import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { INTERVAL_HOURS, type Config } from '../config/schema.js';
import { fetchCandles, findPool, intervalSeconds, DATA_SOURCE, type PoolInfo } from '../data/gecko.js';
import { Executor, SOL_MINT } from '../exec/jupiter.js';
import { buildSnapshot, needsFor } from '../strategy/snapshot.js';
import { checkEntry, openPosition, signalExit, priceExit, type Position } from '../strategy/rules.js';
import { positionSize } from '../strategy/sizing.js';
import { explain } from '../strategy/explain.js';

interface LivePosition extends Position { mint: string; label: string; tokenAmountRaw: string; openedAt: string; barsHeld: number; paper: boolean }
interface State {
  day: string; realizedSolToday: number; paperBalanceSol: number;
  positions: Record<string, LivePosition>; cooldown: Record<string, number>; lastBar: Record<string, number>;
}

const STATE_FILE = 'state.json', TRADES_FILE = 'trades.csv';
const today = () => new Date().toISOString().slice(0, 10);
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadState(cfg: Config): State {
  const fresh: State = { day: today(), realizedSolToday: 0, paperBalanceSol: cfg.backtest.startingBalanceSol, positions: {}, cooldown: {}, lastBar: {} };
  return existsSync(STATE_FILE) ? { ...fresh, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) } : fresh;
}
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
function logTrade(row: (string | number)[]) {
  if (!existsSync(TRADES_FILE)) appendFileSync(TRADES_FILE, 'time,mode,side,label,mint,priceUsd,sol,tokenRaw,pnlSol,reason,signature\n');
  appendFileSync(TRADES_FILE, row.map((v) => String(v).replace(/,/g, ';')).join(',') + '\n');
}

export async function runLive(cfg: Config): Promise<void> {
  if (!cfg.watchlist.length) throw new Error('The watchlist is empty — add tokens to your config.');
  const ex = new Executor(cfg);
  const mode = ex.live ? 'LIVE' : 'PAPER';
  const N = cfg.market.windowCandles, barMs = intervalSeconds(cfg.market.interval) * 1000, needs = needsFor(cfg);
  log(`sine-bot "${cfg.name}" starting in ${mode} mode · ${cfg.market.interval} candles · window ${N} · data: ${DATA_SOURCE}${ex.wallet ? ` · wallet ${ex.wallet.toBase58()}` : ''}`);
  log('Create a file named STOP in this folder to halt after the current pass.');
  const pools = new Map<string, PoolInfo>();

  for (;;) {
    if (existsSync('STOP')) { log('STOP file found — exiting.'); return; }
    const st = loadState(cfg);
    if (st.day !== today()) { st.day = today(); st.realizedSolToday = 0; }
    const halted = st.realizedSolToday <= -cfg.risk.dailyLossLimitSol;
    if (halted) log(`Daily loss limit reached (${st.realizedSolToday.toFixed(3)} SOL): exits only until tomorrow (UTC).`);

    for (const { mint, label } of cfg.watchlist) {
      try {
        let pool = pools.get(mint);
        if (!pool) { pool = await findPool(mint); pools.set(mint, pool); }
        const candles = await fetchCandles(pool.address, mint, cfg.market.interval, N);
        if (candles.length < N) { log(`${label}: only ${candles.length}/${N} candles of history — skipping`); continue; }
        const bar = candles[N - 1];
        if (st.lastBar[mint] === bar.t) continue;           // this bar was already processed
        st.lastBar[mint] = bar.t;
        const snap = buildSnapshot(candles.map((c) => c.c), cfg, needs);
        const pos = st.positions[mint];

        if (pos) {
          pos.barsHeld++;
          const reason = signalExit(pos, snap, pos.barsHeld, cfg) ?? priceExit(pos, bar)?.reason ?? null;
          if (reason) {
            let amount = BigInt(pos.tokenAmountRaw);
            if (ex.live) { const bal = await ex.tokenBalanceRaw(mint); if (bal < amount) amount = bal; }
            if (amount > 0n) {
              const fill = await ex.swap(mint, SOL_MINT, amount.toString());
              const solOut = Number(fill.outAmount) / 1e9, pnl = solOut - pos.sizeSol;
              st.realizedSolToday += pnl;
              if (!ex.live) st.paperBalanceSol += solOut;
              logTrade([new Date().toISOString(), mode, 'SELL', label, mint, bar.c, solOut.toFixed(6), amount.toString(), pnl.toFixed(6), reason, fill.signature ?? '']);
              log(`SELL ${label}: ${reason} · ${solOut.toFixed(4)} SOL · PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`);
            }
            delete st.positions[mint];
            st.cooldown[mint] = cfg.risk.cooldownBars;
          }
          saveState(st);
          continue;
        }

        if ((st.cooldown[mint] ?? 0) > 0) { st.cooldown[mint]--; saveState(st); continue; }
        if (!snap) { saveState(st); continue; }
        const d = checkEntry(snap, cfg);
        log(`${label.padEnd(8)} $${bar.c.toPrecision(6)} · ${snap.strength} · every ${snap.periodHours.toFixed(1)}h · phase ${snap.phase.frac.toFixed(2)}${snap.projection ? ` · proj high ${snap.projection.high.pct.toFixed(1)}% skill ${snap.projection.skill.toFixed(2)}` : ''} → ${d.ok ? 'ENTRY' : 'wait'}${d.ok ? '' : ` (${d.reasons[0]})`}`);
        if (!d.ok || halted) { saveState(st); continue; }
        if (pool.liquidityUsd < cfg.risk.minLiquidityUsd) { log(`  skip: liquidity $${Math.round(pool.liquidityUsd)} < minimum`); saveState(st); continue; }
        if (Object.keys(st.positions).length >= cfg.risk.maxOpenPositions) { log('  skip: max open positions'); saveState(st); continue; }
        const balance = ex.live ? await ex.solBalance() : st.paperBalanceSol;
        const size = Math.min(positionSize(balance, cfg), balance - cfg.risk.minSolReserve);
        if (size < cfg.sizing.minSol) { log('  skip: size below minimum after keeping the SOL reserve'); saveState(st); continue; }

        const before = ex.live ? await ex.tokenBalanceRaw(mint) : 0n;
        const fill = await ex.swap(SOL_MINT, mint, String(Math.round(size * 1e9)));
        const received = ex.live ? (await ex.tokenBalanceRaw(mint)) - before : BigInt(fill.outAmount);
        if (!ex.live) st.paperBalanceSol -= size;
        st.positions[mint] = {
          ...openPosition(bar.c, 0, size, snap, cfg),
          mint, label, tokenAmountRaw: received.toString(), openedAt: new Date().toISOString(), barsHeld: 0, paper: !ex.live,
        };
        logTrade([new Date().toISOString(), mode, 'BUY', label, mint, bar.c, size.toFixed(6), received.toString(), '', 'entry rules met', fill.signature ?? '']);
        log(`BUY ${label}: ${size.toFixed(4)} SOL`);
        if (cfg.logging.explain) for (const line of explain(snap, label)) log(`  ${line}`);
        saveState(st);
      } catch (e) {
        log(`${label}: ${(e as Error).message}`);
      }
    }
    const next = Math.ceil(Date.now() / barMs) * barMs + Math.min(15_000, barMs / 4);
    await sleep(Math.max(1000, next - Date.now()));
  }
}

export const hoursPerBar = (cfg: Config) => INTERVAL_HOURS[cfg.market.interval];

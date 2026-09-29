#!/usr/bin/env node
import 'dotenv/config';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config/load.js';
import type { Config } from './config/schema.js';
import { findPool, fetchCandles, DATA_SOURCE } from './data/gecko.js';
import type { Candle } from './data/types.js';
import { buildSnapshot } from './strategy/snapshot.js';
import { checkEntry } from './strategy/rules.js';
import { explain } from './strategy/explain.js';
import { runBacktest, type BacktestResult } from './engine/backtest.js';
import { runLive } from './engine/live.js';
import { analyze, project, stft, persistence } from './fourier/index.js';

const HELP = `sine-bot — Fourier-analysis trading bot for Solana tokens

Usage: npm run sine -- <command> [options]

Commands
  analyze <token>            Plain-English Fourier readout for a token (mint or watchlist label)
  backtest <token>           Walk-forward backtest of your config on real history
  compare <token>            Backtest every preset in config/presets on the same token
  run                        Run the bot (paper trading unless you enable live mode)
  validate                   Check a config and print the fully resolved settings
  selftest                   Offline check that the Fourier engine recovers known rhythms

Options
  --config <file>            Config file (default: config/default.yaml)
  --preset <name>            Use config/presets/<name>.yaml instead
  --interval <1m|15m|1h|…>   Override market.interval
  --window <64…2048>         Override market.windowCandles (power of two)
  --candles <n>              Backtest history length (default: backtest.candles)
  --csv                      Write trades/equity CSV files after a backtest
`;

function args() {
  const a = process.argv.slice(2), flags: Record<string, string | boolean> = {}, pos: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; flags[k] = v; }
    else pos.push(a[i]);
  }
  return { cmd: pos[0], rest: pos.slice(1), flags };
}

function configFrom(flags: Record<string, string | boolean>): Config {
  const file = typeof flags.preset === 'string' ? `config/presets/${flags.preset}.yaml` : typeof flags.config === 'string' ? flags.config : 'config/default.yaml';
  const market: Record<string, unknown> = {};
  if (typeof flags.interval === 'string') market.interval = flags.interval;
  if (typeof flags.window === 'string') market.windowCandles = Number(flags.window);
  return loadConfig(file, Object.keys(market).length ? { market } : {});
}

function resolveToken(cfg: Config, arg?: string) {
  if (!arg) throw new Error('Give a token: a mint address or a label from your watchlist.');
  return cfg.watchlist.find((w) => w.label.toLowerCase() === arg.toLowerCase() || w.mint === arg) ?? { mint: arg, label: arg.slice(0, 6) };
}

async function history(cfg: Config, mint: string, count: number): Promise<Candle[]> {
  const pool = await findPool(mint);
  console.log(`Pool ${pool.name} · liquidity $${Math.round(pool.liquidityUsd).toLocaleString()} · ${cfg.market.interval} candles · ${DATA_SOURCE}`);
  return fetchCandles(pool.address, mint, cfg.market.interval, count);
}

const f = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;
function printResult(name: string, r: BacktestResult) {
  console.log(`\n${name}`);
  console.log(`  Return ${f(r.totalReturnPct)} vs buy & hold ${f(r.buyHoldPct)} · max drawdown ${r.maxDrawdownPct.toFixed(1)}% · in market ${r.exposurePct.toFixed(0)}% of the time`);
  console.log(`  Trades ${r.trades.length} · win rate ${r.winRatePct.toFixed(0)}% · avg win ${f(r.avgWinPct)} · avg loss ${f(r.avgLossPct)} · profit factor ${isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞'}`);
  if (r.skipReasons.length) console.log(`  Most common reasons entries were skipped:\n${r.skipReasons.map(([k, n]) => `    ${String(n).padStart(6)} × ${k}`).join('\n')}`);
}

async function main() {
  const { cmd, rest, flags } = args();
  switch (cmd) {
    case 'analyze': {
      const cfg = configFrom(flags), tok = resolveToken(cfg, rest[0]);
      const candles = await history(cfg, tok.mint, cfg.market.windowCandles);
      if (candles.length < cfg.market.windowCandles) throw new Error(`Only ${candles.length} candles available; try a shorter --window or a longer --interval.`);
      const snap = buildSnapshot(candles.map((c) => c.c), cfg, { persistence: true, projection: true });
      if (!snap) { console.log('No rhythm could be measured on this window.'); return; }
      console.log(`\n${tok.label} · ${snap.strength} rhythm\n`);
      for (const line of explain(snap, tok.label)) console.log(`  ${line}`);
      const d = checkEntry(snap, cfg);
      console.log(`\nYour entry rules (${cfg.name}): ${d.ok ? 'WOULD ENTER now' : 'would wait'}`);
      for (const r of d.reasons) console.log(`  · ${r}`);
      return;
    }
    case 'backtest': {
      const cfg = configFrom(flags), tok = resolveToken(cfg, rest[0]);
      const n = Number(flags.candles) || cfg.backtest.candles;
      const candles = await history(cfg, tok.mint, n);
      console.log(`Backtesting "${cfg.name}" on ${candles.length} candles…`);
      const r = runBacktest(candles, cfg, (d, t) => process.stdout.write(`\r  ${Math.round((d / t) * 100)}%`));
      process.stdout.write('\r');
      printResult(`${tok.label} · ${cfg.name}`, r);
      if (flags.csv) {
        writeFileSync(`trades-${tok.label}.csv`, 'entryTime,exitTime,entryPrice,exitPrice,sizeSol,pnlSol,returnPct,bars,reason\n' +
          r.trades.map((x) => [new Date(x.entryTime * 1000).toISOString(), new Date(x.exitTime * 1000).toISOString(), x.entryPrice, x.exitPrice, x.sizeSol.toFixed(4), x.pnlSol.toFixed(6), x.returnPct.toFixed(3), x.bars, x.reason].join(',')).join('\n') + '\n');
        writeFileSync(`equity-${tok.label}.csv`, 'time,equity\n' + r.equity.map((e) => `${new Date(e.t * 1000).toISOString()},${e.equity.toFixed(6)}`).join('\n') + '\n');
        console.log(`\n  Wrote trades-${tok.label}.csv and equity-${tok.label}.csv`);
      }
      console.log('\n  A backtest describes the past on one token. Test several tokens and periods, then paper-trade before going live.');
      return;
    }
    case 'compare': {
      const base = configFrom(flags), tok = resolveToken(base, rest[0]);
      const files = readdirSync('config/presets').filter((x) => x.endsWith('.yaml')).sort();
      const cache = new Map<string, Candle[]>();
      for (const file of files) {
        const cfg = loadConfig(path.join('config/presets', file));
        const key = cfg.market.interval;
        if (!cache.has(key)) cache.set(key, await history(cfg, tok.mint, Number(flags.candles) || cfg.backtest.candles));
        try { printResult(`${tok.label} · preset "${cfg.name}" (${cfg.market.interval})`, runBacktest(cache.get(key)!, cfg)); }
        catch (e) { console.log(`\n${cfg.name}: ${(e as Error).message}`); }
      }
      return;
    }
    case 'run': return runLive(configFrom(flags));
    case 'validate': {
      const cfg = configFrom(flags);
      console.log(JSON.stringify(cfg, null, 2));
      console.log(`\n✓ "${cfg.name}" is valid.`);
      return;
    }
    case 'selftest': {
      const planted = [40, 16, 6.4], dt = 0.25, N = 512;
      let s = 42;
      const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
      const closes = Array.from({ length: N }, (_, i) => {
        const t = i * dt, g = (rnd() + rnd() + rnd() + rnd() - 2) * 1.2;
        return 100 * Math.exp(0.0003 * i + 0.04 * Math.sin((2 * Math.PI * t) / planted[0]) + 0.02 * Math.sin((2 * Math.PI * t) / planted[1] + 1) + 0.01 * Math.sin((2 * Math.PI * t) / planted[2] + 2) + 0.008 * g);
      });
      const a = analyze(closes, dt);
      console.log(`Planted rhythms:   ${planted.join(' h, ')} h (±4%, ±2%, ±1%)`);
      console.log(`Recovered:         ${a.peaks.map((p) => `${p.periodHours.toFixed(1)} h (±${(p.amp * 100).toFixed(1)}%)`).join(', ')}`);
      const pr = project(closes, dt, a.peaks[0].periodHours)!;
      console.log(`Projection skill:  ${pr.skill.toFixed(2)} vs "no change" · direction right ${Math.round((100 * pr.hits) / pr.checks)}% (${pr.tests} walk-forward tests)`);
      for (const p of a.peaks) {
        const pe = persistence(stft(closes, dt, p.periodHours), p.periodHours);
        console.log(`Persistence ${p.periodHours.toFixed(1).padStart(5)} h: ${pe ? `present in ${Math.round(pe.share * 100)}% of the window` : 'too slow to check (repeats < 4× in the window)'}`);
      }
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => { console.error(`\n${(e as Error).message}`); process.exit(1); });

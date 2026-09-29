import type { Config } from '../config/schema.js';
import type { Candle } from '../data/types.js';
import { buildSnapshot, needsFor, type Snapshot } from '../strategy/snapshot.js';
import { checkEntry, openPosition, signalExit, priceExit, type Position } from '../strategy/rules.js';
import { positionSize } from '../strategy/sizing.js';

export interface Trade {
  entryTime: number; exitTime: number; entryPrice: number; exitPrice: number;
  sizeSol: number; pnlSol: number; returnPct: number; bars: number; reason: string;
}

export interface BacktestResult {
  trades: Trade[];
  equity: { t: number; equity: number }[];
  startBalance: number; endBalance: number;
  totalReturnPct: number; buyHoldPct: number; maxDrawdownPct: number;
  winRatePct: number; profitFactor: number; avgWinPct: number; avgLossPct: number;
  exposurePct: number; barsTested: number;
  skipReasons: [string, number][];           // most common reasons entries were rejected
}

/**
 * Walk-forward backtest. At each bar close the strategy sees ONLY the last windowCandles closes.
 * Entries and signal exits fill at the next bar's open. Stops, trailing stops, targets and
 * take-profits are checked inside the next bar (stop first if both could have hit).
 * Fees + expected slippage are charged on both sides. Uses exactly the same rule functions as
 * the live bot.
 */
export function runBacktest(candles: Candle[], cfg: Config, onProgress?: (done: number, total: number) => void): BacktestResult {
  const N = cfg.market.windowCandles;
  if (candles.length < N + 20) throw new Error(`Need at least ${N + 20} candles for a window of ${N}; have ${candles.length}.`);
  const costSide = (cfg.execution.feeBps + cfg.execution.expectedSlippageBps) / 1e4;
  const needs = needsFor(cfg);
  const start = cfg.backtest.startingBalanceSol;

  let balance = start, peakEq = start, maxDD = 0, inMarket = 0, cooldown = 0;
  let pos: Position | null = null;
  const trades: Trade[] = [], equity: BacktestResult['equity'] = [], skips = new Map<string, number>();

  const close = (i: number, price: number, reason: string) => {
    const p = pos!;
    const gross = price / p.entryPrice, pnl = p.sizeSol * (gross * (1 - costSide) ** 2 - 1);
    balance += pnl;
    trades.push({ entryTime: candles[p.entryIndex].t, exitTime: candles[i].t, entryPrice: p.entryPrice, exitPrice: price,
      sizeSol: p.sizeSol, pnlSol: pnl, returnPct: (gross * (1 - costSide) ** 2 - 1) * 100, bars: i - p.entryIndex, reason });
    pos = null;
    cooldown = cfg.risk.cooldownBars;
  };

  const total = candles.length - 1 - (N - 1);
  for (let t = N - 1; t < candles.length - 1; t++) {
    const evaluate = (t - (N - 1)) % cfg.market.evaluateEvery === 0;
    let snap: Snapshot | null = null;
    if (evaluate) {
      try { snap = buildSnapshot(candles.slice(t - N + 1, t + 1).map((c) => c.c), cfg, needs); } catch { snap = null; }
    }
    const next = candles[t + 1], nx = t + 1;

    if (pos) {
      inMarket++;
      const reason = signalExit(pos, snap, t - pos.entryIndex, cfg);
      if (reason) close(nx, next.o, reason);
      else { const hit = priceExit(pos, next); if (hit) close(nx, hit.price, hit.reason); }
    } else if (cooldown > 0) {
      cooldown--;
    } else if (snap) {
      const d = checkEntry(snap, cfg);
      if (d.ok) {
        const size = positionSize(balance, cfg);
        if (size > 0) {
          pos = openPosition(next.o, nx, size, snap, cfg);
          const hit = priceExit(pos, next);
          if (hit) close(nx, hit.price, hit.reason);
        } else skips.set('position size below minimum', (skips.get('position size below minimum') ?? 0) + 1);
      } else {
        for (const r of d.reasons) { const key = r.replace(/[-\d.]+%?/g, '#'); skips.set(key, (skips.get(key) ?? 0) + 1); }
      }
    }

    const open = pos as Position | null;
    const eq = balance + (open ? open.sizeSol * ((next.c / open.entryPrice) * (1 - costSide) ** 2 - 1) : 0);
    equity.push({ t: next.t, equity: eq });
    peakEq = Math.max(peakEq, eq);
    maxDD = Math.max(maxDD, 1 - eq / peakEq);
    if (onProgress && (t - N) % 200 === 0) onProgress(t - (N - 1), total);
  }
  if (pos) close(candles.length - 1, candles[candles.length - 1].c, 'end of data');

  const wins = trades.filter((x) => x.pnlSol > 0), losses = trades.filter((x) => x.pnlSol <= 0);
  const sum = (a: Trade[], f: (x: Trade) => number) => a.reduce((s, x) => s + f(x), 0);
  const lossSum = Math.abs(sum(losses, (x) => x.pnlSol));
  return {
    trades, equity, startBalance: start, endBalance: balance,
    totalReturnPct: (balance / start - 1) * 100,
    buyHoldPct: (candles[candles.length - 1].c / candles[N - 1].c - 1) * 100,
    maxDrawdownPct: maxDD * 100,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: lossSum > 0 ? sum(wins, (x) => x.pnlSol) / lossSum : wins.length ? Infinity : 0,
    avgWinPct: wins.length ? sum(wins, (x) => x.returnPct) / wins.length : 0,
    avgLossPct: losses.length ? sum(losses, (x) => x.returnPct) / losses.length : 0,
    exposurePct: total > 0 ? (inMarket / total) * 100 : 0,
    barsTested: total,
    skipReasons: [...skips.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
  };
}

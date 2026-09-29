import { INTERVAL_HOURS, type Config } from '../config/schema.js';
import type { Snapshot } from './snapshot.js';

export interface Decision { ok: boolean; reasons: string[] }

/** Is phase `x` (0 = trough, 0.5 = crest) inside [from, to]? Wraps past 1 → 0 when from > to. */
export function inPhaseWindow(x: number, from: number, to: number): boolean {
  return from <= to ? x >= from && x <= to : x >= from || x <= to;
}

export const roundTripCostPct = (cfg: Config) => (2 * (cfg.execution.feeBps + cfg.execution.expectedSlippageBps)) / 100;

/** Entry: every enabled condition must pass. Reasons explain each failure (useful for tuning). */
export function checkEntry(s: Snapshot, cfg: Config): Decision {
  const e = cfg.entry, r: string[] = [];
  if (s.level < e.minStrength) r.push(`strength ${s.strength} < required ${e.minStrength}`);
  if (s.cyclesSeen < e.minCyclesSeen) r.push(`rhythm seen ${s.cyclesSeen.toFixed(1)}× < ${e.minCyclesSeen}`);

  if (e.persistence.min !== null || e.persistence.requireStrengthening) {
    if (!s.persistence) r.push('main rhythm too slow for the persistence check');
    else {
      if (e.persistence.min !== null && s.persistence.share < e.persistence.min) r.push(`persistence ${(s.persistence.share * 100).toFixed(0)}% < ${(e.persistence.min * 100).toFixed(0)}%`);
      if (e.persistence.requireStrengthening && s.persistence.change < 1.2) r.push('rhythm not strengthening');
    }
  }

  if (e.phase.enabled) {
    if (!inPhaseWindow(s.phase.frac, e.phase.from, e.phase.to)) r.push(`phase ${s.phase.frac.toFixed(2)} outside ${e.phase.from}–${e.phase.to}`);
    if (e.phase.requireRising && !s.phase.rising) r.push('cycle is falling');
  }

  if (e.trend.minPctPerDay !== null && s.trendPctPerDay < e.trend.minPctPerDay) r.push(`trend ${s.trendPctPerDay.toFixed(2)}%/day < ${e.trend.minPctPerDay}`);
  if (e.trend.maxPctPerDay !== null && s.trendPctPerDay > e.trend.maxPctPerDay) r.push(`trend ${s.trendPctPerDay.toFixed(2)}%/day > ${e.trend.maxPctPerDay}`);

  let expectedUpPct = 2 * s.amplitudePct;                   // full trough-to-crest swing, if no projection
  if (e.projection.enabled) {
    const p = s.projection;
    if (!p) r.push('no projection available');
    else {
      expectedUpPct = p.high.pct;
      if (e.projection.requireTested && !p.tested) r.push('projection untested (too little history)');
      if (p.skill < e.projection.minSkill) r.push(`projection skill ${p.skill.toFixed(2)} < ${e.projection.minSkill}`);
      if (p.hitRate < e.projection.minHitRate) r.push(`projection hit rate ${(p.hitRate * 100).toFixed(0)}% < ${(e.projection.minHitRate * 100).toFixed(0)}%`);
      if (p.high.pct < e.projection.minUpsidePct) r.push(`projected upside ${p.high.pct.toFixed(2)}% < ${e.projection.minUpsidePct}%`);
      const rr = p.high.pct / cfg.exit.stopLossPct;
      if (rr < e.projection.minRewardRisk) r.push(`reward/risk ${rr.toFixed(2)} < ${e.projection.minRewardRisk}`);
    }
  }
  const cost = roundTripCostPct(cfg);
  if (expectedUpPct < e.costMultiple * cost) r.push(`expected move ${expectedUpPct.toFixed(2)}% < ${e.costMultiple}× costs (${(e.costMultiple * cost).toFixed(2)}%)`);

  return { ok: r.length === 0, reasons: r };
}

export interface Position {
  entryPrice: number;
  entryIndex: number;       // bar index (backtest) or bar count since start (live)
  sizeSol: number;
  stop: number;
  takeProfit: number | null;
  target: number | null;    // projected high minus buffer
  trailingPct: number | null;
  peak: number;             // highest price since entry (for the trailing stop)
  maxHoldBars: number;
  entryPhase: number;
}

export function openPosition(entryPrice: number, entryIndex: number, sizeSol: number, s: Snapshot, cfg: Config): Position {
  const x = cfg.exit, dt = INTERVAL_HOURS[cfg.market.interval];
  let target: number | null = null;
  if (x.atProjectedHigh.enabled && s.projection) {
    const t = s.projection.high.price * (1 - x.atProjectedHigh.bufferPct / 100);
    if (t > entryPrice) target = t;
  }
  return {
    entryPrice, entryIndex, sizeSol,
    stop: entryPrice * (1 - x.stopLossPct / 100),
    takeProfit: x.takeProfitPct !== null ? entryPrice * (1 + x.takeProfitPct / 100) : null,
    target, trailingPct: x.trailingStopPct, peak: entryPrice,
    maxHoldBars: Math.max(1, Math.round((x.maxHoldCycles * s.periodHours) / dt)),
    entryPhase: s.phase.frac,
  };
}

/** Exits decided from the analysis at a bar close (filled at the next bar's open). */
export function signalExit(pos: Position, s: Snapshot | null, barsHeld: number, cfg: Config): string | null {
  if (barsHeld >= pos.maxHoldBars) return 'max hold time';
  if (!s) return null;
  if (cfg.exit.onCycleTurn && pos.entryPhase < 0.5 && s.phase.frac >= 0.5 && s.phase.frac <= 0.8 && barsHeld > 0) return 'cycle passed its crest';
  if (cfg.exit.onStrengthBelow !== null && s.level < cfg.exit.onStrengthBelow) return 'rhythm weakened';
  return null;
}

/**
 * Price-level exits within a bar. Conservative ordering: stop (and trailing stop) before targets.
 * Returns the fill price and reason, or null. Updates pos.peak afterwards.
 */
export function priceExit(pos: Position, bar: { o: number; h: number; l: number; c: number }): { price: number; reason: string } | null {
  const trail = pos.trailingPct !== null ? pos.peak * (1 - pos.trailingPct / 100) : -Infinity;
  const floor = Math.max(pos.stop, trail), floorReason = trail > pos.stop ? 'trailing stop' : 'stop loss';
  if (bar.o <= floor) return { price: bar.o, reason: floorReason + ' (gap)' };
  if (bar.l <= floor) return { price: floor, reason: floorReason };
  const tops = [pos.target, pos.takeProfit].filter((v): v is number => v !== null);
  if (tops.length) {
    const top = Math.min(...tops), reason = top === pos.target ? 'reached projected high' : 'take profit';
    if (bar.o >= top) return { price: bar.o, reason: reason + ' (gap)' };
    if (bar.h >= top) return { price: top, reason };
  }
  pos.peak = Math.max(pos.peak, bar.h);
  return null;
}

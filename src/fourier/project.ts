import { analyze } from './analyze.js';
import { harmonicFit, type HarmonicModel } from './harmonics.js';

export interface Projection {
  horizon: number;          // samples ahead
  center: number[];         // log price, h = 0..horizon (h = 0 is the last close)
  lo: number[];             // band, same indexing
  hi: number[];
  model: HarmonicModel;     // fitted trend + rhythms over the window (sample index 0..N-1)
  tests: number;            // walk-forward tests performed
  tested: boolean;          // enough tests (≥ 6) for the track record and band to mean anything
  hits: number;             // direction checks that were right
  checks: number;           // direction checks made
  skill: number;            // 1 − error(projection) / error("no change"); > 0 beats doing nothing
}

function quantile(a: number[], q: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), pos = (s.length - 1) * q, i = Math.floor(pos), f = pos - i;
  return s[i] + (s[Math.min(s.length - 1, i + 1)] - s[i]) * f;
}

/** Fit trend + rhythms to `prices` alone and extend H steps, pinned to the last close. */
function forecastFrom(prices: number[], dtHours: number, H: number) {
  const a = analyze(prices, dtHours, { nPeaks: 3, skipNull: true, linearTrend: true });
  if (!a.peaks.length) return null;
  const y = prices.map(Math.log), last = y.length - 1;
  const model = harmonicFit(y, a.peaks.map((p) => dtHours / p.periodHours));
  if (!model) return null;
  const base = model.predict(last), path: number[] = [];
  for (let h = 0; h <= H; h++) path.push(y[last] + model.predict(last + h) - base);
  return { path, model };
}

/**
 * "If the pattern holds" projection with an honest, walk-forward track record.
 * Horizon = one main cycle, capped at N/5. At up to `tests` earlier points inside the window the
 * whole method is re-run on the N/2 samples before that point only, projected forward and
 * compared with what actually happened. Direction is checked at ¼, ½, ¾ and the full horizon.
 * The band is the 80th percentile of those past misses per step (or of typical past moves when
 * there are too few tests).
 */
export function project(prices: number[], dtHours: number, mainPeriodHours: number, tests = 12): Projection | null {
  const N = prices.length;
  if (N < 64) return null;
  const H = Math.max(3, Math.round(Math.min(mainPeriodHours / dtHours, N / 5)));
  const main = forecastFrom(prices, dtHours, H);
  if (!main) return null;
  const y = prices.map(Math.log);

  const W = N / 2, span = N - H - W;                 // N is a power of two, so W is too
  const nOrig = span >= 0 ? Math.min(tests, span + 1) : 0;
  const errs: number[][] = Array.from({ length: H + 1 }, () => []);
  let hits = 0, checks = 0, sumModel = 0, sumNaive = 0, done = 0;

  for (let j = 0; j < nOrig; j++) {
    const o = W + (nOrig === 1 ? span : Math.round((j * span) / (nOrig - 1)));
    const fc = forecastFrom(prices.slice(o - W, o), dtHours, H);
    if (!fc) continue;
    done++;
    const last = y[o - 1];
    for (let h = 1; h <= H; h++) {
      const actual = y[o - 1 + h];
      errs[h].push(Math.abs(actual - fc.path[h]));
      sumModel += Math.abs(actual - fc.path[h]);
      sumNaive += Math.abs(actual - last);
    }
    for (const hh of [Math.round(H / 4), Math.round(H / 2), Math.round((3 * H) / 4), H]) {
      if (hh < 1) continue;
      const aMove = y[o - 1 + hh] - last, fMove = fc.path[hh] - last;
      if (Math.abs(aMove) > 0.001) { checks++; if ((aMove > 0) === (fMove > 0)) hits++; }
    }
  }

  const tested = done >= 6, band = [0];
  for (let h = 1; h <= H; h++) {
    if (tested) band.push(quantile(errs[h], 0.8));
    else {
      const moves: number[] = [];
      for (let i = 0; i + h < N; i += Math.max(1, Math.floor(h / 2))) moves.push(Math.abs(y[i + h] - y[i]));
      band.push(quantile(moves, 0.8));
    }
  }
  return {
    horizon: H, center: main.path,
    lo: main.path.map((v, h) => v - band[h]), hi: main.path.map((v, h) => v + band[h]),
    model: main.model, tests: done, tested, hits, checks,
    skill: sumNaive > 0 ? 1 - sumModel / sumNaive : 0,
  };
}

import { fft, isPow2 } from './fft.js';
import { ols, solve, lcg, upperP, lowerP } from './stats.js';

export interface Peak {
  k: number;             // FFT bin = cycles per window
  kf: number;            // refined (fractional) bin
  periodHours: number;
  freqHz: number;
  cyclesPerDay: number;
  amp: number;           // log-price units ≈ fraction (0.04 ≈ ±4 %)
  phaseDeg: number;
  share: number;         // fraction of detrended variance in this peak (±1 bin)
  prominence: number;    // power ÷ median power of nearby frequencies (sharp spike vs. broad slope)
  p: number | null;      // chance a random walk shows ANY rhythm this prominent (look-elsewhere corrected)
}

export interface FourierTrend {
  k: number;             // slow-wave frequency k* (cycles per window, 0.1–1.5)
  a: number; b: number;  // line: a + b·t (b = log-price slope per sample)
  F: number;             // F-statistic: line + slow wave vs. line only
  at: (n: number) => number;
}

export interface Significance {
  pTop: number;          // main rhythm vs. random walks
  pKss: number;          // mean reversion (Fourier KSS) vs. random walks
  pBreak: number;        // slow regime shift vs. random walks
  sims: number;
}

export interface Analysis {
  N: number;
  dtHours: number;
  trendA: number;
  trendB: number;
  trend: FourierTrend;
  detrended: number[];
  amp: number[];
  power: number[];
  variance: number;
  peaks: Peak[];
  explained: number;
  snr: number;
  kssT: number;
  maxProm: number;
  sig: Significance | null;
  resolutionHz: number;
  nyquistHz: number;
}

export interface AnalyzeOptions {
  nPeaks?: number;
  minCycles?: number;
  skipNull?: boolean;    // skip the random-walk significance tests (used inside simulations and projections)
  linearTrend?: boolean; // straight-line trend only (projection fits: short windows where a slow wave could absorb a rhythm)
}

function linearTrend(y: number[]): FourierTrend {
  const N = y.length, fit = ols([new Array(N).fill(1), y.map((_, i) => i)], y)!;
  const [a, b] = fit.beta;
  return { k: 0, a, b, F: 0, at: (n) => a + b * n };
}

/**
 * Flexible Fourier trend (Enders & Lee; fractional frequency): y_t = a + b·t + c·cos(2πk*t/N) + s·sin(2πk*t/N).
 * k* ∈ {0.1 … 1.5} by minimum SSR — below 1.5 cycles per window, so it can never absorb a repeating rhythm.
 */
export function fourierTrend(y: number[]): FourierTrend {
  const N = y.length, one = new Array(N).fill(1), t = y.map((_, i) => i);
  const lin = ols([one, t], y)!;
  let best: { k: number; beta: number[]; ssr: number } | null = null;
  for (let k10 = 1; k10 <= 15; k10++) {
    const k = k10 / 10, c = new Array(N), s = new Array(N);
    for (let i = 0; i < N; i++) { const g = (2 * Math.PI * k * i) / N; c[i] = Math.cos(g); s[i] = Math.sin(g); }
    const f = ols([one, t, c, s], y);
    if (f && (!best || f.ssr < best.ssr)) best = { k, beta: f.beta, ssr: f.ssr };
  }
  const B = best!;
  return {
    k: B.k, a: B.beta[0], b: B.beta[1],
    F: ((lin.ssr - B.ssr) / 2) / (B.ssr / Math.max(1, N - 4)),
    at: (n) => { const g = (2 * Math.PI * B.k * n) / N; return B.beta[0] + B.beta[1] * n + B.beta[2] * Math.cos(g) + B.beta[3] * Math.sin(g); },
  };
}

/**
 * Fourier KSS non-linear unit-root test (Kapetanios, Shin & Snell 2003; Christopoulos & León-Ledesma 2010),
 * on the Fourier-trend residuals e: Δe_t = φ·e³_{t−1} + Σ_{j≤p} α_j·Δe_{t−j}. Returns the t-statistic of φ
 * (more negative = price pulls back toward its trend instead of wandering like a random walk).
 */
export function kssT(e: number[]): number {
  const N = e.length, p = Math.max(1, Math.floor(4 * (N / 100) ** 0.25));
  const sd = Math.sqrt(e.reduce((s, v) => s + v * v, 0) / N) || 1;
  const z = e.map((v) => v / sd), dz = z.map((v, i) => (i ? v - z[i - 1] : 0));
  const cols: number[][] = Array.from({ length: p + 1 }, () => []), y: number[] = [];
  for (let i = p + 1; i < N; i++) {
    y.push(dz[i]); cols[0].push(z[i - 1] ** 3);
    for (let j = 1; j <= p; j++) cols[j].push(dz[i - j]);
  }
  const r = ols(cols, y);
  if (!r) return 0;
  const e0 = new Array(cols.length).fill(0); e0[0] = 1;
  const inv = solve(r.xtx, e0);
  if (!inv) return 0;
  const se = Math.sqrt((r.ssr / Math.max(1, y.length - cols.length)) * inv[0]);
  return se > 0 ? r.beta[0] / se : 0;
}

/** Random-walk null distributions for a window length (200 simulations, seeded, cached). */
interface NullDist { prom: number[]; kss: number[]; F: number[]; M: number }
const nullCache = new Map<number, NullDist>();
export function nullDist(N: number, M = 200): NullDist {
  const hit = nullCache.get(N);
  if (hit) return hit;
  const rnd = lcg(2024 + N), prom: number[] = [], kss: number[] = [], F: number[] = [];
  for (let m = 0; m < M; m++) {
    let lp = 0;
    const xs = Array.from({ length: N }, () => Math.exp((lp += 0.01 * (rnd() + rnd() + rnd() + rnd() - 2) * 1.73)));
    const a = analyze(xs, 1, { skipNull: true });
    prom.push(a.maxProm); kss.push(a.kssT); F.push(a.trend.F);
  }
  const srt = (a: number[]) => [...a].sort((x, y) => x - y);
  const d = { prom: srt(prom), kss: srt(kss), F: srt(F), M };
  nullCache.set(N, d);
  return d;
}

/**
 * Fourier analysis of a price series (random-walk aware).
 *   log price → Fourier trend (line + slow wave: removes smooth regime shifts) → Hann window → FFT
 *   → peaks (≥ minCycles, ≥ 4 samples/cycle), parabolic refinement, prominence vs. nearby frequencies
 *   → share of variance (Parseval), Fourier KSS mean-reversion test
 *   → significance of the rhythm, mean reversion and regime shift against 200 simulated random walks.
 * Ranking: significant rhythms repeating ≥ 3× first, then significant 2-cycle swings, then the rest (by amplitude).
 */
export function analyze(closes: number[], dtHours: number, opts: AnalyzeOptions = {}): Analysis {
  const N = closes.length, nPeaks = opts.nPeaks ?? 3, minCycles = Math.max(2, opts.minCycles ?? 2);
  if (!isPow2(N) || N < 32) throw new Error(`analyze: sample count must be a power of two ≥ 32 (got ${N})`);
  if (closes.some((v) => !(v > 0))) throw new Error('analyze: prices must be positive');

  const y = closes.map(Math.log);
  const trend = opts.linearTrend ? linearTrend(y) : fourierTrend(y);
  const d = y.map((v, i) => v - trend.at(i));
  const variance = d.reduce((s, v) => s + v * v, 0) / N;

  const wr = new Float64Array(N), wi = new Float64Array(N), rr = new Float64Array(N), ri = new Float64Array(N);
  for (let n = 0; n < N; n++) { wr[n] = d[n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1))); rr[n] = d[n]; }
  fft(wr, wi); fft(rr, ri);

  const half = N / 2, amp: number[] = [], power: number[] = [];
  for (let k = 0; k <= half; k++) {
    amp.push((4 * Math.hypot(wr[k], wi[k])) / N);
    power.push((2 * (rr[k] * rr[k] + ri[k] * ri[k])) / (N * N));
  }

  const kMax = Math.min(half - 1, Math.floor(N / 4)), cand: number[] = [];
  for (let k = minCycles; k <= kMax; k++) if (amp[k] > amp[k - 1] && amp[k] >= amp[k + 1]) cand.push(k);
  const P2 = amp.map((a) => a * a);
  const prom = (k: number) => {
    const nb: number[] = [];
    for (let j = Math.max(1, k - 8); j <= Math.min(half, k + 8); j++) if (Math.abs(j - k) > 1) nb.push(P2[j]);
    nb.sort((a, b) => a - b);
    return P2[k] / Math.max(nb[Math.floor(nb.length / 2)] ?? 0, 1e-30);
  };
  const promOf = new Map<number, number>();
  let maxProm = 0;
  for (const k of cand) { const v = prom(k); promOf.set(k, v); maxProm = Math.max(maxProm, v); }
  const nd = opts.skipNull ? null : nullDist(N);
  const pOf = (k: number) => (nd ? upperP(nd.prom, promOf.get(k)!) : null);
  const tier = (k: number) => { const p = pOf(k); return p !== null && p <= 0.05 ? (k >= 3 ? 0 : 1) : 2; };
  cand.sort((p, q) => tier(p) - tier(q) || amp[q] - amp[p]);

  const T = N * dtHours;
  const peaks: Peak[] = cand.slice(0, nPeaks).map((k) => {
    const la = Math.log(amp[k - 1]), lb = Math.log(amp[k]), lc = Math.log(amp[k + 1]), den = la - 2 * lb + lc;
    const delta = den !== 0 && isFinite(den) ? Math.max(-0.5, Math.min(0.5, (0.5 * (la - lc)) / den)) : 0;
    const kf = k + delta, periodHours = T / kf;
    return {
      k, kf, periodHours, freqHz: 1 / (periodHours * 3600), cyclesPerDay: 24 / periodHours, amp: amp[k],
      phaseDeg: ((Math.atan2(ri[k], rr[k]) * 180) / Math.PI + 360) % 360,
      share: variance > 0 ? (power[k - 1] + power[k] + power[k + 1]) / variance : 0,
      prominence: promOf.get(k)!, p: pOf(k),
    };
  });

  const explained = Math.min(0.999, peaks.reduce((s, p) => s + p.share, 0));
  const kt = kssT(d);
  return {
    N, dtHours, trendA: trend.a, trendB: trend.b, trend, detrended: d, amp, power, variance, peaks,
    explained, snr: explained / (1 - explained), kssT: kt, maxProm,
    sig: nd ? { pTop: peaks[0]?.p ?? 1, pKss: lowerP(nd.kss, kt), pBreak: upperP(nd.F, trend.F), sims: nd.M } : null,
    resolutionHz: 1 / (T * 3600), nyquistHz: 1 / (2 * dtHours * 3600),
  };
}

/** 0 = no clear rhythm … 4 = very strong. Same rules as the SINE website. */
export const STRENGTH_LABELS = ['No clear rhythm', 'Weak', 'Moderate', 'Strong', 'Very strong'] as const;

export function strengthLevel(a: Analysis): { level: number; cyclesSeen: number; p: number | null } {
  if (!a.peaks.length) return { level: 0, cyclesSeen: 0, p: null };
  const e = a.explained;
  let level = e >= 0.75 ? 4 : e >= 0.55 ? 3 : e >= 0.35 ? 2 : e >= 0.15 ? 1 : 0;
  const cyclesSeen = (a.N * a.dtHours) / a.peaks[0].periodHours;
  if (cyclesSeen < 2) level = Math.min(level, 1);
  else if (cyclesSeen < 3) level = Math.min(level, 2);
  const p = a.sig?.pTop ?? null;                  // could this rhythm be a random walk's chance swing?
  if (p !== null) { if (p > 0.3) level = 0; else if (p > 0.15) level = Math.min(level, 1); else if (p > 0.05) level = Math.min(level, 2); }
  return { level, cyclesSeen, p };
}

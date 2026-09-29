import { fft, isPow2 } from './fft.js';

export interface Peak {
  k: number;             // FFT bin
  kf: number;            // refined (fractional) bin
  periodHours: number;
  freqHz: number;        // cycles per second
  cyclesPerDay: number;
  amp: number;           // log-price units ≈ fraction (0.04 ≈ ±4 %)
  phaseDeg: number;      // cosine phase at the start of the window
  share: number;         // fraction of detrended variance in this peak (±1 bin)
}

export interface Analysis {
  N: number;
  dtHours: number;
  trendA: number;        // log-price intercept
  trendB: number;        // log-price slope per sample
  detrended: number[];
  amp: number[];         // Hann amplitude spectrum, bins 0..N/2
  power: number[];       // un-windowed one-sided power per bin (Parseval)
  variance: number;
  peaks: Peak[];
  explained: number;     // share of variance in all reported peaks (capped 0.999)
  snr: number;
  resolutionHz: number;
  nyquistHz: number;
}

export interface AnalyzeOptions {
  nPeaks?: number;       // default 3
  minCycles?: number;    // a peak must complete at least this many cycles in the window (default 2)
}

/**
 * Fourier analysis of a price series.
 *   log price → least-squares linear detrend → Hann window → FFT
 *   → peaks with ≥ minCycles cycles in the window and ≥ 4 samples per cycle,
 *     refined by parabolic interpolation on log amplitude
 *   → amplitude, phase and share of detrended variance (un-windowed FFT, Parseval)
 */
export function analyze(closes: number[], dtHours: number, opts: AnalyzeOptions = {}): Analysis {
  const N = closes.length, nPeaks = opts.nPeaks ?? 3, minCycles = Math.max(2, opts.minCycles ?? 2);
  if (!isPow2(N) || N < 32) throw new Error(`analyze: sample count must be a power of two ≥ 32 (got ${N})`);
  if (closes.some((v) => !(v > 0))) throw new Error('analyze: prices must be positive');

  const y = closes.map(Math.log);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < N; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; }
  const trendB = (N * sxy - sx * sy) / (N * sxx - sx * sx);
  const trendA = (sy - trendB * sx) / N;
  const d = y.map((v, i) => v - (trendA + trendB * i));
  const variance = d.reduce((s, v) => s + v * v, 0) / N;

  const wr = new Float64Array(N), wi = new Float64Array(N), rr = new Float64Array(N), ri = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    wr[n] = d[n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1)));
    rr[n] = d[n];
  }
  fft(wr, wi);
  fft(rr, ri);

  const half = N / 2, amp: number[] = [], power: number[] = [];
  for (let k = 0; k <= half; k++) {
    amp.push((4 * Math.hypot(wr[k], wi[k])) / N);             // Hann coherent gain = 0.5
    power.push((2 * (rr[k] * rr[k] + ri[k] * ri[k])) / (N * N));
  }

  const kMax = Math.min(half - 1, Math.floor(N / 4));
  const cand: number[] = [];
  for (let k = minCycles; k <= kMax; k++) if (amp[k] > amp[k - 1] && amp[k] >= amp[k + 1]) cand.push(k);
  cand.sort((p, q) => amp[q] - amp[p]);

  const T = N * dtHours;
  const peaks: Peak[] = cand.slice(0, nPeaks).map((k) => {
    const la = Math.log(amp[k - 1]), lb = Math.log(amp[k]), lc = Math.log(amp[k + 1]);
    const den = la - 2 * lb + lc;
    const delta = den !== 0 && isFinite(den) ? Math.max(-0.5, Math.min(0.5, (0.5 * (la - lc)) / den)) : 0;
    const kf = k + delta, periodHours = T / kf;
    return {
      k, kf, periodHours,
      freqHz: 1 / (periodHours * 3600),
      cyclesPerDay: 24 / periodHours,
      amp: amp[k],
      phaseDeg: ((Math.atan2(ri[k], rr[k]) * 180) / Math.PI + 360) % 360,
      share: variance > 0 ? (power[k - 1] + power[k] + power[k + 1]) / variance : 0,
    };
  });

  const explained = Math.min(0.999, peaks.reduce((s, p) => s + p.share, 0));
  return {
    N, dtHours, trendA, trendB, detrended: d, amp, power, variance, peaks,
    explained, snr: explained / (1 - explained),
    resolutionHz: 1 / (T * 3600), nyquistHz: 1 / (2 * dtHours * 3600),
  };
}

/** 0 = no clear rhythm … 4 = very strong. Same thresholds as the SINE website. */
export const STRENGTH_LABELS = ['No clear rhythm', 'Weak', 'Moderate', 'Strong', 'Very strong'] as const;

export function strengthLevel(a: Analysis): { level: number; cyclesSeen: number } {
  if (!a.peaks.length) return { level: 0, cyclesSeen: 0 };
  const e = a.explained;
  let level = e >= 0.75 ? 4 : e >= 0.55 ? 3 : e >= 0.35 ? 2 : e >= 0.15 ? 1 : 0;
  const cyclesSeen = (a.N * a.dtHours) / a.peaks[0].periodHours;
  if (cyclesSeen < 2) level = Math.min(level, 1);       // seen fewer than twice: could be coincidence
  else if (cyclesSeen < 3) level = Math.min(level, 2);  // fewer than three repeats: at most moderate
  return { level, cyclesSeen };
}

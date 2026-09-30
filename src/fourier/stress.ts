import { fft } from './fft.js';
import { lcg } from './stats.js';

export interface Stress {
  level: 0 | 1 | 2;       // 0 calm · 1 elevated · 2 high
  share: number;          // share of recent return energy in the slowest L/8 modes
  expected: number;       // ≈ what random churn gives (L/8 ÷ L/2 = 25 %)
  p: number;              // permutation test vs. this token's own returns, randomly re-ordered
  histPct: number;        // percentile of the current share within its own history over the window
  lastMove: number;       // compounded return over the last L candles (direction of the pressure)
  L: number;
  series: number[];
}

export const STRESS_LABELS = ['Calm', 'Elevated', 'High'] as const;

/**
 * Stress check — rolling Fourier spectrum of RETURNS, after Jun, Ahn, Kim & Kim (2019), Physica A 526:121015,
 * who found low-frequency components of stock-index returns surging ahead of global financial crises.
 * Sliding window of L log-returns (step 1) → FFT → share of energy in the slowest L/8 modes.
 */
export function stressIndex(closes: number[], seed = 7): Stress | null {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  const L = r.length >= 160 ? 32 : 16;
  if (r.length < L + 16) return null;
  const lowK = L / 8, half = L / 2;
  const share = (seg: number[]) => {
    const mean = seg.reduce((a, b) => a + b, 0) / L;
    const re = Float64Array.from(seg, (v) => v - mean), im = new Float64Array(L);
    fft(re, im);
    let lo = 0, tot = 0;
    for (let k = 1; k <= half; k++) { const e = (re[k] ** 2 + im[k] ** 2) * (k === half ? 0.5 : 1); tot += e; if (k <= lowK) lo += e; }
    return tot > 0 ? lo / tot : 0;
  };
  const series: number[] = [];
  for (let t = L; t <= r.length; t++) series.push(share(r.slice(t - L, t)));
  const now = series[series.length - 1];
  const histPct = series.filter((v) => v < now).length / series.length;
  const rnd = lcg(seed + r.length), M = 400;
  let ge = 0;
  for (let i = 0; i < M; i++) if (share(Array.from({ length: L }, () => r[Math.floor(rnd() * r.length)])) >= now) ge++;
  const p = (ge + 1) / (M + 1);
  const expected = lowK / half;
  // High: unusual vs. shuffled returns AND near the top of its own history. Elevated: above normal, and above chance level.
  const level: 0 | 1 | 2 = p <= 0.05 && histPct >= 0.8 ? 2 : (p <= 0.1 || histPct >= 0.9) && now > expected ? 1 : 0;
  const lastMove = Math.exp(r.slice(-L).reduce((a, b) => a + b, 0)) - 1;
  return { level, share: now, expected, p, histPct, lastMove, L, series };
}

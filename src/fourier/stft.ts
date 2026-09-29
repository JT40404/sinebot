import { fft, isPow2 } from './fft.js';

export interface Spectrogram {
  frames: Float64Array[];  // frames[f][k - kMin] = amplitude of bin k in slice f
  kMin: number;
  kMax: number;
  Lw: number;              // samples per slice
  hop: number;
  dtHours: number;
  N: number;
}

/**
 * Short-time Fourier transform (spectrogram) of log price. Each slice of Lw samples is
 * linearly detrended and Hann-windowed. Lw is a power of two: at least N/4, and long enough
 * for ~2 cycles of the main rhythm where possible, capped at N/2.
 * Bins k = 2..Lw/4 (≥ 2 cycles per slice, ≥ 4 samples per cycle).
 */
export function stft(closes: number[], dtHours: number, mainPeriodHours?: number): Spectrogram {
  const N = closes.length, y = closes.map(Math.log);
  let Lw = 1;
  const want = Math.max(N / 4, mainPeriodHours ? (2 * mainPeriodHours) / dtHours : 0);
  while (Lw < want) Lw <<= 1;
  Lw = Math.max(16, Math.min(Lw, 1 << Math.floor(Math.log2(N / 2))));
  if (!isPow2(Lw)) throw new Error('stft: bad window');
  const kMin = 2, kMax = Math.max(kMin, Lw / 4);
  const hop = Math.max(1, Math.ceil((N - Lw) / 160));
  const hann = Float64Array.from({ length: Lw }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (Lw - 1)));
  const sx = (Lw * (Lw - 1)) / 2, sxx = ((Lw - 1) * Lw * (2 * Lw - 1)) / 6, den = Lw * sxx - sx * sx;

  const starts: number[] = [];
  for (let st = 0; st + Lw <= N; st += hop) starts.push(st);
  if (starts[starts.length - 1] !== N - Lw) starts.push(N - Lw);

  const frames = starts.map((st) => {
    let sy = 0, sxy = 0;
    for (let n = 0; n < Lw; n++) { sy += y[st + n]; sxy += n * y[st + n]; }
    const b = (Lw * sxy - sx * sy) / den, a = (sy - b * sx) / Lw;
    const re = new Float64Array(Lw), im = new Float64Array(Lw);
    for (let n = 0; n < Lw; n++) re[n] = (y[st + n] - (a + b * n)) * hann[n];
    fft(re, im);
    const out = new Float64Array(kMax - kMin + 1);
    for (let k = kMin; k <= kMax; k++) out[k - kMin] = (4 * Math.hypot(re[k], im[k])) / Lw;
    return out;
  });
  return { frames, kMin, kMax, Lw, hop, dtHours, N };
}

/**
 * How persistently a rhythm of the given period showed up across the spectrogram.
 *   share:  fraction of slices where its band is ≥ half as strong as that slice's strongest rhythm
 *   change: band strength in the latest third of slices ÷ the earliest third (>1 = strengthening)
 * Returns null when the period is outside what the slices can resolve.
 */
export function persistence(sp: Spectrogram, periodHours: number): { share: number; change: number } | null {
  const kb = (sp.Lw * sp.dtHours) / periodHours;
  if (!(kb >= sp.kMin && kb <= sp.kMax)) return null;
  const kr = Math.round(kb);
  let hits = 0;
  const band: number[] = [];
  for (const f of sp.frames) {
    let top = 0, e = 0;
    for (const v of f) top = Math.max(top, v);
    for (let k = Math.max(sp.kMin, kr - 1); k <= Math.min(sp.kMax, kr + 1); k++) e = Math.max(e, f[k - sp.kMin]);
    if (top > 0 && e >= 0.5 * top) hits++;
    band.push(e);
  }
  const third = Math.max(1, Math.floor(band.length / 3));
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  return { share: hits / sp.frames.length, change: mean(band.slice(-third)) / Math.max(1e-12, mean(band.slice(0, third))) };
}

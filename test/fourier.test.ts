import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, analyze, project, stft, persistence, harmonicFit } from '../src/fourier/index.js';

const seeded = (seed: number) => { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); };
const gauss = (rnd: () => number) => (rnd() + rnd() + rnd() + rnd() - 2) * 1.2;

test('FFT matches a direct DFT', () => {
  const N = 64, x = Array.from({ length: N }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1));
  const re = Float64Array.from(x), im = new Float64Array(N);
  fft(re, im);
  for (const k of [0, 1, 5, 17, 32]) {
    let dr = 0, di = 0;
    for (let n = 0; n < N; n++) { dr += x[n] * Math.cos((2 * Math.PI * k * n) / N); di -= x[n] * Math.sin((2 * Math.PI * k * n) / N); }
    assert.ok(Math.abs(dr - re[k]) < 1e-9 && Math.abs(di - im[k]) < 1e-9, `bin ${k}`);
  }
});

test('analyze recovers planted rhythms (period and amplitude)', () => {
  const rnd = seeded(42), dt = 0.25;
  const closes = Array.from({ length: 512 }, (_, i) => {
    const t = i * dt;
    return 100 * Math.exp(0.04 * Math.sin((2 * Math.PI * t) / 40) + 0.02 * Math.sin((2 * Math.PI * t) / 16 + 1) + 0.008 * gauss(rnd));
  });
  const a = analyze(closes, dt);
  assert.ok(Math.abs(a.peaks[0].periodHours - 40) < 1.5, `period ${a.peaks[0].periodHours}`);
  assert.ok(Math.abs(a.peaks[1].periodHours - 16) < 0.5, `period ${a.peaks[1].periodHours}`);
  assert.ok(Math.abs(a.peaks[0].amp - 0.04) < 0.006, `amp ${a.peaks[0].amp}`);
});

test('analyze rejects non-power-of-two windows and bad prices', () => {
  assert.throws(() => analyze(new Array(100).fill(1), 1));
  assert.throws(() => analyze([...new Array(63).fill(1), 0], 1));
});

test('harmonicFit recovers amplitude and phase exactly', () => {
  const f = 1 / 37, y = Array.from({ length: 300 }, (_, n) => 0.5 + 0.03 * Math.cos(2 * Math.PI * f * n - 1.1));
  const m = harmonicFit(y, [f])!;
  const { c, s } = m.components[0];
  assert.ok(Math.abs(Math.hypot(c, s) - 0.03) < 1e-6);
  assert.ok(Math.abs(Math.atan2(s, c) - 1.1) < 1e-6);
  assert.ok(m.r2 > 0.999999);
});

test('projection shows skill on a real rhythm and none on a random walk', () => {
  const rnd = seeded(7);
  const rhythm = Array.from({ length: 512 }, (_, i) => 100 * Math.exp(0.05 * Math.sin((2 * Math.PI * i) / 39) + 0.004 * gauss(rnd)));
  let lp = 0;
  const walk = Array.from({ length: 512 }, () => 100 * Math.exp((lp += 0.01 * gauss(rnd))));
  const pr = project(rhythm, 1, analyze(rhythm, 1).peaks[0].periodHours)!;
  const pw = project(walk, 1, analyze(walk, 1).peaks[0].periodHours)!;
  assert.ok(pr.tested && pr.skill > 0.5, `rhythm skill ${pr.skill}`);
  assert.ok(pr.hits / pr.checks > 0.75, `rhythm hit rate ${pr.hits / pr.checks}`);
  assert.ok(pw.skill < 0.15, `random-walk skill ${pw.skill}`);
});

test('persistence: steady rhythm ≈ 100%, emerging rhythm reads as strengthening', () => {
  const steady = Array.from({ length: 512 }, (_, i) => 100 * Math.exp(0.04 * Math.sin((2 * Math.PI * i) / 12)));
  const emerging = Array.from({ length: 512 }, (_, i) => 100 * Math.exp((i > 256 ? 0.04 : 0) * Math.sin((2 * Math.PI * i) / 12) + 0.003 * Math.sin(i * 1.7)));
  const a = persistence(stft(steady, 1, 12), 12)!, b = persistence(stft(emerging, 1, 12), 12)!;
  assert.ok(a.share > 0.95, `steady share ${a.share}`);
  assert.ok(b.change > 1.4 && b.share < 0.9, `emerging change ${b.change} share ${b.share}`);
});

import { strengthLevel, fourierTrend } from '../src/fourier/index.js';

test('random walks are not reported as rhythms (significance vs. 200 simulated random walks)', () => {
  const rnd = seeded(31);
  let strong = 0, sig = 0;
  for (let m = 0; m < 40; m++) {
    let lp = 0;
    const xs = Array.from({ length: 256 }, () => 100 * Math.exp((lp += 0.01 * gauss(rnd))));
    const a = analyze(xs, 1);
    if (strengthLevel(a).level >= 3) strong++;
    if (a.sig!.pTop <= 0.05) sig++;
  }
  assert.ok(strong <= 3, `random walks rated strong: ${strong}/40`);   // ≈2% expected; allow binomial noise
  assert.ok(sig <= 5, `random walks called significant: ${sig}/40`);
});

test('real rhythms stay significant and mean-reverting', () => {
  const rnd = seeded(12);
  const xs = Array.from({ length: 512 }, (_, i) => 100 * Math.exp(0.03 * Math.sin((2 * Math.PI * i) / 40) + 0.01 * gauss(rnd)));
  const a = analyze(xs, 1);
  assert.ok(a.sig!.pTop <= 0.05 && a.sig!.pKss <= 0.05, `pTop ${a.sig!.pTop} pKss ${a.sig!.pKss}`);
  assert.ok(Math.abs(a.peaks[0].periodHours - 40) < 1.5);
});

test('Fourier trend removes a slow boom-and-bust so the real rhythm is measured at its true size', () => {
  const rnd = seeded(4);
  const xs = Array.from({ length: 512 }, (_, i) => 100 * Math.exp(0.35 * Math.exp(-(((i - 256) / 110) ** 2)) + 0.015 * Math.sin((2 * Math.PI * i) / 64) + 0.006 * gauss(rnd)));
  const a = analyze(xs, 1);
  assert.equal(a.peaks[0].k, 8, `top rhythm bin ${a.peaks[0].k}`);
  assert.ok(a.peaks[0].share > 0.2, `share ${a.peaks[0].share}`);
  assert.ok(fourierTrend(xs.map(Math.log)).k <= 1.5);
});


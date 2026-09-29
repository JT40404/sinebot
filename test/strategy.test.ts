import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { ConfigSchema } from '../src/config/schema.js';
import { inPhaseWindow, priceExit, openPosition } from '../src/strategy/rules.js';
import { positionSize } from '../src/strategy/sizing.js';
import { buildSnapshot } from '../src/strategy/snapshot.js';
import { runBacktest } from '../src/engine/backtest.js';

const base = () => ConfigSchema.parse({});

test('phase window wraps around the trough', () => {
  assert.equal(inPhaseWindow(0.95, 0.9, 0.2), true);
  assert.equal(inPhaseWindow(0.1, 0.9, 0.2), true);
  assert.equal(inPhaseWindow(0.5, 0.9, 0.2), false);
  assert.equal(inPhaseWindow(0.3, 0.2, 0.4), true);
});

test('every shipped config and preset is valid; presets inherit from default', () => {
  for (const f of ['default', 'presets/swing', 'presets/scalper', 'presets/conservative', 'presets/trend-dips']) {
    const cfg = loadConfig(`config/${f}.yaml`);
    assert.ok(cfg.watchlist.length > 0, `${f} inherits the watchlist`);
  }
  assert.equal(loadConfig('config/presets/scalper.yaml').market.interval, '1m');
});

test('invalid settings are rejected with a readable message', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sine-'));
  const f = path.join(dir, 'bad.yaml');
  writeFileSync(f, 'market: { windowCandles: 500 }\nexit: { stopLossPct: -3 }\n');
  assert.throws(() => loadConfig(f), /windowCandles[\s\S]*stopLossPct/);
  writeFileSync(f, 'watchlist: [{ mint: So11111111111111111111111111111111111111112, label: SOL }]\nblocklist: [So11111111111111111111111111111111111111112]\n');
  assert.throws(() => loadConfig(f), /blocklisted/);
});

test('sizing modes', () => {
  const cfg = base();
  assert.equal(positionSize(10, { ...cfg, sizing: { ...cfg.sizing, mode: 'fixed', fixedSol: 0.2 } }), 0.2);
  assert.equal(positionSize(10, { ...cfg, sizing: { ...cfg.sizing, mode: 'percent', percentOfBalance: 5 } }), 0.5);
  // risk: 1% of 10 SOL at risk with a 5% stop → 2 SOL, capped by maxSol 1
  assert.equal(positionSize(10, { ...cfg, exit: { ...cfg.exit, stopLossPct: 5 }, sizing: { ...cfg.sizing, mode: 'risk', riskPercent: 1, maxSol: 1 } }), 1);
  assert.equal(positionSize(0.005, cfg), 0);
});

test('stops are checked before targets inside a bar', () => {
  const cfg = base();
  const closes = Array.from({ length: 512 }, (_, i) => 100 * Math.exp(0.04 * Math.sin((2 * Math.PI * i) / 40)));
  const snap = buildSnapshot(closes, cfg)!;
  const pos = openPosition(100, 0, 1, snap, { ...cfg, exit: { ...cfg.exit, takeProfitPct: 5, stopLossPct: 5 } });
  const hit = priceExit(pos, { o: 100, h: 106, l: 94, c: 100 });
  assert.equal(hit?.reason, 'stop loss');
  assert.equal(hit?.price, 95);
});

function candles(n: number, seed = 3) {
  let s = seed, lp = 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, (_, i) => {
    const prev = lp;
    lp = 0.06 * Math.sin((2 * Math.PI * i) / 32) + 0.006 * (rnd() - 0.5);
    const o = Math.exp(prev), c = Math.exp(lp);
    return { t: 1_700_000_000 + i * 900, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1 };
  });
}

test('backtest never looks ahead: changing the future does not change past trades', () => {
  const cfg = ConfigSchema.parse({ market: { windowCandles: 128 }, entry: { minCyclesSeen: 3 } });
  const a = candles(600);
  const cut = 450;
  const b = a.map((c, i) => (i > cut ? { ...c, o: c.o * 3, h: c.h * 3, l: c.l * 3, c: c.c * 3 } : c));
  const ra = runBacktest(a, cfg), rb = runBacktest(b, cfg);
  const before = (r: typeof ra) => r.trades.filter((t) => t.exitTime <= a[cut].t);
  assert.ok(before(ra).length > 0, 'the test needs some trades before the cut');
  assert.deepEqual(before(ra), before(rb));
});

test('backtest trades a clean rhythm and stays out of pure noise', () => {
  const cfg = ConfigSchema.parse({ market: { windowCandles: 128 } });
  const rhythm = runBacktest(candles(700), cfg);
  let s = 9, lp = 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const noise = Array.from({ length: 700 }, (_, i) => {
    const prev = lp; lp += 0.01 * (rnd() + rnd() + rnd() - 1.5);
    const o = Math.exp(prev), c = Math.exp(lp);
    return { t: 1_700_000_000 + i * 900, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 };
  });
  const quiet = runBacktest(noise, cfg);
  assert.ok(rhythm.trades.length >= 5, `rhythm trades ${rhythm.trades.length}`);
  assert.ok(quiet.trades.length <= 2, `noise trades ${quiet.trades.length}`);
});

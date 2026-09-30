import { analyze, strengthLevel, STRENGTH_LABELS, harmonicFit, stft, persistence, project, stressIndex, STRESS_LABELS, type Analysis, type Stress } from '../fourier/index.js';
import { INTERVAL_HOURS, type Config } from '../config/schema.js';

export interface Turning { price: number; pct: number; hours: number; bars: number; bandLow: number; bandHigh: number }

/** Everything the rules look at, computed from one window of closes. */
export interface Snapshot {
  price: number;
  level: number;                     // rhythm strength 0–4
  strength: string;
  explained: number;                 // share of movement explained by the top rhythms (0–1)
  snr: number;
  cyclesSeen: number;
  periodHours: number;               // main rhythm
  amplitudePct: number;              // ± % swing of the main rhythm
  trendPctPerDay: number;
  phase: { frac: number; rising: boolean; hoursToCrest: number; hoursToTrough: number };
  persistence: { share: number; change: number } | null;
  projection: {
    tested: boolean; tests: number; skill: number; hitRate: number; horizonHours: number;
    high: Turning; low: Turning;
  } | null;
  significance: { pRhythm: number | null; pMeanReversion: number | null; pRegimeShift: number | null; regimeK: number };
  stress: (Stress & { label: string }) | null;
  analysis: Analysis;
}

export interface SnapshotNeeds { persistence: boolean; projection: boolean }

export function needsFor(cfg: Config): SnapshotNeeds {
  return {
    persistence: cfg.entry.persistence.min !== null || cfg.entry.persistence.requireStrengthening,
    projection: cfg.entry.projection.enabled || cfg.exit.atProjectedHigh.enabled,
  };
}

/** closes: exactly cfg.market.windowCandles completed closes, oldest first. */
export function buildSnapshot(closes: number[], cfg: Config, needs = needsFor(cfg)): Snapshot | null {
  const dt = INTERVAL_HOURS[cfg.market.interval];
  const a = analyze(closes, dt, { nPeaks: cfg.analysis.nPeaks, minCycles: cfg.analysis.minCycles });
  if (!a.peaks.length) return null;
  const N = closes.length, p0 = a.peaks[0], P = p0.periodHours;
  const { level, cyclesSeen } = strengthLevel(a);

  // Cycle position from a least-squares fit of the detected rhythms (exact phase, no bin error).
  const model = harmonicFit(closes.map(Math.log), a.peaks.map((p) => dt / p.periodHours));
  let psi = 0;
  if (model) {
    const { f, c, s } = model.components[0];
    psi = 2 * Math.PI * f * (N - 1) - Math.atan2(s, c);   // component = A·cos(ψ); ψ = 0 at a crest
    psi = Math.atan2(Math.sin(psi), Math.cos(psi));
  }
  const TWO_PI = 2 * Math.PI;
  const phase = {
    frac: (psi + Math.PI) / TWO_PI,                     // 0 = trough, 0.5 = crest
    rising: psi < 0,
    hoursToCrest: (((TWO_PI - psi) % TWO_PI) / TWO_PI) * P,
    hoursToTrough: (((3 * Math.PI - psi) % TWO_PI) / TWO_PI) * P,
  };

  // Stress = slow pressure the rhythms DON'T explain: when a real rhythm is present (moderate+), subtract the
  // fitted rhythms first, so a cycle's regular down-swings aren't mistaken for building pressure.
  const stressInput = level >= 2 && model ? closes.map((c, n) => Math.exp(Math.log(c) - model.predict(n))) : closes;
  const st = stressIndex(stressInput);
  if (st && stressInput !== closes) {             // report the real price move over the stress window, not the residual's
    const L = st.L; st.lastMove = closes[N - 1] / closes[Math.max(0, N - 1 - L)] - 1;
  }

  let pers: Snapshot['persistence'] = null;
  if (needs.persistence) pers = persistence(stft(closes, dt, P), P);

  let proj: Snapshot['projection'] = null;
  if (needs.projection) {
    const pr = project(closes, dt, P);
    if (pr) {
      let hiH = 1, loH = 1;
      for (let h = 1; h <= pr.horizon; h++) {
        if (pr.center[h] > pr.center[hiH]) hiH = h;
        if (pr.center[h] < pr.center[loH]) loH = h;
      }
      const last = closes[N - 1];
      const turn = (h: number): Turning => {
        const price = Math.exp(pr.center[h]);
        return { price, pct: (price / last - 1) * 100, hours: h * dt, bars: h, bandLow: Math.exp(pr.lo[h]), bandHigh: Math.exp(pr.hi[h]) };
      };
      proj = {
        tested: pr.tested, tests: pr.tests, skill: pr.skill,
        hitRate: pr.checks ? pr.hits / pr.checks : 0,
        horizonHours: pr.horizon * dt, high: turn(hiH), low: turn(loH),
      };
    }
  }

  return {
    price: closes[N - 1], level, strength: STRENGTH_LABELS[level],
    explained: a.explained, snr: a.snr, cyclesSeen, periodHours: P,
    amplitudePct: p0.amp * 100,
    trendPctPerDay: (Math.exp(a.trendB * (24 / dt)) - 1) * 100,
    phase, persistence: pers, projection: proj,
    significance: { pRhythm: a.sig?.pTop ?? null, pMeanReversion: a.sig?.pKss ?? null, pRegimeShift: a.sig?.pBreak ?? null, regimeK: a.trend.k },
    stress: st ? { ...st, label: STRESS_LABELS[st.level] } : null,
    analysis: a,
  };
}

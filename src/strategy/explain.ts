import type { Snapshot } from './snapshot.js';

const dur = (h: number) => (h < 1 / 60 ? `${Math.round(h * 3600)} s` : h < 1 ? `${Math.round(h * 60)} min` : h >= 72 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`);
export { dur as fmtDuration };

/** Plain-English reading of a snapshot — the same language the SINE website uses. */
export function explain(s: Snapshot, name = 'This token'): string[] {
  const out: string[] = [];
  if (s.level === 0) {
    out.push(`${name}'s recent moves look mostly random — no rhythm explains much of them.`);
  } else {
    out.push(`${name} has a ${s.strength.toLowerCase()} rhythm: about every ${dur(s.periodHours)} it swings ±${s.amplitudePct.toFixed(1)}% around its trend (${Math.round(s.explained * 100)}% of the movement; repeated ${s.cyclesSeen.toFixed(1)}×).`);
  }
  const sg = s.significance, pct = (p: number) => (p < 0.01 ? 'under 1%' : `about ${Math.round(p * 100)}%`);
  if (sg.pRhythm !== null && s.level > 0) {
    out.push(sg.pRhythm <= 0.05
      ? `Against 200 simulated random walks, a rhythm this distinct appeared by chance ${pct(sg.pRhythm)} of the time: statistically real.`
      : `In 200 simulated random walks a rhythm this distinct appeared ${pct(sg.pRhythm)} of the time, so it is suggestive, not proven.`);
  } else if (sg.pRhythm !== null && sg.pRhythm > 0.3) {
    out.push(`Its swings are the kind a random walk makes by chance (${pct(sg.pRhythm)} of simulations): likely noise.`);
  }
  if (sg.pMeanReversion !== null) {
    out.push(sg.pMeanReversion <= 0.05
      ? `Price tends to pull back toward its trend (Fourier KSS p ${sg.pMeanReversion < 0.01 ? '< 0.01' : '≈ ' + sg.pMeanReversion.toFixed(2)}).`
      : `Pull-back toward the trend is not clear (Fourier KSS p ≈ ${sg.pMeanReversion.toFixed(2)}): closer to a random walk.`);
  }
  if (sg.pRegimeShift !== null && sg.pRegimeShift <= 0.05) out.push(`A slow regime shift (≈${sg.regimeK.toFixed(1)} of a cycle) was removed before measuring rhythms.`);
  if (s.stress) {
    const st = s.stress, mv = st.lastMove * 100;
    out.push(`Stress check: ${st.label}. Slow moves are ${Math.round(st.share * 100)}% of recent return energy (random churn ≈ ${Math.round(st.expected * 100)}%)` +
      (st.level > 0 ? `, pressure ${mv >= 0 ? 'upward' : 'downward'} (${mv >= 0 ? '+' : ''}${mv.toFixed(1)}% over ${st.L} candles).` : '.'));
  }
  if (s.persistence) {
    const p = s.persistence;
    out.push(`Over time it was clearly present in ${Math.round(p.share * 100)}% of the window${p.change >= 1.4 ? ' and has been strengthening' : p.change <= 0.7 ? ' and has been fading' : ''}.`);
  }
  out.push(s.phase.rising
    ? `It is in the rising half of the cycle; the next crest would come in ~${dur(s.phase.hoursToCrest)} if the rhythm holds.`
    : `It is in the falling half of the cycle; the next trough would come in ~${dur(s.phase.hoursToTrough)} if the rhythm holds.`);
  out.push(`Underlying trend: ${s.trendPctPerDay >= 0 ? '+' : ''}${s.trendPctPerDay.toFixed(2)}% per day.`);
  const p = s.projection;
  if (p) {
    const sign = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
    out.push(`If the pattern holds: high ${sign(p.high.pct)} in ~${dur(p.high.hours)}, low ${sign(p.low.pct)} in ~${dur(p.low.hours)}.`);
    out.push(p.tested
      ? `Track record here: direction right ${Math.round(p.hitRate * 100)}% across ${p.tests} past tests; ${p.skill >= 0 ? `${Math.round(p.skill * 100)}% more` : `${Math.round(-p.skill * 100)}% less`} accurate than assuming no change.`
      : 'Not enough history to test the projection — treat it as illustration only.');
  }
  return out;
}

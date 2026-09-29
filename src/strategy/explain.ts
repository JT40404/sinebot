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

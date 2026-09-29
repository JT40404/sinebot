import type { Config } from '../config/schema.js';

/** Position size in SOL for the configured sizing mode, clamped to [minSol, maxSol]; 0 = skip. */
export function positionSize(balanceSol: number, cfg: Config): number {
  const z = cfg.sizing;
  let size =
    z.mode === 'fixed' ? z.fixedSol :
    z.mode === 'percent' ? (balanceSol * z.percentOfBalance) / 100 :
    ((balanceSol * z.riskPercent) / 100) / (cfg.exit.stopLossPct / 100);   // risk: a stop-out loses riskPercent of balance
  size = Math.min(size, z.maxSol, balanceSol);
  return size >= z.minSol ? size : 0;
}

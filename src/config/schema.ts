import { z } from 'zod';
import { isPow2 } from '../fourier/fft.js';

export const INTERVALS = ['1s', '15s', '30s', '1m', '5m', '15m', '1h', '4h', '12h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];
export const INTERVAL_HOURS: Record<Interval, number> = {
  '1s': 1 / 3600, '15s': 15 / 3600, '30s': 30 / 3600, '1m': 1 / 60, '5m': 5 / 60, '15m': 0.25,
  '1h': 1, '4h': 4, '12h': 12, '1d': 24,
};

const pct = (d: number) => z.number().min(0).max(100).default(d);
const frac = (d: number) => z.number().min(0).max(1).default(d);
const mint = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a Solana mint address (base58)');

export const ConfigSchema = z.object({
  name: z.string().default('my-strategy'),

  market: z.object({
    interval: z.enum(INTERVALS).default('15m'),
    windowCandles: z.number().int().refine((n) => isPow2(n) && n >= 64 && n <= 2048, 'must be a power of two between 64 and 2048 (64, 128, 256, 512, 1024, 2048)').default(512),
    evaluateEvery: z.number().int().min(1).default(1),
  }).default({}),

  watchlist: z.array(z.object({ mint, label: z.string() })).default([]),
  blocklist: z.array(mint).default([]),

  analysis: z.object({
    nPeaks: z.number().int().min(1).max(5).default(3),
    minCycles: z.number().min(2).default(2),
  }).default({}),

  entry: z.object({
    minStrength: z.number().int().min(0).max(4).default(2),
    minCyclesSeen: z.number().min(0).default(3),
    persistence: z.object({
      min: frac(0.5).nullable(),
      requireStrengthening: z.boolean().default(false),
    }).default({}),
    phase: z.object({
      enabled: z.boolean().default(true),
      from: frac(0.9),
      to: frac(0.2),
      requireRising: z.boolean().default(true),
    }).default({}),
    trend: z.object({
      minPctPerDay: z.number().nullable().default(null),
      maxPctPerDay: z.number().nullable().default(null),
    }).default({}),
    projection: z.object({
      enabled: z.boolean().default(true),
      requireTested: z.boolean().default(true),
      minSkill: z.number().min(-10).max(1).default(0.1),
      minHitRate: frac(0.55),
      minUpsidePct: z.number().min(0).default(2),
      minRewardRisk: z.number().min(0).default(1.2),
    }).default({}),
    costMultiple: z.number().min(0).default(3),
  }).default({}),

  exit: z.object({
    stopLossPct: z.number().positive().max(90).default(6),
    takeProfitPct: z.number().positive().nullable().default(null),
    trailingStopPct: z.number().positive().max(90).nullable().default(null),
    atProjectedHigh: z.object({ enabled: z.boolean().default(true), bufferPct: pct(0.5) }).default({}),
    onCycleTurn: z.boolean().default(true),
    onStrengthBelow: z.number().int().min(0).max(4).nullable().default(1),
    maxHoldCycles: z.number().positive().default(0.75),
  }).default({}),

  sizing: z.object({
    mode: z.enum(['fixed', 'percent', 'risk']).default('fixed'),
    fixedSol: z.number().positive().default(0.1),
    percentOfBalance: z.number().positive().max(100).default(5),
    riskPercent: z.number().positive().max(100).default(1),
    minSol: z.number().nonnegative().default(0.01),
    maxSol: z.number().positive().default(1),
  }).default({}),

  risk: z.object({
    maxOpenPositions: z.number().int().min(1).default(3),
    dailyLossLimitSol: z.number().positive().default(0.5),
    cooldownBars: z.number().int().min(0).default(4),
    minLiquidityUsd: z.number().nonnegative().default(100_000),
    minSolReserve: z.number().nonnegative().default(0.05),
  }).default({}),

  execution: z.object({
    mode: z.enum(['paper', 'live']).default('paper'),
    slippageBps: z.number().int().min(1).max(5000).default(100),
    expectedSlippageBps: z.number().min(0).default(20),
    feeBps: z.number().min(0).default(30),
    maxPriceImpactPct: z.number().positive().default(1),
    priorityFeeMaxLamports: z.number().int().nonnegative().default(1_000_000),
  }).default({}),

  backtest: z.object({
    startingBalanceSol: z.number().positive().default(10),
    candles: z.number().int().min(256).max(20_000).default(3000),
  }).default({}),

  logging: z.object({
    explain: z.boolean().default(true),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

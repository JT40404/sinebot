import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema, type Config } from './schema.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge: objects merge key by key, arrays and scalars are replaced. */
export function deepMerge(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Obj, v) : v;
  return out;
}

/** Resolve `extends:` references: "presets/swing" → config/presets/swing.yaml, or a path relative to the file. */
function resolveExtends(ref: string, fromFile: string): string {
  const candidates = [
    path.resolve(path.dirname(fromFile), ref),
    path.resolve(path.dirname(fromFile), ref + '.yaml'),
    path.resolve('config', ref),
    path.resolve('config', ref + '.yaml'),
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`Cannot find "${ref}" (extended from ${fromFile})`);
  return hit;
}

function readLayered(file: string, seen = new Set<string>()): Obj {
  const abs = path.resolve(file);
  if (seen.has(abs)) throw new Error(`Circular "extends" involving ${abs}`);
  seen.add(abs);
  const raw = parseYaml(readFileSync(abs, 'utf8')) ?? {};
  if (!isObj(raw)) throw new Error(`${file} must contain a YAML mapping`);
  const { extends: ext, ...rest } = raw;
  if (typeof ext === 'string') return deepMerge(readLayered(resolveExtends(ext, abs), seen), rest);
  return rest;
}

export function loadConfig(file = 'config/default.yaml', overrides: Obj = {}): Config {
  const merged = deepMerge(readLayered(file), overrides);
  const res = ConfigSchema.safeParse(merged);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration in ${file}:\n${lines.join('\n')}`);
  }
  const cfg = res.data;
  const clash = cfg.watchlist.filter((w) => cfg.blocklist.includes(w.mint));
  if (clash.length) throw new Error(`Watchlist contains blocklisted mints: ${clash.map((c) => c.label).join(', ')}`);
  if (cfg.exit.takeProfitPct !== null && cfg.exit.takeProfitPct <= cfg.exit.stopLossPct * 0.25) {
    console.warn(`warning: takeProfitPct (${cfg.exit.takeProfitPct}) is tiny next to stopLossPct (${cfg.exit.stopLossPct})`);
  }
  return cfg;
}

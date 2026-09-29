/**
 * Market data from GeckoTerminal / CoinGecko's on-chain DEX API.
 *   no key          → GeckoTerminal public API (low, per-IP rate limits)
 *   COINGECKO_API_KEY + COINGECKO_PLAN=demo|pro → CoinGecko on-chain endpoints (per-key limits)
 * Second-level candles (1s/15s/30s) need a Pro key.
 */
import type { Interval } from '../config/schema.js';
import type { Candle } from './types.js';

const KEY = (process.env.COINGECKO_API_KEY || '').trim();
const PRO = (process.env.COINGECKO_PLAN || '').trim().toLowerCase() === 'pro';
const BASE = !KEY ? 'https://api.geckoterminal.com/api/v2' : PRO ? 'https://pro-api.coingecko.com/api/v3/onchain' : 'https://api.coingecko.com/api/v3/onchain';
const MIN_GAP_MS = !KEY ? 2500 : PRO ? 150 : 2100;
export const DATA_SOURCE = !KEY ? 'GeckoTerminal (public)' : PRO ? 'CoinGecko Pro' : 'CoinGecko Demo';

const TF: Record<Interval, [tf: string, agg: number, sec: number]> = {
  '1s': ['second', 1, 1], '15s': ['second', 15, 15], '30s': ['second', 30, 30],
  '1m': ['minute', 1, 60], '5m': ['minute', 5, 300], '15m': ['minute', 15, 900],
  '1h': ['hour', 1, 3600], '4h': ['hour', 4, 14400], '12h': ['hour', 12, 43200], '1d': ['day', 1, 86400],
};
export const intervalSeconds = (iv: Interval) => TF[iv][2];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

async function get(path: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'sine-bot (open source)' };
    if (KEY) headers[PRO ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = KEY;
    const res = await fetch(BASE + path, { headers });
    if (res.status === 429) { await sleep(3000 * 2 ** attempt); continue; }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      const hint = res.status === 403 && !KEY ? ' — keyless access is often blocked; set COINGECKO_API_KEY (a free Demo key works)' : '';
      throw new Error(`Market data ${res.status} for ${path.split('?')[0]}${hint}${body ? `: ${body}` : ''}`);
    }
    return res.json();
  }
  throw new Error('Market data provider kept rate-limiting; try again later or use an API key.');
}

export interface PoolInfo { address: string; name: string; liquidityUsd: number; symbol: string }

/** The token's most liquid pool. */
export async function findPool(mint: string): Promise<PoolInfo> {
  const j = await get(`/networks/solana/tokens/${mint}?include=top_pools`);
  const pools = (j?.included ?? []).filter((x: any) => x.type === 'pool').map((p: any) => ({
    address: p.attributes.address as string,
    name: p.attributes.name as string,
    liquidityUsd: Number(p.attributes.reserve_in_usd) || 0,
    symbol: String(j?.data?.attributes?.symbol ?? ''),
  })).sort((a: PoolInfo, b: PoolInfo) => b.liquidityUsd - a.liquidityUsd);
  if (!pools.length) throw new Error(`No pools found for ${mint}`);
  return pools[0];
}

/**
 * The last `count` COMPLETED candles (USD price of `mint` in `pool`), oldest first, evenly spaced.
 * Bars with no trades are forward-filled so the Fourier analysis sees even sampling.
 */
export async function fetchCandles(pool: string, mint: string, iv: Interval, count: number): Promise<Candle[]> {
  if (TF[iv][0] === 'second' && !(KEY && PRO)) throw new Error(`${iv} candles need a CoinGecko Pro key (COINGECKO_PLAN=pro)`);
  const [tf, agg, sec] = TF[iv];
  const byT = new Map<number, Candle>();
  let before: number | undefined;
  while (byT.size < count + 2) {
    const limit = Math.min(1000, count + 2 - byT.size);
    const q = `?aggregate=${agg}&limit=${limit}&currency=usd&token=${mint}${before ? `&before_timestamp=${before}` : ''}`;
    const list: number[][] = (await get(`/networks/solana/pools/${pool}/ohlcv/${tf}${q}`))?.data?.attributes?.ohlcv_list ?? [];
    if (!list.length) break;
    for (const r of list) if (+r[4] > 0) byT.set(r[0], { t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    before = Math.min(...list.map((r) => r[0]));
    if (list.length < limit) break;
  }
  const now = Date.now() / 1000;
  const done = [...byT.values()].filter((c) => c.t + sec <= now).sort((a, b) => a.t - b.t);
  const out: Candle[] = [];
  for (const c of done) {
    const prev = out[out.length - 1];
    if (prev) for (let t = prev.t + sec; t < c.t; t += sec) out.push({ t, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 });
    out.push(c);
  }
  return out.slice(-count);
}

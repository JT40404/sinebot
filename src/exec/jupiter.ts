import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { Config } from '../config/schema.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface Fill { paper: boolean; signature?: string; inAmount: string; outAmount: string; priceImpactPct: number }

/**
 * Swaps through the Jupiter aggregator. Paper mode requests real quotes but never signs or sends.
 * Live mode needs BOTH execution.mode: live in the config AND LIVE_TRADING=true in the environment.
 */
export class Executor {
  readonly live: boolean;
  readonly conn: Connection;
  private kp?: Keypair;
  private base = (process.env.JUPITER_BASE_URL || 'https://lite-api.jup.ag/swap/v1').replace(/\/$/, '');
  private apiKey = process.env.JUPITER_API_KEY || '';

  constructor(private cfg: Config) {
    this.live = cfg.execution.mode === 'live' && process.env.LIVE_TRADING === 'true';
    if (cfg.execution.mode === 'live' && !this.live) console.warn('execution.mode is "live" but LIVE_TRADING is not "true" — running in PAPER mode.');
    this.conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
    if (this.live) {
      const p = process.env.WALLET_KEYPAIR_PATH;
      if (!p) throw new Error('Live trading needs WALLET_KEYPAIR_PATH (a Solana keypair JSON file).');
      this.kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
    }
  }

  get wallet(): PublicKey | undefined { return this.kp?.publicKey; }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['content-type'] = 'application/json';
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  private guard(...mints: string[]) {
    const blocked = mints.find((m) => this.cfg.blocklist.includes(m));
    if (blocked) throw new Error(`Refusing to trade blocklisted mint ${blocked}`);
  }

  async quote(inputMint: string, outputMint: string, amountRaw: string): Promise<any> {
    this.guard(inputMint, outputMint);
    const q = new URLSearchParams({ inputMint, outputMint, amount: amountRaw, slippageBps: String(this.cfg.execution.slippageBps) });
    const res = await fetch(`${this.base}/quote?${q}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async swap(inputMint: string, outputMint: string, amountRaw: string): Promise<Fill> {
    const quote = await this.quote(inputMint, outputMint, amountRaw);
    const impact = Number(quote.priceImpactPct ?? 0) * 100;
    if (impact > this.cfg.execution.maxPriceImpactPct) throw new Error(`Price impact ${impact.toFixed(2)}% exceeds ${this.cfg.execution.maxPriceImpactPct}%`);
    if (!this.live || !this.kp) return { paper: true, inAmount: quote.inAmount, outAmount: quote.outAmount, priceImpactPct: impact };

    const res = await fetch(`${this.base}/swap`, {
      method: 'POST', headers: this.headers(true),
      body: JSON.stringify({
        quoteResponse: quote, userPublicKey: this.kp.publicKey.toBase58(),
        wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: this.cfg.execution.priorityFeeMaxLamports, priorityLevel: 'high' } },
      }),
    });
    if (!res.ok) throw new Error(`Jupiter swap ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const s = await res.json();
    const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64'));
    tx.sign([this.kp]);
    const signature = await this.conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const conf = await this.conn.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: s.lastValidBlockHeight }, 'confirmed');
    if (conf.value.err) throw new Error(`Swap failed on-chain (${signature}): ${JSON.stringify(conf.value.err)}`);
    return { paper: false, signature, inAmount: quote.inAmount, outAmount: quote.outAmount, priceImpactPct: impact };
  }

  async tokenBalanceRaw(mint: string): Promise<bigint> {
    if (!this.kp) return 0n;
    const r = await this.conn.getParsedTokenAccountsByOwner(this.kp.publicKey, { mint: new PublicKey(mint) });
    return r.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  async solBalance(): Promise<number> {
    if (!this.kp) return Number(process.env.PAPER_BALANCE_SOL || 10);
    return (await this.conn.getBalance(this.kp.publicKey)) / 1e9;
  }
}

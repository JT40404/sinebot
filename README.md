# sine-bot

**An open-source Solana trading bot built on Fourier analysis of price rhythms.**

sine-bot looks for repeating swings in a token's price with a Fourier transform, the same maths audio analyzers use to split sound into notes. It measures how strong and steady those rhythms are and where the price sits in the cycle right now. It projects the pattern forward and **tests that projection against the token's own history** before trusting it. Every rule it trades on is a setting in a commented YAML file, so you can shape it to your own trading style.

> ⚠️ **Read [the disclaimer](#disclaimer) before using real money.** This is experimental software. Crypto trading can lose all of your capital. Paper-trade first. Nothing here is financial advice.

---

## What it does

| Step | What happens |
|---|---|
| **Measure** | Takes the last *N* candles, removes the trend, windows the data and runs an FFT. It reports the top rhythms: period, amplitude and share of the price movement each explains. |
| **Rate** | Scores rhythm strength from 0 (none) to 4 (very strong), and marks it down if the rhythm has only repeated a few times. |
| **Check persistence** | A spectrogram (sliding FFT) shows whether the rhythm held the whole time, or is emerging or fading. |
| **Locate** | A least-squares fit gives the exact cycle position: 0 is a trough, 0.5 a crest, rising or falling. |
| **Project, honestly** | Extends trend + rhythms forward. A walk-forward test at 12 earlier points, each using only the data available then, gives its **skill** vs. "price stays put", its directional **hit rate**, and an 80% error band. |
| **Decide** | Your YAML rules turn these readings into entries, exits and position sizes. The **backtester and the live bot run the exact same decision code.** |
| **Execute** | Swaps through Jupiter. **Paper trading by default.** Live trading needs two separate switches turned on. |

## Quick start

Requires Node.js 20 or newer.

```bash
git clone https://github.com/<you>/sine-bot.git
cd sine-bot
npm install
cp .env.example .env        # optionally add a free CoinGecko Demo API key

npm run selftest            # offline: confirms the maths recovers known rhythms
npm test                    # unit tests, including a no-look-ahead check on the backtester

npm run analyze -- JUP                     # plain-English readout + what your rules would do now
npm run backtest -- JUP --preset swing     # test a strategy on real history
npm run compare -- JUP                     # every preset, same token, side by side
npm start                                  # run the bot (paper trading)
```

`analyze` prints something like this:

```
JUP · Strong rhythm
  JUP has a strong rhythm: about every 36.0 h it swings ±3.1% around its trend (61% of the movement; repeated 8.5×).
  Over time it was clearly present in 82% of the window.
  It is in the rising half of the cycle; the next crest would come in ~11.2 h if the rhythm holds.
  If the pattern holds: high +4.2% in ~12.0 h, low −2.8% in ~30.0 h.
  Track record here: direction right 68% across 12 past tests; 21% more accurate than assuming no change.

Your entry rules (balanced): would wait
  · phase 0.31 outside 0.9–0.2
```

## Make it yours

All behaviour lives in **`config/default.yaml`**, where every option is documented inline. Copy it or extend a preset:

```yaml
# my-strategy.yaml
extends: presets/swing          # inherit everything from the swing preset…
name: my-strategy
market: { interval: 1h }        # …and change only what you want
entry:
  minStrength: 3
  phase: { from: 0.85, to: 0.15 }
exit:
  trailingStopPct: 3
sizing: { mode: risk, riskPercent: 0.5 }
```

```bash
npm run validate -- --config my-strategy.yaml     # checks every value, prints the resolved config
npm run backtest -- JUP --config my-strategy.yaml
```

### Presets

These are starting points, not recommendations.

| Preset | Candles | Idea |
|---|---|---|
| `default` (balanced) | 15m | Moderate+ rhythms, buy near the trough as it turns up, sell near the projected high. |
| `swing` | 15m | Strong, persistent rhythms only. Stricter projection track record. |
| `scalper` | 1m | Short rhythms, tight stop and trailing stop, high cost margin. |
| `conservative` | 1h | Very steady rhythms with a proven track record. Risk-based sizing, low limits. |
| `trend-dips` | 1h | Only in an uptrend. Buys cycle dips and rides with a trailing stop. |

### What you can configure

| Area | Settings |
|---|---|
| **Market** | Candle interval (1s–1d; seconds need CoinGecko Pro) · window length · how often to re-analyze |
| **Entry** | Minimum rhythm strength · repetitions seen · persistence and "strengthening" · phase window and rising-only · trend limits · projection skill, hit rate, upside, reward/risk · cost margin |
| **Exit** | Stop-loss · take-profit · trailing stop · sell near projected high · sell when the cycle passes its crest · sell if the rhythm weakens · max hold, in cycles |
| **Sizing** | Fixed SOL · % of balance · risk-based (a stop-out costs X% of balance) · min/max |
| **Risk** | Max open positions · daily loss limit · cooldown after a trade · minimum pool liquidity · SOL reserve |
| **Execution** | Paper/live · max slippage · price-impact cap · priority fee |
| **Safety** | `blocklist`: mints the bot will never touch, checked when the config loads *and* before every swap |

### Tuning with the backtester

Every backtest lists **why entries were skipped**:

```
Most common reasons entries were skipped:
     452 × cycle is falling
     324 × phase # outside #–#
     240 × reward/risk # < #
```

This shows which rule is doing the filtering, so you can loosen or tighten it deliberately. Add `--csv` to export every trade and the equity curve.

## How it works

See **[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)** for the maths in plain language and in formulas. The Fourier library in `src/fourier/` has no dependencies and can be reused on its own.

```
src/
  fourier/     fft · analyze · harmonics (least squares) · stft (spectrogram) · project (walk-forward)
  strategy/    snapshot (features) · rules (entry/exit) · sizing · explain (plain English)
  config/      zod schema with defaults · YAML loader with `extends`
  data/        GeckoTerminal / CoinGecko on-chain candles
  engine/      backtest · live loop
  exec/        Jupiter swaps (paper / live)
config/        default.yaml + presets/
test/          unit tests (node:test)
```

## Going live (carefully)

1. Backtest your config on **several tokens and time periods**. A single good backtest proves little.
2. Paper-trade for a few weeks with `npm start`. Trades go to `trades.csv` and state to `state.json`.
3. Create a **dedicated hot wallet** holding only what you can afford to lose. Point `WALLET_KEYPAIR_PATH` at it, and never commit it.
4. Use a paid RPC endpoint (`RPC_URL`).
5. Set `execution.mode: live` in your config **and** `LIVE_TRADING=true` in `.env`. Both are required.
6. To stop the bot, create a file named `STOP` in the project folder.

## Environment variables

| Variable | Purpose |
|---|---|
| `COINGECKO_API_KEY`, `COINGECKO_PLAN` | Market data. A free Demo key avoids most rate limits. `pro` unlocks 1s/15s/30s candles. |
| `RPC_URL` | Solana RPC endpoint |
| `JUPITER_BASE_URL`, `JUPITER_API_KEY` | Jupiter swap API (free tier by default) |
| `LIVE_TRADING`, `WALLET_KEYPAIR_PATH` | Live trading switch and wallet |

## Contributing

Pull requests are welcome, especially new rule types, data providers, better tests and documentation. See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## Disclaimer

This software is provided "as is", without warranty of any kind, under the [MIT License](LICENSE). It is **not financial advice** and not an offer or solicitation to buy or sell any asset.

- Price rhythms describe the past. Markets are under no obligation to repeat them. Projections and backtests do not predict future results.
- Automated trading can lose money quickly, through bugs, bad configuration, API failures, slippage, MEV, illiquid tokens, or market moves.
- You alone are responsible for how you configure and run this software, for any losses, and for complying with the laws and tax rules where you live.
- If you issue a token, **add it to `blocklist`**. Trading your own token with a bot can amount to market manipulation.

The authors and contributors accept no liability for any losses.

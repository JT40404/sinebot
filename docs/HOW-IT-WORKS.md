# How sine-bot works

## The idea

Play a chord and you hear one sound, but it is several notes played together. A **Fourier transform** tells you which notes are in it. sine-bot does the same with a price chart. The single wiggly line can contain repeating swings, a slow one over days and a faster one over hours, on top of a trend and random noise. The bot separates them and measures each one.

It trades only when a rhythm is **strong**, **steady**, **currently in a favourable part of its cycle**, and when projecting it forward **has actually worked on this token before**. Each of those conditions is a setting you control.

## 1. Measuring the rhythms (`src/fourier/analyze.ts`)

Given *N* closes (a power of two) with *Δt* hours between them:

1. `y = log(price)`, so moves are in percentages.
2. **Detrend**: fit a line `a + b·n` by least squares and subtract it. This leaves the swings, `d[n]`.
3. **Hann window** `w[n] = ½ − ½·cos(2πn/(N−1))`, so the edges of the window don't create false rhythms.
4. **FFT** (radix-2 Cooley–Tukey): `X[k] = Σ d[n]·w[n]·e^(−2πikn/N)`. Bin *k* is a rhythm that repeats *k* times in the window, with period `N·Δt / k`.
5. **Peaks**: local maxima with *k* ≥ 2 (at least two full cycles) and *k* ≤ N/4 (at least four candles per cycle, clear of the Nyquist edge). Each peak's frequency is refined by parabolic interpolation on log-amplitude.
6. For each rhythm:
   - **Amplitude**: `4·|X[k]|/N`, correcting for the Hann gain. In log units, so 0.04 means ±4%.
   - **Share of variance**: the un-windowed power at *k* ± 1 divided by the variance of `d` (Parseval).
   - **Signal-to-noise**: `explained / (1 − explained)`.

**Strength**, rated from how much of the movement the top three rhythms explain:

| Explained | Strength |
|---|---|
| 75% or more | 4 (very strong) |
| 55% or more | 3 (strong) |
| 35% or more | 2 (moderate) |
| 15% or more | 1 (weak) |
| less | 0 (none) |

The rating is capped at 2 if the main rhythm repeated fewer than 3 times in the window, and at 1 if fewer than 2.

## 1b. Is it just a random walk? (`analyze.ts`, new in 1.1)

Following Öztürk (2025), who tested 25 cryptocurrencies against the random-walk null:

1. **Fourier trend** (Enders & Lee, fractional frequency). The trend is `a + b·t + c·cos(2πk*t/N) + s·sin(2πk*t/N)`, with k\* ∈ {0.1 … 1.5} chosen by minimum SSR. It removes slow regime shifts before the spectrum, and stays below 1.5 cycles per window so it can't absorb a repeating rhythm. Projection fits keep a straight-line trend, because their shorter windows leave too few cycles to separate the two.
2. **Prominence.** Each peak's power is divided by the median power of nearby frequencies. A real rhythm is a sharp spike; leftover trend is a broad slope.
3. **Random-walk null.** 200 seeded random walks of the same length run through the identical pipeline, once per window size.
   - The rhythm p-value compares a peak's prominence with the **maximum** prominence in each simulation, which corrects for "look everywhere and something stands out."
   - The KSS and regime-shift p-values come from the same simulations.
4. **Fourier KSS test** (Kapetanios, Shin & Snell 2003; Christopoulos & León-Ledesma 2010): `Δe_t = φ·e³_{t−1} + Σ α_j·Δe_{t−j}` on the Fourier-trend residuals, using the t-statistic of φ.
5. **Ranking.** Significant rhythms with ≥ 3 cycles rank first, then significant 2-cycle swings, then the rest.
6. **Strength cap from the rhythm p-value:** > 0.30 caps at 0 (none), > 0.15 at 1 (weak), > 0.05 at 2 (moderate).

## 2. Exact phase (`harmonics.ts`)

With the frequencies known, a least-squares fit of `y[n] ≈ a + b·n/N + Σ (c_j·cos 2πf_j n + s_j·sin 2πf_j n)` recovers each rhythm's amplitude and phase exactly. The cycle position is `ψ = 2πf·(N−1) − atan2(s, c)`, reported as `phase = (ψ + π)/2π`: 0 is a trough and 0.5 a crest. The rhythm is rising while `ψ < 0`.

## 3. Persistence (`stft.ts`)

A **spectrogram** repeats the transform on about 160 overlapping slices of the window. Each slice is detrended and Hann-windowed. The slice length is a power of two, at least N/4 and up to N/2. For the main rhythm:

- **share**: the fraction of slices where its band is at least half as strong as that slice's strongest rhythm. "Was it there the whole time?"
- **change**: its strength in the latest third of slices divided by the earliest third. Above 1 it is strengthening; below 1 it is fading.

The check needs the rhythm to repeat at least 4 times in the window.

## 4. Projection with a track record (`project.ts`)

1. **Project**: fit trend + rhythms (step 2) and extend the fit *H* steps forward, pinned to the last close. *H* is one main cycle, capped at N/5.
2. **Walk-forward test**: at up to 12 earlier points inside the window, re-run the **whole** method on the N/2 candles before that point only. Project forward and compare with what actually happened. This produces:
   - **skill** = `1 − Σ|error of projection| / Σ|error of "price stays put"|`. Above 0 beats doing nothing; 0.2 means 20% more accurate.
   - **hit rate**: whether the direction was right, checked at ¼, ½, ¾ and the full horizon.
   - **band**: the 80th percentile of past misses at each step ahead.
3. The turning points, **projected high** and **projected low**, feed the entry rules (upside, reward/risk) and the "sell near the projected high" exit.

On synthetic data, a genuine rhythm scores skill of about 0.9, while a random walk scores negative skill. The tests in `test/fourier.test.ts` enforce this.

## 5. Decisions (`src/strategy/`)

`buildSnapshot()` turns a window of closes into all of the above. `checkEntry()` applies your entry rules and returns **the reasons** for every rule that failed. `openPosition()` sets the stop, take-profit, trailing stop, projected-high target and maximum hold.

Exits are split in two:
- **`signalExit()`** runs at a bar close, filled at the next open: the cycle passing its crest, the rhythm weakening, or the maximum hold time.
- **`priceExit()`** runs inside the next bar. Stops and the trailing stop are checked before targets, which is conservative.

## 6. Honest backtesting (`src/engine/backtest.ts`)

- At bar *t* the strategy sees only candles *t − N + 1 … t*. `test/strategy.test.ts` changes the future and checks that no past trade changes.
- Entries and signal exits fill at the **next bar's open**.
- Fees and expected slippage are charged on both sides.
- The live bot calls the same `buildSnapshot`, `checkEntry`, `signalExit` and `priceExit` functions.

# Changelog

## 1.3.0

### Changed: the default config is looser and aligned with the website's indicator
- **Rhythm rules:**
  - `minStrength` 2 → 1
  - `significance.maxP` 0.1 → 0.3
  - projection `minSkill` 0.1 → 0, `minHitRate` 0.55 → 0.5, `requireTested` → false
- **Trade-size rules**, sized for typical crypto swings:
  - `stopLossPct` 6 → 3
  - `minRewardRisk` 1.2 → 0.8
  - `minUpsidePct` 2 → 1
  - `costMultiple` 3 → 2
  - trough window 0.9–0.2 → 0.85–0.25
- **Why:** with the old values, a rhythm the indicator rated "Very strong" but swinging only ±2% could never pass the 6%-stop reward/risk rule, so the bot never traded it.
- **Synthetic backtests, new default:**
  - clear rhythm: 15 trades, 93% wins
  - weak rhythm inside a random walk: 14 trades, 86% wins, profitable (was 0 trades)
  - pure random walks: 0, 0 and 1 trade
- **Presets** (`swing`, `scalper`, `conservative`, `trend-dips`) keep their stricter values.

## 1.2.0

### Removed
- The **stress check** (low-frequency surge in returns). It had been used as an entry block (`entry.stress`) and a forced exit (`exit.onStress`). The bot now decides only from rhythm strength, significance, mean reversion, persistence, cycle phase, trend, projections and your risk limits.
- Existing configs that still contain `stress:` or `onStress:` load fine; those keys are ignored.

### Changed
- Backtests are about 33% faster, since the stress calculation no longer runs on every candle.
- The SINE website still shows the stress check, as information only.

## 1.1.0

### Added
- **Random-walk-aware analysis** (after Öztürk 2025):
  - Fourier trend (Enders & Lee) that removes slow regime shifts before the spectrum
  - prominence-based rhythm detection
  - significance against 200 simulated random walks, look-elsewhere corrected
  - Fourier KSS mean-reversion test
- **Stress check** (after Jun et al. 2019): a rolling Fourier spectrum of returns that flags slow, one-directional pressure the rhythms don't explain.
- **New config rules:**
  - `entry.significance.maxP`
  - `entry.meanReversion`
  - `entry.stress`
  - `exit.onStress`
- The new readings are explained in plain English by `analyze` and in logs. The self-test also checks that a pure random walk is rated "No clear rhythm".
- Five new tests:
  - random-walk false positives
  - significance and mean reversion on real rhythms
  - boom-and-bust removal
  - stress calibration
  - the new entry and exit rules

### Changed
- **Strength rating** is now capped by the rhythm's random-walk p-value. Tokens whose swings look like chance are rated lower, sometimes "No clear rhythm". This is intentional.
- **Presets** are tuned with the new rules.

### Notes
- Backtests are somewhat slower (about 10 ms per bar). Raise `market.evaluateEvery` for long runs.

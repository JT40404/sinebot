# Changelog

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

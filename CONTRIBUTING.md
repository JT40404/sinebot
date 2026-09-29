# Contributing

Thanks for helping improve sine-bot.

1. Fork the repo and create a branch.
2. Run `npm install`, then `npm test` and `npm run typecheck`. Both must pass.
3. Keep the Fourier library (`src/fourier/`) dependency-free and deterministic.
4. New rules belong in `src/strategy/rules.ts`, with a setting in `src/config/schema.ts`, a commented entry in `config/default.yaml`, and a test.
5. Anything that affects backtests must keep the **no-look-ahead** test passing.
6. Explain the *why* in your PR description, and include a backtest if you're changing trading behaviour.

Good first contributions:
- more data providers
- a benchmark or market-correlation filter
- per-token config overrides
- notifications (Telegram or Discord)
- a parameter sweep command
- more tests and docs

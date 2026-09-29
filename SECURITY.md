# Security

**Please don't report vulnerabilities in public issues.** Use GitHub's "Report a vulnerability" (Security → Advisories) on this repository.

The bot handles private keys, so:
- Never commit `.env`, `keys/`, or any keypair file. The `.gitignore` excludes them, but check before pushing.
- Use a dedicated hot wallet holding only what you can afford to lose.
- Review dependency updates. `npm audit` is a good habit.

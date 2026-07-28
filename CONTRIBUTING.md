# Contributing

Contributions are welcome. By submitting a contribution, you agree to license it under the project's MIT License and certify that you have the right to do so. Pi Together does not require a contributor license agreement.

## Development workflow

1. Use Node.js 22.19 or newer.
2. Install with `npm ci --include=dev --ignore-scripts`.
3. Add or update a deterministic failing test before changing behavior.
4. Keep Pi as the source of truth; do not add a transcript, credential, or shadow-session database.
5. Use synthetic fixtures only. Never commit real sessions, identifiers, usernames, hostnames, addresses, home paths, tokens, or deployment configuration.
6. Keep browser, server, Pi adapter, deployment, and privileged boundaries explicit.
7. Update public documentation when behavior, support, security, privacy, or lifecycle contracts change.

Run before review:

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run test:package
npm run safety:scan
npm run safety:artifacts
npm run safety:package
npm run audit:ci
```

Changes to deployment or lifecycle behavior must also run the relevant native-template, full-stack, and ACME lanes. These require the pinned helpers documented by their scripts and CI workflow.

Explain security-boundary, persistence, protocol, destructive-operation, and operational effects in the change description. Do not weaken tests or security checks merely to make a change pass.

Coding agents follow [AGENTS.md](AGENTS.md). All participants must follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

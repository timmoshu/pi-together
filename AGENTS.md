# Repository instructions for coding agents

This file is the tool-neutral source of project instructions. `CLAUDE.md` points here; do not duplicate
rules across assistant-specific files.

## Non-negotiable invariants

- Pi owns provider authentication, models, settings, tools, native JSONL sessions, and workspace data.
- Never edit Pi JSONL directly or add a transcript, credential, or shadow-session database.
- Never expose provider credentials, proxy secrets, OAuth cookies, raw environments, arbitrary files,
  unbounded logs, or another viewer's identifier to the browser.
- Public unsafe requests require canonical proxy authentication and exact Origin validation before
  parsing or side effects.
- Attribution and lease history must use strict signed native Pi custom entries.
- Privileged operations remain narrow, independently validated, allowlisted, atomic, journaled, and
  free of shell/arbitrary-command interfaces. `setup` discovery/planning stays mutation-free; only the
  explicit `onboard` wizard may offer the pinned user-level Pi npm install, never with sudo or a shell.
- Tailscale Funnel may expose only the dedicated loopback auth edge through the exact owned foreground
  unit. Never accept Tailscale credentials, reset global Serve/Funnel state, or remove unrelated Tailscale state.
- Post-install GitHub user changes must update app and oauth2-proxy allowlists together through the
  independently validating, journaled privileged boundary; never edit either config directly.
- Uninstall may delete only canonical installation-inventory paths. Preserve Pi data, workspaces,
  credentials, and backups; preserve Pi Together config unless purge is explicit.
- Tests and fixtures must be synthetic. Default tests must not call paid model providers.
- Releases are maintainer-only: never publish npm, create or push a release tag, create a GitHub release,
  or change repository visibility without explicit release-owner approval and all documented gates.

## Development workflow

1. Use Node.js 22.19 or newer and `npm ci --include=dev --ignore-scripts` for verification.
2. Add or update a failing deterministic test before behavioral changes.
3. Keep browser, server, Pi adapter, deployment planning, and privileged execution boundaries explicit.
4. Prefer pure state machines and injected I/O adapters for destructive or security-sensitive behavior.
5. Centralize policy and canonicalization; do not abstract distinct security checks merely because their
   mechanics look similar.
6. Run `npm run typecheck`, `npm test`, `npm run build`, `npm run safety:scan`,
   `npm run safety:artifacts`, `npm run safety:package`, and `npm run audit:ci` before review.
7. Run browser/native/full-stack/ACME lanes when their areas change.

## Structure and documentation

- Keep React shell, session controls, conversation rendering, and event transitions in separate modules.
- A large adapter may remain cohesive when it implements one boundary, but split modules that combine
  unrelated policy, orchestration, and presentation responsibilities.
- Update README/policy/architecture documentation whenever behavior, support, trust boundaries, or
  lifecycle commands change.
- Use `CONTRIBUTING.md` for human workflow and `docs/architecture.md` for system design.

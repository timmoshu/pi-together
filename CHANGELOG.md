# Changelog

All notable changes to Pi Together are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning.

## [Unreleased]

### Fixed

- Printed Funnel activation verification progress once instead of repeating the privileged-boundary message for every poll.

## [0.1.1] - 2026-07-29

### Fixed

- Allowed a clean reinstall after `uninstall --purge-config` to accept only the exact canonical root-owned backup directories that uninstall intentionally preserves.
- Recorded directories created by apply so rollback removes only directories created by that transaction and never an empty preserved backup directory.

## [0.1.0] - 2026-07-28

### Added

- Browser creation, observation, and control of native Pi sessions with bounded SSE streaming.
- Desktop and mobile session controls for prompts, steering, follow-ups, abort, models, thinking levels, and tools.
- GitHub-authenticated collaboration through Tailscale Funnel, including participant presence, controller takeover, and durable control history.
- Signed web-turn attribution and managed per-turn Git author identity without repository Git configuration changes.
- Owner-approved shared-folder policy with bounded repository/worktree discovery and use-time authorization.
- Guided Local and Easy Sharing installation with deterministic planning and independently validated privileged apply.
- GitHub allowlist and workspace administration, diagnostics, recovery, signed stable upgrades, and inventory-owned uninstall.
- Catastrophic Bash deletion guards for common protected-root, active-worktree, and `.git` targets as documented defense in depth.
- Prebuilt npm package, release manifest, checksums, CycloneDX SBOM, notices, and third-party license inventory.

### Security

- Exact Origin and canonical proxy-authentication checks precede unsafe public requests.
- Provider credentials, OAuth cookies, raw environments, arbitrary host files, and viewer identifiers are excluded from browser responses.
- Privileged lifecycle operations use fixed typed requests, independent validation, atomic writes, durable journals, bounded reads, health checks, and rollback.
- Pi Together remains a trusted-group control surface rather than an operating-system sandbox.

[Unreleased]: https://github.com/timmoshu/pi-together/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/timmoshu/pi-together/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/timmoshu/pi-together/releases/tag/v0.1.0

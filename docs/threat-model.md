# Threat model

## Assets

Protected assets include provider credentials held by Pi, native session content, workspace files,
operator identity, proxy secrets, and the ability to invoke Pi tools with the host user's permissions.

## Trust boundaries

The browser, reverse proxy, Pi Together server, Pi RPC child, extensions, native session store, and
workspace filesystem are distinct boundaries. Browser input, forwarded headers, session text, model
output, tool output, and extension events are untrusted.

## Principal threats

- An unauthenticated network client invokes tools or reads sessions.
- A caller forges proxy identity or origin headers.
- Two viewers or processes write one native session concurrently.
- Cross-site requests cause authenticated mutations.
- Session or tool content injects markup, oversized output, paths, or control data.
- Symlinks, stale linked worktrees, basename collisions, or path traversal escape owner-approved shared repository folders.
- A native session outside policy leaks through detail, runtime, lease, SSE, or reconnect replay.
- Unbounded repository scans or Git-controlled/network behavior disclose host metadata or exhaust the service.
- Logs, packages, source maps, fixtures, or errors disclose credentials or private infrastructure.
- A compromised extension consumes attribution intended for another input path.
- Malformed, stale, or takeover-time identity is written permanently into Git history, or a human key
  signs a bot-created commit and falsely implies human execution.
- Funnel transport exposes the wrong local service, overwrites unrelated Tailscale state, leaks tailnet
  status, or accepts arbitrary Tailscale control-plane arguments.
- Installer or post-install user management accepts arbitrary commands, destinations, identities, or
  stale/concurrent configuration changes.

## Current mitigations and gaps

The application binds a private Unix socket by default or literal loopback as an explicit fallback, validates JSON bodies, escapes browser content, blocks
raw HTML, bounds SSE replay/tool previews, projects durable collaboration metadata to browser-safe
DTOs, arbitrates cloned active-tab viewer IDs, and uses in-process controller leases. Signed delivered-turn
identity scopes normal Git commits to a verified GitHub author plus fixed bot committer; malformed actors
fall back to the email-less bot, automatic signing is disabled on the managed commit path, and no local Git
configuration is written. Repository and audit
gates reject known private markers and high-severity dependency advisories.

Tailscale Funnel ingress requires a dedicated secret, canonical allowlisted principal, exact Origin, and
private app listener. It exposes only a dedicated loopback nginx edge and treats all Tailscale-provided
identity headers as untrusted; Tailscale remains an upstream beta availability, metadata, certificate, and
bandwidth dependency. Post-install
allowlist changes are fixed-path, digest-bound, independently identity-verified, journaled, and rolled back
across both app and oauth2-proxy configurations when restart or private health fails. Installer reads and
package-tree walks are bounded; apply/uninstall are sudo-provenance-bound, crash-restartable, and do not
report success until requested service state and authenticated private health pass. Created-directory
rollback is non-recursive when unexpected content appears. Release gates include supported-distro lifecycle validation, clean-history secret scanning, signed artifact
provenance, and destructive-operation review. Own Domain and Certbot activation remain unsupported in 0.1.x.

## Non-goals

The repository boundary is deployment-wide: one installation is one trusted group, with no per-user or GitHub repository entitlement. Discovery is bounded, does not follow symlinks, stays on the selected filesystem, prunes security/cache trees, and uses only fixed sanitized local Git metadata probes. Events are authorized before entering the shared replay buffer. Shared-folder changes are complete-set, digest-bound, serialized, journaled, health-checked, and rollback-safe. Folder permission bits are not a content-integrity boundary; changes by local OS principals with write access occur outside browser authentication, lease, and attribution guarantees and are accepted host-level risk.

Pi Together does not clone, fetch, invoke `gh`, collect Git credentials, or sandbox Pi, models, tools, extensions, or the operating-system account. It cannot
prevent another local process with the same user permissions from reading sessions or opening the same
session concurrently. Per-turn Git attribution covers the managed `git commit` porcelain launcher; an
untrusted model/tool with host authority can deliberately bypass it with plumbing, an absolute binary, or
a custom Git client. The managed extension's catastrophic Bash deletion guard similarly blocks common
literal shell forms but can be bypassed through other interpreters, binaries, or novel shell construction.
These are defense-in-depth paths, not OS enforcement boundaries.

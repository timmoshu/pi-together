# Architecture

Pi Together is a same-host browser control surface for Pi. Pi owns provider authentication, models,
tools, settings, extensions, native JSONL sessions, and workspace access.

## Components

- `client/src/App.tsx`: small React composition shell.
- `client/src/ui/`: session rail, controls, conversation rendering, responsive hooks, and presentation-only helpers.
- `client/src/store.ts`: client connection/action orchestration; pure replay-safe transitions live in `store-events.ts` and state contracts in `store-types.ts`.
- `server/app.ts`: authenticated API-route orchestration only; shared HTTP/SSE/static mechanics live in `http-surface.ts`, bounded ephemeral participant tracking in `presence.ts`, durable controller coordination in `collaboration-leases.ts`, and the browser-safe collaboration projection in `public-projection.ts`.
- `pi-adapter/real.ts`: discovers native sessions and reconstructs browser-safe history.
- `pi-adapter/collaboration-entries.ts`: strict durable attribution and lease custom-entry schemas.
- `pi-adapter/runtime.ts`: owns one `pi --mode rpc` child per attached session and executes the signed arm/consume protocol.
- `pi-adapter/fake.ts`: deterministic synthetic implementation for tests and development.
- `shared/protocol.ts`: validated request shapes and browser-safe event types.
- `deployment/templates.ts`: typed nginx/oauth2-proxy renderers and pinned release metadata.
- `cli/` + `dist/release/`: prebuilt command boundary, Pi compatibility check, unprivileged setup discovery, typed/redacted operation planning, interactive/scriptable user administration, lifecycle commands, diagnostics, checksums, and immutable version layout.
- `privileged/`: bundled no-shell apply/user-management/upgrade/uninstall boundary with independent semantic validation, exact preconditions, fixed-path atomic writes/symlinks, metadata-only certificate and recovery inspection, root-owned journals/backups, explicit reverse rollback, and system-Node enforcement.
- `extension/`: versioned signed-envelope verification, fail-closed Pi input interception, bounded
  per-turn Git identity state, a lexical catastrophic-Bash deletion guard, and the fixed managed Git launcher
  used for commit metadata/trailers. The guard is defense in depth and does not claim OS confinement.

The session rail retains every eligible summary for complete search and grouping. Active sessions remain
fully visible; each inactive workspace initially renders its newest 20 sessions and reveals 20 more per
request, while keeping a selected older session visible.

## Data flow

The browser sends a validated command to the server. The server checks the canonical principal plus browser-viewer lease, renews only the exact holder,
then calls the adapter. The real adapter sends RPC commands to Pi and normalizes Pi events. Blocking Pi
extension dialogs remain pending in adapter memory so a viewer can attach later; an unheld dialog may
acquire the viewer lease on response, while a dialog held by another viewer stays read-only. Extension UI
responses use Pi's no-ack RPC sub-protocol and clear the matching pending dialog after the frame is written.
Stopping a run cancels any blocking extension dialog before sending Pi's abort command, allowing the
blocked tool call to unwind instead of leaving abort waiting indefinitely. The server stores only bounded
in-memory replay, lease, and presence state. A selected session's SSE subscription
registers its authenticated principal and opaque viewer internally; presence collapses viewer instances to a
count and never serializes their identifiers. Presence snapshots are live-only and excluded from reconnect
replay, while each join emits the current revision. Before HTTP or SSE serialization, one public
projection removes native viewer IDs while retaining actor, action, and safe same-actor viewer-change
semantics. Durable messages remain in Pi's session tree; branch-aware normalization selects the current root-to-leaf path
and pairs valid attribution markers with later native user messages FIFO. Signed acquire, takeover,
release, expiry, and crash-recovery events are durable custom entries but never become live locks.
For full-tool managed browser turns, the extension binds delivered user messages back to their consumed
signed actors. Immediately around existing Bash tool execution it scopes Git author/committer environment,
and a fixed launcher adds the Pi/model trailer to normal `git commit` porcelain without writing local Git
configuration. Takeover lease events do not rewrite an in-flight turn, and queued follow-ups retain their
signed queuer. Pi Together never writes JSONL directly.

## Invariants

- No provider credential enters the browser or application persistence.
- No transcript database exists.
- One installation is one trusted collaboration group. Every collaborator receives every eligible Git repository beneath the owner-approved `sharedRepositoryFolders`.
- Repository inventory is derived with bounded, same-filesystem, no-symlink scans and fixed local Git metadata probes; it is never a durable registry.
- Browser/session paths are revalidated against canonical repository identity. External linked worktrees require exact `git worktree list --porcelain` membership in an authorized repository.
- Native sessions, adapter operations, runtime creation, leases, SSE recording, and replay fail closed before exposing a repository outside policy.
- At most one attached runtime exists per native session in one server process.
- One active browser page owns a viewer ID; a browser Web Lock rotates session-storage IDs cloned into another live tab.
- Tool output and replay buffers are bounded.
- Per-session presence is bounded, deduplicated by authenticated principal, reaped on disconnect/timer, and never persisted to Pi JSONL or another store.
- Local mode has no authenticated browser principal and therefore makes no durable per-person authorship claim; unattributed native turns are presented as local input. **You** and named collaborators require strict signed GitHub attribution.
- Managed Git author identity comes only from a delivered strict signed GitHub attribution; malformed or
  unmatched actors fall back to the fixed bot, which is always the committer. Repository Git config is not mutated.
- Browser text is treated as untrusted and rendered without raw HTML.
- The supported installer is the only deployment activation path; unsupported modes fail before planning or mutation.

## Deployment form

The prebuilt npm package plus `pi-together setup` is the supported deployment mechanism. Easy Sharing uses
a dedicated loopback nginx edge reached through a Pi Together-owned foreground Tailscale Funnel unit while
retaining the oauth2-proxy/backend trust model. Own Domain is not supported in 0.1.x. Local
installation selects and displays the first available literal-loopback listener from a small fixed port set,
then rechecks it at the privileged boundary; it never broadens the bind address. Setup verifies requested
systemd state and authenticated private health before success. Root-only apply journals retain the validated
secret-free plan for cross-invocation rollback, including the exact set of directories created by that apply.
Rollback removes an empty directory only when the journal proves that transaction created it. After an explicit
config purge, setup's only alternative preconditions are the two canonical root-owned mode-0700 backup
directories that uninstall always preserves; all other metadata still fails closed. Explicit recovery
inventories one exact journal and dispatches only its allowlisted rollback after confirmation. Uninstall records
durable exact prefixes and keeps its manifest until the final restart-safe deletion. Setup installs
an immutable host release and the reviewed systemd/nginx/oauth2-proxy integration; npm lifecycle scripts
never deploy as root. Signed upgrades accept only a newer stable version whose release bundle binds the
version tag, source commit, package digest, and release-manifest digest. Every version receives a distinct
immutable directory, and activation retains the prior version for rollback.

Shared-folder authorization is a web/session disclosure boundary, not an OS sandbox. Pi tools still run with the service user's host filesystem and Git authority; mutually untrusted groups require separate hosts or VMs.

A production Docker path is deferred. Pi requires same-user host credentials, sessions, workspaces, and
tool execution, so a useful container would need broad sensitive mounts, UID/group coordination, socket
plumbing, init/service handling, and a separate certificate/reverse-proxy contract. That would not create
an OS sandbox and would multiply the v0.1 trust boundary. A future app-only development image or a true
remote-agent architecture can be evaluated separately.

## Module and duplication policy

Module size alone does not define a god module. Boundary adapters such as `RootApplyIo`, `RealAdapter`,
and `PiRuntime` may be long because they implement one narrow interface with shared lifecycle state. They
must not absorb policy from another layer. Presentation composition, conversation rendering, session
controls, client event transitions, and state contracts remain separate modules.

DRY applies most strongly to security policy and canonical data: request schemas, install inventory,
principal normalization, attribution envelopes, operation plans, privileged request dispatch, release
metadata, and lifecycle state machines each have one authoritative implementation. Low-level checks that
look mechanically similar stay explicit when their owner/mode/size/threat requirements differ; sharing
them merely to remove lines would couple trust boundaries and weaken reviewability.

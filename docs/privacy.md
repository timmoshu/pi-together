# Privacy and data handling

Pi Together is designed for self-hosting and has no telemetry or analytics. It does not ask for or
persist provider credentials. Pi handles provider authentication and stores native sessions. Public
setup collects an OAuth client secret for later proxy configuration; interactive input is hidden, and
noninteractive answer files must be owned regular non-symlink files with mode `0600`. Discovery and
plan output redact that secret. Apply sends it only in a bounded stdin request to the privileged helper;
it is written mode `0600` for systemd credential loading and never enters argv, environment, plan,
rollback journal, or console output.

The server reads session metadata and content needed for the selected UI, starts Pi RPC processes, and
keeps bounded event replay plus live controller leases in memory. The browser stores a CSPRNG viewer
ID in tab-scoped session storage and holds a browser Web Lock under a one-way digest—not the raw ID—for that active page. Because opened tabs
can clone session storage, a second live page rotates the copied ID before making API requests. Theme
preference and per-session draft text also remain in browser storage.

Authenticated web authorship and control-history entries include bounded actor/viewer metadata in Pi's
native session JSONL; those records travel with copied sessions. The server removes viewer IDs from chat
HTTP responses and SSE events, exposing only actor/action and safe relationship semantics. Per-session
presence lets authenticated collaborators see which authenticated principals are currently viewing that
session and a bounded count of each principal's distinct viewer instances. Raw viewer IDs are never sent
to another browser. Presence is process-memory-only, removed on disconnect or stale timeout, omitted from
SSE reconnect replay, and never written to Pi's session tree. Anyone with access to that browser profile
may read its drafts.

When a managed browser turn produces a normal Git commit through Pi's full Bash tool, Pi Together writes
the verified actor's canonical GitHub login and `{numeric-id}+{login}@users.noreply.github.com` address
into permanent Git author history. The fixed bot is recorded separately as committer, and the commit
message names Pi plus the active provider/model in an `Agent` trailer. Unverified or unmatched actors use
the bot with no email; Pi Together never uses a profile, forwarded, or prompt-supplied human email. Git
history is copied by clones and is not removed when browser presence, leases, or Pi sessions are deleted;
changing it requires a separate repository history rewrite. Viewer IDs and credentials never enter this
metadata.

In Tailscale Funnel mode, the public `*.ts.net` hostname and transport metadata are processed by
Tailscale under separate terms. Pi Together never stores Tailscale auth/API keys, peer inventory, node
keys, account email, or raw status output. Tailscale currently documents Funnel relays as unable to
decrypt the end-to-end TLS stream.

Only sessions whose existing cwd revalidates to a Git repository beneath an owner-approved shared folder (or one of that repository's exact registered linked worktrees) may cross the HTTP, lease, runtime, SSE, or replay boundary. Outside repository/session names and paths are omitted rather than reported. Repository discovery is ephemeral and reads local Git metadata only; Pi Together stores no repository registry.

Session prompts, responses, reasoning, tool arguments, tool previews, model names, and authorized workspace paths
may appear in the browser and process memory. Reverse proxies and operators must avoid access logging
of secrets or sensitive content. Pi Together does not send telemetry to project maintainers.

Uninstalling Pi Together must not remove Pi sessions, Pi configuration, provider auth, or workspaces.
Users remain responsible for retention and deletion in Pi and on their host filesystem.

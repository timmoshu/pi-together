# Deployment security contract

Pi Together's Easy Sharing edge is generated from typed inputs in `deployment/templates.ts`. These are
installer integration artifacts, not manual deployment instructions.

## Request path

nginx terminates verified HTTPS and delegates authentication to oauth2-proxy's internal auth endpoint.
oauth2-proxy is bound to literal loopback, uses the GitHub provider, and restricts login to the explicit
canonical user allowlist. nginx extracts only the authenticated login returned by that auth subrequest.

For application requests, nginx disables forwarding of caller request headers and reconstructs a small
allowlist needed by the API: host, accept/content metadata, Origin, SSE replay ID, the generated backend
secret, and the authenticated login. Browser Authorization, Cookie, forwarded identity, access-token,
and arbitrary Pi trust headers therefore do not reach the backend. OAuth cookies are forwarded only to
oauth2-proxy endpoints.

The backend independently requires the generated secret and locally configured canonical login. Unsafe
methods also require the exact configured HTTPS Origin.

## OAuth and cookies

The oauth2-proxy config:

- uses an explicit `github_users` allowlist;
- reads client and cookie secrets from mode-restricted files;
- uses a Secure, HttpOnly, SameSite=Lax `__Host-` cookie;
- disables access-token, Authorization, basic-auth, user-header, and host forwarding;
- exposes the authenticated username only through auth-request response headers;
- disables request logging and detailed browser error output.

## Listener and streaming

The default application upstream is a mode-0660 Unix socket. An explicit literal-loopback TCP fallback
is supported with a warning. Broad application and oauth2-proxy binds are not renderable.

The SSE location disables proxy/request buffering, cache, and gzip transformations; preserves
`Last-Event-ID`; sets one-hour proxy timeouts; and returns `no-cache, no-transform` plus
`X-Accel-Buffering: no` while retaining all TLS security headers.

## Setup planning

`pi-together setup --dry-run` performs discovery and builds a versioned typed plan entirely in memory.
The plan inventories enabled nginx sites, records exact path preconditions and rollback metadata, pins
release/helper hashes, selects a local listener only from a fixed literal-loopback port set, resolves GitHub
logins to numeric principals, and renders app, nginx,
oauth2-proxy and systemd templates. Secret values are represented only by typed
references and redacted actions. Dry-run does not write a staging directory, install packages, change
services, issue certificates, or move the release symlink.

Local `setup --apply` requires a second explicit confirmation of that digest (`--apply --yes` for a mode-0600
noninteractive answer file). Guided onboarding instead presents a navigable **Install now / Show technical
plan / Cancel** gate and invokes the same independently validating apply boundary in the same process only
after Install now is selected. For local installs, the helper rechecks the selected bounded port before
mutation. Apply and uninstall requests are bound to matching sudo provenance. The bounded request is piped
over stdin. No secret enters argv, environment,
plan JSON, journal, or console output. The helper runs only with root-owned, non-writable `/usr/bin/node`
18 or newer; npm lifecycle code and the invoking user's version-manager Node are never run as root. The
non-root application service instead receives a fixed `PATH` beginning with the independently reviewed
Node 22 directory, preventing Pi or managed JavaScript launchers from falling back to an older system Node.

The bundled helper copies releases as root, normalizes directories to `0755`, data files to `0644`, and
only the exact CLI, privileged helper, and managed Git launcher to `0755`, then verifies every artifact
hash. The bundled helper independently recomputes the plan digest and validates exact operation ordering,
destinations, modes, owners, package/service allowlists, pinned helper/archive checksums, templates,
secret references, rollback actions, runtime-user identity, and all file metadata/hash preconditions. It
rechecks targets immediately before mutation, uses no shell, performs size-limited stable-handle reads and
bounded package-tree walks, writes through exclusive temporary files plus atomic rename, and preserves
hashed backups. Root-only apply journals include the validated secret-free plan plus in-flight/completed
actions, so a later invocation can reverse an interrupted plan even if fresh discovery has a new digest.
Rollback removes only empty created directories, preserves unexpected concurrent content, and deletes a
backup only after the restored target is synced and hash-read back. Existing nginx inventory is rechecked
byte-for-byte and never rewritten.

Before service activation, the helper rechecks the exact user-owned app-config bytes, mode, and identity
after daemon reload. It verifies requested `is-enabled`/`is-active` state and authenticated private health
before deleting the apply journal or reporting success. Funnel lifecycle actions include the app, OAuth
proxy, private nginx edge, and exact owned foreground Funnel unit.

Post-install shared-folder replacement uses the same helper entrypoint/global lifecycle lock and a separate strict digest-bound request. Root independently revalidates canonical owner-controlled folders, atomically replaces only app config, restarts the exact app service, checks private health, and rolls back on failure. It never edits oauth2-proxy identity allowlists or deletes workspace/Pi data.

Post-install GitHub allowlist changes use the same helper entrypoint but a separate strict request schema.
The non-root CLI digest-binds the app config, oauth2-proxy config, and canonical installation manifest.
Root verifies sudo provenance, safe fixed-path metadata, current cross-config agreement, and—when adding—a
second canonical GitHub numeric-identity lookup. It refuses last-user removal, stale inputs, and overlap with any apply, user-management, upgrade, or
uninstall process through one root-owned privileged lifecycle lock. Candidate oauth2-proxy configuration is tested before atomic replacement; service restart
and authenticated private health failure restore both configs from a durable root-only journal.

## Uninstall inventory

The unprivileged CLI cannot traverse the root-only state directory directly. A strict read-only privileged
query validates and returns only the canonical installation inventory plus its digest for uninstall and the
administrative GitHub-user/workspace commands. The CLI validates the response and digest-binds each later
mutation request; for uninstall it also presents the exact review summary. A separate recovery query returns
only the bounded set of exact root-owned lifecycle journal categories. One confirmed `recover` request must
match that set and can invoke only the category's fixed rollback; multiple journals fail closed. The mutation helper
reopens and revalidates the same root-owned inventory and matching sudo provenance before deleting only
allowlisted installation entries. Every manifest-owned policy journal is included. Journal and directory
fsyncs make operation-prefix recording durable; version-2 journals embed the canonical inventory, and
finalization removes the journal before the manifest so a crash during the last deletion remains idempotently
restartable. A narrowly scoped legacy path can reconstruct only the deterministic local inventory whose digest
matches the initial installer's root-owned version-1 journal after its old finalizer removed the manifest.
For compatibility with the initial installer, bounded release deletion accepts root-owned/root-group legacy
`0775`/`0664` content, but still rejects world write, special mode bits, foreign ownership/group, symlinks,
cross-device entries, unsupported file types, and count/size overflow. New releases are never installed with
legacy writable modes.

## Tailscale Funnel ingress

The no-domain mode retains the same nginx/oauth2-proxy/backend evidence chain behind a dedicated nginx
process bound only to `127.0.0.1:43118`. Its PID and all nginx request/proxy temporary paths live beneath
`/run/pi-together-edge`; the sandbox never writes or changes ownership beneath the distribution-owned
`/var/lib/nginx`. A Pi Together-owned systemd unit runs one exact foreground Tailscale Funnel command for
HTTPS 443; it never uses background/global reset, auth keys, profile changes, or arbitrary targets. Tailscale
identity headers are cleared and never authorize Pi Together. The app remains on its mode-0660 Unix socket.
Tailscale is an upstream beta transport and is preserved on uninstall.

## Validation and provenance

Golden tests verify header clearing, allowlisting, cookie isolation, streaming, fallback, redaction, and
injection rejection. CI runs `nginx -t` for Unix-socket and loopback variants and runs oauth2-proxy's
`--config-test` against synthetic mode-restricted secret files.

oauth2-proxy 7.15.3 Linux x86-64 and arm64 archives are pinned by exact release filename and SHA-256.
The apply boundary verifies package manifest coverage, downloads the selected archive with a size bound,
checks its hash before extraction, and validates configuration before each service activation. DynamicUser
plus systemd credentials isolates oauth2-proxy without modifying local account databases. The real
app/nginx/oauth2-proxy stack passes disposable integration with no provider call. Easy Sharing additionally
requires exact Funnel permission, route inventory, external TLS, and canonical OAuth redirects before
onboarding reports success. Own Domain and Certbot activation are not supported in 0.1.x.

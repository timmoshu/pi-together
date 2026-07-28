# Operations guide

This guide covers supported Pi Together 0.1.x installation and lifecycle operations. Run commands as the
same non-root user that owns the Pi sessions. Never run npm or package lifecycle code with sudo.

## Before setup

- Node.js 22.19 or newer is available to the invoking user. It may come from a user version manager such as NVM; onboarding warns but does not fail when `/usr/bin/node` is older, and it never replaces system Node.
- Pi `>=0.82.0 <0.83.0` is installed for the same non-root user and has at least one configured model.
  Pi Together does not install Pi or configure provider credentials. If needed, run
  `npm install --global --prefix "$HOME/.local" --ignore-scripts @earendil-works/pi-coding-agent@0.82`, add `$HOME/.local/bin` to the invoking shell's `PATH`, start `pi`, and use `/login`
  before running setup. If Pi is installed outside `PATH`, invoke setup with an absolute
  `PI_BIN=/path/to/pi`; the discovered exact path is recorded in the service unit.
- Easy Sharing requires a Tailscale account/tailnet, a manually created GitHub OAuth application, and an
  explicit allowlist of canonical GitHub logins. Collaborators do not need to join the tailnet.
- The tested and supported 0.1.x target is Ubuntu 24.04 on amd64. Other modern systemd-based Linux
  distributions may work but are untested and unsupported. Arm64 is unsupported until separately validated.

## Guided onboarding

For a first installation, install the reviewed Pi Together package as the normal user. If npm's configured
global prefix is root-owned (commonly `/usr`), pass `--global --prefix "$HOME/.local"` and add
`$HOME/.local/bin` to `PATH`; never use `sudo npm`. Then run `pi-together onboard` or simply
`npx --yes pi-together`. The wizard checks Pi first. With explicit confirmation it may run a user-level,
no-install-scripts npm installation of the compatible Pi line and open Pi for `/login`; it never uses sudo
for Pi. This release's arrow-key access choice offers Easy Sharing as the GitHub-authenticated multiplayer
mode and Local single-user / SSH tunnel with one shared local identity. Own Domain is not supported in
0.1.x. Eligible conventional folders plus direct repositories beneath the owner home appear in a
Space-to-select multi-choice list. A separate “Enter another folder…” option keeps custom paths explicit;
when no repositories are detected it offers canonical home as an editable default and accepts `~/…` relative
to that validated home. Guided onboarding can explicitly create a confirmed missing path beneath canonical
home as the invoking user, then revalidates ownership, type, and symlink-free canonicalization. Ordinary setup
discovery/planning remains mutation-free, and no existing workspace permissions are changed. Whole-home
sharing still requires a separate high-risk confirmation.

After a concise configuration summary, the same wizard offers **Install now**, **Show technical plan**, or
**Cancel**. Install now passes the in-memory plan to the independently validating narrow sudo helper
without requiring a second command. The redacted configuration, operation list, preconditions, and digest are hidden during the
normal path but remain available through Show technical plan. Cancel leaves system files unchanged. For local
mode, discovery selects the first bindable literal-loopback port from the bounded Pi Together range
(43117 and 43119–43127; 43118 remains reserved for the authenticated Funnel edge), shows the selected URL,
and the privileged helper rechecks that port before mutation. Discovery treats the current-release link,
root-only installation inventory, or systemd unit as an existing/partial installation marker, so interrupted
state cannot be mistaken for a clean host.

## Easy sharing without a domain

Select **Easy sharing** in onboarding to use Tailscale Funnel. Funnel is an upstream beta service with
separate terms, account, availability, and non-configurable bandwidth limits. Collaborators need only a
browser and allowed GitHub account; they do not join the tailnet. If Tailscale is absent:

```bash
pi-together tailscale prepare --accept-terms
pi-together tailscale login
pi-together onboard
```

The preparation command installs only the pinned official amd64 package and does not add an apt repository
or collect an auth/API key. Tailscale and its account state remain after Pi Together uninstall. Sharing is
controlled independently:

```bash
pi-together share status
pi-together share enable
pi-together share disable
pi-together share verify
```


## Plan first

`setup` discovery and planning remain unprivileged and read-only:

```bash
pi-together setup --dry-run
```

For automation, put noninteractive answers in a regular mode-0600 file owned by the invoking user:

```bash
pi-together setup --non-interactive ./setup-answers.json --dry-run
```

The plan contains references and hashes, not secret values. Review its exact operations, preconditions,
rollback actions, immutable release hash, and digest before applying.

## Apply

```bash
pi-together setup --apply
# explicitly reviewed noninteractive automation only
pi-together setup --non-interactive ./setup-answers.json --apply --yes
```

Apply uses `/usr/bin/sudo /usr/bin/node` to enter one bundled privileged helper. The application service separately pins `PATH` to the exact reviewed invoking-user Node directory, so Pi and managed JavaScript launchers use Node 22 even when the root-owned system Node is older. The helper independently
reconstructs and validates the plan, sudo provenance, release files, identities, templates, secrets,
package/service allowlists, preconditions, and rollback operations. Privileged reads and package-tree walks
are bounded. If start or enable was requested, apply verifies the exact systemd state and polls authenticated
private health before reporting success. Funnel mode starts and verifies the app, OAuth proxy, private edge,
and owned foreground Funnel service. If the tailnet has not enabled Funnel, onboarding obtains only the exact
approval URL from a bounded privileged unit-status query, pauses for the administrator handoff, and verifies
the resulting permission-bearing route to `127.0.0.1:43118` plus twenty consecutive externally TLS-validated
canonical OAuth redirects before declaring installation complete. It offers no shell or arbitrary command
interface.

## Health and diagnostics

```bash
pi-together doctor
pi-together doctor --json
pi-together status
pi-together status --json
pi-together logs --component app
pi-together logs --component oauth2-proxy
pi-together logs --component nginx
pi-together logs --component certbot
pi-together logs --component app --follow
```

Diagnostics use stable `PTD-*` categories and fixed remediation. Log access is restricted to owned exact
units and defensively redacted; nevertheless, review output before sharing it.

## Manage shared repository folders

One installation is one trusted group: every allowed collaborator can view and control Pi sessions for every eligible Git repository beneath every configured shared folder. Pi Together does not clone repositories, invoke `gh`, manage Git credentials, or check GitHub repository membership. This policy is not a filesystem sandbox for Pi tools.

```sh
pi-together workspaces list [--json]
pi-together workspaces detect [--json]
pi-together workspaces configure
```

`list` and `detect` are bounded, host-local, and read-only. `configure` replaces the complete folder set after review; it does not register individual repositories. New repositories appear after **Refresh repositories** in the browser. Approved empty folders are shown separately and open an explanatory non-repository modal instead of starting a session. **Repository not listed?** accepts only an existing exact eligible Git worktree and remains a fallback for bounded/truncated discovery. Removing a folder revokes web/session access after the transactional service restart but never deletes repositories, worktrees, native Pi sessions, credentials, or backups.

Pi Together caches model discovery to keep ordinary dashboard loads fast. Creating a browser session is an
explicit refresh boundary: it performs a new bounded Pi model probe and updates the browser catalog, so a
provider added through terminal `pi` → `/login` becomes selectable without restarting the service. Existing
sessions are not silently switched to the new model.

During guided onboarding, an empty selected folder may remain a container or be explicitly initialized with
`/usr/bin/git init --initial-branch=main` as the invoking user. This creates no remote or commit and is never
offered for a nonempty, symlinked, foreign-owned, or noncanonical directory.

Shared folders must be 1–16 canonical, user-owned, non-symlink directories. `/`, ancestor-redundant sets, and implicit whole-home selection are refused. Group/world write bits are accepted and are not a content-integrity boundary: local OS principals with write access can change repository content or discovery results outside Pi Together authentication and attribution. Run separate Pi Together installations on separate hosts/VMs for mutually untrusted groups.

The managed Pi extension hard-blocks common direct Bash attempts to remove `/`, `$HOME`, a direct child of
home, an approved folder root, the active worktree root, or `.git`; it also blocks broad protected-root
`find -delete`, destructive root globs, and recursive `git clean`. The host owner can still perform those
operations outside Pi Together. This is lexical defense in depth, not confinement: Python, Node, custom
binaries, or novel shell construction may bypass it, and Pi tools retain the service user's host access.

## Manage allowed GitHub users

Easy Sharing installations can administer the exact GitHub allowlist without reinstalling:

```bash
pi-together manage
pi-together users list
pi-together users list --json
pi-together users add octocat
pi-together users remove octocat
```

Run these commands as the same non-root user that owns the Pi sessions and app config. Add verifies the
canonical login and numeric identity with GitHub before review; the root helper independently repeats
that fixed-endpoint verification. Remove refuses to delete the final user. Both app and oauth2-proxy
allowlists are digest-bound and checked for agreement before mutation.

The privileged helper accepts only one typed add/remove request and fixed files/services. It validates the
candidate oauth2-proxy config, updates both files with atomic rename, orders restarts to fail closed,
checks authenticated private app health, and rolls both files and services back on failure. A mode-0600
root-owned journal provides interrupted-operation recovery. Do not edit either allowlist manually.

## Upgrade

Download and unpack the release bundle attached to the target GitHub release. It contains one package
archive, signed metadata, and checksums. Review it without mutation:

```bash
pi-together upgrade latest --bundle ./release-bundle --dry-run
```

Then apply the exact reviewed bundle:

```bash
pi-together upgrade latest --bundle ./release-bundle
```

Only a newer stable version signed by the pinned release key is accepted. The metadata binds the exact
version tag, source commit, package digest, and release-manifest digest. Branches, prereleases, unsigned
builds, and non-increasing versions are rejected. Private signing material never enters the package or
target host.

Root copies the verified user-owned archive into root-owned staging before inspection and extraction.
Activation atomically switches `previous` and `current`, fully stops the owned dependency graph to cancel
pending automatic restarts, starts services in dependency order, polls authenticated private health, verifies
every mode-specific service is active, and commits only after success. Restart or health failure performs the
same quiesced sequence while restoring config, inventory, symlinks, and service health. An interrupted
activation is recovered before version comparison.

## Uninstall

```bash
pi-together uninstall
pi-together uninstall --yes
pi-together uninstall --purge-config
```

Uninstall first uses a bounded read-only privileged query to inspect the canonical root-owned installation
inventory, validates the returned digest, and shows the review summary before confirmation. The subsequent
request is bound to that exact inventory digest. It disables and verifies owned services before deleting
their files, accepts only the bounded root-owned legacy release modes produced by the initial installer
(never world-writable or foreign-owned content), journals the exact completed operation prefix, removes
every inventory-owned policy journal, and removes
only managed integration entries and bounded immutable releases. It always preserves:

- native Pi sessions and JSONL;
- Pi credentials/settings;
- workspaces;
- unrelated nginx sites and systemd units;
- Pi Together backups.

Pi Together config is preserved unless `--purge-config` is explicitly supplied and confirmed. Repeating
uninstall after completion succeeds without mutation only after the root boundary verifies that the bounded
set of canonical managed integration markers is absent.

## Recovery and rollback

Do not manually edit lifecycle journals or installation inventory. Review and roll back one interrupted
apply, user/workspace change, sharing change, Tailscale preparation, or upgrade with:

```bash
pi-together recover
```

The command performs a read-only privileged journal inventory, explains the exact fail-closed rollback, and
requires confirmation before a second digest/action-bound privileged request. Multiple journals are refused.
An interrupted uninstall must instead be resumed with the same uninstall flags because purge intent cannot
be safely inferred from every legacy journal.

Apply journals retain the validated secret-free plan
needed to roll back an interrupted plan even when fresh discovery would produce a different digest. Final
uninstall cleanup removes its recovery journal before the manifest, allowing a crash at the last deletion to
restart idempotently. New root-owned uninstall journals embed the canonical inventory. If the initial local
installer's old finalizer already removed its manifest, privileged inspection reconstructs only the deterministic
local inventory whose digest exactly matches the legacy root-owned journal. If recovery refuses because root-owned metadata
was altered, stop and inspect the reported path; do not bypass ownership, symlink, mode, or digest checks.
Post-uninstall mode changes are supported: planning reads only the preserved app config's validated prior mode
to derive protected directory preconditions, while root still rechecks every exact path before mutation.

Backups live under `/var/lib/pi-together/backups`. Release activation uses
`/opt/pi-together/current` and `/opt/pi-together/previous`. Preserve backups until the operator has
validated the replacement release and its renewal path.

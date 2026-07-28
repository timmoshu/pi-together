# Support policy

Pi Together 0.1.x supports Ubuntu 24.04 on amd64 with Node.js `>=22.19.0` and Pi `>=0.82.0 <0.83.0`. Other modern systemd-based Linux distributions may work but are untested and unsupported.

Before requesting help:

1. Remove credentials and session content.
2. Run `pi-together doctor --json` and `pi-together status --json`.
3. Include the failing command, any stable `PTD-*` diagnostic codes, and only minimal reviewed/redacted logs.

`pi-together logs` is restricted and redacted, but review its output before sharing it. Never post provider keys, proxy secrets, OAuth cookies, native session files, home-directory contents, or raw environments.

Security issues follow [SECURITY.md](SECURITY.md), not the ordinary issue workflow. General Pi usage, provider accounts, model behavior, Tailscale account/policy/service issues, and third-party extensions remain with their respective projects. Pi Together support covers its own pinned integrations, generated configuration, and lifecycle boundaries.

Arm64, Own Domain, Docker, and installations outside the documented Node/Pi/platform range are unsupported in 0.1.x.

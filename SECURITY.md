# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Earlier/private builds | No |

Pi Together 0.1.x supports Node.js `>=22.19.0`, Pi `>=0.82.0 <0.83.0`, and Ubuntu 24.04 on amd64. Other modern systemd-based Linux distributions may work but are untested and unsupported. Arm64 and Own Domain deployment are not supported in 0.1.x.

## Reporting a vulnerability

Do not open a public issue containing exploit details, secrets, session content, or host information. Use GitHub private vulnerability reporting and the repository security-advisory workflow.

Include the affected version, impact, reproduction steps, and a suggested mitigation when available. Maintainers aim to acknowledge reports within five business days and coordinate disclosure after a fix is available.

## Security posture

Pi Together runs with the operating-system permissions of its service user and can ask Pi to invoke tools. It is not a sandbox. Use one installation only for a mutually trusted group.

The browser must never receive provider credentials, raw environment variables, arbitrary host files, another viewer's identifier, or unbounded output. Pi remains responsible for provider authentication and native session storage.

Public requests require canonical proxy authentication and exact Origin validation. The backend uses a private Unix socket by default; literal loopback is the only supported fallback. Privileged lifecycle operations are typed, fixed-path, independently validated, journaled, health-checked, and free of shell or arbitrary-command interfaces.

Do not bind the backend broadly, bypass the generated proxy path, edit native Pi JSONL, or manually modify managed installation files. See [docs/threat-model.md](docs/threat-model.md), [docs/deployment-security.md](docs/deployment-security.md), and [docs/privacy.md](docs/privacy.md).

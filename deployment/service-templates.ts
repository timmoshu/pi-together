import { dirname } from "node:path";
import { z } from "zod";

const AbsoluteExecutable = z.string().regex(/^\/[A-Za-z0-9._/+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/);
const User = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/);

export interface ServiceTemplateInput {
  nodePath: string;
  piPath: string;
  serviceUser: string;
  publicMode: boolean;
}

export function renderAppService(value: ServiceTemplateInput): string {
  const input = z.object({ nodePath: AbsoluteExecutable, piPath: AbsoluteExecutable, serviceUser: User, publicMode: z.boolean() }).strict().parse(value);
  const runtimePath = `${dirname(input.nodePath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  return `[Unit]\nDescription=Pi Together\nAfter=network.target\n\n[Service]\nType=simple\nUser=${input.serviceUser}\nEnvironment=PATH=${runtimePath}\nEnvironment=NODE_ENV=production\nEnvironment=PI_TOGETHER_CONFIG_FILE=/etc/pi-together/config.json\nEnvironment=PI_TOGETHER_CLIENT_DIR=/opt/pi-together/current/client\nEnvironment=PI_TOGETHER_ATTRIBUTION_EXTENSION=/opt/pi-together/current/extension/pi-together-attribution-v1.js\nEnvironment=PI_TOGETHER_GIT_LAUNCHER=/opt/pi-together/current/extension/git-bin/git\nEnvironment=PI_BIN=${input.piPath}\nExecStart=${input.nodePath} /opt/pi-together/current/server/index.js\nRestart=on-failure\nRestartSec=250ms\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=full\nProtectHome=false\n${input.publicMode ? "RuntimeDirectory=pi-together\nRuntimeDirectoryMode=0750\n" : ""}\n[Install]\nWantedBy=multi-user.target\n`;
}

export function renderOauth2ProxyService(): string {
  return `[Unit]\nDescription=Pi Together OAuth2 Proxy\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nDynamicUser=yes\nLoadCredential=oauth-config:/etc/pi-together/oauth2-proxy.cfg\nLoadCredential=oauth-client-secret:/etc/pi-together/oauth-client.secret\nLoadCredential=oauth-cookie-secret:/etc/pi-together/oauth-cookie.secret\nExecStartPre=/opt/pi-together/helpers/oauth2-proxy --config=/run/credentials/pi-together-oauth2-proxy.service/oauth-config --config-test\nExecStart=/opt/pi-together/helpers/oauth2-proxy --config=/run/credentials/pi-together-oauth2-proxy.service/oauth-config\nRestart=on-failure\nRestartSec=250ms\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function renderFunnelEdgeService(): string {
  return `[Unit]\nDescription=Pi Together private Funnel edge\nAfter=network.target pi-together.service pi-together-oauth2-proxy.service\nRequires=pi-together.service pi-together-oauth2-proxy.service\n\n[Service]\nType=simple\nExecStartPre=/usr/sbin/nginx -t -c /etc/pi-together/nginx-funnel.conf\nExecStart=/usr/sbin/nginx -c /etc/pi-together/nginx-funnel.conf -g "daemon off;"\nRestart=on-failure\nRestartSec=250ms\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nRuntimeDirectory=pi-together-edge\nRuntimeDirectoryMode=0755\nReadWritePaths=/run/pi-together-edge\nProtectHome=true\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function renderFunnelService(tailscalePath = "/usr/bin/tailscale"): string {
  if (tailscalePath !== "/usr/bin/tailscale") throw new Error("unsupported Tailscale path");
  return `[Unit]\nDescription=Pi Together Tailscale Funnel\nAfter=tailscaled.service pi-together-edge.service\nRequires=tailscaled.service pi-together-edge.service\n\n[Service]\nType=simple\nExecStart=${tailscalePath} funnel --https=443 --yes http://127.0.0.1:43118\nRestart=on-failure\nRestartSec=1s\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function renderRenewalHook(): string {
  return `#!/bin/sh\nset -eu\n/usr/sbin/nginx -t\nexec /bin/systemctl reload nginx.service\n`;
}

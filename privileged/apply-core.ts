import { createHash, timingSafeEqual } from "node:crypto";
import { normalize } from "node:path";
import { z } from "zod";
import { RUNTIME_EXECUTABLE_LIMIT, SetupPlanSchema, type FileState, type SetupOperation, type SetupPlan } from "../cli/operation-plan.js";
import { renderAppService, renderFunnelEdgeService, renderFunnelService, renderOauth2ProxyService, renderRenewalHook } from "../deployment/service-templates.js";
import { OAUTH2_PROXY_RELEASE, renderDeploymentTemplates, renderNginxChallengeSite, renderNginxFunnelEdge } from "../deployment/templates.js";
import { AppConfigSchema } from "../server/config.js";
import { isLocalListenerPort } from "../shared/local-listener.js";
import { buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";

declare const __PI_TOGETHER_VERSION__: string;
const VERSION = typeof __PI_TOGETHER_VERSION__ === "string" ? __PI_TOGETHER_VERSION__ : "0.1.0";
const SecretValuesSchema = z.object({
  "proxy-secret": z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
  "oauth-client-secret": z.string().min(16).max(4096).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  "oauth-cookie-secret": z.string().min(22).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
const ApplyRequestSchema = z.object({
  protocolVersion: z.literal(1),
  plan: z.unknown(),
  secrets: SecretValuesSchema.optional(),
}).strict();

export interface ApplyRequest {
  protocolVersion: 1;
  plan: SetupPlan;
  secrets?: Record<"proxy-secret" | "oauth-client-secret" | "oauth-cookie-secret", string>;
}

export interface ValidatedApply {
  plan: SetupPlan;
  files: ReadonlyMap<string, Buffer>;
  secrets: ReadonlyMap<string, Buffer>;
  runtimeExecutables: ReadonlySet<string>;
  localPort?: number;
}

export interface ApplyIo {
  inspect(path: string, maximumBytes?: number): Promise<FileState>;
  localPortAvailable(port: number): Promise<boolean>;
  recover(validated: ValidatedApply): Promise<void>;
  prepare(validated: ValidatedApply): Promise<void>;
  execute(operation: SetupOperation, payload?: Buffer): Promise<void>;
  rollback(operation: SetupOperation): Promise<void>;
  abort(validated: ValidatedApply): Promise<void>;
  verify(validated: ValidatedApply): Promise<void>;
  finish(validated: ValidatedApply): Promise<void>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalState(left: FileState, right: FileState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fixedHashEqual(actual: string, expected: string): boolean {
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function operationMap(plan: SetupPlan): Map<string, SetupOperation> {
  return new Map(plan.operations.map((operation) => [operation.id, operation]));
}

function assertOperation<K extends SetupOperation["kind"]>(
  operations: Map<string, SetupOperation>,
  id: string,
  kind: K,
  target: string,
): Extract<SetupOperation, { kind: K }> {
  const operation = operations.get(id);
  if (!operation || operation.kind !== kind || operation.target !== target) throw new Error(`invalid required operation: ${id}`);
  return operation as Extract<SetupOperation, { kind: K }>;
}

function parseOauthConfig(template: string): { clientId: string; logins: string[] } {
  const client = template.match(/^client_id = ("[^"\r\n]*")$/m);
  const users = template.match(/^github_users = (\[[^\r\n]*\])$/m);
  if (!client || !users) throw new Error("invalid oauth2-proxy template");
  try {
    const clientId = JSON.parse(client[1]!) as unknown;
    const logins = JSON.parse(users[1]!) as unknown;
    if (typeof clientId !== "string" || !Array.isArray(logins) || !logins.every((login) => typeof login === "string")) throw new Error();
    return { clientId, logins };
  } catch {
    throw new Error("invalid oauth2-proxy template values");
  }
}

function substitute(template: string, secretId: string, value: string): string {
  return template.replaceAll(`{{secret:${secretId}}}`, value);
}

function validateCommonOperations(plan: SetupPlan, operations: Map<string, SetupOperation>): void {
  const common = [
    ["config-directory", "ensure-directory", "/etc/pi-together"],
    ["runtime-directory", "ensure-directory", "/run/pi-together"],
    ["state-directory", "ensure-directory", "/var/lib/pi-together"],
    ["install-directory", "ensure-directory", "/opt/pi-together"],
    ["release-directory", "ensure-directory", "/opt/pi-together/releases"],
    ["backup-root-directory", "ensure-directory", "/var/lib/pi-together/backups"],
    ["backup-directory", "ensure-directory", "/var/lib/pi-together/backups/setup"],
    ["release", "copy-release", `/opt/pi-together/releases/${VERSION}`],
    ["current-release", "symlink", "/opt/pi-together/current"],
    ["app-config", "write-file", "/etc/pi-together/config.json"],
    ["app-service", "write-file", "/etc/systemd/system/pi-together.service"],
    ["install-manifest", "write-file", "/var/lib/pi-together/install-manifest.json"],
  ] as const;
  for (const [id, kind, target] of common) assertOperation(operations, id, kind, target);
  if (plan.producer.version !== VERSION) throw new Error("apply helper version does not match plan producer");
  if (plan.preconditions.find((item) => item.path === "/etc/systemd/system/pi-together.service")?.expected.kind !== "absent"
    || plan.preconditions.find((item) => item.path === "/var/lib/pi-together/install-manifest.json")?.expected.kind !== "absent") {
    throw new Error("existing Pi Together installation requires explicit upgrade/recovery");
  }
  const appAction = operations.get("app-service-action");
  if (appAction && (appAction.kind !== "service" || appAction.target !== "/etc/systemd/system/pi-together.service" || appAction.unit !== "pi-together.service" || appAction.action === "reload")) {
    throw new Error("app service action is invalid");
  }
  const expected = {
    "config-directory": { mode: "0750", owner: "root" },
    "runtime-directory": { mode: "0750" },
    "state-directory": { mode: "0750", owner: "root", group: "root" },
    "install-directory": { mode: "0755", owner: "root", group: "root" },
    "release-directory": { mode: "0755", owner: "root", group: "root" },
    "backup-root-directory": { mode: "0700", owner: "root", group: "root" },
    "backup-directory": { mode: "0700", owner: "root", group: "root" },
  } as const;
  for (const [id, fields] of Object.entries(expected)) {
    const operation = operations.get(id) as (Record<string, unknown> | undefined);
    for (const [key, expectedValue] of Object.entries(fields)) if (operation?.[key] !== expectedValue) throw new Error(`invalid ${id} ${key}`);
  }
  const release = operations.get("release");
  const current = operations.get("current-release");
  if (release?.kind !== "copy-release" || release.version !== VERSION || current?.kind !== "symlink" || current.linkTarget !== `/opt/pi-together/releases/${VERSION}`) {
    throw new Error("release activation operations are invalid");
  }
}

function ensureOperationOrder(plan: SetupPlan, expected: string[]): void {
  const actual = plan.operations.map((operation) => operation.id);
  if (actual.join("\0") !== expected.join("\0")) throw new Error("operation order does not match the independently allowlisted sequence");
}

function ensureExactOperationIds(plan: SetupPlan, allowed: Set<string>, required: Set<string>): void {
  for (const operation of plan.operations) {
    if (!allowed.has(operation.id)) throw new Error(`operation is not allowlisted: ${operation.id}`);
  }
  for (const id of required) if (!plan.operations.some((operation) => operation.id === id)) throw new Error(`required operation is missing: ${id}`);
}

function expectedBackupPath(path: string, sourceSha256: string): string {
  return `/var/lib/pi-together/backups/setup/${sha256(path).slice(0, 16)}-${sourceSha256.slice(0, 16)}`;
}

function validateRollbackAndPreconditions(plan: SetupPlan): void {
  const preconditions = new Map<string, FileState>();
  for (const precondition of plan.preconditions) {
    if (preconditions.has(precondition.path)) throw new Error(`duplicate precondition: ${precondition.path}`);
    preconditions.set(precondition.path, precondition.expected);
  }
  for (const operation of plan.operations) {
    const state = preconditions.get(operation.target);
    if (!state) throw new Error(`operation lacks precondition: ${operation.id}`);
    const rollback = operation.rollback;
    if (operation.kind === "service") {
      const action = operation.action === "enable-start" ? "disable-stop" : operation.action === "enable" ? "disable" : operation.action === "start" ? "stop" : operation.action === "reload" ? "reload" : "none";
      if (rollback.kind !== "service-action" || rollback.action !== action) throw new Error(`invalid service rollback: ${operation.id}`);
    } else if (operation.kind === "certificate") {
      if (rollback.kind !== "delete-certificate" || rollback.domain !== operation.domain) throw new Error("invalid certificate rollback");
    } else if (operation.kind === "reuse-certificate") {
      if (state.kind !== "symlink" || rollback.kind !== "none") throw new Error("invalid reused certificate precondition or rollback");
    } else if (operation.kind === "install-apt") {
      if (rollback.kind !== "remove-installed-packages" || rollback.packages.join("\0") !== operation.packages.join("\0")) throw new Error("invalid package rollback");
    } else if (state.kind === "file") {
      if (rollback.kind !== "restore-backup" || rollback.sourceSha256 !== state.sha256 || rollback.backupPath !== expectedBackupPath(operation.target, state.sha256)) {
        throw new Error(`invalid file rollback: ${operation.id}`);
      }
    } else if (state.kind === "absent") {
      if (rollback.kind !== "remove-created") throw new Error(`invalid creation rollback: ${operation.id}`);
    } else if (state.kind === "directory") {
      if (rollback.kind !== "none") throw new Error(`invalid directory rollback: ${operation.id}`);
    } else {
      throw new Error(`unsafe operation precondition type: ${operation.id}`);
    }
  }
}

function validateTemplateHash(operation: SetupOperation): asserts operation is SetupOperation & { kind: "write-file" } {
  if (operation.kind !== "write-file" || !fixedHashEqual(sha256(operation.contentTemplate), operation.expectedTemplateSha256)) {
    throw new Error(`template hash mismatch for operation ${operation.id}`);
  }
}

function safeAppConfig(template: string, proxySecret?: string): z.infer<typeof AppConfigSchema> {
  try {
    const config = AppConfigSchema.parse(JSON.parse(proxySecret ? substitute(template, "proxy-secret", proxySecret) : template));
    if (config.sharedRepositoryFolders.some((root) => root === "/" || normalize(root) !== root || /[\u0000-\u001f\u007f]/.test(root))) throw new Error();
    if (config.mode === "local" && (config.listener.host !== "127.0.0.1" || !isLocalListenerPort(config.listener.port))) throw new Error();
    if (config.mode !== "local" && (config.listener.kind !== "unix" || config.listener.path !== "/run/pi-together/app.sock")) throw new Error();
    return config;
  } catch {
    throw new Error("generated app config failed independent validation");
  }
}

export function validateApplyRequest(value: unknown): ValidatedApply {
  const request = ApplyRequestSchema.parse(value);
  const plan = SetupPlanSchema.parse(request.plan);
  const operations = operationMap(plan);
  validateCommonOperations(plan, operations);
  validateRollbackAndPreconditions(plan);
  const files = new Map<string, Buffer>();
  const secrets = new Map<string, Buffer>();

  const commonIds = new Set([
    "config-directory", "runtime-directory", "state-directory", "install-directory", "release-directory",
    "backup-root-directory", "backup-directory", "release", "current-release", "app-config", "app-service", "install-manifest", "app-service-action",
  ]);
  let reviewedConfig: z.infer<typeof AppConfigSchema>;
  const appConfigOperation = assertOperation(operations, "app-config", "write-file", "/etc/pi-together/config.json");
  validateTemplateHash(appConfigOperation);

  if (plan.mode === "local") {
    if (request.secrets || plan.secretInputs.length !== 0) throw new Error("local plans must not carry secrets");
    ensureExactOperationIds(plan, commonIds, new Set([...commonIds].filter((id) => id !== "app-service-action")));
    ensureOperationOrder(plan, [
      "config-directory", "runtime-directory", "state-directory", "install-directory", "release-directory",
      "backup-root-directory", "backup-directory", "release", "current-release", "app-config", "app-service", "install-manifest",
      ...(operations.has("app-service-action") ? ["app-service-action"] : []),
    ]);
    const config = safeAppConfig(appConfigOperation.contentTemplate);
    reviewedConfig = config;
    if (config.mode !== "local") throw new Error("local plan rendered a non-local config");
    const expectedConfig = `${JSON.stringify({ version: config.version, mode: config.mode, listener: config.listener, sharedRepositoryFolders: config.sharedRepositoryFolders }, null, 2)}\n`;
    if (appConfigOperation.contentTemplate !== expectedConfig) throw new Error("local app config is not canonical");
  } else {
    const secretValues = SecretValuesSchema.parse(request.secrets);
    for (const [id, value] of Object.entries(secretValues)) secrets.set(id, Buffer.from(value));
    const declaration = new Map(plan.secretInputs.map((input) => [input.id, input]));
    const oauthDeclaration = declaration.get("oauth-client-secret");
    if (!oauthDeclaration?.expectedSha256 || !fixedHashEqual(sha256(secretValues["oauth-client-secret"]), oauthDeclaration.expectedSha256)) {
      throw new Error("OAuth client secret does not match the reviewed plan");
    }
    const config = safeAppConfig(appConfigOperation.contentTemplate, secretValues["proxy-secret"]);
    reviewedConfig = config;
    if (config.mode === "local" || config.mode !== plan.mode) throw new Error("public plan rendered the wrong ingress config");
    if (config.principals.some((principal) => principal.verification !== "verified" || principal.verifiedAt !== plan.observedAt)) {
      throw new Error("public plan principal verification is invalid");
    }
    const canonicalTemplate = `${JSON.stringify({
      version: config.version,
      mode: config.mode,
      listener: config.listener,
      publicOrigin: config.publicOrigin,
      ...(config.mode === "tailscale-funnel" ? { tailscaleDnsName: config.tailscaleDnsName } : {}),
      proxySecret: "{{secret:proxy-secret}}",
      principals: config.principals,
      sharedRepositoryFolders: config.sharedRepositoryFolders,
    }, null, 2)}\n`;
    if (appConfigOperation.contentTemplate !== canonicalTemplate) throw new Error("public app config is not canonical");

    if (plan.mode === "reverse-proxy") {
    const publicIds = [
      "acme-directory", "oauth-helper-directory", "download-directory", "apt-web-stack",
      "oauth2-proxy-archive", "oauth2-proxy", "oauth-client-secret", "oauth-cookie-secret", "oauth-config",
      "nginx-challenge-site", "nginx-enable", "nginx-challenge-action", "certificate", "nginx-final-site",
      "nginx-final-reload", "oauth-service", "renewal-hook", "certbot-renewal-action", "oauth-service-action",
    ];
    for (const id of publicIds) commonIds.add(id);
    ensureExactOperationIds(plan, commonIds, new Set([...commonIds].filter((id) => id !== "app-service-action" && id !== "oauth-service-action")));
    ensureOperationOrder(plan, [
      "config-directory", "runtime-directory", "state-directory", "install-directory", "release-directory",
      "backup-root-directory", "backup-directory", "release", "current-release", "acme-directory",
      "oauth-helper-directory", "download-directory", "apt-web-stack", "oauth2-proxy-archive", "oauth2-proxy",
      "oauth-client-secret", "oauth-cookie-secret", "oauth-config", "nginx-challenge-site", "nginx-enable",
      "nginx-challenge-action", "certificate", "nginx-final-site", "nginx-final-reload", "oauth-service",
      "renewal-hook", "certbot-renewal-action", ...(operations.has("oauth-service-action") ? ["oauth-service-action"] : []),
      "app-config", "app-service", "install-manifest", ...(operations.has("app-service-action") ? ["app-service-action"] : []),
    ]);
    for (const [id, kind, target] of [
      ["acme-directory", "ensure-directory", "/var/lib/pi-together/acme"],
      ["oauth-helper-directory", "ensure-directory", "/opt/pi-together/helpers"],
      ["download-directory", "ensure-directory", "/var/lib/pi-together/downloads"],
      ["apt-web-stack", "install-apt", "/usr/bin/apt-get"],
      ["oauth2-proxy", "extract-oauth2-proxy", "/opt/pi-together/helpers/oauth2-proxy"],
      ["oauth-client-secret", "write-secret-file", "/etc/pi-together/oauth-client.secret"],
      ["oauth-cookie-secret", "write-secret-file", "/etc/pi-together/oauth-cookie.secret"],
      ["nginx-enable", "symlink", "/etc/nginx/sites-enabled/pi-together.conf"],
      ["oauth-service", "write-file", "/etc/systemd/system/pi-together-oauth2-proxy.service"],
      ["renewal-hook", "write-file", "/etc/letsencrypt/renewal-hooks/deploy/pi-together"],
    ] as const) assertOperation(operations, id, kind, target);
    const appServiceOperation = operations.get("app-service");
    if (appConfigOperation.mode !== "0600" || appConfigOperation.group !== plan.invokingUser.group
      || appServiceOperation?.kind !== "write-file" || appServiceOperation.mode !== "0644" || appServiceOperation.owner !== "root" || appServiceOperation.group !== "root") {
      throw new Error("app file permissions are invalid");
    }
    const apt = operations.get("apt-web-stack");
    if (apt?.kind !== "install-apt" || !(["certbot"].join("\0") === apt.packages.join("\0") || ["nginx", "certbot"].join("\0") === apt.packages.join("\0"))) {
      throw new Error("package allowlist is invalid");
    }
    if (plan.preconditions.find((item) => item.path === "/etc/systemd/system/pi-together-oauth2-proxy.service")?.expected.kind !== "absent") {
      throw new Error("existing oauth2-proxy systemd unit requires explicit upgrade/recovery");
    }
    const oauthAction = operations.get("oauth-service-action");
    if (oauthAction && (oauthAction.kind !== "service" || oauthAction.target !== "/etc/systemd/system/pi-together-oauth2-proxy.service" || oauthAction.unit !== "pi-together-oauth2-proxy.service" || oauthAction.action === "reload")) {
      throw new Error("oauth service action is invalid");
    }
    const appAction = operations.get("app-service-action");
    if (!!appAction !== !!oauthAction || (appAction?.kind === "service" && oauthAction?.kind === "service" && appAction.action !== oauthAction.action)) {
      throw new Error("public app and OAuth lifecycle actions must be present together and match");
    }
    const challengeAction = assertOperation(operations, "nginx-challenge-action", "service", operations.get("nginx-challenge-action")?.target ?? "");
    const finalReload = assertOperation(operations, "nginx-final-reload", "service", "/lib/systemd/system/nginx.service");
    if (challengeAction.unit !== "nginx.service"
      || (challengeAction.action === "start" ? challengeAction.target !== "/usr/sbin/nginx" : challengeAction.action === "reload" ? challengeAction.target !== "/lib/systemd/system/nginx.service" : true)
      || finalReload.unit !== "nginx.service" || finalReload.action !== "reload") {
      throw new Error("nginx service actions are invalid");
    }
    const asset = OAUTH2_PROXY_RELEASE.assets[plan.arch === "x64" ? "linux-x64" : "linux-arm64"];
    const archiveTarget = `/var/lib/pi-together/downloads/${asset.archive}`;
    const archive = assertOperation(operations, "oauth2-proxy-archive", "download", archiveTarget);
    const extraction = operations.get("oauth2-proxy");
    if (archive.kind !== "download" || archive.url !== `${OAUTH2_PROXY_RELEASE.baseUrl}/${asset.archive}` || archive.expectedSha256 !== asset.sha256 || archive.mode !== "0600"
      || extraction?.kind !== "extract-oauth2-proxy" || extraction.archive !== archiveTarget || extraction.archiveSha256 !== asset.sha256 || extraction.mode !== "0755") {
      throw new Error("oauth2-proxy artifact operation is invalid");
    }
    const certificate = operations.get("certificate");
    const certificateTarget = `/etc/letsencrypt/live/${new URL(config.publicOrigin).hostname}/fullchain.pem`;
    if (!certificate || certificate.target !== certificateTarget || !(certificate.kind === "certificate" || certificate.kind === "reuse-certificate")
      || certificate.domain !== new URL(config.publicOrigin).hostname) throw new Error("invalid certificate operation");
    if (certificate.kind === "certificate") {
      const certificateKeyPath = `/etc/letsencrypt/live/${certificate.domain}/privkey.pem`;
      if (certificate.webroot !== "/var/lib/pi-together/acme"
        || plan.preconditions.find((item) => item.path === certificate.target)?.expected.kind !== "absent"
        || plan.preconditions.find((item) => item.path === certificateKeyPath)?.expected.kind !== "absent") {
        throw new Error("invalid certificate issuance operation or existing lineage");
      }
    } else if (plan.preconditions.find((item) => item.path === certificate.target)?.expected.kind !== "symlink") {
      throw new Error("reused certificate must bind the exact reviewed lineage link");
    }
    const renewalAction = assertOperation(operations, "certbot-renewal-action", "service", "/lib/systemd/system/certbot.timer");
    if (renewalAction.unit !== "certbot.timer" || renewalAction.action !== "enable-start") throw new Error("invalid Certbot renewal timer action");
    const oauth = assertOperation(operations, "oauth-config", "write-file", "/etc/pi-together/oauth2-proxy.cfg");
    const challenge = assertOperation(operations, "nginx-challenge-site", "write-file", "/etc/nginx/sites-available/pi-together.conf");
    const nginx = assertOperation(operations, "nginx-final-site", "write-file", "/etc/nginx/sites-available/pi-together.conf");
    for (const operation of [oauth, challenge, nginx]) validateTemplateHash(operation);
    if (oauth.kind !== "write-file" || oauth.mode !== "0644" || oauth.owner !== "root" || oauth.group !== "root") {
      throw new Error("oauth2-proxy config permissions are invalid");
    }
    if (challenge.kind !== "write-file" || challenge.mode !== "0644" || challenge.owner !== "root" || challenge.group !== "root"
      || nginx.kind !== "write-file" || nginx.mode !== "0600" || nginx.owner !== "root" || nginx.group !== "root") {
      throw new Error("nginx file permissions are invalid");
    }
    const oauthServiceFile = operations.get("oauth-service");
    const renewalFile = operations.get("renewal-hook");
    if (oauthServiceFile?.kind !== "write-file" || oauthServiceFile.mode !== "0644" || oauthServiceFile.owner !== "root" || oauthServiceFile.group !== "root"
      || renewalFile?.kind !== "write-file" || renewalFile.mode !== "0755" || renewalFile.owner !== "root" || renewalFile.group !== "root") {
      throw new Error("fixed service file permissions are invalid");
    }
    const oauthValues = parseOauthConfig(oauth.contentTemplate);
    const domain = new URL(config.publicOrigin).hostname;
    const expected = renderDeploymentTemplates({
      domain,
      listener: config.listener,
      oauth2ProxyPort: 4180,
      proxySecret: "PI_TOGETHER_PROXY_SECRET_PLACEHOLDER_______",
      githubLogins: config.principals.map((principal) => principal.login),
      oauthClientId: oauthValues.clientId,
      oauthClientSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-client-secret",
      cookieSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-cookie-secret",
      tlsCertificate: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
      tlsCertificateKey: `/etc/letsencrypt/live/${domain}/privkey.pem`,
      acmeWebroot: "/var/lib/pi-together/acme",
    });
    if (oauthValues.logins.sort().join("\0") !== config.principals.map((principal) => principal.login).sort().join("\0")
      || oauth.contentTemplate !== expected.oauth2ProxyConfig
      || challenge.contentTemplate !== renderNginxChallengeSite(domain, "/var/lib/pi-together/acme")
      || nginx.contentTemplate !== expected.nginxSite.replaceAll("PI_TOGETHER_PROXY_SECRET_PLACEHOLDER_______", "{{secret:proxy-secret}}")) {
      throw new Error("public proxy templates failed independent rendering validation");
    }
    const clientFile = assertOperation(operations, "oauth-client-secret", "write-secret-file", "/etc/pi-together/oauth-client.secret");
    const cookieFile = assertOperation(operations, "oauth-cookie-secret", "write-secret-file", "/etc/pi-together/oauth-cookie.secret");
    const enabledSite = operations.get("nginx-enable");
    if (enabledSite?.kind !== "symlink" || enabledSite.linkTarget !== "/etc/nginx/sites-available/pi-together.conf") throw new Error("nginx activation symlink is invalid");
    if (clientFile.kind !== "write-secret-file" || clientFile.source !== "answer" || clientFile.mode !== "0600" || clientFile.owner !== "root" || clientFile.group !== "root"
      || cookieFile.kind !== "write-secret-file" || cookieFile.source !== "generated-at-apply" || cookieFile.mode !== "0600" || cookieFile.owner !== "root" || cookieFile.group !== "root") {
      throw new Error("secret file operations are invalid");
    }
    } else {
      const funnelIds = ["oauth-helper-directory", "download-directory", "apt-funnel-edge", "oauth2-proxy-archive", "oauth2-proxy",
        "oauth-client-secret", "oauth-cookie-secret", "oauth-config", "funnel-edge-config", "oauth-service", "funnel-edge-service", "funnel-service",
        "oauth-service-action", "funnel-edge-service-action", "funnel-service-action"];
      for (const id of funnelIds) commonIds.add(id);
      const required = new Set([...commonIds].filter((id) => !["apt-funnel-edge", "app-service-action", "oauth-service-action", "funnel-edge-service-action", "funnel-service-action"].includes(id)));
      ensureExactOperationIds(plan, commonIds, required);
      ensureOperationOrder(plan, [
        "config-directory", "runtime-directory", "state-directory", "install-directory", "release-directory", "backup-root-directory", "backup-directory",
        "release", "current-release", "oauth-helper-directory", "download-directory", ...(operations.has("apt-funnel-edge") ? ["apt-funnel-edge"] : []),
        "oauth2-proxy-archive", "oauth2-proxy", "oauth-client-secret", "oauth-cookie-secret", "oauth-config", "funnel-edge-config", "oauth-service",
        "funnel-edge-service", "funnel-service", "app-config", "app-service", "install-manifest", ...(operations.has("app-service-action") ? ["app-service-action"] : []),
        ...(operations.has("oauth-service-action") ? ["oauth-service-action"] : []), ...(operations.has("funnel-edge-service-action") ? ["funnel-edge-service-action"] : []),
        ...(operations.has("funnel-service-action") ? ["funnel-service-action"] : []),
      ]);
      for (const [id, kind, target] of [
        ["oauth-helper-directory", "ensure-directory", "/opt/pi-together/helpers"], ["download-directory", "ensure-directory", "/var/lib/pi-together/downloads"],
        ["oauth2-proxy", "extract-oauth2-proxy", "/opt/pi-together/helpers/oauth2-proxy"],
        ["oauth-client-secret", "write-secret-file", "/etc/pi-together/oauth-client.secret"], ["oauth-cookie-secret", "write-secret-file", "/etc/pi-together/oauth-cookie.secret"],
        ["oauth-service", "write-file", "/etc/systemd/system/pi-together-oauth2-proxy.service"],
        ["funnel-edge-service", "write-file", "/etc/systemd/system/pi-together-edge.service"], ["funnel-service", "write-file", "/etc/systemd/system/pi-together-funnel.service"],
      ] as const) assertOperation(operations, id, kind, target);
      const apt = operations.get("apt-funnel-edge");
      if (apt && (apt.kind !== "install-apt" || apt.target !== "/usr/bin/apt-get" || apt.packages.join("\0") !== "nginx")) throw new Error("Funnel package allowlist is invalid");
      const asset = OAUTH2_PROXY_RELEASE.assets[plan.arch === "x64" ? "linux-x64" : "linux-arm64"];
      const archiveTarget = `/var/lib/pi-together/downloads/${asset.archive}`;
      const archive = assertOperation(operations, "oauth2-proxy-archive", "download", archiveTarget);
      const extraction = operations.get("oauth2-proxy");
      if (archive.url !== `${OAUTH2_PROXY_RELEASE.baseUrl}/${asset.archive}` || archive.expectedSha256 !== asset.sha256 || archive.mode !== "0600"
        || extraction?.kind !== "extract-oauth2-proxy" || extraction.archive !== archiveTarget || extraction.archiveSha256 !== asset.sha256) throw new Error("oauth2-proxy artifact operation is invalid");
      const oauth = assertOperation(operations, "oauth-config", "write-file", "/etc/pi-together/oauth2-proxy.cfg");
      const edge = assertOperation(operations, "funnel-edge-config", "write-file", "/etc/pi-together/nginx-funnel.conf");
      for (const operation of [oauth, edge]) validateTemplateHash(operation);
      const oauthValues = parseOauthConfig(oauth.contentTemplate);
      const domain = new URL(config.publicOrigin).hostname;
      if (config.mode !== "tailscale-funnel" || config.tailscaleDnsName !== domain) throw new Error("Funnel origin is not canonical");
      const templateInput = { domain, listener: config.listener, oauth2ProxyPort: 4180, proxySecret: "PI_TOGETHER_PROXY_SECRET_PLACEHOLDER_______",
        githubLogins: config.principals.map((principal) => principal.login), oauthClientId: oauthValues.clientId,
        oauthClientSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-client-secret",
        cookieSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-cookie-secret",
        tlsCertificate: "/unused/funnel/fullchain.pem", tlsCertificateKey: "/unused/funnel/privkey.pem", acmeWebroot: "/unused/funnel/acme" };
      if (oauth.contentTemplate !== renderDeploymentTemplates(templateInput).oauth2ProxyConfig
        || edge.contentTemplate !== renderNginxFunnelEdge(templateInput, { serviceUser: plan.invokingUser.username }).replaceAll("PI_TOGETHER_PROXY_SECRET_PLACEHOLDER_______", "{{secret:proxy-secret}}")) throw new Error("Funnel proxy templates failed independent validation");
      const oauthService = assertOperation(operations, "oauth-service", "write-file", "/etc/systemd/system/pi-together-oauth2-proxy.service");
      const edgeService = assertOperation(operations, "funnel-edge-service", "write-file", "/etc/systemd/system/pi-together-edge.service");
      const funnelService = assertOperation(operations, "funnel-service", "write-file", "/etc/systemd/system/pi-together-funnel.service");
      if (oauthService.contentTemplate !== renderOauth2ProxyService() || edgeService.contentTemplate !== renderFunnelEdgeService() || funnelService.contentTemplate !== renderFunnelService()) throw new Error("Funnel service templates failed independent validation");
      const funnelLifecycle = [
        ["app-service-action", "pi-together.service", "/etc/systemd/system/pi-together.service"],
        ["oauth-service-action", "pi-together-oauth2-proxy.service", "/etc/systemd/system/pi-together-oauth2-proxy.service"],
        ["funnel-edge-service-action", "pi-together-edge.service", "/etc/systemd/system/pi-together-edge.service"],
        ["funnel-service-action", "pi-together-funnel.service", "/etc/systemd/system/pi-together-funnel.service"],
      ] as const;
      const lifecycleActions: Array<Extract<SetupOperation, { kind: "service" }>> = [];
      for (const [id, unit, target] of funnelLifecycle) {
        const action = operations.get(id);
        if (action && (action.kind !== "service" || action.action === "reload" || action.unit !== unit || action.target !== target)) {
          throw new Error(`invalid Funnel service action: ${id}`);
        }
        if (action?.kind === "service") lifecycleActions.push(action);
      }
      if (lifecycleActions.length !== 0 && (lifecycleActions.length !== funnelLifecycle.length
        || lifecycleActions.some((action) => action.action !== lifecycleActions[0]!.action))) {
        throw new Error("Funnel lifecycle actions must be present together and match");
      }
    }
  }

  for (const operation of plan.operations) {
    if (operation.kind === "write-file") {
      validateTemplateHash(operation);
      let content = operation.contentTemplate;
      for (const id of operation.secretIds) content = substitute(content, id, secrets.get(id)!.toString("utf8"));
      files.set(operation.id, Buffer.from(content));
    } else if (operation.kind === "write-secret-file") {
      files.set(operation.id, secrets.get(operation.secretId)!);
    }
  }

  const appService = assertOperation(operations, "app-service", "write-file", "/etc/systemd/system/pi-together.service");
  const nodePath = appService.kind === "write-file" ? appService.contentTemplate.match(/^ExecStart=(\S+) /m)?.[1] ?? "" : "";
  const piPath = appService.kind === "write-file" ? appService.contentTemplate.match(/^Environment=PI_BIN=(\S+)$/m)?.[1] ?? "" : "";
  const serviceUser = appService.kind === "write-file" ? appService.contentTemplate.match(/^User=(\S+)$/m)?.[1] ?? "" : "";
  if (serviceUser !== plan.invokingUser.username || serviceUser === "root") throw new Error("app service user does not match the invoking non-root user");
  const configDirectory = operations.get("config-directory");
  const runtimeDirectory = operations.get("runtime-directory");
  if (configDirectory?.kind !== "ensure-directory" || configDirectory.owner !== "root" || configDirectory.group !== plan.invokingUser.group
    || runtimeDirectory?.kind !== "ensure-directory" || runtimeDirectory.owner !== serviceUser || runtimeDirectory.group !== plan.invokingUser.group) {
    throw new Error("application directory ownership is invalid");
  }
  if (appService.kind !== "write-file" || appService.mode !== "0644" || appService.owner !== "root" || appService.group !== "root"
    || appConfigOperation.mode !== "0600" || appConfigOperation.owner !== serviceUser || appConfigOperation.group !== plan.invokingUser.group) {
    throw new Error("app service/config ownership is invalid");
  }
  const workspacePaths = new Set(reviewedConfig.sharedRepositoryFolders);
  for (const workspace of workspacePaths) {
    const expected = plan.preconditions.find((item) => item.path === workspace)?.expected;
    if (expected?.kind !== "directory" || expected.uid !== plan.invokingUser.uid) {
      throw new Error("shared repository folder lacks an exact invoking-user-owned directory precondition");
    }
  }
  const operationTargets = new Set(plan.operations.map((operation) => operation.target));
  const certificateKeyPrecondition = reviewedConfig.mode === "reverse-proxy"
    ? `/etc/letsencrypt/live/${new URL(reviewedConfig.publicOrigin).hostname}/privkey.pem`
    : undefined;
  for (const precondition of plan.preconditions) {
    if (!operationTargets.has(precondition.path) && precondition.path !== nodePath && precondition.path !== piPath && !workspacePaths.has(precondition.path)
      && !(plan.mode === "tailscale-funnel" && precondition.path === "/usr/bin/tailscale")
      && !(plan.mode === "reverse-proxy" && (precondition.path.startsWith("/etc/nginx/")
        || precondition.path === certificateKeyPrecondition))) {
      throw new Error("plan contains a non-allowlisted precondition path");
    }
  }
  for (const executable of [nodePath, piPath, ...(plan.mode === "tailscale-funnel" ? ["/usr/bin/tailscale"] : [])]) {
    const precondition = plan.preconditions.find((item) => item.path === executable);
    if (!precondition || precondition.expected.kind !== "file" || (executable === "/usr/bin/tailscale" && (precondition.expected.uid !== 0 || (precondition.expected.mode & 0o022) !== 0))) throw new Error("runtime executable lacks an exact safe file precondition");
  }
  if (appService.kind !== "write-file" || appService.contentTemplate !== renderAppService({
    nodePath,
    piPath,
    serviceUser,
    publicMode: plan.mode !== "local",
  })) throw new Error("app service failed independent rendering validation");
  const installManifest = assertOperation(operations, "install-manifest", "write-file", "/var/lib/pi-together/install-manifest.json");
  const oauthArchive = operations.get("oauth2-proxy-archive");
  const expectedInstallManifest = renderInstallManifest(buildInstallManifest(
    plan.mode,
    plan.producer.version,
    oauthArchive?.kind === "download" ? oauthArchive.target : undefined,
  ));
  if (installManifest.mode !== "0644" || installManifest.owner !== "root" || installManifest.group !== "root"
    || installManifest.contentTemplate !== expectedInstallManifest) throw new Error("installation manifest failed independent validation");

  if (plan.mode !== "local") {
    const oauthService = assertOperation(operations, "oauth-service", "write-file", "/etc/systemd/system/pi-together-oauth2-proxy.service");
    if (oauthService.kind !== "write-file" || oauthService.contentTemplate !== renderOauth2ProxyService()) throw new Error("fixed OAuth service template failed independent validation");
    if (plan.mode === "reverse-proxy") {
      const renewal = assertOperation(operations, "renewal-hook", "write-file", "/etc/letsencrypt/renewal-hooks/deploy/pi-together");
      if (renewal.kind !== "write-file" || renewal.contentTemplate !== renderRenewalHook()) throw new Error("renewal template failed independent validation");
    }
  }
  return {
    plan,
    files,
    secrets,
    runtimeExecutables: new Set([nodePath, piPath, ...(plan.mode === "tailscale-funnel" ? ["/usr/bin/tailscale"] : [])]),
    ...(reviewedConfig.mode === "local" ? { localPort: reviewedConfig.listener.port } : {}),
  };
}

export async function applyValidated(requestValue: unknown, io: ApplyIo): Promise<void> {
  const validated = validateApplyRequest(requestValue);
  await io.recover(validated);
  for (const precondition of validated.plan.preconditions) {
    const actual = await io.inspect(
      precondition.path,
      validated.runtimeExecutables.has(precondition.path) ? RUNTIME_EXECUTABLE_LIMIT : undefined,
    );
    if (!equalState(actual, precondition.expected)) throw new Error(`precondition changed: ${precondition.path}`);
  }
  if (validated.localPort !== undefined && !await io.localPortAvailable(validated.localPort)) {
    throw new Error(`selected local port is no longer available: ${validated.localPort}`);
  }
  await io.prepare(validated);
  const completed: SetupOperation[] = [];
  try {
    for (const operation of validated.plan.operations) {
      await io.execute(operation, validated.files.get(operation.id));
      completed.push(operation);
    }
    await io.verify(validated);
    await io.finish(validated);
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const operation of completed.reverse()) {
      try {
        await io.rollback(operation);
      } catch {
        rollbackFailures.push(operation.id);
      }
    }
    if (rollbackFailures.length === 0) {
      try {
        await io.abort(validated);
      } catch {
        rollbackFailures.push("in-flight operation journal");
      }
    }
    const failed = error instanceof Error ? error.message : "unknown apply failure";
    throw new Error(`apply failed: ${failed}${rollbackFailures.length ? `; rollback failed for ${rollbackFailures.join(", ")}` : ""}`);
  }
}

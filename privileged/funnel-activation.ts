import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request as httpsRequest } from "node:https";
import { parseConfig } from "../server/config.js";
import { renderFunnelService } from "../deployment/service-templates.js";
import { FunnelActivationInspectionSchema, type FunnelActivationInspection } from "../shared/funnel-activation-protocol.js";
import { readBoundedRegular } from "./bounded-file.js";

const exec = promisify(execFile);
const environment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };

export function classifyFunnelActivation(status: string, logs: string, dnsName: string): FunnelActivationInspection {
  let inventory: unknown;
  try { inventory = JSON.parse(status); } catch { throw new Error("Tailscale Funnel status is not valid JSON"); }
  const foreground = inventory && typeof inventory === "object" ? (inventory as { Foreground?: unknown }).Foreground : undefined;
  const key = `${dnsName}:443`;
  const active = foreground && typeof foreground === "object" && Object.values(foreground).some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const value = entry as { TCP?: Record<string, { HTTPS?: unknown }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>; AllowFunnel?: Record<string, unknown> };
    return value.TCP?.["443"]?.HTTPS === true && value.Web?.[key]?.Handlers?.["/"]?.Proxy === "http://127.0.0.1:43118" && value.AllowFunnel?.[key] === true;
  });
  if (active) return { status: "active" };
  const approvalUrl = logs.match(/https:\/\/login\.tailscale\.com\/f\/funnel\?node=[A-Za-z0-9_-]+/)?.[0];
  return FunnelActivationInspectionSchema.parse(approvalUrl ? { status: "approval-required", approvalUrl } : { status: "pending" });
}

async function publicRouteActive(dnsName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = httpsRequest({ hostname: dnsName, port: 443, path: "/", method: "GET", timeout: 5_000 }, (response) => {
      response.resume();
      const expected = `https://${dnsName}/oauth2/sign_in?rd=https://${dnsName}/`;
      response.once("end", () => resolve(response.statusCode === 302 && response.headers.location === expected));
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
    request.end();
  });
}

export async function inspectFunnelActivation(
  invokingUid: number,
  dnsName: string,
  probePublicRoute: (dnsName: string) => Promise<boolean> = publicRouteActive,
): Promise<FunnelActivationInspection> {
  const [unit, config] = await Promise.all([
    readBoundedRegular("/etc/systemd/system/pi-together-funnel.service", 64 * 1024, "Funnel unit is not a bounded stable regular file"),
    readBoundedRegular("/etc/pi-together/config.json", 256 * 1024, "app config is not a bounded stable regular file"),
  ]);
  if (unit.info.uid !== 0 || unit.info.gid !== 0 || (unit.info.mode & 0o777) !== 0o644 || unit.bytes.toString("utf8") !== renderFunnelService()) {
    throw new Error("Funnel unit is not canonical");
  }
  if (config.info.uid !== invokingUid || (config.info.mode & 0o777) !== 0o600) throw new Error("Funnel app config ownership is unsafe");
  const parsed = parseConfig(JSON.parse(config.bytes.toString("utf8")));
  if (parsed.mode !== "tailscale-funnel" || parsed.tailscaleDnsName !== dnsName || parsed.publicOrigin !== `https://${dnsName}`) {
    throw new Error("Funnel app config does not match the requested activation");
  }
  await exec("/bin/systemctl", ["is-active", "--quiet", "pi-together-funnel.service"], { timeout: 10_000, env: environment });
  const status = await exec("/usr/bin/tailscale", ["funnel", "status", "--json"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, env: environment });
  if (classifyFunnelActivation(status.stdout, "", dnsName).status === "active") {
    return await probePublicRoute(dnsName) ? { status: "active" } : { status: "pending" };
  }
  const logs = await exec("/bin/journalctl", ["--unit", "pi-together-funnel.service", "--boot", "--lines", "50", "--no-pager", "--output", "cat"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024, env: environment,
  });
  return classifyFunnelActivation(status.stdout, logs.stdout, dnsName);
}

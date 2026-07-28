import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolvePrivilegedPath } from "./root-path.js";
import { CertificateDomainSchema, CertificateInspectionSchema, type CertificateInspection } from "../shared/certificate-protocol.js";

const exec = promisify(execFile);

interface Options {
  root?: string;
  rootIdentity?: { uid: number; gid: number };
  command?: (file: string, args: string[]) => Promise<string>;
}

export async function inspectCertificateLineage(domainValue: string, options: Options = {}): Promise<CertificateInspection> {
  const domain = CertificateDomainSchema.parse(domainValue);
  const root = resolve(options.root ?? "/");
  const rootIdentity = options.rootIdentity ?? { uid: 0, gid: 0 };
  const path = (logical: string) => resolvePrivilegedPath(root, logical, "certificate inspection");
  const fullchainLogical = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  const privateLogical = `/etc/letsencrypt/live/${domain}/privkey.pem`;
  let fullchainLink;
  let privateLink;
  try {
    [fullchainLink, privateLink] = await Promise.all([lstat(path(fullchainLogical)), lstat(path(privateLogical))]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const states = await Promise.all([fullchainLogical, privateLogical].map(async (logical) => {
      try { await lstat(path(logical)); return "present"; }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw failure; }
    }));
    if (states.every((state) => state === "absent")) return { status: "absent" };
    throw new Error("certificate lineage is incomplete");
  }
  for (const link of [fullchainLink, privateLink]) {
    if (!link.isSymbolicLink() || link.uid !== rootIdentity.uid || link.gid !== rootIdentity.gid) throw new Error("certificate lineage link metadata is unsafe");
  }
  const [fullchainTarget, privateTarget] = await Promise.all([readlink(path(fullchainLogical)), readlink(path(privateLogical))]);
  const escapedDomain = domain.replaceAll(".", "\\.");
  const fullchainVersion = fullchainTarget.match(new RegExp(`^\\.\\./\\.\\./archive/${escapedDomain}/fullchain([1-9]\\d*)\\.pem$`))?.[1];
  const privateVersion = privateTarget.match(new RegExp(`^\\.\\./\\.\\./archive/${escapedDomain}/privkey([1-9]\\d*)\\.pem$`))?.[1];
  if (!fullchainVersion || privateVersion !== fullchainVersion) throw new Error("certificate lineage links are not an exact matching Certbot version");
  const archiveRoot = path(`/etc/letsencrypt/archive/${domain}`);
  const [fullchain, privateKey] = await Promise.all([realpath(path(fullchainLogical)), realpath(path(privateLogical))]);
  if (!fullchain.startsWith(`${archiveRoot}/`) || !privateKey.startsWith(`${archiveRoot}/`)) throw new Error("certificate lineage escapes its exact archive");
  for (const [target, isPrivate] of [[fullchain, false], [privateKey, true]] as const) {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== rootIdentity.uid || info.gid !== rootIdentity.gid
      || (info.mode & (isPrivate ? 0o077 : 0o022)) !== 0) throw new Error("certificate lineage file metadata is unsafe");
  }
  const renewalLogical = `/etc/letsencrypt/renewal/${domain}.conf`;
  const renewalHandle = await open(path(renewalLogical), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await renewalHandle.stat();
    if (!info.isFile() || info.uid !== rootIdentity.uid || info.gid !== rootIdentity.gid || (info.mode & 0o022) !== 0 || info.size > 256 * 1024) {
      throw new Error("Certbot renewal metadata is unsafe");
    }
    const renewal = await renewalHandle.readFile("utf8");
    for (const [key, expected] of [["cert", `/etc/letsencrypt/live/${domain}/cert.pem`], ["privkey", privateLogical], ["fullchain", fullchainLogical]] as const) {
      const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`^${key} = ${escaped}$`, "m").test(renewal)) throw new Error("Certbot renewal lineage does not match the requested domain");
    }
  } finally { await renewalHandle.close(); }
  const command = options.command ?? (async (file, args) => (await exec(file, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })).stdout);
  const openssl = path("/usr/bin/openssl");
  if (!options.command) {
    const info = await lstat(openssl);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== rootIdentity.uid || (info.mode & 0o022) !== 0) throw new Error("OpenSSL executable metadata is unsafe");
  }
  await command(openssl, ["x509", "-in", path(fullchainLogical), "-noout", "-checkend", "2592000"]);
  await command(openssl, ["x509", "-in", path(fullchainLogical), "-noout", "-checkhost", domain]);
  const expiry = await command(openssl, ["x509", "-in", path(fullchainLogical), "-noout", "-enddate"]);
  const parsedExpiry = new Date(expiry.trim().replace(/^notAfter=/, ""));
  if (!Number.isFinite(parsedExpiry.getTime())) throw new Error("certificate expiry could not be parsed");
  return CertificateInspectionSchema.parse({
    status: "existing",
    fullchainState: { kind: "symlink", target: fullchainTarget, uid: fullchainLink.uid, gid: fullchainLink.gid },
    expiresAt: parsedExpiry.toISOString(),
  });
}

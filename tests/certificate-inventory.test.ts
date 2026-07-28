import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCertificateLineage } from "../privileged/certificate-inventory.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-together-cert-"));
  roots.push(root);
  const domain = "pi.example.com";
  const archive = join(root, "etc/letsencrypt/archive", domain);
  const live = join(root, "etc/letsencrypt/live", domain);
  const renewal = join(root, "etc/letsencrypt/renewal");
  await Promise.all([mkdir(archive, { recursive: true }), mkdir(live, { recursive: true }), mkdir(renewal, { recursive: true })]);
  await writeFile(join(archive, "fullchain3.pem"), "synthetic-public-certificate\n", { mode: 0o644 });
  await writeFile(join(archive, "privkey3.pem"), "synthetic-private-key-fixture\n", { mode: 0o600 });
  await symlink(`../../archive/${domain}/fullchain3.pem`, join(live, "fullchain.pem"));
  await symlink(`../../archive/${domain}/privkey3.pem`, join(live, "privkey.pem"));
  await writeFile(join(renewal, `${domain}.conf`), [
    `cert = /etc/letsencrypt/live/${domain}/cert.pem`,
    `privkey = /etc/letsencrypt/live/${domain}/privkey.pem`,
    `fullchain = /etc/letsencrypt/live/${domain}/fullchain.pem`,
    "",
  ].join("\n"), { mode: 0o644 });
  return { root, domain, identity: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 } };
}

describe("protected Certbot lineage inspection", () => {
  it("returns only bounded public metadata for an exact valid lineage", async () => {
    const value = await fixture();
    const commands: string[][] = [];
    const result = await inspectCertificateLineage(value.domain, {
      root: value.root,
      rootIdentity: value.identity,
      command: async (_file, args) => {
        commands.push(args);
        return args.includes("-enddate") ? "notAfter=Jan  1 00:00:00 2027 GMT\n" : "";
      },
    });
    expect(result).toEqual({
      status: "existing",
      fullchainState: { kind: "symlink", target: "../../archive/pi.example.com/fullchain3.pem", ...value.identity },
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(commands).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("private-key-fixture");
  });

  it("reports exact absence and refuses incomplete lineages", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-together-cert-absent-"));
    roots.push(root);
    await expect(inspectCertificateLineage("pi.example.com", { root })).resolves.toEqual({ status: "absent" });
    await mkdir(join(root, "etc/letsencrypt/live/pi.example.com"), { recursive: true });
    await symlink("../../archive/pi.example.com/fullchain1.pem", join(root, "etc/letsencrypt/live/pi.example.com/fullchain.pem"));
    await expect(inspectCertificateLineage("pi.example.com", { root })).rejects.toThrow(/incomplete/);
  });
});

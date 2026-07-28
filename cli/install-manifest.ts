import { z } from "zod";
const Version = z.string().regex(/^\d+\.\d+\.\d+$/);
const AbsolutePath = z.string().regex(/^\/[A-Za-z0-9._+@/-]+$/).refine((path) => path !== "/" && !path.includes("//") && !path.split("/").includes(".."));
const EntrySchema = z.object({
  path: AbsolutePath,
  kind: z.enum(["file", "symlink", "directory"]),
  uninstall: z.enum(["remove", "preserve"]),
}).strict();
export const InstallManifestSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal("pi-together"),
  version: Version,
  mode: z.enum(["local", "reverse-proxy", "tailscale-funnel"]),
  entries: z.array(EntrySchema).min(1).max(128),
}).strict().superRefine((manifest, context) => {
  const paths = new Set<string>();
  manifest.entries.forEach((entry, index) => {
    if (paths.has(entry.path)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", index, "path"], message: "duplicate managed path" });
    paths.add(entry.path);
  });
});
export type InstallManifest = z.infer<typeof InstallManifestSchema>;

/** Return the stable package version embedded by a release. */
export function packageVersionForRelease(release: string): string {
  return Version.parse(release);
}

export function buildInstallManifest(mode: "local" | "reverse-proxy" | "tailscale-funnel", version: string, oauthArchive?: string, previousVersion?: string): InstallManifest {
  const entries: InstallManifest["entries"] = [
    { path: "/etc/pi-together/config.json", kind: "file", uninstall: "preserve" },
    { path: "/var/lib/pi-together/backups", kind: "directory", uninstall: "preserve" },
    { path: `/opt/pi-together/releases/${version}`, kind: "directory", uninstall: "remove" },
    { path: "/opt/pi-together/current", kind: "symlink", uninstall: "remove" },
    ...(previousVersion ? [
      { path: `/opt/pi-together/releases/${Version.parse(previousVersion)}`, kind: "directory" as const, uninstall: "remove" as const },
      { path: "/opt/pi-together/previous", kind: "symlink" as const, uninstall: "remove" as const },
    ] : []),
    { path: "/etc/systemd/system/pi-together.service", kind: "file", uninstall: "remove" },
    { path: "/var/lib/pi-together/install-manifest.json", kind: "file", uninstall: "remove" },
    { path: "/var/lib/pi-together/policy-journal.json", kind: "file", uninstall: "remove" },
  ];
  if (mode !== "local") {
    if (!/^\/var\/lib\/pi-together\/downloads\/oauth2-proxy-v\d+\.\d+\.\d+\.linux-(?:amd64|arm64)\.tar\.gz$/.test(oauthArchive ?? "")) {
      throw new Error("public install inventory requires the pinned oauth archive path");
    }
    const verifiedOauthArchive = oauthArchive!;
    entries.push(
      { path: verifiedOauthArchive, kind: "file", uninstall: "remove" },
      { path: "/opt/pi-together/helpers/oauth2-proxy", kind: "file", uninstall: "remove" },
      { path: "/etc/pi-together/oauth-client.secret", kind: "file", uninstall: "remove" },
      { path: "/etc/pi-together/oauth-cookie.secret", kind: "file", uninstall: "remove" },
      { path: "/etc/pi-together/oauth2-proxy.cfg", kind: "file", uninstall: "remove" },
      { path: "/var/lib/pi-together/user-management-journal.json", kind: "file", uninstall: "remove" },
      { path: "/etc/systemd/system/pi-together-oauth2-proxy.service", kind: "file", uninstall: "remove" },
    );
    if (mode === "reverse-proxy") entries.push(
      { path: "/etc/nginx/sites-available/pi-together.conf", kind: "file", uninstall: "remove" },
      { path: "/etc/nginx/sites-enabled/pi-together.conf", kind: "symlink", uninstall: "remove" },
      { path: "/etc/letsencrypt/renewal-hooks/deploy/pi-together", kind: "file", uninstall: "remove" },
    );
    else entries.push(
      { path: "/etc/pi-together/nginx-funnel.conf", kind: "file", uninstall: "remove" },
      { path: "/etc/systemd/system/pi-together-edge.service", kind: "file", uninstall: "remove" },
      { path: "/etc/systemd/system/pi-together-funnel.service", kind: "file", uninstall: "remove" },
      { path: "/var/lib/pi-together/share-journal.json", kind: "file", uninstall: "remove" },
    );
  }
  return InstallManifestSchema.parse({ schemaVersion: 1, product: "pi-together", version, mode, entries });
}

export function renderInstallManifest(manifest: InstallManifest): string {
  return `${JSON.stringify(InstallManifestSchema.parse(manifest), null, 2)}\n`;
}

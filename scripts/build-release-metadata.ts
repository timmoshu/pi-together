import { createHash } from "node:crypto";
import { readdir, readFile, lstat, writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";

interface PackageJson {
  name: string;
  version: string;
  license: string;
  piCompatibility: string;
  engines: { node: string };
}
interface PackageLockEntry { version?: string; license?: string; dev?: boolean; optional?: boolean }
interface PackageLock { packages: Record<string, PackageLockEntry> }

const root = process.cwd();
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as PackageJson;
const output = join(root, "dist", "release");
await mkdir(output, { recursive: true });
await writeFile(join(output, "LICENSE"), await readFile(join(root, "LICENSE")));

async function filesUnder(path: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(path)).sort()) {
    const child = join(path, name);
    const info = await lstat(child);
    if (info.isSymbolicLink()) throw new Error(`release artifact tree contains a symlink: ${child}`);
    if (info.isDirectory()) out.push(...await filesUnder(child));
    else if (info.isFile()) out.push(child);
    else throw new Error(`release artifact tree contains an unsupported file type: ${child}`);
  }
  return out;
}

const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as PackageLock;
const dependencies = [...new Map(Object.entries(lock.packages).filter(([path]) => path.includes("node_modules/")).map(([path, entry]) => {
  const name = path.split("node_modules/").at(-1)!;
  if (!entry.version || !entry.license) throw new Error(`lockfile license metadata is incomplete for ${name}`);
  const component = { name, version: entry.version, license: entry.license, scope: entry.optional ? "optional" : entry.dev ? "development" : "required" };
  return [`${name}@${entry.version}`, component] as const;
})).values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
const npmPurl = (name: string, version: string) => {
  const path = name.startsWith("@") ? `${encodeURIComponent(name.split("/")[0]!)}/${encodeURIComponent(name.split("/")[1]!)}` : encodeURIComponent(name);
  return `pkg:npm/${path}@${version}`;
};
await writeFile(join(output, "third-party-licenses.json"), JSON.stringify({ version: 1, dependencies }, null, 2) + "\n");
await writeFile(join(output, "NOTICE"), `Pi Together\nCopyright (c) 2026 Tim Xu\nLicensed under MIT; see LICENSE.\n\nThird-party components:\n${dependencies.map((dependency) => `- ${dependency.name} ${dependency.version} (${dependency.license})`).join("\n")}\n`);
await writeFile(join(output, "sbom.cdx.json"), `${JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${createHash("sha256").update(`${pkg.name}@${pkg.version}`).digest("hex").replace(/^(........)(....)(....)(....)(............).*/, "$1-$2-$3-$4-$5")}`,
  version: 1,
  metadata: { component: { type: "application", name: pkg.name, version: pkg.version, licenses: [{ expression: pkg.license }] } },
  components: dependencies.map((dependency) => ({ type: "library", name: dependency.name, version: dependency.version, scope: dependency.scope, licenses: [{ expression: dependency.license }], purl: npmPurl(dependency.name, dependency.version) })),
}, null, 2)}\n`);

const roots = [
  "dist/client",
  "dist/server/index.js",
  "dist/extension",
  "dist/cli/pi-together.js",
  "dist/privileged/apply.js",
  "dist/release/LICENSE",
  "dist/release/third-party-licenses.json",
  "dist/release/NOTICE",
  "dist/release/sbom.cdx.json",
];
const artifactPaths: string[] = [];
for (const candidate of roots) {
  const absolute = join(root, candidate);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`release root has an unsafe type: ${candidate}`);
  artifactPaths.push(...(info.isDirectory() ? await filesUnder(absolute) : [absolute]));
}
const artifacts = await Promise.all(artifactPaths.sort().map(async (absolute) => {
  const data = await readFile(absolute);
  return {
    path: relative(root, absolute).replaceAll("\\", "/"),
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}));


const manifest = {
  schemaVersion: 1,
  package: { name: pkg.name, version: pkg.version, license: pkg.license },
  runtime: { node: pkg.engines.node, pi: pkg.piCompatibility },
  supportedTargets: ["linux-x64"],
  experimentalTargets: ["linux-arm64"],
  privilegedHelpers: {
    status: "bundled-system-node18-narrow-apply",
    selections: { "linux-x64": "dist/privileged/apply.js", "linux-arm64": "dist/privileged/apply.js" },
  },
  signatures: { status: "unsigned-private-build", detachedFormat: "not-selected" },
  artifacts,
};
await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(
  join(output, "SHA256SUMS"),
  artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n") + "\n",
);
process.stdout.write(`built release metadata for ${artifacts.length} artifact(s)\n`);

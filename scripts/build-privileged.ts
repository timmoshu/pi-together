import { chmod, readFile } from "node:fs/promises";
import { build } from "esbuild";

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };

await build({
  entryPoints: ["privileged/main.ts"],
  outfile: "dist/privileged/apply.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  define: { __PI_TOGETHER_VERSION__: JSON.stringify(packageJson.version) },
  legalComments: "none",
  logLevel: "info",
});
await chmod("dist/privileged/apply.js", 0o755);
process.stdout.write("built dist/privileged/apply.js\n");

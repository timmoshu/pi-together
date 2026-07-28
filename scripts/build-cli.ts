import { chmod } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["cli/main.ts"],
  outfile: "dist/cli/pi-together.js",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  logLevel: "info",
});
await chmod("dist/cli/pi-together.js", 0o755);
process.stdout.write("built dist/cli/pi-together.js\n");

import { chmod } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["extension/pi-together-attribution.ts"],
  outfile: "dist/extension/pi-together-attribution-v1.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  logLevel: "info",
});

await build({
  entryPoints: ["extension/git-launcher.ts"],
  outfile: "dist/extension/git-bin/git",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  logLevel: "info",
});
await chmod("dist/extension/git-bin/git", 0o755);

process.stdout.write("built attribution extension and managed Git launcher\n");

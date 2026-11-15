// Builds the dashboard into dist/: index.html, app.js and app.css, with no inline script or style,
// so CloudFront can serve it under a Content-Security-Policy of 'self' only.
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// CDK passes its own output directory (the Dashboard stack builds the site at synth).
const dist = process.argv[2] === undefined ? join(root, "dist") : resolve(process.argv[2]);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [join(root, "src/app.ts")],
  outfile: join(dist, "app.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
});
await copyFile(join(root, "src/index.html"), join(dist, "index.html"));
await copyFile(join(root, "src/app.css"), join(dist, "app.css"));

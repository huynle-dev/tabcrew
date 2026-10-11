/**
 * esbuild configuration for ChromeUse v2.
 *
 * Produces a complete unpacked extension in dist/:
 *   dist/manifest.json, dist/service-worker.js, dist/popup/{popup.html,popup.css,popup.js},
 *   dist/offscreen/{offscreen.html,offscreen.js} (the daemon WebSocket),
 *   dist/icons/*.png
 *
 * Usage:
 *   npx tsx esbuild.config.ts          # Build once
 *   npx tsx esbuild.config.ts --watch  # Watch mode
 */

import * as esbuild from "esbuild";
import { readFileSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const isWatch = process.argv.includes("--watch");

const shared: esbuild.BuildOptions = {
  bundle: true,
  target: "chrome120",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  splitting: false,
};

const serviceWorker: esbuild.BuildOptions = {
  ...shared,
  entryPoints: [join(root, "src/service-worker.ts")],
  outfile: join(dist, "service-worker.js"),
};

const popup: esbuild.BuildOptions = {
  ...shared,
  entryPoints: [join(root, "src/popup/popup.ts")],
  outfile: join(dist, "popup/popup.js"),
};

const offscreen: esbuild.BuildOptions = {
  ...shared,
  entryPoints: [join(root, "src/offscreen/offscreen.ts")],
  outfile: join(dist, "offscreen/offscreen.js"),
  // Offscreen documents only expose chrome.runtime messaging (no getManifest), so inline the version.
  define: { __EXTENSION_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version) },
};

const entries = [serviceWorker, popup, offscreen];

const staticFiles: [string, string][] = [
  ["manifest.json", "manifest.json"],
  ["src/popup/popup.html", "popup/popup.html"],
  ["src/popup/popup.css", "popup/popup.css"],
  ["src/offscreen/offscreen.html", "offscreen/offscreen.html"],
  ["assets/icon-16.png", "icons/icon-16.png"],
  ["assets/icon-48.png", "icons/icon-48.png"],
  ["assets/icon-128.png", "icons/icon-128.png"],
];

function copyStatic(): void {
  for (const [from, to] of staticFiles) {
    const dest = join(dist, to);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(root, from), dest);
  }
}

async function build(): Promise<void> {
  if (isWatch) {
    const contexts = await Promise.all(entries.map((entry) => esbuild.context(entry)));
    copyStatic();
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[esbuild] Watching for changes...");
    return;
  }
  rmSync(dist, { recursive: true, force: true });
  await Promise.all(entries.map((entry) => esbuild.build(entry)));
  copyStatic();
  console.log("[esbuild] Build complete: dist/ is a loadable unpacked extension.");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});

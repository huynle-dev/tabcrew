/**
 * esbuild configuration for the TabCrew extension.
 *
 * Development build (default) → dist/, a complete unpacked extension whose manifest carries the
 * public `key` from dev-key.pub, so its ID is fixed (TABCREW_EXTENSION_IDS.dev) and the pairing host
 * accepts it. Store build (--store) → dist-store/ plus tabcrew-extension-<version>.zip, without
 * `key` and without source maps (the Chrome Web Store assigns the ID).
 *
 * Layout:
 *   dist/manifest.json, dist/service-worker.js, dist/popup/{popup.html,popup.css,popup.js},
 *   dist/offscreen/{offscreen.html,offscreen.js} (the daemon WebSocket),
 *   dist/icons/*.png
 *
 * Usage:
 *   npx tsx esbuild.config.ts          # Build once (dev)
 *   npx tsx esbuild.config.ts --watch  # Watch mode (dev)
 *   npx tsx esbuild.config.ts --store  # Chrome Web Store package
 */

import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./src/build/manifest.js";

const root = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes("--watch");
const isStore = process.argv.includes("--store");
const dist = join(root, isStore ? "dist-store" : "dist");
const sourceManifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
const devKey = readFileSync(join(root, "dev-key.pub"), "utf8").trim();

const shared: esbuild.BuildOptions = {
  bundle: true,
  target: "chrome120",
  format: "esm",
  sourcemap: !isStore,
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
  define: { __EXTENSION_VERSION__: JSON.stringify(sourceManifest.version) },
};

const entries = [serviceWorker, popup, offscreen];

const staticFiles: [string, string][] = [
  ["src/popup/popup.html", "popup/popup.html"],
  ["src/popup/popup.css", "popup/popup.css"],
  ["src/offscreen/offscreen.html", "offscreen/offscreen.html"],
  ["assets/icon-16.png", "icons/icon-16.png"],
  ["assets/icon-32.png", "icons/icon-32.png"],
  ["assets/icon-48.png", "icons/icon-48.png"],
  ["assets/icon-128.png", "icons/icon-128.png"],
];

function copyStatic(): void {
  for (const [from, to] of staticFiles) {
    const dest = join(dist, to);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(root, from), dest);
  }
  const manifest = buildManifest(sourceManifest, isStore ? { kind: "store" } : { kind: "dev", key: devKey });
  writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function zipStore(): string {
  const zip = join(root, `tabcrew-extension-${String(sourceManifest.version)}.zip`);
  rmSync(zip, { force: true });
  execFileSync("zip", ["-qrX", zip, ".", "-x", "*.map", "*.DS_Store"], { cwd: dist });
  return zip;
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
  if (isStore) {
    console.log(`[esbuild] Store build complete: dist-store/ and ${zipStore()} (no "key"; the store assigns the ID).`);
  } else {
    console.log("[esbuild] Build complete: dist/ is a loadable unpacked extension (fixed dev ID).");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});

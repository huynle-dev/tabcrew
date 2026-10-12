// Bundles the `tabcrew` CLI, the daemon and the pairing host into self-contained ESM files
// (every JS dependency inlined), so the installed runtime never needs node_modules.
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const repo = join(root, "..");
// TABCREW_BUILD_OUT lets tests bundle into a temp directory.
const dist = process.env.TABCREW_BUILD_OUT || join(root, "dist");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const entries = {
  "cli.mjs": "daemon/src/cli/bin.ts",
  "daemon.mjs": "daemon/src/daemon-main.ts",
  "pair-host.mjs": "daemon/src/pair/main.ts",
};

rmSync(dist, { recursive: true, force: true });
await Promise.all(
  Object.entries(entries).map(([out, entry]) =>
    esbuild.build({
      entryPoints: [join(repo, entry)],
      outfile: join(dist, out),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      // jsonc-parser's "main" is a UMD build with dynamic requires; its "module" build bundles cleanly.
      mainFields: ["module", "main"],
      legalComments: "none",
      logLevel: "warning",
      // Bundled CommonJS dependencies (ws, ...) call require() for node built-ins.
      banner: {
        js: "#!/usr/bin/env node\nimport { createRequire as __tabcrewCreateRequire } from 'node:module';\nconst require = __tabcrewCreateRequire(import.meta.url);",
      },
      define: { __TABCREW_VERSION__: JSON.stringify(version) },
      alias: {
        "@tabcrew/shared/v2": join(repo, "shared/src/v2.ts"),
        "@tabcrew/shared/product": join(repo, "shared/src/product.ts"),
        "@tabcrew/shared": join(repo, "shared/src/index.ts"),
      },
      // Optional native speedups of ws; it falls back to JS when they are missing.
      external: ["bufferutil", "utf-8-validate"],
    }),
  ),
);
for (const out of Object.keys(entries)) chmodSync(join(dist, out), 0o755);
console.log(`[tabcrew] built ${Object.keys(entries).join(", ")} (v${version}) in ${dist}`);

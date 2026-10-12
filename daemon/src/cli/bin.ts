import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cliMain } from "./main.js";
import { realSystem } from "./system.js";

// Entry point of the published `tabcrew` command (cli/dist/cli.mjs); daemon.mjs and pair-host.mjs sit next to it.
const runtimeDir = dirname(fileURLToPath(import.meta.url));

cliMain(process.argv.slice(2), realSystem(runtimeDir)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`tabcrew: ${(err as Error).message}\n`);
    process.exitCode = 1;
  },
);

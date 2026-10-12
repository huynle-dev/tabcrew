import { homedir } from "node:os";
import { runPairHost } from "./host.js";

// Entry point of pair-host.mjs (launched by Chrome through ~/.tabcrew/app/pair-host).
runPairHost(
  { stdin: process.stdin, stdout: process.stdout },
  { argv: process.argv.slice(2), env: process.env, homedir: homedir() },
).then(
  () => process.exit(0),
  () => process.exit(1),
);

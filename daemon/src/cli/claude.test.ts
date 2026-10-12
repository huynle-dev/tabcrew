import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempHome } from "../testing/helpers.js";
import { claudeAddArgs, ensureClaudeServer, removeClaudeServer } from "./claude.js";
import { realRunner, type System } from "./system.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

const TOKEN = "c".repeat(43);

/** A fake `claude` executable: logs its arguments and keeps registered servers as marker files. */
function fakeClaude(dir: string, opts: { failAdd?: boolean } = {}): { bin: string; log: string } {
  const bin = join(dir, "claude");
  const log = join(dir, "claude.log");
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$2" in
  get) [ -f '${dir}/server-'"$3" ] && { echo "$3: http"; exit 0; }; echo "No MCP server found with name: $3" >&2; exit 1 ;;
  add) ${opts.failAdd ? `echo "add failed for header \${10}" >&2; exit 1 ;;` : `touch '${dir}/server-'"$7"; exit 0 ;;`}
  remove) [ -f '${dir}/server-'"$5" ] && rm '${dir}/server-'"$5" && exit 0; exit 1 ;;
esac
exit 2
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

function sysWithRealRunner(): System {
  return { run: realRunner } as unknown as System;
}

describe("Claude Code registration", () => {
  it("adds tabcrew once with the http transport, user scope and bearer header", async () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const { bin, log } = fakeClaude(t.home);
    const sys = sysWithRealRunner();
    expect(await ensureClaudeServer(sys, bin, "http://127.0.0.1:8770/mcp", TOKEN)).toEqual({ status: "added" });
    expect(await ensureClaudeServer(sys, bin, "http://127.0.0.1:8770/mcp", TOKEN)).toEqual({ status: "present" });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "mcp get tabcrew",
      `mcp add --transport http --scope user tabcrew http://127.0.0.1:8770/mcp --header Authorization: Bearer ${TOKEN}`,
      "mcp get tabcrew",
    ]);
    expect(await removeClaudeServer(sys, bin)).toBe(true);
    expect(await removeClaudeServer(sys, bin)).toBe(false);
  });

  it("reports failures without the token", async () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const { bin } = fakeClaude(t.home, { failAdd: true });
    const result = await ensureClaudeServer(sysWithRealRunner(), bin, "http://127.0.0.1:8770/mcp", TOKEN);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).toContain("<token>");
  });

  it("puts the variadic --header after the name and URL", () => {
    const args = claudeAddArgs("http://u/mcp", TOKEN);
    expect(args.indexOf("tabcrew")).toBeLessThan(args.indexOf("--header"));
    expect(args.indexOf("http://u/mcp")).toBeLessThan(args.indexOf("--header"));
  });
});

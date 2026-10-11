#!/usr/bin/env node
// Live smoke test against a running daemon + extension-v2. No model calls.
// Usage: node daemon/scripts/smoke.mjs [--keep-open] [--out DIR]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const home = process.env.CHROMEUSE_HOME ?? join(homedir(), ".chromeuse");
const port = process.env.CHROMEUSE_MCP_PORT ?? "8770";
const keepOpen = process.argv.includes("--keep-open");
const outIdx = process.argv.indexOf("--out");
const out = outIdx > 0 ? process.argv[outIdx + 1] : null;
const token = readFileSync(join(home, "token"), "utf8").trim();

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "chromeuse-smoke", version: "0.0.0" });
await client.connect(transport);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { error: r.isError ? json : null, json, raw: r };
}

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));

// Two agents share this ONE MCP connection; isolation comes from session handles.
const a = (await call("session_open", { label: "smoke-A" })).json;
const b = (await call("session_open", { label: "smoke-B" })).json;
check("two sessions opened", Boolean(a?.session && b?.session && a.session !== b.session), `${a?.short_id}, ${b?.short_id}`);

const t0 = Date.now();
const [ta, tb] = await Promise.all([
  call("tab_create", { session: a.session, url: "https://example.com/" }),
  call("tab_create", { session: b.session, url: "https://en.wikipedia.org/wiki/Main_Page" }),
]);
check("each session created its own tab in parallel", !ta.error && !tb.error, `${Date.now() - t0} ms; A=${ta.json?.tab_id} B=${tb.json?.tab_id}`);
if (ta.error || tb.error) {
  console.log(`stopping: tab_create failed (${ta.error?.code ?? ""} ${tb.error?.code ?? ""}); is the extension connected?`);
  for (const s of [a, b]) await call("session_close", { session: s.session });
  await client.close();
  process.exit(1);
}
const tabA = ta.json.tab_id, tabB = tb.json.tab_id;

const la = (await call("tab_list", { session: a.session })).json?.tabs?.map((t) => t.tab_id) ?? [];
const lb = (await call("tab_list", { session: b.session })).json?.tabs?.map((t) => t.tab_id) ?? [];
check("tab_list is scoped to each session", la.includes(tabA) && !la.includes(tabB) && lb.includes(tabB) && !lb.includes(tabA), `A sees ${la}, B sees ${lb}`);

const cross = await call("screenshot", { session: b.session, tab_id: tabA });
check("B cannot screenshot A's tab", cross.error?.code === "tab_not_owned", cross.error?.code);
const crossClose = await call("tab_close", { session: a.session, tab_id: tabB });
check("A cannot close B's tab", crossClose.error?.code === "tab_not_owned", crossClose.error?.code);
const bad = await call("tab_list", { session: "s_not-a-real-session-handle" });
check("unknown session handle rejected", bad.error?.code === "bad_session", bad.error?.code);

await new Promise((r) => setTimeout(r, 1500)); // let pages paint
const t1 = Date.now();
const [sa, sb] = await Promise.all([
  call("screenshot", { session: a.session, tab_id: tabA }),
  call("screenshot", { session: b.session, tab_id: tabB }),
]);
const imgA = sa.raw.content.find((c) => c.type === "image");
const imgB = sb.raw.content.find((c) => c.type === "image");
check("both background tabs screenshot in parallel", Boolean(imgA && imgB), `${Date.now() - t1} ms; ${sa.error?.code ?? ""}${sb.error?.code ?? ""}`);
if (out && imgA && imgB) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "A.jpg"), Buffer.from(imgA.data, "base64"));
  writeFileSync(join(out, "B.jpg"), Buffer.from(imgB.data, "base64"));
  console.log(`screenshots saved to ${out}/A.jpg and ${out}/B.jpg`);
}

if (!keepOpen) {
  const ca = (await call("session_close", { session: a.session })).json;
  const cb = (await call("session_close", { session: b.session })).json;
  check("sessions closed with their tabs", ca?.closed_tabs >= 1 && cb?.closed_tabs >= 1, `A closed ${ca?.closed_tabs}, B closed ${cb?.closed_tabs}`);
  const after = await call("tab_list", { session: a.session });
  check("closed session handle no longer works", after.error?.code === "bad_session", after.error?.code);
}

await client.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nALL ${results.length} CHECKS PASSED`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Live: three sessions run tab_list, observe, and observe+act(WAIT) concurrently; prints median/max latency. No model calls.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token = readFileSync(`${homedir()}/.chromeuse/token`, "utf8").trim();
const c = new Client({ name: "phase", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8770/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const j = async (n, a) => { const r = await c.callTool({ name: n, arguments: a }); return JSON.parse(r.content.find(x => x.type === "text").text); };
const S = [];
for (const l of ["p1", "p2", "p3"]) { const s = (await j("session_open", { label: l })).session; const t = (await j("tab_create", { session: s, url: "https://example.com/?" + l })).tab_id; S.push({ s, t }); }
await new Promise(r => setTimeout(r, 3000));
const phase = async (name, fn) => {
  const t0 = performance.now(); const per = [];
  await Promise.all(S.map(async (x) => { for (let i = 0; i < 8; i++) { const a = performance.now(); await fn(x); per.push(performance.now() - a); } }));
  per.sort((a, b) => a - b);
  console.log(`${name.padEnd(28)} wall ${Math.round(performance.now() - t0)} ms, median ${Math.round(per[per.length >> 1])} ms, max ${Math.round(per.at(-1))} ms`);
  await new Promise(r => setTimeout(r, 500));
};
await phase("tab_list only (no debugger)", (x) => j("tab_list", { session: x.s }));
await phase("observe only (snapshot)", (x) => j("observe", { session: x.s, tab_id: x.t }));
await phase("observe + act(WAIT)", async (x) => { const o = await j("observe", { session: x.s, tab_id: x.t }); await j("act", { session: x.s, tab_id: x.t, fingerprint: o.fingerprint, operation: "WAIT" }); });
// session_close hands remaining tabs to the user; close ours first so nothing is left behind.
for (const x of S) {
  for (const t of (await j("tab_list", { session: x.s })).tabs ?? []) await j("tab_close", { session: x.s, tab_id: t.tab_id });
  await j("session_close", { session: x.s });
}
await c.close();

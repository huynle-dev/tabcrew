import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token = readFileSync(`${homedir()}/.chromeuse/token`, "utf8").trim();
const c = new Client({ name: "hold", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8770/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const call = async (name, args) => { const t = Date.now(); const r = await c.callTool({ name, arguments: args }); const txt = r.content.find(x => x.type === "text")?.text; return { ms: Date.now() - t, j: (() => { try { return JSON.parse(txt) } catch { return null } })() }; };
const s = (await call("session_open", { label: "hold" })).j.session;
const A = (await call("tab_create", { session: s, url: "https://example.com/?hold=A" })).j.tab_id;
const B = (await call("tab_create", { session: s, url: "https://example.com/?hold=B" })).j.tab_id;
await new Promise(r => setTimeout(r, 3000));
const obs = [];
for (let k = 0; k < 6; k++) obs.push((await call("observe", { session: s, tab_id: A })).ms);
console.log("via MCP+extension, observe A:", obs.join(","), "ms");
writeFileSync(process.env.TMPDIR_OC + "/hold.json", JSON.stringify({ s }));
if (process.argv[2] === "close") { await call("session_close", { session: s }); }
await c.close();

/**
 * Add/update/remove the TabCrew MCP entry in OpenCode's global config, editing JSONC in place so
 * comments and formatting survive. Handles both layouts:
 *   - V2: `mcp.servers.<name>` (timeout is an object: catalog/execution)
 *   - V1: `mcp.<name>` (timeout is a number)
 * A file without `mcp` gets the V1 layout, which both OpenCode versions read.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type Edit, type Node, type ParseError } from "jsonc-parser";
import type { System } from "./system.js";

export const SERVER_NAME = "tabcrew";
export const LEGACY_SERVER_NAME = "chromeuse";

type Json = Record<string, unknown>;

export function opencodeConfigPath(sys: Pick<System, "env" | "homedir">): string | null {
  const base = sys.env.XDG_CONFIG_HOME?.trim() || join(sys.homedir, ".config");
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const path = join(base, "opencode", name);
    if (existsSync(path)) return path;
  }
  return null;
}

/** `{file:~/.tabcrew/token}` for the default home, else the absolute token path. */
export function tokenFileRef(home: string, homedir: string): string {
  const path = join(home, "token");
  const tilde = path.startsWith(`${homedir}/`) ? `~${path.slice(homedir.length)}` : path;
  return `{file:${tilde}}`;
}

export interface OpencodeState {
  readonly layout: "servers" | "flat";
  /** JSON path of the object holding server entries. */
  readonly base: readonly string[];
  readonly entry: Json | null;
  readonly legacy: Json | null;
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseJsonc(text: string): Json {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !isObject(value)) throw new Error("could not parse the OpenCode config (invalid JSONC)");
  return value;
}

export function inspectOpencode(text: string): OpencodeState {
  const root = parseJsonc(text);
  const mcp = root.mcp;
  const servers = isObject(mcp) && isObject(mcp.servers) ? mcp.servers : null;
  const container: Json = servers ?? (isObject(mcp) ? mcp : {});
  const entry = isObject(container[SERVER_NAME]) ? (container[SERVER_NAME] as Json) : null;
  const legacy = isObject(container[LEGACY_SERVER_NAME]) ? (container[LEGACY_SERVER_NAME] as Json) : null;
  return {
    layout: servers ? "servers" : "flat",
    base: servers ? ["mcp", "servers"] : ["mcp"],
    entry,
    legacy,
  };
}

function indentUnit(text: string): string {
  return /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
}

function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? "";
}

/**
 * Lay out an inserted property like its siblings. jsonc-parser's own formatter reformats whole lines
 * around the edit (including a neighbour's compact one-line object), so only our text is formatted here.
 */
function prettyInsert(text: string, path: readonly string[], value: unknown, edit: Edit): Edit {
  const tree = parseTree(text);
  let parentPath = path.slice(0, -1);
  let key = path[path.length - 1];
  let nested: unknown = value;
  while (parentPath.length > 0 && !(tree && findNodeAtLocation(tree, [...parentPath]))) {
    nested = { [key]: nested };
    key = parentPath[parentPath.length - 1];
    parentPath = parentPath.slice(0, -1);
  }
  const parent: Node | undefined = tree && (parentPath.length > 0 ? findNodeAtLocation(tree, [...parentPath]) : tree);
  if (!parent || parent.type !== "object") return edit;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const unit = indentUnit(text);
  const parentIndent = lineIndent(text, parent.offset);
  const first = parent.children?.[0];
  const sameLine = first !== undefined && !text.slice(parent.offset, first.offset).includes("\n");
  const base = first && !sameLine ? lineIndent(text, first.offset) : parentIndent + unit;
  const property = `${JSON.stringify(key)}: ${JSON.stringify(nested, null, unit).split("\n").join(eol + base)}`;
  let content: string;
  if (edit.content.startsWith(",")) content = `,${eol}${base}${property}`;
  else if (edit.content.endsWith(",")) content = `${eol}${base}${property},${/^\s*\n/.test(text.slice(edit.offset)) ? "" : eol + base}`;
  else content = `${eol}${base}${property}${eol}${parentIndent}`;
  return { ...edit, content };
}

function edit(text: string, path: string[], value: unknown): string {
  const edits = modify(text, path, value, {});
  const tree = parseTree(text);
  const exists = Boolean(tree && findNodeAtLocation(tree, path));
  if (exists || value === undefined || typeof value !== "object" || value === null || edits.length !== 1) return applyEdits(text, edits);
  return applyEdits(text, [prettyInsert(text, path, value, edits[0])]);
}

/** Rename the property at `path` to `newKey` and replace its value, keeping its position and comments. */
function replaceProperty(text: string, path: string[], newKey: string, value: unknown): string {
  const tree = parseTree(text);
  const prop = tree ? findNodeAtLocation(tree, path)?.parent : undefined;
  const [keyNode, valueNode] = prop?.children ?? [];
  if (!keyNode || !valueNode) throw new Error(`cannot find ${path.join(".")}`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const pretty = JSON.stringify(value, null, indentUnit(text)).split("\n").join(eol + lineIndent(text, keyNode.offset));
  return applyEdits(text, [
    { offset: keyNode.offset, length: keyNode.length, content: JSON.stringify(newKey) },
    { offset: valueNode.offset, length: valueNode.length, content: pretty },
  ]);
}

export interface EntryOptions {
  readonly url: string;
  readonly tokenRef: string;
}

export function desiredEntry(layout: OpencodeState["layout"], opts: EntryOptions, previous?: Json | null): Json {
  const timeout =
    previous && previous.timeout !== undefined
      ? previous.timeout
      : layout === "servers"
        ? { catalog: 30_000, execution: 600_000 }
        : 600_000;
  // Keep the previous entry's other settings (disabled, codemode, ...) and its key order.
  const entry: Json = { ...(previous ?? {}) };
  entry.type = "remote";
  entry.url = opts.url;
  entry.headers = { ...(isObject(previous?.headers) ? previous.headers : {}), Authorization: `Bearer ${opts.tokenRef}` };
  entry.oauth = false;
  entry.timeout = timeout;
  if (layout === "flat" && !previous) entry.enabled = true;
  return entry;
}

export type OpencodeChange = "added" | "updated" | "replaced_legacy" | "rewrote_legacy" | "unchanged";

/**
 * Ensure the `tabcrew` entry. `legacy` decides what happens to an existing `chromeuse` entry:
 * "replace" removes it and puts `tabcrew` where it was; "rewrite" keeps it but points its token at the
 * new home (and adds no second entry).
 */
export function upsertOpencode(text: string, opts: EntryOptions, legacy: "replace" | "rewrite"): { text: string; change: OpencodeChange } {
  const state = inspectOpencode(text);
  const header = `Bearer ${opts.tokenRef}`;
  if (state.entry) {
    let next = text;
    const p = [...state.base, SERVER_NAME];
    if (state.entry.url !== opts.url) next = edit(next, [...p, "url"], opts.url);
    const headers = isObject(state.entry.headers) ? state.entry.headers : null;
    if (!headers || headers.Authorization !== header) next = edit(next, [...p, "headers", "Authorization"], header);
    if (state.entry.oauth !== false) next = edit(next, [...p, "oauth"], false);
    return { text: next, change: next === text ? "unchanged" : "updated" };
  }
  if (state.legacy && legacy === "rewrite") {
    const headers = isObject(state.legacy.headers) ? state.legacy.headers : null;
    if (headers && headers.Authorization === header) return { text, change: "unchanged" };
    const next = edit(text, [...state.base, LEGACY_SERVER_NAME, "headers", "Authorization"], header);
    return { text: next, change: "rewrote_legacy" };
  }
  if (state.legacy) {
    const next = replaceProperty(text, [...state.base, LEGACY_SERVER_NAME], SERVER_NAME, desiredEntry(state.layout, opts, state.legacy));
    return { text: next, change: "replaced_legacy" };
  }
  return { text: edit(text, [...state.base, SERVER_NAME], desiredEntry(state.layout, opts)), change: "added" };
}

export function removeOpencodeEntry(text: string): { text: string; removed: boolean } {
  const state = inspectOpencode(text);
  if (!state.entry) return { text, removed: false };
  return { text: edit(text, [...state.base, SERVER_NAME], undefined), removed: true };
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function writeText(path: string, text: string): void {
  writeFileSync(path, text);
}

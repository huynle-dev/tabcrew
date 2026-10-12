import { V2_EXTENSION_PORT } from "@chromeuse/shared/v2";
import {
  PORT_KEY,
  TOKEN_KEY,
  parsePort,
  type BridgeStatus,
  type PopupActionResult,
  type PopupCloseResult,
  type PopupRequest,
  type PopupState,
  type PopupStopResult,
} from "../config.js";
import { finishedRows, sessionRows } from "./view.js";

const STATUS_TEXT: Record<BridgeStatus, string> = {
  connected: "connected",
  connecting: "connecting",
  needs_token: "needs token",
  unauthorized: "unauthorized: check token",
  offline: "offline",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function button(text: string, onClick: () => void, opts: { title?: string; className?: string } = {}): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  if (opts.title) b.title = opts.title;
  if (opts.className) b.className = opts.className;
  b.addEventListener("click", onClick);
  return b;
}

function plural(n: number): string {
  return `${n} tab${n === 1 ? "" : "s"}`;
}

function send<T>(msg: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

async function refresh(): Promise<void> {
  const state = await send<PopupState>({ type: "v2:get_state" }).catch(() => null);
  if (!state) return;
  const status = $("status");
  status.textContent = STATUS_TEXT[state.status];
  status.className = `status ${state.status}`;
  $<HTMLParagraphElement>("token-note").textContent = state.token_set ? "Token saved." : "No token saved.";
  const port = $<HTMLInputElement>("port");
  if (document.activeElement !== port) port.value = String(state.port);

  const list = $<HTMLUListElement>("sessions");
  list.replaceChildren();
  if (state.sessions.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No active sessions";
    li.className = "meta";
    list.append(li);
  }
  for (const row of sessionRows(state.sessions)) {
    const li = document.createElement("li");
    if (row.stopped) li.className = "stopped";
    const name = document.createElement("span");
    name.textContent = row.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = ` ${row.meta}`;
    name.append(meta);
    li.append(name);
    const actions = document.createElement("span");
    actions.className = "actions";
    actions.append(button("Show", () => void showSession(row.short_id), { title: "Bring this session's window to the front" }));
    if (row.action === "stop") {
      actions.append(button("Stop", () => void stopSession(row.short_id), { className: "danger" }));
    } else if (row.action === "close_tabs") {
      actions.append(button("Close tabs", () => void closeStoppedTabs(row.short_id), { title: "Close this stopped session's tabs" }));
    }
    li.append(actions);
    list.append(li);
  }

  const finished = finishedRows(state.finished ?? []);
  $("finished-section").hidden = finished.length === 0;
  const flist = $<HTMLUListElement>("finished");
  flist.replaceChildren();
  for (const row of finished) {
    const li = document.createElement("li");
    li.className = "finished";
    const name = document.createElement("span");
    name.textContent = row.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = ` ${row.meta}`;
    name.append(meta);
    const actions = document.createElement("span");
    actions.className = "actions";
    actions.append(
      button("Open", () => void openFinished(row.group_id), { title: "Expand this group and switch to it" }),
      button("Close", () => void closeFinished(row.group_id), { title: "Close this finished session's tabs" }),
    );
    li.append(name, actions);
    flist.append(li);
  }
}

async function showSession(shortId: string): Promise<void> {
  const result = await send<PopupActionResult>({ type: "v2:show_session", short_id: shortId }).catch(
    (): PopupActionResult => ({ ok: false, error: "extension not responding" }),
  );
  if (!result.ok) $<HTMLParagraphElement>("stop-note").textContent = `Show failed: ${result.error}`;
}

async function openFinished(groupId: number): Promise<void> {
  const result = await send<PopupActionResult>({ type: "v2:open_finished", group_id: groupId }).catch(
    (): PopupActionResult => ({ ok: false, error: "extension not responding" }),
  );
  if (!result.ok) $<HTMLParagraphElement>("finished-note").textContent = `Open failed: ${result.error}`;
  void refresh();
}

async function closeFinished(groupId: number | null): Promise<void> {
  const msg: PopupRequest = groupId === null ? { type: "v2:close_all_finished" } : { type: "v2:close_finished", group_id: groupId };
  const result = await send<PopupCloseResult>(msg).catch(
    (): PopupCloseResult => ({ ok: false, error: "extension not responding" }),
  );
  $<HTMLParagraphElement>("finished-note").textContent = result.ok
    ? `Closed ${plural(result.closed_tabs)}.`
    : `Close failed: ${result.error}`;
  void refresh();
}

async function stopSession(shortId: string | null): Promise<void> {
  const result = await send<PopupStopResult>({ type: "v2:stop", short_id: shortId }).catch(
    (): PopupStopResult => ({ ok: false, error: "extension not responding" }),
  );
  $<HTMLParagraphElement>("stop-note").textContent = result.ok
    ? shortId
      ? `Stop sent for ${shortId}.`
      : "Stop sent for all sessions."
    : `Stop failed: ${result.error}`;
  void refresh();
}

async function closeStoppedTabs(shortId: string): Promise<void> {
  const result = await send<PopupCloseResult>({ type: "v2:close_session_tabs", short_id: shortId }).catch(
    (): PopupCloseResult => ({ ok: false, error: "extension not responding" }),
  );
  $<HTMLParagraphElement>("stop-note").textContent = result.ok
    ? `Closed ${plural(result.closed_tabs)} of ${shortId}.`
    : `Close failed: ${result.error}`;
  void refresh();
}

$<HTMLInputElement>("token").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("save-token").click();
});

$("save-token").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("token");
  const token = input.value.trim();
  if (!token) return;
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
  input.value = "";
  $<HTMLParagraphElement>("token-note").textContent = "Token saved.";
  setTimeout(() => void refresh(), 300);
});

$("save-port").addEventListener("click", async () => {
  const raw = $<HTMLInputElement>("port").value;
  const port = parsePort(raw);
  if (port === V2_EXTENSION_PORT && String(raw).trim() !== String(V2_EXTENSION_PORT)) {
    await chrome.storage.local.remove(PORT_KEY);
  } else {
    await chrome.storage.local.set({ [PORT_KEY]: port });
  }
  setTimeout(() => void refresh(), 300);
});

$("stop-all").addEventListener("click", () => void stopSession(null));
$("close-all-finished").addEventListener("click", () => void closeFinished(null));

void refresh();
setInterval(() => void refresh(), 1500);

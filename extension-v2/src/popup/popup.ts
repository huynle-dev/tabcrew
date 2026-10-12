import { V2_EXTENSION_PORT } from "@chromeuse/shared/v2";
import {
  PORT_KEY,
  TOKEN_KEY,
  parsePort,
  type BridgeStatus,
  type PopupCloseResult,
  type PopupRequest,
  type PopupState,
  type PopupStopResult,
} from "../config.js";
import { sessionRows } from "./view.js";

const STATUS_TEXT: Record<BridgeStatus, string> = {
  connected: "connected",
  connecting: "connecting",
  needs_token: "needs token",
  unauthorized: "unauthorized: check token",
  offline: "offline",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

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
    if (row.action === "stop") {
      const stop = document.createElement("button");
      stop.textContent = "Stop";
      stop.className = "danger";
      stop.addEventListener("click", () => void stopSession(row.short_id));
      li.append(stop);
    } else if (row.action === "close_tabs") {
      const close = document.createElement("button");
      close.textContent = "Close tabs";
      close.title = "Close this stopped session's tabs";
      close.addEventListener("click", () => void closeStoppedTabs(row.short_id));
      li.append(close);
    }
    list.append(li);
  }
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
    ? `Closed ${result.closed_tabs} tab${result.closed_tabs === 1 ? "" : "s"} of ${shortId}.`
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

void refresh();
setInterval(() => void refresh(), 1500);

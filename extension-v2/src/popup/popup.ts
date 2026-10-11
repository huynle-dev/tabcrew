import { V2_EXTENSION_PORT } from "@chromeuse/shared/v2";
import {
  PORT_KEY,
  TOKEN_KEY,
  parsePort,
  type BridgeStatus,
  type PopupRequest,
  type PopupState,
  type PopupStopResult,
} from "../config.js";

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
  for (const s of state.sessions) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${s.label} · ${s.short_id}`;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = ` ${s.tab_count} tab${s.tab_count === 1 ? "" : "s"}`;
    name.append(meta);
    const stop = document.createElement("button");
    stop.textContent = "Stop";
    stop.className = "danger";
    stop.addEventListener("click", () => void stopSession(s.short_id));
    li.append(name, stop);
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
}

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

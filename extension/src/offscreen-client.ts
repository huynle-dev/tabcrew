/**
 * Keeps the single offscreen document (the daemon socket's home) alive.
 * Concurrent callers share one in-flight check-and-create, so `createDocument` runs at most once.
 */

export const OFFSCREEN_PATH = "offscreen/offscreen.html";
const JUSTIFICATION = "Maintain the local WebSocket connection to the TabCrew daemon";

let inflight: Promise<void> | null = null;

export function ensureOffscreenDocument(): Promise<void> {
  inflight ??= createIfMissing().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function createIfMissing(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length > 0) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: JUSTIFICATION,
    });
  } catch (err) {
    // Lost a race with a document created outside this worker's lifetime: that one serves.
    if (/single offscreen document/i.test(err instanceof Error ? err.message : String(err))) return;
    throw err;
  }
}

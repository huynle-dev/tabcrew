import type { V2Error, V2ErrorCode } from "@chromeuse/shared/v2";

/** An operation failure with a typed code that is sent back to the daemon as-is. */
export class OpError extends Error {
  constructor(
    readonly code: V2ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpError";
  }
}

/** Convert anything thrown by an op handler into a one-line wire error (never a stack). */
export function toWireError(err: unknown): V2Error {
  if (err instanceof OpError) return { code: err.code, message: err.message };
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split("\n")[0]?.slice(0, 300) || "unknown error";
  return { code: "internal", message: line };
}

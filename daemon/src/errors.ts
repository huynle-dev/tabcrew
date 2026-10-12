import { V2_ERROR_CODES, type V2Error, type V2ErrorCode } from "@tabcrew/shared/v2";

/** A typed, agent-facing error. `message` is a one-line hint, never a stack trace. */
export class DaemonError extends Error implements V2Error {
  readonly code: V2ErrorCode;

  constructor(code: V2ErrorCode, message: string) {
    super(message);
    this.name = "DaemonError";
    this.code = code;
  }

  toJSON(): V2Error {
    return { code: this.code, message: this.message };
  }
}

export function isErrorCode(value: unknown): value is V2ErrorCode {
  return typeof value === "string" && (V2_ERROR_CODES as readonly string[]).includes(value);
}

function oneLine(text: string, max = 300): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Normalise anything thrown into a V2Error safe to show an agent. */
export function toV2Error(err: unknown): V2Error {
  if (err instanceof DaemonError) return { code: err.code, message: oneLine(err.message) };
  return { code: "internal", message: "internal daemon error" };
}

/** Normalise an error object received from the extension. */
export function fromWireError(value: unknown): DaemonError {
  if (value && typeof value === "object") {
    const { code, message } = value as { code?: unknown; message?: unknown };
    if (isErrorCode(code)) {
      return new DaemonError(code, oneLine(typeof message === "string" && message ? message : code));
    }
  }
  return new DaemonError("internal", "extension returned an invalid error");
}

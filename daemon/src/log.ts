export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (level: LogLevel, message: string) => void;

const stderrSink: LogSink = (level, message) => {
  process.stderr.write(`${new Date().toISOString()} ${level} ${message}\n`);
};

const level = (process.env.TABCREW_LOG || process.env.CHROMEUSE_LOG || "").trim();

let sink: LogSink = level === "silent" ? () => {} : stderrSink;

/** Replace the log sink (tests use this to silence or capture logs). */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? stderrSink;
}

/**
 * One-line logs. Never pass tokens, session handles, page text or typed values here;
 * use a session's short_id to identify it.
 */
const debugEnabled = level === "debug";

export const log = {
  debug: (message: string) => {
    if (debugEnabled) sink("debug", message);
  },
  info: (message: string) => sink("info", message),
  warn: (message: string) => sink("warn", message),
  error: (message: string) => sink("error", message),
};

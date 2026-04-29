import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock CDP manager (hoisted before module imports)
// ---------------------------------------------------------------------------

const cdpManagerMock = vi.hoisted(() => ({
  isAttached: vi.fn(),
  attach: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock("../cdp.js", () => ({
  cdpManager: cdpManagerMock,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are set up)
// ---------------------------------------------------------------------------

const {
  connect,
  send,
  close,
  getSessionStatus,
  generateSessionId,
  GlkvmTransportError,
} = await import("./kvmHidTransport.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a mock CDP sendCommand response for Runtime.evaluate */
function mockEvalResult(value: Record<string, unknown>) {
  return {
    result: { type: "object", value },
  };
}

/** Build a mock CDP sendCommand response with an exception */
function mockEvalException(text: string) {
  return {
    result: { type: "undefined" },
    exceptionDetails: {
      text,
      exception: { description: text },
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  cdpManagerMock.isAttached.mockReturnValue(true);
  cdpManagerMock.attach.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// generateSessionId
// ---------------------------------------------------------------------------

describe("generateSessionId", () => {
  it("returns a string starting with the session prefix", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^__oc_kvm_/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    // With 8 chars of base-36 randomness, collisions should be extremely rare
    expect(ids.size).toBeGreaterThanOrEqual(95);
  });
});

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe("connect", () => {
  it("establishes a new WebSocket session", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 1 }),
    );

    const session = await connect({ tabId: 42 });

    expect(session.tabId).toBe(42);
    expect(session.sessionId).toMatch(/^__oc_kvm_/);
    expect(session.createdAt).toBeGreaterThan(0);

    // Verify CDP was called with Runtime.evaluate
    expect(cdpManagerMock.sendCommand).toHaveBeenCalledWith(
      42,
      "Runtime.evaluate",
      expect.objectContaining({
        returnByValue: true,
        awaitPromise: true,
      }),
    );
  });

  it("attaches CDP if not already attached", async () => {
    cdpManagerMock.isAttached.mockReturnValue(false);
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 1 }),
    );

    await connect({ tabId: 42 });

    expect(cdpManagerMock.attach).toHaveBeenCalledWith(42);
  });

  it("reuses an existing session when sessionId is provided and WebSocket is open", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 1, sessionId: "__oc_kvm_existing" }),
    );

    const session = await connect({
      tabId: 42,
      sessionId: "__oc_kvm_existing",
    });

    expect(session.sessionId).toBe("__oc_kvm_existing");
    // Only one sendCommand call (the check), no new connection
    expect(cdpManagerMock.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("creates a new session when the existing one is closed", async () => {
    // First call: check existing session — it's closed (readyState=3)
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 3, sessionId: "__oc_kvm_old" }),
    );
    // Second call: create new session
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 1 }),
    );

    const session = await connect({
      tabId: 42,
      sessionId: "__oc_kvm_old",
    });

    // Should have gotten a new session ID, not the old one
    expect(session.sessionId).not.toBe("__oc_kvm_old");
    expect(cdpManagerMock.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("creates a new session when the existing one is not found", async () => {
    // First call: check existing session — not found
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: false, error: "Session not found", errorCode: "PROTOCOL_ERROR" }),
    );
    // Second call: create new session
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 1 }),
    );

    const session = await connect({
      tabId: 42,
      sessionId: "__oc_kvm_gone",
    });

    expect(session.sessionId).not.toBe("__oc_kvm_gone");
    expect(cdpManagerMock.sendCommand).toHaveBeenCalledTimes(2);
  });

  // --- Error cases ---

  it("throws AUTH_FAILED when no token is found", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue(
      mockEvalResult({
        ok: false,
        error: "No GLKVM auth token found in localStorage. Log in to the GLKVM web interface first.",
        errorCode: "AUTH_FAILED",
      }),
    );

    await expect(connect({ tabId: 42 })).rejects.toThrow(GlkvmTransportError);
    await expect(connect({ tabId: 42 })).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("throws AUTH_FAILED when server rejects credentials", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue(
      mockEvalResult({
        ok: false,
        error: "WebSocket authentication rejected (close code 4403). Re-authenticate in the GLKVM web interface.",
        errorCode: "AUTH_FAILED",
      }),
    );

    await expect(connect({ tabId: 42 })).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("throws TAB_NOT_FOUND when CDP attach fails", async () => {
    cdpManagerMock.isAttached.mockReturnValue(false);
    cdpManagerMock.attach.mockRejectedValue(
      new Error("No tab with id: 999"),
    );

    await expect(connect({ tabId: 999 })).rejects.toThrow(GlkvmTransportError);
    await expect(connect({ tabId: 999 })).rejects.toMatchObject({
      code: "TAB_NOT_FOUND",
    });
  });

  it("throws CONNECTION_FAILED when WebSocket cannot connect", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue(
      mockEvalResult({
        ok: false,
        error: "WebSocket connection failed. The GLKVM device may be offline or unreachable.",
        errorCode: "CONNECTION_FAILED",
      }),
    );

    await expect(connect({ tabId: 42 })).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
    });
  });

  it("throws TIMEOUT when connection exceeds timeout", async () => {
    cdpManagerMock.sendCommand.mockResolvedValue(
      mockEvalResult({
        ok: false,
        error: "WebSocket connection timed out after 5000ms",
        errorCode: "TIMEOUT",
      }),
    );

    await expect(connect({ tabId: 42, timeout: 5000 })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("throws EVAL_ERROR when CDP Runtime.evaluate throws an exception", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalException("ReferenceError: foo is not defined"),
    );

    await expect(connect({ tabId: 42 })).rejects.toMatchObject({
      code: "EVAL_ERROR",
    });
  });

  it("throws EVAL_ERROR when no result value is returned", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce({
      result: { type: "undefined" },
    });

    await expect(connect({ tabId: 42 })).rejects.toMatchObject({
      code: "EVAL_ERROR",
    });
  });

  it("passes custom timeout to the connect script", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 1 }),
    );

    await connect({ tabId: 42, timeout: 5000 });

    const callArgs = cdpManagerMock.sendCommand.mock.calls[0];
    const expression = callArgs[2].expression as string;
    expect(expression).toContain("5000");
  });
});

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

describe("send", () => {
  const session = {
    sessionId: "__oc_kvm_test",
    tabId: 42,
    createdAt: Date.now(),
  };

  it("sends binary packets through the WebSocket", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true }),
    );

    const packet1 = new Uint8Array([0x01, 1, 65]); // key event
    const packet2 = new Uint8Array([0x03, 0x00, 0x00, 0x00, 0x00]); // mouse move

    await send({ session, packets: [packet1, packet2] });

    expect(cdpManagerMock.sendCommand).toHaveBeenCalledWith(
      42,
      "Runtime.evaluate",
      expect.objectContaining({
        returnByValue: true,
        awaitPromise: false,
      }),
    );

    // Verify packets are serialized as number arrays in the expression
    const expression = cdpManagerMock.sendCommand.mock.calls[0][2]
      .expression as string;
    expect(expression).toContain("[1,1,65]");
    expect(expression).toContain("[3,0,0,0,0]");
  });

  it("does nothing for empty packet array", async () => {
    await send({ session, packets: [] });
    expect(cdpManagerMock.sendCommand).not.toHaveBeenCalled();
  });

  it("throws PROTOCOL_ERROR when session is not found", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({
        ok: false,
        error: "Session not found. The WebSocket may have been closed.",
        errorCode: "PROTOCOL_ERROR",
      }),
    );

    await expect(
      send({ session, packets: [new Uint8Array([1, 0, 65])] }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("throws PROTOCOL_ERROR when WebSocket is not open", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({
        ok: false,
        error: "WebSocket is not open (readyState=3)",
        errorCode: "PROTOCOL_ERROR",
      }),
    );

    await expect(
      send({ session, packets: [new Uint8Array([1, 0, 65])] }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("throws PROTOCOL_ERROR when send fails", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({
        ok: false,
        error: "Send failed: InvalidStateError",
        errorCode: "PROTOCOL_ERROR",
      }),
    );

    await expect(
      send({ session, packets: [new Uint8Array([1, 0, 65])] }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe("close", () => {
  const session = {
    sessionId: "__oc_kvm_test",
    tabId: 42,
    createdAt: Date.now(),
  };

  it("closes the WebSocket and cleans up", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true }),
    );

    await close(session);

    expect(cdpManagerMock.sendCommand).toHaveBeenCalledWith(
      42,
      "Runtime.evaluate",
      expect.objectContaining({
        returnByValue: true,
        awaitPromise: false,
      }),
    );

    // Verify the script cleans up the window property
    const expression = cdpManagerMock.sendCommand.mock.calls[0][2]
      .expression as string;
    expect(expression).toContain("delete window");
    expect(expression).toContain("__oc_kvm_test");
  });

  it("does not throw when CDP sendCommand fails (best-effort cleanup)", async () => {
    cdpManagerMock.isAttached.mockReturnValue(false);
    cdpManagerMock.attach.mockRejectedValueOnce(
      new Error("Tab not found"),
    );

    // Should not throw
    await expect(close(session)).resolves.toBeUndefined();
  });

  it("does not throw when session is already gone", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true }),
    );

    // Closing a non-existent session is fine
    await expect(close(session)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getSessionStatus
// ---------------------------------------------------------------------------

describe("getSessionStatus", () => {
  const session = {
    sessionId: "__oc_kvm_test",
    tabId: 42,
    createdAt: Date.now(),
  };

  it("returns readyState for an existing session", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 1 }),
    );

    const status = await getSessionStatus(session);
    expect(status).toBe(1); // WebSocket.OPEN
  });

  it("returns readyState 3 for a closed session", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 3 }),
    );

    const status = await getSessionStatus(session);
    expect(status).toBe(3); // WebSocket.CLOSED
  });

  it("returns null when the session is not found", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: false, error: "Session not found" }),
    );

    const status = await getSessionStatus(session);
    expect(status).toBeNull();
  });

  it("returns null when CDP throws", async () => {
    cdpManagerMock.sendCommand.mockRejectedValueOnce(
      new Error("Tab closed"),
    );

    const status = await getSessionStatus(session);
    expect(status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GlkvmTransportError
// ---------------------------------------------------------------------------

describe("GlkvmTransportError", () => {
  it("has the correct name and code", () => {
    const err = new GlkvmTransportError("AUTH_FAILED", "Token expired");
    expect(err.name).toBe("GlkvmTransportError");
    expect(err.code).toBe("AUTH_FAILED");
    expect(err.message).toBe("Token expired");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GlkvmTransportError);
  });

  it("supports all error codes", () => {
    const codes = [
      "AUTH_FAILED",
      "TAB_NOT_FOUND",
      "CONNECTION_FAILED",
      "PROTOCOL_ERROR",
      "TIMEOUT",
      "EVAL_ERROR",
    ] as const;

    for (const code of codes) {
      const err = new GlkvmTransportError(code, `Error: ${code}`);
      expect(err.code).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// connect script content verification
// ---------------------------------------------------------------------------

describe("connect script content", () => {
  it("reads auth token from both localStorage keys", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 1 }),
    );

    await connect({ tabId: 42 });

    const expression = cdpManagerMock.sendCommand.mock.calls[0][2]
      .expression as string;
    expect(expression).toContain("gl-kvm-token-keys");
    expect(expression).toContain("gl-kvm-token-key");
  });

  it("constructs WebSocket URL from page origin", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 1 }),
    );

    await connect({ tabId: 42 });

    const expression = cdpManagerMock.sendCommand.mock.calls[0][2]
      .expression as string;
    expect(expression).toContain("/api/ws?auth_token=");
    expect(expression).toContain("location.protocol");
    expect(expression).toContain("location.host");
  });

  it("sets binaryType to arraybuffer", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 1 }),
    );

    await connect({ tabId: 42 });

    const expression = cdpManagerMock.sendCommand.mock.calls[0][2]
      .expression as string;
    expect(expression).toContain('binaryType = "arraybuffer"');
  });

  it("detects auth rejection close codes", async () => {
    cdpManagerMock.sendCommand.mockResolvedValueOnce(
      mockEvalResult({ ok: true, readyState: 1 }),
    );

    await connect({ tabId: 42 });

    const expression = cdpManagerMock.sendCommand.mock.calls[0][2]
      .expression as string;
    // Script should check for auth-related close codes
    expect(expression).toContain("1008");
    expect(expression).toContain("4401");
    expect(expression).toContain("4403");
  });
});

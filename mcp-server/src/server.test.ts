import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMcpServer, getToolSchemas } from "./server.js";
import { TOOL_NAMES, ALL_TOOL_NAMES } from "@opencode-chrome/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SocketClient } from "./socketClient.js";

// ---------------------------------------------------------------------------
// Tool schema tests
// ---------------------------------------------------------------------------

describe("getToolSchemas", () => {
  const schemaFor = (name: string) => {
    const schema = getToolSchemas().find((s) => s.name === name);
    expect(schema).toBeDefined();
    return schema!;
  };

  const expectRequiredProperty = (name: string, property: string) => {
    const schema = schemaFor(name);
    expect(schema.inputSchema.properties).toHaveProperty(property);
    expect(schema.inputSchema.required).toContain(property);
  };

  it("returns exactly 21 tool schemas", () => {
    const schemas = getToolSchemas();
    expect(schemas).toHaveLength(21);
  });

  it("includes all tool names from shared constants", () => {
    const schemas = getToolSchemas();
    const schemaNames = schemas.map((s) => s.name);

    expect([...schemaNames].sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it("every schema has name, description, and inputSchema", () => {
    for (const schema of getToolSchemas()) {
      expect(schema.name).toBeTruthy();
      expect(schema.description).toBeTruthy();
      expect(schema.inputSchema).toBeDefined();
      expect(schema.inputSchema.type).toBe("object");
    }
  });

  it("does not use unsupported top-level schema combinators", () => {
    for (const schema of getToolSchemas()) {
      expect(schema.inputSchema).not.toHaveProperty("anyOf");
      expect(schema.inputSchema).not.toHaveProperty("oneOf");
      expect(schema.inputSchema).not.toHaveProperty("allOf");
    }
  });

  it("navigate tool requires action", () => {
    const schema = getToolSchemas().find(
      (s) => s.name === TOOL_NAMES.NAVIGATE
    )!;
    expect(schema.inputSchema.required).toContain("action");
  });

  it("computer tool requires action", () => {
    const schema = getToolSchemas().find(
      (s) => s.name === TOOL_NAMES.COMPUTER
    )!;
    expect(schema.inputSchema.required).toContain("action");
  });

  it("javascript_tool requires code", () => {
    const schema = getToolSchemas().find(
      (s) => s.name === TOOL_NAMES.JAVASCRIPT
    )!;
    expect(schema.inputSchema.required).toContain("code");
  });

  it("resize_window requires width and height", () => {
    const schema = getToolSchemas().find(
      (s) => s.name === TOOL_NAMES.RESIZE_WINDOW
    )!;
    expect(schema.inputSchema.required).toContain("width");
    expect(schema.inputSchema.required).toContain("height");
  });

  it("tabs_close requires tabId", () => {
    const schema = schemaFor(TOOL_NAMES.TABS_CLOSE);
    expect(schema.inputSchema.properties).toHaveProperty("tabId");
  });

  it("advertises required tabId for tab-scoped tools", () => {
    const tabScopedTools = [
      TOOL_NAMES.COMPUTER,
      TOOL_NAMES.READ_PAGE,
      TOOL_NAMES.FIND,
      TOOL_NAMES.FORM_INPUT,
      TOOL_NAMES.GET_PAGE_TEXT,
      TOOL_NAMES.JAVASCRIPT,
      TOOL_NAMES.FILE_UPLOAD,
      TOOL_NAMES.READ_CONSOLE,
      TOOL_NAMES.READ_NETWORK,
      TOOL_NAMES.RESIZE_WINDOW,
      TOOL_NAMES.GIF_CREATOR,
    ];

    for (const toolName of tabScopedTools) {
      expectRequiredProperty(toolName, "tabId");
    }
  });

  it("keeps navigate tabId optional for active-tab fallback", () => {
    const schema = schemaFor(TOOL_NAMES.NAVIGATE);
    expect(schema.inputSchema.properties).toHaveProperty("tabId");
    expect(schema.inputSchema.required).not.toContain("tabId");
  });

  it("does not add tabId to global tab discovery or tab creation tools", () => {
    expect(
      schemaFor(TOOL_NAMES.TABS_CONTEXT).inputSchema.properties
    ).not.toHaveProperty("tabId");
    expect(
      schemaFor(TOOL_NAMES.TABS_CREATE).inputSchema.properties
    ).not.toHaveProperty("tabId");
  });

  it("matches read_page handler format names", () => {
    const schema = schemaFor(TOOL_NAMES.READ_PAGE);
    expect(schema.inputSchema.properties).toMatchObject({
      format: { enum: ["accessibility", "html", "text"] },
    });
  });

  it("matches find handler argument names", () => {
    const schema = schemaFor(TOOL_NAMES.FIND);
    expect(schema.inputSchema.properties).toHaveProperty("query");
    expect(schema.inputSchema.properties).toHaveProperty("maxResults");
    expect(schema.inputSchema.properties).not.toHaveProperty("description");
    expect(schema.inputSchema.required).toEqual(
      expect.arrayContaining(["tabId", "query"])
    );
  });

  it("matches computer handler coordinate and scroll argument names", () => {
    const schema = schemaFor(TOOL_NAMES.COMPUTER);
    expect(schema.inputSchema.properties).toEqual(
      expect.objectContaining({
        tabId: expect.any(Object),
        x: expect.any(Object),
        y: expect.any(Object),
        ref: expect.any(Object),
        direction: expect.any(Object),
        amount: expect.any(Object),
        startX: expect.any(Object),
        startY: expect.any(Object),
        endX: expect.any(Object),
        endY: expect.any(Object),
      })
    );
    expect(schema.inputSchema.properties).not.toHaveProperty("coordinate");
    expect(schema.inputSchema.properties).not.toHaveProperty("scroll_direction");
    expect(schema.inputSchema.properties).not.toHaveProperty("scroll_amount");
    expect(schema.inputSchema.properties).not.toHaveProperty("start_coordinate");
    expect(schema.inputSchema.properties).not.toHaveProperty("end_coordinate");
  });

  it("matches file_upload handler argument names", () => {
    const schema = schemaFor(TOOL_NAMES.FILE_UPLOAD);
    expect(schema.inputSchema.properties).toEqual(
      expect.objectContaining({
        tabId: expect.any(Object),
        selector: expect.any(Object),
        files: expect.objectContaining({
          type: "array",
          items: { type: "string" },
        }),
      })
    );
    expect(schema.inputSchema.properties).not.toHaveProperty("ref");
    expect(schema.inputSchema.properties).not.toHaveProperty("filePath");
    expect(schema.inputSchema.required).toEqual(
      expect.arrayContaining(["tabId", "selector", "files"])
    );
  });

  it("advertises optional handler-supported arguments", () => {
    expect(
      schemaFor(TOOL_NAMES.GET_PAGE_TEXT).inputSchema.properties
    ).toHaveProperty("maxLength");
    expect(schemaFor(TOOL_NAMES.JAVASCRIPT).inputSchema.properties).toEqual(
      expect.objectContaining({
        awaitPromise: expect.any(Object),
        timeout: expect.any(Object),
      })
    );
    expect(
      schemaFor(TOOL_NAMES.GIF_CREATOR).inputSchema.properties
    ).toHaveProperty("delay");
  });

  it("advertises tabs_close tabIds batch close support", () => {
    const schema = schemaFor(TOOL_NAMES.TABS_CLOSE);
    expect(schema.inputSchema.properties).toHaveProperty("tabIds");
    expect(schema.inputSchema.properties).toMatchObject({
      tabIds: { type: "array", items: { type: "number" } },
    });
  });

  it("registers the GLKVM tool schemas from shared constants", () => {
    expect(schemaFor(TOOL_NAMES.GLKVM_STATUS).description).toContain("GLKVM");
    expect(schemaFor(TOOL_NAMES.GLKVM_SCREENSHOT).description).toContain("GLKVM");
    expect(schemaFor(TOOL_NAMES.GLKVM_INPUT).description).toContain("GLKVM");
    expect(schemaFor(TOOL_NAMES.GLKVM_WAIT).description).toContain("GLKVM");
    expect(schemaFor(TOOL_NAMES.GLKVM_SEQUENCE).description).toContain("GLKVM");
    expect(schemaFor(TOOL_NAMES.GLKVM_OCR).description).toContain("GLKVM");
  });

  it("advertises GLKVM OCR as an optional unavailable wrapper", () => {
    const schema = schemaFor(TOOL_NAMES.GLKVM_OCR);

    expect(schema.description).toContain("optional");
    expect(schema.description).toContain("unavailable");
    expect(schema.inputSchema.properties).toMatchObject({
      target: { type: "string" },
      sessionId: { type: "string" },
      language: { type: "string" },
      region: { type: "object" },
    });
    expect(schema.inputSchema.required ?? []).toEqual([]);
  });

  it("uses explicit GLKVM target/session targeting instead of tabId", () => {
    const glkvmTools = [
      TOOL_NAMES.GLKVM_STATUS,
      TOOL_NAMES.GLKVM_SCREENSHOT,
      TOOL_NAMES.GLKVM_INPUT,
      TOOL_NAMES.GLKVM_WAIT,
      TOOL_NAMES.GLKVM_OCR,
    ];

    for (const toolName of glkvmTools) {
      const schema = schemaFor(toolName);
      expect(schema.inputSchema.properties).toHaveProperty("target");
      expect(schema.inputSchema.properties).toHaveProperty("sessionId");
      expect(schema.inputSchema.properties).not.toHaveProperty("tabId");
    }
  });

  it("advertises GLKVM screenshot OCR as optional", () => {
    const schema = schemaFor(TOOL_NAMES.GLKVM_SCREENSHOT);
    expect(schema.inputSchema.properties).toMatchObject({
      includeOcr: { type: "boolean" },
    });
    expect(schema.inputSchema.required ?? []).not.toContain("includeOcr");
  });

  it("advertises GLKVM input argument shapes", () => {
    const inputSchema = schemaFor(TOOL_NAMES.GLKVM_INPUT);
    expect(inputSchema.inputSchema.properties).toMatchObject({
      action: {
        enum: ["key", "type", "click", "move", "drag", "scroll"],
      },
      keyAction: { enum: ["press", "down", "up", "hotkey", "chord"] },
      fallback: { enum: ["keys", "none"] },
      button: { enum: ["left", "middle", "right"] },
      direction: { enum: ["up", "down"] },
    });
    expect(inputSchema.inputSchema.required).toContain("action");
  });

  it("advertises GLKVM wait as frame-change polling", () => {
    const waitSchema = schemaFor(TOOL_NAMES.GLKVM_WAIT);
    expect(waitSchema.description).toContain("frame");
    expect(waitSchema.description).toContain("change");
    expect(waitSchema.inputSchema.properties).toEqual(
      expect.objectContaining({
        target: expect.any(Object),
        sessionId: expect.any(Object),
        timeout: expect.any(Object),
        pollInterval: expect.any(Object),
      })
    );
    expect(waitSchema.inputSchema.properties).not.toHaveProperty("text");
    expect(waitSchema.inputSchema.properties).not.toHaveProperty("includeOcr");
    expect(waitSchema.inputSchema.properties).not.toHaveProperty("interval");
  });

  it("advertises GLKVM sequence frame waits", () => {
    const sequenceSchema = schemaFor(TOOL_NAMES.GLKVM_SEQUENCE);

    expect(sequenceSchema.description).toContain("batched");
    expect(sequenceSchema.inputSchema.required).toEqual(
      expect.arrayContaining(["tabId", "steps"]),
    );
    expect(sequenceSchema.inputSchema.properties).toEqual(
      expect.objectContaining({
        tabId: expect.any(Object),
        sessionId: expect.any(Object),
        steps: expect.any(Object),
      })
    );
    expect(sequenceSchema.inputSchema.properties.steps.items.properties.action.enum).toEqual(
      ["key", "type", "click", "move", "drag", "scroll", "wait", "waitFrameChange", "waitFrameStable", "capture"],
    );
    expect(sequenceSchema.inputSchema.properties.steps.items.properties).toEqual(
      expect.objectContaining({
        text: expect.any(Object),
        key: expect.any(Object),
        keyAction: expect.any(Object),
        timeout: expect.any(Object),
        pollInterval: expect.any(Object),
        stabilityDuration: expect.any(Object),
        includeData: expect.any(Object),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// MCP server integration tests (using in-memory transport)
// ---------------------------------------------------------------------------

describe("createMcpServer", () => {
  let client: Client;
  let mockSocketClient: SocketClient;

  beforeEach(async () => {
    // Create a mock socket client
    mockSocketClient = new SocketClient();
    // Override connect to no-op
    vi.spyOn(mockSocketClient, "connect").mockResolvedValue(undefined);
    // Mark as connected
    Object.defineProperty(mockSocketClient, "connected", { get: () => true });

    const server = await createMcpServer(mockSocketClient);
    client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  it("lists all 21 tools via MCP protocol", async () => {
    const result = await client.listTools();
    expect(result.tools).toHaveLength(21);
  });

  it("tool names match shared constants", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    for (const toolName of ALL_TOOL_NAMES) {
      expect(names).toContain(toolName);
    }
  });

  it("returns error for unknown tool", async () => {
    const result = await client.callTool({
      name: "nonexistent_tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("Unknown tool") }),
      ])
    );
  });

  it("forwards tool call to socket client", async () => {
    const sendSpy = vi.spyOn(mockSocketClient, "sendToolRequest").mockResolvedValue({
      content: [{ type: "text", text: "Navigated to: https://example.com" }],
    });

    const result = await client.callTool({
      name: "navigate",
      arguments: { action: "goto", url: "https://example.com" },
    });

    expect(sendSpy).toHaveBeenCalledWith("navigate", {
      action: "goto",
      url: "https://example.com",
    });
    expect(result.content).toEqual([
      { type: "text", text: "Navigated to: https://example.com" },
    ]);
  });

  it("returns error when socket client throws", async () => {
    vi.spyOn(mockSocketClient, "sendToolRequest").mockRejectedValue(
      new Error("Connection lost")
    );

    const result = await client.callTool({
      name: "computer",
      arguments: { action: "screenshot" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("Connection lost"),
        }),
      ])
    );
  });

  it("attempts reconnect when not connected", async () => {
    // Create a fresh socket client where we can control the connected state
    const freshClient = Object.create(SocketClient.prototype) as SocketClient;
    let isConnected = false;

    Object.defineProperty(freshClient, "connected", {
      get: () => isConnected,
      configurable: true,
    });

    const connectSpy = vi.fn(async () => {
      isConnected = true;
    });
    freshClient.connect = connectSpy;
    freshClient.sendToolRequest = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });

    // Create a server with the fresh client
    const server2 = await createMcpServer(freshClient);
    const client2 = new Client(
      { name: "test-client-2", version: "1.0.0" },
      { capabilities: {} }
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client2.connect(ct), server2.connect(st)]);

    await client2.callTool({
      name: "tabs_context",
      arguments: {},
    });

    expect(connectSpy).toHaveBeenCalled();
  });
});

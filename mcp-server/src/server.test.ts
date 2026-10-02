import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import {
  WebSocketFirstTransport,
  createMcpServer,
  getToolSchemas,
} from "./server.js";
import { WebSocketBridge } from "./webSocketBridge.js";
import { TOOL_NAMES, ALL_TOOL_NAMES } from "@chromeuse/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowserTransport, ToolRequestResult } from "./transport.js";
import { AI_TOOL_NAMES } from "./aiTools.js";
import type { DecisionProvider } from "./decisionTypes.js";

type TestTransport = BrowserTransport & {
  connect: ReturnType<typeof vi.fn>;
  sendToolRequest: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  setConnected: (value: boolean) => void;
};

function createTestTransport(options: { connected?: boolean } = {}): TestTransport {
  let connected = options.connected ?? true;

  return {
    get connected() {
      return connected;
    },
    setConnected(value: boolean) {
      connected = value;
    },
    connect: vi.fn(async () => {
      connected = true;
    }),
    sendToolRequest: vi.fn(async (): Promise<ToolRequestResult> => ({
      content: [{ type: "text", text: "ok" }],
    })),
    disconnect: vi.fn(() => {
      connected = false;
    }),
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();

  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

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

  it("returns one schema for every shared MCP tool name", () => {
    const schemas = getToolSchemas();
    expect(schemas).toHaveLength(ALL_TOOL_NAMES.length);
  });

  it("includes all tool names from shared constants", () => {
    const schemas = getToolSchemas();
    const schemaNames = schemas.map((s) => s.name);

    expect(schemaNames).toEqual(expect.arrayContaining([...ALL_TOOL_NAMES]));
    expect(new Set(schemaNames)).toHaveProperty("size", ALL_TOOL_NAMES.length);
    expect(schemaNames).toHaveLength(ALL_TOOL_NAMES.length);
  });

  it("every schema has name, description, and inputSchema", () => {
    for (const schema of getToolSchemas()) {
      expect(schema.name).toBeTruthy();
      expect(schema.description).toBeTruthy();
      expect(schema.inputSchema).toBeDefined();
      expect(schema.inputSchema.type).toBe("object");
    }
  });

  it("advertises the default browser interaction policy", () => {
    expect(schemaFor(TOOL_NAMES.TABS_CONTEXT).description).toMatch(/start here/i);
    expect(schemaFor(TOOL_NAMES.GET_PAGE_TEXT).description).toMatch(/read first/i);
    expect(schemaFor(TOOL_NAMES.READ_PAGE).description).toMatch(/accessibility/i);
    expect(schemaFor(TOOL_NAMES.FIND).description).toMatch(/prefer.*computer/i);
    expect(schemaFor(TOOL_NAMES.JAVASCRIPT).description).toMatch(/exact state/i);
    expect(schemaFor(TOOL_NAMES.COMPUTER).description).toMatch(/last-mile/i);
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
        overlay: expect.any(Object),
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

  it("advertises temporary grid screenshot support on the computer tool", () => {
    const schema = schemaFor(TOOL_NAMES.COMPUTER);

    expect(schema.inputSchema.properties).toMatchObject({
      overlay: {
        type: "string",
        enum: ["none", "temporary-grid"],
      },
    });
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

  it("advertises markdown_render safe text and file inputs", () => {
    const schema = schemaFor(TOOL_NAMES.MARKDOWN_RENDER);
    expect(schema.description).toMatch(/markdown/i);
    expect(schema.inputSchema.required ?? []).toEqual([]);
    expect(schema.inputSchema.properties).toEqual(
      expect.objectContaining({
        markdown: expect.objectContaining({
          type: "string",
          description: expect.stringMatching(/markdown text/i),
        }),
        filePath: expect.objectContaining({
          type: "string",
          description: expect.stringMatching(/workspace file/i),
        }),
        url: expect.objectContaining({
          type: "string",
          description: expect.stringMatching(/accessible/i),
        }),
        allowRawHtml: expect.objectContaining({
          type: "boolean",
          description: expect.stringMatching(/disabled by default/i),
        }),
      })
    );
  });

  it("advertises markdown_render safe defaults explicitly", () => {
    const schema = schemaFor(TOOL_NAMES.MARKDOWN_RENDER);

    expect(schema.description).toMatch(/safe html/i);
    expect(schema.description).toMatch(/raw html is disabled by default/i);
    expect(schema.inputSchema.properties).toMatchObject({
      allowRawHtml: {
        type: "boolean",
        description: expect.stringMatching(/disabled by default/i),
      },
    });
    expect(schema.inputSchema.properties).not.toHaveProperty("sanitize");
  });

  it("advertises the workspace and markdown foundation tools from shared constants", () => {
    const foundationToolNames = [
      TOOL_NAMES.MARKDOWN_RENDER,
      TOOL_NAMES.WORKSPACE_LIST_FILES,
      TOOL_NAMES.WORKSPACE_READ_FILE,
    ];

    for (const toolName of foundationToolNames) {
      expect(schemaFor(toolName).name).toBe(toolName);
      expect(ALL_TOOL_NAMES).toContain(toolName);
    }
  });

  it("advertises workspace_list_files selected-workspace inputs", () => {
    const schema = schemaFor(TOOL_NAMES.WORKSPACE_LIST_FILES);
    expect(schema.description).toMatch(/selected.*workspace/i);
    expect(schema.description).toMatch(/permission/i);
    expect(schema.inputSchema.required ?? []).toEqual([]);
    expect(schema.inputSchema.properties).toEqual(
      expect.objectContaining({
        path: expect.objectContaining({
          type: "string",
          description: expect.stringMatching(/workspace-relative/i),
        }),
        depth: expect.objectContaining({
          type: "number",
          description: expect.stringMatching(/depth/i),
        }),
        limit: expect.objectContaining({
          type: "number",
          description: expect.stringMatching(/maximum/i),
        }),
      })
    );
  });

  it("advertises workspace_list_files bounded lazy tree controls", () => {
    const schema = schemaFor(TOOL_NAMES.WORKSPACE_LIST_FILES);

    expect(schema.description).toMatch(/file system access permission/i);
    expect(schema.inputSchema.required ?? []).toEqual([]);
    expect(schema.inputSchema.properties).toMatchObject({
      path: {
        type: "string",
        description: expect.stringMatching(/defaults to the workspace root/i),
      },
      depth: {
        type: "number",
        description: expect.stringMatching(/maximum recursive directory depth/i),
      },
      limit: {
        type: "number",
        description: expect.stringMatching(/maximum number of entries/i),
      },
    });
  });

  it("advertises workspace_read_file selected-workspace inputs", () => {
    const schema = schemaFor(TOOL_NAMES.WORKSPACE_READ_FILE);
    expect(schema.description).toMatch(/selected.*workspace/i);
    expect(schema.description).toMatch(/permission/i);
    expect(schema.inputSchema.required).toEqual(["path"]);
    expect(schema.inputSchema.properties).toEqual(
      expect.objectContaining({
        path: expect.objectContaining({
          type: "string",
          description: expect.stringMatching(/workspace-relative/i),
        }),
        limit: expect.objectContaining({
          type: "number",
          description: expect.stringMatching(/maximum/i),
        }),
        encoding: expect.objectContaining({
          type: "string",
          enum: ["utf-8"],
        }),
      })
    );
  });

  it("advertises workspace_read_file text-only bounded reads", () => {
    const schema = schemaFor(TOOL_NAMES.WORKSPACE_READ_FILE);

    expect(schema.description).toMatch(/text-like file/i);
    expect(schema.description).toMatch(/file system access permission/i);
    expect(schema.inputSchema.required).toEqual(["path"]);
    expect(schema.inputSchema.properties).toMatchObject({
      path: {
        type: "string",
        description: expect.stringMatching(/workspace-relative path/i),
      },
      limit: {
        type: "number",
        description: expect.stringMatching(/maximum number of characters/i),
      },
      encoding: {
        type: "string",
        enum: ["utf-8"],
        description: expect.stringMatching(/defaults to utf-8/i),
      },
    });
  });

  it("advertises workspace_write_file selected-workspace writes", () => {
    const schema = schemaFor(TOOL_NAMES.WORKSPACE_WRITE_FILE);

    expect(schema.description).toMatch(/selected workspace/i);
    expect(schema.description).toMatch(/File System Access/i);
    expect(schema.inputSchema.properties).toHaveProperty("path");
    expect(schema.inputSchema.properties).toHaveProperty("dataUrl");
    expect(schema.inputSchema.properties).toHaveProperty("createDirectories");
    expect(schema.inputSchema.required).toEqual(["path", "dataUrl"]);
  });

  it("advertises save_resource selected-workspace path semantics", () => {
    const schema = schemaFor(TOOL_NAMES.SAVE_RESOURCE);

    expect(schema.description).toMatch(/selected workspace/i);
    expect(schema.description).not.toMatch(/absolute path/i);
    expect(schema.inputSchema.properties).toHaveProperty("outputPath");
    expect(schema.inputSchema.required).toEqual(["tabId", "url"]);
  });

  it("advertises extension health checks", () => {
    const schema = schemaFor(TOOL_NAMES.HEALTH_CHECK);

    expect(schema.description).toMatch(/health/i);
    expect(schema.inputSchema.properties).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// MCP server integration tests (using in-memory transport)
// ---------------------------------------------------------------------------

describe("createMcpServer", () => {
  let client: Client;
  let server: Awaited<ReturnType<typeof createMcpServer>>;
  let mockSocketClient: TestTransport;

  beforeEach(async () => {
    mockSocketClient = createTestTransport();
    server = await createMcpServer(mockSocketClient);
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

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("lists all shared MCP tools via MCP protocol", async () => {
    const result = await client.listTools();
    expect(result.tools).toHaveLength(ALL_TOOL_NAMES.length);
  });

  it("registers injected direct-Jev tools and handles them locally", async () => {
    const directJev: DecisionProvider = {
      async decide() {
        return {
          answers: { assertion: { type: "noul", noul: 0.91 } },
          metadata: {
            provider: "direct-jev",
            requestedModel: "typesafe/jev-1.13",
            resolvedModel: "typesafe/jev-1.13-20260917",
            latencyMs: 5,
            usage: { inputTokens: 10, outputTokens: 1, cost: 0.00001 },
          },
        };
      },
    };
    const localTransport = createTestTransport();
    const localServer = await createMcpServer(localTransport, directJev, {
      action: 0.8,
      assertion: 0.8,
      sufficiency: 0.8,
      maxRisk: 1,
    });
    const localClient = new Client(
      { name: "direct-jev-test", version: "1.0.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      localClient.connect(clientTransport),
      localServer.connect(serverTransport),
    ]);

    try {
      const tools = await localClient.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining(Object.values(AI_TOOL_NAMES))
      );
      const result = await localClient.callTool({
        name: AI_TOOL_NAMES.AI_ASSERT,
        arguments: {
          tabId: 7,
          condition: "dashboard visible",
          pageContent: "Dashboard",
        },
      });
      expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
        pass: true,
        probability: 0.91,
      });
      expect(localTransport.sendToolRequest).not.toHaveBeenCalled();
    } finally {
      await localClient.close();
      await localServer.close();
    }
  });

  it("does not load ambient Jev config when provider and thresholds are injected", async () => {
    const previousApiKey = process.env.CHROMEUSE_JEV_API_KEY;
    const previousThreshold = process.env.CHROMEUSE_JEV_ACTION_THRESHOLD;
    process.env.CHROMEUSE_JEV_API_KEY = "configured-but-unused";
    process.env.CHROMEUSE_JEV_ACTION_THRESHOLD = "invalid";
    const directJev: DecisionProvider = {
      async decide() {
        throw new Error("not called");
      },
    };
    let localServer: Awaited<ReturnType<typeof createMcpServer>> | undefined;

    try {
      localServer = await createMcpServer(createTestTransport(), directJev, {
        action: 0.8,
        assertion: 0.8,
        sufficiency: 0.8,
        maxRisk: 1,
      });
      expect(localServer).toBeDefined();
    } finally {
      if (localServer) await localServer.close();
      if (previousApiKey === undefined) delete process.env.CHROMEUSE_JEV_API_KEY;
      else process.env.CHROMEUSE_JEV_API_KEY = previousApiKey;
      if (previousThreshold === undefined) delete process.env.CHROMEUSE_JEV_ACTION_THRESHOLD;
      else process.env.CHROMEUSE_JEV_ACTION_THRESHOLD = previousThreshold;
    }
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
    mockSocketClient.sendToolRequest.mockResolvedValue({
      content: [{ type: "text", text: "Navigated to: https://example.com" }],
    });

    const result = await client.callTool({
      name: "navigate",
      arguments: { action: "goto", url: "https://example.com" },
    });

    expect(mockSocketClient.sendToolRequest).toHaveBeenCalledWith(
      "navigate",
      {
        action: "goto",
        url: "https://example.com",
      },
      undefined,
      { clientId: expect.stringMatching(/^chromeuse-mcp-\d+-[a-z0-9]+$/) },
    );
    expect(result.content).toEqual([
      { type: "text", text: "Navigated to: https://example.com" },
    ]);
  });

  it("preserves the direct transport ToolRequestResult shape", async () => {
    mockSocketClient.sendToolRequest.mockResolvedValue({
      content: [{ type: "text", text: "Permission denied" }],
      isError: true,
      metadata: { requestId: "direct-transport" },
    });

    const result = await client.callTool({
      name: "computer",
      arguments: { action: "screenshot", tabId: 7 },
    });

    expect(mockSocketClient.sendToolRequest).toHaveBeenCalledWith(
      "computer",
      {
        action: "screenshot",
        tabId: 7,
      },
      undefined,
      { clientId: expect.stringMatching(/^chromeuse-mcp-\d+-[a-z0-9]+$/) },
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "Permission denied" }],
      isError: true,
      metadata: { requestId: "direct-transport" },
    });
  });

  it("maps extension image content to MCP image content", async () => {
    mockSocketClient.sendToolRequest.mockResolvedValue({
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: "aGVsbG8=",
          },
        },
        {
          type: "text",
          text: '{"screenshot":{"width":1200,"height":800}}',
        },
      ],
    });

    const result = await client.callTool({
      name: "computer",
      arguments: { action: "screenshot", tabId: 7 },
    });

    expect(result.content).toEqual([
      {
        type: "image",
        data: "aGVsbG8=",
        mimeType: "image/jpeg",
      },
      {
        type: "text",
        text: '{"screenshot":{"width":1200,"height":800}}',
      },
    ]);
  });

  it("returns error when socket client throws", async () => {
    mockSocketClient.sendToolRequest.mockRejectedValue(new Error("Connection lost"));

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
    const freshClient = createTestTransport({ connected: false });

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

    expect(freshClient.connect).toHaveBeenCalled();

    await client2.close();
    await server2.close();
  });

  it("closes the injected browser transport when the server closes", async () => {
    await server.close();

    expect(mockSocketClient.disconnect).toHaveBeenCalledTimes(1);
  });

  it("routes MCP callTool requests through the WebSocket bridge", async () => {
    const bridge = new WebSocketBridge({ port: 0 });
    await bridge.connect();

    const extension = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    await waitForOpen(extension);

    const webSocketServer = await createMcpServer(bridge);
    const webSocketClient = new Client(
      { name: "websocket-test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      webSocketClient.connect(clientTransport),
      webSocketServer.connect(serverTransport),
    ]);

    try {
      const response = webSocketClient.callTool({
        name: "navigate",
        arguments: { action: "goto", url: "https://example.com" },
      });

      const request = await waitForMessage(extension);
      expect(request).toMatchObject({
        type: "tool_request",
        method: "execute_tool",
        params: {
          request_id: expect.any(String),
          tool: "navigate",
          args: { action: "goto", url: "https://example.com" },
        },
      });

      extension.send(
        JSON.stringify({
          type: "tool_response",
          request_id: (request.params as Record<string, unknown>).request_id,
          result: { content: [{ type: "text", text: "navigated" }] },
        })
      );

      await expect(response).resolves.toEqual({
        content: [{ type: "text", text: "navigated" }],
      });
    } finally {
      await webSocketClient.close();
      await webSocketServer.close();
      if (extension.readyState === WebSocket.OPEN) extension.close();
    }
  });
});

describe("WebSocketFirstTransport", () => {
  it("prefers a connected WebSocket extension over native fallback", async () => {
    const webSocket = createTestTransport({ connected: true });
    const native = createTestTransport({ connected: true });
    const transport = new WebSocketFirstTransport(webSocket, native);

    webSocket.sendToolRequest.mockResolvedValue({
      content: [{ type: "text", text: "websocket" }],
    });

    await expect(transport.sendToolRequest("tabs_context", {})).resolves.toEqual({
      content: [{ type: "text", text: "websocket" }],
    });
    expect(webSocket.sendToolRequest).toHaveBeenCalledWith(
      "tabs_context",
      {},
      undefined
    );
    expect(native.sendToolRequest).not.toHaveBeenCalled();
  });

  it("falls back to native transport when no WebSocket extension is connected", async () => {
    const webSocket = createTestTransport({ connected: false });
    const native = createTestTransport({ connected: true });
    const transport = new WebSocketFirstTransport(webSocket, native);

    native.sendToolRequest.mockResolvedValue({
      content: [{ type: "text", text: "native" }],
    });

    await expect(transport.sendToolRequest("tabs_context", {})).resolves.toEqual({
      content: [{ type: "text", text: "native" }],
    });
    expect(webSocket.sendToolRequest).not.toHaveBeenCalled();
    expect(native.sendToolRequest).toHaveBeenCalledWith(
      "tabs_context",
      {},
      undefined
    );
  });

  it("mentions the side panel Connect action when no transport is connected", async () => {
    const webSocket = createTestTransport({ connected: false });
    const native = createTestTransport({ connected: false });
    const transport = new WebSocketFirstTransport(webSocket, native);

    await expect(transport.sendToolRequest("tabs_context", {})).rejects.toThrow(
      /side panel.*Connect/i
    );
  });

  it("starts WebSocket resources while allowing native fallback", async () => {
    const webSocket = createTestTransport({ connected: false });
    const native = createTestTransport({ connected: false });
    webSocket.connect.mockImplementation(async () => undefined);
    const transport = new WebSocketFirstTransport(webSocket, native);

    await transport.connect();

    expect(webSocket.connect).toHaveBeenCalled();
    expect(native.connect).toHaveBeenCalled();
    expect(transport.connected).toBe(true);
  });

  it("closes WebSocket and native resources", async () => {
    const webSocket = createTestTransport();
    const native = createTestTransport();
    const transport = new WebSocketFirstTransport(webSocket, native);

    await transport.close();

    expect(webSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(native.disconnect).toHaveBeenCalledTimes(1);
  });
});

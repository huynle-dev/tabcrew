import { TOOL_NAMES } from "@opencode-chrome/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageRouter } from "../messageRouter.js";
import { registerTools } from "./index.js";

describe("registerTools", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      tabs: {
        onRemoved: { addListener: vi.fn() },
      },
    });
  });

  it("registers the GLKVM screenshot tool exposed by the MCP schema", () => {
    const router = new MessageRouter();

    registerTools(router);

    expect(router.getRegisteredTools()).toContain(TOOL_NAMES.GLKVM_SCREENSHOT);
    expect(router.getRegisteredTools()).toContain(TOOL_NAMES.GLKVM_SEQUENCE);
  });
});

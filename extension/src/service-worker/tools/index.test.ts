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

  it("registers every public GLKVM handler exposed by the MCP schema", () => {
    const router = new MessageRouter();

    registerTools(router);

    expect(router.getRegisteredTools()).toEqual(
      expect.arrayContaining([
        TOOL_NAMES.GLKVM_OPEN,
        TOOL_NAMES.GLKVM_ATTACH,
        TOOL_NAMES.GLKVM_STATUS,
        TOOL_NAMES.GLKVM_SCREENSHOT,
        TOOL_NAMES.GLKVM_INPUT,
        TOOL_NAMES.GLKVM_WAIT,
        TOOL_NAMES.GLKVM_SEQUENCE,
        TOOL_NAMES.GLKVM_NAV,
        TOOL_NAMES.GLKVM_OCR,
        TOOL_NAMES.GLKVM_SMOKE_TEST,
      ]),
    );
  });
});

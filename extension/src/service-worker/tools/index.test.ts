import { ALL_TOOL_NAMES } from "@opencode-chrome/shared";
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

  it("registers exactly every public shared tool", () => {
    const router = new MessageRouter();

    registerTools(router);

    expect([...router.getRegisteredTools()].sort()).toEqual(
      [...ALL_TOOL_NAMES].sort(),
    );
  });
});

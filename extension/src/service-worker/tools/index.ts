/**
 * Tool registry - imports all tool handlers and registers them with the
 * message router using shared TOOL_NAMES constants.
 *
 * Called once during service worker initialization.
 */

import { TOOL_NAMES } from "@opencode-chrome/shared";
import type { MessageRouter } from "../messageRouter.js";

// Tool handlers
import { ComputerTool } from "./computer.js";
import { ConsoleTool } from "./console.js";
import { FileUploadTool } from "./fileUpload.js";
import { FindTool } from "./find.js";
import { FormInputTool } from "./formInput.js";
import { GetPageTextTool } from "./getPageText.js";
import { GifCreatorTool } from "./gifCreator.js";
import { GlkvmAttachTool } from "./glkvmAttach.js";
import { GlkvmNavTool } from "./glkvmNav.js";
import { GlkvmOpenTool } from "./glkvmOpen.js";
import { GlkvmScreenshotTool } from "./glkvmScreenshot.js";
import { GlkvmSequenceTool } from "./glkvmSequence.js";
import { GlkvmSmokeTestTool } from "./glkvmSmokeTest.js";
import { GlkvmWaitTool } from "./glkvmWait.js";
import { GlkvmInputTool } from "./kvmInput.js";
import { GlkvmOcrTool } from "./kvmOcr.js";
import { GlkvmStatusTool } from "./kvmStatus.js";
import { JavaScriptTool } from "./javascript.js";
import { NavigateTool } from "./navigate.js";
import { NetworkTool } from "./network.js";
import { ReadPageTool } from "./readPage.js";
import { ResizeTool } from "./resize.js";
import { TabsCloseTool } from "./tabsClose.js";
import { TabsContextTool } from "./tabsContext.js";
import { TabsCreateTool } from "./tabsCreate.js";

/**
 * Register all tool handlers with the message router.
 *
 * Each handler implements {@link ToolHandler} and is registered under its
 * canonical name from {@link TOOL_NAMES}.
 */
export function registerTools(router: MessageRouter): void {
  router.register(TOOL_NAMES.COMPUTER, new ComputerTool());
  router.register(TOOL_NAMES.READ_CONSOLE, new ConsoleTool());
  router.register(TOOL_NAMES.FILE_UPLOAD, new FileUploadTool());
  router.register(TOOL_NAMES.FIND, new FindTool());
  router.register(TOOL_NAMES.FORM_INPUT, new FormInputTool());
  router.register(TOOL_NAMES.GET_PAGE_TEXT, new GetPageTextTool());
  router.register(TOOL_NAMES.GIF_CREATOR, new GifCreatorTool());
  router.register(TOOL_NAMES.GLKVM_OPEN, new GlkvmOpenTool());
  router.register(TOOL_NAMES.GLKVM_ATTACH, new GlkvmAttachTool());
  router.register(TOOL_NAMES.GLKVM_NAV, new GlkvmNavTool());
  router.register(TOOL_NAMES.GLKVM_SCREENSHOT, new GlkvmScreenshotTool());
  router.register(TOOL_NAMES.GLKVM_SEQUENCE, new GlkvmSequenceTool());
  router.register(TOOL_NAMES.GLKVM_SMOKE_TEST, new GlkvmSmokeTestTool());
  router.register(TOOL_NAMES.GLKVM_WAIT, new GlkvmWaitTool());
  router.register(TOOL_NAMES.GLKVM_INPUT, new GlkvmInputTool());
  router.register(TOOL_NAMES.GLKVM_OCR, new GlkvmOcrTool());
  router.register(TOOL_NAMES.GLKVM_STATUS, new GlkvmStatusTool());
  router.register(TOOL_NAMES.JAVASCRIPT, new JavaScriptTool());
  router.register(TOOL_NAMES.NAVIGATE, new NavigateTool());
  router.register(TOOL_NAMES.READ_NETWORK, new NetworkTool());
  router.register(TOOL_NAMES.READ_PAGE, new ReadPageTool());
  router.register(TOOL_NAMES.RESIZE_WINDOW, new ResizeTool());
  router.register(TOOL_NAMES.TABS_CLOSE, new TabsCloseTool());
  router.register(TOOL_NAMES.TABS_CONTEXT, new TabsContextTool());
  router.register(TOOL_NAMES.TABS_CREATE, new TabsCreateTool());

  console.log(
    "[Tools] Registered:",
    router.getRegisteredTools().join(", "),
  );
}

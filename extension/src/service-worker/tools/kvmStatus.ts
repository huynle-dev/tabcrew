import type {
  ToolHandler,
  ToolResult,
  ToolContext,
} from "../../types/messages.js";
import { getVideoMetadata, requireOwnedGlkvmTabForDirectControl } from "../glkvmTab.js";
import { getSessionStatus, type GlkvmSession } from "./kvmHidTransport.js";

function readyStateLabel(readyState: number | null): string {
  switch (readyState) {
    case 0:
      return "connecting";
    case 1:
      return "open";
    case 2:
      return "closing";
    case 3:
      return "closed";
    case null:
      return "not_found";
    default:
      return "unknown";
  }
}

function streamStatus(video: {
  videoWidth: number;
  videoHeight: number;
  visible: boolean;
}): { available: boolean; status: string } {
  if (!video.visible) {
    return { available: false, status: "hidden" };
  }

  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    return { available: false, status: "no_frame" };
  }

  return { available: true, status: "ready" };
}

export class GlkvmStatusTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    try {
      const target = typeof args.target === "string" ? args.target : undefined;
      const sessionId =
        typeof args.sessionId === "string" ? args.sessionId : undefined;

      const validated = await requireOwnedGlkvmTabForDirectControl(
        {
          ...("tabId" in args ? { tabId: args.tabId } : {}),
          ...(target ? { target } : {}),
        },
        _context.sessionScope,
      );
      const video = await getVideoMetadata(validated.tabId);

      const response: Record<string, unknown> = {
        ...(target ? { target } : {}),
        tab: validated.tab,
        video,
        stream: streamStatus(video),
      };

      if (sessionId) {
        const session: GlkvmSession = {
          tabId: validated.tabId,
          sessionId,
          createdAt: Date.now(),
        };
        const readyState = await getSessionStatus(session);
        response.session = {
          sessionId,
          readyState,
          status: readyStateLabel(readyState),
        };
      }

      return {
        success: true,
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    } catch (error) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: `GLKVM status failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
}

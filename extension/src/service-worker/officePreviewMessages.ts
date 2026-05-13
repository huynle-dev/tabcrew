import { renderDocxPreview, renderXlsxPreview, type OfficePreviewResult } from "./officePreview.js";

export interface OfficePreviewMessage {
  readonly action?: string;
  readonly url?: unknown;
  readonly fileType?: unknown;
}

type SendResponse = (response: OfficePreviewResponse) => void;
type Fetcher = (url: string) => Promise<Pick<Response, "ok" | "status" | "arrayBuffer">>;

export interface OfficePreviewResponse extends OfficePreviewResult {}

export function handleOfficePreviewMessage(
  message: OfficePreviewMessage,
  sendResponse: SendResponse,
  fetcher: Fetcher = fetch,
): boolean {
  if (message.action !== "chromeuse_render_office_preview") return false;

  const url = typeof message.url === "string" ? message.url : "";
  const fileType = message.fileType === "docx" || message.fileType === "xlsx" ? message.fileType : fileTypeFromUrl(url);

  renderOfficePreview(url, fileType, fetcher)
    .then(sendResponse)
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error || "Unknown error");
      sendResponse({
        ok: false,
        error: `Unable to render Office preview: ${detail}`,
        html: `<div class="chromeuse-markdown-fallback-preview">Unable to render Office preview: ${escapeHtml(detail)}</div>`,
      });
    });

  return true;
}

async function renderOfficePreview(url: string, fileType: "docx" | "xlsx" | null, fetcher: Fetcher): Promise<OfficePreviewResponse> {
  if (!url) throw new Error("missing file URL");
  const response = await fetcher(url);
  if (!response.ok && !isFileUrl(url)) throw new Error(`HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();

  if (fileType === "docx") return renderDocxPreview(arrayBuffer);
  if (fileType === "xlsx") return renderXlsxPreview(arrayBuffer);

  return {
    ok: false,
    error: "Unsupported Office preview type",
    html: `<div class="chromeuse-markdown-fallback-preview">Unsupported Office preview type.</div>`,
  };
}

function fileTypeFromUrl(url: string): "docx" | "xlsx" | null {
  const pathname = url.split(/[?#]/, 1)[0].toLowerCase();
  if (pathname.endsWith(".docx")) return "docx";
  if (pathname.endsWith(".xlsx")) return "xlsx";
  return null;
}

function isFileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

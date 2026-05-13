import mammoth from "mammoth";
import * as XLSX from "xlsx";

export interface OfficePreviewResult {
  readonly ok: boolean;
  readonly html: string;
  readonly error?: string;
}

export type DocxTextExtractor = (input: { readonly arrayBuffer: ArrayBuffer }) => Promise<{ readonly value: string }>;

const MAX_XLSX_PREVIEW_ROWS = 50;
const MAX_XLSX_PREVIEW_COLUMNS = 10;

export function renderXlsxPreview(arrayBuffer: ArrayBuffer): OfficePreviewResult {
  try {
    const signature = new Uint8Array(arrayBuffer, 0, Math.min(2, arrayBuffer.byteLength));
    if (signature[0] !== 0x50 || signature[1] !== 0x4b) throw new Error("not a valid XLSX zip container");

    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    if (workbook.SheetNames.length === 0) throw new Error("workbook has no sheets");

    const sheets = workbook.SheetNames.map((sheetName) => {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, raw: false, blankrows: false });
      if (rows.length === 0) return "";

      const truncated = rows.length > MAX_XLSX_PREVIEW_ROWS || rows.some((row) => row.length > MAX_XLSX_PREVIEW_COLUMNS);
      const notice = truncated
        ? `<p class="chromeuse-office-preview-limit">Showing first ${MAX_XLSX_PREVIEW_ROWS} rows and ${MAX_XLSX_PREVIEW_COLUMNS} columns.</p>`
        : "";
      const body = rows.slice(0, MAX_XLSX_PREVIEW_ROWS)
        .map((row) => `<tr>${row.slice(0, MAX_XLSX_PREVIEW_COLUMNS).map((cell) => `<td>${escapeHtml(String(cell ?? ""))}</td>`).join("")}</tr>`)
        .join("");

      return `<section class="chromeuse-office-sheet"><h2>${escapeHtml(sheetName)}</h2>${notice}<table><tbody>${body}</tbody></table></section>`;
    }).filter(Boolean).join("");

    if (!sheets) throw new Error("workbook has no readable sheets");
    return { ok: true, html: `<div class="chromeuse-office-preview">${sheets}</div>` };
  } catch (error) {
    return errorPreview("XLSX", error);
  }
}

export async function renderDocxPreview(
  arrayBuffer: ArrayBuffer,
  extractRawText: DocxTextExtractor = mammoth.extractRawText,
): Promise<OfficePreviewResult> {
  try {
    const result = await extractRawText({ arrayBuffer });
    const paragraphs = result.value
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
      .join("");
    return { ok: true, html: `<div class="chromeuse-office-preview chromeuse-office-docx">${paragraphs}</div>` };
  } catch (error) {
    return errorPreview("DOCX", error);
  }
}

function errorPreview(kind: "DOCX" | "XLSX", error: unknown): OfficePreviewResult {
  const detail = error instanceof Error ? error.message : String(error || "Unknown parser error");
  const message = `Unable to render ${kind} preview: ${detail}`;
  return { ok: false, error: message, html: `<div class="chromeuse-markdown-fallback-preview">${escapeHtml(message)}</div>` };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

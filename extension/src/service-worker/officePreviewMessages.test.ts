import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { handleOfficePreviewMessage } from "./officePreviewMessages.js";

function workbookBuffer(): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Name"], ["Ada"]]), "Sheet1");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("officePreviewMessages", () => {
  it("handles xlsx preview messages by fetching ArrayBuffer content", async () => {
    const buffer = workbookBuffer();
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => buffer }));
    const sendResponse = vi.fn();

    const handled = handleOfficePreviewMessage(
      { action: "chromeuse_render_office_preview", url: "file:///tmp/book.xlsx" },
      sendResponse,
      fetcher,
    );

    expect(handled).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(fetcher).toHaveBeenCalledWith("file:///tmp/book.xlsx");
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: true });
    expect(sendResponse.mock.calls[0][0].html).toContain("Ada");
  });

  it("returns false for unrelated runtime messages", () => {
    expect(handleOfficePreviewMessage({ action: "sidepanel_get_state" }, vi.fn())).toBe(false);
  });
});

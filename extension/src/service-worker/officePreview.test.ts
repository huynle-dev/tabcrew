import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { renderDocxPreview, renderXlsxPreview } from "./officePreview.js";

function workbookBuffer(): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Name", "Note"], ["Ada", "<script>alert('x')</script>"]]), "People & Teams");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("officePreview", () => {
  it("renders xlsx sheets as escaped HTML tables", () => {
    const result = renderXlsxPreview(workbookBuffer());
    expect(result.ok).toBe(true);
    expect(result.html).toContain("People &amp; Teams");
    expect(result.html).toContain("<table");
    expect(result.html).toContain("Ada");
    expect(result.html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(result.html).not.toContain("<script>");
  });

  it("renders docx text as escaped readable HTML", async () => {
    const result = await renderDocxPreview(new ArrayBuffer(8), async () => ({ value: "Title\n\nHello <team> & friends" }));
    expect(result.ok).toBe(true);
    expect(result.html).toContain("<p>Title</p>");
    expect(result.html).toContain("Hello &lt;team&gt; &amp; friends");
  });

  it("returns graceful error results when Office parsing fails", async () => {
    const docx = await renderDocxPreview(new ArrayBuffer(8), async () => { throw new Error("bad zip"); });
    const xlsx = renderXlsxPreview(new Uint8Array([1, 2, 3]).buffer);
    expect(docx).toMatchObject({ ok: false, error: "Unable to render DOCX preview: bad zip" });
    expect(docx.html).toContain("Unable to render DOCX preview");
    expect(xlsx.ok).toBe(false);
    expect(xlsx.html).toContain("Unable to render XLSX preview");
  });

  it("limits xlsx rows and columns in preview output", () => {
    const workbook = XLSX.utils.book_new();
    const rows = Array.from({ length: 55 }, (_, rowIndex) => Array.from({ length: 14 }, (_, columnIndex) => `R${rowIndex + 1}C${columnIndex + 1}`));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Large");
    const result = renderXlsxPreview(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    expect(result.ok).toBe(true);
    expect(result.html).toContain("Showing first 50 rows and 10 columns");
    expect(result.html).toContain("R50C10");
    expect(result.html).not.toContain("R51C1");
    expect(result.html).not.toContain("R1C11");
  });
});

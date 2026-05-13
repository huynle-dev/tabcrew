import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addParentDirectoryEntry,
  buildFileTreeEntries,
  createMarkdownDocumentModel,
  extractMarkdownHeadings,
  fetchDirectoryListing,
  getFileTreeIconPath,
  getParentDirectoryUrl,
  markdownDocumentRenderer,
  shouldRenderFileBrowserShell,
  parseDirectoryListing,
  shouldRenderMarkdownDocument,
} from "./markdownDocumentRenderer.js";

describe("markdown document renderer", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes markdown documents opened directly in a Chrome tab", () => {
    expect(shouldRenderMarkdownDocument("file:///Users/me/notes.md", "text/plain")).toBe(true);
    expect(shouldRenderMarkdownDocument("file:///Users/me/notes.md", "text/plain; charset=utf-8")).toBe(true);
    expect(shouldRenderMarkdownDocument("file:///Users/me/notes.md#heading", "")).toBe(true);
    expect(shouldRenderMarkdownDocument("file:///Users/me/notes.MDX", "application/octet-stream")).toBe(true);
    expect(shouldRenderMarkdownDocument("https://example.com/spec.markdown", "text/plain")).toBe(true);
    expect(shouldRenderMarkdownDocument("https://example.com/readme.mdx?raw=1", "text/markdown")).toBe(true);
    expect(shouldRenderMarkdownDocument("https://example.com/download", "text/x-markdown; charset=utf-8")).toBe(true);
    expect(shouldRenderMarkdownDocument("https://example.com/component", "text/mdx")).toBe(true);
    expect(shouldRenderMarkdownDocument("https://github.com/org/repo/blob/main/README.md", "text/html")).toBe(false);
    expect(shouldRenderMarkdownDocument("https://example.com/data.json", "application/json")).toBe(false);
  });

  it("recognizes local directory listings for the file browser shell", () => {
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/docs/", "text/html")).toBe(true);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/docs/", "text/html; charset=utf-8")).toBe(true);
    expect(shouldRenderFileBrowserShell("https://example.com/docs/", "text/html")).toBe(false);
  });

  it("recognizes supported local non-markdown files for the file browser shell", () => {
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/src/app.ts", "text/plain")).toBe(true);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/package.json", "application/json")).toBe(true);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/archive.zip", "application/zip")).toBe(false);
  });

  it("creates a safe rendered markdown document model", () => {
    const model = createMarkdownDocumentModel(
      "file:///Users/me/project/README.md",
      "# Title\n\nHello <script>alert(1)</script>",
    );

    expect(model.title).toBe("README.md");
    expect(model.source).toContain("# Title");
    expect(model.html).toContain("<h1>Title</h1>");
    expect(model.html).not.toContain("<script>");
    expect(model.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(model.outline).toBe(model.headings);
  });

  it("exposes markdown rendering through a generic document renderer boundary", () => {
    expect(markdownDocumentRenderer.shouldRender("file:///Users/me/notes.md", "text/plain")).toBe(true);
    expect(markdownDocumentRenderer.shouldRender("file:///Users/me/project/docs/", "text/html")).toBe(true);
    expect(markdownDocumentRenderer.shouldRender("file:///Users/me/project/src/app.ts", "text/plain")).toBe(true);

    const model = markdownDocumentRenderer.createModel("file:///Users/me/notes.md", "# Notes");

    expect(model.title).toBe("notes.md");
    expect(model.html).toContain("<h1>Notes</h1>");
    expect(model.outline).toEqual([{ level: 1, text: "Notes", id: "notes" }]);
    expect(model.headings).toBe(model.outline);
  });

  it("renders mermaid fences as mermaid diagram containers", () => {
    const model = createMarkdownDocumentModel(
      "file:///Users/me/diagram.md",
      "# Diagram\n\n```mermaid\nflowchart TD\n  A --> B\n```",
    );

    expect(model.html).toContain('class="mermaid"');
    expect(model.html).toContain("flowchart TD");
    expect(model.html).not.toContain("language-mermaid");
  });

  it("extracts headings for a TOC side panel", () => {
    expect(extractMarkdownHeadings("# Title\n\n## Goal\n\n### Notes\n\n#### Hidden")).toEqual([
      { level: 1, text: "Title", id: "title" },
      { level: 2, text: "Goal", id: "goal" },
      { level: 3, text: "Notes", id: "notes" },
    ]);
  });

  it("finds the parent directory for local markdown documents", () => {
    expect(getParentDirectoryUrl("file:///Users/me/project/docs/README.md")).toBe("file:///Users/me/project/docs/");
    expect(getParentDirectoryUrl("https://example.com/docs/README.md")).toBeNull();
  });

  it("maps folders and common file types to Devicon assets", () => {
    expect(getFileTreeIconPath({ name: "docs", url: "file:///Users/me/project/docs/", type: "directory" })).toBe(
      "assets/devicons/folder.svg",
    );
    expect(getFileTreeIconPath({ name: "README.md", url: "file:///Users/me/project/README.md", type: "file" })).toBe(
      "assets/devicons/markdown.svg",
    );
    expect(getFileTreeIconPath({ name: "package.json", url: "file:///Users/me/project/package.json", type: "file" })).toBe(
      "assets/devicons/npm.svg",
    );
    expect(getFileTreeIconPath({ name: "app.tsx", url: "file:///Users/me/project/app.tsx", type: "file" })).toBe(
      "assets/devicons/react.svg",
    );
    expect(getFileTreeIconPath({ name: "unknown.lock", url: "file:///Users/me/project/unknown.lock", type: "file" })).toBe(
      "assets/devicons/file.svg",
    );
  });

  it("parses Chrome file directory listings into markdown files and folders", () => {
    const listing = `
      <script>
        addRow("guide.md", "guide.md", 0, "1 KB", "today");
        addRow("notes.txt", "notes.txt", 0, "1 KB", "today");
        addRow("specs", "specs/", 1, "", "today");
      </script>
    `;

    expect(parseDirectoryListing(listing, "file:///Users/me/project/docs/")).toEqual([
      { name: "specs", url: "file:///Users/me/project/docs/specs/", type: "directory" },
      { name: "guide.md", url: "file:///Users/me/project/docs/guide.md", type: "file" },
    ]);
  });

  it("adds an up-directory entry before child entries", () => {
    expect(
      addParentDirectoryEntry(
        [{ name: "README.md", url: "file:///Users/me/project/docs/sub/README.md", type: "file" }],
        "file:///Users/me/project/docs/sub/",
      ),
    ).toEqual([
      { name: "..", url: "file:///Users/me/project/docs/", type: "directory" },
      { name: "README.md", url: "file:///Users/me/project/docs/sub/README.md", type: "file" },
    ]);
  });

  it("omits up-directory entries for nested expanded folders", () => {
    const listing = `
      <script>
        addRow("README.md", "README.md", 0, "1 KB", "today");
        addRow("child", "child/", 1, "", "today");
      </script>
    `;

    expect(buildFileTreeEntries(listing, "file:///Users/me/project/docs/sub/", false)).toEqual([
      { name: "child", url: "file:///Users/me/project/docs/sub/child/", type: "directory" },
      { name: "README.md", url: "file:///Users/me/project/docs/sub/README.md", type: "file" },
    ]);
  });

  it("falls back to page-context fetch when extension directory fetch fails", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: "Failed to fetch" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "directory html",
    });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDirectoryListing("file:///Users/me/project/docs/")).resolves.toBe("directory html");
    expect(sendMessage).toHaveBeenCalledWith({
      action: "chromeuse_fetch_directory_listing",
      url: "file:///Users/me/project/docs/",
    });
    expect(fetchMock).toHaveBeenCalledWith("file:///Users/me/project/docs/");
  });

  it("accepts readable file directory responses even when fetch reports status 0", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: "HTTP 0" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 0,
      text: async () => "file directory html",
    });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDirectoryListing("file:///Users/me/project/docs/")).resolves.toBe("file directory html");
  });
});

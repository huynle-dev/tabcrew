import { beforeEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import type { FileBrowserEntry } from "./markdownDocumentRenderer.js";
import {
  addParentDirectoryEntry,
  buildFileTreeEntries,
  classifyFileBrowserFile,
  createFileBrowserPreviewModel,
  createMarkdownDocumentModel,
  createDocumentPreviewContainer,
  extractMarkdownHeadings,
  fetchDirectoryListing,
  fetchLocalFileArrayBuffer,
  fetchLocalFileText,
  getFileTreeIconPath,
  getParentDirectoryUrl,
  handleFileTreeFileClick,
  limitPreviewSource,
  MAX_TEXT_PREVIEW_CHARACTERS,
  markdownDocumentRenderer,
  renderCurrentPreviewDocument,
  renderFileTreeEntry,
  shouldRenderFileBrowserShell,
  parseDirectoryListing,
  shouldPreviewFileBrowserEntry,
  shouldRenderMarkdownDocument,
  updateDocumentPreviewContainer,
} from "./markdownDocumentRenderer.js";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    run: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockedMermaid = vi.mocked(mermaid);

describe("markdown document renderer", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
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
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/src/app.ts", "application/octet-stream")).toBe(false);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/archive.zip", "application/zip")).toBe(false);
  });

  it("recognizes local media and PDF files for file URL previews", () => {
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/photo.png", "image/png")).toBe(true);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/movie.mp4", "video/mp4")).toBe(true);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/song.mp3", "audio/mpeg")).toBe(true);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/manual.pdf", "application/pdf")).toBe(true);
    expect(shouldRenderFileBrowserShell("https://example.com/project/photo.png", "image/png")).toBe(false);
  });

  it("recognizes local Office files for fallback file URL previews", () => {
    expect(
      shouldRenderFileBrowserShell(
        "file:///Users/me/project/deck.pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).toBe(true);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/brief.doc", "application/msword")).toBe(true);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/budget.xls", "application/vnd.ms-excel")).toBe(true);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/archive.zip", "application/zip")).toBe(false);
  });

  it("renders media and PDF previews from escaped file URLs", () => {
    const imageModel = createFileBrowserPreviewModel("file:///Users/me/project/photo%20&%20logo.png", "", "image/png");
    const videoModel = createFileBrowserPreviewModel("file:///Users/me/project/movie.mp4", "", "video/mp4");
    const audioModel = createFileBrowserPreviewModel("file:///Users/me/project/song.mp3", "", "audio/mpeg");
    const pdfModel = createFileBrowserPreviewModel("file:///Users/me/project/manual.pdf", "", "application/pdf");

    expect(imageModel.html).toContain('<img src="file:///Users/me/project/photo%20&amp;%20logo.png"');
    expect(imageModel.html).toContain('alt="photo &amp; logo.png"');
    expect(videoModel.html).toContain('<video src="file:///Users/me/project/movie.mp4" controls></video>');
    expect(audioModel.html).toContain('<audio src="file:///Users/me/project/song.mp3" controls></audio>');
    expect(pdfModel.html).toContain('<iframe class="chromeuse-markdown-media-preview chromeuse-markdown-media-preview-pdf"');
    expect(pdfModel.html).toContain('src="file:///Users/me/project/manual.pdf"');
  });

  it("renders SVG previews as file URL image references without inline SVG injection", () => {
    const model = createFileBrowserPreviewModel("file:///Users/me/project/logo.svg", "<svg><script>alert(1)</script></svg>", "image/svg+xml");

    expect(model.route).toBe("image");
    expect(model.html).toContain('<img src="file:///Users/me/project/logo.svg"');
    expect(model.html).not.toContain("<svg");
    expect(model.html).not.toContain("<script>");
  });

  it("classifies general file browser preview file types independent of rendering", () => {
    expect(classifyFileBrowserFile("file:///Users/me/project/README.md")).toBe("markdown");
    expect(classifyFileBrowserFile("file:///Users/me/project/src/app.ts")).toBe("text");
    expect(classifyFileBrowserFile("file:///Users/me/project/package.json")).toBe("text");
    expect(classifyFileBrowserFile("file:///Users/me/project/logo.svg", "text/plain")).toBe("image");
    expect(classifyFileBrowserFile("file:///Users/me/project/movie.mp4")).toBe("video");
    expect(classifyFileBrowserFile("file:///Users/me/project/song.mp3")).toBe("audio");
    expect(classifyFileBrowserFile("file:///Users/me/project/manual.pdf")).toBe("pdf");
    expect(classifyFileBrowserFile("file:///Users/me/project/deck.pptx")).toBe("office");
    expect(classifyFileBrowserFile("file:///Users/me/project/archive.tar.gz")).toBe("archive");
    expect(classifyFileBrowserFile("file:///Users/me/project/program.bin")).toBe("binary");
  });

  it("uses MIME types when file names do not identify a preview type", () => {
    expect(classifyFileBrowserFile("file:///Users/me/project/download", "image/png")).toBe("image");
    expect(classifyFileBrowserFile("file:///Users/me/project/download", "video/webm; codecs=vp9")).toBe("video");
    expect(classifyFileBrowserFile("file:///Users/me/project/download", "audio/wav")).toBe("audio");
    expect(classifyFileBrowserFile("file:///Users/me/project/download", "application/pdf")).toBe("pdf");
    expect(classifyFileBrowserFile("file:///Users/me/project/download", "application/zip")).toBe("archive");
    expect(classifyFileBrowserFile("file:///Users/me/project/download", "application/octet-stream")).toBe("binary");
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

  it("routes markdown files through the markdown preview path", () => {
    const model = createFileBrowserPreviewModel("file:///Users/me/project/README.md", "# Title");

    expect(model.route).toBe("markdown");
    expect(model.fileType).toBe("markdown");
    expect(model.html).toContain("<h1>Title</h1>");
    expect(model.outline).toEqual([{ level: 1, text: "Title", id: "title" }]);
  });

  it("routes text and code files through the text preview path", () => {
    const model = createFileBrowserPreviewModel("file:///Users/me/project/src/app.ts", "const answer = 42;");

    expect(model.route).toBe("text");
    expect(model.fileType).toBe("text");
    expect(model.html).toContain("chromeuse-markdown-text-preview");
    expect(model.html).toContain("const answer = 42;");
    expect(model.outline).toEqual([]);
  });

  it("routes media and PDF files through media preview paths", () => {
    expect(createFileBrowserPreviewModel("file:///Users/me/project/photo.png", "").route).toBe("image");
    expect(createFileBrowserPreviewModel("file:///Users/me/project/movie.mp4", "").route).toBe("video");
    expect(createFileBrowserPreviewModel("file:///Users/me/project/song.mp3", "").route).toBe("audio");
    expect(createFileBrowserPreviewModel("file:///Users/me/project/manual.pdf", "").route).toBe("pdf");
  });

  it("routes unsupported, binary, and archive files through the fallback path", () => {
    expect(createFileBrowserPreviewModel("file:///Users/me/project/deck.pptx", "").route).toBe("fallback");
    expect(createFileBrowserPreviewModel("file:///Users/me/project/program.bin", "").route).toBe("fallback");
    expect(createFileBrowserPreviewModel("file:///Users/me/project/archive.zip", "").route).toBe("fallback");
  });

  it("documents Office previews as fallback-only to keep parser dependencies out of the content-script bundle", () => {
    const model = createFileBrowserPreviewModel("file:///Users/me/project/deck.pptx", "binary office contents");

    expect(model.fileType).toBe("office");
    expect(model.route).toBe("fallback");
    expect(model.source).toBe("");
    expect(model.html).toContain("Office previews are fallback-only");
    expect(model.html).toContain("mammoth/xlsx are not bundled into this always-injected content script");
  });

  it("keeps the TOC markdown-only by returning empty outlines for non-markdown previews", () => {
    for (const name of ["notes.txt", "photo.png", "movie.mp4", "song.mp3", "manual.pdf", "archive.zip"]) {
      expect(createFileBrowserPreviewModel(`file:///Users/me/project/${name}`, "# Not a markdown heading").outline).toEqual([]);
    }
  });

  it("truncates oversized text previews with an explicit fallback message", () => {
    const oversizedSource = `${"a".repeat(MAX_TEXT_PREVIEW_CHARACTERS)}tail`;

    const limited = limitPreviewSource(oversizedSource);
    const model = createMarkdownDocumentModel("file:///Users/me/project/large.ts", oversizedSource);

    expect(limited).toContain("Preview truncated:");
    expect(limited).not.toContain("tail");
    expect(model.source).toBe(limited);
    expect(model.html).toContain("Preview truncated:");
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

  it("updates the preview container without replacing the main shell", () => {
    const doc = createTestDocument();
    const initialModel = createFileBrowserPreviewModel("file:///Users/me/README.md", "# Readme\n\nHello");
    const nextModel = createFileBrowserPreviewModel("file:///Users/me/guide.md", "# Guide\n\n## Steps\n\nUpdated");
    const preview = createDocumentPreviewContainer(doc as unknown as Document, initialModel);
    const shell = doc.createElement("main");

    shell.append(preview.main as unknown as TestElement);
    doc.body.append(preview.raw as unknown as TestElement, shell);
    const originalMain = preview.main;

    updateDocumentPreviewContainer(doc as unknown as Document, markdownDocumentRenderer, preview, nextModel);

    expect(preview.main).toBe(originalMain);
    expect(doc.title).toBe("guide.md");
    expect(preview.title.textContent).toBe("guide.md");
    expect(preview.content.innerHTML).toContain("<h1 id=\"guide\">Guide</h1>");
    expect(preview.content.innerHTML).toContain("<h2 id=\"steps\">Steps</h2>");
    expect(preview.raw.textContent).toBe(nextModel.source);
    expect(preview.tocPanel?.textContent).toContain("Guide");
    expect(preview.tocPanel?.textContent).toContain("Steps");
  });

  it("renders mermaid fences as mermaid diagram containers", () => {
    const model = createFileBrowserPreviewModel(
      "file:///Users/me/diagram.md",
      "# Diagram\n\n```mermaid\nflowchart TD\n  A --> B\n```",
    );

    expect(model.html).toContain('class="mermaid"');
    expect(model.html).toContain("flowchart TD");
    expect(model.html).not.toContain("language-mermaid");
  });

  it("runs mermaid effects when markdown previews are rendered or updated", () => {
    const doc = createTestDocument();
    const model = createFileBrowserPreviewModel(
      "file:///Users/me/diagram.md",
      "# Diagram\n\n```mermaid\nflowchart TD\n  A --> B\n```",
    );
    const preview = createDocumentPreviewContainer(doc as unknown as Document, model);

    updateDocumentPreviewContainer(doc as unknown as Document, markdownDocumentRenderer, preview, model);

    expect(mockedMermaid.initialize).toHaveBeenCalledWith({ startOnLoad: false, theme: "default" });
    expect(mockedMermaid.run).toHaveBeenCalledWith({ nodes: expect.arrayContaining([expect.any(TestElement)]) });

    mockedMermaid.initialize.mockClear();
    mockedMermaid.run.mockClear();
    doc.body.classList.add("chromeuse-theme-dark");

    updateDocumentPreviewContainer(doc as unknown as Document, markdownDocumentRenderer, preview, model);

    expect(mockedMermaid.initialize).toHaveBeenCalledWith({ startOnLoad: false, theme: "dark" });
    expect(mockedMermaid.run).toHaveBeenCalledWith({ nodes: expect.arrayContaining([expect.any(TestElement)]) });
  });

  it("preserves markdown raw, TOC, theme, and raw controls in the full preview shell", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    const doc = createTestDocument("text/plain");
    const source = "# Title\n\n## Details\n\nBody";
    const originalPre = doc.createElement("pre");
    originalPre.textContent = source;
    doc.body.appendChild(originalPre);

    const rendered = renderCurrentPreviewDocument(markdownDocumentRenderer, doc as unknown as Document, "file:///Users/me/README.md");

    expect(rendered).toBe(true);
    expect(doc.title).toBe("README.md");
    expect(doc.body.classList.contains("chromeuse-markdown-document")).toBe(true);
    expect(doc.body.querySelector(".chromeuse-markdown-content")?.innerHTML).toContain('<h1 id="title">Title</h1>');
    expect(doc.body.querySelector(".chromeuse-markdown-toc-list")?.textContent).toContain("Details");
    expect(doc.body.querySelector(".chromeuse-markdown-raw-view")?.textContent).toBe(source);

    const rawButton = doc.body.querySelector('[title="Toggle raw"]');
    rawButton?.click();
    expect(doc.body.classList.contains("chromeuse-raw-visible")).toBe(true);

    const moreButton = doc.body.querySelector('[title="More"]');
    moreButton?.click();
    expect(doc.body.querySelector(".chromeuse-markdown-top-actions")?.classList.contains("open")).toBe(true);

    const darkButton = doc.body.querySelector('[data-theme="dark"]');
    darkButton?.click();
    expect(doc.body.classList.contains("chromeuse-theme-dark")).toBe(true);
    expect(darkButton?.classList.contains("active")).toBe(true);
  });

  it("keeps the raw toggle available for text previews", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    const doc = createTestDocument("text/plain");
    const source = "const answer = 42;";
    const originalPre = doc.createElement("pre");
    originalPre.textContent = source;
    doc.body.appendChild(originalPre);

    const rendered = renderCurrentPreviewDocument(markdownDocumentRenderer, doc as unknown as Document, "file:///Users/me/app.ts");

    expect(rendered).toBe(true);
    expect(doc.body.querySelector(".chromeuse-markdown-raw-view")?.textContent).toBe(source);
    const rawButton = doc.body.querySelector('[title="Toggle raw"]');
    expect(rawButton?.hidden).toBe(false);
    expect(rawButton?.disabled).toBe(false);

    rawButton?.click();
    expect(doc.body.classList.contains("chromeuse-raw-visible")).toBe(true);
  });

  it("disables raw controls for binary previews without raw source", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    const doc = createTestDocument("image/png");

    const rendered = renderCurrentPreviewDocument(markdownDocumentRenderer, doc as unknown as Document, "file:///Users/me/photo.png");

    expect(rendered).toBe(true);
    expect(doc.body.querySelector(".chromeuse-markdown-raw-view")?.hidden).toBe(true);
    const rawButton = doc.body.querySelector('[title="Toggle raw"]');
    expect(rawButton?.hidden).toBe(true);
    expect(rawButton?.disabled).toBe(true);

    rawButton?.click();
    expect(doc.body.classList.contains("chromeuse-raw-visible")).toBe(false);
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

  it("maps folders and common file types to Devicon and fallback assets", () => {
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
    expect(getFileTreeIconPath({ name: "photo.png", url: "file:///Users/me/project/photo.png", type: "file" })).toBe(
      "assets/devicons/image.svg",
    );
    expect(getFileTreeIconPath({ name: "movie.mp4", url: "file:///Users/me/project/movie.mp4", type: "file" })).toBe(
      "assets/devicons/video.svg",
    );
    expect(getFileTreeIconPath({ name: "song.mp3", url: "file:///Users/me/project/song.mp3", type: "file" })).toBe(
      "assets/devicons/audio.svg",
    );
    expect(getFileTreeIconPath({ name: "manual.pdf", url: "file:///Users/me/project/manual.pdf", type: "file" })).toBe(
      "assets/devicons/pdf.svg",
    );
    expect(getFileTreeIconPath({ name: "deck.pptx", url: "file:///Users/me/project/deck.pptx", type: "file" })).toBe(
      "assets/devicons/office.svg",
    );
    expect(getFileTreeIconPath({ name: "archive.tar.gz", url: "file:///Users/me/project/archive.tar.gz", type: "file" })).toBe(
      "assets/devicons/archive.svg",
    );
    expect(getFileTreeIconPath({ name: "unknown.lock", url: "file:///Users/me/project/unknown.lock", type: "file" })).toBe(
      "assets/devicons/file.svg",
    );
  });

  it("identifies all file entries as previewable through router or fallback paths", () => {
    expect(shouldPreviewFileBrowserEntry({ name: "README.md", url: "file:///Users/me/project/README.md", type: "file" })).toBe(
      true,
    );
    expect(shouldPreviewFileBrowserEntry({ name: "app.ts", url: "file:///Users/me/project/app.ts", type: "file" })).toBe(true);
    expect(shouldPreviewFileBrowserEntry({ name: "image.png", url: "file:///Users/me/project/image.png", type: "file" })).toBe(true);
    expect(shouldPreviewFileBrowserEntry({ name: "archive.zip", url: "file:///Users/me/project/archive.zip", type: "file" })).toBe(
      true,
    );
    expect(shouldPreviewFileBrowserEntry({ name: "docs", url: "file:///Users/me/project/docs/", type: "directory" })).toBe(
      false,
    );
  });

  it("intercepts supported sidebar file clicks and updates the main preview", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, html: "# Guide\n\nPreview body" });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const doc = createTestDocument();
    const initialModel = createMarkdownDocumentModel("file:///Users/me/project/README.md", "# Readme");
    const preview = createDocumentPreviewContainer(doc as unknown as Document, initialModel);
    const navigationList = new TestElement("ul");
    const previousItem = new TestElement("li");
    const item = new TestElement("li");
    const preventDefault = vi.fn();
    previousItem.classList.add("active");
    navigationList.append(previousItem, item);

    const handled = await handleFileTreeFileClick(
      { preventDefault },
      doc as unknown as Document,
      { name: "guide.md", url: "file:///Users/me/project/guide.md", type: "file" },
      item as unknown as HTMLElement,
      navigationList as unknown as HTMLElement,
      { renderer: markdownDocumentRenderer, preview },
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({
      action: "chromeuse_fetch_local_file",
      url: "file:///Users/me/project/guide.md",
      responseType: "text",
    });
    expect(doc.title).toBe("guide.md");
    expect(preview.title.textContent).toBe("guide.md");
    expect(preview.content.innerHTML).toContain('<h1 id="guide">Guide</h1>');
    expect(preview.raw.textContent).toBe("# Guide\n\nPreview body");
    expect(previousItem.classList.contains("active")).toBe(false);
    expect(item.classList.contains("active")).toBe(true);
  });

  it("marks the selected preview active when rendering newly expanded folders", async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, html: "# Guide\n\nPreview body" })
      .mockResolvedValueOnce({
        ok: true,
        html: '<script>addRow("guide.md", "guide.md", 0, "1 KB", "today");</script>',
      });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const doc = createTestDocument();
    const initialModel = createMarkdownDocumentModel("file:///Users/me/project/README.md", "# Readme");
    const preview = createDocumentPreviewContainer(doc as unknown as Document, initialModel);
    const navigationList = new TestElement("ul");
    const selectedItem = renderFileTreeEntry(
      doc as unknown as Document,
      { name: "guide.md", url: "file:///Users/me/project/docs/guide.md", type: "file" },
      "file:///Users/me/project/README.md",
      navigationList as unknown as HTMLElement,
      { renderer: markdownDocumentRenderer, preview },
    ) as unknown as TestElement;
    const folderItem = renderFileTreeEntry(
      doc as unknown as Document,
      { name: "docs", url: "file:///Users/me/project/docs/", type: "directory" },
      "file:///Users/me/project/README.md",
      navigationList as unknown as HTMLElement,
      { renderer: markdownDocumentRenderer, preview },
    ) as unknown as TestElement;
    navigationList.append(selectedItem, folderItem);

    selectedItem.children[0].click();
    await waitForMicrotasks();
    folderItem.children[0].click();
    await waitForMicrotasks();

    expect(selectedItem.classList.contains("active")).toBe(true);
    expect(folderItem.children[1].children[0].classList.contains("active")).toBe(true);
  });

  it("intercepts unsupported sidebar file clicks and shows a fallback preview", async () => {
    const doc = createTestDocument();
    const initialModel = createMarkdownDocumentModel("file:///Users/me/project/README.md", "# Readme");
    const preview = createDocumentPreviewContainer(doc as unknown as Document, initialModel);
    const preventDefault = vi.fn();
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const handled = await handleFileTreeFileClick(
      { preventDefault },
      doc as unknown as Document,
      { name: "archive.zip", url: "file:///Users/me/project/archive.zip", type: "file" },
      new TestElement("li") as unknown as HTMLElement,
      new TestElement("ul") as unknown as HTMLElement,
      { renderer: markdownDocumentRenderer, preview },
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(preview.title.textContent).toBe("archive.zip");
    expect(preview.content.innerHTML).toContain("chromeuse-markdown-fallback-preview");
  });

  it("leaves directory entries available for expand/collapse instead of preview interception", async () => {
    const doc = createTestDocument();
    const initialModel = createMarkdownDocumentModel("file:///Users/me/project/README.md", "# Readme");
    const preview = createDocumentPreviewContainer(doc as unknown as Document, initialModel);
    const preventDefault = vi.fn();

    const handled = await handleFileTreeFileClick(
      { preventDefault },
      doc as unknown as Document,
      { name: "docs", url: "file:///Users/me/project/docs/", type: "directory" },
      new TestElement("li") as unknown as HTMLElement,
      new TestElement("ul") as unknown as HTMLElement,
      { renderer: markdownDocumentRenderer, preview },
    );

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(preview.title.textContent).toBe("README.md");
  });

  it("preserves folder row expand/collapse behavior when file preview routing is enabled", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      html: '<script>addRow("guide.md", "guide.md", 0, "1 KB", "today");</script>',
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const doc = createTestDocument();
    const initialModel = createMarkdownDocumentModel("file:///Users/me/project/README.md", "# Readme");
    const preview = createDocumentPreviewContainer(doc as unknown as Document, initialModel);
    const navigationList = new TestElement("ul");
    const item = renderFileTreeEntry(
      doc as unknown as Document,
      { name: "docs", url: "file:///Users/me/project/docs/", type: "directory" },
      "file:///Users/me/project/README.md",
      navigationList as unknown as HTMLElement,
      { renderer: markdownDocumentRenderer, preview },
    ) as unknown as TestElement;
    const button = item.children[0];
    const childList = item.children[1];

    button.click();
    await waitForMicrotasks();

    expect(item.classList.contains("expanded")).toBe(true);
    expect(childList.hidden).toBe(false);
    expect(childList.dataset.loaded).toBe("true");
    expect(childList.children).toHaveLength(1);
    expect(childList.children[0].textContent).toContain("guide.md");
    expect(preview.title.textContent).toBe("README.md");
    expect(sendMessage).toHaveBeenCalledWith({
      action: "chromeuse_fetch_directory_listing",
      url: "file:///Users/me/project/docs/",
      responseType: "text",
    });

    button.click();
    await waitForMicrotasks();

    expect(item.classList.contains("expanded")).toBe(false);
    expect(childList.hidden).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("preserves parent directory navigation by replacing the root tree", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      html: '<script>addRow("README.md", "README.md", 0, "1 KB", "today");</script>',
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const doc = createTestDocument();
    const initialModel = createMarkdownDocumentModel("file:///Users/me/project/docs/guide.md", "# Guide");
    const preview = createDocumentPreviewContainer(doc as unknown as Document, initialModel);
    const navigationList = new TestElement("ul");
    navigationList.appendChild(new TestElement("li"));
    const item = renderFileTreeEntry(
      doc as unknown as Document,
      { name: "..", url: "file:///Users/me/project/", type: "directory" },
      "file:///Users/me/project/docs/guide.md",
      navigationList as unknown as HTMLElement,
      { renderer: markdownDocumentRenderer, preview },
    ) as unknown as TestElement;

    item.children[0].click();
    await waitForMicrotasks();

    expect(navigationList.children).toHaveLength(2);
    expect(navigationList.children[0].textContent).toContain("..");
    expect(navigationList.children[1].textContent).toContain("README.md");
    expect(preview.title.textContent).toBe("guide.md");
    expect(sendMessage).toHaveBeenCalledWith({
      action: "chromeuse_fetch_directory_listing",
      url: "file:///Users/me/project/",
      responseType: "text",
    });
  });

  it("fetches local text file previews through a generic file fetch action", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, text: "const answer = 42;" });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await expect(fetchLocalFileText("file:///Users/me/project/src/app.ts")).resolves.toBe("const answer = 42;");
    expect(sendMessage).toHaveBeenCalledWith({
      action: "chromeuse_fetch_local_file",
      url: "file:///Users/me/project/src/app.ts",
      responseType: "text",
    });
  });

  it("fetches local file previews as array buffers for binary conversion paths", async () => {
    const arrayBuffer = new Uint8Array([1, 2, 3]).buffer;
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, arrayBuffer });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await expect(fetchLocalFileArrayBuffer("file:///Users/me/project/deck.pptx")).resolves.toBe(arrayBuffer);
    expect(sendMessage).toHaveBeenCalledWith({
      action: "chromeuse_fetch_local_file",
      url: "file:///Users/me/project/deck.pptx",
      responseType: "arrayBuffer",
    });
  });

  it("preserves extension and page fetch details when local text preview loading fails", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: "Missing host permission" });
    const fetchMock = vi.fn().mockRejectedValue(new Error("Load blocked"));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLocalFileText("file:///Users/me/project/README.md")).rejects.toThrow(
      "Unable to load preview: extension fetch failed (Missing host permission); page fetch failed (Load blocked). Allow access to file URLs",
    );
  });

  it("shows actionable local-file permission guidance when sidebar file preview loading fails", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: "Missing host permission" });
    const fetchMock = vi.fn().mockRejectedValue(new Error("Load blocked"));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    vi.stubGlobal("fetch", fetchMock);
    const doc = createTestDocument();
    const initialModel = createMarkdownDocumentModel("file:///Users/me/project/README.md", "# Readme");
    const preview = createDocumentPreviewContainer(doc as unknown as Document, initialModel);
    const item = new TestElement("li");
    const navigationList = new TestElement("ul");
    const preventDefault = vi.fn();

    const handled = await handleFileTreeFileClick(
      { preventDefault },
      doc as unknown as Document,
      { name: "guide.md", url: "file:///Users/me/project/guide.md", type: "file" },
      item as unknown as HTMLElement,
      navigationList as unknown as HTMLElement,
      { renderer: markdownDocumentRenderer, preview },
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(preview.content.innerHTML).toContain("Preview unavailable");
    expect(preview.content.innerHTML).toContain("Allow access to file URLs");
    expect(preview.content.innerHTML).toContain("Open file in browser");
    expect(item.classList.contains("active")).toBe(true);
  });

  it("parses Chrome file directory listings into files and folders", () => {
    const listing = `
      <script>
        addRow("archive.zip", "archive.zip", 0, "1 KB", "today");
        addRow("guide.md", "guide.md", 0, "1 KB", "today");
        addRow("image.png", "image.png", 0, "1 KB", "today");
        addRow("notes.txt", "notes.txt", 0, "1 KB", "today");
        addRow("specs", "specs/", 1, "", "today");
      </script>
    `;

    const entries: FileBrowserEntry[] = parseDirectoryListing(listing, "file:///Users/me/project/docs/");

    expect(entries.map(toEntryIdentity)).toEqual([
      { name: "specs", url: "file:///Users/me/project/docs/specs/", type: "directory" },
      { name: "archive.zip", url: "file:///Users/me/project/docs/archive.zip", type: "file" },
      { name: "guide.md", url: "file:///Users/me/project/docs/guide.md", type: "file" },
      { name: "image.png", url: "file:///Users/me/project/docs/image.png", type: "file" },
      { name: "notes.txt", url: "file:///Users/me/project/docs/notes.txt", type: "file" },
    ]);
    expect(entries).toEqual([
      { name: "specs", url: "file:///Users/me/project/docs/specs/", type: "directory", modified: "today" },
      { name: "archive.zip", url: "file:///Users/me/project/docs/archive.zip", type: "file", size: "1 KB", modified: "today" },
      { name: "guide.md", url: "file:///Users/me/project/docs/guide.md", type: "file", size: "1 KB", modified: "today" },
      { name: "image.png", url: "file:///Users/me/project/docs/image.png", type: "file", size: "1 KB", modified: "today" },
      { name: "notes.txt", url: "file:///Users/me/project/docs/notes.txt", type: "file", size: "1 KB", modified: "today" },
    ]);
  });

  it("parses anchor directory listings into files and folders", () => {
    vi.stubGlobal(
      "DOMParser",
      class {
        parseFromString(html: string) {
          const anchors = Array.from(html.matchAll(/<a\s+href="([^"]*)">([^<]*)<\/a>/g)).map(([, href, text]) => ({
            getAttribute: (name: string) => (name === "href" ? href : null),
            textContent: text,
          }));

          return {
            querySelectorAll: (selector: string) => (selector === "a[href]" ? anchors : []),
          };
        }
      },
    );

    const listing = `
      <a href="archive.zip">archive.zip</a>
      <a href="guide.md">guide.md</a>
      <a href="image.png">image.png</a>
      <a href="notes.txt">notes.txt</a>
      <a href="specs/">specs/</a>
    `;

    expect(parseDirectoryListing(listing, "file:///Users/me/project/docs/")).toEqual([
      { name: "specs", url: "file:///Users/me/project/docs/specs/", type: "directory" },
      { name: "archive.zip", url: "file:///Users/me/project/docs/archive.zip", type: "file" },
      { name: "guide.md", url: "file:///Users/me/project/docs/guide.md", type: "file" },
      { name: "image.png", url: "file:///Users/me/project/docs/image.png", type: "file" },
      { name: "notes.txt", url: "file:///Users/me/project/docs/notes.txt", type: "file" },
    ]);
  });

  it("parses Chrome directory listings without metadata", () => {
    const listing = `
      <script>
        addRow("guide.md", "guide.md", 0);
        addRow("specs", "specs/", 1);
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

    expect(buildFileTreeEntries(listing, "file:///Users/me/project/docs/sub/", false).map(toEntryIdentity)).toEqual([
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
      responseType: "text",
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

  it("shows local-file permission guidance when expanded directory loading fails", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: "Missing host permission" });
    const fetchMock = vi.fn().mockRejectedValue(new Error("Load blocked"));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    vi.stubGlobal("fetch", fetchMock);
    const doc = createTestDocument();
    const initialModel = createMarkdownDocumentModel("file:///Users/me/project/README.md", "# Readme");
    const preview = createDocumentPreviewContainer(doc as unknown as Document, initialModel);
    const navigationList = new TestElement("ul");
    const folderItem = renderFileTreeEntry(
      doc as unknown as Document,
      { name: "docs", url: "file:///Users/me/project/docs/", type: "directory" },
      "file:///Users/me/project/README.md",
      navigationList as unknown as HTMLElement,
      { renderer: markdownDocumentRenderer, preview },
    ) as unknown as TestElement;
    const childList = folderItem.children[1];

    folderItem.children[0].click();
    await waitForMicrotasks();
    await waitForMicrotasks();

    expect(childList.textContent).toContain("Unable to load files");
    expect(childList.textContent).toContain("Allow access to file URLs");
    expect(childList.textContent).toContain("Open folder in browser");
    expect(preview.title.textContent).toBe("README.md");
  });
});

class TestElement {
  readonly children: TestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly listeners: Record<string, ((event: { preventDefault: () => void }) => void)[]> = {};
  className = "";
  hidden = false;
  disabled = false;
  href = "";
  id = "";
  rel = "";
  src = "";
  title = "";
  type = "";
  private html = "";
  private text = "";

  constructor(readonly tagName: string) {}

  get classList(): {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    contains: (name: string) => boolean;
    toggle: (name: string, force?: boolean) => boolean;
  } {
    const getClasses = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const setClasses = (classes: Set<string>) => {
      this.className = Array.from(classes).join(" ");
    };
    return {
      add: (...names) => {
        const classes = getClasses();
        names.forEach((name) => classes.add(name));
        setClasses(classes);
      },
      remove: (...names) => {
        const classes = getClasses();
        names.forEach((name) => classes.delete(name));
        setClasses(classes);
      },
      contains: (name) => getClasses().has(name),
      toggle: (name, force) => {
        const classes = getClasses();
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        setClasses(classes);
        return enabled;
      },
    };
  }

  append(...children: TestElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: TestElement): TestElement {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: (event: { preventDefault: () => void }) => void): void {
    this.listeners[type] ??= [];
    this.listeners[type].push(listener);
  }

  click(): void {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    for (const listener of this.listeners.click ?? []) listener(event);
  }

  dispatchEvent(event: { type: string; preventDefault?: () => void }): boolean {
    for (const listener of this.listeners[event.type] ?? []) listener({ preventDefault: event.preventDefault ?? vi.fn() });
    return true;
  }

  remove(): void {}

  replaceChildren(...children: TestElement[]): void {
    this.textContent = "";
    this.html = "";
    this.children.length = 0;
    this.children.push(...children);
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children.length = 0;
    for (const match of value.matchAll(/<span class="([^"]+)"><\/span>/g)) {
      const span = new TestElement("span");
      span.className = match[1];
      this.children.push(span);
    }
    for (const match of value.matchAll(/<div class="([^"]+)">([\s\S]*?)<\/div>/g)) {
      const div = new TestElement("div");
      div.className = match[1];
      div.textContent = match[2].replace(/<[^>]+>/g, "");
      this.children.push(div);
    }
    for (const match of value.matchAll(/<h([1-3])>(.*?)<\/h\1>/g)) {
      const heading = new TestElement(`h${match[1]}`);
      heading.textContent = match[2].replace(/<[^>]+>/g, "");
      this.children.push(heading);
    }
    for (const match of value.matchAll(/<input\s+([^>]*?)\s*\/>/g)) {
      const input = new TestElement("input");
      applyHtmlAttributes(input, match[1]);
      this.children.push(input);
    }
    for (const match of value.matchAll(/<button\s+([^>]*?)>(.*?)<\/button>/g)) {
      const button = new TestElement("button");
      applyHtmlAttributes(button, match[1]);
      button.textContent = match[2].replace(/<[^>]+>/g, "");
      this.children.push(button);
    }
  }

  get firstElementChild(): TestElement | null {
    return this.children[0] ?? null;
  }

  set textContent(value: string) {
    this.text = value;
  }

  get textContent(): string {
    return `${this.text}${this.children.map((child) => child.textContent).join("")}`;
  }

  get innerHTML(): string {
    let index = 0;
    return this.html.replace(/<h([1-3])>(.*?)<\/h\1>/g, (_match, level: string, text: string) => {
      const heading = this.children[index++];
      const id = heading?.id ? ` id="${heading.id}"` : "";
      return `<h${level}${id}>${text}</h${level}>`;
    });
  }

  querySelectorAll(selector: string): TestElement[] {
    const selectors = selector.split(",").map((part) => part.trim());
    const matches = (element: TestElement) =>
      selectors.some((part) => {
        const normalized = part.toLowerCase();
        if (normalized === "[data-theme]") return element.dataset.theme !== undefined;
        if (normalized === "[data-option]") return element.dataset.option !== undefined;
        if (normalized.startsWith("[data-theme=")) return element.dataset.theme === part.match(/\[data-theme="([^"]+)"\]/)?.[1];
        if (normalized.startsWith("[data-option=")) return element.dataset.option === part.match(/\[data-option="([^"]+)"\]/)?.[1];
        if (normalized.startsWith("[title=")) return element.title === part.match(/\[title="([^"]+)"\]/)?.[1];
        const [tagName, className] = normalized.split(".");
        if (tagName && tagName !== element.tagName) return false;
        return !className || element.classList.contains(className);
      });
    const descendants = (element: TestElement): TestElement[] =>
      element.children.flatMap((child) => [child, ...descendants(child)]);
    return descendants(this).filter(matches);
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function createTestDocument(contentType = ""): {
  body: TestElement;
  head: TestElement;
  title: string;
  contentType: string;
  createDocumentFragment: () => TestElement;
  createElement: (tagName: string) => TestElement;
  addEventListener: (type: string, listener: (event: { preventDefault: () => void }) => void) => void;
  dispatchEvent: (event: { type: string; preventDefault?: () => void }) => boolean;
  getElementById: (id: string) => TestElement | null;
} {
  const body = new TestElement("body");
  const head = new TestElement("head");
  const listeners: Record<string, ((event: { preventDefault: () => void }) => void)[]> = {};
  return {
    body,
    head,
    title: "",
    contentType,
    createDocumentFragment: () => new TestElement("#fragment"),
    createElement: (tagName: string) => new TestElement(tagName.toLowerCase()),
    addEventListener: (type, listener) => {
      listeners[type] ??= [];
      listeners[type].push(listener);
    },
    dispatchEvent: (event) => {
      for (const listener of listeners[event.type] ?? []) listener({ preventDefault: event.preventDefault ?? vi.fn() });
      return true;
    },
    getElementById: (id) => [head, body].flatMap((root) => root.querySelectorAll("*")).find((element) => element.id === id) ?? null,
  };
}

function applyHtmlAttributes(element: TestElement, attributes: string): void {
  for (const [, name, value = ""] of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
    if (name.startsWith("data-")) {
      element.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
    } else if (name in element) {
      (element as unknown as Record<string, string>)[name] = value;
    }
  }
}

function toEntryIdentity(entry: FileBrowserEntry): FileBrowserEntry {
  return { name: entry.name, url: entry.url, type: entry.type };
}

async function waitForMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

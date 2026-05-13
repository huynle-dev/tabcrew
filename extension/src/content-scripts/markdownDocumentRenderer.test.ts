import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileBrowserEntry } from "./markdownDocumentRenderer.js";
import {
  addParentDirectoryEntry,
  buildFileTreeEntries,
  classifyFileBrowserFile,
  createMarkdownDocumentModel,
  createDocumentPreviewContainer,
  extractMarkdownHeadings,
  fetchDirectoryListing,
  getFileTreeIconPath,
  getParentDirectoryUrl,
  handleFileTreeFileClick,
  limitPreviewSource,
  MAX_TEXT_PREVIEW_CHARACTERS,
  markdownDocumentRenderer,
  shouldRenderFileBrowserShell,
  parseDirectoryListing,
  shouldPreviewFileBrowserEntry,
  shouldRenderMarkdownDocument,
  updateDocumentPreviewContainer,
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
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/src/app.ts", "application/octet-stream")).toBe(false);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/archive.zip", "application/zip")).toBe(false);
  });

  it("rejects image and SVG file previews instead of rendering them inline", () => {
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/logo.svg", "image/svg+xml")).toBe(false);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/photo.png", "image/png")).toBe(false);
    expect(shouldRenderFileBrowserShell("file:///Users/me/project/icon.svg", "text/plain")).toBe(false);
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
    const initialModel = createMarkdownDocumentModel("file:///Users/me/README.md", "# Readme\n\nHello");
    const nextModel = createMarkdownDocumentModel("file:///Users/me/guide.md", "# Guide\n\n## Steps\n\nUpdated");
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

  it("identifies only supported file entries as previewable", () => {
    expect(shouldPreviewFileBrowserEntry({ name: "README.md", url: "file:///Users/me/project/README.md", type: "file" })).toBe(
      true,
    );
    expect(shouldPreviewFileBrowserEntry({ name: "app.ts", url: "file:///Users/me/project/app.ts", type: "file" })).toBe(true);
    expect(shouldPreviewFileBrowserEntry({ name: "image.png", url: "file:///Users/me/project/image.png", type: "file" })).toBe(
      false,
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
      action: "chromeuse_fetch_directory_listing",
      url: "file:///Users/me/project/guide.md",
    });
    expect(doc.title).toBe("guide.md");
    expect(preview.title.textContent).toBe("guide.md");
    expect(preview.content.innerHTML).toContain('<h1 id="guide">Guide</h1>');
    expect(preview.raw.textContent).toBe("# Guide\n\nPreview body");
    expect(previousItem.classList.contains("active")).toBe(false);
    expect(item.classList.contains("active")).toBe(true);
  });

  it("leaves unsupported sidebar file clicks available for normal navigation", async () => {
    const doc = createTestDocument();
    const initialModel = createMarkdownDocumentModel("file:///Users/me/project/README.md", "# Readme");
    const preview = createDocumentPreviewContainer(doc as unknown as Document, initialModel);
    const preventDefault = vi.fn();

    const handled = await handleFileTreeFileClick(
      { preventDefault },
      doc as unknown as Document,
      { name: "archive.zip", url: "file:///Users/me/project/archive.zip", type: "file" },
      new TestElement("li") as unknown as HTMLElement,
      new TestElement("ul") as unknown as HTMLElement,
      { renderer: markdownDocumentRenderer, preview },
    );

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(preview.title.textContent).toBe("README.md");
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

class TestElement {
  readonly children: TestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  className = "";
  hidden = false;
  href = "";
  id = "";
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
    for (const match of value.matchAll(/<h([1-3])>(.*?)<\/h\1>/g)) {
      const heading = new TestElement(`h${match[1]}`);
      heading.textContent = match[2].replace(/<[^>]+>/g, "");
      this.children.push(heading);
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
    const selectors = selector.split(",").map((part) => part.trim().toLowerCase());
    const matches = (element: TestElement) =>
      selectors.some((part) => {
        const [tagName, className] = part.split(".");
        if (tagName && tagName !== element.tagName) return false;
        return !className || element.classList.contains(className);
      });
    const descendants = (element: TestElement): TestElement[] =>
      element.children.flatMap((child) => [child, ...descendants(child)]);
    return descendants(this).filter(matches);
  }
}

function createTestDocument(): { body: TestElement; title: string; createElement: (tagName: string) => TestElement } {
  return {
    body: new TestElement("body"),
    title: "",
    createElement: (tagName: string) => new TestElement(tagName.toLowerCase()),
  };
}

function toEntryIdentity(entry: FileBrowserEntry): FileBrowserEntry {
  return { name: entry.name, url: entry.url, type: entry.type };
}

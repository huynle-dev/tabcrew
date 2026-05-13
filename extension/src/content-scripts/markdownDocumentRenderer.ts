import mermaid from "mermaid";
import { renderMarkdown } from "../sidepanel/markdownRenderer.js";

export interface DocumentPreviewModel {
  readonly title: string;
  readonly source: string;
  readonly html: string;
  readonly outline: readonly DocumentOutlineEntry[];
}

export interface FileBrowserEntry {
  readonly name: string;
  readonly url: string;
  readonly type: "directory" | "file";
}

export interface DocumentOutlineEntry {
  readonly level: 1 | 2 | 3;
  readonly text: string;
  readonly id: string;
}

export interface DocumentPreviewRenderer<TModel extends DocumentPreviewModel = DocumentPreviewModel> {
  readonly shouldRender: (url: string, contentType: string) => boolean;
  readonly createModel: (url: string, source: string) => TModel;
  readonly renderContentEffects?: (doc: Document, model: TModel, content: HTMLElement) => void;
}

export interface MarkdownDocumentModel extends DocumentPreviewModel {
  readonly headings: readonly MarkdownHeading[];
}

export type MarkdownFileTreeEntry = FileBrowserEntry;
export type MarkdownHeading = DocumentOutlineEntry;

const MARKDOWN_DOCUMENT_RE = /\.(?:md|mdx|markdown)(?:[?#].*)?$/i;
const FILE_BROWSER_SUPPORTED_FILE_RE = /\.(?:cjs|css|go|htm|html|js|json|jsx|md|mdx|markdown|mjs|py|rs|svelte|ts|tsx|vue)(?:[?#].*)?$/i;
const MARKDOWN_CONTENT_TYPES = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/mdx",
]);

const DIRECTORY_LISTING_CONTENT_TYPES = new Set(["text/html"]);

const PLAIN_DOCUMENT_CONTENT_TYPES = new Set([
  "",
  "text/plain",
  "application/octet-stream",
]);

const FILE_BROWSER_FILE_CONTENT_TYPES = new Set([
  ...PLAIN_DOCUMENT_CONTENT_TYPES,
  "application/json",
  "application/javascript",
  "text/css",
  "text/html",
  "text/javascript",
]);

let hideDotFiles = true;

export function shouldRenderMarkdownDocument(url: string, contentType: string): boolean {
  const normalizedContentType = normalizeContentType(contentType);
  if (MARKDOWN_CONTENT_TYPES.has(normalizedContentType)) return true;
  return MARKDOWN_DOCUMENT_RE.test(url) && PLAIN_DOCUMENT_CONTENT_TYPES.has(normalizedContentType);
}

export function shouldRenderFileBrowserShell(url: string, contentType: string): boolean {
  if (!isFileUrl(url)) return false;

  const normalizedContentType = normalizeContentType(contentType);
  if (isLocalDirectoryListingUrl(url)) return DIRECTORY_LISTING_CONTENT_TYPES.has(normalizedContentType);

  return FILE_BROWSER_SUPPORTED_FILE_RE.test(url) && FILE_BROWSER_FILE_CONTENT_TYPES.has(normalizedContentType);
}

export function createMarkdownDocumentModel(url: string, source: string): MarkdownDocumentModel {
  const headings = extractMarkdownHeadings(source);
  return {
    title: titleFromUrl(url),
    source,
    html: renderMarkdown(source),
    outline: headings,
    headings,
  };
}

export const markdownDocumentRenderer: DocumentPreviewRenderer<MarkdownDocumentModel> = {
  shouldRender: (url, contentType) => shouldRenderMarkdownDocument(url, contentType) || shouldRenderFileBrowserShell(url, contentType),
  createModel: createMarkdownDocumentModel,
  renderContentEffects: (doc, _model, content) => renderMermaidDiagrams(doc, content),
};

export function extractMarkdownHeadings(source: string): MarkdownHeading[] {
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line): MarkdownHeading | null => {
      const match = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line.trim());
      if (!match) return null;
      const text = match[2].replace(/[`*_~[\]()]/g, "").trim();
      if (!text) return null;
      return {
        level: match[1].length as 1 | 2 | 3,
        text,
        id: slugifyHeading(text),
      };
    })
    .filter((heading): heading is MarkdownHeading => heading !== null);
}

function slugifyHeading(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return slug || "section";
}

export function getParentDirectoryUrl(fileUrl: string): string | null {
  try {
    const url = new URL(fileUrl);
    if (url.protocol !== "file:") return null;

    const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    const lastSlash = pathname.lastIndexOf("/");
    if (lastSlash < 0) return null;

    url.pathname = pathname.slice(0, lastSlash + 1);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function parseDirectoryListing(html: string, directoryUrl: string): MarkdownFileTreeEntry[] {
  const currentHref = new URL(directoryUrl).href;
  const anchorEntries = parseAnchorDirectoryListing(html, currentHref);
  if (anchorEntries.length) return sortEntries(anchorEntries);
  return sortEntries(parseChromeDirectoryListing(html, currentHref));
}

export function addParentDirectoryEntry(
  entries: readonly MarkdownFileTreeEntry[],
  directoryUrl: string,
): MarkdownFileTreeEntry[] {
  const parentUrl = getParentDirectoryUrl(directoryUrl);
  if (!parentUrl || parentUrl === directoryUrl) return [...entries];
  return [{ name: "..", url: parentUrl, type: "directory" }, ...entries];
}

export function buildFileTreeEntries(
  html: string,
  directoryUrl: string,
  includeParentEntry: boolean,
): MarkdownFileTreeEntry[] {
  const entries = parseDirectoryListing(html, directoryUrl);
  return includeParentEntry ? addParentDirectoryEntry(entries, directoryUrl) : entries;
}

function isMarkdownFileUrl(url: string): boolean {
  return MARKDOWN_DOCUMENT_RE.test(url);
}

function isFileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

function isLocalDirectoryListingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" && parsed.pathname.endsWith("/");
  } catch {
    return false;
  }
}

function normalizeContentType(contentType: string): string {
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

function parseAnchorDirectoryListing(html: string, currentHref: string): MarkdownFileTreeEntry[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("a[href]"))
    .map((anchor): MarkdownFileTreeEntry | null => {
      const href = anchor.getAttribute("href");
      if (!href || href === "../") return null;

      let url: URL;
      try {
        url = new URL(href, currentHref);
      } catch {
        return null;
      }

      if (url.protocol !== "file:" || url.href === currentHref) return null;
      const isDirectory = url.pathname.endsWith("/");
      if (!isDirectory && !isMarkdownFileUrl(url.href)) return null;

      const name = anchor.textContent?.trim().replace(/\/$/, "") || titleFromUrl(url.href);
      if (!name || name === "..") return null;
      return { name, url: url.href, type: isDirectory ? "directory" : "file" };
    })
    .filter((entry): entry is MarkdownFileTreeEntry => entry !== null);
}

function parseChromeDirectoryListing(html: string, currentHref: string): MarkdownFileTreeEntry[] {
  const rows = html.matchAll(/addRow\("((?:\\.|[^"\\])*)",\s*"((?:\\.|[^"\\])*)",\s*(\d)/g);
  return Array.from(rows)
    .map(([, rawName, rawHref, rawType]): MarkdownFileTreeEntry | null => {
      const name = parseJSONString(rawName).replace(/\/$/, "");
      const href = parseJSONString(rawHref);
      if (!name || name === ".." || !href) return null;

      let url: URL;
      try {
        url = new URL(href, currentHref);
      } catch {
        return null;
      }

      const isDirectory = rawType === "1";
      if (url.protocol !== "file:" || (!isDirectory && !isMarkdownFileUrl(url.href))) return null;
      if (isDirectory && !url.pathname.endsWith("/")) url.pathname += "/";
      return { name, url: url.href, type: isDirectory ? "directory" : "file" };
    })
    .filter((entry): entry is MarkdownFileTreeEntry => entry !== null);
}

function parseJSONString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function sortEntries(entries: MarkdownFileTreeEntry[]): MarkdownFileTreeEntry[] {
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).at(-1);
    return lastSegment ? decodeURIComponent(lastSegment) : "Markdown Document";
  } catch {
    const lastSegment = url.split(/[?#]/, 1)[0].split("/").filter(Boolean).at(-1);
    return lastSegment ? decodeURIComponent(lastSegment) : "Markdown Document";
  }
}

function readDocumentSource(doc: Document): string {
  const pre = doc.body.querySelector("pre");
  return (pre?.textContent ?? doc.body.textContent ?? "").trimEnd();
}

function getChromeUseIconUrl(size: 16 | 48 = 16): string | null {
  if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return null;
  return chrome.runtime.getURL(`assets/icon-${size}.png`);
}

export function getFileTreeIconPath(entry: MarkdownFileTreeEntry): string {
  if (entry.type === "directory") return "assets/devicons/folder.svg";

  const name = entry.name.toLowerCase();
  const extension = name.includes(".") ? name.split(".").at(-1) : "";

  if (name === "package.json" || name === "package-lock.json" || name === "npm-shrinkwrap.json") {
    return "assets/devicons/npm.svg";
  }
  if (name === ".gitignore" || name === ".gitattributes" || name === ".gitmodules") return "assets/devicons/git.svg";

  switch (extension) {
    case "md":
    case "mdx":
    case "markdown":
      return "assets/devicons/markdown.svg";
    case "tsx":
    case "jsx":
      return "assets/devicons/react.svg";
    case "ts":
      return "assets/devicons/typescript.svg";
    case "js":
    case "mjs":
    case "cjs":
      return "assets/devicons/javascript.svg";
    case "json":
      return "assets/devicons/json.svg";
    case "html":
    case "htm":
      return "assets/devicons/html5.svg";
    case "css":
      return "assets/devicons/css3.svg";
    case "py":
      return "assets/devicons/python.svg";
    case "vue":
      return "assets/devicons/vuejs.svg";
    case "svelte":
      return "assets/devicons/svelte.svg";
    case "go":
      return "assets/devicons/go.svg";
    case "rs":
      return "assets/devicons/rust.svg";
    default:
      return "assets/devicons/file.svg";
  }
}

function getFileTreeIconUrl(entry: MarkdownFileTreeEntry): string | null {
  if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return null;
  return chrome.runtime.getURL(getFileTreeIconPath(entry));
}

function createFileTreeIcon(doc: Document, entry: MarkdownFileTreeEntry): HTMLElement {
  const iconUrl = getFileTreeIconUrl(entry);
  if (!iconUrl) {
    const fallback = doc.createElement("span");
    fallback.className = entry.type === "directory" ? "chromeuse-markdown-icon-folder" : "chromeuse-markdown-icon-file";
    fallback.textContent = entry.type === "directory" ? "▢" : "•";
    return fallback;
  }

  const icon = doc.createElement("img");
  icon.className = "chromeuse-markdown-icon-image";
  icon.src = iconUrl;
  icon.alt = "";
  return icon;
}

function setPageIcon(doc: Document): void {
  const iconUrl = getChromeUseIconUrl(16);
  if (!iconUrl) return;

  for (const existing of Array.from(doc.head.querySelectorAll('link[rel~="icon"]'))) {
    existing.remove();
  }

  const icon = doc.createElement("link");
  icon.rel = "icon";
  icon.type = "image/png";
  icon.href = iconUrl;
  doc.head.appendChild(icon);
}

function createStyle(doc: Document): HTMLStyleElement {
  const style = doc.createElement("style");
  style.textContent = `
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a;
      color: #e2e8f0;
    }

    body.chromeuse-markdown-document {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(59, 130, 246, 0.18), transparent 30rem),
        #0f172a;
    }

    .chromeuse-markdown-shell {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(0, 920px);
      gap: 24px;
      box-sizing: border-box;
      width: min(1240px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 40px 0 64px;
    }

    .chromeuse-markdown-sidebar {
      position: sticky;
      top: 24px;
      align-self: start;
      max-height: calc(100vh - 48px);
      overflow: auto;
      padding: 18px 14px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      border-radius: 20px;
      background: rgba(15, 23, 42, 0.76);
      box-shadow: 0 20px 60px rgba(15, 23, 42, 0.28);
    }

    .chromeuse-markdown-sidebar-title {
      overflow: hidden;
      margin-bottom: 12px;
      color: #cbd5e1;
      font-size: 11px;
      font-weight: 750;
      letter-spacing: 0.12em;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .chromeuse-markdown-file-tree {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chromeuse-markdown-file-tree .chromeuse-markdown-file-tree {
      margin-left: 14px;
      padding-left: 14px;
      border-left: 1px solid rgba(148, 163, 184, 0.2);
    }

    .chromeuse-markdown-file-tree button,
    .chromeuse-markdown-file-tree a {
      display: flex;
      width: 100%;
      min-height: 32px;
      align-items: center;
      gap: 8px;
      border: 0;
      border-radius: 10px;
      padding: 5px 8px;
      color: #cbd5e1;
      background: transparent;
      font: inherit;
      font-size: 13px;
      text-align: left;
      text-decoration: none;
      cursor: pointer;
    }

    .chromeuse-markdown-file-tree button:hover,
    .chromeuse-markdown-file-tree a:hover {
      color: #93c5fd;
      background: rgba(148, 163, 184, 0.12);
    }

    .chromeuse-markdown-file-tree li.active > a {
      color: #bfdbfe;
      background: rgba(59, 130, 246, 0.18);
      font-weight: 700;
    }

    .chromeuse-markdown-caret {
      width: 12px;
      opacity: 0.7;
      transition: transform 0.12s;
    }

    .chromeuse-markdown-file-tree li.expanded > button .chromeuse-markdown-caret {
      transform: rotate(90deg);
    }

    .chromeuse-markdown-file-tree-message {
      color: #94a3b8;
      font-size: 13px;
      line-height: 1.4;
    }

    .chromeuse-markdown-main {
      min-width: 0;
    }

    .chromeuse-markdown-title {
      margin: 0 0 20px;
      color: #f8fafc;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .chromeuse-markdown-content {
      padding: 32px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      border-radius: 22px;
      background: rgba(15, 23, 42, 0.82);
      box-shadow: 0 24px 80px rgba(15, 23, 42, 0.42);
      line-height: 1.7;
    }

    .chromeuse-markdown-content h1,
    .chromeuse-markdown-content h2,
    .chromeuse-markdown-content h3 {
      color: #f8fafc;
      line-height: 1.2;
    }

    .chromeuse-markdown-content a { color: #93c5fd; }
    .chromeuse-markdown-content code {
      border-radius: 6px;
      background: rgba(148, 163, 184, 0.14);
      padding: 0.15em 0.35em;
    }
    .chromeuse-markdown-content pre {
      overflow: auto;
      border-radius: 12px;
      background: rgba(2, 6, 23, 0.74);
      padding: 16px;
    }
    .chromeuse-markdown-content pre code { background: transparent; padding: 0; }
    .chromeuse-markdown-content blockquote {
      margin-inline: 0;
      border-left: 3px solid #60a5fa;
      padding-left: 16px;
      color: #cbd5e1;
    }
    .chromeuse-markdown-content table {
      width: 100%;
      border-collapse: collapse;
    }
    .chromeuse-markdown-content th,
    .chromeuse-markdown-content td {
      border: 1px solid rgba(148, 163, 184, 0.28);
      padding: 8px 10px;
    }

    @media (prefers-color-scheme: light) {
      :root { background: #f8fafc; color: #1e293b; }
      body.chromeuse-markdown-document { background: #f8fafc; }
      .chromeuse-markdown-title,
      .chromeuse-markdown-content h1,
      .chromeuse-markdown-content h2,
      .chromeuse-markdown-content h3 { color: #0f172a; }
      .chromeuse-markdown-content {
        background: #ffffff;
        border-color: #e2e8f0;
        box-shadow: 0 24px 80px rgba(15, 23, 42, 0.12);
      }
      .chromeuse-markdown-content pre { background: #f1f5f9; }
      .chromeuse-markdown-content code { background: #e2e8f0; }
      .chromeuse-markdown-sidebar {
        background: #ffffff;
        border-color: #e2e8f0;
        box-shadow: 0 24px 80px rgba(15, 23, 42, 0.1);
      }
      .chromeuse-markdown-sidebar-title,
      .chromeuse-markdown-file-tree button,
      .chromeuse-markdown-file-tree a { color: #475569; }
    }

    @media (max-width: 860px) {
      .chromeuse-markdown-shell {
        grid-template-columns: 1fr;
      }

      .chromeuse-markdown-sidebar {
        position: static;
        max-height: 40vh;
      }
    }

    /* MD Reader style page shell */
    :root {
      color-scheme: light;
      background: #ffffff;
      color: #25364d;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body.chromeuse-markdown-document {
      margin: 0;
      min-height: 100vh;
      background: #ffffff;
      color: #25364d;
    }

    body.chromeuse-theme-dark.chromeuse-markdown-document {
      background: #101827;
      color: #dbe4f0;
    }

    body.chromeuse-theme-dark .chromeuse-markdown-sidebar {
      border-right-color: #253246;
      background: #111c2d;
    }

    body.chromeuse-theme-dark .chromeuse-markdown-content,
    body.chromeuse-theme-dark .chromeuse-markdown-content h1,
    body.chromeuse-theme-dark .chromeuse-markdown-content h2,
    body.chromeuse-theme-dark .chromeuse-markdown-content h3,
    body.chromeuse-theme-dark .chromeuse-markdown-sidebar-title,
    body.chromeuse-theme-dark .chromeuse-markdown-file-tree button,
    body.chromeuse-theme-dark .chromeuse-markdown-file-tree a,
    body.chromeuse-theme-dark .chromeuse-markdown-toc-list a {
      color: #dbe4f0;
    }

    body.chromeuse-theme-dark .chromeuse-markdown-side-switch {
      border-color: #253246;
      background: #182338;
    }

    body.chromeuse-theme-dark .chromeuse-markdown-side-switch button.active,
    body.chromeuse-theme-dark .chromeuse-markdown-file-tree li.active > a,
    body.chromeuse-theme-dark .chromeuse-markdown-icon-button,
    body.chromeuse-theme-dark .chromeuse-markdown-options-menu {
      background: #1c2940;
    }

    body.chromeuse-theme-dark .chromeuse-markdown-content code,
    body.chromeuse-theme-dark .chromeuse-markdown-content pre {
      background: #182338;
      color: #dbe4f0;
    }

    .chromeuse-markdown-shell {
      display: block;
      width: 100%;
      margin: 0;
      padding: 0;
    }

    .chromeuse-markdown-sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      width: 340px;
      max-height: none;
      overflow: auto;
      padding: 34px 12px 28px;
      border: 0;
      border-right: 1px solid #e3e7ee;
      border-radius: 0;
      background: #fafbfc;
      box-shadow: none;
    }

    .chromeuse-markdown-side-switch {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      margin: 0 8px 24px;
      padding: 6px;
      border: 1px solid #e7eaf0;
      border-radius: 20px;
      background: #f0f1f3;
    }

    .chromeuse-markdown-side-switch button {
      height: 42px;
      border: 0;
      border-radius: 14px;
      color: #4b5563;
      background: transparent;
      font: inherit;
      font-size: 15px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
    }

    .chromeuse-markdown-side-switch button.active {
      color: #5b7fdd;
      background: #ffffff;
      box-shadow: 0 14px 30px rgba(30, 41, 59, 0.1), inset 0 0 0 1px rgba(226, 232, 240, 0.8);
    }

    .chromeuse-markdown-side-panel[hidden] {
      display: none;
    }

    .chromeuse-markdown-sidebar-title {
      margin: 0 13px 18px;
      color: #4b5563;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.22em;
      text-transform: uppercase;
    }

    .chromeuse-markdown-file-tree {
      margin: 0;
      padding: 0;
      color: #4b5563;
      list-style: none;
    }

    .chromeuse-markdown-file-tree .chromeuse-markdown-file-tree {
      margin-left: 18px;
      padding-left: 10px;
      border-left: 1px solid #e5e7eb;
    }

    .chromeuse-markdown-file-tree button,
    .chromeuse-markdown-file-tree a,
    .chromeuse-markdown-toc-list a {
      display: flex;
      width: 100%;
      min-height: 42px;
      align-items: center;
      gap: 10px;
      box-sizing: border-box;
      border: 0;
      border-radius: 11px;
      padding: 6px 13px;
      color: #4b5563;
      background: transparent;
      font: inherit;
      font-size: 17px;
      line-height: 1.25;
      text-align: left;
      text-decoration: none;
      cursor: pointer;
    }

    .chromeuse-markdown-file-tree button:hover,
    .chromeuse-markdown-file-tree a:hover,
    .chromeuse-markdown-toc-list a:hover {
      color: #5b7fdd;
      background: rgba(91, 127, 221, 0.08);
    }

    .chromeuse-markdown-file-tree li.active > a {
      color: #5b7fdd;
      background: #e6ebff;
      font-weight: 800;
    }

    .chromeuse-markdown-caret {
      flex: 0 0 12px;
      width: 12px;
      color: #9ca3af;
      font-size: 12px;
    }

    .chromeuse-markdown-icon-folder,
    .chromeuse-markdown-icon-file,
    .chromeuse-markdown-icon-image {
      flex: 0 0 18px;
      width: 18px;
      height: 18px;
      color: #9aa1aa;
      font-size: 15px;
      font-weight: 800;
      text-align: center;
    }

    .chromeuse-markdown-icon-image {
      border-radius: 5px;
      object-fit: contain;
    }

    .chromeuse-markdown-file-name,
    .chromeuse-markdown-toc-text {
      overflow: hidden;
      min-width: 0;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chromeuse-markdown-file-tree-message {
      padding: 0 13px;
      color: #8b949e;
      font-size: 14px;
    }

    .chromeuse-markdown-main {
      min-width: 0;
      margin-left: 340px;
      padding: 68px 62px 80px;
    }

    .chromeuse-markdown-content {
      max-width: 1760px;
      margin: 0 auto;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      color: #25364d;
      font-size: 21px;
      line-height: 1.6;
    }

    .chromeuse-markdown-title {
      display: none;
    }

    .chromeuse-markdown-content h1 {
      margin: 0 0 44px;
      color: #28384f;
      font-size: 36px;
      line-height: 1.2;
      text-align: center;
    }

    .chromeuse-markdown-content h2 {
      margin: 52px 0 22px;
      padding-bottom: 18px;
      border-bottom: 1px solid #cbd5e1;
      color: #28384f;
      font-size: 28px;
      line-height: 1.2;
    }

    .chromeuse-markdown-content h3 {
      margin: 30px 0 13px;
      color: #28384f;
      font-size: 23px;
    }

    .chromeuse-markdown-content p {
      margin: 0 0 22px;
    }

    .chromeuse-markdown-content ul,
    .chromeuse-markdown-content ol {
      margin: 0 0 28px 28px;
      padding-left: 18px;
    }

    .chromeuse-markdown-content li {
      margin: 9px 0;
    }

    .chromeuse-markdown-content a,
    .chromeuse-markdown-content code {
      color: #5b7fdd;
    }

    .chromeuse-markdown-content code {
      padding: 0.08em 0.28em;
      border-radius: 8px;
      background: #f2f5fb;
      font-size: 0.86em;
    }

    .chromeuse-markdown-content pre {
      position: relative;
      overflow: auto;
      margin: 28px 0;
      padding: 20px;
      border-radius: 8px;
      background: #f3f6fb;
      color: #1f2937;
      font-size: 16px;
    }

    .chromeuse-markdown-content pre::after {
      content: "text";
      position: absolute;
      top: 12px;
      right: 15px;
      color: #9ca3af;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 15px;
    }

    .chromeuse-markdown-content pre code {
      background: transparent;
      color: inherit;
      padding: 0;
    }

    .chromeuse-markdown-top-left,
    .chromeuse-markdown-top-actions {
      position: fixed;
      z-index: 20;
      top: 32px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .chromeuse-markdown-top-left {
      left: 372px;
    }

    .chromeuse-markdown-top-actions {
      right: 40px;
    }

    .chromeuse-markdown-top-actions.open .chromeuse-markdown-options-menu {
      display: block;
    }

    .chromeuse-markdown-icon-button {
      min-width: 34px;
      height: 34px;
      border: 1px solid transparent;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.78);
      color: #b8bec6;
      font: inherit;
      font-size: 19px;
      font-weight: 800;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .chromeuse-markdown-icon-button:hover {
      color: #5b7fdd;
      border-color: #e3e7ee;
      background: #ffffff;
    }

    .chromeuse-markdown-options-menu {
      position: absolute;
      top: 44px;
      right: 0;
      display: none;
      width: 240px;
      padding: 14px;
      border: 1px solid #e3e7ee;
      border-radius: 16px;
      background: #ffffff;
      box-shadow: 0 18px 50px rgba(15, 23, 42, 0.14);
      color: #4b5563;
      font-size: 13px;
    }

    .chromeuse-markdown-options-title {
      margin-bottom: 12px;
      color: #25364d;
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .chromeuse-markdown-options-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }

    .chromeuse-markdown-options-row strong,
    .chromeuse-markdown-options-label {
      display: block;
      margin-bottom: 4px;
      color: #25364d;
      font-weight: 750;
    }

    .chromeuse-markdown-options-row small {
      display: block;
      color: #7b8492;
      line-height: 1.35;
    }

    .chromeuse-markdown-options-theme {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }

    .chromeuse-markdown-options-theme button {
      min-height: 30px;
      border: 1px solid #e3e7ee;
      border-radius: 9px;
      background: #f8fafc;
      color: #4b5563;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }

    .chromeuse-markdown-options-theme button.active {
      border-color: #5b7fdd;
      color: #5b7fdd;
      background: #eef2ff;
    }

    .chromeuse-markdown-raw-view {
      display: none;
      box-sizing: border-box;
      width: min(1120px, calc(100vw - 64px));
      min-height: calc(100vh - 96px);
      margin: 48px auto;
      padding: 24px;
      border: 1px solid #e3e7ee;
      border-radius: 14px;
      background: #f8fafc;
      color: #25364d;
      font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: pre-wrap;
    }

    body.chromeuse-raw-visible .chromeuse-markdown-shell {
      display: none;
    }

    body.chromeuse-raw-visible .chromeuse-markdown-raw-view {
      display: block;
    }

    .chromeuse-markdown-rail-toggle {
      min-width: 26px;
      width: 26px;
      height: 26px;
      border: 2px solid #b8bec6;
      border-radius: 4px;
      background: linear-gradient(90deg, transparent 40%, #b8bec6 40%, #b8bec6 52%, transparent 52%);
    }

    .chromeuse-markdown-toc-list {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chromeuse-markdown-toc-list a {
      min-height: 34px;
      font-size: 15px;
    }

    .chromeuse-markdown-toc-level-2 a {
      padding-left: 24px;
    }

    .chromeuse-markdown-toc-level-3 a {
      padding-left: 38px;
      font-size: 14px;
    }

    body.chromeuse-sidebar-collapsed .chromeuse-markdown-sidebar {
      transform: translateX(-340px);
    }

    body.chromeuse-sidebar-collapsed .chromeuse-markdown-main {
      margin-left: 0;
    }

    body.chromeuse-sidebar-collapsed .chromeuse-markdown-top-left {
      left: 38px;
    }

    @media (max-width: 900px) {
      .chromeuse-markdown-sidebar {
        width: 280px;
      }
      .chromeuse-markdown-main {
        margin-left: 280px;
        padding: 64px 24px;
      }
      .chromeuse-markdown-top-left {
        left: 308px;
      }
    }
  `;
  return style;
}

export async function fetchDirectoryListing(directoryUrl: string): Promise<string> {
  let extensionFetchError: unknown;

  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "chromeuse_fetch_directory_listing",
        url: directoryUrl,
      });
      if (response?.ok && typeof response.html === "string") return response.html;
      if (typeof response === "string") return response;
      extensionFetchError = new Error(response?.error ?? "Extension fetch failed");
    } catch (error) {
      extensionFetchError = error;
    }
  }

  try {
    const response = await fetch(directoryUrl);
    if (!response.ok && !isFileUrl(directoryUrl)) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } catch (error) {
    if (extensionFetchError) {
      const extensionMessage = extensionFetchError instanceof Error ? extensionFetchError.message : String(extensionFetchError);
      const pageMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to load files: extension fetch failed (${extensionMessage}); page fetch failed (${pageMessage})`);
    }
    throw error;
  }
}

function renderFileTreeEntry(
  doc: Document,
  entry: MarkdownFileTreeEntry,
  currentUrl: string,
  navigationList: HTMLElement,
): HTMLElement {
  const item = doc.createElement("li");
  item.className = `chromeuse-markdown-file-tree-entry chromeuse-markdown-file-tree-entry-${entry.type}`;

  if (entry.type === "directory") {
    const button = doc.createElement("button");
    button.type = "button";
    const caret = doc.createElement("span");
    caret.className = "chromeuse-markdown-caret";
    caret.textContent = "▸";
    const icon = entry.name === ".." ? doc.createElement("span") : createFileTreeIcon(doc, entry);
    if (entry.name === "..") {
      icon.className = "chromeuse-markdown-icon-folder";
      icon.textContent = "↑";
    }
    const name = doc.createElement("span");
    name.className = "chromeuse-markdown-file-name";
    name.textContent = entry.name;
    button.append(caret, icon, name);

    if (entry.name === "..") {
      caret.textContent = "";
      button.addEventListener("click", () => {
        void loadFileTreeDirectory(doc, entry.url, navigationList, currentUrl, true, navigationList);
      });
      item.appendChild(button);
      return item;
    }

    const childList = doc.createElement("ul");
    childList.className = "chromeuse-markdown-file-tree";
    childList.hidden = true;

    button.addEventListener("click", () => {
      const expanded = item.classList.toggle("expanded");
      childList.hidden = !expanded;
      if (expanded && !childList.dataset.loaded) {
        childList.dataset.loaded = "true";
        void loadFileTreeDirectory(doc, entry.url, childList, currentUrl, false, navigationList);
      }
    });

    item.append(button, childList);
    return item;
  }

  const link = doc.createElement("a");
  link.href = entry.url;
  const spacer = doc.createElement("span");
  spacer.style.width = "12px";
  spacer.style.flex = "0 0 12px";
  const icon = createFileTreeIcon(doc, entry);
  const name = doc.createElement("span");
  name.className = "chromeuse-markdown-file-name";
  name.textContent = entry.name;
  link.append(spacer, icon, name);
  if (entry.url === currentUrl) item.classList.add("active");
  item.appendChild(link);
  return item;
}

async function loadFileTreeDirectory(
  doc: Document,
  directoryUrl: string,
  list: HTMLElement,
  currentUrl: string,
  includeParentEntry = true,
  navigationList: HTMLElement = list,
): Promise<void> {
  list.textContent = "Loading...";
  try {
    const html = await fetchDirectoryListing(directoryUrl);
    const entries = buildFileTreeEntries(html, directoryUrl, includeParentEntry).filter(
      (entry) => !hideDotFiles || entry.name === ".." || !entry.name.startsWith("."),
    );
    list.replaceChildren();

    if (!entries.length) {
      list.textContent = "No markdown files";
      return;
    }

    for (const entry of entries) list.appendChild(renderFileTreeEntry(doc, entry, currentUrl, navigationList));
  } catch (error) {
    list.textContent = error instanceof Error ? error.message : "Unable to load files";
  }
}

function createTocList(doc: Document, headings: readonly DocumentOutlineEntry[]): HTMLElement {
  const list = doc.createElement("ul");
  list.className = "chromeuse-markdown-toc-list";

  if (!headings.length) {
    const empty = doc.createElement("div");
    empty.className = "chromeuse-markdown-file-tree-message";
    empty.textContent = "No headings";
    return empty;
  }

  for (const heading of headings) {
    const item = doc.createElement("li");
    item.className = `chromeuse-markdown-toc-level-${heading.level}`;
    const link = doc.createElement("a");
    link.href = `#${heading.id}`;
    link.innerHTML = `<span class="chromeuse-markdown-toc-text"></span>`;
    link.firstElementChild!.textContent = heading.text;
    item.appendChild(link);
    list.appendChild(item);
  }

  return list;
}

function createSideSwitch(doc: Document, filesPanel: HTMLElement, tocPanel: HTMLElement): HTMLElement {
  const switcher = doc.createElement("div");
  switcher.className = "chromeuse-markdown-side-switch";

  const filesButton = doc.createElement("button");
  filesButton.type = "button";
  filesButton.textContent = "Files";
  filesButton.className = "active";

  const tocButton = doc.createElement("button");
  tocButton.type = "button";
  tocButton.textContent = "TOC";

  const activate = (mode: "files" | "toc") => {
    const filesActive = mode === "files";
    filesButton.classList.toggle("active", filesActive);
    tocButton.classList.toggle("active", !filesActive);
    filesPanel.hidden = !filesActive;
    tocPanel.hidden = filesActive;
  };

  filesButton.addEventListener("click", () => activate("files"));
  tocButton.addEventListener("click", () => activate("toc"));
  switcher.append(filesButton, tocButton);
  return switcher;
}

function createFileTreeSidebar(doc: Document, currentUrl: string, headings: readonly DocumentOutlineEntry[]): HTMLElement | null {
  const parentDirectoryUrl = getParentDirectoryUrl(currentUrl);
  if (!parentDirectoryUrl) return null;

  const sidebar = doc.createElement("aside");
  sidebar.className = "chromeuse-markdown-sidebar";

  const filesPanel = doc.createElement("section");
  filesPanel.className = "chromeuse-markdown-side-panel";

  const tocPanel = doc.createElement("section");
  tocPanel.className = "chromeuse-markdown-side-panel";
  tocPanel.hidden = true;

  const title = doc.createElement("div");
  title.className = "chromeuse-markdown-sidebar-title";
  title.textContent = titleFromUrl(parentDirectoryUrl) || "Files";

  const list = doc.createElement("ul");
  list.className = "chromeuse-markdown-file-tree";
  filesPanel.append(title, list);
  tocPanel.appendChild(createTocList(doc, headings));
  sidebar.append(createSideSwitch(doc, filesPanel, tocPanel), filesPanel, tocPanel);
  void loadFileTreeDirectory(doc, parentDirectoryUrl, list, currentUrl);
  doc.addEventListener("chromeuse_hide_dotfiles_changed", () => {
    void loadFileTreeDirectory(doc, parentDirectoryUrl, list, currentUrl);
  });
  return sidebar;
}

function applyHeadingIds(content: HTMLElement, headings: readonly DocumentOutlineEntry[]): void {
  const elements = Array.from(content.querySelectorAll("h1, h2, h3"));
  for (let i = 0; i < elements.length && i < headings.length; i++) {
    elements[i].id = headings[i].id;
  }
}

function renderMermaidDiagrams(doc: Document, content: HTMLElement): void {
  const diagrams = Array.from(content.querySelectorAll<HTMLElement>(".mermaid"));
  if (!diagrams.length) return;

  mermaid.initialize({
    startOnLoad: false,
    theme: doc.body.classList.contains("chromeuse-theme-dark") ? "dark" : "default",
  });
  mermaid.run({ nodes: diagrams }).catch((error: unknown) => {
    console.error("Mermaid rendering error:", error);
  });
}

function createOptionsMenu(doc: Document): HTMLElement {
  const menu = doc.createElement("div");
  menu.className = "chromeuse-markdown-options-menu";
  menu.innerHTML = `
    <div class="chromeuse-markdown-options-title">Options</div>
    <label class="chromeuse-markdown-options-row">
      <span>
        <strong>Hide dotfiles</strong>
        <small>Hide files and folders starting with a dot.</small>
      </span>
      <input type="checkbox" data-option="hide-dotfiles" />
    </label>
    <div class="chromeuse-markdown-options-label">Theme</div>
    <div class="chromeuse-markdown-options-theme">
      <button type="button" data-theme="light">Light</button>
      <button type="button" data-theme="dark">Dark</button>
      <button type="button" data-theme="auto">Auto</button>
    </div>
  `;

  const hideDotFilesInput = menu.querySelector<HTMLInputElement>('[data-option="hide-dotfiles"]');
  if (hideDotFilesInput) {
    hideDotFilesInput.checked = hideDotFiles;
    hideDotFilesInput.addEventListener("change", () => {
      hideDotFiles = hideDotFilesInput.checked;
      doc.dispatchEvent(new CustomEvent("chromeuse_hide_dotfiles_changed"));
    });
  }

  const setTheme = (theme: string) => {
    const dark = theme === "dark" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    doc.body.classList.toggle("chromeuse-theme-dark", dark);
    menu.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((button) => {
      button.classList.toggle("active", button.dataset.theme === theme);
    });
  };

  menu.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((button) => {
    button.addEventListener("click", () => setTheme(button.dataset.theme ?? "light"));
  });
  setTheme("light");

  return menu;
}

function createTopControls(doc: Document, source: string): DocumentFragment {
  const fragment = doc.createDocumentFragment();

  const left = doc.createElement("div");
  left.className = "chromeuse-markdown-top-left";
  const railToggle = doc.createElement("button");
  railToggle.type = "button";
  railToggle.className = "chromeuse-markdown-icon-button chromeuse-markdown-rail-toggle";
  railToggle.title = "Toggle side";
  railToggle.addEventListener("click", () => doc.body.classList.toggle("chromeuse-sidebar-collapsed"));
  left.appendChild(railToggle);

  const actions = doc.createElement("div");
  actions.className = "chromeuse-markdown-top-actions";
  const more = doc.createElement("button");
  more.type = "button";
  more.className = "chromeuse-markdown-icon-button";
  more.textContent = "•••";
  more.title = "More";
  const optionsMenu = createOptionsMenu(doc);
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    actions.classList.toggle("open");
  });
  optionsMenu.addEventListener("click", (event) => event.stopPropagation());
  doc.addEventListener("click", () => actions.classList.remove("open"));

  const code = doc.createElement("button");
  code.type = "button";
  code.className = "chromeuse-markdown-icon-button";
  code.textContent = "</>";
  code.title = "Toggle raw";
  code.addEventListener("click", () => doc.body.classList.toggle("chromeuse-raw-visible"));
  const raw = doc.createElement("pre");
  raw.className = "chromeuse-markdown-raw-view";
  raw.textContent = source;
  actions.append(more, code, optionsMenu);

  fragment.append(left, actions, raw);
  return fragment;
}

export function renderCurrentPreviewDocument<TModel extends DocumentPreviewModel>(
  renderer: DocumentPreviewRenderer<TModel>,
  doc: Document = document,
  url: string = location.href,
): boolean {
  if (!doc.body || doc.getElementById("chromeuse-markdown-shell")) return false;
  if (!renderer.shouldRender(url, doc.contentType)) return false;

  const model = renderer.createModel(url, readDocumentSource(doc));
  doc.title = model.title;
  setPageIcon(doc);
  doc.head.appendChild(createStyle(doc));

  const shell = doc.createElement("main");
  shell.id = "chromeuse-markdown-shell";
  shell.className = "chromeuse-markdown-shell";

  const main = doc.createElement("section");
  main.className = "chromeuse-markdown-main";

  const title = doc.createElement("div");
  title.className = "chromeuse-markdown-title";
  title.textContent = model.title;

  const content = doc.createElement("article");
  content.className = "chromeuse-markdown-content";
  content.innerHTML = model.html;
  applyHeadingIds(content, model.outline);

  main.append(title, content);
  const sidebar = createFileTreeSidebar(doc, url, model.outline);
  if (sidebar) shell.append(sidebar);
  shell.append(main);
  doc.body.className = `${doc.body.className} chromeuse-markdown-document`.trim();
  doc.body.replaceChildren(createTopControls(doc, model.source), shell);
  renderer.renderContentEffects?.(doc, model, content);
  return true;
}

export function renderCurrentMarkdownDocument(doc: Document = document, url: string = location.href): boolean {
  return renderCurrentPreviewDocument(markdownDocumentRenderer, doc, url);
}

if (typeof document !== "undefined") {
  renderCurrentMarkdownDocument();
}

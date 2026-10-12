import { describe, expect, it } from "vitest";
import { inspectOpencode, parseJsonc, removeOpencodeEntry, tokenFileRef, upsertOpencode } from "./opencode.js";

const OPTS = { url: "http://127.0.0.1:8770/mcp", tokenRef: "{file:~/.tabcrew/token}" };

const V2 = `{
  // top comment
  "mcp": {
    "servers": {
      "brain": { "type": "remote", "url": "https://brain.example/mcp" }, // compact neighbour
      /* block comment */
      "other": {
        "type": "local",
        "command": ["x"]
      }
    }
  }
}
`;

const V1 = `{
    // four-space file
    "model": "m",
    "mcp": {
        "context7": { "type": "remote", "url": "https://c7.example/mcp" }
    },
}
`;

describe("OpenCode config editing", () => {
  it("adds tabcrew under mcp.servers (V2) with object timeouts, preserving comments and neighbours", () => {
    const { text, change } = upsertOpencode(V2, OPTS, "replace");
    expect(change).toBe("added");
    expect(text).toContain("// top comment");
    expect(text).toContain("/* block comment */");
    expect(text).toContain('"brain": { "type": "remote", "url": "https://brain.example/mcp" }, // compact neighbour');
    expect(text.startsWith(V2.slice(0, V2.indexOf('"other"')))).toBe(true);
    expect(parseJsonc(text)).toEqual({
      mcp: {
        servers: {
          brain: { type: "remote", url: "https://brain.example/mcp" },
          other: { type: "local", command: ["x"] },
          tabcrew: {
            type: "remote",
            url: OPTS.url,
            headers: { Authorization: "Bearer {file:~/.tabcrew/token}" },
            oauth: false,
            timeout: { catalog: 30000, execution: 600000 },
          },
        },
      },
    });
    expect(text).toContain('\n      "tabcrew": {\n        "type": "remote",');
  });

  it("adds tabcrew directly under mcp (V1) with a numeric timeout, matching the file's indentation", () => {
    const { text, change } = upsertOpencode(V1, OPTS, "replace");
    expect(change).toBe("added");
    expect(text).toContain("// four-space file");
    expect(text).toContain('"context7": { "type": "remote", "url": "https://c7.example/mcp" }');
    expect(text).toContain('\n        "tabcrew": {\n            "type": "remote",');
    expect((parseJsonc(text).mcp as Record<string, unknown>).tabcrew).toMatchObject({ timeout: 600000, enabled: true, oauth: false });
  });

  it("creates mcp when the file has none", () => {
    const { text } = upsertOpencode('{\n  "model": "m" // keep\n}\n', OPTS, "replace");
    expect(text).toContain("// keep");
    expect(inspectOpencode(text)).toMatchObject({ layout: "flat", entry: { url: OPTS.url } });
    expect(upsertOpencode("{}", OPTS, "replace").text).toContain('"tabcrew"');
  });

  it("is idempotent and only fixes fields that differ on an existing entry", () => {
    const once = upsertOpencode(V2, OPTS, "replace").text;
    expect(upsertOpencode(once, OPTS, "replace")).toEqual({ text: once, change: "unchanged" });
    const moved = upsertOpencode(once, { ...OPTS, url: "http://127.0.0.1:9000/mcp" }, "replace");
    expect(moved.change).toBe("updated");
    expect(moved.text.replace("9000", "8770")).toBe(once);
  });

  it("replaces a chromeuse entry in place, keeping its timeout and extra settings", () => {
    const legacy = `{
  "mcp": {
    "servers": {
      // browser automation
      "chromeuse": {
        "type": "remote",
        "url": "http://127.0.0.1:8770/mcp",
        "headers": { "Authorization": "Bearer {file:~/.chromeuse/token}" },
        "oauth": false,
        "disabled": false,
        "timeout": { "catalog": 30000, "execution": 900000 }
      },
      "next": { "type": "remote", "url": "https://n.example/mcp" }
    }
  }
}
`;
    const { text, change } = upsertOpencode(legacy, OPTS, "replace");
    expect(change).toBe("replaced_legacy");
    expect(text).toContain('// browser automation\n      "tabcrew": {');
    expect(text).not.toContain("chromeuse");
    expect(text).toContain('"next": { "type": "remote", "url": "https://n.example/mcp" }');
    expect(inspectOpencode(text).entry).toEqual({
      type: "remote",
      url: OPTS.url,
      headers: { Authorization: "Bearer {file:~/.tabcrew/token}" },
      oauth: false,
      disabled: false,
      timeout: { catalog: 30000, execution: 900000 },
    });
  });

  it("can instead keep chromeuse and only rewrite its token path", () => {
    const legacy = '{ "mcp": { "chromeuse": { "type": "remote", "url": "u", "headers": { "Authorization": "Bearer {file:~/.chromeuse/token}" } } } }';
    const { text, change } = upsertOpencode(legacy, OPTS, "rewrite");
    expect(change).toBe("rewrote_legacy");
    expect(text).toBe(legacy.replace("~/.chromeuse/token", "~/.tabcrew/token"));
    expect(upsertOpencode(text, OPTS, "rewrite").change).toBe("unchanged");
  });

  it("removes the entry and rejects invalid JSONC", () => {
    const added = upsertOpencode(V2, OPTS, "replace").text;
    const { text, removed } = removeOpencodeEntry(added);
    expect(removed).toBe(true);
    expect(parseJsonc(text)).toEqual(parseJsonc(V2));
    expect(text).toContain("/* block comment */");
    expect(removeOpencodeEntry(V2)).toEqual({ text: V2, removed: false });
    expect(() => upsertOpencode("{ nope", OPTS, "replace")).toThrow(/invalid JSONC/);
  });

  it("references the token file with ~ for the default home and absolutely otherwise", () => {
    expect(tokenFileRef("/Users/x/.tabcrew", "/Users/x")).toBe("{file:~/.tabcrew/token}");
    expect(tokenFileRef("/srv/tabcrew", "/Users/x")).toBe("{file:/srv/tabcrew/token}");
  });
});

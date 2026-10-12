#!/usr/bin/env node
// Renders the Chrome Web Store screenshots (1280×800) and the small promo tile (440×280) from the
// HTML mockups in store/screenshots/src/ with headless Chrome. It never touches a real browser
// profile: each render uses a fresh temporary --user-data-dir inside this repo, deleted afterwards.
//
// Usage: node store/scripts/render-screenshots.mjs
// Override the browser with CHROME_BIN=/path/to/chrome (any Chromium-based browser works).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const store = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(store, "screenshots", "src");
const out = join(store, "screenshots");

const CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const chrome = CANDIDATES.find((path) => existsSync(path));
if (!chrome) {
  console.error("No Chrome/Chromium found; set CHROME_BIN.");
  process.exit(1);
}

const SHOTS = [
  ["1-sessions.html", "1-sessions.png", 1280, 800],
  ["2-placement.html", "2-placement.png", 1280, 800],
  ["3-finished-group.html", "3-finished-group.png", 1280, 800],
  ["4-agent-browse.html", "4-agent-browse.png", 1280, 800],
  ["promo-small.html", "promo-small-440x280.png", 440, 280],
];

function pngSize(path) {
  const png = readFileSync(path);
  return [png.readUInt32BE(16), png.readUInt32BE(20), png[25]];
}

/**
 * Headless Chrome on macOS sometimes keeps running after writing the screenshot, so wait for the
 * "Written to file" line (or the file itself) and then stop the process.
 */
function capture(args, target) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      child.once("exit", () => (err ? reject(err) : resolve()));
      if (child.exitCode !== null || child.signalCode !== null) err ? reject(err) : resolve();
    };
    const written = () => existsSync(target) && statSync(target).mtimeMs >= started && statSync(target).size > 0;
    const poll = setInterval(() => {
      if (/Written to file/.test(stderr) || written()) setTimeout(() => finish(), 300);
      else if (Date.now() - started > 60_000) finish(new Error(`timed out rendering ${target}\n${stderr.slice(-2000)}`));
    }, 100);
    child.stderr.on("data", (d) => (stderr += d));
    child.once("exit", () => {
      if (!settled) (written() ? finish() : finish(new Error(`chrome exited without ${target}\n${stderr.slice(-2000)}`)));
    });
  });
}

for (const [html, png, width, height] of SHOTS) {
  const profile = mkdtempSync(join(store, ".chrome-profile-"));
  const target = join(out, png);
  rmSync(target, { force: true });
  try {
    await capture(
      [
        "--headless=new",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--allow-file-access-from-files",
        `--window-size=${width},${height}`,
        `--screenshot=${target}`,
        pathToFileURL(join(src, html)).href,
      ],
      target,
    );
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  const [w, h, colorType] = pngSize(target);
  if (w !== width || h !== height) throw new Error(`${png} is ${w}×${h}, expected ${width}×${height}`);
  // The store wants JPEG or 24-bit PNG without alpha (PNG colour type 2).
  if (colorType !== 2) throw new Error(`${png} has PNG colour type ${colorType}, expected 2 (RGB, no alpha)`);
  console.log(`[screenshots] ${png} ${w}×${h}`);
}

#!/usr/bin/env node
// Renders the TabCrew icon without any image dependency: the geometry below is the source of truth,
// it is rasterized with signed-distance anti-aliasing and encoded as PNG with node:zlib.
//
// Design: three overlapping browser-tab cards (violet, teal, orange), each separated from the one
// behind it by a transparent gap; the front card carries three white "crew" dots. Small sizes are
// simplified (32 px: no dots, 16 px: two cards) so they stay legible.
//
// Writes extension/assets/icon.svg, extension/assets/icon-{16,32,48,128}.png and
// store/assets/icon-128.png (96 px artwork centred with 16 px transparent padding, as the
// Chrome Web Store asks). Usage: node extension/scripts/render-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const extensionAssets = join(here, "..", "assets");
const storeAssets = join(here, "..", "..", "store", "assets");

/** Design space is 128 × 128 units. */
const UNITS = 128;
const COLORS = { violet: "#6D28D9", teal: "#0D9488", orange: "#F97316", dot: "#FFFFFF" };

// One card: a body plus an "ear" (the tab handle) on its top-left, overlapping the body so the
// ear's lower corners are hidden.
const CARD = { w: 76, h: 62, r: 9, earW: 34, earH: 22, earR: 7, earLift: 13 };

function card(x, y, color) {
  return { x, y, color };
}

/** Layouts per pixel size (all coordinates in design units). */
const LAYOUTS = {
  large: {
    gap: 4,
    cards: [card(8, 21, COLORS.violet), card(26, 39, COLORS.teal), card(44, 57, COLORS.orange)],
    dots: { r: 5.5, spacing: 16 },
  },
  medium: {
    gap: 5,
    cards: [card(8, 21, COLORS.violet), card(26, 39, COLORS.teal), card(44, 57, COLORS.orange)],
    dots: null,
  },
  small: {
    gap: 9,
    cards: [card(6, 22, COLORS.teal), card(50, 72, COLORS.orange)],
    dots: null,
  },
};

// The small layout uses bigger cards so two of them fill the frame.
const SMALL_CARD = { w: 72, h: 50, r: 9, earW: 34, earH: 22, earR: 8, earLift: 16 };

function cardGeometry(c, dims) {
  return {
    body: { x: c.x, y: c.y, w: dims.w, h: dims.h, r: dims.r },
    ear: { x: c.x, y: c.y - dims.earLift, w: dims.earW, h: dims.earH, r: dims.earR },
  };
}

function layoutFor(px) {
  if (px <= 16) return { ...LAYOUTS.small, dims: SMALL_CARD };
  if (px <= 32) return { ...LAYOUTS.medium, dims: CARD };
  return { ...LAYOUTS.large, dims: CARD };
}

// ---------- signed distance functions (design units) ----------

function sdRoundRect(px, py, rect) {
  const hx = rect.w / 2;
  const hy = rect.h / 2;
  const qx = Math.abs(px - (rect.x + hx)) - (hx - rect.r);
  const qy = Math.abs(py - (rect.y + hy)) - (hy - rect.r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - rect.r;
}

function sdCard(px, py, geo) {
  return Math.min(sdRoundRect(px, py, geo.body), sdRoundRect(px, py, geo.ear));
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function dotCenters(layout) {
  if (!layout.dots) return [];
  const front = cardGeometry(layout.cards.at(-1), layout.dims).body;
  const cx = front.x + front.w / 2;
  const cy = front.y + front.h / 2 + 2;
  return [-1, 0, 1].map((i) => ({ x: cx + i * layout.dots.spacing, y: cy, r: layout.dots.r }));
}

// ---------- rasterizer ----------

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Render the icon into a `size`×`size` RGBA buffer. The artwork occupies `art` pixels starting at
 * `offset` (so the store icon can be padded).
 */
function render(size, art = size, offset = 0) {
  const layout = layoutFor(art);
  const unitsPerPixel = UNITS / art;
  // Straight-alpha float canvas.
  const rgba = new Float64Array(size * size * 4);
  const coverage = (sd) => Math.min(1, Math.max(0, 0.5 - sd / unitsPerPixel));

  const paint = (sdf, color) => {
    const [r, g, b] = hexToRgb(color).map((v) => v / 255);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const ux = (x + 0.5 - offset) * unitsPerPixel;
        const uy = (y + 0.5 - offset) * unitsPerPixel;
        const a = coverage(sdf(ux, uy));
        if (a <= 0) continue;
        const i = (y * size + x) * 4;
        const da = rgba[i + 3];
        const oa = a + da * (1 - a);
        rgba[i] = (r * a + rgba[i] * da * (1 - a)) / oa;
        rgba[i + 1] = (g * a + rgba[i + 1] * da * (1 - a)) / oa;
        rgba[i + 2] = (b * a + rgba[i + 2] * da * (1 - a)) / oa;
        rgba[i + 3] = oa;
      }
    }
  };

  const erase = (sdf) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const ux = (x + 0.5 - offset) * unitsPerPixel;
        const uy = (y + 0.5 - offset) * unitsPerPixel;
        const a = coverage(sdf(ux, uy));
        if (a > 0) rgba[(y * size + x) * 4 + 3] *= 1 - a;
      }
    }
  };

  for (const c of layout.cards) {
    const geo = cardGeometry(c, layout.dims);
    erase((ux, uy) => sdCard(ux, uy, geo) - layout.gap);
    paint((ux, uy) => sdCard(ux, uy, geo), c.color);
  }
  for (const d of dotCenters(layout)) paint((ux, uy) => sdCircle(ux, uy, d.x, d.y, d.r), COLORS.dot);

  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < rgba.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, rgba[i])) * 255);
  return out;
}

// ---------- PNG encoder ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- SVG (same geometry, large layout) ----------

function rectPath(r) {
  return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${r.r}"/>`;
}

function svg() {
  const layout = layoutFor(128);
  const parts = [];
  const defs = [];
  layout.cards.forEach((c, i) => {
    const geo = cardGeometry(c, layout.dims);
    const shape = `${rectPath(geo.body)}${rectPath(geo.ear)}`;
    // Each card cuts a gap (its outline widened by `gap`) into the cards behind it.
    const later = layout.cards.slice(i + 1).map((n) => cardGeometry(n, layout.dims));
    if (later.length) {
      const cut = later
        .map((g) => `<g stroke="#000" stroke-width="${layout.gap * 2}" stroke-linejoin="round">${rectPath(g.body)}${rectPath(g.ear)}</g>`)
        .join("");
      defs.push(`<mask id="gap${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128"><rect width="128" height="128" fill="#fff"/>${cut}</mask>`);
      parts.push(`<g fill="${c.color}" mask="url(#gap${i})">${shape}</g>`);
    } else {
      parts.push(`<g fill="${c.color}">${shape}</g>`);
    }
  });
  const dots = dotCenters(layout)
    .map((d) => `<circle cx="${d.x}" cy="${d.y}" r="${d.r}"/>`)
    .join("");
  parts.push(`<g fill="${COLORS.dot}">${dots}</g>`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">`,
    `<title>TabCrew</title>`,
    `<!-- Generated by extension/scripts/render-icons.mjs; edit the geometry there. -->`,
    `<defs>${defs.join("")}</defs>`,
    ...parts,
    `</svg>`,
    "",
  ].join("\n");
}

function main() {
  mkdirSync(extensionAssets, { recursive: true });
  mkdirSync(storeAssets, { recursive: true });
  writeFileSync(join(extensionAssets, "icon.svg"), svg());
  for (const size of [16, 32, 48, 128]) {
    writeFileSync(join(extensionAssets, `icon-${size}.png`), encodePng(size, size, render(size)));
  }
  writeFileSync(join(storeAssets, "icon-128.png"), encodePng(128, 128, render(128, 96, 16)));
  console.log("[icons] wrote extension/assets/icon.svg, icon-{16,32,48,128}.png and store/assets/icon-128.png");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

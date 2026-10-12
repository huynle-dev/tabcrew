#!/usr/bin/env node
// Builds the v2 toolbar icons: the shared ChromeUse icon (assets/base/icon-N.png) with an
// orange corner badge showing "2", so v2 is not confused with v1. Node built-ins only.
// Usage: node scripts/make-icons.mjs   (writes assets/icon-{16,48,128}.png)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [16, 48, 128];
const BADGE = [249, 115, 22]; // #F97316
const WHITE = [255, 255, 255];
const SAMPLES = 4; // supersampling per axis

// --- PNG I/O (8-bit RGBA, non-interlaced) ---------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readPng(file) {
  const buf = readFileSync(file);
  let pos = 8;
  let width = 0, height = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error(`${file}: expected 8-bit RGBA, non-interlaced`);
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, px };
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function writePng(file, { width, height, px }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  writeFileSync(file, Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

// --- Badge geometry (badge-local units: the badge circle has radius 1) ----------------------

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// "2": an upper arc, a diagonal to the lower left, and a base line (y grows downwards).
const ARC = { cx: 0, cy: -0.2, r: 0.28 };
const ARC_END = 0.55; // radians below the horizontal on the right
const DIAG_FROM = [ARC.cx + ARC.r * Math.cos(ARC_END), ARC.cy + ARC.r * Math.sin(ARC_END)];
const BASE_Y = 0.46;
const LEFT = -0.3, RIGHT = 0.32;
const STROKE = 0.15;

function inTwo(x, y) {
  const ang = Math.atan2(y - ARC.cy, x - ARC.cx);
  // Arc from the left (slightly below horizontal) over the top to ARC_END on the right.
  if (ang <= ARC_END || ang >= Math.PI - 0.35) {
    if (Math.abs(Math.hypot(x - ARC.cx, y - ARC.cy) - ARC.r) <= STROKE / 2) return true;
  }
  if (segDist(x, y, DIAG_FROM[0], DIAG_FROM[1], LEFT, BASE_Y) <= STROKE / 2) return true;
  return segDist(x, y, LEFT, BASE_Y, RIGHT, BASE_Y) <= STROKE / 2;
}

function badgeFor(size) {
  // Bigger relative badge on tiny icons so the "2" stays legible.
  const r = size <= 16 ? size * 0.3 : size * 0.21;
  const ring = Math.max(1, size * 0.03);
  const c = size - r - ring - (size <= 16 ? 0 : size * 0.02);
  return { cx: c, cy: c, r, ring };
}

function blend(px, i, color, alpha) {
  if (alpha <= 0) return;
  const a0 = px[i + 3] / 255;
  const a = alpha + a0 * (1 - alpha);
  for (let k = 0; k < 3; k++) px[i + k] = Math.round((color[k] * alpha + px[i + k] * a0 * (1 - alpha)) / a);
  px[i + 3] = Math.round(a * 255);
}

function stamp(img) {
  const { width, px } = img;
  const { cx, cy, r, ring } = badgeFor(width);
  for (let y = Math.floor(cy - r - ring - 1); y < width; y++) {
    for (let x = Math.floor(cx - r - ring - 1); x < width; x++) {
      if (x < 0 || y < 0) continue;
      let ringCov = 0, fillCov = 0, glyphCov = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const fx = x + (sx + 0.5) / SAMPLES, fy = y + (sy + 0.5) / SAMPLES;
          const d = Math.hypot(fx - cx, fy - cy);
          if (d <= r + ring) ringCov++;
          if (d <= r) {
            fillCov++;
            if (inTwo((fx - cx) / r, (fy - cy) / r)) glyphCov++;
          }
        }
      }
      const n = SAMPLES * SAMPLES;
      const i = (y * width + x) * 4;
      blend(px, i, WHITE, ringCov / n);
      blend(px, i, BADGE, fillCov / n);
      blend(px, i, WHITE, glyphCov / n);
    }
  }
  return img;
}

for (const size of SIZES) {
  const img = readPng(join(root, "assets/base", `icon-${size}.png`));
  if (img.width !== size || img.height !== size) throw new Error(`base icon-${size}.png is ${img.width}x${img.height}`);
  writePng(join(root, "assets", `icon-${size}.png`), stamp(img));
  console.log(`assets/icon-${size}.png`);
}

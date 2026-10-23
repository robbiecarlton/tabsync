// Draws the extension icon (two offset browser windows on a blue rounded square) and writes PNGs.
// Dependency-free: rasterizes with 4x4 supersampling and encodes PNG with node:zlib.
// Run: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const BLUE = [26, 115, 232];
const WHITE = [255, 255, 255];

function inRoundedRect(x, y, [x0, y0, x1, y1], r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** A browser window: rounded body with a title-bar line (drawn in the background colour). */
const WINDOW = { w: 0.5, h: 0.42, bar: 0.11, line: 0.045 };

function inWindow(x, y, left, top) {
  return inRoundedRect(x, y, [left, top, left + WINDOW.w, top + WINDOW.h], 0.06);
}

function inTitleLine(x, y, left, top) {
  const y0 = top + WINDOW.bar;
  return (
    x >= left &&
    x <= left + WINDOW.w &&
    y >= y0 &&
    y <= y0 + WINDOW.line &&
    inWindow(x, y, left, top)
  );
}

const BACK = [0.34, 0.2];
const FRONT = [0.16, 0.38];

/** Layers bottom to top: [test, color, alpha]. */
const layers = [
  [(x, y) => inRoundedRect(x, y, [0.02, 0.02, 0.98, 0.98], 0.22), BLUE, 1],
  [(x, y) => inWindow(x, y, ...BACK), WHITE, 0.55],
  [(x, y) => inTitleLine(x, y, ...BACK), BLUE, 1],
  [(x, y) => inWindow(x, y, ...FRONT), WHITE, 1],
  [(x, y) => inTitleLine(x, y, ...FRONT), BLUE, 1],
];

function render(size) {
  const ss = 4;
  const rgba = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          // Composite this sample (premultiplied "over").
          let [cr, cg, cb, ca] = [0, 0, 0, 0];
          for (const [inside, color, alpha] of layers) {
            if (!inside(x, y)) continue;
            cr = color[0] * alpha + cr * (1 - alpha);
            cg = color[1] * alpha + cg * (1 - alpha);
            cb = color[2] * alpha + cb * (1 - alpha);
            ca = alpha + ca * (1 - alpha);
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      rgba[i] = alpha ? Math.round(r / n / alpha) : 0;
      rgba[i + 1] = alpha ? Math.round(g / n / alpha) : 0;
      rgba[i + 2] = alpha ? Math.round(b / n / alpha) : 0;
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  const file = new URL(`../public/icons/icon-${size}.png`, import.meta.url);
  writeFileSync(file, png(size, render(size)));
  console.log(`wrote ${file.pathname}`);
}

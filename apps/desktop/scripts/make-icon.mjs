#!/usr/bin/env node
/**
 * Draws the 1024x1024 source icon that `tauri icon` slices into every platform
 * format. Hand-rolled rather than checked in as a binary so the mark can be
 * tweaked in a diff: a dark rounded tile, a blue ring for the agent at work,
 * and an amber dot for the moment it needs you.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../src-tauri/icon-source.png");

const TILE = [0x1d, 0x20, 0x27];
const RING = [0x5b, 0x9d, 0xff];
const DOT = [0xe5, 0xb6, 0x5c];

const pixels = Buffer.alloc(SIZE * SIZE * 4);

/** Signed distance to a rounded square centred on the canvas. */
function roundedSquareDistance(x, y, half, radius) {
  const dx = Math.abs(x) - (half - radius);
  const dy = Math.abs(y) - (half - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** 1 inside, 0 outside, feathered across one pixel so edges are not jagged. */
function coverage(distance) {
  return Math.min(1, Math.max(0, 0.5 - distance));
}

function blend(target, offset, colour, alpha) {
  if (alpha <= 0) return;
  const existing = target[offset + 3] / 255;
  const out = alpha + existing * (1 - alpha);
  for (let channel = 0; channel < 3; channel += 1) {
    const src = colour[channel];
    const dst = target[offset + channel];
    target[offset + channel] = Math.round((src * alpha + dst * existing * (1 - alpha)) / out);
  }
  target[offset + 3] = Math.round(out * 255);
}

const centre = SIZE / 2;

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const offset = (y * SIZE + x) * 4;
    const px = x - centre + 0.5;
    const py = y - centre + 0.5;

    blend(pixels, offset, TILE, coverage(roundedSquareDistance(px, py, 492, 210)));

    // Ring: an annulus, open at the lower right where the dot sits.
    const radius = Math.hypot(px, py);
    const ringAlpha = coverage(Math.abs(radius - 290) - 46);
    const angle = Math.atan2(py, px);
    const inGap = angle > 0.28 && angle < 1.29;
    blend(pixels, offset, RING, inGap ? 0 : ringAlpha);

    blend(pixels, offset, DOT, coverage(Math.hypot(px - 228, py - 228) - 104));
  }
}

// PNG wants a filter byte at the head of every scanline; 0 means "none".
const rows = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  rows[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(rows, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`Wrote ${out} (${(png.length / 1024).toFixed(1)} KB)`);

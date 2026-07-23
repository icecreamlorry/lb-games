// Generates Weiqi's PNG app icons with no external image libraries — it draws
// a little wooden goban (grid + one black and one white stone) straight into an
// RGBA pixel buffer and encodes a PNG by hand (zlib + CRC32). Run from the repo
// root:  node weiqi/tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const ia = a / 255, ib = 1 - ia;
    buf[i] = Math.round(r * ia + buf[i] * ib);
    buf[i + 1] = Math.round(g * ia + buf[i + 1] * ib);
    buf[i + 2] = Math.round(b * ia + buf[i + 2] * ib);
    buf[i + 3] = Math.max(buf[i + 3], a);
  };
  const disc = (cx, cy, rad, shade) => {
    for (let y = Math.floor(cy - rad - 1); y <= cy + rad + 1; y++) {
      for (let x = Math.floor(cx - rad - 1); x <= cx + rad + 1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > rad + 1) continue;
        const a = Math.max(0, Math.min(1, rad - d + 0.5));
        // simple top-left highlight for a stone look
        const t = Math.max(0, 1 - Math.hypot(x - (cx - rad * 0.3), y - (cy - rad * 0.3)) / (rad * 1.6));
        const [r, g, b] = shade === 'black'
          ? [20 + 70 * t, 26 + 70 * t, 32 + 70 * t]
          : [235 + 20 * t, 238 + 17 * t, 242 + 13 * t];
        set(x, y, r, g, b, Math.round(a * 255));
      }
    }
  };

  // Wood background with a soft vignette.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 1 - 0.16 * (Math.hypot(x - size / 2, y - size / 2) / (size / 1.4));
      set(x, y, 220 * v, 180 * v, 113 * v, 255);
    }
  }

  // A 5-line goban grid inset with a margin.
  const m = Math.round(size * 0.2);
  const span = size - 2 * m;
  const step = span / 4;
  const lw = Math.max(1, Math.round(size * 0.012));
  const line = (x0, y0, x1, y1) => {
    if (x0 === x1) { for (let y = y0; y <= y1; y++) for (let o = 0; o < lw; o++) set(x0 + o, y, 74, 52, 17, 255); }
    else { for (let x = x0; x <= x1; x++) for (let o = 0; o < lw; o++) set(x, y0 + o, 74, 52, 17, 255); }
  };
  for (let i = 0; i < 5; i++) {
    const p = Math.round(m + i * step);
    line(m, p, m + span, p);
    line(p, m, p, m + span);
  }

  // Two stones on intersections.
  const rad = step * 0.46;
  disc(Math.round(m + step * 1), Math.round(m + step * 3), rad, 'black');
  disc(Math.round(m + step * 3), Math.round(m + step * 1), rad, 'white');
  return encodePNG(size, size, buf);
}

for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  const png = draw(size);
  writeFileSync(new URL(`../icons/${name}`, import.meta.url), png);
  console.log(`wrote icons/${name} (${size}px, ${png.length} bytes)`);
}

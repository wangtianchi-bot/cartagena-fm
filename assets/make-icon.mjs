// assets/make-icon.mjs —— 纯 Node 生成 app 图标（无第三方依赖，zlib 手搓 PNG）
// 画面：深色圆角底 + 绿色像素均衡器条（呼应 UI 的像素/绿 #3ddc84 风格）。
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const S = 1024;
const buf = Buffer.alloc(S * S * 4); // RGBA

const set = (x, y, [r, g, b, a = 255]) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // 简单 alpha 合成到已有像素（用于抗锯齿叠加）
  const ba = buf[i + 3] / 255, fa = a / 255, oa = fa + ba * (1 - fa);
  if (oa === 0) return;
  buf[i] = (r * fa + buf[i] * ba * (1 - fa)) / oa;
  buf[i + 1] = (g * fa + buf[i + 1] * ba * (1 - fa)) / oa;
  buf[i + 2] = (b * fa + buf[i + 2] * ba * (1 - fa)) / oa;
  buf[i + 3] = oa * 255;
};

// 圆角矩形填充（带 1px 软边）
function roundRect(x0, y0, w, h, rad, color) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const dx = Math.max(x0 + rad - x, x - (x0 + w - 1 - rad), 0);
    const dy = Math.max(y0 + rad - y, y - (y0 + h - 1 - rad), 0);
    const d = Math.hypot(dx, dy);
    const a = d <= rad ? 1 : d <= rad + 1 ? rad + 1 - d : 0;
    if (a > 0) set(x, y, [...color, Math.round(255 * a)]);
  }
}

// 底：深色圆角方（macOS 大圆角观感）
roundRect(0, 0, S, S, 230, [0x12, 0x16, 0x1a]);
// 顶部一道极淡的绿色辉光带，呼应 UI 辉光
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const t = 1 - y / S;
  if (t > 0.55) set(x, y, [0x3d, 0xdc, 0x84, Math.round(10 * (t - 0.55) / 0.45)]);
}

// 均衡器：5 条绿色像素柱，高低错落像声波
const GREEN = [0x3d, 0xdc, 0x84];
const bars = [0.42, 0.74, 0.56, 1.0, 0.48];
const barW = 96, gap = 56;
const totalW = bars.length * barW + (bars.length - 1) * gap;
const startX = (S - totalW) / 2;
const baseY = S * 0.74;        // 柱底
const maxH = S * 0.46;         // 最高柱
for (let b = 0; b < bars.length; b++) {
  const x0 = Math.round(startX + b * (barW + gap));
  const h = Math.round(bars[b] * maxH);
  roundRect(x0, Math.round(baseY - h), barW, h, 30, GREEN);
}
// 柱底一条基线，把五条柱"坐实"
roundRect(Math.round(startX - 20), Math.round(baseY) + 8, totalW + 40, 18, 9, [0x3d, 0xdc, 0x84]);

// —— 编码 PNG ——
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit, RGBA
// 每行前置 filter 字节 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(DIR, 'icon-1024.png');
fs.writeFileSync(out, png);
console.log('icon written:', out, png.length, 'bytes');

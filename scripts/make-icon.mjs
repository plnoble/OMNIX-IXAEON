#!/usr/bin/env node
/**
 * 生成 IXAEON 应用图标（多尺寸 ICO，PNG-in-ICO）。
 * 纯 Node：zlib 压缩 + 手写 PNG 块（无外部依赖，可在受限环境运行）。
 * 设计：深蓝底、圆形底盘、青色衍生弧、金色十字（析衍意象）。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- 像素绘制（RGBA） ---
function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const setPx = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // 简单 alpha 混合
    const sa = a / 255;
    const da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = Math.round(oa * 255);
  };

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // 背景：深蓝 (16,24,40)；圆形底盘半径 46%（圆形徽章）
      const discR = size * 0.46;
      if (dist <= discR) {
        setPx(x, y, 24, 34, 56);
      } else {
        // 圆外透明
        setPx(x, y, 0, 0, 0, 0);
        continue;
      }

      // 青色弧线：半径 34%，环宽 ~7%（220°–50° 开口的衍射弧）
      const arcR = size * 0.34;
      const arcW = Math.max(1, size * 0.07);
      const ad = Math.abs(dist - arcR);
      if (ad <= arcW / 2) {
        // 极角（0°=右，逆时针为正）
        let ang = (Math.atan2(-dy, dx) * 180) / Math.PI;
        if (ang < 0) ang += 360;
        // 开口朝右上（20°–160° 为空）
        const inGap = ang > 20 && ang < 160;
        if (!inGap) {
          const edge = 1 - ad / (arcW / 2); // 抗锯齿
          setPx(x, y, 90, 200, 250, Math.round(255 * Math.min(1, edge * 2.2)));
        }
      }

      // 金色十字（垂直 30%–72%，水平 32%–68%，线宽 ~5%）
      const cw = Math.max(1, size * 0.05);
      const inV = Math.abs(dx) <= cw / 2 && dy >= -size * 0.22 && dy <= size * 0.22;
      const inH = Math.abs(dy) <= cw / 2 && dx >= -size * 0.18 && dx <= size * 0.18;
      if (inV || inH) {
        setPx(x, y, 250, 200, 90);
      }
    }
  }
  return px;
}

// --- PNG 编码（无滤波，scanline filter 0） ---
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function encodePng(px, size) {
  // filter 0 scanlines
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO 组装 ---
const sizes = [256, 128, 64, 48, 32, 16];
const pngs = sizes.map((s) => encodePng(drawIcon(s), s));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: 1 = ICO
header.writeUInt16LE(sizes.length, 4);

const entries = [];
let offset = 6 + 16 * sizes.length;
for (let i = 0; i < sizes.length; i++) {
  const e = Buffer.alloc(16);
  e[0] = sizes[i] >= 256 ? 0 : sizes[i];
  e[1] = sizes[i] >= 256 ? 0 : sizes[i];
  e[2] = 0;
  e[3] = 0;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
}

const ico = Buffer.concat([header, ...entries, ...pngs]);
const out = join(root, 'apps', 'desktop', 'resources', 'icon.ico');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, ico);
console.log(`icon.ico: ${ico.length} bytes (${sizes.length} sizes: ${sizes.join(', ')})`);

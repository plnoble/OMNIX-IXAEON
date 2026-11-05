/**
 * MP3c 真机检查：只输出三行「工具名：找到 / 没找到、手填 / 自动」，不输出路径。
 *   node scripts/real/run-batch.mjs scripts/real/mp3c-devtools.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectDevTools } from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3c-real-'));

const rows = detectDevTools({ manual: {}, env: process.env });
for (const r of rows) {
  const state = r.found ? '找到' : '没找到';
  const source = r.source === 'manual' ? '手填' : r.source === 'auto' ? '自动' : '—';
  console.log(`${r.tool}：${state}、${source}`);
}
rmSync(dir, { recursive: true, force: true });

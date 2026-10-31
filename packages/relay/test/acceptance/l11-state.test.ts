/**
 * L11 验收条件 4：状态锁（`updateState`）。
 * - 两个进程同时各调 50 次 `updateState(s => { s.turns += 1 })` → 最后 turns 是 100；
 * - 锁文件超过 30 秒还在 → 当它是崩掉的进程留下的，删掉再拿。
 *
 * 先测试后实现（B 档）：`updateState` 还没写，这份现在是红的。
 * 并发用两个真的子进程（各自经 jiti 跑一小段脚本），不是同一进程里的两次 Promise。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REPO = process.cwd();
function findJiti(): string {
  const pnpm = join(REPO, 'node_modules', '.pnpm');
  const found = existsSync(pnpm) ? readdirSafe(pnpm).find((d) => d.startsWith('jiti@')) : undefined;
  const direct = join(REPO, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs');
  if (found) return join(pnpm, found, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs');
  if (existsSync(direct)) return direct;
  throw new Error('找不到 jiti 的 CLI');
}
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const initialState = (): string =>
  `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 0, notify: { sent: {} } }, null, 2)}\n`;

describe('条件 4：状态锁 updateState', () => {
  it('两个进程各调 50 次 turns += 1 → 最后是 100，没有互相覆盖', async () => {
    const dataDir = temp('ixa-l11-state-');
    writeFileSync(join(dataDir, 'state.json'), initialState(), 'utf8');
    const jiti = findJiti();
    const scratch = join(dataDir, 'bump.ts');
    writeFileSync(
      scratch,
      [
        `import { updateState } from '${join(REPO, 'packages', 'relay', 'src', 'store.js').replaceAll('\\', '/')}';`,
        `const dataDir = process.argv[2];`,
        `for (let i = 0; i < 50; i++) await updateState(dataDir, (s) => { s.turns += 1; });`,
        `console.log('done');`,
        '',
      ].join('\n'),
      'utf8',
    );
    // 真并发：两个子进程同时起、各自加 50 次（不是一前一后）
    const { spawn } = await import('node:child_process');
    const runAsync = () =>
      new Promise<{ status: number | null; stderr: string }>((done) => {
        const child = spawn(process.execPath, [jiti, scratch, dataDir], { windowsHide: true });
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
        child.on('close', (status) => done({ status, stderr: err }));
      });
    const [first, second] = await Promise.all([runAsync(), runAsync()]);
    // 两个都要成功（有谁拿不到锁抛错了，这里就会非 0）
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    const after = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as {
      turns: number;
    };
    expect(after.turns).toBe(100);
  }, 90_000);

  it('锁文件超过 30 秒：当它是崩掉的进程留下的，删掉再拿', async () => {
    // 先把「现在拿锁成功」跑通：本条主要钉「陈旧锁不挡人」
    const dataDir = temp('ixa-l11-state-');
    writeFileSync(join(dataDir, 'state.json'), initialState(), 'utf8');
    const stale = join(dataDir, 'state.lock');
    writeFileSync(stale, '1234', 'utf8');
    const old = new Date(Date.now() - 40_000);
    utimesSync(stale, old, old);
    const jiti = findJiti();
    const scratch = join(dataDir, 'once.ts');
    writeFileSync(
      scratch,
      [
        `import { updateState } from '${join(REPO, 'packages', 'relay', 'src', 'store.js').replaceAll('\\', '/')}';`,
        `const dataDir = process.argv[2];`,
        `updateState(dataDir, (s) => { s.turns += 1; });`,
        `console.log('done');`,
        '',
      ].join('\n'),
      'utf8',
    );
    const r = spawnSync(process.execPath, [jiti, scratch, dataDir], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const after = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as {
      turns: number;
    };
    expect(after.turns).toBe(1);
  }, 90_000);
});

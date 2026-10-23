/**
 * L10 验收测试（四）：开棒前装好依赖（规格条件 5，对应契约第 4 条）。
 *
 * 逐条对应：
 * - `ensureDeps(dir, install)`：第一次 → `'ok'`、装了、记号文件写了；锁文件不变 → `'skipped'`、没装；
 *   锁文件变了 → 又装；装的命令退出码 1 → `'failed'`、记号没写。
 * - 整合方的棒：`IXAEON_RELAY_INSTALL` 设成退出码 1 的命令 → 这一棒没开（没有 `turns/`、
 *   记账没多一条），输出含 `没开棒：整合方的工作目录装不上依赖`。
 *
 * 装的命令用写记录的 node 小脚本（不出本机、不联网）。不调真模型。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDeps } from '../../src/deps.js';
import { makeWorld, type World } from './l10-harness.js';

const dirs: string[] = [];
const worlds: World[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const markerOf = (dir: string): string | null => {
  const p = join(dir, 'node_modules', '.relay-lock-sha256');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').trim();
};

/** 记账用的安装命令：往 --out 追加一行，退出码可选。 */
const recorder = (out: string, fail = false): string[] => {
  const script = join(tmp('ixa-l10-installer-'), 'install.mjs');
  writeFileSync(
    script,
    [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(out)}, "installed\\n");`,
      fail ? 'process.exit(1);' : '',
      '',
    ].join('\n'),
    'utf8',
  );
  return [process.execPath, script];
};
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('条件 5：ensureDeps', () => {
  it('第一次装、锁文件不变跳过、锁文件变了再装；装失败 → failed 且不写记号', () => {
    const dir = tmp('ixa-l10-dep-ws-');
    const lock = join(dir, 'pnpm-lock.yaml');
    const out = join(tmp('ixa-l10-dep-log-'), 'installs.txt');
    writeFileSync(lock, 'lockfileVersion: 9\n', 'utf8');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });

    const install = recorder(out);
    expect(ensureDeps(dir, install)).toBe('ok');
    expect(readFileSync(out, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    const marker = markerOf(dir);
    expect(marker).not.toBeNull();
    expect(marker!).toContain(sha256(readFileSync(lock, 'utf8')));

    // 锁文件没变 → 跳过、不再装
    expect(ensureDeps(dir, install)).toBe('skipped');
    expect(readFileSync(out, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);

    // 锁文件变了 → 又装
    writeFileSync(lock, 'lockfileVersion: 9\n# 变了\n', 'utf8');
    expect(ensureDeps(dir, install)).toBe('ok');
    expect(readFileSync(out, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(markerOf(dir)!).toContain(sha256(readFileSync(lock, 'utf8')));

    // 装的命令退出码 1 → failed、记号没写（换一个没装过的目录）
    const bad = tmp('ixa-l10-dep-bad-');
    writeFileSync(join(bad, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    mkdirSync(join(bad, 'node_modules'), { recursive: true });
    const failInstall = recorder(out, true);
    expect(ensureDeps(bad, failInstall)).toBe('failed');
    expect(markerOf(bad)).toBeNull();
  }, 120_000);
});

describe('条件 5（后半）：整合方的棒装不上依赖 → 这一棒没开', () => {
  it('没有 turns/、记账没多一条、输出含那句话、不停下', async () => {
    const w = makeWorld({ status: '测试待审（整合方）' }); // 让整合方当第一棒
    worlds.push(w);
    const r = await w.run(['once'], {
      IXAEON_RELAY_INSTALL: JSON.stringify([process.execPath, '-e', 'process.exit(1)']),
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('没开棒：整合方的工作目录装不上依赖');
    expect(existsSync(join(w.dataDir, 'turns'))).toBe(false);
    expect(w.ledger()).toHaveLength(0);
    expect(w.state().stoppedReason).toBe(null);
  }, 120_000);
});

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
    // 整合方改严（2026-10-23）：记号里存的就是那一串 sha256（原来是「含」）
    expect(markerOf(dir)).toBe(sha256(readFileSync(lock, 'utf8')));

    // 锁文件没变 → 跳过、不再装
    expect(ensureDeps(dir, install)).toBe('skipped');
    expect(readFileSync(out, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);

    // 锁文件变了 → 又装
    writeFileSync(lock, 'lockfileVersion: 9\n# 变了\n', 'utf8');
    expect(ensureDeps(dir, install)).toBe('ok');
    expect(readFileSync(out, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(markerOf(dir)).toBe(sha256(readFileSync(lock, 'utf8')));

    // 装的命令退出码 1 → failed、记号没写（换一个没装过的目录）
    const bad = tmp('ixa-l10-dep-bad-');
    writeFileSync(join(bad, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    mkdirSync(join(bad, 'node_modules'), { recursive: true });
    const failInstall = recorder(out, true);
    expect(ensureDeps(bad, failInstall)).toBe('failed');
    expect(markerOf(bad)).toBeNull();

    // 整合方补（2026-10-23）：装过一次、锁文件又变了、这次装失败 → failed，旧记号不许改成新的 sha
    writeFileSync(lock, 'lockfileVersion: 9\n# 又变了\n', 'utf8');
    expect(ensureDeps(dir, failInstall)).toBe('failed');
    expect(markerOf(dir)).not.toBe(sha256(readFileSync(lock, 'utf8')));
    expect(ensureDeps(dir, install)).toBe('ok'); // 下一次照样重装
  }, 120_000);

  // 整合方补（2026-10-23，规格末尾第 1 条）：没有 pnpm-lock.yaml 的目录没东西可装 → skipped、不跑装的命令
  it('目录里没有 pnpm-lock.yaml → skipped，不装', () => {
    const dir = tmp('ixa-l10-dep-nolock-');
    const out = join(tmp('ixa-l10-dep-log2-'), 'installs.txt');
    expect(ensureDeps(dir, recorder(out))).toBe('skipped');
    expect(existsSync(out)).toBe(false);
  });

  // 整合方补（2026-10-23）：不传 install → 用 IXAEON_RELAY_INSTALL（JSON 数组）
  it('不传 install、IXAEON_RELAY_INSTALL 有值 → 用它装', () => {
    const dir = tmp('ixa-l10-dep-env-');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    const out = join(tmp('ixa-l10-dep-log3-'), 'installs.txt');
    const old = process.env.IXAEON_RELAY_INSTALL;
    process.env.IXAEON_RELAY_INSTALL = JSON.stringify(recorder(out));
    try {
      expect(ensureDeps(dir)).toBe('ok');
    } finally {
      if (old === undefined) delete process.env.IXAEON_RELAY_INSTALL;
      else process.env.IXAEON_RELAY_INSTALL = old;
    }
    expect(readFileSync(out, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    expect(markerOf(dir)).toBe(sha256('lockfileVersion: 9\n'));
  });
});

describe('条件 5（后半）：整合方的棒装不上依赖 → 这一棒没开', () => {
  it('没有 turns/、记账没多一条、输出含那句话、不停下', async () => {
    const w = makeWorld({ status: '测试待审（整合方）' }); // 让整合方当第一棒
    worlds.push(w);
    // 整合方补（2026-10-23）：整合方的目录里要有锁文件才会去装（没有锁文件 → skipped，见上）
    writeFileSync(join(w.integ, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    const r = await w.run(['once'], {
      IXAEON_RELAY_INSTALL: JSON.stringify([process.execPath, '-e', 'process.exit(1)']),
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('没开棒：整合方的工作目录装不上依赖');
    expect(existsSync(join(w.dataDir, 'turns'))).toBe(false);
    expect(w.ledger()).toHaveLength(0);
    expect(w.state().stoppedReason).toBe(null);
  }, 120_000);

  // 整合方补（2026-10-23）：只给整合方的棒装；开发的棒不因为装不上而不开
  it('开发的棒：IXAEON_RELAY_INSTALL 失败也照常开', async () => {
    const w = makeWorld({ status: '待领' });
    worlds.push(w);
    writeFileSync(join(w.integ, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    const r = await w.run(['once'], {
      IXAEON_RELAY_INSTALL: JSON.stringify([process.execPath, '-e', 'process.exit(1)']),
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toContain('没开棒');
    expect(w.ledger()).toHaveLength(1);
  }, 120_000);
});

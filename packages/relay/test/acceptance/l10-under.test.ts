/**
 * L10 验收测试（二）：`once --under <pid>`（规格条件 3，对应契约第 2 条）。
 *
 * 逐条对应：
 * - 锁文件里的进程号是一个活着的进程、`once --under <它>` → 照常跑一棒，锁文件跑完还在、内容不变；
 * - `once --under <别的进程号>` → 照原来被拒（拿不到锁）。
 *
 * 锁里写测试进程自己的号（它活着）；不调真模型、不连 GitHub。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './l10-harness.js';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
});

describe('条件 3：--under', () => {
  it('锁里是活着的进程、once --under 它 → 跑一棒，锁文件还在且内容不变', async () => {
    const w = makeWorld();
    worlds.push(w);
    const lock = join(w.dataDir, 'lock.json');
    const content = `${JSON.stringify({ pid: process.pid, startedAt: '2026-10-22T02:00:00.000Z' })}\n`;
    writeFileSync(lock, content, 'utf8');

    const r = await w.run(['once', '--under', String(process.pid)]);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.ledger()).toHaveLength(1); // 照常跑了一棒
    expect(readFileSync(lock, 'utf8')).toBe(content); // 锁没被拿、也没被放
  }, 120_000);

  it('once --under 别的进程号 → 照原来被拒（不启动）', async () => {
    const w = makeWorld();
    worlds.push(w);
    writeFileSync(
      join(w.dataDir, 'lock.json'),
      `${JSON.stringify({ pid: process.pid, startedAt: '2026-10-22T02:00:00.000Z' })}\n`,
      'utf8',
    );

    const r = await w.run(['once', '--under', '99999999']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('不启动');
    expect(w.ledger()).toHaveLength(0);
  }, 120_000);

  // 整合方补（2026-10-23）：锁里的进程号对得上、但那个进程已经没了 → 不算继承，照原来拿锁、跑完放掉
  it('锁里的进程号就是 --under 的、但进程已经没了 → 照原来拿锁，跑完锁放掉', async () => {
    const w = makeWorld();
    worlds.push(w);
    const dead = 99999999;
    const lock = join(w.dataDir, 'lock.json');
    writeFileSync(
      lock,
      `${JSON.stringify({ pid: dead, startedAt: '2026-10-22T02:00:00.000Z' })}\n`,
      'utf8',
    );
    const r = await w.run(['once', '--under', String(dead)]);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.ledger()).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  }, 120_000);
});

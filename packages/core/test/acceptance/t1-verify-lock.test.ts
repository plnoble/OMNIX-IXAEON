/**
 * T1 验收条件 1–8：整台机器一把 verify 锁（scripts/lib/verify-lock.mjs）。
 *
 * 1. 拿到锁 → 锁文件里有自己的 pid / startedAt、没有路径；release 后没了。
 * 2. 活着的进程拿着锁 + wait:false → busy，带对方 pid。
 * 3. wait:true、pollMs 小：对方退出后拿到；等的时候 log 收到「另一次 verify 正在跑」。
 * 4. 锁里的 pid 已不在 / 内容不是 JSON → 接手，log 收到「已失效，接手」。
 * 5. 两个同时发起 → 只有一个拿到。
 * 6. release 时锁里的 pid 不是自己 → 不删。
 * 7. maxWaitMs 到了仍拿不到 → busy。
 * 8. verify.mjs 在 CI 有值时不拿锁（读源码核对）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireVerifyLock } from '../../../../scripts/lib/verify-lock.mjs';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-t1-'));
  lockPath = join(dir, 'verify.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function spawnAlive(): Promise<{ pid: number; kill: () => void }> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
  return new Promise((resolvePromise) => {
    child.once('spawn', () =>
      resolvePromise({ pid: child.pid!, kill: () => child.kill('SIGKILL') }),
    );
  });
}

describe('条件 1：拿到锁', () => {
  it('锁文件里是自己的 pid / startedAt，没有路径；release 后没了', async () => {
    const got = await acquireVerifyLock({ path: lockPath });
    expect('busy' in got).toBe(false);
    const raw = readFileSync(lockPath, 'utf8');
    const holder = JSON.parse(raw) as { pid: number; startedAt: string };
    expect(holder.pid).toBe(process.pid);
    expect(Number.isNaN(new Date(holder.startedAt).getTime())).toBe(false);
    expect(raw).not.toContain(dir);
    expect(raw).not.toContain('\\');
    (got as { release: () => void }).release();
    expect(() => readFileSync(lockPath, 'utf8')).toThrow();
  });
});

describe('条件 2：活锁 + wait:false → busy', () => {
  it('返回 busy，带对方 pid', async () => {
    const other = await spawnAlive();
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }),
      );
      const got = await acquireVerifyLock({ path: lockPath, wait: false });
      expect('busy' in got).toBe(true);
      expect((got as { holder: { pid: number } }).holder.pid).toBe(other.pid);
    } finally {
      other.kill();
    }
  });
});

describe('条件 3：wait 等到对方结束', () => {
  it('对方退出后拿到锁；等的时候 log 有「另一次 verify 正在跑」', async () => {
    const other = await spawnAlive();
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }),
    );
    const lines: string[] = [];
    const waiting = acquireVerifyLock({
      path: lockPath,
      wait: true,
      pollMs: 30,
      maxWaitMs: 8000,
      log: (l: string) => lines.push(l),
    });
    // 等一小会儿再杀掉对方，让轮询跑起来
    await new Promise((r) => setTimeout(r, 120));
    other.kill();
    const got = await waiting;
    expect('busy' in got).toBe(false);
    expect(lines.join('\n')).toContain('另一次 verify 正在跑');
    (got as { release: () => void }).release();
  });
});

describe('条件 4：死锁 / 读不懂的锁 → 接手', () => {
  it('pid 不在 → 接手并打印「已失效，接手」', async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
    );
    const lines: string[] = [];
    const got = await acquireVerifyLock({
      path: lockPath,
      wait: false,
      log: (l: string) => lines.push(l),
    });
    expect('busy' in got).toBe(false);
    expect(lines.join('\n')).toContain('已失效，接手');
    (got as { release: () => void }).release();
  });

  it('内容不是 JSON → 接手', async () => {
    writeFileSync(lockPath, 'not json');
    const lines: string[] = [];
    const got = await acquireVerifyLock({
      path: lockPath,
      wait: false,
      log: (l: string) => lines.push(l),
    });
    expect('busy' in got).toBe(false);
    expect(lines.join('\n')).toContain('已失效，接手');
    (got as { release: () => void }).release();
  });
});

describe('条件 5：两个同时发起只有一个拿到', () => {
  it('Promise.all 里恰好一个非 busy', async () => {
    const [a, b] = await Promise.all([
      acquireVerifyLock({ path: lockPath, wait: false }),
      acquireVerifyLock({ path: lockPath, wait: false }),
    ]);
    const ok = [a, b].filter((r) => !('busy' in r));
    expect(ok).toHaveLength(1);
    (ok[0] as { release: () => void }).release();
  });
});

describe('条件 6：release 只删自己的锁', () => {
  it('锁里的 pid 被换成别人 → 不删', async () => {
    const got = await acquireVerifyLock({ path: lockPath });
    const other = { pid: 424_242, startedAt: new Date().toISOString() };
    writeFileSync(lockPath, JSON.stringify(other));
    (got as { release: () => void }).release();
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(other.pid);
  });
});

describe('条件 7：maxWaitMs 到了还是 busy', () => {
  it('等超时返回 busy', async () => {
    const other = await spawnAlive();
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }),
      );
      const startedAt = Date.now();
      let logs = 0;
      const got = await acquireVerifyLock({
        path: lockPath,
        wait: true,
        pollMs: 20,
        maxWaitMs: 120,
        log: () => {
          logs += 1;
        },
      });
      const waited = Date.now() - startedAt;
      expect('busy' in got).toBe(true);
      // 真的等到了期限，而不是第一次就放弃
      expect(logs).toBe(0); // 不到一分钟不重复打印
      expect(waited).toBeGreaterThanOrEqual(100);
      expect(waited).toBeLessThan(2000);
    } finally {
      other.kill();
    }
  });
});

describe('条件 8：CI 有值时不拿锁', () => {
  function runVerify(
    env: NodeJS.ProcessEnv,
    args: string[],
  ): Promise<{ code: number | null; out: string }> {
    return new Promise((resolvePromise) => {
      const child = spawn(process.execPath, ['scripts/verify.mjs', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
      });
      let out = '';
      child.stdout.on('data', (b) => (out += String(b)));
      child.stderr.on('data', (b) => (out += String(b)));
      const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ code, out });
      });
    });
  }

  it('CI 有值时：锁被别人拿着也照常开始跑（不打印等待、不以 4 退出）', async () => {
    const other = await spawnAlive();
    try {
      // 锁文件在 tmpdir 的默认名，verify 用的是它
      writeFileSync(
        join(tmpdir(), 'ixaeon-verify.lock'),
        JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }),
      );
      const r = await runVerify({ CI: '1' }, ['--no-wait']);
      expect(r.out).not.toContain('另一次 verify 正在跑');
      expect(r.code).not.toBe(4);
    } finally {
      other.kill();
      rmSync(join(tmpdir(), 'ixaeon-verify.lock'), { force: true });
    }
  }, 40_000);

  it('没有 CI 时：锁被别人拿着 + --no-wait → 立刻退出码 4', async () => {
    const other = await spawnAlive();
    try {
      writeFileSync(
        join(tmpdir(), 'ixaeon-verify.lock'),
        JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }),
      );
      const r = await runVerify({}, ['--no-wait']);
      expect(r.code).toBe(4);
      expect(r.out).toContain('另一次 verify 正在跑');
    } finally {
      other.kill();
      rmSync(join(tmpdir(), 'ixaeon-verify.lock'), { force: true });
    }
  }, 40_000);
});

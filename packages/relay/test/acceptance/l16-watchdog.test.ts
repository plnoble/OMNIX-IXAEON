/**
 * L16 验收测试（六）：看门人顺带管着收听进程（规格条件 6，对应契约第 5 条）。
 *
 * 逐条对应：
 * - `IXAEON_RELAY_CODE` 指向一个假代码目录（它的 `relay.mjs listen` 打一行就退出）、
 *   `feishu-app.json` 四项齐 → 看门人起了收听、退出后又起（`收听 <pid> 退出 <码>`）；
 * - 文件不全 → 不起。
 *
 * 合成世界照 `l10-harness`；队列里没有能接的活，`once` 马上空转退出，看门人 `--exit-when-idle` 退出前
 * 会先停掉收听。原话、密钥全是合成的；不调真模型、不连 GitHub。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './l10-harness.js';

const SECRET = 'synthetic-secret-not-real';
const worlds: World[] = [];
const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * 假代码目录：`listen` 打一行（带上自己收到的参数）就退；`once` 过 5 秒再退（队列里没活）。
 * 整合方改（2026-10-24）：原来 `once` 马上退，看门人 `--exit-when-idle` 第一轮空转就退了，
 * 收听根本来不及「退出后隔 idleSeconds 再起」——实现写对了也过不了。
 * `hang: true`：`listen` 把自己的进程号写进 pidFile 后一直挂着，看看门人退出前有没有停掉它。
 */
const fakeCode = (o: { hang?: boolean; pidFile?: string } = {}): string => {
  const dir = tmp('ixa-l16-fakecode-');
  const bin = join(dir, 'packages', 'relay', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'relay.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      'const cmd = process.argv[2];',
      'if (cmd === "listen") {',
      '  console.log(`收听测试 ${process.pid} 参数 ${process.argv.slice(3).join(" ")}`);',
      o.hang
        ? `  writeFileSync(${JSON.stringify(o.pidFile ?? '')}, String(process.pid), 'utf8'); setTimeout(() => process.exit(0), 150_000); // 兜底：没人停也不留孤儿`
        : '  process.exitCode = 0;',
      '} else {',
      '  setTimeout(() => { process.exitCode = 0; }, 5000);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return dir;
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pids = (stdout: string): string[] =>
  [...stdout.matchAll(/收听 (\d+) 退出 0/g)].map((m) => m[1]!);

describe('条件 6：看门人管收听', () => {
  it('feishu-app.json 四项齐 → 起了收听、退出后又起；退出前停掉', async () => {
    const w = makeWorld({ status: '已完成（2026-10-24）', idleSeconds: 1 });
    worlds.push(w);
    writeFileSync(
      join(w.dataDir, 'feishu-app.json'),
      `${JSON.stringify({ appId: 'cli_synthetic', appSecret: SECRET, chatId: 'oc_bound', ownerOpenId: 'ou_owner' })}\n`,
      'utf8',
    );
    const r = await w.run(['run', '--exit-when-idle'], { IXAEON_RELAY_CODE: fakeCode() });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const seen = pids(r.stdout);
    expect(seen.length).toBeGreaterThanOrEqual(2); // 退出后又起
    expect(new Set(seen).size).toBe(seen.length); // 每次是新进程
    expect(r.stdout).not.toContain(SECRET);
    // 整合方补：子进程是 `listen --under <看门人的进程号>`
    const watchdogPid = /看门人 (\d+)/.exec(r.stdout)?.[1];
    expect(watchdogPid).toBeTruthy();
    expect(r.stdout).toContain(`参数 --under ${watchdogPid}`);
  }, 180_000);

  it('整合方补：--exit-when-idle 退出前停掉还挂着的收听', async () => {
    const w = makeWorld({ status: '已完成（2026-10-24）', idleSeconds: 1 });
    worlds.push(w);
    writeFileSync(
      join(w.dataDir, 'feishu-app.json'),
      `${JSON.stringify({ appId: 'cli_synthetic', appSecret: SECRET, chatId: 'oc_bound', ownerOpenId: 'ou_owner' })}\n`,
      'utf8',
    );
    const pidFile = join(tmp('ixa-l16-pid-'), 'listen.pid');
    const r = await w.run(['run', '--exit-when-idle'], {
      IXAEON_RELAY_CODE: fakeCode({ hang: true, pidFile }),
    });
    expect(r.status, r.stderr || r.stdout).toBe(0); // 没停掉收听的话，看门人退不出来，到点被杀（status 不是 0）
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((x) => setTimeout(x, 1000));
    expect(alive(pid)).toBe(false);
  }, 180_000);

  it('feishu-app.json 不全 → 不起收听', async () => {
    const w = makeWorld({ status: '已完成（2026-10-24）', idleSeconds: 1 });
    worlds.push(w);
    writeFileSync(
      join(w.dataDir, 'feishu-app.json'),
      `${JSON.stringify({ appId: 'cli_synthetic', appSecret: SECRET })}\n`,
      'utf8',
    );
    const r = await w.run(['run', '--exit-when-idle'], { IXAEON_RELAY_CODE: fakeCode() });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(pids(r.stdout)).toEqual([]);
    expect(r.stdout).not.toContain('收听 ');
  }, 180_000);
});

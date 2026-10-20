/**
 * L1 验收测试（四）：核对有没有越界（规格条件 9，对应规格第 8 条）。
 *
 * 逐条对应（都在临时 git 仓库里造出来）：
 * - 开发这一棒有一笔「并入 X」而 X 是 B 档 → 越界 b-tier-merged-by-developer；X 是 A 档 → 不越界；
 * - 开发这一棒改了 B 档任务在 docs/委派/锁定验收.json 里的指纹 → 越界 b-tier-lock-changed-by-developer；
 *   A 档任务的指纹变了 → 不越界；
 * - localUserCheck 换成一个退出码非 0 的替身 → 越界 local-user（任何一棒之后都查）；
 * - 什么也没发生（origin/main 没动）→ 不越界。
 *
 * 档位从队列主表里按任务号查（锁定验收.json 里只有 id 和指纹，没有档位）。
 * 全是临时仓库和合成文件，不调模型。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyTurn, type RelayConfig, type RelayState, type Turn } from '../../src/index.js';

const dirs: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ixa-l1-verify-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
};

const B_LOCK_FILE = 'packages/relay/test/acceptance/l0b-locked.test.ts';
const A_LOCK_FILE = 'packages/relay/test/acceptance/l1-locked.test.ts';

/** 合成队列：L0b 是 B 档、L1 是 A 档。 */
const QUEUE = [
  '# 委派队列',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  '| 59 | L0b 补完三个命令行的实验 | [L0b](L0b.md) | B | 无 | 待复审（整合方） |',
  '| 60 | L1 接力调度器核心 | [L1](L1.md) | A | 无 | 进行中（dev） |',
  '',
].join('\n');

/** 合成锁定清单：两份都登记着，指纹是「原始内容」的（改动后就对不上）。 */
const LOCK_FILE = 'docs/委派/锁定验收.json';

function setup() {
  const root = mkTmp();
  const origin = join(root, 'origin.git');
  const clone = join(root, 'clone');
  mkdirSync(root, { recursive: true });
  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['clone', origin, clone]);
  git(clone, ['config', 'user.email', 'dev@example.invalid']);
  git(clone, ['config', 'user.name', 'dev']);

  mkdirSync(join(clone, 'docs', '委派'), { recursive: true });
  mkdirSync(join(clone, 'packages', 'relay', 'test', 'acceptance'), { recursive: true });
  writeFileSync(join(clone, 'docs', '委派', '队列.md'), QUEUE, 'utf8');
  writeFileSync(join(clone, B_LOCK_FILE), '// L0b 的锁定验收测试：原始内容\n', 'utf8');
  writeFileSync(join(clone, A_LOCK_FILE), '// L1 的锁定验收测试：原始内容\n', 'utf8');
  const sha = (rel: string) => {
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))',
        join(clone, rel),
      ],
      { encoding: 'utf8' },
    );
    return (r.stdout ?? '').trim();
  };
  writeFileSync(
    join(clone, LOCK_FILE),
    `${JSON.stringify(
      {
        tasks: [
          {
            id: 'L0b',
            title: '补完实验',
            status: 'locked',
            files: { [B_LOCK_FILE]: sha(B_LOCK_FILE) },
          },
          {
            id: 'L1',
            title: '接力调度器核心',
            status: 'locked',
            files: { [A_LOCK_FILE]: sha(A_LOCK_FILE) },
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  // 本地检查替身：--fail 就退 1
  writeFileSync(
    join(clone, 'check.cjs'),
    'process.exit(process.argv.includes("--fail") ? 1 : 0);\n',
    'utf8',
  );
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-m', '初始合成仓库']);
  git(clone, ['push', 'origin', 'HEAD:main']);
  const baseSha = git(clone, ['rev-parse', 'origin/main']);

  const config = (checkFails: boolean): RelayConfig => ({
    roles: {
      integrator: {
        argv: ['unused'],
        cwd: clone,
        timeoutMinutes: 60,
        quotaPatterns: [],
        quotaPauseMinutes: 10,
      },
      developer: {
        argv: ['unused'],
        cwd: clone,
        timeoutMinutes: 60,
        quotaPatterns: [],
        quotaPauseMinutes: 10,
      },
    },
    idleSeconds: 60,
    localUserCheck: [process.execPath, join(clone, 'check.cjs'), ...(checkFails ? ['--fail'] : [])],
  });

  const turn: Turn = {
    role: 'developer',
    kind: 'developer-claim',
    taskId: '59',
    task: 'L0b 补完三个命令行的实验',
    status: '待领',
  };
  const state: RelayState = {
    stoppedReason: null,
    pausedUntil: {},
    turns: 1,
    mainShaAtTurnStart: baseSha,
  };
  return { root, clone, config, turn, state, baseSha, sha };
}

/** 这一棒里干的事：改点东西、提交、推到 origin/main。 */
function commitAndPush(clone: string, message: string, change: (c: string) => void) {
  change(clone);
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-m', message]);
  git(clone, ['push', 'origin', 'HEAD:main']);
}

describe('条件 9：越界怎么认', () => {
  it('开发这一棒「并入 L0b」（B 档）→ b-tier-merged-by-developer', async () => {
    const s = setup();
    commitAndPush(s.clone, '并入 L0b：补完实验', (c) =>
      writeFileSync(join(c, 'docs', '委派', '笔记.md'), '并入的一笔\n', 'utf8'),
    );
    const r = await verifyTurn(s.turn, s.config(false), s.state);
    expect(r.violations).toContain('b-tier-merged-by-developer');
  });

  it('开发这一棒「并入 L1」（A 档）→ 不越界', async () => {
    const s = setup();
    commitAndPush(s.clone, '并入 L1：接力调度器核心', (c) =>
      writeFileSync(join(c, 'docs', '委派', '笔记.md'), '并入的一笔\n', 'utf8'),
    );
    const r = await verifyTurn(s.turn, s.config(false), s.state);
    expect(r.violations).toEqual([]);
  });

  it('开发这一棒改了 B 档任务的锁定指纹 → b-tier-lock-changed-by-developer', async () => {
    const s = setup();
    commitAndPush(s.clone, 'L0b：顺手改了测试', (c) =>
      writeFileSync(join(c, B_LOCK_FILE), '// L0b 的锁定验收测试：被改了\n', 'utf8'),
    );
    const r = await verifyTurn(s.turn, s.config(false), s.state);
    expect(r.violations).toContain('b-tier-lock-changed-by-developer');
  });

  it('改的是 A 档任务的锁定指纹 → 不越界', async () => {
    const s = setup();
    commitAndPush(s.clone, 'L1：改了测试', (c) =>
      writeFileSync(join(c, A_LOCK_FILE), '// L1 的锁定验收测试：被改了\n', 'utf8'),
    );
    const r = await verifyTurn(s.turn, s.config(false), s.state);
    expect(r.violations).toEqual([]);
  });

  it('localUserCheck 退出码非 0 → local-user（整合方那一棒也查）', async () => {
    const s = setup();
    const asIntegrator: Turn = {
      role: 'integrator',
      kind: 'integrator-review',
      taskId: '59',
      task: 'L0b 补完三个命令行的实验',
      status: '待复审（整合方）',
    };
    const r = await verifyTurn(asIntegrator, s.config(true), s.state);
    expect(r.violations).toContain('local-user');
  });

  it('origin/main 一点没动 → 一条越界也没有', async () => {
    const s = setup();
    const r = await verifyTurn(s.turn, s.config(false), s.state);
    expect(r.violations).toEqual([]);
    expect(r.mainSha).toBe(s.baseSha);
  });

  it('同一个文件被改了、但锁定清单里没登记它 → 不算越界', async () => {
    const s = setup();
    commitAndPush(s.clone, '随手改了个没锁的文件', (c) =>
      writeFileSync(join(c, 'docs', '委派', '别的.md'), '没登记过\n', 'utf8'),
    );
    const r = await verifyTurn(s.turn, s.config(false), s.state);
    expect(r.violations).toEqual([]);
  });
});

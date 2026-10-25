/**
 * L11 验收条件 2：越界按提交者分账。
 * - 开发那一棒：这期间「并入 B 档」的提交是**整合方署名**的 → 不算开发越界；开发自己署名的才算。
 * - 规划棒：这期间**开发署名**的 packages/ 改动、别行状态改动 → 不算规划越界；整合方自己署名的才算。
 * - 没配 gitIdentity：照原来的口径（整段都算这一棒的）。
 *
 * 直接调 `verifyTurn`（它只读合成仓库、`git fetch` 也只打到临时裸仓库），不起调度器进程。
 * `gitIdentity` 还没实现，按新口径写的条目现在是红的（测试先行）。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyTurn } from '../../src/verify.js';
import type { RelayConfig, RelayState, Turn } from '../../src/types.js';

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const QUEUE = ['docs', '委派', '队列.md'].join('/');
const LOCK = ['docs', '委派', '锁定验收.json'].join('/');

const queueOf = () =>
  [
    '# 委派队列',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    '| 70 | L7 合成的一行 | [L7](L7.md) | B | 无 | 待领 |',
    '| 71 | L8 合成的另一行 | [L8](L8.md) | A | 无 | 待领 |',
    '',
  ].join('\n');

interface Repo {
  integ: string;
  /** 开棒时 origin/main 的提交号（核对起点）。 */
  since: string;
  /** 在 origin/main 上追加一笔署名提交（改一个文件），返回新的 origin/main。 */
  push(who: 'dev' | 'integrator', file: string, content: string, message: string): string;
}

/** 合成仓库：裸 origin + 整合方克隆（核对跑在它里面）。 */
function makeRepo(): Repo {
  const root = temp('ixa-l11-acc-');
  const origin = join(root, 'origin.git');
  const integ = join(root, 'integ');
  const must = (cwd: string, args: string[], env?: Record<string, string>) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  };
  must(root, ['init', '--bare', '-b', 'main', origin]);
  must(root, ['clone', origin, integ]);
  must(integ, ['config', 'user.email', 'relay@example.invalid']);
  must(integ, ['config', 'user.name', 'relay']);
  mkdirSync(join(integ, 'docs', '委派'), { recursive: true });
  writeFileSync(join(integ, QUEUE), queueOf(), 'utf8');
  writeFileSync(join(integ, LOCK), '{"tasks":[]}\n', 'utf8');
  must(integ, ['add', '-A']);
  must(integ, ['commit', '-q', '-m', '初始合成仓库']);
  must(integ, ['push', '-q', 'origin', 'HEAD:main']);

  const repo: Repo = {
    integ,
    since: '',
    push(who, file, content, message) {
      const env =
        who === 'dev'
          ? {
              GIT_AUTHOR_NAME: 'dev',
              GIT_AUTHOR_EMAIL: 'dev@ixaeon.invalid',
              GIT_COMMITTER_NAME: 'dev',
              GIT_COMMITTER_EMAIL: 'dev@ixaeon.invalid',
            }
          : {
              GIT_AUTHOR_NAME: 'relay-integrator',
              GIT_AUTHOR_EMAIL: 'integrator@ixaeon.invalid',
              GIT_COMMITTER_NAME: 'relay-integrator',
              GIT_COMMITTER_EMAIL: 'integrator@ixaeon.invalid',
            };
      const abs = join(integ, ...file.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      must(integ, ['add', '-A']);
      must(integ, ['commit', '-q', '-m', message], env);
      must(integ, ['push', '-q', 'origin', 'HEAD:main']);
      const sha = spawnSync('git', ['rev-parse', 'origin/main'], {
        cwd: integ,
        encoding: 'utf8',
        windowsHide: true,
      });
      return sha.stdout.trim();
    },
  };
  repo.since = spawnSync('git', ['rev-parse', 'origin/main'], {
    cwd: integ,
    encoding: 'utf8',
    windowsHide: true,
  }).stdout.trim();
  return repo;
}

function relayConfig(repo: Repo, identity?: { dev?: boolean; integ?: boolean }): RelayConfig {
  return {
    roles: {
      integrator: {
        argv: ['node', '-e', ''],
        cwd: repo.integ,
        timeoutMinutes: 5,
        quotaPatterns: [],
        quotaPauseMinutes: 30,
        ...(identity?.integ
          ? { gitIdentity: { name: 'relay-integrator', email: 'integrator@ixaeon.invalid' } }
          : {}),
      },
      developer: {
        argv: ['node', '-e', ''],
        cwd: join(repo.integ, '..', 'dev'),
        timeoutMinutes: 5,
        quotaPatterns: [],
        quotaPauseMinutes: 30,
        ...(identity?.dev ? { gitIdentity: { name: 'dev', email: 'dev@ixaeon.invalid' } } : {}),
      },
    },
    idleSeconds: 1,
    localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
  } as unknown as RelayConfig;
}

const stateAt = (since: string): RelayState =>
  ({
    stoppedReason: null,
    pausedUntil: {},
    turns: 1,
    notify: { sent: {} },
    mainShaAtTurnStart: since,
  }) as unknown as RelayState;

describe('条件 2：开发那一棒按提交者分账', () => {
  const devTurn: Turn = {
    role: 'developer',
    kind: 'developer-continue',
    taskId: '70',
    task: 'L7 合成的一行',
    status: '进行中（dev）',
  };

  it('这期间「并入 B 档」的提交是整合方署名的 → 不算开发越界', async () => {
    const repo = makeRepo();
    const after = repo.push(
      'integrator',
      'docs/委派/交付/X.md',
      '整合方并的\n',
      '并入 L7：整合方合并 B 档',
    );
    const r = await verifyTurn(devTurn, relayConfig(repo, { dev: true }), stateAt(repo.since));
    expect(after).not.toBe(repo.since);
    expect(r.violations).toEqual([]);
  });

  it('开发自己署名的「并入 B 档」→ 照原来 b-tier-merged-by-developer、停下', async () => {
    const repo = makeRepo();
    repo.push('dev', 'docs/委派/交付/Y.md', '开发并的\n', '并入 L7：开发自己并的');
    const r = await verifyTurn(devTurn, relayConfig(repo, { dev: true }), stateAt(repo.since));
    expect(r.violations).toContain('b-tier-merged-by-developer');
  });

  it('没配 gitIdentity：照原来的口径（别人的并入也算这一棒的）', async () => {
    const repo = makeRepo();
    repo.push('integrator', 'docs/委派/交付/X.md', '整合方并的\n', '并入 L7：整合方合并 B 档');
    const r = await verifyTurn(devTurn, relayConfig(repo), stateAt(repo.since));
    expect(r.violations).toContain('b-tier-merged-by-developer');
  });
});

describe('条件 2：规划棒按提交者分账', () => {
  const planTurn: Turn = {
    role: 'integrator',
    kind: 'integrator-plan',
    taskId: 'plan',
    task: '规划',
    status: '规划',
  };

  it('这期间开发署名的 packages/ 改动、别行状态改动 → 不算规划越界', async () => {
    const repo = makeRepo();
    repo.push('dev', 'packages/合成.txt', '开发道推的\n', '开发：顺手改的');
    repo.push(
      'dev',
      QUEUE,
      queueOf().replace(
        '| 71 | L8 合成的另一行 | [L8](L8.md) | A | 无 | 待领 |',
        '| 71 | L8 合成的另一行 | [L8](L8.md) | A | 无 | 进行中（dev） |',
      ),
      '开发：改了另一行的状态',
    );
    const r = await verifyTurn(planTurn, relayConfig(repo, { integ: true }), stateAt(repo.since));
    expect(r.violations).toEqual([]);
  });

  it('整合方自己署名的 packages/ 改动 → plan-touched-code；自己改已有一行 → plan-changed-rows', async () => {
    const repo = makeRepo();
    repo.push('integrator', 'packages/合成.txt', '规划棒越界了\n', '规划：不该碰代码');
    const r = await verifyTurn(planTurn, relayConfig(repo, { integ: true }), stateAt(repo.since));
    expect(r.violations).toContain('plan-touched-code');

    const repo2 = makeRepo();
    repo2.push(
      'integrator',
      QUEUE,
      queueOf().replace(
        '| 71 | L8 合成的另一行 | [L8](L8.md) | A | 无 | 待领 |',
        '| 71 | L8 合成的另一行 | [L8](L8.md) | A | 无 | 已完成（2026-10-23） |',
      ),
      '规划：改了已有的一行',
    );
    const r2 = await verifyTurn(
      planTurn,
      relayConfig(repo2, { integ: true }),
      stateAt(repo2.since),
    );
    expect(r2.violations).toContain('plan-changed-rows');
  });

  it('没配 gitIdentity：照原来的口径（开发的 packages/ 改动也算规划棒的）', async () => {
    const repo = makeRepo();
    repo.push('dev', 'packages/合成.txt', '开发道推的\n', '开发：顺手改的');
    const r = await verifyTurn(planTurn, relayConfig(repo), stateAt(repo.since));
    expect(r.violations).toContain('plan-touched-code');
  });
});

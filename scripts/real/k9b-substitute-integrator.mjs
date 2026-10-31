#!/usr/bin/env node
/**
 * K9b 真机检查：整合方在歇时，替补整合方（真 DSH + 用户自建的替补补丁）跑一棒。
 *
 * 照 `scripts/real/l10-watchdog.mjs` 的做法：临时裸仓库当 origin、临时克隆/工作目录、
 * `IXAEON_WORKTREES` 指到临时目录，**不碰用户真实的 relay 数据目录**。合成队列里一行
 * 「待复审（整合方）」、`pausedUntil.integrator` 设到两小时后，替补的 argv 用真的 DSH 启动器
 * 和用户自建的 `~/.dsh/ixaeon-integrate.patch.yml`（模型由用户填）。跑一次 `relay once`，
 * 打印记账那一行、那一行在 origin/main 上的新状态、main 上改动的文件列表
 * （只该有 `docs/委派/` 下的）。临时目录、家目录遮掉，不打印补丁内容、不打印 argv。
 *
 * 用户还没建替补补丁 → 输出「没跑：等用户建补丁、选模型」并退出 0（没跑，不是失败）。
 * 补丁路径可以用 `IXAEON_INTEGRATE_PATCH` 换（测试用），数据目录里的补丁路径是现算的。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const patch =
  process.env.IXAEON_INTEGRATE_PATCH?.trim() ||
  join(homedir(), '.dsh', 'ixaeon-integrate.patch.yml');
const work = mkdtempSync(join(tmpdir(), 'ixa-k9b-real-'));

/** 输出里不出现本机账户名、临时目录。 */
function mask(text) {
  let out = String(text);
  for (const p of [work, tmpdir(), homedir()]) {
    if (p) out = out.split(p).join(p === homedir() ? '<家目录>' : '<临时目录>');
  }
  return out;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
}

const QUEUE = [
  '# 委派队列',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  '| 9856 | K9b 合成的一行：替补预审 | [K9b](../../K9b-整合方顶班.md) | B | 无 | 待复审（整合方） |',
  '',
].join('\n');

try {
  if (!existsSync(patch)) {
    console.log('没跑：等用户建补丁、选模型');
    console.log(`（替补补丁不在：${mask(patch)}）`);
    process.exitCode = 0;
  } else {
    const origin = join(work, 'origin.git');
    const repo = join(work, 'repo');
    const integ = join(work, 'relay-int');
    const dev = join(work, 'dev');
    const relay = join(work, 'relay');
    const dsh = join(root, 'packages', 'relay', 'bin', 'dsh.mjs');
    mkdirSync(relay, { recursive: true });

    git(work, ['init', '--bare', '-b', 'main', origin]);
    git(work, ['clone', '-q', origin, repo]);
    git(repo, ['config', 'user.email', 'relay@example.invalid']);
    git(repo, ['config', 'user.name', 'relay']);
    mkdirSync(join(repo, 'docs', '委派', '交付'), { recursive: true });
    writeFileSync(join(repo, 'docs', '委派', '队列.md'), QUEUE, 'utf8');
    writeFileSync(join(repo, 'AGENTS.md'), '# 合成 AGENTS.md\n\n真机检查的临时仓库。\n', 'utf8');
    writeFileSync(
      join(repo, 'docs', '委派', '交付', 'K9b.md'),
      '# K9b 交付\n\n真机检查的合成交付说明。\n',
      'utf8',
    );
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', '初始合成仓库']);
    git(repo, ['push', '-q', 'origin', 'HEAD:main']);
    const base = git(repo, ['rev-parse', 'origin/main']);
    git(repo, ['worktree', 'add', '--detach', '-q', integ, 'origin/main']);
    git(work, ['clone', '-q', origin, dev]);
    git(dev, ['config', 'user.email', 'relay@example.invalid']);
    git(dev, ['config', 'user.name', 'relay']);

    const paused = new Date(Date.now() + 2 * 3_600_000).toISOString();
    writeFileSync(
      join(relay, 'config.json'),
      `${JSON.stringify(
        {
          roles: {
            integrator: {
              argv: ['claude'],
              cwd: integ,
              timeoutMinutes: 1,
              quotaPatterns: ['usage_limit_reached'],
              quotaPauseMinutes: 120,
            },
            developer: {
              argv: ['node', '未用到的替身'],
              cwd: dev,
              timeoutMinutes: 1,
              quotaPatterns: ['usage_limit_reached'],
              quotaPauseMinutes: 120,
            },
            integratorSubstitute: {
              argv: [
                'node',
                dsh,
                '--profile',
                'headless',
                '--json',
                '--patch',
                patch,
                '读 {prompt_file}，照里面做。',
              ],
              label: 'DSH + 用户补丁（K9b 真机检查）',
            },
          },
          idleSeconds: 60,
          localUserCheck: ['node', '-e', 'process.exit(0)'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(relay, 'state.json'),
      `${JSON.stringify(
        { stoppedReason: null, pausedUntil: { integrator: paused }, turns: 0 },
        null,
        2,
      )}\n`,
      'utf8',
    );

    console.log('跑一棒替补整合方（真 DSH + 用户补丁）……');
    const r = spawnSync(
      process.execPath,
      [join(root, 'packages', 'relay', 'bin', 'relay.mjs'), 'once'],
      {
        cwd: repo,
        env: {
          ...process.env,
          IXAEON_RELAY_DIR: relay,
          IXAEON_WORKTREES: join(work, 'trees'),
          IXAEON_RELAY_NOW: new Date().toISOString(),
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20 * 60 * 1000,
      },
    );
    console.log(mask(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim()));

    const ledgerPath = join(relay, 'ledger.jsonl');
    if (!existsSync(ledgerPath)) {
      console.log('没有记账：这一棒没开（看上面输出）。');
      process.exitCode = 1;
    } else {
      const rows = readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const last = rows[rows.length - 1];
      console.log(`记账行：${mask(JSON.stringify(last))}`);
      const mainSha = git(repo, ['rev-parse', 'origin/main']);
      const changed = git(repo, [
        '-c',
        'core.quotepath=false',
        'diff',
        '--name-only',
        base,
        mainSha,
      ]);
      console.log('main 上改动的文件：');
      console.log(changed ? mask(changed) : '（没有）');
      const queueMd = git(repo, ['show', 'origin/main:docs/委派/队列.md']);
      const line = queueMd.split('\n').find((l) => l.includes('9856')) ?? '';
      console.log(`那一行的新状态：${mask(line.trim())}`);
      const outside = changed.split('\n').filter((f) => f && !f.startsWith('docs/委派/'));
      console.log(
        outside.length
          ? `注意：main 上改了 docs/委派/ 以外的文件：${outside.join('、')}`
          : '越界：没有',
      );
      process.exitCode = last?.violations?.length ? 1 : 0;
    }
  }
} catch (e) {
  console.error(mask(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

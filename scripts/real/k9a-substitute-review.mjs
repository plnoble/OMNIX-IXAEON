#!/usr/bin/env node
/**
 * K9a 真机检查：Codex 报额度用完时，替补审查（真 DSH + 用户自建的替补补丁）跑一次审查。
 *
 * 临时合成仓库里造一个小分支（一处明显的 bug），把本仓库的 `scripts/codex-review.mjs` 拷进去；
 * `CODEX_BIN` 指向一个只打「用量到顶」的替身；调度器配置的 `roles.reviewer` 用真的 DSH
 * 启动器和用户自建的 `~/.dsh/ixaeon-review.patch.yml`（模型由用户填）。跑完打印结论文件
 * 开头几行和退出码；临时目录、家目录遮掉，不打印补丁内容、不打印 argv。
 *
 * 用户还没建替补补丁 → 输出「没跑：等用户建补丁、选模型」并退出 0（没跑，不是失败）。
 * 补丁路径可以用 `IXAEON_REVIEW_PATCH` 换（测试用）。
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const patch =
  process.env.IXAEON_REVIEW_PATCH?.trim() || join(homedir(), '.dsh', 'ixaeon-review.patch.yml');
const work = mkdtempSync(join(tmpdir(), 'ixa-k9a-real-'));

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

try {
  if (!existsSync(patch)) {
    console.log('没跑：等用户建补丁、选模型');
    console.log(`（替补补丁不在：${mask(patch)}）`);
    process.exitCode = 0;
  } else {
    const origin = join(work, 'origin.git');
    const repo = join(work, 'repo');
    const relay = join(work, 'relay');
    const codexStub = join(work, 'codex-quota.mjs');
    const dsh = join(root, 'packages', 'relay', 'bin', 'dsh.mjs');
    const taskId = 'K98';
    mkdirSync(relay, { recursive: true });

    git(work, ['init', '--bare', '-b', 'main', origin]);
    git(work, ['clone', '-q', origin, repo]);
    git(repo, ['config', 'user.email', 'relay@example.invalid']);
    git(repo, ['config', 'user.name', 'relay']);
    mkdirSync(join(repo, 'docs', '委派', '交付'), { recursive: true });
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(
      join(repo, 'docs', '委派', `${taskId}-合成.md`),
      [
        `# 规格 ${taskId}：合成的审查对象`,
        '',
        '## 验收条件',
        '',
        '1. 合成条件一：`calc.mjs` 的加法要真的加（这里只给 codex-review.mjs 喂上下文）。',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(repo, 'AGENTS.md'),
      '# 合成 AGENTS.md\n\n这是真机检查的临时仓库，规则不读真的。\n',
      'utf8',
    );
    writeFileSync(
      join(repo, 'docs', '委派', '交付', `${taskId}.md`),
      `# ${taskId} 合成交付\n\n真机检查用。\n`,
      'utf8',
    );
    copyFileSync(
      join(root, 'scripts', 'codex-review.mjs'),
      join(repo, 'scripts', 'codex-review.mjs'),
    );
    writeFileSync(join(repo, 'calc.mjs'), 'export const add = (a, b) => a + b;\n', 'utf8');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', '初始合成仓库']);
    git(repo, ['push', '-q', 'origin', 'HEAD:main']);
    git(repo, ['switch', '-q', '-c', `dev/${taskId}`]);
    // 一处明显的 bug：加法写成减法，审查者应该看得出来。
    writeFileSync(
      join(repo, 'calc.mjs'),
      'export const add = (a, b) => a - b; // 明显的 bug\n',
      'utf8',
    );
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', '合成：一处明显的 bug']);

    writeFileSync(codexStub, "console.log('usage limit reached');\nprocess.exit(1);\n", 'utf8');
    writeFileSync(
      join(relay, 'config.json'),
      `${JSON.stringify(
        {
          roles: {
            integrator: {
              argv: ['claude'],
              quotaPatterns: ['usage_limit_reached', 'session limit'],
            },
            reviewer: {
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
              label: 'DSH + 用户补丁（K9a 真机检查）',
              timeoutSeconds: 1200,
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    console.log('跑一次替补审查（真 DSH + 用户补丁）……');
    const r = spawnSync(process.execPath, [join(repo, 'scripts', 'codex-review.mjs'), taskId], {
      cwd: repo,
      env: { ...process.env, CODEX_BIN: codexStub, IXAEON_RELAY_DIR: relay },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 25 * 60 * 1000,
    });
    const reviewFile = join(repo, 'docs', '委派', '交付', `${taskId}-Codex审查.md`);
    console.log(`退出码：${r.status ?? r.error?.message ?? 'null'}`);
    if (existsSync(reviewFile)) {
      const lines = readFileSync(reviewFile, 'utf8').split(/\r?\n/).slice(0, 10);
      console.log('结论文件开头几行：');
      console.log(mask(lines.join('\n')));
      process.exitCode = 0;
    } else {
      console.log('没有写出结论文件。审查命令最后几行输出：');
      console.log(
        mask(
          `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').filter(Boolean).slice(-10).join('\n'),
        ),
      );
      process.exitCode = 1;
    }
  }
} catch (e) {
  console.error(mask(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

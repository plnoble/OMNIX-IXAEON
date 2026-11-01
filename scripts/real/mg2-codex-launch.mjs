/**
 * MG2b 真机检查（甲）：审查真的走本机 magpie 的分组。
 *
 * 合成一个最简 git 仓库，用真的 `scripts/codex-review.mjs`、真的 Codex，审查选
 * `group/group-ixaeon-review` → 贴退出码和结论文件开头。不碰 ~/.codex/config.toml。
 * 分组由用户在 magpie 里建；没有对应的分组时写「没跑：等用户在 magpie 里建分组」。
 *
 * 用法：node scripts/real/mg2-codex-launch.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const root = mkdtempSync(join(tmpdir(), 'ixa-mg2-codex-'));
const MAGPIE = 'http://127.0.0.1:3425';
const REVIEW_GROUP = 'group/group-ixaeon-review';

const mask = (s) => {
  let text = String(s);
  for (const p of [root, process.env.TEMP, process.env.USERPROFILE, homedir(), tmpdir()].filter(
    (x) => x && x.trim(),
  )) {
    text = text.split(p).join('<临时目录>');
    text = text.split(p.replaceAll('\\', '/')).join('<临时目录>');
    text = text.split(JSON.stringify(p).slice(1, -1)).join('<临时目录>');
  }
  const user = process.env.USERPROFILE ?? '';
  const name = user ? user.split(/[\\/]/).pop() : '';
  return name ? text.split(name).join('<账户名>') : text;
};
const log = (s) => console.log(mask(s));

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
};
const write = (path, text) => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
};

async function groups() {
  const res = await fetch(`${MAGPIE}/v1/models`, {
    headers: { authorization: 'Bearer magpie' },
    signal: AbortSignal.timeout(3_000),
  });
  const body = await res.json();
  return (body.data ?? [])
    .map((x) => x.id)
    .filter((id) => typeof id === 'string' && id.startsWith('group/'));
}

function runReviewer() {
  const base = join(root, 'review');
  const repo = join(base, 'repo');
  const relay = join(base, 'relay');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'docs', '委派', '交付'), { recursive: true });
  writeFileSync(
    join(repo, 'scripts', 'codex-review.mjs'),
    readFileSync(join(REPO, 'scripts', 'codex-review.mjs')),
  );
  write(join(repo, 'AGENTS.md'), '# 合成仓库规则\n');
  write(join(repo, 'docs', '委派', 'demo-合成规格.md'), '# demo 规格\n\n合成任务。\n');
  write(join(repo, 'docs', '委派', '交付', 'demo.md'), '# demo 交付\n');
  write(join(repo, 'base.txt'), 'base\n');
  git(repo, ['init', '-q']);
  git(repo, ['add', '.']);
  git(repo, [
    '-c',
    'user.name=MG2',
    '-c',
    'user.email=mg2@ixaeon.invalid',
    'commit',
    '-q',
    '-m',
    'base',
  ]);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  write(join(repo, 'change.txt'), 'change\n');
  git(repo, ['add', '.']);
  git(repo, [
    '-c',
    'user.name=MG2',
    '-c',
    'user.email=mg2@ixaeon.invalid',
    'commit',
    '-q',
    '-m',
    'change',
  ]);
  mkdirSync(relay, { recursive: true });
  write(
    join(relay, 'config.json'),
    `${JSON.stringify({ review: { magpieModel: REVIEW_GROUP, magpieUrl: MAGPIE } }, null, 2)}\n`,
  );

  const r = spawnSync(process.execPath, [join(repo, 'scripts', 'codex-review.mjs'), 'demo'], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, IXAEON_RELAY_DIR: relay },
    timeout: 30 * 60_000,
  });
  const file = join(repo, 'docs', '委派', '交付', 'demo-Codex审查.md');
  log(`== 甲（审查）真的 codex-review.mjs + 真的 Codex，模型 ${REVIEW_GROUP}`);
  log(`   codex-review.mjs 退出码：${r.status ?? '?'}`);
  if (r.error) log(`   起不来：${r.error.message}`);
  for (const line of `${r.stdout ?? ''}`.trim().split('\n').slice(-3)) log(`   ${line}`);
  if (existsSync(file)) {
    log('   结论文件开头：');
    for (const line of readFileSync(file, 'utf8').split('\n').slice(0, 8)) log(`   ${line}`);
  } else {
    log('   没有结论文件');
    for (const line of `${r.stderr ?? ''}`.trim().split('\n').slice(-5)) log(`   ${line}`);
  }
  return r.status === 0 && existsSync(file);
}

try {
  const found = await groups().catch(() => []);
  log(`magpie 的分组：${found.length} 个`);
  if (!found.includes(REVIEW_GROUP)) {
    log(`== 甲（审查）没跑：等用户在 magpie 里建分组 ${REVIEW_GROUP}`);
    process.exitCode = 1;
  } else {
    const ok = runReviewer();
    log(ok ? '== 结论：通过' : '== 结论：没通过');
    process.exitCode = ok ? 0 : 1;
  }
} catch (e) {
  log(`没跑成：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

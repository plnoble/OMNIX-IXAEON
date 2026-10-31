/**
 * K10a 验收 条件 6（规格 docs/委派/K10a-调度器面板.md，B 档：本周例外）。
 *
 * 条件 6：`codex-review.mjs`：`review.codexModel` 设成 `demo-model` → Codex 替身收到的参数里
 *          有 `-m demo-model`；不设 → 没有 `-m`。
 *
 * 做法：临时合成一个 git 仓库（有 origin/main、分支上有一处改动、规格 / 交付说明齐全），
 * 把 scripts/codex-review.mjs 原样复制过去跑；CODEX_BIN 指向一个替身，替身把自己收到的参数
 * 写进标记文件，并按 `-o` 写出「结论：可以合并」。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const dirs: string[] = [];
const savedRelay = process.env.IXAEON_RELAY_DIR;

afterEach(() => {
  if (savedRelay === undefined) delete process.env.IXAEON_RELAY_DIR;
  else process.env.IXAEON_RELAY_DIR = savedRelay;
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上句柄没关干净时删不掉，留给系统临时目录 */
    }
  }
});

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
}

const STUB = `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('1.2.3');
  process.exit(0);
}
const marker = process.env.K10A_MARKER;
if (marker) writeFileSync(marker, JSON.stringify(args), 'utf8');
const o = args.indexOf('-o');
if (o >= 0 && args[o + 1]) writeFileSync(args[o + 1], '结论：可以合并\\n', 'utf8');
console.log('替身审查完毕');
`;

function makeRepo(): { root: string; marker: string; relay: string } {
  const root = mkdtempSync(join(tmpdir(), 'ixaeon-k10a-codex-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'docs', '委派', '交付'), { recursive: true });
  copyFileSync(
    join(repoRoot, 'scripts', 'codex-review.mjs'),
    join(root, 'scripts', 'codex-review.mjs'),
  );
  writeFileSync(join(root, 'AGENTS.md'), '# 合成仓库规则\n', 'utf8');
  writeFileSync(
    join(root, 'docs', '委派', 'demo-合成规格.md'),
    '# demo 规格\n\n合成任务。\n',
    'utf8',
  );
  writeFileSync(join(root, 'docs', '委派', '交付', 'demo.md'), '# demo 交付\n', 'utf8');
  writeFileSync(join(root, 'base.txt'), 'base\n', 'utf8');
  const stub = join(root, 'stub-codex.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const marker = join(root, 'args.json');

  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=K10a 合成仓库',
    '-c',
    'user.email=k10a@ixaeon.invalid',
    'commit',
    '-q',
    '-m',
    'base',
  ]);
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  writeFileSync(join(root, 'change.txt'), 'change\n', 'utf8');
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=K10a 合成仓库',
    '-c',
    'user.email=k10a@ixaeon.invalid',
    'commit',
    '-q',
    '-m',
    'change',
  ]);

  const relay = join(root, 'relay');
  mkdirSync(relay, { recursive: true });
  return { root, marker, relay };
}

function run(
  root: string,
  relay: string,
  marker: string,
  codexModel: string | null,
): number | null {
  writeFileSync(
    join(relay, 'config.json'),
    `${JSON.stringify(codexModel ? { review: { codexModel } } : {}, null, 2)}\n`,
    'utf8',
  );
  process.env.IXAEON_RELAY_DIR = relay;
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'codex-review.mjs'), 'demo'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_BIN: join(root, 'stub-codex.mjs'),
      K10A_MARKER: marker,
      IXAEON_RELAY_DIR: relay,
    },
  });
  return r.status;
}

describe('条件 6：review.codexModel → codex exec 的 -m', () => {
  it('设了 demo-model → Codex 替身收到的参数里有 -m demo-model', () => {
    const { root, relay, marker } = makeRepo();
    expect(run(root, relay, marker, 'demo-model')).toBe(0);
    const args = JSON.parse(readFileSync(marker, 'utf8')) as string[];
    const at = args.indexOf('-m');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(args[at + 1]).toBe('demo-model');
  });

  it('没设 → 参数里没有 -m', () => {
    const { root, relay, marker } = makeRepo();
    expect(run(root, relay, marker, null)).toBe(0);
    const args = JSON.parse(readFileSync(marker, 'utf8')) as string[];
    expect(args).not.toContain('-m');
  });
});

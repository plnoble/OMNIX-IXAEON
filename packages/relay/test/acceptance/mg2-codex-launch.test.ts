/**
 * MG2b 验收（规格 docs/委派/MG2-角色走magpie轮动.md，B 档：本周例外，测试和实现一起在分支上）。
 *
 * 条件 3：审查选 a/m1 → Codex 替身收到 `-m a/m1`、provider 指向合成 magpie 的 `/v1`、Key 是
 *          magpie；「默认」→ 没有这些；`~/.codex/config.toml`（测试里指向临时目录）没被改。
 *
 * 条件 1（界面那一半）和它一起在 `apps/desktop/test/acceptance/mg2-panel.test.ts`。
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const dirs: string[] = [];
const savedRelay = process.env.IXAEON_RELAY_DIR;
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ixaeon-mg2b-codex-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  if (savedRelay === undefined) delete process.env.IXAEON_RELAY_DIR;
  else process.env.IXAEON_RELAY_DIR = savedRelay;
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上句柄没关干净时删不掉，留给系统临时目录 */
    }
  }
});

/** 合成一个最简 git 仓库，把 scripts/codex-review.mjs 原样复制过去跑。 */
function makeReviewRepo() {
  const root = mkTmp();
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
  writeFileSync(
    stub,
    `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('1.2.3');
  process.exit(0);
}
const marker = process.env.MG2_MARKER;
if (marker) writeFileSync(marker, JSON.stringify({
  args,
  key: process.env.MAGPIE_KEY ?? null,
  noProxy: process.env.NO_PROXY ?? null,
}), 'utf8');
const o = args.indexOf('-o');
if (o >= 0 && args[o + 1]) writeFileSync(args[o + 1], '结论：可以合并\\n', 'utf8');
console.log('替身审查完毕');
`,
    'utf8',
  );
  const git = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
  };
  git(['init', '-q']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=MG2 合成仓库',
    '-c',
    'user.email=mg2@ixaeon.invalid',
    'commit',
    '-q',
    '-m',
    'base',
  ]);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  writeFileSync(join(root, 'change.txt'), 'change\n', 'utf8');
  git(['add', '.']);
  git([
    '-c',
    'user.name=MG2 合成仓库',
    '-c',
    'user.email=mg2@ixaeon.invalid',
    'commit',
    '-q',
    '-m',
    'change',
  ]);

  const relay = join(root, 'relay');
  mkdirSync(relay, { recursive: true });
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), 'model = "keep"\n', 'utf8');
  return { root, relay, marker: join(root, 'args.json'), codexHome };
}

function runReview(
  root: string,
  relay: string,
  marker: string,
  codexHome: string,
  review: Record<string, unknown>,
): number | null {
  writeFileSync(
    join(relay, 'config.json'),
    `${JSON.stringify(Object.keys(review).length ? { review } : {}, null, 2)}\n`,
    'utf8',
  );
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'codex-review.mjs'), 'demo'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_BIN: join(root, 'stub-codex.mjs'),
      CODEX_HOME: codexHome,
      MG2_MARKER: marker,
      IXAEON_RELAY_DIR: relay,
    },
  });
  return r.status;
}

describe('条件 3：审查脚本按 magpie 的 Codex 接法起 Codex', () => {
  it('选 a/m1 → -m a/m1、provider 指向 magpie 的 /v1、Key magpie，config.toml 不动', () => {
    const { root, relay, marker, codexHome } = makeReviewRepo();
    const before = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    expect(
      runReview(root, relay, marker, codexHome, {
        magpieModel: 'a/m1',
        magpieUrl: 'http://127.0.0.1:4321',
      }),
    ).toBe(0);
    const got = JSON.parse(readFileSync(marker, 'utf8')) as {
      args: string[];
      key: string | null;
      noProxy: string | null;
    };
    const at = got.args.indexOf('-m');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(got.args[at + 1]).toBe('a/m1');
    expect(got.args).toContain('model_providers.magpie.base_url=http://127.0.0.1:4321/v1');
    expect(got.args).toContain('model_provider=magpie');
    expect(got.args).toContain('--ignore-user-config');
    expect(got.key).toBe('magpie');
    expect(got.noProxy).toContain('127.0.0.1');
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(before);
  });

  it('默认 → 没有 -m 和 magpie 的 provider / Key，config.toml 不动', () => {
    const { root, relay, marker, codexHome } = makeReviewRepo();
    const before = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    expect(runReview(root, relay, marker, codexHome, {})).toBe(0);
    const got = JSON.parse(readFileSync(marker, 'utf8')) as {
      args: string[];
      key: string | null;
      noProxy: string | null;
    };
    expect(got.args).not.toContain('-m');
    expect(got.args).not.toContain('--ignore-user-config');
    expect(got.args.some((a) => a.startsWith('model_provider'))).toBe(false);
    expect(got.key).toBeNull();
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(before);
  });
});
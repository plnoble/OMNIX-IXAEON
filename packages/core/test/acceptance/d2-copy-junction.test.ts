/**
 * D2 验收测试（规格 docs/委派/D2-验证按档位进沙箱.md，v2 写法：先测试后实现）。
 * 本文件对应验收条件 2（依赖档副本里的链接）。
 *
 * 整合方 2026-09-30 改正（规格「改正与补充」第 1 条）：链接只在依赖档跑的那段时间存在。
 * 执行方先推的版本要求 copyProjectWorkspace 一复制就建链接——那样执行器阶段和零依赖档
 * 都碰得到真实依赖，零依赖档（Node 权限模型）还会顺着链接写穿（D2 实验 E1）。
 *
 * 条件 2（改正后）：
 * - 复制副本本身不建链接、不放 pnpm-workspace.yaml；
 * - 依赖档派生的那一刻：根目录与子包的 node_modules 都是指回真实目录的链接，
 *   副本根有空的 pnpm-workspace.yaml（项目自己有就原样保留，不换成空的）；
 * - 跑完（通过 / 没通过 / 派生出错 / 取消）：本次加进副本的东西全部拆掉——副本和跑之前
 *   一模一样（替身往 TMP 写的临时文件也算），真实依赖目录里的东西一个不少。
 *
 * 依赖档的上下文照规格「改正与补充」第 3 条从 defaultCheck 第 6 个参数给
 * （projectRoot、dataDir，checkAuth / spawnCommand 替身）。实现前本文件应当失败。
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { copyProjectWorkspace } from '../../src/execution/workspaceCopy.js';
import { defaultCheck, type IndependentCheck } from '../../src/execution/executor.js';

type AuthResult =
  { ok: true } | { ok: false; reason: 'unauthorized' | 'codex_missing' | 'unsupported_platform' };
interface SpawnOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
}
type SpawnResult = { exitCode: number | null; stdout: string; stderr: string };
interface DependencyContext {
  projectRoot: string;
  dataDir: string;
  checkAuth?: () => Promise<AuthResult>;
  spawnCommand?: (cmd: string, args: string[], opts: SpawnOpts) => Promise<SpawnResult>;
}

/** 实现前 defaultCheck 没有第 6 个参数：类型收窄把规格定的接缝写在测试侧。 */
const check = defaultCheck as unknown as (
  argv: string[],
  cwd: string,
  signal?: AbortSignal,
  runAsNode?: (...a: unknown[]) => boolean,
  versions?: NodeJS.ProcessVersions,
  context?: DependencyContext,
) => Promise<IndependentCheck>;

const DEP_DIRS = ['node_modules', 'packages/sub/node_modules'];
const canon = (p: string) => realpathSync.native(p).replaceAll('\\', '/').toLowerCase();

function makeProject(root: string, opts: { workspaceFile?: string } = {}) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const n = 1;\n');
  writeFileSync(join(root, 'src', 'main.test.ts'), "import { it } from 'vitest';\n");
  mkdirSync(join(root, 'node_modules', 'dep-a'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep-a', 'package.json'), '{"name":"dep-a"}\n');
  writeFileSync(join(root, 'node_modules', 'dep-a', 'index.js'), 'module.exports = 1;\n');
  // 依赖档要求项目根目录装了 vitest（规格「改正与补充」第 6 条）；替身不会真跑它
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), '// 替身\n');
  mkdirSync(join(root, 'packages', 'sub', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'sub', 'src', 'x.ts'), 'export const x = 1;\n');
  mkdirSync(join(root, 'packages', 'sub', 'node_modules', 'dep-b'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'sub', 'node_modules', 'dep-b', 'package.json'),
    '{"name":"dep-b"}\n',
  );
  if (opts.workspaceFile !== undefined) {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), opts.workspaceFile);
  }
}

/** 目录全貌：链接记指向、不进去；文件记内容指纹；目录本身也记（空目录多出来也看得见）。 */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const rel = relative(dir, abs).replaceAll('\\', '/');
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) out.push(`L ${rel} -> ${readlinkSync(abs)}`);
      else if (st.isDirectory()) {
        out.push(`D ${rel}`);
        walk(abs);
      } else {
        out.push(`F ${rel} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

function setup(opts: { workspaceFile?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ixaeon-d2-copy-'));
  const root = join(base, 'proj');
  makeProject(root, opts);
  const copy = join(base, 'copy');
  copyProjectWorkspace(root, copy);
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });
  return { base, root, copy, dataDir };
}

const authorized = async (): Promise<AuthResult> => ({ ok: true });
const ARGV = ['ixaeon:vitest', 'run', 'src/main.test.ts'];

describe('D2 条件 2：链接只在依赖档跑的那段时间存在', () => {
  it('复制副本本身不建链接、不放 pnpm-workspace.yaml', () => {
    const { base, copy } = setup();
    for (const rel of DEP_DIRS) {
      expect(existsSync(join(copy, rel)), `副本里不该有 ${rel}`).toBe(false);
    }
    expect(existsSync(join(copy, 'pnpm-workspace.yaml'))).toBe(false);
    expect(listing(copy).filter((l) => l.startsWith('L '))).toEqual([]);
    expect(existsSync(join(copy, 'src', 'main.ts'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('派生的那一刻：两处 node_modules 都是指回真实目录的链接，副本根有空的 pnpm-workspace.yaml', async () => {
    const { base, root, copy, dataDir } = setup();
    const seen: Record<string, { link: boolean; target: string }> = {};
    const got: { marker?: string | null } = {};
    const spawnCommand = async (): Promise<SpawnResult> => {
      for (const rel of DEP_DIRS) {
        const link = join(copy, rel);
        seen[rel] = {
          link: existsSync(link) && lstatSync(link).isSymbolicLink(),
          target: existsSync(link) ? canon(link) : '',
        };
      }
      const m = join(copy, 'pnpm-workspace.yaml');
      got.marker = existsSync(m) ? readFileSync(m, 'utf8') : null;
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const r = await check(ARGV, copy, undefined, undefined, undefined, {
      projectRoot: root,
      dataDir,
      checkAuth: authorized,
      spawnCommand,
    });

    expect(r.ran).toBe(true);
    for (const rel of DEP_DIRS) {
      expect(seen[rel]?.link, `${rel} 派生时应是目录链接`).toBe(true);
      expect(seen[rel]?.target, `${rel} 应指回真实依赖目录`).toBe(canon(join(root, rel)));
    }
    expect(got.marker, '派生时副本根应有 pnpm-workspace.yaml').toBeTypeOf('string');
    expect(got.marker!.trim()).toBe('');
    rmSync(base, { recursive: true, force: true });
  });

  for (const mode of ['通过', '没通过', '派生出错', '取消'] as const) {
    it(`跑完（${mode}）：副本和跑之前一模一样，真实依赖一个不少`, async () => {
      const { base, root, copy, dataDir } = setup();
      const copyBefore = listing(copy);
      const realBefore = DEP_DIRS.map((rel) => listing(join(root, rel)));
      const ac = new AbortController();
      let started: () => void = () => {};
      const startedP = new Promise<void>((res) => (started = res));
      const got = { spawned: 0, linksDuring: false };
      const spawnCommand = async (
        _cmd: string,
        _args: string[],
        opts: SpawnOpts,
      ): Promise<SpawnResult> => {
        got.spawned += 1;
        // 派生时链接确实在：这样「跑完拆干净」才是真拆过，不是压根没建
        got.linksDuring = DEP_DIRS.every((rel) => {
          const link = join(copy, rel);
          return existsSync(link) && lstatSync(link).isSymbolicLink();
        });
        // vitest 会往 TMP 里写临时文件：这些也要随副本一起还原
        if (opts.env.TMP && existsSync(opts.env.TMP)) {
          writeFileSync(join(opts.env.TMP, 'vitest-tmp.txt'), 'tmp');
        }
        started();
        if (mode === '派生出错') throw new Error('派生失败（替身）');
        if (mode === '取消') {
          await new Promise<void>((res) => {
            if (opts.signal.aborted) return res();
            opts.signal.addEventListener('abort', () => res(), { once: true });
            setTimeout(res, 5_000); // 实现没把信号传进来时别卡死：条件 12 另有断言
          });
          return { exitCode: null, stdout: '', stderr: '' };
        }
        return { exitCode: mode === '通过' ? 0 : 1, stdout: '', stderr: '' };
      };

      const p = check(ARGV, copy, ac.signal, undefined, undefined, {
        projectRoot: root,
        dataDir,
        checkAuth: authorized,
        spawnCommand,
      });
      if (mode === '取消') {
        await Promise.race([startedP, p]);
        ac.abort();
      }
      await p;

      expect(got.spawned, '依赖档应真的派生了一次').toBe(1);
      expect(got.linksDuring, '派生时两处链接都应在').toBe(true);
      expect(listing(copy), '副本应和跑之前一模一样').toEqual(copyBefore);
      expect(DEP_DIRS.map((rel) => listing(join(root, rel)))).toEqual(realBefore);
      rmSync(base, { recursive: true, force: true });
    });
  }

  it('项目自己有 pnpm-workspace.yaml：派生时和跑完都原样，不换成空的', async () => {
    const own = "packages:\n  - 'packages/*'\n";
    const { base, root, copy, dataDir } = setup({ workspaceFile: own });
    const got: { during?: string } = {};
    const spawnCommand = async (): Promise<SpawnResult> => {
      got.during = readFileSync(join(copy, 'pnpm-workspace.yaml'), 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await check(ARGV, copy, undefined, undefined, undefined, {
      projectRoot: root,
      dataDir,
      checkAuth: authorized,
      spawnCommand,
    });
    expect(got.during).toBe(own);
    expect(readFileSync(join(copy, 'pnpm-workspace.yaml'), 'utf8')).toBe(own);
    rmSync(base, { recursive: true, force: true });
  });
});

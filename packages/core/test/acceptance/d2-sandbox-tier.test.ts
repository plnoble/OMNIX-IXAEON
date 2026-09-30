/**
 * D2 验收测试（规格 docs/委派/D2-验证按档位进沙箱.md，v2 写法：先测试后实现）。
 * 本文件对应验收条件 3、4、5、7，以及整合方 2026-09-30 补的 9、10、12
 * （规格「改正与补充」一节）。执行方先写了 3/4/5/7，整合方锁定前补全。
 *
 * 依赖档的上下文从 defaultCheck 第 6 个参数给：{ projectRoot, dataDir, checkAuth?, spawnCommand? }
 * （规格「改正与补充」第 3 条）。这里 checkAuth、spawnCommand 都用替身，不碰真的 Codex。
 * 生产路径（不替换任何东西）与编排层接线在 d2-wiring.test.ts。
 *
 * 条件 3：已授权时，派生的正好是契约 3 的形状——档案名、提权、-C 副本、`--` 之后是
 *   node + 副本里的 vitest.mjs + run --config-loader runner，命令自己的参数原样放在最后；
 *   产品在 runner 与命令参数之间加的参数里若有路径，只许在副本内（缓存目录之类）。
 *   替身退出 0 / 非 0 → exitCode 如实（编排层记 passed / failed）。
 * 条件 4、5：没授权 / 找不到 Codex / 不是 Windows——替身调用 0 次，ran=false，
 *   exitCode=null，原因写进输出；副本原样（没建链接）。
 * 条件 7：专用 CODEX_HOME 在 <数据目录>/codex-sandbox-home，生成的 config.toml：
 *   有 [permissions.<档案名>]（名字与派生参数一致），网络关闭，副本可写，
 *   根目录与子包的真实 node_modules 只读。
 * 条件 9：派生环境 CODEX_HOME、TMP/TEMP（副本内、已建好）、白名单外变量带不进去、
 *   Electron 下 ELECTRON_RUN_AS_NODE=1；config.toml 有 inherit = "all"；
 *   write 条目只有副本，换副本后跟着换。
 * 条件 10：项目根目录没装 vitest → vitest_missing，不派生；ixaeon:vitest watch 拒绝，不派生。
 * 条件 12：外面取消 → 派生收到的 signal 跟着取消；超时 60 秒。
 *
 * 路径比较一律先取真实路径：CI 机器的临时目录是 8.3 短名（RUNNER~1），
 * 实现写长名或短名都算对。
 */
import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyProjectWorkspace } from '../../src/execution/workspaceCopy.js';
import { defaultCheck, type IndependentCheck } from '../../src/execution/executor.js';

type AuthError = 'unauthorized' | 'codex_missing' | 'unsupported_platform';
type AuthResult = { ok: true } | { ok: false; reason: AuthError };
interface SpawnOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
}
interface SpawnCall {
  cmd: string;
  args: string[];
  opts: SpawnOpts;
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

const authorized = async (): Promise<AuthResult> => ({ ok: true });
const deny = (reason: AuthError) => async (): Promise<AuthResult> => ({ ok: false, reason });

/** 规范化：分隔符、TOML 里转义过的反斜杠、大小写（Windows），并尽量取真实路径（短名→长名）。 */
const slash = (p: string) =>
  p
    .replaceAll('\\\\', '/')
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
function forms(p: string): string[] {
  const out = new Set([slash(p)]);
  try {
    out.add(slash(realpathSync.native(p)));
  } catch {
    // 不存在就只比原样
  }
  return [...out];
}
const samePath = (a: string | undefined, b: string) =>
  a !== undefined && forms(a).some((x) => forms(b).includes(x));
const inside = (dir: string, p: string | undefined) =>
  p !== undefined && forms(p).some((x) => forms(dir).some((d) => x === d || x.startsWith(`${d}/`)));

function makeVitestProject(root: string, opts: { vitest?: boolean } = {}) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'verify.test.ts'), "import { it } from 'vitest';\n");
  mkdirSync(join(root, 'node_modules', 'dep-x'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep-x', 'package.json'), '{"name":"dep-x"}\n');
  if (opts.vitest !== false) {
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), '// 替身\n');
  }
  mkdirSync(join(root, 'packages', 'sub', 'node_modules', 'dep-y'), { recursive: true });
  writeFileSync(join(root, 'packages', 'sub', 'index.ts'), 'export {};\n');
  writeFileSync(
    join(root, 'packages', 'sub', 'node_modules', 'dep-y', 'package.json'),
    '{"name":"dep-y"}\n',
  );
}

function setup(opts: { vitest?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ixaeon-d2-tier1-'));
  const proj = join(base, 'proj');
  makeVitestProject(proj, opts);
  const copy = join(base, 'copy');
  copyProjectWorkspace(proj, copy);
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });
  return { base, proj, copy, dataDir };
}

function makeSeam(
  s: { proj: string; dataDir: string },
  auth: () => Promise<AuthResult>,
  spawnCode: number | null = 0,
  onSpawn?: (call: SpawnCall) => void | Promise<void>,
) {
  const calls: SpawnCall[] = [];
  const spawnCommand = async (cmd: string, args: string[], opts: SpawnOpts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    await onSpawn?.(call);
    return { exitCode: spawnCode, stdout: 'STUB_OUT', stderr: '' };
  };
  const context: DependencyContext = {
    projectRoot: s.proj,
    dataDir: s.dataDir,
    checkAuth: auth,
    spawnCommand,
  };
  return { context, calls };
}

function readConfig(dataDir: string): string {
  const cfgPath = join(dataDir, 'codex-sandbox-home', 'config.toml');
  expect(existsSync(cfgPath), `应生成专用 HOME 配置 ${cfgPath}`).toBe(true);
  return slash(readFileSync(cfgPath, 'utf8'));
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 配置里有没有 "<路径>/**" = "<权限>"（长名短名任一形式都算）。 */
const hasEntry = (cfg: string, dir: string, access: 'read' | 'write') =>
  forms(dir).some((d) =>
    new RegExp(`["']${esc(d)}/\\*\\*["']\\s*=\\s*["']${access}["']`).test(cfg),
  );
const writeEntries = (cfg: string) =>
  [...cfg.matchAll(/["']([^"'\n]+)["']\s*=\s*["']write["']/g)].map((m) => m[1]!);

describe('D2 条件 3：依赖档命令形状与退出码映射', () => {
  it('已授权：派生参数正好是契约形状，命令参数原样在最后，替身退出 0 → exitCode 0', async () => {
    const s = setup();
    const { context, calls } = makeSeam(s, authorized, 0);
    const rest = ['./src/verify.test.ts'];

    const r = await check(
      ['ixaeon:vitest', 'run', ...rest],
      s.copy,
      undefined,
      undefined,
      undefined,
      context,
    );

    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const { cmd, args, opts } = calls[0]!;
    expect(cmd.toLowerCase()).toContain('codex');
    expect(args.slice(0, 3)).toEqual(['sandbox', 'windows', '--permissions-profile']);
    expect(args[3]).toMatch(/^[a-z0-9_-]+$/i);
    expect(args.slice(4, 7)).toEqual(['-c', 'windows.sandbox="elevated"', '-C']);
    expect(samePath(args[7], s.copy), `-C 应是副本：${args[7]}`).toBe(true);
    expect(args[8]).toBe('--');
    expect(args[9]).toBe(process.execPath);
    expect(samePath(args[10], join(s.copy, 'node_modules', 'vitest', 'vitest.mjs'))).toBe(true);
    expect(args.slice(11, 14)).toEqual(['run', '--config-loader', 'runner']);
    expect(args.slice(args.length - rest.length)).toEqual(rest);
    // 产品在 runner 与命令参数之间加的参数（缓存目录之类）：出现路径只许在副本内
    for (const extra of args.slice(14, args.length - rest.length)) {
      const value = extra.includes('=') ? extra.slice(extra.indexOf('=') + 1) : extra;
      if (/^[a-z]:[\\/]|^[\\/]/i.test(value)) {
        expect(inside(s.copy, value), `产品加的路径参数应在副本内：${extra}`).toBe(true);
      }
    }
    expect(samePath(opts.cwd, s.copy)).toBe(true);
    rmSync(s.base, { recursive: true, force: true });
  });

  it('替身退出非 0 → exitCode 如实（编排层记 failed）', async () => {
    const s = setup();
    const { context } = makeSeam(s, authorized, 7);
    const r = await check(
      ['ixaeon:vitest', 'run'],
      s.copy,
      undefined,
      undefined,
      undefined,
      context,
    );
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(7);
    rmSync(s.base, { recursive: true, force: true });
  });
});

describe('D2 条件 4、5：三种没跑成——不派生、ran=false、原因进输出、副本原样', () => {
  for (const reason of ['unauthorized', 'codex_missing', 'unsupported_platform'] as const) {
    it(`原因 ${reason}：0 次派生，ran=false，原因进输出，副本里没建链接`, async () => {
      const s = setup();
      const { context, calls } = makeSeam(s, deny(reason));
      const r = await check(
        ['ixaeon:vitest', 'run'],
        s.copy,
        undefined,
        undefined,
        undefined,
        context,
      );
      expect(calls).toHaveLength(0);
      expect(r.ran).toBe(false);
      expect(r.exitCode).toBeNull();
      expect(r.output).toContain(reason);
      expect(existsSync(join(s.copy, 'node_modules'))).toBe(false);
      rmSync(s.base, { recursive: true, force: true });
    });
  }
});

describe('D2 条件 7：专用 CODEX_HOME 在数据目录下，config.toml 内容正确', () => {
  it('档案名与派生一致；网络关闭；副本可写；根目录与子包的真实依赖只读', async () => {
    const s = setup();
    const { context, calls } = makeSeam(s, authorized);
    await check(['ixaeon:vitest', 'run'], s.copy, undefined, undefined, undefined, context);

    const cfg = readConfig(s.dataDir);
    const profile = calls[0]!.args[3]!.toLowerCase();
    expect(cfg).toContain(`[permissions.${profile}`);
    expect(cfg).toMatch(
      new RegExp(`\\[permissions\\.${esc(profile)}\\.network\\][^\\[]*enabled\\s*=\\s*false`),
    );
    expect(hasEntry(cfg, s.copy, 'write'), '副本应可写').toBe(true);
    for (const rel of ['node_modules', 'packages/sub/node_modules']) {
      expect(hasEntry(cfg, join(s.proj, rel), 'read'), `${rel} 应只读`).toBe(true);
    }
    rmSync(s.base, { recursive: true, force: true });
  });
});

describe('D2 条件 9（整合方补）：派生的环境与沙箱配置', () => {
  it('CODEX_HOME、TMP/TEMP 在副本内且已建好、白名单外变量带不进去、inherit = "all"', async () => {
    const s = setup();
    const probe = 'IXAEON_D2_PROBE_SHOULD_NOT_LEAK';
    process.env[probe] = 'secret-value';
    let tmpExisted = false;
    const { context, calls } = makeSeam(s, authorized, 0, ({ opts }) => {
      tmpExisted = !!opts.env.TMP && existsSync(opts.env.TMP);
    });
    try {
      await check(['ixaeon:vitest', 'run'], s.copy, undefined, undefined, undefined, context);
    } finally {
      delete process.env[probe];
    }
    const env = calls[0]!.opts.env;
    expect(samePath(env.CODEX_HOME, join(s.dataDir, 'codex-sandbox-home'))).toBe(true);
    expect(inside(s.copy, env.TMP), `TMP 应在副本内：${env.TMP}`).toBe(true);
    expect(inside(s.copy, env.TEMP), `TEMP 应在副本内：${env.TEMP}`).toBe(true);
    expect(tmpExisted, '派生时 TMP 目录应已建好').toBe(true);
    expect(env[probe]).toBeUndefined();
    expect(env.PATH, '白名单里的 PATH 照带').toBeTruthy();
    const cfg = readConfig(s.dataDir);
    expect(cfg).toMatch(/\[shell_environment_policy\][^[]*inherit\s*=\s*["']all["']/);
    rmSync(s.base, { recursive: true, force: true });
  });

  it('应用（Electron）里跑：沙箱里的 node 带 ELECTRON_RUN_AS_NODE=1；普通 node 不带', async () => {
    const s = setup();
    const electron = { ...process.versions, electron: '44.0.0' } as NodeJS.ProcessVersions;
    const plain = { ...process.versions } as NodeJS.ProcessVersions;
    delete (plain as { electron?: string }).electron;
    const a = makeSeam(s, authorized);
    await check(['ixaeon:vitest', 'run'], s.copy, undefined, undefined, electron, a.context);
    expect(a.calls[0]!.args[9]).toBe(process.execPath);
    expect(a.calls[0]!.opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
    const b = makeSeam(s, authorized);
    await check(['ixaeon:vitest', 'run'], s.copy, undefined, undefined, plain, b.context);
    expect(b.calls[0]!.opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    rmSync(s.base, { recursive: true, force: true });
  });

  it('write 条目只有副本；换一份副本再跑，档案里的路径跟着换', async () => {
    const s = setup();
    const copyB = join(s.base, 'copy-b');
    copyProjectWorkspace(s.proj, copyB);
    await check(
      ['ixaeon:vitest', 'run'],
      s.copy,
      undefined,
      undefined,
      undefined,
      makeSeam(s, authorized).context,
    );
    for (const p of writeEntries(readConfig(s.dataDir))) {
      expect(inside(s.copy, p.replace(/\/\*\*$/, '')), `write 条目只许有副本：${p}`).toBe(true);
    }
    await check(
      ['ixaeon:vitest', 'run'],
      copyB,
      undefined,
      undefined,
      undefined,
      makeSeam(s, authorized).context,
    );
    const cfg = readConfig(s.dataDir);
    expect(hasEntry(cfg, copyB, 'write'), '新副本应可写').toBe(true);
    expect(hasEntry(cfg, s.copy, 'write'), '旧副本不该还可写').toBe(false);
    for (const p of writeEntries(cfg)) {
      expect(inside(copyB, p.replace(/\/\*\*$/, '')), `write 条目只许有新副本：${p}`).toBe(true);
    }
    rmSync(s.base, { recursive: true, force: true });
  });
});

describe('D2 条件 10（整合方补）：没装 vitest、不是 run 子命令', () => {
  it('项目根目录没装 vitest：vitest_missing，不派生', async () => {
    const s = setup({ vitest: false });
    const { context, calls } = makeSeam(s, authorized);
    const r = await check(
      ['ixaeon:vitest', 'run'],
      s.copy,
      undefined,
      undefined,
      undefined,
      context,
    );
    expect(calls).toHaveLength(0);
    expect(r.ran).toBe(false);
    expect(r.output).toContain('vitest_missing');
    rmSync(s.base, { recursive: true, force: true });
  });

  it('ixaeon:vitest watch：拒绝，不派生（同一份副本 run 照常派生）', async () => {
    const s = setup();
    const watch = makeSeam(s, authorized);
    const r = await check(
      ['ixaeon:vitest', 'watch'],
      s.copy,
      undefined,
      undefined,
      undefined,
      watch.context,
    );
    expect(watch.calls).toHaveLength(0);
    expect(r.ran).toBe(false);
    // 对照：换成 run 就派生——拒绝的是子命令，不是整个依赖档
    const run = makeSeam(s, authorized);
    await check(['ixaeon:vitest', 'run'], s.copy, undefined, undefined, undefined, run.context);
    expect(run.calls).toHaveLength(1);
    rmSync(s.base, { recursive: true, force: true });
  });
});

describe('D2 条件 12（整合方补）：取消与超时', () => {
  it('外面取消 → 派生收到的 signal 跟着取消；超时 60 秒', async () => {
    const s = setup();
    const ac = new AbortController();
    const seen: { signal?: AbortSignal; timeoutMs?: number } = {};
    let started: () => void = () => {};
    const startedP = new Promise<void>((res) => (started = res));
    const { context } = makeSeam(s, authorized, null, async ({ opts }) => {
      seen.signal = opts.signal;
      seen.timeoutMs = opts.timeoutMs;
      started();
      await new Promise<void>((res) => {
        if (opts.signal?.aborted) return res();
        opts.signal?.addEventListener('abort', () => res(), { once: true });
        setTimeout(res, 5_000);
      });
    });
    const p = check(['ixaeon:vitest', 'run'], s.copy, ac.signal, undefined, undefined, context);
    await Promise.race([startedP, p]);
    ac.abort();
    await p;
    expect(seen.signal, '派生应收到取消信号').toBeInstanceOf(AbortSignal);
    expect(seen.signal!.aborted).toBe(true);
    expect(seen.timeoutMs).toBe(60_000);
    rmSync(s.base, { recursive: true, force: true });
  });
});

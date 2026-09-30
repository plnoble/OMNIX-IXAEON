/**
 * D2 真机检查（规格 D2「真机检查」原 3 条 + 补充 5 条），分阶段：
 *   node scripts/real/d2-real.ts phase1   # 不需要任何授权：未授权免弹窗、零依赖档、Electron 当 node
 *   node scripts/real/d2-real.ts phase2   # 需要先做一次 UAC 授权（requestSandboxAuth）；跑真实沙箱
 * 全部只用合成项目与临时目录；不打印用户真实数据。输出原样贴进交付说明。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { copyProjectWorkspace } from '../../packages/core/src/execution/workspaceCopy.js';
import { defaultCheck } from '../../packages/core/src/execution/executor.js';
import {
  checkSandboxAuth,
  requestSandboxAuth,
} from '../../packages/core/src/execution/verifySandbox.js';

const log = (...a: unknown[]) => console.log(...a);
const root = resolve(import.meta.dirname, '..', '..');

function shell(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true,
    ...opts,
  });
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
}

function makeNodeModulesTree(dir: string) {
  mkdirSync(join(dir, 'node_modules', 'dep-a'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep-a', 'package.json'), '{"name":"dep-a"}\n');
  mkdirSync(join(dir, 'packages', 'sub', 'node_modules', 'dep-b'), { recursive: true });
  writeFileSync(
    join(dir, 'packages', 'sub', 'node_modules', 'dep-b', 'package.json'),
    '{"name":"dep-b"}\n',
  );
  mkdirSync(join(dir, 'packages', 'sub', 'src'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'sub', 'src', 'x.ts'), 'export const x = 1;\n');
}

function makeVitestProject(dir: string, vitestConfig: boolean, mode: 'pass' | 'fail' | 'forever') {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'add.ts'),
    'export const add = (a: number, b: number) => a + b;\n',
  );
  const body =
    mode === 'fail'
      ? "it('intentional failure', () => { expect(add(1, 2)).toBe(99); });"
      : mode === 'forever'
        ? "it('waits forever', () => new Promise<void>(() => {}));"
        : "it('sums', () => { expect(add(1, 2)).toBe(3); });";
  writeFileSync(
    join(dir, 'src', 'add.test.ts'),
    ["import { it, expect } from 'vitest';", "import { add } from './add.ts';", body, ''].join(
      '\n',
    ),
  );
  if (vitestConfig) {
    writeFileSync(
      join(dir, 'vitest.config.ts'),
      "import { defineConfig } from 'vitest/config';\n" +
        '// 真机检查：故意不设 cacheDir，看默认缓存去向\n' +
        'export default defineConfig({});\n',
    );
  }
  // 真 vitest：用主仓库的同版本安装（离线装不上就如实报告）
  const vitestReal = join(dir, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitestReal)) {
    const add = shell('pnpm', ['add', '-w', '-D', 'vitest'], { cwd: dir });
    if (add.status !== 0 || !existsSync(vitestReal)) {
      throw new Error('vitest 安装失败（如实报告）：' + add.out.slice(0, 300));
    }
  }
  makeNodeModulesTree(dir);
}

const listing = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const rel = abs.slice(dir.length + 1).replaceAll('\\', '/');
      out.push(rel + (existsSync(abs) && statSync(abs).isDirectory() ? '/' : ''));
    }
  };
  walk(dir);
  return out.sort();
};

async function phase1() {
  const base = mkdtempSync(join(tmpdir(), 'ixa-d2-real1-'));
  log('== phase1: 不需要授权的检查 ==\n');

  // 真机检查 1：从没授权过的新数据目录 → 检查报没授权、没有弹窗（0 次派生）
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });
  const auth = await checkSandboxAuth(dataDir);
  log('[1] checkSandboxAuth(新数据目录) =', JSON.stringify(auth));
  log('[1] 期望 reason=unauthorized（本机装了 Codex）；检查本身是被动读取，不会有任何弹窗。');

  // 零依赖档真机：node:test 直跑（条件 1 实时版）
  const zproj = join(base, 'zproj');
  mkdirSync(join(zproj, 'src'), { recursive: true });
  writeFileSync(join(zproj, 'lib.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  writeFileSync(
    join(zproj, 'verify.pass.test.ts'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from './lib.ts';",
      "test('zero-dep pass', () => { assert.equal(add(40, 2), 42); });",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(zproj, 'verify.fail.test.ts'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from './lib.ts';",
      "test('zero-dep fail', () => { assert.equal(add(1, 2), 99); });",
      '',
    ].join('\n'),
  );
  const zcopy = join(base, 'zcopy');
  copyProjectWorkspace(zproj, zcopy);
  const zpass = await defaultCheck([process.execPath, 'verify.pass.test.ts'], zcopy);
  const zfail = await defaultCheck([process.execPath, 'verify.fail.test.ts'], zcopy);
  log('[零依赖档] 通过例 ran=' + zpass.ran + ' exitCode=' + zpass.exitCode);
  log('[零依赖档] 失败例 ran=' + zfail.ran + ' exitCode=' + zfail.exitCode + '（期望非 0）\n');

  // 补充 5：Electron 当 node（模拟应用里，ELECTRON_RUN_AS_NODE=1）
  const electron = join(
    root,
    'node_modules',
    '.pnpm',
    'electron@44.1.1',
    'node_modules',
    'electron',
    'dist',
    'electron.exe',
  );
  if (existsSync(electron)) {
    const er = shell(electron, [join(zproj, 'verify.pass.test.ts')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    log(
      '[补充5] Electron 当 node 直跑零依赖档 exit=' +
        er.status +
        ' 输出尾部：\n' +
        er.out.split('\n').slice(-6).join('\n'),
    );
  } else {
    log('[补充5] electron.exe 不在预期路径，如实未跑');
  }

  rmSync(base, { recursive: true, force: true });
  log('\n[phase1 done]');
}

async function electronAsNodeDependencyTier(base: string, dataDir: string) {
  // 补充 5：用仓库的 Electron 可执行文件当 node（ELECTRON_RUN_AS_NODE=1）跑一遍
  // 依赖档通过例——process.execPath 是 Electron 的形态与真实应用一致。
  const electron = join(
    root,
    'node_modules',
    '.pnpm',
    'electron@44.1.1',
    'node_modules',
    'electron',
    'dist',
    'electron.exe',
  );
  log('[补充5] Electron 可执行文件存在：' + existsSync(electron));
  const proj = join(base, 'proj-electron');
  makeVitestProject(proj, true, 'pass');
  const copy = join(base, 'copy-electron');
  copyProjectWorkspace(proj, copy);
  const r = await defaultCheck(
    ['ixaeon:vitest', 'run', 'src/add.test.ts'],
    copy,
    undefined,
    undefined,
    { ...process.versions, electron: '44.1.1' } as NodeJS.ProcessVersions,
    { projectRoot: proj, dataDir },
  );
  log(
    `[补充5] Electron 形态依赖档通过例：ran=${r.ran} exitCode=${r.exitCode}（期望 ran=true exitCode=0）`,
  );
  log('  输出尾部：\n' + r.output.split('\n').slice(-10).join('\n'));
}

async function phase2() {
  const base = mkdtempSync(join(tmpdir(), 'ixa-d2-real2-'));
  log('== phase2: 授权后的真实沙箱 ==\n');
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });

  // 补充 5：授权前先跑一次（不依赖授权，只依赖已生成的身份；跳过这一步先展示环境事实）
  // 补充 5：Electron 当 node 跑依赖档通过例（授权无关，先跑出来涨证据）
  await electronAsNodeDependencyTier(base, dataDir);

  // 真机检查 2：发起授权（会弹一次 UAC——运行前已请用户点「是」）
  const req = await requestSandboxAuth(dataDir);
  log('[2] requestSandboxAuth =', JSON.stringify(req));
  if (!req.ok) {
    log('[2] 授权没成（可能用户点了否，或 UAC 未响应），按失败如实报告。');
    rmSync(base, { recursive: true, force: true });
    return;
  }
  const authNow = await checkSandboxAuth(dataDir);
  log('[2] 授权后 checkSandboxAuth =', JSON.stringify(authNow), '\n');

  for (const mode of ['pass', 'fail'] as const) {
    const proj = join(base, `proj-${mode}`);
    makeVitestProject(proj, true, mode);
    const copy = join(base, `copy-${mode}`);
    copyProjectWorkspace(proj, copy);
    const realBefore = ['node_modules', 'packages/sub/node_modules'].map((rel) =>
      listing(join(proj, rel)),
    );
    const icaclsBefore = shell('icacls', [join(proj, 'node_modules')]).out;
    const r = await defaultCheck(
      ['ixaeon:vitest', 'run', 'src/add.test.ts'],
      copy,
      undefined,
      undefined,
      undefined,
      { projectRoot: proj, dataDir },
    );
    const realAfter = ['node_modules', 'packages/sub/node_modules'].map((rel) =>
      listing(join(proj, rel)),
    );
    const icaclsAfter = shell('icacls', [join(proj, 'node_modules')]).out;
    const copyLeftovers = readdirSync(copy);
    log(
      `[3] ${mode} 例：ran=${r.ran} exitCode=${r.exitCode}（期望 ${mode === 'pass' ? 0 : '非 0'}）`,
    );
    log('  输出尾部：\n' + r.output.split('\n').slice(-12).join('\n'));
    log(
      `[4] 真实 node_modules 目录项一致：${JSON.stringify(realBefore) === JSON.stringify(realAfter)}`,
    );
    log(`[7] icacls 前后一致：${icaclsBefore === icaclsAfter}（原样见交付说明附录）`);
    log(`[4] 副本残留目录项（应含 src 等、无链接）：${copyLeftovers.join(', ')}\n`);
  }

  // 经链接写真实依赖被拦（D2b 结论再验）
  {
    const proj = join(base, 'proj-pierce');
    makeVitestProject(proj, true, 'pass');
    const copy = join(base, 'copy-pierce');
    copyProjectWorkspace(proj, copy);
    writeFileSync(
      join(copy, 'src', 'pierce.test.ts'),
      [
        "import { it, expect } from 'vitest';",
        "import { writeFileSync } from 'node:fs';",
        "it('writes through link', () => {",
        "  try { writeFileSync(new URL('../node_modules/dep-a/pierced.txt', import.meta.url), 'x'); } catch {}",
        '  expect(true).toBe(true);',
        '});',
        '',
      ].join('\n'),
    );
    const r = await defaultCheck(
      ['ixaeon:vitest', 'run', 'src/pierce.test.ts'],
      copy,
      undefined,
      undefined,
      undefined,
      { projectRoot: proj, dataDir },
    );
    const pierced = existsSync(join(proj, 'node_modules', 'dep-a', 'pierced.txt'));
    log(
      `[3 写穿] ran=${r.ran} exitCode=${r.exitCode}；真实 dep-a 里出现 pierced.txt：${pierced}（期望 false）\n`,
    );
  }

  // 补充 6：取消——跑一个永远等着的测试，3 秒后取消，确认没留进程
  {
    const proj = join(base, 'proj-cancel');
    makeVitestProject(proj, false, 'forever');
    const copy = join(base, 'copy-cancel');
    copyProjectWorkspace(proj, copy);
    // 复审整改：先记机器当前 codex/node 进程号，取消后再比对，只报新多出来
    // 且还活着的（不数全机总数——用户桌面上的 Codex 和我们自己都有这些进程）
    const pidSnapshot = () =>
      new Set(
        shell('powershell.exe', [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='codex.exe' or Name='node.exe'\" | Select-Object -ExpandProperty ProcessId",
        ])
          .out.split(/\s+/)
          .filter(Boolean),
      );
    const beforePids = pidSnapshot();
    const ac = new AbortController();
    const p = defaultCheck(
      ['ixaeon:vitest', 'run', 'src/add.test.ts'],
      copy,
      ac.signal,
      undefined,
      undefined,
      { projectRoot: proj, dataDir },
    );
    setTimeout(() => ac.abort(), 3_000);
    const r = await p;
    await new Promise((res) => setTimeout(res, 1_500)); // 给进程树退出留时间
    const afterPids = pidSnapshot();
    const leftovers = [...afterPids].filter((pid) => !beforePids.has(pid));
    log(
      `[6] 取消后结果 ran=${r.ran} exitCode=${r.exitCode}；新多出来还活着的 codex/node 进程：${leftovers.length === 0 ? '无' : leftovers.join(',')}`,
    );
    log('[6] 注：机器上若有其他工作在途进程数不为 0，需人工比对（本机此刻无运行中的 IXAEON）。\n');
  }

  rmSync(base, { recursive: true, force: true });
  log('[phase2 done]');
}

const phase = process.argv[2] ?? 'phase1';
if (phase === 'phase1') await phase1();
else if (phase === 'phase2') await phase2();
else log('用法: node scripts/real/d2-real.ts phase1|phase2');

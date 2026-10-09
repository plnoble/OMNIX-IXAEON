#!/usr/bin/env node
/**
 * D2 实验 3：codex sandbox windows 能否做独立验证的执行沙箱。
 *
 * 本机 codex-cli 0.130.0-alpha.5 提供 `codex sandbox windows <COMMAND>`——
 * Windows 受限令牌沙箱，纯本地运行、不调模型、不花 Codex 额度。
 *
 * 模式与探针：
 * - 默认（read-only）：写全拦（基线确认）；
 * - sandbox_mode="workspace-write"（-C <copy>）：写副本应允许；写副本外
 *   （实验根目录，非 tmp）应拦截；联网观察默认策略；
 * - vitest run 在 workspace-write 沙箱内跑通（junction node_modules）。
 * 另测 elevated 变体（IXAEON 执行器 Windows 上写文件需要它）。
 *
 * 真实发现（已写入交付）：用户 config.toml 的 service_tier="default" 被
 * 0.130 alpha 拒绝且 `codex sandbox` 无 --ignore-user-config → 用独立
 * CODEX_HOME 绕开（会触发「不在临时目录建 helper」警告，仅警告不阻断）。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const CODEX = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin', 'codex.exe');
const root = join(tmpdir(), `ixaeon-d2-e3-${process.pid}`);
const proj = join(root, 'proj');
const copy = join(root, 'copy');
// 越界探针目标：实验根目录（copy 的父目录，非系统临时目录）——
// workspace-write 的可写根是 -C 指定的 copy + 系统 tmp，父目录应被拦。
const outsideTarget = join(root, 'outside-probe.txt');
// 真实发现：用户 config.toml 的 service_tier="default" 被 codex 0.130 alpha
// 拒绝（codex sandbox 无 --ignore-user-config）→ 用独立 CODEX_HOME。
const codexHome = join(tmpdir(), `d2-codex-home-${process.pid}`);
mkdirSync(codexHome, { recursive: true });
// 0.130 alpha 的 --permissions-profile 需要 config 里的 [permissions.<名字>] 表
//（schema 见 openai/codex codex-rs/config/src/permissions_toml.rs）：
// filesystem 全盘 read + workspace_roots 授权副本写 + network 关闭。
const BACKSLASH = String.fromCharCode(92);
// 这两个目录照本机的算，不把账户名写进脚本（仓库是公开的；2026-10-09 之前是写死的）
const slashed = (p) => p.split(BACKSLASH).join('/');
const TEMP_DIR = slashed(tmpdir());
const LOCAL_APP_DATA = slashed(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'));
const writeConfigAt = (roots) => {
  const toml = [
    '[permissions.d2-verify]',
    '[permissions.d2-verify.filesystem]',
    `"${TEMP_DIR}/**" = "write"`,
    `"${LOCAL_APP_DATA}/**" = "read"`,
    '[permissions.d2-verify.workspace_roots]',
    ...roots.map((r) => `"${r.split(BACKSLASH).join('/')}" = true`),
    '[permissions.d2-verify.network]',
    'enabled = false',
    '',
    '[permissions.default_permissions]',
    'extends = "d2-verify"',
    '',
  ].join('\n');
  writeFileSync(join(codexHome, 'config.toml'), toml, 'utf8');
};
writeConfigAt([]);
const out = [];
const log = (l) => {
  out.push(l);
  console.log(l);
};

function run(label, argv, cwd, timeout = 240_000) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, CODEX_HOME: codexHome, D2_OUTSIDE_TARGET: outsideTarget },
  });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  log(`\n### ${label}`);
  log(`$ ${argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}  (cwd=${cwd})`);
  log(`exit=${r.status}`);
  log(text.split('\n').slice(-16).join('\n'));
  return { exit: r.status, text };
}

// 合成项目 + 副本 + junction（同 E1/E2）
mkdirSync(join(proj, 'src'), { recursive: true });
writeFileSync(
  join(proj, 'package.json'),
  JSON.stringify({ name: 'd2-e3', type: 'module', private: true, version: '1.0.0' }, null, 2),
);
const add = spawnSync('corepack', ['pnpm', 'add', 'vitest', '--prefer-offline'], {
  cwd: proj,
  encoding: 'utf8',
  timeout: 300_000,
  shell: true,
});
log(`[setup] pnpm add vitest exit=${add.status}`);
if (add.status !== 0) process.exit(1);
writeFileSync(
  join(proj, 'src', 'math.ts'),
  'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
);
writeFileSync(
  join(proj, 'src', 'math.test.ts'),
  "import { describe, expect, it } from 'vitest';\nimport { add } from './math.ts';\ndescribe('add', () => {\n  it('adds', () => { expect(add(1, 2)).toBe(3); });\n});\n",
);
mkdirSync(join(copy, 'src'), { recursive: true });
for (const f of ['package.json', 'pnpm-lock.yaml'])
  if (existsSync(join(proj, f))) cpSync(join(proj, f), join(copy, f));
cpSync(join(proj, 'src', 'math.ts'), join(copy, 'src', 'math.ts'));
cpSync(join(proj, 'src', 'math.test.ts'), join(copy, 'src', 'math.test.ts'));
symlinkSync(join(proj, 'node_modules'), join(copy, 'node_modules'), 'junction');
writeFileSync(join(copy, 'pnpm-workspace.yaml'), '', 'utf8');
const realNm = join(proj, 'node_modules');
const vitest = join(realNm, 'vitest', 'vitest.mjs');
log(`[setup] codex=${CODEX} exists=${existsSync(CODEX)}`);
// copy 已存在 → 把副本写根写进 profile 配置
writeConfigAt([copy]);

// 探针：写副本内 / 写副本外（父目录）/ 联网
writeFileSync(
  join(copy, 'probe.mjs'),
  [
    "import { writeFileSync, existsSync, unlinkSync } from 'node:fs';",
    'const outside = process.env.D2_OUTSIDE_TARGET;',
    "try { writeFileSync('inside.txt', 'in-workspace'); console.log('IN_WORKSPACE_WRITE=OK'); }",
    "catch (e) { console.log('IN_WORKSPACE_WRITE=BLOCKED ' + e.code); }",
    'try { if (existsSync(outside)) unlinkSync(outside); } catch {}',
    "try { writeFileSync(outside, 'escape'); console.log('OUTSIDE_WRITE=OK（越界写入成功——沙箱未拦）'); }",
    "catch (e) { console.log('OUTSIDE_WRITE=BLOCKED ' + e.code); }",
    "try { if (existsSync(outside)) { console.log('OUTSIDE_FILE_EXISTS=TRUE'); unlinkSync(outside); } else console.log('OUTSIDE_FILE_EXISTS=FALSE'); } catch {}",
    "const t = setTimeout(() => { console.log('NETWORK=TIMEOUT(可能被拦)'); process.exit(0); }, 15000);",
    'try {',
    "  const r = await fetch('https://api.github.com/zen', { signal: AbortSignal.timeout(12000) });",
    '  clearTimeout(t);',
    "  console.log('NETWORK=ALLOWED status=' + r.status);",
    '} catch (e) {',
    '  clearTimeout(t);',
    "  console.log('NETWORK=BLOCKED ' + (e.cause?.code ?? e.code ?? e.name));",
    '}',
  ].join('\n'),
);

const wsWrite = ['--permissions-profile', 'd2-verify', '-C', copy];

// 1) 基线 echo
run(
  '1 基线 echo（d2-verify profile）',
  [CODEX, 'sandbox', 'windows', ...wsWrite, '--', 'cmd', '/c', 'echo CODEX_SANDBOX_OK'],
  copy,
);

// 2) 探针：profile 基线 / elevated
for (const variant of [
  ['2 profile 探针（读全盘+写副本根+断网）', []],
  ['2b profile + elevated（IXAEON Windows 同款）', ['-c', 'windows.sandbox="elevated"']],
]) {
  const [label, extra] = variant;
  run(
    label,
    [CODEX, 'sandbox', 'windows', ...wsWrite, ...extra, '--', process.execPath, 'probe.mjs'],
    copy,
  );
  log(`[probe-file] 副本外探针文件存在吗: ${existsSync(outsideTarget)}`);
  if (existsSync(outsideTarget)) {
    rmSync(outsideTarget);
    log('[probe-file] 已清理');
  }
}

// 3) vitest 在 workspace-write 沙箱内（elevated 与否各一次）
for (const variant of [
  ['3 vitest @ d2-verify profile', wsWrite],
  ['3b vitest @ profile + elevated', [...wsWrite, '-c', 'windows.sandbox="elevated"']],
]) {
  const [label, extra] = variant;
  const r = run(
    label,
    [CODEX, 'sandbox', 'windows', ...extra, '--', process.execPath, vitest, 'run'],
    copy,
  );
  log(
    `[vitest-in-sandbox] ${r.exit === 0 && /passed/i.test(r.text) ? 'PASSED' : '未通过（见上）'}`,
  );
}

try {
  rmSync(root, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
  log(`\n[cleanup] 已删除 ${root}`);
} catch (e) {
  log(`\n[cleanup] 失败：${e.message}`);
}

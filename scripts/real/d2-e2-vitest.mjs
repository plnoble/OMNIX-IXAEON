#!/usr/bin/env node
/**
 * D2 实验 2：vitest 能否在 Node 权限模型下运行，最少要加哪些 --allow-*。
 *
 * 步骤：
 * 1. 临时目录合成 TS+vitest 项目；pnpm 离线装 vitest（本机 store）；
 * 2. 复制工作区（跳过 node_modules）+ junction 挂真实 node_modules（E1 结论）；
 * 3. 渐进加旗标跑 vitest run，记录每一步的真实失败/成功；
 * 4. 输出最小旗标集与安全边界评估。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(tmpdir(), `ixaeon-d2-e2-${process.pid}`);
const proj = join(root, 'proj');
const copy = join(root, 'copy');
const out = [];

function log(line) {
  out.push(line);
  console.log(line);
}

function run(label, argv, cwd) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: 120_000 });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  log(`\n### ${label}`);
  log(`$ ${argv.join(' ')}  (cwd=${cwd})`);
  log(`exit=${r.status}`);
  log(text.split('\n').slice(-25).join('\n'));
  return { exit: r.status, text };
}

// 1) 合成项目 + pnpm 离线装 vitest
mkdirSync(join(proj, 'src'), { recursive: true });
writeFileSync(
  join(proj, 'package.json'),
  JSON.stringify({ name: 'd2-e2', type: 'module', private: true, version: '1.0.0' }, null, 2),
);
log(`[setup] proj=${proj}`);
let added = spawnSync('corepack', ['pnpm', 'add', 'vitest', '--offline'], {
  cwd: proj,
  encoding: 'utf8',
  timeout: 300_000,
  shell: process.platform === 'win32',
});
if (added.status !== 0) {
  log('[setup] --offline 安装失败，退回 --prefer-offline（如实记录）');
  log((added.stderr ?? '').split('\n').slice(-8).join('\n'));
  added = spawnSync('corepack', ['pnpm', 'add', 'vitest', '--prefer-offline'], {
    cwd: proj,
    encoding: 'utf8',
    timeout: 300_000,
    shell: process.platform === 'win32',
  });
}
log(`[setup] pnpm add vitest exit=${added.status}`);
log((added.stdout ?? '').split('\n').slice(-6).join('\n'));
if (added.status !== 0) {
  log('[setup] vitest 安装失败，实验中止（如实报告）');
  process.exit(1);
}

// 项目代码：TS + vitest 测试（含类型注解、esm 导入）
writeFileSync(join(proj, 'src', 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
writeFileSync(
  join(proj, 'src', 'math.test.ts'),
  [
    "import { describe, expect, it } from 'vitest';",
    "import { add } from './math.ts';",
    "describe('add', () => {",
    "  it('adds', () => { expect(add(1, 2)).toBe(3); });",
    "});",
  ].join('\n'),
);

// 2) 复制工作区 + junction
mkdirSync(join(copy, 'src'), { recursive: true });
cpSync(join(proj, 'package.json'), join(copy, 'package.json'));
cpSync(join(proj, 'src', 'math.ts'), join(copy, 'src', 'math.ts'));
cpSync(join(proj, 'src', 'math.test.ts'), join(copy, 'src', 'math.test.ts'));
if (existsSync(join(proj, 'pnpm-lock.yaml'))) {
  cpSync(join(proj, 'pnpm-lock.yaml'), join(copy, 'pnpm-lock.yaml'));
}
symlinkSync(join(proj, 'node_modules'), join(copy, 'node_modules'), 'junction');
// 修复 vite searchForWorkspaceRoot 向上级目录探测 pnpm-workspace.yaml（探测
// 到未授权的临时根目录被拒）：副本里放空 workspace 标记，让 vite 停在副本根。
// （对单包项目这是纯新增标记；monorepo 的真 pnpm-workspace.yaml 本就会被复制。）
writeFileSync(join(copy, 'pnpm-workspace.yaml'), '', 'utf8');

const realNm = join(proj, 'node_modules');
const tmp = tmpdir();
const base = [
  '--permission',
  `--allow-fs-read=${copy}`,
  `--allow-fs-read=${realNm}`,
  `--allow-fs-write=${copy}`,
];
const vitest = join(realNm, 'vitest', 'vitest.mjs');
if (!existsSync(vitest)) {
  log(`[setup] 未找到 ${vitest}（pnpm 布局不同？），实验中止`);
  process.exit(1);
}

// 3) 渐进旗标
// vitest 5 移除了 basic reporter（--reporter=basic 会被当自定义模块加载而失败）；
// 原生绑定（rolldown .node / esbuild）需要 --allow-addons。
const withAddons = [...base, '--allow-addons'];
const variants = [
  ['A 基础+addons（副本读+真实nm读+副本写+workspace标记）', withAddons],
  ['B A + --allow-worker（tinypool worker 线程）', [...withAddons, '--allow-worker']],
  ['C B + --allow-child-process（esbuild.exe 等子进程）', [...withAddons, '--allow-worker', '--allow-child-process']],
  [
    'D C + tmp 读写（tinypool/vite 落临时目录）',
    [...withAddons, '--allow-worker', '--allow-child-process', `--allow-fs-read=${tmp}`, `--allow-fs-write=${tmp}`],
  ],
];
let lastGood = null;
const tried = [];
for (const [label, flags] of variants) {
  const r = run(label, [process.execPath, ...flags, vitest, 'run'], copy);
  tried.push({ label, exit: r.status });
  const passed = r.exit === 0 && /passed|passed\s/i.test(r.text);
  if (passed) {
    lastGood = { label, flags };
    break;
  }
}
if (lastGood) {
  log(`\n== 最小可用旗标集：${lastGood.label} ==`);
  log(`flags = ${JSON.stringify(lastGood.flags, null, 1)}`);
} else {
  log('\n== 全部变体失败：需要继续排查（输出见上） ==');
}
try {
  rmSync(root, { recursive: true, force: true });
  log(`\n[cleanup] 已删除实验目录 ${root}`);
} catch (e) {
  log(`\n[cleanup] 删除失败（如实保留）：${e.message}`);
}

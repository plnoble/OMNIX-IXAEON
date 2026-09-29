#!/usr/bin/env node
/**
 * D2 实验 4：不依赖 node_modules 的最简路线——
 * Node 自带 TypeScript 类型剥离（type stripping）+ node:test。
 *
 * 问题：
 * 1. 执行验证的 node 是哪个、什么版本？（系统 node / 打包应用的 IXAEON.exe）
 * 2. node --permission + node:test 直跑 .ts（零依赖）能否在副本里工作；
 * 3. 覆盖面：可剥离语法（注解）OK；不可剥离语法（enum/命名空间/参数属性）；
 *    相对导入是否要写 .ts 扩展名；旧版 vitest 风格测试不适用。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const out = [];
const log = (l) => { out.push(l); console.log(l); };

const root = join(tmpdir(), `ixaeon-d2-e4-${process.pid}`);
const proj = join(root, 'proj');
const copy = join(root, 'copy');

// 1) 执行验证的 node 是谁
log(`== 1) 执行验证的 node ==`);
log(`系统 node: ${process.execPath} @ ${process.version}`);
log(`--experimental-strip-types 在本版 node：${process.allowedNodeEnvironmentFlags.has('--experimental-strip-types') ? '可识别' : '未知'}`);
const unpacked = 'D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/release/win-unpacked/IXAEON.exe';
if (existsSync(unpacked)) {
  // 打包应用的"node"= IXAEON.exe（Electron）。executor 的 isNode 检查
  // （exe === process.execPath）在打包环境会命中它——验证它能否当 node 用
  // （Electron 需要 ELECTRON_RUN_AS_NODE=1 才走 node 模式；defaultCheck 的
  //  minimalChildEnv 目前不传这个变量）。
  const t1 = spawnSync(unpacked, ['-e', 'console.log("AS_NODE=" + process.versions.node)'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  log(`打包 IXAEON.exe + ELECTRON_RUN_AS_NODE=1: exit=${t1.status} 输出=${(t1.stdout ?? '').trim() || '(无)'}`);
  const t2 = spawnSync(unpacked, ['-e', 'console.log("AS_NODE=" + process.versions.node)'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env },
  });
  log(
    `打包 IXAEON.exe 不带 ELECTRON_RUN_AS_NODE: exit=${t2.status} ` +
      `stdout=${(t2.stdout ?? '').trim().slice(0, 60) || '(无)'} stderr=${(t2.stderr ?? '').trim().slice(0, 80) || '(无)'}`,
  );
}

// 2) 合成项目（零依赖）+ 副本
mkdirSync(join(proj, 'src'), { recursive: true });
writeFileSync(
  join(proj, 'package.json'),
  JSON.stringify({ name: 'd2-e4', type: 'module', private: true, version: '1.0.0' }, null, 2),
);
writeFileSync(
  join(proj, 'src', 'math.ts'),
  [
    'export interface AddResult {',
    '  value: number;',
    '  label: string;',
    '}',
    'export function add(a: number, b: number): AddResult {',
    "  return { value: a + b, label: `sum=${a + b}` };",
    '}',
  ].join('\n'),
);
writeFileSync(
  join(proj, 'src', 'math.test.ts'),
  [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './math.ts';",
    "test('add returns erasable-typed result', () => {",
    "  const r = add(1, 2);",
    "  assert.equal(r.value, 3);",
    "  assert.equal(r.label, 'sum=3');",
    '});',
  ].join('\n'),
);
mkdirSync(join(copy, 'src'), { recursive: true });
for (const f of ['package.json']) cpSync(join(proj, f), join(copy, f));
cpSync(join(proj, 'src', 'math.ts'), join(copy, 'src', 'math.ts'));
cpSync(join(proj, 'src', 'math.test.ts'), join(copy, 'src', 'math.test.ts'));

// 3a) --permission 下直跑测试文件（node:test 进程内，无子进程）
log(`\n== 3a) --permission 直跑 .ts 测试（零依赖，node:test 进程内） ==`);
const run1 = spawnSync(
  process.execPath,
  [
    '--permission',
    `--allow-fs-read=${copy}`,
    `--allow-fs-write=${copy}`,
    join(copy, 'src', 'math.test.ts'),
  ],
  { cwd: copy, encoding: 'utf8', timeout: 60_000 },
);
log(`exit=${run1.status}`);
log(`${run1.stdout ?? ''}\n${run1.stderr ?? ''}`.trim().split('\n').slice(-10).join('\n'));

// 3b) node --test 模式（会为每个测试文件起子进程——需 --allow-child-process）
log(`\n== 3b) node --test 模式（需子进程） ==`);
const run2 = spawnSync(
  process.execPath,
  [
    '--permission',
    `--allow-fs-read=${copy}`,
    `--allow-fs-write=${copy}`,
    '--allow-child-process',
    '--test',
    join(copy, 'src', 'math.test.ts'),
  ],
  { cwd: copy, encoding: 'utf8', timeout: 60_000 },
);
log(`exit=${run2.status}`);
log(`${run2.stdout ?? ''}\n${run2.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n'));

// 4) 覆盖面：不可剥离语法（enum）在纯类型剥离下失败
log(`\n== 4) 不可剥离语法（enum）==`);
writeFileSync(
  join(copy, 'src', 'kind.ts'),
  'export enum Kind { A = "a", B = "b" }\n',
);
const run3 = spawnSync(
  process.execPath,
  [
    '--permission',
    `--allow-fs-read=${copy}`,
    `--allow-fs-write=${copy}`,
    '-e',
    `import('./src/kind.ts').then(() => console.log('ENUM_OK'), (e) => console.log('ENUM_FAIL: ' + e.message.slice(0, 120)))`,
  ],
  { cwd: copy, encoding: 'utf8', timeout: 60_000 },
);
log(`exit=${run3.status}`);
log(`${run3.stdout ?? ''}\n${run3.stderr ?? ''}`.trim().split('\n').slice(-4).join('\n'));

try {
  rmSync(root, { recursive: true, force: true });
  log(`\n[cleanup] 已删除 ${root}`);
} catch (e) {
  log(`\n[cleanup] 失败：${e.message}`);
}

#!/usr/bin/env node
/**
 * D2 实验 2b：rolldown 绑定被拒的诊断。
 * 1) junction 基线：无 --permission 时 vitest 在副本里能否跑（排除一般性损坏）；
 * 2) --permission 下逐个探测 rolldown 绑定相关路径，打印被拒的真实 resource；
 * 3) 对比：realNm 全量授权后 require 该绑定是否成功。
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(tmpdir(), `ixaeon-d2-e2b-${process.pid}`);
const proj = join(root, 'proj');
const copy = join(root, 'copy');
const out = [];
const log = (l) => {
  out.push(l);
  console.log(l);
};

mkdirSync(join(proj, 'src'), { recursive: true });
writeFileSync(
  join(proj, 'package.json'),
  JSON.stringify({ name: 'd2-e2b', type: 'module', private: true, version: '1.0.0' }, null, 2),
);
const add = spawnSync('corepack', ['pnpm', 'add', 'vitest', '--prefer-offline'], {
  cwd: proj,
  encoding: 'utf8',
  timeout: 300_000,
  shell: true,
});
log(`[setup] pnpm add vitest exit=${add.status}`);
if (add.status !== 0) {
  log((add.stderr ?? '').slice(-400));
  process.exit(1);
}
writeFileSync(
  join(proj, 'src', 'math.ts'),
  'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
);
writeFileSync(
  join(proj, 'src', 'math.test.ts'),
  "import { describe, expect, it } from 'vitest';\nimport { add } from './math.ts';\ndescribe('add', () => {\n  it('adds', () => { expect(add(1, 2)).toBe(3); });\n});\n",
);

mkdirSync(join(copy, 'src'), { recursive: true });
for (const f of ['package.json', 'pnpm-lock.yaml']) {
  if (existsSync(join(proj, f))) cpSync(join(proj, f), join(copy, f));
}
cpSync(join(proj, 'src', 'math.ts'), join(copy, 'src', 'math.ts'));
cpSync(join(proj, 'src', 'math.test.ts'), join(copy, 'src', 'math.test.ts'));
symlinkSync(join(proj, 'node_modules'), join(copy, 'node_modules'), 'junction');

const realNm = join(proj, 'node_modules');
const vitest = join(realNm, 'vitest', 'vitest.mjs');

// 1) junction 基线：无权限模型
log('\n== 1) 无 --permission：vitest 经 junction 在副本里跑 ==');
const base = spawnSync(process.execPath, [vitest, 'run', '--reporter=basic'], {
  cwd: copy,
  encoding: 'utf8',
  timeout: 180_000,
});
log(`exit=${base.status}`);
log(`${base.stdout ?? ''}\n${base.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n'));

// 2) 找 rolldown 绑定相关真实文件
log('\n== 2) rolldown 绑定文件实际布局 ==');
const rolldownDist = join(realNm, '.pnpm');
const candidates = [];
const walkPnpm = (dir, depth) => {
  if (depth > 3) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('@rolldown') || e.name.startsWith('rolldown')) candidates.push(full);
      walkPnpm(full, depth + 1);
    }
  }
};
walkPnpm(rolldownDist, 0);
for (const c of candidates.slice(0, 10)) {
  log(`[layout] ${c.replaceAll(root, '<root>')}`);
  try {
    for (const f of readdirSync(c)) log(`         - ${f}`);
  } catch {
    /* noop */
  }
}

// 3) --permission 探针：require 精确绑定文件，打印被拒 resource
log('\n== 3) --permission 下 require 探针（realNm 已授权）==');
const probe = join(copy, 'probe.mjs');
writeFileSync(
  probe,
  [
    "import { createRequire } from 'node:module';",
    "import { readdirSync } from 'node:fs';",
    'const req = createRequire(process.argv[1]);',
    'const dir = process.argv[2];',
    'try {',
    "  const files = readdirSync(dir + '/dist/shared');",
    "  console.log('dist/shared 列表: ' + files.join(', '));",
    "  const wasi = files.find((f) => f.includes('rolldown-binding'));",
    '  if (wasi) {',
    "    req(dir + '/dist/shared/' + wasi);",
    "    console.log('REQUIRE_OK: ' + wasi);",
    '  } else {',
    "    console.log('目录里没有 rolldown-binding*.cjs（可能绑定在可选包里）');",
    '  }',
    '} catch (e) {',
    "  console.log('DENIED_OR_FAIL: ' + (e.code ?? '') + ' ' + e.message);",
    "  if (e.permission) console.log('permission=' + e.permission + ' resource=' + e.resource);",
    '}',
  ].join('\n'),
);
const rolldownDir = join(realNm, '.pnpm', 'rolldown@1.2.11', 'node_modules', 'rolldown');
const flags = [
  '--permission',
  `--allow-fs-read=${copy}`,
  `--allow-fs-read=${realNm}`,
  `--allow-fs-write=${copy}`,
  '--allow-worker',
  '--allow-child-process',
];
const pr = spawnSync(process.execPath, [...flags, probe, rolldownDir], {
  cwd: copy,
  encoding: 'utf8',
  timeout: 60_000,
});
log(`exit=${pr.status}`);
log(`${pr.stdout ?? ''}\n${pr.stderr ?? ''}`.trim());

// 4) 对照：全盘 Temp 读授权（最宽）看是否仍被拒
log('\n== 4) 对照：放开整个 Temp 读 ==');
const pr2 = spawnSync(
  process.execPath,
  [
    ...flags.filter((f) => !f.startsWith('--allow-fs-read')),
    `--allow-fs-read=${tmpdir()}`,
    probe,
    rolldownDir,
  ],
  { cwd: copy, encoding: 'utf8', timeout: 60_000 },
);
log(`exit=${pr2.status}`);
log(`${pr2.stdout ?? ''}\n${pr2.stderr ?? ''}`.trim());

try {
  rmSync(root, { recursive: true, force: true });
  log(`\n[cleanup] 已删除 ${root}`);
} catch (e) {
  log(`\n[cleanup] 失败：${e.message}`);
}

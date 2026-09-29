#!/usr/bin/env node
/**
 * D2 实验 1：junction 挂载 node_modules + Node 权限模型的链接解析行为。
 *
 * 合成项目（临时目录，跑完清理）：
 *   proj/
 *     package.json {type:module}
 *     src/add.ts
 *     dep-dep.js            （真实 node_modules 里的依赖）
 *     node_modules/dep/...  （pnpm 风格：dep 是指向 .pnpm 的相对 symlink）
 *   copy/                   （模拟 copyProjectWorkspace：跳过 node_modules）
 *     node_modules -> proj/node_modules （junction）
 *
 * 回答四个问题：
 * 1a. --permission 下经 junction 读依赖是否可行；
 * 1b. Node 权限模型按「链接路径」还是「真实路径」判权（决定要不要
 *     额外 --allow-fs-read=<真实 node_modules>）；
 * 1c. 经 junction 写真实 node_modules 是否被 --allow-fs-write=<copy> 挡住
 *     （能否保证代理/测试写不进真实依赖）；
 * 1d. pnpm 风格的包内相对 symlink（dep -> ../.pnpm/...）经 junction 后能否解析。
 *
 * 原样输出写 stdout；退出码 0 = 实验跑完（不代表结论方向）。
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(tmpdir(), `ixaeon-d2-e1-${process.pid}`);
const proj = join(root, 'proj');
const copy = join(root, 'copy');
const results = [];

function log(line) {
  results.push(line);
  console.log(line);
}

function buildProject() {
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules', 'dep'), {
    recursive: true,
  });
  writeFileSync(
    join(proj, 'package.json'),
    JSON.stringify({ name: 'd2-e1', type: 'module', version: '1.0.0' }, null, 2),
  );
  // 真实依赖包内容（pnpm 风格：node_modules/dep 是相对 symlink）
  writeFileSync(
    join(proj, 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules', 'dep', 'index.js'),
    "export const depVersion = () => 'dep-1.0.0';\nexport default { depVersion };\n",
  );
  symlinkSync(
    join('.pnpm', 'dep@1.0.0', 'node_modules', 'dep'),
    join(proj, 'node_modules', 'dep'),
    'junction',
  );
  // 项目代码：从依赖读值
  writeFileSync(
    join(proj, 'src', 'main.mjs'),
    [
      "import dep from 'dep';",
      "import { readFileSync } from 'node:fs';",
      "console.log('DEP_VALUE=' + dep.depVersion());",
      "// 读一个依赖目录里的文件（模拟测试读取类型声明等）",
      "const decl = readFileSync(new URL('../node_modules/dep/index.js', import.meta.url), 'utf8');",
      "console.log('DECL_LEN=' + decl.length);",
    ].join('\n'),
  );
  // 复制工作区（模拟 workspaceCopy：跳过 node_modules）
  mkdirSync(join(copy, 'src'), { recursive: true });
  cpSync(join(proj, 'package.json'), join(copy, 'package.json'));
  cpSync(join(proj, 'src', 'main.mjs'), join(copy, 'src', 'main.mjs'));
  // junction：copy/node_modules -> proj/node_modules
  symlinkSync(join(proj, 'node_modules'), join(copy, 'node_modules'), 'junction');
  log(`[setup] proj=${proj}`);
  log(`[setup] copy=${copy}`);
  log(`[setup] copy/node_modules (junction) -> ${proj}\\node_modules`);
}

/** 跑 node --permission 变体；返回 {exit, out} */
function runNode(label, extraFlags, script, cwd) {
  const argv = ['--permission', ...extraFlags, script];
  const r = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout: 30_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  log(`\n### ${label}`);
  log(`$ node ${argv.join(' ')}  (cwd=${cwd})`);
  log(`exit=${r.status}`);
  log(out || '(no output)');
  return { exit: r.status, out };
}

function experiment() {
  buildProject();
  const mainScript = join(copy, 'src', 'main.mjs');

  // 基线：无 --permission， junction 读取应正常（证明 junction 本身工作）
  log('\n== 0) 基线：无权限模型，junction 读取 ==');
  runNode('baseline-no-permission', [], mainScript, copy);

  // 1a/1b: 只授权 copy —— 读经 junction 能否成功（判定链接 vs 真实路径）
  log('\n== 1) --allow-fs-read=<copy> 只授权副本 ==');
  const r1 = runNode('read-copy-only', [`--allow-fs-read=${copy}`], mainScript, copy);

  // 2) 加上真实 node_modules 授权
  log('\n== 2) --allow-fs-read=<copy> + --allow-fs-read=<真实 node_modules> ==');
  const r2 = runNode(
    'read-copy-plus-real',
    [`--allow-fs-read=${copy}`, `--allow-fs-read=${join(proj, 'node_modules')}`],
    mainScript,
    copy,
  );

  // 3) 写测试：经 junction 写真实 node_modules（只授权 copy 写）
  log('\n== 3) 写测试：--allow-fs-write=<copy>，尝试经 junction 写真实依赖 ==');
  const writeProbe = join(copy, 'write-probe.mjs');
  writeFileSync(
    writeProbe,
    [
      "import { writeFileSync } from 'node:fs';",
      "const target = new URL('./node_modules/dep/probe-written.txt', import.meta.url);",
      "try {",
      "  writeFileSync(target, 'written-through-junction');",
      "  console.log('WRITE_OK (危险：真实依赖被写入)');",
      "} catch (e) {",
      "  console.log('WRITE_BLOCKED: ' + e.code + ' ' + e.message);",
      "}",
    ].join('\n'),
  );
  runNode('write-through-junction', [`--allow-fs-read=${copy}`, `--allow-fs-write=${copy}`], writeProbe, copy);
  const probeFile = join(proj, 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules', 'dep', 'probe-written.txt');
  log(`[verify] 真实依赖里是否真的出现了写入文件: ${existsSync(probeFile)}`);
  if (existsSync(probeFile)) {
    rmSync(probeFile); // 清理实验产物
    log('[verify] 已清理实验写入');
  }

  // 4) 反向确认：对真实 node_modules 的写授权才写得进去（证明语义）
  log('\n== 4) 对照：--allow-fs-write=<真实 node_modules> 时同一写探针 ==');
  runNode(
    'write-with-real-grant',
    [
      `--allow-fs-read=${copy}`,
      `--allow-fs-read=${join(proj, 'node_modules')}`,
      `--allow-fs-write=${copy}`,
      `--allow-fs-write=${join(proj, 'node_modules')}`,
    ],
    writeProbe,
    copy,
  );
  log(`[verify] 真实依赖里是否出现了写入文件: ${existsSync(probeFile)}`);
  if (existsSync(probeFile)) {
    rmSync(probeFile);
    log('[verify] 已清理实验写入');
  }

  // 汇总
  log('\n== 结论要点（脚本自动判定） ==');
  log(`只授权 copy 时 junction 读取: ${r1.exit === 0 ? '成功(按链接路径判权)' : '失败(按真实路径判权)'}`);
  log(`加授权真实 node_modules 后读取: ${r2.exit === 0 ? '成功' : '仍失败(见输出)'}`);
  log(
    `写保护: ${
      !existsSync(probeFile) && r1.out.includes('WRITE_BLOCKED')
        ? '写被拦（真实依赖受保护）'
        : '注意：见上方写入结果'
    }`,
  );
}

try {
  experiment();
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
    log(`\n[cleanup] 已删除实验目录 ${root}`);
  } catch (e) {
    log(`\n[cleanup] 删除失败（如实保留）：${e.message}`);
  }
}
writeFileSync(join(import.meta.dirname, 'e1-last-run.txt'), results.join('\n'), 'utf8');

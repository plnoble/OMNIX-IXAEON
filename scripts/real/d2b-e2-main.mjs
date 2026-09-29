#!/usr/bin/env node
/**
 * D2b 主实验（专用 CODEX_HOME 已一次性授权后）：
 * T1 连续 10 次无人值守 elevated 运行；
 * T4 junction 挂真实依赖：读可行、写真实依赖被拦（核心安全问题）；
 * T5 联网被拦、写工作区外被拦（固定 HOME 下复核）；
 * T6 vitest 沙箱内外计时对比。
 *
 * 专用 HOME：<系统临时目录>/ixaeon-d2b-home（cap_sid 已由用户点一次 UAC 生成），
 * CODEX_HOME 通过环境覆盖，路径在运行期由 tmpdir() 推导，不在仓库里写本机路径。
 * 不跑 codex exec、不调模型、只用合成项目。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CODEX = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin', 'codex.exe');
const HOME = join(tmpdir(), 'ixaeon-d2b-home');
const WORK = join(tmpdir(), 'ixaeon-d2b-work');
const env = { ...process.env, CODEX_HOME: HOME };
const out = [];
const log = (l) => {
  out.push(l);
  console.log(l);
};

// 幂等重建 junction：rmSync(recursive) 只删链接、不跟进目标（已真机验证）
function ensureJunction(link, target) {
  if (existsSync(link)) rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, 'junction');
}

function sandboxRun(args, cwd = WORK, timeout = 120_000, extraEnv = {}, extraCfg = []) {
  const r = spawnSync(
    CODEX,
    [
      'sandbox',
      'windows',
      '--permissions-profile',
      'd2b',
      '-c',
      'windows.sandbox="elevated"',
      ...extraCfg,
      '-C',
      cwd,
      '--',
      ...args,
    ],
    { encoding: 'utf8', timeout, env: { ...env, ...extraEnv }, windowsHide: true },
  );
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
}

// ── T1：10 次无人值守 ──
log('== T1 连续 10 次无人值守（专用 HOME 已授权） ==');
let okCount = 0;
for (let i = 1; i <= 10; i += 1) {
  const r = sandboxRun([process.execPath, '-e', `process.stdout.write('D2B_T1_${i}')`]);
  const ok = r.status === 0 && r.out.includes(`D2B_T1_${i}`);
  if (ok) okCount += 1;
  log(
    `T1-${i}: exit=${r.status} ${ok ? 'PASS' : 'FAIL out=' + r.out.split('\n').slice(-2).join('|')}`,
  );
}
log(`T1 汇总：${okCount}/10`);

// ── T4：junction 写保护 ──
log('\n== T4 junction 挂真实依赖：读可行、写真实依赖被拦 ==');
// 真实依赖位于 work 之外的「只读区」（filesystem 只给了 Temp/** read）
const realNm = join(tmpdir(), 'ixaeon-d2b-realnm');
rmSync(join(realNm, 'dep'), { recursive: true, force: true });
mkdirSync(join(realNm, 'dep'), { recursive: true });
writeFileSync(
  join(realNm, 'dep', 'package.json'),
  '{"name":"dep","type":"module","main":"index.js"}',
);
writeFileSync(join(realNm, 'dep', 'index.js'), 'export const v = () => "dep-real";\n');
const copyDir = join(WORK, 'copy');
mkdirSync(join(copyDir, 'src'), { recursive: true });
writeFileSync(join(copyDir, 'package.json'), '{"name":"d2b-copy","type":"module"}');
writeFileSync(
  join(copyDir, 'src', 'main.mjs'),
  [
    "import { writeFileSync, existsSync } from 'node:fs';",
    '// 1) 经 junction 读真实依赖',
    "const dep = await import('dep');",
    "console.log('READ_DEP=' + dep.v());",
    '// 2) 经 junction 写真实依赖里的新文件（应被拦）',
    "try { writeFileSync(new URL('../node_modules/dep/write-through.txt', import.meta.url), 'x'); console.log('WRITE_THROUGH=ALLOWED'); }",
    "catch (e) { console.log('WRITE_THROUGH=BLOCKED(' + e.code + ')'); }",
    '// 3) 写在副本内（应放行）',
    "try { writeFileSync(new URL('../inside.txt', import.meta.url), 'x'); console.log('WRITE_INSIDE=ALLOWED'); }",
    "catch (e) { console.log('WRITE_INSIDE=BLOCKED(' + e.code + ')'); }",
  ].join('\n'),
);
ensureJunction(join(copyDir, 'node_modules'), realNm);
const t4 = sandboxRun([process.execPath, 'src/main.mjs'], copyDir);
log('T4 输出：\n' + t4.out);
const throughFile = join(realNm, 'dep', 'write-through.txt');
log(`T4 真实依赖里是否真出现写入文件：${existsSync(throughFile)}`);
if (existsSync(throughFile)) rmSync(throughFile);

// ── T5：联网 / 越界写 ──
log('\n== T5 联网被拦 + 写工作区外被拦 ==');
writeFileSync(
  join(WORK, 'probe.mjs'),
  [
    "const t = setTimeout(() => { console.log('NETWORK=TIMEOUT'); process.exit(0); }, 20000);",
    "fetch('https://api.github.com/zen', { signal: AbortSignal.timeout(15000) })",
    "  .then((r) => { clearTimeout(t); console.log('NETWORK=ALLOWED(' + r.status + ')'); })",
    "  .catch((e) => { clearTimeout(t); console.log('NETWORK=BLOCKED(' + (e.cause?.code ?? e.name) + ')'); });",
  ].join('\n'),
);
const t5n = sandboxRun([process.execPath, 'probe.mjs']);
log('T5 联网：\n' + t5n.out);
writeFileSync(
  join(WORK, 'escape.mjs'),
  "import { writeFileSync, existsSync, unlinkSync } from 'node:fs';" +
    "import { join } from 'node:path';" +
    "const p = join(process.env.LOCALAPPDATA ?? '', 'd2b-escape.txt');" +
    'try { if (existsSync(p)) unlinkSync(p); } catch {}' +
    "try { writeFileSync(p, 'x'); console.log('ESCAPE=ALLOWED'); }" +
    "catch (e) { console.log('ESCAPE=BLOCKED(' + e.code + ')'); }",
);
const t5e = sandboxRun([process.execPath, 'escape.mjs']);
log('T5 越界写：\n' + t5e.out);
const escapeFile = join(process.env.LOCALAPPDATA ?? '', 'd2b-escape.txt');
log(`T5 越界文件是否存在：${existsSync(escapeFile)}`);
if (existsSync(escapeFile)) rmSync(escapeFile);

// ── T6：vitest 计时（沙箱内 vs 沙箱外）──
log('\n== T6 vitest 计时对比 ==');
const vitestProj = join(WORK, 'vitest-proj');
mkdirSync(join(vitestProj, 'src'), { recursive: true });
writeFileSync(join(vitestProj, 'package.json'), '{"name":"d2b-vitest","type":"module"}');
writeFileSync(
  join(vitestProj, 'src', 'add.test.ts'),
  "import { describe, expect, it } from 'vitest';\n" +
    "import { add } from './add.ts';\n" +
    "describe('add', () => { it('sums', () => { expect(add(1,2)).toBe(3); }); });\n",
);
writeFileSync(
  join(vitestProj, 'src', 'add.ts'),
  'export const add = (a: number, b: number) => a + b;\n',
);
const vitestExists = existsSync(join(realNm, 'node_modules', 'vitest', 'vitest.mjs'));
if (!vitestExists) {
  log('vitest 未安装在真实依赖目录（合成项目需 pnpm 离线安装），T6 标记未跑。');
} else {
  // junction 供内外两次运行解析 'vitest'；vitest 缓存强制写副本内（真实依赖只读，写透会被 ACL 拦）
  // 用 .mjs 纯对象配置：TS 配置会触发 Vite config 打包 → 写 node_modules/.vite-temp（junction 写透，EPERM）
  ensureJunction(join(vitestProj, 'node_modules'), join(realNm, 'node_modules'));
  writeFileSync(
    join(vitestProj, 'vitest.config.mjs'),
    "export default { cacheDir: '.vitest-cache' };\n",
  );
  const tDirect0 = Date.now();
  const direct = spawnSync(
    process.execPath,
    [join(realNm, 'node_modules', 'vitest', 'vitest.mjs'), 'run'],
    {
      cwd: vitestProj,
      encoding: 'utf8',
      timeout: 180_000,
    },
  );
  const directMs = Date.now() - tDirect0;
  log(`T6 沙箱外：exit=${direct.status} 耗时 ${directMs}ms`);
  // Temp/** 只读，vitest 运行时临时文件指到工作区内可写目录
  mkdirSync(join(WORK, 'tmp'), { recursive: true });
  const sboxTmp = join(WORK, 'tmp');
  const beforeKeys = readdirSync(join(realNm, 'node_modules')).length;
  const t0 = Date.now();
  const insand = sandboxRun(
    [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config-loader', 'runner'],
    vitestProj,
    240_000,
    { TMP: sboxTmp, TEMP: sboxTmp },
    ['-c', 'shell_environment_policy.inherit=all'],
  );
  const ms = Date.now() - t0;
  log(`T6 沙箱内：exit=${insand.status} 耗时 ${ms}ms`);
  log(`T6 沙箱内输出全量：\n${insand.out}`);
  const afterKeys = readdirSync(join(realNm, 'node_modules')).length;
  log(`T6 真实 node_modules 目录项数 前=${beforeKeys} 后=${afterKeys}（写透应被拦，数目不该变）`);
}

writeFileSync(join(tmpdir(), 'd2b-main-last.txt'), out.join('\n'), 'utf8');
log('\n[done] 摘要已写 ' + join(tmpdir(), 'd2b-main-last.txt'));

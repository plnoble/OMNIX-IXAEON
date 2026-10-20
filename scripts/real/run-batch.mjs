/**
 * 真机脚本跑批：按顺序跑一串 `scripts/real/` 下的脚本，每个单独超时，输出落
 * `.logs/<文件名>.out`，跑完打一张「退出码 + RESULT 行」的表（同时写进
 * `.logs/run-batch-summary.md`）。
 *
 * 为什么提交进来：真机检查是一次一串跑的，逐个手敲容易漏、也容易忘了记退出码。
 * Q1（真机脚本体检）就是用这个把 26 个「甲类」脚本连跑三遍的，输出原样贴进了交付说明。
 *
 *   node scripts/real/run-batch.mjs [--timeout <毫秒>] <脚本> [<脚本> ...]
 *   node scripts/real/run-batch.mjs --timeout 480000 scripts/real/a5-model-failure-real.mjs
 *
 * 两件事它替你做（脚本自己也做，这里是双保险）：
 * - 清掉宿主带来的 `ELECTRON_RUN_AS_NODE`：开发 agent 的 shell 与门禁都带这个变量，
 *   Electron 会当普通 node 跑、Playwright 报「Process failed to launch!」；
 * - `.ts` 脚本用 jiti 跑：先找 `node_modules/.bin/jiti`，没有就从 `node_modules/.pnpm/jiti@*`
 *   里找 CLI（新建的工作目录里通常只有后者）。
 *
 * 退出码：全 0 才 0，有一个非 0 就是 1。
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
let timeoutMs = 300_000;
const scripts = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--timeout') {
    timeoutMs = Number(args[++i]);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout 要给毫秒数');
  } else if (a.startsWith('--')) {
    throw new Error(`不认识的参数：${a}`);
  } else {
    scripts.push(a);
  }
}
if (scripts.length === 0) {
  throw new Error('用法：node scripts/real/run-batch.mjs [--timeout 毫秒] <脚本> [<脚本> ...]');
}

/** jiti 的 CLI 路径：`.bin` 里没有就从 `.pnpm` 里找（jiti 不是根依赖）。 */
function findJiti() {
  const direct = join('node_modules', '.bin', process.platform === 'win32' ? 'jiti.cmd' : 'jiti');
  if (existsSync(direct)) return direct;
  try {
    const dir = readdirSync(join('node_modules', '.pnpm')).find((d) => d.startsWith('jiti@'));
    if (!dir) return null;
    return resolve(
      join('node_modules', '.pnpm', dir, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'),
    );
  } catch {
    return null;
  }
}

const jiti = scripts.some((s) => s.endsWith('.ts')) ? findJiti() : null;
if (scripts.some((s) => s.endsWith('.ts')) && !jiti) {
  throw new Error(
    '要跑 .ts 脚本，但没找到 jiti（node_modules/.bin/jiti 与 node_modules/.pnpm/jiti@* 都没有）',
  );
}

const summaryPath = resolve('.logs', 'run-batch-summary.md');
writeFileSync(
  summaryPath,
  `# 真机脚本跑批（单独超时 ${timeoutMs}ms）开始 ${new Date().toISOString()}\n\n| 脚本 | 退出码 | RESULT |\n| --- | --- | --- |\n`,
  'utf8',
);

const rows = [];
for (const script of scripts) {
  const isTs = script.endsWith('.ts');
  const outPath = resolve('.logs', `${basename(script)}.out`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`\n===== ${script} =====`);
  const out = createWriteStream(outPath);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, isTs ? [jiti, script] : [script], {
      env,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const pipe = (buf) => {
      process.stdout.write(buf);
      out.write(buf);
    };
    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.log('[runner] 超时，杀进程');
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('exit', (c, sig) => {
      clearTimeout(timer);
      done(timedOut ? 124 : (c ?? (sig ? 125 : 1)));
    });
  });
  out.end();

  let text = '';
  try {
    text = readFileSync(outPath, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  } catch {
    /* 没输出文件就当没有 RESULT */
  }
  const resultLine =
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('RESULT'))
      .at(-1) ?? '（没有 RESULT 行）';
  console.log(`[runner] ${basename(script)} 退出码=${code}｜${resultLine}`);
  appendFileSync(
    summaryPath,
    `| \`${basename(script)}\` | ${code} | ${resultLine.replace(/\|/g, '\\|')} |\n`,
    'utf8',
  );
  rows.push({ script, code, resultLine });
}

console.log('\n===== 汇总 =====');
for (const r of rows) console.log(`${r.code}\t${r.script}\t${r.resultLine}`);
const bad = rows.filter((r) => r.code !== 0);
console.log(`\n共 ${rows.length} 个，非 0 的 ${bad.length} 个`);
process.exitCode = bad.length === 0 ? 0 : 1;

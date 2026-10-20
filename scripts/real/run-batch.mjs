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
  mkdirSync,
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

/** jiti 的 CLI 路径：一定要拿到 **真正的 JS 入口**（`.bin/jiti.cmd` 是批处理包装，
 *  交给 node 解析会直接失败）。先找 `.pnpm/jiti@*`，再退到提升到根上的 `node_modules/jiti`。 */
function findJiti() {
  const candidates = [];
  try {
    for (const dir of readdirSync(join('node_modules', '.pnpm'))) {
      if (dir.startsWith('jiti@')) {
        candidates.push(
          resolve(
            join('node_modules', '.pnpm', dir, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'),
          ),
        );
      }
    }
  } catch {
    /* 没有 .pnpm 就试下面的 */
  }
  candidates.push(resolve(join('node_modules', 'jiti', 'lib', 'jiti-cli.mjs')));
  return candidates.find((p) => existsSync(p)) ?? null;
}

const wantsTs = scripts.some((s) => s.endsWith('.ts'));
const jiti = wantsTs ? findJiti() : null;
if (wantsTs && !jiti) {
  throw new Error(
    '要跑 .ts 脚本，但没找到 jiti 的 CLI（node_modules/.pnpm/jiti@*/node_modules/jiti/lib/jiti-cli.mjs 与 node_modules/jiti/lib/jiti-cli.mjs 都没有）',
  );
}

/** 跑之前核对数据目录（规格第 2 步）：起应用的脚本必须自己设 IXAEON_DATA_DIR，否则不许跑。 */
function checkDataDir(script) {
  let src = '';
  try {
    src = readFileSync(script, 'utf8');
  } catch {
    throw new Error(`读不到脚本源码：${script}`);
  }
  const launchesApp = /electron\.launch/.test(src);
  const setsDataDir = /IXAEON_DATA_DIR/.test(src);
  const usesTemp = /mkdtempSync/.test(src);
  if (launchesApp && !setsDataDir) {
    throw new Error(
      `${script} 会起应用但没设 IXAEON_DATA_DIR（默认数据目录是用户的真实数据），拒绝运行`,
    );
  }
  if (!launchesApp && !usesTemp) {
    throw new Error(`${script} 既不起应用也没有 mkdtempSync 临时目录，拒绝运行`);
  }
  return launchesApp
    ? '起应用=是，IXAEON_DATA_DIR=有'
    : `起应用=否，临时目录当参数传（mkdtempSync=${usesTemp ? '有' : '无'}）`;
}

mkdirSync('.logs', { recursive: true });
const summaryPath = resolve('.logs', 'run-batch-summary.md');
writeFileSync(
  summaryPath,
  `# 真机脚本跑批（单独超时 ${timeoutMs}ms）开始 ${new Date().toISOString()}\n\n| 脚本 | 退出码 | RESULT |\n| --- | --- | --- |\n`,
  'utf8',
);

const rows = [];
for (const script of scripts) {
  const isTs = script.endsWith('.ts');
  const dataDirNote = checkDataDir(script);
  const outPath = resolve('.logs', `${basename(script)}.out`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`\n===== ${script} =====`);
  console.log(`[runner] 数据目录核对：${dataDirNote}`);
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
    // 等 close（不是 exit）：close 之后 stdout/stderr 已经收完，才不会漏掉最后的 RESULT 行
    child.on('close', (c, sig) => {
      clearTimeout(timer);
      done(timedOut ? 124 : (c ?? (sig ? 125 : 1)));
    });
  });
  // 等日志流真正落盘再读（否则读到的是半截）
  await new Promise((done) => out.end(done));

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

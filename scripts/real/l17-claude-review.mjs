/**
 * L17 真机检查：Codex 额度用完时，真 Claude 代审（规格 L17「真机检查」）。
 *
 * 做法：在**临时目录**里建一个合成的 git 仓库（bare origin + 一个克隆），放一份三行的合成规格
 * `docs/委派/L99-合成.md`，切 `dev/L99` 改一行并提交。`CODEX_BIN` 指一个只打
 * `usage limit reached` 的替身；Claude 照契约第 3 条在本机找（`CLAUDE_BIN` 优先，否则
 * `~/.ixaeon/relay/config.json` 的 `roles.integrator.argv[0]`），路径不打印。
 *
 * 在 Codex 和真 Claude 之间垫一个记录用的 `.mjs` 替身（经 `CLAUDE_BIN`）：它把收到的参数、
 * 标准输入长度记下来，起真 Claude，再把真 Claude 的原始 JSON 留一份。这样能核对
 * 「`--restricted --tools '' …` 这串参数真 Claude 认不认」、有没有 tool 来回（`num_turns`）。
 *
 * 核对：`codex-review.mjs` 退出码是 0/1 之一、审查记录第一行对、`审查者：Claude（x.y.z）`、
 * 有花费一行、退出码和最后的结论对得上。**真模型调用最多 2 次**；这里只用 1 次（`--version`
 * 不算模型调用）。不符就逐条打「✗」，最后「结论：不通过」退 1。
 *
 * 全程不调真 Codex、不连 GitHub；打印遮掉临时目录和本机用户目录/账户名。
 *   node scripts/real/l17-claude-review.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REVIEW_SCRIPT = join(repo, 'scripts', 'codex-review.mjs');
const TASK = 'L99';

const work = mkdtempSync(join(tmpdir(), 'ixa-l17-real-'));
const mask = (s) => {
  let text = String(s);
  for (const p of [
    work,
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    homedir(),
    tmpdir(),
  ].filter((x) => x && x.trim())) {
    for (const v of [p, p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) {
      text = text.split(v).join('<临时目录>');
    }
  }
  for (const n of [process.env.USERNAME, process.env.USER]) {
    if (n && n.trim().length >= 3) text = text.split(n.trim()).join('<本机账户>');
  }
  return text;
};
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(mask(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`));
  return (r.stdout ?? '').trim();
};

let bad = 0;
const check = (ok, what, extra = '') => {
  if (!ok) bad++;
  log(`  ${ok ? '✓' : '✗'} ${what}${extra ? `：${mask(extra)}` : ''}`);
};

/** 契约第 3 条：环境变量优先，再看调度器配置的 roles.integrator.argv[0]。 */
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const dataDir = process.env.IXAEON_RELAY_DIR || join(homedir(), '.ixaeon', 'relay');
  try {
    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
    const bin = config?.roles?.integrator?.argv?.[0];
    if (typeof bin === 'string' && bin) return bin;
  } catch {
    /* 配置读不到、不是 JSON：当作没有 */
  }
  return null;
}

/** 记录替身：记参数和标准输入长度，起真 Claude，留下原始 JSON。 */
const WRAPPER = [
  "import { spawnSync } from 'node:child_process';",
  "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
  'const real = process.env.L17_REAL_CLAUDE;',
  'if (!real) { console.error("L17_REAL_CLAUDE 没设"); process.exit(2); }',
  'const args = process.argv.slice(2);',
  "const stdin = readFileSync(0, 'utf8');",
  "if (!args.includes('--version')) {",
  '  appendFileSync(process.env.L17_ARGV_LOG, JSON.stringify({ args, stdinLength: stdin.length }) + "\\n");',
  '}',
  'const isScript = /^(?:.*[\\\\/])?[^\\\\/]+\\.(?:mjs|js)$/i.test(real);',
  'const r = spawnSync(isScript ? process.execPath : real, isScript ? [real, ...args] : args, {',
  '  input: stdin,',
  "  encoding: 'utf8',",
  '  windowsHide: true,',
  '  maxBuffer: 64 * 1024 * 1024,',
  '  timeout: 44 * 60 * 1000,',
  '});',
  "if (!args.includes('--version')) writeFileSync(process.env.L17_RAW_OUT, r.stdout ?? '', 'utf8');",
  "if ((r.stderr ?? '') !== '') process.stderr.write(r.stderr);",
  "process.stdout.write(r.stdout ?? '');",
  'process.exit(r.status ?? 1);',
  '',
].join('\n');

/** Codex 替身：`--version` 打版本；其余只打额度字样，不写 `-o` 文件。 */
const CODEX_STUB = [
  'const argv = process.argv.slice(2);',
  "if (argv.includes('--version')) { console.log('codex-cli 9.9.9 (synthetic)'); process.exit(0); }",
  "console.log('usage limit reached');",
  'process.exit(1);',
  '',
].join('\n');

try {
  log('== 一、合成仓库（三行规格、一处一行改动、切 dev/L99）');
  const origin = join(work, 'origin.git');
  const tempRepo = join(work, 'repo');
  git(work, ['init', '--bare', '-b', 'main', origin]);
  git(work, ['clone', '-q', origin, tempRepo]);
  git(tempRepo, ['config', 'user.email', 'relay@example.invalid']);
  git(tempRepo, ['config', 'user.name', 'relay']);
  mkdirSync(join(tempRepo, 'docs', '委派', '交付'), { recursive: true });
  mkdirSync(join(tempRepo, 'scripts'), { recursive: true });
  writeFileSync(
    join(tempRepo, 'docs', '委派', 'L99-合成.md'),
    ['# 合成规格 L99', '', '这一条验收条件：合成仓库只用来喂审查上下文。', ''].join('\n'),
    'utf8',
  );
  writeFileSync(join(tempRepo, 'AGENTS.md'), '# 合成 AGENTS.md\n\n合成规则：不读真的。\n', 'utf8');
  copyFileSync(REVIEW_SCRIPT, join(tempRepo, 'scripts', 'codex-review.mjs'));
  writeFileSync(join(tempRepo, '合成.txt'), '原始一行\n', 'utf8');
  git(tempRepo, ['add', '-A']);
  git(tempRepo, ['commit', '-q', '-m', '初始合成仓库']);
  git(tempRepo, ['push', '-q', 'origin', 'HEAD:main']);
  git(tempRepo, ['switch', '-q', '-c', 'dev/L99']);
  writeFileSync(join(tempRepo, '合成.txt'), '改了一行\n', 'utf8');
  git(tempRepo, ['add', '-A']);
  git(tempRepo, ['commit', '-q', '-m', '合成：一处改动']);
  log('   合成规格 3 行；改动 1 个文件 1 行；分支 dev/L99');

  log('== 二、替身 Codex 只打 usage limit reached');
  const codexStub = join(work, 'codex-stub.mjs');
  writeFileSync(codexStub, CODEX_STUB, 'utf8');
  const claude = findClaude();
  if (!claude) {
    check(false, '按契约第 3 条找到本机的 Claude');
  } else {
    log('   找到 Claude（路径不打印）');
  }

  const argvLog = join(work, 'claude-args.jsonl');
  const rawOut = join(work, 'claude-raw.json');
  const wrapper = join(work, 'claude-wrapper.mjs');
  writeFileSync(wrapper, WRAPPER, 'utf8');

  log('== 三、跑 node scripts/codex-review.mjs L99（Codex 额度用完 → Claude 代审）');
  const before = Date.now();
  const r = claude
    ? spawnSync(process.execPath, [join(tempRepo, 'scripts', 'codex-review.mjs'), TASK], {
        cwd: tempRepo,
        env: {
          ...process.env,
          CODEX_BIN: codexStub,
          CLAUDE_BIN: wrapper,
          L17_REAL_CLAUDE: claude,
          L17_ARGV_LOG: argvLog,
          L17_RAW_OUT: rawOut,
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 48 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
      })
    : null;
  const seconds = Math.round((Date.now() - before) / 1000);
  if (r) {
    log(`   退出码 ${r.status}｜用了 ${seconds} 秒`);
    const errTail = (r.stderr ?? '').trim().split('\n').slice(-6).join('\n');
    if (errTail) log(`   stderr 最后几行（遮过）：\n${mask(errTail)}`);
  }

  log('== 四、逐条核对');
  check(!!r, '跑起了 codex-review');
  if (r) check(r.status === 0 || r.status === 1, '退出码是 0/1 之一', String(r.status));

  const reviewPath = join(tempRepo, 'docs', '委派', '交付', `${TASK}-Codex审查.md`);
  const reviewText = existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8') : '';
  const firstLine = (reviewText.split(/\r?\n/)[0] ?? '').trim();
  check(
    firstLine === `# ${TASK} 审查（Codex 额度用完，由 Claude 代审）`,
    '审查记录第一行写明 Claude 代审',
    firstLine,
  );
  const reviewer = /^- 审查者：Claude（(\d+\.\d+\.\d+)）/m.exec(reviewText);
  check(!!reviewer, '审查者行有 Claude（x.y.z）', reviewer?.[1] ?? '（没有）');
  const cost = /^- 花费：(.+) 美元$/m.exec(reviewText);
  check(!!cost, '有花费一行', cost?.[1] ?? '（没有）');
  const lastLine =
    reviewText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? '';
  check(
    r?.status === 0 ? lastLine.includes('结论：可以合并') : lastLine.includes('结论：需要修改'),
    '退出码和最后的结论对得上',
    lastLine,
  );

  // 真 Claude 收到的参数：契约第 4 条那一串，且 --tools 后面是空字符串
  const calls = existsSync(argvLog)
    ? readFileSync(argvLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  check(calls.length === 1, '真 Claude 被调用 1 次（模型调用）', String(calls.length));
  const args = calls[0]?.args ?? [];
  check(
    args.length === 7 &&
      args[0] === '--restricted' &&
      args[1] === '--tools' &&
      args[2] === '' &&
      args[3] === '--output-format' &&
      args[4] === 'json' &&
      args[5] === '-p' &&
      typeof args[6] === 'string' &&
      args[6].length > 0,
    '参数正好 --restricted --tools "" --output-format json -p <prompt>',
    args
      .slice(0, 6)
      .map((a) => JSON.stringify(a))
      .join(' ') + ` + <prompt ${String(args[6] ?? '').length} 字>`,
  );

  // 真 Claude 的原始 JSON：有 result、不是错误、没有 tool 来回
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(rawOut, 'utf8').trim());
  } catch {
    /* 不是 JSON：下面报 */
  }
  check(!!raw, '真 Claude 的原始输出是整段 JSON');
  check(raw?.is_error !== true, 'is_error 不是 true', String(raw?.is_error));
  check(typeof raw?.result === 'string' && raw.result.trim().length > 0, 'JSON 里有 result');
  check(
    typeof raw?.total_cost_usd === 'number',
    'JSON 里有 total_cost_usd（记录里的花费来自它）',
    String(raw?.total_cost_usd),
  );
  if (typeof raw?.num_turns === 'number') {
    check(
      raw.num_turns <= 1,
      '没有 tool 来回（num_turns ≤ 1，--tools "" 生效）',
      String(raw.num_turns),
    );
  } else {
    log('   （JSON 里没有 num_turns，无法从回合数核对 tool；参数里的 --tools "" 已核对）');
  }
} catch (err) {
  bad++;
  log(`  ✗ 出错：${mask(err instanceof Error ? err.message : String(err))}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

log(bad === 0 ? '结论：通过' : `结论：不通过（${bad} 条不符）`);
log(bad === 0 ? 'RESULT 通过' : 'RESULT 没通过');
process.exit(bad === 0 ? 0 : 1);

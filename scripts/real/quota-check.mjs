/**
 * 额度自检（不改任何东西、不推任何分支）：
 *
 *   node scripts/real/quota-check.mjs            # 看 Codex / Claude 两家的额度回没回
 *   node scripts/real/quota-check.mjs --l18      # 顺手提示 L18 该跑哪条命令
 *
 * 做法：只发**一句话**问各自「回一个字「在」就行」，各花 1 次调用：
 * - Codex：`codex exec ... -o <临时文件>`；
 * - Claude：`claude --restricted --tools '' --output-format json -p ...`（和 L17 代审同一个形状）。
 *
 * 判读沿用调度器自己的 quotaPatterns（`<数据目录>/config.json` 里 `roles.*.quotaPatterns`，
 * 读不到就用 `usage_limit_reached`、`session limit`、`usage limit`、`rate limit` 几条兜底）。
 * 只打印「回没回」，不打印任何凭据、不打印账户名；临时目录整个遮掉。
 *
 * 退出码：0 = 至少一家可用；1 = 两家都不可用；2 = 找不到命令行。
 *
 * 周四要用的那条：额度回了就跑
 *   node scripts/codex-review.mjs L18
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'ixa-quota-'));
const mask = (s) => String(s).split(work).join('<临时>').split(homedir()).join('<本机>');
const log = (...a) => console.log(...a.map(mask));

/** 数据目录：`IXAEON_RELAY_DIR` 优先，否则 `~/.ixaeon/relay`（和 datadir.ts 一个规矩）。 */
function dataDir() {
  const env = process.env.IXAEON_RELAY_DIR?.trim();
  return env ? resolve(env) : join(homedir(), '.ixaeon', 'relay');
}

/** 配置里的字样匹配不到真句子的兜底：Codex/Claude 报额度用的是自然语句，不是代码里的常量。 */
const ALWAYS = ['usage limit', 'rate limit', 'session limit', 'quota exceeded'];

/** 从配置里取 quotaPatterns（只读这两个字段，别的不碰也不打印）。 */
function patterns() {
  try {
    const cfg = JSON.parse(readFileSync(join(dataDir(), 'config.json'), 'utf8'));
    const out = [];
    for (const role of ['integrator', 'developer']) {
      const p = cfg?.roles?.[role]?.quotaPatterns;
      if (Array.isArray(p)) out.push(...p.filter((x) => typeof x === 'string'));
    }
    return [...new Set([...out, ...ALWAYS])];
  } catch {
    return ALWAYS;
  }
}

const hitQuota = (text, pats) => pats.some((p) => text.toLowerCase().includes(p.toLowerCase()));

/** 找 Codex 命令行（照 executor 的找法：IXAEON_CODEX_EXE 优先，否则 bin 下取版本最大的）。 */
function findCodex() {
  const pinned = process.env.IXAEON_CODEX_EXE?.trim();
  if (pinned === 'none') return null;
  if (pinned) return existsSync(pinned) ? pinned : null;
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const base = join(local, 'OpenAI', 'Codex', 'bin');
  const cands = [];
  if (existsSync(join(base, 'codex.exe'))) cands.push(join(base, 'codex.exe'));
  try {
    for (const d of spawnSync('cmd', ['/c', 'dir', '/b', base], { encoding: 'utf8' }).stdout.split(
      '\n',
    )) {
      const name = d.trim();
      if (!name) continue;
      const p = join(base, name, 'codex.exe');
      if (existsSync(p)) cands.push(p);
    }
  } catch {
    /* 没有就没有 */
  }
  let best = null;
  let bestVer = null;
  for (const exe of cands) {
    const r = spawnSync(exe, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(r.stdout ?? ''));
    if (!m) continue;
    const rank = [Number(m[1]), Number(m[2]), Number(m[3])];
    const better =
      !bestVer ||
      rank[0] > bestVer[0] ||
      (rank[0] === bestVer[0] && rank[1] > bestVer[1]) ||
      (rank[0] === bestVer[0] && rank[1] === bestVer[1] && rank[2] > bestVer[2]);
    if (better) {
      best = exe;
      bestVer = rank;
    }
  }
  return best;
}

/** 找 Claude：CLAUDE_BIN → 调度器配置的 roles.integrator.argv[0]（L17 的同一套顺序）。 */
function findClaude() {
  const env = process.env.CLAUDE_BIN?.trim();
  if (env) return env;
  try {
    const cfg = JSON.parse(readFileSync(join(dataDir(), 'config.json'), 'utf8'));
    const argv0 = cfg?.roles?.integrator?.argv?.[0];
    if (typeof argv0 === 'string' && argv0.trim()) return argv0.trim();
  } catch {
    /* 读不到就当没有 */
  }
  const guess = join(
    process.env.APPDATA ?? homedir(),
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  return existsSync(guess) ? guess : null;
}

/** 起一个命令行；返回输出（stdout+stderr）与退出码。`.js`/`.mjs`/`.cjs` 用 node 起（替身/脚本用）。 */
function ask(bin, args, timeoutMs) {
  try {
    const opts = { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, cwd: work };
    const r = /\.(mjs|cjs|js)$/.test(bin)
      ? spawnSync(process.execPath, [bin, ...args], opts)
      : spawnSync(bin, args, opts);
    return { out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, code: r.status ?? null };
  } catch (err) {
    return { out: err instanceof Error ? err.message : String(err), code: null };
  }
}

const pats = patterns();
log(`== 额度自检（数据目录：${mask(dataDir())}）`);
log(`   判读用的字样：${pats.join(' / ')}`);

let available = 0;

// ---- Codex ----
const codex = findCodex();
if (!codex) {
  log('Codex：没找到命令行（跳过）');
} else {
  const outFile = join(work, 'codex-last.txt');
  const r = ask(
    codex,
    ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-o', outFile, '回答说一个字：在'],
    180_000,
  );
  if (hitQuota(r.out, pats)) {
    log('Codex：额度还没恢复');
  } else if (r.code === 0) {
    log('Codex：可以用 ✓');
    available += 1;
  } else {
    log(`Codex：没给出结论（退出码 ${String(r.code)}），最后几行：`);
    log(
      r.out
        .split('\n')
        .filter((l) => l.trim())
        .slice(-5)
        .map((l) => `     ${l.trim().slice(0, 120)}`)
        .join('\n'),
    );
  }
}

// ---- Claude ----
const claude = findClaude();
if (!claude) {
  log('Claude：没找到命令行（跳过）');
} else {
  const r = ask(
    claude,
    ['--restricted', '--tools', '', '--output-format', 'json', '-p', '回答说一个字：在'],
    180_000,
  );
  if (hitQuota(r.out, pats)) {
    log('Claude：额度还没恢复');
  } else if (r.code === 0) {
    log('Claude：可以用 ✓');
    available += 1;
  } else {
    log(`Claude：没给出结论（退出码 ${String(r.code)}）`);
  }
}

rmSync(work, { recursive: true, force: true });

if (process.argv.includes('--l18')) {
  log('');
  if (available > 0) {
    log('→ 额度有可用的了：L18 的审查可以跑');
    log('   cd <L18 的工作目录> && node scripts/codex-review.mjs L18');
  } else {
    log('→ 两家都还不行：L18 继续等（队列第 83 行「待审（Codex 额度）」）。');
  }
}

process.exitCode = available > 0 ? 0 : 1;

/**
 * L6 契约第 4 条：调度器替开发推送。
 *
 * 开发只提交、不推，在输出里写 `RELAY-PUSH <目录> <本地分支> <远端分支>`；这一棒跑完、核对之前，调度器
 * 用本机的登录态替它推。**先全部查一遍，有一条不过就一条都不推**；都过了按先后推，有一条失败就停。
 *
 * 只许推 `main` 和 `dev/` 开头的分支，只许从调度器所在仓库的工作目录里推，不加 `--force`、不删远端分支。
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findSharedCheckout, isInside } from './config.js';
import { fetchMain, git, waitBeforeRetry } from './git.js';
import type { PushRecord, RoleConfig } from './types.js';

export interface PushLine {
  dir: string;
  local: string;
  remote: string;
}

export interface PushResult {
  /** 真推过的（失败的那一条也记，后面的不推）。 */
  pushes: PushRecord[];
  /** 停下时写进 `stoppedReason` 的那句；没停下就是 null。 */
  stopReason: string | null;
}

/** `RELAY-PUSH` 后面剩下的整段是目录（目录里可能有空格），最后两个词是本地分支、远端分支。 */
const LINE = /^RELAY-PUSH\s+(.+?)\s+(\S+)\s+(\S+)$/;

const parseLine = (line: string): PushLine | null => {
  const m = LINE.exec(line.trim());
  if (!m) return null;
  return { dir: m[1]!, local: m[2]!, remote: m[3]! };
};

/** 一段文字里所有 RELAY-PUSH 行（按出现次序）。 */
const linesIn = (text: string): PushLine[] => {
  const found: PushLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('RELAY-PUSH')) continue;
    const parsed = parseLine(line);
    if (parsed) found.push(parsed);
  }
  return found;
};

/**
 * 从命令行输出里收 `RELAY-PUSH` 行，认法照 `parseRoleOutput` 的 `RELAY-DONE`：
 * - 整行是 JSON 且 `result` 是字符串（Claude `--output-format json`）→ 在 result 里找；
 * - 整行是 JSON 且 `type` 为 `final`、`text` 是字符串（DSH `--json`）→ 在 text 里找；
 * - 其余按普通文字找。
 */
export function parsePushLines(stdout: string): PushLine[] {
  const found: PushLine[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line) as { result?: unknown; type?: unknown; text?: unknown };
        // 整合方改（2026-10-24）：只认 Claude 那一整行（type 是 result）。DSH 的 tool_result 也有 result 字段，
        // 第 12 棒 DSH 读了交代文件，里面那句格式说明被当成了一条推送，整个调度器停下。
        if (j.type === 'result' && typeof j.result === 'string') found.push(...linesIn(j.result));
        else if (j.type === 'final' && typeof j.text === 'string') found.push(...linesIn(j.text));
        continue;
      } catch {
        /* 不是 JSON 就当普通文字 */
      }
    }
    const parsed = parseLine(line);
    if (parsed && line.startsWith('RELAY-PUSH')) found.push(parsed);
  }
  return found;
}

/** 一棒的原样输出（runTurn 落在 `turns/<第几棒>/stdout.txt`）。 */
export const readTurnStdout = (stdoutPath: string): string => readFileSync(stdoutPath, 'utf8');

const normalize = (p: string): string => {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
};

/** `dir` 是不是调度器所在仓库的工作目录（`--git-common-dir` 和当前目录的是一个）。 */
const sameRepo = (dir: string, shared: string): boolean => {
  const out = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
  if (!out) return false;
  return normalize(dirname(out)) === normalize(shared);
};

/** `origin` 地址归一：去首尾空白、去末尾的 `/` 和 `.git`（再去一次 `/`），Windows 上不分大小写。 */
const normUrl = (url: string): string => {
  const u = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return process.platform === 'win32' ? u.toLowerCase() : u;
};

/**
 * L6b 契约第 2 条（新加的一条）：`dir` 的 `.git` 在这个角色的 `cwd` 里面，
 * **并且** `dir` 的 `origin` 和调度器所在仓库的 `origin` 是同一个地址。
 * 这样 DSH 自己的克隆（`<cwd>/repo`，`.git` 在它里面）也能代推。
 */
const ownRepoInCwd = (dir: string, roleCwd: string, shared: string): boolean => {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
  // 整合方改（2026-10-23）：git 给的是长路径，配置里的 cwd 可能是 RUNNER~1 这种短写法——两边都换成真实路径再比
  const real = (p: string): string => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };
  if (!common || !isInside(real(common), real(roleCwd))) return false;
  const mine = git(dir, ['remote', 'get-url', 'origin']).out;
  const theirs = git(shared, ['remote', 'get-url', 'origin']).out;
  if (!mine || !theirs) return false;
  return normUrl(mine) === normUrl(theirs);
};

/** 分支名里不许有 `+` `:` 空格，也不许以 `-` 开头（`+`/`:` 是 refspec 的写法，`-` 会被当成开关）。 */
const badName = (s: string): boolean => /[+:\s]/.test(s) || s.startsWith('-');

/** `dir` 里当前检出的分支；detached 时 git 给的是 `HEAD`。 */
const checkedOut = (dir: string): string => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;

/** 一条 push 最多试 3 次（L13b 契约第 2 条）：第 1 次失败后等 2 秒、再失败等 5 秒。 */
const PUSH_ATTEMPTS = 3;

/** 推一条 refspec，失败了照 `fetchMain` 那组等待重试，最多 3 次；3 次都失败回 false。 */
async function pushWithRetry(dir: string, refspec: string): Promise<boolean> {
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    // 不加 --force：main 不是快进时 git 自己会拒；也不带 + 前缀。
    if (git(dir, ['push', 'origin', refspec], 300_000).code === 0) return true;
    if (attempt < PUSH_ATTEMPTS) await waitBeforeRetry(attempt);
  }
  return false;
}

/**
 * L13：推 `main` 被拒（别人先推过、不是快进）时，在 `dir` 里先 rebase 到最新的 `origin/main`，再推一次。
 * 只碰 `dir`，不加 `--force`、不带 `+`；rebase 冲突时 `--abort`，不留没做完的 rebase。
 * 返回 `rebased`：rebase 成没成；`ok`：第二次推上去没有。fetch 失败就不试 rebase（免得拿旧的 FETCH_HEAD）。
 * L13b：fetch 改用 `fetchMain`（同样的 2 秒 / 5 秒重试），rebase 加 `--rebase-merges` 保留合并提交，
 * 第二次推也照 `pushWithRetry` 重试 3 次。
 */
async function rebaseThenPush(dir: string, local: string): Promise<{ rebased: boolean; ok: boolean }> {
  if (!(await fetchMain(dir))) return { rebased: false, ok: false };
  if (git(dir, ['rebase', '--rebase-merges', 'FETCH_HEAD'], 300_000).code !== 0) {
    git(dir, ['rebase', '--abort'], 300_000);
    return { rebased: false, ok: false };
  }
  return { rebased: true, ok: await pushWithRetry(dir, `${local}:refs/heads/main`) };
}

/** 目录这一道：在这个角色的 cwd 里面、是同一个仓库（或它自己的克隆）、不是开关写法。 */
function dirReason(dir: string, roleCwd: string, shared: string): string | null {
  if (!isInside(dir, roleCwd)) return `${dir} 不在这个角色的 cwd（${roleCwd}）里面`;
  if (dir.trim().startsWith('-')) return `目录不能用开关的写法：${dir}`;
  if (sameRepo(dir, shared)) return null;
  if (ownRepoInCwd(dir, roleCwd, shared)) return null;
  return `${dir} 既不是调度器所在仓库的工作目录，origin 也和它不一样`;
}

function lineReason(line: PushLine, roleCwd: string, shared: string): string | null {
  const dirBad = dirReason(line.dir, roleCwd, shared);
  if (dirBad) return dirBad;
  if (line.remote !== 'main' && !line.remote.startsWith('dev/')) {
    return `远端分支只能是 main 或者以 dev/ 开头：${line.remote}`;
  }
  if (badName(line.local)) return `本地分支名里不能有 + : 空格，也不能以 - 开头：${line.local}`;
  if (badName(line.remote)) return `远端分支名里不能有 + : 空格，也不能以 - 开头：${line.remote}`;
  return null;
}

/**
 * 替这一棒推。`shared` 是调度器所在仓库（照当前目录算的 `findSharedCheckout()`）。
 * 有一条不过 → `pushes` 空、`stopReason` 写「第 N 棒替开发推送被拒：<原因>」；
 * 推的时候有一条失败 → 停下、「第 N 棒替开发推送失败：<远端分支>」，后面的不推。
 * L13b：每一次推都最多试 3 次（2 秒 / 5 秒），所以这个函数是 async 的。
 */
export async function relayPushes(
  lines: PushLine[],
  role: RoleConfig,
  turnNumber: number,
  shared = findSharedCheckout(),
): Promise<PushResult> {
  for (const line of lines) {
    const bad = lineReason(line, role.cwd, shared);
    if (bad) return { pushes: [], stopReason: `第 ${turnNumber} 棒替开发推送被拒：${bad}` };
  }
  const pushes: PushRecord[] = [];
  for (const line of lines) {
    // L13b：推一条失败后隔 2 秒、再隔 5 秒重推，第 3 次还失败才算失败。
    let ok = await pushWithRetry(line.dir, `${line.local}:refs/heads/${line.remote}`);
    let rebased = false;
    // L13：只对 main 重试，而且 `local` 得就是这个目录里检出的分支（或 HEAD），不能动别人检出的东西。
    if (
      !ok &&
      line.remote === 'main' &&
      (line.local === 'HEAD' || line.local === checkedOut(line.dir))
    ) {
      const retry = await rebaseThenPush(line.dir, line.local);
      ok = retry.ok;
      rebased = retry.rebased;
    }
    pushes.push({
      dir: line.dir,
      local: line.local,
      remote: line.remote,
      ok,
      ...(rebased ? { rebased: true } : {}),
    });
    if (!ok) {
      return { pushes, stopReason: `第 ${turnNumber} 棒替开发推送失败：${line.remote}` };
    }
  }
  return { pushes, stopReason: null };
}

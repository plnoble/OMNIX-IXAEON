/**
 * L6 契约第 4 条：调度器替开发推送。
 *
 * 开发只提交、不推，在输出里写 `RELAY-PUSH <目录> <本地分支> <远端分支>`；这一棒跑完、核对之前，调度器
 * 用本机的登录态替它推。**先全部查一遍，有一条不过就一条都不推**；都过了按先后推，有一条失败就停。
 *
 * 只许推 `main` 和 `dev/` 开头的分支，只许从调度器所在仓库的工作目录里推，不加 `--force`、不删远端分支。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findSharedCheckout, isInside } from './config.js';
import { git } from './git.js';
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
        if (typeof j.result === 'string') found.push(...linesIn(j.result));
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
  if (!common || !isInside(common, roleCwd)) return false;
  const mine = git(dir, ['remote', 'get-url', 'origin']).out;
  const theirs = git(shared, ['remote', 'get-url', 'origin']).out;
  if (!mine || !theirs) return false;
  return normUrl(mine) === normUrl(theirs);
};

/** 分支名里不许有 `+` `:` 空格，也不许以 `-` 开头（`+`/`:` 是 refspec 的写法，`-` 会被当成开关）。 */
const badName = (s: string): boolean => /[+:\s]/.test(s) || s.startsWith('-');

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
 */
export function relayPushes(
  lines: PushLine[],
  role: RoleConfig,
  turnNumber: number,
  shared = findSharedCheckout(),
): PushResult {
  for (const line of lines) {
    const bad = lineReason(line, role.cwd, shared);
    if (bad) return { pushes: [], stopReason: `第 ${turnNumber} 棒替开发推送被拒：${bad}` };
  }
  const pushes: PushRecord[] = [];
  for (const line of lines) {
    // 不加 --force：main 不是快进时 git 自己会拒；也不带 + 前缀。
    const r = git(line.dir, ['push', 'origin', `${line.local}:refs/heads/${line.remote}`], 300_000);
    pushes.push({ dir: line.dir, local: line.local, remote: line.remote, ok: r.code === 0 });
    if (r.code !== 0) {
      return { pushes, stopReason: `第 ${turnNumber} 棒替开发推送失败：${line.remote}` };
    }
  }
  return { pushes, stopReason: null };
}

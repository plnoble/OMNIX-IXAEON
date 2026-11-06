/**
 * T1：整台机器一把 verify 锁（同一时间只跑一个完整 verify）。
 *
 * 锁文件里只写 { pid, startedAt }，不写工作目录（路径里有账户名）。
 * 拿锁用独占创建（openSync 'wx'）；拿不到按轮询等；锁里的 pid 已经不在或内容读不懂就接手。
 */
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PATH = join(tmpdir(), 'ixaeon-verify.lock');
const DEFAULT_POLL_MS = 10_000;
const DEFAULT_MAX_WAIT_MS = 60 * 60_000;

function readHolder(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

/** 对方进程还在吗：ESRCH 表示不在；EPERM 表示在（只是没权限）。 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/** 锁文件多大；读不到当作有内容。 */
function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/** 锁文件建了多久（毫秒）；读不到当作很久以前。 */
function ageMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function hhmm(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—:—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 拿锁。拿不到且不等待时返回 { busy, holder }；等到 maxWaitMs 仍是 busy 也返回它。
 */
export async function acquireVerifyLock(opts = {}) {
  const path = opts.path ?? DEFAULT_PATH;
  const wait = opts.wait !== false;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const log = opts.log ?? ((line) => console.log(line));
  const started = Date.now();
  let lastLogAt = 0;
  let tookOver = false;

  const create = () => {
    const fd = openSync(path, 'wx');
    const holder = { pid: process.pid, startedAt: new Date().toISOString() };
    try {
      writeSync(fd, JSON.stringify(holder));
    } finally {
      closeSync(fd);
    }
    return {
      release: () => {
        const cur = readHolder(path);
        if (!cur || cur.pid !== process.pid) return;
        try {
          unlinkSync(path);
        } catch {
          /* 已经没了 */
        }
      },
    };
  };

  for (;;) {
    let got = null;
    try {
      got = create();
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (got) {
      if (tookOver) log('上一次 verify 留下的锁已失效，接手');
      return got;
    }
    const holder = readHolder(path);
    // 整合方 11-06：锁文件是空的、且 5 秒内刚建——对方刚 open 还没写进去，先当它活着，免得两份都拿到锁。
    // 有内容但读不懂的照规格条件 4 马上接手。
    const fresh = holder === null && sizeOf(path) === 0 && ageMs(path) < 5_000;
    const stale = !fresh && (holder === null || !alive(holder.pid));
    if (stale) {
      try {
        unlinkSync(path);
      } catch {
        /* 别人已经删了 */
      }
      tookOver = true;
      continue;
    }
    if (!wait) return { busy: true, holder };
    if (Date.now() - started >= maxWaitMs) return { busy: true, holder };
    if (Date.now() - lastLogAt >= 60_000) {
      lastLogAt = Date.now();
      log(
        holder
          ? `另一次 verify 正在跑（进程 ${holder.pid}，${hhmm(holder.startedAt)} 开始），等它跑完`
          : '另一次 verify 刚开始，等它跑完',
      );
    }
    await sleep(pollMs);
  }
}

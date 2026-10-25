import { spawnSync } from 'node:child_process';

/** 回环地址不该走代理：这台机器的全局 git 配了 http.proxy，连 127.0.0.1 也走它，死地址会拖十几秒。 */
const isLoopback = (url: string): boolean =>
  /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url.trim());

/**
 * 原样跑一条 git（**不 trim**）：`git show :1:docs/委派/队列.md` 这种要保留末尾换行和 CRLF，
 * 交给 `mergeQueue` 才比得准、写回去才不变样。
 */
export function gitRaw(
  cwd: string,
  args: string[],
  timeout = 120_000,
  extraEnv: Record<string, string> = {},
): { code: number; out: string } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    // 后台跑：git 不许停下来问凭据（问也没人答）；回环地址不走代理
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
      ...extraEnv,
    },
  });
  return { code: r.status ?? 1, out: r.stdout ?? '' };
}

/** 只读地跑一条 git（调度器不改仓库：不 checkout、不 pull）。 */
export function git(
  cwd: string,
  args: string[],
  timeout = 120_000,
  extraEnv: Record<string, string> = {},
): { code: number; out: string } {
  const r = gitRaw(cwd, args, timeout, extraEnv);
  return { code: r.code, out: r.out.trim() };
}

/** 这台机器上 git 连 GitHub 隔三差五握手失败（L2 契约第 2 条）：第 1 次重试前等 2 秒、第 2 次前等 5 秒。 */
const waits = [2_000, 5_000];

/**
 * 第 `attempt` 次重试（从 1 数起）之前等多久。`fetchMain` 和 L13b 的推送重试用同一组等待，
 * 不各写一份。
 */
export async function waitBeforeRetry(attempt: number): Promise<void> {
  await new Promise((r) => setTimeout(r, waits[Math.min(attempt, waits.length) - 1]));
}

/**
 * 这台机器上 `git fetch` 隔三差五握手失败（L2 契约第 2 条）：隔 2 秒、再隔 5 秒重试，三次都失败回 false。
 * 只拉 main（队列和核对都只看 origin/main）；远端是回环地址时绕开代理。
 */
export async function fetchMain(cwd: string): Promise<boolean> {
  const remote = git(cwd, ['remote', 'get-url', 'origin']).out;
  const bypass = isLoopback(remote) ? ['-c', 'http.proxy=', '-c', 'https.proxy='] : [];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await waitBeforeRetry(attempt);
    if (git(cwd, [...bypass, 'fetch', 'origin', 'main']).code === 0) return true;
  }
  return false;
}

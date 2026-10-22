import { spawnSync } from 'node:child_process';

/** 回环地址不该走代理：这台机器的全局 git 配了 http.proxy，连 127.0.0.1 也走它，死地址会拖十几秒。 */
const isLoopback = (url: string): boolean =>
  /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url.trim());

/** 只读地跑一条 git（调度器不改仓库：不 checkout、不 pull）。 */
export function git(cwd: string, args: string[], timeout = 120_000): { code: number; out: string } {
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
    },
  });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim() };
}

/**
 * 这台机器上 `git fetch` 隔三差五握手失败（L2 契约第 2 条）：隔 2 秒、再隔 5 秒重试，三次都失败回 false。
 * 只拉 main（队列和核对都只看 origin/main）；远端是回环地址时绕开代理。
 */
export async function fetchMain(cwd: string): Promise<boolean> {
  const waits = [2_000, 5_000];
  const remote = git(cwd, ['remote', 'get-url', 'origin']).out;
  const bypass = isLoopback(remote) ? ['-c', 'http.proxy=', '-c', 'https.proxy='] : [];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, waits[attempt - 1]));
    if (git(cwd, [...bypass, 'fetch', 'origin', 'main']).code === 0) return true;
  }
  return false;
}

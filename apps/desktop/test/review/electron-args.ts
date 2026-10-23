/**
 * L14：接力里调度器起的 DSH 跑门禁时，界面那几步要起得来真 Electron。
 *
 * DSH 的受限令牌下 Chromium 的沙箱起不来（`electron.exe --version` 退出码 `0x80000003`，
 * 加 `--no-sandbox` 就正常）；门禁已经清掉了宿主带进来的 `ELECTRON_RUN_AS_NODE`，
 * 所以调度器起 DSH 时设 `IXAEON_ELECTRON_NO_SANDBOX=1`，界面用例通过这里把
 * `--no-sandbox` 放到参数最前面。
 *
 * **只影响测试里起的 Electron**：`IXAEON_ELECTRON_NO_SANDBOX` 只有调度器的启动器会设，
 * 应用自己的代码不读它，用户平时打开的 IXAEON 照旧带沙箱。
 */
export function electronArgs(args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return env.IXAEON_ELECTRON_NO_SANDBOX === '1' ? ['--no-sandbox', ...args] : args;
}

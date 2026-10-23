# 委派单 L14：接力里的 DSH 跑门禁时，界面那几步起得来 Electron

档位：**A**（只改测试怎么起 Electron，不改应用本身）。大小：小（约 40 行）。依赖：无。来源：接力第 7 棒（2026-10-23）：调度器起的 DSH 里，`electron.exe --version` 退出码 `0x80000003`，加 `--no-sandbox` 就好；整合方从普通环境起同一个 `electron.exe` 没事。所以 `node scripts/verify.mjs` 里四步「真实 Electron」的界面复审（`review-needs-lifecycle-ui`、`review-understanding-ui`、`review-sources-wizard-ui`、`review-recheck-ui`）在 DSH 那边跑不了，DSH 永远拿不到「verify 全过」。

## 要什么

调度器起 DSH 时多设一个环境变量 `IXAEON_ELECTRON_NO_SANDBOX=1`；门禁里这四套界面复审起 Electron 时，看到它就在参数最前面加 `--no-sandbox`，没有就和现在一模一样。只影响测试里起的 Electron，**不改应用自己的代码**（`apps/desktop/src` 不动），用户平常用的 IXAEON 照旧带沙箱。

## 契约

1. 新文件 `apps/desktop/test/review/electron-args.ts`，导出 `electronArgs(args: string[], env: NodeJS.ProcessEnv = process.env): string[]`：`env.IXAEON_ELECTRON_NO_SANDBOX === '1'` → `['--no-sandbox', ...args]`；否则原样返回 `args`（同一个数组内容，不加不减）。
2. 上面四套界面复审用到的 spec（照四个 `playwright.*.config.ts` 的 `testMatch`：`needs-lifecycle-ui-20260908`、`understanding-20260908`、`sources-20260908`、`wizard-20260908`、`project-audit-ui-20260906`、`recheck-ui-20260907` 里起 Electron 的地方）里，`electron.launch({ args: X, … })` 改成 `electron.launch({ args: electronArgs(X), … })`。别的不改。
3. `packages/relay/bin/dsh.mjs` 起 DSH 时的环境里加 `IXAEON_ELECTRON_NO_SANDBOX: '1'`（和 `GIT_CONFIG_PARAMETERS` 那几项放一起）。别的不变。

## 约束

- 先确认原因再改：在调度器起的 DSH 里（就是你现在这一棒）分别跑 `electron.exe --version` 和 `electron.exe --no-sandbox --version`，把退出码贴进交付说明。要是加了 `--no-sandbox` 也起不来、或者真正的原因不是沙箱，**停下**，把查到的写进交付说明、状态改「待复审（整合方）」，不要改应用代码绕过去。
- `apps/desktop/src` 不动；`scripts/verify.mjs` 不动；已锁定的验收测试不改。

## 验收

- 新测试 `packages/relay/test/acceptance/l14-electron-args.test.ts`（放这里是因为 `packages/*/test/acceptance/` 才进验收流程）：`electronArgs(['a', 'b'], {})` → `['a', 'b']`；`{ IXAEON_ELECTRON_NO_SANDBOX: '1' }` → `['--no-sandbox', 'a', 'b']`；值是 `'0'`、`'true'` → 原样；不改传进去的数组。再用 `l6-launcher.test.ts` 的假安装目录办法，测 `dsh.mjs` 起的进程环境里 `IXAEON_ELECTRON_NO_SANDBOX` 是 `1`。
- 真机：在这一棒里跑 `node scripts/verify.mjs`，那四步界面复审过了（输出原样贴进交付说明，遮掉用户目录）。别的步骤因为别的原因红了，照实写。
- `node scripts/acceptance.mjs lock L14 …` 登记；`node scripts/codex-review.mjs L14`；照 AGENTS.md 合并。

# MP3d 交付说明（拆分后第一支）：四个纯函数 / Claude Code 执行器 / 判定规则 / hashWorkspace

分支 `dev/MP3d`，基于 `dev/MP3c`。拆单原因：原 MP3d 源码 +418 行，超过 300 行，按规矩拆成 MP3d / MP3db 两支。

## 已实现

- `packages/core/src/execution/toolLaunch.ts`（新，约 160 行）：`claudeCodeLaunch` / `parseClaudeCodeOutput` / `dshLaunch` / `parseDshOutput` 四个纯函数（DSH 的 `env` 只多 `ELECTRON_RUN_AS_NODE=1`，不改传进来的 `baseEnv`；Claude 不带放开权限的开关）+ `ClaudeCodeExecutor`（`name: 'claude-code'`，argv 写死、不拼 shell、15 分钟超时、取消即杀）。
- `packages/core/src/models/fallbackRules.ts`（新）：`acceptableFallback` / `reasonText` 从桌面挪来并导出；`apps/desktop/src/main/modelFallback.ts` 改成引用 core（行为不变）。
- `packages/core/src/execution/executor.ts`：导出 `hashWorkspace`（用原来那份私有的，不另写）。
- `packages/core/src/index.ts`：导出上述。

## 自动化通过

```
$ node scripts/acceptance.mjs run MP3d   # 拆分后只归本支 mp3d-launch-pure
Tests  5 passed (5)
```

`tsc -p tsconfig.json --noEmit` 0。

## 真机通过

本支只有纯函数与执行器骨架，真机检查（假程序跑一串）在 MP3db 的 `scripts/real/mp3d-coding-chain.mjs` 里做，见 MP3db.md。

## 已知缺口

- `mp3d-chain-executor` / `mp3d-coding-chain` 两份测试归 MP3db，本支上没有实现，红是预期的。

四项：已实现=上面三处；自动化通过=5/5；真机通过=见 MP3db；用户接受=未接受。

## 照 11-06 复审改了什么（第 1、2、3 条 Claude Code 部分）

- `ClaudeCodeExecutor`（以及同文件的 `DshExecutor`，MP3db 接线要用）改用 `minimalChildEnv()`，只额外补 `APPDATA` / `LOCALAPPDATA`；
- 失败不再抛，返回 `claimedSuccess:false` 的回报：`summary` 一句人话，`raw` 带 stdout/stderr 各末约 4000 字（候选串据此看到 `usage_limit_reached` 才知道换）；
- `spawn` 用 `stdio: ['ignore','pipe','pipe']`、`shell:false`；取消/超时用导出的 `killProcessTree` 杀整棵进程树；超时用 `task.timeout_ms`（默认 15 分钟）；
- 回报按 `ExecutorReport` 字段写，去掉 `changes: []` 与 `as unknown`；
- `executor.ts` 导出 `minimalChildEnv` / `killProcessTree`。

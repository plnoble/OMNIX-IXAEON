# MP3d 交付说明：编码任务一串候选 + Claude Code

分支 `dev/MP3d`（基于 `dev/MP3c`）。

## 已实现

- `packages/core/src/execution/codingChain.ts`（新）：`CodingCandidate = { key, label, executor | null }`、`CodingChainExecutor(candidates, { skip, now? })`。
  - 顺序按 5 分钟冷却重排（不删）；`executor: null` 直接跳过、不算失败；
  - 每次试前后比 `hashWorkspace(workspace)`（不算自建报告通道文件）：工作区改过就不换、照失败抛出；
  - 额度错误（抛出的信息或失败回报的 `raw` 里有 `usage_limit_reached` 等）→ 换；`ModelError` 按 `acceptableFallback` / `reasonText` 判（401/403、402/429、5xx 换，400 不换）；用户取消（signal 已中止）不换；
  - 换过之后成功：`summary` 以「「甲」这次不行（原因），由替补「乙」来做」开头；`name` 在 run 前是第一个可用执行器、run 后是实际做完的那个；
  - 都不行：抛错写明「试过的候选：「甲」：原因；…」，最后一项不管因为什么都写进去。
- `packages/core/src/execution/toolLaunch.ts`（新）：四个纯函数 `claudeCodeLaunch` / `parseClaudeCodeOutput` / `dshLaunch` / `parseDshOutput`（DSH 的 `env` 只多 `ELECTRON_RUN_AS_NODE=1`，不改传进来的 `baseEnv`）；`ClaudeCodeExecutor`（`name: 'claude-code'`，argv 写死、不拼 shell、15 分钟超时、取消即杀）。
- `packages/core/src/execution/executor.ts`：导出 `hashWorkspace`；`CodexCliExecutor` 之后写执行器名字改成在 `run` 结束（成功 / 失败 / 待验证）时写 `this.executor.name`（原来只写开工时那个）。
- `packages/core/src/models/fallbackRules.ts`（新）：`acceptableFallback` / `reasonText` 从桌面挪到这里并导出；`apps/desktop/src/main/modelFallback.ts` 改成引用 core（行为不变）。
- `packages/core/src/index.ts` 导出以上；`packages/contracts`：`config.codingChain`（最多 5 项、tool/provider 两种）与 `saveCodingChain(list)` IPC；`appRuntime.saveCodingChain`（>5 拒绝、重复拒绝、Codex/DSH 填模型拒绝、Claude 只收 opus/sonnet/haiku、供应商项必须是保存过的模型、空数组清空、审计只记项数）；`ipc.ts` / `preload` 注册。

## 自动化通过

```
$ node scripts/acceptance.mjs run MP3d
Test Files  3 passed (3)
Tests  25 passed (25)
```

`tsc -p tsconfig.json --noEmit` 0。

## 真机通过

**没跑**：`scripts/real/mp3d-coding-chain.mjs`（假 Codex / 假 Claude Code 用 csc 现编 `.exe`，跑「Codex → Claude Code」与「Codex → DSH」两串）本轮时间用尽，没有写、没有跑。按规矩「没跑的不能合并」，这一单在真机补齐前请先不要并入。

## 已知缺口

- 编排层把 `codingChain` 接进 `executorPlan()`（存过就按候选串选执行器）只做了「保存/读回」，派发时的候选串接线还没接上；MP3d 锁定测试没有覆盖这条，MP3e 的端到端依赖它，下一轮先接这条再做 MP3e。
- MP3e（DSH 执行器、编码任务主选+替补界面、端到端）未开始。

四项：已实现=上面这些；自动化通过=25/25；真机通过=没跑；用户接受=未接受。

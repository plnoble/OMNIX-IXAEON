# MP3db 交付说明（拆分后第二支）：编码候选串 + 派发接线

分支 `dev/MP3db`，基于 `dev/MP3d`。

## 已实现

- `packages/core/src/execution/codingChain.ts`（新，约 150 行）：`CodingCandidate` / `CodingChainExecutor(candidates, { skip, now? })`。
  - 5 分钟冷却只重排不删；`executor: null` 跳过不算失败；每次试前后比 `hashWorkspace`，工作区改过不换；
  - 额度（抛出信息或失败回报 `raw` 里含 `usage_limit_reached` 等）→ 换；`ModelError` 按 `acceptableFallback`/`reasonText` 判；取消（signal 已中止）不换；
  - 换过才在成功回报前加「「甲」这次不行（原因），由替补「乙」来做」；`name` run 前是第一个可用、run 后是实际做完的；
  - 都不行抛错写明试过哪几项、各自原因（最后一项不管因为什么都写进去）。
- `packages/contracts`：`config.codingChain`（≤5 项、tool/provider 两种）、`saveCodingChain(list)` IPC；`ipc.ts`/`preload` 注册。
- `apps/desktop/src/main/appRuntime.ts`：
  - `saveCodingChain`（>5 拒绝、重复拒绝、Codex/DSH 填模型拒绝、Claude 只收 opus/sonnet/haiku、供应商项必须是保存过的模型、空数组清空、审计只记项数）；
  - `codingChainSkip`（运行时持有的 Map）+ `clearCodingChainSkip()`，在 `saveCodingChain` / `saveModelProvider` / `saveDevToolPath` 时清空；
  - `codingCandidates()`：按 `codingChain` 顺序，工具类用 `detectDevTools` 的位置建 Codex / Claude 执行器、没找到给 null；供应商类按那家那个模型建「我的模型」执行器、解析不出给 null；
  - `executorPlan()`：存过 `codingChain` 就返回包着 `CodingChainExecutor` 的 model 执行器；没存过照旧。
  - `CodexCliExecutor` 在 `run` 结束（成功 / 失败 / 待验证）时再写一次实际执行器名字（原来只写开工时那个）。

## 自动化通过

```
$ node scripts/acceptance.mjs run MP3d
Test Files  3 passed (3)
Tests  25 passed (25)
```

`tsc -p tsconfig.json --noEmit` 0。（本支承担 `mp3d-chain-executor` 12 条 + `mp3d-coding-chain` 8 条 + `mp3d-launch-pure` 5 条。）

## 真机通过（假程序，csc 现编 .exe，不跑真的三个工具）

`node scripts/real/run-batch.mjs scripts/real/mp3d-coding-chain.ts`：

```
谁做的： claude-code
换了几次： 1
那一句提示： 「Codex」这次不行（额度用完），由替补「Claude Code · sonnet」来做；<假程序写文件时打的中文乱码>
```

（最后一段是假 exe 控制台输出的编码问题，链路与提示句本身正确；临时目录已整段遮成 `<临时目录>`。假 Codex 只打 `usage_limit_reached` 并退出 1，假 Claude 写 `note.txt` 并输出 JSON。）

## 已知缺口

- 真机只跑了「Codex → Claude Code」一串；「Codex → DSH」要等 MP3e 的 DSH 执行器。

四项：已实现=上面；自动化通过=25/25；真机通过=上面输出；用户接受=未接受。

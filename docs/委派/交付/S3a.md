# S3a 编码代理会话选择导入（核心）交付

- 分支：grok/S3a，基于 main `20c63a2`；档位 B（**先只交测试**）
- 执行方：Grok

## 已实现

未实现。本单按 v2 B 档先把规格 7 条验收条件写成测试，等整合方看过并锁定后再写代码。

测试假设的核心入口（实现时用这些名字，或改测试由整合方决定）：

- `ImportService.previewAgentSessions(dir)`
- `ImportService.estimateAgentSessions(dir, ids)`
- `ImportService.importSelectedAgentSessions(dir, ids, { permissionId, projectId })`
- `AppRuntime.listAgentSessions / estimateAgentSessions / importAgentSessions`（IPC，渲染层只传 ticket / listId / ids）

## 验收测试（v2 规格任务）

| 文件                                                             | 条件             |
| ---------------------------------------------------------------- | ---------------- |
| `packages/core/test/acceptance/s3a-agent-session-select.test.ts` | 1、2、3、4、6、7 |
| `apps/desktop/test/acceptance/s3a-ipc-list.test.ts`              | 5                |

当前 7 条全红（方法还不存在），这是预期。未跑 `acceptance.mjs lock`（B 档由整合方锁定）。

## 自动化通过

- `node scripts/acceptance.mjs run S3a`：未登记，未跑
- `node scripts/verify.mjs`：待推送前跑（验收测试不进日常 unit/integration）
- GitHub 上的 verify：没看

## 真机通过

规格要求的真机检查在实现阶段跑。本阶段没跑。

## Codex 审查（A 档）

B 档，不跑 Codex。等整合方复审测试。

## 已知缺口

- 条件 5 目前覆盖「编造的清单号」。过期清单、编号不在本次清单里，实现 IPC 后应仍被同一拒绝路径打到；若整合方要求测试里先 list 再传错号，再补。
- 条件 7 断言列出时不对 `big.jsonl` 调用无范围的 `readFileSync`（应只读开头 20 行和末尾 256KB）。
- 测试里核心方法挂在 `ImportService` 上；若实现放在别的模块，需要整合方改测试或实现迁就测试。

## 整合方审核测试（2026-09-19）

规格 7 条都有对应测试。核心挂在 `ImportService.previewAgentSessions` / `estimateAgentSessions` / `importSelectedAgentSessions`，IPC 三个方法名与规格一致。条件 5 目前只打「编造清单号」，过期清单与「编号不在本次清单」实现时走同一 `VALIDATION_FAILED` 即可；不放宽。条件 7 禁 `readFileSync` 整份读 20MB 文件。已锁定指纹。实现阶段按这些名字接线，不要改测试。

## 用户接受

未发生。

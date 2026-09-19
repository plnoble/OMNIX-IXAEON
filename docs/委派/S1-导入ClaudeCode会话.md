# 委派单 S1：导入 Claude Code 的会话记录

任务来源：[三周任务单](../三周任务单.md)「用户的目标场景」场景一第一步。档位：**A**。大小：中（≤300 行）。依赖：无。

## 背景

场景一：IXAEON 要理解你想开发什么、做到哪了，然后指挥编码代理干活。第一步是让它读到你和编码代理的对话。Claude Code 把每个会话存成 `~/.claude/projects/<目录名>/<会话 id>.jsonl`，一行一个 JSON。这一单把它导成「编码代理」来源（provider `coding_agent`，数据库已允许），走现有的提炼管线。S2 接着做 Codex，复用这里的导入通道。

## 契约（写死，照着实现，不改名）

1. 新文件 `packages/core/src/import/agentSessions.ts`，从 `packages/core/src/index.ts` 导出：

   ```ts
   export function detectAgentSession(lines: string[]): 'claude_code' | 'codex' | null;
   export function parseClaudeCodeSession(
     lines: Iterable<string>,
     opts?: { accountNamespace?: string },
   ): ParsedSource | null;
   ```

   - `ParsedSource['provider']` 的联合类型加上 `'coding_agent'`。
   - `detectAgentSession`：有一行带字符串 `sessionId` 和 `type` 的 → `'claude_code'`（S2 再加 `'codex'`）；都不像 → `null`。不是 JSON 的行跳过。
   - 解析规则（锁定的测试就是这些规则的例子）：
     - 用户说的话：`type:'user'` 且内容是字符串或 `text` 块的行。去掉 `<system-reminder>…</system-reminder>`。以 `<command-name>`、`<command-message>`、`<local-command-stdout>`、`<local-command-caveat>` 开头的是命令包装，整行跳过。
     - 只有 `tool_result` 的用户行（工具输出，可能有文件内容、密钥）整行不导，**也不打断**正在累积的回答。
     - `isSidechain: true`（子代理）的行不导；`thinking` 块不导。
     - 回答：从一条用户消息之后到下一条用户消息之前的所有 assistant 行并成一段——`text` 块用空行连起来，末尾再空一行加「〔工具：A、B〕」（本段用过的 `tool_use` 名字去重、按出现顺序）；没有文字只有工具的就只有这一行。
     - 段号 `sequence` 从 0 连续；`externalNodeId` 取这一段第一行的 `uuid`，`occurredAt` 取它的 `timestamp`。
     - 标题：`custom-title` 行的 `customTitle` > `ai-title` 行的 `aiTitle` > 第一句用户的话（最长 80 字）。
     - 来源：`kind 'conversation'`、`provider 'coding_agent'`、`externalId` = `sessionId`、`importMethod 'history_export'`、`metadata = { tool: 'claude_code', cwd, gitBranch }`；没有任何一段 → 返回 `null`。

2. `ImportService.importFile` 处理 `.jsonl`：
   - **逐块读、逐行解析**（`fs.openSync` / `readSync` 自己切行），不许把整个文件读成一个字符串——本机有超过 512MB 的会话文件（Codex 的），V8 字符串装不下。`.jsonl` 不受 10MB 普通文件上限约束（上限 2GB）。
   - 用前 20 个非空行 `detectAgentSession`；认不出 → `IxaError(UNSUPPORTED_FORMAT)`，消息含「不认识的 .jsonl 格式」。解析结果为 `null` → `IxaError(VALIDATION_FAILED)`「这个会话里没有对话内容」。
   - 存进 vault 的是**保留下来的内容**（每段一行「角色: 文本」），不是原始文件——工具输出是故意不留的。
   - 导入时没选项目（`projectId` 为 null）、会话的 `cwd` 与某个项目的 `root_path` 是同一个目录（规范化后比较，Windows 不分大小写、正反斜杠等价）→ 归到那个项目。
   - 去重沿用现有 `insertParsed`（内容指纹）。
3. 文件夹导入：`.jsonl` 进白名单；单个文件失败照旧列进 `failed`（带上面的消息）。

## 验收（锁定，执行方不改）

- `node scripts/acceptance.mjs run S1` 全过（`packages/core/test/acceptance/s1-claude-code-import.test.ts`）；
- `node scripts/verify.mjs` 全过；
- 真机：用**合成**的会话文件在临时数据目录里导一次，描述结果。**不要导入用户真实的会话**——导入后会自动分析、发给模型，那是用户的决定。

## 不要做

- 不导工具输出、思考、子代理；不加迁移；
- 不改提炼规则（导进来的会话按现有规则提炼：你的话算你的，AI 的回答记成 AI 建议）；
- 不改锁定的验收测试。

## 交付

改动文件与行数；验收与 verify 的输出；真机描述；已知缺口。推送前先 rebase 到最新 main，**不要自己合并**。

## 并入时整合方补的（2026-09-19）

按本机真实会话的结构（只统计了字段与开头类别，没看内容）发现，Claude Code 会把不是你打的字也记成「用户」行，原规则会把它们当成你说的话去提炼。并入时补上，测试在 `packages/core/test/integration/agent-sessions.test.ts`：

- 带 `isMeta: true` 的行（技能展开、命令说明，本机 64 条）、带 `isCompactSummary: true` 的行（上下文压缩后 AI 写的摘要，24 条；原话在同一个文件前面）、带 `isApiErrorMessage: true` 的行（接口出错时合成的一句「回答」，55 条）：都不导，也不打断正在累积的回答；
- 以 `<task-notification>`（后台任务通知，87 条）、`[Request interrupted by user`（你按了停止，16 条）开头的用户行：整行跳过；
- 标题会反复写，改过名的以最后一次为准；
- 逐块读的切行改用 `indexOf`、只扫新读进来的部分（原来每读一块都从头扫，长行会越来越慢）；单行超过 64MB 的整行跳过（本机最长一行 5.7MB），不让一行无限攒进内存。

用改好的解析器在内存里过了一遍本机 13 个会话（不入库）：留下 1043 段，没有注入的内容混进「你说的话」。其中你说的约 10 万字，AI 的回答约 110 万字——导入后这些都会发给模型分析。

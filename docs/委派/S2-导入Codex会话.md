# 委派单 S2：导入 Codex 的会话记录

任务来源：[三周任务单](../三周任务单.md)「用户的目标场景」场景一第一步。档位：**A**。大小：小到中（≤200 行）。依赖：S1（`agentSessions.ts` 与 `.jsonl` 导入通道）。

## 背景

Codex 把会话存成 `~/.codex/sessions/年/月/日/rollout-*.jsonl`，一行一个 `{timestamp, type, payload}`。本机有超过 512MB 的会话文件，S1 的逐行读取通道必须用上。Codex 会把 AGENTS.md、环境说明等也塞成「用户消息」，Codex 自己派出去的子代理（如自动审查）也会留下会话——这些都不是你在聊。

## 契约（写死，照着实现，不改名）

1. `packages/core/src/import/agentSessions.ts` 增加并导出：

   ```ts
   export function parseCodexSession(
     lines: Iterable<string>,
     opts?: { accountNamespace?: string },
   ): ParsedSource | null;
   ```

   - `detectAgentSession`：有一行 `type === 'session_meta'` 且带 `payload` → `'codex'`（先于 Claude Code 的判断）。
   - 解析规则（锁定的测试就是这些规则的例子）：
     - `session_meta`：会话 id 取 `payload.id`（没有就 `payload.session_id`），`cwd`，分支取 `payload.git.branch`。`payload.source` 是对象且带 `subagent` → 整个会话返回 `null`。
     - `response_item` 且 `payload.type === 'message'`：
       - `role 'user'`：**逐段**看 `input_text`。一条消息常由好几段拼成，注入的内容和你的话可能在同一条里，不能先拼起来再看开头（2026-09-19 按本机真实会话的结构补）：
         - 以这些标签开头的段，去掉整个标签（到对应的闭合标签为止），后面剩下的话留下；标签可能带属性，没有闭合标签的整段去掉：`<environment_context>`、`<user_instructions>`、`<permissions instructions>`、`<recommended_plugins>`、`<turn_aborted>`、`<subagent_notification>`、`<send_user_message_question_reply>`、`<codex_internal_context …>`、`<in-app-browser-context …>`。它们是环境说明、注入的指令、插件推荐、中断记录、子代理通知、Codex 自己的目标提示、内置浏览器的状态（贴在你的话前面）；问答回复是选项的 JSON，离开问题看不懂；
         - 以 `# AGENTS.md instructions`、`<image`、`</image>` 开头的段整段丢掉（注入的指令、图片占位）；
         - 以 `# Files mentioned by the user` 开头的段（你在界面里带上了文件）：只留 `## My request for Codex:` 或 `## My request:` 后面的话，两个都没有就丢掉。去掉标签后剩下的话以这两个标记之一开头的（浏览器状态后面就是这样），也把标记去掉；
         - 留下的段去首尾空白，非空的用换行连起来。什么都没留下的消息整条跳过，**也不打断**正在累积的回答；
       - `role 'assistant'`：从一条（留下的）用户消息之后到下一条之前的所有回答并成一段。每条的 `output_text` 拼起来，条与条之间空一行；末尾再空一行加「〔工具：…〕」，列出这期间 `function_call` / `custom_tool_call` / `local_shell_call` 的名字（去重、按出现顺序）。没有文字只有工具的，就只有这一行；
       - `role 'developer'` / `'system'` 跳过。
     - `reasoning`、各种 `*_output`、`event_msg`、`turn_context`、`compacted`、用量记录：都不导。不是 JSON 的行跳过。
     - 段号 `sequence` 从 0 连续；`externalNodeId` 为 `null`（Codex 的记录没有逐条的 id）；`occurredAt` 取这一段第一条的 `timestamp`。
     - 标题：第一句用户的话（最长 80 字）。
     - 来源：`kind 'conversation'`、`provider 'coding_agent'`、`importMethod 'history_export'`、`metadata = { tool: 'codex', cwd, gitBranch }`；没有任何一段 → `null`。
   - 性能：本机最大的会话文件 1.5GB，大部分是工具输出。建议先用字符串判断跳过明显不要的行（比如不含 `"type":"message"`、`"session_meta"` 或 `_call"` 的），再 `JSON.parse`。导入在主进程同步跑，不要让它卡太久。

2. S1 的 `.jsonl` 导入通道（`ImportService` 里的 `importAgentSession`，逐行读用 `iterateJsonlLines`，不要另写一个）识别到 `'codex'` 时用 `parseCodexSession`。子代理会话（返回 `null` 且 `session_meta` 带 `subagent`）→ `IxaError(VALIDATION_FAILED)`，消息含「子代理」：「这是 Codex 派出去的子代理的会话（如自动审查），不导入」。

## 验收（锁定，执行方不改）

- `node scripts/acceptance.mjs run S2` 全过（`packages/core/test/acceptance/s2-codex-import.test.ts`）；
- `node scripts/verify.mjs` 全过；
- 真机：用**合成**的会话文件在临时数据目录里导一次，描述结果。不要导入用户真实的会话。

## 不要做

- 不导推理、工具输出、注入的指令与环境说明；不加迁移；
- 不改锁定的验收测试。

## 交付

改动文件与行数；验收与 verify 的输出；真机描述；已知缺口。推送前先 rebase 到最新 main，**不要自己合并**。

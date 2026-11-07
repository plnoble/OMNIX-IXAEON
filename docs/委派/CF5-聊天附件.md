# 规格 CF5：聊天附件（图片、文本文件随一问发给模型）

档位：**B**。把一类新数据（用户选的文件、图片）发给模型，是新的外发；要加迁移（附件表）；改了直连客户端发出去的消息格式。源码约 280 行，拆两支：

- **CF5**：core（附件表的读写、直连客户端发图片）+ 主进程（选文件、校验、进 vault、拼进这一问）；
- **CF5b**：界面（附件按钮、消息上的附件、缩略图）。

依赖：CF3 / CF3c（聊天只走直连）已并入。功能上不依赖 CF4，迁移编号排在 CF4 的 43 后面。**迁移 44 由整合方写**，写好并推到 main 之前，执行方只写测试。

来源：队列第 154 行「文件、图片进聊天（进 vault、按授权外发）」；用户 10-31 定的第 1 阶段先后（CF0 → CF1 → CF2 → CF3 → CF6 → CF4 → CF5）。产品分工（用户 11-03）：聊天对标 ChatGPT，ChatGPT 能直接贴图、传文件。

## 现在的样子

- 聊天输入框（`Ask.tsx` 的 `ask-composer`）只有项目下拉框、文本框、「发送」「取消」，没有附件。
- `askQuestionInputSchema` 只有 `conversationId`、`projectId`、`question`（最多 4000 字）。
- `messages` 表（迁移 26）只有正文和 `meta_json`，没有地方放文件；`meta_json` 是「渲染用元数据」，不放原件引用。
- 直连客户端的 `ChatMessage` 里 user 消息只有 `content: string`，`OpenAIChatStreamClient` 原样发成 `{ role, content }`，发不了图片。
- **能复用的**：
  - `Vault`（`packages/core/src/vault.ts`）：按 SHA-256 存原件，只增不改；
  - 主进程的文件选择和票据（`ipc.ts` 的 `pickFiles` / `issueTicket` / `consumeTicket`）：渲染层拿不到也报不了路径，只拿一次性票据；
  - `permissions.grantFile(path)`：对话框选中的文件建一条 `once` 授权，跟导入一样；
  - 导出（`archiveStore.listVaultFiles`）现在只导 `sources.raw_path` 引用到的 vault 文件。
- 导入（`ImportService.importFile`）是「把文件变成来源、排提炼」，跟附件不是一回事：附件不进来源，不提炼。

## 要什么

1. **选文件**：输入框旁加「附件」按钮。点了由主进程开系统对话框（可多选），新 IPC（写死，不改名）：
   ```ts
   pickChatAttachments(): Promise<{ ticket: string; files: Array<{ name: string; sizeBytes: number }> } | null>;
   // askQuestionInputSchema 加两个可选字段：
   attachmentTicket?: string;          // 上面那张票据，一次性，用过作废
   attachmentsFromMessageId?: string;  // 第 6 条：换模型重问时沿用那条用户消息的附件
   ```
   票据照 `issueTicket` / `consumeTicket` 那一套（新的 purpose `attachment`，5 分钟有效），返回给渲染层的只有文件名和大小，没有路径。测试钩子用 `IXAEON_TEST_DIALOG_RESPONSES` 的 `chatAttachment|…` 一段。输入框上方列出已选的附件，每个能单独去掉。拖文件进输入框、粘贴图片这一单不做：它们要渲染层先拿到路径或内容，跟「渲染层只拿票据」冲突，要做另开单。
2. **类型与大小**（写死，常量放 core，名字 `CHAT_ATTACHMENT_LIMITS`）：
   - 图片：`png`、`jpg` / `jpeg`、`webp`、`gif`，每张不超过 5 MB；按文件头判断类型，扩展名对不上文件头也算不支持。
   - 文本：`md`、`txt`、`json`、`csv`、`log`，每个不超过 1 MB，必须是 UTF-8（判断方法跟 `ImportService.readAuthorized` 一样）。
   - 一问最多 4 个附件。
   - 别的类型（pdf、docx、xlsx、zip、exe…）这一单不支持，说「不支持这种文件：<扩展名>，现在只收图片和文本文件」。
3. **存哪**：发送时主进程消费票据，逐个读文件、校验；全部通过后才落库：
   - 每个文件 `grantFile` 一条授权，原件 `vault.store`；
   - `message_attachments` 表记一行，挂在这一问的用户消息上；
   - 有一个不通过，整问不发：抛错（大小超了 `FILE_TOO_LARGE`，其余 `VALIDATION_FAILED`，文案写出是哪个文件、为什么），不落任何消息、不进 vault、不建授权。
4. **模型怎么看到**，只在带附件的那一问：
   - **文本**：拼在问题后面，格式写死：
     ```
     <问题原文>

     附件「<文件名>」：
     <<<
     <文件全文>
     >>>
     ```
     几个文本附件按选的顺序依次拼。存进 `messages.content` 的仍是用户打的原话，不含附件全文。
   - **图片**：这一问的 user 消息带上图片。`ChatMessage` 的 user 那一支加一个可选字段 `images?: Array<{ mime: string; base64: string }>`（这一单唯一改 CF3 契约的地方）。`OpenAIChatStreamClient` 遇到带 `images` 的 user 消息，发成 OpenAI 的分段格式：`content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:<mime>;base64,<...>' } }, ...]`。没有 `images` 的消息发法一个字不变。
   - **之后几轮**：`priorTurns` 里那条用户消息的正文后面加一行 `（附件：a.png、b.md，原件没有再发）`，不重发图片和文本全文。
   - 系统提示词一个字不改。
5. **问只带附件、没打字**：允许，问题按「（见附件）」处理；`question` 至少 1 个字的校验对带附件的问放宽成「问题或附件至少有一样」。
6. **失败怎么办**：
   - 网关拒了这一问（比如模型不收图片）：照现在的失败路径记成失败（A5），`errorMessage` 里有网关的状态码，并加一句「这一问带了图片，这个模型可能不支持图片，可以换一个模型重问」。不偷偷去掉图片重发。
   - **换模型重问**（CF0 的 `retryWithModel`）要带上原来的附件：传 `attachmentsFromMessageId`，主进程按那条用户消息的附件从 vault 读原件，照第 4 条拼；原件读不出来（vault 里没了）就报错，说哪个附件没了，不发。
7. **界面**：用户消息下面列出附件（文件名、大小）；图片显示缩略图，数据由新 IPC `getMessageAttachment(id): Promise<{ mime: string; base64: string }>` 给（只给图片；CSP 已允许 `img-src data:`）。
8. **记忆**：附件不进记忆。`captureAsk` 存档的提问是用户打的原话加一行 `（附件：<文件名…>）`，不含文本全文，不含图片。
9. **留痕**：每一问带了附件就记 `recordAudit(db, 'chat.attachments_sent', { count, images, texts, totalBytes, model })`：只记数量、字节数和模型名，不记文件名、不记内容。
10. **导出和删除**：
    - 导出包要带上附件原件：`listVaultFiles` 把 `message_attachments.content_hash` 引用到的也算进去；恢复照现在的办法把 vault 整个放回去。
    - 删对话时附件行随消息级联删除，vault 原件留着（vault 只增不改，跟来源一样）。

## 迁移 44（整合方写，执行方不动）

```sql
-- CF5：聊天附件。原件在 vault（按内容指纹），这里只记挂在哪条消息上、叫什么、多大、凭哪条授权读的。
CREATE TABLE message_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),            -- 在这条消息里的先后
  kind TEXT NOT NULL CHECK (kind IN ('image', 'text')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  created_at TEXT NOT NULL,
  UNIQUE (message_id, seq)
);
CREATE INDEX idx_message_attachments_message ON message_attachments(message_id, seq);
```

为什么另建表、不放 `meta_json`：一条消息可以挂多个附件；导出要按内容指纹找原件；授权要能追到是哪一条。`meta_json` 是给界面渲染用的，原件引用放进去，导出和删除都查不到。`name` 只存文件名，不存完整路径（路径里有本机账户名）。

## 约束

- 不写迁移；不改系统提示词和工具清单；附件不进记忆、不建来源、不排提炼。
- 渲染层拿不到文件路径，只拿票据。
- 只发给这一问实际回答的模型（含 MP3 的替补链里接手的那个），不发给别的服务。
- 不加 PDF、Office 解析，不做图片压缩或转码。

## 验收条件

测试用临时库、临时 vault、合成文件（`合成笔记.md` 内容「合成暗号：蓝鲸七号」；一张 1×1 的 png，用固定的 base64 写在测试里），替身直连客户端照 `mp3-chat.test.ts` 的办法。

1. **文本附件**：带 `合成笔记.md` 问「总结一下」：
   - 替身收到的最后一条 user 消息正文正好是第 4 条写死的格式（问题、文件名、`<<<`、全文、`>>>`）；
   - 库里这一问的 `messages.content` 是「总结一下」；
   - `message_attachments` 一行：`kind = 'text'`、`name = '合成笔记.md'`、`size_bytes` 对、`content_hash` 是文件的 SHA-256，vault 里有这份原件，`permission_id` 指向一条 `file` 授权。
2. **图片附件**：带 png 问「图里是什么」：
   - 替身收到的 user 消息 `images` 里有一张，`mime = 'image/png'`，`base64` 跟文件一致；
   - 用 `fetch` 替身测 `OpenAIChatStreamClient`：请求体里这条消息的 `content` 是数组，第一段 `type: 'text'`，第二段 `image_url.url` 以 `data:image/png;base64,` 开头；
   - 不带 `images` 的消息请求体跟改之前逐字节相同（拿 CF3 现有一份请求体做对照）。
3. **校验不过整问不发**，下面每种都抛错，消息表、`message_attachments`、`permissions` 行数和 vault 文件数都不变，替身客户端调用 0 次：
   - 6 MB 的 png（`FILE_TOO_LARGE`）；1.5 MB 的 txt（`FILE_TOO_LARGE`）；
   - 扩展名 `.png`、内容是文本（`VALIDATION_FAILED`）；
   - `.pdf`（文案含「不支持这种文件」）；
   - 非 UTF-8 的 `.txt`；
   - 5 个附件；
   - 一个合格、一个不合格：合格的那个也没进 vault。
4. **之后几轮**：带 `合成笔记.md` 问完一轮再问「刚才那份笔记里的暗号是什么」，第二问发给模型的上文里，第一问那条是「总结一下」加一行「（附件：合成笔记.md，原件没有再发）」，不含「蓝鲸七号」。
5. **只带附件**：问题为空、带一张图，能发；模型收到的正文是「（见附件）」。问题为空也没附件，照旧被拒。
6. **网关拒图**：替身返回 400，这一轮消息 `status = 'failed'`，`errorMessage` 含「400」和「可能不支持图片」；替身只被调了一次，没有不带图重发。
7. **换模型重问带上附件**：对第 6 条失败的那一轮用 `attachmentsFromMessageId` 重问，替身收到的 user 消息里有同一张图；新的用户消息上 `message_attachments` 也有一行，`content_hash` 跟原来的相同。把 vault 里那份原件删掉再重问：报错，文案含那个文件名，替身调用 0 次。
8. **不进记忆**：第 1 条那一轮 `imports.captureAsk` 收到的提问含「（附件：合成笔记.md）」，不含「蓝鲸七号」。
9. **留痕**：第 1、2 条各多一行 `chat.attachments_sent`，`count`、`images`、`texts`、`totalBytes`、`model` 对；整行详情的 JSON 里不含文件名、不含「蓝鲸七号」。
10. **导出带附件**：导出 ZIP 里有 `vault/<前两位>/<hash>` 这份附件原件；恢复到另一个临时目录后 `getMessageAttachment` 读得出同样的内容。
11. **删对话**：删掉对话后 `message_attachments` 里这些行没了，vault 里原件还在。
12. **渲染层拿不到路径**：`pickChatAttachments()` 返回给渲染层的只有票据、名字、大小（用 `IXAEON_TEST_DIALOG_RESPONSES` 钩子），JSON 里不含所选文件的目录；`askQuestion` 传一个用过的票据被拒。`attachmentsFromMessageId` 指向别的对话的消息也被拒。
13. **界面**（jsdom，替身 api）：
    - 点 `ask-attach` 调了 `pickChatAttachments()`，已选附件出现在 `ask-attachment-<序号>`，点它的去掉按钮就没了；
    - 发送时 `askQuestion` 收到票据，之后已选列表清空；
    - 用户消息下有 `message-attachment-<id>`；图片调 `getMessageAttachment` 后显示 `<img>`，`src` 以 `data:image/png;base64,` 开头；
    - 失败那一轮点「换模型重问」时 `askQuestion` 收到 `attachmentsFromMessageId`。

## 真机检查

- 写 `scripts/real/cf5-attachment-gateway.mjs`：照 `cf3-fake-gateway.mjs` 起一个假网关（模型 `demo-a`），每收到一次请求只打印一行统计：消息条数、`image_url` 段数、最后一条 user 消息的字符数。不打印正文。
- 设 `IXAEON_DATA_DIR=<临时目录>` 启动应用，接这个假网关，新对话里：
  - 带一张合成 png 问「图里是什么」；
  - 带 `合成笔记.md` 问「总结一下」；
  - 选一个 6 MB 的合成文件发，看到拒绝的提示；
  - 截图（消息上的缩略图、附件名、拒绝提示），遮掉临时目录。
- 写 `scripts/real/cf5-attachment-counts.mjs`，只读那个临时库，输出：附件行数（图片几个、文本几个）、vault 文件数、`chat.attachments_sent` 审计行数、消息条数。预期：附件 2（图片 1、文本 1），审计 2，消息 4（被拒的那一问没落消息）。
- **真模型（可选，没跑写没跑）**：本机 magpie 选一个支持图片的模型，带同一张合成 png 问一句，只记 `succeeded` / `failed` 和模型名。
- 只贴脚本输出和截图，不贴回答原文。

## 交付

B 档：先只推测试（`packages/core/test/acceptance/cf5-*.test.ts`、`apps/desktop/test/acceptance/cf5-*.test.ts`），队列状态改「测试待审（整合方）」，接着去领别的。整合方写迁移 44、锁定测试后再写实现，两支 CF5 / CF5b 照 AGENTS.md 拆分的规矩交。交付说明 `docs/委派/交付/CF5.md`、`CF5b.md`。

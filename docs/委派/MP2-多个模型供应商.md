# 规格 MP2：模型接入支持多个供应商，额度挂在供应商上（MP2 / MP2b）

档位：**B**：会访问用户填的任意地址（去拉模型清单），要存多个 Key，聊天和后台分析用哪家的模型也会变。大小：拆两支，各自源码不超过 300 行。
- **MP2**：配置、主进程、IPC，不动界面，约 230 行；
- **MP2b**：新的「模型」页，从设置页搬走「模型接入」和「额度来源」，约 250 行。

依赖：队列第 151 行（CF3 / CF3b）先并入。两单都改 `appRuntime.ts` 里读聊天模型的那一段，同时改会撞。

来源：用户 2026-11-03（[三周任务单](../三周任务单.md)「模型池（用户 2026-11-03 定）」一节）。用户原话：
- 「模型接入只能一个地址和key，这是不够的」
- 「额度来源应该和模型接入是一体的」
- 「我输入地址和key，获取可用模型，然后我勾选我想用的模型」
- 「不要做自己的magpie、newapi……直接接入他们」

这一单只做模型池的**第一步**。用途的先后顺序和「不行换下一个」是第二步，不在这一单里。整合、审查、开发选哪个模型，已经由 MG2 / K10a 在驾驶舱里做了，这一单不碰。

## 为什么

现在「模型接入」只有一个地址、一个 Key。用户想同时接 magpie、DeepSeek 官方、token plan 这几家，只能来回改。「额度来源」在设置页的另一张卡片上，跟模型接入分开，用户找不到对应关系。设置页现在有十几张卡片并排，已经放不下了。

## 要什么

### MP2（配置 + 主进程 + IPC）

1. **第一家沿用 `config.model`，其余放进新的 `config.providers`**：
   - `config.model` 就是 id 固定为 `default` 的那一家，旧字段一个不改、一个不搬。
   - 这样不用迁移配置；旧的 IPC（`saveModelSettings`、`listAvailableModels`）和旧测试照常能用；装回旧版本也不坏。
2. **每家供应商**有这些：名字、类型（`openai` 或 `magpie`）、地址、加密的 Key、勾选保存的模型、上次检测时间。
   - 新加的 Key 跟现在一样，用 `encryptApiKey` 加密后落盘，完整的 Key 和密文永远不回给界面。
   - 界面显示 Key 的**后四位**（用户 11-03 定），好认出是哪个 Key。后四位由主进程在生成视图时解密现算，**不另存**。Key 不到 8 个字符的（比如 magpie 的 Key）不显示后四位，只显示「已保存」；没有 Key 显示「未配置」；解不开显示「Key 解不开，请重新填」。
   - 地址的来源（协议 + 主机 + 端口）改了、这次又没填新 Key：把那一家已保存的 Key 清掉。照 M3 的规则，每一家都一样。
3. **获取模型**：对某一家发 `GET <地址>/models`，带 `Authorization: Bearer <Key>`。
   - 只取每项的 `id`，去重；超时 10 秒；不跟跳转（`redirect: 'error'`）。
   - 成功了记下那一家的检测时间；失败返回原因，不抛错。
   - Key 留空时，用那一家已保存的 Key，但只限地址没变。照 M2 / M3 的规则。
   - 不发任何别的请求。
4. **用途**：新的 `config.uses` 记三件事：后台分析、聊天、编码任务「我的模型」，每件用哪家的哪个模型。
   - 选的是 `default` 那一家：写回旧字段（`model.modelName` / `model.chatModelName` / `coding.modelName`），同时删掉 `uses` 里对应的那一项。
   - 选的是别的家：写进 `uses`，旧字段不动。
   - 只能从那一家勾选保存过的模型里选，否则拒绝。
5. **按用途取模型**，规则只写在一处：
   - `uses` 里有这一项，就用那一家；没有，就照旧走 `default` 和旧字段。
   - 聊天没有单独选（`uses.chat` 没有，`chatModelName` 也是空的）：跟着后台分析走，包括跟着它用同一家供应商。
   - `getProvider()`（后台分析）、`chatLaunchOptions()`（聊天，CF3 的直连和 Hermes 都从这里读）、编码任务「我的模型」都改从这里取。`chatLaunchOptions()` 的返回形状不变。
   - CF3b 并入时定了：聊天**单独选过**才走直连（`directChatLaunch()` 现在只看 `model.chatModelName` 非空）。这一单把「单独选过」改成 `uses.chat` 有，或者 `chatModelName` 非空，两种都算；「跟着后台分析」两种都没有，照旧不走直连。验收条件 6 里「聊天选了 B 家的 `demo-b`」那一条，同时断言这一问走的是直连（`engine = 'direct'`）。
   - 那家没了、没 Key、Key 解不开：返回 null，行为跟今天「没配模型」一样。
6. **额度挂在 magpie 那一家上**：
   - magpie 最多只能有一家。保存一家 `magpie` 类型的供应商时，把它地址的来源写进 `cockpit.magpie_url`；地址不过 `checkMagpieUrl`（只认 http + 本机 + 端口）就拒绝保存。现有的驾驶舱额度、MG2 模型清单都读这个设置，那些代码不改。
   - `default` 那一家算不算 magpie，不另存字段，靠推算：它地址的来源等于当前 magpie 地址，就算。
   - `openai` 类型的供应商**不发任何额度请求**，返回给界面的视图里也没有额度这一项。
7. **删除**：
   - `default` 不能删，只能改或清空。
   - 别的家被 `uses` 用着：拒绝，提示写明是被哪个用途用着（例如「聊天在用它，先在用途里换掉」）。
   - 没人用：删掉，它的密文一起从 config.json 里消失。
8. **审计**：保存、删除供应商，各记一条，只记 id、类型，以及 Key 是新填、保留还是清掉了。不记地址里的路径和查询，不记 Key。

### MP2b（界面）

9. **左边导航加「模型」**，放在「设置」上面。设置页拿掉「模型接入」和「额度来源」两张卡片，原地留一行「模型和额度搬到了左边的「模型」」，带一个跳过去的按钮。现在别处「去设置里配模型」的跳转（`focus: { section: 'model' }`）改成跳到「模型」页。
10. **「模型」页分三块**：
    - **供应商**：每家一张卡片，`default` 排第一。卡片上有：
      - 名字；magpie 那家加一个「magpie」标记；
      - 地址；Key 显示成「已保存 ····abcd」（后四位），规则见第 2 条；
      - 「获取模型」「编辑」「删除」三个按钮；
      - 勾选清单，照 M2 的样子：筛选框、「新」「上游已没有」标记，加一个「保存勾选」。
      - magpie 那张卡片在下面显示驾驶舱同一份额度卡片，加一个「刷新」按钮。别的卡片**没有任何额度区域**。
      - 卡片下面有「+ 添加供应商」，表单是名字、地址、Key。旁边有「用本机 magpie」一键预设，照 SUB1 那样填好地址和 Key、类型设成 magpie；已经有一家 magpie 时，这个按钮不能点。
    - **用途**：后台分析、聊天、编码任务「我的模型」三个下拉框。选项是所有供应商勾选过的模型，显示成「供应商名 · 模型」。聊天多一个「跟着后台分析」。有一个「保存」按钮。
    - **手动登记的额度**：现在额度来源卡片里的手动登记原样搬过来，默认收起。
11. **聊天里换模型（CF0）**、设置里「编码任务交给谁」的模型下拉框，也改成同样的「供应商名 · 模型」选项，保存走第 4 条的规则。

## 契约（写死，不改名、不加字段）

```ts
// packages/contracts/src/config.ts：appConfigSchema 加两项（都有默认值，旧配置照样能读）
export const modelChoiceSchema = z.object({ providerId: z.string().min(1), model: z.string().min(1) });
providers: z.array(z.object({
  id: z.string().min(1),                 // 新建时生成，形如 'p-<随机>'；'default' 保留给 config.model
  name: z.string().min(1).max(40),
  kind: z.enum(['openai', 'magpie']),
  apiBaseUrl: z.string(),
  apiKeyEncrypted: z.string().nullable(),
  apiKeyPresent: z.boolean(),
  savedModels: z.array(z.string()).default([]),
  modelsCheckedAt: z.string().nullable().default(null),
})).default([]),
uses: z.object({
  analysis: modelChoiceSchema.optional(),
  chat: modelChoiceSchema.optional(),
  coding: modelChoiceSchema.optional(),
}).default({}),
// config.model 加一项：model.providerName: z.string().default('')（default 那家的显示名，空 = 「默认」）

// 给界面的视图（packages/contracts，不含任何 Key 或密文）
export interface ModelProviderView {
  id: string; name: string; kind: 'openai' | 'magpie';
  apiBaseUrl: string; apiKeyPresent: boolean;
  apiKeyTail: string | null;          // Key 的后四位；Key 不到 8 个字符、没有 Key、解不开都是 null
  apiKeyUnreadable: boolean;          // 有密文但解不开
  savedModels: string[]; modelsCheckedAt: string | null;
  usedBy: Array<'analysis' | 'chat' | 'coding'>;
}

// packages/core：按用途取模型，纯函数，不解密
export function resolveModelUse(
  config: AppConfig, use: 'analysis' | 'chat' | 'coding',
): { providerId: string; providerName: string; apiBaseUrl: string; apiKeyEncrypted: string | null; model: string } | null;

// AppRuntime 新方法（IPC 照 ipc.ts 现有写法各开一个通道，api.ts 同名）
listModelProviders(): ModelProviderView[];
saveModelProvider(input: { id?: string; name: string; kind: 'openai' | 'magpie'; apiBaseUrl: string; apiKey?: string; savedModels?: string[] }): { ok: true; id: string; keyCleared: boolean };
deleteModelProvider(id: string): { ok: true };            // 被用着 / 删 default → 抛 IxaError，message 是给用户看的中文
fetchProviderModels(id: string, input?: { apiBaseUrl?: string; apiKey?: string }): Promise<{ models: string[]; error: string | null }>;
saveModelUses(input: { analysis?: ModelChoice | null; chat?: ModelChoice | null; coding?: ModelChoice | null }): { ok: true };  // null = 清掉这一项（回到旧字段）
```

`id === 'default'` 时，`saveModelProvider`、`fetchProviderModels` 读写的是 `config.model`，规则跟旧的 `saveModelSettings`、`listAvailableModels` 一样。旧方法保留，内部可以改成调新方法。

## 约束

- 只访问用户填的地址，只发 `GET /models`；Key 只放在请求头里，只发给那一家的地址。magpie 的额度请求照旧只认本机。
- Key 不进日志、审计、错误信息，也不进 `ModelProviderView`、`runtime_runs`。错误信息里引用上游回的正文时，先截断到 120 字。
- 不写迁移（只改 config.json 的 schema，新增项都有默认值）。
- 不做用途的先后顺序，也不做「不行换下一个」（第二步）。驾驶舱的调度器面板（K10a / MG2）不碰。
- 不给 `openai` 类型的供应商加任何额度读取。以后每多一家有额度接口的，单独开一单，先用真机确认它返回的样子。
- 合成数据：测试里地址用 `http://127.0.0.1:<端口>`，Key 用 `sk-synthetic-a`、`sk-synthetic-b`，模型名用 `demo-a`、`demo-b`。

## 验收条件

MP2：
1. 旧配置（只有 `config.model`，没有 `providers` / `uses`）照样能读。`listModelProviders()` 返回一家 `default`，地址、模型清单跟旧字段一样；`getProvider()`、`chatLaunchOptions()` 的结果跟改之前完全一样。
2. 新加一家供应商（Key 用 `sk-synthetic-a1b2c3d4`）：
   - config.json 的文本里找不到明文 Key；
   - `listModelProviders()` 和 `getSettings()` 的返回里找不到完整的 Key，也找不到密文；那一家的 `apiKeyTail` 是 `c3d4`；
   - config.json 里没有单独存后四位的字段；
   - Key 是 `magpie`（不到 8 个字符）时 `apiKeyTail` 是 null；密文解不开时 `apiKeyUnreadable` 是 true、`apiKeyTail` 是 null。
3. 同一家改了地址来源、又没填新 Key：那一家的 Key 被清掉，返回 `keyCleared: true`，别的家不受影响。
4. 获取模型：假服务收到的是 `GET /models`，带的是那一家的 Key；只取出 `id`，去重。另外三种情况：
   - 假服务回 302 指向另一个端口：返回 error，另一个端口一次请求都没收到；
   - 超时：返回 error，不抛错；
   - Key 留空、地址没变：用已保存的 Key；地址变了：不带旧 Key。
5. 两家各自勾选、保存，互不影响；获取 A 家的模型不改 B 家的检测时间。
6. 用途：
   - 聊天选了 B 家的 `demo-b`：`chatLaunchOptions()` 返回 B 家的地址、B 家的 Key、`demo-b`，`getProvider()` 还是 default；
   - 聊天的选择清掉：回到旧字段；
   - 后台分析选了 B 家、聊天没单独选：聊天也走 B 家；
   - 选一个没勾选过的模型：拒绝；
   - 选 default 那一家：写进旧字段，`uses` 里没有这一项。
7. B 家被删，或者 B 家的 Key 解不开：用了 B 家的用途返回 null，行为跟「没配模型」一样，不会掉回 default 去用别家的 Key。
8. 删除：
   - 被用着的那家：拒绝，提示里写着用途的名字；
   - 删 `default`：拒绝；
   - 没人用的那家：删掉，它的密文从 config.json 里消失。
9. magpie：
   - 保存一家 magpie 类型：`cockpit.magpie_url` 变成它地址的来源；
   - 第二家 magpie：拒绝；
   - magpie 类型、地址不是本机：拒绝，不发请求；
   - 一家 `openai` 类型的走完获取模型、保存、读视图整个过程：假服务只收到 `/models`，没有任何额度请求。
10. 审计里有保存、删除的记录，记录里没有 Key，也没有密文。

MP2b：
11. 导航里有「模型」；设置页里没有 `settings-model`、`settings-quota` 两张卡片了（testId 以现有为准），有跳到「模型」页的按钮。原来跳到设置页模型区的入口，现在跳到「模型」页。
12. 供应商卡片：
    - Key 显示后四位（「已保存 ····c3d4」）；短 Key 只显示「已保存」；没有 Key 显示「未配置」；页面文本里找不到完整的 Key；
    - 勾选清单有筛选框和「新」「上游已没有」标记；
    - magpie 那张有额度区和「刷新」；`openai` 那张页面上找不到额度区域；
    - 已经有 magpie 时，「用本机 magpie」按钮不能点。
13. 用途的三个下拉框：选项是所有供应商勾选过的模型，显示成「供应商名 · 模型」；聊天多一个「跟着后台分析」；保存后重新打开页面，选中的还在。
14. 聊天里换模型、设置里「编码任务交给谁」的模型下拉框，选项跟第 13 条一样。
15. 删除一家正在用的供应商：页面上显示拒绝的原因，卡片还在。

## 已有锁定测试会撞到的

UI 搬家会撞到一些锁定测试，它们查的是设置页上「模型接入」「额度来源」的 testId。可能的有：`m2-settings-ui`、`m3-settings-ui`、`sub1-magpie-preset`、`sub1b-quota-settings`、`k4c-quota-settings`、`v4-settings-page`、`u2-settings-coding-saved`、`d7b-pages`、`cf0-chat-model-switch`。

**不许改它们。** 写 MP2 / MP2b 的验收测试时，把**实际会撞**的锁定测试列一份清单，写进交付说明：哪个文件、哪一条、为什么跟本规格冲突。整合方锁 MP2 测试时一并改写或退役。后端那一侧的旧方法都保留，应该不会撞；撞了照样列出来。

## 真机检查

- **甲（合成）**：
  - 设 `IXAEON_DATA_DIR=<临时目录>` 启动应用，起两个假的 OpenAI 兼容服务（本机两个端口，各回一份不同的 `/models`，再回一段固定的流式正文）。
  - 在「模型」页加两家，各自获取模型、勾选、保存。
  - 用途里把聊天选成第二家的模型，问一句。
  - 看两点：第二家的假服务收到了聊天请求，第一家没收到；第一家的卡片上没有额度区域。
  - 再删第二家，看到拒绝。
  - 截图，临时目录遮掉。
- **乙（本机 magpie，只出统计数字）**：在临时数据目录里用「用本机 magpie」加一家，获取模型。只打印三样：模型个数、分组（`group/` 开头）个数、额度卡片张数。不打印模型名、账号、额度的具体数。
- **丙**：用户在自己的应用里加第二家供应商（比如 DeepSeek 官方），把聊天切过去问几句。交付说明里写「待用户实测」。

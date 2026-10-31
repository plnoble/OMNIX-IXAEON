# 规格 DG1：接力的 DSH 网关跟 DSH 桌面版走（不再抄副本）

档位：**B**（接力能用的网关变多了：新的外部访问）。大小：小（约 60 行，在 `packages/relay/bin/dsh.mjs` 或起棒拼参数的地方）。依赖：无。来源：用户 10-31：「为什么你用 DSH 不看 DSH 桌面版的配置呢」「你不能一个网关管所有，我可能有很多网关，我还有本地的 magpie」。现状：接力的补丁 `~/.dsh/ixaeon-relay.patch.yml` 里的网关段（`llm-pi-ai`）是 10-23 从桌面版 `~/.dsh/profiles/desktop/cordis.patch.yml` 照抄的副本，之后桌面版新加的 sub2api、magpie 等接力都看不到。

v2 规格：先把验收条件写成测试（`packages/relay/test/acceptance/dg1-*.test.ts`）。**本周例外（用户 10-31 定）**：测试和实现一起在 `dev/DG1` 上做完，状态改「待复审（整合方）」，不合并。

## 要什么

每一棒起 DSH 时：

1. 从桌面版配置（默认 `~/.dsh/profiles/desktop/cordis.patch.yml`；`DSH_HOME` 有值时用 `<DSH_HOME>/profiles/desktop/cordis.patch.yml`）里**只取顶层 `- id: llm-pi-ai` 那一项**（到下一个顶层 `- id:` 之前），原样写进一个临时补丁文件；
2. DSH 的参数变成 `--profile headless --patch <临时网关补丁> --patch <接力补丁> …`：网关在前，接力补丁在后（接力补丁只管权限、默认模型）；
3. 棒结束删掉临时文件。

**不能整份叠桌面版**：10-31 实测，整份叠进来会把桌面版的 MCP 服务（比如能操作浏览器的 chrome-devtools）一起带进每一棒。

接力补丁里那份旧的网关副本由用户（或整合方经用户同意）删掉；`README.md`、接力补丁开头的注释改成「网关在 DSH 桌面版里管，接力每棒自动取」。

## 约束

- 只取 `llm-pi-ai` 那一项，别的项（MCP、界面设置、`llm-deepseek` 等）一律不带。
- 临时文件放系统临时目录、文件名随机，棒结束（含崩溃、超时）都删掉；不打印、不记录它的内容（里面有网关地址、`apiKeyEnv` 名字）。
- 桌面版配置不存在或里面没有 `llm-pi-ai` 项 → 照现在的参数起（不加临时补丁），打一行「没找到 DSH 桌面版的网关配置，接力用自己补丁里的」。
- 不改桌面版配置，不改用户的接力补丁（删旧副本那一步是用户的事）。

## 验收条件

1. 合成桌面版配置：顶层三项 `ui-settings-general`、`llm-pi-ai`（两个网关，其中一个叫 `magpie`）、`mcp-servers`；合成接力补丁 → 起棒时 DSH（替身）收到的参数是 `--profile headless --patch <A> --patch <接力补丁> …`，A 的内容正好是 `llm-pi-ai` 那一项（逐字），里面没有 `ui-settings-general`、`mcp-servers`。
2. 棒结束（正常、替身崩溃、超时三种）后 A 都不在了。
3. 桌面版配置不存在 / 没有 `llm-pi-ai` 项 → 参数和现在一样，输出那一行提示。
4. `DSH_HOME` 指向另一个目录 → 从那里读。
5. 记账、日志、飞书通知里都找不到合成网关的地址和 `apiKeyEnv` 的值。

## 真机检查

`scripts/real/dg1-desktop-gateways.mjs`：用用户真实的桌面版配置（**只读**）起一次 DSH headless，默认模型临时指向桌面版里登记、接力副本里没有的一个网关模型（比如 magpie 的某个模型），只问「只回复两个字母：OK」：贴出退出码和含 OK 的那一行；不打印配置内容。（10-31 整合方用同样的办法手工试过一次：整份叠桌面版能用 magpie 答出 OK，但带进了 MCP 服务，所以这一单只取网关段。）

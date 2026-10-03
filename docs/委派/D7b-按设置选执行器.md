# 规格 D7b：按设置选执行器——选了「我的模型」，编码任务就交给它

档位：**B**（决定项目文件发不发给模型、发到哪个地址、带哪个 Key）。大小：中（≤300 行源码；超了把设置页那一栏拆成另一单）。依赖：D7（网关执行器本体）、M2（已保存的模型清单）。来源：从 D7 拆出（D7 规格末尾「拆成两单」）。

验收测试整合方已经写好并锁定，执行方只写实现，不改测试：

- `apps/desktop/test/acceptance/d7b-executor-selection.test.ts`
- `apps/desktop/test/acceptance/d7b-pages.test.ts`

## 要什么

D7 做出了「我的模型」这种执行器，但应用里还选不到它。这一单把它接进去：设置里选「编码任务交给谁」，派发时按当时的设置取执行器；选了「我的模型」却没选模型或没配 Key，就不派发，告诉用户缺什么。

写法留出位置：以后加 Claude Code 或别的 agent，是给下面的 `ExecutorPlan` 加一种，不是再改一遍派发。

## 契约（接口写死，不改名、不加字段）

1. **配置**（`packages/contracts`）：`coding: { executor: 'codex' | 'model'（默认 'codex'）, modelName: string（默认 ''） }`，整段缺省时取默认——旧的 config.json 照常读出来。不加迁移。
2. **保存**：`AppRuntime.saveCodingSettings({ executor, modelName }): { ok: true }`，IPC 同名。
   - `executor` 不是这两个值 → 拒绝；
   - `modelName` 非空但不在已保存的模型清单（`model.savedModels`）里 → 拒绝；
   - 只改 `coding` 这一段，落盘。
   - 设置视图（`getSettings().config`）加 `codingExecutor`（默认 `'codex'`）、`codingModelName`（默认 `''`）。
3. **取执行器**：`AppRuntime.executorPlan(): ExecutorPlan`，每次现读设置（改了设置不用重启）：
   - 选的是 Codex，或者没有这段配置 → `{ use: 'codex' }`。运行时连 `config` 都没有也算这一种：D3、D4、P4 的锁定测试就是这样搭运行时的，派发闸门会在那里调到它，不能报错；
   - 选的是「我的模型」：
     - 模型名为空，或已不在已保存清单里 → `{ use: 'none', missing: 'model_name' }`；
     - `codingModelProvider(模型名)` 拿不到 → `{ use: 'none', missing: 'model_key' }`；
     - 否则 → `{ use: 'model', executor: new ModelCodingExecutor(provider, 模型名) }`。
4. **模型客户端**：`AppRuntime.codingModelProvider(modelName: string): ModelProvider | null`：
   - 环境变量 `IXAEON_FAKE_MODEL=1` 时返回假模型（就是 `getProvider()` 给的那个），绝不联网；
   - 否则用已保存的 Key（没有、解不开 → `null`）、已保存的 API 地址、**传入的模型名**建客户端。不用分析模型的名字。
5. **`apps/desktop/src/main/codingExecutor.ts`**：

   ```ts
   export type ExecutorPlan =
     | { use: 'codex' }
     | { use: 'model'; executor: CodingExecutor }
     | { use: 'none'; missing: 'model_name' | 'model_key' };

   export class ConfiguredCodingExecutor implements CodingExecutor {
     constructor(codex: CodingExecutor, plan: () => ExecutorPlan);
   }
   ```

   - `run` 一开头（第一个 `await` 之前）取一次 plan：`codex` → 交给 `codex`；`model` → 交给 `plan.executor`；`none` → 抛错。
   - `name`：按当前 plan，`model` → 那个执行器的名字（`model:<模型名>`），其余 → `codex.name`。
   - `AppRuntime.create()` 和恢复数据后重建编排的地方，都用它包住现有的 `createCodingExecutor()`，plan 用 `executorPlan()`。

6. **编排层**（`CodingOrchestrator.dispatch`）：执行器名在开工时读一次，之后写库都用这个值。跑到一半改了设置，这个任务记的还是开工时那个执行器。
7. **派发闸门**：自动派发（`CodingDispatch`；`CodingDispatchHost` 加可选的 `executorPlan?: () => ExecutorPlan`）与任务页点「派发」（`finishCodingTask(id, 'dispatch')`）都先问 `executorPlan()`：
   - `none` → 不派发，任务留在排队。自动派发在发起的对话里回报一条（`meta.status = 'executor_missing'`，同一任务只写一次）：写明缺什么（没选模型 / 没配 Key）、去设置的「编码任务交给谁」里补、补好后在任务页点派发。任务页点派发报同样意思的错；
   - `model` → 不做「本机没装 Codex」的检查；
   - `codex`，或者宿主没有 `executorPlan` → 与现在一模一样。
8. **显示**：
   - 回报（「等你验收」「没做成」）：任务是「我的模型」做的，多写明 `我的模型（<模型名>）`；别的执行器的回报一字不变；
   - 任务页卡片：`model:<模型名>` 显示成 `我的模型（<模型名>）`；
   - 任务页顶部：`listCodingTasks()` 的 `executor` 加一种 `'model'`。选了「我的模型」时 `notice` 写明现在交给谁、项目副本里的文件内容会发给这个模型（缺东西时写缺什么、去哪补），页面不再显示 Fake / 真机 Codex 那两句。
9. **设置页**加一栏「编码任务交给谁」（卡片 `data-testid="settings-coding"`）：
   - 下拉框 `settings-coding-executor`：`codex`「Codex（本机装了才能用）」、`model`「我的模型」；
   - 选了「我的模型」才出现下拉框 `settings-coding-model`：第一项是空值「请选择」，其余只有已保存的模型；
   - 说明一句：选「我的模型」后，你点「要做」的编码任务会把项目副本里的文件内容发给这个模型；
   - 按钮 `settings-coding-save` → `api.saveCodingSettings({ executor, modelName })`。

## 约束

- 不加迁移。不动 M2 的模型清单和保存逻辑。Codex / 替身执行器的回报文字一字不变。
- 批准流程不变：只有用户点了「要做」（或在任务页批准并派发）的任务，才会把文件发给模型。
- Claude Code、别的 agent 不在本单。

## 验收条件

1. 默认（没有 `coding` 这段，或选的是 Codex）：与现在一模一样——用原来的执行器，没装 Codex 时的检查与回报照旧，回报文字不变（D3、D4、P4 的锁定测试照过）。
2. 旧的 config.json（没有 `coding`）照常读出来，默认 Codex；保存后落盘，重读还在。
3. `saveCodingSettings`：模型名不在已保存清单里 → 拒绝、配置不变；合法的保存只动 `coding`。
4. 选了「我的模型」并选好模型、配了 Key：点「要做」→ 网关执行器做完（文件写进副本）→ 验证 → 对话里回报 → 接受 → 合成 git 项目里建出分支，提交正好是这些改动。本机没装 Codex 也照常派发。任务记的执行器是 `model:<模型名>`。
5. 模型要改范围外的文件：任务失败，回报里有那个路径；真实项目没变。
6. 没选模型（或选的模型已不在已保存清单里）、没配 Key：不派发，任务留在排队，对话里回报一条、不重复写；任务页点派发同样不派发并报错；这期间没有任何内容发给模型；补好之后在任务页点派发能做完。
7. 改了设置不用重启：同一个运行时里先后两个任务，各按派发那一刻的设置走。
8. 跑到一半改设置：这个任务记的执行器还是开工时那个，另一个执行器没被调用。
9. 模型客户端：没存 Key → 拿不到；存了 → 请求发到已保存的地址、带已保存的 Key、用的是编码用的模型名；假模型模式下不联网。
10. 显示：回报、任务页卡片里是 `我的模型（<模型名>）`；任务页顶部在选了「我的模型」时写明交给谁，没有 Fake / 真机 Codex 那两句；缺东西时写缺什么。
11. 设置页：两个选项；选「我的模型」才出现模型下拉框，选项只来自已保存清单；保存调用 `saveCodingSettings`。

## 端到端测试（随实现一起交，不锁定）

`apps/desktop/e2e/d7b-model-executor.spec.ts`，假模型（`IXAEON_FAKE_MODEL=1` 加响应脚本）、`IXAEON_CODEX_EXE=none`、合成数据：

1. 设置页选「我的模型」、选一个已保存的模型、保存；重新打开设置页还是它（证明 `getSettings` 带回了这两项）。
2. 合成项目（绑了文件夹）里点「要做」→ 对话里出现回报，写着 `我的模型（<模型名>）`；任务页卡片同样。副本里的文件确实改了（证明应用启动时装进编排的是按设置选的执行器，不是替身）。

## 真机检查

1. **界面**（假模型）：`IXAEON_DATA_DIR=<临时目录>`、`IXAEON_FAKE_MODEL=1` 启动，照上面两步点一遍，再把设置里的模型清空后点「要做」，截图或描述回报与任务页。
2. **真模型网关**（原 D7 规格的两步）：`scripts/real/d7b-model-task.mjs`——
   - 建临时数据目录，写一份最小配置：只从真实配置里取 `model.apiBaseUrl`、`model.apiKeyEncrypted`、`model.apiKeyPresent`、`model.savedModels`、`model.modelName` 五项，其余用默认值；**不复制数据库，不复制别的配置项**；
   - 用 `IXAEON_DATA_DIR=<临时目录>`、另选端口（`IXAEON_HTTP_PORT`）启动应用，不开假模型；
   - 合成的小 git 项目（只有 README）：目标「在 README.md 末尾加一行……」、批准范围 `README.md` → 副本里 README 多了这一行，接受后建出分支，提交正好改了 README；
   - 同一个项目，批准范围只给 `README.md`，目标却要新建 `other.txt` → 没写任何文件，任务失败，原因里有 `other.txt`；
   - 原样贴两次的回报和任务页显示的执行器名。**只打印合成内容和状态，不打印 Key、网关地址**；跑完删掉临时目录。
   - 用户的应用开着也能跑（数据目录、端口都是另外的）；不要关用户的应用。

原样贴进交付说明。没跑的写没跑。

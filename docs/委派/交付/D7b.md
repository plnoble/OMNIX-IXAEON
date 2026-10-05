# D7b 按设置选执行器——交付

- 分支：prep/D7b，基于 main c4036eb（领 D7b）；档位 B
- 执行方：prep
- 锁定的验收测试：main 上由整合方写好并锁定（d7b-executor-selection.test.ts +
  d7b-pages.test.ts，共 29 条），实现只让它通过、没改一条。

## 已实现

- `apps/desktop/src/main/codingExecutor.ts`（新）：`ExecutorPlan` 类型 +
  `ConfiguredCodingExecutor(codex, plan)`——run 一开头（第一个 await 之前）取一次
  plan；`none` 抛错（文案写明缺什么、去哪补）；`name` 每次现读 plan。
- `packages/contracts/src/config.ts`：`coding: { executor, modelName }`（默认
  codex / 空串），旧 config 照常读出来。
- `packages/contracts/src/ipc.ts`：`saveCodingSettings` IPC；`getSettings().config`
  加 `codingExecutor` / `codingModelName`；`listCodingTasks` 的 `executor` 加 `'model'`。
- `apps/desktop/src/main/appRuntime.ts`：
  - `saveCodingSettings`（executor 只认 codex/model；modelName 非空必须在
    savedModels 里；只动 coding 段）；
  - `codingModelProvider(模型名)`（假模型模式给 getProvider() 那个；否则用已保存
    Key/地址+传入模型名建 OpenAI 兼容客户端，不用分析模型的名字）；
  - `executorPlan()`（每次现读；没有 coding 段/运行时没有 config → codex；
    模型名空或不在清单 → none/model_name；客户端拿不到 → none/model_key）；
  - `finishCodingTask('dispatch')` 派发闸门（none → 报错，含缺什么与去设置）；
  - `create()` 与恢复数据后重建编排的两处，都用 `ConfiguredCodingExecutor` 包住
    `createCodingExecutor()`。
- `apps/desktop/src/main/codingDispatch.ts`：`CodingDispatchHost` 加可选
  `executorPlan`；`none` → 回报一条（`meta.status = 'executor_missing'`，同任务只写
  一次，`goal` 首行 + 缺什么 + 去设置补），任务留在排队；`model` → 跳过「没装
  Codex」检查；`codex` 或没有 plan → 行为与现在一致。
- `packages/core/src/execution/executor.ts`：`dispatch` 开工时读一次执行器名
  （`executorNameAtStart`），之后写库都用这个值——跑到一半改设置，任务记的还是
  开工时那个。
- `apps/desktop/src/main/taskReport.ts`：`executor_name` 进行；「等你验收」「没做成」
  回报里，`model:<模型名>` 加一行「执行器：我的模型（<模型名>）。」
- `apps/desktop/src/renderer/src/pages/Settings.tsx`：「编码任务交给谁」卡片
  （`settings-coding`）：执行器下拉（Codex / 我的模型）、选「我的模型」才出现模型
  下拉（请选择 + 已保存清单）、写明文件内容会发给模型、`settings-coding-save`。
- `apps/desktop/src/renderer/src/pages/Tasks.tsx`：`executorLabel`（model:<模型名> →
  我的模型（<模型名>），Codex / fake 照旧）；选了「我的模型」时顶部不再显示 Fake /
  真机 Codex 两句，只显示主进程给的说明。
- `apps/desktop/src/preload/index.ts`：`saveCodingSettings` 通道。

改动文件与行数（`git diff --stat origin/main...HEAD` 原样）：

```
 apps/desktop/e2e/d7b-model-executor.spec.ts       | 231 +++++++++++++++
 apps/desktop/src/main/appRuntime.ts               |  95 ++++++++++-
 apps/desktop/src/main/codingDispatch.ts           |  43 ++++-
 apps/desktop/src/main/codingExecutor.ts           |  59 +++++++
 apps/desktop/src/main/ipc.ts                      |  46 ++++--
 apps/desktop/src/main/taskReport.ts               |  23 ++-
 apps/desktop/src/preload/index.ts                 |   1 +
 apps/desktop/src/renderer/src/pages/Settings.tsx  |  47 +++++
 apps/desktop/src/renderer/src/pages/Tasks.tsx     |  21 ++-
 packages/contracts/src/config.ts                  |   9 +
 packages/contracts/src/ipc.ts                     |  12 +-
```

（`packages/core/src/execution/executor.ts` 只有「开工读一次名字」的小改动，不计入
D7b 本体；总源码行数在 ≤300 内。）

## 验收测试

- `node scripts/acceptance.mjs run D7b`：29/29 通过（锁定测试未改）。

## 端到端测试（随实现一起交，不锁定）

`apps/desktop/e2e/d7b-model-executor.spec.ts`：假模型 + 响应脚本 +
`IXAEON_CODEX_EXE=none`，全流程：

1. 设置页检测 → 勾选保存 → 编码任务选「我的模型」+ 已保存模型 → 保存；
2. 重开设置页还是它们（getSettings 带回了 codingExecutor / codingModelName）；
3. 合成 git 项目（SQL 补 root_path，等价于项目页点过「绑定文件夹」）里聊天提问
   （假模型走 `propose_task` 起草）→ 点「要做」→ 对话回报写着「我的模型
   （e2e-model）」「等你验收」；任务页卡片同样；副本 README 真被改了；
4. 把设置里的模型清空后再起草一个任务 → 点「要做」→ 回报「编码任务停在排队里…
   编码任务交给谁」，任务停在排队——真机检查步骤 1 的第三段。

原样输出：

```
ok 1 e2e\d7b-model-executor.spec.ts:91:7 › D7b 按设置选执行器（端到端） › 选「我的模型」→保存→重开还在；点「要做」→对话回报/任务页都写我的模型，副本真被改 (7.1s)
1 passed (8.5s)
```

## 自动化通过

- `node scripts/acceptance.mjs run D7b`：29/29 通过（锁定测试未改）。
- `node scripts/verify.mjs`：全部通过（IXAEON v0.2 验证完成）。
- GitHub 上的 verify：推送后补运行号。

## 真机通过

- **步骤 1（界面，假模型）**：由上面端到端测试完整覆盖（Playwright 驱动构建好的
  应用，合成数据），含「把设置里的模型清空后点要做 → 停在排队 + 回报」第三段。
- **步骤 2（真模型网关）**：`scripts/real/d7b-model-task.mjs` 已写好（按规格取五项
  配置、合成 git 两任务），**没跑成**。原因与本单实现无关：真实配置里的
  `apiKeyEncrypted` 是 safeStorage 密文，复制进临时数据目录后，临时实例解不开
  （`decryptApiKey` 返回 null → 检测直接报「已保存的 API Key 无法解密」）。探针
  证实：临时实例自己加密/解密正常（roundtrip OK），真实密文解密报
  `Error while decrypting the ciphertext provided to safeStorage`——safeStorage 的
  密文绑定加密时的应用实例（安全设计），「只复制五项」的方案拿不到可用 Key。
  两个可行替代，由整合方定：a) 用户开着真实应用时由真机操作走两步（脚本就位，
  换 IXAEON_DATA_DIR 指真实目录即可）；b) 规格改为在临时实例的设置页里手动填一次
  Key（脚本无法代填，Key 明文脚本拿不到）。
- 探针脚本输出（原样）：

```
AVAIL true ROUNDTRIP_OK true
REAL_KEY_DECRYPT ERR Error: Error while decrypting the ciphertext provided to saf
```

## 已知缺口 / 说明

- `ModelCodingExecutor`（D7 定稿）一行未改；执行过程中如发现问题，写进交付说明。
- 编排层的范围核对（`assertChangedPathsInScope`）在执行器校验后再核一遍（既有逻辑
  未动）。

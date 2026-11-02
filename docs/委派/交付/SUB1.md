# SUB1 直接接 magpie（第一支：模型接入一键预设，聊天跟着走 magpie）交付

- 分支：`dev/SUB1`，基于 main `5cbd952`；档位 B（本周例外：测试和实现一起交，不锁定、不合并）
- 执行方：dev

## 已实现

设置 →「模型接入」加「用本机 magpie」：把 API 地址填成 `http://127.0.0.1:3425/v1`、Key 填 `magpie`，走现有检测通道列出 magpie 全部模型；连不上只在按钮下面提示，表单不动。聊天（Hermes）启动时把已保存的网关地址与解密的 Key 和聊天模型一起交过去（照 `HERMES_MODEL` 只走启动环境变量，不写回 Hermes 的 config.yaml）；换网关 / Key 时重开长驻网关会话。

`git diff --stat origin/main...HEAD`：

```
 apps/desktop/src/main/appRuntime.ts                |  22 ++-
 apps/desktop/src/renderer/src/pages/Settings.tsx   |  59 ++++++
 .../test/acceptance/sub1-hermes-launch.test.ts     | 110 +++++++++++
 .../test/acceptance/sub1-magpie-preset.test.ts     | 186 ++++++++++++++++++
 packages/core/src/runtime/adapter.ts               |  40 +++-
 packages/core/src/runtime/hermesLocator.ts         |  23 ++-
 .../test/acceptance/sub1-hermes-gateway.test.ts    | 208 +++++++++++++++++++++
 .../test/acceptance/sub1-magpie-models.test.ts     |  81 ++++++++
 8 files changed, 717 insertions(+), 12 deletions(-)
```

源码改动 144 行（appRuntime 22、Settings 59、adapter 40、hermesLocator 23；其余是验收测试），≤300。

规格条件 3 的「能不能」：Hermes 的 stdio 网关没有命令行参数，只能用环境变量。查了本机 Hermes 的 `hermes_cli/providers.py` / `tui_gateway/server.py`：`HERMES_TUI_PROVIDER` 选 provider，`lmstudio` 这一档读 `LM_BASE_URL` / `LM_API_KEY`（OpenAI 兼容 chat_completions）。所以选它把 magpie 地址和 Key 交进去；带斜杠的 `provider/model` 原样发出。用真 Hermes + 本机 magpie 直接探针问「只回复两个字母：OK」实测答出 OK（见「真机通过」）。没有改 Hermes 的配置文件。

## 验收测试（规格条件 1–3）

- `packages/core/test/acceptance/sub1-magpie-models.test.ts`：条件 1 的真实 HTTP 段（合成 magpie 的 `GET /v1/models` 回 3 个 `prov/model`；检测通道原样列出，Bearer magpie；连不上时抛错而不是假装空清单）。
- `apps/desktop/test/acceptance/sub1-magpie-preset.test.ts`：条件 1、2（点按钮后地址 / Key / 清单正好 3 个；连不上出那句话、地址与 Key 不变、清单不动）。
- `packages/core/test/acceptance/sub1-hermes-gateway.test.ts`：条件 3（启动环境带合成 magpie 的地址 / Key magpie / 模型 `prov/m1`；没设地址或模型时不干预网关；替身进程真的收到这些值；换网关地址会重开进程）。
- `apps/desktop/test/acceptance/sub1-hermes-launch.test.ts`：条件 3 的桌面接线（设置里的地址、解密后的 Key、聊天模型一起交给启动参数；没有聊天模型 / 地址为空时不碰网关）。

## 自动化通过

- 验收测试：`node node_modules/vitest/vitest.mjs run --project acceptance <上面 4 个文件>` → **4 files / 11 tests 全过**。
- `node scripts/verify.mjs`：**全过**（lint、format、local-user、typecheck、typecheck-acceptance、build、unit、integration、acceptance-lock、acceptance、全部 review 套件）。摘录末尾的通过行：

```
  ✓ acceptance-lock（锁定的验收测试没被改） — 0.1s
  ✓ acceptance（已完成任务的锁定验收测试） — 280.5s
  ✓ review（二次验收独立业务测试 11 项，修复 R1-R9 回归） — 3.6s
  ✓ review-closure（修复收尾验收 5 项：迁移命中范围/回滚/重开库/原因保留/查询边界） — 2.8s
  ✓ review-recheck-ui（复审界面 UI01 + BUI01 + BUI02，真实 Electron） — 9.8s
全部通过（IXAEON v0.2 验证完成）
```

- GitHub 上的 verify：没看（本棒由调度器替推，推送前只在本地跑了 verify）。
- 本支没有 `acceptance.mjs lock`、没有合并、没有 `acceptance.mjs done`（B 档是整合方的关卡）。

## 真机通过

由 `scripts/real/sub1-magpie.mjs` 在 **SUB1b 分支**（包含本支）上一次性跑完 SUB1 + SUB1b 的甲项；真实本机 magpie、真 Hermes 代码。输出（原样，已遮临时目录；不打印额度卡账号名）：

```
MAGPIE models=15
HERMES_ENV given
HERMES found=true
PRESET base=http://127.0.0.1:3425/v1 key=magpie
LISTED ["antigravity/claude-opus-5-5","antigravity/claude-sonnet-5-5","antigravity/gemini-3.8-flash","antigravity/gemini-4-argon","auto/claude-opus-5-5","auto/claude-sonnet-5-5","auto/deepseek-v4.1-flash","auto/gemini-3.8-flash","auto/gpt-5.6-luna","baidu-qianfan/deepseek-v4.1-flash-1017","kiro/gpt-5.6-luna","opencode-go/deepseek-v4.1-flash","qoder/dfmodel","qoder/qmodel_38max","workbuddy/deepseek-v4.1-flash"]
SAVED models+chat model
ANSWER OK 本轮经 Hermes TUI gateway（stdio JSON-RPC）。不是单轮检索。 语义检索未启用，本轮按关键词选取记忆。；问答已存入 IXAEON 记忆（日常偏好与事实自动沉淀生效；若有冲突或关键决策，将在「待讨论」等你确认）。 引擎 hermes · 模型 auto/deepseek-v4.1-flash
QUOTAS cards=5 windows=28 note=（无）
shots=true models=true quotas=true
RESULT 通过：magpie 预设与模型清单一致、聊天真的走 magpie 答出 OK、驾驶舱额度区读到卡片；两张截图已落盘
```

- 模型清单截图：[附件/SUB1-magpie-models.png](附件/SUB1-magpie-models.png)（只有模型名）。
- 驾驶舱额度区截图：[附件/SUB1-cockpit-quotas.png](附件/SUB1-cockpit-quotas.png)（卡片上的账号名已涂黑）。
- 环境说明（如实）：当前 DSH 接力环境给工作区打了低完整性，Electron 子进程写不了用户真实 Hermes 的 `runtime/active_sessions.json` / `logs`（实测 `PermissionError(13)`，Hermes 的 claim 失败）。所以这次真机的 `HERMES_HOME` 指到 `.logs/` 下的一份临时 home：`hermes-agent` 用 junction 指向真安装（真 venv python、真 tui_gateway 代码），config/state/logs 都是空的临时目录，**没读也没写用户的 config、记忆、会话库**。同一环境里直接用 Node 起真 Hermes + 真 HERMES_HOME、走 magpie 的问句也答出 OK（探针，未留仓库）。
- 乙（用户自己做）：待用户实测。

## Codex 审查

B 档，不跑 Codex 审查。

## 已知缺口

- 聊天页的「聊天模型」下拉只列**已保存**的模型：按规格流程勾选 → 保存选择 → 再选模型；真机脚本照这个顺序走。没有自动保存用户没点保存的勾选。
- 任务行第 ③ 项「调度器与模型的开发、两个替补默认从 magpie 的模型里选」：K10a 面板本来就从 DSH 桌面版读全部网关（含 magpie），这份分支没有改它；也没有替用户把真实调度器配置里的默认值改成 magpie（那会写用户真实配置，规格里没有这条验收条件）。需要改默认值时，用户在驾驶舱「调度器与模型」里选，下一棒生效。
- 真机里 Hermes 只有用临时 HERMES_HOME 才起得来（见上）；用户真实桌面版由用户自己那一步验证。

## 用户接受

未发生（用户用过并认可之后才写）。

## 整合方复审（2026-11-02，接力第 83 棒）

两支一起复审、一起并入 main，结论和改动写在 [SUB1b](SUB1b.md) 末尾。本支源码没改；补了一条测试（换 Key 也重开 Hermes 进程），`sub1-magpie-preset` 的界面数据改用 `magpieUrl`。真机甲项整合方在最终代码上重跑通过（聊天模型 `opencode-go/deepseek-v4.1-flash` 经 Hermes 答出 OK）。任务行第 ③ 项没做，归第 161 行 MG2。
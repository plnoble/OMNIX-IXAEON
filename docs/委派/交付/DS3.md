# 交付：DS3 —— 多轮 IR 接线（保守方案，统筹 §8 定稿）

- 分支：`dev2/DS3`，基线 = main `0cafc37` + `origin/dev2/DS2`（merge 进来，DS2 未并 main 前类型可用）
- 档位 **B**（改变发给模型的输入组织）；执行方：dev2（窗口）
- 依据：统筹 2026-10-27 任务书 §8「选择保守方案」——**不改 `ModelProvider` 公共接口**、
  不迁移那 6+ 组既有测试、不扩大 Provider Contract。

## 一、已实现

- `packages/core/src/model/render.ts`（新增 107 行，纯函数）：
  - `renderConversation(conversation, rules?)` → `RenderedConversation`
    （角色/文本/reasoning 渲染后文本/toolCalls/toolCallId 全保留）。
    **两段式**：第一段只校验（孤儿 tool 结果——引用了没有 assistant 声明过的 call——先抛）；
    第二段产出时按 §RFC-002 四态渲染 reasoning（严格档缺失抛错）。
    **坏结构零输出**：任何一条消息坏了，调用方拿不到半截渲染结果，错误带「第 N 条」可定位。
  - `toProviderPrompt(rendered)` → `{ system, user }`：system 消息进 system；
    其余按顺序转成带角色标记的 transcript 行（`[user] …`/`[assistant] …`/`[reasoning] …`/
    `[tool_call id] name args`/`[tool_result_for id]`）进 user。
    这只服务**现有** `chatText({system,user})`；provider 要保真多轮，应由各自 adapter 读
    `renderConversation` 的结果自己转，不在核心里改接口。
  - provider 中立：文件里不出现任何 provider 专有词。
- 测试 `packages/core/test/acceptance/ds3-render.test.ts`（8 个 it，对应 §8.2 四条验收目标）：
  顺序保真、transcript 顺序可检、四态各验、严格档 missing 抛「第 2 条」、孤儿 tool 抛错、
  合法 tool 往返保留 id、渲染结果真的喂进现有 FakeProvider 且每轮可见、
  **条件 4 钉死旧入口形状不回归**（`textCalls[0]` 仍是 `{system,user}`）。

## 二、自动化通过

```
tsc --noEmit                      exit 0
eslint（render.ts + ds3 测试）     exit 0
vitest acceptance ds3 + ds2       17 passed (17)     ← ds3 8 条 + ds2 9 条同跑，互不回归
接口零改动验证：
git diff origin/dev2/DS2 -- .../provider.ts .../fake.ts   →  0 行
```

本机完整 `verify.mjs`：**未全绿**，失败点与本单无关，证据如下（不硬拗成「通过」）：

```
✗ acceptance（已完成任务的锁定验收测试）
FAIL |acceptance| packages/relay/test/acceptance/l5-init.test.ts > 条件 2
  × 写出的 config.json 形状对… 122321ms
  AssertionError: expected null to be +0
  Error: EPERM, Permission denied: \\?\C:\...\Temp\ixa-l5-trees-...
```

定性证据：该文件**单独重跑 4 passed (4)、38.55s 通过**。完整门禁里它跑到 122 秒才 EPERM，
是 Windows 临时目录句柄释放竞争被并发放大（同类现象此前在 `l6b-launcher`、`l20-init-patch` 出现过，
CI 重跑即绿）。本单只新增 `packages/core/src/model/render.ts` 与一个 acceptance 测试文件，
不在 relay 路径上。已推分支由 **CI（独立 runner）** 复跑完整门禁作最终判定，分支 CI：run 40440940626 首跑因 l10-watchdog（起真进程、时序敏感）失败 1 条、其余 1032 全过；**--failed 重跑后 conclusion=success（全绿）**。CI 是独立 runner，故判定为本机时序偶发而非本单回归。。

## 三、真机 / 独立复审 / 合并

- 真机：**未跑**（纯函数层，无外发；接线进 ask 流程属下一单）。
- 独立复审：**归整合方**（B 档）。
- lock / merge / done：**不做**，等整合方。

## 四、留给整合方的边界声明

1. `toProviderPrompt` 的 transcript 格式是**给现有单入口用的桥**，不是 Provider Contract v2——
   按 §8.2 尾注：多个 provider 证明现有接口真是瓶颈时**另立单**，本单没顺手做。
2. §6 的 Goal Engine **组合真机检查**（建 Goal→子 Goal→Plan→Step→绑真 Todo→完成→weighted→
   failure→watch→blocked→replan→advanceStep→重启仍在）：需 G1a 迁移与锁定完成后才可跑，
   脚本可在放行当天由窗口出。
3. §14 L11 的 `sent` 整表替换缺陷（engine.ts:178/326）维持原判：复审时逐键合并。
4. §10 研究封板确认：后续只做定向补研究/Probe/真实 evidence，不再扩研究面。
5. §11：22-A Source Intelligence Schema 只当规格、实现前先与 GKD §4 对照防第二套模型；
   22-B Capability Registry 遵守 Observed facts only（confidence 字段在 evidence JSON 里
   已声明为 dev2 自评非测量值）；22-D recipe Probe 等放行。

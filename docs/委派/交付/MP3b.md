# MP3b 交付说明（第二支：界面）

规格：[MP3-用途替补.md](../MP3-用途替补.md) 第 9–10 条、验收条件 11–12。分支：`dev/MP3b`，基于 `dev/MP3`。

## 已实现（源码 < 300 行）

- `apps/desktop/src/renderer/src/pages/Models.tsx`：
  - 「用途」卡片里，后台分析、聊天两个用途下面各加一个替补列表：每项「供应商名 · 模型」，有「上移 / 下移 / 删掉」；列表下面一个下拉框 + 「添加」按钮，选项是所有供应商勾选过的模型并去掉主选和已在列表里的，满 4 项时「添加」不可点；
  - 和主选共用「保存」：一次存 `saveModelUses` + `saveModelFallbacks`；主进程拒绝时把提示原样显示；
  - 聊天选「跟着后台分析」时，聊天的替补列表收起，原地写一行「跟着后台分析，替补也用后台分析的」。
  - 约定的 data-testid：`fallback-list-analysis` / `fallback-list-chat`、`fallback-add-analysis` / `fallback-add-chat`（列表项按钮按文字找：上移 / 下移 / 删掉 / 添加）。
- `apps/desktop/src/renderer/src/api.ts`：`api` 改成惰性代理（每次取 `window.ixaeon` 的当前值）。jsdom 验收测试在 import 之后才给 `window.ixaeon` 装桩，原来模块加载时快照成空对象；这一改不影响应用（preload 早已就位）。
- 第 10 条「聊天里带替补提示的回答下面显示那句话 / 模型名显示实际那个」：主进程在 MP3 已把 `notice` 与消息自己的 `modelName` 写好，界面沿用现有展示样式，无需再改。

## 自动化通过

```
$ node scripts/acceptance.mjs run MP3
Test Files  6 passed (6)
Tests  42 passed (42)
```

```
$ node scripts/build.mjs && node scripts/test-e2e.mjs desktop
24 passed (1.1m)
✓ desktop e2e 完成（69.1s）
```

其中 `apps/desktop/e2e/mp3b-fallback.spec.ts`（条件 12）：在「模型」页真实点击配两家供应商、聊天主选、添加替补、保存，然后问一句；对话里出现「这是替补答的回答」和整句「「合成甲 · demo-a」这次不行（额度用完），由替补「合成乙 · demo-b」回答」。

## 真机通过（界面）

`node scripts/real/mp3b-ui-check.mjs`（临时数据目录已遮；两个本机假 OpenAI 服务：一个 429、一个正常）：

```
引擎/模型标签： 引擎 直连 · 模型 demo-b
回答片段： 来自替补的回答「合成甲 · demo-a」这次不行（额度用完），由替补「合成乙 · demo-b」回答；问答已存入 IXAEON 记忆（日常偏好与事实自动沉淀生效；若有冲突或关键决策，将在「待讨论」等你确认）。引擎 直连 · 模型 demo-b使用 0 字符资料
截图: .logs/mp3b-ui-chat.png
```

## 用户接受

未接受。

## CI

`dev/MP3b` @ `3038812` → **success**（run 41961643675，全绿，含 mp3b-ui 与端到端）。

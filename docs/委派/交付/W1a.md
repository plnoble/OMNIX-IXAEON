# W1a 关注方向 交付

- 分支：grok/W1a，基于 main ad8b578；档位 B
- 执行方：Grok
- 历史：第一版只交测试；整合方 2026-09-19 补全重锁后，本版交实现。

## 已实现

研究页顶上「帮我想想该关注什么」：先确认（条数 = 这次会发的记忆条数），点「好」才把有效目标、约束和项目发给 Core 模型（不走 Hermes）。坏形状整次报错。卡片显示对外检索描述、依据原文、预算说明。「关注」建研究主题并启用（一天一次；搜索已配置时预批 3 次）；「不关注」记进 `app_settings`（最多 200 条）。相似方向（字符二元组 Jaccard ≥ 0.6）和已有研究主题不再显示。

代码 300 行（`git diff --stat origin/main`，不含本文件）：`watchDirections.ts` 122、`Research.tsx` 95、`appRuntime.ts` 56、`ipc.ts`（契约）18、preload/ipc 各 4、core index 1。

提示词（system，全文）：

```
从目标、约束、项目提炼 3–5 个持续关注方向。question=内部问题（可带用户背景）；publicDescription=对外检索描述，不许含个人信息（人名/项目名/公司/地名/习惯），只写公开技术词；why=记忆 UUID 数组。只返回 JSON：{"directions":[{"question":"…","publicDescription":"…","why":["…"]}]}
```

user：`目标与约束（UUID｜类型：原文）` + `在做的项目：- 名称：描述`。与规格不一样的地方：无。

## 验收测试

锁定测试未改。`w1a-suggest-topics-page.test.ts` 条件 1、3；`w1a-suggest-topics.test.ts` 条件 2、4、5。

## 自动化通过

- `node scripts/acceptance.mjs run W1a`：12/12 通过。
- `node scripts/verify.mjs`：全部通过。
- GitHub CI：推送后看。

## 真机通过

没跑。规格要求用真 Core 模型走一遍提方向。本机模型 Key 在 Electron `safeStorage` 里，非 Electron 进程解不开（DPAPI 直接解 `v10` 块失败）；没有把 Key 写进环境变量、没有打印。检查脚本 2026-09-20 补提交到 `scripts/real/w1a-watch-directions.ts`（规矩澄清前为卡行数未入库；无 Key 时退出码 2、只报原因）。锁定测试覆盖了发给模型的内容与卡片行为。

## 已知缺口

- 本机拿不到可用的模型 Key，真模型这一步没跑成（上面如实记录）。
- GitHub CI：推送后看。
- 用户接受：未发生（B 档）。

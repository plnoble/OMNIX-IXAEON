# IXAEON v0.2 三次复审：1dad8d4

日期：2026-09-08。审核提交：`1dad8d49360c1ee31dfa905bdb0717fe4ce421cd`。

对照：[上轮 F01–F03 报告](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_v0.2_二次复审报告_2026-09-07.md)。本轮复核修复及相邻操作，没有重新扩大功能范围。

## 1. 结论

**上轮 F01–F03 可以关闭；但完整 v0.2 验收还剩两个 P2 收尾问题，以及此前已明确保留的真实环境验证。**

原先“选一次项目，就把人工要求或冲突的待处理状态擦掉”的问题，在本轮已测场景中修好了。原因集合、共用规则、来源重绑范围及保守迁移的方向成立，不需要推翻。

补查发现的问题，用通俗的话说：

- **N01：你已经纠正了一条内容，旧内容却还留在待讨论里，继续让你处理。**
- **N02：你点击“暂不处理”，某些条目却原样不动，也没有任何暂缓效果。**

这不是又发现两个资料丢失问题，而是“处理完”和“暂时放一边”两个操作没有完整接上新规则。下一批只需集中修这两处，不要重做已通过的模块，也不要混入 Door 等新功能。

## 2. 本轮独立验证

以下为本轮实际运行结果，不是转抄交付摘要。

| 检查                           | 结果           | 证据边界                                                                              |
| ------------------------------ | -------------- | ------------------------------------------------------------------------------------- |
| 完整 `node scripts/verify.mjs` | 14 步通过      | 234 项单元／集成／审核回归，另有 UI01／BUI01／BUI02 三项真实 Electron 检查，共 237 项 |
| 上轮 round2 检查               | 11/11 通过     | 含原四个失败场景及 F01-a／b／c，已在默认 verify 中                                    |
| 桌面 E2E                       | 16/16 通过     | 真实 Electron，含已有 m2-ui 场景                                                      |
| 扩展 E2E                       | 通过           | 本地受控网页，不等于真实 ChatGPT 网站                                                 |
| 真扩展→服务→SQLite 串联        | 通过           | 合成数据，包含采集、增量及暂停／继续等已有场景                                        |
| 当前 win-unpacked 产物         | 3/3 通过       | 自定义目录、重启保留、搬迁后无全局 Node 的 MCP 调用与持久化回写                       |
| 新增核心相邻场景               | 3 通过、2 失败 | 确认／不采纳后重绑、真实迁移执行器通过；两种纠正后待处理清理失败                      |
| 新增 Electron 相邻场景         | 2 项失败       | 真实点击“暂不处理”无效果；纠正后重新进入 Inbox，旧条目仍在                            |

新增检查使用独立配置，尚未纳入默认 verify。因此“原有回归全绿”和“补查发现失败”并不矛盾；四个失败用例对应两个问题，不是四个独立故障。

安装包已独立核对，与交付说明一致：

- [IXAEON-Setup-0.2.0.exe](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/release/IXAEON-Setup-0.2.0.exe)
- 大小：122,597,406 字节。
- SHA-256：`43BFE97C0DDCCC8D3EBA866D455779AD3E8FED5C96FCA3F23C0784902EA97F28`。

本轮没有执行安装器。解包产物能运行，不代表安装、覆盖升级、卸载流程已经验收。

## 3. F01–F03 的关闭依据

**F01：已测要求通过。** 两个归属入口共用 `syncDerivedNeedsReasons`；人工显式原因与人工约束冲突不会因选项目而消失；人工单独搬走的条目不被来源重绑顺带修改。原四项失败场景及附验均转绿。

另补了两项对照：确认、不采纳后，再做来源重绑和条目归属，不会把已解决的重要 AI 条目重新送进待讨论。

迁移方面，除原 F01-c 外，本轮用带有三条合成旧数据和迁移账本的 v8 数据库，实际调用生产 `migrate()` 升至 v9；验证旧待处理／冲突得到保留、旧非待处理行保持为空，再调用一次也不重复执行或改动数据。**这补强了迁移执行器的证据，但不替代真实用户旧库及安装升级测试。**

**F02：文案已更正，可以关闭。** [隐私说明](D:/Agent/Project/OMNIX-IXAEON析衍/docs/privacy-model.md:48)已明确 MCP 不逐次弹确认或展示范围，不再承诺不存在的界面保护。

**F03：记录已如实更正，可以关闭。** [开发日志](D:/Agent/Project/OMNIX-IXAEON析衍/docs/dev-log-fixes.md:896)及 [REVIEW_PACKET](D:/Agent/Project/OMNIX-IXAEON析衍/REVIEW_PACKET.md:289)已承认历史 UI 上下文丢失，没有重造证据。该关闭结论不代表丢失文件已恢复。

## 4. 交给修复 agent 的两项任务

### N01 · P2 · 纠正完成后，旧条目的待处理原因没有退出

位置：[ItemService.correct](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/itemStore.ts:155)、[Inbox 查询](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Inbox.tsx:12)。

`correct()` 把旧条目标为 `superseded` 并创建新条目，但没有清理旧条目的 `needs_reasons` 和对应的 `needs_review`。Inbox 又只筛选待处理、未搁置，没有排除已被替代的历史条目。

已复现：

1. **L01**：未确认 AI 决定“先采用方案甲”被纠正为“改用方案乙”。旧条目的替代状态和新内容正确，但旧项仍有 `unconfirmed`，`needs_review=true`，仍出现在 Inbox 查询结果中。
2. **L02**：与人工约束冲突的候选，再被用户显式置为待处理，随后纠正。旧项已经 `superseded`，但仍保留 `conflict,manual`。
3. **LUI02**：通过真实 MCP 写入待确认工作记录，经公开 IPC 纠正，再离开并重进 Inbox。加载完成后，旧记录仍显示“确认正确／不采纳／暂不处理”。此用例验证的是 IPC 纠正与真实页面联动，不冒充手工填写纠正表单。

影响：用户已经处理的旧内容继续占据待讨论列表；旧项又已不能正常确认／不采纳，形成无意义的重复处理。现有证据没有显示原始资料或改口历史丢失。

修复要求：

1. 在现有纠正事务中，让**被替代的旧条目**退出待处理；同步原因集合和物化标记。保留旧内容、纠正链、来源及历史记录，不得靠删除旧条目解决。
2. 明确 Inbox 的可处理范围，避免历史 `superseded` 条目继续进入操作队列；不能因此把历史查询中的旧条目全局隐藏。
3. 考虑本版本已产生的历史残留。可以对 Inbox 做兼容过滤，或采用有针对性的后续迁移；如需迁移应新增版本，不修改已经发布执行过的 Migration 9，也不能清空所有待处理状态。
4. 确认纠正后的新条目及其他尚未解决的冲突，不会被连带清除。再次归属或重绑，也不能让旧历史条目重新成为待处理事项。

验收：L01、L02、LUI02 转绿；新增重启／重新归属后的检查；连续纠正、重提保护、人工确认和不采纳回归继续通过。

### N02 · P2 · “暂不处理”仍调用旧入口，已不能表达暂缓

位置：[Inbox 按钮](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Inbox.tsx:92)、[setPendingReview](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/itemStore.ts:284)。

按钮仍调用 `setItemPendingReview({ needsReview: false })`。新后端契约是：移除 `manual`，再重算派生原因；不会移除尚未确认或冲突的原因。这对“只解除人工标记”是合理的，但已不能实现按钮文字所说的“暂不处理”。

**LUI01 已真实点击复现**：通过 MCP 写入一条待确认工作记录，进入 Inbox 点击“暂不处理”，条目仍原样显示，没有暂缓状态或提示。数据库中条目没有删除，也没有被确认；失败点就是按钮没有实现预期动作。

同样的入口问题从代码上也适用于仍有 `unconfirmed`／`conflict`／`no_project` 原因的其他条目；本轮真实 UI 实测对象是工作记录，不声称逐类都点过。

修复要求：

1. 把“暂时不看它”与“问题已经解决”分开。暂缓应有实际且可见的效果，不得用确认、不采纳、删除记录来冒充。
2. 优先评估复用已有 [shelveItem](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/ipc.ts:307) 搁置能力，不需要新建任务调度框架；若采用搁置，须提供能找回并恢复的界面入口。
3. 保留未解决的原因以及 `confirmation=none`。**不要把 `setPendingReview(false)` 改回无条件清空全部原因**，否则会破坏本轮刚通过的 F01-a 语义。
4. 处理失败应有错误反馈。刷新、重进、重启后仍能理解并恢复暂缓状态；恢复后，未解决的内容应回到待处理范围。

验收：LUI01 转绿，并补真实界面的暂缓→重进／重启→恢复检查，核实原因及确认状态未被篡改。现有 LUI01 只是最低复现检查，单靠把条目藏起来、却再也找不回来，不算修复完成。

## 5. 可复跑证据

- [核心检查源码](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/needs-lifecycle-20260908.test.ts)
- [核心最终结果：3 通过、2 失败](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-needs-lifecycle-20260908-checked.json)
- [Electron 检查源码](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/needs-lifecycle-ui-20260908.spec.ts)
- [LUI01 失败上下文](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/.needs-lifecycle-ui-20260908-checked/needs-lifecycle-ui-2026090-2a34b-pretending-it-was-confirmed/error-context.md)
- [LUI02 失败上下文](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/.needs-lifecycle-ui-20260908-checked/needs-lifecycle-ui-2026090-e3ec7-or-must-not-remain-in-Inbox/error-context.md)

最终判据使用以上 `checked` 结果。初次核心测试有辅助函数导入错误，初次 UI 测试有未等待列表加载的断言问题；均已修正并重跑，初次文件保留，但不作为产品通过／失败依据。

在项目根目录依次运行，修复后使用新的结果文件和 UI 输出目录，勿覆盖本轮失败证据：

```powershell
node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.needs-lifecycle-20260908.config.ts --reporter=json --outputFile=apps/desktop/test/review/results-needs-lifecycle-20260908-fixed.json
node apps/desktop/node_modules/playwright/cli.js test -c apps/desktop/test/review/playwright.needs-lifecycle-20260908.config.ts --output=apps/desktop/test/review/.needs-lifecycle-ui-20260908-fixed
node scripts/verify.mjs
node scripts/test-e2e.mjs
```

修复 agent 应把这些场景纳入默认持续回归，再重建候选产物、核对哈希，并运行已有 `packaged-20260905.mjs` 产物检查。UI 测试前核实 `43191` 没有其他服务占用，不要强杀未知进程；健康检查超时不能单独证明端口空闲。

## 6. 下一步与 v0.3

原 F01 的 P1 门槛已解除。建议下一批只收尾 N01／N02，然后进入此前约定的真实环境验收，而不是继续扩写一套大架构。

仍未完成的条件保持不变：

1. 在可恢复备份／隔离副本上完成非空真实旧库升级，确认资料、纠正链、授权及配置保留。
2. 真实安装和升级流程验证，而不只是运行 win-unpacked。
3. 真人使用真实网页、模型及编码客户端，走完“采集→理解／纠正→提供背景→工作回写”的闭环。

这些完成前，可以继续整理 v0.3 方案，但不能把当前自动化结果写成“v0.2 已完成全部实际验收”。准入条件继续沿用 [全项目审核报告](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_全项目审核与v0.3准入条件_2026-09-06.md)，本轮不另加新功能门槛。

本轮仅新增审核测试、输出证据和本文，未修改业务源码，未提交代码，未运行安装器、真实模型或真实聊天采集，也未操作用户真实数据库。原有扩展／串联脚本重建了已核实的专用临时目录，旧合成测试数据被替换，不涉及用户资料；此前审核证据未主动删除。

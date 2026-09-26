# N2 Codex 审查

- 时间：2026-09-26T22:40:40.447Z
- 分支：grok/N2（0c3c41e），对照 docs/委派/N2-研究页显示判定和理由.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/src/research/requirements.ts:82`：每个查询结果都用 `groups.find` 扫描已有分组，F 条发现、R 条要求产生 O(F²R) 的分组开销；该查询同步运行于主进程，历史发现较多时会阻塞界面，应改用 Map。
- 必须改｜`docs/委派/交付/N2.md:26`：完整 diff 没有新增验收测试的锁定清单登记，也没有 `acceptance.mjs run N2` 的执行结果；直接运行六条测试不能替代仓库规定的锁定验收流程。
- 必须改｜`packages/core/test/acceptance/n2-finding-judgments.test.ts:83`：“没有要求”用例也没有任何发现，即使错误地为无要求主题返回发现分组，这个测试仍会通过；需补充“有发现、无要求”的断言，落实验收条件 2。
- 必须改｜`docs/委派/交付/N2.md:35`：完整 verify 尚有失败，预计 CI 不占端口不能替代通过证据；需在隔离环境补跑并记录结果。需要人工确认：待合并分支的 GitHub verify 是否全绿。
- 建议｜`apps/desktop/test/acceptance/n2-finding-judgments-page.test.ts:130`：仅检查整个详情区的文本，且“看不出来”的理由与判定文案相同，漏显示该理由或配错要求仍能通过；应使用不同的理由文本，展开后逐项核对要求、判定和理由。
- 建议｜`packages/contracts/src/config.ts:111`：共享模块新增顶层 `process.env` 读取；需要人工确认：该模块是否进入没有 `process` 的渲染端，否则会在加载时抛出异常。端口转换也应校验，避免空字符串变成随机端口所用的 `0`。

结论：需要修改

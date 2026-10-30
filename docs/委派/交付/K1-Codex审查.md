# K1 审查（Codex 额度用完，由 Claude 代审）

- 时间：2026-10-30T13:51:40.645Z
- 分支：dev/K1（d84bcc0），对照 docs/委派/K1-项目清单导入.md
- 审查者：Claude（2.1.312）；上下文由脚本喂入（不让审查者跑命令）
- 花费：0.294545 美元

- 建议 `packages/core/src/projectImport.ts:57-59` 与 `:95`：库里匹配用 SQLite 的 `lower()`，它只处理 ASCII 字母；清单内去重用 JS 的 `toLowerCase()`，它也处理非 ASCII 字母。对 `É`/`é` 这类名字，两边判断不一致：清单内会当成重名，库里却匹配不上，可能被当成新项目去 `create`。现有清单以中文为主，影响不大，最好统一用同一套口径。
- 建议 `packages/core/src/projectImport.ts:37`：`root_path: ""` 会被 `min(1)` 拒掉，但给出的原因是「root_path 必须是字符串」，和实际原因不符，用户看预览时会困惑。
- 建议 `packages/core/src/projectImport.ts:162-180`：`createMany` 如果对某条 `root_path` 抛错（比如相对路径、格式不被接受），整个事务会回滚，界面只能看到报错。plan 只预判了两类冲突：目录已登记给别的项目、清单内目录重复。`ProjectService.create` 是否还有别的拒绝条件，需要人工确认：是否还有别的拒绝条件（绝对路径、规范化、`stat` 是否存在）；如果 `create` 会 `stat` 目录，还要确认这是否算「读取目录」。
- 建议 `packages/core/test/acceptance/k1-project-import.test.ts:281-298`：条件 8 只断言了 `description` 不变。约束写的是「已有项目别的字段一律不动」，建议同时断言已有项目带 `root_path` 时，`root_path` 也不被改动（可以直接比较整行，只排除 `status` 和 `updated_at`）。
- 建议 `docs/委派/交付/K1.md:73`：「情况 1」应为「条件 1」；文中贴的 diff stat 是 5 个文件、534 行，实际分支是 6 个文件、620 行（多了交付说明本身），建议更新。
- 需要人工确认：规格要求的真机检查（5 条合成清单、预览截图和导入后的项目页截图）没有出现在本支的交付说明里，只引用了 `K1b.md`，而 `K1b.md` 不在这次审查材料中。合并前要核对 `K1b.md` 里确实贴了原样输出和截图，并且截图和输出里没有本机账户名路径。
- 需要人工确认：交付说明写明「GitHub 上的 verify 没看」。按 AGENTS.md，A 档要 CI 绿才能自己合并，合并前要确认分支 CI 是绿的。
- 需要人工确认：`ProjectService.updateStatus(id, 'archived')` 有没有附带副作用（比如撤销授权、改别的字段）。这次改动里看不到；如果有，条件 2「A 是 archived」之外可能还会动到别的数据。

结论：可以合并

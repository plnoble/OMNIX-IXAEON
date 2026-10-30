# K1 审查（Codex 额度用完，由 Claude 代审）

- 时间：2026-10-30T13:41:01.186Z
- 分支：dev/K1（0dc6ed2），对照 docs/委派/K1-项目清单导入.md
- 审查者：Claude（2.1.312）；上下文由脚本喂入（不让审查者跑命令）
- 花费：0.3053032 美元

- **必须改**：`docs/委派/交付/K1.md` 第 79 行写的是「预览后到确认前如果库被别人改了，`apply` 会按确认时的库重新算一遍（不照旧预览盲写）」，代码里没有这件事。`packages/core/src/projectImport.ts` 第 155–178 行的 `applyProjectImport` 一次库都不读，直接照传进来的 `plan.create` / `plan.update` 写。第 172 行的 `item.project.status === item.status` 比的是预览时存下的旧快照，不是确认时的库。这句交付说明不实。两种改法：在 `apply` 里真的按当前库重算；或者如果重算其实是 K1b 的 IPC 在确认时重新调了 `planProjectImport`，就把说明改成照实写在哪一层做的。需要人工确认：K1b 的确认流程是不是重新 plan。
- **建议**：`packages/core/test/acceptance/k1-project-import.test.ts` 第 84–92 行和第 115–130 行，条件 2 测「C 新建且状态对」时，清单里 C 的状态是 `active`，正好是 `create` 的默认值。所以 `projectImport.ts` 第 166–169 行「新建后按清单改状态」这段测试没跑到。没跑到的话，这段代码出错，条件 2 的测试也照样会过。建议补一条：新建项目的状态设成 `paused` 或 `archived`，再断言建出来就是这个状态。（规格没写 C 是什么状态，所以算「建议」。）
- **建议**：`packages/core/src/projectImport.ts` 第 58–59 行，`sameNameRows` 把 `SELECT *` 的原始行直接当成 `Project` 用，放进 `unchanged` / `update.project` 给预览显示。如果 `ProjectService` 读出项目时对字段做过转换（比如可选列、JSON 列），这里的形状会和 `ProjectService.get` 返回的不一样。建议匹配到唯一一行后，用 `ProjectService.get(id)` 再取一次。需要人工确认：`ProjectService` 读出项目时有没有做字段映射。
- **建议**：`packages/core/src/projectImport.ts` 第 117 行，`seen.set` 放在 `root_path` 检查的前面。一条新项目如果因为目录冲突进了「无效」，后面同名的条目给的原因会是「第 N 条已经用过」，可那第 N 条自己也是无效的，用户看了容易糊涂。建议把 `seen.set` 挪到真正收下这一条之后。
- **建议**：`packages/core/test/acceptance/k1-project-import.test.ts` 第 199–226 行，条件 7 用的是替身库。替身库里任何含 `lower(name)` 的查询都返回两行，所以这条测试只证明了「查出多于一行就进无效」这一个分支。另外，SQLite 的 `UNIQUE` 默认区分大小写，真库里 `E` 和 `e` 可能并存（比如早年的数据）。如果能这样造出两行，建议改用真库直接插入两行来测，这样「两个 E 都不变」也能在真库上验证。需要人工确认：`projects.name` 的约束和排序规则。
- **建议**：`applyProjectImport` 完全信任传进来的 plan，包括 `project.id` 和 `status`。如果 K1b 让 plan 从渲染进程经 IPC 原样传回主进程，渲染进程就能改掉任意项目的状态，绕过「不改清单里没有的项目」这条约束。需要人工确认：K1b 是不是在主进程里根据清单重新算 plan，而不是收渲染进程传回来的 plan。
- 需要人工确认：这一支本身没有可以点的界面，规格要求的真机检查（5 条合成清单、两张截图）写在 `K1b.md` 里，这次给我的材料里没有。按 AGENTS.md「没跑的不能合并」，要先核对 K1b.md 里确实贴了原样输出、截图路径，并且没有带出本机账户名。

结论：需要修改

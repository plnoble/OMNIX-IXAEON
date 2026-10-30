# K1 审查（Codex 额度用完，由 Claude 代审）

- 时间：2026-10-30T13:47:02.988Z
- 分支：dev/K1（d6df27a），对照 docs/委派/K1-项目清单导入.md
- 审查者：Claude（2.1.312）；上下文由脚本喂入（不让审查者跑命令）
- 花费：0.3655018 美元

- **必须改** `packages/core/src/projectImport.ts:115-120`：条目匹配到库里已有项目时直接 `return`，没有执行第 144 行的 `seen.set(key, index)`。所以清单里同一个已有项目出现两次（例如库里有 A，清单写 `{A, archived}`、`{A, paused}`）时，两条都会进 `update`，`apply` 依次改两次状态，最后一条生效。这违反条件 3「清单内 name 重复进无效」。应在匹配已有项目（以及进「库里多个同名」无效）之前就记名字。
- **必须改** `packages/core/test/acceptance/k1-project-import.test.ts:149-172`：条件 3 的重名用例只测了「两条都是新项目」，没覆盖「重名的是库里已有项目」。上面那个 bug 因此没被测出来。应补这一情形，重新 `lock`。
- **必须改** `packages/core/test/acceptance/k1-project-import.test.ts:213-237`：条件 7 要求「两个 E 都不变」，测试只在 `planProjectImport` 之后比了快照，没有调用 `applyProjectImport`。确认导入后两个 E 是否不变，测试没有验证。应在清单里加上 E 和其他条目，执行 apply 后再断言两行都不变。
- **必须改** `packages/core/test/acceptance/k1-project-import.test.ts:197-211`：条件 6（不产生 `project_snapshot` 来源）用的 `listABC` 里没有任何 `root_path`。真正可能触发目录登记读取的路径（带 `root_path` 的新建）没被测到，这条测试实际等于空测。应让清单里的新项目带合成的 `root_path`（用 `tmpdir` 下现建的目录），再断言 `project_snapshot` 数量为 0；最好同时断言没有新增目录读取授权。
- **需要人工确认**：`ProjectService.create` / `createMany` 带 `rootPath` 时会不会顺带授予目录读取权限，或者排队生成快照。diff 里看不到；如果会，就违反「root_path 只登记」的约束。
- **需要人工确认**：`projects.name` 是否确实是区分大小写的 `UNIQUE`（没有 `COLLATE NOCASE`）。条件 7 的测试和交付说明里的解释都建立在这个前提上。
- **需要人工确认**：K1b.md 里规格要求的真机检查（5 条合成清单、预览弹窗和导入后项目页的截图）是否已经跑过、输出是否贴了，且不含账户名路径。本支交付说明只引用了 K1b，按「没跑的不能合并」，K1 合并前应先确认这一点。
- **建议** `docs/委派/交付/K1.md:17-24`：贴的 stat 写的是 `projectImport.ts` 179 行、测试 254 行，实际 diff 是 180 / 267 行，说明测试在出 stat 之后又改过。请更新 stat，并确认 `锁定验收.json` 里的指纹是对最终版本测试文件算的（`acceptance-lock` 能拦住，但交付说明应如实）。
- **建议** `packages/core/src/projectImport.ts:62-68`：`rootOwner` 只做 `lower()` 比较。如果 `ProjectService.create` 对路径做了规范化（分隔符、末尾斜杠、`resolve`），预览会漏判目录冲突，`apply` 时 `create` 抛错，整个事务回滚。建议复用 `ProjectService` 的同一套规范化逻辑（需要人工确认它是否有规范化）。
- **建议** `packages/core/src/projectImport.ts:58` 与 `:96`：SQLite 的 `lower()` 只转换 ASCII，JS 的 `toLowerCase()` 会转换 Unicode，两边对非 ASCII 字母大小写的判重口径不一致。中文名不受影响，可以统一成一种口径。

结论：需要修改

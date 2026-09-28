# D4 Codex 审查

- 时间：2026-09-28T11:22:29.578Z
- 分支：grok/D4（6634a9e），对照 docs/委派/D4-接受后在项目里建分支.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:552–581`：目录换文件并不必然写入失败，先删除旧文件和空目录即可成功；当前测试会拒绝合法实现，也无法证明失败发生在工作树建立之后。应注入确定的写入故障再验证清理。
- 必须改｜`apps/desktop/test/acceptance/d4-landing-report.test.ts:190`：直接调用新增的 `runtime.acceptCodingTask`，没有覆盖实际 IPC 接受入口；即使现有 IPC 仍调用 `runtime.coding.accept`、用户点击后没有对话回报，这些测试也能通过。
- 必须改｜`apps/desktop/test/acceptance/d4-landing-report.test.ts:202–207`：列表对象包含字段不能证明任务页显示了落地结果；页面完全不渲染分支、改动包和错误原因也能通过，遗漏契约 6 的界面要求。
- 必须改｜`apps/desktop/test/acceptance/d4-landing-report.test.ts:221–223`：失败回报只检查固定短语和任务 id，没有核对失败原因、实际改动包路径及追加行为；缺少原因、路径错误或覆盖原回报均可能通过。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:305–309`：三点差异比较不能证明分支从接受时的当前 `HEAD` 建立；缺少“派发后提交其他文件”的成功场景，使用过期基线、遗漏用户新提交的实现仍可能通过，应核对新提交的父节点。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:390–396`：派发和接受始终使用同一个实例，没有验证契约 3 要求的原始指纹持久化；仅在内存保存指纹的实现也能通过，应覆盖重新加载任务后接受的场景。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:381–422`：冲突测试只涉及原有文件，没有覆盖“原本不存在的新文件在派发后被用户提交”；遗漏契约 3 的不存在基线，忽略新增路径冲突并覆盖用户文件的实现仍能通过。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:227–236`：测试自行固定了 `manifest.json` 及四个字段，规格只规定清单内容，未规定此格式。需要人工确认：整合方是否批准了这个新增输出接口；未经确认不应将其锁成验收条件。

结论：需要修改

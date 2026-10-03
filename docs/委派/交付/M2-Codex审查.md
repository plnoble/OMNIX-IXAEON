# M2 Codex 审查

- 时间：2026-10-03T01:56:16.064Z
- 分支：prep/M2（bf24ba5），对照 docs/委派/M2-模型管理-检测勾选保存.md
- Codex：0.159.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/renderer/src/pages/Settings.tsx:439`：检测与保存可同时执行，检测回调使用旧的 `savedSet`；检测期间刚保存的模型若从上游消失，会被清除勾选，下一次保存便误删。应协调两项操作，避免旧响应覆盖最新状态。
- 必须改｜`apps/desktop/test/acceptance/m2-settings-ui.test.ts:170`：直接设置 `checked` 再派发 `change` 不会触发 React 复选框的 `onChange`，因此“勾选后重检消失”的测试实际上没有更新勾选状态，存在空测。应模拟真实点击并验证勾选确实生效。
- 必须改｜`docs/委派/锁定验收.json:302`：缺失模型的「上游已没有」标记等验收断言仅存在于未登记的 E2E 文件中，当前锁定验收未完整覆盖规格。应将这些断言纳入锁定验收。
- 建议｜`apps/desktop/e2e/m2-model-ui.spec.ts:142`：清单始终挂载且此时已经可见，等待其可见不能证明重新检测完成；紧接着同步检查 `auths` 会产生竞态。应等待本次请求完成或轮询请求记录。
- 建议｜`docs/委派/交付/M2.md:10`、`packages/contracts/src/config.ts:32`：仍声称保存选择时更新时间，实际实现是在检测成功时更新、保存时保持不变，需统一说明。
- 建议｜`docs/委派/交付/M2.md:42`、`:60`：需要人工确认：未提供的既有 Key 测试确实覆盖地址变化、空 Key 保存和保密要求，以及最新提交的 GitHub verify 已通过。

结论：需要修改

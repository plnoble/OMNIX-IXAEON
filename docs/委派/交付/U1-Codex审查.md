# U1 Codex 审查

- 时间：2026-09-20T03:41:58.518Z
- 分支：grok/U1（d3b6788），对照 docs/委派/U1-研究页忙状态.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改：`apps/desktop/src/renderer/src/pages/Research.tsx:196`：检查 IPC 返回后仍要等 `reload()` 完成才清除检查提示；列表刷新慢或挂起时，会继续显示“正在检查”，甚至误报五分钟未返回，违反验收条件 2。应独立结束检查等待，并补充刷新尚未返回的测试。
必须改：`scripts/real/u1-research-busy.ts:74`：`CREATE_DURING` 在 `await click()` 后才采样，立即失败的检查此时可能已经结束，无法证明交付说明所称的“检查中、全程可点”。需在点击前建立状态观察，记录实际等待期间创建按钮是否被禁用，重跑并更新交付记录。
结论：需要修改

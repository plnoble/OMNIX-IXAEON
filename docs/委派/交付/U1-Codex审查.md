# U1 Codex 审查

- 时间：2026-09-20T03:17:07.537Z
- 分支：grok/U1（45d919b），对照 docs/委派/U1-研究页忙状态.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/renderer/src/pages/Research.tsx:163–170`：`topicAct` 的调用方均未传入 `label`，启用、暂停、改预算、加来源等操作失败时，错误提示不带主题名，违反契约 5。
- 必须改｜`apps/desktop/src/renderer/src/pages/Research.tsx:194–203`：成功路径没有校验请求顺序。停止等待后再次检查同一主题，旧请求若最后返回，会覆盖新检查的搜索结果及降级提示，甚至清掉新检查的警告；应防止旧结果覆盖新结果，同时保留后台完成后的列表刷新，并补乱序返回测试。
- 必须改｜`apps/desktop/src/renderer/src/pages/Research.tsx:103–120`：计时按回调次数累加，且其他主题开始或结束检查都会重建定时器，推迟已有主题的计时；后台节流或休眠也会让五分钟提醒严重延后。应按各主题实际开始时间计算经过秒数。
- 建议｜`apps/desktop/test/acceptance/u1-research-busy.test.ts:230–234`：空 `error` 只测试了从未显示提示的主题乙，删除实现中的旧提示清理逻辑仍能通过；补充同一主题先返回降级、再返回空错误的场景，并验证警告样式。

结论：需要修改

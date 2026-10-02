# A4 Codex 审查

- 时间：2026-10-02T11:58:19.264Z
- 分支：prep/A4（49bccad），对照 docs/委派/A4-切回来接着看还在写的回答.md
- Codex：0.159.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改：`docs/委派/交付/A4.md:127、183–185`——验收文件实际有 7 条用例，原样输出仍是 `6 tests`，最终摘要也混写 6 条和 7/7。需要人工确认：最后一次修改后是否重新通过验收、verify 和分支 CI；请追加对应版本的原样结果。
必须改：`apps/desktop/src/renderer/src/pages/Ask.tsx:149`、`apps/desktop/src/main/appRuntime.ts:755`、`packages/core/src/extraction/model/fake.ts:18`——源码合计新增 91＋3＋8＝102 行，超过规格的 ≤100 行限制；精简重复注释和未使用的 `joined` 标记即可缩回约定范围。
结论：需要修改

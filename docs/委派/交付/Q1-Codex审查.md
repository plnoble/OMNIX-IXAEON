# Q1 Codex 审查

- 时间：2026-10-19T23:06:01.139Z
- 分支：grok/Q1（829a615），对照 docs/委派/Q1-真机脚本体检.md
- Codex：0.163.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改：`scripts/real/a5-model-failure-real.mjs:72–80`、`scripts/real/v1-verify-electron.mjs:60–68` 等启动环境仍缺随机端口、`IXAEON_EMBED_MODEL=none`、`IXAEON_CODEX_EXE=none`，未落实规格第 3 步明确要求的隔离配置；应补齐并重跑。
- 必须改：`docs/委派/交付/Q1.md:66` 自行以“不是 node 脚本”为由豁免 G06 的 `RESULT`；规格第 4 步覆盖所有甲类，没有此例外，应让 Playwright 的最终结果也输出与退出码一致的 `RESULT`。
- 必须改：`scripts/real/s3b-agent-sessions-ui.ts:142–145`、`scripts/real/d7-model-executor.ts:134–137` 直接打印未遮罩的异常；临时文件读写失败时，错误对象会包含绝对路径和本机账户名，成功运行的输出扫描不能覆盖这个泄露路径。
- 必须改：`scripts/real/d4-landing.ts:166–177` 用 `git show HEAD:note.txt` 判断“用户版本没有被覆盖”，实际检查的是提交内容；即使工作区文件被错误覆盖也会通过，应同时核对工作区文件。
- 必须改：`scripts/real/s3b-agent-sessions-ui.ts:119–140` 仅检查估算、导入提示非空及任意来源行存在；“估算失败”等错误文字同样满足条件，不能证明合成会话估算和导入成功，应核对实际估算值、导入成功数量及对应来源。
- 必须改：`scripts/real/w2-chinese-display.ts:197–211` 仅匹配一个原文字符串便宣称原摘录可见，且 `OVERVIEW_BLOCKS` 的过滤条件恒真、始终打印两个区块名；应分别验证原标题和摘录，并从实际 DOM 获取区块，避免缺失内容仍输出通过证据。
- 必须改：`docs/委派/交付/Q1.md:757` 明知 `d2-e4-node-test.mjs` 留有写死的本机路径却按戊类豁免修改；规格要求路径改为现算，实验记录“不运行”并未豁免这一要求。
- 必须改：`docs/委派/交付/Q1.md:72` 将承担安全核对的批跑器留在未提交的 `.logs/`，违反真机检查脚本须提交到 `scripts/real/` 的约定；同时 `s3a-synthetic-list.ts:69–95` 没有所声称的 `IXAEON_DATA_DIR` 赋值，需更正核对说明。需要人工确认：批跑器是否曾在启动环境中补设该变量。
- 建议：`scripts/real/n1-matched-findings.ts:97–101、160–161` 的启动和首次设置位于异常处理之外，这些步骤失败会绕过末尾 `RESULT`；建议统一处理完整运行过程的失败输出。
- 建议：`docs/委派/交付/Q1.md:109–118` 需要人工确认：是否在运行甲类脚本前，对最新 `origin/main` 执行了 `node scripts/build.mjs`；现有记录不足以确认运行的 `out/` 对应本轮代码。

结论：需要修改

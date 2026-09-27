# M1 Codex 审查

- 时间：2026-09-27T05:38:45.014Z
- 分支：grok/M1（7d3a098），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改｜`packages/core/src/extraction/model/openai.ts:398–403`：跨读取的 CRLF 处理检查了拼接后整个 `buffer` 的开头。若前一块以事件内某条 `data:` 行的 `\r` 结束，缓冲区仍以 `data:` 开头，下一块的 `\n` 就不会被跳过，会制造空行并提前解析尚未完整的多行 JSON，最终误报网络错误。应在拼接前处理新块开头的 LF，并补充事件内部 CRLF 跨块的测试。
结论：需要修改

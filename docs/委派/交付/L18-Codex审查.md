# L18 Codex 审查

- 时间：2026-10-25T12:39:23.064Z
- 分支：dev2/L18（163f119），对照 docs/委派/L18-看门人换了代码自己重起.md
- Codex：0.164.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/relay/test/acceptance/l18-forever.test.ts:83`：验收条件 1 要求修改文件中的一个字，这里仅追加注释、改变文件长度；仅根据路径和文件大小计算指纹的错误实现也能通过。须补充同字节长度的内容修改断言。
- 必须改｜`scripts/real/l18-forever.mjs:161`：子进程继承了 `IXAEON_RELAY_CODE`。该变量有值时，`forever` 会执行它指定的入口，并禁用代码自检，绕过合成的 `relay-run`；须清除该变量，保证真机检查隔离且实际覆盖重启流程。
- 必须改｜`scripts/real/l18-forever.mjs:29`：遮罩只匹配 Windows 原生反斜杠路径，无法遮住 Node ESM 错误栈中 `file:///C:/Users/...` 形式的临时路径；后面的子进程输出转发仍可能打印本机账户名。须覆盖正斜杠及文件 URL 形式。

结论：需要修改

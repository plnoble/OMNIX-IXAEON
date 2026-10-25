# L18 Codex 审查（三轮，第 3 轮没审成）

分支 dev2/L18。规格：docs/委派/L18-看门人换了代码自己重起.md。

## 第 1 轮（2026-10-25，Codex 0.164.0）：需要修改

- 必须改｜`packages/relay/bin/relay.mjs:52`：切换子进程 `cwd` 后仍原样传入相对路径的 `IXAEON_WORKTREES`、`IXAEON_RELAY_CODE`，看门人会相对于新目录再次解析，导致使用错误目录；应在切换前统一解析为绝对路径。
- 必须改｜`scripts/real/l18-forever.mjs:171`：收到第一个看门人 PID 就推提交，没有按规格等第一棒完成。
- 必须改｜`scripts/real/l18-forever.mjs:193、199`：子进程输出直接写入 stdout/stderr，绕过 `mask`。
- 必须改｜`packages/relay/test/acceptance/l18-forever.test.ts:152`：`forever: false` 时没有清除继承的 `IXAEON_RELAY_FOREVER`。
- 必须改｜`packages/relay/test/acceptance/l18-forever.test.ts:276`：仅比较参数数组的前两项，放宽了条件 5。
- 建议｜测试查 `relay.lock`，实际是 `lock.json`，那条断言无法验证锁释放。

**处理：6 条全部照改**（第 6 条是真 bug——实际锁文件是 `lock.json`，原来那条断言永远为真、等于没测）：

1. `forever` 起子进程之前，`IXAEON_WORKTREES`、`IXAEON_RELAY_CODE` 统一 `resolve()` 成绝对路径再传。
2. 真机脚本改成「记账里有一行（第一棒真跑完）才推」；并把合成队列放两行，让第一轮跑完后不立刻 idle 退出、第二轮才比对。
3. 子进程输出全部过 `mask`。
4. 条件 4 显式 `delete env.IXAEON_RELAY_FOREVER`。
5. 比整个 `c.argv`，不是前两项。
6. 锁文件名改成 `lock.json`。

改完：锁定测试 7/7、真机检查通过（「第 1 棒 → 推 → 第 2 棒 → 看门人自己的代码换了 → 重起 → 新 pid → 退 0」）。

## 第 2 轮（Codex 0.164.0）：需要修改

- 必须改｜`packages/relay/test/acceptance/l18-forever.test.ts:83`：验收条件 1 要求修改文件中的一个字，这里仅追加注释、改变文件长度；仅根据路径和文件大小计算指纹的错误实现也能通过。须补充同字节长度的内容修改断言。
- 必须改｜`scripts/real/l18-forever.mjs:161`：子进程继承了 `IXAEON_RELAY_CODE`。该变量有值时，`forever` 会执行它指定的入口，并禁用代码自检，绕过合成的 `relay-run`；须清除该变量。
- 必须改｜`scripts/real/l18-forever.mjs:29`：遮罩只匹配反斜杠路径，无法遮住 Node ESM 错误栈中 `file:///C:/Users/...` 形式的临时路径。须覆盖正斜杠及文件 URL 形式。

**处理：3 条全部照改**：

1. 条件 1 改成**等长字节替换**（换掉一个 ASCII 字母，并断言字节数没变）——这条批评正中要害，也正是 D5b 要防的「测试太松」。
2. 真机脚本传 `IXAEON_RELAY_CODE: ''`（代码里按 `.trim()` 判空，等于没设）。
3. `mask` 覆盖「反斜杠 / 正斜杠 / file URL」三种写法。

改完：锁定测试 7/7、`verify.mjs` 全过（改严后重新 `lock`）、真机检查通过且日志里没有账户名。

## 第 3 轮：**没审成**

`node scripts/codex-review.mjs L18` 连续两次退出码 3（Codex 额度用完 → L17 兜底换 Claude 代审 → Claude 也没额度）。

**按 AGENTS.md「最多审三轮」的规矩，第三轮审不成就不硬等**：队列状态改「待复审（整合方）」，三轮意见与处理如上，交给整合方定。额度恢复后重跑 `node scripts/codex-review.mjs L18` 即可接着审。

## 结论

前两轮 9 条意见（8 条必须改 + 1 条建议）**全部照改并逐条验证**；第 3 轮因两家额度都用完未能进行。

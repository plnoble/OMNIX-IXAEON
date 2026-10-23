# D4c 建分支失败时带上 git 的原话 交付

- 分支：`dev/D4c`，基于 main `233dbbc`；档位 **A**
- 执行方：dev

## 已实现

| 文件                                                   | 改动          | 什么                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/execution/landing.ts`               | +23 −3        | `gitText` 失败时把 git 错误输出整段挂到错误对象上（`err.stderr`，`message` 保持 node 原话 `Command failed: git …`）；`catch` 里新增 `firstGitLine(stderr)`，在 `建分支失败：<why>` 后面接上**错误输出里第一条非空的行**（去首尾空白，最多 200 字），没有错误输出就照旧 |
| `packages/core/test/acceptance/d4c-git-stderr.test.ts` | 新，约 190 行 | 新测试 3 条：前导空行/首尾空白/多行只取第一条且完整接在 why 后面、超长截断 200 字且完整接在 why 后面、没有错误输出时保持原样（不追加冒号）                                                                                                                             |
| `scripts/real/d4c-flaky-repro.mjs`                     | 新，约 65 行  | 本机复现脚本：单跑 30 遍 + 20 进程烤机 12 遍（限时 2 分钟）                                                                                                                                                                                                            |

源码改动（只算 `apps/*/src`、`packages/*/src`）确为 **+23 −3，共 26 行**（`git diff --stat origin/main...HEAD -- packages/core/src` 核实），没超 300 行。没动 D4 的锁定测试（三个文件的指纹没变）。

**取行规则**（照委派单字面）：**错误输出里第一条非空的行**，去掉首尾空白，最多 200 字；没有错误输出就不追加。

**完整格式**：`建分支失败：Command failed: git commit -am msg：<第一条非空行>`。

## 自动化通过

`node scripts/acceptance.mjs run D4` 原样：

```
 ✓ |acceptance| apps/desktop/test/acceptance/d4-tasks-page.test.ts (5 tests) 57ms
 ✓ |acceptance| apps/desktop/test/acceptance/d4-landing-report.test.ts (5 tests) 5375ms
 ✓ |acceptance| packages/core/test/acceptance/d4-apply-branch.test.ts (20 tests) 27347ms
 ✓ |acceptance| packages/core/test/acceptance/d4c-git-stderr.test.ts (3 tests) 4833ms
 Test Files  4 passed (4)
      Tests  33 passed (33)
```

`node scripts/verify.mjs`：**全过**（2026-10-23 12:1x，末行「全部通过（IXAEON v0.2 验证完成）」）。

## 真机通过

**本机复现那条偶发：没复现出来（42 遍 0 红）。** 完整复现脚本已提交到 `scripts/real/d4c-flaky-repro.mjs`，方便后续调用。

1. 阶段 1：单独连跑 30 遍：

```
== 阶段 1：单独连跑 30 遍 ==
阶段 1 结果：pass=30 fail=0
```

2. 阶段 2：机器忙时跑 12 遍（起 20 个占 CPU 的 node 进程、限时 2 分钟）：

```
== 阶段 2：机器忙时跑 12 遍（起 CPU 烤机进程，限时 2 分钟） ==
已起 20 个占 CPU 的进程
阶段 2 结果：pass=12 fail=0
总计：pass=42 fail=0
```

**本机 30 + 12 = 42 遍全绿，没有复现。** CI 上两次红（Q2 那轮、2026-10-23 L5/L6 并入时）和本机环境不同（runner 并发、磁盘、git 版本都不同），所以：

- **偶发原因：没查到**（试了 42 遍，0 红）。
- 这一单**没有做任何治本改动**（没改建分支/提交流程、没加锁、没加重试）——没有证据表明该改哪儿。
- 价值仍然成立：以后 CI 再红，回报里会带上 git 的原话（比如 `index.lock` 被占、`fatal: cannot lock ref`），**下一次就有据可查**。

## Codex 审查

### 第一轮（2026-10-23）

结论「需要修改」，4 条必须改。逐条处理：恢复照字面取第一条非空行；测试补全截断与无 stderr；文档按实际行为重写；验收计数核正。

### 第二轮（2026-10-23）

结论「需要修改」，2 条必须改、1 条建议。逐条处理：

1. **「样本未覆盖前导空行、首尾空白或多条非空行；未断言追加在 why 后面；无 stderr 仅查末尾不是冒号」** → 测试重写为 3 条严密断言：前导空行/首尾空白/多行只取第一条且严格以 `：D4C_FIRST_NON_EMPTY_LINE` 结尾（多行内容不出现）；截断严格以 `：${first200}` 结尾；无 stderr 完整断言等于原样 `建分支失败：${why}`（中间没有冒号）。
2. **「源码改动记为 +40 −6，完整 diff 实际是 +23 −3」** → 已用 `git diff --stat` 核实并改正为 **+23 −3**。
3. **「建议：复现脚本按 AGENTS.md 提交到 scripts/real/」** → 已写进 `scripts/real/d4c-flaky-repro.mjs`。

第三轮：待跑。

## 用户接受

未发生。

## 已知缺口

1. **偶发没复现、原因没查到**（如实写：42 遍 0 红）。要再查只能等 CI 下一次红、拿回报里新带出来的 git 原话。
2. `err.stderr` 是我在 `gitText` 里挂上去的非标准字段（`execFile` 的 `stderr` 参数）。别处若也想用，最好提成正式类型；这一单只在 `catch` 里用。

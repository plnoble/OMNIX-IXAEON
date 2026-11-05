# 规格 T1：本机同一时间只跑一个完整 verify

档位：**A**。只改门禁脚本，不碰应用。源码不算行数（`scripts/` 不是 `apps/*/src`、`packages/*/src`），但也要小：约 100 行。

来源：队列第 120 行（统筹 10-28 建议）。整合方、dev、调度器常在不同工作目录里同时跑 `node scripts/verify.mjs`，两份一起跑会把 CPU 吃满。50k 性能用例从 4.9 秒拖到 35 秒，桌面计时断言超时，门禁假红，大家又各自重跑，越跑越挤。

## 要什么

1. **整台机器一把锁**：`scripts/verify.mjs` 一开始先拿锁，锁文件是 `<os.tmpdir()>/ixaeon-verify.lock`。所有工作目录共用这一把，因为挤的是同一台机器的 CPU。
   - 锁里写 JSON：`{ pid, startedAt }`。**不写工作目录路径**（路径里有账户名）。
   - 拿锁用「独占创建」（`fs.openSync(path, 'wx')`）：两份同时启动只能有一份拿到。
2. **拿不到就等**：
   - 每 10 秒看一次；
   - 等的时候打印一行「另一次 verify 正在跑（进程 <pid>，<HH:MM> 开始），等它跑完」，每分钟最多打印一次；
   - 最多等 60 分钟，还拿不到就退出码 4，说明原因。
   - `--no-wait`：拿不到马上退出码 4。
3. **锁是死的就接手**：锁里的 `pid` 已经不在了（`process.kill(pid, 0)` 抛 `ESRCH`），或者锁文件读不懂，就删掉重拿。打印一行「上一次 verify 留下的锁已失效，接手」。
4. **跑完一定放锁**：正常结束、某一步失败退出、Ctrl+C（`SIGINT`）、`SIGTERM` 都要删锁。只删自己的锁：删之前读一下，`pid` 是自己才删。
5. **CI 上不拿锁**：`process.env.CI` 有值时整个跳过，CI 一台机器只跑一份。
6. **代码放一处**：锁的逻辑写成 `scripts/lib/verify-lock.mjs`，导出 `acquireVerifyLock(opts: { path?: string; wait?: boolean; pollMs?: number; maxWaitMs?: number; log?: (line: string) => void }): Promise<{ release: () => void } | { busy: true; holder: { pid: number; startedAt: string } }>`。`verify.mjs` 只调它。

## 约束

- 不改 verify 的各个步骤，也不改它们的顺序和超时；
- 不杀别人的进程；
- 打印的内容里不出现路径。

## 验收条件

测试放 `packages/core/test/acceptance/t1-verify-lock.test.ts`（vitest 的 acceptance 项目只收 `packages/*/test/acceptance`、`apps/*/test/acceptance`），从那里 import `scripts/lib/verify-lock.mjs`；锁文件用临时目录里的路径：

1. 第一次拿到锁，锁文件里有自己的 `pid` 和 `startedAt`，没有路径；`release()` 后锁文件没了。
2. 锁已被一个活着的进程拿着（测试里起一个 `node -e "setTimeout(()=>{},5000)"` 子进程，把它的 pid 写进锁），`wait: false` → 返回 `busy`，带对方的 pid。
3. 同样情况 `wait: true`、`pollMs` 设小：对方进程结束后在几次轮询内拿到锁；等的时候 `log` 收到「另一次 verify 正在跑」。
4. 锁里的 pid 已经不在了、或锁文件内容不是 JSON → 接手，`log` 收到「已失效，接手」。
5. 两个拿锁同时发起（`Promise.all`），只有一个拿到，另一个是 `busy` 或在等。
6. `release()` 时锁文件里的 pid 不是自己（被人换过）→ 不删。
7. `maxWaitMs` 到了还拿不到 → 返回 `busy`。
8. `verify.mjs` 在 `CI` 有值时不拿锁（读源码或用 `--dry` 之类的办法测都行，写明怎么测的）。

## 真机检查

开两个终端，在两个工作目录里几乎同时跑 `node scripts/verify.mjs`：

- 第二个打印「另一次 verify 正在跑」并等着；第一个跑完后第二个接着跑；
- 再试一次：第一个跑到一半按 Ctrl+C，锁文件被删掉，第二个马上拿到锁。
  贴两次的输出（只贴锁那几行和最后的结果，路径遮掉）。

## 交付

A 档：测试和实现一起交，`acceptance.mjs lock T1 ...` 登记。Codex 审过、CI 绿，自己合并。交付说明 `docs/委派/交付/T1.md`。

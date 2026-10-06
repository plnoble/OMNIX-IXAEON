# U3b 任务页看改动-IPC与界面 交付

- 分支：`prep/U3b`，基于 `prep/U3`（U3 第二支：IPC 接线（条件 11）+ 界面（条件 12）+ 真机检查）；档位 A
- 执行方：prep

U3 按规格拆成两支：第一支（核心层，条件 1–10、13）在 `prep/U3`，见 `docs/委派/交付/U3.md`。本分支是第二支——IPC 三处接线、任务卡片上的「看改动」界面和规格要求的真机检查。

## 已实现

- `packages/contracts/src/ipc.ts` / `apps/desktop/src/main/ipc.ts` / `apps/desktop/src/preload/index.ts`：`getCodingTaskChanges(id): Promise<TaskChanges>`（主进程 handler 调 `readTaskChanges(runtime.db, runtime.coding.store.get(id))`；不存在的任务照 `store.get` 报 NOT_FOUND）。
- `apps/desktop/src/renderer/src/pages/Tasks.tsx`：执行报告里 `changedPaths` 非空的任务，卡片上显示「改了 N 个文件」和按钮「看改动」（`data-testid="task-changes-toggle-<任务号>"`）；点开调 IPC，在卡片里（`data-testid="task-changes-<任务号>"`）列出每个文件的路径、种类（新增/修改/删除/没有变化/看不了）、note、差异；差异用 `<pre>`，`+` 行和 `-` 行颜色不同；`total` 比列出来的多时写「共 N 个，只列了前 50 个」。按钮变「收起」，再点收起；再点开重新读一次。读取出错显示在这张卡片里（`task-changes-error-<id>`），不上页顶报错条。清单空、没有执行报告的任务不显示这一行和按钮。
- `apps/desktop/src/renderer/src/styles.css`：差异正文的着色样式（`--ok` 绿 / `--bad` 红）。
- `scripts/real/u3-task-changes.mjs`：真机检查脚本（照 `scripts/real/u2-tasks-page-live.mjs` 的做法），可复现。

改动文件与行数（源码部分，相对合并了第一支的 main）：

```
 apps/desktop/src/main/ipc.ts                     |   3 +
 apps/desktop/src/preload/index.ts                |   1 +
 packages/contracts/src/ipc.ts                    |   3 +
 apps/desktop/src/renderer/src/pages/Tasks.tsx    | 123 +++++++++++++++++
 apps/desktop/src/renderer/src/styles.css         |  23 ++++
```

## 验收测试（v2 规格任务）

- `apps/desktop/test/acceptance/u3-ipc.test.ts`（2 条）对条件 11：registerIpc 注册了通道、调它和 `readTaskChanges` 结果一样；不存在的任务照 `store.get` 报错。预加载和接口类型由 typecheck 把关（缺一处编译不过）。
- `apps/desktop/test/acceptance/u3-tasks-page.test.ts`（5 条）对条件 12：有改动的任务显示「改了 N 个文件」和「看改动」，点开列出文件、种类、note、差异与颜色；`total` 比列出来的多时写「共 N 个，只列了前 50 个」；读取出错显示在卡片里、不上页顶报错条；没有改动清单、没有执行报告的任务不显示；收起再展开时旧请求的结果不会盖掉新请求（竞态）。

## 自动化通过

- `node scripts/acceptance.mjs run U3b`：2 个测试文件、7 条全过。
- `node scripts/verify.mjs`：全绿，关键步骤原样：
  ```
  ✓ lint（ESLint） 通过（5.0s）
  ✓ format:check（Prettier） 通过（2.6s）
  ✓ typecheck（tsc --noEmit） 通过（5.7s）
  ✓ integration（Vitest 集成测试） 通过（42.1s）
  ✓ acceptance-lock（锁定的验收测试没被改） 通过（0.1s）
  ✓ acceptance（已完成任务的锁定验收测试） 通过（37.9s）
  ```
- GitHub 上的 verify：运行号合并时补，绿才合。

## 真机通过

`node scripts/real/u3-task-changes.mjs` 四步（临时数据目录、`IXAEON_CODEX_EXE=none` 替身执行器、合成 git 项目 note.txt 十来行），在含第一支全部修订的构建上输出：

```
等任务做完： 待用户接受 · 版本 1 · 执行器 fake · 独立验证 passed
--- 做完之后 ---
卡片里看到的清单：
  note.txt 修改
  
  -合成项目笔记
  +fake result for 把 note.txt 重写成一句话
   
  -一、今天做的事
  -写了一点界面。
  -二、明天要做的事
  -还没想好。
  -三、备注
  -这里是一个占位行。
  -继续占位。
文件 1 个 / 总数 1：
  note.txt modified +4/-9
完整 diff（逐行）：
  "-合成项目笔记"
  "+fake result for 把 note.txt 重写成一句话"
  " "
  "-一、今天做的事"
  "-写了一点界面。"
  "-二、明天要做的事"
  "-还没想好。"
  "-三、备注"
  "-这里是一个占位行。"
  "-继续占位。"
  "+可修改范围：note.txt"
  " "
  "-结尾。"
  "+获准背景：无"
  "+获准 Skill：无"
步骤 2 通过：note.txt 是 modified，+/- 都有
界面断言 [做完之后]：note.txt=有，+ 行 4，- 行 9
接受之后： 已在项目仓库建分支 ixaeon/f0ca8765（没有推送，也没动你的工作区）。要合并：git merge ixaeon/f0ca8765
--- 接受之后（分支建好、还没合并） ---
卡片里看到的清单：
  note.txt 修改
  
  -合成项目笔记
  +fake result for 把 note.txt 重写成一句话
   
  -一、今天做的事
  -写了一点界面。
  -二、明天要做的事
  -还没想好。
  -三、备注
  -这里是一个占位行。
  -继续占位。
文件 1 个 / 总数 1：
  note.txt modified +4/-9
步骤 3 通过：分支建好没合并，差异还在
界面断言 [接受之后]：note.txt=有，+ 行 4，- 行 9
已合并分支： ixaeon/f0ca8765
--- 合并之后 ---
卡片里看到的清单：
  note.txt 没有变化
  
  只有换行符不同
文件 1 个 / 总数 1：
  note.txt same（只有换行符不同） +0/-0
步骤 4 通过：合并之后是「没有变化」，note 写明
界面断言 [合并之后]：note.txt=有，+ 行 0，- 行 0
RESULT 通过：做完 modified（+/- 都有）→ 接受后差异还在 → 合并后「没有变化」
```

（步骤 4 显示「只有换行符不同」：合并把内容原样写进项目工作区时，Windows autocrlf 让工作区是 CRLF、副本是 LF，行的内容完全一致——这正是规格里「只差换行符」的同款情形，算「没有变化」。脚本断言接受「一样」或「只有换行符不同」。）

## Codex 审查（A 档）

第一轮结论「需要修改」，逐条处理：

1. 完整 diff 含未合并的 U3 → 核心改动归回 U3 分支（`prep/U3`），本支只含 IPC + 界面 + 真机；两支按顺序合并（先 U3）；U3 的锁改动请整合方复核（见 U3 交付说明）。
2. 链接检查与打开仍分离 → 核心层已加 fstat/lstat 的 dev+ino 对象核对与 `readSync` 限量读（在 `prep/U3` 分支，本支对齐）。
3. 读取追踪是 fd 数字、按路径断言失效 → 测试断言改按 openSync 路径追踪（在 `prep/U3` 分支，本支对齐）。
4. 收起再展开的请求竞态 → 已修：每次展开发新序号，旧请求结果作废；补了竞态用例（u3-tasks-page 第 5 条）。
5. 验收/verify 缺原始输出 → 见下「自动化通过」的实际输出；GitHub 运行号合并时补。
6. 建议：规格原文未提供给审查 → 已把条件 11、12 与真机检查原文摘录进 `docs/委派/U3b-任务页看改动-界面.md`。
7. 建议：LCS 同步算在主进程 → 极端构造（50 个文件、每个近 2000 行）会阻塞主进程一两秒；规格只要求「按行 LCS、不加依赖、不起进程」，未要求异步化，作为已知缺口写明，由整合方决定要不要优化。
8. 建议：最后一个文件可让差异合计略超 200 000 字符 → 这正是规格字面（「超过 200 000 字符之后，后面的文件 diff 是 null」——给差异时还没超），测试按精确累计边界验证；不做改动。

小结见 `docs/委派/交付/U3b-Codex审查.md`。

## 已知缺口

- LCS 差异在主进程同步算，极端构造输入（50 个文件、每个近 2000 行、只有少量改动）会让 Electron 主进程阻塞一两秒。规格只要求「按行 LCS、不加依赖、不起进程」，没要求异步化；是否要移出主进程由整合方定。
- 单个文件给差异时预算只按「给之前还剩多少」判断，所以最后一个给差异的文件可能让合计略超 200 000 字符——与规格字面一致（「超过 200 000 字符之后，后面的文件 diff 是 null」）。

## 用户接受

未发生（用户用过并认可之后才写）。
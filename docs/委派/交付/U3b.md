# U3b 任务页看改动-界面 交付

- 分支：`prep/U3b`，基于 `prep/U3`（U3 第二支：界面，条件 12 + 真机检查）；档位 A
- 执行方：prep

U3 按规格拆成两支：第一支（核心层 + IPC，条件 1–11、13）在 `prep/U3`，见 `docs/委派/交付/U3.md`。本分支是第二支——任务卡片上的「看改动」界面和规格要求的真机检查。

## 已实现

- `apps/desktop/src/renderer/src/pages/Tasks.tsx`：执行报告里 `changedPaths` 非空的任务，卡片上显示「改了 N 个文件」和按钮「看改动」（`data-testid="task-changes-toggle-<任务号>"`）；点开调 IPC，在卡片里（`data-testid="task-changes-<任务号>"`）列出每个文件的路径、种类（新增/修改/删除/没有变化/看不了）、note、差异；差异用 `<pre>`，`+` 行和 `-` 行颜色不同；`total` 比列出来的多时写「共 N 个，只列了前 50 个」。按钮变「收起」，再点收起；再点开重新读一次。读取出错显示在这张卡片里（`task-changes-error-<id>`），不上页顶报错条。清单空、没有执行报告的任务不显示这一行和按钮。
- `apps/desktop/src/renderer/src/styles.css`：差异正文的着色样式（`--ok` 绿 / `--bad` 红）。
- `scripts/real/u3-task-changes.mjs`：真机检查脚本（照 `scripts/real/u2-tasks-page-live.mjs` 的做法），可复现。

改动文件与行数（源码部分，相对第一支的最新 main）：

```
 apps/desktop/src/renderer/src/pages/Tasks.tsx | 123 +++++++++++++++++
 apps/desktop/src/renderer/src/styles.css      |  23 ++++
```

## 验收测试（v2 规格任务）

- `apps/desktop/test/acceptance/u3-tasks-page.test.ts`（4 条）对条件 12：
  - 有改动的任务显示「改了 N 个文件」和「看改动」，点开列出文件、种类、note、差异与颜色；
  - `total` 比列出来的多时写「共 N 个，只列了前 50 个」；
  - 读取出错显示在卡片里、不上页顶报错条；
  - 没有改动清单、没有执行报告的任务不显示。

## 自动化通过

- `node scripts/acceptance.mjs run U3b`：1 个测试文件、4 条全过。
- `node scripts/verify.mjs`：全绿。
- GitHub 上的 verify：推送后见运行号，绿才合。

## 真机通过

`node scripts/real/u3-task-changes.mjs` 四步（临时数据目录、`IXAEON_CODEX_EXE=none` 替身执行器、合成 git 项目 note.txt 十来行），输出原样：

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
  note.txt modified +5/-9
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
  "+"
  "+获准 Skill：无"
步骤 2 通过：note.txt 是 modified，+/- 都有
接受之后： 已在项目仓库建分支 ixaeon/a42d4027（没有推送，也没动你的工作区）。要合并：git merge ixaeon/a42d4027
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
  note.txt modified +5/-9
步骤 3 通过：分支建好没合并，差异还在
已合并分支： ixaeon/a42d4027
--- 合并之后 ---
卡片里看到的清单：
  note.txt 没有变化
  
  和项目里现在的文件一样（可能已经合并过了）
文件 1 个 / 总数 1：
  note.txt same（和项目里现在的文件一样（可能已经合并过了）） +0/-0
步骤 4 通过：合并之后是「没有变化」，note 写明
RESULT 通过：做完 modified（+/- 都有）→ 接受后差异还在 → 合并后「没有变化」
```

（+5 行 = 替身执行器写进的「fake result / 可修改范围 / 获准背景 / 空行 / 获准 Skill」；-9 行 = 原 note.txt 11 行里删掉的 9 行，2 行是上下文。）

## Codex 审查（A 档）

见 `docs/委派/交付/U3b-Codex审查.md`（跑完 `codex-review.mjs` 后补）。

## 已知缺口

无。

## 用户接受

未发生（用户用过并认可之后才写）。
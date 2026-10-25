# V4b 依赖档验证的授权入口（桌面，条件 7–12）交付

- 分支：dev2/V4b，基于 dev2/V4（含核心实现）；档位 B
- 执行方：dev2
- 用户 2026-10-25 定：实现先做，整合方额度回来后一起检查。

## 已实现（契约 1、2、4，条件 7–12）

- `packages/contracts/src/entities.ts`：`VerifySandboxView { status; codexVersion }`。
- `packages/contracts/src/ipc.ts` + `apps/desktop/src/main/ipc.ts` + `src/preload/index.ts` + `src/renderer/src/api.ts`：`getVerifySandbox`（只查不弹）、`authorizeVerifySandbox`（先 `requestSandboxAuth` 再 `checkSandboxAuth`，记审计 `verify_sandbox.authorize { status }`）。
- `apps/desktop/src/main/appRuntime.ts`：两个方法；启动时用 `findLatestCodex()` 找一次并记下（`codexLocator` 返回同一个），别的路径不再问版本。
- `apps/desktop/src/renderer/src/pages/Settings.tsx`：「依赖档验证（Codex 沙箱）」一块（排在「编码任务交给谁」后），打开时查一次、查到前「正在查……」，四态文案逐字（含「版本不明」那句）、只有 `unauthorized` 有「授权」按钮、确认框逐字（新版去掉了「一个 Windows 服务」）、授权中按钮态、「授权好了。/没授权成…」消息、出错进报错条。
- `scripts/real/v4-verify-sandbox.mjs`：照新规格改（第 4 步的参数核对换成新 argv、加 `sandbox setup` 不带 `--elevated` 的拒绝语核对；步骤 2 期望串换成新文案）。

改动主体从 grok/V4（ca81a41，整合方审过说写得好）搬来再改文案；`git diff` 计：contracts +17、desktop 主进程 +54、Settings.tsx +87、real 脚本 +369。

## 验收测试

`apps/desktop/test/acceptance/v4b-verify-sandbox.test.ts`（9 条，条件 6 回报行/7/8/9/10）、`v4b-settings-page.test.ts`（12 条，条件 11/12）、`v4b-codex-startup.test.ts`（2 条，条件 1 的启动找一次）。已授权场景的测试脚手架按新口径改（授权记录+标记，不再摆 cap_sid/helper/服务）。

## 自动化通过

- 三份测试：**23/23 过**
- `node scripts/verify.mjs`：红在「已完成任务的锁定验收测试」（D2 的 3 条，与 dev2/V4 同因，见 V4.md 的冲突清单）——旧 V4 条目是 queued、不在 verify 里。其余步骤全过。

## 真机通过

`node scripts/real/v4-verify-sandbox.mjs`（本支上跑的，前三步要桌面、正好都在）：

```
[1] IXAEON_CODEX_EXE=none 时「依赖档验证」那句话： 没找到 Codex 命令行，依赖档验证跑不了。
[1] 「授权」按钮个数： 0
[2] 不指定时那句话： 还没授权（Codex 0.164.0-alpha.11.1）。带 npm 依赖的项目，验收测试现在跑不了。授权一次就行；Codex 更新之后要再授权一次。
[2] 「授权」按钮个数： 1 （有，但这一步不点）
[2] 设置页显示的版本号： 0.164.0-alpha.11.1 ／ 和最新版一样吗： 一样
[3] 回报里那一行： 验证没跑：没找到 Codex 命令行，依赖档验证跑不了（这一档要用 Codex 的沙箱）。
[4] 执行器与依赖档派生的全部参数： 在（-c/-C/--sandbox/--skip-git-repo-check/--ignore-user-config/--color/--json/-o；--permission-profile；codex --help 的 -c）
[4] `sandbox setup`（不带 --elevated，带 --current-user）的拒绝语： 认得，拒了（`codex sandbox setup` currently requires --elevated）
RESULT 通过
```

（版本号 0.164.0-alpha.11.1 是本机真实最新版，规格要求设置页原样显示；用户目录与临时目录全遮掉了。）

## 已知缺口

- 没真点过「授权」按钮（规格禁止在真机检查里点）；授权要等用户自己点，装完之后的「已授权」状态只在测试里验过。
- 旧 V4 条目（queued）锁的桌面旧测试 `v4-verify-sandbox/v4-settings-page/v4-codex-startup` 在本支上会红（钉旧口径），等整合方重锁；不在 verify 的已跑清单里。

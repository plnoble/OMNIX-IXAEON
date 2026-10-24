# 规格 L17：审查兜底——Codex 没额度时换 Claude 审

档位：**B**（改的是 A 档合并前那道关卡本身；会花 Claude 的额度）。大小：小（约 80 行源码，只改 `scripts/codex-review.mjs`）。依赖：无。来源：接力第 29 棒（规划棒），[三周任务单](../三周任务单.md)「接下来一周」第 1 件。

## 要什么

`node scripts/codex-review.mjs <任务号>` 碰上 Codex 额度用完（现在退出码 3 的那一处）时，不再直接退 3，改用调度器起整合方的那个 Claude 命令行，**照同一份审查要求、同一份喂进去的上下文**审一遍，结论照样写进 `docs/委派/交付/<任务号>-Codex审查.md`，文件开头写明这次是 Claude 代审的。退出码的规矩不变（0 可以合并 / 1 需要修改 / 2 结论不明或出错 / 3 额度用完）；Claude 也没额度、或者找不到 Claude，才回 3。

## 为什么

- 10-24 L13b 在「待审（Codex 额度）」上卡了大半天。A 档的活全靠 Codex 一家审，Codex 的额度又是三家里最小的；接力要 24 小时转，这一处一卡，开发那条道上的 A 档就全堆着。
- 审查要的东西本来就全由脚本喂进去（不让审查者跑命令），换一个模型审不用改审查的做法，只换执行的那一个命令。

## 契约（接口写死）

1. 只改 `scripts/codex-review.mjs`（外加新测试、交付说明）。命令行用法、`--dry-run`、`--base` 不变。
2. **什么时候换**：只在现在 `process.exit(3)` 的那个条件（输出里有 `usage limit` / `rate limit`、又没拿到审查结论）成立时。Codex 别的失败（退出码 2 那些）照旧，不换。
3. **找 Claude**，按这个顺序，找到就停：
   1. 环境变量 `CLAUDE_BIN`；
   2. 调度器配置 `<数据目录>/config.json` 里 `roles.integrator.argv[0]`；数据目录 = 环境变量 `IXAEON_RELAY_DIR`（有值时），否则 `~/.ixaeon/relay`（和 `packages/relay/src/datadir.ts` 同一个规矩）。配置读不到、不是 JSON、没有这个字段 → 当作没有。
   3. 都没有 → 照现在的样子打「Codex 额度用完……」那两行，再加一行 `也没找到可用的 Claude，没法代审`，退 3。
4. **怎么起 Claude**：参数固定为
   `[<Claude>, '--restricted', '--tools', '', '--output-format', 'json', '-p', <和给 Codex 的同一段 prompt>]`，
   标准输入是和给 Codex 的同一份 `context`；`cwd` 是一个新建的空临时目录（审完删掉），超时 45 分钟，`windowsHide: true`。**不带** `packages/relay/src/config.ts` 里 `FORBIDDEN_SWITCHES` 列的任何一个开关。
   - `CLAUDE_BIN`（或配置里那一项）以 `.mjs` / `.js` 结尾时，改成 `process.execPath <那个文件> <其余参数>` 起（给测试用的替身）；`CODEX_BIN` 同样这么认（现在不认，这一单一起加）。
5. **认结果**：标准输出整段当 JSON 解析，取 `result` 字段（字符串、去掉首尾空白）当审查结论。
   - 解析不了、没有 `result`、`is_error` 为 `true` 时：输出（标准输出 + 标准错误）里含配置里 `roles.integrator.quotaPatterns` 的任何一条（不分大小写；配置读不到时用 `usage_limit_reached`、`session limit` 两条）→ 打 `Claude 也没额度了：分支先等着，队列状态改「待审（Codex 额度）」，稍后重跑。`，退 3；否则打 `Claude 没有给出结论（退出码 <码>）。最后几行输出：` 加最后 15 行，退 2。
6. **写审查记录**：同一个文件 `docs/委派/交付/<任务号>-Codex审查.md`。Claude 代审时开头写成：

   ```
   # <任务号> 审查（Codex 额度用完，由 Claude 代审）

   - 时间：<ISO 时间>
   - 分支：<分支>（<短提交号>），对照 <规格路径>
   - 审查者：Claude（<`<Claude> --version` 输出里的第一个 x.y.z，问不出写 ?>）；上下文由脚本喂入（不让审查者跑命令）[；diff 太长已截断]
   - 花费：<total_cost_usd> 美元（JSON 里没有这个字段就不写这一行）
   ```

   后面接审查结论原文，和现在一样。Codex 审的那种写法一个字不变。
7. 认结论（最后一行「结论：可以合并」→ 0，「结论：需要修改」→ 1，其他 → 2）对两家用同一段代码。
8. 换到 Claude 之前在标准错误打一行：`Codex 额度用完，改用 Claude 代审（<Claude 的路径>）`。

## 约束

- 不改 AGENTS.md、队列规则、调度器代码。AGENTS.md 里「Codex 额度用完 → 待审（Codex 额度）」那句，整合方复审并入时改。
- 不读、不打印任何凭据文件；配置里只取 `roles.integrator.argv[0]` 和 `roles.integrator.quotaPatterns` 两样，别的不碰、不打印。
- 审查记录和输出里不能有本机账户名：Claude 的路径只打在标准错误、不写进审查记录。

## 验收条件

新测试 `packages/relay/test/acceptance/l17-review-fallback.test.ts`。做法：建一个临时 git 仓库（带一个裸仓库当 `origin`，`main` 推上去），把本仓库的 `scripts/codex-review.mjs` 拷进去，放一份合成规格 `docs/委派/L99-合成.md` 和一个 `AGENTS.md`，切一个分支改一个文件、提交；在那个临时仓库里用 `node scripts/codex-review.mjs L99` 跑。Codex、Claude 都用 `.mjs` 替身（经 `CODEX_BIN` / `CLAUDE_BIN`），替身把收到的参数、标准输入、`cwd` 写进一个文件，按测试要的打输出。`IXAEON_RELAY_DIR` 指到临时目录。

1. Codex 替身正常给出结论（往 `-o` 那个文件写「…\n结论：可以合并」）→ 退 0；审查记录开头是 `# L99 Codex 审查`；Claude 替身没被调用。
2. Codex 替身打 `usage limit reached`、不写 `-o` 文件；Claude 替身打 `{"type":"result","is_error":false,"result":"没有发现问题\n结论：可以合并","total_cost_usd":0.12}` → 退 0；审查记录第一行是 `# L99 审查（Codex 额度用完，由 Claude 代审）`，含 `- 审查者：Claude（`、`- 花费：0.12 美元`、`结论：可以合并`；标准错误含 `改用 Claude 代审`。
3. 同 2，Claude 的结论最后一行是 `结论：需要修改` → 退 1。最后一行别的话 → 退 2。
4. Claude 替身收到的：参数正好是契约第 4 条那一串（`-p` 后面那段和 Codex 替身收到的 prompt 一样）；标准输入和 Codex 替身收到的一样；`cwd` 不是那个临时仓库、也不在它里面；参数里没有 `FORBIDDEN_SWITCHES` 的任何一项。
5. Claude 替身打 `{"type":"result","is_error":true,"result":"You've hit your session limit · resets 3:10am (Asia/Shanghai)","api_error":"usage_limit_reached"}` → 退 3，标准错误含 `Claude 也没额度了`；审查记录没写。
6. Claude 替身打不是 JSON 的一句话、退出码 1 → 退 2，标准错误含 `Claude 没有给出结论`。
7. 不设 `CLAUDE_BIN`，`<IXAEON_RELAY_DIR>/config.json` 里 `roles.integrator.argv[0]` 指向 Claude 替身 → 用的是它（同条件 2 的结果）。配置里 `quotaPatterns` 写 `["自定义额度字样"]`、Claude 替身打出这几个字且没有 `result` → 退 3。
8. 不设 `CLAUDE_BIN`、数据目录里没有 `config.json` → 退 3，标准错误含 `也没找到可用的 Claude`。
9. Codex 替身别的失败（不含额度字样、不写 `-o`）→ 退 2，Claude 替身没被调用。

`node scripts/acceptance.mjs lock L17 …` 登记；B 档先只推测试，状态改「测试待审（整合方）」。

## 真机检查

`scripts/real/l17-claude-review.mjs`（照 `p7-revoke-reading.mjs` 的规矩：每步核对、不符打「结论：不通过」退 1、遮掉临时目录和用户目录）：在一个临时仓库里放一份三行的合成规格和一处一行的改动，`CODEX_BIN` 指一个只打 `usage limit reached` 的替身，Claude 用本机真的（照契约第 3 条找）。核对：退出码是 0/1 之一、审查记录第一行对、`审查者：Claude（x.y.z）`、有花费一行。**真调用最多 2 次**，花费贴进交付说明。这一步确认真 Claude 认 `--tools ''`（空字符串＝不给任何工具）；它要是不认（报错或照样有工具），停下写进交付说明，转整合方，不要自己换别的开关。

## 整合方审测试时的改正与补充（2026-10-25，第 33 棒）

开发交的 11 条照着条件 1–9 写得对，替身、临时仓库的搭法没毛病。整合方写了一份一次性实现（只改 `scripts/codex-review.mjs`，约 70 行，不提交）跑通，再逐处改坏做变异检查，补了契约里有、条件里没点到的几处（测试文件开头注释里也写了）：

- 契约 6：分支那一行（`- 分支：dev/L99（<短提交号>），对照 docs/委派/L99-合成.md`）；JSON 里没有 `total_cost_usd` 时**不写**花费那一行。
- 契约 4：`.js` 结尾的 `CODEX_BIN` / `CLAUDE_BIN` 也经 `process.execPath` 起。
- 契约 5：配置读不到时默认的两条字样**各自单独**都认（只有 `Session Limit` 在标准输出、只有 `USAGE_LIMIT_REACHED` 在标准错误），不分大小写。
- 契约 3：`CLAUDE_BIN` 和配置都有时先用 `CLAUDE_BIN`；`config.json` 不是 JSON 当作没有（退 3、`也没找到可用的 Claude`），不许崩。
- 契约 5：是 JSON、但没有 `result` 字段 → 退 2、`Claude 没有给出结论`（变异检查查出来的：不查 `result` 的类型，实现会在 `.trim()` 上崩成退出码 1）。
- 另修两处类型错（`env` 上加 `CLAUDE_BIN`、`it.each` 的回调参数），行为不变。共 18 条。

变异检查：改坏 26 处，补测试后 25 处变红；1 处存活算等价（Claude 的 `result` 不去首尾空白：结论按去空白后的最后一行认，记录里多几个空行，不影响任何条件）。「少 `--restricted`」这一处由条件 4 的整串参数比较兜着。去掉实现后 18 条全红，红在「起不了 `.mjs` 替身」和「没有换 Claude」上。没有别的测试或脚本用到 `scripts/codex-review.mjs`，不撞已锁定的测试。

给实现的提醒：

- 额度判断和找 Claude 都在「Codex 额度用完」那个分支里做；Codex 正常、Codex 别的失败两条路一个字不动（条件 1、9）。
- Claude 的工作目录用 `mkdtempSync` 新建、审完 `rmSync`；不要用仓库目录、也不要复用给 Codex 的那个 scratch（测试查它是空的、审完不在了）。
- 版本号用 `<Claude> --version`，同样要经 `.mjs` / `.js` → `process.execPath` 那一层；问不出写 `?`。
- 真机检查按规格做，**真调用最多 2 次**；`--tools ''` 不认就停下转整合方。

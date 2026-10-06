# D5a 验收先行——先写测试并锁定，再写实现，做完自动跑——交付

- 分支：prep/D5a，基于 main cde42ba（锁定测试重写之后）；档位 B
- 执行方：prep
- 锁定的验收测试：main 上由整合方写好并锁定（d5a-acceptance-first.test.ts 33 条 +
  d5a-executor-options.test.ts 4 条），实现只让它通过、没改一条。

## 已实现

- `packages/core/src/execution/executor.ts`：
  - `ACCEPTANCE_DIR = 'ixaeon-acceptance'`、`ExecutorRunOptions { readScope?: string[] }`
    导出；`CodingExecutor.run` 加第 4 参 `options?`；
  - `FakeCodingExecutor`：被叫去写验收测试（scope 只有测试目录）时不动副本，返回
    `claimedSuccess: false`、summary「替身执行器不写验收测试」（契约 6 / 条件 23）；
  - `CodexCliExecutor.run` 签名加 `options?`（不使用）；
  - `CodingOrchestrator.dispatch` 五步流程：有验收条件、没有验证命令的任务 →
    ①写测试（目标换成「写测试的交代」，scope 只有测试目录，readScope 是原批准范围；
    越界 → 失败「写验收测试时改了别的文件：<路径>」；执行器报错/说做不到/没写文件 →
    不锁定直接去第 4 步，原因记执行器说的话）→ ②实现前先跑一遍（每个 `.test.mjs`
    按 `runCheck([process.execPath, <相对路径>], 副本, …)`；全过 → 不锁定，原因
    「验收测试在实现之前就全部通过，测不出这次改动」；沙箱不肯跑 → 不锁定，原因用
    沙箱的话；跑完副本里测试目录以外有变化 → 失败「验收测试改了项目里的文件：
    <路径>」；至少一个不通过 → 下一步）→ ③锁定（记测试目录指纹）→ ④写实现（原
    派发目标 + 验收条件 + 交代；越界/自报没做成照旧先拦；做完后测试目录任何变化 →
    失败「实现时改了验收测试：<路径>」）→ ⑤再跑（全过 → passed；有不过 → failed；
    沙箱不肯跑 → not_run 等接受；跑完测试目录以外有变化 → 失败）。每步之间查取消。
    没锁定时做完 not_run，原因进 verify_output。
- `packages/core/src/execution/modelExecutor.ts`：`readScope` 里的文件发内容（提示
  里注明「只读范围，不要改」），能写的仍只有 scope；改 readScope 里的文件照样被拒。
- `apps/desktop/src/main/codingExecutor.ts`：`ConfiguredCodingExecutor.run` 把
  `options` 原样传给实际干活的执行器（模型、Codex 都传）。
- `packages/core/src/index.ts`：导出 `ACCEPTANCE_DIR`、`ExecutorRunOptions`。

改动文件与行数（最后一次提交之后 `git diff --stat origin/main...HEAD` 原样，见推送后）：

实现要点（规格「没钉住、留给实现判断的」四条的选择）：

- 测试目录下子目录里的 `.test.mjs` 算测试文件（`testFilesOf` 按前缀 + 后缀收集）；
- 第一步执行器说没做成、却写了测试文件时，不算「没写出测试」，测试照锁定/跑
  （claimedSuccess=false 只在测试目录里没有任何 .test.mjs 时才走「没写出测试」）；
- 没写出测试的原因开头写「没写出验收测试：<执行器说的话>」；报错时是报错的话；
- 实现后那遍测试既不通过、又改了项目文件时：先查项目文件被改（原因「验收测试改了
  项目里的文件」），否则按测试不通过记 failed——两者都会让任务失败。

## 验收测试

`node scripts/acceptance.mjs run D5a` → 37/37 通过（33 + 4 条锁定测试未改）。

## 自动化通过

- `node scripts/acceptance.mjs run D5a`：37 passed。
- `node scripts/verify.mjs`：全部通过（IXAEON v0.2 验证完成）。
- GitHub 上的 verify：推送后补运行号。

## 端到端测试（随实现一起交，不锁定）

`apps/desktop/e2e/d5a-acceptance-first.spec.ts`：任务草案照 `d3-auto-dispatch.ts` 的
做法直写临时库（带验收条件、`allowed_commands_json = '[]'`、待办卡），假模型响应
脚本给两步（写测试 / 写实现），设置里选「我的模型」，合成 git 项目只有 `calc.mjs`。
流程：点「要做」→ 对话回报「做完了，等你验收」「验证通过」「我的模型
（e2e-model）」；任务页「独立验证 passed」；副本里测试文件与实现都在；接受后分支
相对 main 改了 `calc.mjs` 与验收测试文件。原样输出：

```
ok 1 e2e\d5a-acceptance-first.spec.ts:93:7 › D5a 验收先行（端到端） › 带验收条件的任务：先写测试再写实现，回报「验证通过」，接受后分支里两样都有 (5.8s)
1 passed (6.8s)
```

## 真机通过

规格要求的真机检查（用户模型网关跑两个任务）**没跑**。原因：脚本需要真实配置里的
五项，但本机验证发现 `apiKeyEncrypted` 是 safeStorage 密文，绑定加密时的应用实例——
临时数据目录里的副本解不开（探针：临时实例自身加解密 roundtrip 正常，真实密文解密
报 `Error while decrypting the ciphertext provided to safeStorage`）。脚本
`scripts/real/d5a-acceptance-first.mjs` 已按 `d7b-model-task.mjs` 的做法写好待用，
两个替代方案（用户开着应用跑 / 规格改临时实例手填 Key）由整合方定。探针输出原样：

```
AVAIL true ROUNDTRIP_OK true
REAL_KEY_DECRYPT ERR Error: Error while decrypting the ciphertext provided to saf
```

## 已知缺口 / 说明（规格「留给实现判断的」四条的选择）

- 测试目录下子目录里的 `.test.mjs` 算测试文件；
- 第一步执行器说没做成、却写了测试文件时，测试照锁定/跑（claimedSuccess=false 只在
  测试目录里没有任何 .test.mjs 时才走「没写出测试」）；
- 没写出测试的原因开头写「没写出验收测试：<执行器说的话>」，报错时是报错的话；
- 实现后那遍测试既不通过、又改了项目文件时：先查「验收测试改了项目里的文件」
  （任务失败、原因有路径），否则按测试不通过记 failed——两种都失败，先后如实。
- 已知局限（规格约束原文）：测试只在零依赖档跑；带 npm 依赖的项目模型写的测试引
  不到依赖，照流程就是「任务失败，独立验证失败」，不绕。

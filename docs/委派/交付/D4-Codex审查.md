# D4 Codex 审查

- 时间：2026-09-28T17:56:30.448Z
- 分支：grok/D4（0e442d5），对照 docs/委派/D4-接受后在项目里建分支.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/src/execution/landing.ts:176–181`：冲突检查用了仓库子目录偏移 `gitRel(rel)`，写入、删除和暂存却仍用 `rel`；项目登记在仓库子目录时，会改到仓库根下的同名路径，甚至提交错误删除。
- 必须改｜`packages/core/src/execution/landing.ts:80–82、123–127`：`headHash` 仍读取可变的 `HEAD`，没有使用已捕获的 `head`；并发提交时，各文件的核对版本可能不同，也可能与建分支的基线不同，交付说明所称“绑定同一个 HEAD”尚未实现。
- 必须改｜`packages/core/src/execution/landing.ts:60、78–82`：Git blob 被按 UTF-8 解码后重新哈希，非 UTF-8 字节会被替换，无法可靠核对二进制文件；应对原始字节计算指纹，并确保与派发端算法一致。
- 必须改｜`packages/core/src/execution/landing.ts:71–82、127`：超时、超出缓冲上限等读取失败均被当成“文件不存在”；基线为 `null` 时会因此放过冲突，须区分路径不存在与读取失败，后者不能通过核对。
- 必须改｜`packages/core/src/execution/landing.ts:180`：删除路径绕过了 `safeWrite` 的父级符号链接检查；若工作树内目录链接指向外部，删除其子路径会直接删除临时工作树之外的文件。
- 必须改｜`packages/core/src/execution/landing.ts:168–169、157`：分支指向相同 `head` 不能证明它由本次操作创建；其他操作恰好从同一提交创建同名分支时，建树失败后的清理会将他人的分支删除。
- 必须改｜`packages/core/src/execution/patchPack.ts:54–60、84`：`manifest.json` 的特殊处理违反清单契约：新增被列为修改、删除被列为新增，数组内还混入说明文字；若同时改动 `manifest.json.project`，其内容会被覆盖。撞名方案应退回整合方确定，不能把当前实现称为“无损”。
- 必须改｜`packages/core/src/execution/executor.ts:611–616`、`packages/core/src/execution/taskStore.ts:503–508`：落地尚在异步执行时，任务已变为可删除的 `completed`；并发删除会移除任务记录，后续仍可能创建分支，但无法保存落地结果或追加回报，需要保护落地期间的任务。
- 必须改｜`packages/core/src/execution/landing.ts:143–160`：`worktree list` 和 `prune` 的失败被吞掉，清理函数仍可能返回成功；没有复核注册信息是否残留，不能据此宣称满足验收条件 8。
- 必须改｜`packages/core/src/execution/landing.ts:36–37、194–196`、`apps/desktop/src/renderer/src/pages/Tasks.tsx:48–50`：清理失败虽然写入 `apply_error`，分支回报和任务页却都忽略这个字段，只显示成功文案，用户无法发现残留工作树。
- 必须改｜`docs/委派/交付/D4.md:23`：源码新增已达 416 行，超过硬性 300 行上限；拆成两个模块没有拆小本次任务，记录“由整合方裁决”也不等于已获例外许可。
- 建议｜`packages/core/src/execution/patchPack.ts:22–32、51–85`、`packages/core/src/execution/landing.ts:151`：复制文件、构建改动包和递归清理仍同步执行，大文件或大型工作树会阻塞 Electron 主进程；应改为异步文件操作。
- 建议｜`docs/委派/交付/D4.md:27–58`：需要人工确认：材料未提供三份锁定验收测试正文及锁定指纹，无法核实测试是否确实覆盖所列条件；交付摘要和通过日志不能替代这部分审查。

结论：需要修改

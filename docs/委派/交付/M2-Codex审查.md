# M2 Codex 审查

- 时间：2026-10-03T01:25:56.033Z
- 分支：prep/M2（7a416c0），对照 docs/委派/M2-模型管理-检测勾选保存.md
- Codex：0.159.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/renderer/src/pages/Settings.tsx:684`：筛选框只在已有保存模型时显示；首次检测即使返回几百个模型也无法筛选，违反契约 2。
- 必须改｜`apps/desktop/src/renderer/src/pages/Settings.tsx:402、453`：勾选尚未保存的模型后重新检测，如果该模型从上游消失，它会从清单隐藏却仍留在 `checked` 中，保存时会写入不可见的模型，违反“保存只认清单里勾选的项”。
- 必须改｜`apps/desktop/src/main/appRuntime.ts:1381`：`modelsCheckedAt` 记录的是保存时间；从未成功检测、检测失败后保存或仅调整下拉框都会更新时间，不能代表规格要求的“上次检测时间”。
- 必须改｜`apps/desktop/src/renderer/src/pages/Settings.tsx:449、723`：合法的空 `modelName` 配置保存时会被自动替换为 `gpt-5.2`，即使它不在保存清单里；已有保存模型时又没有空值选项，界面可能显示首项而实际提交另一个模型，违反用户选择后才改变模型的契约。
- 必须改｜`apps/desktop/e2e/m2-model-ui.spec.ts:119–122`、`apps/desktop/test/acceptance/m2-saved-models.test.ts:169–172`：验收覆盖不完整；下拉框只检查部分选项存在，没有排除未保存模型；失败测试只检查通用异常和磁盘配置，没有验证界面显示上游错误且清单、勾选状态和当前模型不变。
- 必须改｜`docs/委派/锁定验收.json:302–303`：只锁定了后端测试，承担多条界面验收条件的 `m2-model-ui.spec.ts` 未登记指纹，界面验收不受锁定门禁保护。
- 建议｜`apps/desktop/e2e/m2-model-ui.spec.ts:135–136、167–170`：清单可见、下拉值不变都不能证明异步检测或保存已完成；立即检查请求记录或关闭应用存在竞态，应等待对应操作完成。
- 建议｜`docs/委派/交付/M2.md:41、51`：需要人工确认：未提供的既有 Key 测试是否覆盖留空保存、地址变化时禁止复用及界面／日志不泄漏 Key，以及最终提交的 GitHub verify 是否通过；当前材料无法核实。

结论：需要修改

# 本目录说明（C3，2026-09-29）

- **活测试**：`*.test.ts`（vitest 套件）、`*.spec.ts`（真实 Electron 界面检查）、
  `vitest.*.config.ts`、`playwright.*.config.ts`——由 `scripts/verify.mjs`
  引用，改动即进门禁。
- **`results-*.json`（57 个左右）是历史审核证据，不是程序输入**：没有任何
  测试或脚本读取它们；被 8 份以上历史报告（REVIEW_PACKET、dev-log、
  docs/history/ 等）按**原路径**引用。**不搬家、不删除**。
  新的验证证据请写进各任务的交付说明（docs/委派/交付/），不要再往这里放。
- `packaged-20260905.mjs` 是打包产物复核脚本（win-unpacked 真机检查），
  按需手工运行，不进 verify。
# 规格 R2：CI 用的 GitHub Actions 升到 Node 24 版本

档位：**A**。大小：很小（几行）。依赖：无。

## 要什么

GitHub 上每次 verify 运行都有这条提示：

> Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/cache@v4, actions/checkout@v4, actions/setup-node@v4.

把 `.github/workflows/verify.yml` 里这三个 action 升到以 Node 24 为目标的主版本（查各自仓库的发布说明确认是哪一版）。

## 约束

- 不改门禁步骤本身，不换 runner，不改安装方式（`--ignore-scripts` + `pnpm rebuild electron` 那套是 2026-09-19 为云端编译器问题定的，保持原样）。
- 升级后缓存的键如果要变，写进交付说明。

## 验收条件

1. 分支和合并后 main 上的 verify 都是绿的。
2. 运行记录里不再有「Node.js 20 is deprecated」这条提示。查法：

   ```bash
   gh api repos/plnoble/OMNIX-IXAEON/check-runs/<job 的 databaseId>/annotations --jq '.[].message'
   ```

   （`databaseId` 用 `gh run view <运行号> --json jobs --jq '.jobs[0].databaseId'` 取。）

这一单改的是 CI 配置，**没有验收测试**：`acceptance.mjs` 的 `run` / `lock` / `done` 三步跳过，交付说明里写明。

## 真机检查

上面第 2 条就是：把查到的提示列表（应为空）原样贴进交付说明。

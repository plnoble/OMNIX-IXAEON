# IXAEON（析衍）

IXAEON 的长期目标是成为持续理解用户、统筹项目、主动研究世界、调动模型与设备，并在授权边界内行动和成长的个人 Agent。

- 正式系统名：**IXAEON**，中文名：**析衍**（Jarvis 只是历史称呼）。
- 厂牌：OMNIX。用户始终只面对一个 IXAEON。
- 本机服务只监听 `127.0.0.1`；默认无读取权限，用户明确授权后才读取。

## 当前状态（2026-09-17）

包版本 v0.2.9。当前**不是**可日用的个人 Agent，正在做的是让它变成一个：

- 已有并可信的：原文与来源保全、授权与撤权传播、SQLite 权威记录与只追加迁移、ChatGPT 导入、Hermes 引擎适配（stdio JSON-RPC，本机已锁定 v2026.9.11）。
- **尚不具备的**：连续对话（当前问答页是单轮无状态检索框，数据库里没有对话表）、语义检索（当前是关键词子串匹配）、流式输出。
- **停在设计稿的**：Door 设备感知、模型池、自我升级、多设备协作、角色治理。代码曾被提交但未接线，2026-09-17 已降级归档。

历史上的「阶段全部完成」「门禁全绿」不代表产品可用。判断依据以 [三周任务单](docs/三周任务单.md) 的验收信号为准。

## 接手入口

- **[三周任务单](docs/三周任务单.md)** — 当前唯一在用的计划。
- **[AGENTS.md](AGENTS.md)** — 交付规则与硬规矩。
- [架构决策记录](docs/IXAEON_架构决策记录.md) — 选择、理由、代价与改选条件。
- `docs/history/` — 历史规划与审核报告，保留为事实，不决定当前开发顺序。
- `REVIEW_PACKET.md` — 交付流水账，只追加。

根目录三份历史思想文档（`JARVIS_CONSTITUTION_v0.1.md`、`Jarvis_Constitution_v0.1.docx`、`grok-20260903-IXAEON-思想碰撞.md`）为只读资料，不移动、不改名、不修改。

## 仓库结构

```text
apps/
  desktop/        Electron 主进程、React 界面、本地 HTTP 接口（127.0.0.1:43191）
  mcp/            STDIO MCP 服务（名称 ixaeon），调用本机 IXAEON 接口
  extension/      Chrome/Edge Manifest V3 扩展（仅 chatgpt.com）
packages/
  contracts/      Zod schema、共享类型、统一错误码
  core/           导入、存储、提取、检索、纠正、简报逻辑
  test-fixtures/  脱敏测试资料和模拟 ChatGPT 页面
docs/
  三周任务单.md          当前计划
  architecture.md       架构与数据流
  privacy-model.md      隐私与权限模型
  mcp-setup.md          Codex / MCP 接入说明
  history/              历史规划与审核记录
scripts/
  verify.mjs       pnpm verify 入口
```

## 环境要求

- Windows 11
- Node.js 24 LTS（含 corepack）
- Git

pnpm 10 通过 corepack 固定（见根 `package.json` 的 `packageManager` 字段），无需全局安装。

## 常用命令

```text
corepack pnpm install --frozen-lockfile   # 安装依赖（首次或更新依赖后）
corepack pnpm setup:browsers              # 下载 Playwright Chromium（端到端测试需要，仅首次）
corepack pnpm verify                      # lint + format 检查 + typecheck + 单元/集成测试 + 构建
corepack pnpm dev                         # 启动桌面应用开发模式
corepack pnpm build                       # 构建全部子应用
corepack pnpm test:e2e                    # Playwright 端到端测试（桌面 + 扩展）
corepack pnpm package:windows             # 生成 Windows 安装包（NSIS）
```

> 在无法直连 npm/GitHub 的网络中，先设置代理：`HTTP_PROXY` / `HTTPS_PROXY`，并保留 `.npmrc` 中的 electron 镜像。

## 数据位置

运行数据不写入本仓库，统一放在 `%LOCALAPPDATA%\OMNIX\IXAEON\`（可在首次设置中更改）：

```text
ixaeon.db     SQLite 数据库（WAL、外键开启）
vault\        原文内容指纹库（SHA-256，只增不改）
logs\         结构化日志（遮盖敏感字段）
backups\      导出包
config.json   配置（API Key 经 safeStorage 加密；MCP 令牌本机保存）
```

当前未实现应用级全库加密，建议开启 Windows BitLocker。

## 许可

私有项目，未授权不得分发。

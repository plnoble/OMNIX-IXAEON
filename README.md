# IXAEON（析衍）

IXAEON 的长期目标是成为持续理解用户、统筹项目、主动研究世界、调动模型与设备，并在授权边界内行动和成长的个人 Agent。

当前已实现的 V0.2 主要是运行在 Windows 本机的项目记忆与编码 AI 背景服务，是上述目标的可靠性底座，不代表个人内核、主动研究和自主执行已经完成。

- 正式系统名：**IXAEON**，中文名：**析衍**（Jarvis 只是历史称呼）。
- 厂牌：OMNIX。用户始终只面对一个 IXAEON。
- 第一版核心价值：项目连续性。
- 当前本机服务只监听 `127.0.0.1`；默认无读取权限，用户明确授权后才读取。后续新增研究联网与执行能力需按新计划分别授权。

当前包版本：**v0.2.0**。按既有审核记录，工程修复验收通过，真实环境验收仍有未完成项；实际状态以最新审核记录和当前代码为准。

## 开发方向与接手入口

- [长期愿景与开发路线图](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_长期愿景与开发路线图.md)：固定最终目标，避免分阶段开发后缩成单项目工具。
- [下一阶段 V0.3 开发计划](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_v0.3_开发计划_个人内核与最小Agent闭环.md)：个人内核、主动研究与最小行动闭环，供开发 Agent 分批实施。
- [Agent 阅读入口](D:/Agent/Project/OMNIX-IXAEON析衍/AGENTS.md)：接手时的阅读顺序和交付规则。

2026-09-08 起，上述 V0.3 计划取代旧 Door 计划的下一阶段主线地位。旧计划和原始讨论继续保留；Door 将作为长期路线中的设备能力模块推进。

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
  architecture.md       架构与数据流
  privacy-model.md      隐私与权限模型
  mcp-setup.md          Codex / MCP 接入说明
  review-checklist.md   审核清单
scripts/
  verify.mjs       pnpm verify 入口
```

根目录三份历史思想文档（`JARVIS_CONSTITUTION_v0.1.md`、`Jarvis_Constitution_v0.1.docx`、`grok-20260903-IXAEON-思想碰撞.md`）为只读资料，不移动、不改名、不修改。

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

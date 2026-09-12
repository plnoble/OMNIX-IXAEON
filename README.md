# IXAEON（析衍）

IXAEON 的长期目标是成为持续理解用户、统筹项目、主动研究世界、调动模型与设备，并在授权边界内行动和成长的个人 Agent。

当前 V0.2.x 主要是运行在 Windows 本机的项目记忆与编码 AI 背景服务，并已包含部分实验性个人/研究/任务模块；有可继承的资料与历史基础，但不代表个人 Agent 已完成或全部路径可靠。

- 正式系统名：**IXAEON**，中文名：**析衍**（Jarvis 只是历史称呼）。
- 厂牌：OMNIX。用户始终只面对一个 IXAEON。
- V0.2 的历史核心价值：项目连续性；当前开发主线已转向用户中心的个人 Agent。
- 当前本机服务只监听 `127.0.0.1`；默认无读取权限，用户明确授权后才读取。后续新增研究联网与执行能力需按新计划分别授权。

截至 2026-09-11，本仓库包版本：**v0.2.6**。最新独立审核发现执行验证、隐私、取消和真实接入等缺陷，不能沿用更早的“工程全通过”作为当前结论；实际状态以当前代码及 [独立审核](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_方向与质量独立审核_2026-09-11.md) 为准。

## 开发方向与接手入口

- [长期愿景与开发路线图](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_长期愿景与开发路线图.md)：固定最终目标，避免分阶段开发后缩成单项目工具。
- [架构决策记录](D:/Agent/Project/OMNIX-IXAEON析衍/docs/IXAEON_架构决策记录.md)：选择、理由、代价与改选条件，防止遗忘和静默缩小目标。
- [当前 V0.3 重整开发计划](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_v0.3_重整开发计划_个人Agent内核与Hermes接入.md)：自有 Core、首选 Hermes 适配器、自动情境记忆、真实搜索与执行，按 B0–B5 交付。
- [Agent 阅读入口](D:/Agent/Project/OMNIX-IXAEON析衍/AGENTS.md)：接手时的阅读顺序和交付规则。

2026-09-11 重整计划取代 2026-09-08 V0.3 计划的实施顺序与冲突选择；旧安全/数据要求和未完成项按新计划映射保留。旧 Door 计划及原始讨论仍是历史参考，Door/模型池/多终端和受控成长并未取消。上述是规划，不是新内核已实现声明。

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

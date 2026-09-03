# MCP 接入指南（编码 AI ↔ IXAEON）

IXAEON 通过 MCP（Model Context Protocol）向编码 AI 提供项目记忆。服务名固定为 `ixaeon`，共 4 个工具：

| 工具 | 用途 | 时机 |
| --- | --- | --- |
| `prepare_task` | 取得项目简报（目的/决定/否决/待办/最近工作，带引用 ID，字符预算内） | 开始规划或修改前 |
| `search_context` | 检索条目与原文短片段 | 简报不足以完成任务时 |
| `get_source_excerpt` | 展开引用核对原文细节 | 确实需要核对原文时 |
| `record_work_result` | 写回工作结果与未完成事项 | 每次结束时（无论成败） |

## 前置条件

1. IXAEON 桌面应用已运行（本地服务监听 `127.0.0.1:43191`）。
2. 已在桌面端完成首次设置并创建了项目。
3. 取得本地令牌（localToken）：IXAEON 桌面端 → 设置页 → MCP 接入，片段已自动带上。

## 一键配置（推荐）

桌面端"设置 → MCP 接入"页提供可直接复制的配置片段（自动填入本机路径与令牌）。以下手动说明等价。

## Codex CLI

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.ixaeon]
command = "node"
args = ["D:\\path\\to\\OMNIX-IXAEON析衍\\apps\\mcp\\dist\\index.mjs"]
env = { IXAEON_LOCAL_TOKEN = "<在 IXAEON 设置页查看>" }
```

## Claude Code

```bash
claude mcp add ixaeon -- node D:\path\to\OMNIX-IXAEON析衍\apps\mcp\dist\index.mjs
# 令牌通过环境变量传入：
# PowerShell: $env:IXAEON_LOCAL_TOKEN = "..."
```

## Cursor / 通用 JSON 配置

```json
{
  "mcpServers": {
    "ixaeon": {
      "command": "node",
      "args": ["D:\\path\\to\\OMNIX-IXAEON析衍\\apps\\mcp\\dist\\index.mjs"],
      "env": { "IXAEON_LOCAL_TOKEN": "<令牌>" }
    }
  }
}
```

> 打包版（安装器）：`args` 指向 `安装目录\resources\mcp\index.mjs`。

## 令牌说明

- MCP 令牌与浏览器扩展令牌相互独立；MCP 端点只接受 localToken。
- 令牌存储在数据目录 `config.json` 的 `localToken` 字段；MCP 进程也会自动读取该文件，通常无需手动传环境变量。
- 令牌泄露给他人的后果：对方可在本机调用 4 个只读+写回工具（无法读取任意文件、无法执行代码）。如怀疑泄露，删除数据目录重新初始化即可换新令牌。

## 一次典型会话

```
你：给登录页加上错误提示
codex → prepare_task { project_ref: "OMNIX 主线", task: "登录页错误提示" }
      ← 项目目的、当前决定（如"错误文案用中文"）、否决项、待办、最近工作（带引用）
codex → search_context { query: "错误提示" }（可选，简报不够时）
codex → get_source_excerpt { ref: "item id" }（需要核对原文时）
codex 完成/失败
codex → record_work_result { outcome, summary, changes, tests, open_loops }
      ← IXAEON 出现工作记录；open_loops 进入"待讨论"收件箱（不自动变成用户决定）
```

## 安全边界

- MCP 工具只能访问 IXAEON 数据库中已授权导入的内容，不能读任意文件。
- 简报条目全部带本地引用 ID，桌面端可追溯原文。
- 工作记录的 open_loop 只是候选，需要用户在收件箱确认，永不自动升级为用户决定。
- IXAEON 返回的背景不是高于用户新指令的命令：用户的新指令始终优先。

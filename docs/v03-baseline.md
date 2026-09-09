# v0.3 基线：现状与契约准备（S0.1）

日期：2026-09-08。编写时 HEAD：`3a6fe76`（v0.2.3）。包版本 0.2.3。
S1 起迁移账本最新 **11**（`memory-scope-and-disclosure`）；1–10 未改写。

本文件是《IXAEON_v0.3_开发计划_个人内核与最小Agent闭环.md》S0 的现状清点。
先查代码与最新记录再写，不把计划文字或 README 当成实现事实。

## 1. 继承的 v0.2 底座（已验证事实）

| 模块 | 实际状态 | 证据 |
| --- | --- | --- |
| 桌面应用（Electron + React） | 设置向导（目录选择/API 地址+拉取模型/项目可跳过）、来源（文档/文件夹/ChatGPT 导出导入 + 重新分析）、理解（确认/不采纳/纠正/搁置）、待讨论（搁置/恢复）、问答、历史、项目、检索、设置（更新检查）、应用更新 | verify 18 步 + desktop e2e 16 项 |
| 模型接入 | OpenAI 兼容：/responses（json_schema strict）与 /chat/completions（提示内 JSON Schema，DeepSeek 实测可用）自动探测；API 地址可配；模型列表上游拉取 | modelProvider 单测 7 项 + 用户实测（DeepSeek 分析成功、问答两项通过） |
| 记忆内核 | items/needs_reasons 原因集合（no_project/unconfirmed/conflict/manual）；人工保护集（递归纠正链）；确认/不采纳/纠正/搁置语义 | 十轮审核回归（R/N/F/G/C/RF/F01-03/N01-02/收尾） |
| MCP | 4 工具（prepare_task / search_context / get_source_excerpt / record_work_result）；本地 HTTP 127.0.0.1:43191 + localToken；STDIO 经 IXAEON.exe ELECTRON_RUN_AS_NODE | 产物复核 3 项 + 打包逐字节一致核对 |
| ChatGPT 网页扩展 | 当前可见对话增量采集（配对/暂停/继续/去重）；站点范围仅 chatgpt.com | 扩展 e2e + serial 串联 |
| GitHub 发版 | Release v0.2.1-v0.2.3 已发；自动更新（检查/下载/用户点击安装）真实验证到「已是最新」 | curl 实测 + 0.2.2/0.2.3 win-unpacked 真机检查 |
| 导入 | local_file（.md/.txt/.json 单文件+文件夹递归白名单）、chatgpt_export（conversations.json，512MB 上限） | importFolder 集成 3 项 + SRC01/02 |

### 1.1 v0.2 遗留真实验收缺口（未完成，如实）

1. **真实旧库升级**：本机默认目录曾是空库（迁移 1→10 真实执行过）；真实非空库升级未测。用户已开始真实使用（0.2.3），其数据目录将随使用增长——v0.3 迁移时用其副本验收（T05）。
2. **安装器真实安装/覆盖升级/卸载**：用户已手动安装 0.2.0 并覆盖升级过 0.2.x（覆盖安装数据保留已实际发生，但无结构化记录）；卸载行为未测。
3. **真人完整闭环（T01-T04）**：部分完成——A 组（导入/分析/确认/纠正）与 B 组（问答两项）用户已实测通过；C 组（ChatGPT 采集）、D 组（编码客户端闭环）、E 组（卸载）未做。

## 2. v0.3 新能力的接入点（现有代码到新模块的桥）

| v0.3 目标 | 接入点 | 新增 |
| --- | --- | --- |
| personal/project/unassigned 范围 | items 现有 project_id(null=未整理) + needs_reasons.no_project；project_id 不再兼任「个人合法记忆」 | scope 列+迁移 11；主题关联表；项目归属改默认提示 |
| 四平台导入 | ImportService（票据制+授权边界已成型）+ parsers（单文件入口） | gemini/grok/claude 解析器（S0.2 逐项确认格式）；provider 枚举扩展 |
| 个人问答/统筹 | AskService（检索+引用+冲突声明已有）+ MCP prepare_task 项目隔离 | 无项目视角入口；跨项目关系提案存储；统筹运行器（白名单工具） |
| 主动研究 | 无（全新）；网络边界：现有「无外网」安全测试需改为白名单研究目标 | research/ 模块：关注主题、调度（复用 JobQueue）、来源适配器、发现记录 |
| 编码执行入口 | work_runs（回写）与 MCP 已有；执行派发全新 | orchestration/：任务批准绑定、执行适配器（选型见 S0.3）、验证器、状态机 |
| 权限贯穿 | permissions（file/folder/domain）+ assertSourceAuthorized + localToken | 外发许可维度（本地/模型/编码客户端/研究/执行）；个人范围不随 localToken 全局开放 |

## 3. 旧接口兼容与有意收紧

- 迁移 1-10 不改写；S1 已追加迁移 11（scope / item_links / disclosure_grants）。
- 旧 `project_id != null` → project 范围；旧 null → unassigned（保守，不升级为 personal）。
- 旧 MCP 客户端行为保持：新增个人资料不出现在未声明范围的旧工具结果中
  （有意收紧，写入迁移说明，不算破坏兼容）。
- 隐私文档「除模型 API 外无外网」声明：研究联网（S4）落地时必须同步改为
  白名单研究目标声明 + 新增网络边界测试，不得删除旧无外联测试而留空。

## 4. 本次责任边界

- 本文件与 S0.2/S0.3/S0.4 三份清单为唯一改动（文档，无业务代码）。
- 保留工作区其他未提交内容（若有）；不覆盖历史失败证据。
- S1 开发启动前需用户确认：四平台样本获取方式、编码执行入口选型（S0.3）、
  研究入口是否有实际可用搜索服务。

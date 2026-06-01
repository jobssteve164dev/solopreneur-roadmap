# SoloMap 跨 Agent Harness 设计

## 产品边界

SoloMap 的初衷是补齐 Agent CLI 和用户项目生命周期之间的最后十公里。它不是新的 Agent CLI，也不应该重建模型调用、工具执行、代码生成或权限体系。大厂和成熟社区已经在 Agent CLI 上投入了大量能力，SoloMap 应充分利用这些 CLI 的潜力。

SoloMap 要做好的事情是管理 Agent CLI 如何服务项目生命周期：把项目目标转成路线图，把路线图环节转成可执行对话，把 memory、skill 和 MCP connector 放到统一上下文里，把执行日志、文件变更、状态、交接和验收沉淀回项目。用户面对的是项目推进，不是 Agent 配置工程。

## 目标

SoloMap 的跨 Agent harness 负责让不同 Agent CLI 在同一套项目上下文、能力说明和外部连接规则下工作。用户只需要理解“项目、经验、技能、连接器”，不需要理解每个 Agent 的私有目录、配置格式或调用差异。

核心目标：

- 普通用户用一套心智启动任务。
- Agent 共享同一份项目经验、可复用 skill 和 MCP 能力连接器。
- 插件吸收不同 CLI 的提示词、配置、权限和安装差异。
- 高风险能力默认不自动启用，避免把外部写入、发消息、云资源或密钥风险交给隐式匹配。

## 三层能力

### 1. Memory

位置：`.solomap-global/memory/`

Memory 保存长期上下文和跨项目经验，解决“Agent 开始任务前应该知道什么”。

主要目录：

- `profile.md`：用户长期偏好、协作方式和禁忌。
- `operating-rules.md`：跨任务通用执行规则。
- `projects/`：项目事实和稳定上下文。
- `patterns/`：可复用交付、排障和工程模式。
- `decisions/`：已确认的长期决策。
- `domains/`：跨项目领域知识。
- `inbox/`、`active/`：临时观察和当前交接。

任务启动时，SoloMap 注入默认系统提示词，要求 Agent 按需读取 memory，且以当前用户请求、当前项目文件、测试和日志为最高事实来源。

### 2. Skill

位置：`.solomap-global/skills/`

Skill 是“做事方法包”，解决“Agent 应该按什么方法做这类任务”。

主要结构：

- `registry.json`：统一 skill 注册表。
- `installed/<skill-id>/package/`：完整 skill package，入口为 `SKILL.md`。
- `installed/<skill-id>/solomap.skill.json`：统一元数据。
- `installed/<skill-id>/source.lock.json`：来源锁定信息。
- `runs/`：安装运行记录。

安装逻辑：

1. 用户在设置中粘贴 skill 来源。
2. 插件唤起当前默认 Agent CLI，并注入受控安装提示词。
3. Agent 下载、整理、生成元数据和 `result.json`。
4. 插件校验 package、`SKILL.md`、`solomap.skill.json`、`source.lock.json`。
5. 校验通过后写入 `registry.json`。

使用逻辑：

- 插件只把少量候选 skill 注入给 Agent。
- 高风险 skill 不自动作为候选。
- Agent 判断是否读取使用，并在输出中说明实际使用情况。

### 3. MCP Connector

位置：`.solomap-global/mcp/`

MCP Connector 是“外部能力连接器”，解决“Agent 可以连接哪些工具或服务”。

它比 skill 风险更高，因为 MCP 可能涉及进程、凭证、网络、外部写入、消息发送、云资源和密钥访问。因此 MCP 不应只是同步配置文件，而应作为受治理的能力连接器管理。

主要结构：

- `registry.json`：统一 MCP 注册表。
- `servers/<mcp-id>/package/`：MCP server package 或配置说明。
- `servers/<mcp-id>/solomap.mcp.json`：统一 MCP 元数据。
- `servers/<mcp-id>/source.lock.json`：来源锁定信息。
- `servers/<mcp-id>/profiles/`：不同 Agent CLI 的配置建议片段。
- `runs/`：安装、检测和修复记录。
- `profiles/`：全局 profile 汇总空间，供后续生成 Agent 专属配置视图。

安装逻辑：

1. 用户在设置中粘贴 MCP 来源、npm 包、GitHub 链接或配置片段。
2. 插件唤起默认 Agent CLI，并注入 MCP 受控安装提示词。
3. Agent 只做下载、复制、分析和配置建议生成。
4. Agent 不启动 MCP server，不登录外部服务，不写入 Agent 私有配置目录。
5. Agent 生成 `solomap.mcp.json`、`source.lock.json`、profiles 和 `result.json`。
6. 插件校验结果都位于 `.solomap-global/mcp/servers/` 下，再写入 `registry.json`。

使用逻辑：

- 插件只注入候选 MCP 摘要，不强制启用。
- Agent 只有在任务明确需要外部工具能力时才使用。
- 涉及外部写入、发消息、云资源、密钥或付费动作时，必须先停下要求用户明确授权。
- 高风险 MCP 默认不自动候选。

## Prompt 投递

所有非交互 Agent 任务都以文件承载完整任务：

- 完整 prompt 写入 `.solopreneur/agent-runs/<scope>/prompt.txt`。
- Codex/Cursor 使用 stdin 读取该文件。
- agy、Claude、Copilot、OpenCode 和未知 CLI 只接收一条短 wrapper，要求读取 `prompt.txt` 并严格执行。

禁止把完整多行任务通过 shell 参数、`"$agent_prompt"` 或 `$(cat prompt.txt)` 直接传给 CLI。

## 用户界面原则

前台不要求用户理解底层实现差异。

建议命名：

- Memory：经验库
- Skill：技能
- MCP：连接器 / 能力连接器

设置页用户动作：

- 设置跨项目数据目录。
- 安装技能。
- 安装连接器。
- 查看安装结果。

后续可以增加：

- 已安装技能列表。
- 已连接能力列表。
- 启用、禁用、仅手动。
- 风险说明和授权状态。
- 为不同 Agent 生成配置建议。

## 当前一版边界

已落地：

- `.solomap-global/memory` 默认经验库。
- `.solomap-global/skills` 跨 Agent skill 安装、注册和候选注入。
- `.solomap-global/mcp` 跨 Agent MCP connector 安装、注册和候选注入。
- 设置页提供 skill 和 connector 安装入口。
- Agent 任务前可接收 skill/MCP 候选摘要。

暂不做：

- 自动写入各 Agent 私有 MCP 配置。
- 自动启动或健康检查 MCP server。
- 自动注入高风险 MCP。
- MCP 凭证保存。
- 完整管理 UI。

这些应在后续讨论中按用户动作和风险边界逐步展开。

# SoloMap 跨 Agent Harness 设计

## 产品边界

SoloMap 的初衷是补齐 Agent CLI 和用户项目生命周期之间的最后十公里。它不是新的 Agent CLI，也不应该重建模型调用、工具执行、代码生成或权限体系。大厂和成熟社区已经在 Agent CLI 上投入了大量能力，SoloMap 应充分利用这些 CLI 的潜力。

SoloMap 要做好的事情是管理 Agent CLI 如何服务项目生命周期：把项目目标转成路线图，把路线图环节转成可执行对话，把 memory、skill、MCP connector 和外部增强能力放到统一上下文里，把执行日志、文件变更、状态、交接和验收沉淀回项目，并把可复用执行经验带入下一轮任务。用户面对的是项目推进，不是 Agent 配置工程。

## 目标

SoloMap 的跨 Agent harness 负责让不同 Agent CLI 在同一套项目上下文、能力说明和外部连接规则下工作。用户只需要理解“项目、经验、技能、连接器”，不需要理解每个 Agent 的私有目录、配置格式或调用差异。

核心目标：

- 普通用户用一套心智启动任务。
- Agent 共享同一份项目经验、可复用 skill、MCP 能力连接器和可选增强能力。
- 插件吸收不同 CLI 的提示词、配置、权限和安装差异。
- 高风险能力默认不自动启用，避免把外部写入、发消息、云资源或密钥风险交给隐式匹配。
- Agent 运行记录能沉淀为下一轮任务可用的执行经验，而不是停留在原始日志。
- 外部增强能力只让 Agent 跑得更快、更准、更省，不成为新的任务入口，也不要求用户理解内部实现差异。

## 五层能力

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

- 插件内建默认 skill。初始化 `.solomap-global/skills` 时会自动写入完整 package 和注册表条目，让高复用执行方法以 skill 形式进入任务候选，而不只依赖系统提示词注入。首批内建 skill 包括：
  - `solomap-global-execution-guide`：全局工程执行指南。
  - `solomap-roadmap-planning`：SoloMap 路线图生成与调整。
  - `solomap-project-docs-lifecycle`：项目生命周期工程文档维护。
  - `solomap-cross-project-memory`：跨项目记忆沉淀。
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

### 4. Execution Experience

位置：第一版依托 `.solopreneur/agent-runs/`、`.solopreneur/step-memory/`、`.solomap-global/memory` 和 `.solomap-global/learning`；后续可补 Run Digest 与 Execution Graph 索引。

Execution Experience 保存项目推进过程中的可复用执行经验，解决“Agent 下次如何少探索、少犯同样错误、复用正确验证”。

它不替代 Agent CLI 原生 memory，也不重建模型推理或代码生成。它只把 SoloMap 已经记录的运行事实转成下一轮任务可用的上下文。

详细边界见 [SoloMap 全局执行经验层设计](./execution-experience-layer.zh.md)，方法论见 [SoloMap 执行经验层方法论](../methodology/execution-experience-methodology.zh.md)。

### 5. Harness Enhancement

位置：`.solomap-global/enhancements/`

Harness Enhancement 是“外部增强能力”，解决“Harness 如何让 Agent 运行得更快、更准、更省”。

它不同于 skill 和 MCP：

| 类型 | 解决什么 | 典型例子 |
| --- | --- | --- |
| Skill | Agent 应该按什么方法做这类任务 | 调试流程、写作流程、文档生命周期维护 |
| MCP Connector | Agent 可以连接哪些外部工具或服务 | GitHub、Gmail、数据库、Cloudflare |
| Harness Enhancement | Harness 如何增强 Agent 的执行环境、上下文定位或输出效率 | 命令输出优化器、代码结构索引、日志压缩器、影响面分析器 |

主要结构：

- `registry.json`：统一增强能力注册表。
- `installed/<enhancement-id>/package/`：增强能力 package、适配说明或本地安装材料。
- `installed/<enhancement-id>/solomap.enhancement.json`：统一增强能力元数据。
- `installed/<enhancement-id>/source.lock.json`：来源锁定信息。
- `installed/<enhancement-id>/profiles/`：不同 Agent CLI 或运行路径的接入建议。
- `runs/`：安装、检测、修复和验证记录。

安装逻辑沿用 skill / MCP 的受控安装心智：

1. 用户在设置中粘贴增强能力来源，例如 GitHub repo、npm 包、二进制下载说明或本地路径。
2. 插件唤起默认 Agent CLI，并注入增强能力受控安装提示词。
3. Agent 下载、复制、分析并生成 manifest、profiles 和 `result.json`。
4. 插件校验 package、`solomap.enhancement.json`、`source.lock.json`、可用性检测命令和风险声明。
5. 校验通过后写入 `registry.json`。

运行逻辑：

- 插件根据任务类型、项目类型、风险级别和可用性检测决定是否注入增强能力摘要。
- 增强能力失败时必须无感回退到原 Agent 任务流程，不能阻断主任务。
- 增强能力不能替代当前文件、日志、测试和命令结果这些事实来源。
- 涉及外部写入、账号授权、网络服务、密钥、付费动作或不可逆操作时，必须先要求用户明确授权。
- 用户前台最多看到“已启用命令输出优化”“已启用代码结构辅助”这类行动收益，不需要理解 hook、索引、schema、manifest、路由规则或内部配置差异。

首批试点方向：

- `rtk` 代表执行输出优化：它适合作为可选命令输出压缩辅助，帮助 Agent 在 `ls`、`grep`、构建、测试摘要和大文件结构扫描中减少 token 消耗；它不是无损事实来源，进入根因定位、验收、安全、权限或发布判断时必须允许 Agent 回读原始输出、原始文件和完整日志。
- `CodeGraph` 代表代码结构理解增强：它适合作为代码符号、调用关系和影响半径维度，帮助 Agent 在任务开始前减少盲目搜索；它不负责判断运行是否成功，也不替代执行经验、用户纠偏、验证命令和当前代码事实。

第一版不做通用插件生态，而是验证三件事：

- Harness 能识别外部增强能力是否可用。
- Harness 能在正确任务中注入正确增强。
- Harness 能在增强失败或不适用时回退到原流程。

## Prompt 投递

所有非交互 Agent 任务都以文件承载完整任务：

- 完整 prompt 写入 `.solopreneur/agent-runs/<scope>/prompt.txt`。
- Codex/Cursor 使用 stdin 读取该文件。
- Antigravity/agy 使用 stdin 读取 `prompt.txt`，不能只发“请读取 prompt.txt”的短 wrapper；实际运行中短 wrapper 可能被模型当成普通任务处理，导致忽略用户本次要求。也不能把完整 prompt 放进启动命令参数，避免命令过长、转义和旧会话串线问题。
- Claude、Copilot、OpenCode 和未知 CLI 仍接收短 wrapper，要求读取 `prompt.txt` 并严格执行，除非后续真实日志证明该 CLI 也不可靠。

禁止把完整多行任务通过 shell 参数、`"$agent_prompt"` 或 `$(cat prompt.txt)` 直接传给 CLI。

## 用户界面原则

前台不要求用户理解底层实现差异。

建议命名：

- Memory：经验库
- Skill：技能
- MCP：连接器 / 能力连接器
- Harness Enhancement：增强能力

设置页用户动作：

- 设置跨项目数据目录。
- 安装技能。
- 安装连接器。
- 安装增强能力。
- 查看安装结果。

后续可以增加：

- 已安装技能列表。
- 已连接能力列表。
- 已启用增强能力列表。
- 启用、禁用、仅手动。
- 风险说明和授权状态。
- 为不同 Agent 生成配置建议。

## 当前一版边界

已落地：

- `.solomap-global/memory` 默认经验库。
- `.solomap-global/skills` 跨 Agent skill 安装、注册和候选注入。
- 内建默认 skill，覆盖全局工程执行、路线图生成/调整、项目生命周期工程文档维护和跨项目记忆沉淀。
- `.solomap-global/mcp` 跨 Agent MCP connector 安装、注册和候选注入。
- 设置页提供 skill 和 connector 安装入口。
- Agent 任务前可接收 skill/MCP 候选摘要。
- 全局执行经验层设计与方法论文档。

暂不做：

- 自动写入各 Agent 私有 MCP 配置。
- 自动启动或健康检查 MCP server。
- 自动注入高风险 MCP。
- MCP 凭证保存。
- Harness Enhancement 安装与 registry。
- 自动运行第三方工具的全局 hook 安装。
- 把第三方增强能力的 tracking、tee、索引或运行日志混入 SoloMap 主运行记录。
- 完整管理 UI。
- 独立 Execution Graph 数据库、embedding 召回和自动经验升级。

这些应在后续讨论中按用户动作和风险边界逐步展开。

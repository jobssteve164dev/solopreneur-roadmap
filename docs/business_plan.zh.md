# SoloMap AI Roadmap - 战略路线图与商业计划

## 1. 执行摘要

SoloMap AI Roadmap 是一个本地优先的 VS Code 插件，面向使用 AI Agent 构建产品的独立开发者和一人软件公司。它解决的不是“再生成一些代码”，而是帮助用户决定下一步做什么、跟踪项目进度、保留上下文，并把 Agent 执行结果绑定到产品路线图上。

这个产品不应该正面竞争 Cursor、GitHub Copilot、Kilo Code、Cline、Claude Code 或 Codex 这类“写代码的 Agent”。这些工具模型能力强、资金密集、生态成熟。SoloMap 更有防御力的位置在它们上方：作为产品生命周期控制面，把用户想法变成路线图，把路线图环节变成 Agent 可执行任务，记录执行结果，并给独立开发者一个本地、Git 友好的项目操作系统。

推荐定位：

> 面向已经使用 AI 编码 Agent 的独立开发者的项目路线图与执行驾驶舱。

第一个可变现人群是技术型独立开发者：他们在 VS Code 中构建 SaaS、插件、自动化工具、模板和微型产品。真正痛点不是“我还需要一个编码助手”，而是“我的 AI 工作散落在提示词、终端、TODO、聊天历史和半成品任务里，我丢失上下文，项目停止推进”。

## 2. 现实锚点

代码与产品中已经观察到：

- 这是一个本地优先的 VS Code 插件，用于独立开发者项目路线图与 Agent 编排。
- README 已经把它定位为面向独立开发者和一人公司的 AI 路线图与 Agent 任务流工具。
- 产品使用 Git 友好的 CSV 作为路线图真实源，并使用本地 SQLite/WASM 记录执行日志。
- 它通过 VS Code 终端运行本地 Agent CLI，并通过本地状态文件检测完成状态。
- 它同时提供侧边栏控制面板和完整路线图大图，两者共享状态。

推论：

- 产品优势不是原始代码生成能力，而是工作流记忆、项目状态、路线图结构和本地执行控制。
- 最强用户承诺是“用 Agent 时不丢方向，持续推进交付”，不是“比 Cursor/Copilot 写代码更强”。
- 最合理商业模式是开发者工具 Freemium：先把本地生产力功能做出留存，再考虑可选云端协作或同步。

## 3. 市场背景

AI 开发工具已经主流化，但 Agent 工作流仍然处于信任和使用习惯尚未完全建立的阶段。Stack Overflow 2025 开发者调查显示，大量开发者正在使用或计划使用 AI 工具，但对“差一点正确”的 AI 结果、调试成本、安全隐私、价格和替代方案仍有明显顾虑。

VS Code 是正确的初始渠道。开发者大量使用 VS Code，GitHub 生态也在把 Copilot 从补全和聊天推进到异步编码 Agent。Agentic workflow 正在进入生产行为，但用户仍需要更好的控制、验证和连续性。

战略含义：

- 需求存在，但信任与工作流质量仍未解决。
- 开发者不缺一个泛用 AI 输入框。
- 他们需要上下文连续、任务拆解、执行可追踪、本地控制，以及中断后能继续推进的方式。

## 4. 商业模式

### 产品驱动 Freemium

免费版本：

- 本地路线图创建与编辑。
- Starter roadmap。
- CSV 路线图存储。
- 从路线图环节启动本地 Agent。
- 基础执行历史。
- 中英文界面。

Pro 版本：

- 多项目仪表盘和项目组合视图。
- SaaS、VS Code 插件、Chrome 插件、自动化脚本、内容产品、Marketplace、API 产品等高级模板。
- 跨项目 Agent 执行历史搜索。
- 从历史上下文重新运行。
- Prompt 与任务库。
- 路线图健康评分：阻塞环节、长期停滞任务、缺失验证、近期无进展。
- 可导出的投资人、客户或产品路线图。
- 私有 license 激活。

后续 Studio/Team：

- 2 到 5 人微型团队共享路线图空间。
- 角色化任务交接。
- 共享执行日志。
- 云备份与同步。
- 客户项目治理能力。

服务与模板：

- 常见独立开发产品的付费 Launch Kit。
- 路线图诊断、上线准备度审计、AI 工作流搭建等打包服务。
- 基础产品有留存后，再考虑模板和 Agent playbook 市场。

### 收入逻辑

建议定价：

- Free：足够形成日常使用习惯。
- Pro：每月 12-19 美元，或每年 99-149 美元。
- Studio：每月 29-49 美元，面向小团队和代理商。
- 早期 Founder Lifetime：99-199 美元，限量并明确早期访问属性。
- 模板包：一次性 19-49 美元。

定价逻辑：

- SoloMap 位于主 AI IDE 之下，应补充而不是替代付费编码 Agent。
- BYOK 和本地优先降低了推理成本压力，因为核心计划不需要为大模型调用买单。

## 5. 目标用户

### 第一人群：技术型独立开发者

画像：

- 独自或偶尔与外包协作构建软件产品。
- 长期在 VS Code 中工作。
- 使用 Cursor、Copilot、Codex、Claude Code、Cline、Kilo Code、Roo 等 Agent。
- 有多个半成品想法，上下文分散在 Markdown、提示词、聊天和终端中。
- 重视本地控制和 Git 友好工作流。

核心任务：

- 把想法变成具体构建路线图。
- 不重读历史聊天也知道下一步。
- 把任务交给 Agent，同时保持控制感。
- 几天或几周后能恢复项目。
- 保留决策、输出和验证证据。
- 即使 Agent 只完成一部分，也能继续推进。

购买触发：

- 副业项目经历几次 AI 对话后停滞。
- 用户同时管理多个产品。
- AI 生成代码带来大量清理工作。
- 用户想要可复用的上线流程。
- 用户不希望项目状态被锁在 SaaS 仪表盘中。

### 第二人群：Indie Hacker 和 Micro-SaaS Builder

他们更关心发布和增长，不只关心工程结构。产品需要更强的路线图模板、下一步动作、上线检查、分发任务、定价页、用户反馈循环。

### 第三人群：开发者代理商和 Fractional CTO

他们管理多个小型客户项目，需要可追踪 Agent 工作记录、项目状态和可导出进度报告。

## 6. 竞争格局

| 类别 | 示例 | 用户承诺 | 威胁 | SoloMap 可占据的位置 |
| --- | --- | --- | --- | --- |
| AI IDE | Cursor、Windsurf、Antigravity | 在编辑器内写和改代码 | 日常工作流锁定强 | 它们重在编码，不重在创始人级项目生命周期和路线图记忆 |
| AI 编码 Agent | Copilot coding agent、Codex、Claude Code、Devin | 把编码任务委托给 Agent | 品牌和模型强 | 它们需要结构化任务、进度状态和持久项目上下文 |
| 开源 Agent 插件 | Kilo Code、Cline、Roo Code | BYOK、多模型、IDE 内 Agent | 社区强 | 它们是执行引擎，SoloMap 可以成为计划和协调层 |
| 项目工具 | Linear、Notion、GitHub Projects、Jira、Trello | 跟踪工作 | 用户已有习惯 | 太通用，不围绕 AI Agent 执行 |
| 规格/PRD 工具 | Spec Kit、Markdown spec managers | 让规格贴近代码 | 与路线图规划有重叠 | SoloMap 连接规格、Agent 步骤和执行日志 |
| AI App Builder | Lovable、Bolt、v0、Replit Agent | 从提示词快速生成应用 | 对非技术用户吸引力强 | 本地所有权、长期维护和 Git 友好不足 |

战略响应：不要让用户离开他们已经使用的 Agent。SoloMap 应成为“带上你的 Agent，我们给它路线图、记忆和执行闭环”的上层工作台。

## 7. 定位

推荐品类：

> 面向独立开发者的 AI 项目执行驾驶舱。

避免主打：

- “AI coding assistant”：会直接触发与 Cursor/Copilot 对比。
- “Project management tool”：过于通用且拥挤。
- “Agent orchestrator”：太像实现者语言。

核心信息：

> 把产品想法变成可执行路线图，从每个环节运行你偏好的 AI Agent，并把完整项目记忆保存在本地工作区。

价值支柱：

1. 不丢方向：始终知道下一步。
2. 保持控制：Agent 在终端中可见运行。
3. 保留记忆：路线图和执行历史跟随项目。
4. 本地优先：Git 友好文件、本地日志、无强制 SaaS 绑定。
5. 持续交付：为常见独立开发产品提供可复用模板。

公开文案应使用用户语言：

- “知道下一步该构建什么。”
- “不用重读旧聊天，也能恢复项目。”
- “从任务运行 Agent，而不是从空白提示词开始。”
- “把路线图和执行历史放在代码旁边。”

避免在公开主文案中使用：

- File sentinel IPC。
- WASM SQLite。
- DAG。
- CLI orchestration contract。
- Bi-directional sync engine。

这些可以作为技术文档中的产品证据，不应成为营销主语。

## 8. 产品策略

MVP 要把四件事做到足够好：

1. 从产品想法生成有用路线图。
2. 告诉创始人下一步可执行动作。
3. 针对该环节运行用户选择的 Agent。
4. 保留发生过什么，让用户可以恢复项目。

任何不能强化这四个循环的功能都应推迟。

### 激活时刻

用户应在 5 分钟内感受到价值：

1. 安装插件。
2. 打开项目。
3. 输入产品想法。
4. 看到具体路线图。
5. 点击第一个可执行环节。
6. 看到终端 Agent 运行，路线图状态更新。

激活指标：

- 一个会话内生成第一份路线图并启动第一次 Agent run。

### 留存循环

用户间隔一段时间回来时，应立即知道：

- 上次改了什么。
- 还卡在哪里。
- 下一步最佳动作是什么。
- 哪个 Agent 提示词或输出属于哪个路线图环节。

周留存指标：

- 用户在后续会话打开同一项目并推进至少一个路线图环节。

## 9. 12 个月战略路线图

### 阶段 1：可信免费核心（0-6 周）

目标：让免费产品足够可靠，可以用于真实项目。

交付：

- 清晰首启流程。
- 从想法生成路线图。
- 可运行的下一步卡片。
- Agent CLI 设置与缺失时的可继续路径。
- 每个路线图环节的执行日志。
- 简单本地项目切换。
- 中英文界面一致。
- Marketplace 与 README 围绕用户结果重写。

成功标准：

- 40% 以上首启用户生成路线图。
- 25% 以上启动至少一次 Agent run。
- CLI/配置缺失导致的激活阻断错误低于 5%。

### 阶段 2：可重复交付系统（6-12 周）

目标：成为独立开发者管理多个想法的默认工作区。

交付：

- 按产品类型的路线图模板。
- “恢复项目”视图。
- 停滞/阻塞任务检测。
- Prompt 历史和重新运行。
- 基础 Markdown 导出。
- 项目健康摘要。

成功标准：

- 激活用户中 20% 以上每周回访。
- 激活用户中 15% 创建 2 个以上项目。
- 用户反馈中自然提到“恢复”“跟踪”“下一步”。

### 阶段 3：可变现 Pro（3-6 个月）

目标：转化跨项目依赖 SoloMap 的高频用户。

交付：

- License 激活。
- 跨项目仪表盘。
- 高级模板包。
- 全历史搜索。
- 任务和 Prompt 库。
- 可导出进度报告。
- 路线图健康评分。

成功标准：

- 激活用户 3-5% 免费转付费。
- 付费用户 30% 以上每周使用。
- 前两个计费周期后月流失低于 8%。

### 阶段 4：生态与分发（6-12 个月）

目标：围绕独立开发者工作流建立小生态。

交付：

- 模板市场或精选模板库。
- 与主流本地 Agent 集成。
- 可选 GitHub issue 同步，但不作为主工作流。
- 条件合适时发布 Open VSX。
- 面向小团队/代理商的 Studio tier。

成功标准：

- 10,000+ 安装。
- 1,000+ 激活用户。
- 100+ 付费用户。
- 3-5 个可重复获客渠道。

## 10. Go-To-Market

启动切口：

> Stop losing the thread between AI coding sessions.

不要主打架构、存储或编排。用户故事是连续性、控制感和交付。

渠道：

- VS Code Marketplace：围绕 AI roadmap、AI project manager、agent workflow、solo developer、indie hacker、local-first 优化。
- GitHub：README 结果导向，展示 idea -> roadmap -> run agent -> completed step。
- Indie hacker 社区：Product Hunt、Hacker News Show HN、Reddit、X/Twitter。
- 内容：展示如何在 VS Code 中经营一人软件公司、5 分钟从想法到 Agent-ready 路线图、为什么 AI Agent 需要路线图而不是另一个聊天框。
- 合作：开源 Agent 社区、模板作者、独立开发教育者。

转化路径：

1. 免费安装。
2. 生成第一份路线图。
3. 启动第一次 Agent run。
4. 创建第二个项目或 7 天后回访。
5. 当用户触达高频需求时提示 Pro：跨项目搜索、高级模板、导出报告、历史搜索、多项目仪表盘。

不要过早用付费墙阻断第一次成功运行。核心产品必须先证明价值。

## 11. 运营指标

获客：

- Marketplace 曝光。
- Marketplace 安装转化。
- GitHub stars。
- 官网转化。
- Demo 视频完播率。

激活：

- 路线图生成。
- 项目创建。
- CLI 配置。
- 第一次 Agent run。
- 第一个路线图环节完成。

留存：

- 每周活跃项目。
- 按项目回访用户。
- 每周推进环节数。
- 停滞项目重新激活。

变现：

- 激活到付费转化。
- 试用到付费转化。
- 月流失。
- 付费用户平均收入。
- 模板包购买率。

产品质量：

- Agent run 失败率。
- CLI 缺失导致失败。
- 路线图生成 fallback 率。
- 从安装到第一个可执行环节的时间。
- 每 100 个激活用户的支持请求数。

## 12. 风险与缓解

### 竞争工具增加路线图功能

缓解：围绕本地优先、跨 Agent、Git 友好连续性建立优势，把模板和执行历史做到足够好，并优先集成 Agent 而不是竞争。

### 用户不想再多一个工具

缓解：留在 VS Code 内，使用项目本地文件，首启 5 分钟内给出价值，免费核心不要求创建 SaaS 账号。

### Agent 执行显得脆弱

缓解：终端执行可见，按环节捕获日志，失败状态可行动，并支持从上下文安全重试。

### 变现不足

缓解：基础路线图免费，跨项目记忆、高级模板、历史搜索和报告付费，并增加模板包和 Launch Kit。

### 公开文案太技术化

缓解：所有公开界面围绕用户动作重写，内部架构语言只留在开发者文档中。每张截图都必须回答“我下一步该做什么”。

## 13. 近期行动计划

### 产品

- 围绕用户结果重写 README hero 和功能文案。
- 增加从想法到第一次 Agent run 的首启流程。
- 改善 CLI 缺失设置，让用户能继续而不是直接卡住。
- 把“恢复项目”和“下一步动作”做成一级 UI 概念。

### 商业

- 创建一个带安装 CTA 和 30 秒 GIF 的单页官网。
- 定义 Pro 功能边界，但在留存清晰前不急着实现付费。
- 访谈 15-20 个已经使用 Cursor/Copilot/Codex/Claude Code 的目标用户。
- 创建三个模板包：Micro-SaaS、VS Code Extension、Automation Script。

### 分发

- 在开发者社区发布短 Demo。
- 增加围绕真实工作流的 Marketplace 截图。
- 用 SoloMap 构建一个公开产品，并发布过程。

### 验证

- 如果暂不做遥测，先手动跟踪首启激活。
- 使用 opt-in 本地分析或显式反馈导出，保持本地优先定位。
- 观察用户一周后是否回到同一项目继续推进。

## 14. 战略结论

SoloMap 应赢在“独立开发者产品想法”和“AI 编码 Agent”之间缺失的操作层。市场已经有很多 Agent 和 AI IDE，未解决的问题是独立开发者仍会丢失上下文、丢失动能，很难把散落的 AI 会话变成完成的产品。

因此，产品必须保持：

- 本地优先。
- Agent 无关。
- 路线图中心。
- 执行可感知。
- 极度聚焦用户下一步动作。

如果 SoloMap 能可靠帮助独立开发者恢复项目、运行下一个 Agent 任务，并跨多个项目持续交付，那么即使在拥挤的 AI 开发工具市场中，也有可信的付费细分位置。

## 资料来源

- Stack Overflow 2025 Developer Survey: https://survey.stackoverflow.co/2025
- GitHub Octoverse 2025: https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/
- GitHub Copilot coding agent announcement: https://github.com/newsroom/press-releases/coding-agent-for-github-copilot
- GitHub Copilot plans: https://docs.github.com/en/copilot/get-started/plans
- Cursor pricing: https://cursor.com/pricing
- Kilo AI product page: https://kilo.ai/
- Kilo open-source/BYOK commitment: https://kilo.ai/open


# SoloMap「Codex for Open Source」申请表填写稿

本文用于申请 [Codex for Open Source](https://openai.com/zh-Hans-CN/form/codex-for-oss/)。申请前请把文中的个人信息占位符替换为真实信息，并再次核对会变化的公开数据。

## 申请策略

SoloMap 目前仍是早期开源项目，不应把申请建立在“已经被广泛采用”的夸大表述上。更可信的申请理由是：项目公开、采用 MIT 许可证、维护活跃，直接帮助独立开发者在本地项目中持续使用 Codex 等编码 Agent，并且 API 额度有清晰、可审计的开源维护用途。

## 表单逐项填写

### 姓氏

`[你的姓氏，与 ChatGPT 账户信息一致]`

### 名字

`[你的名字，与 ChatGPT 账户信息一致]`

### 电子邮箱

`[与你的 ChatGPT 账户关联的邮箱]`

### GitHub 用户名

`jobssteve164dev`

提交前确认该 GitHub 个人资料为公开状态。

### GitHub 代码仓库 URL

`https://github.com/jobssteve164dev/solopreneur-roadmap`

### 说明你的角色：你是主要维护者还是核心维护者？

选择：`主要维护者`

### 为什么这个代码仓库符合要求？

推荐填写以下英文版本：

> SoloMap is an actively maintained, MIT-licensed VS Code extension that gives solo developers a local-first, Git-friendly roadmap and execution cockpit for Codex and other coding agents. The public project currently has 7 GitHub stars, 1 fork, 114 VS Code Marketplace installs, and at least 100 published releases. It helps make agent work reproducible by keeping plans, task context, execution history, and verification evidence beside the code instead of in scattered chats.

中文参考：

> SoloMap 是一个持续维护、采用 MIT 许可证的 VS Code 插件，为独立开发者提供本地优先、Git 友好的路线图与 Codex 等编码 Agent 执行驾驶舱。项目目前有 7 个 GitHub stars、1 个 fork、114 次 VS Code Marketplace 安装和至少 100 个公开版本。它将计划、任务上下文、执行历史和验证证据保存在代码旁，帮助开发者把零散的 Agent 对话变成可复现的开源工作流。

### 我感兴趣的是

建议同时选择：

- `Codex Security`
- `项目的 API 额度`

Codex Security 可用于审查这个会启动本地 CLI、处理项目路径并保存执行记录的 VS Code 插件；API 额度则可支持公开仓库的日常维护自动化。

### 你的项目为何需要 Codex Security？

推荐填写以下英文版本：

> SoloMap is a VS Code extension that launches local coding-agent CLIs and handles repository files, generated prompts, process execution, local paths, and persistent run history. These trust boundaries create risks such as command injection, path traversal, unsafe file writes, secret exposure, malicious repository content, and vulnerable dependencies. Codex Security would help us continuously identify, validate, and prioritize exploitable findings before they affect open-source users.

中文参考：

> SoloMap 是一个会启动本地编码 Agent CLI，并处理仓库文件、生成的提示词、进程执行、本地路径和持久运行历史的 VS Code 插件。这些信任边界可能带来命令注入、路径穿越、不安全文件写入、密钥泄露、恶意仓库内容和依赖漏洞等风险。Codex Security 可以帮助我们持续发现、验证并确定可利用安全问题的优先级，避免其影响开源用户。

### OpenAI 组织 ID

`[登录 OpenAI Platform 后填写 org- 开头的组织 ID]`

使用与本次申请邮箱对应、计划承接开源项目 API 额度的组织。不要填写 API Key 或 Project ID。

### 你将如何针对自己的项目使用 API 额度？

推荐填写以下英文版本：

> We will use the API credits only for SoloMap's open-source maintenance: triaging and deduplicating GitHub issues, reviewing pull requests, proposing regression tests, checking release readiness, drafting release notes, and auditing security-sensitive changes in CLI execution, local file handling, and agent handoffs. We also plan to evaluate opt-in maintenance workflows that help contributors reproduce failures and turn verified fixes into reusable project guidance. No credits will be resold.

中文参考：

> API 额度将仅用于 SoloMap 的开源维护：分类和去重 GitHub Issues、评审 PR、建议回归测试、检查发布就绪状态、起草发布说明，以及审计 CLI 执行、本地文件处理和 Agent 交接中的安全敏感改动。我们还计划验证可选的维护工作流，帮助贡献者复现故障，并把经过验证的修复沉淀为可复用的项目指导。额度不会被转售。

### 还有其他需要说明的事项吗？

推荐填写以下英文版本：

> SoloMap is built in public and is designed to complement Codex rather than replace it. Users bring their preferred local agent, while SoloMap supplies the roadmap, bounded task context, visible terminal execution, and durable local history needed to keep long-running projects moving. Support from this program would directly reduce the maintenance load of a fast-moving early-stage project and help us publish safer, better-tested integrations for the open-source developer community.

中文参考：

> SoloMap 采用公开开发方式，目标是补充而不是替代 Codex。用户继续使用偏好的本地 Agent，SoloMap 则提供路线图、有边界的任务上下文、可见的终端执行和持久本地历史，让长期项目持续推进。本项目的支持将直接减轻早期开源项目快速迭代中的维护负担，并帮助我们为开源开发者社区发布更安全、测试更充分的集成。

## 提交前检查

- 个人姓名和邮箱与 ChatGPT 账户一致。
- GitHub 个人资料和仓库均为公开状态。
- OpenAI 组织 ID 来自承接额度的正确组织。
- 重新核对 GitHub stars、forks、Marketplace installs 和发布数量；数据增长后同步更新文案。
- 确认所选权益与计划用途一致，并阅读申请页面链接的项目条款。

## 本稿依据

- [Codex for Open Source 申请表](https://openai.com/zh-Hans-CN/form/codex-for-oss/)
- [Codex for Open Source 项目说明](https://developers.openai.com/community/codex-for-oss)
- [SoloMap GitHub 仓库](https://github.com/jobssteve164dev/solopreneur-roadmap)
- [SoloMap VS Code Marketplace 页面](https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap)

公开数据核对日期：2026-07-21。

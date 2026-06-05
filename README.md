<p align="center">
  <img src="https://raw.githubusercontent.com/jobssteve164dev/solopreneur-roadmap/main/resources/logo.png" width="150" height="150" alt="SoloMap Logo" />
</p>

<h1 align="center">SoloMap: AI Roadmap & Agent Task Flow</h1>

<p align="center">
  <strong>Stop losing momentum in scattered AI chats. Turn every project into a local execution cockpit.</strong><br />
  <strong>别让项目迷失在零散 AI 对话里。把每个项目变成 VS Code 里的本地推进驾驶舱。</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-blue?style=flat-square&logo=visual-studio-code" alt="Marketplace" /></a>
  <a href="https://github.com/jobssteve164dev/solopreneur-roadmap/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-emerald?style=flat-square" alt="License" /></a>
  <a href="https://github.com/jobssteve164dev/solopreneur-roadmap"><img src="https://img.shields.io/badge/Git-Friendly-purple?style=flat-square&logo=git" alt="Git Friendly" /></a>
</p>

---

## Why SoloMap? / 为什么选择 SoloMap？

SoloMap is for solo builders who already use AI agents, but still lose track of what to do next, what the Agent changed, which projects are stuck, and what users just told them. It gives each project a clear next action, runs your local Agent CLI from the right context, and keeps the evidence of progress where you work: inside VS Code and your local repo.

SoloMap 面向已经在用 AI Agent 的独立开发者，但真正的问题往往不是“再生成一点代码”，而是下一步做什么、Agent 改了什么、哪个项目卡住了、用户反馈该怎么吸收。SoloMap 给每个项目一个清晰的下一步，用正确上下文启动你的本地 Agent CLI，并把推进证据留在你工作的地方：VS Code 和本地仓库。

Use it as the operating panel above your AI coding tools: register projects, see what needs attention, run the next roadmap step, capture open-ended Solo work, collect feedback, and learn across projects without sending your roadmap state to a hosted backend.

你可以把它当成 AI 编码工具之上的项目操作面板：登记项目、看到哪里最需要推进、运行下一步路线图任务、承接开放式 Solo 工作、收集反馈，并在多个项目之间复用经验，而不需要把路线图状态交给插件后端服务。

---

## Methodology / 方法论

SoloMap follows a simple builder loop: find the real problem, build the product system, sell to customers, then keep scaling through Build -> Sell -> Learn -> Improve.

SoloMap 遵循一套面向独立开发者的行动循环：发现真实问题，打造产品系统，卖给客户，再通过 Build -> Sell -> Learn -> Improve 持续放大。

See [docs/methodology/methodology.md](docs/methodology/methodology.md) for the full methodology. 中文版本见 [docs/methodology/methodology.zh.md](docs/methodology/methodology.zh.md)。

完整方法论见 [docs/methodology/methodology.zh.md](docs/methodology/methodology.zh.md)，英文版本见 [docs/methodology/methodology.md](docs/methodology/methodology.md)。

Next-stage product planning is tracked in [docs/roadmap/next-feature-plan.zh.md](docs/roadmap/next-feature-plan.zh.md).

下一阶段功能规划见 [docs/roadmap/next-feature-plan.zh.md](docs/roadmap/next-feature-plan.zh.md)。

Full documentation map: [docs/README.zh.md](docs/README.zh.md).

完整文档入口见 [docs/README.zh.md](docs/README.zh.md)。

---

## Core Capabilities / 核心能力

### Project Command Center / 项目推进侧边栏

- Track multiple local projects from the SoloMap activity bar.
- 在 SoloMap 侧边栏集中查看多个本地项目。
- See the current stage, next action, recent delivery signals, feedback issues, and latest Agent activity without opening every roadmap.
- 不必逐个打开大图，也能看到当前阶段、下一步、近期交付信号、反馈 Issue 和最近 Agent 动作。
- Refresh a project card on demand when you need the latest local and GitHub-backed signals.
- 需要最新状态时，可以直接刷新项目卡片里的本地与 GitHub 信号。

### AI Roadmap / AI 路线图

- Break a project idea into executable steps from planning to delivery.
- 把项目想法拆成从规划到交付的可执行环节。
- Start with a runnable starter roadmap, then ask a local Agent to rewrite the real `roadmap.csv` for your project.
- 默认初始化为可执行 starter roadmap，再通过本地 Agent 按你的项目要求改写真实的 `roadmap.csv`。
- Revise the roadmap at any time when priorities or direction change, using the same local Agent conversation flow.
- 当目标、优先级或方向变化时，可随时通过同一套本地 Agent 对话流程调整路线图。
- Store the roadmap in `.solopreneur/roadmap.csv`, making it easy to review, diff, and manage with Git.
- 路线图保存在 `.solopreneur/roadmap.csv`，便于 Git 管理、审阅和跨设备迁移。

### Agent Task Flow / Agent 任务流

- Expand each roadmap step into a task conversation history.
- 每个路线图环节都可以展开为任务对话列表。
- Add extra instructions for a single run and choose which local Agent CLI should handle it.
- 你可以为单次任务补充要求，并选择本地 Agent CLI 执行。
- Track Agent input, output, status, changed files, and retry actions in the same step card.
- SoloMap 会记录 Agent 输入、输出、状态、修改文件列表和重试入口。
- Keep structured step memory in `.solopreneur/step-memory/` so each Agent run can read the current step context before working.
- 环节记忆保存在 `.solopreneur/step-memory/`，Agent 每次工作前都会被要求读取当前环节上下文。

### Solo Conversations / Solo 对话

- Use Solo mode for open-ended project work that is not tied to the current roadmap step.
- 使用 Solo 模式处理不适合直接归入当前路线图环节的开放式项目请求。
- Keep the latest Solo conversation visible on the project card and continue native Agent sessions when supported.
- 在项目卡片上查看最近一次 Solo 对话，并在支持时继续原生 Agent 会话。

### Feedback and Learning / 反馈与学习

- Capture seed-user feedback from inside the extension and route it to GitHub Issues when configured.
- 在插件内收集种子用户反馈，并在配置可用时同步到 GitHub Issues。
- Review daily cross-project signals so repeated lessons, blockers, and reusable context can shape the next action.
- 通过今日聚焦查看跨项目信号，让重复经验、阻断和可复用上下文影响下一步动作。

### Local-First Project Data / 本地优先项目数据

- Project data lives inside the project folder under `.solopreneur/`.
- 项目数据保存在项目文件夹内的 `.solopreneur/` 目录。
- You can commit `.solopreneur/` to Git so roadmap state, task records, and step memory move with the code.
- 你可以把 `.solopreneur/` 提交到 Git，让路线图、任务记录和环节记忆随项目一起流转。
- Removing a project from SoloMap only removes that project's `.solopreneur/` data directory; it does not delete your code folder.
- 在 SoloMap 中删除项目只会移除该项目的 `.solopreneur/` 数据目录，不会删除项目代码文件夹。

---

## Quick Start / 快速开始

1. Open the VS Code Command Palette.
2. Run `SoloMap: Show AI Roadmap`.
3. Click the add button next to the project selector and choose a project folder.
4. In the initial roadmap step, describe your project idea and assign a local Agent to generate the first real roadmap.
5. Expand roadmap steps and keep moving the project through Agent task conversations.

1. 打开 VS Code 命令面板。
2. 运行 `SoloMap: Show AI Roadmap`。
3. 点击项目下拉框旁边的添加按钮，选择项目工作目录。
4. 在初始化环节输入你的项目想法和要求，指派本地 Agent 生成初始路线图。
5. 展开路线图环节，继续通过 Agent 对话推进项目交付。

---

## Local Agent CLI / 本地 Agent CLI

SoloMap runs your local Agent CLI through the VS Code integrated terminal. The current workflow focuses on Antigravity `agy` and Codex CLI, and you can also enter a custom CLI command or executable path in settings.

SoloMap 通过 VS Code 集成终端调用你本机已安装的 Agent CLI。当前链路重点支持 Antigravity `agy` 和 Codex CLI，也可以在设置中填写自定义 CLI 命令或可执行文件绝对路径。

If the Agent CLI is not available from the system PATH, set the executable path in SoloMap Settings.

如果 Agent CLI 没有被系统 PATH 识别，请在 SoloMap 设置里填写可执行文件路径。

---

## Data Location / 数据位置

SoloMap creates this folder in each project root:

SoloMap 会在每个项目根目录自动创建：

```text
.solopreneur/
  README.md
  roadmap.csv
  project_journal.db
  agent-runs/
  step-memory/
```

`.solopreneur/README.md` explains what each file is for. Avoid deleting `.solopreneur/roadmap.csv` and `.solopreneur/step-memory/`, or the project roadmap and step context will be lost.

`.solopreneur/README.md` 会说明每类文件的用途。不要随意删除 `.solopreneur/roadmap.csv` 和 `.solopreneur/step-memory/`，否则该项目的路线图和环节上下文会丢失。

---

## Privacy / 隐私

SoloMap does not require a hosted backend. Roadmaps, task records, Agent logs, and step memory are stored locally in your project folder by default. Network access, authentication, and model calls depend on the local Agent CLI you choose to run.

SoloMap 不需要后端服务。路线图、任务记录、Agent 日志和环节记忆默认都保存在你的项目本地文件夹中。Agent CLI 的实际联网、认证和模型调用行为由你本机安装的对应 CLI 决定。

---

## Feedback / 反馈

Issues and pull requests are welcome in the [GitHub repository](https://github.com/jobssteve164dev/solopreneur-roadmap). If you are trying SoloMap as a seed user, use the in-extension feedback button or open a [seed user feedback issue](https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new?template=seed-user-feedback.yml).

欢迎在 [GitHub 仓库](https://github.com/jobssteve164dev/solopreneur-roadmap) 提交 Issue 或 Pull Request。如果你正在试用 SoloMap，可以直接使用插件里的反馈按钮，或提交 [种子用户反馈](https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new?template=seed-user-feedback.yml)。

- Repository / 项目仓库: [jobssteve164dev/solopreneur-roadmap](https://github.com/jobssteve164dev/solopreneur-roadmap)
- License / 许可协议: [MIT License](https://github.com/jobssteve164dev/solopreneur-roadmap/blob/main/LICENSE)

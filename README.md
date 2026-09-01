<p align="center">
  <img src="https://raw.githubusercontent.com/jobssteve164dev/solopreneur-roadmap/main/resources/logo_with_text.png" width="320" alt="SoloMap Logo" />
</p>

<h1 align="center">SoloMap - AI Coding Agent Roadmap</h1>

<p align="center">
  <strong>Stop losing momentum in scattered AI chats. Turn your local folder into a visual cockpit for autonomous agents.</strong><br />
  <strong>别让项目迷失在零散 AI 对话里。把你的本地代码库变成 AI Agent 推进的视觉驾驶舱。</strong>
</p>

<p align="center">
  <a href="https://solomap.app"><img src="https://img.shields.io/badge/Website-solomap.app-c92f38?style=flat-square" alt="SoloMap website" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-blue?style=flat-square&logo=visual-studio-code" alt="Marketplace" /></a>
  <a href="https://github.com/jobssteve164dev/solopreneur-roadmap/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-emerald?style=flat-square" alt="License" /></a>
  <a href="https://github.com/jobssteve164dev/solopreneur-roadmap"><img src="https://img.shields.io/badge/Git-Friendly-purple?style=flat-square&logo=git" alt="Git Friendly" /></a>
</p>

---

### 🤯 Are you suffering from "AI Chat Hell"? / 你是否正陷入“AI 乱聊地狱”？

1. **Scattered Context**: You talk to AI in 20 different chat windows. A week later, you have no idea what the agent changed, where the project is stuck, or what to do next.
   **对话碎片化**：在 20 个不同的 Chat 窗口里跟 AI 聊天。一周后，你不记得 Agent 改了什么、项目卡在哪里，更不知道下一步该干什么。
2. **Black Box Execution**: You run a terminal agent, it generates 500 lines of code, breaks 3 features, and leaves you to diff files line-by-line.
   **黑盒执行**：终端运行 Agent 丢下一堆改动，弄坏了既有功能，最后只能自己一行行去 diff。
3. **Cloud Lock-in & Privacy Risks**: You just want a clear task manager, but other tools force you to upload your roadmap, tasks, and private code to their proprietary clouds.
   **云端绑定与隐私**：你只想用个清爽的路线图，某些工具却非要逼你把项目规划和私有代码上传到他们的云端服务器。

### 🚀 Introducing SoloMap: The local command deck above your AI tools / 别急，SoloMap 来了

SoloMap is a **local-first, Git-friendly, highly-polished** execution control panel built directly inside VS Code. It does not replace your favorite Agent CLIs (like `Claude Code`, `agy`, or `Codex`) — **it orchestrates them**.

SoloMap 是直接嵌在 VS Code 里的**本地优先、Git 友好、高审美**项目推进控制台。它不替代你最爱用的终端 Agent CLI（如 `Claude Code`、`agy`、`Codex`），而是**作为它们的主控面板**，将零散对话穿针引线。

---

## 💡 Core Capabilities / 核心能力

### 🧭 Visual Coding Roadmap / 可视化 AI 编码路线图
*   **From Idea to Milestones**: Generate a step-by-step developer roadmap from your initial project idea, structured through **Build ➔ Sell ➔ Learn ➔ Improve**.
    **从想法到里程碑**：将你的构想拆解为覆盖 **Build ➔ Sell ➔ Learn ➔ Improve** 商业闭环的渐进式路线图。
*   **Git-Friendly CSV**: Saved in `.solopreneur/roadmap.csv`. Every status update or step adjustment is a plain text diff. Zero database lock-in.
    **Git 友好**：路线图保存在 `.solopreneur/roadmap.csv`。状态变更或路线调整都是纯文本 diff，告别二进制冲突。

### 🤖 Local Agent Orchestrator / 无缝本地 Agent 调度
*   **One-Click Run**: Dispatch tasks to your local CLI agents (`agy`, `codex`, `claude-code`, `copilot-cli`, `grok`) directly from the active roadmap step.
    **一键调度**：在当前路线图步骤中直接唤起本地 Agent CLI（如 `agy`、`codex`、`claude-code` 等）执行任务。
*   **Step-Level Handover**: Automatically builds a context-rich `.solopreneur/step-memory/` package before each execution so agents know the exact scope and completion criteria.
    **环节记忆交接**：执行前自动组装上下文交接包，让 Agent 带着清晰的完成标准（Completion Criteria）去工作。
*   **Multi-Agent Collaboration**: Toggle a secondary Agent (e.g., use `agy` for building and `claude` for read-only review) to get automatic code quality gates.
    **主副智能体协作**：可选配置自动复核智能体，主 Agent 负责交付，副 Agent 自动只读复核，把控代码质量门禁。

### 🧠 Cross-Project Learning & Memory / 跨项目经验沉淀
*   **Never Make the Same Mistake Twice**: Lessons learned, architectural decisions, and repeated blockers are captured in `.solomap-global/memory/` and automatically injected into subsequent task prompts.
    **拒绝踩相同的坑**：踩过的坑、做过的技术决策、被阻断的依赖会自动沉淀到本地全局经验库，并智能注入后续任务的 Prompt 中。
*   **Privacy by Default**: All task logs, agent histories, and learnings live entirely on your machine.
    **隐私至上**：所有运行历史、提示词、执行记录和指标均保留在本地，无任何云端数据泄露风险。

---

## 🏁 Quick Start / 快速开始

Get started in less than 60 seconds. All you need is a local folder and your favorite Agent CLI.
只需 60 秒，带上你的本地文件夹和你正在用的 Agent CLI 即可开启。

1. **Install** the SoloMap VS Code Extension.
   **安装** SoloMap 插件。
2. Open Command Palette (`Cmd/Ctrl + Shift + P`) and run `SoloMap: Show AI Roadmap`.
   打开命令面板运行 `SoloMap: Show AI Roadmap`。
3. **Register Project**: Choose your local project folder and select the project type.
   **登记项目**：选择本地项目文件夹，并选择它的项目类型。
4. **Bootstrapping**: In the initial step, type your project goal and let the agent generate your first runnable `.solopreneur/roadmap.csv`.
   **启动路线**：在初始对话框里输入你的项目目标，指派本地 Agent，它将为你重写并生成第一版路线图。
5. **Execute & Deliver**: Expand any roadmap node, dispatch a local agent, run verification, and keep the project moving forward!
   **推进与交付**：展开路线图环节，指派 Agent 自动完成编码，运行本地校验，搞定交付！

---

## 🛠️ Integrated Agent CLIs / 本地 Agent 支持

SoloMap runs your local CLI agents via VS Code's integrated terminal for maximum transparency. We auto-detect:
为了保证执行透明，SoloMap 通过 VS Code 集成终端唤起你本机的 CLI：
*   **Antigravity** (`agy`)
*   **Codex** (`codex-cli`)
*   **Claude Code** (`claude-code`)
*   **GitHub Copilot** (`copilot-cli`)
*   **OpenCode** (`opencode`)
*   **Grok Build** (`grok`)
*   *Custom executables are fully supported in SoloMap settings.*

---

## 🔒 Privacy & Architecture / 本地数据结构

SoloMap creates a `.solopreneur/` folder inside your project root to keep it completely self-contained:
SoloMap 会在每个项目根目录下自动创建 `.solopreneur/` 目录，数据与代码共存：

```text
.solopreneur/
  ├── roadmap.csv          <- The single source of truth for your roadmap (Git-friendly)
  ├── project_journal.db   <- Local SQLite DB for high-frequency agent execution logs
  ├── step-memory/         <- Context & completion criteria for each roadmap node
  └── agent-runs/          <- Bounded prompt inputs and output digests
```

---

## 📖 Methodology & Advanced Docs / 深度方法论文档

For solo founders looking to build a highly reproducible delivery machine, explore our core blueprints:
如果你想把一人公司打造成高效可复制的交付引擎，请查阅我们的核心方法论与设计边界：

*   **Core Methodology / 核心推进模型**: [docs/methodology/methodology.zh.md](docs/methodology/methodology.zh.md)
*   **Delivery Boundary / 独立开发者交付闭环边界**: [docs/architecture/solo-delivery-loop-boundary.zh.md](docs/architecture/solo-delivery-loop-boundary.zh.md)
*   **Next-stage Roadmap / 下一阶段功能规划**: [docs/roadmap/next-feature-plan.zh.md](docs/roadmap/next-feature-plan.zh.md)
*   **Full Documentation Index / 完整正式文档入口**: [docs/README.zh.md](docs/README.zh.md)

---

## 💖 Support and Feedback / 倾听你的声音

We are building SoloMap in public for solo developers. Your feedback directly shapes the product!
我们正在公开构建 SoloMap，你的每一次反馈对我们都至关重要！

*   **Love SoloMap?** Please leave a ⭐ [Marketplace Rating & Review](https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap) to help other solo developers find us!
    **觉得好用？** 请到 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap) 为我们留下五星好评，这能帮我们被更多开发者看到！
*   **Having trouble?** Open a [GitHub Issue](https://github.com/jobssteve164dev/solopreneur-roadmap/issues) or submit a [Seed User Feedback](https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new?template=seed-user-feedback.yml).
    **遇到问题？** 欢迎直接在 [GitHub 仓库](https://github.com/jobssteve164dev/solopreneur-roadmap) 提交 Issue 或 [种子用户反馈](https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new?template=seed-user-feedback.yml)。
*   **Contribute & Reward / 贡献与激励**：If you contribute to this project's source code or if your submitted issue/feedback is adopted, please contact [hello@szlk.ai](mailto:hello@szlk.ai). Once verified, you will be rewarded with a 1-year Pro membership!
    凡是为本项目源码做出贡献或者反馈的 issue 被采纳，都欢迎联系 [hello@szlk.ai](mailto:hello@szlk.ai)，经过核实后可奖励 1 年 Pro 会员！

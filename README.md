<p align="center">
  <img src="https://raw.githubusercontent.com/jobssteve164dev/solopreneur-roadmap/main/resources/logo_with_text.png" width="320" alt="SoloMap Logo" />
</p>

<h1 align="center">SoloMap - AI Coding Agent Roadmap</h1>

<p align="center">
  <strong>English</strong> | <a href="https://github.com/jobssteve164dev/solopreneur-roadmap/blob/main/README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <strong>Stop losing momentum in scattered AI chats. Turn your local folder into a visual cockpit for autonomous agents.</strong>
</p>

<p align="center">
  <a href="https://solomap.app"><img src="https://img.shields.io/badge/Website-solomap.app-c92f38?style=flat-square" alt="SoloMap website" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-blue?style=flat-square&logo=visual-studio-code" alt="Marketplace" /></a>
  <a href="https://github.com/jobssteve164dev/solopreneur-roadmap/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-emerald?style=flat-square" alt="License" /></a>
  <a href="https://github.com/jobssteve164dev/solopreneur-roadmap"><img src="https://img.shields.io/badge/Git-Friendly-purple?style=flat-square&logo=git" alt="Git Friendly" /></a>
</p>

---

### 🤯 Are you suffering from "AI Chat Hell"?

1. **Scattered Context**: You talk to AI in 20 different chat windows. A week later, you have no idea what the agent changed, where the project is stuck, or what to do next.
2. **Black Box Execution**: You run a terminal agent, it generates 500 lines of code, breaks 3 features, and leaves you to diff files line-by-line.
3. **Cloud Lock-in & Privacy Risks**: You just want a clear task manager, but other tools force you to upload your roadmap, tasks, and private code to their proprietary clouds.

### 🚀 Introducing SoloMap: The local command deck above your AI tools

SoloMap is a **local-first, Git-friendly, highly-polished** execution control panel built directly inside VS Code. It does not replace your favorite Agent CLIs (like `Claude Code`, `agy`, or `Codex`) — **it orchestrates them**.

---

## 💡 Core Capabilities

### 🧭 Visual Coding Roadmap
*   **From Idea to Milestones**: Generate a step-by-step developer roadmap from your initial project idea, structured through **Build ➔ Sell ➔ Learn ➔ Improve**.
*   **Git-Friendly CSV**: Saved in `.solopreneur/roadmap.csv`. Every status update or step adjustment is a plain text diff. Zero database lock-in.

### 🤖 Local Agent Orchestrator
*   **One-Click Run**: Dispatch tasks to your local CLI agents (`agy`, `codex`, `claude-code`, `copilot-cli`, `grok`) directly from the active roadmap step.
*   **Step-Level Handover**: Automatically builds a context-rich `.solopreneur/step-memory/` package before each execution so agents know the exact scope and completion criteria.
*   **Multi-Agent Collaboration**: Toggle a secondary Agent (e.g., use `agy` for building and `claude` for read-only review) to get automatic code quality gates.

### 🧠 Cross-Project Learning & Memory
*   **Never Make the Same Mistake Twice**: Lessons learned, architectural decisions, and repeated blockers are captured in `.solomap-global/memory/` and automatically injected into subsequent task prompts.
*   **Privacy by Default**: All task logs, agent histories, and learnings live entirely on your machine.

---

## 🏁 Quick Start

Get started in less than 60 seconds. All you need is a local folder and your favorite Agent CLI.

1. **Install** the SoloMap VS Code Extension.
2. Open Command Palette (`Cmd/Ctrl + Shift + P`) and run `SoloMap: Show AI Roadmap`.
3. **Register Project**: Choose your local project folder and select the project type.
4. **Bootstrapping**: In the initial step, type your project goal and let the agent generate your first runnable `.solopreneur/roadmap.csv`.
5. **Execute & Deliver**: Expand any roadmap node, dispatch a local agent, run verification, and keep the project moving forward!

---

## 🛠️ Integrated Agent CLIs

SoloMap runs your local CLI agents via VS Code's integrated terminal for maximum transparency. We auto-detect:
*   **Antigravity** (`agy`)
*   **Codex** (`codex-cli`)
*   **Claude Code** (`claude-code`)
*   **GitHub Copilot** (`copilot-cli`)
*   **OpenCode** (`opencode`)
*   **Grok Build** (`grok`)
*   *Custom executables are fully supported in SoloMap settings.*

---

## 🔒 Privacy & Architecture

SoloMap creates a `.solopreneur/` folder inside your project root to keep it completely self-contained:

```text
.solopreneur/
  ├── roadmap.csv          <- The single source of truth for your roadmap (Git-friendly)
  ├── project_journal.db   <- Local SQLite DB for high-frequency agent execution logs
  ├── step-memory/         <- Context & completion criteria for each roadmap node
  └── agent-runs/          <- Bounded prompt inputs and output digests
```

---

## 📖 Methodology & Advanced Docs

For solo founders looking to build a highly reproducible delivery machine, explore our core blueprints:

*   **Core Methodology**: [docs/methodology/methodology.zh.md](docs/methodology/methodology.zh.md)
*   **Delivery Boundary**: [docs/architecture/solo-delivery-loop-boundary.zh.md](docs/architecture/solo-delivery-loop-boundary.zh.md)
*   **Next-stage Roadmap**: [docs/roadmap/next-feature-plan.zh.md](docs/roadmap/next-feature-plan.zh.md)
*   **Full Documentation Index**: [docs/README.zh.md](docs/README.zh.md)

---

## 💖 Support and Feedback

We are building SoloMap in public for solo developers. Your feedback directly shapes the product!

*   **Love SoloMap?** Please leave a ⭐ [Marketplace Rating & Review](https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap) to help other solo developers find us!
*   **Having trouble?** Open a [GitHub Issue](https://github.com/jobssteve164dev/solopreneur-roadmap/issues) or submit a [Seed User Feedback](https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new?template=seed-user-feedback.yml).
*   **Contribute & Reward**: If you contribute to this project's source code or if your submitted issue/feedback is adopted, please contact [hello@szlk.ai](mailto:hello@szlk.ai). Once verified, you will be rewarded with a 1-year Pro membership!

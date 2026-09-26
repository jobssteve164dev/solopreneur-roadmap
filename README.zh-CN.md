<p align="center">
  <img src="https://raw.githubusercontent.com/jobssteve164dev/solopreneur-roadmap/main/resources/logo_with_text.png" width="320" alt="SoloMap Logo" />
</p>

<h1 align="center">SoloMap - AI Coding Agent Roadmap</h1>

<p align="center">
  <a href="https://github.com/jobssteve164dev/solopreneur-roadmap/blob/main/README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <strong>别让项目迷失在零散 AI 对话里。把你的本地代码库变成 AI Agent 推进的视觉驾驶舱。</strong>
</p>

<p align="center">
  <a href="https://solomap.app"><img src="https://img.shields.io/badge/Website-solomap.app-c92f38?style=flat-square" alt="SoloMap 官网" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-blue?style=flat-square&logo=visual-studio-code" alt="VS Code Marketplace" /></a>
  <a href="https://github.com/jobssteve164dev/solopreneur-roadmap/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-emerald?style=flat-square" alt="MIT 许可证" /></a>
  <a href="https://github.com/jobssteve164dev/solopreneur-roadmap"><img src="https://img.shields.io/badge/Git-Friendly-purple?style=flat-square&logo=git" alt="Git 友好" /></a>
</p>

---

### 🤯 你是否正陷入“AI 乱聊地狱”？

1. **对话碎片化**：在 20 个不同的 Chat 窗口里跟 AI 聊天。一周后，你不记得 Agent 改了什么、项目卡在哪里，更不知道下一步该干什么。
2. **黑盒执行**：终端运行 Agent 丢下一堆改动，弄坏了既有功能，最后只能自己一行行去 diff。
3. **云端绑定与隐私**：你只想用个清爽的路线图，某些工具却非要逼你把项目规划和私有代码上传到他们的云端服务器。

### 🚀 别急，SoloMap 来了

SoloMap 是直接嵌在 VS Code 里的**本地优先、Git 友好、高审美**项目推进控制台。它不替代你最爱用的终端 Agent CLI（如 `Claude Code`、`agy`、`Codex`），而是**作为它们的主控面板**，将零散对话穿针引线。

---

## 💡 核心能力

### 🧭 可视化 AI 编码路线图

* **从想法到里程碑**：将你的构想拆解为覆盖 **Build ➔ Sell ➔ Learn ➔ Improve** 商业闭环的渐进式路线图。
* **Git 友好**：路线图保存在 `.solopreneur/roadmap.csv`。状态变更或路线调整都是纯文本 diff，告别二进制冲突。

### 🤖 无缝本地 Agent 调度

* **一键调度**：在当前路线图步骤中直接唤起本地 Agent CLI（如 `agy`、`codex`、`claude-code`、`copilot-cli`、`grok` 等）执行任务。
* **环节记忆交接**：执行前自动组装 `.solopreneur/step-memory/` 上下文交接包，让 Agent 带着清晰的完成标准去工作。
* **主副智能体协作**：可选配置自动复核智能体，主 Agent 负责交付，副 Agent 自动只读复核，把控代码质量门禁。

### 🧠 跨项目经验沉淀

* **拒绝踩相同的坑**：踩过的坑、做过的技术决策、被阻断的依赖会自动沉淀到本地全局经验库，并智能注入后续任务的 Prompt 中。
* **隐私至上**：所有运行历史、提示词、执行记录和指标均保留在本地，无任何云端数据泄露风险。

---

## 🏁 快速开始

只需 60 秒，带上你的本地文件夹和你正在用的 Agent CLI 即可开启。

1. **安装** SoloMap VS Code 插件。
2. 打开命令面板（`Cmd/Ctrl + Shift + P`），运行 `SoloMap: Show AI Roadmap`。
3. **登记项目**：选择本地项目文件夹，并选择项目类型。
4. **启动路线**：在初始步骤中输入项目目标，让 Agent 生成第一版可运行的 `.solopreneur/roadmap.csv`。
5. **推进与交付**：展开任一路线图环节，指派本地 Agent 执行任务、运行验证并继续推进项目。

---

## 🛠️ 本地 Agent 支持

为了保证执行透明，SoloMap 通过 VS Code 集成终端唤起你本机的 CLI，并自动检测：

* **Antigravity** (`agy`)
* **Codex** (`codex-cli`)
* **Claude Code** (`claude-code`)
* **GitHub Copilot** (`copilot-cli`)
* **OpenCode** (`opencode`)
* **Grok Build** (`grok`)
* SoloMap 设置也完全支持自定义可执行文件。

---

## 🔒 本地数据结构

SoloMap 会在每个项目根目录下自动创建 `.solopreneur/` 目录，数据与代码共存：

```text
.solopreneur/
  ├── roadmap.csv          <- Git 友好的路线图单一事实来源
  ├── project_journal.db   <- 保存高频 Agent 执行记录的本地 SQLite 数据库
  ├── step-memory/         <- 各路线图环节的上下文与完成标准
  └── agent-runs/          <- 有边界的提示词输入与输出摘要
```

---

## 📖 深度方法论文档

如果你想把一人公司打造成高效可复制的交付引擎，请查阅我们的核心方法论与设计边界：

* **核心推进模型**：[docs/methodology/methodology.zh.md](docs/methodology/methodology.zh.md)
* **独立开发者交付闭环边界**：[docs/architecture/solo-delivery-loop-boundary.zh.md](docs/architecture/solo-delivery-loop-boundary.zh.md)
* **下一阶段功能规划**：[docs/roadmap/next-feature-plan.zh.md](docs/roadmap/next-feature-plan.zh.md)
* **完整正式文档入口**：[docs/README.zh.md](docs/README.zh.md)

---

## 💖 倾听你的声音

我们正在公开构建 SoloMap，你的每一次反馈对我们都至关重要！

* **觉得好用？** 请到 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap) 为我们留下五星好评，这能帮我们被更多开发者看到！
* **遇到问题？** 欢迎直接在 [GitHub 仓库](https://github.com/jobssteve164dev/solopreneur-roadmap)提交 [Issue](https://github.com/jobssteve164dev/solopreneur-roadmap/issues) 或 [种子用户反馈](https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new?template=seed-user-feedback.yml)。
* **贡献与激励**：如果你为本项目源码做出贡献，或者提交的 Issue/反馈被采纳，欢迎联系 [hello@szlk.ai](mailto:hello@szlk.ai)。核实后可获得 1 年 Pro 会员。

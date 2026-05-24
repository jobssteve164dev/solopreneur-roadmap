<p align="center">
  <img src="resources/logo.png" width="150" height="150" alt="SoloMap Logo" />
</p>

<h1 align="center">SoloMap: AI Roadmap & Agent Task Flow</h1>

<p align="center">
  <strong>Turn your project idea into a roadmap your local AI agents can execute.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-blue?style=flat-square&logo=visual-studio-code" alt="Marketplace" /></a>
  <a href="https://github.com/jobssteve164dev/solopreneur-roadmap/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-emerald?style=flat-square" alt="License" /></a>
  <a href="https://github.com/jobssteve164dev/solopreneur-roadmap"><img src="https://img.shields.io/badge/Git-Friendly-purple?style=flat-square&logo=git" alt="Git Friendly" /></a>
</p>

---

## 为什么选择 SoloMap？

SoloMap 是一个本地优先的 VS Code 插件，用路线图管理项目推进，用本地 Agent CLI 执行每个环节的具体任务。

它把“项目想法、路线图、Agent 对话、文件修改、任务状态、环节记忆”放在同一条工作流里：你选择项目文件夹，SoloMap 创建本地 `.solopreneur/` 项目数据目录；初始化路线图会包含“生成初始路线图”环节；随后你可以把项目要求交给本地 Agent，让它直接修改路线图 CSV，再按环节持续推进项目。

---

## 核心能力

### AI Roadmap

- 用路线图拆解项目从想法到交付的关键环节。
- 默认初始化为可执行的 starter roadmap，并通过“生成初始路线图”环节让本地 Agent 按你的项目要求改写真实路线图。
- 路线图保存在 `.solopreneur/roadmap.csv`，适合 Git 管理、审阅和跨设备迁移。

### Agent Task Flow

- 每个路线图环节都可以展开为任务对话列表。
- 你可以为单次任务补充要求，并选择本地 Agent CLI 执行。
- SoloMap 会记录 Agent 输入、输出、状态、修改文件列表和重试入口。
- 环节记忆保存在 `.solopreneur/step-memory/`，Agent 每次工作前都会被要求读取当前环节上下文。

### Local-First Project Data

- 项目数据保存在项目文件夹内的 `.solopreneur/` 目录。
- 你可以把 `.solopreneur/` 提交到 Git，让路线图、任务记录和环节记忆随项目一起流转。
- 删除 SoloMap 中的项目只会移除该项目的 `.solopreneur/` 数据目录，不会删除项目代码文件夹。

---

## 快速开始

1. 打开 VS Code 命令面板。
2. 运行 `SoloMap: Show AI Roadmap`。
3. 点击项目下拉框旁边的添加按钮，选择项目工作目录。
4. 在初始化环节输入你的项目想法和要求，指派本地 Agent 生成初始路线图。
5. 展开路线图环节，继续通过 Agent 对话推进项目交付。

---

## 本地 Agent CLI

SoloMap 通过 VS Code 集成终端调用你本机已安装的 Agent CLI。当前链路重点支持 Antigravity `agy` 和 Codex CLI，也可以在设置中填写自定义 CLI 命令或绝对路径。

如果 Agent CLI 没有被系统 PATH 识别，请在 SoloMap 设置里填写可执行文件路径。

---

## 数据位置

SoloMap 会在每个项目根目录自动创建：

```text
.solopreneur/
  README.md
  roadmap.csv
  project_journal.db
  agent-runs/
  step-memory/
```

`.solopreneur/README.md` 会说明每类文件的用途。不要随意删除 `.solopreneur/roadmap.csv` 和 `.solopreneur/step-memory/`，否则该项目的路线图和环节上下文会丢失。

---

## 隐私

SoloMap 不需要后端服务。路线图、任务记录、Agent 日志和环节记忆默认都保存在你的项目本地文件夹中。Agent CLI 的实际联网、认证和模型调用行为由你本机安装的对应 CLI 决定。

---

## 反馈

欢迎在 [GitHub 仓库](https://github.com/jobssteve164dev/solopreneur-roadmap) 提交 Issue 或 Pull Request。

- 项目仓库: [jobssteve164dev/solopreneur-roadmap](https://github.com/jobssteve164dev/solopreneur-roadmap)
- 许可协议: [MIT License](https://github.com/jobssteve164dev/solopreneur-roadmap/blob/main/LICENSE)

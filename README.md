# Solopreneur AI Roadmap & Agent Orchestrator (VS Code 插件)

🎯 一个专为独立开发者与一人公司设计、完全本地优先、Git 友好的项目全生命周期 AI 路线图与智能体集成编排插件。

---

## 🎨 核心特性

*   **CoFounder2 风格极客路线图**：基于 React Flow + Glassmorphism 设计的半透明玻璃微透节点路线图，包含 Pending, Running, Completed, Failed 动态流光发光与霓虹呼吸边框动效。
*   **双轨制本地优先存储 (CSV + SQLite)**：
    *   **CSV 结构** (`roadmap.csv`)：作为结构状态唯一信源，完全可读的纯文本，`git diff` 极其清晰，完美契合 Git 版本控制，零二进制冲突。
    *   **SQLite 引擎** (`project_journal.db` / sql.js WASM)：用于实时的高频关系查询、智能体控制台日志、以及 AI 路线图生成的历史缓存记录。
*   **内置终端智能体编排 (File Sentinel IPC)**：一键 `⚡ Run Agent` 直接在 VS Code 侧边栏交互终端唤醒本地已安装的智能体 CLI（如 `antigravity-cli`, `cursor-cli` 等）。利用文件哨兵机制实现无损、高弹性的异步状态同步。
*   **AI 路线图一键生成**：集成先进的 Gemini API 状态管道，根据您的业务创意描述，智能规划完整的有向无环图 (DAG) 阶段任务。

---

## 📁 目录结构说明

```text
├── package.json               # 插件定义与依赖
├── tsconfig.json              # TS 编译器配置
├── docs/                      # 全套中文设计蓝图、任务清单及说明文档
│   ├── implementation_plan.md # 架构调研与实施蓝图
│   ├── task.md                # 任务看板进度清单
│   └── walkthrough.md         # MVP 原理与运行指南
└── src/
    ├── extension.ts           # 插件激活入口、Webview 控制与终端文件监视器
    └── db/
        ├── types.ts           # 统一的数据模型类型声明
        ├── csvStore.ts        # Git 友好的纯文本 CSV 读写层
        ├── sqliteStore.ts     # SQLite WASM 关系存储与执行日志层
        └── syncEngine.ts      # CSV 与 SQLite 双轨制数据同步引擎
```

---

## 🚀 快速开始与本地调试

1. 克隆本仓库到本地，并在 VS Code 中打开：
   ```bash
   git clone https://github.com/jobssteve164dev/solopreneur-roadmap.git
   cd solopreneur-roadmap
   ```
2. 安装项目依赖：
   ```bash
   npm install
   ```
3. 按下键盘上的 **`F5`** 键（或者打开左侧 **Run and Debug** 面板点击运行）。
4. 在新弹出的 `[Extension Development Host]` 窗口中，打开任意待管理的项目目录。
5. 按下 `F1` 或 `Ctrl+Shift+P` 调出命令控制板，输入并回车执行命令：
   > **`Solopreneur: Show AI Roadmap`**
6. 体验属于您的一人公司智能路线图看板！

# VS Code 独立项目管理器：AI 路线图与智能体编排 (MVP 蓝图)

本文件为专为一人公司（独立开发者/Solopreneur）设计的 VS Code 插件提供全面的技术调研、架构设计及实施蓝图。核心概念是一个通过 AI 生成的、可交互的项目路线图（灵感源自 CoFounder2），路线图中的每个任务节点均可直接指派给本地安装的 AI Agent CLI 运行，且所有数据完全保存在本地并通过 Git 进行版本管理。

---

## 🎨 用户体验与路线图 UI 设计（源自 Cofounder2 灵感）

为了给用户带来极具震撼力和高级感的第一印象，路线图 UI 将运行在 VS Code Webview Panel 内，并遵循以下设计准则：

### 1. 视觉美学（深色模式与玻璃拟态）
*   **主题无缝融合**：直接继承 VS Code 当前活跃的主题配色变量（如 `--vscode-editor-background`, `--vscode-button-background`），辅以精心调配的半透明渐变。
*   **玻璃拟态卡片**：路线图节点设计为玻璃微透卡片（`backdrop-filter: blur(10px)`），边框带有极具质感的发光效果，以颜色指示状态：
    *   `Pending (等待)`：内敛的灰白边框。
    *   `Running (运行中)`：带呼吸动效的青蓝（Cyan）渐变发光边框。
    *   `Completed (已完成)`：精致的翡翠绿边框，配有成功勾选图标。
    *   `Failed (失败)`：警示的霓虹红发光边缘。
*   **动态拓扑图**：支持缩放和拖拽的动态节点网络，节点代表项目生命周期的各个阶段（例如：*需求定义 -> 市场调研 -> 架构设计 -> 数据库 -> 后端开发 -> 前端集成 -> 部署上线 -> 运营推广*）。

### 2. 交互与微动效
*   **悬停反馈**：鼠标悬停在卡片上时，卡片温和放大 (`transform: scale(1.02)`) 并伴随优雅的阴影扩散。
*   **流动连线**：连接节点的路径线条具有光流传送动画（利用 SVG `stroke-dasharray` 属性实现），直观展现工作流的流转与完成。
*   **快速指派面板**：点击卡片可拉出侧边抽屉，显示详细检查清单，并提供一个发光的 "运行智能体" 按钮，下拉可选本地安装的各种 CLI（如 `antigravity-cli`, `cursor-cli`, `gitops-cli` 等）。

---

## 🛠️ 系统架构设计

本插件采用去中心化、本地优先的无服务端架构，完全运行在用户的本地环境中。

```mermaid
graph TD
    subgraph VS Code 插件进程 (Host)
        Extension[插件核心核心] <--> Webview[Webview 界面: React + React Flow]
        Extension <--> LLMEngine[AI 生成器: Gemini/OpenAI SDK]
        Extension <--> CLIOrchestrator[CLI 终端调度引擎]
        Extension <--> DbManager[本地同步引擎]
    end

    subgraph 用户项目工作区 (Local Filesystem)
        DbManager <--> CSV[roadmap.csv: 纯文本, Git 差分友好]
        DbManager <--> SQLite[project_journal.db: 关系查询/历史日志]
        Git[本地 Git 仓库] <--> CSV
        Git <--> SQLite
    end

    subgraph 操作系统 / 运行进程
        CLIOrchestrator <--> VSTerminal[VS Code 内置集成终端]
        VSTerminal <--> AgentCLIs[本地 Agent CLI: antigravity, cursor等]
    end

    CLIOrchestrator -. 哨兵状态轮询 .-> SQLite
```

---

## 💾 数据管理与 Git 版本控制同步策略

在本地优先的开发工作流中，SQLite 等二进制数据库文件对 Git 版本管理极不友好，极易产生庞大且不可读的二进制 Diff，导致代码冲突合并困难。

### 双轨制混合存储方案 (CSV + SQLite)
为实现“Git 差分可读性”与“高效本地关系查询”的双重优势，我们设计了**双轨同步机制**：

1.  **`roadmap.csv`（结构与状态的唯一真实信源）**：
    *   采用逗号分隔的文本文件，存储核心路线图节点（节点 ID、阶段名称、任务名称、依赖 ID、指派 CLI、当前状态、创建时间、完成时间）。
    *   **Git 绝对优势**：每次任务添加或状态变迁，CSV 的变更在 `git diff` 中呈现为完美的单行文本差异（如 `- 4, "构建 API", "后端", "Pending"` 变为 `+ 4, "构建 API", "后端", "Completed"`），一目了然。
2.  **`project_journal.db`（SQLite，负责富文本、终端日志及缓存）**：
    *   本地 SQLite 数据库用于存放高频次的 Agent 终端输出日志、AI 提示词历史及执行性能分析。
    *   该文件可在 `.gitignore` 中忽略，以保证代码仓库的极简，亦可作为可选的本地缓存保存。
3.  **自动同步机制**：
    *   **启动时**：插件读取项目中的 `roadmap.csv`，自动水合（Hydrate）并更新 SQLite 内存数据。
    *   **运行时**：UI 操作或 Agent 运行状态的任何修改，优先写入 SQLite 确保数据响应速度，并立即将其最新 network 结构序列化写入 `roadmap.csv`。

---

## 🤖 智能体 CLI 终端编排引擎

不同于在后台默默无闻、容易假死且无法干预的静默进程运行模式，本插件直接利用 **VS Code 终端 API** 开展智能体编排：

### 1. 终端注入与复用
插件启动时创建一个专用的、具有机器人图标的交互终端：
```typescript
const agentTerminal = vscode.window.createTerminal({
    name: "Solopreneur Agent Console",
    iconPath: new vscode.ThemeIcon("robot")
});
```

### 2. 状态哨兵文件机制 (File Sentinel)
为实现 Agent 进程与 VS Code 插件的安全解耦与状态互通，采用**文件哨兵机制**：
1.  用户在 UI 上点击某个节点的“运行”按钮。
2.  插件在集成终端发送运行指令，同时使用 Shell 运算符串联状态文件写入操作：
    ```bash
    echo '{"nodeId": "1", "status": "Running"}' > .agent_status.json && \
    (antigravity-cli run --task "...") && \
    echo '{"nodeId": "1", "status": "Completed"}' > .agent_status.json || \
    echo '{"nodeId": "1", "status": "Failed"}' > .agent_status.json
    ```
3.  **插件监听器**：插件通过 `vscode.workspace.createFileSystemWatcher` 实时监测 `.agent_status.json` 的写出与改变。一旦检测到 `Completed` 或 `Failed`，立即更新本地 CSV/SQLite 数据，刷新 Webview 中的节点颜色，并在片刻后自动删除 `.agent_status.json` 保持项目文件夹整洁！

---

## 🛠️ 推荐技术栈选型

| 模块组件 | 推荐技术 | 选型考量 |
| :--- | :--- | :--- |
| **插件主壳** | **VS Code Extension API (TypeScript)** | 原生 VS Code 接口集成，完美调度内置终端和文件监视器。 |
| **Webview 前端** | **React (ES Modules 优化版)** | 在 Webview 中以极高响应速度处理复杂的拓扑节点和数据状态变迁。 |
| **视觉样式** | **Vanilla CSS (CSS 变量)** | 完美应用 VS Code 原生主题配色，极致的自定义玻璃拟态和 neon 流光动效，避免打包体积臃肿。 |
| **拓扑图渲染** | **React Flow** | 节点拓扑的最佳交互引擎。支持平滑缩放、连接线高度自定义及极简卡片组件包裹。 |
| **本地数据库** | **sql.js (SQLite WASM)** | **零原生 C++ 编译绑定**。完全在 JS 运行时环境内调度，保证插件在 Windows, macOS, Linux 跨平台“开箱即用”，彻底规避 Electron 编译报错。 |
| **CSV 处理器** | **Papa Parse** | 行业标杆级 CSV 高效解析器，确保文本序列化精准无误。 |

---

## ❓ 待 align 的设计开放问题

> [!IMPORTANT]
> 请您对以下三个核心问题给出您的期望和首选策略：

1.  **AI 生成路线图的颗粒度**：您希望 AI 初始化时直接一口气生成整个项目大而全的全生命周期路线图（如 20+ 个详细微观任务），还是先生成一个高级的宏观骨架（5-7 个核心阶段），由您后续点击某阶段再按需让 AI 拆分该阶段的微观任务？
2.  **本地 Agent CLI 的发现模式**：插件应该通过自动搜索系统全局环境变量 `PATH` 来列出可用智能体，还是读取当前项目根目录下的 `.agentrc.json` 配置文件来自定义智能体模板和运行参数？
3.  **Git 自动提交机制**：当 Agent 自动运行成功并更新路线图状态后，您希望插件**自动执行 Git commit**（例如提交消息：`[Roadmap] 数据库 Schema 设计已完成`），还是完全交由您手动控制？

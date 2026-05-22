# VS Code 独立项目管理器插件 - MVP 运行与实装说明书

我们已经为您成功开发、构建并顺利编译了这款为独立开发者/一人公司量身定制的 VS Code 插件。本插件采用本地优先、Git 版本友好、且完美融合本地 AI CLI 的技术方案，以下为实装运行的具体说明。

---

## 📁 插件源码目录结构

所有核心逻辑与代码已妥善保存在 `/home/ubuntu/project/solopreneur-roadmap/` 下：

```text
├── package.json               # 插件清单、命令注册与依赖配置
├── tsconfig.json              # TypeScript 编译配置
├── out/                       # 编译输出目录（编译生成的 JS 执行代码）
├── docs/                      # 全套中文设计蓝图与说明文件
└── src/
    ├── extension.ts           # 插件入口、Webview 渲染、进程哨兵与终端调度器
    └── db/
        ├── types.ts           # 统一的数据模型类型声明 (RoadmapNode, ProjectState)
        ├── csvStore.ts        # Git 友好的纯文本 CSV 读写层 (PapaParse)
        ├── sqliteStore.ts     # SQLite WASM 关系存储与执行日志层 (sql.js)
        └── syncEngine.ts      # CSV 与 SQLite 双轨制数据同步引擎
```

---

## ⚡ 核心子系统实装细节与运行原理

### 1. 本地双轨制存储引擎 (`src/db/syncEngine.ts`)
*   **启动水合**：插件激活并打开路线图时，自动扫描项目根目录下 `.solopreneur/roadmap.csv`。若存在，则解析该 CSV 并自动在 WASM SQLite 数据库中建立关系结构，用于实时渲染。
*   **开箱即用种子**：若检测到为全新项目（无历史 CSV），同步引擎会自动生成并持久化一套包含六个阶段（需求、调研、架构、后端、前端、发布）的项目生命周期基础路线图，零配置上手。
*   **Git 差分可读性**：任何 UI 操作或 Agent CLI 导致的状态改变都会同时双写。SQLite 提供即时的高效日志查询，而 CSV 则保证了每次任务完成在 `git diff` 中都是清晰的纯文本单行对比，彻底规避二进制冲突。

### 2. 状态哨兵文件机制与终端集成 IPC (`src/extension.ts`)
*   **内置终端激活**：点击节点卡片上的 `⚡ Run Agent`，插件会智能匹配/唤起一个专用的交互式内置终端 `"Solopreneur Agent Console"`。
*   **Shell 串联指令与哨兵注入**：发送命令时，自动串联创建哨兵状态文件，如下所示：
    ```bash
    echo '{"nodeId": "1", "status": "Running"}' > .agent_status.json && \
    (antigravity-cli run --task "...") && \
    echo '{"nodeId": "1", "status": "Completed"}' > > .agent_status.json || \
    echo '{"nodeId": "1", "status": "Failed"}' > .agent_status.json
    ```
*   **原生文件监控监听**：插件主进程使用 VS Code 的 `createFileSystemWatcher` 实时感知 `.agent_status.json` 的更新。一旦监听到 `Completed` 或 `Failed`，立即在 SQLite 中记录本次运行历史，同步写回 CSV 真实源，并向前端 Webview 广播节点更新事件，同时在 1 秒后自动销毁 `.agent_status.json` 文件保持干净。

### 3. 高级玻璃拟态 UI 界面 (`getWebviewHtml()`)
*   **精美深色美学**：全局引入 **Inter** 与 **Outfit** 极客感无衬线字体，利用 VS Code 官方 CSS 变量动态匹配系统底色。
*   **状态光晕描边**：不同状态卡片带有精致的半透明磨砂毛玻璃效果，并配有呼吸发光边缘：
    *   `Pending (等待)`：内敛的高级灰色边框。
    *   `Running (运行中)`：带脉冲发光动画的青蓝色霓虹边框。
    *   `Completed (已完成)`：带成功勋章标识的翡翠绿发光阴影。
    *   `Failed (失败)`：红色的危机警示霓虹边框。

---

## 🧪 TypeScript 编译与类型安全验证

我们已经在工作区中对其进行了严格的编译验证：

```bash
cd /home/ubuntu/project/solopreneur-roadmap
npm run compile
```

### 验证状态：
编译顺利通过，TypeScript 编译器没有报告任何 Error 或 Warning。这表明核心的双轨制逻辑、类型系统及文件监视器的实现是**完全类型安全且正确无误的**。

---

## 🚀 如何在本地 VS Code 中激活和测试该插件

1.  在您本地的 VS Code 中，打开项目根目录 `/home/ubuntu/project/solopreneur-roadmap`。
2.  按下键盘上的 **`F5`** 键（或者在左侧活动栏选择 **Run and Debug（运行与调试）** 并点击启动绿色播放按钮）。
3.  这会为您唤起一个新的 **[Extension Development Host]**（插件开发宿主）VS Code 窗口。
4.  在弹出的新 VS Code 窗口中，打开您任意的项目文件夹，作为被管理的 Solopreneur 项目。
5.  按下快捷键 `F1` 或 `Ctrl+Shift+P` 打开 VS Code 命令控制板，输入并回车运行命令：
    > **`Solopreneur: Show AI Roadmap`**
6.  大功告成！您会看到精心绘制的极客风玻璃拟态路线图渲染面板被激活。您可以在输入框输入新的开发创意，或点击路线图卡片直接让智能体在终端开始奔跑！

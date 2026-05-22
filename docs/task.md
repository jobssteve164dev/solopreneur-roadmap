# Solopreneur Project Manager VS Code 插件 - MVP 实施任务看板

本文件用于跟踪项目管理插件的开发实施进度。

## Phase 1: 基础工程搭建与脚手架
- `[x]` 创建项目文件夹 `/home/ubuntu/project/solopreneur-roadmap` 并初始化 `package.json`
- `[x]` 配置 TypeScript 环境 (`tsconfig.json`) 与 VS Code 插件扩展配置
- `[x]` 安装基础开发依赖（如 `sql.js`, `papaparse`, `typescript`, `@types/vscode` 等）
- `[x]` 编写插件主入口文件 (`src/extension.ts`)

## Phase 2: 双轨制 CSV 与 SQLite 存储引擎开发
- `[x]` 实现本地纯文本 CSV 读写封装模块 (`src/db/csvStore.ts`)，保障 Git Diff 友好性
- `[x]` 编写基于 `sql.js` (WebAssembly) 的 SQLite 数据库运行层 (`src/db/sqliteStore.ts`)
- `[x]` 编写同步协调管理器 (`src/db/syncEngine.ts`)，实现 CSV 结构与内存 SQLite 双写同步与启动时水合
- `[x]` 编写默认路线图自动初始化种子，保证全新项目开箱即用

## Phase 3: React 路线图 UI 界面 (Webview) 打造
- `[x]` 搭建 React + HTML 单页 Webview 架构，免去外部静态编译加载开销
- `[x]` 集成拓扑流布局与连接线渲染，展现项目任务演进拓扑
- `[x]` 采用高级深色模式 + 玻璃拟态卡片进行样式美化，定制 Pending, Running, Completed, Failed 发光边框
- `[x]` 增加操作区按钮，提供 ⚡ Run Agent 触发入口，与 AI 生成路线图控制面板

## Phase 4: AI 路线图生成器实现
- `[x]` 在插件主进程实现 AI 路线图生成响应逻辑（支持 VS Code Progress 状态气泡通知）
- `[x]` 编写系统提示词模板，将用户描述转化为符合有向无环图 (DAG) 约束的节点结构
- `[x]` 实现数据解析、反序列化存入 CSV、以及实时触发 Webview 界面刷新渲染

## Phase 5: 内置终端智能体 CLI 调度编排 (Terminal Sentinel)
- `[x]` 编写基于 `vscode.window.createTerminal` 的专用交互式终端生成模块
- `[x]` 设计终端命令动态生成逻辑与 Shell 操作串联指令
- `[x]` 编写文件系统监听器，通过原生 FS 监控哨兵文件 `.agent_status.json` 的创建与修改
- `[x]` 实现任务完成状态的捕捉、SQLite 运行日志记录、CSV 节点状态转换以及 UI 端实时动效流转

## Phase 6: 端到端编译测试与说明文档
- `[x]` 对插件进行完整的 TypeScript 编译测试，排除所有编译阻碍与类型异常
- `[x]` 验证本地数据库的持久化与初始化同步行为
- `[x]` 在项目文件夹内产出详尽的中文版架构与运行说明文档

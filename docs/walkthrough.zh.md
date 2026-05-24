# VS Code SoloMap 插件 - MVP Walkthrough 与 Loading 问题修复

我们已经定位并修复了侧边栏无限 Loading 的问题：插件声明了侧边栏视图，但没有注册对应的 `WebviewViewProvider`。修复后，SoloMap 同时具备侧边栏控制中心和完整路线图大图，两者共享同一套本地项目状态。

## 代码结构

项目位于 `/home/ubuntu/project/solopreneur-roadmap/`：

```text
├── package.json               # 插件配置、命令、视图注册和依赖
├── tsconfig.json              # TypeScript 配置
├── out/                       # 编译后的 JavaScript
└── src/
    ├── extension.ts           # VS Code 入口、初始化和消息同步
    ├── sidebarProvider.ts     # 侧边栏 Webview Provider
    └── db/
        ├── types.ts           # 路线图节点等统一数据模型
        ├── csvStore.ts        # Git 友好的 CSV 存储
        ├── sqliteStore.ts     # 本地 SQLite/WASM 日志与缓存
        └── syncEngine.ts      # CSV 与 SQLite 的同步引擎
```

## 问题诊断与侧边栏架构

### 问题

`package.json` 中注册了 `solopreneur.sidebar` 侧边栏 Webview，但 `src/extension.ts` 没有注册对应的 provider。VS Code 打开侧边栏时找不到内容解析者，于是一直显示 Loading。

### 解决

新增 `SolopreneurSidebarProvider` 并在插件激活时注册。侧边栏现在能直接渲染项目进度、路线图环节和快捷动作。

## 双视图同步

侧边栏和完整路线图大图共享同一个 `SyncEngine`。

- CSV 或 SQLite 状态变化后，扩展端统一推送最新节点。
- 如果大图面板打开，会同步刷新大图。
- 如果侧边栏打开，会同步刷新侧边栏。
- Agent 任务执行、状态变化和完成结果会在两个视图中保持一致。

## 侧边栏体验

侧边栏作为紧凑控制中心，包含：

1. 路线图总体进度。
2. 可扫描的路线图环节卡片。
3. 不同状态的视觉提示。
4. 快速打开完整路线图大图的入口。
5. 针对可执行环节的快捷 Agent 触发入口。

侧边栏的目标不是替代大图，而是让用户在 VS Code 日常工作中快速知道项目当前状态和下一步动作。

## 构建验证

运行：

```bash
cd /home/ubuntu/project/solopreneur-roadmap
npm run compile
```

编译应以退出码 `0` 结束。

## 手动测试步骤

1. 重新加载 VS Code 窗口：打开命令面板，执行 `Developer: Reload Window`。
2. 点击 Activity Bar 中的 SoloMap 图标。
3. 确认侧边栏不再卡在 Loading，而是显示项目进度与路线图环节。
4. 点击打开完整路线图大图，确认编辑器中显示完整路线图。
5. 从侧边栏或大图触发 Agent 任务，确认终端启动，节点状态同步更新。
6. 任务完成后，确认侧边栏和大图都显示最新状态。


# 实施计划 - 通过高质量侧边栏 Provider 修复 Webview Loading 问题

这份计划用于解决 VS Code 插件界面长期停留在 Loading 状态的问题。

## 诊断与分析

我们审计代码后确认，卡在 Loading 的根因不是样式或网络问题，而是 VS Code 侧边栏 Webview 没有对应的内容提供者。

1. `package.json` 中声明了自定义侧边栏容器 `solopreneur-sidebar-container`，并注册了一个 ID 为 `solopreneur.sidebar` 的 Webview View。
2. `src/extension.ts` 虽然完成了插件激活，但没有为 `solopreneur.sidebar` 注册 `WebviewViewProvider`。
3. 用户安装插件后，VS Code 会尝试渲染这个侧边栏视图；由于没有 provider 负责解析内容，侧边栏只能显示空白 Loading 面板，让用户误以为整个插件加载失败。

## 解决方案

新增并注册 `SolopreneurSidebarProvider`，让侧边栏成为 SoloMap 的轻量控制中心，而不是一个没有内容的占位视图。

侧边栏应承担三件事：

- 显示当前项目路线图进度。
- 展示可推进的路线图环节。
- 提供打开大图和触发 Agent 任务的快捷入口。

## 侧边栏 UI 设计

侧边栏应服务于用户动作，而不是解释系统结构。

- 使用 VS Code 主题变量适配编辑器主题。
- 顶部展示进度卡片，例如 `2 / 6 Completed`，配合清晰进度条。
- 以紧凑卡片列表展示路线图环节。
- 不同状态使用不同视觉提示：`Pending`、`Running`、`Completed`、`Failed`。
- 对可执行环节提供直接运行入口。
- 底部提供打开完整路线图大图的入口。

## 代码改动

### 新增 `src/sidebarProvider.ts`

实现 `SolopreneurSidebarProvider`，负责：

- 实现 `vscode.WebviewViewProvider`。
- 处理侧边栏 Webview 生命周期。
- 接收侧边栏消息，例如获取节点、运行 Agent、打开完整路线图。
- 将最新节点列表推送回侧边栏。
- 提供侧边栏 HTML、CSS 与前端交互逻辑。

### 修改 `src/extension.ts`

需要完成：

- 从 `./sidebarProvider` 引入 `SolopreneurSidebarProvider`。
- 在插件激活时实例化 provider。
- 使用 `vscode.window.registerWebviewViewProvider` 注册 `solopreneur.sidebar`。
- 更新节点同步逻辑，让大图面板和侧边栏共享同一份路线图状态。

## 验证计划

### 自动验证

运行：

```bash
npm run compile
```

要求 TypeScript 编译无错误。

### 手动验证

1. 打开 VS Code，点击 Activity Bar 中的 SoloMap 图标，确认侧边栏立即显示，不再卡在 Loading。
2. 确认默认路线图可以在侧边栏中显示为任务卡片，进度条状态正确。
3. 从侧边栏打开完整路线图大图，确认大图正常出现。
4. 从侧边栏或大图触发 Agent 任务，确认同一个节点状态在两个视图中同步变为 `Running`。
5. Agent 任务完成后，确认侧边栏和大图中的状态同步更新。


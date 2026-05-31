# SoloMap 独立开发者交付闭环产品边界

## 结论

SoloMap 不应该把独立开发者变成一个人模拟完整团队流程。

默认主路径是：

```text
Issue / Solo
-> Roadmap Step
-> Agent 执行
-> 本地验证 / GitHub Actions
-> Release / Deploy
-> 反馈输入
-> Improve 调整
```

Issue 说明为什么要做，Actions 证明能不能发，Release 证明用户有没有拿到，Improve 负责把反馈变成下一轮路线图。

## 不照搬小团队完整流程

小团队常见流程是：

```text
Issue
-> Roadmap / Milestone
-> Branch
-> PR
-> Review / CI
-> Merge
-> Release
-> Deploy
-> Feedback
```

对独立开发者，Branch、PR Review、Milestone、Project Board 很多时候是协作治理，不是交付必需。SoloMap 默认不强制这些对象进入主路径。

## 默认保留的交付对象

### Issue

Issue 是现实输入层，回答：

- 用户反馈了什么？
- Bug 或需求是什么？
- 为什么路线图应该调整？

Issue 主要影响 Learn / Improve。

### Actions / Checks

Actions 是验证层，回答：

- 这版能不能发？
- 构建、测试、打包或发布检查有没有失败？
- 下一步是否应该先修检查失败？

SoloMap 不做完整 GitHub Actions 控制台。侧边栏只显示轻量信号，例如：

```text
Checks failed 1
```

当最近检查失败时，Next Action 应优先提示修复发布检查，并把失败摘要注入 Agent prompt。

### Release / Deploy

Release 是交付层，回答：

- 用户拿到哪个版本？
- 最近一次发布是什么时候？
- 路线图环节完成后是否真的发布？

侧边栏只显示轻量信号，例如：

```text
Latest v0.0.108
```

如果路线图环节都完成但没有新 Release，Next Action 可以提示“发布当前成果”。

### PR

PR 是可选证据层，不是独立开发者默认门槛。

当项目本身使用 PR、开源协作或 GitHub Actions 发布依赖 PR 时，SoloMap 可以读取 PR 状态作为补充证据；没有 PR 时，不应阻断本地验证或发布闭环。

## 第一版落地范围

第一版只补三件事：

1. 读取 GitHub Actions 最近运行和最新 Release。
2. 在侧边栏项目卡片显示轻量交付信号。
3. 将交付信号注入路线图环节和路线图调整 prompt。

不做：

- PR 管理面板。
- GitHub Actions 浏览器。
- Release 管理后台。
- 强制 Branch / PR / Review 流程。

## UI 原则

侧边栏仍然只回答：

```text
现在最该做什么？
为什么是它？
点哪里继续？
```

Actions 和 Release 只能作为下一步判断的信号，不应成为新的重面板。

大图可以在后续版本里展示交付时间线，但第一版不需要。

## 验收标准

- 有 GitHub remote 且 `gh` 可用时，SoloMap 能读取最新 Actions 和 Release。
- GitHub 数据读取失败时，侧边栏仍可用，并优先显示缓存。
- 最近 Actions 失败时，项目下一步可以变成“修复发布检查”。
- 最新 Release 能作为轻量信号展示。
- Agent prompt 能获得当前项目交付信号，用于修 CI、发布或调整路线图。
- 没有 PR 的独立开发者项目不会被阻断。

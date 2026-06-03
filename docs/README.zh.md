# SoloMap 文档入口

这份索引用来回答一个问题：应该从哪里读起，以及某类长期判断应该沉淀到哪里。

## 推荐阅读顺序

1. [单项目方法论](./methodology/methodology.zh.md)：理解 SoloMap 如何把项目推进成可执行路线图。
2. [项目生命周期工程文档体系方法论](./methodology/project-lifecycle-engineering-docs.zh.md)：理解项目解释性文档应该如何产出和维护。
3. [跨 Agent Harness 设计](./architecture/cross-agent-harness.zh.md)：理解 memory、skill、MCP connector 和外部增强能力如何服务项目生命周期。
4. [Agent 协作机制产品边界](./architecture/agent-collaboration-boundary.zh.md)：理解主副 Agent 协作如何进入任务闭环，同时避免把内部编排负担暴露给用户。
5. [Agent Task Flow 方法论](./methodology/agent-task-flow-methodology.zh.md)：理解 SoloMap 如何从 Agent 启动器升级为可复核、可续推、可验收的任务流。
6. [下一阶段功能规划](./roadmap/next-feature-plan.zh.md)：查看仍在推进的产品能力。

## 目录职责

| 目录 | 职责 | 适合放入 |
| --- | --- | --- |
| `methodology/` | 方法论、项目类型、全局执行指南 | 长期判断模型、执行节奏、文档体系 |
| `product/` | 产品定位、商业计划、客户发现 | 用户、市场、访谈、商业化判断 |
| `architecture/` | 系统边界、Harness、交付闭环 | 架构边界、数据/能力归属、插件化设计 |
| `ui/` | UI 与治理面行动模型 | 侧边栏、大图、Issue 面板、阶段视图 |
| `roadmap/` | 后续功能路线和产品计划 | 下一阶段规划、功能落地蓝图 |
| `marketing/` | 对外发布和传播材料 | Product Hunt、小红书、朋友圈、发布计划 |
| `assets/` | 文档配图和发布图片 | 截图、封面、宣传图 |

## 种子用户反馈闭环

- 人工触达记录：[product/seed-users.md](./product/seed-users.md)
- 访谈问题与反馈表：[product/customer-discovery.zh.md](./product/customer-discovery.zh.md)
- GitHub Issue 模板：`.github/ISSUE_TEMPLATE/seed-user-feedback.yml`
- 插件内入口：侧边栏顶部反馈按钮

## 写入规则

- 本轮做了什么、改了哪里、怎么验证，不写进 `docs/`，应留在 Agent 运行记录或环节交接中。
- 新增文档前先判断是否能更新已有文档。
- 新文档文件名必须表达长期职责，避免 `summary.md`、`notes.md`、`plan.md` 这类低语义名称。
- 发布素材可以放在 `marketing/`，但不要和长期产品边界、架构决策混在一起。

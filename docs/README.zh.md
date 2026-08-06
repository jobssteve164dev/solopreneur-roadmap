# SoloMap 文档入口

这份索引用来回答一个问题：应该从哪里读起，以及某类长期判断应该沉淀到哪里。

## 推荐阅读顺序

1. [单项目方法论](./methodology/methodology.zh.md)：理解 SoloMap 如何把项目推进成可执行路线图。
2. [项目生命周期工程文档体系方法论](./methodology/project-lifecycle-engineering-docs.zh.md)：理解项目解释性文档应该如何产出和维护。
3. [跨 Agent Harness 设计](./architecture/cross-agent-harness.zh.md)：理解 memory、skill、MCP connector 和外部增强能力如何服务项目生命周期。
4. [内置 Harness 增强能力挂载指导](./architecture/curated-harness-enhancements.zh.md)：理解 rtk、CodeGraph、caveman 等调研能力如何作为内置增强开关进入 SoloMap。
5. [Harness Enhancement Adapter 设计指导](./architecture/harness-enhancement-adapter-guidelines.zh.md)：理解外部增强能力如何统一治理，同时保留不同底层接入方式。
6. [Agent 协作机制产品边界](./architecture/agent-collaboration-boundary.zh.md)：理解主副 Agent 协作如何进入任务闭环，同时避免把内部编排负担暴露给用户。
7. [Agent Task Flow 方法论](./methodology/agent-task-flow-methodology.zh.md)：理解 SoloMap 如何从 Agent 启动器升级为可复核、可续推、可验收的任务流。
8. [下一阶段功能规划](./roadmap/next-feature-plan.zh.md)：查看仍在推进的产品能力。
9. [中文品牌命名与定位分析](./product/chinese-naming-analysis.zh.md)：关于项目中文命名的多维度头脑风暴与品牌定位思考。
10. [独立开发者生态与协作网络战略](./product/solo-developer-ecosystem-strategy.zh.md)：理解本地项目如何在用户授权下连接协作者、能力、反馈和商业机会，以及私密房间、公共共创与官网中继的长期边界。
11. [CloudMCP JSON 记忆目标适配边界](./architecture/cloudmcp-json-memory-adapter.zh.md)：理解 SoloMap 作为可配置本地记忆目标时，与 CloudMCP 本地代理唯一写入口之间的职责边界。

## UI 与交互基线

- [本地优先加载交互体验基线](./ui/local-first-loading-interaction-baseline.zh.md)：统一冷启动、项目切换、对话终端和大图加载的硬时限、完成条件、状态保护与验收口径。

## 官网工作台

- [本地项目远程控制方法论](./methodology/remote-project-control-methodology.zh.md)：理解官网如何延伸用户的观察、补充与决策能力，同时保持项目事实和用户数据在本地。
- [官网工作台本地优先架构设计](./architecture/web-workbench-local-first-design.zh.md)：固定本地权威、端到端加密、最小状态投影、远程命令和首版实现边界。
- [独立开发者生态与协作网络战略](./product/solo-developer-ecosystem-strategy.zh.md)：固定官网门户、邀请制协作房间、公共共创空间、贡献信誉与后续能力市场之间的关系。

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
- Pro 定价基准：[product/roi-pricing-guidance.zh.md](./product/roi-pricing-guidance.zh.md)
- 官网与 Early Access 承接：[marketing/website-early-access-guidance.zh.md](./marketing/website-early-access-guidance.zh.md)
- 官网设计基准：[marketing/website-design.zh.md](./marketing/website-design.zh.md)
- GitHub Issue 模板：`.github/ISSUE_TEMPLATE/seed-user-feedback.yml`
- 插件内入口：侧边栏顶部反馈按钮

## 写入规则

- 本轮做了什么、改了哪里、怎么验证，不写进 `docs/`，应留在 Agent 运行记录或环节交接中。
- 新增文档前先判断是否能更新已有文档。
- 新文档文件名必须表达长期职责，避免 `summary.md`、`notes.md`、`plan.md` 这类低语义名称。
- 发布素材可以放在 `marketing/`，但不要和长期产品边界、架构决策混在一起。

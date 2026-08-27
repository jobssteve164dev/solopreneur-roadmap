# SoloMap 官网设计文档

**日期**: 2026-06-04  
**主域名**: `solomap.app`  
**适用范围**: SoloMap 官网首版、Pro Early Access、金字塔战略驾驶舱展示、下载与反馈承接  
**文档性质**: 官网长期设计基准，不是一次性页面草稿  

---

## 2026-08-27 定位升级（V2，当前执行基准）

### 1. 官网要建立的新品类

SoloMap 的长期定位不再是“AI 项目的路线图工具”或“Agent 调度器”，而是：

> 人与 AI Agent 之间的本地优先工作协议。

它要让一个人能稳定地告诉 Agent：结果是什么、什么不能改、Agent 可以做什么、完成需要什么证据、下一次从哪里继续。这份约定跨模型、跨 Agent CLI、跨会话成立，且最终判断权仍在用户手中。

对普通用户的表达不应只抛出“协议”这个抽象概念。首屏必须立即用“结果、边界、证据、记忆”解释它对用户有什么用。

### 2. 网站服务的用户动作

首页只服务一条主路径：

1. 意识到单次 Prompt 不足以维持长期协作。
2. 理解 SoloMap 把用户意图变成 Agent 可持续遵守的工作约定。
3. 看懂用户、SoloMap 和 Agent 各自负责什么。
4. 确认数据与最终判断权仍属于自己。
5. 安装 SoloMap，用一个真实 Agent 任务开始。

不要把模型数量、Agent 数量、任务数量或内部实现对象当成官网的核心卖点。

### 3. 首页信息架构

V2 首页按用户决策顺序组织：

1. **Hero**：让每一个 Agent 都按你的目标工作。
2. **Problem**：一句 Prompt 能启动工作，但不能定义协作关系。
3. **Working loop**：说清结果 → 划定边界与授权 → Agent 执行 → 用证据决定完成。
4. **Responsibility**：用户负责判断，Agent 负责行动，证据决定状态。
5. **Comparison matrix**：对比“SoloMap 工作约定”与“只靠 Agent 对话”，而不是笼统贬低编码工具。
6. **Protocol milestones**：明确展示已经达成、当前阶段、下一阶段与最终愿景。
7. **Local-first trust**：工作约定跟随本地项目，用户保留选择 Agent 与对外共享的决定权。
8. **Pro / Guides / Blog / FAQ**：承接多项目治理、教育和搜索意图，不抢首屏主线。
9. **Final CTA**：从一个真实 Agent 任务开始。

### 4. SEO 与对比矩阵

中英文首页的 Title、Description、H1、首屏前 100 字和 FAQ 应围绕同一主题：

- 中文：人与 AI Agent 的工作协议、Agent 协作、本地优先、跨会话项目记忆。
- 英文：human-Agent working agreement, AI Agent workflow, local-first Agent collaboration, cross-session project memory.

对比矩阵必须是真实 HTML 表格，具有明确列头和行标题。桌面端突出 SoloMap 列；手机端转换为逐项决策卡片，在每个值前显示列名，禁止水平滚动。对比只陈述职责边界，不做无法证实的性能或效果宣称。

### 5. 视觉与交互基准

- 保留 SoloMap 现有深色、本地开发工具的品牌气质，不复制竞品品牌。
- 吸收 SoloTerm 的编辑节奏：更清晰的标题层级、更大留白、先给结论再展开、真正可扫读的对比矩阵。
- 一屏只保留一个主 CTA，次要链接降级表现。
- 卡片只用于表达独立决策或动作，不把每句话都装进容器。
- 动效只表达“约定 → 执行 → 证据 → 继续”的状态流转；启用减少动效后所有内容必须直接可读。
- 375px 宽度下无水平滚动，点击区不小于 44px，首屏不得被同意弹层或固定元素遮挡。

### 6. 协议演进里程碑

里程碑组件用于回答两个用户问题：SoloMap 今天已经做到什么，以及它最终要把人与 Agent 的协作带到哪里。

- **已达成**：只陈述当前代码和产品路径已经支持的能力，包括本地项目事实、从路线图启动 Agent、完成标准、执行记录、交接和证据。
- **当前阶段**：将目标、边界、授权、证据和记忆统一成跨会话的一份工作约定。
- **下一阶段**：让同一份已验证约定能够随用户选择跨 Agent CLI 延续，减少重复建立项目背景。
- **最终愿景**：无论 Agent、项目或会话如何变化，用户只需用同一种方式定义目标和边界；Agent 在授权内行动、用证据交付，项目从已验证状态继续。

组件必须使用可见状态标签与 `aria-current="step"` 标记当前阶段，不能只依赖颜色。阶段不使用百分比、虚构日期或未经实现的完成宣称；移动端按相同顺序纵向展示，不复制内容。

### 7. 产品边界

- SoloMap 不替代具体 Agent，不代替用户判断“完成”。
- 官网不成为云端项目副本，本地 SoloMap 仍是项目事实、Agent 执行与最终控制的权威入口。
- SoloMap 不扩展为一人公司 ERP；Pro 只说明已有的多项目战略视图与 Early Access 能力。
- 完成由用户定义的标准和可复查证据裁定，不由模型自述裁定。

---

## 历史基线（V1，与 V2 冲突处不再适用）

## 1. 结论

`solomap.app` 应作为 SoloMap 的正式产品主域名。官网首版不是公司官网，也不是大型营销站，而是一个面向独立开发者的产品验证页。

首版官网只服务四个用户动作：

1. 看懂 SoloMap 是什么。
2. 安装 VS Code 插件。
3. 理解 Free 与 Pro Early Access 的区别。
4. 提交反馈或表达 Early Access 兴趣。

官网第一版的目标不是把所有能力讲完，而是让用户快速形成一句话理解：

> SoloMap 是给使用 AI Agent 构建产品的独立开发者准备的本地优先路线图与战略驾驶舱。

---

## 2. 域名与品牌入口

| 入口 | 用途 | 说明 |
| --- | --- | --- |
| `solomap.app` | 正式官网主域名 | 对外传播、下载、Early Access、文档入口 |
| `solomap.szlk.ai` | 公司体系入口 / 过渡入口 | 可用于 SZLK 产品矩阵、Passport 跳转或内部测试 |
| GitHub 仓库 | 开源与反馈入口 | 代码、Issue、Release、可信度 |
| VS Code Marketplace | 主下载入口 | VS Code 用户默认安装路径 |
| Open VSX | 补充分发入口 | code-server、VSCodium、部分 VS Code forks 用户 |

官网所有公开文案应优先使用 `solomap.app`。`solomap.szlk.ai` 只作为公司体系和授权系统的辅助入口，不作为对外主品牌。

---

## 3. 首页信息架构

首版只做一个长页面，不做复杂导航。推荐结构：

1. Hero 首屏
2. Problem / Why SoloMap
3. Product Workflow
4. Local-first Trust
5. Pro Early Access
6. Install / Feedback
7. Footer

顶部导航只保留：

- Product
- Pro
- Docs
- GitHub
- Install

不做：

- Blog
- Enterprise
- Templates
- Login
- Dashboard
- Marketplace

这些入口会让首版官网变成维护负担，也会稀释当前最重要的下载和 Early Access 验证。

---

## 4. Hero 首屏

### 4.1 首屏目标

首屏必须在 10 秒内回答：

- 这是给谁用的。
- 解决什么问题。
- 现在可以怎么开始。

### 4.2 推荐主标题

英文：

> Keep your AI-built projects moving.

中文辅助心智：

> 让 AI Agent 负责执行，让 SoloMap 负责不丢方向。

### 4.3 推荐副标题

英文：

> SoloMap is a local-first roadmap and strategy cockpit for indie developers building with AI agents in VS Code.

中文：

> SoloMap 把产品想法、路线图、Agent 执行历史和下一步动作放回你的本地工作区，帮助独立开发者持续推进项目，而不是迷失在零散 AI 对话里。

### 4.4 首屏 CTA

主 CTA：

- `Install from VS Code Marketplace`

次 CTA：

- `Get it on Open VSX`
- `View on GitHub`

Pro CTA 只作为轻量入口：

- `Join Pro Early Access`

不要把 Pro CTA 放在唯一主按钮位置。首版应先让用户安装并体验 Free 主路径。

### 4.5 首屏视觉

首屏必须使用真实产品截图或短动图，不使用抽象插画。优先展示：

- 侧边栏今日安排 + 项目卡片
- 单项目路线图大图
- Agent 执行卡片或终端运行状态

截图应该让用户直接看到：

- SoloMap 在 VS Code 里工作。
- 它不是独立 SaaS 后台。
- 它帮助项目从路线图进入执行。

---

## 5. Problem / Why SoloMap

该区块回答为什么用户需要 SoloMap，而不是再买一个 AI 编码工具。

推荐标题：

> AI can write code. It does not keep your product on track.

中文心智：

> AI 能写代码，但不会自动帮你经营项目方向。

内容应围绕三个真实痛点：

1. **上下文散落**  
   项目计划、AI 对话、终端输出、TODO 和代码修改分散在不同地方。

2. **下一步不清楚**  
   几天后重新打开项目，需要重新读聊天、读代码、猜测上次进度。

3. **项目偏向只 Build**  
   AI 很容易让用户一直改代码，却忽略 Sell、Learn、Improve 和真实反馈。

对应 SoloMap 承诺：

- 把想法变成路线图。
- 从路线图环节运行本地 Agent。
- 记录执行历史和项目状态。
- 用今日安排帮助用户知道当前优先处理什么。
- 用金字塔战略驾驶舱帮助用户看见多项目经营结构。

---

## 6. Product Workflow

该区块用 4 步说明用户路径，不解释底层实现。

推荐标题：

> From idea to shipped progress, without losing the thread.

四步：

1. **Add your local project**  
   选择本地项目文件夹。

2. **Create a roadmap**  
   输入项目目标，让 SoloMap 生成可执行路线图。

3. **Run your AI agent from a step**  
   在路线图环节里启动用户已有的本地 Agent CLI。

4. **Come back and continue**  
   下次打开时，看到今日安排、项目状态和历史推进记录。

注意：这里不要展示内部文件名、数据库、同步引擎或 Agent prompt 细节。用户只需要理解动作，不需要理解实现。

---

## 7. Local-first Trust

该区块建立信任，但不能变成工程说明书。

推荐标题：

> Local-first by default.

可以说：

- Your roadmap and project memory stay in your workspace.
- Bring your own AI agent CLI.
- No hosted backend is required for the core workflow.
- GitHub Issues and release signals are pulled only when you connect or refresh them.

中文表达：

> SoloMap 的主路径不要求你把项目数据托管到我们的服务器。路线图、执行历史和项目记忆优先保存在本地工作区。

避免说：

- SQLite/WASM
- File sentinel
- CSV sync engine
- Agent prompt 注入
- 任何内部对象名作为主要卖点

---

## 8. Pro Early Access

该区块承接金字塔战略驾驶舱。

### 8.1 定位

Free 的价值：

> Move one project forward.

Pro 的价值：

> Run your one-person company.

中文：

> Free 帮你推进一个项目；Pro 帮你经营一人公司。

### 8.2 展示内容

Pro Early Access 应展示：

- 金字塔战略驾驶舱。
- 多项目战略评分。
- 项目组合健康度。
- 能力复利分析。
- 市场、收入、交付结构诊断。
- 未来 SZLK Passport 订阅授权。

当前不应承诺：

- 云端托管 Agent。
- 多设备同步。
- 团队工作区。
- 自动云端 AI 战略诊断。

这些能力一旦加入，会改变成本结构和定价模型。

### 8.3 价格口径

首版展示：

> Pro Early Access: $29/year

说明：

- Early access to the strategy cockpit.
- Help shape the Pro roadmap.
- Free core workflow stays available.

不要现在展示复杂价格表。正式价格 `$5/月 或 $49/年` 可作为后续正式 Pro 的目标，不必在首版首屏强展示。

### 8.4 CTA

推荐：

- `Join Pro Early Access`
- `Tell us you want Pro`
- `Get early access updates`

如果支付入口尚未完成，CTA 可以进入：

- waitlist
- GitHub Issue feedback
- SZLK Passport 预留登录
- 邮件或表单

---

## 9. Install / Feedback

该区块提供明确行动，不要让用户到处找入口。

必须包含：

- VS Code Marketplace 安装按钮。
- Open VSX 安装按钮。
- GitHub 仓库按钮。
- GitHub Issue 反馈按钮。
- 隐私 / 本地优先说明链接。

推荐文案：

> Try SoloMap with one project first. If it helps you keep momentum, tell us what the strategy cockpit should show next.

中文：

> 先用一个项目试试 SoloMap。如果它帮你保持推进，请告诉我们金字塔战略驾驶舱下一步应该看见什么。

---

## 10. Footer

Footer 只保留必要信息：

- SoloMap
- GitHub
- VS Code Marketplace
- Open VSX
- Feedback
- Privacy / Local-first note
- SZLK

不要在首版 footer 放大量产品矩阵、企业销售或复杂法律页面入口。后续接入 Passport 和支付后，再补 Terms / Privacy / Billing。

---

## 11. 视觉方向

官网视觉应匹配开发者工具和战略驾驶舱，不做消费级花哨落地页。

建议：

- 深色或中性背景，但避免全站过暗导致截图不可读。
- 使用真实 VS Code / SoloMap 截图作为第一视觉。
- 色彩可沿用 SoloMap 当前红色品牌资产，但保持克制。
- 卡片圆角不超过 8px。
- 文案密度适中，避免大段工程描述。
- CTA 清晰，按钮数量少。
- 移动端优先保证首屏标题、截图和安装入口不互相挤压。

禁止：

- 抽象渐变球、装饰性光斑、无意义 3D 物体。
- 用维护者口吻解释内部实现。
- 用大段功能列表替代用户动作。
- 没有截图的“AI 工具通用模板页”。

---

## 12. 首版验收标准

官网首版上线前必须通过以下检查：

1. 首屏 10 秒内能看懂 SoloMap 是什么。
2. 页面第一视觉是真实产品截图或动图。
3. 主 CTA 指向安装。
4. Pro Early Access 是清晰但不压迫的次级路径。
5. 没有把 Free 主路径描述成残缺试用。
6. 没有暴露内部实现细节作为用户必须理解的概念。
7. 移动端不出现标题、截图、按钮重叠。
8. 至少有一个反馈入口。
9. `solomap.app` 是页面公开主域名。
10. `solomap.szlk.ai` 只作为公司体系或授权辅助入口。

---

## 13. 后续版本

第二版官网可以加入：

- 金字塔战略驾驶舱截图。
- Early Access 用户反馈。
- 更明确的 Free / Pro 对比。
- ROI 例子。
- 安装后 5 分钟上手视频。

第三版官网可以加入：

- SZLK Passport 登录。
- 正式支付。
- Billing / Terms / Privacy。
- Pro 用户权益说明。

首版阶段不投入博客、SEO 内容矩阵或复杂官网后台；下方“当前版本”约束覆盖已进入后续版本的官网能力。

---

## 14. 对比搜索走廊（当前版本）

对比内容不是首页功能矩阵的放大版，而是一组独立、可索引、可持续复核的决策页面：

- `/compare`：对比中心，按“工作协议、编码 Agent、编辑器、项目系统”组织直接对比。
- `/compare/:slug`：回答一个具体的 A vs B 搜索意图，给出快速结论、适用人群、逐项取舍、诚实边界、官方来源和相邻对比。
- `/alternatives`：替代方案中心，先区分用户要替换的是执行者、计划工具，还是缺失的跨会话工作协议。
- `/alternatives/:slug`：围绕具体替代意图提供选项与选择条件，不把 SoloMap 强行写成所有产品的直接替代品。

所有页面必须同时具备中英文 canonical / hreflang、结构化数据、站点地图入口、官网导航内链、最近复核日期和官方来源。对比轴统一围绕用户决策：谁负责执行、谁保存项目事实、谁拥有完成判断、换 Agent 或会话后如何继续。

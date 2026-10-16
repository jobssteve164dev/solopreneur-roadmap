# SoloMap 单位经济与规模化路线复盘 (Scale & Unit Economics Review)

## 0. 里程碑：首月 Open VSX 下载突破 20k

SoloMap 发布不到一个月，在 **Open VSX 市场下载量已顺利突破 20k (20,000+)**！
同时，多项核心及长尾关键词在两边市场（Open VSX 和 Visual Studio Marketplace）基本上全部进入了前 50。其中：
*   `ai roadmap`，`coding roadmap` 排名第 1。
*   `agent roadmap` 排名第 2。
*   `ai coding agent` 排名第 26。
*   `local ai agent` 排名第 12。

这说明我们以“AI Roadmap”为切入点、强调“本地优先（Local-first）与 Git 友好”的差异化品牌定位极其有效，吸引了大量独立开发者和 AI 编码重度用户。

为了庆祝这一里程碑，我们生成了一张社交媒体宣传海报，用于在 X (Twitter)、小红书、V2EX 等渠道进行下一轮的 Sell 与推广：

![SoloMap 20k Downloads Milestone Poster](assets/solomap_20k_milestone.jpg)

---

## 1. 单位经济学复盘 (Unit Economics Review)

根据早期的用户增长速度与使用特征，我们对 SoloMap 的单位经济假设做如下复盘：

### 1.1 激活分析 (Activation)
*   **当前现状**：用户下载插件后，首启流程能快速完成（在 5 分钟内创建首个本地项目并基于想法初始化 Starter 路线图）。
*   **瓶颈与挑战**：由于我们目前没有强制用户注册 SaaS 账号，也没有内置遥测（保持 100% 本地优先与隐私保护），我们无法通过后台日志直接获取用户激活率。我们目前以用户成功运行一次本地 Agent CLI（如 Claude Code, Aider）并生成首份 `.solopreneur/step-memory/` 交接 JSON 为激活标准。
*   **优化动作**：未来可以加入可选（Opt-in）的匿名本地分析，或者在侧边栏加入简单的“完成首次 Agent run 激活引导”。

### 1.2 留存分析 (Retention)
*   **当前现状**：独立开发者的开发行为大多是碎片化的（周末开发、周中停滞）。因此周留存是核心指标。
*   **核心保障**：我们的“Next Action”视图和“环节环境交接（Handoff）”机制，极大地降低了用户重新打开项目时的“上下文恢复成本”。
*   **反馈信号**：GitHub Issues 中用户开始提出一些更深度的使用需求（如 TG 远程调用），说明这部分高频用户已经把 SoloMap 当成了长期的项目推进驾驶舱。

### 1.3 转化分析 (Conversion)
*   **定价假设**：根据 ROI 评估，我们计划推出 Freemium 模式：
    *   **Free**：单项目路线图、本地 Agent 推进及基础 handoff 功能。
    *   **Pro Early Access**：$29/年（一次性买断或首年优惠）。
    *   **Pro 正式版**：$5/月 或 $49/年。
*   **转化触发点**：转化不应通过收费墙强行阻断核心开发流，而应在用户有“多项目全局管理需求”（多项目仪表盘）、“复杂业务规划”（高级模板包）以及“跨项目查找 Agent 经验”（全历史搜索）时，以自然增值的形式引导升级。

### 1.4 支持成本 (Support Cost)
*   **优势**：SoloMap 采用 BYOK（Bring Your Own Key）和本地运行模式，不承担任何模型调用或云端数据库的服务器边际成本。因此我们的 **LTV/CAC 极具防御力**，每新增一个用户的边际服务器成本为 0。
*   **劣势/成本点**：支持成本主要集中在“环境兼容”上。用户本地环境千差万别（Node/npm 版本、Python 环境、各家 CLI Agent 的配置差异）。当本地 CLI 缺失或报错时，插件的容错和引导机制需要非常强大，否则会直接转化为 GitHub Issues 的技术支持成本。
*   **改进**：持续优化 `out/agentCli.js` 对环境的容错，当 CLI 缺失时提供友好的降级路径和文档链接。

### 1.5 付费意愿 (Willingness to Pay)
*   访谈与社区反馈表明，独立开发者对“能显著减少半成品项目烂尾率”的工具有很高的付费意愿。
*   最愿意付费的买单点依次是：
    1.  **多项目金字塔看板**：同时管理 3 个以上 side projects 时的统一驾驶舱。
    2.  **高级商业路线图模板包**：如 SaaS 变现、插件发布、Product Hunt 冲榜的一键式步骤骨架。
    3.  **跨项目 Agent 执行轨迹搜索**。

---

## 2. 下一轮规模化路线图建议 (Next-round Roadmap Recommendations)

基于目前的真实用户反馈（包括 Issues 中提到的 TG远程 和 增加官网工作台 需求）以及我们的增长实验，建议对路线图进行如下调整：

### 建议 1：增加官网工作台 (对齐 Issue #2)
*   **背景**：目前 SoloMap 完全寄居在 VS Code 内。对于一些关注“发布与增长”阶段的用户（Indie Hacker），他们希望有一个能脱离编辑器、在网页端直观管理 and 同步项目路线图的入口。
*   **定位**：官网工作台也是 Pro 权益激活、云同步的前置控制面。
*   **执行建议**：作为下一个 Sell/Product 阶段的环节。

### 建议 2：支持 TG 远程调用与异步状态通知 (对齐 Issue #1)
*   **背景**：Agent 运行（如自动写代码、自动跑测试）通常需要较长时间。用户不可能一直盯着终端。
*   **痛点**：用户希望离开电脑后仍然能收到运行完成的通知，甚至能通过 Telegram 远程向本地插件发送指令（比如批准下一步执行、询问当前卡在哪个文件）。
*   **执行建议**：实现轻量级的 TG Bot 桥接，利用本地长连接和 CLI 执行，让“人在回路”不必局限于坐在电脑前。

### 建议 3：推出实验性新插件 ID 以吃满搜索流量
*   **背景**：根据 2026-06-23 的关键词实验，目前我们的插件 ID `SZLK.solopreneur-roadmap` 对 `ai coding agent` 等核心高流量组合词的文本匹配度还不够强。
*   **建议**：在两边市场推出高匹配度 ID 的实验性插件 `SoloMapAI.ai-coding-agent-roadmap`，采用“AI Coding Agent Roadmap - SoloMap”作为 displayName，并将流量引流回主项目。

---

## 3. 路线图更新 (.solopreneur/roadmap.csv 调整说明)

我们已在 `.solopreneur/roadmap.csv` 中将环节 `10` 标记为 `Completed`，并新增了以下 3 个后续规模化与功能强化环节：
*   **环节 11**：设计并实现官网工作台，用于承接用户 Early Access 申请、路线图预览和 Pro 权益管理（对齐 Issue #2）。
*   **环节 12**：支持 Telegram 远程控制与运行状态异步通知，实现人在回路的移动端解耦（对齐 Issue #1）。
*   **环节 13**：发布高流量匹配的实验性新插件 ID 并进行双 Listing 引流实验，进一步扩大分发规模。

通过这些动作，我们将顺利闭环“反馈与规模化”阶段，并为下一轮迭代铺平道路。

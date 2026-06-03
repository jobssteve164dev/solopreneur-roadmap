# SoloMap 官网与 Early Access 承接指导

**日期**: 2026-06-03  
**适用范围**: SoloMap 官网首版、Pro Early Access、金字塔战略驾驶舱展示、后续 SZLK Passport 承接  
**文档性质**: 长期营销与转化边界，不是一次性网页草稿  

---

## 1. 结论

SoloMap 应该设计自己的官网，但首版不应做完整公司官网或复杂营销站。

首版官网定位：

> 独立开发者产品验证页。

官网首版的任务不是展示公司规模，也不是铺开博客、企业页、模板市场或复杂定价页，而是承接三个动作：

1. 让访问者理解 SoloMap 是什么。
2. 让访问者安装插件或打开 Marketplace / Open VSX。
3. 让对金字塔战略驾驶舱感兴趣的用户加入 Pro Early Access。

---

## 2. 首页主张

官网首屏必须直接回答：

- SoloMap 服务谁。
- 解决什么问题。
- 为什么它不是 Cursor / Copilot 的替代品。
- 用户下一步怎么开始。

推荐英文主张：

> SoloMap is a local-first roadmap and strategy cockpit for indie developers building with AI agents.

推荐中文主张：

> AI Agent 负责执行，SoloMap 负责让项目不丢方向。

避免主张：

- “AI coding assistant”
- “Agent orchestrator”
- “Project management platform”
- “All-in-one productivity system”

这些词会把 SoloMap 拉回拥挤的 AI 编码或通用项目管理市场。

---

## 3. 首版结构

首版官网只需要四个核心区块。

### 3.1 首页首屏

必须包含：

- 一句话定位。
- 一张真实产品截图或短动图。
- VS Code Marketplace 下载入口。
- Open VSX 下载入口。
- GitHub 仓库入口。

首屏不应解释内部实现，不应展示 `.solopreneur` 文件结构作为主视觉，不应把技术架构当成卖点。

### 3.2 Why SoloMap

解释 SoloMap 与 AI 编码工具的关系：

> Cursor、Copilot、Claude Code、Codex 等工具负责写代码和执行任务；SoloMap 负责把项目目标、路线图、执行历史和下一步放在一个本地优先的生命周期控制面里。

核心表达：

- 不替代用户现有 Agent。
- 不托管用户代码。
- 不强制 SaaS 后端。
- 把路线图、执行历史和反馈闭环放在用户工作区附近。

### 3.3 Pro Early Access

该区块承接金字塔战略驾驶舱。

必须说明：

- Early Access 价格基准：$29/年。
- Pro 核心价值：一人公司战略驾驶舱。
- 当前承诺：早期访问、反馈优先、后续 Pro 功能。
- Free 仍保留项目推进主路径。

建议文案：

> Free helps you move one project forward. Pro helps you run your one-person company.

中文表达：

> Free 帮你推进一个项目；Pro 帮你经营一人公司。

首版可以先做 waitlist / interest / Passport 登录预留，不必一开始接完整支付。

### 3.4 Docs / Feedback

必须包含：

- 安装指引。
- GitHub Issue 反馈入口。
- 本地优先与隐私说明。
- Marketplace / Open VSX 链接。
- Pro Early Access 咨询或等待列表入口。

---

## 4. 不做什么

首版官网不要做：

- 博客系统。
- 复杂定价页。
- 企业销售页。
- 模板市场。
- 登录控制台。
- SEO 大站。
- 大量动画和抽象插画。
- 没有真实产品截图的空泛营销页。

理由：当前目标是验证用户理解、下载和 Early Access 兴趣，不是制造维护负担。

---

## 5. 成功标准

官网首版成功标准：

```text
访问者 2 分钟内明白：
SoloMap 帮谁、解决什么、怎么安装、为什么 Pro 值得期待。
```

可观测信号：

- Marketplace / Open VSX 点击。
- GitHub 仓库点击。
- Pro Early Access interest / waitlist 提交。
- 反馈 Issue 创建。
- 用户在反馈中复述“项目不丢方向”“一人公司战略驾驶舱”“多项目取舍”等核心价值。

---

## 6. 演进路径

推荐分三版推进：

| 阶段 | 内容 | 目标 |
| --- | --- | --- |
| 第一版 | 产品说明 + 下载 + 反馈 + Early Access 意向 | 承接理解、安装和付费兴趣 |
| 第二版 | 加入金字塔战略驾驶舱截图 / 演示 | 强化 Pro 价值 |
| 第三版 | 接入 SZLK Passport 和正式支付 | 承接订阅授权 |

第三版之前，官网不应承担复杂用户后台职责。SZLK Passport 负责订阅授权，SoloMap 项目数据仍保持本地优先。

---

## 7. 与付费计划的关系

官网不是等待正式 Pro 完成后才上线的资产。它应该和 Early Access 同步出现。

当前推荐动作：

- 官网展示 $29/年 Early Access。
- 不强行锁住 Free 主路径。
- 在金字塔战略驾驶舱尚未完全成熟前，以 waitlist / interest / early access 方式承接。
- 当 Early Access 有 5-10 个真实付费用户后，再决定是否加重官网付费入口。

---

## 8. 长期边界

官网长期应服务用户动作，而不是展示内部实现。

允许展示：

- 产品截图。
- 用户问题。
- 安装路径。
- Free / Pro 价值边界。
- 本地优先和隐私承诺。
- Early Access 或 Passport 入口。

避免展示：

- 工程对象名。
- 内部数据结构。
- Agent prompt 机制。
- 文件哨兵、SQLite/WASM、CSV 同步等实现细节。
- 维护者视角的功能堆砌。

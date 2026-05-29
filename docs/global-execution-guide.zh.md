# 全局工程执行指南

> 如何在日常工作中落地全局方法论
>
> 这个指南是 [全局工程方法论](./global-methodology.zh.md) 的实操版本。

---

## 第一部分：周期性操作

### 每日站会（如果有团队的话）或自查

#### 5 分钟快速检查

```
今天要做什么？
  → 是在处理上一个项目的同一任务，还是要切换？
  → 如果要切换，确认这个新项目是更高优先级吗？
  
当前遇到什么 blocker？
  → 有没有依赖其他项目的解决方案？
  → 能不能在 .codex-memory 里查到类似问题的答案？
```

### 每周规划（周一）

#### 30 分钟全局优先级评估

1. **检查 P0**
   ```
   有没有项目在等我的某个东西？
   （如果有，把它升到 P0，中断其他工作）
   ```

2. **确定本周 P1**
   ```
   这周最该专注的项目是什么？为什么？
   （写下理由，后续评估时用）
   ```

3. **列出 P2**
   ```
   有空余时间时该做什么？
   （通常是积累类：文档、工具、模式沉淀）
   ```

4. **扫描外部变化**
   ```
   上周有没有新的跨项目模式出现？
   上周的决策有没有被后续项目驳回？
   ```

**输出物：** 更新 `.solomap-global/portfolio.csv` 中的优先级列

### 每周审核（周五）

#### 30 分钟学习候选审核

1. **查看 `.solomap-global/.solopreneur-learning/`**
   ```
   这周完成的环节生成了哪些学习候选？
   ```

2. **逐项评估**
   ```
   这个学习是否会在下个项目中出现？
   如果出现，复用的概率是多少？
   （目标：>50% 才进入 .codex-memory）
   ```

3. **批准提升**
   ```
   标记为 "approved_for_codex"
   （下周由你手工提升到 .codex-memory）
   ```

**输出物：** `.solomap-global/.solopreneur-learning/{project}/approved.csv`

#### 15 分钟下周准备

1. **预览下周 P1 项目**
   ```
   读一遍该项目的 README
   快速扫 .codex-memory/projects/{project_name}
   ```

2. **识别可复用的起点**
   ```
   有没有类似的项目我们已经做过？
   那个项目的起点方案是什么？
   ```

3. **提前预警 blocker**
   ```
   这个项目会不会卡在什么地方？
   能不能提前准备应对方案？
   ```

**输出物：** 下周项目的启动 checklist

### 每月审视（月末）

#### 1 小时月度反思

1. **执行效率回顾**
   ```
   这个月的环节完成速度相比上个月变了吗？
   如果提升，提升来自哪个项目的复用？
   ```

2. **优先级准确度评估**
   ```
   月初定的优先级，现在看对不对？
   有没有误判的地方？
   ```

3. **知识沉淀质量**
   ```
   这个月提升到 .codex-memory 的知识被用上了吗？
   有没有"记了但没用"的知识？
   ```

4. **跨项目协调**
   ```
   这个月有没有项目因为依赖被阻断？
   是否应该调整下月的优先级？
   ```

**输出物：** 更新 `.codex-memory/active/current-session.md` 或月度总结文件

---

## 第二部分：按阶段的操作清单

### 新项目初始化

#### 第 0 步：分类判断（5 分钟）

```
这个项目属于哪一类？
  ├─ 核心产品 → 完整四阶段路线图
  ├─ 基础设施 → 严格版本管理
  ├─ 内容产品 → 工程化流程
  ├─ 试验研究 → 轻量路线图
  ├─ 工具脚手架 → 清晰接口
  └─ 归档维护 → 监控优先

这个分类决定了路线图模板的选择
```

#### 第 1 步：查阅相似项目（10 分钟）

```
在 .codex-memory/projects 中找相似项目
  → 查看他们的 README
  → 查看他们的 .solopreneur/roadmap.csv
  → 看他们第一个环节怎么做的

复制可直接用的部分（目标模型、技术栈、初始任务）
```

#### 第 2 步：提取起点模板（10 分钟）

```
从 .codex-memory/patterns 中查找相关模式
  → "内容产品的工程化"模式
  → "跨项目基础设施"模式
  → 相关技术决策

用这些模式快速初始化项目的起点
```

#### 第 3 步：启动 SoloMap（5 分钟）

```
创建项目的 .solopreneur/roadmap.csv
  → 用起点模板作为初始路线图
  → 不要从空白开始

这个新项目的启动速度应该比前一个快 30-50%
```

### 环节执行中的查询

#### 场景 1：遇到问题，不知道怎么解

```
当前环节: "实现 X 功能"
遇到问题: Y 错误

操作:
  1. 描述问题
  2. 在 .codex-memory/patterns 中搜索
     └─ patterns/problem-closure-mindset.md
     └─ patterns/coding-patterns.md
  3. 查看 .codex-memory/projects 中相似项目的历史
  4. 给 Agent 的 prompt 中自动引用这些知识
  
结果: 80% 的问题能找到已知解法，快速解决
```

#### 场景 2：看到两个项目的决策冲突

```
项目 A: "用 OAuth 认证"
项目 B: "用 API Key 认证"
冲突: 两个都是合理的，但全局应该统一吗？

操作:
  1. 查看 .codex-memory/decisions
  2. 看过往类似决策怎么处理的
  3. 阅读决策的 "适用范围" 和 "理由"
  4. 做出全局最优选择

结果: 不再每个项目各搞一套，减少后期协调成本
```

#### 场景 3：要重复一个之前做过的功能

```
项目 C: "需要实现上传文件到 R2"
之前: "项目 A、B 都做过"

操作:
  1. 查询 .codex-memory 中的文件上传模式
  2. 找到项目 A 的 step-memory 中的具体实现
  3. 复制代码和配置
  4. 项目 C 改只需要改参数，不需要重新设计
  
结果: 这个功能的执行速度快 70%
```

### 环节完成后的学习提升

#### 第 1 步：SoloMap 自动生成学习候选

```
step-memory/{step_id}.json 中生成：
  - 模式识别: "这个步骤用到的通用模式"
  - 决策记录: "这个步骤的关键决策是什么"
  - 问题记录: "遇到过什么 blocker"
  - 成功标志: "什么证明这个步骤成功了"
```

#### 第 2 步：周五审核

```
查看 .solomap-global/.solopreneur-learning/{project}

对每个学习候选问三个问题：
  1. 这个在其他项目也会出现吗？
  2. 如果出现，复用的概率是多少？
  3. 它是解决方案还是只是观察？

只有回答"会在其他项目出现且概率 >50%"时，
才标记为 "approved_for_codex"
```

#### 第 3 步：手工提升到 .codex-memory

```
approved 的学习：

如果是模式 → 进入 .codex-memory/patterns/{category}.md
如果是决策 → 进入 .codex-memory/decisions/{topic}.md
如果是领域知识 → 进入 .codex-memory/domains/{domain}.md
如果是项目特例 → 留在 .codex-memory/projects/{project}.md

关键: 每次提升时写清 "何时适用、何时不适用"
```

#### 第 4 步：更新项目记忆

```
.codex-memory/projects/{project_name}.md 中记录:
  - 这个项目执行的关键决策
  - 当前的稳定状态
  - 下次要注意的 edge case
```

---

## 第三部分：工具和文件结构

### `.solomap-global/` 的文件结构

```
.solomap-global/
│
├── portfolio.csv
│   ├─ id: 项目 ID
│   ├─ name: 项目名
│   ├─ type: 项目类型 (core_product / infra / content / experiment / tool / archive)
│   ├─ status: 当前状态 (initializing / in_progress / stable / completed / paused)
│   ├─ priority: 当前优先级 (P0 / P1 / P2 / P3)
│   ├─ blocker: 被什么阻断（如果有）
│   ├─ next_action: 下一步该做什么
│   └─ owner: 负责人（如果是团队）
│
├── dependencies.csv
│   ├─ from_project: 依赖者
│   ├─ to_project: 被依赖项目
│   ├─ capability: 依赖的能力是什么
│   ├─ status: 依赖是否满足
│   └─ priority_boost: 这个依赖是否提升了优先级
│
├── .solopreneur-learning/
│   ├─ {project_name}/
│   │   ├─ step-1-learning.md
│   │   ├─ step-2-learning.md
│   │   └─ approved.csv
│   └─ ...
│
├── capability-registry.csv
│   ├─ capability_name: 能力名称
│   ├─ first_implemented_in: 第一次实现在哪个项目
│   ├─ reused_in_projects: 复用过的项目列表
│   ├─ reuse_success_rate: 复用成功率
│   └─ latest_improvement: 最后一次改进
│
├── decision-conflicts.csv
│   ├─ topic: 决策主题
│   ├─ project_a: 项目 A 的决策
│   ├─ project_b: 项目 B 的决策
│   ├─ resolution: 最终的全局决策
│   └─ rationale: 为什么这样决策
│
└── metrics/
    ├─ monthly-summary.md
    ├─ execution-speed-trends.csv
    ├─ reuse-rate-trends.csv
    └─ priority-accuracy.csv
```

### `.codex-memory/` 的查询模式

#### 查询 1：找相似项目

```bash
grep -r "similar_to" .codex-memory/projects/*.md
grep -r "predecessor" .codex-memory/projects/*.md
```

#### 查询 2：找已知解法

```bash
grep -r "solution" .codex-memory/patterns/*.md
grep -r "workaround" .codex-memory/patterns/*.md
```

#### 查询 3：查决策历史

```bash
grep -r "rationale" .codex-memory/decisions/*.md
grep -r "scope" .codex-memory/decisions/*.md
```

#### 查询 4：找域名知识

```bash
ls .codex-memory/domains/
# backend.md / frontend.md / infra.md / product.md
```

---

## 第四部分：遇到的常见情况与处理

### 情况 1：发现了新的跨项目模式

**症状：** 在项目 A 的某个环节中，你发现了一个"这个在其他项目肯定也用到"的通用方案

**处理：**

1. 在环节完成时，标记为 `pattern_candidate`
2. 下周的审核中，确认它是否真的跨项目适用
3. 如果适用，在 `.codex-memory/patterns/` 中新建或补充对应文件
4. 格式：`### 模式名\n说明\n适用场景\n实现示例\n何时不适用`

### 情况 2：项目因为依赖被阻断了

**症状：** 项目 B 的工作停了，因为在等项目 A 的某个能力

**处理：**

1. 在 `.solomap-global/dependencies.csv` 中记录这个依赖
2. 把项目 A 的相关工作升到 P0 或 P1
3. 把项目 B 标记为 "blocked_by_A"
4. 每周检查项目 A 的进度
5. 一旦项目 A 完成，项目 B 自动升到 P1

### 情况 3：需要决策，但发现多个项目的做法不一样

**症状：** "我们应该用 Cloudapi 还是直接调用 LLM provider？" 项目 C 和项目 D 的答案不一样

**处理：**

1. 在 `.solomap-global/decision-conflicts.csv` 中记录冲突
2. 查阅 `.codex-memory/decisions/` 看有没有相似的决策记录
3. 根据决策的理由和应用范围，做出全局最优选择
4. 在 `.codex-memory/decisions/` 中新建文件记录这次决策
5. 通知相关项目团队，后续应该遵循这个全局决策

### 情况 4：环节完成很快，但发现是因为复用了之前的方案

**症状：** "这个环节本该花 3 天，结果 1 天就完了，因为项目 A 已经做过"

**处理：**

1. 在学习候选中标记为 `successful_reuse`
2. 在 `.solomap-global/capability-registry.csv` 中更新复用率
3. 在月度评估时，用这个案例证明复利在生效
4. 识别更多可以这样复用的地方

### 情况 5：全局优先级和个人想做的事冲突

**症状：** "我想做项目 C，但全局优先级说应该做项目 B"

**处理：**

1. 在周规划时明确确认了 P1 项目
2. 如果想改，先问：项目 C 的优先级凭什么超过 P1？
3. 如果确实有新理由，更新 `portfolio.csv` 中的优先级和理由
4. 下周评估时会验证这个决策对不对

---

## 第五部分：常见指标与目标

### 执行速度指标

```
同类环节在不同项目中的耗时:

第一次实现:  10 天  (100%)
第二次复用:  5 天   (50%)
第三次复用:  3 天   (30%)

目标：第三次比第一次快 70%
```

### 能力复用率

```
新环节所需能力中：

第一个项目: 100% 自创
第二个项目: 70% 复用 + 30% 改进
第三个项目: 90% 复用 + 10% 改进

目标：复用率逐次上升，最终稳定在 85%+
```

### 跨项目决策冲突

```
第一个月: 发现冲突的方式 = 事后冲突爆发
第二个月: 发现冲突的方式 = 项目评审时识别
第三个月: 发现冲突的方式 = 规划时提前看到

目标：从被动发现冲突，升级到主动规划避免
```

### 学习提升成功率

```
周五审核的学习候选 100 个
  → 30 个被标记为 "non_reusable"（只是项目特例）
  → 50 个被标记为 "maybe_reusable"（可能用到）
  → 20 个被标记为 "definitely_reusable"（肯定会用）

提升到 .codex-memory 的只有最后这 20 个

目标：有多少 "maybe" 最终被证实为 "definitely"
```

---

## 相关文档

- [全局工程方法论](./global-methodology.zh.md) - 理论基础
- [.codex-memory 结构](../.codex-memory/README.md) - 知识库管理
- [SoloMap 方法论](./methodology.zh.md) - 单项目循环

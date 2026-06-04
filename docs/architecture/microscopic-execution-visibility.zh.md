# 微观层面执行可见性设计

## 问题陈述

目前 SoloMap 在项目生命周期层面实现了很好的**宏观可见性**：
- 路线图阶段清晰（Build/Sell/Learn/Improve）
- 每个环节的状态透明（Pending/In Progress/Completed/Failed）
- Agent 工作过程可追溯（Agent 运行日志、文件变更、结果交接）

但在**微观层面**（具体代码实现层）缺乏结构化可见性：
- 代码各模块是否按设计实现，无法快速验证
- 新增功能的设计图、实现路径、测试覆盖情况没有统一视口
- Agent 改动了哪些核心流程、为什么这样改，需要逐行 diff 才能理解
- 跨模块的协作关系、哪些是新增的边界、哪些实现已稳定，缺乏可视化
- 新人或返回后的开发者难以快速定位"这个功能在哪、当前状态如何、需要怎么改"

## 用户需求的本质

用户希望在以下场景中**不必逐行 diff，也能优雅地理解项目底层完成了什么**：

1. **功能验收**：Agent 声称"已完成某功能"，我想快速确认实现质量、设计合理性、测试覆盖
2. **代码审查**：有新的一轮改动提交，我想看设计图、核心改动、测试新增情况、而不是被 diff 淹没
3. **架构管理**：某个模块可能成为新瓶颈或设计不合理，我想有可视化视角看模块职责、依赖关系、当前健康度
4. **知识沉淀**：下一个开发者或 Agent 需要理解"为什么这里这样实现"，而不是只有代码和 Git log
5. **回溯验证**：某次改动说"遵循设计"，我想能快速对比实现与设计是否一致

## 微观可见性框架设计

### 核心思路：从过程到工件

不是让 Agent 在运行时不断上报状态（这会浪费 token），而是让 Agent 在每次重要改动后**生成标准化的工件**，这些工件可以被长期复用、对比、关联：

### 工件类型体系

#### 1. **模块设计工件** (Module Design Blueprint)
- **何时生成**：首次实现新模块或模块架构有重大重构
- **生成者**：Agent（设计阶段）
- **格式**：`docs/design/<模块-名>.zh.md`
- **内容**：
  - 模块目标与职责（一句话）
  - 与其他模块的协作关系（入站依赖、出站依赖、可独立测试的边界）
  - 核心数据流/状态机/协议（文字 + ASCII 图）
  - 已知限制与未来扩展方向
  - 预计实现周期与依赖项

**示例**（`docs/design/sync-engine.zh.md`）：
```
# SyncEngine 模块设计

## 职责
用 SQLite 和 CSV 管理路线图状态，驱动 Webview 增量更新。

## 入站依赖
- VS Code 文件系统事件（roadmap.csv 变更）
- 用户交互（新建/编辑/完成环节）
- Agent 执行结果（.agent_status.json）

## 出站依赖
- VS Code Webview API（sendMessage）
- SQLite（execution_logs 读写）
- fs 模块（文件监听、.solopreneur/ 子目录管理）

## 核心流程（数据流 + 状态流）

[ASCII 图表显示：CSV 变更 -> 解析 -> SQLite 更新 -> Webview 消息队列 -> 渲染]

## 边界条件与测试用例
- 无 SQLite 前：降级到纯 CSV 回读（兼容性）
- 大规模 roadmap（100+ 环节）：流式更新，不阻塞
- 并发 Agent 运行：多 Agent 同时写入同一环节交接，最后一次写入优先

## 未来扩展
- [ ] 支持多人协作的 OT/CRDT 冲突解决
- [ ] 可视化执行图谱（DAG 渲染）
```

#### 2. **实现工件** (Implementation Summary)
- **何时生成**：功能完成、测试通过、代码提交后
- **生成者**：Agent（验证阶段）或人工补充
- **格式**：`.solopreneur/agent-runs/<nodeId>/implementation.json`
- **内容**（JSON Schema）：
```json
{
  "module": "string",               // 涉及的主要模块
  "feature": "string",              // 功能名称
  "designRef": "string",            // 关联的设计文档链接
  "changes": [
    {
      "file": "string",             // 相对路径
      "type": "create|edit|delete", // 变更类型
      "lines": "number",            // 总行数变更
      "reason": "string",           // 这个文件为什么变
      "keyPoints": ["string"]       // 这个文件最重要的 3-5 点改动
    }
  ],
  "testCoverage": {
    "unitTests": {"new": number, "modified": number, "deleted": number},
    "regressionTests": "passed|failed|skipped",
    "integrationTests": {"touched": ["string"], "status": "passed|failed"}
  },
  "designCompliance": {
    "status": "compliant|deviation|unknown",
    "compliance": "string",   // 与设计一致性的说明
    "deviations": ["string"]  // 有意的偏离与理由
  },
  "boundaryChanges": {
    "newInterfaces": ["string"],    // 新增的输入/输出契约
    "modifiedInterfaces": ["string"],
    "breakingChanges": ["string"]   // 需要通知下游的改动
  },
  "quality": {
    "complexity": "low|medium|high",
    "riskLevel": "low|medium|high",
    "technicalDebt": ["string"],    // 已知的技术债
    "nextActions": ["string"]       // 后续改进建议
  },
  "verification": {
    "commands": ["string"],         // 用户可以运行的验证命令
    "manualSteps": ["string"]       // 需要人工检查的步骤
  }
}
```

#### 3. **设计对标工件** (Design vs Implementation Diff)
- **何时生成**：设计完成后、实现完成后、或代码审查时
- **生成者**：Agent（对标检查）
- **格式**：`docs/decisions/<功能名>-design-compliance.zh.md`
- **内容**：
```
## [功能名] 设计对标

### 设计预期 vs 实现现状

| 设计项 | 预期 | 实现现状 | 符合度 | 备注 |
|------|------|--------|-------|------|
| 界面刷新延迟 | <100ms | 50-200ms | 符合 | 大规模 roadmap 时可能达到 200ms |
| Agent 超时处理 | 30s 后降级到轮询 | 30s 后启用轮询 | 符合 | - |
| SQLite 兼容模式 | 无 SQLite 时回读 CSV | 已实现，自动降级 | 符合 | - |
| Webview 消息队列 | 防止 JSON 过大 | 未实现，直接全量推送 | **偏离** | 优先级降低，暂不处理 100+ 节点场景 |

### 有意的偏离

1. **消息队列**: 设计时考虑了分页推送，实现时因项目规模小（通常 <50 环节）而简化，后续可恢复
2. **并发锁**: 设计时假设单进程，实现时未预留多 Agent 的竞争机制

### 技术债

- [ ] WebView 消息体积控制（当前 roadmap >50 环节时需要分页）
- [ ] SQLite 事务隔离等级调整（防止 Agent 并发冲突）

### 下一轮建议

1. 先验证实际使用中 roadmap 节点数通常是多少
2. 如果超过 50 个，优先实现消息队列；否则保持现状
3. 多 Agent 支持时，回来补充锁与事务处理
```

#### 4. **模块依赖图工件** (Module Topology)
- **何时生成**：每次大改动后自动生成、或定期审计生成
- **生成者**：Agent（代码扫描工具）+ 人工评审
- **格式**：`.solopreneur/architecture/module-graph.json` + `docs/architecture/module-topology.zh.md`
- **内容**：
```
## 模块拓扑与依赖

### 模块列表
- extension（VS Code 主激活入口）
- sidebarProvider（侧边栏 Webview 提供方）
- syncEngine（SQLite + CSV 状态管理）
- csvStore（CSV 读写和格式转换）
- sqliteStore（SQLite 持久化）
- agentImpact（Agent 变更检测）
- documentationManifest（文档清单管理）

### 依赖关系
```
extension
├── sidebarProvider
│   ├── syncEngine
│   │   ├── csvStore
│   │   ├── sqliteStore
│   │   └── agentImpact
│   └── documentationManifest
└── [其他 VS Code 模块]
```

### 已知的设计约束
1. **单一 SyncEngine 实例**: 侧边栏和全屏 Webview 共享状态，需小心避免消息乱序
2. **CSV 到 SQLite 的单向映射**: 当前 SQLite 不能反向更新 CSV（防止数据分裂）
3. **Agent 输出的异步处理**: 文件监听和 watcher 的竞争

### 可视化查看
- [交互式模块图](../assets/module-dependency-diagram.html)（需手动维护）
```

#### 5. **快速诊断工件** (Health Check Report)
- **何时生成**：每次环节完成后、或定期审计
- **生成者**：Agent（静态分析工具）
- **格式**：`.solopreneur/health/<日期>-health-report.json`
- **内容**：
```json
{
  "timestamp": "2026-06-04T11:22:17Z",
  "project": "solopreneur-roadmap",
  "metrics": {
    "codeQuality": {
      "testsTotal": 44,
      "testsPassed": 44,
      "testsCoverage": "67%",
      "lintWarnings": 0,
      "lintErrors": 0
    },
    "architecture": {
      "modulesTotal": 7,
      "circularity": 0,
      "maxDepth": 4,
      "avgCoupling": 1.5
    },
    "documentation": {
      "designDocsRatio": 0.6,
      "architectureDocsUpToDate": true,
      "missingDesignDocs": ["某功能"],
      "missingImplementationRecords": []
    },
    "technicalDebt": {
      "estimatedHours": 12,
      "items": ["消息队列", "并发锁", "边界条件测试"]
    }
  },
  "scorecard": {
    "stability": 85,    // 0-100
    "maintainability": 78,
    "testCoverage": 67,
    "documentationCompleteness": 72,
    "overallHealth": 75
  },
  "actionItems": [
    {"priority": "P1", "item": "消息队列"},
    {"priority": "P2", "item": "多 Agent 锁机制"}
  ]
}
```

---

## 集成策略

### 方案 A：轻量级集成（3-6 周）
1. **阶段 1**：定义核心工件格式（模块设计 + 实现总结）
2. **阶段 2**：创建现有主要模块的设计文档（手工 + Agent 协助）
3. **阶段 3**：在 Agent 改动后自动生成实现工件
4. **阶段 4**：CI 中加入设计对标检查（可选的 linting）

### 方案 B：重量级集成（8-12 周）
1. 基础之上，添加模块依赖图的自动生成和可视化
2. 定期的健康报告生成和审计
3. 长期的工件演变历史追踪
4. 与反馈循环集成：用户提交 Issue -> 自动附加相关模块的设计和现状

---

## 落地建议

### 第一步：试点一个模块
选择 **SyncEngine**（核心的状态管理模块）作为试点：
1. 创建 `docs/design/sync-engine.zh.md`（设计）
2. 要求后续改动附带 `implementation.json`
3. 在每次 Agent 改动后生成设计对标报告

### 第二步：建立反馈记录与支持循环的连接
把微观工件嵌入反馈处理流程：
- 用户提交 Issue -> 自动列出涉及的模块 + 当前设计 + 最近改动
- Agent 改进代码 -> 自动生成实现工件 + 对标报告
- 用户验收 -> 可以从工件中快速理解改了什么、为什么改、质量如何

### 第三步：度量与迭代
- 追踪：改动理解的平均时间（目标从 20min diff 降到 5min 工件读取）
- 追踪：设计对标符合度（目标从 40% 提升到 85%+）
- 追踪：新成员熟悉代码的时间（目标从 3 天降到 1 天）

---

## 与既有系统的协调

### 与路线图的关系
- 路线图环节 = **宏观可见性**（What needs to be done）
- 微观工件 = **实现可见性**（How it's being done）
- 两个系统协同：环节驱动什么要做，工件说明怎么做的

### 与反馈循环的关系
- 微观工件是反馈处理的"上下文包"：用户反馈来了，能快速定位到相关模块、看懂当前设计、理解改动范围

### 与 Agent 工作流的关系
- Agent 每次改动后自动生成工件，不增加用户的额外负担
- 工件格式标准化，方便 Agent 下一轮理解上下文、避免重复改动

---

## 开放讨论

**这个框架是否能解决你的核心痛点？**

1. 你是否需要 Design -> Implementation 的自动对标？还是手工 spotcheck 就够？
2. 模块依赖图的实时更新 vs 定期审计，哪个更有价值？
3. 微观工件应该进入 Git 版本控制（长期保留），还是只在本地/AI 对话中流转？
4. 多项目之间，这类工件应该被复用吗？比如"SyncEngine 的设计模式"跨项目复用

**下一步建议**

根据你的反馈，可以：
1. 马上试点一个模块的完整流程（1-2 环节，1-2 周）
2. 优先解决最痛的场景（比如首先关注"反馈 -> 改动 -> 验证"这个链路）
3. 随着反馈循环逐步扩展工件类型和自动化程度

# 运行索引数据库层

## 目标

SoloMap 的运行数据分为两层：

- `project_journal.db` 负责结构化索引和高频查询。
- `.solopreneur/agent-runs/` 负责原始审计材料，保留完整命令、prompt、输出和工作区变更记录。

这个边界的目的不是把所有运行日志搬进数据库，而是让数据库承担它擅长的职责：快速回答“跑了什么、谁跑的、结果怎样、影响哪些文件、有哪些验证或失败信号”。

## 不变边界

- `.solopreneur/roadmap.csv` 仍是路线图节点的 Git 可读事实源。
- `execution_logs` 仍保存会话级摘要，用于最近对话、节点历史和生命周期展示。
- 完整 `output.log` 不进入数据库。数据库只保存输出路径、大小和有限尾部摘要。
- 原始运行目录仍是审计、复盘和深度排障入口。
- 数据库写入失败不得把一次已经完成的 Agent 运行改判失败；运行结果和索引健康是两个问题。

## 数据模型

第一阶段新增三张索引表：

- `run_records`：一条 Agent 运行的核心索引。
  - `executionLogId`
  - `nodeId`
  - `runKind`
  - `agentCli`
  - `status`
  - `startedAt`
  - `finishedAt`
  - `durationMs`
  - `outputPath`
  - `outputBytes`
  - `outputTail`
  - `commandPath`
  - `promptPath`
  - `changesPath`
  - `touchedFilesPath`
  - `updatedAt`
- `run_files`：运行触达的文件索引。
  - `executionLogId`
  - `filePath`
  - `role`
- `run_signals`：运行中的结构化信号。
  - `executionLogId`
  - `type`
  - `value`

## 第一阶段闭环

第一阶段完成的行为闭环：

1. 插件启动时确保旧数据库自动补齐运行索引表和索引。
2. Agent 运行结束时写入 `run_records`、`run_files`、`run_signals`。
3. Agent 贡献统计优先读取数据库索引。
4. 数据库没有索引数据时，继续回落到 `run-digests`；再没有时才读取 `.solopreneur/agent-runs/` 的轻量尾部信息。
5. 运行索引写入结果进入会话摘要，方便发现 DB 索引故障。

## 后续阶段

第二阶段迁移项目投资统计：

- 为 `projectAnalytics` 增加 DB 优先的数据入口。
- 将当前同步 portfolio 调用链改成可接收预加载的 DB 统计，避免把 `sql.js` 初始化异步性扩散成临时补丁。
- 保留 digest 和文件层兜底，直到旧项目完成足够 backfill。

第三阶段补齐治理和修复：

- 增加从 `run-digests` 回填 `run_records` 的显式修复动作。
- 在本地数据状态中展示运行索引健康度。
- 对异常索引写入提供可定位错误，而不是让用户理解 SQLite 表结构。

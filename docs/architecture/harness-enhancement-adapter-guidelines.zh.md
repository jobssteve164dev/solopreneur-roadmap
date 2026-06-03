# SoloMap Harness Enhancement Adapter 设计指导

## 这份文档解决什么判断

这份文档固定 SoloMap 外部增强能力如何吸收不同底层接入方式。

核心判断只有一句：**统一的是 Harness 对增强能力的治理协议，不是增强能力的底层调用方式。**

rtk、CodeGraph 和未来的日志压缩器、代码索引器、环境预检器，都可能增强 Agent 任务质量，但它们的接入方式天然不同。SoloMap 不应为了形式统一，把它们强行包装成同一种工具调用；也不应因为底层不同，就在用户心智、设置入口和任务流程里暴露多套概念。

## 第一性原则

用户要完成的是项目推进，不是管理增强插件。

因此前台只回答：

- 这个增强能力能让 Agent 更快、更准还是更省。
- 是否已启用。
- 是否需要用户授权。
- 失败后是否已经回到原流程。

前台不回答：

- 它是 MCP、命令改写、prompt policy、preflight 还是后台服务。
- 它的 hook、schema、索引、manifest、路由规则如何工作。
- 它如何写配置、如何启动进程、如何生成缓存。

底层差异必须由 Harness 吸收。

## 两层模型

每个 Harness Enhancement 分成两层：

```text
enhancement identity
  -> 这个增强是什么、解决什么、何时适用、风险是什么

activation adapter
  -> 它具体如何接入任务运行链路
```

### Enhancement Identity

Identity 是统一层，所有增强能力都必须具备。

它描述：

- `id`：稳定标识。
- `title`：用户可理解名称。
- `capability`：能力类型，例如命令输出优化、代码结构辅助、日志压缩、环境预检。
- `benefit`：更快、更准、更省中的主要收益。
- `activation`：适用任务、项目类型、文件类型、风险级别。
- `risk`：是否涉及网络、外部写入、密钥、后台服务、原始输出隐藏。
- `fallback`：增强失败时如何回到原流程。
- `evidencePolicy`：何时必须回读原始事实。

Identity 不描述底层怎么调用。

### Activation Adapter

Adapter 是差异层。它允许不同增强能力用不同方式接入。

它描述：

- `type`：接入方式。
- `detect`：如何检测可用性。
- `installCheck`：安装后如何验证。
- `runtime`：任务中如何注入或调用。
- `fallback`：这个 adapter 失败时如何退回。
- `sideEffects`：可能产生的本地文件、缓存、索引、tracking、tee 或服务进程。

Adapter 不改变用户前台心智。

## Adapter 类型

第一版只收敛以下 adapter 类型，后续按真实需求扩展。

| Adapter | 用途 | 例子 | 默认回退 |
| --- | --- | --- | --- |
| `mcp` | Agent 通过 MCP 工具获得额外能力 | CodeGraph 查询符号、调用关系、影响半径 | 直接文件搜索和现有 shell 工具 |
| `command_rewrite` | 改写或建议 shell 命令以减少输出噪声 | rtk 包装 `ls`、`grep`、构建、测试摘要 | 原始 shell 命令 |
| `prompt_policy` | 只注入行为策略，不提供工具或进程 | 要求 Agent 优先读某类上下文或避免某类命令 | 不注入策略 |
| `preflight` | Agent 启动前生成上下文包 | 代码结构摘要、环境状态摘要、依赖风险摘要 | 跳过上下文包 |
| `background_service` | 需要本地服务、索引或守护进程 | CodeGraph 高级索引服务 | 不使用服务，回到本地文件探索 |
| `output_filter` | 对运行输出做后处理 | 测试日志压缩器、部署日志摘要器 | 原始输出 |

禁止把 MCP 当成所有增强能力的总类型。MCP 只是 adapter 之一。

## 统一治理协议

Harness 必须统一管理以下内容：

- 安装来源和 source lock。
- manifest 校验。
- 可用性检测。
- 任务适用性判断。
- 风险等级。
- 默认启用策略。
- 用户授权边界。
- 本轮是否注入。
- 本轮是否成功生效。
- 失败时的回退路径。
- 是否影响完成判断。
- 是否产生本地缓存、索引、tracking 或 raw output 副作用。

Harness 不统一以下内容：

- 具体调用协议。
- 是否是 MCP。
- 是否需要命令改写。
- 是否需要本地服务。
- 是否生成索引。
- 是否修改 Agent 私有配置。

换句话说：

```text
Registry 统一
Policy 统一
Risk 统一
Fallback 统一
效果记录统一

Adapter 不强行统一
```

## Manifest 指导

增强能力 manifest 应表达两层结构。

rtk 这类命令输出优化器可以声明为：

```json
{
  "id": "rtk",
  "kind": "harness_enhancement",
  "capability": "command_output_optimization",
  "benefit": "save_tokens",
  "activation": {
    "taskKinds": ["code", "debug", "test", "build"],
    "useWhen": ["需要读取目录、搜索文本、运行构建或测试摘要"],
    "doNotUseWhen": ["需要完整原始日志、安全审计、发布验收或精读源码"]
  },
  "adapter": {
    "type": "command_rewrite",
    "detect": "rtk --version",
    "runtime": "prefer rtk for eligible shell commands",
    "fallback": "raw_command"
  },
  "evidencePolicy": {
    "mustReadRawWhen": ["root_cause", "security", "permissions", "release", "data_migration"]
  }
}
```

CodeGraph 这类代码结构辅助可以声明为：

```json
{
  "id": "codegraph",
  "kind": "harness_enhancement",
  "capability": "code_structure_context",
  "benefit": "improve_accuracy",
  "activation": {
    "taskKinds": ["code", "debug", "refactor", "review"],
    "useWhen": ["需要定位符号、调用关系或影响半径"],
    "doNotUseWhen": ["任务不涉及代码结构或当前索引不可用"]
  },
  "adapter": {
    "type": "mcp",
    "detect": "check configured MCP profile",
    "tools": ["symbol_search", "call_graph", "impact_radius"],
    "fallback": "direct_file_search"
  },
  "evidencePolicy": {
    "mustVerifyWith": ["current_files", "tests", "git_diff"]
  }
}
```

这些示例说明 manifest 形态，不代表当前已经实现。

## 任务注入规则

Harness 在任务开始前做三步判断：

1. 这个增强是否已安装并可用。
2. 当前任务是否适用。
3. 启用后是否会改变用户授权、风险、成本或结果责任。

只有三步都通过，才把增强能力注入本轮 Agent 上下文。

注入内容必须是行动指导，不是内部配置说明。例如：

- 可以注入：“本轮可使用代码结构辅助定位相关符号；所有结论仍需以当前文件和测试为准。”
- 可以注入：“本轮可优先用命令输出优化器查看目录、搜索和构建摘要；需要根因或验收时回读原始输出。”
- 不应注入：“adapter type 是 mcp，registry score 为 0.82，profile path 是某某。”

## 回退与完成判断

增强能力失败时，主任务继续。

回退规则：

- `mcp` 不可用：回到文件搜索、`rg`、测试和当前代码审计。
- `command_rewrite` 不可用：运行原始命令。
- `preflight` 失败：不注入上下文包。
- `background_service` 未启动：不启动主任务阻断，除非用户明确要求该增强是本轮目标。
- `output_filter` 失败：保留原始输出。

增强能力不能单独决定任务完成。

任务完成仍以用户目标、文件改动、测试验证、运行结果、交付证据和必要授权为准。增强能力只提供辅助信号。

## 事实来源边界

增强输出不是最高事实来源。

优先级应始终是：

```text
用户本轮要求
当前文件 / 当前命令输出 / 当前测试 / 当前日志
SoloMap 项目状态与运行记录
增强能力输出
历史经验与召回摘要
```

当增强输出与当前事实冲突时，以当前事实为准。

当增强能力为了省 token 做摘要、过滤、索引或压缩时，必须保留回到原始事实的路径。

## 用户界面边界

设置页可以提供统一入口：

```text
添加增强能力
```

安装后展示用户收益：

```text
命令输出优化
代码结构辅助
日志摘要辅助
```

不要展示 adapter 作为用户心智主语：

```text
MCP adapter
command_rewrite adapter
background_service adapter
索引 schema
hook profile
```

adapter 只属于实现层、诊断层和开发者文档。

## 禁止项

- 禁止把所有增强能力硬塞进 MCP。
- 禁止为了统一接口而牺牲真实能力形态。
- 禁止让用户选择 adapter 类型来完成普通任务。
- 禁止让增强能力失败阻断主任务，除非用户本轮目标就是安装或验证该增强。
- 禁止让压缩、摘要、索引结果替代原始文件、原始日志、测试结果或用户授权。
- 禁止自动写入 Agent 私有配置、安装全局 hook、启动后台服务或打开外部连接，除非用户明确授权。
- 禁止把第三方增强能力的 tracking、tee、索引或运行日志混入 SoloMap 主运行记录，除非先定义清晰的数据归属和清理边界。

## 与跨 Agent Harness 的关系

跨 Agent Harness 负责统一项目上下文、能力候选、安装治理和执行闭环。

Harness Enhancement Adapter 机制是其中一层：它让 rtk、CodeGraph 等外部能力可以进入同一套治理面，同时保留各自最合适的底层接入方式。

长期目标不是让 SoloMap 成为插件管理器，而是让外部增强能力在不增加用户心智负担的前提下，提高 Agent 任务完成率、减少无效探索、降低 token 浪费。

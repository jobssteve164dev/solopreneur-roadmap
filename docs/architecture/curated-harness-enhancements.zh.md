# SoloMap 内置 Harness 增强能力挂载指导

## 这份文档固定什么

SoloMap Harness Enhancement 不作为开放插件市场面向用户。下一阶段采用 **内置增强能力 + 安装/检测状态卡** 的产品路径。

用户不需要粘贴 GitHub 仓库、npm 包、二进制下载地址或 adapter 配置。用户只需要知道：

- 这个增强能力解决什么问题。
- 当前是否已安装、是否可用、安装版本是多少。
- 是否需要授权。
- 失败后是否回到原流程。

第三方项目只作为供应方或实现材料进入 Harness 内部适配层。用户看到的是能力，不是供应方。

## 产品原则

增强能力服务项目推进，不服务插件管理。

设置页不开放“安装任意增强能力”。设置页只展示经过 SoloMap 调研、适配和验证的能力卡片：

- 命令输出优化。
- 代码结构辅助。
- MCP 工具描述压缩。
- 极简回复模式。
- 记忆文件压缩。

能力可以显示收益、状态、版本和下一步动作，但不把 `mcp`、`command_rewrite`、`output_filter`、hook、profile、source lock、registry path 当作用户主语。

## 内部挂载模型

每个内置增强能力仍然进入 `.solomap-global/enhancements` 的 registry 和 manifest，但真实安装、更新和修复由 Agent CLI 按 SoloMap 安装 skill 执行；插件只负责复验、登记、状态展示、运行时消费和 fallback。

内部结构保留：

- `solomap.enhancement.json`：能力身份、适用场景、风险、adapter、fallback、证据策略。
- `source.lock.json`：供应方来源、版本、commit、校验信息。
- `health.json`：本机可用性、版本、检测时间、配置改动摘要和警告。
- `profiles/`：不同 Agent CLI 或运行链路的接入建议。
- `runs/`：检测、验证和排障记录。

用户界面只映射到状态和动作：

```text
命令输出优化        未安装 / 已安装 / 需要修复    版本    安装 / 修复 / 重新检测
代码结构辅助        未安装 / 已安装 / 需要修复    版本    安装 / 修复 / 重新检测
MCP 工具描述压缩    未安装 / 已安装 / 需要修复    版本    安装 / 修复 / 重新检测
```

## 第一版闭环边界

首版只落地三个内置增强能力卡片：

- 命令输出优化。
- 代码结构辅助。
- MCP 工具描述压缩。

这三个能力进入设置页、Agent 安装链路、插件复验链路和 Agent runtime 挂载链路。未安装或复验未通过时不注入、不挂载；用户点击安装或修复后，SoloMap 唤起当前默认 Agent CLI，要求 Agent 按内置增强安装 skill 安装、配置、写 manifest/source lock/health/result；插件读取 result 并复验通过后才标记为可用。

首版仍不开放任意增强能力安装入口，也不把第三方仓库代码复制进主仓。供应方来源只作为内置 manifest 的 source 信息、安装命令和后续适配依据保留。真实接入跟随上游仓库或包管理器更新，由 Harness 侧生成 profile、wrapper、MCP 配置建议和 fallback。

首版真实影响：

- 命令输出优化：生成 SoloMap 受管 PATH wrapper，在 Agent run 中前置常见 shell 命令；rtk 可用时走 `rtk <command>`，不可用时回退原始命令。
- 代码结构辅助：Agent 安装/配置 CodeGraph；Agent run 前检测 `codegraph`，缺少 `.codegraph/` 时初始化索引，并把 `.codegraph/` 加入 git info exclude。
- MCP 工具描述压缩：Agent 安装 caveman MCP shrink 路径，注册描述压缩能力；失败时不阻断主任务。

第二轮共同消费层：

- 每次 Agent run 生成 `.solopreneur/agent-runs/<scope>/harness-enhancements.md`。
- 该文件记录增强健康状态、rtk 原始输出旁路、CodeGraph 状态、任务搜索、索引文件概览、当前 diff 影响测试和 MCP 描述压缩状态。
- Agent prompt 必须先读取该文件，再决定是否使用增强结果。
- 共同层统一规则是：增强只降低探索成本，不替代当前文件、原始日志、测试和用户最新要求。

极简回复模式和记忆文件压缩暂不进入首版自动挂载：

- 极简回复模式容易影响用户可读性，只适合在用户明确要求省 token 或内部低风险汇报时启用。
- 记忆文件压缩涉及写文件和信息保真，必须保持手动触发和原始内容回退。

## 能力 1：命令输出优化

供应方候选：`rtk`

### 能力范围

用于减少 Agent 读取 shell 命令输出时的 token 浪费。

适用：

- `ls`、`tree`、`find` 等目录探索。
- `rg`、`grep` 等文本搜索摘要。
- `git status`、`git log`、部分 `git diff` 摘要。
- 构建、lint、测试输出的失败摘要。
- 大文件结构预览。

不适用：

- 根因判断需要完整日志时。
- 发布验收、安全审计、权限、数据迁移、计费、密钥相关任务。
- 需要逐字读取源码、配置、错误栈或测试输出时。
- 空输出或短输出场景；压缩可能反而增加噪音。

### 挂载方式

建议 adapter：

```json
{
  "id": "command-output-optimizer",
  "capability": "command_output_optimization",
  "benefit": "save_tokens",
  "adapter": {
    "type": "command_rewrite",
    "runtime": "prefer optimized wrapper for eligible shell commands",
    "fallback": "raw_command"
  }
}
```

SoloMap 不应依赖全局 shell hook 作为唯一主路径。首版真实挂载使用 SoloMap runtime PATH wrapper：

- 在 `.solomap-global/enhancements/runtime/bin/` 生成 `ls`、`tree`、`find`、`rg`、`grep`、`git`、`gh` wrapper。
- Agent run 脚本前置该目录到 `PATH`。
- wrapper 检测到正确 rtk 时执行 `rtk <command>`，否则执行原始命令。
- 关键证据命令可用 `SOLOMAP_RTK_BYPASS=1 <command>` 强制旁路 wrapper。
- 要求根因、验收、安全、权限和发布判断必须回读原始输出。
- 如果优化器不可用，直接运行原始命令。

setup 仍可运行上游 rtk init 来配置支持的 Agent，但 SoloMap 自身的可验证影响来自本轮 Agent shell 的受管 wrapper，不依赖用户全局 shell。

### 设置页呈现

名称：命令输出优化
说明：减少目录、搜索、构建和测试摘要的输出噪音。关键判断仍回读原始输出。
默认：关闭或仅建议。
风险：可能漏掉被压缩掉的细节。

## 能力 2：代码结构辅助

供应方候选：`CodeGraph`

### 能力范围

用于帮助 Agent 更快定位代码符号、调用关系、依赖边界和影响半径。

适用：

- 代码修复、调试、重构、代码审查。
- 需要定位函数、类、组件、路由、模块关系。
- 需要估计改动影响范围。
- 执行经验召回需要把历史 run 触碰文件映射到符号或模块。

不适用：

- 非代码任务。
- 当前索引不可用或明显过期。
- 判断任务是否完成、测试是否通过、用户是否满意。
- 替代真实文件读取、`git diff`、测试结果或运行日志。

### 挂载方式

建议 adapter：

```json
{
  "id": "code-structure-assistant",
  "capability": "code_structure_context",
  "benefit": "improve_accuracy",
  "adapter": {
    "type": "mcp",
    "runtime": "query symbols, call graph, impact radius when code task starts",
    "fallback": "direct_file_search"
  }
}
```

CodeGraph 可以作为受管 MCP 连接器，也可以作为代码上下文预检能力。无论哪种方式，前台都叫“代码结构辅助”。

挂载规则：

- 安装 Agent 负责按上游方式安装和配置 CodeGraph，并在 health/result 中记录版本与配置改动。
- Agent run 前如果 `codegraph` 可用且当前项目没有 `.codegraph/`，执行 `codegraph init -i` 建立索引。
- Agent run 前生成 CodeGraph 上下文包，包含 `codegraph status`、基于本轮任务文本的 `codegraph query`、`codegraph files` 和当前 diff 的 `codegraph affected`。
- 任务开始前可提供相关符号、模块、调用关系的短摘要。
- Agent 必须用当前文件和测试验证 CodeGraph 结果。
- 索引失败或过期时回到 `rg`、文件读取和测试。
- CodeGraph 输出不得成为完成判断。

### 设置页呈现

名称：代码结构辅助
说明：帮助 Agent 更快定位相关代码和影响范围。结论仍以当前文件和测试为准。
默认：关闭，代码项目可建议开启。
风险：索引可能过期。

## 能力 3：MCP 工具描述压缩

供应方候选：`caveman-shrink`

### 能力范围

用于压缩 MCP 工具目录中的自然语言描述，减少 Agent 读取工具清单时的 token 消耗。

适用：

- 已安装 MCP connector 较多，工具描述很长。
- Agent 任务需要读取 MCP `tools/list`、`prompts/list`、`resources/list`。
- 工具语义稳定，压缩只影响说明文字。

不适用：

- 工具描述本身是协议契约、法律文本、安全边界或用户必须逐字理解的说明。
- 工具返回内容、请求体、参数 schema 需要保持完整时。
- MCP server 使用非标准 stdio framing，proxy 兼容性未验证时。

### 挂载方式

建议 adapter：

```json
{
  "id": "mcp-description-compressor",
  "capability": "mcp_catalog_token_reduction",
  "benefit": "save_tokens",
  "adapter": {
    "type": "mcp",
    "runtime": "wrap selected MCP servers with description compressor",
    "fallback": "unwrapped_mcp_server"
  }
}
```

虽然底层是 MCP proxy，但用户不需要理解 proxy。SoloMap 应在内部生成 profile 建议，并在 setup 中运行上游 caveman installer 的 MCP shrink 配置路径：

- 对低风险 MCP server，可生成 wrapped profile。
- 不把 MCP proxy 细节暴露给用户前台。
- 不压缩 `tools/call` 返回，不改请求体。
- proxy 失败时回到原 MCP server。

### 设置页呈现

名称：MCP 工具描述压缩
说明：减少 MCP 工具清单说明的 token 占用，不改工具调用结果。
默认：关闭。
风险：工具说明变短后可能减少细节。

## 能力 4：极简回复模式

供应方候选：`caveman`

### 能力范围

用于让 Agent 的最终回复更短，降低输出 token 和阅读负担。

适用：

- 用户明确要求省 token、简短回复或快速状态更新。
- 内部 Agent 对话、排障摘要、低风险执行汇报。
- 非面向普通用户的技术协作。

不适用：

- 面向真实用户的产品文案、界面文案、营销内容、说明文档。
- 需要清晰安抚、完整解释、法律/安全/医疗/财务等高风险沟通。
- 用户要求详细解释或已经表示没看懂。
- SoloMap 最终用户体验需要自然、专业、完整表达时。

### 挂载方式

建议 adapter：

```json
{
  "id": "terse-response-mode",
  "capability": "response_token_reduction",
  "benefit": "save_tokens",
  "adapter": {
    "type": "prompt_policy",
    "runtime": "inject terse response policy when explicitly enabled",
    "fallback": "normal_response_style"
  }
}
```

这个能力不应默认开启。它改变用户看到的语言风格，因此必须受用户偏好控制。

### 设置页呈现

名称：极简回复模式
说明：让 Agent 回复更短。适合技术状态和低风险执行，不适合面向用户的内容。
默认：关闭。
选项：关闭 / 本轮手动 / 始终用于内部技术对话。
风险：过度压缩会降低可读性。

## 能力 5：记忆文件压缩

供应方候选：`caveman-compress`

### 能力范围

用于压缩长期记忆、偏好、项目说明等自然语言文件，减少每次注入的输入 token。

适用：

- 用户明确要求压缩某个 memory / preference / notes 文件。
- 文件主要是自然语言说明。
- 已经明确备份路径和还原方式。

不适用：

- 自动压缩项目正式文档。
- 自动压缩 `AGENTS.md`、`README.md`、产品文案、用户可见文档。
- 压缩代码、配置、JSON、YAML、脚本、SQL、env、lock 文件。
- 没有用户确认目标文件时。

### 挂载方式

建议 adapter：

```json
{
  "id": "memory-file-compressor",
  "capability": "memory_input_token_reduction",
  "benefit": "save_tokens",
  "adapter": {
    "type": "preflight",
    "runtime": "manual compression workflow for selected natural-language memory files",
    "fallback": "leave_file_unchanged"
  },
  "risk": {
    "writesFiles": true,
    "requiresExplicitEnable": true
  }
}
```

这个能力只能作为手动动作，不能进入普通任务自动候选。

执行前必须展示：

- 待压缩文件。
- 备份文件。
- 可还原路径。
- 压缩后仍需保留的事实边界。

### 设置页呈现

名称：记忆文件压缩
说明：手动压缩长期记忆文件，降低输入 token。会备份原文件。
默认：手动。
风险：会改写文件，必须明确确认。

## 三个供应方的挂载优先级

| 优先级 | 能力 | 供应方 | 建议先做原因 |
| --- | --- | --- | --- |
| P1 | MCP 工具描述压缩 | caveman-shrink | 边界清晰，只压缩工具清单说明，不改工具调用结果 |
| P1 | 命令输出优化 | rtk | 对 Agent CLI token 浪费直接有效，但必须保留原始输出回退 |
| P2 | 代码结构辅助 | CodeGraph | 能提高代码任务准确率，但需要索引可用性和当前文件验证 |
| P2 | 极简回复模式 | caveman | 实现简单，但会改变用户体验，需偏好开关 |
| P3 | 记忆文件压缩 | caveman-compress | 有输入 token 价值，但会写文件，只能手动确认 |

## 下一步集成顺序

第一步：把设置页从“启用开关”改成“内置增强能力安装/检测状态卡”。
第二步：新增增强安装 skill，并让 Agent CLI 负责复杂安装与配置。
第三步：插件复验 result、manifest、source lock、health 和版本后写入 registry。
第四步：先实现只读/低副作用能力：

1. MCP 工具描述压缩 profile 生成。
2. 命令输出优化的 prompt 建议和原始输出回退协议。
3. 代码结构辅助的候选注入占位和可用性检测。

第五步：把高风险能力保持为手动动作：

- 极简回复模式仅影响内部技术对话。
- 记忆文件压缩必须逐文件确认。

## 禁止事项

- 禁止开放任意第三方增强来源安装给普通用户。
- 禁止把供应方名称当作设置页主语。
- 禁止由插件直接执行复杂安装命令；复杂安装、配置和修复必须交给 Agent CLI 的受控安装任务，插件只做复验与登记。
- 禁止默认写入 Agent 私有配置、全局 shell hook、IDE rule file 或 OpenClaw workspace；若上游安装器确实修改配置，Agent 必须在 health/result 中列出改动。
- 禁止让增强能力替代当前文件、命令输出、测试和日志。
- 禁止让增强失败阻断主任务。
- 禁止自动压缩长期文档或用户可见内容。

## 成功标准

这条路线成立的标准不是“用户能安装更多插件”，而是：

- 用户只用一套开关理解增强能力。
- Agent 在合适任务中获得更省、更准或更快的辅助。
- 增强失败时主任务继续。
- 所有关键判断仍能回到原始事实。
- SoloMap 不把底层插件生态的复杂度转嫁给用户。

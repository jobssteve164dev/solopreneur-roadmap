# CloudMCP JSON 记忆目标适配边界

## 一句话边界

SoloMap 可以被用户显式选择为 CloudMCP 本地代理的一种 JSON 记忆目标：适配必须是可选的，不能改变未安装 CloudMCP 用户的默认提示词、写入路径或使用方式。

## 组件分工

| 组件 | 职责 |
| --- | --- |
| CloudMCP 本地代理 npm 包 | `capture_memory` 唯一写入口、本地目标契约、JSON 生成与校验、双端写入和回读一致性验证 |
| CloudMCP memory plane | 受治理的远端 scope、幂等 revision 存储和读取 |
| SoloMap | 用户在 VS Code 中显式连接目标后，由宿主校验并导入 `active` 条目；Agent 只从统一数据库检索 |

SoloMap 不负责：

- 实现另一个 `capture_memory`。
- 在未连接时扫描本地目录或推断云端差异。
- 把本地绝对路径上传云端。
- 自动合并两台设备直接编辑产生的文件冲突。
- 在全局提示词、默认技能或初始化目录中假设 CloudMCP 已安装。
- 要求不使用 CloudMCP 的用户理解 CloudMCP 对象或协议。

## 本地目录契约

本地代理通过 `configure_local_memory_target` 接收用户或 Agent 明确指定的目录。SoloMap 不要求目录硬编码为某个固定位置。

当目标适配器为 `solomap` 时，目录结构是：

```text
<configured-memory-root>/
  contract.json
  entries/
    <memory-id>.json
```

`contract.json` 必须包含独立的 `targetId`、格式和 schema 版本；缺少身份的目录会被拒绝，不能以适配器名代替目标身份。本地绝对路径只由 VS Code 文件选择器交给宿主，不写入数据库或该文件。

用户通过“连接外部记忆”选择目录。宿主拒绝符号链接和读取期间发生变化的文件，逐条校验后写入统一数据库；“断开外部记忆”按持久化目标身份撤销授权，不依赖原目录仍然存在或内容仍可解析。普通 Agent MCP 会话不能调用连接、同步、对账或断开操作。

## 可选 JSON 读取规则

只有用户显式连接目标后，SoloMap 宿主才导入满足以下条件的条目：

1. `schemaVersion === 1`
2. `status === "active"`
3. `canonicalHash` 与条目内容匹配
4. `validUntil` 为空或尚未过期
5. scope 与当前用户、项目或工作空间匹配

`layer: "candidate"` 且 `status: "active"` 的条目默认不参与检索，只有显式请求 `inbox` 来源时才读取。`pending`、`draft`、`inactive` 等非 `active` 状态即使位于 stable 层也不进入任何普通上下文。当前用户要求、代码、测试、日志和实时外部回读始终高于历史记忆。

每次重新连接都会按目标身份对账：上游已经移除的条目会在数据库中标记为撤销；同一全局目标的同一条目在不同项目连接时仍是同一个全局对象。目标身份和条目身份使用精确匹配，不能被 `_` 等通配字符合并。同步、对账和断开均使用稳定幂等键，丢失回包后的重试返回原结果。

## 旧 Markdown 兼容

现有 `.solomap-global/memory` Markdown 只作为历史导入来源：

- 对已显式接入 CloudMCP 的目标，新正式记忆由 CloudMCP 本地代理写入 JSON；SoloMap 的新记忆和检索统一走数据库操作。
- 生产检索不直接读取 JSON 或旧 Markdown 文件；后台导入完成后以数据库对象和固定版本为准。
- 旧内容迁移必须走独立的显式导入和预览流程。
- 本轮不授权删除、覆盖或批量改写旧 Markdown。

## 跨设备恢复

新设备配置空目标后，由 CloudMCP 本地代理从获授权的远端 scope 初始化 JSON 条目。SoloMap 不扫描旧设备目录，也不承担设备间文件同步。

## 完成标准

- VS Code 宿主能连接、重连、对账和断开一个明确身份的 JSON v1 目标。
- `solomap_memory` MCP 工具的 `retrieve` 动作只从统一数据库检索已导入且仍获授权的条目。
- JSON 状态、有效期、scope、哈希和相关性过滤有测试。
- 旧 Markdown 只读导入保持兼容，生产消费者不回退到文件读取。
- SoloMap 全局提示词、默认技能和初始化目录不依赖 CloudMCP；未接入用户的行为与接入前一致。

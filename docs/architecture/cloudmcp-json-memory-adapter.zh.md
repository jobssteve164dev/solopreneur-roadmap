# CloudMCP JSON 记忆目标适配边界

## 一句话边界

SoloMap 可以被用户显式选择为 CloudMCP 本地代理的一种 JSON 记忆目标：适配必须是可选的，不能改变未安装 CloudMCP 用户的默认提示词、写入路径或使用方式。

## 组件分工

| 组件 | 职责 |
| --- | --- |
| CloudMCP 本地代理 npm 包 | `capture_memory` 唯一写入口、本地目标契约、JSON 生成与校验、双端写入和回读一致性验证 |
| CloudMCP memory plane | 受治理的远端 scope、幂等 revision 存储和读取 |
| SoloMap | 当配置目录中确实存在 CloudMCP JSON 条目时，附加解析与检索 active 条目；原有 Markdown 路径保持默认 |

SoloMap 不负责：

- 实现另一个 `capture_memory`。
- 扫描本地目录并推断云端差异。
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

`contract.json` 只包含目标身份、格式和 schema 版本；本地绝对路径保存在 CloudMCP 本机私有配置中，不写入该文件。

## 可选 JSON 读取规则

只有目标目录中已经存在由 CloudMCP 本地代理创建的 `entries/` 时，SoloMap 才附加读取其中满足以下条件的条目：

1. `schemaVersion === 1`
2. `status === "active"`
3. `canonicalHash` 与条目内容匹配
4. `validUntil` 为空或尚未过期
5. scope 与当前用户、项目或工作空间匹配

JSON 的 `candidate` 默认不参与检索，只有显式请求 `inbox` 来源时才读取。这条兼容读取不能改变 SoloMap 现有 Markdown 写入提示或普通用户默认行为。当前用户要求、代码、测试、日志和实时外部回读始终高于历史记忆。

## 旧 Markdown 兼容

现有 `.solomap-global/memory` Markdown 在迁移期间保持只读可检索：

- 对已显式接入 CloudMCP 的目标，新正式记忆由 CloudMCP 本地代理写入 JSON；未接入用户仍沿用 SoloMap 原有 Markdown 路径。
- 当 JSON 目录存在时，SoloMap 将有效 JSON 结果纳入检索并提高其排序优先级；目录不存在时行为不变。
- 旧内容迁移必须走独立的显式导入和预览流程。
- 本轮不授权删除、覆盖或批量改写旧 Markdown。

## 跨设备恢复

新设备配置空目标后，由 CloudMCP 本地代理从获授权的远端 scope 初始化 JSON 条目。SoloMap 不扫描旧设备目录，也不承担设备间文件同步。

## 完成标准

- `solomap-memory.cjs retrieve` 能在 `entries/` 已存在时检索 JSON v1 条目。
- JSON 状态、有效期、scope、哈希和相关性过滤有测试。
- 旧 Markdown 检索保持兼容，且 JSON 结果优先。
- SoloMap 全局提示词、默认技能和初始化目录不依赖 CloudMCP；未接入用户的行为与接入前一致。

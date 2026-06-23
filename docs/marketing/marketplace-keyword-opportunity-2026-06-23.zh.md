# Marketplace 关键词机会实验 2026-06-23

本实验用于评估 SoloMap 是否值得新增一个实验性同步发布插件，以及新插件 ID 应该覆盖哪些自然搜索词。实验对象是当前正式插件 `SZLK.solopreneur-roadmap`，市场为 Open VSX 与 Visual Studio Marketplace。

## 实验命令

```bash
npm --silent run openvsx:rank -- --preset growth --marketplaces openvsx,vscode --sort-by relevance --scan-limit 1000 --top 10 --json
```

`growth` 预设关键词：

- `ai`
- `agent`
- `ai agent`
- `coding agent`
- `ai coding`
- `ai coding agent`
- `ai code agent`
- `agent roadmap`
- `ai roadmap`
- `coding roadmap`
- `project roadmap`
- `claude code`
- `codex`
- `cursor agent`
- `local ai agent`
- `agent sessions`
- `agent workflow`
- `solomap`

## 结果摘要

| 关键词 | Open VSX 排名 | VS Marketplace 排名 | 判断 |
| --- | ---: | ---: | --- |
| `ai` | 508 | 未进前 1000 | 流量大但过泛，当前不适合主攻 |
| `agent` | 174 | 510 | 流量大但语义混杂，竞争强 |
| `ai agent` | 44 | 123 | 有价值，但头部强竞争 |
| `coding agent` | 46 | 44 | 高相关，高价值，是新 ID 必须覆盖的核心词 |
| `ai coding` | 82 | 65 | 高相关，高价值，但会撞 autocomplete/copilot 赛道 |
| `ai coding agent` | 26 | 27 | 最适合新插件 ID 的核心组合词 |
| `ai code agent` | 25 | 133 | Open VSX 强，VS Marketplace 相对弱于 `ai coding agent` |
| `agent roadmap` | 2 | 1 | 当前已经很强，适合守住和转化 |
| `ai roadmap` | 1 | 1 | 当前最强高相关长尾之一 |
| `coding roadmap` | 1 | 2 | 当前最强高相关长尾之一 |
| `project roadmap` | 1 | 2 | 当前强，但更偏项目管理 |
| `claude code` | 524 | 未进前 1000 | 流量大但品牌词强绑定，不适合作为 ID 主攻 |
| `codex` | 182 | 686 | 品牌词/产品词，转化不稳定 |
| `cursor agent` | 65 | 15 | VS Marketplace 机会好，但品牌词不适合做主 ID |
| `local ai agent` | 12 | 20 | 高相关、竞争相对可打，适合描述和副标题强化 |
| `agent sessions` | 175 | 31 | VS Marketplace 有一定机会，但产品心智不如 roadmap/agent cockpit |
| `agent workflow` | 16 | 57 | 有机会，适合 keywords 与 README 覆盖 |
| `solomap` | 1 | 1 | 品牌词已占住 |

## 关键观察

1. `ai` 单词流量最大，但不值得作为实验 ID 的唯一目标。VS Marketplace 下当前插件连前 1000 都进不去，头部被 AI autocomplete、AI assistant、AI review 等泛工具占据。
2. `agent` 单词同样竞争强，且含义混杂，包含 coding agent、Open Policy Agent、Salesforce Agent、workflow agent 等不同意图。
3. `ai coding agent` 是最平衡的核心组合词：Open VSX 第 26，VS Marketplace 第 27，说明当前 listing 已经能进入前 30；如果 extension id/name 精确命中，有机会进一步冲前排。
4. `coding agent` 和 `ai coding` 是必须覆盖的次核心词。它们在 VS Marketplace 的前 10 安装量总和都是千万级，说明真实需求强。
5. `agent roadmap`、`ai roadmap`、`coding roadmap`、`project roadmap` 当前已经很强，说明 SoloMap 的 roadmap 定位有效；新 listing 不应丢掉 roadmap。
6. `local ai agent` 是低竞争高相关机会词，适合在 description、README 首屏和 keywords 中持续强化。
7. `claude code`、`codex`、`cursor agent` 都有流量，但更接近第三方品牌词。可以在描述中说明兼容，不建议作为插件 ID 或 publisher 的主命名。

## 新插件 ID 建议

实验性新插件若目标是“尽量吃满搜索流量”，推荐：

```json
{
  "publisher": "SoloMapAI",
  "name": "ai-coding-agent-roadmap",
  "displayName": "AI Coding Agent Roadmap - SoloMap"
}
```

对应 ID：

```text
SoloMapAI.ai-coding-agent-roadmap
```

这个组合覆盖：

- `ai`
- `coding`
- `agent`
- `roadmap`
- `ai coding`
- `coding agent`
- `ai agent`
- `ai coding agent`

同时保留 SoloMap 品牌，不像 `ai-agent.ai-coding-agent-roadmap` 那样过度 SEO 化、低信任。

## 首屏市场文案建议

短描述第一句优先覆盖高价值组合词：

```text
AI coding agent roadmap for solo developers. Run Claude Code, Codex, Cursor Agent and local AI agents, organize sessions, and turn scattered AI chats into a Git-friendly roadmap.
```

中文补充：

```text
面向独立开发者的 AI 编码智能体路线图：运行 Claude Code、Codex、Cursor Agent 等本地智能体，整理会话，并把零散 AI 对话沉淀为 Git 友好的项目路线图。
```

## 后续实验标准

新插件发布后，建议至少观察 7-14 天，固定每天记录：

- Open VSX: `ai coding agent`, `coding agent`, `ai coding`, `local ai agent`, `agent roadmap`
- VS Marketplace: 同上
- 新插件安装量 / 下载量
- 老插件安装量 / 下载量是否被分流
- README 点击与 GitHub 流量来源

判断是否继续扩大新插件入口：

- `ai coding agent` 两边市场进入前 10：实验成功，继续推。
- `coding agent` 或 `ai coding` 任一进入前 20：可继续优化截图、README 和评分。
- 14 天后组合词仍在 30 名外：说明 ID 收益不足，需要改图文转化或重新评估 publisher/name。

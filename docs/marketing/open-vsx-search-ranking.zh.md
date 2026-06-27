# Open VSX 搜索排名调研

本文记录 SoloMap 在 Open VSX 市场搜索曝光优化中的长期判断。目标不是复述一次性查询结果，而是固定后续命名、描述、关键词与排名观测脚本的依据。

## 结论

Open VSX 的市场源码是开源的，公共站点主要基于 `eclipse-openvsx/openvsx`，open-vsx.org 的站点配置在 `EclipseFdn/open-vsx.org`。

Open VSX 默认搜索接口 `/api/-/search` 使用 `sortBy=relevance` 和 `sortOrder=desc`。默认排序不是单纯按下载量，而是由文本匹配得分和索引中的 `relevance` 字段共同决定。

对 SoloMap 来说，当前 `displayName` 和 `description` 已经让插件进入 `agent`、`ai`、`ai agent`、`coding agent` 等结果集；但 `name` / `extensionId` 仍是 `solopreneur-roadmap`，不包含 `ai` 或 `agent`，因此在单词级高竞争搜索里天然弱于 `agent-system.agent-system`、`trae.ai`、`lean-ai.lean-ai` 这类 extension id 精确命中的插件。

## 源码依据

主要源码入口：

- Open VSX 主仓库：https://github.com/eclipse-openvsx/openvsx
- open-vsx.org 公共实例配置：https://github.com/EclipseFdn/open-vsx.org
- 搜索 API：`server/src/main/java/org/eclipse/openvsx/RegistryAPI.java`
- Elasticsearch 搜索实现：`server/src/main/java/org/eclipse/openvsx/search/ElasticSearchService.java`
- relevance 计算：`server/src/main/java/org/eclipse/openvsx/search/RelevanceService.java`
- 搜索索引对象：`server/src/main/java/org/eclipse/openvsx/search/ExtensionSearch.java`
- 排序字段定义：`server/src/main/java/org/eclipse/openvsx/search/SortBy.java`

部署文档说明 Web UI 默认使用 Elasticsearch 做搜索；数据库搜索只是性能较差的备选路径。

## 默认 API 行为

`RegistryAPI.java` 中 `/api/-/search` 的默认参数：

- `size=18`
- `offset=0`
- `sortOrder=desc`
- `sortBy=relevance`
- `includeAllVersions=false`

这意味着用户在 Open VSX 网页搜索框输入关键词时，默认看到的是 relevance 倒序结果。

## 文本匹配权重

`ElasticSearchService.createTextSearchQuery` 对用户查询词构建多组匹配：

| 信号 | 字段 | 权重影响 |
| --- | --- | --- |
| 精确 extension id | `extensionId.keyword` | boost 10 |
| 多字段匹配 | `name` | boost 5 |
| 多字段匹配 | `displayName` | boost 5 |
| 多字段匹配 | `tags` | boost 3 |
| 多字段匹配 | `namespace` | boost 2 |
| 多字段匹配 | `description` | 无额外 boost |
| 模糊匹配 | `name`, `displayName`, `namespace`, `description` | fuzziness AUTO |
| 前缀匹配 | `displayName`, `namespace` | displayName 有额外 boost |

因此，市场排名最吃香的是：

1. extension id 精确包含用户搜索词。
2. package `name` 或 `displayName` 直接包含用户搜索词。
3. `tags` 命中。
4. `description` 命中。

仅在描述中塞关键词，效果会明显弱于 id/name/displayName 命中。

## relevance 字段

`RelevanceService` 将以下因素合成为索引中的 `relevance` 字段：

- 平均评分与评论数量。
- 下载量。
- 最新版本发布时间相对市场历史的时间位置。
- verified 状态。
- deprecated 状态。

默认配置中，未验证 namespace 会乘以 `0.5` 降权；deprecated 也会降权。SoloMap 已 verified，这是优势；但在 `agent` / `ai` 单词搜索中，文本匹配弱点仍然存在。

## 对 SoloMap 的影响

当前 SoloMap 的市场元数据：

- `extensionId`: `SZLK.solopreneur-roadmap`
- `name`: `solopreneur-roadmap`
- `displayName`: `SoloMap - AI Coding Agent Roadmap`
- `description`: 首句包含 `AI coding agent cockpit`
- `keywords`: 包含 `agent`、`ai-agent`、`ai-coding`、`cursor-agent` 等

实际含义：

- `roadmap` 和 `solomap` 查询仍是强项，因为 extension id/name/displayName 都能对齐。
- `ai agent`、`coding agent` 这类组合词比单独 `ai` 或 `agent` 更容易提升，因为 displayName 和 description 能连续覆盖语义。
- 单独 `agent` 和 `ai` 的前排竞争者通常在 extension id 或 package name 中直接含词，我们目前无法靠 description 单独追平。

## 后续优化原则

优先级从高到低：

1. 继续保留当前 `displayName` 中的 `AI Coding Agent Roadmap`，这是低风险的强相关性信号。
2. description 首句继续用英文直说产品动作，中文描述放在后半段，不要抢占英文搜索首句。
3. keywords 保持 `ai-agent`、`ai-coding`、`agent`、`cursor-agent`、`claude-code`、`local-ai`、`roadmap` 等组合。
4. 持续观测 `sortBy=relevance` 下的自然排名，同时对比 `downloadCount`、`timestamp`、`rating`，判断瓶颈是文本匹配、下载量、新鲜度还是评分。
5. 不轻易改 package `name`。改 `name` 会影响 extension id 和市场迁移路径，除非确认愿意承担新 listing / 老用户迁移 / 品牌断裂成本。

## 观测口径

使用仓库脚本：

```bash
npm run openvsx:rank
npm run openvsx:rank -- --queries agent,ai,"ai agent","coding agent" --sort-by relevance,downloadCount,timestamp,rating --scan-limit 1000 --top 10
npm run openvsx:rank -- --queries agent,roadmap --sort-by relevance,downloadCount --json
npm --silent run openvsx:rank -- --preset growth --marketplaces openvsx,vscode --sort-by relevance --scan-limit 1000 --top 10 --json
```

默认关注关键词：

- `agent`
- `ai`
- `ai agent`
- `coding agent`
- `ai coding`
- `roadmap`
- `solomap`

解释结果时优先看：

- relevance 排名：真实默认搜索曝光。
- downloadCount 排名：下载势能是否足够。
- timestamp 排名：新版发布新鲜度是否起作用。
- rating 排名：评分/评论是否是短板。

脚本现在也支持 VS Code Marketplace。`--marketplaces openvsx,vscode` 会同时查询 Open VSX 与 Visual Studio Marketplace；如果需要机器可解析 JSON，应使用 `npm --silent run` 避免 npm banner 混入输出。

## 当前判断

SoloMap 已经通过 displayName 与 description 优化从 `agent` / `ai` 前 100 不可见，进入了相关结果集。但要进入 `agent` 或 `ai` 单词前 10，仅靠描述和关键词大概率不够；除非 extension id/name 也强命中，或下载、评分、新鲜度形成明显优势。

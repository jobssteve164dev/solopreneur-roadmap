# `/home/ubuntu/project` 全项目数据迁移交接

更新时间：2026-10-13

## 最终目标

先用一个真实项目完成“迁移、对账、清理原路径、产品回读”的完整试点；试点全部通过后，再将 `/home/ubuntu/project` 下所有真实项目的 SoloMap 旧数据迁入 `/home/ubuntu/project/.solomap-global/solomap.db`。每个旧文件只有在数据库内容、归属、关系、版本和哈希完成对账后，才能进入精确回收清单；用户在插件界面核对并确认该清单后，必须在同一轮立即把这些旧文件从原项目路径移入 SoloMap 可恢复回收区，并验证原路径已经清除。

这项工作以 SoloMap 0.0.512 已发布能力为基线。除补足单项目试点所必需的最小项目作用域外，它是一项数据迁移操作，不是新迁移架构开发；真实迁移必须使用正式发布版本的设置入口、当前主 Agent CLI、正式 run 和 `solomap_data` MCP 工具。不得另写迁移脚本、直接修改数据库、直接搬动旧文件、创建专用运行时，或重新引入已经退役的 RTK、CodeGraph、Caveman 产品路径。

## 已确认起点

- SoloMap 0.0.512 已在 VS Marketplace 和 Open VSX 发布，八个交付包已经验收。
- 全局数据根：`/home/ubuntu/project/.solomap-global`。
- 权威数据库：`/home/ubuntu/project/.solomap-global/solomap.db`，本次只读检查大小为 9,849,450,496 字节，schema 版本为 39。
- `/home/ubuntu/project/.solomap-global/projects.json` 当前登记 58 个项目，所有登记路径都真实存在。
- `/home/ubuntu/project` 顶层有 67 个非隐藏目录，其中 55 个顶层目录已有 `.solopreneur`。
- 数据库当前只读快照：169 个迁移任务，其中 `completed=166`、`completed_with_conflicts=3`；157,456 个迁移项，其中 `captured=157042`、`imported=403`、`unmapped=11`；111 个回收项处于 `prepared`。这些只是新会话的起始事实，执行时必须通过正式 MCP 状态重新读取，不能直接按这里的数字结案。
- 当前 111 个 `prepared` 回收项属于同一个全局计划 `53f9bc98-0e88-4723-aa9e-ceb8a7811fbf`，跨多个项目，共 3,253,724,361 字节。它没有得到针对整份清单的用户确认，不能拿来冒充单项目试点，也不能直接执行。
- 顶层已有 `.solopreneur` 但未登记：`/home/ubuntu/project/TRANS-MES`。
- 顶层 Git 仓库但未登记：`GitOps`、`TRANS-MES`、`code-server-container`、`studio`、`wechat`。它们是待核对项目候选，不能因未登记而静默漏掉，也不能把无旧数据的项目伪造成迁移任务。
- 登记表包含四个非顶层路径：`.DailyWork`、`.solomap-global/memory/inbox`、`_external/TRANS-MES`、`revenue/earn-200`。必须核对其项目身份；尤其要区分顶层 `TRANS-MES` 与 `_external/TRANS-MES`，不得串项目或重复导入。
- `node_modules`、日志、审计、缓存、工具目录和父级容器目录不能仅因位于 `/home/ubuntu/project` 就当作业务项目登记。

## 试点门禁

试点项目固定为 `/home/ubuntu/project/packer`。它已经登记，是独立 Git 项目，`.solopreneur` 当前约 220,867 字节、34 个文件，同时具有 `agent-runs`、`step-memory`、`run-digests`、`project_journal.db`、`roadmap.csv` 和 `project.json`，数据量小且类型具有代表性。不能换成没有旧数据的空项目制造通过结果；若执行前发现该项目状态已经变化，应重新选择“已登记、数据量较小、同时覆盖主要旧数据类型”的项目，并记录理由。

已发布的 0.0.512 中，`solomap_migration_start` 和 `solomap_recycling_preview` 没有项目范围参数，现有设置动作会发现全部登记项目，回收计划也会聚合所有候选。因此在当前版本上直接点击全局动作不能证明单项目试点。新会话必须先核对这一事实；若仍成立，只补足“当前项目”这一最小工具作用域，并继续复用同一全局数据库、Runtime、主 Agent CLI、正式 run、终端、MCP 授权和生命周期。不得为试点创建第二套数据库、临时正式数据根、迁移内核或供应方专用链路。

项目作用域必须贯穿发现、状态读取、重试、回收预览和计划确认。全局默认行为保持可用，以便试点通过后使用同一工具执行全量迁移。任何项目作用域代码改动都按 SoloMap 仓库现有要求完成测试、独立审查、完整验证、提交、推送和正式版本发布后，才能对真实项目执行。

试点通过至少要求：

- 迁移前保存 `packer` 旧数据文件的路径、字节数和 SHA-256 清单，并记录数据库中该项目的基线对象/关系/版本计数。
- 迁移任务和回收计划只包含 `packer`，不得夹带其他项目或全局记忆来源。
- 数据库中的正文、原始字节、项目归属、父子关系和版本与迁移前清单对账一致；没有冲突、`unmapped` 或静默丢失。
- 精确回收清单经插件界面确认后立即执行；清单中的旧数据文件从 `packer` 原路径清除，`project.json`、`roadmap.csv`、规则、正式文档、源码和业务资产保持原样。
- 重新打开 `packer` 后，路线图、历史运行、步骤记忆、摘要/报告和相关产品消费者从数据库正常读取；数据库完整性成立，回收收据与恢复入口可用。
- 本轮临时进程和夹具已经清理。试点未全部通过时禁止开始全量；通过后直接沿同一实现推进全量，不再另造第二种流程。

## 正确启动方式

在安装并载入具备项目作用域迁移能力的 SoloMap 正式版本中先打开 `/home/ubuntu/project/packer`，确认设置的数据位置为 `/home/ubuntu/project/.solomap-global`，主 Agent CLI 选择用户当前使用的通用 Agent，然后从设置页“旧数据整理”启动“当前项目”迁移。这个入口必须创建具备迁移工具权限的正式 `migration_apply` 会话。试点通过后，再从同一设置卡片启动“全部项目”迁移。

普通 Solo 对话没有迁移写权限。若新对话不是正式 `migration_apply` 会话，不得绕过授权直接操作数据库或文件；应回到上述入口启动正式迁移会话。迁移完成后，设置页必须展示精确回收清单。用户逐项核对后点击“移到回收站”，由同一个主 Agent CLI 通用链路启动正式 `recycling_apply` 会话。

## 执行闭环

1. 读取根级和当前项目的 `AGENTS.md`、`agent.md`、本交接文件及相关长期记忆，确认没有更新的用户约束。
2. 只读核对登记表、顶层 Git 仓库和 `.solopreneur` 目录。用真实项目身份解决上述差集；新增真实项目只能走 SoloMap 既有项目登记路径，不能手改登记表。无旧数据的项目记录为“已检查，无需迁移”。
3. 先完成 `packer` 试点门禁。若当前正式工具仍不支持项目作用域，按“试点门禁”补足最小能力并正式发布；禁止用全局扫描、隔离数据根或手工文件操作伪装单项目试点。
4. 在限定 `packer` 的正式 `migration_apply` 会话中先调用 `solomap_migration_status`，再调用 `solomap_migration_start`。持续读取状态；对每个 `failed`、`interrupted` 或 `completed_with_conflicts` 任务逐项读取详情、修正可修正原因并调用 `solomap_migration_retry`。
5. 不以任务启动、队列排空或文件被捕获作为完成。必须证明正文、原始字节、项目归属、父子关系、版本和必要消费者已经进入权威数据库；试点范围的 `unmapped` 和冲突必须归零，不能用跳过、丢弃或禁用来源消除数字。
6. 试点迁移成功后立刻调用限定 `packer` 的 `solomap_recycling_preview`，生成包含绝对路径、哈希、字节数和计划 ID 的精确清单。清单只允许包含已完成对账且源哈希未变化的旧 SoloMap 数据文件。
7. 以下文件永远不进入回收清单：`project.json`、`roadmap.csv`、用户规则、正式项目文档、源代码、业务资产和其他非旧数据文件。变化中、正在使用、归属不明或尚未完整对账的文件继续保留并明确原因。
8. 回到插件界面展示试点清单。用户在清单上点击“移到回收站”即为该精确计划的确认；随后立即运行绑定同一 `planId` 的正式 `recycling_apply`。不得让 Agent 在确认前自行调用回收工具。
9. 完成试点回读和普通用户实际入口验证。全部试点门禁通过后，使用同一工具的全局作用域处理全部真实项目；重复迁移、对账、精确清单确认、即时回收和回读流程，直到全量完成。
10. 回收后逐项验证原项目路径不存在、回收收据与数据库状态一致、恢复入口仍可用，并再次调用 `solomap_migration_status`。若还有可安全回收的旧文件，继续同一流程，不把它留给下一轮。
11. 关闭本轮 Agent/终端/浏览器等临时进程并清理本轮夹具。任何永久删除回收区副本、历史夹具或其他存量文件的动作，仍须先提交新的精确物理文件清单，并取得针对该清单的明确授权；不得用批量删除命令。

## 完成标准

- `packer` 已先独立通过迁移、对账、即时回收、原路径清除和产品回读门禁，且证据证明没有夹带其他项目。
- 试点通过后，所有真实项目均被列入“已迁移”或“已检查，无旧数据”清单，没有因登记差异漏项。
- 迁移任务没有 `queued`、`running`、`interrupted`、`failed` 或 `completed_with_conflicts`。
- 没有未解释的 `unmapped`、缺失正文、关系断裂、版本漂移或项目串写。
- 所有满足回收条件的旧数据文件已经过精确清单确认并从原项目路径清除；被保留文件逐项给出原因。
- 数据库完整性、迁移总数、逐项目结果、回收计划/收据和原路径检查均有可复核证据。
- 不修改任何项目的 `roadmap.csv`，不改变路线图状态，不提交与迁移无关的代码或配置。
- 没有遗留测试夹具、后台进程或未结算的迁移/回收会话。

## 新对话提示词

```text
先以 `/home/ubuntu/project/packer` 为真实试点，完成 SoloMap 旧数据迁移、完整对账、即时清理原路径和产品回读；试点全部通过后，再执行 `/home/ubuntu/project` 下所有真实项目的全量迁移与即时清理。先完整读取：

1. 当前目录适用的所有 AGENTS.md 与 agent.md；
2. /home/ubuntu/project/solopreneur-roadmap/docs/qa/project-wide-data-migration-handoff.zh.md；
3. /home/ubuntu/project/.solomap-global/memory/profile.md；
4. /home/ubuntu/project/.solomap-global/memory/operating-rules.md；
5. /home/ubuntu/project/.solomap-global/memory/projects/solopreneur-roadmap.md；
6. /home/ubuntu/project/.solomap-global/memory/active/current-session.md。

严格以交接文件的最终目标、现实起点、执行闭环和完成标准为合同。先核对 58 个已登记项目与物理项目差集，不能漏掉未登记的真实项目，也不能把缓存、日志、node_modules 或父级容器目录当成项目。顶层 TRANS-MES 与 _external/TRANS-MES 必须按真实身份区分。

迁移与回收只能使用 SoloMap 的正式设置入口、当前主 Agent CLI、正式 migration_apply / recycling_apply 会话以及 solomap_data MCP 工具。不要另写迁移脚本，不要直接修改 solomap.db 或旧文件，不要新造运行时、会话、凭据、provider、结果或生命周期链路，不要恢复 RTK、CodeGraph、Caveman。

先核对当前正式版本是否支持按 projectRoot 贯穿迁移发现、状态、重试、回收预览和计划确认。已知 0.0.512 的公开迁移工具没有项目范围参数，现存 prepared 计划跨 111 个文件、多个项目，不能直接用于试点。若这一事实仍成立，只实现最小的当前项目作用域，继续复用既有全局数据库、Runtime、通用 Agent CLI 和生命周期；完成测试、独立审查、完整验证、提交、推送和正式发布后再操作真实数据。不得用第二数据根、手工筛文件或直接数据库操作代替作用域能力。普通对话若没有迁移工具权限，通过设置页进入正式迁移会话，不得绕过授权。

试点固定为 /home/ubuntu/project/packer。先保存其旧文件路径、字节和 SHA-256 清单及数据库基线，再只迁移 packer；任何任务或回收计划夹带其他项目都算试点失败。迁移后逐项对账正文、原始字节、归属、关系和版本，确保冲突与 unmapped 为零。立即生成只包含 packer 的精确回收清单；用户在插件界面核对并点击“移到回收站”后，立即执行绑定 planId 的 recycling_apply，验证原路径清除、保护文件未变、回收收据和恢复入口成立，并从真实产品入口读回路线图、历史运行、步骤记忆和报告。

试点所有门禁通过后，直接用同一实现切换到全部项目作用域推进全量；不要再创建另一套流程。

持续处理所有 failed、interrupted、completed_with_conflicts 和 unmapped，直到每个真实项目都得到“已迁移”或“已检查，无旧数据”的可验证结论。不要用验收代替实施前审计，不要因局部成功、超时、队列暂空或更早失败而停下。

迁移成功后立即生成精确回收清单。清单必须逐项包含绝对路径、哈希、字节数和 planId，只能包含已完整写入数据库、关系和版本已对账、源哈希未变化的旧 SoloMap 数据文件；必须排除 project.json、roadmap.csv、用户规则、正式文档、源码和业务资产。把完整清单交给插件界面确认；用户点击“移到回收站”后，立即通过绑定该 planId 的正式 recycling_apply 会话执行，并逐项确认原路径已清除、回收收据一致、恢复入口可用。若仍有可安全清理的旧文件，继续完成，不留到下一轮。

结束前清理本轮测试夹具和后台进程，更新交接状态，并交付：逐项目结果、迁移状态汇总、冲突/unmapped 归零证据、回收清单与收据、原路径清除验证、保留文件及原因。没有完整闭环前不要停下或宣称完成。不要修改任何项目的 roadmap.csv。
```

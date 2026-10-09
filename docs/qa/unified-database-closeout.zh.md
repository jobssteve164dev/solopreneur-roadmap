# 单一全局数据库收口验收账

本账对应 `docs/architecture/unified-local-database-blueprint.zh.md` 第 12.2 节八个交付包。起始源码提交为 `de80f4835292d168a33cf2fdd2b76acac97bfab5`，工作树干净。状态只随真实生产入口和验证证据更新；已有 schema、归档副本、迁移任务完成或测试通过，均不能单独关闭交付包。

## 固定交付合同

- 一个数据根只使用一个权威 `solomap.db`，Runtime 继续是唯一正式 owner。
- SQLite 活跃期的 `solomap.db-wal`、`solomap.db-shm` 属于同一个数据库的事务设施，允许由 SQLite 管理；不得手工删除来达成文件数指标。
- 项目常态保留 `project.json`、已有的 `roadmap.csv` 和用户正式规则、文档、产物；Runtime 只保留 `control.json`。实际执行包、宿主配置、活跃临时文件和用户导出按明确用途存在。
- 完整保留正文、原始字节、日志、附件、历史版本、项目归属和关系；不改本项目路线图状态。
- 多项目、多窗口、多 Agent 并发、提交后即时回读、关闭插件与 Runtime 重启后接续均属于完成条件。
- 历史来源只读。完整对账后才能列出物理回收清单；没有用户对精确清单的明确授权，不回收任何存量。
- 全部新代码、独立审查、完整验证、正式生成物和用户入口验收完成后才推送发布；双市场版本回读和干净工作树属于最终验收。

## 八包验收账

每包必须同时关闭：生产者、全部消费者、schema/正式 operation、历史导入、并发、重启恢复、负向测试、旧写入停止。以下为启动审计结果，全部保持未关闭。

| 包 | Observed in code：生产者与消费者 | schema / operation 现状 | 尚需取得的关闭证据 | 状态 |
| --- | --- | --- | --- | --- |
| 1 运行、会话、任务 | `extension.ts` 每轮生成 prompt、command、runner、session、status、PID、时间、快照、日志；`taskCheckpoint.ts` 读写物理状态；`sessionIdentity.ts`、`continuation.ts`、`activeConversationLedger.ts` 依赖文件恢复 | `unifiedSchema.ts` 有 task/turn/run/session/log/evidence 表；`runtimeDataOperations.ts` 的 journal/artifact 操作尚未代替正式生命周期 | 新建、续聊、停止、无 Agent 自报命令、迟到终态、关闭窗口、Runtime 重启全部从库恢复；完整日志和 binding 修订可读；永久 agent-runs 文件不增长 | 未关闭 |
| 2 摘要、报告、学习来源 | `runDigest.ts` 写 digest/graph/step-memory；`taskReport.ts` 写 learning-tasks、报告及回执；`growthReports.ts`、`learningReview.ts` 扫描来源文件 | 有 report/run_summaries/relations 和汇报投影；正式报告提交与读取仍需收敛 | 同任务同轮正文、父子关系、回执、证据、汇报与学习采集从库完整回读；旧目录不可作为成功前提 | 未关闭 |
| 3 记忆、经验、RSI | `solomap-memory.cjs`、`solomap-experience.cjs`、`learningLedger.ts`、`learningReviewRunner.ts`、`learningReviewApply.ts`、`solomapGlobal.ts` 仍有文件生产和读取 | memory/lesson/review/application/policy/use/evaluation 表及通用 CRUD 已有；后台记忆导入已有 | 正式工具与手动复盘入口切库；原始来源完整导入；审核应用完整策略；后续真实任务采用固定版本并完成结果评价；外部可选记忆适配与来源、scope、revision/hash、撤销及授权切换通过；无永久学习文件增长 | 未关闭 |
| 4 项目、设置、UI、后台 | `projectRegistry.ts` 写 projects.json；extension globalState；`activeConversationLedger.ts`、`scheduledTaskLedger.ts`、`autonomousRuntime.ts`、认知/TG config 和通知写文件 | projects/locations/settings/ui/leases/schedules/outbox/inbox 表已有；现有注册不等于项目管理和队列切换 | 位置、排序、隐藏、草稿、选择、设置补丁、多窗口、调度去重、投递重启、TG 身份代次和暂停后数据操作通过；只留 control.json | 未关闭 |
| 5 包、文档、附件 | `solomapGlobal.ts` 写 registry/source.lock/health/install 状态；`documentationManifest.ts` 写索引；`attachments.ts` 写消息附件 | integration/package/document/asset 表已有；通用写入尚未接完安装和消息入口 | 安装、升级、启停、卸载及失败恢复只认库；实际包可执行；消息附件字节完整；文档索引切库且正式用户资产守恒 | 未关闭 |
| 6 分析与回退退役 | `projectAnalytics.ts`、`agentImpact.ts`、`growthReports.ts`、`runIndexMaintenance.ts`、`localUsageStats.ts`、`strategyPyramid.ts` 和侧栏仍有旧源；extension 汇报 watcher 监听 agent-runs | 全局运行索引、生长与汇报投影已有；旧源回退仍在 | 十类消费者全部真实入口通过；隔离旧来源后统计、汇报、战略、日报、远端投影和使用量仍完整；旧 watcher 与兼容读取退役 | 未关闭 |
| 7 CSV、导出、恢复、边界 | `db/csvStore.ts` 直接读写 CSV；`db/unifiedDataStore.ts` export 输出当前单对象，backup 使用 SQLite API；缺少完整项目恢复入口 | file_binding/outbox/版本表已有；不能用单对象 export 冒充完整项目交换包 | CSV hash/revision/冲突及提交未投影恢复；全库一致性备份；单项目全历史导出恢复；move/clone/旧 ID/大附件/秘密边界；真实 CLI 无损配置接入 | 未关闭 |
| 8 生产者退役、对账、回收、发布 | `runtimeDatabaseBootstrap.ts`、`databaseMigrationCoordinator.ts` 导入 memory/intelligence/journal/growth/agent-runs；回收资格刻意保留仍有消费者的文件 | migration_items/job/recycling 框架已有；尚不能覆盖全部旧生产者 | 所有来源数量、原字节 hash、版本、关系、状态、冲突、重启对账；同存量同负载下新增文件、物理写入字节、读写及提交到回读延迟、宿主阻塞、首屏与恢复耗时对比；外部写入合同；精确清单授权；CI/安全/VSIX/双市场与主线一致 | 未关闭 |

Inference：现有表和归档能支撑后续切换，但在生产入口仍读写旧文件时，数据库没有独占内部业务权威。不能把“兼容可用”判为“终态成立”。

## 十类最终入口验收

以下都必须通过普通用户原有动作，不新增数据库模式、专用概念或迁移责任。

| 消费者 | 实际验收动作 | 证据 / 状态 |
| --- | --- | --- |
| 1 项目与 UI | 添加、隐藏、排序、项目属性、设置、草稿、展开、选中；两个窗口并发补丁与重启 | 待验收 |
| 2 路线图 | 用户编辑 CSV、Git checkout/pull、无冲突合并、真实冲突、DB 已提交但投影未写完后恢复 | 待验收；不改本项目 CSV |
| 3 执行入口 | Solo、步骤、续聊、路线图讨论/调整、Flow、复核、CLI 安装升级与包操作 | 待验收 |
| 4 身份与任务 | binding 修订、checkpoint、宿主 sentinel、报告回执、运行终态与后台恢复；Agent 不运行自报命令 | 待验收 |
| 5 分析与文档 | 贡献、投资、token、handoff、graph、生长、汇报、文档审计；旧来源不可用 | 待验收 |
| 6 记忆与 RSI | 真实外部 MCP 搜索、全文分页、create、patch、link、context、export 与同 revision 提交后回读；正式复盘收集/提案/验证/应用、后续采用版本、真实评价；可选外部记忆切换、撤销与来源版本核验；召回不冒充采用 | 待验收；已有宿主配置不代替真实工具动作 |
| 7 Runtime 与 TG | 租约、授权、调度、去重、TG 收发/代次、智能对话、通知、本地官网投影、插件关闭后继续 | 待验收 |
| 8 远端与领域投影 | issues/PR/security/delivery、日报、战略、渠道与领域记录 | 待验收 |
| 9 包与秘密 | 来源、版本、配置、健康、能力登记；原宿主配置无损；搜索、普通 MCP、导出不暴露秘密 | 待验收 |
| 10 数据带走 | 全库 backup、单项目导出恢复、move/clone、旧 ID、原日志、二进制附件与大正文 | 待验收 |

## 必须保留的负向与时序验收

- 同幂等键重试只有一次副作用；同键不同内容拒绝；旧 revision、旧 owner、迟到结果不能覆盖新状态。
- 同一数字 execution ID 在不同项目不混用；父子关系在缺少可选字段时仍保留；其他项目和会话仍能读写。
- 已提交事务即时读回；合法长任务不因整理或保护措施提前失败；历史后台迁移不阻塞入口骨架和当前任务。
- 进程在提交、状态刷新、CSV 投影、通知投递之间退出后可恢复，且不重复执行。
- 移开旧来源的隔离验证不能静默生成新旧文件；原生产来源不能为测试被移动或删除。
- 导出不包含长期秘密、跨项目私有数据；恢复不覆盖更新的对象、已有用户产物或不匹配的项目身份。

## 验证与发布台账

启动完整基线：`npm test`，日志定位 `/tmp/solomap-462-baseline-tests.log`，793 项中 792 通过、1 项宿主沙箱能力跳过、0 失败；compile 通过。

本轮已验证的迁移读取改动：常规概览不再逐条解码全部历史任务的保留文件清单；显式 `migration_status` 继续回读完整内容，受限维护 MCP 的原状态工具支持按任务读取详情。任务注册用 SQL 计数，不解析无关历史。最新状态按提交顺序决定，避免同毫秒 UUID 排序选中旧失败。九份相关测试在首次验证中 55 项通过；最终源码、完整测试及独立审查结果另行核实。这一项改动不关闭任何交付包。

记忆启动归属的另一项缺口：原实现只按旧 `projects.json` 建立项目映射；现在先使用数据库登记的项目位置，再合并旧登记来源。仅在数据库登记的项目无需重建旧文件即可导入并在重启后幂等恢复；数据库与旧登记出现相同目录 slug 时仍保留归属冲突，不把私有历史写到任一错误项目。两个位置只是同一项目的物理目录与符号链接时，不制造归属冲突。前两项负向案例在原实现均失败，别名回归也已观测失败并修正；26 项相关测试全部通过。这里没有退役其他仍读写旧登记的消费者，不能判定包 3、4、8 完成。

真实 Runtime 读回 169 个当前来源任务、157429 个已捕获来源；完整概览快照 25587837 字节。原始快照及隔离对比位于本数据根的 `tmp/acceptance-462-*`，属于本轮验收材料，全部保留且不向公开仓库写入项目私有路径。对比只覆盖迁移概览，不替代首屏、通知、任务、RSI、写入字节或整个生产库的性能验收。暖读取与冷读取必须区分，不能单取冷读宣称改进倍数。

最终概览查询用同一个隔离数据库、169 个真实来源任务、157185 个保留路径和 20 项冲突做八次交错对比。原实现读取加序列化 160–214 ms，当前 81–89 ms；载荷从 25587745 字节降至 70370 字节。全部任务详情与原快照逐项相等。此处不包含完整生产库、首屏或其他入口，不据此关闭存量性能验收。

最新完整源码验证：最终界面补丁后的串行 `npm test`，802 项中 801 通过、1 项宿主沙箱能力跳过、0 失败，日志 `/tmp/solomap-462-final-serial.log`；最终 compile 通过。此前把打包和全测并行运行，两者重写同一 `out/`，出现一项加载生成文件失败；打包结束后该用例单独通过，并重新串行跑完整测试，不能引用失败的并行结果作为验收。CI 三份稳定测试 35 项通过；根与 website 高危审计均为零漏洞。最终 VSIX 由正式脚本打包并通过审计：6284 文件、11.38 MiB 压缩、37.14 MiB 解压，产物 `output/acceptance-462/solopreneur-roadmap-0.0.511-candidate-ui-final.vsix`，SHA-256 `c349f1276ec51b42f72c7de1bdef81a29d65fb9f95bd3504e8358301e1ab9293`。这只是本地候选包，没有生产发布或双市场新版本回读证据。

真实 Chromium 已检查两份最终生成的完整 Webview HTML，分别从原设置按钮打开卡片；页面桥接至隔离数据库中的正式 `migration_overview` 操作。第二遍实际截图和 bounds 检查曾发现大图卡片被限高 flex 父容器压至 30 px，动作超出卡片并裁切；此前按 DOM 宣称两个入口均可读的判断已撤回。补丁只阻止该卡片被 flex 压缩，沿用父面板滚动。原最终生成物的真实布局断言失败；修复后展开详情的大图卡片高 645 px、侧栏高 684 px，7 个可见按钮均在各自卡片内。两处 DOM 保留全部 20 个冲突与 3 个重试动作，单张卡片、初始化执行且无 JavaScript 错误；360 px 侧栏下卡片宽 314 px。两处原“更新状态”按钮点击后均完成读取。最终截图已从普通用户视角复核正文、按钮、展开项和滚动可读性。全部生成内联脚本先经语法解析；最终截图为 `output/playwright/acceptance-462/roadmap-expanded-green.png` 与 `sidebar-expanded-green.png`，原裁切截图保留为负向证据。宿主桥为验收适配；没有发起真实重试、回收、Agent 维护，也不等同于已安装插件的十类生产入口验收。

预期源码改动会触发 `ci.yml`、`security.yml`、`publish.yml`；后者会递增版本、推送 main/tag、发布 VS Marketplace/Open VSX 并创建 GitHub Release。发布前必须复现 compile、完整 Node 测试、CI 三份稳定测试、根及 website 高危审计、最终 VSIX 验证；按最终 diff 扩展全部消费者和生成物检查。文档本身不触发 publish。

当前没有可授权回收清单，也没有本轮发布完成证据。历史文件全部保留；不得从本账推导出任何删除授权或终态声明。

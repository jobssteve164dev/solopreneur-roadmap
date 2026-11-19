# 数据分层与退出设计

更新：2026-11-14。状态：实施合同，尚未完成实现和发布验收。

本设计落实本次数据库空间与内容池审计。上位约束为[单一数据库蓝图](unified-local-database-blueprint.zh.md)、[交互与 Runtime 并发架构](interactive-runtime-concurrency-blueprint.zh.md)和[本地体验优先基线](../ui/local-first-loading-interaction-baseline.zh.md)。业务历史、正文、关系、固定版本与接续能力继续完整保留；同一数据根只有一个权威数据库，不增加旁路归档库或长期业务文件。

## 1. 目标与不变量

交付结果：每类数据都有明确的保留责任、冷热转换、退出条件、引用释放和实际空间回收路径；同一用户动作、旧版本读取、重试和重启恢复仍得到原有结果。

- 不以停日志、截断正文、缩短会话、提前失败或丢弃历史降低占用。
- 不把分层、编码、引用关系或维护队列变成用户需要配置的新概念。
- 用户输入输出、报告、路线图、有效记忆、采用/验证证据和正式历史不按统一 TTL 删除。
- 前台只读持久小投影；迁移、索引、压缩、回收与文件重整均不得进入前台/启动必经链。
- 只允许唯一 Writer 提交；重计算进入既有 Maintenance Compute Worker，读取沿已有独立 Reader，维护分片后重新参与统一准入。
- 既有生产数据不得用于探索迁移或回收算法。先用隔离数据库、真实引擎和最终候选完成验证；历史物理文件回收继续要求精确清单与授权。

## 2. 审计基线与生产链

2026-11-12 的一致读视图为20.892GB：`contents` 与 `content_chunks` 连同所属索引占13.141GB（62.90%），事件、请求与日志分块记录另占28.37%。普通索引合计5.455GB。内容池约1021万项，实际载荷8.560GB；小于16KiB的未压缩 JSON 约918万项、3.573GB。日志追加累计316万次，最近24小时82,743次。数字是审计样本，不是新增预算或永久配额。

已观察的正式链：

| 入口/生产者 | 当前写入和最终消费者 | 本次责任 |
|---|---|---|
| `runAgentProcess`、`runCodexContinuation`、`runNativeObserver` | `append_run_log` → `appendRunLog` → 原文、事件描述、回执；`readRunLog`、原生恢复、界面输出 | 保留字节、顺序、offset、重放结果；缩小技术回执的存储放大 |
| 统一 `write`、`recordMutation`、运行状态、设置 | 当前对象、`object_revisions`、`events`、`requests`；固定 revision、学习、导出 | 完整历史保留；小载荷无损冷存储，不把完整对象快照误当正文副本 |
| 导入、附件、项目导出、准备内容 | `putContent` / `putPreparedContent` / `putStagedProjectExportContent` | 共享内容完整性、准备过程 pin、失败/取消/重试与引用接管 |
| 旧认知检查点替换、副产物删除 | `queueStorageCleanupContents` → 既有维护 | 接入统一引用释放，不只依赖这两个入口发现可回收内容 |
| 历史对象/事件/回执/复盘输入 | 声明 FK 与 JSON 内的内容引用 | 统一保护所有实际解释的内容引用，补齐事件和回执容器，不能把未知引用当孤儿 |
| 派生投影、诊断、执行队列 | 当前投影、诊断展示、重试/恢复、投递去重 | 逐生产者定义可替代状态与终态，不把原始业务证据归为副产物 |
| Runtime 启动及维护调度 | 目前启动后自动维护一次，之后主要依赖显式调用 | 变为持久进度、single-flight、可唤醒/恢复的常驻维护循环 |
| 备份/导出/恢复、数据库 generation | 最终文件与权威切换 | 新编码/内联结果/引用索引全部可带走和恢复；物理回收使用受控 generation 边界 |

审计原始证据位于本地 `output/database-storage-audit-20261112-56df40/`。8段生产包核心存储函数与审计源码编译结果一致。没有测定全局孤儿量、跨版本重复块量或可删除GB数。

## 3. 数据分层合同

分层是内部生命周期，不是第二套业务状态或用户入口。

| 层 | 数据 | 保留和转换 | 退出条件 |
|---|---|---|---|
| 权威业务层 | 用户原文、任务/报告/路线图、正式记忆/经验/策略、采用验证、完整历史关系 | 保持原身份、权限、revision与完整读取；长期历史可无损压缩 | 只沿原有明确业务退役/精确授权路径；不会因时间或容量自动删除 |
| 活跃执行层 | 活动运行、恢复所需上下文、准备中的内容、未确认投递、待重试操作、消费者租约 | 活跃持有者 pin；保持恢复/幂等语义；结束后释放执行占用并转为保留历史或可退役细节 | 真实终态、必要确认、重放及消费者依赖全部闭合；不凭超时猜测结束 |
| 保留冷层 | 已结束日志、旧快照、不可变事件与幂等结果 | 同库无损重编码/压缩；技术小回执可内联于所属记录，读取接口保持原结果 | 不再占活跃执行路径；原历史仍可读；解除旧载荷引用后进入统一GC |
| 可再生/短命层 | 被替代投影、已确认副产物、已闭合技术细节、诊断明细 | 每个生产者有明确替代/完成边界；保留必要统计与证据；未知用途默认保留 | 按明确合同退役，不能把“生成的”一概当可删；既有历史不得静默套新删除规则 |
| 共享内容层 | `contents`、分块及编码 | 内容字节与业务保留职责分离；保存 hash/MIME/原始长度与分页完整性 | 无任何有效直接/间接引用、无活跃 pin、无未完成引用索引或准备任务，才可回收 |

队列、投递、计划、能力任务及学习记录均须在上述层中归属。未定义专用退出合同者归权威/保留层，不启用猜测性 TTL。原始日志与必要证据不能因其来源是执行器而变为可删除项。

## 4. 控制增长：保持结果，减少重复存储

1. 保持整文 hash + MIME + 基础编码的去重语义；不得改变原文、把不同媒体解释混成同一对象，或凭语义相似合并内容。
2. 对小型结构化 JSON 也评估压缩收益；只有确实降低体积才使用既有 gzip 表示。旧内容以后台游标渐进转换，身份、hash、MIME、逻辑长度和原字节不变；不可压缩项不能被每轮重新计算。
3. 请求回执的短小结果可保存在请求自身；同一幂等键、输入hash、原始结果和提交序号继续可恢复。大结果保持共享内容引用。读取、导出、恢复和旧库升级统一兼容，不能只改生产者。
4. 小回执从内容池转为所属记录保存后，原内容只释放本条引用；其他历史引用存在时继续保留。内联JSON中的正式内容引用也须登记，项目导出等 `archiveContentId` 不能丢保护。
5. 高频事件/日志的存储优化不得改变用户日志字节、顺序和重放能力。stdout/output共用同一载荷；统计不得把别名引用相加算两份内容。
6. 本次不把跨版本块去重作为已实现收益。块属于完整内容的一部分，不能在内容仍有效时独立丢弃。

## 5. 引用、准备过程与共享内容回收

### 5.1 直接引用与间接引用

- 声明FK继续是直接引用权威，利用既有引用索引，不为全部直接引用复制一套巨型账本。
- 系统实际解释的JSON内容引用统一登记，覆盖对象历史、事件描述、请求结果、复盘输入、运行上下文与内联结果；不能只保护原有四类输入。
- 初次引用索引在后台有持久游标与进度，重启续接，源未就绪时保留相应候选；不能在Writer里解压/扫描全部历史。
- 内容替换、引用删除和准备过程结束统一产生回收候选。活跃引用加入或重新使用内容时撤销相应回收提交权；最后引用解除后可以再次入队。
- 准备中的分块内容有明确持有者，跨事务准备不能被GC误判。自然完成后由业务引用接管；失败/取消与死亡owner恢复均释放持有并重新检查引用。

### 5.2 回收协议

维护按“选取候选 → 引用与活跃持有者分析 → 复核来源/动作版本 → 最小Writer提交”执行。分析、解压和文件I/O不占Writer事务。

- 检查直接根和可达JSON引用，保护完整历史及活动消费者。
- 新增/迟到引用、并发替换、准备恢复或源版本变化必须让旧回收计划失去提交权。
- 相互引用的不可达内容须有闭合处理，不得永远互相保护，也不得为清理一个节点制造可见悬空引用。
- 回收分块与内容记录保持一致；故障可重放，重复执行不重复计数，不形成“清理自身又制造同等内容”的循环。
- 普通候选GC与现有成长快照授权闭包清理共享引用与完整性合同，不能绕过对方的保护。

### 5.3 实施协议（本次采用）

引用权威分为三类：现有业务表指向 `contents` 的 FK 是根；`content_lifecycle_edges(source_id,target_id)` 只保存 JSON 的隐式边；准备 pin 是临时根。边、维护候选、游标均不能成为业务根。边表无指向内容的 FK，主键为 `(source_id,target_id)`，反向索引为 `(target_id,source_id)`，删除内容时一并移除相关边。没有隐式引用的 JSON 不产生边记录。

迁移只创建轻量表、触发器及起始高水位，不扫描正文。初次后台索引按持久游标推进；解析范围保持旧正式引用的递归语义，不能按 MIME 单独漏掉可解析的被引用内容。无效 JSON 不产生可解释引用；未知编码/损坏内容保留，记录可定位异常后推进，不能一个附件阻塞全局索引；缺失目标保留原字节并记录缺口，不伪造或删除历史。初次索引闭合前保守保留候选。

索引实现采用内容主键的有序游标和迁移时上界，避免依赖可能被物理重整改写的 rowid。历史扫描与新增队列交替，处理队列不得越过历史游标；新写入、同身份修复及编码切换均产生递增队列版本。计算结果同时复核持久进度和源队列版本。大 fanout 按最多128条边提交，保存 source、版本、代次与偏移，计算 Worker 丢失后重新计算并从已提交偏移续接；旧代次的保守边在新 summary 完整后分片移除。边代次是整数，不给每条边复制UUID。无效JSON视为无可解释边；正文完整性异常单独保留未解决证据，未知依赖没有证明前不能授权删除。深层合法JSON使用迭代遍历，引用键语义与旧导出/恢复协议一致。

引用队列以 `content_id`为稳定主键，版本使用每次变动独立的128bit随机token，时间与主键排序只负责公平取件。缺席后重建也产生新token，不能复用从1开始的计数当作同源证明。后台提交推进索引revision；无关新正文发布不改变该revision，避免连续日志让历史索引永久重试。generation回放在候选事务内抑制本队列的重复触发，然后精确应用源队列changeset；事务guard不捕获，成功前复原，异常回滚恢复。业务触发器与原changeset冲突规则不放宽。候选不运行索引/GC，独立导入产生的待处理条目必须保留；源cursor/job不能替代候选自己的未完成工作。

队列区分未知、正在私有准备和摘要完整三种状态。私有引用准备在首片边写入前登记持有者与 manifest，替换同源token并取消旧job；后台不能同时重建/修剪该源，旧计算结果也不能提交。多个调用可分别准备同一不可变hash，分别持pin；分片只追加/确认同一正确引用集合，不相互删除。完成时仅CAS自己的manifest/count和内容hash，将队列变为完整摘要状态并移交；后台接管完整摘要只确认，不再解析或修剪正文引用。未到历史游标的完整摘要行保留到对应位置，不能删掉身份后让旧的“无pending”首批重新获得提交权。所有持有者失败后，未完成源恢复为未知待索引，不能永久锁住历史推进。

准备API在入口复制并冻结规则版本、hash、逻辑长度与完整引用集合，flight、manifest、各片及最终复核只消费该快照；跨让行后不再读取调用方可修改的summary。重复flight比较完整引用身份，不能仅以数量相同认定为同一证明。

新内容在引用完整前具有私有发布标记；正式业务FK不能接管它。旧历史尚未索引的正文不会因为被一个新准备调用命中就被误认为私有无依赖：初次索引闭合须覆盖这些保留债务。新GC可以区分完整摘要的交通交接行与真正未知的已发布依赖，不等待所有队列为空，也不让持续正常发布阻止退出。

新正式内容发布前必须具备完整引用 summary。结构化生产者在已有序列化遍历中提取元数据；外部原文和准备文件由 Maintenance Compute 计算。大正文和大 fanout summary 在私有 staging 分片写入，source 全程由每调用 pin 保护，已stage的边可保守保护目标；最终仅核验已提交 manifest/count/ref-ready 后短提交业务引用。不能发布未知引用后用全局队列持续阻塞 GC，也不能将全部边一次塞入 Writer。

结构化生产者的同步提交只覆盖单片以内的引用：在原规范序列化中同时取得最终文本和引用集合，同一事务写正文、最多128条边和ready标记，随即提交领域FK，不重新解析文本。不超过该界限的既有同步调用不增加await或准备owner；大正文仍须在计算域准备，大fanout必须走私有分片后发布。兼容改造期间超出单片的旧入口继续留下未知债务，不能冒充已接入；这些入口全部完成异步准备前不得启用生产严格发布和GC。

生产者接入按最终字节绑定，不把 RPC 输入遍历当成完整覆盖：`normalizeData`、运行输入、日志、文档与产物在异步入口准备外部字节；`captureMigrationSource`的文件调用方在稳定读取后准备；导入必须在解码与ID重映射之后重新计算。结构化正文覆盖 `canonical`和 `JSON.stringify`两种来源。`prepareLearningReview`与旧复盘导入会在方法内读取旧版本、分配新内容ID并生成 `sourceContents`，属于真实的大 fanout：拆为一致来源计划/身份预留、计算与有界私有提交、Writer版本复核发布三个内部阶段，保留原有正式操作入口和结果。全部生产者闭合前不启用生产GC。

运行输入更新保留patch_run_inputs原request hash、inputs事件、receipt、固定control revision、空command及关闭会话的原语义。Readonly Compute先准备新prompt/command的最终字节和完整引用；绑定实际内容ID后，在同一读快照校验保留正文与metadata，准备完整run快照、完整FTS和prompt中的学习交付候选。Source复核run代次/版本、控制metadata及正文身份、turn和lesson资格，仅在最后原同步Pi fence内提交SQL、control revision及学习交付。大metadata的返回状态也按事务捕获的固定内容与control身份在原Compute投影和预序列化，传输复用该结果，不能在Source再次解码/JSON编码。重放仍读取原receipt对应的固定control历史。同run沿既有publication串行键保持先后，小写不能越过已接受的大写。

运行快照还依赖不一定提高run revision的关系写入，例如创建新purpose的运行文档。Source在计算前登记run head及关系监听；计算后返回全部被解释URI的head，包括缺失和当前不符合交付条件的对象，每128项用当前revision与准备值比较后登记TEMP证明。任何对象插入、修改、删除或其关系变化都令证明失效；最终提交只通过token/dirty索引探测，不再逐URI查询。外部连接的data_version、schema变化及正文watch仍共同约束整份计划。退出按每128项清本token；暂时清理失败保留retired token，由后续准备或原Cold量子有界重试，不替换原结果或根错误。TEMP对象随Writer连接退出，不成为永久业务根或新的Actor。

普通运行输入保留总量64KiB的同步快路，计入请求、SQL控制状态、当前正文与metadata、关系及新正文的实际编码工作；关系和解释引用各不超过128。可能命中学习交付的提示词进入计算域，重放也走固定结果投影，不能只按本次新prompt长度判定快路。最终选中的大量学习交付仍有原子业务写入成本；不能用缺失URI已经分片证明任意数量的正式交付已满足前台预算。

当前独立Runtime入口已接publishRunInputs、既有Maintenance Compute和返回预序列化。TEMP证明的schema安装使用短SAVEPOINT原子完成，建表、索引或触发器失败全部回滚，保留原存储错误；不能让部分安装迫使同Writer的合法重试永久失败。退出失败由Cold量子抛原I/O错误进入既有5秒异常重试，不把不可推进的证明清理误记成可立即执行的pending工作。

局部证据中，v7运行输入17项和共享消费者合计128项通过。v8真实Runtime样本保存11,214,322B提示词、340,000B元数据及301条内容引用；从准备owner已建立到请求回包之前，6次独立读、6次小写完成，最大分别12.84ms、34.56ms，全部公开返回值重放相同且正文/事件/请求计数不增。JSON属性顺序不是原回执值合同。该样本观察RSS峰1,518,526,464B，含共享Worker与测试父进程的验证工作；WAL峰4,919,312B。它没有识别每次重叠时所处的物理写片阶段，也没有证明正式存量/真实Host/Browser预算。证据在`output/database-lifecycle-implementation-20261113-56df40/remaining-entry-completion-20261114/run-input-publication-v8-runtime-values.log`；后续冻结候选仍须复验。准备与结果投影会同时持有正文/metadata、编码后的JSON及结构化克隆副本；这些同时占用及TEMP表/触发器持续成本不能记为零拷贝或零开销。

prepare_agent_launch也通过patch_run_inputs生成最终输入，且原runAtomicCommand覆盖其多步写入；它是独立的真实复合调用链，不能因直接入口通过而漏记。该复合链须先把所有参与者的正文、派生状态与最终输入准备完，再进入原原子提交；不能在已开的Writer事务里await异步准备，也不能靠拆掉原原子性或保留大正文同步特例宣称退出旧路径。

运行准备以真实业务身份构造typed plan：Source只在内存生成新对象UUID和时间，Compute在新的只读快照中选定parent turn、任务sequence、固定policy以及已有journal位置，派生完整子对象、原请求hash、正文、metadata、备份和launch_request。launch_request保持原生JSON序列化字节；不能用canonical JSON替换其原合同。子对象与运行的完整FTS及每个固定版本快照也在Compute准备，所有正文仍沿既有owner/pin/summary/分块协议暂存。Source在一次原同步事务中重核实际位置、parent turn、任务sequence、policy与journal头、学习版本及正文资格，再按原事件顺序提交；失效则事务外重新准备。业务日志、task turn和绑定序号不能通过提前写正式setting预留。最终大结果在Compute按已提交固定版本投影与序列化。同key准备保持原到达顺序，其他项目的小写可在准备等待期间推进。

这项接入按完整调用族验收：独立prepare_run先接入并不代表intent、slot、Flow或prepare_agent_launch已经退出。后者还须覆盖binding、状态中间版本、固定policy全文、最终prompt、Flow所有loop历史及恢复分支；整请求的旧独占Writer gate也只能在最终同步提交段保留，不能跨Compute等待。必须用最后ready写失败、Flow attach失败、非法备份等实际故障验证全图回滚，并用暂停真实Compute的反例验证独立Writer确实能提交。

当前本地候选已接独立prepare_run、intent/slot及独立Flow角色入口；Agent启动与运行结算内的嵌套路径仍待接入。分配型准备在新的只读selection中确定原候选和每项目journal地址；已有候选按原固定控制状态重放，新的journal事件仍在原单事务中先于运行事件提交。日志正文及既有key的source evidence重算留在Compute。Source复用既有conversation_revision在发表前复核日志变化，并复核原分配setting的完整正文身份与控制头；没有counter时仅允许同时不存在任何journal的初始状态，不把缺行当稳定的0。该counter也会因同项目其他日志/关联变化而失效，保守重试成本仍须进入正式持续压力预算。

Flow接入须同时迁移独立write_flow_trace及prepare_flow_role内部的两次写入。计划显式包含header、conversation/task、实际变化的workflow_loop及flow_loop evidence、每版loop版本数组、所有中间固定快照/FTS和最终完整结果。header的原text/plain MIME与各正文的原canonical字节分别保留。角色准备按原单事务依次发表可选initial Flow、journal、完整运行、角色映射、attach Flow；尚未进入数据库的运行身份以typed role引用传给Compute，不能靠试写回滚来发现引用。Source只核验Flow当前版本、实际loop/role/attempt与已观察运行头，所有保留历史读取、loop hash与整图派生留在Compute；并发失效后事务外重做。conversation tracking对Flow的状态投影也须消费准备好的真实版本，不能在最后通知时又从Source读回整份历史。

组合准备沿同一私有owner和证明句柄持有正文，独立Flow发表复用该句柄。后继准备显式接收前驱真实SQL列投影及已准备的正文身份；事件当时的固定快照与前驱结束后新增的关系分别保存，不能把后加关系倒写进旧版本。新对象在原数据库中的证明仍是“不存在”，不能拿虚拟revision1代替真实head。已有同key子回执复用时，后继看到它真实的当前对象，而不是本次未实际执行的create结果。业务序号仍在最终Native事务分配，未进入正文的数据不编造预留地址。计算域不执行业务事务、不拦截RPC模拟整条调用。所有前驱/后继证明在首次Native写入前统一核验，进入事务后只依既定顺序同步发表；通知派生marker在同一事务中按实际当前值推进，不把文件系统可见性假定成前驱必然已完成的效果。

完整运行根请求已经提交也不等于复合角色请求已经完成。相同根意图重放仍须补齐原角色映射及附着，采用已提交回执的真实run身份和原startedAt；通知进度继续读取真实当前运行，不用历史回执覆盖当前delivery状态。准备期间完整根请求抢先提交时，只在原根input_hash完全相同的条件下退出旧的子对象计划、重选完整重放，不能放宽任务子请求的不同意图冲突。

Agent启动中的状态与身份准备必须覆盖每次中间版本：读取原metadata与binding、验证原不可修改字段和关闭会话语义、计算新metadata/binding/providerContext及证据正文、保存原run版本快照和原请求hash。Source在计算前保护原metadata/binding及run关系头，之后沿同一owner暂存；最终提交复核generation、原控制头及conversation下binding序号，再同步写证据、绑定索引、control与run历史。独立状态/绑定入口与完整Agent启动共用这些准备步骤；独立入口接入后仍不能在旧runAtomicCommand内部await，复合调用须继续迁移为完整预备图，保留所有中间版本和最后ready写的原子回滚。

状态与身份写原本不更新run的FTS，准备也不能顺带读取或校验它们不消费的prompt/command。run版本快照直接从真实SQL列、当前关联及本次列变更计算，正文ID保持原样；不能因无关旧prompt损坏阻断合法状态与身份恢复。小型控制更新继续保留总量64KiB、最多128个正文引用与关联的同步快路，预算覆盖原metadata、实际需要的binding、本次输入和结果/快照编码；不能只按patch大小判断。相同run与输入更新共用到达顺序，已存在的幂等请求走固定历史投影。

相同身份确认的重放须保留原物理WAL不变合同，不能为了只读结果新建持有者或pin。计算域返回固定回执、固定结果JSON及实际消费的少量正文身份；Source登记临时watch后，再由现有计算域验证真实字节与这些身份相符，覆盖首次解码至watch建立之间的窗口。最终同步段重核原generation/control、请求回执头、数据库身份和全部watch，再直接返回固定结果。已提交业务FK承担这些正文的保留责任，不为重放新增持久保留根；历史状态只验证实际读取的版本快照及metadata，身份重放只验证实际binding，不扩大到无关prompt/command。二次正文核验的实际读取成本也计入完整资源模型。

Agent的绑定、身份状态和ready准备使用显式前驱投影：control保存已暂存正文ID，run/turn/policy保存事件当时的真实SQL对象，原Native基线独立保留。绑定表的conversation序号不进入正文，因此仍在最终Native逐次分配；不能把两个前置准备都算出的同一MAX+1当作已预留地址。最终ready准备须接收真实turn与前驱run版本，所有句柄在首次业务写入前统一检查，再按原顺序提交。新运行尚未出现时，任何准备步骤都不得靠试写、回滚或模拟一串RPC发现对象。最后ready失败必须回滚运行、所有身份中间版本、日志与文档。

恢复启动还须覆盖claim/release交付权。计算域按原顺序验证generation、预期版本、Flow运行状态、stopRequested、交付状态和原owner，准备完整快照及需要更新的metadata；claim不重新发表未变metadata。Source保护真正读取的Flow头与正文，最后同步段重核实际Flow映射、control以及进程/owner存活性，保留原delivery与delivery_release事件。已经提交的交付请求按同一无持久写重放处理，不因后来的Flow暂停或无关正文损坏重跑原变更条件。begin_run_delivery等仍在内部调用旧同步方法的复合入口也必须继续迁移，不能用独立claim/release接入代替整族退出。

完整Agent启动的意图、初始metadata、身份seed、命令、固定policy全文、上下文和最终prompt共用原纯构造规则，在既有Compute中构成typed selection与分阶段准备。launch_request保留原生JSON字节与真实分配executionLogId；恢复时先核原保存文档的运行、工作目录和node身份，沿原uiLaunchActionHash/launchIntentHash语义选择已有请求。准备返回实际依赖的正文身份和原Native头；Source需在最后采用前重新验证这些字节与控制条件。上述计算阶段不意味着实际prepare_agent_launch已退出：只有最终结果投影、fresh/resume完整图、逐run先后顺序、原子失败和原Writer独占gate退出一起验证后才能记为完成。

启动选择和运行创建各自负责刷新其准备证明。外层启动选择的证明失效时，本次创建不提交，回到启动选择重新读取并准备同一意图。内层创建仅重试自己的计划。首次运行初始化临时验证表后，如果外层证明失效，同样由外层重新读取，避免使用已经失效的证明反复准备。

真实反例要求完整保留SQLite列亲和性，包括journal先落TEXT列再构造source正文的行为；metadata中的原始值不跟着改写。准备期间同key子对象抢先提交时，必须采用赢家的真实身份并重做依赖图。学习采纳条件须在已登记资格后的新只读快照中重新求值，不能沿用更早blueprint里尚未覆盖的approved状态。学习复核运行的draft检查只读control与review_batches状态列，不因读取对象投影而解码保留的大manifest。当前定向回归与真实Runtime序列化样本只证明这些局部功能，不替代完整调用族、正式留存规模、Host/Browser、资源峰值和发布门禁。

物理迁移消费者只读取当前设备的活动位置头，先按绑定项目或目标路径收窄，再由原有realpath、文件hash和目录锚核验实际文件；不得为了生成候选位置表而先同步探测所有无关项目目录。该位置表不授予缺失目录的恢复权限。分析缓存默认恢复继续使用单独的数据库保护证明与最后路径核验：Compute证明只包括数据库保护，不能把计算时短暂存在的目录误当成保护证据；普通缺失根的批准恢复及未受保护测试根的排除保持原合同。

通用对象写入按实体定义解释正文列，不能用RPC参数递归预走或试执行事务猜最终内容。Source先保护旧正文及显式内容列引用；Maintenance Compute对本次实际正文做原有文本、规范JSON或二进制编码，并计算原始请求的幂等hash。每个最终正文沿既有owner、分块和完整summary协议交接，业务提交仍在原短事务中进行。准备后重核当前对象revision、scope、权限与Pi调用身份；原请求hash不能变成删去正文后的输入或暂存ID的hash。已经提交的同key请求只验证原意图并重放原回执，不再次编码正文或制造新历史。

有界同步调用继续成立：输入、保留正文及最终单片引用均在既有小片预算内时，允许原短事务直接发布完整summary。通用写入以总量64KiB和最多128个解释引用约束该路径，不按每字段分别累加无界额度；先有限步确认结构和字节预算，再处理小对象及小二进制，无法在界限内确认的旧正文及大引用集合走计算域。空正文的0字节是合法资格，不能按假值拒绝。小型前台写入不应被正在执行的大文件计算挡住，也不以更早失败替代结果。同对象及相同创建key沿已有按键tail保持到达顺序，快速路径也不能越过已准入的大正文；其他对象继续独立提交。

准备范围包含合法大TEXT、JSON标量列及引用数组，不能只移走正文别名。字段校验与规范编码复用同一纯规则；SQLite默认值与列亲和性按实际引擎合同投影，不能让数字文本、REAL／NUMERIC、NULL或省略字段改变历史快照。预留对象身份和时间不写业务行；准备后的SQL字段、固定关联、完整版本快照、完整FTS候选及报告版本派生均按同一个最终对象准备，不通过业务事务试执行再回滚发现内容。Source在原短事务复核对象版本、关联约束及准备资格后，只提交实际SQL、已准备快照和派生结果。

大正文和大元数据的搜索候选、版本快照及报告解析在计算域完成，Writer不为改标题或保留正文重新解码整篇。查询仍对当前授权对象的完整规范数据执行原substring复核；字符串转义、二进制、旧正文、host review隐藏字段和报告summary／unmet／commits／files都须回归。最终取证使用既有专用只读连接的新snapshot，绑定每个正文、本次watch、数据库实例和连接资格；同一无await提交段复核全部资格。完整快照沿原owner和内容发布协议交接，不能最后又在Writer把普通大字段编码一遍，也不能把只读元数据对象交给仍期待全文的报告消费者。

固定历史关联的发现不授予发布权，也不在第一次await前逐项读库和加pin：仍存在的object_revisions正文已有真实FK根。计算域先发现完整版本清单，Source再按每片最多128项，在原短事务核对版本根、active正文身份并登记本owner的pin和精确watch，片间让出Writer；已有watch跨片保留。最后完整取证必须发生在watch登记之后的新只读snapshot，最终仍复核版本根没有消失或变换。失效、取消与迟到返回仅退出本调用的pin/watch，不追认sealed身份。资格查找按(objectId,revision)建本次计划的索引，避免逐引用反复线性搜索造成平方增长。分页登记只解决准备阶段的单片占用，全部watch的峰值和最终原子关联写入仍需独立资源验收。

Pi写入的准备阶段不持有SQLite事务；准备后再进入原同步调用fence，在同一原子提交中重新做权限和取消检查。准备失败、失权、取消及版本冲突只撤销本次发布权，私有字节和pin按既有生命周期退出。没有新增Writer、Worker、队列表或用户入口。实测基线为324,018B正文通过实际Runtime write入口124.41ms；该样本同时确认原文、固定历史、搜索和重放，不能代替正式Host预算。新路径须补同一消费者、无变化重试及真实后台大文件期间小写入的资源对照。

自动化事件复用同一对象发布链，以内部生产者标识保留原append_automation_event请求hash和evidence.automation事件合同；该标识不进入公开RPC字段或数据库对象。事件始终按原规范JSON编码，带encoding/data属性也不能误当二进制正文。小片沿原同步方法，较大事件在计算域生成正文、完整摘要、FTS和固定快照后发布；observed_at与本次对象创建时间一致。replayed在实际提交前核对，两个同key并发提交仍只有后者为重放，不因异步准备改变外部自动化去重行为。

附带既有Pi调用身份的自动化事件，在登记项目和准备之前固定本次fence；大准备、小片及回执重放都在最终原同步fence事务内重新核验后执行。外层async guard的前后检查不能替代这个提交边界：准备期间失权时，不得先提交事件再向调用方报取消。

同一提交约束覆盖日志、文档、产物及产物附带的迁移来源登记：准备仍在原owner和Compute链路，业务接管字节的无await段才进入原同步Pi fence。每个原本独立提交的业务步骤都复核同一调用身份；后一步准备期间失权，只拒绝尚未授权提交的后一步，不回滚此前已经合法提交的数据。无Pi身份的既有迁移、恢复和内部调用沿原默认提交，不能把准备所有权与Pi执行权混成一套新队列或状态。

项目导入的重计算和大事务属于原私有Generation Worker，不能按Store类名误算为前台Source占用，也不能因此豁免发布完整性。候选权限须由已核验的candidate目录及数据库文件身份绑定到本次Worker；deferRecordOrder等业务布尔值不能授予Source超出同步预算的能力。私有候选可在自己的事务中合作让行，但不能把该事务或重编码带回Source Writer。

复用健康baseline正文时，候选先核验实际字节并补齐完整目标边，在同一私有事务里供新正式记录接管；不能删除Source已接受的引用job、改其offset或覆盖既有边的generation。既有未发布标记及GC候选token在正式记录接管后恢复原状态，由Source原生Session继续推进。多出的完整边只保守保留引用，原job完成时按原generation规则收敛；继承的debt继续阻止过早GC。这避免每一尾帧重新遍历全部导入正文，也不更改原生冲突规则。损坏baseline正文的修复与健康复用分开验证，不能用健康分支的证据替代修复尾流。

损坏canonical的有效active布局先逐段与归档正确字节核对，再在原物理ordinal及原codec内恢复，支持非零wrapper和显式absolute ordinal。候选不能替Source supersede原修复journal或清除其shadow；原pending版本、故障记录和GC候选均须保留，GC候选在会触发root变更的故障记录恢复后再恢复。验证必须覆盖Source真实修复重试与连续Native尾流，并确认最终全部物理ordinal与active manifest一致、原journal退出。缺失active行或损坏manifest属于独立恢复边界；有效布局的验证不能代替该边界。

该独立边界不能沿旧putContent删除Source物理行：Source删除后重写同键同字节的shadow在Native Session里可能净值不变，候选一旦提前删掉就无法由尾流补回。候选在原codec内另建完整active区间，位置越过Source现有及下一次完整修复的预留区；所有原物理行保持，候选新增ordinal用私有TEMP收据跟踪，Source真正写入时晋升为Source责任。每帧只处理触及的这些ID，在Native事务内、FK证明前至多退出64个已离开active的私有块。

Worker关闭前必须把剩余责任交给既有repair journal。若Source原journal仍在，保留其token、phase及进度，在候选的source_encoding内记录受保护active区间，并将pointer绑定当前表示；该私有责任标记只由已核验候选写入。原repair消费路径据此按64块清理全部active范围外块，再退休journal；不能按Source原building范围误删候选active。后续原生帧到来时只重绑触及ID的区间和pointer，正文仍按Source正式发布结果或候选原完整证明读取，不逐帧重算全部正文。Source修复失败或中断也必须留下可读的导入历史和持久清理责任。

候选新增正文不能提前占用Source未来的普通(sha256,mime,encoding)唯一槽。新增内容沿已有repair编码表示使用私有namespace，gzip/chunked物理前缀、字节、hash、MIME及业务ID不变；baseline复用和修复保持其既有表示。通常使用短保留token i，仅当同一物理唯一槽确已占用或被另一内容ID预留时，细分为本候选与内容ID绑定的128位token并复核实际槽，不给每条正文长期附加完整UUID和SHA。预留按最终hash/MIME/物理codec进行，覆盖合法旧包的多个repair token，不得等INSERT碰撞才猜测映射。Source同字节新canonical尾流可以原样进入，无需忽略约束或末帧重写所有导入引用。常规去重先保持精确codec优先，再沿sha/MIME索引按实际base编码查找活repair表示；下一代导入及后续写入复用已有表示，不随导入次数不断增殖。冷转换也按实际base选择未压缩小JSON，保留namespace再加gzip前缀，不能永久跳过或换回Source普通唯一槽。

冷队列资格必须覆盖Source后续对已越过历史游标的alias异步修复；仅依赖generation最终重置游标不能闭合这条入口。新增83迁移重建cold insert/update触发器，使正常及repair表示的实际未压缩UTF8小JSON共用资格，保留Native replay抑制；不修改已应用的82迁移。历史遗漏只重置既有content游标和代次，由原Readonly/Writer有界量子补扫，不在迁移事务里遍历正文或建立全表队列。

候选导入先稳定所有受控元数据的最终身份映射，再按该映射生成最终字节；不能命中一个旧canonical就永久跳过后续子引用的变化。原始正文保持原字节；损坏canonical在承诺映射前用归档正确字节恢复原ID，不能只相信sha表头。最终导入的contents/chunks全部就位后，只验证本次实际涉及的最终ID，建立完整引用、交接ready，再插入正式业务根。循环、缺失标识、零引用、大fanout及重映射均须保持原语义。候选事务失败应回滚本次字节修复、引用与正式记录，不能留下下一次接管不完整数据的捷径。

候选发布不能清空baseline其他pending/job/owner或改写Source writer incarnation；同ID已有债务和后续Session尾流须复核其版本与退出责任。finish及retarget另生成的短回执沿原同步小片发布，不因portable正文已索引而漏掉。Source同步128边上限保持，候选执行权限不进入RPC或portable格式，正式切换、验证、文件发布与失败清理继续使用原generation链路。

原始字节准备复用Maintenance Compute：在那里完成传输解码、hash、编码和完整引用summary，Actor在第一片字节让行前登记目标union，再以每调用owner保护字节和分片引用，最终提交领域FK。日志的旧完整输入hash仍按原规范计算，文档保留原内容hash型幂等合同；迁移候选的native JSON版本对账也在计算域完成，BOM、空白和原始字节本身不改写。同一日志流、文档用途、产物路径或迁移源键仅在自身键上保持提交顺序，各键之间继续并发；最终提交重新核对运行代次、文档版本和领域约束。headless原生测试显式注入同一真实计算Worker并负责关闭，产品路径不增加Writer计算fallback。

异步准备的去重命中仍须校验完整原字节，但不在Writer解压/读整文/hash。先在原准备owner下pin目标，随后用既有Maintenance Compute的一条专用可复用只读连接验证；每次请求必须在watch发出后建立全新读事务，不继承导出或其他计算保留的旧snapshot。校验绑定本次随机token、数据库/Writer实例及目标id/hash/MIME/基础编码/原长度。准备与采纳点均不得位于未提交主库事务；正式调用者在最终业务事务前准备，不通过提前提交事务或Writer整文fallback绕开。

Source仅为正在取证的目标建立本连接TEMP watch，不为历史池逐项预填，不持久化到业务库、不进入Session或portable。六个TEMP触发器按被watch的content id记录contents及chunks的插入、更新、删除，dirty单调；即使header/hash不变的块改写也会失效。再以本Source连接的PRAGMA data_version复核连接外提交；本连接的无关日志不会使它递增，不能用全局total_changes制造持续重试。TEMP对象只一次初始化；schema资格变化使旧证据失效，取消/晚回包按id+token精确退出，连接关闭后无采纳权且不能由旧finally覆盖新watch或首个错误。private candidate如使用该设施，须在接受增量FK baseline前初始化，不能在tail期间改变其TEMP schema。

Worker返回后在同一无await提交段复核token、仍active的精确身份、数据/Schema资格与调用存活，只采纳刚验证的同一ID；变化则重新取证。仅资格未变的正文完整性错误可走原shadow repair，EIO、取消、Worker退出不能伪装为正文损坏。repair的开始、恢复后及superseded三处校验均遵循同一异步资格。迟到canonical同样适用：分片完成后才出现的canonical不能在最终promote短事务中未经证明直接返回，最后也不能切换为另一个未经验证的ID。原私有staging继续由原owner/引用退出协议收口，不新增旁路字节池。

该TEMP watch增加每正文/块写入的索引探测及每活跃取证的临时行，专用只读连接增加缓存占用，必须以真实前后写入对照、并发取消、重编码、外连接改写、旧snapshot、未提交事务、迟到坏canonical及最终退出测试验收；不能因为无持久表就宣称零成本或通过正式容量门禁。

直接 FK 仍为根，边和维护表均不是业务根。只对正在分析的候选/祖先建立 target watch：同一 target 最多一个活动 group/watch，根 FK、边、pin 变化只增加对应 watch 版本并将该 group.dirty 单调置1。闭包发现新祖先时先分片建立 watch 再重新读取，直至整个反向祖先闭包都受监视；无关日志或根变更不使计划失效。失效必须换 proof 代次，禁止清零旧 dirty 覆盖已经发生的变化。

大闭包成员及证明分片持久准备，准备时逐片验证源版本；最终只 CAS group(closure-complete、dirty=0、Writer incarnation匹配) 单行成为 sealed，整组原子逻辑退役，不在最后扫描全体成员。sealed 后按128个 chunks/edges/成员为量子物理回收；中断沿 group 日志继续。移除出边时，将未退役目标重新入候选。所有合法跨 await 使用者在第一次让行前必须持 pin；seal 之前的迟到引用使证明失效，seal 之后已退役身份不再可被发布为正式引用。

每个证明从一个候选种子展开反向祖先闭包，每片最多128条边。任一祖先有根即可证明该种子仍可达，只移除这个种子的原token；其他候选继续独立处理，避免一条受保护分支吞掉无关孤儿的退出机会。中断或dirty失效只取消证明并有界释放watch，不清除未获证明的候选；新Writer取消旧incarnation未封口证明，已sealed组继续回收。原生schema核验全部声明FK根均有leading索引；v78的81类根加上v79修复责任根，复用这些索引做存在性判断，不新增全量根账本。generation捕获期间暂停GC，避免消费者仍需的基线被退出。

严格发布接齐后，持续准备不以全局队列清空为前提。只可暂时排除本Writer仍活动、源hash/长度已核验、完整不可变summary已登记目标预留的精确source/hash/owner，并复核其持久manifest、私有标记及incarnation；不是按unpublished标记直接放行。当前Actor维护每owner目标union和活动watch，首次让行前登记：命中旧watch单次置dirty；新成员登记及每次展开时检查预留，命中则为该owner幂等pin实际成员并取消证明。pin成员保活其后代，避免为每个后代种子另建pin。watch覆盖已展开成员直至取消清理或封口，登记与提交同Actor无await。多个summary/重试不提前移除共享预留；owner真正finally时移除，持久pin沿既有恢复释放。完整预留经短事务交接为精确临时exemption，Readonly与Writer均读取随源键变动维护的债务状态；封口复核当前恢复屏障与债务存在性。对于P→S→U，只有S完整summary仍受上述预留保护时可排除S，否则继续保守等待索引；owner结束即恢复这项检查，迟到计算没有旧的豁免权。历史上界未闭合及未获该证明的未知依赖继续保守保留，生产者未接齐前不启用此严格分支。

白名单不在seal时全量JOIN扫描。其临时exemption按source/hash/逻辑长度/owner/incarnation持久交接；`gc_debt(content_id)`仅保存仍未知且没有有效预留的源。pending/job/fault、源身份、manifest、私有标记与exemption每次变动只按该source主键刷新派生债务；封口只做债务存在性和历史范围索引检查。owner finally单行置reservations_live=0；若仍有exemption，同一事务设置恢复屏障并增加gc revision，先撤销封口权，再由Readonly取片/Writer每128删除旧incarnation或已结束owner的exemption。最后空片CAS恢复代次后清屏障。持久撤销失败时Actor保留本地阻断并限量重试，不能先释放预留再继续seal。watch只在SQL提交成功后移除。派生debt不进入Session，其确定性源键刷新在回放中照常执行，以保留候选自己的未知来源；owner/incarnation的一对多变化始终处于恢复屏障内，不能在前台做全来源重建。新增临时表与触发器成本、回放末态和屏障交错必须另行实测。

失败准备立即撤销本owner/source的manifest，让后台可在同一长owner仍活动时补完引用；不删除其他owner的manifest。同一来源的exemption先交给仍健康、完整登记token匹配且身份复核通过的调用，避免一个调用失败拖住另一调用。旧撤销若持久失败，同owner/source重试先在无await段完成并吸收旧撤销，再创建新manifest，旧维护任务不获得删除新代次的权利。owner终结按统一工作预算分片清pin、exemption、manifest、身份映射和owner本身；全部子表及阶段空才删除owner，禁止靠FK批量级联退出。

完整引用证明绑定不可变hash和逻辑长度。已知同hash再准备保留完整状态；小JSON无损冷转换经原表示CAS后，将新队列token同事务交接为ready，不因编码切换重新产生未知引用债务。尚未闭合的历史、job、fault、私有标记或未知队列不能使用此快路。

半写字节按明确来源退出：只有取得唯一写权、已进入严格发布的Actor，为本调用新分配且尚无入边的随机身份初始化staging记录时，才登记私有字节证明；不能扫描旧staging编码后追认。正式FK和typed读取不能接管未完成字节；原文中的缺失、退役或未完成ID仍可作为悬空索引标识保存，不赋予载荷存在性，也不复活identity。真正需要载荷的领域入口必须在跨await前验证并持pin；回放仅跳过中间态的正式接管拒绝，按源变更精确恢复证明。生产者先初始化并保护所有新身份及完整目标预留，再写字节，字节全部完成后才发布引用和业务结果。正常提升为完整表示撤销该证明；失败后最后pin解除，可独立于无关已发布损坏源的债务回收这份已证明从未发布的字节，不解析或冒充其完整性。私有证明的删除使正在分析的watch失效；封口复核证明、staging表示和真实根。签发之后的原文入边不把从未完成的字节变成已发布载荷，回收保留来自live source的悬空边；若以后提供原字节恢复同ID，该边重新参与保护。未获来源证明的旧损坏/未知内容继续保留。

已被引用的损坏身份不能当成新私有字节退出。提供相同hash/MIME的完整原字节后必须恢复原ID。v79修复日志保存Writer代次、随机任务token、旧表示及替换分块范围；旧正文、索引和分块在替换全部持久完成之前保持原样。替换分块使用当前最大ordinal之后的新范围，不改写既有分块表；chunk索引包裹firstOrdinal与Worker生成的原始逻辑分块数组，旧数组仍按数组位置读取；旧显式物理ordinal优先，不能叠加偏移。Writer不重新解析/展开整个索引，每16块的同一事务以token/offset CAS累计块数和存储字节，提升仅核单行计数。完整范围的数量、长度及任务身份核验后，一次事务切换正文索引，再按最多64条清理旧分块。切换前中断只退出新暂存范围，保留所有旧字节；切换后无需调用方重传即可继续清理。再次修复必须先按旧token有界闭合上一代清理责任，不能覆盖旧日志丢失退出责任。修复日志自身是正式FK根，未结束前不得GC原ID。按实际内容ID串行修复与共享字节flight，不能因调用方是否提供preferred ID而分裂。编码变体中的token与内容ID无绑定，导入映射ID后仍能恢复同一身份；旧同步修复必须原子标记异步任务已被替代。分页、完整性校验及portable导入导出全部读取当前索引指向的ordinal；未生效或待退出分块不得进入导出。不能以返回另一份载荷冒充原历史身份已经恢复。

新收集器取得清理权后，旧桥接hold按128条退出，必要内容仍由真实业务根、隐式边和准备pin保护；新pin释放及历史回执转换不再新增桥接hold。启用后物理删除只接受sealed证明，旧清理入口须先全部接入同一协议，不能依赖继续制造hold抵挡旧删除器。

portable导出遵循相同边界：直接FK及快照中的正式payload字段继续严格校验；启发式发现的不可用目标只保留父正文中的原ID，不把退役或半写字节打包成可恢复载荷。导出和导入后父正文逐字节不变，合法原文不因其中的失效handle失败。purge对入边按主键游标每128条检查，只移除不存在或已退役来源的边；Writer删除时再次核验来源仍不可用，Reader快照后恢复的来源不能被旧计划删边。不反复全扫live入边，也不破坏将来的同ID恢复。

所有读取（group状态、metadata、data/chunks）必须在同一可嵌套 SQLite 读快照；已有快照沿用，不重开 BEGIN。历史 Reader 继续读自己的 WAL 快照。去重、冷转换、准备、分页、归档与恢复统一检查 sealed，不能只改 GC 查询。带完整原字节的去重命中 sealed 行时，可惰性更名其旧 encoding 释放唯一槽（chunked 保持前缀），再产生新的有效 identity，不原位复活旧内容。

准备 pin 使用本 Writer incarnation 和每次调用随机 token，相同原文分别持有；已有内容去重命中也须在第一次跨 await 前 pin。使用持久 preparation-key→active-identity 映射恢复重试；原 deterministic ID 若 sealed，CAS 映射到新身份，两个 prepared 路径均只写 active identity。映射本身不保活内容；pin 在业务接管或异常 finally 释放。只有正式取得唯一写权的新 Writer 才恢复旧 incarnation，无 TTL 猜测；只读/候选连接不得释放活动 pin。

日志回执新增 `requests.result_inline_json`，仅 `run.log_appended` 四字段短回执内联，最多512 UTF-8字节且无内容引用；其他回执仍在内容池，`archiveContentId` 等继续受 JSON 边保护。后台核对请求FK、事件kind、描述、旧内容身份与四字段形状，保留原结果（导入后的事件序号可以不同于结果内的源序号）。历史扫描之外，用持久 receipt-pending 发现旧档导入及序号回退后的结果；contents 同样用 cold-pending 处理 rowid 复用。内联/外置表示受数据库互斥约束，通用读取兼容；sourceSchemaVersion<75 的旧档只补新增 nullable 列，其他缺列仍拒绝。维护表不进入项目档案，导入后重建索引。

冷热转换仅处理 JSON/utf8 非分块、256B–64KiB 载荷，gzip level1，至少节省10%和32B，保留 id/hash/逻辑长度。压缩和解析在 Maintenance Compute，Writer复核原表示后提交；编码唯一槽冲突保留原身份。不可压缩项不反复计算；无工作不更新游标/历史。新写入小JSON由持久队列后台转换，不额外给前台加入压缩工作。

活动准备持有 pin 时，冷转换保留当前物理表示，待准备发布或退出后再压缩。后台选取时避开已被 pin 的候选，历史游标越过该项时把它接入既有冷队列。Writer 在同次提交复核 pin，已选候选若在此期间被 pin，继续保留在冷队列。只剩活动准备持有的候选时，等待既有后台唤醒，避免反复压缩、撤销同一次发布资格及持续生成准备内容。

早期 v75 的历史回执释放曾由 `content_lifecycle_release_holds` 真实 FK 暂时保留。当前旧清理入口已经只转交统一 GC，不再新增桥接 hold，也不能直接删除正文；GC 未启用时仍保留原字节和持久候选，正式退出必须经过统一引用证明。历史 hold 的接管与最终资源、引用及发布验收仍按前述完整合同核验，不能把早期桥接保护当成当前实现或闭环结果。

### 5.4 每类生产者的退出合同

| 所有者 | 活跃退出证据 | 退出后保留 | 释放/恢复责任 |
|---|---|---|---|
| 日志追加请求 | 已提交事件与同请求四字段结果一致 | 原 key、hash、提交序号和完整重放结果，日志全部原字节 | 回执内联后解除原结果 FK；GC 复核所有历史引用 |
| 对象/设置/运行历史 | 新 revision 已提交 | 全部旧 revision、事件和内容 | 旧内容只转冷；有效历史引用不释放 |
| 当前检查点/被替代投影 | 新版本提交且旧消费者已结束 | 必需恢复记录、正式历史 | 原替换入口释放旧 FK，经触发器重入候选；未定义替代证据者保留 |
| 准备内容/导出 | 持久业务引用已接管，或调用失败且 owner 已结束 | 已提交导出回执、完整归档、已确认文件 | 每调用 pin finally；旧 owner 由唯一 Writer 重启恢复 |
| 副产物/迁移夹具 | 现有分类确认非用户输出、无产物链接 | 正式报告、用户产物、历史捕获事件 | 沿原分类删除记录；事件内引用继续保护历史源 |
| outbox/计划/投递/能力任务 | 原有完成/确认/终态规则 | 原幂等和恢复证据，正式结果 | 保留现有终态记录；载荷可转冷，不新增通用 TTL |
| 诊断/学习/记忆 | 原领域所有者明确处理完成 | 全部当前历史与证据 | 本轮不删除诊断行或学习记录；内容池 JSON 可无损冷转换 |

常驻维护每次仅执行一个有界量子，完成后重新进入既有 maintenance lane；有工作继续推进，无工作退避轮询，变化由持久游标/队列发现。没有工作不写事件、回执或维护历史；shutdown 取消下一次调度，正在提交的量子正常结束，重启沿游标恢复。显式维护复用同一量子，不另建全库 Writer 扫描。

## 6. 维护执行拓扑与资源矩阵

继续使用既有统一准入、Maintenance单lane、Maintenance Compute Worker与唯一Writer，不增加服务或模型调用。已有前台席位、Reader隔离和本地首屏时限是预算边界。

| 操作 | 性质/资源 | 执行域与一致性边界 | 恢复/让行 |
|---|---|---|---|
| 前台读/写 | 小型、用户优先 | 既有前台Reader / Writer短事务 | 不等待后台索引、压缩或物理整理 |
| 引用索引与冷转换 | 历史读、解压/解析/压缩，CPU与I/O | Maintenance Compute读取，分片结果经Writer复核提交 | 持久游标；每片重新准入；旧格式持续可读 |
| 生产者退役 | 原子状态与引用变更 | 按所有者合同在Writer短事务提交 | 幂等、确认/重放/pin保护；迟到结果不能复活过期动作 |
| 内容GC | 索引读与少量删除 | 后台分析，Writer条件提交 | 队列去重；候选/引用变化后重算；关闭可恢复 |
| 容量统计 | 已提交计数/小投影 | 前台只读投影；精确重算在后台 | 不把全库SUM/dbstat放到普通设置/点击前置 |
| 物理整理 | 大文件I/O、备份与切换 | 既有generation机制与独立维护域 | 不在活动Writer上VACUUM；清单、空间预估、恢复及孤儿回收闭合 |

资源基线：已测20.892GB页分配、8.560GB载荷、约1021万内容；根卷2026-11-13初始只读观测可用15.637GB。此前全库页统计耗时约18分钟、内容聚合约5分钟，不能把这种操作加入循环前台读取。历史引用索引可能产生额外行/索引，必须用真实SQLite测量其累计与峰值；不假定节省大于开销。

隔离原生 SQLite 实测（各 10,000 条、每条独立持久事务）：原回执 831.90B/条，小 gzip 833.54B/条且载荷无变化，内联 447.69B/条；分别耗时 29.66s/28.27s/25.86s，峰值 WAL 均约 4.2MB。按审计的 82,743 条/日推算，仅回执表示约少增长 31.8MB/日，不含日志与事件，也不是已释放量。隐式边双向索引实测 176.95B/边；100万边约177MB，真实边数以后台累计为准，不能按全部 FK 复制。证据为 `output/database-lifecycle-implementation-20261113-56df40/*cost-results.json`。回执迁移、JSON重写和新增边都会产生 WAL；量子最多128条/4MiB原载荷，单个大容器独立进入维护计算域，逐量子提交与让行；累计工作仅处理一次历史，后续依赖队列。以已登记负载频率和真实引擎测试决定批次/表示。维护没有工作时不新增历史/回执；重复未变化维护必须趋于零增量。无法从压缩/回收释放的必要历史继续纳入容量预测，空间不足只形成明确可恢复维护状态，不停止合法用户任务或破坏历史。

v77实际分片索引样本：100份来源各100条引用，边及反向索引共1,785,856B，即178.59B/边（含整数代次）。沿实际只读 Maintenance Worker计算、Writer提交共168量子、1.204s，Writer提交max28.47ms/p9512.11ms，WAL峰4,569,112B，含Worker的隔离进程RSS峰126,738,432B，25次空跑0SQL变化。证据为同目录 `reference-index-cost-results-v77.json`；这只验证索引基础和样本成本，不能替代正式规模预算、生产者发布、GC或物理缩库验收。

v78隔离退出实测经过真实owned发布、索引、owner释放和只读Worker分析/Writer提交：100来源各引用100个真实目标，200份hold；保留一份memory及其完整历史。812量子/4.047s回收201份内容、444,121B载荷，hold/owner/pin/候选/组/watch均归零；保留3份内容和1条必要历史引用。Writer max25.76ms/p957.83ms，进程RSS峰189.03MB，WAL峰4.705MB，25次空跑0SQL变化。文件仍5,808,128B，仅601页可复用，未缩文件。证据 `content-gc-cost-results-v78.json`；这是小样本基础能力，未覆盖正式并发SLO、大正文和生产接线，不作全库节省承诺。

债务交接版8调用样本：200来源各301引用、2400个分离真实目标，按来源让行并与真实Readonly Worker回收重叠；114.898s内2602份/2,755,979B载荷退出，临时保护/债务/候选最终全部0，保留3份内容和1条历史边。14,266次Writer事务max56.54ms/p958.95ms，RSS峰497.76MB、WAL峰6.349MB，pin峰2600、exemption峰24、临时债务/exemption分配24,576B，25空跑0SQL变化。证据 `content-gc-eight-owner-cost-results-v78.json`。这是私有字节补齐前的局部资源样本，尚不覆盖正式数据库和前台延迟；不能据此替代16GiB/真实Host与Browser门禁。

发布交接版重新实测：128bit token、ready及FIFO队列10,000项占1,953,792B（195.38B/待处理项），比计数版本约多34.82B/项；不为历史1021万内容逐项预填该队列。更新后的10,000边样本179.81B/边，167量子1.163s，Writer max23.55ms/p9511.82ms，25空跑仍0写。实际准备API对100份正文各100个真实目标完成pin、摘要交接、finally与有界owner恢复，共500事务4.84s、单事务max42.37ms，pin峰101，最后owner/pin/manifest均0；200份release hold仍等待新GC接管，不能当成已回收。证据为 `reference-queue-cost-results-v77-token-ready.json`、`reference-index-cost-results-v77-token-ready.json`、`reference-publication-cost-results-v77.json`。正式业务生产者、全池GC和物理缩库仍须分别验收。

原始产物生产者样本：8个真实artifact并发调用，各带301条引用，共2400个实际目标、11,292,568B原文，经Maintenance Worker准备后逐字节读取一致。发布937.61ms，随后索引、owner退出及解除artifact根后的GC合计49.655s；相对初始计数退出2408份内容、8,545,547B载荷，临时owner/pin/debt/hold/候选/证明全部归零，25次空跑0SQL变化。12,160次Writer事务max42.82ms/p954.34ms，RSS峰327,319,552B，WAL峰4,466,112B。文件由13,791,232B变为13,856,768B，可复用页10,309,632B。本次构造和首次索引不计入计时，GC在发布之后；先退出无根迁移种子，再保存基线与计数差，避免将既有种子混为本轮收益。证据 `raw-producer-publication-v3-cost-results.json` 带源码hash，fixture精确回收见对应cleanup；该样本早于Pi单遍发布与修复索引包裹补丁，不代表最终冻结性能或正式Host/Browser门禁。

旧内容清理入口只转交候选：无论统一GC是否启用，既有候选按内容主键每片最多128条搬入同一GC队列，新解除引用直接入该队列；不再扫描全部历史正文或由旧finalize直接删除chunks/contents，也不再新增供旧清理器使用的release hold。GC关闭时保留正文与持久退出责任，不回退到旧删除分支。转交不计作deletedContents或reclaimedStoredBytes，实际退出计量只来自本轮新GC实际提交的删除，不能以全局计数差吸收别的维护操作收益。生产尚未启用；旧成长授权闭包清理和失效项目登记退休仍需继续收口，不能据此声称旧路径全部退役。

统一后台量子入口按reference、cold（含准备/修复恢复）、GC轮转，每次调用只推进一个阶段；每片都回到既有maintenance统一准入，不在同一RPC内跑完整历史。各阶段分别保存pending和runnable状态并single-flight：有效来源分片或可重算CAS仍立即重新准入；只有活动私有manifest、无sourceId等暂时不能推进的债务仍保持pending，但所有阶段均不可执行时按原100ms短轮询，不能零延迟空转。真正空闲后30秒再查，异常5秒重试。历史引用阶段当前单来源分片，若每片固定等待100ms，仅1021万历史项就至少约11.8天；增加阶段轮转会进一步延长，因此不能保留该人为等待。独立真实Worker复现过暂停301引用发布首片时三阶段均applied=false却pending=true的空转，须以runnable区分并保留暂停后的正常接续回归。仍须测正式吞吐、峰值和前台SLO；移除有效历史分片的等待不等于绕过准入或取得额外资源预算。GC仍仅在明确启用后运行，生产者接齐与正式门禁未过时不自动启用。

成长快照的v2授权清单在实际生成路径中始终将contents.deletableIds、contentChunks及旧内容候选删除范围设为空；现有行为已是只移除明确批准的业务记录。移除残留的空范围正文删除语句，显式拒绝非空正文删除范围；解除根由现有FK触发器交到统一GC。保留的固定历史引用继续保护正文，授权回执仍只报告真实删除的业务行，不把后续GC计为本次直接删除。

既有审计的最大正文为517,963,776B（SQLite二进制快照），通用binary最大478,933,156B；不能按2MiB修复用例假设正文峰值。字节引用摘要先只检查JSON允许的前导空白和对象/数组起始字节：其余根类型不可能携带被解释的引用键，直接保持空引用摘要并照常计算完整SHA/长度，避免为SQLite、普通原文或JSON原始值生成整份UTF-8字符串。对象/数组仍完整按既有JSON语义处理；这仅消除无意义转换，不代表大正文解压、hash、有效JSON解析及最大发布/修复峰值已过门禁。

迁移源的可退出元数据不能同时充当唯一捕获序号。实际旧路径删除未关联副产物的migration_items后，再次发现同一路径会重用旧回执；只恢复当前actor的最大值仍会在actor交替时失败。v80独立保留每来源的最小序号状态：删除源行时在同一事务保留高水位；当前行与高水位取最大值，普通有效捕获不重复扫描历史。新建或旧未解析高水位仅一次从所有actor的同来源回执恢复：actors外层、requests使用既有actor/幂等键索引前缀范围，只接受已提交且匹配真实migration.source_captured空subject事件的回执，防止其他普通mutation的相似key抬高序号。SQLite按字符计算前缀长度，含中文/emoji仍正确。该初始化成本为actor数加该来源历史记录数，并非恒定；原审计actors表仅102,400B，最终仍须测真实恢复峰值。序号状态无正文FK，不承担业务保留责任；Session捕获它，回放时抑制派生删除触发器，避免双写。项目portable不导入该本地全局控制状态，完整备份/恢复保持它。原回执和正文不删除，也不重用旧幂等键。

持久化的resolved标记不能独自证明当前合并视图已核验：portable导入可能带入更高的真实捕获历史，随后live Session又覆盖同来源当前行和高水位。每个Writer仅在当前视图内缓存已核验高水位（LRU最多1024来源），缓存下界不得高于当前持久高水位；不满足时重新按上述索引范围恢复。重新打开、导入开始与结束、每次成功Session应用均使本地核验失效；这不修改Session冲突规则，也不引入新的业务状态。事务回滚若撤销了较高的持久高水位，下次不得信任缓存中的更高下界。热来源无需反复查历史，缓存淘汰只增加一次核验，不得影响捕获序号与回执。

旧portable包的闭包会携带migration_items当前捕获回执，却未必携带空subject捕获事件；重新扫描events不能恢复这部分序号。成功激活导入行的同一事务，将实际导入来源的捕获序号合并到本库的最小导入高水位，每来源最多一行、无正文FK。它只记录该库已经接受过的序号下界，普通相似幂等键不能写入；正式捕获取当前行、捕获高水位与导入下界的最大值。此表随完整备份保留，但与回放guard一样不参加源Session捕获，避免源端较低状态抹掉候选已接受的导入事实。不依赖进程缓存保留该事实，重启和连续Session回放后仍成立。导入失败必须与业务行一起回滚；不得伪造旧包缺失的事件或改写原回执。

周期性副产物退出必须保留运行索引明确指定的输出，即便它位于通常视为副产物的嵌套路径。v81在同库维护最小的运行输出路径投影：实际索引生产者直接从已有record对象写入；旧索引由Maintenance Compute按稳定业务主键与迁移时上界分片解析。索引变更使旧投影失效并产生独立随机token的待处理项，后台提交只接受相同token；历史扫描还核对当前原始元数据，不能覆盖更新后的投影。错误元数据保留并记录，不授权退出。

统一维护增加副产物阶段，每片先推进输出投影或退出最多128条领域元数据，再让出准入；有索引却尚无有效投影的产物及其对应迁移源暂不退出，其他已判定来源继续推进。明确输出、直接运行文件、正式关联来源和完整历史保持；只有既有策略已认定可再生成的副产物解除领域根，正文交同一GC，不在本阶段删除内容。索引投影无正文FK，不能成为内容保留根；幂等重试和源重新出现仍遵循v80序号。启用前保留旧手动兼容入口，生产严格发布与全部生产者未闭合时不自动启用退出。

v81局部实测：1000条既有运行索引经真实迁移、Maintenance Worker与四阶段维护，200份指定输出逐字节保留，另外200份副产物的元数据与载荷退出；13.589s、5599量子、4226次Writer事务，事务max21.38ms/p953.30ms，RSS峰233,312,256B、WAL峰4,210,672B。输出投影86,016B（86.016B/索引），空pending与progress各4096B；总计1000条元数据解析传输3,155,164B。25个空闲量子0数据变化。相同API的独立1000次写入对照：关闭新增缓存与触发器3.144s、启用3.005s；单次采样差异不能解释为性能提升，只证明未观察到本样本回归。内容402→202份、存储载荷249,888→124,701B，可复用页200,704B；数据库文件8,564,736→8,720,384B，未缩库。证据`byproduct-cost-results.json`含源码hash，`byproduct-cost-cleanup.json`确认全部自建夹具精确回收。该样本不替代正式Host/Browser、57项目真实库或最终冻结资源门禁。

正文复用校验局部实测：同一Source对既有分块执行6000次相同字节更新，TEMP监听初始化前78.61ms，初始化且空监听106.02ms，一个无关监听97.96ms，一个目标监听首改置脏后92.86ms；这是单轮热更新样本，显示固定探测开销，不能外推为完整日志生产吞吐或零成本。20,971,537B正文的原Writer整文校验四次分别70.03/66.60/83.20/61.75ms；沿既有Maintenance Worker、先打开通用Reader再打开专用验证Reader、带完整owner/pin/watch退出的四次异步复用分别116.93/76.60/75.30/77.31ms。该段Writer八次短事务max3.99ms，Source事件循环推进251次，最大采样间隔15.62ms；复用仍返回原ID且逐字节一致，watch/pin/owner最终均0。打开验证连接前共享进程RSS313,339,904B，观察峰320,942,080B，WAL峰25,057,872B；RSS混有共享缓存和暂存分配，不能将差额全部归因于连接。证据`content-verification-cost-results.json`记录源码hash，实验由owned runner回收。该测量不覆盖正式数据库、持续并发、真实Host/Browser、总存量或最终预算门禁。

## 7. 物理空间与生产授权

逻辑退役、共享内容删除、可复用页和文件实际缩小分别记账。不得把候选字节、GC载荷计数、归档状态或估算当成磁盘已回收。

在线 `compact:true` 已退役，不能恢复活动Writer上的阻塞VACUUM。compact generation 复用受控切换，journal purpose=compact，不发布项目文件。正确性边界如下：先真正排空所有已准入和跨await仍可提交的Writer操作，在独占短fence内让专用只读连接BEGIN并实际读页钉住snapshot；ACK带调用token/数据库身份/incarnation。随后纯Session attach全部权威表后立即放行，FULL checkpoint不得成为该fence前置。

专用连接对已钉snapshot native backup到baseline，结束读事务，再从baseline VACUUM INTO最终candidate；这需要 baseline＋candidate 两份额外空间，不再承诺一份。持续捕获、追平、短封口尾批、校验和proof落盘后沿既有重启恢复切换，Reader重新绑定。Worker/snapshot/capture丢失或incarnation变化使未封口候选立即失去资格，从新snapshot重新开始，迟到ACK不得复活；切换后的旧库只按精确generation manifest回收。不得放宽changeset冲突策略掩盖不精确快照。

候选压缩只写自有排他暂存文件，验证原身份、迁移版本、固定序号和完整性后以不覆盖链接发布。当前绑定的原生SQLite会保留有主键索引表的rowid；必须在实际baseline/candidate按objects.id核验对应rowid一致后才信任contentless FTS，不能以“通常不变”跳过核验。冷转换的contents/requests物理游标及未完成overview基线在全部尾批应用后重置，稳定主键引用/副产物游标沿用。compact journal与导入journal共用同一恢复状态路径，purpose明确区分；compact不创建虚构项目、不发布项目文件，各切换中断点均须可恢复且最终精确回收本代目录。

快照基础约定：先BEGIN并读取真实数据库身份、迁移版本、schema cookie与事件序号，才签发包含调用token、独立快照nonce、Writer incarnation和源文件device/inode的ACK。复制仅接受该绑定，目标必须不存在；原生backup成功后在释放读事务之前验证目标身份、迁移版本和固定事件序号，再同步文件及目录。撤销或替换快照后，即使复用调用token，旧ACK也不能创建新目标或取得候选资格。Node v22.21.1原生实验已验证：读事务钉住后，另一个Writer连接在逐页backup进度回调中持续提交，目标仍只包含钉住时的版本。依据[Node该版本实现](https://github.com/nodejs/node/blob/v22.21.1/src/node_sqlite.cc)与[SQLite备份接口合同](https://www.sqlite.org/c3ref/backup_finish.html)，测试必须继续使用同一已钉住的原生连接，不能在备份开始时重新打开来源。该基础实验不等于初始短fence、Session接续或compact切换已实现。

纯Session接续先向当前快照持有者复核nonce仍有效，再复核fence开始与ACK之后的同连接total_changes、跨连接data_version和schema cookie，以及身份/incarnation/固定事件序号和源inode；事件序号本身不能发现投影、维护或其他无事件写入。旧ACK不能消耗较新的fence，事务尚未结束时不得签发fence或attach。任一变化使此次钉住结果失去接续资格，应重新取得精确快照。该复核不能替代真正排空已准入事务；它用于发现短fence期间遗漏的回调写入。Session分表attach失败必须关闭已创建的全部Session，不能留下部分捕获。

目标“不存在”的预检不提供文件所有权。备份写入同父目录下原子创建的私有暂存目录，排他创建文件并持有目录与文件描述符；校验及同步只针对自有inode。每次复制均重新同步同一文件系统内的目标目录祖先链，直至根目录或文件系统边界，不能只依赖mkdir是否本次新建：先前创建成功但同步失败的目录，在重试或Worker重启后仍须补齐持久化，调用方预先创建的generation目录也在同一责任内。完成后用不可覆盖的硬链接发布目标，晚出现的已有文件按原字节保留；父目录身份变化使此次发布失效。取消或失败只精确回收本次自有暂存，不能删除或覆盖竞态中出现的其他文件。Linux/macOS沿已持有的目录描述符锚定路径，减少目录替换窗口。

实际接线使用独立snapshot Worker，在进入初始fence前完成启动与目录准备；它不复用可能正在解析大正文的Maintenance Compute。客户端在新pin发出时立即撤销旧lease，仅接受本次请求的ACK并维护当前nonce，Worker退出后立即失去资格。代次任务先释放自身普通请求的共享lease，不能在复制、外部计算或持久化期间一直持有它而挡住前台独占动作。初始fence单独申请独占，等待其他已准入跨await操作结束；签发fence、pin、资格复核和pure attach之后立即放行。失败的pin尝试也先放行再重新准入。后续每次Session rotate/stop及Source序号读取各自申请短共享段，避免从其他前台异步事务中截取未提交变化；大文件IO不占有该段。等待者取得gate后还须重查最终cutover状态，不能在旧authority封口后补写。

同一专用Worker承接快照复制与捕获文件的写入、同步；50ms捕获定时器不能在Actor执行大文件write/fsync。每代最多一个捕获持久化flight，忙时不再堆积完整字节帧；已落盘项只回传路径、序号和必要索引对象ID。持久化失败或Worker丢失立即使未封口代次失效并停止捕获，前台继续使用原authority。最大帧、Native Session积累、长读WAL及IO竞争仍须通过正式容量与前台延迟门禁，不能将移到Worker等同于资源问题已解决。

代次退出是整个任务的生命周期，不止专用快照Worker的生命周期。有序关闭先拒绝计算等待者并停止计算Worker，允许代次在关闭中的短Writer清理段停止Native Session，再等待代次的失败处理与自有目录回收结束，最后关闭数据库；不能持有独占gate等待还要申请gate的清理任务。持久化失败在下一可取得的Writer段立即取消Session，直接关闭全部Native Session而不生成已经不会应用的尾帧，不等待长候选build返回；候选build在现有让行点接收取消，数据库关闭后再回收。文件清单扫描和精确回收在独立Worker完成，并复核最初创建的generation目录device/inode；替换目录不属于本次授权。共享Maintenance Compute只取消该代次，不能为单代失败中断其他前台准备。

峰值必须计入baseline、candidate、捕获文件、长读快照阻止checkpoint时的WAL及运行余量。2026-11-14本地检查约13GiB可用，不能执行审计约21GB真实库的正式复制或compact验收。涉及正式数据规模的磁盘验收在推送后通过真实冒烟执行，记录启动、处理、退出时的实际文件大小、可用空间及临时对象清理结果。发布前的功能回归仍按正式入口验证事务与数据一致性。

代次执行仍经原RuntimeDataOperations鉴权与Pi invocation guard，只有通过原合同的host操作才能进入专用实现；读取已完成回执也不能绕鉴权。内部compact调用必须先生成并持有同一个idempotencyKey，重启重试原key才能取得已提交回执；服务端不得为缺key的每次重试另造UUID。当前没有用户界面直接调用compact，不能把内部key合同转嫁为用户选择。代次在既有单maintenance准入席位内拥有一个私有计算Worker，复用原计算实现并绑定初始目录身份；长VACUUM与整库校验不占供前台准备使用的共享Compute，也不新增后台准入容量。该Worker与snapshot Worker一同加入代次生命周期，取消后先等实际退出再清理文件。

新代次创建前只读检查所在文件系统可用空间：baseline按page_count分配全量计算，compact candidate按已用页计算，另预留max(一次全库写入量,当前WAL)供长读快照期间WAL增长，以及max(512MiB,baseline与candidate合计10%)运行余量。这是初始容量下界，不能承诺覆盖任意无限写入；正式验收仍须观察峰值，不能用该估算替代75GB隔离空间条件。当前开发环境无法腾出该空间，遗留入口本地验证及复核结束后先推送，再由实际部署环境执行真实冒烟。冒烟记录与正式隔离压力、峰值空间及长期稳定性测量分别报告。回执重放无需创建代次或通过容量检查。生产正式容量条件未满足时不启动复制、压缩或启用自动GC。

既有业务数据的破坏性退役必须有精确预览、身份/版本、保留合同及授权。临时实验数据库不进入生产登记；本轮临时对象逐项清理，正式验收证据留在项目输出路径。

代次完整性证明在同一私有candidate连接上延续：先完成全库integrity/FK验证，复核该连接total_changes、跨连接data_version及schema cookie没有变化，再安装仅TEMP作用域的增量FK记录。每次Native changeset事务按实际子键变更和父键删除/更改收集受影响的子记录；父键变化也覆盖未出现在changeset中的既有导入引用。全部分表changeset应用后、COMMIT之前，按子记录主键与父唯一键检查这些关系，失败回滚整个帧。复合键、NULL、父列affinity与collation必须遵循SQLite实际FK语义，不能用宽松JSON比较代替。成功级联删除和循环引用以整帧最终状态核验；不放宽原changeset冲突策略。

Worker只持有本代连接，不在帧之间关闭重开并丢失证明。schema变化、连接/Worker丢失或候选身份改变使证明失效，不能仅凭旧标志跳过全验证。最终封口只应用已捕获尾批和验证尚未闭合的关系、同步并取得文件proof；禁止在停止原authority后重新扫描全库。未取得此证明的通用旧apply调用继续全FK检查。该机制仍须用实际完整schema、延迟到达引用和正式体量验证，不能以空表测试宣布短封口完成。

增量记录覆盖实际身份值而非UPDATE语法：普通rowid与INTEGER PRIMARY KEY别名、WITHOUT ROWID复合主键、生成列的依赖更新都以任意UPDATE后实际OLD/NEW键变化判断；比较同时检查存储类型并使用BINARY，不能因子列自身NOCASE或1与1.0数值相等漏掉父语义变化。TEMP记录的主库反查显式指定main，TEMP schema cookie也属于证明；下一帧先验证尚未闭合的dirty keys再清空。尾批验证在全部查询结束后再次复核主库/临时schema与外部data_version，不能只在开始时检查。

父变化反查对已证明父子同affinity的关系，增加保留父列collation的可索引比较，并继续使用严格父语义作为残余校验；不同affinity仍按准确语义处理，不得用可能漏引用的索引预筛。最终关系查询强制从dirty keys出发，再按子主键查主库，不能因统计选择反过来扫描整张子表。正式schema中的实际查询计划与所有不满足索引条件的关系仍须审计、计量，不把有索引等同于用了索引。

持续合法写入不能阻止最终完成。后台最多四轮追平后进入既有最终fence，不以等待一次空捕获作为唯一退出条件；随后排空已准入动作、停止Source捕获并应用全部尾批，保留所有已确认提交。候选最终关闭和落盘完成后才回ACK，再取得proof并启动重启握手，不能在关闭中的WAL checkpoint之前签发完成回包。

运行临时输入的预留直接复用runs已经发布的prompt内容身份、sha256和长度，不在Writer解码整份执行计划再编码/hash同一正文。后续物化、冲突验证和部分文件恢复仍按原始完整字节与该固定身份核验；临时文件不能为存储复用牺牲用户输入完整性。

正式schema的全部452条父反查中，初版仍有100条扫描；按真实增长授权清理的14类可删除父表筛选，其中12条缺少可用前导索引，集中在objects、object_revisions和requests。私有candidate在完整baseline校验前，仅补applications.target_object_id、grants.target_id、mcp_conversation_launches.flow_object_id、migration_items.object_id、relations.target_id；legacy_learning_review_cursor_inputs(cursor_id,cursor_revision)、lesson_decision_candidates(lesson_id,lesson_revision)、lesson_event_refs(event_id,event_revision)、policy_uses(lesson_id,lesson_revision)、policy_uses(policy_id,policy_revision)；以及migration_items.source_capture_request_id和migration_source_json_versions.request_id。已有等价未过滤前导键时沿用，不重复建索引；不在Source首次升级时扫描历史建索引，也不为无实际变更路径的稳定父字段盲加全部索引。索引带来的实际空间与写入成本必须进入正式candidate峰值/净收益计量；这不是内容释放收益。未来新增实际父删除/键改写路径时须同步扩展此计划检查。

历史交接的边界必须脱离物理rowid。原生Session回放会重排新行，完整业务schema已复现固定step-memory revision数量仍为50却读出不同条目；FK校验不能证明这种历史语义。v82只为step_handoffs增可空handoff_sequence，不在升级时回填/扫描历史。旧行NULL继续按原rowid解释，既有snapshot中的handoffCursor原值保留；新交接由唯一producer在同一事务取得最小持久高水位并分配逻辑序号，随Native变化传输。初始化/保存边界取现有控制高水位与MAX(rowid)的上界，不能在Writer扫MAX(COALESCE(...))。读取按逻辑序号（旧行回退rowid）过滤和排序，候选VACUUM还须核查既有step_handoffs的rowid保持，不能只检查objects搜索绑定。

新portable导出显式填入旧NULL行的原rowid为handoff_sequence。旧档不以数组rank猜序号：正式handoff每次生成的step-memory revision给出原handoff_cursor，其不可变snapshot.latestHandoffRef对应run_documents的run_id及settlement_加去横线turnId和checkpoint的purpose，足以恢复原边界（包括跨项目的rowid间隙）。只补准备行的派生列，不改源档/hash或原snapshot正文。candidate在后台构建阶段计算逻辑序号上界，全部tail后以常量控制记录重base；冷转换物理游标与导入后的overview计数也在同一封口步骤重新初始化，不能让Source派生计数覆盖独立导入的行。新序号、旧库升级、旧档恢复、固定历史、后续新增及中断恢复均须真实回归。

同一审计还确认Pi准入队列会因新行重排改变同会话前驱与恢复头，不能把它归为普通分页。admission_sequence同样由最小高水位在原准入事务分配，旧NULL行沿用基线rowid，新行Native回放保持逻辑顺序。成长快照的“最新”、保留两份、语义连续段和清理授权也必须使用稳定顺序；物理FTS删除仍以稳定对象ID查当前实际rowid，禁止把清理计划中的业务边界与物理索引地址混用。run digest最新选择、outbox投影先后及旧迁移任务排序逐项按业务顺序或可重建进度归类，不能统一视为瞬态游标。

成长快照以snapshot_sequence保存原创建边界，所有真实生产者在原事务内分配；历史NULL按objects原rowid解释。明细的节点、边、信号与标签分页依赖原数组顺序，不能在切库中改成主键排序；新增detail_ordinal保存生产者已有的数组/暂存页顺序，旧NULL保留原rowid解释。现有清理清单的objectRowid与搜索rowids字段保留冻结合同，其数值继续指向原创建边界；验证与续跑比较稳定快照身份和原边界，真正删除FTS时才按对象ID解析当前物理地址。不得修改已批准清单正文/hash来适应物理重排。候选后台序号上界、旧NULL行VACUUM保持与portable兼容必须覆盖这些新增字段。

运行摘要以digest_sequence保持原插入顺序、分页边界与每运行最新选择；迁移任务job_sequence与原重试attempt共用已有持久高水位，新增任务与重试均不依赖时钟或物理行号。outbox生产者在对应event事务内创建，恢复和最新投影使用已有events.sequence；不另存第二份队列序号。文档manifest的既有updated_at主排序保持，同毫秒的先后改由已有权威event sequence裁决。旧portable成长清单中的原创建边界作为精确锚；未被清单冻结的相对顺序由不可变creation events恢复，缺失或相互冲突拒绝导入，不能猜测时间顺序。旧NULL行仍须经过候选压缩的主键/物理rowid逐表核验。上述控制高水位在候选后台预先求上界、封口常量max-rebase，Source较低控制值不能覆盖已导入记录的上界。

派生触发器必须与Session记录闭合：Source已捕获的投影行、计数、待处理队列和失效标记由其changeset恢复，candidate在本代回放事务的既有replication guard期间不得再次执行相同派生。已真实复现project_run_indexes尾批使run_count从源1变成候选2；不能用完成后全库重建掩盖重复。仅为写入被捕获派生表的触发器增加guard条件，保留原有WHEN和全部主体逻辑；普通Source写入不变。未捕获的GC债务仍须由候选真实行变化推导，不能一起禁用；业务scope/RAISE约束、SQLite CHECK和TEMP增量FK证明继续有效。封口复核guard复原、Source投影逐值相同及独立导入贡献完整；overview的全局导入合并仍经已有后台重建，不把全量扫描移回最终fence。

外部数字分页同样是跨代次合同：run_control的普通/恢复/交付列表、run_consumer_sources待消费列表、run_settlements历史、run_effects任务、flow_control及临时输入列表，均由调用方跨RPC拼接，不能以Actor会重启为由豁免。各表以可空逻辑序号保存既有插入顺序和不透明cursor，旧NULL回退原rowid；正式producer在原事务分配，后台导入floor与compact旧NULL核验使用同一清单。历史报告回退头保存原对象创建顺序；MCP launch最近查询和失败保留20条使用同一稳定launch序号。FTS仍使用真实物理地址，missing工作片扫描仍可物理排序，不增加用户需要理解的概念。

跨库导入还必须处理顺序域碰撞：已实证两个库各4个运行，正常导入后8行但limit=1只能列4行。全局分页涉及run_control、run_consumer_sources、run_effects及run_input_materializations，仅提高将来分配的高水位不足以处理现有重复。四类导入行在后台按已有顺序分配本次导入内的紧凑序号，绑定仅本地的导入顺序范围；范围以常量offset保存，读取仍返回同一不透明数字cursor。当前Source行与未来普通写入沿用全局高水位，不改固定历史正文或用户接口。直接导入在发布行的同一事务确定最终范围；在线generation在全部尾批后只为当前导入项目重定4个范围到Source当前高水位之后，再提高各计数器。不能在最终fence逐行重写整份导入数据。范围身份与进度持久化且跟随候选恢复，仅作本地控制状态，不作为项目portable数据输出；重试保持来源身份。按项目/节点解释的handoff固定边界保持原数值，不能为合并全局排序修改不可变snapshot。旧档业务历史的相对顺序须由正式创建事件、版本与settlement文档证据恢复，缺失/冲突明确拒绝，不能用归档数组顺序或created_at猜测；无原入队证据的技术effect队列遵循下述既有归档兼容合同。

范围按(project_id,table_name)唯一槽保存，稳定ID不包含archiveHash，另绑定原staging的archive hash与request；失败/换来源须沿既有staging生命周期核验后CAS复用未公开槽，不能不断留下不同hash的范围或复用已公开区间。空族不建范围。后台完整校验每个非空族的rank唯一且在1至maximum，全部active offset+maximum受global counter/floor保护；不在Writer全表验证。第二次generation和compact保持旧active offset不变。最终按当前项目、表、manifest/request及pending条件CAS，必须完整覆盖本次导入的非空族，offset/counter与pending→active在同一短事务提交；所有值及其和须为安全整数。四族所有普通/恢复/交付/待消费/临时输入查询使用effective sequence。portable强制namespace列为NULL；每项目/表一个active范围、后续普通序号高于其end，保证再次导出raw序号仍保项目内相对顺序。控制状态只随其正式历史保留，不增加正文保留根；失败阶段仍属于原导入任务的持久进度，需恢复或有界退出。

旧effect队列有一项不可推断的信息：settlement payload没有保存input.effects数组，每条effect也无原ordinal/创建事件；input_hash不能还原原输入，completed_at、kind、UUID和执行状态均不能证明原入队顺序。现有正式旧档导入本就按归档run_effects行数组逐条插入；对此技术队列保留这一兼容合同，将未带effect_sequence的完整旧数组一次赋予稳定rank，后续切代/再导出保持它。不能声称恢复了源库原rowid，也不能按当前extension的kind偏好猜历史。ID、状态、token、错误、完成时间、载荷和settlement FK全部保留，不重造任务。已有显式序号保持原序；混合不完整表示须报冲突。其他有正式创建/版本/文档证据的业务历史仍按证据恢复，不采用该技术队列例外。

报告版本的ordinal是库内AUTOINCREMENT索引地址，不是报告身份或时间：所有正式引用使用(object_id,revision)，报告/观察分页及最新选择按events.sequence。含运行报告的真实跨库导入已复现ordinal碰撞。导入时在原发表事务为这些本地地址分配目标库尚未使用的负整数区间；普通运行继续自动分配正数，Source尾批不与私有导入地址冲突。原报告ID、版本、正文/hash、事件顺序与所有复合FK保持，不移动Source已有索引地址，也不在最后fence重编号整批报告。新负区间取当前MIN并逐条分配，支持再次导入；不把此本地地址变成新的用户概念。

运行输入临时文件沿同一维护计算域处理。Writer只预留已有prompt身份/hash/长度、复核小型文件证明和提交状态，不再为物化或恢复重读完整执行计划/正文。计算Worker在独立只读一致视图逐块校验、写入和比对，分块索引只解析一次，不能每64KiB重新扫描整份索引。文件只能是当前数据根已登记的精确临时路径；物化重试、恢复和释放按同一运行/代次串行。半写文件须先验证为原prompt的真实前缀，以既有准备pin、引用摘要和短事务协议保留完整观察字节，再复核device/inode、长度、变更时间与hash后清理；外来、替换、软链或内容冲突文件保留并明确报错。计算失败/中断留下登记与文件供恢复，不提前标记已写入/释放，不增加旁路清理队列。

portable携带的活动临时文件登记不能继承源库物理路径或written确认。已实证正常导入后仍指向Source数据根。导入在原发表事务把活动登记重绑为目标最终authority数据根下的新随机路径并重置written；保留原prompt身份/hash/长度、运行与代次和正式临时文件证据。generation绑定的是切换后的最终数据根，不能绑定将被清理的私有candidate目录。原源文件不属于本次导入，后续恢复不会操作它；目标可从完整prompt重新物化或按已有死进程恢复退出未物化登记。

完整备份恢复到另一数据根同样不继承源文件责任。备份及恢复文件保持原字节与身份，真正使用运行输入或有界恢复时才在Writer按单条登记重绑本地活动路径，清除源written/退出证明；异根released回执只清本地物理责任，不访问源文件。该处理不扫描全历史、不改变正式prompt或临时文件历史证据，也不在只读恢复检查时修改备份。

独立原生反例另确认：旧合法大inline正文的半写片段也须切为64KiB；不能只覆盖chunked。退出前在原临时登记持久保存精确文件证明，并沿该登记的确定私有退出子目录领入文件。父目录与退出目录使用FD锚定；领入后再次核对身份与字节，不直接unlink公开原路径。被替换的文件保留或无覆盖恢复，未知冲突不授权删除。领入前/后、删除后及空退出目录回收均同步目录，Writer只在持久退出ACK后置released并清除证明。中断恢复沿同一登记发现原文件、已领入文件或空目录续接；不能丢下随机hold文件或新建旁路退出队列。

目录持久化须按平台真实能力解释，不能把未执行的同步当作成功，也不能因此阻断运行输入的主功能。支持目录同步的平台在确认后清除退出证明。无法取得目录同步的平台由Worker明确返回该结果，逻辑释放后仍在原历史登记保留小型物理退出凭证；它不占活跃pin，不成为新正文根或新任务。新Writer在既有恢复循环中以启动时固定业务主键上界、每次最多128条元数据核对一次；只有released且带本地凭证者才访问文件，旧released及portable导入记录不扫。扫描完毕后空闲不再反复访问历史，每5秒恢复不能变成全历史文件扫描。回执只复核原path/确定退出目录与原inode/hash，不重新物化或再发布partial；缺口/冲突保留凭证并报错。物化重试无论新建或EEXIST均须完成实际支持的文件及父目录链同步，初次EIO不能被下一轮的命中去重绕过。Windows最终仍须真实平台验收，平台分支模拟不能替代。

一次性启动扫描不等于跳过实际失败的退出。released文件遇到EIO、计算Worker丢失等暂时失败，在原凭证内标记retry并保存仅覆盖失败键的复核范围，原恢复循环每次仍最多128条元数据，只对retry标记访问文件；成功后移除该标记，范围完成即空闲，不重扫全部成功历史。范围控制只占常量内存，不复制历史身份到内存队列；重启仍从持久凭证恢复。明确文件身份/内容冲突保留凭证并报错，不能以重试名义删除替换文件。

标记本身落盘失败也不能先丢失责任：批次携带已读取的业务主键，在任何标记SQL前先登记失败键范围。若写retry或重新读取失败，该范围按保留凭证复核，不依赖尚未落地的retry位；恢复成功后仍回到空闲。该异常范围可能额外复核其中其他凭证，仍受128元数据量子限制，不扩大到整份成功历史。

## 8. 兼容与旧路径退出

- 升级只建轻量schema和进度，重工作在启动后的维护域，历史库升级不扫描全部正文。
- 旧 `utf8/binary/gzip/chunked` 读取、固定revision、分页/hash、备份/项目导入导出全部保留。
- 内联回执和新引用索引不能破坏旧请求重试、旧项目归档导入或恢复后重放；缺失的新字段按明确旧格式处理。
- 新回收达到可用后退出旧的全历史Writer扫描；不保留共享串行fallback。
- 新维护循环接管一次性启动清理，保留显式操作的幂等/状态合同，不生成第二套清理入口。

Source Store遗留的直接compact调用同步拒绝，不再执行checkpoint、VACUUM或全库完整性扫描；空间预留、候选完整性与物理切换只由既有generation路径承担。Runtime显式compact继续走原generation执行器，不能把退役的直接方法当作备用实现。

旧项目过滤对回收路径的迁移须保留恢复语义。只服务真实文件发现、realpath匹配和空目录修剪的消费者可使用本机active位置中物理存在的路径；它们不需要登记JSON或历史FK扫描，且须保留现存文件路径的捕获验证能力，不能附加isDirectory限制。外置analysis-cache的已批准恢复另有合同：原项目目录消失时，按登记路径字面匹配后允许重建目录；不能把这条资格替换为“当前路径必须存在”。该恢复资格仍需沿既有Compute与最终来源/位置证明迁移，未闭合前明确记为旧扫描残留，不得扩大授权或声称全路径退出。

恢复资格在Source保持同步消费：普通、现存及元数据已排除退休可能的登记，只核本机active位置；只有仍可能属于失效测试夹具的缺失根才使用Compute的完整保护证据。证据属于本逻辑回收操作的不透明本地plan，绑定位置、数据库文件、TEMP watch和registry正文；在同步readPlan/confirm/approve前再次检验，不在打开的事务中await。未准备或失效的证据沿原Scheduler续片计算并重准入；该内部信号不能被文件错误catch吞掉、标成changed或显示给用户。作为恢复授权的“非失效”证明还必须被保护迁移的删除/退出状态撤销，普通进度不撤销。整个操作结束后每片最多128项退出plan证据，关闭与generation等待完整操作，不能只排空某个RPC片。只读Reader可在自身只读域解释原保护数据；Source Writer没有旧扫描fallback。

这项恢复证明只回答数据库是否保护该登记，不能直接反转含文件存在性检查的退休布尔值。Compute期间目录短暂出现后又消失，不是数据库保护；scope专用只读资格排除文件存在性，最终仍由Source当前路径与原物理锚点规则检查。否则一个无任何保护的失效夹具会因文件系统短暂变化被错误允许恢复。

旧完整维护runner退出时，显式非compact调用、启动屏障后的自动维护及会话checkpoint统一唤醒／执行既有生命周期量子；每片重新参与原maintenance准入，不在Writer循环排空历史。旧候选每次最多128项转交，转交不计删除收益。旧running审计行须沿有界恢复结算为中断，历史审计和实际回收计数保留。严格筛选后的失效测试项目登记仍需按原hide→archive→location标记合同退休，但改为有界计划和单项目提交，不能随runner删掉。成长清理已批准清单的恢复仍依赖FK目录，正式归档与恢复仍需真实内容闭包；这些消费者不能误随旧正文扫描退出。

失效测试项目按location主键每页最多128项交给既有Compute筛选；只有本机唯一active位置、未归档revision1及默认metadata、临时目录下原测试命名且物理路径已消失、无scoped对象、登记/隐藏根、活动迁移或任何实际项目/对象FK引用时才有退休资格。引用目录来自实际schema；已审计103处引用中12处无前导索引，因此引用扫描、登记JSON和迁移参数解析留在Compute，不以Writer逐表复核代替。Compute核验前在本Writer登记项目专属TEMP资格，原生触发器只使受影响项目失效，登记与活动迁移保护变化使当前资格失效，普通迁移progress更新不触发全局重试；绑定连接、主库/临时schema和外部写入版本。最后短事务核验资格、项目位置与文件仍消失后执行原hide、archive及位置标记，资格变化重新计算，不提前失败或扩大授权。每个项目结束释放TEMP资格，失败释放由冷维护重试；TEMP触发器的常驻写入成本须计入资源验收。原同步项目范围查询仍承载恢复路径授权，须单独审计迁移，不能为退出维护扫描直接删掉过滤规则。

完整维护调用继续只返回整轮结果，不把单片中间计数交给原调用者。原Scheduler continuation保持一个已接受请求和最终promise，每片释放当前准入再从同一队列尾参与；已接受续片不重套初次deadline或排队上限。Source与Supervisor之间只传内部不透明续片token，函数留在Source，不能把闭包放进结构化克隆或公共操作输入。屏障和前一维护的依赖等待以内部就绪通知交给Scheduler，在等待期间不占maintenance槽；compact/import等随后需要排空维护的动作也遵循该规则，不能持唯一槽等待自己的前序续片。Socket的已接受标记、Source维护审计和逻辑drain覆盖整轮，不在两片之间提前释放完成责任。直接Domains调用自行使用原统一Scheduler，已经由Supervisor或Socket准入的调用沿传入admission接续，不能双重排队。

维护审计恢复复用冷维护片：本Writer第一次恢复时固定审计表rowid上界，每片最多读取128条身份/状态元数据，在短事务中仅结算仍为running且不属于本Writer活动维护的记录。结算保留原删除计数、字节统计与完整性标记，只补中断状态、结束时间和当下物理大小；扫描完成后不再重扫已完成历史，也不制造空闲写入。重启重新核对固定历史范围，事务失败不推进内存游标。显式维护的活动身份从开始到finally退出，不能被并发冷维护误判为中断。

本Writer新建的活动审计同样持有退出责任：成功结算才解除；结算I/O失败后finally释放活动身份，冷维护按同一128项预算精确重试已释放的ID，不依赖重启或重开整个历史游标。恢复只补终态，仍保留原删除统计。业务失败与审计结算同时失败时，调用者得到原业务错误，审计失败保留可定位日志和待恢复责任，不以清理异常覆盖原错误。

元数据删除及GC每个实际提交的计数须在其原删除事务中累加到本轮审计；审计计数失败时本片删除一并回滚。最终结算写整轮绝对值，不能在已有分片统计上重复相加。Writer在最终结算前退出，重启恢复仍保留已经发生的删除数量和实际载荷退出字节，不依赖内存Map补回。Pi调用的GC fence进入GC自身原事务边界：在打开fence事务之前继续拒绝已有外层事务，提交成功后才发布GC内存watch变化；不能通过全局放宽GC嵌套来容纳fence，也不能先完成删除再做权限后验。

完整维护操作以内部续片交回现有调度器：每片完成后释放当片准入，把同一已接受操作的下一片放回原maintenance队列，重新服从前台优先和已有维护排队；原RPC只在最终结算时返回完整结果。当片准入在释放时退休，旧token不能继续提交子操作，前台父片的排队特权也只在父片仍活动时有效。续片不是新用户请求，不重新套用已过期的首次准入deadline，也不能因新请求把队列填满而丢弃已经接受的工作；占用仍归原活动加排队的容量总额。不增加Actor、队列或公开工具，不在已占用的maintenance并发槽里等待重新提交自身。每片仍按原身份核权，失败保留原错误及审计恢复责任，compact继续走原generation链路。

依赖尚未结束的完整操作时，续片仍留在这同一队列里等待其已有完成Promise，不占活动准入、不轮询、不反复发送Writer RPC；就绪后再参与原优先级选择。依赖失败以原错误结束本操作，明确允许从旧失败继续的调用方须沿既有合同吸收该失败。compact/import等待旧维护排空也不能占着maintenance槽等待维护续片，否则会形成环；Runtime排空跟踪的是完整操作的外层Promise，不能把某一片的完成当作完整请求完成。

项目退休资格每次失效也结束当前维护片：释放本次TEMP资格后，把同一项目的下一次核验交回原Scheduler重新准入，不在单片内无限循环等待稳定。连续合法迁移写入可以使保护证据变化，但不能因此饿死已经排队的冷维护；不通过限制核验次数或提前拒绝来代替结果。

## 9. 可反证验收与完成状态

Agent 启动与恢复使用同一隔离准备链。Source 只保存调用身份、原生控制头和最终发布权；Compute 读取完整启动请求、固定策略和绑定历史，推导原始意图 hash、绑定、身份补丁、完整提示词及最终返回投影。预检和备份读取在数据库事务外执行。槽位、意图、Flow 角色仍复用既有分配和同键 FIFO，运行输入仍复用既有运行键；不能再以整个异步启动占有 Writer 独占段。所有已消费正文必须绑定实际内容身份与新鲜验证，最终事务前检查全部控制头、关系、Flow 当前轮次与交付权。首次创建按原顺序一次发布；最后准备或提交失败，正式运行、绑定、日志与 Flow 附着一并回滚。恢复保留原来的分段合同：预检后先正式认领交付权，剩余准备在事务外执行，绑定与最终输入在短事务内发布；失败正式释放交付权并保存原始失败原因、认领与释放历史，不能以全图回滚抹去原恢复证据。已完成准备且无需交付的重读不制造准备 owner 或业务写入。宿主普通准备仍校验传入意图，显式恢复才使用保存请求，二者共用同一正式入口并保持原语义；调用域的 provider 路径与交付 owner 作为小控制输入传递，不能读取 Compute 启动时的过期环境替代。所有复合启动均按既有分配键、真实运行 creation 键、inputs 键的顺序取得原有 FIFO；不能持 inputs 反向等待 creation。只有真实入口大正文、恢复、同键并发、失败与独立 Writer 让行回归通过，才退出旧 `runAtomicCommand` 启动入口。此处是实施合同，不能当作已经完成的证明。

最终启动继续覆盖终端交付、Runner 认领与终端 owner 接管：完整运行 metadata 的读取、修改、hash 与返回 JSON 都在同一 Compute 协议内完成，Source 只核验原生控制头、Flow、活进程和 owner。保留原始参数校验先后、generation/proof、历史幂等回执及进程竞争错误。终端交付的 lease 与 terminal 补丁仍使用原有两个幂等键和中间版本，在同一个 Native 事务内提交；最后 terminal 事件失败时 lease 一并回滚，不能改成两次独立发布。无工作重放不得创建准备 owner 或改变主库/WAL。

报告提交保留完整原文与现有大小校验：校验、相对文件核对、规范序列化、hash、FTS、固定报告快照及大运行 metadata 绑定在 Compute 准备，文件检查不占数据库读事务。无效报告仍完整保存为 invalid，不能截断原文。正式提交仍为原 submit 报告事件与条件性的 bind_run_report 事件同一 Native 事务；当前轮次才绑定运行，旧轮报告仍可独立归档。报告选择仍按原 updated_at/id 顺序，创建序号由 Native 分配，不能预造。重放保留原固定报告回执与当前报告 availability 的原返回语义，不回滚后来报告或重新绑定过期版本；无工作重放无持久 owner/WAL 增长。检查点内嵌报告与独立报告应复用同一准备句柄，检查点、结算和学习采用的剩余写入仍须逐项迁移，不能因独立报告过关就称整个报告族退出。

检查点依赖的运行文档先补齐同一可组合准备协议：Compute 校验完整 Base64 原始字节、生成原 sha256 意图、按真实当前文档头与幂等回执派生 evidence 元数据、原 metadata-only FTS 与完整关系快照；Source 分批准备正文和快照，在新鲜实际字节校验及头/映射/关系/代际核验后短事务发布。原 bytes、MIME、当前同 SHA 身份修复及历史回执必须保留，expectedRevision 仍不进入原幂等意图。已提交重放只验证真正消费的回执和当前代际/轮次授权，不创建持久 owner、不重新写正文或 WAL。句柄分开 check 与 commitNative，支持父图已准备的真实 run/turn 投影，全部证据在第一次 Native 写之前检查，不能在自己的前驱已写后用旧头拒绝自身。检查点仍须一次发布原 turn、日志、报告、文档、绑定、metadata 和消费源，不得拆成多个独立公开写请求。

检查点整图按只读事实、真实子节点准备、最终投影三步完成事务外计算。只读阶段校验原 proof、完整幂等意图及真实回执，保留原校验先后；已提交重放直接返回固定历史运行投影，不为重读申请持久准备权。尚未提交的图以真实当前 run、turn、任务序号、日志映射、报告头、文档头、绑定头、策略和正文依赖形成资格。新轮次只使用本次准备的真实对象身份；子请求已提交时必须消费它的原回执，不能假定当前头加一就是历史结果。全部正文、快照、日志追加、报告和返回结果在 Compute 计算，文件观测不占读事务。Native 发布保留原动作顺序以及绑定造成的中间运行版本，父图自己的后继不得再检查前驱旧头。普通日志持续追加不应无限推翻已观察的前缀；截断、替换和代际变化须撤销资格。原生观察器、恢复、当前运行 MCP 和结算都须分别接到同一准备机制，不能把直接 checkpoint_run 的迁移当作整个族退出。

原生观察器的状态、绑定、文档解码、原始文档编码及日志 JSON 行解析复用原 Maintenance Compute；Source 只保留原控制顺序与发布权，不能在外围回调重新拼整行、解析完整 JSON 或编码大正文。未完 JSON 行在 Compute 的私有解析状态内保留，只追加本次新读的字节，不在 RPC 间反复复制累计前缀，也不改变原字节 cursor。普通扫描结束、消费方提前停止、观察失败、代际变化、事件确认及会话关闭都须释放对应解析状态；真正等待下一段字节的现存 Claude 观察才继续保留。该状态是可重建的内存索引，不写业务对象、不新建后台队列；清理失败不得改写已接受的结果或覆盖原始错误，由既有维护量子继续完成。维护中的持久清理故障必须进入既有错误退避，不能只返回 pending 而形成零延时热重试。报告、turn request 与事件确认仍须沿原原子边界提交，不能只把日志解析移出 Source 就宣称整个观察族完成。

Claude ready、event、append 与 acknowledgement 使用各自真实操作组成的只读准备合同，复用既有文档、关系和运行控制句柄。proof、输入合法性、provider/binding、已存在文档的字节冲突、关闭状态与队列顺序仍按原先先后判定；原 JSON.stringify 字段次序、完整 UUID 列表及原 hash/目的名称不变。Source 先观察真实 run、文档映射和已消费字节，再准备全部子节点；ack 的来源关系与游标、event/ready 的文档与控制更新在一个原事务内发布。append 的新文档只能把其真实已准备的文档投影传给关系准备，不能把未提交文档伪装成 Source 既有行，不能预定业务回执。所有句柄检查在第一次 Native 写之前完成，提交失败整体回滚；返回值由 Compute 解释真正接受的固定版本/回执并完成编码，ready 的恢复投影也不能在返回包装中重新读取 Source 大正文。无变化及已接受重放只验证实际消费的证据，不制造 owner、WAL 或重复业务写入。

真实用户消息补入既有 turn 也使用自身的只读准备合同，不冒充 checkpoint action。原请求只从幂等意图移除 expectedRevision，调用者实际传入的其它字段全部保留。generation、非空消息、既有固定回执、当前运行版本/turn 与未结算条件保持原先后；turn 正文、完整 metadata、日志 TEXT 及对应 source evidence 的编码、哈希、FTS 和版本快照交给原 Compute。Source 沿原 run-inputs FIFO 准备真实子节点，复用既有 journal 原始行证明和头/正文证明，在原一笔事务中依次发布 root request、turn、日志/source、metadata/control history 与最终回执。日志表的未截断文本在准备前开始观察，无法提前确定身份时由 Compute 重新核对原行签名，不能在最后 Source 事务重新拼接或哈希大 TEXT。已完成重放保原固定版本与当前代际校验，不重新追加用户消息或创建持久准备数据；最终失败全部回滚，输出解释真实已接受回执。

停止与恢复沿原入口、原运行队列继续。停止意图的既有字段归一化、代际/turn 校验和固定回执语义进入原运行控制准备，不能把调用者声称的 native boundary 当作可信边界。实际 binding 和状态由原只读链解释，Source 只核对小型真实绑定身份并读取原生文件头；大 metadata 不在 Source 解码。关闭与中断仍须保留已接受停止意图供恢复，不能把异步准备变成未登记的在途工作，也不能等待依赖同一数据服务的 wrapper 后才关闭。完整状态读取可以异步，发出进程信号前的当前代际及真实进程身份复核仍须紧邻实际动作；不能因新增 await 失去原即时栅栏。小型上下文须先以 Native 字节预算核实再走已有同步资格，不能为迁移大正文引入小型停止的启动等待。输出最终化及其文档、日志、索引、控制历史仍按原原子边界完成，不拆成用户需要协调的多次动作。

宿主输出最终化使用真实 finalization 输入与独立只读准备，不借用 checkpoint action 或构造预执行回执。保留原 proof、退出码与 source 校验、固定回执哈希（排除 proof、expectedRevision、workspaceSnapshot、gitEvidence）、版本与 turn 校验、pending 条件、恢复时实际进程存活判断和工作区快照要求。完整 before 文档、Git 证据、after/changes 文档、未交付判定、需要时的失败 turn、原日志全文及其 source evidence、最终 metadata 和历史快照均在既有 Compute 准备；Source 仅核对实际控制头、文档映射、日志字节边界和只读内容证明。在原同一 Native 事务内依序提交全部文档、turn、日志/索引、控制历史、consumer source 与根回执。末步失败必须整体回滚；重复完整请求先走只读固定版本重放，不启动工作区扫描或新增持久 owner。停止、恢复和真实宿主三处都接入该同一发布入口，不能只迁移公开 Runtime 路由。

原有交付物校验将损坏或不合格的复盘材料解释为“没有有效交付物”时，迁移必须保留该结果及正式失败收尾，不能把它升级为阻断收尾的正文完整性异常。有效交付物仍须通过完整有效正文证明；否定判断则观察实际控制映射、对象头与真正参与判断的内容 ID，并在登记失效观察后的只读计划中重算原谓词。后续字节或映射变化使该判断失效重做，不能用伪造有效正文或跳过原校验来获得否定结果。

恢复扫描先沿原序号索引选择最多 100 条真实运行身份及控制头，再逐条由既有 Context 解释完整状态，避免在 Source 一次解码整页 metadata。异步读取后复核实际代际、版本与恢复资格，不能恢复已经被其他动作完成或替换的旧观察。后续状态重读、停止与最终化继续走同一组原入口。失败处理仍按原 run/generation/turn 选择可用的最新状态，使用原 state 发布与原幂等键保存退避版本、尝试次数和重试时间；保留 30 秒起始、最多 300 秒的原退避及原诊断。未到重试时间的扫描不重写状态、回执、owner 或诊断，不能通过新增持久恢复队列代替这些行为。

运行结算继续是原消费租约下的一次完整原子发布，不能拆为异步 Flow、日志、学习或通知等相互独立的正式请求。原完整 settlement 输入哈希和固定回执保留；重放先于后来租约、代际或源状态变化的检查。新提交按原顺序校验真实 lease、当前 head 和已排队 source，允许消费仍被正式租约选中的旧 checkpoint，不能把 sourceRevision 误当当前运行版本。只读准备覆盖原 Flow 子发布、完整 settlement 文档、digest 及其投影、文档审计、verification、learning event、RSI 采纳、step handoff、所有需要关闭的日志及 source evidence、项目运行索引、effects、summary、当前控制 metadata 和通知。Source 在短 Native 事务首写前核对实际读取的源、映射与内容证明，依原顺序提交所有孩子、历史和根回执；任何末步故障全部回滚。原 RSI 子事务将指定错误转为采纳拒绝证据的语义必须保留，不能把辅助采纳失败改成整轮结算失败。完成同 turn 后的关闭结算仍复用原 learning/handoff，并保持 effects 去重及原通知行为，不新建用户需要协调的结算步骤。

通用补丁的同步资格也必须先以 Native 字段字节统计和有界关系资格判断是否足够小，不能先把完整 title、summary、JSON TEXT 或全部关系读回 Source 后再判定。进入异步准备的通用写入及复合子节点，仅查询实际既有内容 ID 列；完整元数据、正文、FTS 与快照由原 Compute 读取和计算，不为提取正文 ID 而造一个业务对象。已完成的通用写入在原同对象 FIFO 内只读解释实际固定回执，核验实际消费的回执字节与最终权限后直接返回；不能为重放再创建持久 owner 或改写 WAL。关系写入按原 link 意图和错误先后准备，保留两端原先实际消费的完整正文、引用版本、FTS、关系快照与固定回执。实际用户 link、原生用户来源关联及事件确认必须共用可组合句柄；首个 Native 写前统一核验，同对象沿既有 data-write FIFO，重放不制造持久准备写入，最终 Pi 授权仍在正式提交内检查。

小请求的固定回执重放同样先核对真实请求和回执字节预算，不能为判断同步资格而读取无关的当前正文。历史引用的固定版本映射在准备阶段按每批最多128项登记到既有 Source TEMP 证明；登记时原生核对真实 content ID 与 SHA，映射的插入、替换和删除仅使受影响版本失效。最终事务只查询本 token 是否失效，不再重复逐引用读取一轮资格映射；原事务必须执行的引用语义校验和引用行写入仍保留。证明随原 token 的有界释放和冷维护退出，不能另造持久任务或业务根。

准备期间，既有原子业务生产者可能先提交同一 actor/key。异步通用写入在尚未进入自身 Native 发布时遇到准备冲突，应重新解释这个真实已提交请求：相同原意图返回固定回执，不同意图仍报幂等冲突，最终权限仍要重查。不能用当前头的 revision 冲突覆盖已经成立的原回执，也不能把自身已进入发布后的真实故障吞掉或伪装成重试成功。

MCP write/link 的既有权限政策保持一套。完整对象元数据、学习审阅输入和可读性判定由原 Compute 在真实只读视图执行，Source 不为授权回调再次取回全部 title、summary、JSON TEXT、历史引用或审阅清单。准备前登记真实对象与实体行的变更证明，准备后补齐实际消费的内容、固定映射及审阅项目范围证明；最终提交前在 Source 核验这些证明、当前 grant、运行 proof 与 Pi 调用身份。依赖变化重新读取并执行原权限政策，不能用过期权限继续提交，也不能为授权造部分业务对象或另设使用入口。成功重放也须遵守当前授权，但授权证明本身不创建持久 owner 或改写 WAL。

进入原 write/link 对象 FIFO 必须早于第一次异步授权等待，host、MCP 和关系写入仍共享原键；内层 publisher 消费已取得的同一位置，不能再取同键造成死锁，也不能增加 MCP 私有尾链。授权准备失效可以在该位置重做；一旦进入本次 Native 发布，真实错误原样向外传播，不能因为自身写入使旧授权证明失效而重新重放并吞掉错误。只是准备失效、没有产生回执的 Native 空片仍返回原准备流程。

结算中的文档审计保留原清单合并、路径校验、绑定复用、无变化文档跳过与每个子请求的固定回执。读取及合并完整清单、文档职责和子请求哈希在 Compute 完成。Source 在读取前登记本项目文档与绑定集合的 TEMP 变更证明，准备后核对最新清单头和实际对象签名；新增绑定或文档也能使集合证明失效。所有 TEMP 实体触发器须在父图取得资格前初始化，不能在准备子节点时改变 TEMP schema 后继续使用父图旧资格。最终一次性核对完整子请求集合，按绑定、文档、清单原顺序加入父事务；禁止为了新路径而提前单独提交文档审计。

学习采纳准备必须消费真实固定报告、当前且已审核的经验、实际投递证据和指定验证，保留原 absent-global-prompt 基线策略及 use、反馈、evaluation 顺序。已提交的 evaluation/rejected 只核原存在性，不读取原路径从未消费的回执正文。验证正文的读取或 JSON 解释失败继续表示未评估；此类失败只登记实际内容 ID 的变更观察，并在登记后重新执行原判定，不能强制完整性校验后把原可结算结果改为失败。成功消费的正文仍须完整物理证明。固定版本映射、经验投递和跳过条件在首写前核对；准备的子节点是真实候选身份，不能冒充已经存在的 policy、use 或回执。负面经验验证优先于任务整体通过，指定采纳错误仍生成原拒绝证据。

交接仍先写原 step_handoffs，再以原 settlement_step_memory 意图和 step_memory 事件保存快照。Compute 从真实当前记忆指针和实际来源集合生成完整快照、FTS、来源引用及固定版本，不为复用既有 metadata 读取或解码其正文。首次 metadata 为空对象；后续只沿用原 content ID 和 metadata 对象。全局交接序号仍由 Native 正式分配，准备只观察当前高水位，变化后重准备；禁止持久预留序号。最终快照的游标必须等于实际插入的序号，latestHandoffRef 使用前驱文档提交后的真实版本；历史文档回执不能冒充该文档当前头。交接、记忆历史、关系、事件和父结算仍同一事务回滚。

结算日志按真实 journal 行及其来源映射准备，主日志先保存提交的四个 TEXT 字段，再在会话已经关闭时逐一关闭本 run 的全部 turn 日志。主日志因此可能生成两次来源版本，不能折叠中间历史。Compute 使用实际 SQLite 参数往返得到写后文本表示，再编码来源 JSON 与哈希，以保留原生文本编码行为。后继来源只能消费前驱实际准备的对象投影；已提交回执继续读取当前真实来源头。已有来源 SHA 相同则按原逻辑跳过正文读取和重写，不能以完整性校验名义改变未消费旧正文的行为。Source 登记每个实际 TEXT 行和原映射的 TEMP 观察，登记后由 Compute 再核原始行签名与关闭集合；首写前核映射、请求及观察资格，按原顺序提交中间日志和来源版本。

结算通知沿用原会话查询与通知箱：Compute 将真正待插入的 settlement 载荷显式作为候选，与原最新 checkpoint 比较，并从待结算判定中排除本次将提交的 source。已存在的固定运行版本照常读取；不能以虚构运行状态或试提交替代准备。会话可见性、实际目录、配置、固定报告及现有通知的 payload/response 都按原读取路径验证；准备后再核实际读取头、固定映射与 pending 条件。新通知仍使用原 intent、通知事件、完整证据、通知箱行与回执，在父结算内提交。Flow 仍由其原通知路径负责，运行结算只保留原查询和筛选行为；已有通知不得因整图重试再排一份。

消费者租约认领沿原输入 FIFO 单独准备，不能在 Source 为检查 generation 解析完整运行 metadata。Compute 保留原 owner、source 存在性、固定运行读取、turn/generation、committed、同源租约和进程活性判定顺序；没有 source 的原合法空分支不读 metadata。固定源可早于当前 head，比较 generation 用真实源版本，租约记录和返回 generation 仍用当前控制头。Source 末步核真实控制行、source、实际读取的租约/历史、内容和固定映射，并重核原 PID/birth 活性；真正写入时才生成 token 和原租约行。不变认领返回实际既有 token，不创建持久准备 owner 或改写 WAL；释放仍沿原小原生控制路径。

复盘应用保留原清单、固定来源、提案和恢复校验，以及当前项目范围检查，再以原完整子意图准备 application、policy、正式经验及其 decision/application、游标、历史目标恢复和 batch。新的经验尚未提交时，后继 decision 只能引用前驱真实准备产物对应的固定快照；由同一发布 owner 持有和验证物理内容、缺席头与预计版本，提交时先正式创建经验再沿原引用约束写 decision。不能为验证引用先提交经验、伪造未来回执，或用临时业务事务试跑后回滚。现有经验和事件仍读取实际固定版本，不能退化为当前头。所有前置资格统一在首写前复核，按原顺序一次提交；迟到历史恢复沿原目标版本和范围推进；后继恢复同时消费前驱真实准备的目标快照和待提交来源映射，原生资格仍核对真实数据库中的映射。两份待恢复记录指向同一新目标时，必须保留原目标版本冲突，不能拖到第二次插入才暴露数据库唯一键错误。不增加用户需要理解的应用步骤。

复盘中断保留原分支：先完整读取批次，再检查实际关联运行及 PID/birth 活性；存活运行只按原规则释放 draft 批次的 owner，不读取或修改无关运行 metadata。运行已经退出时才解释完整运行状态，必要的停止与 draft 批次转 interrupted 仍在同一 Native 事务内。批次正文、原始控制输入、控制关联和实际消费的运行正文纳入准备证明；原生提交前重核 PID/birth 与映射。使用既有运行控制可组合句柄和原对象/运行冲突范围，不拆成提前提交的停止请求，不造新队列或复盘状态。没有新停止、状态或 owner 修改时，仅核验真实源与权限，不制造 owner 或 WAL。

复盘完成确认由 Compute 读取实际 application、当前目标指令和 batch，保留完整 after_content 的 promptHash 检查及原错误先后；已 applied 的应用可以在后来指令变化后重放，但不能跳过原本仍会读取的当前目标。批次控制记录指向的原始输入和当前 review_content 都纳入实际正文证明，缺席或映射变化也须复核。Source 复用原 application 对象 FIFO，将 application 与必要的 batch 状态补丁一次提交；不添加复盘根回执或额外事件。所有子请求均为真实固定重放且没有新状态补丁时，核验当前源与最终权限后直接返回真实 application 回执，保持 owner 与 WAL 零增长。首写后错误不得转成准备重试。公开完成兼容方法与 Runtime 均进入同一个完成发布器，不再保留同步读取、哈希和写回大正文的另一套实现；直接调用须等待同一真实发布结果。

宿主运行验证使用独立的真实验证准备合同，不借用结算状态。原 claim/evidence、运行与 task、经验评估及 turn 来源检查仍先于根请求重放；完整意图哈希、证据编码、原 evaluation baseline 匹配和反馈计划由 Compute 读取并产生。只影响同一 turn、经验版本和具体动作，保留未匹配、无证据及历史坏 baseline 的原判定。同一采用存在多个评价指标时，相同子幂等键必须核对完整原意图，并复用同一个真实计划节点及对象身份，保留所有来源关系；不能为每个指标分配新的反馈对象或伪造未提交回执。Source 核实际控制身份、task、来源关系、请求、评价集合和内容证明，再将原根请求、证据、verification、反馈关系及 evaluation 一次提交；没有额外根事件。准备期间新增评价或改动 baseline 必须使计划失效，不能漏掉迟到采用，也不能在首写后吞错重放。既有固定根回执仍由真实只读解释与最终权限核验返回，不创建持久准备 owner 或改写 WAL。

诊断追加保留原事件字段、完整 canonical payload 和同键严格冲突语义。小事件先通过有界预算判定，继续本地同步发布；字符串与键名的预算须在编码前计算实际 JSON UTF-8 字节，包含转义、配对及孤立代理字符，不能先编码再判断超预算；大事件由既有 Compute 编码正文及当前请求的完整返回值，Source 在原短事务中仅比较实际存储的字段和正文，再决定复用或插入，不将旧大 TEXT 读回进程。重复请求返回本次输入的 payload 顺序，不制造持久准备记录或 WAL。最终权限在正式事务入口复核；准备期间出现同键请求，以真实已提交内容决定重放或冲突。后台诊断回调的大请求通过既有内部 Writer admission 追踪，小请求保持原本地即时写入；不得新增诊断专用队列，也不能让关闭或代际切换遗留未登记的异步写入。迁移启动入口仍需随其整条迁移链单独接齐，不能以普通诊断已迁移宣称旧路径全部退出。

旧环节学习记录入口继续保留原 evidence → learning_event 的单事务合同、原来源固定版本及按项目/环节/结束时间确定的幂等键。完整 node、输出、文件摘要的 canonical 编码、意图哈希及请求重放由现有 Compute 完成；Source 只持有实际准备产物和最小提交计划，两个子请求按原顺序一次发布。准备期间允许独立前台写入；首写前复核真实请求、对象头、正文资格与调用身份。相同输入重放必须返回原事件回执且 owner、事件、版本和 WAL 零增长，不得以先提交来源的方式模拟原子性。保留这个正式兼容操作不会保留其同步大正文写路径。

外部记忆仍由宿主既有选择目录/断开动作发起，沿原稳定文件读取、hash/范围校验和 Runtime 授权进入同一数据权威。同步准备由 Compute 完整校验外部条目、当前真实身份/版本/授权状态与原请求；不变同步返回最后真实固定回执，不强制读取原路径没有消费的正文。项目来源仍限定原 active location 名称，全局来源在各项目间复用同一对象，拒绝同来源多对象、倒退版本及同版本不同 hash。Source 在读取前登记准确来源或目标前缀的 TEMP 集合变更观察，连同项目位置、对象头、真实正文和请求证明在正式提交前核验；新增来源、归档、换范围或撤销都使准备失效，不在 Writer 扫描或编码完整记忆集合。观察只属于本次准备，释放失败随既有冷维护重试，不产生持久业务对象或额外队列。

撤销和对账保留原项目/全局前缀匹配、原排序、每个 memory 状态补丁的幂等键，以及末尾 external_memory_target_action 真实证据回执。完整 sources 意图、集合筛选、旧 marker 的固定版本解释和所有大快照均在 Compute 准备；原 M 个补丁和一个 marker 在同一 Native 事务提交，不能提前逐条撤销。正式 CloudMCP 来源的同步、撤销和对账按同一 target 使用既有发布 FIFO，跨项目的全局来源也保持调用先后；不能按项目分开排队，让较早同步在较晚撤销后重新生效。其他历史来源按真实 source 身份使用原发布 FIFO，不新增队列。对账只撤销缺席来源，后续再授权仍可恢复，固定历史按原访问合同保留。重复 action 用原 marker 返回固定统计并保持 WAL 零增长；新 action 即使零撤销也保留原必需 marker。容量合同沿用原真实状态转换和历史：同步不变零增长，变化只形成原一次 memory 修订；目标动作只形成原 M 次修订及一个 marker，准备与 TEMP 观察无永久保留。实际大集合的 CPU/I/O、主库/WAL和原子提交峰值仍须通过正式规模门禁，局部功能回归不能替代。

复盘准备沿原正式入口分阶段进行。原 active 批次、PID/birth、同 runId 的 prompt/hash 重放、旧批次中断和初次 policy 保留原判定顺序；中断只准备既有可组合句柄，后继提案和策略引用消费真实物理快照，全部业务变更仍随新批次或原重放结果在一次 Native 事务中提交。只读准备不试跑业务事务，也不以虚构对象或未来回执补齐依赖。原 active 遍历在既有 Compute 内保留单次准备进度，draft 批次的中断准备只在实际物理快照或真实已提交原请求回执校验后推进，不通过重新查询同一未提交 draft 模拟进度；各阶段返回前关闭只读事务，不能跨自己的暂存写持有读视图。

数据库输入先在既有 Compute 的只读席位固定当前原生元数据，按实体键分片读取；只保留实际 SQL 状态、正文 ID、固定版本和必要控制关系，不在这个视图中解码正文、访问项目文件或发表私有内容。一次只允许一个准备上下文，不按项目数增加进程或连接。捕获期间其他 Compute 工作使用已有的独立只读席位，交互 Reader 与 Writer 保持可用；捕获完成即关闭读视图，随后分片准备正文和真实内容绑定，已处理的元数据及时退出上下文。这样避免自己的私有分块写入在长读视图下积累 WAL；剩余 WAL 占用是捕获窗口中的真实外部写入，须纳入正式资源测量。只根据 events 最大序号和旧修订快照重建输入并不充分：升级回填可能改变当前 SQL 元数据而没有改写旧不可变快照，必须保留当时真实 SQL 行。

正文准备继续保留原来源顺序、全部未处理旧版本、延期来源、历史提案和恢复目标。正文与元数据分开持有，单个阶段不返回整份来源全文给 Source。每份正文完成真实暂存后才记录 sourceContents 的实际内容 ID；最终完整输入、FTS 和原意图 hash 在 Compute 生成。新批次的控制行尚未提交时，正式准备身份仍只按原复盘允许字段生成索引，不能因控制行当前缺席而回退到整份输入的普通全文索引；这个内部标记不能用于普通对象、已有批次补丁或全局无项目批次。大量正文资格按同一调用的 TEMP 集合观察统一复核，不能在每片上重复遍历此前全部 watch。输入游标描述实际只读捕获的业务高水位，不预留或冒充尚未提交的中断事件序号；实际消费仍由已有 source/ref/revision/hash 和 cursor setting 推进，原字段没有被引入新的处理消费者。

正式 Runner 的启动只需要固定批次身份、persistedPromptHash 和完整 manifestHash；通过内部最小返回模式接收这些值，来源继续由 Agent 沿已有固定批次分页读取。兼容调用仍可取得原完整 manifest，完整返回的编码也留在 Compute。上下文结束、重试、权限丢失、Worker 退出和代际切换均须释放只读视图、元数据及暂存持有；不留新的持久任务或私有旁路。只读捕获同时核对连接建立时的 device/inode 和当前路径身份，禁止给缓存的旧连接签发新代身份；已封闭的元数据在代次失效后也不可继续读取或消费，但仍可用原绑定释放。首次全量、未变化重放、真实变化、旧导入、同时写入和取消的内存、WAL、主库、暂存及清理峰值都须验证，不能把此实施合同视为已完成的证据。

批次保存也必须保持正文分离：旧来源的结构化 `value` 通过 `sourceContents` 中的实际内容身份保存，完整延期游标和待恢复成果分别保存为真实的 `previousContentId`、`pendingContentId`。Reader 恢复原完整字段与版本，manifest 哈希仍按原字段顺序和全文计算；既有固定来源分页保持原字节及哈希。接受成果时，恢复的正文仅作为 Compute 的局部输入，写回的批次继续引用原实际内容身份，不把全文重新内联。捕获后的当前来源更新不使固定历史版本失效；历史资格绑定实际修订、内容身份和哈希，批次选择、权限与所有权仍在最终发布前复核。只有本调用实际取得的准备或捕获上下文才由本调用释放，已有上下文忙时保留原错误及其所有权。

释放失败不能替换已经提交的有效结果，也不能遗失原准备身份。既有 Source 保留原数据库绑定和准备身份的退出责任，由下一次准备及既有 Cold 维护继续释放；不新增持久任务或工作队列。持续释放失败向既有维护退避返回真实错误，不能形成无进展的热重试；同一资格释放故障只报告一次，成功退出后清除记录。

初次准备的返回值固定到真实提交回执的版本，结果投影按该实际版本读取。提交后发生的后续批次编辑不能把初次返回悄然替换为更新版本；同 runId 的后续显式重放仍沿原规则读取当时批次状态。

准备上下文只在首次建立时接收原完整输入；后续推进、捕获分页、资格复核和释放仅传各自合同所需的原绑定、确认及证据。不能在每个来源的控制消息里重复整份提示词，使传输和序列化成本随来源数乘上原输入大小。

公开 Store 的复盘准备、应用、完成、打断及运行验证记录均沿既有异步发布方法调用，调用方等待原结果；不保留另一份公开同步正文处理实现。应用旧体专用的恢复与经验写入助手一并退出生产。历史错误顺序和竞争提交的对照保留为仅用于测试的原 Native 代码，在隔离数据库真实执行原事务，不调用新发布器充当旧行为。

Claude 原生运行的 ready、event、append 与 acknowledgement 公开方法也只转发既有发布器，复用原运行 FIFO 和提交图。Runtime 原有 event 后观察与回读继续保留；直接方法不额外添加观察流程。大段运行状态由 Compute 读取，确认时仍保留原代次、序号、事件缺失及轮次绑定的判定顺序。

公开运行文档写入只转发既有异步文档发布器，直接调用方等待原回执。原校验先后、完整正文与引用关系、固定重放及零增量保持不变。旧复合事务中的内部文档写入暂仍沿原 Native 提交内核，必须随各自完整生产者接入准备链后退出，不能因公开入口转发就计为全部文档写入退出。代次竞争回归在实际文档准备接口之后插入真实代次变更，复核原所有权错误以及文档和请求均未写入。

运行 checkpoint、输出完成与结算的公开方法同样只转发既有发布器；它们专用的旧 Git 证据保存和旧经验采用助手退出生产。Runtime 继续承担原有工作区采集、报告校验、原生观察与最终权限提交，直接 Store 方法只保留原自身合同，不额外执行 Runtime 的输入归一化。历史事务和同步竞争需要的原代码仅在显式测试夹具中执行，包含原方法哈希与真实 SQLite 提交；不得用新发布器替代旧行为对照。历史导入及其他尚有实际调用的旧内核仍须逐条接齐后退出。

运行创建、启动意图、启动槽位与 Flow 角色四个公开入口作为同一组接入既有异步发布器。创建 Native 内核必须取得实际完成的准备图，未准备时编码正文、重建元数据或直接创建子对象的分支退出；对话、任务、轮次、文档、日志映射、采用记录与根回执仍沿原一次提交。启动意图和槽位的调用输入不要求预先提供执行编号，编号由原分配流程选定；重放计划绑定真实已有编号，不能补造占位身份。直接调用方等待创建结果，隔离建库使用的 Compute 在数据库交给 Runtime 前完成关闭。

纯重放必须在建立持久准备责任之前识别：Compute 从已提交请求读取真实回执和固定历史结果，Source 用实际内容身份、请求头与运行映射复核，再通过原最终权限提交返回缓存序列化结果。内容证明在构造期间因真实物理内容变化失效时，也必须在同一只读选择循环内重选；不能只处理最终提交时的失效，更不能向调用方泄露内部失效标记。既有运行和 Flow 角色的重复读取不能新建 owner、pin、内容、请求、事件或改写主库 WAL。首次发布及确实还有后续变更的组合发布继续持有原准备责任；组合发布如果得到更新回执，返回值必须来自该实际最终回执，不能被早期根请求的固定结果替代。

独立步骤记忆写入沿正式 `write_step_memory` 与同一个公开 Store 发布入口。先保留原输入合法性和错误先后、完整意图哈希、排除 expectedRevision 的幂等合同，再只读取得真实当前元数据、按原顺序排列的来源及全局交接游标。Compute 合并完整元数据；Source 暂存真实元数据和来源引用后，Compute 才按实际 content ID 是否相同决定原 dataRef 或完整 data、metadata 对象身份及新鲜度是否递增。正文物理落位后，再用其真实 CID 准备 evidence、搜索词和固定对象快照。后续阶段只传实际引用和必要的控制事实，不能反复附带上一阶段的整份大正文。

正式提交前复核请求、当前步骤指针、物理来源表、全局交接游标和实际内容证明；字段来源、对象、evidence、当前记忆、固定历史、关系、新鲜度和原根回执仍在一次 Native 事务中发布。只修改本次 patch 字段的来源，保留 default/user 优先级；相同 metadata CID 不递增项目新鲜度，也不重复内联历史元数据。返回值由 Compute 按真实提交回执对应 evidence 的步骤版本读取完整固定结果，并沿既有序列化缓存返回。旧请求重放先只读核验原回执与固定内容；当原读取会使用当前 evidence 行时，资格还必须绑定该行实际 content_id，覆盖首次 watch 建立前且对象版本未变的真实正文映射变更，不能只验证对象版本或 object_revisions 映射。不新增 owner、pin、请求、事件、正文或 WAL；证明构造和最终复核的真实变化均须重新选择。字段覆盖竞争、迟到来源、末事件失败及跨入口重试必须覆盖原子回滚。独立写入接入本身不代表历史来源导入已迁移；历史导入与其专用同步 save 内核的退出按下文单独验收。

这项迁移不新增后台轮询、actor、队列、付费调用或原业务事件；写入频率仍由原用户补丁和完成标准初始化决定。单次成功图仍是原一次步骤版本与回执，正文按真实内容去重；准备占用须在成功、失效、失败和重开后退出。验收须观测大元数据的真实 Source 编码/读取/哈希、相同键零额外写入、不同键同内容的存储增长、固定历史和清理责任；正式留存规模及资源门仍按全任务要求独立验证，局部小库通过不能替代。

运行输入文件恢复只根据真实 Native generation 和原父进程、子进程 PID/birth 存活规则决定是否退出，不读取完整 RunState 或运行 metadata。代次已替换时仍按原短路规则清退旧注册，当前存活代次及其文件必须保留；身份缺失继续抛出原 run_missing，由现有逐项错误收集处理。这个资格读取不新增内容解码、哈希、owner、事件或 WAL 写入。注册文件的实际检查、部分输入原字节归档、inode/内容证明、移除、释放回执与失败重试继续沿既有机制，不扩大文件清理范围。验收须同时包含大元数据下的真实父/子进程存活、birth 不匹配、无存活进程及旧代次和存活替代文件，不能用伪 liveness 返回值替代。

轮次请求补写的公开 Store 方法只转发既有轮次请求发布器，退出原同步哈希、turn 补丁、完整 metadata 合并和日志追加的另一套公开实现。原生观察器继续沿既有发布入口；完整用户消息、turn 固定历史、日志来源、原根意图与 expectedRevision 排除规则、固定重放、末事件整图回滚和最终权限均不变。generation 和消息合法性仍先校验；原幂等键合法性校验继续先于完整意图哈希及版本冲突，不能在异步准备时改变错误优先级。直接调用方等待同一实际结果，不新增 Runtime 操作或前台步骤。

运行状态、停止标记、会话绑定、交付认领与释放、运行认领、终端 owner 接管和终端交付启动这八个公开 Store 入口都只转发各自既有发布器。原小状态资格满足时继续走原同步 Native 内核；公开方法不再提供绕过资格的另一份大正文路径。转发未提供的可选边界时保持原参数形态，不添加自有 undefined 字段而使原本满足资格的小请求退入 Compute；合格的小停止仍在让出执行权前完成原 Native 提交。内部 Native 调用必须显式命名并限制在原资格成立的提交分支；发布器不能通过调用异步公开方法递归自己。启动交付的 lease 与 terminal 两个原子请求保留原幂等键、中间版本和一次 Native 事务，不能先认领再独立保存终端状态。

直接调用方等待同一实际结果，原 generation、PID/birth、provider/binding、owner、Flow、停止意图归一化、proof、完整意图和错误优先级均以真正旧 Native 对照核实。幂等键合法性保持原先先后：运行认领在 PID 校验后、读取运行前检查；有独立根回执的其余控制动作在原 generation 及状态补丁合法性检查后、完整意图哈希和版本或 lease 条件前检查。组合交付启动仍沿原终端参数校验和 lease/terminal 子键，不新增根键限制。固定回执和历史重放仍无额外持久准备写入；停止与关闭时原有小状态快路不能要求先启动 Compute。Source 仍只提交资格允许的原小图，完整 metadata、binding 和结果序列化沿既有 Compute；不能以重命名内核冒充未准备正文路径已经退出。历史报告提交中仍调用的私有报告绑定内核属于另一个待迁移生产者，必须随报告整图单独闭合，不列为本组公开入口退出。

旧 Native 事务竞争及 generation capture 的测试对照保留八个原完整编译方法及依赖，按原同步事务执行；调用方不能改成提前提交或在原 Native 事务内等待新公开发布器。原生 checkpoint 对照里使用的旧同步 binding 也必须随原 Native 辅助方法显式安装和恢复，不能悄悄指向异步公开方法。

公开运行输入补丁只转发既有输入发布器。保留原完整 input 哈希（包括 expectedRevision 与实际额外输入）、空 command、状态与关闭规则、固定版本返回和错误先后；幂等键合法性仍在 generation/输入类型检查后、哈希和版本冲突前判断。原有有界小输入资格及即时 Native 提交不变。含环节经验引用的提示词原本不满足小输入资格，继续由 Compute 解释完整来源并准备真实学习交付图；公开入口接齐后，同步内核中这条不可达的大正文解释分支与孤立助手应真正退出。

纯输入重放在持久准备责任之前识别，并由既有 Compute 从已提交原请求、实际回执与 Native 固定读取语义取得完整结果和序列化值；Source 只核验真正消费的实际内容、当前 generation/头、回执与历史/日志/任务映射，再执行原最终权限提交。验证构造和最终检查期间的真实变化均要在同一选择循环重选，不泄露内部失效标记。重放不得新增 owner、pin、正文、请求、事件或改写主库 WAL；首次写入仍先准备真实正文 CID、快照、索引和学习交付节点，再一次 Native 提交。历史与当前分支只验证它们实际读取的内容，不能因为无关大正文损坏而让本来可完成的补丁或恢复失败。用于迟到 Native 赢家的三个原竞争测试继续执行真正冻结的旧同步方法，不能等待同 FIFO 的新公开入口来替代旧行为。

公开报告提交接入既有报告发布器，退出同步处理报告正文的另一套入口。直接 Store 调用仍接受原调用方的 availability 与 validationError，完整原始报告、空值和原幂等意图均不重新归一化；Runtime 的正式提交继续由 Compute 按原工作区规则校验报告。这个差异只属于既有内部准备合同，不增加前台步骤或另一套发布队列。generation、turn 合法性、来源关系及幂等键的错误先后保持原 Native 行为；当前轮报告与运行 metadata 绑定仍以原两个请求在一次 Native 事务提交，非当前轮不额外绑定，末绑定失败须使整个报告图回滚。

准备、正文编码、完整哈希、索引与快照由既有 Compute 完成，Source 仅提交实际准备产物并执行原最终权限检查。直接提交替换已有报告时，Compute 仍按原 Native 顺序读取实际旧正文；内容资格同时绑定真实 CID 与报告行的当前正文映射，首次 watch 建立前且对象版本未变的映射变化也须重选。旧请求重放保留固定回执与当时当前报告的 availability，不读取原路径没有消费的正文，不新增 owner、pin、正文、事件或 WAL。物理资格构造期间的真实变化也须重选；不提前提交报告来准备运行绑定。仅旧提交入口使用的 upsert 正文助手随入口退出，仍有真实消费者的报告头读取和合格小绑定内核保留。旧 Native checkpoint、历史竞胜及错误顺序测试显式安装冻结的原完整同步助手并恢复，不能换成新异步公开入口。验收同时核对大正文、原状态意图、固定历史、归档后续写入、整图回滚、重放零增长及相关前台报告消费者；局部通过不替代正式规模资源门。

公开日志追加只转发既有日志发布器。原 generation、保留 output 流、stream/sequence/offset/key、Base64 合法性及完整输入幂等哈希的先后保持不变；额外输入仍属于原完整意图，调用开始时固定实际输入，不能在等待期间被调用方修改。使用现有 Compute 的只读准备合同完成实际字节校验、完整哈希与请求解释；已接受重放先于当前日志游标冲突判断，返回原固定结果，即使后来又追加日志也不新增 owner、pin、正文、事件或 WAL，也不验证原重放没有读取的历史日志正文。历史回执在读取后改为内联或切换实际结果指针时，证明构造失败也须先复核真实请求头；已换指针则重选，不能因验证已不消费的旧载荷使合法重放失败。请求头未变的真实损坏仍沿原错误返回。

首次追加的二进制正文与原事件描述正文都在既有 Compute 准备，Source 只暂存真实内容并持有原 owner 和内容资格，首写前核验身份、实际请求与内容，再沿原一次 Native 事务插入请求、源流日志、stdout/stderr 必需的 output 镜像、事件和原小结果。保留原序号、偏移与全局事件游标，不提前提交日志来取得回执，不为重放增加业务对象。准备构造及最终资格的实际变化应重新选择或使用本调用的真实准备字节恢复，不能泄露内部变化标记或用提前失败替代原来可完成的追加。正式首写后的错误须按原方式回滚并返回，不能再归为准备失效而重新执行整图。退出未准备时在 Source 解码、哈希、编码正文的同步分支；需要构造原历史日志的测试明确使用冻结 Native 事务，普通调用方等待正式发布结果。成功、重试、失败、关闭和恢复的准备责任继续由原生命周期退出，不新增队列或后台频率。资源验收包含大日志、同键零增长、连续日志与输出镜像、迟到赢家、旧字节、损坏重放及末事件失败整图回滚，正式规模与前台门禁另行验证。

日志的私有准备标签复用 Compute 已得到的原完整意图 hash，正文与事件描述分别持有真实绑定，不把任意长的 stream 或 key 再拼入 Source 哈希。原 FIFO、SQL 中的 stream/key 和完整幂等意图不变，不截断合法值或新增长度限制。

历史环节记忆来源导入接入同一环节记忆 FIFO 和现有 Compute。原 node/source/hash/format 校验先后、同哈希快捷分支、UTF-8 严格解码与完整 JSON/Markdown 解析不变。来源未变时只按原条件恢复 migration_items 的 imported 标记，不读取本来没有消费的当前记忆或旧来源正文；标记已经正确时不新增 owner、pin、正文、事件、版本或 WAL。目录导入等待正式结果，保留来源原文、未知字段、全部 entries、原目录及中断/冲突统计。

真实变化保留原来源 evidence、step_memory_sources 映射、字段来源修改、环节快照及迁移标记的一次 Native 事务。只移除仍由同一来源拥有且新版本已缺席的字段；保留 user 来源、其他导入来源与无来源标记的既有字段，default 来源继续按原规则由导入接管。完整来源字节、当前记忆与来源引用、字段优先级合并、原两个请求意图、索引和固定快照均在 Compute 准备。先暂存来源正文及其真实私有快照，再让后继环节快照引用它；不能提前提交来源、伪造未来回执或用未存在的对象通过检查。环节记忆复用现有 metadata/sourceRefs/body/plan 准备协议，保留实际 CID 相等时的 dataRef、metadata 对象、全局 handoff cursor 及新鲜度规则。来源名称采用真实 SQL 绑定后的值，并按原 SQL 顺序排列；原始名称仍完整保留在请求意图中，更新来源时也按真实 SQL 比较排除旧映射。不为适配接口填造 origin 或其他领域字段。

来源行、当前记忆、字段来源、原请求与实际内容资格在首写前统一复核；构造证明时的真实变化也须重选。首写后真实错误按原图回滚并返回。只为旧导入使用的 saveStepMemoryRevision 正文助手随入口退出；真正构造旧 Native 结算和旧 portable 档案的测试显式安装冻结同步助手，不换成新发布器或多次提前提交。成功、失败、重试与恢复退出本次准备责任；首次来源、未变化、来源更新、用户修改竞争、标记恢复、最后投影失败、固定历史和实际背景导入都须验证。共享历史文件采集及未决来源归档仍按各自生产者整体接齐，不能把本 Store 入口的迁移计作所有历史采集、归档或正式规模门禁已经完成。

Runtime 正常关闭时沿既有 Writer 生命周期控制先中断后台迁移并等待当前文件完成；下一文件继续由原 shouldContinue 边界停止。该等待发生在向 Writer 发出 close、停止其 Compute 和启动原线程退出期限之前，保留当前文件的完整提交与 interrupted 进度，不因关闭计算线程把正在完成的导入改为失败。不增加专用队列或提前提交来源；已退出或已有终态故障的 Writer 仍按原关闭路径清理，等待中发生的真实错误也须在清理线程后返回。

通用历史对象导入的公共入口接入既有迁移来源 FIFO 与现有 Compute/Reader。先按原顺序验证来源身份、读取实际迁移映射与绑定对象元数据，再判定绑定不符、相同来源、数据库较新或本次写入；相同来源仍在原输入写入校验之前返回，并保留原标记 UPDATE 的副作用，不将其误记为纯回执重放或声称原实现 WAL 零写；绑定不符不能因哈希相同被跳过。冲突标记与错误须按原语义保留，不把错误包装成成功。来源更新只在原来源仍拥有当前版本时沿原 after:revision 子键补丁，保留固定历史、旧项目作用域与用户后续修改。

资格只覆盖原操作确实消费的依赖。创建时忽略的目标 objectId 与 expectedRevision 仍进入原全文意图，但不构造额外目标头依赖，也不把创建版本误算为 expectedRevision+1。真实补丁在字段规范化后、进入重试发布前按原顺序读取旧对象完整正文并校验作用域和预期版本；原输入版本错误须直接返回，不能被共享准备助手当作竞争无限重试。字符串列先采用真实 SQL 绑定后的值再生成索引和快照，原始输入继续单独参与原请求哈希。

本次隐式选择的当前引用须绑定真实 Compute 计划观察到的对象头；准备期间来源版本变化或缺失对象后来出现，均须在首写前重新选择。显式固定引用和从已有版本继承的引用继续指向原固定历史，包括原有未解析引用，不因当前对象出现或更新自动改写。引用证明在成功、失败和重选后随本次准备责任释放。

隐式选择通过旧学习来源映射解析时，资格还须覆盖该经验的真实来源绑定及被查询事件的映射，包含映射尚不存在的情况。沿既有对象资格观察器按每片最多128项登记精确映射，最终复核只消费本次观察结果；映射变化触发首写前重选，不扫描整个学习目录，不让无关来源变更反复打断本次导入。新增临时资格与原对象头一并分片释放，不新增持久队列或业务事件。

来源、根请求意图、字段正文、实际历史引用、索引与版本快照均在既有 Compute 准备；复用通用对象准备协议时显式携带真实导入来源，保留原 {input,source} 全文哈希、历史未解析引用的原允许语义与实际 SQL 值。不将导入伪装成普通 write，也不为接口适配填造生产者、回执或未来对象。已有根回执按真实请求选择原结果，照原规则跳过已执行的迁移映射副作用；不新增正文、owner 或业务图。首次写入、来源更新及来源标记仍在同一 Native 事务中提交，首写后错误按原图回滚并返回。

项目注册表首次导入复用已验证的导入准备与发布，稳定来源、完整注册表正文、导入意图和正式项目显示信息在既有 Compute 准备。项目元数据的后续启动上下文补齐基于该次已经准备的项目版本。准备结束后才进入原事务，正式注册表、显示信息、启动上下文捕获及标记继续按原顺序一起提交或回滚。已存在注册表时沿原上下文补齐规则。

已经接受的注册表修改按原请求回执返回该次接受的完整注册表。Reader/Compute 读取固定修订及正文，Native 只复核请求、实际修订映射和正文观察。后续修改依旧保留，重放既有修改不会产生新版本。

首次登记项目继续先完成原身份和位置登记。同一事务标记待同步的确切位置和原逻辑路径，进程重启或准备失败后仍可在原登记入口补齐。已接受注册表中的完整名称、说明及备注由 Reader/Compute 按该位置和当前项目版本生成修改，再通过已有对象写入发布。元数据与标记退出一起提交；注册表或项目头变化时重新选择，位置已经移动时交由新位置完成登记；重复登记沿用既有回执。

恢复首次登记时复核原逻辑路径与物理目录的绑定。未绑定的别名已经改指时，以项目物理目录继续选择。登记期间正式注册表编辑已同步到项目时，同一事务结束该项目的位置待同步状态，保留最新接受的编辑。

普通注册表编辑按原路径顺序同步正式项目元数据。Reader/Compute 准备真实项目的正文、索引和修订。同一批不同路径指向同一项目时，后项基于前项已经准备的实际版本。Native 在原事务中复核项目和路径，按旧顺序提交别名、项目版本和注册表，任一环节失败时保留原先接受的状态。

迁移项目位置时，Reader/Compute 按原位置、目标目录中的正式身份及真实现有设置准备新注册表、项目元数据、自治授权、路径跳转、自动化和日程。准备中的目标位置只用于选择本次会写入的项目，Native 在原事务内先验证并绑定真实位置，再按原顺序发布项目、注册表、授权、工作台状态、自动化及日程。待执行和失败的日程保留完整内容和原发生身份，已运行或完成的发生记录沿原规则保留。任一环节失败时整笔迁移回滚，重试仍复用本次提交的固定输入。

项目自治授权的单项修改和批量撤销使用同一正式设置。Reader/Compute 按提交时的路径与授权版本准备设置和完整回执，保留不改变授权时的原值及撤销时的完整字段。Native 在同一事务中按原顺序提交各设置及根回执。路径、授权版本或正文变化时重新选择，重复请求仍读回原接受版本。

Runtime 停机后，停用服务和撤销自治仍先取得原本地租约，再通过正式 Writer/Reader/Compute 提交。操作结束后退出临时执行域并释放该次运行状态。

历史项目自治文件由 Compute 校验目录身份、解析内容并保留原始捕获。迁移仍以正式库已有授权为准，从同一个设置发布入口导入缺失授权。计算进程中断交由迁移恢复，来源冲突仍按旧文件、条目和正式版本的原判断记录。

历史运行的冲突归档从 Reader 读取实际捕获的完整正文。历史学习评审也从同一只读路径解析已捕获的清单、提案和应用记录，保留原编码检查。Compute 传输中断不改变来源冲突或归档状态。

历史候选的应用结果从真实捕获版本选择。缺少 JSON 版本索引时，Reader/Compute 读取并核对原捕获回执，计算待补索引和匹配正文。Writer 复核同一来源后补齐实际索引与进度。读取失败保持旧错误的事务位置，账本或评审准备中断由原迁移任务报告并重试。

Supervisor 优先提供已接受的内存注册表。需要启动装载、重取或读取固定历史修订时，沿既有控制查询 Reader 读取同一数据库快照，已知版本仍返回原有未变化响应。

启动上下文保留完整的旧设置快照。Reader/Compute 按本次已接受注册表及旧文件的实际导入状态生成上下文补齐，并预备原始捕获与注册表写入。Native 在原事务内先捕获上下文，再应用补齐并关联最终版本。已导入的上下文继续使用原来接受的版本，正式注册表出现或变化时读取真实当前版本后再准备。启动返回落库正文的原字段顺序和完整内容，晚到旧文件与正式版本的比较也由 Reader/Compute 执行。

启动迁移继续使用原始来源身份和迁移标记，真实文件散列、JSON/JSONL 解码与 Telegram 秘密剥离在原 Compute 准备。捕获保留未修改的非秘密原字节，Telegram 持久捕获只含清理后的数据；原有秘密存放流程保持。启动完成信号等待迁移实际结束。 单次运行使用同一 Writer/Compute 路径，启动时先释放用于读取数据库身份的连接。认知设置投影在复核真实扩展设置版本后使用同一设置批发布。已登记的 Telegram 会话来源只在没有新设置绑定时导入，保留原来源捕获与标记顺序，完整会话映射使用同一准备链。

Telegram 启动时根据当前正式绑定准备旧配置，并核对实际捕获的源版本。确实需要导入的状态使用前段实际暂存的设置和修订准备，合并时保留正式绑定及已有会话选择。配置、配置来源标记、状态和状态来源标记保持原顺序在同一事务提交。接受旧绑定时，秘密仍沿原本地路径在 SQLite 事务开始前单独存放。

启动期间 Compute 退出时，沿同一正式入口重做读取、正文准备和实际发布。已提交的来源用原版本和标记继续处理。坏文件仍保留原冲突记录，暂时的计算进程故障由启动恢复处理。

独立交付进程沿原租约和数据库身份启动。取得本地租约后，认知配置从正式数据库的只读连接取得，读取结束即关闭连接；已有运行时持有租约时继续从该运行时查询。请求文件处理和交付仍使用原入口。

宿主设置批量写入在提交时固定完整输入。原请求意图、设置正文、子版本、索引与响应由已存在的 Compute 准备，源事务按原顺序执行权限、每项修订和秘密引用检查。设置批的后项失败回滚前项，重放仍根据原请求回执接受并读取本次真实设置视图。 旧调度发生记录恢复的完整意图和任务正文预先准备，Native 仍先检查实际调度绑定和发生记录，再绑定正文并在原事务内提交。启动导入保留原定义与发生记录一次提交的边界。 调度定义按真实绑定、当前模板和活动发生记录准备；只有实际需要更新的定义、发生记录和停用版本取得正文准备责任。固有的保留日期、索引、设置失效和状态回放仍由 Native 在原事务执行。

同一批日程重复引用一个实际绑定时，按原输入次序沿用前项准备的定义、待执行记录及真实请求键。数值 ID 按既有 SQLite 绑定识别实际日程，根回执与停用判断仍采用原始输入值。第二项与本批前项请求键冲突时，在原请求位置报错并回滚整批。发生记录、定义停用和根回执继续共用原事务。

旧发生记录批量恢复时，Reader/Compute 验证每份已准备的正文，验证保持到原事务消费正文为止。后续准备或启动定义同步期间正文发生变化时，重新准备整个恢复请求。原绑定检查与发生记录写入顺序、已接受请求的固定回执继续有效。

调度同步的批次回执沿原请求持久化。完整调度 ID 列表、回执正文、索引和对象修订由 Compute 准备。Native 按原顺序写入调度和发生记录，随后写入批次证据及回执。任何后项错误回滚之前的调度写入，重放已接受的根请求时仍沿原读取规则。

历史项目 SQLite 的备份和读取沿既有 Compute。先隔离并核对输入文件，再采集一致的读副本。日志和运行索引按原页序读取，增长沿原顺序在同一 Compute 内读取完整快照并准备正式写入，Writer 接收实际发布计划。历史投影错误和导入顺序保持。每次打开读副本都校验该次备份的实际文件身份，完成或失败时沿原入口释放暂存副本。

增长历史报告投影的完整比较和 JSON 编码在同一 Reader/Compute 侧执行。发布前复核对应项目与原查询前缀的新数据，已有不同的正式值继续记为冲突，只有仍然缺失的键进入原 Native 写入。

历史运行索引按原来源优先级对照已接受的索引、关系及归档输出。Reader/Compute 准备完整的记录、关系和用量合并，保留原冲突、未变化和来源判断。Native 确认这些记录和来源仍然有效后，在原事务写入实际索引及它的来源绑定。

正式运行索引同样在 Compute 固定完整记录、文件关系和信号。发布继续使用原索引事务，正式写入保持优先于历史来源。

历史日志导入和正式日志来源补齐由 Reader/Compute 准备完整正文及证据写入。复核对应日志、会话引用和已有证据后，Native 在原事务保留已存在的日志，写入新日志和对应来源。逐页读取同时控制返回的正文总量，单条大日志仍完整保留。

正式日志追加、更新和旧运行编号预留沿同一正文和证据准备链。追加重放仍返回原编号和接受的正文，编号或日志在准备期间变化时重新选择。Native 先写入实际日志，再提交对应证据和来源绑定，失败时整体回滚。

将已有日志关联到另一条步骤时，Native 只保存原关联和首次关联时间。Reader 从已提交的关联读取同一日志的完整正文和会话状态，保留原日志身份及重复关联的返回内容。Compute 退出后恢复这次只读回包，沿用已经写入的实际关联。

旧宿主秘密状态迁移继续核对实际旧指纹和值的版本。Reader/Compute 解释旧字段及重放回执，Native 在一个事务中补齐秘密状态并归档旧字段。已存在的秘密状态保留当前值。归档失败回滚状态写入，迁移的响应沿原顺序投影当前设置视图。

今日安排发布前，由 Reader/Compute 按正式项目注册表、当前路径、路线图版本和学习版本重新计算原资料校验。Native 复核实际读取的事实，仍在写设置的原位置返回资料冲突。已有固定回执继续优先，准备新的资料证明不改变一次请求中反馈检查与设置写入的先后。

今日安排反馈使用真实当前或已保留的决策版本、实际项目选择和完整反馈数据，在 Reader/Compute 准备学习事件。Native 复核决策和项目，在原事务内先发布设置，再写入学习事件。重复反馈保留原请求身份，后项失败回滚设置，原学习事件的相关决策版本仍可追溯。

Pi 时间安排继续由同一调用的执行身份保护。Reader/Compute 使用真实项目位置、扩展设置、专注提醒和调度版本生成本次设置修改及调度意图。Native 在原栅栏事务内先写设置，再同步调度和发生记录，离开事务前复核执行身份。任何后项故障回滚整次安排。准备期间如果相关设置、调度版本或生效时间窗口变化，用同一提交输入重新准备。组合操作即使遇到既有同步回执，也要核对自己取得的调度版本。

调度领取保留原到期顺序及整批事务。Reader/Compute 根据实际候选正文准备完整领取结果，Native 在写前复核当前候选及正文。每项先写原租约，再消费该项的正文校验结果。后项正文失败时整批回滚，较早的真实租约写入失败仍优先返回。调用未指定时钟时，按最终事务的实际时间核对候选和写入租约。

调度结算继续先核定原发生记录和租约。Reader/Compute 从正式任务定义准备下一次的计划版本及完整模板，仍按原时区和日期生成。Native 在同一事务中写结算、更新调度并建立下一发生记录；完成一次性任务保持原行为，原固定请求仍返回已经接受的结算。后项故障回滚结算及下一发生记录。

公共 importObject 接入后，目录记忆导入与直接调用方等待实际完成。仍在旧同步复合事务中使用导入内核的学习、报告、注册表、分析和归档生产者继续按各自完整图接齐，不能在旧事务内 await，也不能提前提交子对象；公共入口迁移不等于这些复合旧路径已经退出。通用准备协议新增的来源信息默认缺席，普通写入及既有生产者的哈希、权限、引用和重放行为保持原合同。共享文件读取、哈希、结构化映射、未决归档与进度正文仍须整体退出，不能把单个对象导入的接入算作整条目录链和正式规模门禁完成。

分析与策略状态的历史导入沿同一来源发布协议准备实际 setting；Compute 先完整读取并解析原当前状态，再检查该来源是否拥有当前选择，最后编码本次固定数据并准备原完整导入意图。分析参数校验保持原最先执行；候选值的生成与归一化属于提交前阶段，进入数据链后的已有数据库选择、旧正文、来源及数据编码仍保持原顺序。相同来源也保留原当前状态读取和本次 JSON 编码。Source 通过现有 namespace/owner/key 索引检查实际选择（包括缺席）及其正文映射，不能因准备期间出现用户选择而覆盖，也不能因对象版本未变而忽略旧正文 CID 变化。

按 2026-11-16 用户确认，写入以提交时固定数据快照为合同。生成与 JSON 语义归一化在首次等待、排队及数据库选择之前一次完成，随后只传递本次私有数据；等待、重新选择、重试及最终提交都使用同一快照。普通生产者继续提交既有 JSON 数据，无需附加操作。完整 JSON 编码、hash、索引与正文快照仍由 Compute 完成。

输入复制保留原数组长度、空位和元素位置；不得把稀疏数组尾部截短，也不得提前在 Source 编码 JSON 来补偿复制差异。JSON 可见的索引值（包括继承值与不可枚举索引）在生成阶段取得，命名属性不属于数组 JSON 范围。该阶段的 getter 与编码方法按真实 receiver 和 key 执行一次；最终 JSON、固定历史与原全文意图 hash 保持对本次生成数据的原编码语义。

状态值中的实际 Buffer 在复制时只登记对应字节副本的类型身份，随同一私有准备请求传递真实对象引用；Compute 按这些身份执行原 Buffer JSON 编码。真正的 Uint8Array 与 Date 继续保留各自原 JSON 语义，不能因跨线程后表示相似而统一改成 Buffer，也不能在 Source 先展开全部字节或预编码全文。实例将原生编码方法遮蔽为非函数时，按原 JSON 的普通自有字段语义复制，不能恢复默认编码；Buffer 字节及这些普通可变字段仍在首次等待前取得副本。类型身份只服务本次准备，不进入业务字段、原意图 hash 或持久队列。

状态值的复制按完整 JSON 可见图递归处理：类实例、Error 及其他普通容器的可枚举自有字段都要保留并继续发现内部 Buffer，不能把整段非普通对象当成不可见叶子。Date、数值包装对象和原生字节视图按其真实 JSON 叶值语义处理，Map/Set/RegExp 等容器只复制原 JSON 确实消费的自有字段；状态值与控制头分开复制，不能把状态值的 JSON 转换规则用于原 source 意图。原始 JSON 编码仍只在 Compute 执行。

数值型视图的索引字节保持原副本，只另外复制原 JSON 可见的命名自有字段，并随实际视图引用传入 Compute；非规范索引名、字段中的 Buffer、重复引用与循环均须保留原语义。Compute 才展开索引数据和附加字段用于 JSON 编码；准备责任结束后退出这些临时引用。命名字段发现的输入占用和耗时须计入正式资源验收，功能保真不能代替预算核验。

输入快照不得继续共享调用方可修改的内存。SharedArrayBuffer 支撑的字节视图须在首次等待前取得本次私有字节副本，保留原视图的数值解释和可见字段；调用方随后修改共享区不改变本次正文、历史或意图 hash。该规则同样适用于共用输入复制助手的普通写入，不能只保护状态导入。

原生 raw JSON 值须保留实际类型身份与原字面量，由 Compute 恢复其原生编码；数值写法、字符串转义和解析后的逻辑值均与 Native 一致。普通同名属性对象不授予该身份，不能把字面量悄悄改写为包装对象或规范化数值后再计算原意图 hash。

输入自带编码钩子时，先由现有 Reader 完整读取当前状态并检查既有数据库选择，Source 资格成立后才在原接收者上执行钩子，保留根与嵌套 key 和原返回值。钩子的返回图取得本次输入快照后交给原 Compute 编码；相同来源仍执行原编码步骤，已有选择或坏当前正文不得提前触发输入钩子。数组按开始编码时的长度逐项取值，保留取值时可见的继承元素；钩子追加元素不扩大本次范围，缩短数组后缺席的位置仍按原语义编码为 null。不调用钩子来猜测未来业务对象，不在 Source 预编码完整 JSON，也不为编码增加 Writer 或持久队列。

实际状态、来源映射、原回执和来源标记仍在一次 Native 事务内发布。状态导入的原外层事务会回滚冲突标记，这一点与通用独立导入的冲突标记提交不同，须分别保留；不得把两者的错误副作用混同。成功、重选与失败释放本次资格，目录导入调用方等待实际结果后更新进度。日常分析/策略保存及刷新复合图尚须单独接齐，不能把历史状态导入的接入计为日常写入内核已经退出。

日常分析和策略保存继续使用原正式操作、请求键与 setting 版本。既有 Reader 按原顺序完整读取当前状态、检查原请求是否已经存在、检查本次实际生效的来源和版本条件，再编码本次值并准备原完整写入意图。原请求重试仍跳过原本不再生效的来源与版本前置条件，但写入意图必须从这次实际选择的对象构建；不得拿历史对象替代当前选择来制造成功重放。分析与策略在当前对象缺席时的不同错误顺序分别保留。

来源资格只观察真正消费的关系数据：分析保存使用实际项目对话计数版本；策略保存使用原全局学习集合和原排序去重后的项目偏好选择、运行索引版本。全文来源算法与哈希在既有 Compute 执行，Source 不重新扫描和哈希学习全集。实际项目计数、已有偏好头、缺席选择和全局集合成员变更通过既有临时资格机制复核，分批登记、释放；项目计数行的键迁移同时使旧项目和新项目的资格失效，不能只看计数列是否变化。不能用新时间戳、假定未来对象或重建的摘要代替原来源。相同请求已存在而忽略的条件不得继续成为发布依赖。

本次正文、索引、请求意图、快照及返回值在既有 Compute 准备。返回的旧请求结果必须读取原回执对应的真实固定版本；新写结果来自实际准备正文，不能把输入值直接当成存储后的结果。Compute 对解析后的返回值准备原 JSON 响应片段；Source 仅以真实已接受回执的少量标量组装既有序列化缓存，不在真正 Writer 返回时重新编码整份值，也不能直接拿原文 raw JSON 字面量冒充解析后的返回值。Source 在原调用权限和 Pi 工具围栏内完成一次最终 Native 提交，首写后的错误照原事务回滚，不改为重试。覆盖率、迁移与所有直接调用方须等待写入完成后再返回或关闭。

覆盖率保存的当前版本由原发布串行入口内的既有 Reader 从真实当前状态选择，不能让 Source 为取版本号先读整份旧正文，也不能在进入发布队列前固定自动版本而制造原同步调用没有的冲突。覆盖率计算、原失败时保留的完整旧字段和本次保存沿原链路完成；返回使用实际已保存值的既有 Compute 响应缓存，不能保存后再把大快照交回 Writer 全文编码。调用方仍使用原覆盖率操作和结果结构，最终权限围栏保持同一条。

外部刷新预留、外部缓存接受、增长刷新预留及增长阶段发布按各自原完整事务图接入。预留代次、接受条件、增长快照、来源状态、原结果请求和实时索引的先后及原子性都须保留；不能在同步旧事务中等待新公共保存接口，也不能提前提交子状态。过渡期只允许尚未整体迁移的原组合调用继续使用明确的私有内核；最后一个真实组合调用迁移并验证后删除内核，以实际调用链清空作为退出证据。正式规模、前台并发、资源成本和关闭重开仍单独验收。

增长刷新预留先按原预留请求查固定回执：已提交请求从真实固定版本读取并校验项目、命名空间、键和请求身份，再返回原代次；该分支不读取也不覆盖较新的当前预留。未提交请求保持原 pending 错误顺序。只有确无原预留回执时，才读取当前预留并构造本次实际子意图，不能套用外部刷新重试时按当前版本报冲突的规则。增长阶段发布与历史增长导入继续各自保留原完整图，预留的局部迁移不代表增长旧内核已经退出。

增长阶段准备以 Source 实际 TEMP 暂存头和行作为输入，不能用 Compute 原扫描副本替代；按页交接时必须保持该暂存身份和变更资格。原清单、数量、顺序、父子图与引用校验仍先于结果请求重放；重放之后才按原顺序读取预留、最新增长快照，以及确实需要写入时的来源状态。完整正文解析、规范化、哈希和对象准备进入既有 Compute；Source 最终保留同一原子图中的原结果请求、增长快照、实时拓扑轮换、来源状态和结果完成记录。后序准备错误不能抢到原本更早的真实 Native 写错误之前；不能以试写回滚规划业务图，也不能在准备时提前提交任何子状态。暂存变化、同键并发、重放、首写失败、最终权限和关闭清理均属于同轮验证。此段定义剩余迁移合同，不表示阶段旧链已经退出。

阶段校验在既有 Compute 内只建立保存实际暂存原始行的私有内存 SQLite 表，以复用原 SQL 的 JSON、NULL、数值和排序语义；不创建权威对象、请求或内容表，不试跑最终业务事务。Source 每页最多交接128行，以实际 ordinal 继续读取，跨页变更使本次准备退出重选；大整数 ordinal 交接保留 SQLite 原值，不经过 JavaScript 精度截断。内存校验表在该调用完成、失效或失败后关闭。128行只是行数上界，不能替代正文大小、消息复制、原扫描副本、校验副本与准备内容的累计内存及峰值成本测量。

增长暂存输入的开始、追加和丢弃复用既有发布串行机制，按同一实际 stage 身份保持调用顺序；调用方完整等待每一步，不能让丢弃后又落入较早的等待写入。提交前固定实际清单和分页数据，完整规范编码在既有 Compute 完成。Source 只消费编码结果，保留原清单替换的两次删除及插入、原分页逐条插入的各自单一事务；稀疏页保持原 forEach 实际索引。Compute 返回首个编码错误之前的真实前缀与错误相位，Source 在原位置抛出该错误，不能让后项编码错误抢到更早的实际 Native SQL 错误之前，也不自动重试该写入。

输入快照保留原 forEach 与规范编码中 Array.map 实际消费的数组槽位，包括非枚举自有索引和继承索引；清单与条目中的嵌套数组遵循同一规则。按初始长度逐项检查属性存在后取得值，缺席槽位仍保留为缺席，不能只复制 Object.entries 可见的索引而成功少写正文。此行为仅用于本输入快照，不改变其他既有快照调用方的合同。

Runtime 从清单准备成功起即进入同一退出范围；开始失败、追加失败、正式提交失败和成功都等待 Source 暂存退出，Compute 扫描副本清理在 finally 中独立执行。暂存删除失败登记真实 stage 的临时退出债务，由既有 Cold 量子独立清空；不能假报 pending=false，也不能让旧退出债务误删同一身份后来合法重新开始的暂存。不新增业务队列、执行器、持久对象或额外资源席位，输入复制、编码结果、TEMP 与原扫描副本的累计占用纳入原正式资源门。

Cold 的 pending 在返回时还须检查等待计算批次期间新出现的暂存退出债务；不能只用进入计算之前的退出检查结果。合法重用身份按同一串行入口使旧退出责任失效，排队中的旧清理也须核对其仍是当前责任后再删除。

阶段 proof 或 Compute 捕获释放失败时，登记本调用的临时退出债务，由既有 Cold 量子继续清退并反映 pending；不能只写日志，也不能依赖下一次增长任务触发退出。恢复后既有维护链必须能独立清空债务。释放须可重复，Compute 私有副本实际关闭后才从其索引退出；退出故障不得覆盖已经成立的业务结果或更早的业务错误。此处复用原维护执行域，不增加业务队列或额外执行器。

来源归档须将单源与组合归档一起迁移：组合的排序去重、逐源完整性校验、每份原文的证据、组合清单及所有来源标记仍是原同一事务，不能分别调用异步单源发布器提前提交。证据继续绑定实际已捕获原文 CID、捕获版本与原 MIME/编码，保留带原绑定的幂等意图；不重新编码原文替换其身份。组合清单中的证据引用只能由本图实际准备身份及私有快照取证，最终须核对真实子回执，不能伪造未来对象或回执。后序缺失、绑定冲突、正文错误仍保持原逐步先后，更早的真实 Native 写失败优先；完整图失败须回滚证据、来源映射和退出标记。所有文件退役调用方须等待同一真实归档结果后再推进原退出流程。

组合保留原始键的排序、去重及清单内容，同时按实际 SQLite 参数绑定后的来源键识别本图内的同一绑定。不同原始键落到同一个实际键时，后项引用本图前项的真实准备身份，最终只在前项已经提交后读取实际绑定与回执并执行原 unchanged 标记；不得重复创建、重复更新，也不得提前伪造未来映射或回执。首次创建和已有来源更新都须验证原子图大小、真实对象版本和清单 hash，不能通过收窄原始键字符集绕开问题。

更新已有归档时仍须消费原 Native 在替换前读取的完整旧正文，并将正文与同一读取快照的实际身份纳入核验；不能因为新绑定将覆盖该字段，就跳过旧正文损坏错误。读取由只读准备域完成，错误留在原实际请求首写之后的相位；原 unchanged 与固定请求重放没有消费旧正文时继续跳过，既不扩大读取，也不把后序正文错误提前到真实 Native 首写错误之前。

归档准备保留原证据写入中宿主观察权限先于旧正文消费的顺序，并把实际 actor 是否为 MCP 的判定维持到最终提交；未变化与请求重放不额外消费这项判定。字段或后序发布准备失败仍在原对应子项的真实请求首写后返回，不提前掩盖更早 Native SQL 错误，也不执行失败子项的多余正文发布。失败后的原单事务回滚与私有准备退出保持同一闭环。

历史复盘游标导入单独沿原来源身份串行发布，调用方等待完整结果。Compute 解析本次固定原始字节，按原顺序还原 hash-only deferred source、验证完整原文与历史版本及项目范围，再准备实际 setting；原字节文本、BOM、完整导入意图与固定历史均不改写。相同来源也先完成原解析和验证，不能以 unchanged 提前跳过。

游标采用真实已固定的 legacy cursor input，其次才读取原控制映射；实际两类映射的存在与缺席、run key、input CID、所消费的内容及对象头一直核验到原生提交。准备错误绑定实际读取视图，正文或映射变化须重选，不能把旧读取失败直接归为当前结果。Source 不全文解析或重建游标及原清单。

setting 的原导入、可选 cursor input 的 INSERT OR IGNORE 和末尾来源标记仍在原同一 Native 事务。实际游标 ID 和版本从本事务真实回执或真实绑定取得，不伪造未来对象或回执；未变化分支也保留原必需标记与元数据读取。前置解析错误仍先于写入，后续字段或正文准备错误留在原 mutation 相位，不能盖过更早的真实 Native 请求 SQL 错误；该写错误不自动重试。私有正文、证明与 pin 同轮退出，原同步组合内核只在全部组合调用迁移后退休。

学习事件来源导入保留原来源证据、证据来源绑定检查和学习事件导入的同一 Native 事务，不能提前提交证据。原始字节哈希、UTF 文本、两项完整意图、旧正文与引用准备均由既有 Compute 完成；未变化和固定请求分支只消费原来实际需要的映射、正文与固定版本。事件的 source_object_id/source_revision 继续按原真实证据回执优先、来源绑定其次取得。

未变化或固定请求分支不建立没有实际发布内容的 preparation owner；只有证据或事件确实需要私有内容发布时才进入既有责任域，单图责任保持到最终事务与退出。首次创建 owner 的额外写入次数也纳入资源回归，不能以最终 owner 表为空掩盖重复调用的无用创建。

每个实际导入相位在 Reader 准备前登记真实来源行和原对象头的既有观察证明；失败读也持有这份观察。来源或实体在准备、重读及最终资格期间变化时重选，避免把已恢复的缺失实体当成当前失败。只有尚未开始真实业务 Native 写时允许重选；原请求 SQL 已开始后不重试。

证据新增或更新时，先完成真实私有物理快照，再取该发布结果的实际对象 ID 与版本；未变化及固定请求分支从原真实绑定或原回执取得标量。当前 learning_event 的 source_object_id/source_revision 不经过 lesson 的固定引用解析，不额外读取原路径没有消费的证据历史正文，也不为此扩展通用 pending reference 机制。不能造未来业务对象或数据库映射。Native 先写证据并核对真实回执，再查询真实绑定，最后写事件；后项字段或正文错误不得抢到更早证据 SQL 错误之前，全图失败回滚并退出私有责任。

学习决策来源入口在提交前固定字节、来源描述及数据；排队键也只使用已捕获的来源身份，不再次调用来源属性。随后先按原顺序校验完整原始字节哈希，再检查物理来源的已导入固定决策；该固定分支保留原历史版本、类型与项目验证，跳过本次未消费的事件、候选及新字段。实际新导入才依次选择真实事件映射、全部候选经验映射与版本，以及逻辑决策的当前版本、来源时间与副本身份。只读准备不得通过伪造未来映射跳过这些判断。

证据导入、真实证据绑定读取、决策导入、物理来源指针回写与来源标记仍在原同一 Native 事务。完整字节哈希、UTF 文本、字段、意图、候选验证和正文索引进入既有 Compute，Source 保留实际标量、证明及原事务写入。证据重放与事件入口的绑定要求并不相同，必须保留原短路消费：真实回执可直接提供来源指针时，不额外强制原本没有读取的绑定字段。

候选经验的固定版本验证遵循原 readMetadata 的实际选择：请求版本等于当前版本时使用真实当前元数据，不强制读取该分支原先跳过的历史快照；请求历史版本时读取并证明实际历史快照。准备期间版本变化后重新选择原读取分支，不能读取损坏的未消费快照制造新失败，也不能用旧头元数据代替确实要消费的历史版本。实际来源、事件及候选映射的存在性和版本在准备到 Native 提交期间均保持资格；后项字段或引用错误留在其原 mutation 相位，不能掩盖更早的真实证据写入错误。整图成功、失败及未变化责任均在同轮退出。

原决策先在字段阶段校验首个候选，再在实际对象与决策行写入后校验完整候选及旧决策版本；两种消费相位分别保留。准备期发现后者的引用错误时，保存错误及已规范化的 SQL 标量；最终事务仍执行原真实 Native 请求与实体写入前缀，再在原引用校验位置返回错误。这里没有试写回滚式计划器、没有未来业务对象或伪造映射；失败前缀只沿原事务实际执行一次，随原错误整体回滚。这样真实决策行 SQL 错误仍先于后续候选历史正文错误，Source 也不为失败分支重做完整 JSON、哈希或正文准备。

学习经验来源入口保留原事件 ID 解析和真实映射、经验来源绑定与物理来源判断顺序，再按原分支处理来源捕获。非相同来源的当前版本、来源时间和副本冲突检查仍先于捕获；相同来源分支先捕获原始字节，再读取当前经验及合并此前未解析的事件。原始 JSON 的字节版本、语义版本、捕获请求与事件、经验写入、可选事件补齐及最终经验绑定都留在原同一 Native 事务。

完整来源哈希、JSON 语义哈希、事件列表解析、完整意图、引用和正文准备移入既有 Compute。准备不伪造捕获后的未来 migration 行；原真实缺席或无对象绑定的来源在捕获后的分支等价性由实际选择记录和最终 Native 写入保证。捕获前、捕获内容阶段、捕获后的元数据读取、字段阶段和实体写入后的完整引用阶段分别保存原失败位置。只读准备或物理内容准备失败，不能抢过原更早的捕获 SQL、来源分类 SQL或经验行 SQL；实际 Native 前缀只执行一次，并与全部业务效果一同回滚。

新物理副本可能尚无对象绑定，但仍按真实经验绑定更新已存在的对象。此分支也必须在实际对象头被读取的同一视图捕获元数据签名；不能只携带版本，再让资格检查因缺签名反复重选。额外签名仅在该来源入口已要求 observeMetadata 时建立，其他导入默认路径不变。

实际引用字段准备前，为本次真实映射及当前经验已固定的事件登记既有头与实体观察，包括头存在但实体暂缺的情况。资格期间恢复真实事件实体时重选，不能把旧的 entity_missing 延后带进已经恢复的 Native 图；这里仅读取真实引用标量及当前索引，不提前消费原分支未读的事件历史正文。

同字节来源补齐事件时，只替换原来 objectId 为空的条目，保留已固定的事件版本、当前用户编辑及其余数据。若当前经验仍属于来源导入版本，补齐后更新原来源指针与经验绑定版本；否则只补齐当前经验，保留来源导入指针与版本。此时用于意图哈希及来源回写的 source 与用于历史引用验证的 importedSource 继续分开，不能因哈希分支省略后者而增加原本没有的映射限制。未变化调用仍校验和消费原来实际需要的输入、捕获回执与当前经验，不强制读取原分支跳过的历史快照。

历史报告任务入口在提交前固定来源描述、原始字节与任务数据，调用方等待完整发布后再导入报告。完整原始哈希、会话及任务意图、正文、执行身份 JSON 合并与预览由既有 Compute 准备；Source 只持有实际来源行、旧任务绑定、对象头、请求与内容证明。新会话先完成真实私有发布快照，任务再使用该实际对象身份，不伪造未来对象、绑定或回执。当前任务已经存在时沿原元数据读取取得会话，不额外消费原路径跳过的历史正文。

固定会话请求只核验其实际请求与回执，不提前完整读取原重放分支未消费的当前会话实体。后继任务仍在原 SQL 位置校验真实引用；当前实体缺席不能抢过原本更早的任务 pending SQL 错误。旧执行身份 JSON 仅由 Reader/Compute 消费，Source 用紧凑绑定与既有实体观察保护其变化，不把整份旧 JSON 读回 Source 作比较。

原始来源捕获、可选会话写入、任务导入、执行身份合并及报告来源代次更新仍在原同一 Native 事务。原始哈希错误先于捕获；来源绑定冲突、后项字段和执行身份错误各在原位置返回，更早的真实捕获、会话或任务 SQL 错误仍优先；首次真实写错不重试。未变化任务仍执行原捕获与执行身份合并，保留用户编辑、已登记执行与完整历史。准备阶段变化只重选真实当前状态，成功、重放、失败与取消都在同轮退出私有内容、证明和准备责任；不拆成提前提交的子任务。

历史报告导入与历史运行接管共用可组合的准备和发布步骤。直接报告导入等待完整结果；接管中的未登记任务、执行身份补齐及报告导入仍属于接管的原同一 Native 事务，不能把这些子项改成提前提交的公共异步调用。接管在提交前固定完整状态、绑定、提示词、命令、输出、文档及报告来源；不新增最终用户需要理解的入口或配置。

未登记任务先按原顺序选择实际别名与来源绑定，再准备会话和任务。完整原始需求、各子请求意图、字段、索引和版本快照由 Compute 生成；Native 在父事务中的原位置发布这两个子项。后继任务只能使用真实准备的会话身份或原固定请求回执；已有子请求不强行读取它当前可能已缺席的会话实体，也不为固定重放新增持久准备责任。别名校验与登记 SQL 仍在两个子写之后，后续运行或报告失败必须同时回滚整个任务图。

已有未登记任务的执行身份合并须先登记实际任务与登记实体的观察，再由 Reader/Compute 读取完整 JSON 并沿原逻辑补齐、排序和编码。Source 只接收实际需写回的编码及后继消费所需的匹配结果；未变化时不回传整段旧 JSON。合并错误仍位于报告之前，后续身份匹配错误仍位于报告之后，并与原项目日志 SQL 交错消费；不得以提前验证后项匹配来改变首错。新任务登记值来源于本图真实准备的任务身份和固定来源事实，作为待发布操作传递，不冒充数据库中已经存在的登记行。

报告按原顺序捕获来源、校验已登记执行、选择或准备真实轮次、登记轮次映射、检查实际来源绑定、导入报告并回写实际捕获版本。完整原始哈希、执行身份 JSON、完整报告意图、正文、索引和来源时间在既有 Compute 准备。轮次已经由本图准备时，后继报告只消费该实际私有快照与原生基线证明；不捏造未来轮次行、来源行或已提交回执。相同来源仍执行原有捕获和身份校验，固定请求仍返回原历史结果。不同报告并发创建同一任务的轮次时，必须按真实映射、任务轮次序号及已消费对象重新选择，不能发布过时序号。

接管准备保留原先的分支及消费顺序：状态来源一致性、可选任务和报告图、执行与项目日志身份、物理位置、原生绑定、输出及转录来源、旧完成决策、追加输出和刷新产物、已有运行或首次创建。完整 JSON、哈希、字节比较、日志前缀比对、绑定前缀、文档及报告投影留在 Compute。Source 只登记实际控制行、来源地址、对象头、实体、映射及物理内容证明，并在首次 Native 写之前统一复核。缺席实体在准备期间恢复、来源被替换或执行身份仅更新 JSON 时，也必须失效重选。

外层历史迁移也使用同一计算队列读取和哈希稳定文件、解释历史 JSON、扫描已登记任务并校验归档前缀。文件检查仍绑定本次读取的真实字节，归档前缀从同一个只读事务内取值，后续正式接管继续验证实际接纳的来源。仅需要校验散列或计量时只返回散列与长度。计算队列退出等传输故障进入原迁移任务失败与重试路径，不登记为来源损坏或历史运行失败。原始文件和冲突回执保留。

历史运行摘要先沿原步骤完整捕获来源。Reader/Compute 根据本次捕获的真实内容解释摘要、生成检索词和版本快照，以及准备来源指针的版本。Native 复核捕获回执、来源指针、固定请求和正文证明，在原事务中发布摘要、信号、指针、历史关系和导入标记。相同散列仍只推进当前捕获的导入标记。被更新捕获取代的任务沿原失败重试流程运行，保留新捕获及其进度。索引回填继续在摘要发布后执行。候选扫描与最终健康汇总由 Reader/Compute 执行，Source 只登记实际候选的绑定、摘要和归档地址，再按主键核对当前索引替换资格。原生索引抢先提交时舍弃相应过期候选及其读取错误。保留原有来源优先级和统计口径。

输出、原生转录与旧完成状态来源的完整读取、JSON 解释及逐字节核对由 Reader/Compute 完成。来源地址须在读取前观察，缺席内容恢复与实际来源变化均撤销资格。来源若由本图更早的报告捕获，后继只消费该次真实私有捕获 CID，不能误读尚未提交的旧来源正文或伪造已提交来源行。来源错误仍在原 Native 消费位置抛出，更早的任务、报告、项目日志、位置或绑定错误优先；准备与验证不得把后项来源错误提前到这些动作之前。

追加输出与刷新证据的校验沿用同一只读准备入口：原归档产物、实际捕获来源、正式日志的连续字节前缀及上一来源意图由 Reader/Compute 核对。Source 只持有归档长度、哈希、类型、真实日志行及核对结果，不接收旧归档全文。产物地址和运行日志在读取前登记观察，包含缺席后恢复及变更后恢复原值；正文继续取得实际物理内容证明。追加与刷新错误在原哈希校验之后、已有运行分支之前消费，正式日志核对错误仍在原已有运行分支消费，不能覆盖此前的错误。这里迁移的是校验，产物写入、文档修订及运行最终快照仍须一并接齐才能退出整个生产者。

没有追加来源且刷新列表为空时不触发这一步准备。多段正式日志的内容相位用身份映射记录；逐次等待后使用已有分组脏索引复核，发布前再完整复核各观察仍存在且有效，避免随日志段数反复扫描已登记的全部证明。所有临时观察仍按原有界批次退出，不引入持久责任或新的后台频率。

已有运行分别保留追加输出、补录完成状态、已接受输出来源重读、轮次时间补齐及消费队列修复的原语义。首次接管保留任务和会话身份、原轮次及项目日志关联、完整提示词与命令、输出和原生转录、逐版本绑定证据、工作区文档、报告关联、控制历史、消费源及最终迁移标记的整体发布。更新产物和文档时仍使用真实旧版本；原完成状态归一条件、用户后续修改和历史来源版本不得放宽。 迟到完成附件只有在真实旧来源意图匹配且尚无完成来源时才补录；基础来源意图、完整控制元数据、运行搜索及版本快照和最终状态在既有 Compute 准备。 状态选择先只携带运行身份和已有摘要；未变化或已经附上完成来源时不重复传递完整状态与绑定上下文。确实进入基础意图核对后，再按原消费位置读取已观察的真实元数据并核对完整上下文。第一版且当前状态仍与历史输入一致时才应用原完成归一，并沿原条件推进消费源；后续正式状态只附上来源，不覆盖其状态或消费队列。固定回执、原请求首错、归一状态 SQL、控制历史和消费源 SQL 保留原消费顺序。已接受的旧输出来源重读由真实状态先选择；仅在原状态来源和输出地址符合原条件时，才在既有 Reader/Compute 读取正式日志并核对旧来源意图。读取前观察日志地址与实际内容，新增、删除、修改和改后恢复均撤销资格。正式日志位置按每批最多 128 条登记，批间让行，提交前检查同一组的变更记录。接受后仍只推进原来源标记，保留旧正式日志、原运行版本和状态，不建立正文准备责任；核对失败保持原冲突或原读取错误位置。未变化来源的轮次时间补齐也沿既有 Reader/Compute 准备：只消费实际旧映射或本图真实报告建立的私有映射，并在读取前观察实际项目、任务、执行和轮次序号的映射，以及轮次实体和正文。故障时，已存在的固定回执在原重放位置返回错误，缺失或损坏的旧轮次正文在原轮次更新前返回错误。只补原来的空时间，保留非空冲突、固定请求回执、完整请求正文、索引和版本快照；补齐仍在原父事务位置执行，保持运行版本与返回状态不变。无补齐、前置冲突和固定重放不新增正文准备责任；实际新补齐沿既有责任准备并在本轮退出。原来只修复消费队列的分支不能制造新运行版本。Reader 选择实际已接受的完整状态，Native 仍在轮次补齐之后查询并修复实际消费队列，写入来源标记后再根据原分支返回。修复只改变队列和返回的 unchanged 标记，外层迁移按该标记推进，并不另行编码或传输整份返回正文。 已有运行的追加准备须覆盖真实旧状态、正式日志前缀、归档原 MIME、各刷新产物及文档、日志新增尾段、最终控制元数据、搜索和运行版本，再在原同一事务内发布。已有运行的只读选择、未变化返回与追加最终投影必须在读取前观察其真实运行控制、运行实体、元数据正文、当前轮次的项目日志映射及唯一任务别名。观察须覆盖实际读取的键；只有对象版本或正文证明不足以约束关联行和未增版本的实体更新，改后恢复原值同样撤销资格。无追加产物时也不能跳过状态依赖；所有复核仍在原 Native 首写前完成。只读状态选择不建立内容责任；只有原请求确实消费新的写入图时才取得既有准备责任。固定回执、未变化和前置拒绝不能为了准备未消费的后项正文而新增 owner，后项准备错误仍在原产物、文档、尾段、元数据或最终快照的位置消费。 状态读取、请求准备和只读证明的传输失败也要保留原图中更早的真实任务、报告和请求 SQL，不能绕过这些前缀直接在准备层退出；实际资格变化继续在发布前重选。

首次创建的准备按原消费顺序组合轮次及时间补齐、运行原文与初始控制、项目日志来源、逐版本绑定证据、文档、报告关联和最终运行投影。后继步骤只读取前序真实私有快照或真实固定回执；私有运行控制复用既有文档投影准备协议，不冒充已经提交的运行。完整字段编码、绑定前缀、日志来源正文、搜索索引、控制元数据及版本快照在既有 Compute 完成。 首次创建同时刷新归档产物时，按归档原 MIME 单独准备完整字节及原哈希，不能因正文相同就复用另一 MIME 的日志 CID；原路径和类型校验、准备失败仍在原产物写入位置消费，Native 只绑定本轮真实私有内容。Native 仍逐项执行原业务 SQL 并一次提交，后项字段、索引、快照或投影失败不能覆盖更早的真实 SQL。父运行需要首次写入时，其真实正文可取得现有准备责任；已重放的会话和任务本身仍不建立新的准备责任，整图未变化时不为运行正文建立责任。

准备错误在原 Native 图的消费位置抛出；更早的真实 SQL、请求 pending、映射、字段或引用错误优先，首个实际写错后不重试。字段准备、索引准备与快照暂存的失败位置分别保留：后项快照失败不得以只执行请求 pending 的方式抢过原业务 SQL 和索引 SQL；可用的真实字段及发布计划继续执行原 Native 前缀，再在原位置返回失败，不能退回 Source 计算完整正文来构造前缀。最终返回需要的完整运行投影也须在发布前准备并验证，不能提交成功后才发现原事务内应回滚的投影错误。成功、未变化、固定重放、失败、重选及关闭均退出本轮内容 owner、pin、观察与证明；物理原文件保持不变。 历史接管的同一准备责任可能覆盖多份报告和父运行，返回前沿既有清理方法分批排空；每批仍最多处理 64 项，批间让出执行权，不新增后台任务或频率，也不因图变大而遗留本轮临时责任。原始实现及依赖须先冻结为逐字 Native 对照；实际目录导入、接管各分支、错误优先级、并发与关闭、完整内容和责任退出全部验证后，才退出这一族旧同步路径。此段是实施合同，不是已经完成的证明。

旧学习审查批次按原完整图接齐：先处理清单及应用游标中实际消费的完整来源正文和嵌套历史，再选择批次导入；批次未变化时仍完成原先必做的来源处理与文件标记，并跳过未消费的目标和凭据图。新批次或来源更新保留真实批次控制、各历史目标、应用记录、物理凭据、批次关联及最终导入版本回写，全部在原同一 Native 事务内发布。导入仅保留历史，不激活旧策略、旧记忆或旧经验；原本需要归档的历史目标仍在应用记录之前归档。

来源正文、完整清单与应用 JSON、全文意图、目标证明哈希、字段、索引和各固定版本在既有 Compute 准备。后续步骤使用实际私有内容和版本证明读取本图已准备的结果，不伪造未来业务对象、请求回执或 migration 行，也不试写回滚来计算计划。真实来源绑定、对象选择、物理凭据内容及请求在原消费阶段建立资格；变更发生在 Native 发布前则重新选择。来源校验、原导入冲突、后项字段或引用失败、凭据哈希变化及关联错误保留原位置，更早的真实 Native SQL 错误不能被后项准备错误覆盖，原事务实际前缀只执行一次并整体回滚。

同一批次中的目标和凭据重用按实际已准备的私有版本与来源证明推导，不新增可见中间提交，也不把旧历史版本当作当前选择。批次与凭据关联产生的真实版本变化须同步进入最后的导入版本回写，保证后续来源更新仍可推进。导入调用方等待完整图完成后才更新迁移进度或关闭；成功、未变化、失败和重新选择都退出本轮私有内容、资格与临时责任。

来源值的标准 Buffer 保留原 JSON 类型身份和私有字节，不能在固定快照或线程传递后按普通 Uint8Array 编码，导致原合法声明哈希失配。身份提示必须与实际私有叶值一起传递，并仅由 Compute 恢复原编码；清单原哈希、完整来源正文及保存内容使用同一身份，真正的 Uint8Array 保持其原编码。不得在 Source 展开字节、预编码完整 JSON 或改写声明哈希来补偿。

本图中的来源地址按真实 SQLite 参数绑定后的身份与键相等性判断；私有导入映射和原来源选择校验必须共用这一地址，不能因 JavaScript 字符串不同而把数据库中的同一来源拆成多个业务对象。原输入字符串仍参与原意图和来源哈希，不能为了地址归一而改写用户输入、请求键或已保存正文。

合法深层 JSON 不能因为新加入的快照或线程边界而更早失败或永久等待。该入口的普通容器快照使用显式工作栈，保留数组初始长度、空位、可见索引和共享引用；既有原生叶值继续按原捕获规则处理。只有已经取得私有数据的准备请求与结果才使用既有扁平节点传输，并保留同一消息内的类型提示引用身份。不得把完整 JSON 编码移回 Source、截断内容、虚设深度配额或用产品超时替代完整返回。

原生叶值的内建数据与 JSON 可见的自有字段必须一起固定并跨线程保留。没有生效编码方法的字节视图、Date 等值仍可有命名字段；屏蔽继承编码方法的静态值即使不可枚举，也影响原 JSON。私有快照用同一工作栈捕获这些字段，私有传输携带实际叶值与字段引用，在还原时恢复字段及枚举性。字节视图索引沿原生字节副本传递，不在 Source 展开为数字属性；完整正文和哈希仍由 Compute 生成。原生克隆本身保留内建值，不等于保留其完整 JSON。

普通 JSON 与原规范编码各自保留实际消费规则。来源正文和完整清单仍使用原 JSON；目标数据、目标证明、前后内容及原提案等实际进入规范编码的值，还须固定有效 `toJSON` 会忽略的自有字段。只沿这些原消费值补齐同一私有图，不重新读取已捕获的普通调用方容器，不把所有来源 Buffer 都展开成数字属性。来源和目标共享同一原生值时仍是同一私有别名，完整 JSON、规范意图与最终正文分别在 Compute 使用原编码器，不以一种编码规则代替另一种。生成阶段对原生命名字段的枚举单独计量，后续传输仅跟随已登记字段。

原 JSON 会直接解包的 Number、String、Boolean 等盒装值，只固定其原生值；JSON 不消费的额外字段不读取、不执行，也不送入线程克隆。只有本图确实沿原规范编码消费其自有字段时，才按上面的同一私有别名补齐规则捕获这些字段。不能为了传递 JSON 不可见的字段，让原本合法的完整来源在 Worker 克隆时失败。

叶值是否需要内建状态，由原编码消费决定，不以线程原生克隆是否支持该对象决定。盒装 Symbol、Map、DataView 等按普通对象编码的值，只固定实际自有字段；未消费的内建成员不复制。Date、可解包原始值及数值字节视图继续保留实际需要的内建值。原生 URL 的固定 JSON 字符串在提交前生成，私有字段与该生成值沿同一实际引用传递，Compute 恢复其 JSON 投影；规范编码继续读取原自有字段，不把 URL 字符串代替规范目标。此处不在 Source 编码完整 JSON，也不克隆 JSON 忽略的函数成员。

JSON 不可见的 Symbol、函数叶值不得原样交给线程克隆，也不能直接删除或替成 undefined，改变原类型校验与错误。私有扁平传输用单独的引用元数据保留这些叶值的类型及同一消息内身份，Compute 恢复 Symbol 与不会执行用户代码的函数类型标记。JSON 按原规则省略对象字段、把数组位置编码为 null；规范编码仍沿原位置拒绝不可持久化值。函数类型标记只服务数据编码和校验；真实生成逻辑继续在提交前完成，不跨线程传递、求值或模拟任意 JS 回调。

原生 raw JSON 字面值保留品牌对应的原始文本，不能按普通 `{rawJSON:...}` 对象编码，也不能先解析为数字或字符串再重新编码。私有传输携带实际值引用与原文本标记，只有 Compute 真正执行 JSON 编码时才恢复并缓存该字面值；Source 只持有不可变文本和标记。原规范编码继续读取其原 `rawJSON` 自有文本字段，普通同名对象不取得字面值品牌。指数写法、大整数和转义等完整正文及声明哈希保持原样，历史回读仍按原 JSON 语义恢复。

字面文本只保存在私有值的原字段，传输标记通过同一引用读取，不另复制一份完整文本。已脱离缓冲区的数值视图沿既有 JSON 视图复制助手固定为空内建跨度，并保留原可见命名字段；不能因原生克隆不接受其缓冲区而拒绝原本合法的 JSON。

直接增长快照写入与旧刷新提交一同退出同步准备路径，保留原 API 的数据、重放及事务边界。提交前固定完整候选数据；节点、边、信号与标签的完整规范化、哈希、摘要、排序和 metrics JSON 编码进入既有 Compute，Source 只发布真实私有内容、持有资格与执行原标量 SQL。不得把直接导入改成新的刷新预留或伪造 TEMP stage。

直接写入仍先校验基本快照、父节点、边及信号，再计算原完整快照意图并处理请求重放。父环检测及拓扑写入保持在真实快照写入与 live 槽切换之后；失败只沿原实际 Native 前缀执行一次并整体回滚。metrics_json 的 snapshotId 必须对应本图实际私有快照及最终真实回执，不能用来源文件的逻辑 ID 充当已提交对象。重复请求保留真实回执，不再轮转 live 槽或新增历史。

旧刷新提交仍先处理固定 root 请求；新请求先写原 pending，再读实际预留及最新快照，拒绝分支不准备未消费的候选图。只有接受后才按原 payload hash 判断是否未变化，或在同一 Native 事务中写完整增长图并完成 root 回执。原预留读取错误、后续图错误及 SQL 错误分别保留消费顺序；不得在提前拓扑校验或新的保护门槛处改变原错误、拒绝或重放结果。

Runtime 关闭时，先通知既有 Writer 停止尚未切换的数据库代际构建并等待其候选清理，再排空已接收的普通续执行任务。不能先把代际导入当作普通续执行任务等到切换完成，导致关闭反而发布候选。实际构建中断复用原采集、Worker 和候选清理责任；已进入正式切换的 journal 继续按原恢复合同保护，不能借关闭清理活动代际。

最后一批增量应用返回后、取得最终切换围栏前，必须在同一同步段再次检查关闭状态。已进入的关闭控制自身仍占用 Writer 操作计数；若构建此时继续取得围栏并等待操作计数归零，就会与等待构建退出的关闭控制互相等待。该窗口应在取得围栏前沿原失败清理链退出，不把真实候选留给一次尚未发生的切换，也不靠产品超时终止制造完成。

正文在 Reader 消费后、实际 watch 注册前发生物理变化并导致核验失败时，须重读实际输入确认其原消费相位。若原只读准备已能复现正文错误，应重选带真实错误相位的计划，再沿原事务顺序返回；不能直接用外围核验错误掩盖原本更早的 Native 写错误。真正的核验基础设施故障继续返回实际错误，不以无限重选掩盖故障。

外部刷新预留从本次实际当前状态选择子意图的版本；不得借用增长刷新自己的固定回执分支来改写原重放结果。候选值在入队前完成生成并取得私有数据快照。外部缓存提交仍先完整读取预留，再完整读取当前缓存，最后判断代次与请求是否接受；被拒绝时返回实际当前缓存，不在 Compute 编码该候选数据、不建立写请求。接受时从本次真实当前缓存构造原子意图，预留选择和缓存选择（包括缺席、旧正文映射）一起保持资格直到最终 Native 提交。预留、缓存正文及完整接受/拒绝响应沿既有 Compute 准备与既有响应缓存返回，最终原权限围栏仍在同一次正式操作内。

状态快照只保留 JSON 实际消费的生成数据，不能用跨线程克隆能力替代 JSON 合同。已转移底层内存的字节视图仍可能合法编码为空对象，其可见命名字段、共享引用和 Buffer 原生编码规则继续保留；生成阶段须能取得这些合法数据。进入数据链后的读取与接受条件顺序不变，实际 JSON 编码仍由 Compute 完成。

生成阶段只执行本次 JSON 可见操作，不额外调用不可见 getter。字节视图的索引范围从其真实内建跨度取得；代理、可见 getter 与编码方法在同一生成阶段完成，生成失败则不进入写入排队。其结果成为本次私有数据，后续数据库读取和接受判断不再触发调用方逻辑。

Buffer 的原生编码方法与普通字节视图的对象编码保留各自真实行为。使用原方法和原内建长度的默认 Buffer 只取得私有字节副本并在 Compute 编码；覆盖长度、访问器或编码方法时，在提交前生成阶段按真实 receiver 执行一次并固定其数据结果。生成阶段的占用单独计入验收，默认大 Buffer 的展开与 JSON 编码仍在 Compute。

保存与状态导入共用一次生成、私有数据捕获规则；循环与重复访问按生成时的真实对象身份处理。生成期间由前一字段影响后续字段的数据变化在该次生成中确定，之后调用方对普通容器、数组、共享内存或字节视图的任何修改都不改变已提交快照。准备流程不再持有待调用的真实 receiver、异步属性基线或字节差分映射；真实 Buffer、原始 JSON 和附加字段提示只服务本次私有数据编码，不进入业务字段、意图 hash 或持久队列。

合法普通 JSON 的深度能力随完整数据链保留。生成捕获使用显式工作栈，按原键顺序逐项读取，保留数组初始长度与当前祖先路径的循环判定；不能把 JavaScript 函数递归上限变成更小的数据限制。验收必须穿过真实 Worker、编码、Native 发布、完整返回与读取，核对全值和退出；不得只证明复制助手能处理深层数据，也不得截断、虚设深度配额或把完整 JSON 编码搬回 Source。

深层私有数据在既有 Worker 消息边界使用扁平节点引用传递，再逐项还原完整数据；这是传输格式选择，不是数据深度配额，也不产生业务对象、持久记录、额外 actor 或业务队列。输入快照与真实状态结果都保留 Buffer、原始 JSON 提示和同一消息内的引用身份；Runtime 请求、普通结果与已有完整序列化返回沿原端口接齐，避免只修 Compute 入口却在下一段消息中再次栈溢出。完整 JSON 编码与解码仍留在原计算、只读和调用消费边界，Source 不用全文 stringify/parse 绕过传输限制。

传输格式判断不得执行生成属性，也不模拟原 Worker 的动态输入克隆。Runtime 请求和结果先通过自有属性描述符检查完整普通容器图；只有全部由普通自有数据组成且需要深层传输时才使用扁平格式。任何访问器、非普通对象、函数或 Symbol 都保留原端口的一次原生克隆，避免生成逻辑、原生叶值、别名和错误顺序被自定义复制改写；不能在先遇到深分支时提前结束检查，忽略后面的生成逻辑。Source 已完成生成并持有私有字节及提示的状态快照仍直接使用既有私有扁平传输，完整 JSON 编码仍在 Compute。

生成逻辑导致的字段删除、枚举性和原生对象时点均交由原消息克隆处理。缺席字段与显式 `undefined` 对通用数据写入并不等价，Date、字节视图和别名也必须在原生遇到它们的时点固定；不能保活原引用到后续生成逻辑执行完再复制。验收使用实际通用写入、状态写入和原生克隆控制，核对请求接受、完整存储值和临时责任退出；不能只用会省略 `undefined` 的状态 JSON 代替验证，也不为逐种原生对象增加自定义复制和额外大字节副本。

已固定私有数据的扁平表示保留自身键与引用。原生克隆的动态细节以真实对照为准：最初列入的字段后来变为不可枚举时仍会被消费，而前面生成逻辑删除的字段会跳过；Runtime 不再自行重演这套过程。

全局指令保存继续沿设置持久化队列和 `save_global_prompt` 正式入口。Compute 先完整读取当前权威指令，保留原 `user`/`review_projection` 分支及错误先后；投影确认只比对真实当前对象、版本和全文，不创建回执或准备 owner。用户保存沿原 policy 子意图，已有固定回执若不再对应当前头，照原规则跳过覆盖；覆盖仅针对原查询选中的未完成应用，保留全文相同则跳过的规则。完整 policy 与 application 正文、覆盖证据、关系新快照及最终补丁在既有 Compute 准备，Source 观察全局指令与相关未完成应用集合并复核真实请求。

新覆盖证据尚未提交时，关系准备只能读取它实际完成的私有物理快照；随后的 application 补丁只能继承该关系实际准备快照，不能手工伪造未来对象或回执。发布仍依次为 policy、每个覆盖 evidence、原 source 关系、superseded 补丁，在同一 Native 事务中提交，保留中间关系版本、原幂等键和事件。不增加根请求或提前提交证据。准备中出现新的指令、应用或历史控制映射会使旧计划失效；首写后真实错误继续抛出。成功重放和只读投影确认的正文仍有真实证明，但不新增 owner、内容、请求、事件或 WAL。全图的容量增量保持原一次 policy 修订加每个实际覆盖的三次原变更，正式资源门禁另行验证。

先以真实SQLite回归观察RED，再实现；每项证据绑定最终候选。至少覆盖：

1. 完整用户原文、日志、固定历史、报告、记忆、采用证据与附件跨冷转换/重开/备份/导出恢复逐字节及hash一致。
2. 新旧请求结果在提交丢回包、相同key重试、输入冲突、关闭重开后相同；内联结果的嵌套引用仍受保护。
3. 直接/间接/多层/循环/共享引用、活动准备、迟到引用和引用撤销均不误删；最后引用解除可重新入队并最终回收。
4. 准备/索引/压缩/回收任意阶段中断、异常和恢复保持状态一致，不留下永久暂存、重复计量或无法退出的队列。
5. 所有层均有可核验保留/退出合同；未知数据不被自动删除；诊断/派生/终态技术记录的用户结果与统计仍成立。
6. 首次升级、代表性留存历史、实际变化、持续未变化、重试和恢复的读写/索引/主库/WAL/维护峰值守恒；没有工作时不制造无限内容。
7. 后台维护压力下真实Host/Browser的冷首屏、项目切换、Agent启动及输入/焦点/IME仍满足两份上位基线；禁止用提前失败换时延。
8. 最终VSIX、完整共享回归、独立审查、正式真实库规模门禁和既有发布路径闭合；实验无残留。缺任何一项保持进行中。

已完成冷转换/内联回执、读快照、引用索引、每调用pin、引用发布与GC的隔离基础实现；独立审查发现的codec去重、sealed导入、准备债务、撤销ABA和purge迟到恢复竞态已有定向原生回归并关闭。结构化单片发布共享回归157项通过；原始产物/迁移源/日志/文档的6项原生合同与83项领域回归通过。原本异步的文件、观察器与恢复调用已接新准备链；Pi局部规范序列化复用同程summary，已补strict真实入口回归。v79修复保留旧代字节，已补切换前/后中断、再次损坏、并发修复和导入映射后的原身份恢复；索引包裹与逐批计数还须最终独立审查及资源门禁。同步内部生产者、大正文/大fanout、重映射导入、旧清理路径退出、compact generation、正式规模资源门禁和发布仍未完成。不得把子步骤GREEN当作整轮完成。

正文复用校验本次限定阶段已接入初始去重、迟到同内容记录、原修复流程和分块导出归档；16项专项以及准备31项、GC32项、增量外键26项、跨项目导出导入63项，共168项共享回归通过。损坏导出修复按每批16块从自有暂存内容复制，保留原内容身份，废弃暂存最终退出；没有整档拼回Writer。此处仅记录当前编译结果的局部证据，完整消费者回归、最终独立审查及正式规模资源门禁仍按上面的完成条件执行。

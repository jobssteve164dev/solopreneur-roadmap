# 对话启动阻塞修复台账

> 建立时间：2026-10-25 UTC  
> 主目标：所有由插件发起、用户可感知的对话，在用户动作被接受后 **10 秒内进入真实 Agent CLI 任务**；新对话和续聊均以 Provider 原生任务开始或与当前 run/turn/interaction 精确绑定的 Agent loop 收据为准。终端创建、`processId`、命令写入、runner spawn 均不算任务开始。  
> 当前结论：0.0.625 的前台 Pseudoterminal bridge 在两个输入边界上引入了回归：非交互维护继承了长寿命 stdin socket；续聊按钮被改成了会向原生会话发送 SoloMap wrapper 的新 turn。0.0.626 已统一修复输入合同并发布：非交互维护使用 closed stdin，续聊按钮只做原生 session reentry，不提交任何提示词；完整回归、真实 closed-stdin / resume-only 合同、打包 VSIX 的真实 Codex 压力门禁、CI、发布流水线及三个发布面均已核验。任务前 Git 基线作为“可撤回”能力继续完整保留。

## 1. 状态口径

- `已确认`：有当前日志、代码、数据库或命令输出证据。
- `已改待总验`：补丁与窄测试已经完成，但还没有通过最终真实插件验收。
- `已验收`：最终生成物已在真实插件运行环境完成验收。
- `未闭合`：存在明确缺口，不得对外宣称完成。

## 2. 根因与修复记录

| ID | 问题 / 根因 | 证据 | 已做改动 | 当前验证 | 状态 |
|---|---|---|---|---|---|
| R-01 | 旧 Runtime 出现增长型 CPU 热循环，导致“版本没更新但用几天后突然变慢”。Codex 原生日志增量被读取两遍，并按每一条 JSONL 记录写一次 cursor。现场 native log 约 2 MB、transcript 约 13.9 MB、run revision 602；旧 Runtime 主线程持续约 70%–77% CPU。 | CPU profile 热栈落在 `RunNativeObserver.rows -> UnifiedDataStore.readRunLog -> SQLite step`；实现见 `src/runNativeObserver.ts`。 | 改为单次解析同一增量、1 MiB 分页、整批仅持久化一次 cursor；任务语义事件仍逐条处理；Codex session locator 先检查 `session_meta` 和文件时间，再扫描合格 transcript，避免历史目录增长导致重复正文扫描。 | `test/run-native-observer.test.js`、`test/codex-session-identity.test.js` 通过；0.0.625 Runtime 已接管 0.0.624，r13 加压门禁通过。 | 已验收 |
| R-02 | 对话启动曾把 VS Code Terminal `processId`、shell 出现和 `sendText` 当成启动链路的一部分，且容易关联到其他项目终端。 | 旧 trace 在 terminal create/show 后等待 `processId`；终端选择曾依赖标题/cwd 弱身份。 | 新增前台 Pseudoterminal runner bridge；输入直接写入唯一 runner；复用要求 data root、project、execution/root、run、generation、delivery 与 live bridge 全部一致。 | bridge、终端碰撞、完整身份窄测通过；r13 真实宿主使用唯一受控 runner 成功进入 Codex。跨 Host 重新附着旧 pipe 仍是明确边界。 | 已验收 |
| R-03 | “已发命令”被误当作“Agent 已进入任务”，观测无法定位 10 秒究竟花在哪里；observer 迟到还会把已经及时启动的任务误报成“暂时无法回答”。 | 旧链路只有 delivery trace，没有从用户动作到 Provider task start 的同一 interaction；r8—r11 证明 Provider 已在 6.8—9.12 秒启动，但 observer 可晚 1.878—6.982 秒发现。 | 增加不可重置 `interactionBudget`；贯通入口、run、turn、Provider 收据和 deadline verdict；Webview 点击即产生同一 interaction 与起点。宿主轮询明确记为 `task.ingress.observation`，Codex 原生/MCP 权威接单另记 `task.ingress`；后到原生收据按 Provider 原始时间调和观察超时，并保留 observer delay。 | 最终 VSIX 压力门禁中 Agent launch 2.254 秒、first output 2.866 秒、Provider start 7.447 秒；observer 晚 8.285 秒仍以同一 trace 写入 `provider_native ok` 并标记已调和观察超时。 | 已验收 |
| R-04 | 续聊在写入 Agent CLI 前串行执行状态投影、刷新和 Git 备份；其中 Git 备份不能删除，因为它定义本轮可撤回边界。 | `handleContinueConversationTurn` / `handleContinueNativeConversation`、`registerInteractiveConversationTurn`。错误候选曾移除两条新 runner 续聊的备份，复用原终端的续轮也会把 `baseGitHash` 清空。 | 已恢复“备份先于本轮输入/正式 CLI”的顺序，只把项目投影、刷新等非必要 I/O 移到收据之后；复用终端和新 resume runner 都携带本轮新基线。 | 复用终端续轮、新 resume runner、权威 hash 投影和真实 rollback 共 4 类定向回归通过；历史真实同 Session 续聊 8.938 秒。 | 已验收 |
| R-05 | 原 `createPreSessionGitCommit` 依次执行 `status`、`add -A`、普通 `commit`、`rev-parse`，最坏超时累计 80 秒左右，并会改动用户当前分支和索引；但它提供的完整工作树基线必须保留。 | `src/preSessionGit.ts`；rollback 消费者在 `rollbackProjectToPreSessionGitHash`；最终 UI 只从 `SoloMapPreGitHash` 读取撤回哈希。另发现 runner 仅写 `status.baseGitHash`，结算代码却只从旧 journal 文本提取，可能导致撤回按钮缺失。 | 已改为 Git plumbing 快照：独立临时 index 先读入 HEAD tracked 集合，再单次 `add -A` → `write-tree`；内容变化时生成确定性 `commit-tree`，内容未变时复用 HEAD；两种情况都用 `update-ref --no-deref` 写受控 ref 后再放行。相同 HEAD/工作树复用同一对象，已有 hash 也重新验证和保留。全过程不移动 HEAD、不污染用户 index。正式 CLI/续轮输入等待快照成功，失败闭锁；结算直接投影权威 `status.baseGitHash`，MCP start 保留 runner 已写 hash，rollback 同时接受受控隐藏 ref。 | 定向测试覆盖 tracked-but-ignored、重复 dirty 去重、clean HEAD、symbolic ref 防护、坏 hash/失败闭锁、runner 顺序、UI 消费与真实 restore；r13 真实 dirty 工作树生成并保留隐藏 ref，HEAD 与用户文件未改变。 | 已验收 |
| R-06 | task-ingress 超时处理会释放 delivery、关闭唯一 runner，或因 observer 迟到提前向用户报错，把“已启动但尚未观察”变成确定失败并可能制造重复任务。 | 旧 timeout 清理路径；r8—r11 的 Provider 时间与 observer 时间对照。 | deadline 先持久化观察证据，不释放 lease、不 dispose terminal、不创建第二个任务；仍受控的已提交 runner 不返回假失败；revision conflict 有限重读重试；后到 Provider 收据按原始时间裁决；runner-claim 观测失败最多重试三次，不再产生永久 endpoint 轮询。 | timeout retention、observer lag、观测器自然退出回归和 r13 真实门禁通过。 | 已验收 |
| R-07 | Roadmap 发起入口误用未定义的 `currentProjectPath`，会在 Host 前抛 `ReferenceError`。 | `src/roadmapWebview.ts` 的 `conversation.runRoadmapRevision` sender。 | 改为当前页面真实变量 `activeProjectPath`。 | 定向回归、完整回归与 TypeScript 编译通过。 | 已验收 |
| R-08 | CLI 预检在正式命令前启动额外 `--help` / `--version` 子进程，用户任务被能力探测阻塞。 | `prepareNativeAgentLaunch` 的旧 Provider 分支。 | 移除每任务 capability subprocess；使用既有确定性 invocation，失败由唯一正式启动返回。 | “formal Agent 前无 capability subprocess”、完整回归和真实 r13 gate 通过。 | 已验收 |
| R-09 | 同一 native log 的观测、入口阶段和错误信息不足，过去只能反复猜测。 | 旧日志不能将 UI 动作、delivery、runner、Provider turn 串到同一 ID。终态压力回归还发现：trace 创建时若尚无 persistence，原实现用 `undefined` 表示“无 sink”，迟到记录时却会被默认参数重新解释为“使用当前 sink”；AsyncLocalStorage 内迟到的 error 又会读取新的全局 sink，从而串写到后来打开的数据根。 | 对话阶段诊断统一记录 interaction、run/generation、turn、终端身份、Provider receipt、observer delay 与 deadline verdict；审计文档写明成功口径和不允许的伪成功。每条 trace 创建时即绑定当时的 persistence 或显式 no-sink，普通 trace event 与异步 error 都沿同一 sink；同步或异步持久化失败只记录脱敏 warning，不反向打断用户主路径。 | r13 gate 从同一 run 直接读出 Provider task 7.569 秒、observer delay 3.173 秒、MCP 完成、profile 与 Git ref；异步边界、跨根 sink 替换、no-sink 和同步 sink 抛错均完成 RED→GREEN，策略页竞态场景连续 5 轮通过，最终全量 0 失败，独立终审 C0/I0/M0 Ready。 | 已验收 |
| R-10 | Git 快照曾被误列为 10 秒主因；真实分段证明主要等待来自 Codex 工具链冷启动，以及旧 Runtime/历史 transcript 扫描对 CPU 的争用，而不是回滚快照。 | r6 快照约 152 ms、总 task start 13.398 s；旧 Runtime 持续约 70%–77% CPU。停止旧 Runtime 后样本降到 8.525 秒，但旧版本会自动重启；最终 r13 为 7.569 秒。 | 保留 Git 硬门；workspace 元数据 baseline 与 CLI 初始化并行；优化 observer/transcript locator；完成 Runtime 正式版本接管。独立 app-server 失败实验已移除，保持原生 Codex CLI 对话和工具调用链。 | r13 在两个 CPU burner 下通过；Git/MCP/profile/HEAD 不变同时验证。 | 已验收 |
| R-11 | 所有项目共用 `CODEX_HOME/solomap.config.toml`，最后一次写入会把 `solomap_data` 指向另一个项目/临时数据根，导致当前 Agent 的 MCP 对话启动或 checkpoint 卡住/失败。 | 正式共享 profile 曾指向已失效 temp root；该状态不需要版本更新即可由另一个项目/测试覆盖，符合“突然今天才坏”的现象。 | profile 改为按 global data root 哈希派生 `solomap-<16hex>`，并贯穿新任务、续聊、preflight、runner 与 Runtime 数据操作。 | 配置、preflight、runner、数据库与最终真实 profile `solomap-f410ff7b22798794` 验证通过。 | 已验收 |
| R-12 | 设置页非交互维护命令卡在 `Reading additional input from stdin...`。0.0.625 将 runner 放入前台 bridge 后，`runAgentProcess` 仍对非交互子进程使用 `inherit`，导致 Codex 继承不会 EOF 的 bridge socket。 | 现场 `agent_cli_upgrade` 的 runner/Codex fd 0 同指向一个长寿命 socket，22 分 31 秒后才进入 MCP start；命令输出首行即为读取 stdin。 | 持久化统一 `agentInputMode`；所有设置维护是 `closed`，runner 对非交互正式 Agent 使用 `stdio: ignore`，启动即 EOF。 | 最终真实 Codex 输入合同通过：非交互任务 1.903 秒进入 turn 并自然完成；runner EOF、设置维护入口分类与共享 runner 回归通过。 | 已验收 |
| R-13 | 续聊按钮会把“继续当前 Agent 对话”与 SoloMap wrapper 当成新用户回合发给原生会话。回归来自 0.0.625：宿主移除 resume-only direct command，preparer 又主动删除 Codex direct command。 | 现场 Codex argv 在 session ID 后明确带有 `Read the complete SoloMap task prompt...`；代码与 0.0.614 对比证明旧路径只有 `resume <sessionId>`。 | 续聊按钮改为 `session_reentry`，恢复 Provider 原生无 PROMPT resume，Codex 继续使用按 data root 隔离的 profile；输入准备层拒绝任何非空 prompt/userMessage，最终执行计划中的 prompt 也保持为空。预建 turn 为 `Waiting`，真实原生输入到达后才回填原文、切换 `Running` 并创建该次提交的新 interaction；无输入关闭由 runner 直接走 `session-close`，正常或异常退出都不制造空完成轮次。用户明确输入的 Continue Turn 仍使用 `prompt_turn`。 | 最终真实 Codex resume-only TUI 54 ms 可见，启动前后 transcript 用户消息数不变；命令和执行计划都不含 wrapper/合成提示。真实 runner 0/7 退出、原生回填和侧边栏/大图 sender 回归通过。 | 已验收 |
| R-14 | 页面各自生成消息、后台恢复反复失败以及预检进程混入 formal trace，使同一故障既可能丢失点击起点，也可能被后台 I/O 和伪 `agent.*` 事件掩盖。 | 生产 sender 原先没有点击时 interaction 身份；恢复退避只在内存，Runtime 重启后会重新打重 I/O；preflight 复用 formal `execute()` 记录。 | 主动对话、全部 `project.continue`、Flow、路线图修订、时间计划、全局指令复盘、CLI 更新、Skill/MCP 安装升级卸载和迁移维护入口都在点击时生成 interaction；Host 的统一 helper 只继承不重置，迁移不再绕过。恢复退避按 run revision 持久化，30 秒指数退避至 5 分钟，observer 自身推进 revision 后失败会基于最新同一 run/turn 写入退避。preflight 与 formal 使用不同事件命名。 | 实际渲染 sender、设置维护 sender、迁移宿主入口、跨 Runtime 退避、observer 自推进失败、revision 解锁、退避封顶、Cursor 预检与 formal 事件数量回归全部通过；独立终审 C0/I0 Ready。 | 已验收 |
| R-15 | 发布流程先 push/tag 再测试和打包，候选失败时会留下不可发布却已公开的版本。 | `.github/workflows/publish.yml` 的旧顺序。前两次候选分别在环境夹具和诊断竞态上失败，但都停在版本提升之前，没有生成坏版本或标签。 | 发布前先安装根目录与 website 依赖，再 compile、全量测试和最终 VSIX 打包审计；只有全部成功才 push 版本提交与 tag。依赖安全审计继续由独立 Security workflow 治理，不把既有依赖告警混入本次发布顺序修复。 | Publish `40331655070` 按顺序完成全量测试、打包、版本提交/tag、两个市场、GitHub Release 与 Open VSX 可用性校验；`v0.0.626` 已发布，证明失败候选不会越过发布门禁。 | 已验收 |
| R-16 | Coder 整页刷新会替换 Extension Host；直连 Custom PTY 的 runner 与权威日志仍存活，但新 Host 丢失 stdin/stdout 引用，多个已打开对话终端不会恢复。 | 代码审计确认 `detachForHostReload()` 只清空内存 consumer，`reconcileRestoredAgentTerminalOwners()` 只认领标题相同的现存 terminal，不存在重新连接 transport；生产现场同时存在多个 PPID=1 的存活 runner，证明故障点在显示/输入桥而非任务进程或 Coder 会话保留。 | 交互 runner 增加认证 loopback IPC；状态持久化完整 endpoint 身份。新 Host 以数据库 owner CAS 接管，从权威 output 尾部回放后按 offset 接入同一 runner；协议串行 attached/replay/ready，输入在 Agent stdin 接受后 ACK 并按 request ID 去重。run/generation/delivery/PID/birth/nonce 任一缺失或不符都拒绝；缓冲、单帧、认证时间和未认证连接数都有硬上限。异常断线取消假 live 状态并复用原 terminal surface。恢复不依赖当前项目、终端标题或普通 PTY processId，且不 spawn/resume/补发 prompt。 | 红转绿覆盖断开重连、错误 nonce、有界缺口、异常断线、ACK 时序、输入去重、身份错配、未打开 surface 缓冲、超大帧和连接上限；真实 runner 在原 bridge 断开后保持同一 PID 并恢复输入输出，最近一次进入子进程约 4.3 秒。Extension Host VM 覆盖单终端、三项目终端和瞬时断线复用；独立终审 C0/I0/M0 Ready。最终主套件 2728 项为 2727 pass、0 fail、1 skip，随后 140 轮真实 Pi 容量门禁 1/1 通过；0.0.628 的 CI、Security、Publish 与双市场精确包核验全部成功。 | 已验收并发布 0.0.628 |

## 3. 本轮已经执行的验证

| 验证 | 结果 | 备注 |
|---|---|---|
| TypeScript 编译与 Pi runtime bundle | 通过 | 最新代码执行 `npm run compile` 成功。 |
| RunNativeObserver 定向测试 | 14/14 通过 | 覆盖单次增量解析、批量 cursor、迟到收据调和与 resume-only 输入回填。 |
| 前台 terminal bridge / interaction budget / scheduler / preflight 定向测试 | 32/32 通过 | 覆盖唯一 runner、预算和优先级基础约束。 |
| Git 回滚基线定向测试 | 通过 | 覆盖独立 index、tracked-but-ignored、重复 dirty 去重、脏工作树和干净 HEAD 的隐藏 ref、symbolic ref 防护、已有坏 hash、HEAD/暂存区不变、失败闭锁、正式 CLI 启动顺序、续轮基线传递、UI 展示与真实 restore。 |
| runner 启动顺序定向测试 | 通过 | Git 快照成功后才允许正式 CLI；次级 workspace 元数据基线开始于 CLI 前、与原生初始化重叠，不再把这项辅助 I/O 串行压在用户任务前；无额外 capability subprocess。 |
| Webview/续聊关键回归 | 通过 | 覆盖 Roadmap projectPath、轻量续聊、超时保留、完整终端身份、续聊前置 Git、新 Solo/Step 前置 Git。 |
| 最终候选真实输入合同 | 通过 | 非交互 Codex 1.903 秒进入 turn；resume-only TUI 54 ms 可见；没有提交合成提示词，transcript 用户消息数不变。 |
| 最终候选 VSIX 结构审计 | 通过 | 6335 文件，11.48 MiB 压缩、38.80 MiB 解压；SHA-256 `6c13c1a25736df68704b24fdcadd59521c93fb72f9f51122eba524535f764f2d`。 |
| 最终候选真实 Codex 压力门禁 | 通过 | 两个 CPU burner 下 7.447 秒进入 Provider task；Agent launch 2.254 秒、首输出 2.866 秒；MCP 完成、按根 profile、Git hidden ref、HEAD 与脏工作树保持均通过。observer delay 8.285 秒被独立记录并由权威原生收据调和。 |
| 上一候选 VSIX 的 Codex 新对话 | 7.862 秒 | 已进入真实 native turn；这是最新两项补丁之前的候选数据，不能替代最终验收。 |
| 上一候选 VSIX 的 Codex 续聊 | 8.938 秒 | 同一 native session 的新 native turn；同上，不作为最终发布结论。 |
| r6 VSIX + 隔离 code-server + 两个 CPU 负载 | 失败：13.398 秒 | interaction `4d06fd66-f6d5-42a7-aff1-9cb069976f48`；Git 快照约 152 ms，Provider 原生 `task_started` 超过 10 秒硬门。HEAD 与用户 index 保持不变，隐藏回滚 ref 可解析。 |
| 完整 `npm test` | 2700 项，2699 通过、0 失败、1 跳过 | 最终代码 709.446 秒自然退出；跳过项为既有环境能力条件。期间发现并修复只等待 PID 文件存在、未等待内容和子进程 birth 的测试夹具竞态，以及 trace error/no-sink 被后来数据根接管的迟到诊断竞态；策略页目标序列连续 5/5 轮通过。 |
| 临时夹具物理清理 | 通过 | 四批遗留物精确清单共清理 398 个根、2225 个普通文件/链接、3038 个目录，释放对象分配空间口径合计 1,146,474,496 bytes；进程引用均为 0。后续测试与真实门禁全部通过 owned-TMPDIR 包装器自动回收；最终临时 VSIX 也按精确路径 unlink/rmdir。反向扫描只保留两个正式 Telegram 协调根，共享 Agent/Codex 配置未触碰。 |
| 上一发布版 r13 VSIX 结构审计 | 通过 | 6335 文件，11.48 MiB 压缩、38.78 MiB 解压。 |
| 上一发布版 r13 真实 Codex 门禁 | 通过 | 7.569 秒进入 Provider task；observer delay 3.173 秒；MCP 往返、两路 CPU burner、profile、Git ref、HEAD/工作树不变均通过。 |
| Runtime 升级接管 | 通过 | 0.0.625 PID 3884064 接管 0.0.624 PID 3700738；新 endpoint 为 build `478320a9fe985551aca581ca52e368d93dae9420f8b0db21daab2546f94eeb17`，旧 PID 已退出，health 返回 `ok`。 |
| 上一发布版 Git commit / push / CI / publish | 通过 | 0.0.625 实现 `f4128e8`、自动发布 `13db58d`；CI `40272156144` 与 Publish `40272156120` 成功，Open VSX 可用性回读通过。Security `40272156101` 仍仅失败于该版既有依赖告警。 |
| 0.0.626 Git / CI / publish / 市场 | 通过 | 输入合同 `5472788`、夹具隔离 `059d3ee`、发布环境 `ed2cefe`、诊断竞态 `124b421`、自动发布 `e777574` 已推送。CI `40331654992`、Publish `40331655070` 成功；GitHub Release 与 tag 为 `v0.0.626`，Open VSX API 返回 `0.0.626`，Visual Studio Marketplace 精确包端点返回 200 且包内版本为 `0.0.626`。Security `40331655114` 仍失败于独立依赖告警：root 4 项、website 3 项。 |

## 4. 当前未闭合项

| ID | 缺口 | 对本次交付的处理 |
|---|---|---|
| O-01 | 当前候选已在真实 Codex 配置和双 CPU 压力下以 7.447 秒通过，但单机单次样本不能证明所有硬件与账号都永远小于 10 秒。 | 发布仍以 Provider 原始开始时间逐次记账；任何真实 `>=10s` 样本都令对应版本失败，不能用 observer 或 UI 时间掩盖。 |
| O-02 | `foregroundStart` 在上一轮仍 `nativeOutputPending` 时，为保证不覆盖未结算输出，会先完成 native observer 结算。 | observer 热循环已消除，历史真实正常续聊为 8.938 秒；异常超大未结算输出仍需持续用分段 trace 观察，不能靠跳过结算制造假通过。 |
| O-03 | Codex/Claude 有原生 Provider ingress；其他 CLI 当前主要依赖与本轮身份精确绑定的 Agent MCP start。OpenCode 的 serve/attach 同 PTY 续聊合同尚未实现。 | 不把 Codex 实测外推成所有 Provider 已验收，也不把未实现能力写成已完成。主线先闭合当前真实配置 Codex；多 Provider 缺口保留为明确架构边界。 |
| O-04 | Telegram、scheduled/effect 等入口已通过完整契约回归，但本轮没有可用外部 Telegram 账号做同等级真实 Provider 门禁。 | 不把本地契约测试表述为外部账号实测；这些入口继续复用同一持久 run/interaction/runner 主路径和 10 秒 verdict。 |
| O-05 | 每个唯一工作树基线都必须被 Git 对象和受控 ref 保留，才能保证历史对话可撤回；这会随真正不同的任务基线增长。 | 本版先用确定性提交消除“相同 HEAD + 相同工作树”的重复增长。不得在没有逐 run 引用审计和用户明确清理授权时自动删除 ref；后续容量治理必须以 durable run/conversation 引用为保留根，先观测数量、字节和增长速率，再只回收已明确退休且无引用的基线。 |

## 5. 已完成的强制验收顺序

1. 当前候选 VSIX 已从最终源码生成并通过包结构审计。
2. 两个 CPU 负载下真实 Solo 新对话已于 7.447 秒进入 Codex task。
3. MCP 完成、项目 profile、Git hidden ref、HEAD 与用户文件不变已在同一 gate 验证；resume-only 另由真实输入合同证明没有提交合成提示词。
4. interaction 可直接给出 Provider start、observer delay、MCP、profile 和 Git 分段证据。
5. 完整测试 2700 项已自然退出，2699 通过、0 失败、1 个环境条件跳过。
6. 临时测试与诊断对象已物理清理，反向扫描只保留两个正式 Telegram 协调根。
7. 代码与修复提交已推送 `main`；CI、Publish、GitHub Release、Open VSX 与 Visual Studio Marketplace 精确版本均已核验。Security 的独立依赖告警继续如实记录，不冒充通过，也不与本次输入合同/启动链修复混改。

## 6. 关联证据入口

- 全链路审计：`docs/ui/conversation-terminal-launch-audit-2026-10-25.zh.md`
- 本地体验基线：`docs/ui/local-first-loading-interaction-baseline.zh.md`
- 前台 runner bridge：`src/foregroundAgentTerminal.ts`
- 交互预算：`src/interactionBudget.ts`
- Provider task receipt：`src/providerTaskIngress.ts`
- 原生日志观察：`src/runNativeObserver.ts`
- 对话入口与续聊：`src/extension.ts`
- 正式 runner：`src/runAgentProcess.ts`

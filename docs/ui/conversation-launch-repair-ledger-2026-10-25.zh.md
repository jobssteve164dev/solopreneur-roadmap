# 对话启动阻塞修复台账

> 建立时间：2026-10-25 UTC  
> 主目标：所有由插件发起、用户可感知的对话，在用户动作被接受后 **10 秒内进入真实 Agent CLI 任务**；新对话和续聊均以 Provider 原生任务开始或与当前 run/turn/interaction 精确绑定的 Agent loop 收据为准。终端创建、`processId`、命令写入、runner spawn 均不算任务开始。  
> 当前结论：**主线修复已提交、推送并发布为 0.0.625。** 任务前 Git 基线作为“可撤回”能力完整保留；0.0.625/r13 在隔离 code-server、两个 CPU 负载和真实 Codex CLI 下 7.569 秒进入 Provider task，MCP 往返、项目配置隔离、隐藏回滚 ref、HEAD/用户文件不变均通过。

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
| R-03 | “已发命令”被误当作“Agent 已进入任务”，观测无法定位 10 秒究竟花在哪里；observer 迟到还会把已经及时启动的任务误报成“暂时无法回答”。 | 旧链路只有 delivery trace，没有从用户动作到 Provider task start 的同一 interaction；r8—r11 证明 Provider 已在 6.8—9.12 秒启动，但 observer 可晚 1.878—6.982 秒发现。 | 增加不可重置 `interactionBudget`；贯通入口、run、turn、Provider 收据和 deadline verdict；Codex/Claude 原生事件写 `provider_native`，精确 MCP start 写 `agent_acknowledged`；记录 Provider 原始开始时间与 observer 延迟。10 秒观察未命中不再对仍受控的唯一 runner返回用户可见失败；后到收据按 Provider 原始时间清除假超时或保留真实超限。 | r13 真实 Provider start 7.569 秒、observer delay 3.173 秒，未误报；interaction/provider ingress 回归通过。 | 已验收 |
| R-04 | 续聊在写入 Agent CLI 前串行执行状态投影、刷新和 Git 备份；其中 Git 备份不能删除，因为它定义本轮可撤回边界。 | `handleContinueConversationTurn` / `handleContinueNativeConversation`、`registerInteractiveConversationTurn`。错误候选曾移除两条新 runner 续聊的备份，复用原终端的续轮也会把 `baseGitHash` 清空。 | 已恢复“备份先于本轮输入/正式 CLI”的顺序，只把项目投影、刷新等非必要 I/O 移到收据之后；复用终端和新 resume runner 都携带本轮新基线。 | 复用终端续轮、新 resume runner、权威 hash 投影和真实 rollback 共 4 类定向回归通过；历史真实同 Session 续聊 8.938 秒。 | 已验收 |
| R-05 | 原 `createPreSessionGitCommit` 依次执行 `status`、`add -A`、普通 `commit`、`rev-parse`，最坏超时累计 80 秒左右，并会改动用户当前分支和索引；但它提供的完整工作树基线必须保留。 | `src/preSessionGit.ts`；rollback 消费者在 `rollbackProjectToPreSessionGitHash`；最终 UI 只从 `SoloMapPreGitHash` 读取撤回哈希。另发现 runner 仅写 `status.baseGitHash`，结算代码却只从旧 journal 文本提取，可能导致撤回按钮缺失。 | 已改为 Git plumbing 快照：独立临时 index 先读入 HEAD tracked 集合，再单次 `add -A` → `write-tree`；内容变化时生成确定性 `commit-tree`，内容未变时复用 HEAD；两种情况都用 `update-ref --no-deref` 写受控 ref 后再放行。相同 HEAD/工作树复用同一对象，已有 hash 也重新验证和保留。全过程不移动 HEAD、不污染用户 index。正式 CLI/续轮输入等待快照成功，失败闭锁；结算直接投影权威 `status.baseGitHash`，MCP start 保留 runner 已写 hash，rollback 同时接受受控隐藏 ref。 | 定向测试覆盖 tracked-but-ignored、重复 dirty 去重、clean HEAD、symbolic ref 防护、坏 hash/失败闭锁、runner 顺序、UI 消费与真实 restore；r13 真实 dirty 工作树生成并保留隐藏 ref，HEAD 与用户文件未改变。 | 已验收 |
| R-06 | task-ingress 超时处理会释放 delivery、关闭唯一 runner，或因 observer 迟到提前向用户报错，把“已启动但尚未观察”变成确定失败并可能制造重复任务。 | 旧 timeout 清理路径；r8—r11 的 Provider 时间与 observer 时间对照。 | deadline 先持久化观察证据，不释放 lease、不 dispose terminal、不创建第二个任务；仍受控的已提交 runner 不返回假失败；revision conflict 有限重读重试；后到 Provider 收据按原始时间裁决；runner-claim 观测失败最多重试三次，不再产生永久 endpoint 轮询。 | timeout retention、observer lag、观测器自然退出回归和 r13 真实门禁通过。 | 已验收 |
| R-07 | Roadmap 发起入口误用未定义的 `currentProjectPath`，会在 Host 前抛 `ReferenceError`。 | `src/roadmapWebview.ts` 的 `conversation.runRoadmapRevision` sender。 | 改为当前页面真实变量 `activeProjectPath`。 | 定向回归、完整回归与 TypeScript 编译通过。 | 已验收 |
| R-08 | CLI 预检在正式命令前启动额外 `--help` / `--version` 子进程，用户任务被能力探测阻塞。 | `prepareNativeAgentLaunch` 的旧 Provider 分支。 | 移除每任务 capability subprocess；使用既有确定性 invocation，失败由唯一正式启动返回。 | “formal Agent 前无 capability subprocess”、完整回归和真实 r13 gate 通过。 | 已验收 |
| R-09 | 同一 native log 的观测、入口阶段和错误信息不足，过去只能反复猜测。 | 旧日志不能将 UI 动作、delivery、runner、Provider turn 串到同一 ID。 | 对话阶段诊断统一记录 interaction、run/generation、turn、终端身份、Provider receipt、observer delay 与 deadline verdict；审计文档写明成功口径和不允许的伪成功。 | r13 gate 从同一 run 直接读出 Provider task 7.569 秒、observer delay 3.173 秒、MCP 完成、profile 与 Git ref，故障点可分段定位。 | 已验收 |
| R-10 | Git 快照曾被误列为 10 秒主因；真实分段证明主要等待来自 Codex 工具链冷启动，以及旧 Runtime/历史 transcript 扫描对 CPU 的争用，而不是回滚快照。 | r6 快照约 152 ms、总 task start 13.398 s；旧 Runtime 持续约 70%–77% CPU。停止旧 Runtime 后样本降到 8.525 秒，但旧版本会自动重启；最终 r13 为 7.569 秒。 | 保留 Git 硬门；workspace 元数据 baseline 与 CLI 初始化并行；优化 observer/transcript locator；完成 Runtime 正式版本接管。独立 app-server 失败实验已移除，保持原生 Codex CLI 对话和工具调用链。 | r13 在两个 CPU burner 下通过；Git/MCP/profile/HEAD 不变同时验证。 | 已验收 |
| R-11 | 所有项目共用 `CODEX_HOME/solomap.config.toml`，最后一次写入会把 `solomap_data` 指向另一个项目/临时数据根，导致当前 Agent 的 MCP 对话启动或 checkpoint 卡住/失败。 | 正式共享 profile 曾指向已失效 temp root；该状态不需要版本更新即可由另一个项目/测试覆盖，符合“突然今天才坏”的现象。 | profile 改为按 global data root 哈希派生 `solomap-<16hex>`，并贯穿新任务、续聊、preflight、runner 与 Runtime 数据操作。 | 配置、preflight、runner、数据库与 r13 真实 profile `solomap-db82e0d3cbbb9de8` 验证通过。 | 已验收 |

## 3. 本轮已经执行的验证

| 验证 | 结果 | 备注 |
|---|---|---|
| TypeScript 编译与 Pi runtime bundle | 通过 | 最新代码执行 `npm run compile` 成功。 |
| RunNativeObserver 定向测试 | 11/11 通过 | 覆盖单次增量解析与批量 cursor。 |
| 前台 terminal bridge / interaction budget / scheduler / preflight 定向测试 | 32/32 通过 | 覆盖唯一 runner、预算和优先级基础约束。 |
| Git 回滚基线定向测试 | 通过 | 覆盖独立 index、tracked-but-ignored、重复 dirty 去重、脏工作树和干净 HEAD 的隐藏 ref、symbolic ref 防护、已有坏 hash、HEAD/暂存区不变、失败闭锁、正式 CLI 启动顺序、续轮基线传递、UI 展示与真实 restore。 |
| runner 启动顺序定向测试 | 通过 | Git 快照成功后才允许正式 CLI；次级 workspace 元数据基线开始于 CLI 前、与原生初始化重叠，不再把这项辅助 I/O 串行压在用户任务前；无额外 capability subprocess。 |
| Webview/续聊关键回归 | 通过 | 覆盖 Roadmap projectPath、轻量续聊、超时保留、完整终端身份、续聊前置 Git、新 Solo/Step 前置 Git。 |
| 上一候选 VSIX 的 Codex 新对话 | 7.862 秒 | 已进入真实 native turn；这是最新两项补丁之前的候选数据，不能替代最终验收。 |
| 上一候选 VSIX 的 Codex 续聊 | 8.938 秒 | 同一 native session 的新 native turn；同上，不作为最终发布结论。 |
| r6 VSIX + 隔离 code-server + 两个 CPU 负载 | 失败：13.398 秒 | interaction `4d06fd66-f6d5-42a7-aff1-9cb069976f48`；Git 快照约 152 ms，Provider 原生 `task_started` 超过 10 秒硬门。HEAD 与用户 index 保持不变，隐藏回滚 ref 可解析。 |
| 完整 `npm test` | 2679 项，2678 通过、0 失败、1 跳过 | 661.762 秒自然退出；跳过项为既有环境能力条件。另完成 webview 压力单跑 563/563。 |
| 最终 r13 VSIX 结构审计 | 通过 | 6335 文件，11.48 MiB 压缩、38.78 MiB 解压。 |
| 最终 r13 真实 Codex 门禁 | 通过 | 7.569 秒进入 Provider task；observer delay 3.173 秒；MCP 往返、两路 CPU burner、profile、Git ref、HEAD/工作树不变均通过。 |
| Runtime 升级接管 | 通过 | 0.0.625 PID 3884064 接管 0.0.624 PID 3700738；新 endpoint 为 build `478320a9fe985551aca581ca52e368d93dae9420f8b0db21daab2546f94eeb17`，旧 PID 已退出，health 返回 `ok`。 |
| Git commit / push / CI / publish | 通过 | 实现 `f4128e8`、自动发布 `13db58d`；CI `40272156144` 与 Publish `40272156120` 成功，Open VSX 可用性回读通过。Security `40272156101` 仍仅失败于本轮未修改的既有依赖告警。 |

## 4. 当前未闭合项

| ID | 缺口 | 对本次交付的处理 |
|---|---|---|
| O-01 | r13 已在当前真实 Codex 配置和双 CPU 压力下以 7.569 秒通过，但单机单次样本不能证明所有硬件与账号都永远小于 10 秒。 | 发布仍以 Provider 原始开始时间逐次记账；任何真实 `>=10s` 样本都令对应版本失败，不能用 observer 或 UI 时间掩盖。 |
| O-02 | `foregroundStart` 在上一轮仍 `nativeOutputPending` 时，为保证不覆盖未结算输出，会先完成 native observer 结算。 | observer 热循环已消除，历史真实正常续聊为 8.938 秒；异常超大未结算输出仍需持续用分段 trace 观察，不能靠跳过结算制造假通过。 |
| O-03 | Codex/Claude 有原生 Provider ingress；其他 CLI 当前主要依赖与本轮身份精确绑定的 Agent MCP start。OpenCode 的 serve/attach 同 PTY 续聊合同尚未实现。 | 不把 Codex 实测外推成所有 Provider 已验收，也不把未实现能力写成已完成。主线先闭合当前真实配置 Codex；多 Provider 缺口保留为明确架构边界。 |
| O-04 | Telegram、scheduled/effect 等入口已通过完整契约回归，但本轮没有可用外部 Telegram 账号做同等级真实 Provider 门禁。 | 不把本地契约测试表述为外部账号实测；这些入口继续复用同一持久 run/interaction/runner 主路径和 10 秒 verdict。 |
| O-05 | 每个唯一工作树基线都必须被 Git 对象和受控 ref 保留，才能保证历史对话可撤回；这会随真正不同的任务基线增长。 | 本版先用确定性提交消除“相同 HEAD + 相同工作树”的重复增长。不得在没有逐 run 引用审计和用户明确清理授权时自动删除 ref；后续容量治理必须以 durable run/conversation 引用为保留根，先观测数量、字节和增长速率，再只回收已明确退休且无引用的基线。 |

## 5. 接下来的强制验收顺序

1. 0.0.625/r13 VSIX 已生成并通过包结构审计。
2. 正式 0.0.624 → 0.0.625 Runtime 接管、旧进程退出和新 endpoint health 已通过。
3. 两个 CPU 负载下真实 Solo 新对话已于 7.569 秒进入 Codex task。
4. MCP 完成、项目 profile、Git hidden ref、HEAD 与用户文件不变已在同一 gate 验证；正常续聊由历史真实 8.938 秒样本和最终代码回归共同覆盖。
5. interaction 可直接给出 Provider start、observer delay、MCP、profile 和 Git 分段证据。
6. 完整测试 2679 项已自然退出，2678 通过、0 失败、1 个环境条件跳过。
7. 已提交并推送 `main`；CI 与发布链成功，Security 的既有依赖告警单独记录，不冒充本次启动链回归。

## 6. 关联证据入口

- 全链路审计：`docs/ui/conversation-terminal-launch-audit-2026-10-25.zh.md`
- 本地体验基线：`docs/ui/local-first-loading-interaction-baseline.zh.md`
- 前台 runner bridge：`src/foregroundAgentTerminal.ts`
- 交互预算：`src/interactionBudget.ts`
- Provider task receipt：`src/providerTaskIngress.ts`
- 原生日志观察：`src/runNativeObserver.ts`
- 对话入口与续聊：`src/extension.ts`
- 正式 runner：`src/runAgentProcess.ts`

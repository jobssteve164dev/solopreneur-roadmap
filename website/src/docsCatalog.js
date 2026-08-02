const UPDATED_AT = "2026-08-02";

function page(category, title, description, heading, lead, sections, faq, related = []) {
  return { category, title, description, heading, lead, sections, faq, related, updatedAt: UPDATED_AT };
}

export const docsCatalog = {
  en: {
    index: {
      title: "SoloMap Docs: Start, Integrate Agents, and Keep AI Projects Moving",
      description: "Practical SoloMap guides for setup, AI coding roadmaps, local-first project continuity, Agent CLI integrations, and tool selection.",
      heading: "Go from scattered AI chats to the next verified step.",
      lead: "Start in minutes, connect the Agent CLI you already use, and build a durable project workflow around plain local files.",
      categories: [
        ["Start", "Start here"],
        ["Solve", "Solve a workflow problem"],
        ["Integrate", "Connect an Agent CLI"],
        ["Choose", "Choose the right workflow"],
        ["Method", "Understand the method"]
      ]
    },
    pages: {
      "getting-started": page(
        "Start",
        "SoloMap Quick Start",
        "Install SoloMap, register a local project, create your first roadmap, and run a focused Agent task from VS Code.",
        "Start using SoloMap in about five minutes",
        "You need VS Code, a local project folder, and at least one supported Agent CLI installed on your machine.",
        [
          { title: "1. Install and open SoloMap", copy: "Install the extension from VS Code Marketplace or Open VSX. Open your project folder, then run ‘SoloMap: Show AI Roadmap’ from the Command Palette." },
          { title: "2. Register the current project", copy: "Choose the folder you want SoloMap to manage. SoloMap creates project records under .solopreneur/ in that folder; your roadmap remains inspectable and Git-friendly." },
          { title: "3. Choose your local Agent CLI", copy: "Open SoloMap settings, select Codex, Claude Code, Cursor, Copilot, OpenCode, Antigravity, or enter a custom executable path. Use the built-in check before the first run." },
          { title: "4. Create and run the first step", copy: "Describe the outcome you want, review the generated roadmap, open one active step, and send a bounded task to your Agent. Verify the result before moving the step forward." },
          { title: "What success looks like", copy: "After the first run you should have a readable roadmap, one task tied to a specific step, visible execution output, and evidence you can use to decide what happens next." }
        ],
        [
          ["Does SoloMap include an AI model?", "No. SoloMap coordinates Agent CLIs installed on your machine. Model access, sign-in, and usage charges remain with the Agent provider you choose."],
          ["Does setup upload my repository?", "No. Core project records and run history stay in your local workspace by default."],
          ["Where should I go next?", "Read the guide for your Agent CLI, then use the resume-project guide when you return after a break."]
        ],
        ["agents/codex", "agents/claude-code", "agents/cursor", "resume-ai-coding-projects"]
      ),
      "ai-coding-project-roadmap": page(
        "Solve",
        "How to Build an AI Coding Project Roadmap",
        "Create an AI coding roadmap that keeps product goals, Agent tasks, verification, launch work, and feedback connected.",
        "Build an AI coding roadmap that survives real execution",
        "A useful roadmap does more than divide code into tickets. It preserves why the project exists, what users need next, and what evidence closes each step.",
        [
          { title: "Start with an observable outcome", copy: "Write the change a user should be able to experience. Avoid a roadmap made only of internal components, frameworks, or implementation nouns." },
          { title: "Split the journey into Build, Sell, Learn, and Improve", copy: "Build creates the usable result. Sell makes it discoverable and trustworthy. Learn captures market and usage evidence. Improve turns that evidence into the next decision." },
          { title: "Give every active step a boundary", copy: "Record the intended result, completion criteria, relevant files, known constraints, and the smallest useful verification. The Agent should not have to infer the project boundary from an old chat." },
          { title: "Close with evidence, not confidence", copy: "A successful Agent message is not proof. Use tests, rendered output, logs, diffs, or direct user feedback before marking a step complete." },
          { title: "Keep only the next useful detail visible", copy: "A roadmap should reduce cognitive load. Keep long research and raw logs in linked records, while the active view answers: where are we, what matters now, and what proves it is done?" }
        ],
        [
          ["How detailed should an AI coding roadmap be?", "Detailed enough that one step has a clear outcome and verification, but not so detailed that the roadmap duplicates every code edit."],
          ["Should marketing and feedback be in a developer roadmap?", "Yes when the goal is a product. Shipping code without discovery, trust, feedback, or learning leaves the product loop open."]
        ],
        ["solomap-method", "micro-execution-loop", "resume-ai-coding-projects"]
      ),
      "resume-ai-coding-projects": page(
        "Solve",
        "How to Resume an AI Coding Project Without Losing Context",
        "Resume an AI-assisted coding project after a break using roadmap state, local history, touched files, and verification evidence.",
        "Resume the project without rereading every AI chat",
        "The goal is not to remember the conversation. It is to recover the last verified project state and choose the next bounded action.",
        [
          { title: "Read the roadmap before opening a new chat", copy: "Locate the active step, its completion criteria, and any blocked dependency. This restores project intent before a new Agent starts proposing work." },
          { title: "Separate claims from verified facts", copy: "Review the last result, touched files, test output, and handoff. Treat unverified Agent summaries as leads, not as completed work." },
          { title: "Check the current repository state", copy: "Code and logs may have changed since the last session. Confirm the working tree and run the narrowest relevant validation before continuing." },
          { title: "Continue with one explicit outcome", copy: "Tell the Agent what must change, what must remain stable, and how completion will be checked. Do not ask it to ‘continue’ without a boundary." },
          { title: "Leave a better handoff than you found", copy: "Record the result, remaining risk, and next action. The next session should start from project facts instead of chat archaeology." }
        ],
        [
          ["Why not paste the entire old chat into a new Agent session?", "Long transcripts add noise and may preserve obsolete assumptions. A concise handoff tied to current files and evidence is usually safer."],
          ["What if the roadmap and code disagree?", "Treat the code, tests, logs, and current user direction as stronger evidence, then correct the roadmap through the normal project workflow."]
        ],
        ["getting-started", "micro-execution-loop", "local-first-ai-project-management"]
      ),
      "local-first-ai-project-management": page(
        "Solve",
        "Local-first Project Management for AI Coding Agents",
        "Understand how local-first project records make AI coding work portable, inspectable, Git-friendly, and easier to resume.",
        "Keep project continuity beside the code",
        "Local-first means the durable project record stays in files you control. It does not mean every Agent provider or optional account feature runs offline.",
        [
          { title: "What stays local", copy: "SoloMap keeps the roadmap, project journal, step memory, Agent run records, and reusable local context in your workspace or configured local data directory." },
          { title: "What remains provider-dependent", copy: "When you run Codex, Claude Code, Cursor, or another Agent CLI, that tool follows its own authentication, model, network, privacy, and billing terms." },
          { title: "Why plain files matter", copy: "A CSV roadmap and readable records can be inspected, diffed, reviewed, backed up, and versioned with the project. Your workflow is not locked inside an opaque hosted board." },
          { title: "What the website measures", copy: "The public website may record anonymous aggregate page and CTA events without cookies. It does not receive your repository, roadmap, prompt, or local Agent history from the extension." },
          { title: "A practical backup rule", copy: "Commit project records you want to share with collaborators; keep secrets and private runtime data out of Git using the repository’s established ignore rules." }
        ],
        [
          ["Is SoloMap fully offline?", "The core project record is local, but the Agent CLI you choose may require a network connection. Marketplace installation and optional website account features also use network services."],
          ["Can I inspect or move my roadmap?", "Yes. The roadmap is stored as a readable local file and can move with the project folder."]
        ],
        ["getting-started", "resume-ai-coding-projects", "compare/solomap-vs-task-managers"]
      ),
      "agents/codex": page(
        "Integrate",
        "Use Codex CLI with SoloMap",
        "Configure Codex as a local Agent in SoloMap, test the executable, run a roadmap step, and keep the result tied to project evidence.",
        "Use Codex from the roadmap step that needs it",
        "SoloMap does not replace Codex. It gives Codex a bounded project step, visible execution path, and durable local handoff.",
        [
          { title: "Before you start", copy: "Install and authenticate Codex CLI according to its provider documentation. Confirm that the codex command works in a normal terminal." },
          { title: "Select Codex in SoloMap", copy: "Open SoloMap settings and choose codex. If your executable uses another name or path, enter that custom executable and run the built-in dependency check." },
          { title: "Run a bounded task", copy: "Open the active roadmap step, state the exact outcome, attach only relevant files when needed, choose a model if available, and start the run in VS Code’s terminal." },
          { title: "Verify and hand off", copy: "Review changed files and the requested checks. Record what was verified, what remains risky, and the next action before moving the roadmap step." }
        ],
        [
          ["Does SoloMap install or pay for Codex?", "No. Codex installation, authentication, model access, and provider charges remain separate."],
          ["Can I use a custom Codex executable path?", "Yes. SoloMap accepts a command name or an absolute executable path."]
        ],
        ["getting-started", "micro-execution-loop", "agents/claude-code"]
      ),
      "agents/claude-code": page(
        "Integrate",
        "Use Claude Code with SoloMap",
        "Connect Claude Code to SoloMap, run it from a roadmap step, and preserve scoped context and verification in the local project record.",
        "Give Claude Code a durable place in the project loop",
        "Use Claude Code for execution while SoloMap keeps the project goal, roadmap boundary, evidence, and next action visible.",
        [
          { title: "Before you start", copy: "Install and authenticate Claude Code using its official instructions, then confirm the claude command is available in your terminal." },
          { title: "Select Claude in SoloMap", copy: "Choose claude in Agent settings or enter the executable path used on your machine. Run the dependency check before dispatching the first task." },
          { title: "Send the active step", copy: "Describe the outcome and completion criteria in user language. Keep unrelated roadmap work out of the prompt so the Agent can stay inside the intended boundary." },
          { title: "Review before advancing", copy: "Inspect the repository changes and run the relevant validation. Preserve a concise result and handoff for the next SoloMap session." }
        ],
        [
          ["Does SoloMap change Claude Code’s privacy terms?", "No. Claude Code continues to use its own provider account, network behavior, and terms."],
          ["Can Claude Code be used as the secondary reviewer?", "SoloMap supports an optional secondary Agent for read-only review; availability depends on your installed CLI and selected review mode."]
        ],
        ["getting-started", "micro-execution-loop", "agents/codex"]
      ),
      "agents/cursor": page(
        "Integrate",
        "Use Cursor Agent with SoloMap",
        "Configure Cursor Agent CLI in SoloMap and run focused project work from a roadmap step inside VS Code.",
        "Connect Cursor Agent to a roadmap, not another loose chat",
        "SoloMap recognizes the Cursor Agent CLI family and can resolve common executable names such as cursor-agent, cursor, and cursor-cli.",
        [
          { title: "Enable the Cursor command", copy: "Install Cursor Agent CLI or enable Cursor’s shell command according to Cursor’s current documentation. Confirm it works in a terminal before configuring SoloMap." },
          { title: "Select Cursor", copy: "Choose cursor in SoloMap settings. SoloMap checks common Cursor executable names; you can also provide the exact absolute path." },
          { title: "Run from one roadmap step", copy: "Open the step that owns the work, add the desired result and completion criteria, then start Cursor Agent in the integrated terminal." },
          { title: "Keep the outcome portable", copy: "Review files and evidence, then store the handoff with the local project record so a later session—or another supported Agent—can continue from facts." }
        ],
        [
          ["Does SoloMap replace the Cursor editor?", "No. SoloMap is a VS Code extension and a coordination layer for supported local Agent CLIs."],
          ["Which Cursor executable name should I enter?", "Start with cursor in SoloMap. If detection fails, enter the exact command or absolute path that works in your terminal."]
        ],
        ["getting-started", "agents/codex", "local-first-ai-project-management"]
      ),
      "compare/solomap-vs-task-managers": page(
        "Choose",
        "SoloMap vs General Task Managers for AI Coding Projects",
        "Compare SoloMap with general task managers by project location, Agent execution, context continuity, verification, collaboration, and reporting.",
        "Choose a roadmap cockpit or a general task manager",
        "The tools solve overlapping but different jobs. SoloMap is strongest when one developer wants local project continuity around AI Agent execution; a general task manager is stronger for broad team coordination.",
        [
          { title: "Choose SoloMap when", copy: "Your code lives in VS Code, local Agent CLIs do much of the execution, you want roadmap records beside the repository, and resuming the next technical step is the main problem." },
          { title: "Choose a general task manager when", copy: "You need organization-wide planning, many non-technical stakeholders, advanced cross-team reporting, procurement controls, or workflows that are not centered on a local codebase." },
          { title: "Use both when", copy: "A team system can hold portfolio commitments while SoloMap holds the developer’s executable local roadmap and Agent handoffs. Keep ownership clear so status is not copied blindly between tools." },
          { title: "Compare the responsibility boundary", copy: "Ask where project data lives, who updates status, how Agent changes are verified, whether history is portable, and which tool remains the source of truth for the next action." },
          { title: "The honest limitation", copy: "SoloMap is not a replacement for mature enterprise planning, issue tracking, or every collaboration workflow. Its focused advantage is continuity between a solo developer, a local repository, a roadmap, and coding Agents." }
        ],
        [
          ["Is SoloMap an alternative to Linear, Notion, or GitHub Projects?", "For an individual AI coding workflow, sometimes. For broad team planning and organization-wide reporting, those tools may remain the better system."],
          ["Can SoloMap work alongside GitHub Issues?", "Yes, but define which system owns each decision and avoid treating duplicated status as automatically synchronized."]
        ],
        ["local-first-ai-project-management", "ai-coding-project-roadmap", "portfolio-method"]
      )
    }
  },
  zh: {
    index: {
      title: "SoloMap 文档：快速上手、Agent 集成与 AI 项目推进指南",
      description: "涵盖 SoloMap 安装上手、AI 编码路线图、本地优先项目续接、Agent CLI 集成与工具选择的实用指南。",
      heading: "从零散 AI 对话，回到下一个可验证动作。",
      lead: "快速开始，接入你已经在用的本地 Agent CLI，并用可读的本地文件建立能长期续接的项目工作流。",
      categories: [
        ["Start", "快速开始"],
        ["Solve", "解决推进问题"],
        ["Integrate", "接入 Agent CLI"],
        ["Choose", "选择合适工具"],
        ["Method", "理解推进方法"]
      ]
    },
    pages: {
      "getting-started": page("Start", "SoloMap 快速上手", "安装 SoloMap、登记本地项目、创建第一份路线图，并在 VS Code 中运行一次聚焦的 Agent 任务。", "大约五分钟开始使用 SoloMap", "你需要 VS Code、一个本地项目文件夹，以及至少一个已安装在本机的 Agent CLI。", [
        { title: "1. 安装并打开 SoloMap", copy: "从 VS Code Marketplace 或 Open VSX 安装插件。打开项目文件夹，再从命令面板运行“SoloMap: Show AI Roadmap”。" },
        { title: "2. 登记当前项目", copy: "选择希望 SoloMap 管理的文件夹。SoloMap 会在项目内创建 .solopreneur/ 记录，路线图保持可读并适合 Git 管理。" },
        { title: "3. 选择本地 Agent CLI", copy: "在设置中选择 Codex、Claude Code、Cursor、Copilot、OpenCode、Antigravity，或填写自定义可执行文件路径。第一次执行前先运行内置检测。" },
        { title: "4. 创建并运行第一个环节", copy: "描述要达成的结果，检查生成的路线图，打开一个当前环节，把边界清晰的任务交给 Agent，并在推进状态前验证结果。" },
        { title: "怎样算上手成功", copy: "你应当得到一份可读路线图、一个归属于具体环节的任务、可见的执行输出，以及足以判断下一步的验证证据。" }
      ], [["SoloMap 自带 AI 模型吗？", "不带。SoloMap 调度你本机安装的 Agent CLI；模型权限、登录和费用由你选择的 Agent 服务商负责。"], ["配置过程会上传代码仓库吗？", "不会。核心项目记录和运行历史默认保存在本地工作区。"], ["下一篇应该看什么？", "先阅读你所用 Agent 的集成指南；以后中断再回来时，可使用“续接 AI 编码项目”指南。"]], ["agents/codex", "agents/claude-code", "agents/cursor", "resume-ai-coding-projects"]),
      "ai-coding-project-roadmap": page("Solve", "如何规划 AI 编码项目路线图", "建立能连接产品目标、Agent 任务、验证、发布和反馈的 AI 编码路线图。", "建立经得起真实执行的 AI 编码路线图", "有用的路线图不只是把代码拆成工单，还要保存项目为何存在、用户下一步需要什么，以及每个环节靠什么证据闭环。", [
        { title: "从可观察的用户结果开始", copy: "先写清用户最终能感受到什么变化，避免路线图只由组件、框架和内部实现名词组成。" },
        { title: "拆成 Build、Sell、Learn、Improve", copy: "Build 产出可用结果，Sell 让用户能发现并信任，Learn 收集市场与使用证据，Improve 把证据带回下一步决策。" },
        { title: "给每个当前环节明确边界", copy: "记录目标结果、完成标准、相关文件、已知约束和最小验证。不要让 Agent 从旧聊天里猜项目边界。" },
        { title: "用证据闭环，而不是用信心闭环", copy: "Agent 说“完成”不等于完成。状态推进前，应查看测试、渲染、日志、diff 或真实用户反馈。" },
        { title: "只把下一步所需信息放到前台", copy: "长研究和原始日志可以放在关联记录里；当前视图只需回答：现在在哪里、什么最重要、怎样证明完成。" }
      ], [["路线图应该多细？", "细到每个环节有明确结果和验证，但不要细到重复列出每一次代码编辑。"], ["开发路线图里需要营销和反馈吗？", "如果目标是产品，就需要。只有代码、没有发现、信任、反馈和学习，产品闭环仍然没有完成。"]], ["solomap-method", "micro-execution-loop", "resume-ai-coding-projects"]),
      "resume-ai-coding-projects": page("Solve", "如何续接中断的 AI 编码项目", "通过路线图状态、本地历史、改动文件和验证证据，在中断后安全续接 AI 编码项目。", "不用重读所有 AI 对话，也能继续推进", "目标不是记住整段聊天，而是恢复最后一次被验证的项目状态，并选择下一个边界清晰的动作。", [
        { title: "开新对话前先读路线图", copy: "找到当前环节、完成标准和阻塞依赖，先恢复项目意图，再让新的 Agent 提方案。" },
        { title: "把声明与事实分开", copy: "查看上次结果、改动文件、测试输出和交接记录；未验证的 Agent 总结只能当线索，不能当已完成事实。" },
        { title: "核对当前仓库状态", copy: "代码和日志可能已经变化。继续前先检查工作区，并运行影响范围内最窄的验证。" },
        { title: "用一个明确结果继续", copy: "告诉 Agent 必须改变什么、必须保持什么、怎样验收；不要只说一句“继续”。" },
        { title: "留下更容易续接的交接", copy: "记录结果、剩余风险和下一动作，让下一次从项目事实开始，而不是考古聊天记录。" }
      ], [["为什么不直接把旧聊天全部贴给新 Agent？", "长对话会带来噪音，也可能保留已经失效的假设。绑定当前文件和证据的简洁交接通常更可靠。"], ["路线图与代码冲突时听谁的？", "以当前代码、测试、日志和用户最新方向为准，再通过正常项目流程纠正路线图。"]], ["getting-started", "micro-execution-loop", "local-first-ai-project-management"]),
      "local-first-ai-project-management": page("Solve", "面向 AI 编码 Agent 的本地优先项目管理", "了解本地优先的项目记录如何让 AI 编码工作更可迁移、可检查、Git 友好并容易续接。", "把项目连续性留在代码旁边", "本地优先指长期项目记录保存在你控制的文件里，并不表示每个 Agent 服务或可选账号功能都能离线运行。", [
        { title: "哪些内容保存在本地", copy: "SoloMap 会把路线图、项目日志、环节记忆、Agent 运行记录和可复用上下文保存在工作区或你配置的本地数据目录。" },
        { title: "哪些仍由服务商决定", copy: "运行 Codex、Claude Code、Cursor 或其他 Agent CLI 时，登录、模型、网络、隐私和计费仍遵循对应工具自己的规则。" },
        { title: "为什么可读文件重要", copy: "CSV 路线图和可读记录可以检查、diff、评审、备份并随项目版本化，不会被锁进不透明的托管看板。" },
        { title: "官网会衡量什么", copy: "官网可以在不使用 Cookie 的前提下记录匿名汇总的页面与 CTA 事件；插件不会把你的仓库、路线图、提示词或本地 Agent 历史发给官网。" },
        { title: "实用备份规则", copy: "需要协作的项目记录可以提交到 Git；密钥与私有运行数据应遵循仓库既有忽略规则，不要提交。" }
      ], [["SoloMap 完全离线吗？", "核心项目记录在本地，但你选择的 Agent CLI 可能需要联网；应用市场安装和可选官网账号能力也使用网络服务。"], ["路线图能检查或迁移吗？", "可以。路线图是可读的本地文件，可以随项目文件夹一起迁移。"]], ["getting-started", "resume-ai-coding-projects", "compare/solomap-vs-task-managers"]),
      "agents/codex": page("Integrate", "在 SoloMap 中使用 Codex CLI", "把 Codex 配置为 SoloMap 的本地 Agent，检测命令、执行路线图环节，并让结果与项目证据保持关联。", "从真正需要执行的路线图环节启动 Codex", "SoloMap 不替代 Codex；它为 Codex 提供边界清晰的项目环节、可见执行路径和可长期续接的本地交接。", [
        { title: "开始前", copy: "按 Codex 官方说明安装并登录 CLI，先确认 codex 命令能在普通终端运行。" },
        { title: "在 SoloMap 选择 Codex", copy: "打开设置并选择 codex。如果本机命令名或路径不同，填写自定义可执行文件并运行内置检测。" },
        { title: "执行边界清晰的任务", copy: "打开当前环节，写清结果；需要时只附加相关文件，选择可用模型，然后从 VS Code 终端启动。" },
        { title: "验证并交接", copy: "检查改动文件和约定验证；推进路线图前记录已验证内容、剩余风险和下一动作。" }
      ], [["SoloMap 会安装 Codex 或承担费用吗？", "不会。Codex 的安装、登录、模型权限和服务费用保持独立。"], ["可以填写自定义 Codex 路径吗？", "可以。SoloMap 接受命令名或可执行文件绝对路径。"]], ["getting-started", "micro-execution-loop", "agents/claude-code"]),
      "agents/claude-code": page("Integrate", "在 SoloMap 中使用 Claude Code", "把 Claude Code 接入 SoloMap，从路线图环节运行，并把范围、验证和交接保存在本地项目记录中。", "让 Claude Code 进入可持续的项目循环", "Claude Code 负责执行，SoloMap 负责让项目目标、路线图边界、验证证据和下一动作保持可见。", [
        { title: "开始前", copy: "按 Claude Code 官方说明安装并登录，确认 claude 命令能在终端运行。" },
        { title: "在 SoloMap 选择 Claude", copy: "在 Agent 设置中选择 claude，或填写本机使用的可执行文件路径；第一次分派任务前先运行依赖检测。" },
        { title: "发送当前环节", copy: "用用户语言描述结果和完成标准，把无关路线图工作排除在提示之外，让 Agent 保持在目标边界内。" },
        { title: "推进前复核", copy: "检查仓库改动并运行相关验证，再保存简洁结果和下一次可续接的交接。" }
      ], [["SoloMap 会改变 Claude Code 的隐私规则吗？", "不会。Claude Code 继续使用自己的服务账号、网络行为和服务条款。"], ["能把 Claude Code 用作复核 Agent 吗？", "SoloMap 支持可选的只读复核 Agent；具体可用性取决于本机 CLI 和选择的复核模式。"]], ["getting-started", "micro-execution-loop", "agents/codex"]),
      "agents/cursor": page("Integrate", "在 SoloMap 中使用 Cursor Agent", "在 SoloMap 中配置 Cursor Agent CLI，并从路线图环节运行聚焦的项目任务。", "把 Cursor Agent 接到路线图，而不是再开一段散落对话", "SoloMap 能识别 Cursor Agent CLI 家族，并解析 cursor-agent、cursor、cursor-cli 等常见命令名。", [
        { title: "启用 Cursor 命令", copy: "按 Cursor 当前官方文档安装 Cursor Agent CLI 或启用 shell command，并先确认命令能在终端运行。" },
        { title: "选择 Cursor", copy: "在 SoloMap 设置中选择 cursor。SoloMap 会尝试常见命令名，也可以填写准确的绝对路径。" },
        { title: "从一个路线图环节运行", copy: "打开负责这项工作的环节，补充结果和完成标准，再从集成终端启动 Cursor Agent。" },
        { title: "让结果保持可迁移", copy: "检查文件与证据，再把交接保存在本地项目记录中，让以后会话或其他受支持 Agent 能从事实继续。" }
      ], [["SoloMap 会替代 Cursor 编辑器吗？", "不会。SoloMap 是 VS Code 插件，也是受支持本地 Agent CLI 的协调层。"], ["应该填写哪个 Cursor 命令名？", "先在 SoloMap 选择 cursor；检测失败时，填写实际能在终端工作的命令或绝对路径。"]], ["getting-started", "agents/codex", "local-first-ai-project-management"]),
      "compare/solomap-vs-task-managers": page("Choose", "SoloMap 与通用任务管理工具的区别", "从项目数据位置、Agent 执行、上下文续接、验证、协作和汇报维度比较 SoloMap 与通用任务管理工具。", "选择路线图驾驶舱，还是通用任务管理工具", "两类工具有重叠，但解决的主要任务不同：SoloMap 更适合独立开发者围绕本地代码和 Agent 执行保持连续性；通用任务工具更适合大范围团队协作。", [
        { title: "这些情况更适合 SoloMap", copy: "代码主要在 VS Code，本地 Agent CLI 承担大量执行，希望路线图随仓库保存，而且最核心的问题是快速恢复下一个技术动作。" },
        { title: "这些情况更适合通用任务工具", copy: "需要组织级规划、大量非技术协作者、跨团队高级报表、采购管控，或工作流并不以本地代码库为中心。" },
        { title: "这些情况可以同时使用", copy: "团队系统记录组合承诺，SoloMap 保存开发者可执行的本地路线图和 Agent 交接。必须明确所有权，避免盲目复制状态。" },
        { title: "比较责任边界", copy: "重点问：数据在哪里、谁更新状态、怎样验证 Agent 改动、历史是否可迁移、哪个工具决定下一动作。" },
        { title: "诚实的能力边界", copy: "SoloMap 不替代成熟的企业规划、Issue 管理或全部协作流程。它的聚焦优势是连接独立开发者、本地仓库、路线图和编码 Agent。" }
      ], [["SoloMap 能替代 Linear、Notion 或 GitHub Projects 吗？", "对个人 AI 编码工作流有时可以；对广泛团队规划和组织级汇报，这些工具可能仍然更合适。"], ["SoloMap 能与 GitHub Issues 并用吗？", "可以，但要明确每类决策由哪个系统负责，不要把重复状态当成自动同步。"]], ["local-first-ai-project-management", "ai-coding-project-roadmap", "portfolio-method"])
    }
  }
};

const REVIEWED_AT = "2026-08-27";

function entry(data) {
  return { ...data, reviewedAt: REVIEWED_AT };
}

const sources = {
  solomap: ["SoloMap source and product documentation", "https://github.com/jobssteve164dev/solopreneur-roadmap"],
  claude: ["Claude Code official documentation", "https://docs.anthropic.com/en/docs/claude-code/getting-started"],
  codex: ["Codex CLI official documentation", "https://learn.chatgpt.com/docs/codex/cli"],
  cursor: ["Cursor Agent official documentation", "https://cursor.com/docs/agent/overview"],
  githubProjects: ["GitHub Projects official documentation", "https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects"],
  linear: ["Linear Projects official documentation", "https://linear.app/docs/projects"],
  notion: ["Notion task databases and sprints documentation", "https://www.notion.com/help/sprints"]
};

export const comparisonCatalog = {
  en: {
    hub: {
      title: "Compare AI Coding Agents and Project Workflows | SoloMap",
      description: "Honest comparisons for choosing AI coding agents, editors, task managers, and the working agreement that keeps projects aligned across sessions.",
      heading: "Compare Agents, project tools, and the agreement around them.",
      lead: "Use this directory to decide what should write code, what should coordinate work, and what should preserve verified project state. SoloMap is not forced into every verdict.",
      directTitle: "Direct comparison pages",
      directLead: "Head-to-head decisions between a working agreement, coding Agents, editors, and project systems.",
      alternativeTitle: "Alternative guides",
      alternativeLead: "Start from the job you need done, then compare options that solve genuinely different versions of it."
    },
    alternativesHub: {
      title: "AI Coding Agent and Project Workflow Alternatives | SoloMap",
      description: "Compare alternatives to Claude Code and conventional AI coding project management, with honest guidance on when each option fits.",
      heading: "Choose an alternative by the job you need done.",
      lead: "Replacing an Agent, replacing a project tracker, and adding a durable working agreement are different decisions. These guides keep those decisions separate."
    },
    pages: {
      "solomap-vs-claude-code": entry({
        kind: "comparison",
        category: "Working agreement vs coding Agent",
        title: "SoloMap vs Claude Code: Project Agreement or Coding Agent?",
        description: "Compare SoloMap and Claude Code by execution, project continuity, boundaries, evidence, local records, and the situations where they work best together.",
        heading: "SoloMap vs Claude Code",
        subheading: "A durable project agreement versus a terminal coding Agent",
        verdict: "Claude Code performs coding work. SoloMap defines the project outcome, boundaries, evidence, and verified state around that work. For most SoloMap users, this is a complement decision—not a replacement decision.",
        choices: [
          ["Choose Claude Code", "when your main need is a capable Agent that can inspect a repository, edit files, run commands, and iterate with you in the terminal."],
          ["Choose SoloMap", "when the harder problem is keeping goals, permissions, completion criteria, evidence, and the next step consistent across Agent sessions."],
          ["Use both", "when you want Claude Code to execute from a bounded roadmap step and want the accepted result to become durable project context."]
        ],
        columns: ["Decision", "SoloMap", "Claude Code"],
        rows: [
          ["Primary job", "Maintain the human-Agent working agreement and verified project state", "Inspect, edit, run, and reason about code"],
          ["Where work begins", "A roadmap step with an outcome, boundary, and completion criteria", "A terminal prompt or resumed Claude Code session"],
          ["Agent execution", "Launches the local Agent CLI you choose", "Provides the coding Agent itself"],
          ["Completion", "User accepts reviewable evidence before project state advances", "Reports results inside the Agent session"],
          ["Continuity", "Keeps roadmap, run records, handoff, and project memory beside the workspace", "Can continue or resume Claude Code conversations"],
          ["Best fit", "Long-running projects that may span sessions or Agents", "Hands-on repository implementation and debugging"]
        ],
        scenarioTitle: "The practical workflow",
        scenarios: [
          ["Before the run", "Use SoloMap to state what must become true, what Claude Code may change, and what evidence will count."],
          ["During the run", "Claude Code reads the repository, edits code, runs commands, and asks for direction inside its own permission model."],
          ["After the run", "Review the actual files and checks, then let SoloMap preserve the accepted result and next action for another session or Agent."]
        ],
        limitation: "SoloMap does not provide Claude models or replace Claude Code's coding capabilities. Claude Code does not automatically become the authority for your roadmap or your definition of done.",
        faq: [
          ["Does SoloMap include Claude Code?", "No. Install and authenticate Claude Code separately, then select its local CLI in SoloMap."],
          ["Can I switch away from Claude Code later?", "Yes. SoloMap is designed to keep project context outside one Agent conversation, but each replacement Agent still has its own capabilities and terms."],
          ["Which one should I install first?", "Install a coding Agent first if you cannot yet execute code. Add SoloMap when continuity, boundaries, and verified handoff become the bottleneck."]
        ],
        sources: [sources.solomap, sources.claude],
        related: ["solomap-vs-codex", "claude-code-vs-codex", "solomap-vs-cursor"]
      }),
      "solomap-vs-codex": entry({
        kind: "comparison",
        category: "Working agreement vs coding Agent",
        title: "SoloMap vs Codex: Project Continuity or Coding Execution?",
        description: "Compare SoloMap and OpenAI Codex across local execution, permissions, project memory, evidence, roadmap continuity, and when to use both.",
        heading: "SoloMap vs Codex",
        subheading: "A project working agreement versus a multi-surface coding Agent",
        verdict: "Codex is the Agent that inspects, edits, runs, and reviews code. SoloMap is the agreement that tells any selected Agent which project outcome matters and what evidence moves the project forward.",
        choices: [
          ["Choose Codex", "when you need an Agent for implementation, review, terminal work, or delegated coding tasks."],
          ["Choose SoloMap", "when you already have an Agent but project intent and verified continuity keep disappearing between runs."],
          ["Use both", "when Codex should execute one explicit roadmap step while SoloMap preserves the result, handoff, and next state."]
        ],
        columns: ["Decision", "SoloMap", "Codex"],
        rows: [
          ["Primary job", "Preserve outcome, boundaries, authority, evidence, and project memory", "Inspect, edit, run, review, and automate code work"],
          ["Execution surface", "VS Code roadmap and the local Agent CLI selected by the user", "CLI, IDE, app, cloud, and automation surfaces"],
          ["Instructions", "Project and step context organized around the active outcome", "Agent instructions, rules, permissions, and session prompts"],
          ["Evidence", "Stored as the basis for accepting completion and continuing", "Produced through diffs, commands, reviews, and Agent output"],
          ["Agent choice", "Designed to work with more than one local Agent CLI", "Provides the Codex execution environment"],
          ["Best fit", "Cross-session project control and human judgment", "Software engineering execution and review"]
        ],
        scenarioTitle: "Where the boundary matters",
        scenarios: [
          ["Codex can remember instructions", "That helps Codex work well, but a product roadmap still needs a user-owned record of which outcome is active and what was accepted."],
          ["SoloMap can launch Codex", "That does not make SoloMap a model provider; authentication, models, usage, and execution behavior remain Codex responsibilities."],
          ["The useful combination", "Keep the agreement stable in SoloMap and let Codex remain replaceable as the implementation engine."]
        ],
        limitation: "SoloMap cannot perform Codex's coding work, and it does not unify every Codex surface today. Codex can maintain Agent instructions, but it is not a substitute for a user-owned multi-stage project roadmap.",
        faq: [
          ["Is SoloMap a Codex alternative?", "Not as a coding Agent. It is an alternative to managing Codex work through disconnected prompts and manual project notes."],
          ["Does SoloMap pay for Codex usage?", "No. Codex access, authentication, models, and charges remain with OpenAI or the environment you use."],
          ["Can another Agent continue after Codex?", "SoloMap can preserve a concise verified handoff for another supported local Agent, although tool-specific capabilities still differ."]
        ],
        sources: [sources.solomap, sources.codex],
        related: ["solomap-vs-claude-code", "claude-code-vs-codex", "solomap-vs-cursor"]
      }),
      "solomap-vs-cursor": entry({
        kind: "comparison",
        category: "Working agreement vs AI editor",
        title: "SoloMap vs Cursor: Project Agreement or AI Code Editor?",
        description: "Compare SoloMap and Cursor by editor experience, Agent execution, local project records, completion evidence, and cross-session continuity.",
        heading: "SoloMap vs Cursor",
        subheading: "A VS Code working agreement versus an AI-first code editor",
        verdict: "Cursor puts a coding Agent inside an AI-first editor. SoloMap stays inside VS Code and adds a user-owned roadmap, boundaries, evidence, and handoff around whichever local Agent CLI you choose.",
        choices: [
          ["Choose Cursor", "when you want the editor itself to provide integrated AI planning, edits, terminal tools, checkpoints, and cloud Agents."],
          ["Choose SoloMap", "when you want to keep VS Code and coordinate Agent work through local roadmap state and explicit completion evidence."],
          ["Use both", "when Cursor Agent CLI is your executor but the broader product roadmap and handoff should remain tool-independent."]
        ],
        columns: ["Decision", "SoloMap", "Cursor"],
        rows: [
          ["Product type", "VS Code extension and local-first project agreement", "AI-first code editor and coding Agent"],
          ["Main interface", "Roadmap, active step, runs, evidence, and project memory", "Editor, Agent panel, diffs, terminal tools, and checkpoints"],
          ["Coding Agent", "Uses a supported local Agent CLI", "Includes Cursor Agent and cloud Agent workflows"],
          ["Project record", "Readable local roadmap and SoloMap records", "Editor rules, conversations, checkpoints, and connected repository workflows"],
          ["Switching tools", "Keeps the project agreement separate from one Agent", "Optimized around the Cursor product environment"],
          ["Best fit", "Developers preserving VS Code and cross-session project control", "Developers wanting AI deeply integrated into the editor"]
        ],
        scenarioTitle: "Choose by the layer you want to change",
        scenarios: [
          ["Change the editor", "Choose Cursor if its integrated Agent experience is the main value you want."],
          ["Keep the editor", "Choose SoloMap if VS Code remains home and the missing layer is durable coordination around Agent work."],
          ["Separate execution from project truth", "Use Cursor for coding and SoloMap for the outcome, evidence, and next verified state when that split reduces lock-in."]
        ],
        limitation: "SoloMap does not reproduce Cursor's editor-native completion, checkpoints, or cloud Agent environment. Cursor has broader integrated coding features; SoloMap is narrower and focused on the working agreement.",
        faq: [
          ["Does SoloMap replace Cursor?", "No. SoloMap is a VS Code extension, while Cursor is an editor and Agent product."],
          ["Can SoloMap run Cursor Agent?", "SoloMap supports the Cursor Agent CLI family when the executable is installed and available locally."],
          ["Which is more local-first?", "SoloMap keeps its core roadmap records in your workspace. Cursor's local and cloud features have different data and execution boundaries, so review the feature you plan to use."]
        ],
        sources: [sources.solomap, sources.cursor],
        related: ["solomap-vs-claude-code", "solomap-vs-codex", "claude-code-vs-codex"]
      }),
      "solomap-vs-linear": entry({
        kind: "comparison",
        category: "Local agreement vs team planning",
        title: "SoloMap vs Linear for AI Coding Projects",
        description: "Compare SoloMap and Linear for AI coding projects across roadmap ownership, issue tracking, Agent execution, evidence, collaboration, and reporting.",
        heading: "SoloMap vs Linear",
        subheading: "Local Agent continuity versus team issue and project planning",
        verdict: "Linear is stronger for team issues, projects, cycles, and shared product planning. SoloMap is stronger when one developer needs a local roadmap connected directly to Agent execution and verified handoff.",
        choices: [
          ["Choose Linear", "when multiple people coordinate issues, projects, milestones, cycles, and product updates in a shared workspace."],
          ["Choose SoloMap", "when the main user is a solo developer running local coding Agents and preserving executable context beside the code."],
          ["Use both", "when Linear owns team commitments while SoloMap owns the developer's local Agent run and evidence trail."]
        ],
        columns: ["Decision", "SoloMap", "Linear"],
        rows: [
          ["Primary unit", "Roadmap stage, active step, Agent run, and evidence", "Issue, project, initiative, cycle, and team"],
          ["Source of truth", "Local workspace records beside the project", "Shared Linear workspace"],
          ["Agent execution", "Starts a selected local Agent CLI from the active step", "Coordinates product work and integrations; not a local CLI launcher"],
          ["Completion", "User accepts evidence tied to the run and step", "Issue and project workflow states"],
          ["Collaboration", "Optimized for one builder and optional handoff", "Designed for multi-person product and engineering teams"],
          ["Reporting", "Next action and local project continuity", "Team views, project progress, cycles, and portfolio coordination"]
        ],
        scenarioTitle: "Use one source of truth per decision",
        scenarios: [
          ["Team promise", "Keep externally shared delivery commitments and cross-team ownership in Linear."],
          ["Local execution", "Keep the exact Agent prompt boundary, run evidence, and next technical action in SoloMap."],
          ["Avoid status theater", "Do not duplicate every state automatically. Decide which system owns the commitment and which owns execution evidence."]
        ],
        limitation: "SoloMap is not an enterprise issue tracker and Linear is not designed to preserve a local Agent CLI execution record beside every repository by default.",
        faq: [
          ["Can SoloMap replace Linear?", "For a solo local Agent workflow, sometimes. For team planning, shared issues, cycles, and organization-wide reporting, Linear remains the stronger fit."],
          ["Can I use both without duplicating everything?", "Yes. Let Linear own shared commitments and SoloMap own the bounded local execution record."],
          ["Which tool should define done?", "The team can define acceptance in Linear, while the developer keeps the concrete verification evidence with the local run in SoloMap."]
        ],
        sources: [sources.solomap, sources.linear],
        related: ["solomap-vs-github-projects", "solomap-vs-notion", "solomap-vs-claude-code"]
      }),
      "solomap-vs-notion": entry({
        kind: "comparison",
        category: "Local agreement vs flexible workspace",
        title: "SoloMap vs Notion for AI Coding Project Management",
        description: "Compare SoloMap and Notion for AI coding projects across documentation, databases, Agent execution, local records, verification, and project continuity.",
        heading: "SoloMap vs Notion",
        subheading: "Executable local project context versus a flexible documentation workspace",
        verdict: "Notion is the broader workspace for documents, databases, tasks, and shared knowledge. SoloMap is the focused local workflow for turning one roadmap step into an Agent run, evidence, and a verified next state.",
        choices: [
          ["Choose Notion", "when you need flexible documents, databases, task views, sprints, and knowledge sharing across many kinds of work."],
          ["Choose SoloMap", "when the work is anchored to a code repository and local Agent execution is the center of the workflow."],
          ["Use both", "when Notion explains the product or business context and SoloMap owns the executable technical roadmap beside the code."]
        ],
        columns: ["Decision", "SoloMap", "Notion"],
        rows: [
          ["Primary job", "Human-Agent working agreement for a code project", "Flexible documents, databases, tasks, and knowledge workspace"],
          ["Structure", "Purpose-built roadmap, steps, runs, evidence, and memory", "User-designed pages, properties, views, tasks, and relations"],
          ["Data location", "Core project records stay in the local workspace", "Workspace content is managed in Notion's service"],
          ["Agent action", "Starts local Agent CLI work from an active step", "Organizes context and tasks; integrations vary by plan and setup"],
          ["Verification", "Evidence is part of deciding whether a step advances", "Completion is represented through database and task properties"],
          ["Best fit", "Solo builders shipping code with local Agents", "Flexible cross-functional documentation and collaboration"]
        ],
        scenarioTitle: "Split narrative context from execution context",
        scenarios: [
          ["Product knowledge", "Use Notion for research, meeting notes, specs, and material that many roles need to shape."],
          ["Agent-ready action", "Use SoloMap for the exact technical outcome, boundaries, allowed action, and completion evidence."],
          ["Link, do not mirror", "Reference the relevant Notion decision from SoloMap instead of copying whole databases into local Agent context."]
        ],
        limitation: "SoloMap is deliberately less flexible than Notion and does not replace a general knowledge base. Notion can model roadmaps, but a custom database does not automatically become a local Agent execution and evidence loop.",
        faq: [
          ["Can I build a SoloMap-like board in Notion?", "You can model stages and tasks, but local CLI launching, run history, and evidence-based handoff require additional workflow design or integrations."],
          ["Is SoloMap a Notion alternative?", "Only for the narrow job of managing an AI coding roadmap beside the code. It is not a general docs or knowledge workspace replacement."],
          ["Where should the product spec live?", "Keep it where collaborators can maintain it. Put only the bounded, current technical context needed for Agent execution into SoloMap."]
        ],
        sources: [sources.solomap, sources.notion],
        related: ["solomap-vs-linear", "solomap-vs-github-projects", "solomap-vs-cursor"]
      }),
      "solomap-vs-github-projects": entry({
        kind: "comparison",
        category: "Local agreement vs repository planning",
        title: "SoloMap vs GitHub Projects for AI Coding Work",
        description: "Compare SoloMap and GitHub Projects across issues, pull requests, roadmaps, local Agent execution, evidence, collaboration, and project continuity.",
        heading: "SoloMap vs GitHub Projects",
        subheading: "Local Agent execution context versus repository-connected planning",
        verdict: "GitHub Projects is stronger for shared planning around issues and pull requests. SoloMap is stronger for the private, local execution loop between one developer, a roadmap step, and a chosen coding Agent.",
        choices: [
          ["Choose GitHub Projects", "when issues, pull requests, contributors, custom fields, boards, and roadmaps should stay connected on GitHub."],
          ["Choose SoloMap", "when you need to launch local Agent work with the right context and preserve evidence before moving the project."],
          ["Use both", "when GitHub owns public or team-visible work while SoloMap owns the developer's local execution agreement."]
        ],
        columns: ["Decision", "SoloMap", "GitHub Projects"],
        rows: [
          ["Primary items", "Roadmap steps, Agent runs, handoffs, and evidence", "Issues, pull requests, draft items, fields, and project views"],
          ["Location", "Local workspace and Git-friendly project records", "GitHub-hosted project linked to repository activity"],
          ["Views", "Purpose-built roadmap and next-action surfaces", "Table, board, roadmap, filters, groups, and charts"],
          ["Agent execution", "Starts supported local Agent CLIs", "Tracks development work; Actions and integrations are separate mechanisms"],
          ["Completion", "Accepted from concrete run evidence", "Item status and repository events"],
          ["Best fit", "Private solo execution continuity", "Shared repository planning and contributor coordination"]
        ],
        scenarioTitle: "A clean two-layer workflow",
        scenarios: [
          ["Public work", "Keep issues, feature requests, and pull-request status in GitHub Projects when collaborators need visibility."],
          ["Private execution", "Use SoloMap to keep the exact local context, Agent run, and evidence that may be too detailed for the shared board."],
          ["Promote only verified state", "Update the GitHub item after the local result is reviewed rather than treating an Agent message as completion."]
        ],
        limitation: "SoloMap does not replace GitHub collaboration, issue discussion, or pull-request workflows. GitHub Projects does not by itself launch and govern a local Agent CLI run from a user-owned working agreement.",
        faq: [
          ["Should a solo open-source developer use both?", "Often yes: GitHub can expose community-facing work while SoloMap keeps the private local execution path concise."],
          ["Does SoloMap synchronize GitHub Project status?", "Do not assume automatic synchronization. Define which system owns each status and update it through an explicit workflow."],
          ["Which one is the repository source of truth?", "Git remains the code authority. GitHub Projects can own shared planning; SoloMap can own the local next action and its verification record."]
        ],
        sources: [sources.solomap, sources.githubProjects],
        related: ["solomap-vs-linear", "solomap-vs-notion", "solomap-vs-codex"]
      }),
      "claude-code-vs-codex": entry({
        kind: "comparison",
        category: "Coding Agent comparison",
        title: "Claude Code vs Codex for Local Agent Work",
        description: "Compare Claude Code and OpenAI Codex by local CLI workflow, permissions, resumability, execution surfaces, and how to keep project context portable.",
        heading: "Claude Code vs Codex",
        subheading: "Two coding Agents; one separate project-continuity decision",
        verdict: "Both tools can inspect repositories, edit files, and run commands. Choose by the models, permission flow, execution surfaces, and ecosystem you prefer. Use SoloMap only if you also need a durable project agreement outside either Agent session.",
        choices: [
          ["Choose Claude Code", "when Anthropic's terminal workflow, session continuation, permission model, and Claude ecosystem fit your daily work."],
          ["Choose Codex", "when OpenAI's CLI plus IDE, app, cloud, review, automation, and configurable permission surfaces fit better."],
          ["Keep the choice reversible", "when project goals and accepted evidence should survive a later switch between the two Agents."]
        ],
        columns: ["Decision", "Claude Code", "Codex"],
        rows: [
          ["Core role", "Coding Agent centered on Claude Code workflows", "Coding Agent available across CLI and additional Codex surfaces"],
          ["Local repository", "Reads, edits, and runs commands from the project", "Inspects, edits, and runs tools against the local repository"],
          ["Control", "Claude Code permissions, settings, hooks, and CLI flags", "Configurable permissions, sandboxing, rules, and environment modes"],
          ["Continuity", "Continue or resume Claude Code sessions", "Codex session history plus instructions such as AGENTS.md"],
          ["Remote work", "Capabilities depend on the Claude Code surface and integrations used", "Includes cloud and delegated execution surfaces in addition to local CLI"],
          ["Project roadmap", "Not a dedicated multi-stage product roadmap", "Not a dedicated multi-stage product roadmap"]
        ],
        scenarioTitle: "Run the same acceptance test",
        scenarios: [
          ["Use one real task", "Give both Agents the same bounded repository task, completion criteria, and allowed changes."],
          ["Compare the evidence", "Review diff quality, command behavior, how each Agent handles uncertainty, and the effort required to reach a verified result."],
          ["Separate Agent quality from continuity", "A better single run does not solve where the project roadmap, accepted evidence, and next action live."]
        ],
        limitation: "Agent capabilities, available models, plans, and remote features change quickly. This page avoids benchmark claims and should be rechecked against official documentation before a high-stakes rollout.",
        faq: [
          ["Is Claude Code or Codex objectively better?", "No universal answer. Repository type, model preference, permissions, environment, and review habits change the result."],
          ["Can SoloMap use both?", "SoloMap can work with supported local CLI executables, allowing the project record to remain separate from one Agent choice."],
          ["Should I compare pricing here?", "Check current official pricing for your account and usage pattern. Pricing changes more quickly than the workflow boundary described here."]
        ],
        sources: [sources.claude, sources.codex, sources.solomap],
        related: ["solomap-vs-claude-code", "solomap-vs-codex", "solomap-vs-cursor"]
      }),
      "claude-code": entry({
        kind: "alternative",
        category: "Coding Agent alternatives",
        title: "Best Claude Code Alternatives for Long-Running AI Projects",
        description: "Compare Codex, Cursor, and SoloMap-adjacent workflows when you need an alternative to Claude Code for coding execution or project continuity.",
        heading: "Claude Code alternatives",
        subheading: "First decide whether you are replacing the Agent or fixing the workflow around it",
        verdict: "Codex and Cursor are direct execution alternatives. SoloMap is not: it is the working-agreement layer to add when Claude Code itself is fine but project continuity across sessions is the problem.",
        choices: [
          ["Codex", "for another coding Agent with local CLI, review, automation, and broader execution surfaces."],
          ["Cursor", "for an AI-first editor with integrated Agent tools, diffs, checkpoints, and cloud workflows."],
          ["SoloMap", "as a complement when you want to keep Claude Code but add a roadmap, boundaries, evidence, and portable handoff."]
        ],
        columns: ["Option", "Best when", "Important tradeoff"],
        rows: [
          ["Codex", "You want another Agent for repository implementation and terminal work", "OpenAI account, models, permissions, and product surfaces replace the Claude stack"],
          ["Cursor", "You want the editor itself to become the AI execution environment", "Changing editor is a larger workflow move than changing one CLI"],
          ["SoloMap + Claude Code", "You like Claude Code but lose project intent and evidence across sessions", "Adds coordination; it does not replace the Agent or its subscription"],
          ["Plain files + Git", "You want maximum control and accept a manual process", "Cheap and portable, but consistency depends on your own discipline"]
        ],
        scenarioTitle: "Diagnose the reason you are switching",
        scenarios: [
          ["Execution quality", "Trial Codex or Cursor against the same bounded task."],
          ["Editor experience", "Test Cursor if integrated edits and Agent surfaces matter more than terminal-first work."],
          ["Lost context", "Keep Claude Code and add SoloMap if the real failure is re-explaining goals, boundaries, and accepted state."]
        ],
        limitation: "This is not a model benchmark or price ranking. Availability and commercial terms change; confirm them on the official sites before switching.",
        faq: [
          ["What is the closest direct Claude Code alternative?", "Codex is the closest option in this guide when you want another terminal-capable coding Agent rather than a project-management layer."],
          ["Is Cursor a CLI replacement?", "Cursor is primarily an editor and Agent environment, so adopting it changes more of the daily workspace."],
          ["Why is SoloMap listed if it is not an Agent?", "Because many searches for an alternative are actually about context loss and coordination, which can be solved without replacing Claude Code."]
        ],
        sources: [sources.claude, sources.codex, sources.cursor, sources.solomap],
        related: ["solomap-vs-claude-code", "claude-code-vs-codex", "solomap-vs-cursor"]
      }),
      "ai-coding-project-management": entry({
        kind: "alternative",
        category: "Project workflow alternatives",
        title: "Best Project Management Options for AI Coding Agents",
        description: "Compare SoloMap, Linear, GitHub Projects, Notion, and a plain-files workflow for managing AI coding projects without confusing planning with Agent execution.",
        heading: "Project management for AI coding Agents",
        subheading: "Choose the system that should own the next decision—not the one with the longest feature list",
        verdict: "SoloMap fits local Agent execution continuity. Linear fits structured product teams. GitHub Projects fits repository collaboration. Notion fits flexible knowledge and planning. Plain files fit developers willing to maintain the protocol themselves.",
        choices: [
          ["SoloMap", "for a solo developer who wants roadmap steps, local Agent runs, evidence, and handoff in one project-owned workflow."],
          ["Linear or GitHub Projects", "for shared engineering commitments, issue ownership, contributor coordination, and reporting."],
          ["Notion or plain files", "for flexible documentation—or maximum local control—when you can design and maintain the execution discipline yourself."]
        ],
        columns: ["Option", "Best when", "Important tradeoff"],
        rows: [
          ["SoloMap", "Local AI coding execution and cross-session continuity are central", "Narrower than a general team or knowledge platform"],
          ["Linear", "Product and engineering teams need issues, projects, cycles, and shared planning", "Local Agent run evidence is not the primary object"],
          ["GitHub Projects", "Planning should stay close to issues, pull requests, and contributors", "Execution context can become noisy or scattered across repository objects"],
          ["Notion", "Docs, databases, specs, and cross-functional knowledge need one flexible home", "Requires custom discipline to become an Agent execution loop"],
          ["Plain files + Git", "You want complete portability and can maintain conventions manually", "No dedicated interface or automatic workflow guidance"]
        ],
        scenarioTitle: "Match the tool to the source of truth",
        scenarios: [
          ["One builder, many Agent sessions", "Start with SoloMap or a disciplined plain-file protocol."],
          ["A team ships through issues and pull requests", "Use Linear or GitHub Projects for the shared commitment layer."],
          ["Research and specs dominate", "Use Notion for knowledge, then pass only the bounded current action into the Agent workflow."]
        ],
        limitation: "No single tool should automatically own strategy, team promises, source code, Agent execution, and verification. Define the responsibility boundary before adding integrations.",
        faq: [
          ["What is the best AI project manager for a solo developer?", "SoloMap fits when local Agent execution is central; Notion or plain files may fit better when flexible planning matters more than direct execution."],
          ["Should Agent chats become the project tracker?", "Usually not. Conversations are useful execution context, but the durable project state should remain concise, reviewable, and user-owned."],
          ["Can these tools be combined?", "Yes. Keep one owner for each decision: shared commitments, local execution, code, and accepted evidence."]
        ],
        sources: [sources.solomap, sources.linear, sources.githubProjects, sources.notion],
        related: ["solomap-vs-linear", "solomap-vs-github-projects", "solomap-vs-notion"]
      })
    }
  }
};

const zhDetails = {
  "solomap-vs-claude-code": {
    category: "工作协议 vs 编码 Agent", title: "SoloMap vs Claude Code：项目工作协议还是编码 Agent？", heading: "SoloMap vs Claude Code",
    description: "从代码执行、项目连续性、权限边界、完成证据和本地记录比较 SoloMap 与 Claude Code，并判断何时组合使用。",
    subheading: "一个规定项目如何持续推进，一个负责真正读写和运行代码",
    verdict: "Claude Code 是执行者，SoloMap 是人与 Agent 之间可持续复用的项目工作协议。需要写代码时选 Claude Code；需要让目标、边界、证据和下一步跨会话保持一致时选 SoloMap；多数本地项目适合组合使用。",
    left: ["SoloMap", "保持路线图、执行边界、证据和交接连续", "不直接替你编写代码"], right: ["Claude Code", "在终端中理解、修改并运行代码", "会话执行上下文不等于长期项目协议"]
  },
  "solomap-vs-codex": {
    category: "工作协议 vs 编码 Agent", title: "SoloMap vs Codex：项目连续性还是代码执行？", heading: "SoloMap vs Codex",
    description: "比较 SoloMap 与 Codex 在代码执行、授权、项目边界、验证证据和跨会话续接上的不同职责。",
    subheading: "不要在项目控制层与编码执行者之间做假二选一",
    verdict: "Codex 负责检查、修改、运行和验证代码；SoloMap 负责把本轮工作放回用户确认的路线图和项目事实中。只需要执行时用 Codex，需要跨会话持续推进时把二者组合。",
    left: ["SoloMap", "让执行对齐当前路线图环节与验收标准", "不提供独立编码模型"], right: ["Codex", "自主完成有边界的代码任务", "不应独自决定长期路线图状态"]
  },
  "solomap-vs-cursor": {
    category: "工作协议 vs AI 编辑器", title: "SoloMap vs Cursor：工作协议还是 AI 代码编辑器？", heading: "SoloMap vs Cursor",
    description: "比较 SoloMap 和 Cursor 在编辑体验、Agent 执行、项目记忆、完成证据与工作流连续性上的分工。",
    subheading: "编辑代码的界面与约束项目推进的协议解决不同问题",
    verdict: "Cursor 是带 Agent 能力的代码编辑器；SoloMap 是可与本地 Agent CLI 配合的项目工作协议。重视一体化编辑体验选 Cursor，重视跨 Agent 的路线图连续性选 SoloMap，也可以让 Cursor 执行、SoloMap 保存约定。",
    left: ["SoloMap", "跨 Agent 保持目标、边界、证据和交接", "不是新的代码编辑器"], right: ["Cursor", "在编辑器内完成代码理解与修改", "项目路线图并非其唯一事实中心"]
  },
  "solomap-vs-linear": {
    category: "本地协议 vs 团队规划", title: "SoloMap vs Linear：本地 Agent 工作流还是团队项目管理？", heading: "SoloMap vs Linear",
    description: "比较 SoloMap 与 Linear 在个人 Agent 执行、团队承诺、路线图、证据和项目状态上的不同边界。",
    subheading: "本地执行连续性和团队协作承诺不是同一层",
    verdict: "SoloMap 更适合独立开发者在本地项目里持续推进 Agent 执行；Linear 更适合团队用 issue、project 和 cycle 管理共同承诺。个人执行选 SoloMap，团队协调选 Linear，需要时让二者各自拥有清晰边界。",
    left: ["SoloMap", "围绕本地代码与 Agent 会话推进个人项目", "不替代完整团队协作系统"], right: ["Linear", "协调团队 issue、项目、周期与里程碑", "不直接保存本地 Agent 的执行证据链"]
  },
  "solomap-vs-notion": {
    category: "本地协议 vs 灵活工作区", title: "SoloMap vs Notion：Agent 工作协议还是通用知识空间？", heading: "SoloMap vs Notion",
    description: "比较 SoloMap 与 Notion 在项目知识、结构自由度、Agent 执行、完成证据和跨会话续接上的取舍。",
    subheading: "自由组织信息与推动一次可验证执行，是两种不同需求",
    verdict: "Notion 适合灵活组织文档、数据库和跨职能知识；SoloMap 适合从当前路线图环节启动本地 Agent，并把证据和下一步带回项目。知识中枢选 Notion，执行协议选 SoloMap，两者也可分层并用。",
    left: ["SoloMap", "把项目意图转成可执行、可验证的 Agent 工作", "不追求通用知识库自由度"], right: ["Notion", "灵活承载文档、数据库和规划", "需要额外约定才能形成 Agent 执行闭环"]
  },
  "solomap-vs-github-projects": {
    category: "本地协议 vs 仓库规划", title: "SoloMap vs GitHub Projects：Agent 执行还是仓库协作？", heading: "SoloMap vs GitHub Projects",
    description: "比较 SoloMap 与 GitHub Projects 在本地 Agent 工作、issue 与 PR 协作、路线图状态和证据上的不同职责。",
    subheading: "紧贴代码仓库的团队计划，不等于本地 Agent 的工作协议",
    verdict: "GitHub Projects 适合围绕 issue、pull request 和贡献者规划工作；SoloMap 适合在本地项目内约束并续接 Agent 执行。公开协作选 GitHub Projects，本地执行连续性选 SoloMap，也可以按承诺层与执行层组合。",
    left: ["SoloMap", "管理本地 Agent 执行边界、证据与交接", "不替代 issue 和 PR 协作"], right: ["GitHub Projects", "让计划贴近 issue、PR 与贡献者", "本地会话上下文可能分散在多个仓库对象中"]
  },
  "claude-code-vs-codex": {
    category: "编码 Agent 对比", title: "Claude Code vs Codex：如何选择本地编码 Agent？", heading: "Claude Code vs Codex",
    description: "从终端工作流、代码修改、权限控制、会话续接和项目协议边界比较 Claude Code 与 Codex。",
    subheading: "选择执行者时，也要把长期项目事实留在执行者之外",
    verdict: "Claude Code 与 Codex 都能检查、修改和运行代码，真正差异应以你的仓库、权限策略和日常工作流实测。无论选择哪一个，都不要让单次 Agent 会话成为路线图与完成状态的唯一来源。",
    left: ["Claude Code", "偏好 Anthropic 的终端 Agent 工作流", "具体能力与行为会随产品更新"], right: ["Codex", "偏好 OpenAI 的本地编码 Agent 与权限工作流", "具体能力与行为会随产品更新"]
  },
  "claude-code": {
    category: "编码 Agent 替代方案", title: "Claude Code 替代方案：Codex、Cursor、SoloMap 与手动工作流", heading: "Claude Code 替代方案",
    description: "按真实任务比较 Codex、Cursor、SoloMap 和手动终端工作流；区分替换编码 Agent 与补齐项目协议。",
    subheading: "先确认你要替换执行者，还是要补上执行者之外的项目连续性",
    verdict: "要替换终端编码 Agent，可评估 Codex；要编辑器内 Agent，可评估 Cursor；要跨 Agent 保留路线图、边界和证据，SoloMap 是互补层而不是 Claude Code 的直接替代品。",
    left: ["Codex", "替换本地终端编码 Agent", "需要在真实仓库中评估模型与权限体验"], right: ["Cursor", "把 Agent 放进一体化编辑器", "意味着改变主要编辑环境"]
  },
  "ai-coding-project-management": {
    category: "项目工作流替代方案", title: "AI 编码 Agent 项目管理工具怎么选？", heading: "AI 编码 Agent 的项目管理选择",
    description: "比较 SoloMap、Linear、GitHub Projects、Notion 与纯文件工作流，避免把计划工具误当成 Agent 执行协议。",
    subheading: "选择应该拥有下一项决策的系统，而不是功能列表最长的系统",
    verdict: "SoloMap 适合本地 Agent 执行连续性；Linear 适合结构化产品团队；GitHub Projects 适合仓库协作；Notion 适合灵活知识与规划；纯文件适合愿意自行维护协议的开发者。",
    left: ["SoloMap", "一个人、多次 Agent 会话持续推进", "比通用团队平台更聚焦"], right: ["Linear / GitHub Projects", "团队承诺、issue 与贡献者协作", "Agent 本地执行证据不是核心对象"]
  }
};

function buildZhPage(slug, page) {
  const detail = zhDetails[slug];
  const third = page.kind === "alternative"
    ? ["SoloMap / 纯文件协议", "补上跨会话项目连续性", "需要明确它是互补层还是替代品"]
    : ["组合使用", `让 ${detail.right[0]} 执行，让 ${detail.left[0]} 保存约定`, "需要明确每一层的事实所有权"];
  return {
    ...page, ...detail,
    choices: [detail.left, detail.right, third],
    columns: ["比较维度", detail.left[0], detail.right[0]],
    rows: [
      ["核心职责", detail.left[1], detail.right[1]],
      ["重要边界", detail.left[2], detail.right[2]],
      ["项目连续性", "把已验证状态和下一步留在项目中", "主要围绕自身工作流和对象组织上下文"],
      ["完成判断", "由用户依据可复核证据确认", "提供执行结果，但不应独占长期项目状态"],
      ["适合组合吗", "可以作为项目约定层", "可以在清晰边界内承担对应动作"]
    ],
    scenarioTitle: "按你当前要完成的动作选择",
    scenarios: [
      [detail.left[0], detail.left[1]],
      [detail.right[0], detail.right[1]],
      [third[0], third[1]]
    ],
    limitation: `不要只凭功能表作决定。${detail.left[2]}；${detail.right[2]}。最终应以你的真实项目、协作人数和事实边界验证。`,
    faq: [
      [`${detail.left[0]} 能替代 ${detail.right[0]} 吗？`, page.kind === "alternative" ? "取决于你要替换的具体工作。先区分代码执行、项目规划与跨会话协议，再选择对应工具。" : "通常不是直接替代。二者承担不同职责，是否组合取决于你的项目工作流。"],
      ["应该如何做最终选择？", "用一个真实项目检验：谁负责执行、谁保存项目事实、谁确认完成，以及换会话后能否从已验证状态继续。"],
      ["可以同时使用吗？", "可以，但每项决策只能有一个明确的事实所有者，避免路线图、代码和完成状态互相冲突。"]
    ]
  };
}

comparisonCatalog.zh = {
  hub: {
    title: "AI 编码 Agent 与项目工作流对比 | SoloMap",
    description: "对比 AI 编码 Agent、编辑器、项目管理工具，以及让项目跨会话持续对齐的人与 Agent 工作协议。",
    heading: "对比 Agent、项目工具与它们周围的工作协议。",
    lead: "从你要完成的动作出发：谁负责写代码，谁负责协调工作，谁负责保存已验证的项目状态。这里不会把每个答案都强行导向 SoloMap。",
    directTitle: "直接对比",
    directLead: "比较工作协议、编码 Agent、编辑器与项目系统各自真正负责什么。",
    alternativeTitle: "替代方案指南",
    alternativeLead: "从要解决的工作出发，再比较真正解决不同问题的选项。"
  },
  alternativesHub: {
    title: "AI 编码 Agent 与项目工作流替代方案 | SoloMap",
    description: "比较 Claude Code 与常见 AI 编码项目管理方案的替代选择，并诚实说明各自适用边界。",
    heading: "按你要完成的工作选择替代方案。",
    lead: "替换编码 Agent、替换项目管理器、补上一套持久工作协议，是三种不同决定。"
  },
  pages: Object.fromEntries(Object.entries(comparisonCatalog.en.pages).map(([slug, page]) => [slug, buildZhPage(slug, page)]))
};

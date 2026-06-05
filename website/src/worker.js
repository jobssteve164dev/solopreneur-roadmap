const SITE_ORIGIN = "https://solomap.app";
const MARKETPLACE_URL = "https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap";
const OPEN_VSX_URL = "https://open-vsx.org/extension/SZLK/solopreneur-roadmap";
const GITHUB_URL = "https://github.com/jobssteve164dev/solopreneur-roadmap";
const FEEDBACK_URL = "https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new?template=seed-user-feedback.yml";
const SCREENSHOT_URL = "https://raw.githubusercontent.com/jobssteve164dev/solopreneur-roadmap/main/docs/assets/solomap_red_terminal.png";
const LOGO_URL = "https://raw.githubusercontent.com/jobssteve164dev/solopreneur-roadmap/main/resources/logo.svg";

const securityHeaders = {
  "content-security-policy": [
    "default-src 'none'",
    "img-src 'self' https://raw.githubusercontent.com data:",
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "connect-src 'none'",
    "script-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join("; "),
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

const content = {
  en: {
    lang: "en",
    pathPrefix: "",
    homePath: "/",
    docsPath: "/docs",
    privacyPath: "/privacy-local-first",
    alternateLabel: "中文",
    alternateHomePath: "/zh",
    alternateDocsPath: "/zh/docs",
    alternatePrivacyPath: "/zh/privacy-local-first",
    nav: {
      product: "Product",
      pro: "Pro",
      docs: "Docs",
      github: "GitHub",
      install: "Install"
    },
    meta: {
      title: "SoloMap - Local-first roadmap and strategy cockpit for AI-built projects",
      description: "SoloMap is a local-first roadmap and strategy cockpit for indie developers building with AI agents in VS Code.",
      ogDescription: "Keep your AI-built projects moving with a local-first roadmap and strategy cockpit in VS Code."
    },
    hero: {
      eyebrow: "Local-first VS Code extension",
      title: "Keep your AI-built projects moving.",
      copy: "SoloMap is a local-first roadmap and strategy cockpit for indie developers building with AI agents in VS Code.",
      support: "Let AI agents execute. Let SoloMap keep the direction clear.",
      primaryCta: "Install from VS Code Marketplace",
      secondaryCta: "Get it on Open VSX",
      githubCta: "View on GitHub",
      proofLabel: "Product highlights",
      proof: ["Works in your workspace", "Bring your own Agent CLI", "Free core workflow"],
      screenshotLabel: "SoloMap running in VS Code",
      screenshotAlt: "SoloMap roadmap and Agent terminal running inside Visual Studio Code"
    },
    problem: {
      title: "AI can write code. It does not keep your product on track.",
      lead: "SoloMap keeps plans, Agent runs, next actions, and project memory in the place where you already work.",
      cards: [
        ["Scattered context", "Project plans, AI chats, terminal output, TODOs, and code changes stop living as disconnected fragments."],
        ["Clear next step", "Come back days later and see what needs attention without rereading every chat and file."],
        ["Beyond only Build", "Roadmaps can keep Sell, Learn, Improve, feedback, and delivery signals visible while code keeps moving."]
      ]
    },
    workflow: {
      title: "From idea to shipped progress, without losing the thread.",
      lead: "Four actions are enough to start with one real project.",
      steps: [
        ["Add your local project", "Choose a workspace folder and let SoloMap create the project operating surface there."],
        ["Create a roadmap", "Describe the outcome and get a set of executable steps you can revise as reality changes."],
        ["Run your AI agent", "Start your local Agent CLI from the right roadmap step with the context already attached."],
        ["Come back and continue", "See today's priorities, project status, and recent progress when you reopen VS Code."]
      ]
    },
    answer: {
      title: "What is SoloMap?",
      lead: "SoloMap is a local-first VS Code extension that helps indie developers turn AI-built projects into clear roadmaps, executable agent runs, and visible next actions. It does not replace coding agents; it gives them a product direction layer so solo builders can keep building, selling, learning, and improving without losing context.",
      comparisonTitle: "SoloMap vs. AI coding tools",
      comparison: [
        ["What it manages", "Project direction, roadmap steps, AI run context, progress memory", "Code generation, edits, chat, review, and terminal execution"],
        ["Where it works", "Inside the user's existing VS Code workspace", "Usually inside an IDE, terminal, hosted chat, or agent runtime"],
        ["Best use", "Knowing what to do next and keeping a solo product moving", "Completing a specific coding or editing task"],
        ["Data posture", "Core workflow is local-first by default", "Depends on the selected AI provider and tool"]
      ],
      modules: [
        ["Choose SoloMap if", "you already use AI agents but keep losing the product thread between plans, chats, code changes, and follow-up work."],
        ["Choose a coding agent if", "your immediate need is to write, modify, review, or explain code inside one task."],
        ["Use both when", "you want the agent to execute while SoloMap keeps the project roadmap, memory, and next step visible."]
      ]
    },
    trust: {
      title: "Local-first by default.",
      copy: "SoloMap's core workflow does not require a hosted backend. Roadmaps, task records, and project memory stay in your workspace first.",
      items: [
        "Your project roadmap and memory stay with your local project.",
        "You bring the AI Agent CLI you already use.",
        "GitHub signals are pulled when you connect or refresh them."
      ]
    },
    pro: {
      title: "Free moves one project forward. Pro helps run your one-person company.",
      features: [
        "Strategy cockpit",
        "Multi-project scoring",
        "Portfolio health",
        "Ability compounding",
        "Market and delivery diagnosis",
        "Early access roadmap input"
      ],
      label: "Pro Early Access",
      price: "$29/year",
      copy: "Get early access to the strategy cockpit and help shape the Pro roadmap. The Free core workflow stays available.",
      cta: "Join Pro Early Access"
    },
    install: {
      title: "Try SoloMap with one project first.",
      lead: "If it helps you keep momentum, tell us what the strategy cockpit should show next.",
      marketplace: "VS Code Marketplace",
      openVsx: "Open VSX",
      ios: "iOS app",
      android: "Android app",
      webWorkspace: "Web workspace",
      comingSoon: "Coming soon",
      github: "GitHub repository",
      feedback: "Send feedback"
    },
    faq: {
      title: "SoloMap FAQ",
      items: [
        ["Is SoloMap an AI coding agent?", "No. SoloMap is the roadmap and strategy layer around the coding agents you already use."],
        ["Does SoloMap require a hosted backend?", "No. The core workflow keeps roadmap state, task records, and project memory in the local workspace by default."],
        ["Who should use SoloMap?", "SoloMap is for indie developers and solo founders building products with AI agents inside VS Code."],
        ["What problem does SoloMap solve?", "It keeps project direction, next actions, and AI execution history visible so solo builders do not lose momentum between coding sessions."],
        ["Can SoloMap work with different agent CLIs?", "Yes. SoloMap is designed around bringing your own local Agent CLI rather than forcing one hosted coding agent."]
      ]
    },
    footer: {
      feedback: "Feedback",
      privacy: "Privacy / Local-first note"
    },
    privacy: {
      title: "SoloMap Local-first Note",
      back: "Back to SoloMap",
      heading: "Local-first note",
      copy: "SoloMap's core workflow keeps roadmap state, task records, and project memory in your local workspace by default. It does not require a hosted SoloMap backend to run the main project workflow.",
      items: [
        "Your AI provider usage depends on the local Agent CLI you choose.",
        "GitHub data is used when you connect or refresh GitHub-backed signals.",
        "Feedback is sent only when you open or submit a feedback issue yourself."
      ]
    }
  },
  zh: {
    lang: "zh-Hans",
    pathPrefix: "/zh",
    homePath: "/zh",
    docsPath: "/zh/docs",
    privacyPath: "/zh/privacy-local-first",
    alternateLabel: "English",
    alternateHomePath: "/",
    alternateDocsPath: "/docs",
    alternatePrivacyPath: "/privacy-local-first",
    nav: {
      product: "产品",
      pro: "Pro",
      docs: "文档",
      github: "GitHub",
      install: "安装"
    },
    meta: {
      title: "SoloMap - 给 AI Agent 项目的本地优先路线图与战略驾驶舱",
      description: "SoloMap 是给使用 AI Agent 构建产品的独立开发者准备的本地优先路线图与战略驾驶舱。",
      ogDescription: "让 AI Agent 负责执行，让 SoloMap 负责不丢方向。"
    },
    hero: {
      eyebrow: "本地优先的 VS Code 插件",
      title: "让 AI 项目持续往前走。",
      copy: "SoloMap 是给使用 AI Agent 构建产品的独立开发者准备的本地优先路线图与战略驾驶舱。",
      support: "把产品想法、路线图、Agent 执行历史和下一步动作放回你的本地工作区。",
      primaryCta: "从 VS Code Marketplace 安装",
      secondaryCta: "在 Open VSX 获取",
      githubCta: "查看 GitHub",
      proofLabel: "产品亮点",
      proof: ["在你的工作区里运行", "使用你已有的 Agent CLI", "Free 主路径保持可用"],
      screenshotLabel: "SoloMap 在 VS Code 中运行",
      screenshotAlt: "SoloMap 路线图和 Agent 终端在 Visual Studio Code 中运行"
    },
    problem: {
      title: "AI 能写代码，但不会自动帮你经营项目方向。",
      lead: "SoloMap 把计划、Agent 执行、下一步动作和项目记忆留在你真正工作的地方。",
      cards: [
        ["上下文散落", "项目计划、AI 对话、终端输出、TODO 和代码修改不再散落在不同地方。"],
        ["下一步清楚", "几天后重新打开项目，也能立刻看见当前该处理什么。"],
        ["不只停在 Build", "路线图持续提醒 Sell、Learn、Improve、反馈和交付信号，不让项目只是在改代码。"]
      ]
    },
    workflow: {
      title: "从想法到真实推进，不丢掉上下文。",
      lead: "从一个真实项目开始，只需要四个动作。",
      steps: [
        ["添加本地项目", "选择一个工作区文件夹，让 SoloMap 在那里建立项目推进界面。"],
        ["生成路线图", "描述目标，得到一组可执行、可调整的路线图环节。"],
        ["运行你的 AI Agent", "从正确的路线图环节启动本地 Agent CLI，并自动带上上下文。"],
        ["回来继续推进", "下次打开 VS Code 时，直接看到今日安排、项目状态和最近进展。"]
      ]
    },
    answer: {
      title: "SoloMap 是什么？",
      lead: "SoloMap 是一个本地优先的 VS Code 插件，帮助独立开发者把 AI Agent 项目整理成清晰路线图、可执行 Agent 任务和可继续推进的下一步。它不替代编码 Agent，而是给编码 Agent 外层补上产品方向，让一个人也能持续 Build、Sell、Learn、Improve。",
      comparisonTitle: "SoloMap 与 AI 编码工具的区别",
      comparison: [
        ["管理对象", "项目方向、路线图环节、Agent 执行上下文、推进记忆", "代码生成、编辑、问答、审查和终端执行"],
        ["工作位置", "用户已有的 VS Code 本地工作区", "通常在 IDE、终端、托管聊天或 Agent 运行环境中"],
        ["最适合", "知道下一步做什么，并让一个产品持续推进", "完成一个具体编码、修改或解释任务"],
        ["数据姿态", "核心工作流默认本地优先", "取决于用户选择的 AI provider 和工具"]
      ],
      modules: [
        ["选择 SoloMap，如果", "你已经在用 AI Agent，但项目计划、对话、代码修改和后续动作总是散落。"],
        ["选择编码 Agent，如果", "你当前只需要完成一个具体的写代码、改代码、解释代码或审查任务。"],
        ["两者一起用，当", "你希望 Agent 负责执行，同时 SoloMap 保持路线图、项目记忆和下一步动作清楚可见。"]
      ]
    },
    trust: {
      title: "默认本地优先。",
      copy: "SoloMap 的核心工作流不要求托管后端。路线图、任务记录和项目记忆优先留在你的本地工作区。",
      items: [
        "项目路线图和记忆跟随你的本地项目保存。",
        "你继续使用自己已经安装的 AI Agent CLI。",
        "GitHub 信号只在你连接或刷新时拉取。"
      ]
    },
    pro: {
      title: "Free 帮你推进一个项目；Pro 帮你经营一人公司。",
      features: [
        "战略驾驶舱",
        "多项目战略评分",
        "项目组合健康度",
        "能力复利分析",
        "市场与交付结构诊断",
        "Early Access 路线图共创"
      ],
      label: "Pro Early Access",
      price: "$29/年",
      copy: "提前使用战略驾驶舱，并参与塑造 Pro 路线图。Free 核心工作流会继续保持可用。",
      cta: "加入 Pro Early Access"
    },
    install: {
      title: "先用一个项目试试 SoloMap。",
      lead: "如果它帮你保持推进，请告诉我们金字塔战略驾驶舱下一步应该看见什么。",
      marketplace: "VS Code Marketplace",
      openVsx: "Open VSX",
      ios: "iOS 应用",
      android: "安卓应用",
      webWorkspace: "网页版工作台",
      comingSoon: "即将推出",
      github: "GitHub 仓库",
      feedback: "提交反馈"
    },
    faq: {
      title: "SoloMap 常见问题",
      items: [
        ["SoloMap 是 AI 编码 Agent 吗？", "不是。SoloMap 是你已有编码 Agent 外层的路线图和战略层。"],
        ["SoloMap 必须使用托管后端吗？", "不需要。核心工作流默认把路线图状态、任务记录和项目记忆保存在本地工作区。"],
        ["谁适合使用 SoloMap？", "SoloMap 适合在 VS Code 中用 AI Agent 构建产品的独立开发者和 solo founder。"],
        ["SoloMap 解决什么问题？", "它让项目方向、下一步动作和 AI 执行历史保持可见，避免一个人做产品时在多次编码会话之间丢掉节奏。"],
        ["SoloMap 能配合不同 Agent CLI 吗？", "可以。SoloMap 的设计是带上你自己的本地 Agent CLI，而不是强迫你使用某一个托管编码 Agent。"]
      ]
    },
    footer: {
      feedback: "反馈",
      privacy: "隐私 / 本地优先说明"
    },
    privacy: {
      title: "SoloMap 本地优先说明",
      back: "返回 SoloMap",
      heading: "本地优先说明",
      copy: "SoloMap 的核心工作流默认把路线图状态、任务记录和项目记忆保存在你的本地工作区。主项目推进流程不要求托管的 SoloMap 后端。",
      items: [
        "AI 服务的使用取决于你选择的本地 Agent CLI。",
        "GitHub 数据只在你连接或刷新相关信号时使用。",
        "反馈只会在你主动打开或提交反馈 Issue 时发送。"
      ]
    }
  }
};

const docsContent = {
  en: {
    index: {
      title: "SoloMap Docs",
      description: "Methods for using SoloMap to keep AI-built projects moving from idea to shipped progress.",
      heading: "Methods for keeping AI-built projects moving.",
      lead: "SoloMap is built around a simple operating model: turn ideas into roadmaps, turn roadmap steps into agent work, and turn evidence back into the next decision.",
      cards: [
        ["solomap-method", "SoloMap Method", "Build, sell, learn, and improve as one loop instead of treating coding as the finish line."],
        ["portfolio-method", "Portfolio Method", "Coordinate multiple solo projects through reusable capability, priority, and learning loops."],
        ["micro-execution-loop", "Micro Execution Loop", "Make agent work observable by tracking intent, judgment, action, evidence, result, and attribution."]
      ]
    },
    pages: {
      "solomap-method": {
        title: "SoloMap Method",
        description: "The SoloMap method turns AI-built project ideas into roadmaps, agent execution, market contact, and feedback loops.",
        heading: "The SoloMap method",
        lead: "SoloMap treats a solo project as a living loop: find a real problem, build a usable product, reach customers, learn from evidence, and improve the next roadmap step.",
        sections: [
          ["Find the real problem", "Start with a problem worth exploring, the people who can validate it, and one action that creates momentum."],
          ["Build a product system", "A prototype is not enough. A deliverable product needs requirements, architecture, data, tests, design, deployment, and maintenance evidence."],
          ["Reach customers", "A project is not done when the code runs. It also needs a brand, website, distribution path, sales signal, and feedback channel."],
          ["Loop through improvement", "Build, Sell, Learn, and Improve stay visible in the roadmap so the product can absorb feedback instead of drifting into endless coding."]
        ],
        faq: [
          ["What is the SoloMap method?", "The SoloMap method is a project loop for solo builders: turn an idea into a roadmap, run focused AI agent work from each step, verify evidence, and update the roadmap from real feedback."],
          ["Why does SoloMap include selling and learning?", "AI agents make it easy to keep coding, but a product only becomes real when users can discover it, trust it, try it, and send feedback."]
        ]
      },
      "portfolio-method": {
        title: "Portfolio Method",
        description: "The SoloMap portfolio method helps solo founders coordinate multiple AI-built projects through reusable learning and priority loops.",
        heading: "The portfolio method",
        lead: "Solo builders often manage more than one product, experiment, infrastructure project, or content system. SoloMap treats that portfolio as an operating system, not as a pile of disconnected projects.",
        sections: [
          ["Classify projects by execution mode", "Core products, infrastructure, content products, experiments, tools, and maintenance projects need different roadmap shapes."],
          ["Reuse capability", "Patterns learned in one project should reduce work in the next project instead of being rediscovered every time."],
          ["Coordinate priority", "The next action should consider revenue potential, blocked surface area, learning value, and execution cost."],
          ["Compound learning", "Completed work feeds a shared operating memory so future projects can start with better defaults."]
        ],
        faq: [
          ["What is a solo founder portfolio method?", "It is a way to coordinate multiple projects by execution mode, priority, reusable capabilities, and learning feedback instead of managing every project as an isolated todo list."],
          ["Why does portfolio context matter for AI-built projects?", "AI can accelerate individual tasks, but the solo founder still needs a system for deciding which project and which action deserves attention next."]
        ]
      },
      "micro-execution-loop": {
        title: "Micro Execution Loop",
        description: "The Micro Execution Loop makes AI agent work visible through intent, judgment, action, evidence, result, and attribution.",
        heading: "The micro execution loop",
        lead: "A roadmap step is only trustworthy when the small agent loops underneath it are observable. SoloMap uses a six-part loop to turn agent activity into project facts.",
        sections: [
          ["Intent", "Capture what the user wanted and what this loop is supposed to change."],
          ["Judgment", "Record the chosen path, affected files, tradeoffs, boundaries, and expected validation."],
          ["Action", "Track what actually changed in the project, not just what the agent claimed."],
          ["Evidence", "Verify with tests, rendered output, logs, diffs, screenshots, or concrete files."],
          ["Result", "Classify the loop as closed, partial, failed, unverified, deviated, or follow-up required."],
          ["Attribution", "Connect the evidence back to a roadmap step, user capability, product boundary, or risk."]
        ],
        faq: [
          ["What is a micro execution loop?", "A micro execution loop is the smallest reliable unit of AI-assisted project progress: intent, judgment, action, evidence, result, and attribution."],
          ["Why is evidence part of the loop?", "Without evidence, agent output is only a claim. Evidence turns a run into something that can safely move a roadmap forward."]
        ]
      }
    }
  },
  zh: {
    index: {
      title: "SoloMap 文档",
      description: "SoloMap 如何帮助 AI Agent 项目从想法推进到真实交付的方法论。",
      heading: "让 AI 项目持续推进的方法。",
      lead: "SoloMap 的核心不是再做一个聊天框，而是把想法变成路线图，把路线图环节变成 Agent 执行，再把证据带回下一步判断。",
      cards: [
        ["solomap-method", "SoloMap 方法", "把 Build、Sell、Learn、Improve 放进同一个循环，而不是把写完代码当作终点。"],
        ["portfolio-method", "项目组合方法", "用可复用能力、优先级和学习循环协调多个独立项目。"],
        ["micro-execution-loop", "微观执行循环", "用意图、判断、动作、证据、结果和归因，让 Agent 执行不再是黑箱。"]
      ]
    },
    pages: {
      "solomap-method": {
        title: "SoloMap 方法",
        description: "SoloMap 方法把 AI Agent 项目从想法推进到路线图、执行、市场接触和反馈循环。",
        heading: "SoloMap 方法",
        lead: "SoloMap 把一个独立项目看成持续循环：找到真实问题，打造可交付产品，触达客户，从证据中学习，并把下一步重新带回路线图。",
        sections: [
          ["找到真实问题", "先确认一个值得解决的问题、可以验证的人群，以及能立刻带来动能的第一个动作。"],
          ["打造产品系统", "原型只是开始。可交付产品需要需求、架构、数据、测试、设计、部署和维护证据。"],
          ["卖给客户", "代码跑通不是终点。产品还需要品牌、官网、分发路径、销售信号和反馈渠道。"],
          ["通过循环改进", "Build、Sell、Learn、Improve 持续留在路线图里，让产品吸收反馈，而不是陷入无尽改代码。"]
        ],
        faq: [
          ["SoloMap 方法是什么？", "SoloMap 方法是给独立开发者的项目推进循环：把想法变成路线图，从环节启动聚焦 Agent 执行，用证据验证结果，再根据真实反馈更新路线图。"],
          ["为什么 SoloMap 要包含销售和学习？", "AI Agent 很容易让人一直写代码，但产品只有被用户发现、信任、试用并反馈后，才真正进入市场。"]
        ]
      },
      "portfolio-method": {
        title: "项目组合方法",
        description: "SoloMap 项目组合方法帮助独立开发者用可复用学习和优先级循环协调多个 AI 项目。",
        heading: "项目组合方法",
        lead: "独立开发者常常同时管理多个产品、实验、基础设施和内容系统。SoloMap 把这看作一个操作系统，而不是一堆互不相干的待办事项。",
        sections: [
          ["按执行模式分类", "核心产品、基础设施、内容产品、实验、工具和维护项目，需要不同的路线图形态。"],
          ["复用能力", "一个项目里学到的模式，应该降低下一个项目的工作量，而不是每次重新发现。"],
          ["协调优先级", "下一步该做什么，需要同时看收入潜力、阻断面、学习价值和执行成本。"],
          ["沉淀复利", "已完成的工作进入共享经验，让未来项目从更好的默认值开始。"]
        ],
        faq: [
          ["什么是独立开发者项目组合方法？", "它是一种按执行模式、优先级、可复用能力和学习反馈来协调多个项目的方法，而不是把每个项目都当作孤立 todo list。"],
          ["为什么 AI 项目需要项目组合视角？", "AI 能加速单个任务，但独立开发者仍然需要判断哪个项目、哪个动作现在最值得投入。"]
        ]
      },
      "micro-execution-loop": {
        title: "微观执行循环",
        description: "微观执行循环用意图、判断、动作、证据、结果和归因，让 AI Agent 工作变得可观察。",
        heading: "微观执行循环",
        lead: "一个路线图环节是否可信，取决于它下面的 Agent 小循环是否可观察。SoloMap 用六段结构把 Agent 活动变成项目事实。",
        sections: [
          ["意图", "记录用户想要什么，以及本轮循环要改变什么。"],
          ["判断", "记录选择的路径、影响文件、取舍、边界和预期验证。"],
          ["动作", "追踪项目真实发生了什么变化，而不是只看 Agent 自称做了什么。"],
          ["证据", "用测试、渲染结果、日志、diff、截图或具体文件验证。"],
          ["结果", "把循环归类为已闭环、部分完成、失败、未验证、偏航或需要后续。"],
          ["归因", "把证据连接回路线图环节、用户能力、产品边界或风险。"]
        ],
        faq: [
          ["什么是微观执行循环？", "微观执行循环是 AI 辅助项目推进的最小可靠单元：意图、判断、动作、证据、结果和归因。"],
          ["为什么证据是循环的一部分？", "没有证据，Agent 输出只是声明；有证据，才能安全推动路线图继续前进。"]
        ]
      }
    }
  }
};

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...securityHeaders,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300"
    }
  });
}

function textResponse(body, contentType = "text/plain; charset=utf-8") {
  return new Response(body, {
    headers: {
      ...securityHeaders,
      "content-type": contentType,
      "cache-control": "public, max-age=300"
    }
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function absoluteUrl(path, origin) {
  return `${origin}${path}`;
}

function englishPathFor(pagePath) {
  if (!pagePath.startsWith("/zh")) {
    return pagePath;
  }
  return pagePath.slice(3) || "/";
}

function chinesePathFor(pagePath) {
  if (pagePath.startsWith("/zh")) {
    return pagePath;
  }
  return `/zh${pagePath === "/" ? "" : pagePath}`;
}

function buildHead(t, origin, pagePath) {
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(t.meta.title)}</title>
  <meta name="description" content="${escapeHtml(t.meta.description)}">
  <link rel="icon" href="${LOGO_URL}">
  <link rel="canonical" href="${absoluteUrl(pagePath, origin)}">
  <link rel="alternate" hreflang="en" href="${absoluteUrl(englishPathFor(pagePath), origin)}">
  <link rel="alternate" hreflang="zh-Hans" href="${absoluteUrl(chinesePathFor(pagePath), origin)}">
  <link rel="alternate" hreflang="x-default" href="${absoluteUrl(englishPathFor(pagePath), origin)}">
  <meta property="og:title" content="SoloMap">
  <meta property="og:description" content="${escapeHtml(t.meta.ogDescription)}">
  <meta property="og:image" content="${SCREENSHOT_URL}">
  <meta property="og:url" content="${absoluteUrl(pagePath, origin)}">
  <meta name="twitter:card" content="summary_large_image">`;
}

function buildStyles() {
  return `<style>
    :root {
      color-scheme: dark;
      --ink: #f6f0e8;
      --muted: #bfb5a7;
      --soft: #ded4c8;
      --bg: #11100e;
      --panel: #1a1714;
      --line: rgba(246, 240, 232, 0.16);
      --red: #ef3e46;
      --cyan: #49d6d0;
      --green: #a5d66d;
      --shadow: rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    a { color: inherit; text-decoration: none; }
    img { display: block; max-width: 100%; }
    input[type="range"] {
      width: 100%;
      height: 18px;
      margin: 0;
      appearance: none;
      -webkit-appearance: none;
      background: transparent;
      accent-color: var(--cyan);
    }
    input[type="range"]::-webkit-slider-runnable-track {
      height: 4px;
      border-radius: 999px;
      background: rgba(246, 240, 232, 0.16);
    }
    input[type="range"]::-webkit-slider-thumb {
      width: 14px;
      height: 14px;
      margin-top: -5px;
      border: 2px solid #11100e;
      border-radius: 999px;
      background: var(--soft);
      -webkit-appearance: none;
    }
    input[type="range"]::-moz-range-track {
      height: 4px;
      border: 0;
      border-radius: 999px;
      background: rgba(246, 240, 232, 0.16);
    }
    input[type="range"]::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border: 2px solid #11100e;
      border-radius: 999px;
      background: var(--soft);
    }
    .shell { width: min(1160px, calc(100% - 40px)); margin: 0 auto; }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 10;
      border-bottom: 1px solid var(--line);
      background: rgba(17, 16, 14, 0.9);
      backdrop-filter: blur(18px);
    }
    .nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 68px;
      gap: 20px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      font-weight: 760;
      letter-spacing: 0;
    }
    .brand img { width: 34px; height: 34px; border-radius: 8px; }
    .links {
      display: flex;
      align-items: center;
      gap: 18px;
      color: var(--soft);
      font-size: 14px;
    }
    .links a:hover { color: var(--ink); }
    .language-link {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 7px 10px;
    }
    .install-link {
      color: #11100e;
      background: var(--ink);
      padding: 9px 13px;
      border-radius: 8px;
      font-weight: 720;
    }
    .hero {
      min-height: calc(100vh - 68px);
      display: grid;
      align-items: center;
      padding: 58px 0 36px;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 0.92fr) minmax(420px, 1.08fr);
      gap: 46px;
      align-items: center;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      gap: 8px;
      color: var(--cyan);
      border: 1px solid rgba(73, 214, 208, 0.36);
      border-radius: 999px;
      padding: 7px 11px;
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      max-width: 720px;
      font-size: clamp(44px, 8vw, 86px);
      line-height: 0.96;
      letter-spacing: 0;
    }
    .hero-copy {
      margin: 22px 0 0;
      max-width: 650px;
      color: var(--soft);
      font-size: 19px;
    }
    .cn-line {
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 17px;
    }
    .cta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 30px;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 46px;
      border-radius: 8px;
      padding: 0 18px;
      font-weight: 760;
      border: 1px solid var(--line);
      text-align: center;
      font: inherit;
    }
    .button.primary { background: var(--red); border-color: var(--red); color: white; }
    .button.secondary { color: #11100e !important; background: #f6f0e8; }
    .button.ghost { color: var(--soft); }
    .button.soon {
      color: var(--muted);
      background: rgba(255, 255, 255, 0.035);
      cursor: default;
    }
    .button:disabled {
      opacity: 1;
      pointer-events: none;
    }
    .button:hover { transform: translateY(-1px); }
    .button:disabled:hover { transform: none; }
    .soon-tag {
      color: var(--cyan);
      font-size: 12px;
      font-weight: 760;
    }
    .proof {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 24px;
      color: var(--muted);
      font-size: 13px;
    }
    .proof span {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 7px 10px;
      background: rgba(255, 255, 255, 0.035);
    }
    .product-preview {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b0d0f;
      box-shadow: 0 28px 80px var(--shadow);
      overflow: hidden;
      min-height: 560px;
      position: relative;
    }
    .preview-titlebar {
      height: 42px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 14px;
      color: #aeb8c2;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      background: #171b20;
      font-size: 13px;
    }
    .preview-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #ef3e46;
      box-shadow: 18px 0 0 #f0c46b, 36px 0 0 #77c979;
      margin-right: 42px;
    }
    .preview-body {
      display: grid;
      grid-template-columns: 170px minmax(0, 1fr);
      min-height: 518px;
    }
    .preview-side {
      border-right: 1px solid rgba(255, 255, 255, 0.1);
      background: #121417;
      padding: 16px 12px;
    }
    .preview-side strong,
    .preview-main strong,
    .terminal strong {
      display: block;
      color: var(--ink);
      font-size: 13px;
      margin-bottom: 10px;
    }
    .project-chip {
      border: 1px solid rgba(73, 214, 208, 0.28);
      border-radius: 8px;
      padding: 10px;
      color: var(--soft);
      background: rgba(73, 214, 208, 0.06);
      font-size: 12px;
      margin-bottom: 10px;
    }
    .preview-main {
      padding: 18px;
      display: grid;
      gap: 14px;
      align-content: start;
    }
    .roadmap-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .roadmap-step {
      min-width: 0;
      min-height: 118px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 12px;
      background: #171411;
      position: relative;
      overflow: hidden;
    }
    .roadmap-step::after {
      content: "";
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 12px;
      height: 4px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.12);
    }
    .roadmap-step.active {
      border-color: rgba(239, 62, 70, 0.7);
      background: rgba(239, 62, 70, 0.1);
      animation: pulseStep 3.6s ease-in-out infinite;
    }
    .roadmap-step.active::after { background: var(--red); }
    .roadmap-step span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 8px;
    }
    .roadmap-step b {
      display: block;
      color: var(--ink);
      font-size: 12px;
      line-height: 1.25;
      white-space: nowrap;
    }
    .terminal {
      border: 1px solid rgba(73, 214, 208, 0.24);
      border-radius: 8px;
      background: #090b0d;
      padding: 14px;
      min-height: 176px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: #b8c7d9;
      overflow: hidden;
    }
    .terminal-line {
      display: block;
      margin-top: 6px;
      white-space: nowrap;
      opacity: 1;
      transform: translateY(0);
      animation: focusLine 8s ease-in-out infinite;
    }
    .terminal-line:nth-child(3) { animation-delay: 1.2s; }
    .terminal-line:nth-child(4) { animation-delay: 2.4s; }
    .terminal-line:nth-child(5) { animation-delay: 3.6s; }
    .terminal-line:nth-child(6) { animation-delay: 4.8s; }
    .ok { color: var(--green); }
    .warn { color: #f0c46b; }
    .info { color: var(--cyan); }
    .next-actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .next-actions div {
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 12px;
      color: var(--soft);
      background: rgba(255, 255, 255, 0.035);
      font-size: 13px;
    }
    @keyframes focusLine {
      0%, 100% { color: #b8c7d9; }
      45%, 55% { color: #f6f0e8; }
    }
    @keyframes pulseStep {
      0%, 100% { box-shadow: 0 0 0 rgba(239, 62, 70, 0); }
      50% { box-shadow: 0 0 34px rgba(239, 62, 70, 0.18); }
    }
    @media (prefers-reduced-motion: reduce) {
      .terminal-line,
      .roadmap-step.active {
        animation: none;
        opacity: 1;
        transform: none;
      }
    }
    .section {
      padding: 78px 0;
      border-top: 1px solid var(--line);
    }
    .section-head {
      display: grid;
      grid-template-columns: minmax(0, 0.7fr) minmax(320px, 0.3fr);
      gap: 32px;
      align-items: end;
      margin-bottom: 30px;
    }
    h2 {
      margin: 0;
      font-size: clamp(30px, 4vw, 52px);
      line-height: 1.05;
      letter-spacing: 0;
    }
    .section-head p,
    .section > .shell > p.lead {
      margin: 0;
      color: var(--soft);
      font-size: 17px;
    }
    .grid-3,
    .grid-4 {
      display: grid;
      gap: 14px;
    }
    .grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 22px;
      min-height: 170px;
    }
    .card h3 {
      margin: 0 0 10px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .card p {
      margin: 0;
      color: var(--muted);
      font-size: 15px;
    }
    .answer-block {
      display: grid;
      grid-template-columns: minmax(0, 0.42fr) minmax(0, 0.58fr);
      gap: 18px;
      align-items: start;
    }
    .answer-copy {
      border: 1px solid rgba(73, 214, 208, 0.34);
      border-radius: 8px;
      padding: 28px;
      background: rgba(73, 214, 208, 0.07);
    }
    .answer-copy p {
      margin: 14px 0 0;
      color: var(--soft);
      font-size: 18px;
    }
    .comparison-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: var(--panel);
    }
    .comparison-table caption {
      text-align: left;
      margin-bottom: 12px;
      color: var(--ink);
      font-weight: 760;
      font-size: 18px;
    }
    .comparison-table th,
    .comparison-table td {
      border-top: 1px solid var(--line);
      padding: 14px;
      text-align: left;
      vertical-align: top;
      color: var(--soft);
      font-size: 14px;
    }
    .comparison-table tr:first-child th { border-top: 0; }
    .comparison-table th {
      color: var(--ink);
      background: rgba(255, 255, 255, 0.04);
    }
    .module-list {
      display: grid;
      gap: 12px;
      margin-top: 18px;
    }
    .module-list div {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      background: rgba(255, 255, 255, 0.035);
    }
    .module-list strong {
      display: block;
      margin-bottom: 6px;
      color: var(--ink);
    }
    .module-list p { margin: 0; color: var(--muted); }
    .faq-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .faq-list details {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      background: var(--panel);
    }
    .faq-list summary {
      cursor: pointer;
      color: var(--ink);
      font-weight: 760;
    }
    .faq-list p {
      margin: 12px 0 0;
      color: var(--muted);
    }
    .step {
      position: relative;
      padding-top: 54px;
    }
    .step::before {
      content: attr(data-step);
      position: absolute;
      top: 18px;
      left: 22px;
      color: #11100e;
      background: var(--cyan);
      border-radius: 999px;
      width: 26px;
      height: 26px;
      display: grid;
      place-items: center;
      font-size: 13px;
      font-weight: 800;
    }
    .trust-band {
      display: grid;
      grid-template-columns: minmax(0, 0.48fr) minmax(0, 0.52fr);
      gap: 14px;
      align-items: stretch;
    }
    .trust-copy {
      border-radius: 8px;
      border: 1px solid rgba(165, 214, 109, 0.34);
      background: rgba(165, 214, 109, 0.07);
      padding: 28px;
    }
    .trust-copy p { color: var(--soft); font-size: 18px; margin: 12px 0 0; }
    .trust-list {
      display: grid;
      gap: 14px;
    }
    .trust-list div {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      color: var(--soft);
      background: rgba(255, 255, 255, 0.035);
    }
    .pro {
      display: grid;
      grid-template-columns: minmax(0, 0.62fr) minmax(320px, 0.38fr);
      gap: 14px;
      align-items: stretch;
    }
    .price {
      border: 1px solid rgba(239, 62, 70, 0.42);
      border-radius: 8px;
      padding: 28px;
      background: rgba(239, 62, 70, 0.08);
    }
    .price strong {
      display: block;
      font-size: 44px;
      line-height: 1;
      margin: 10px 0 14px;
      letter-spacing: 0;
    }
    .feature-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .feature-list span {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      color: var(--soft);
      background: rgba(255, 255, 255, 0.035);
    }
    .install-panel {
      display: grid;
      grid-template-columns: minmax(0, 0.54fr) minmax(0, 0.46fr);
      gap: 16px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 28px;
      background: #171411;
    }
    .install-actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    footer {
      border-top: 1px solid var(--line);
      padding: 30px 0;
      color: var(--muted);
      font-size: 14px;
    }
    .footer-row {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      flex-wrap: wrap;
    }
    .footer-links {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
    }
    .privacy-page {
      width: min(860px, calc(100% - 40px));
      margin: 0 auto;
      padding: 72px 0;
    }
    .privacy-nav {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      margin-bottom: 32px;
    }
    .privacy-page a { color: var(--cyan); }
    .privacy-page h1 { margin-bottom: 22px; }
    .privacy-page p,
    .privacy-page li { color: var(--soft); font-size: 18px; }
    .privacy-page ul { padding-left: 22px; }
    .docs-page {
      width: min(1040px, calc(100% - 40px));
      margin: 0 auto;
      padding: 72px 0 86px;
    }
    .docs-hero {
      margin-bottom: 30px;
    }
    .docs-hero h1,
    .privacy-page h1 {
      font-size: clamp(38px, 6vw, 68px);
      line-height: 0.98;
      letter-spacing: 0;
    }
    .docs-hero p {
      margin: 18px 0 0;
      max-width: 760px;
      color: var(--soft);
      font-size: 19px;
    }
    .docs-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .docs-card {
      min-height: 210px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
      background: var(--panel);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 20px;
    }
    .docs-card h2 {
      font-size: 24px;
      line-height: 1.08;
    }
    .docs-card p,
    .docs-section p {
      color: var(--muted);
      margin: 10px 0 0;
    }
    .docs-card span {
      color: var(--cyan);
      font-weight: 760;
    }
    .docs-body {
      display: grid;
      grid-template-columns: minmax(0, 0.66fr) minmax(280px, 0.34fr);
      gap: 18px;
      align-items: start;
    }
    .docs-sections,
    .docs-aside {
      display: grid;
      gap: 14px;
    }
    .docs-section,
    .docs-aside article {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
      background: var(--panel);
    }
    .docs-section h2,
    .docs-aside h2 {
      font-size: 24px;
      line-height: 1.1;
    }
    .docs-aside article p {
      color: var(--muted);
      margin: 10px 0 0;
      font-size: 15px;
    }
    @media (max-width: 920px) {
      .links a:not(.install-link):not(.language-link) { display: none; }
      .hero { min-height: auto; padding-top: 44px; }
      .hero-grid,
      .section-head,
      .trust-band,
      .answer-block,
      .pro,
      .install-panel {
        grid-template-columns: 1fr;
      }
      .grid-3,
      .grid-4,
      .docs-grid,
      .docs-body,
      .faq-list,
      .feature-list {
        grid-template-columns: 1fr;
      }
      .product-preview { min-height: 520px; }
      .preview-body { grid-template-columns: 1fr; }
      .preview-side { display: none; }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 28px, 1160px); }
      .brand span { font-size: 15px; }
      .links { gap: 8px; }
      .install-link,
      .language-link { padding: 8px 10px; }
      h1 { font-size: 44px; }
      .hero-copy { font-size: 17px; }
      .button { width: 100%; }
      .install-actions { grid-template-columns: 1fr; }
      .section { padding: 58px 0; }
      .product-preview { min-height: 500px; }
      .preview-main { padding: 14px; }
      .roadmap-strip,
      .next-actions { grid-template-columns: 1fr; }
      .roadmap-step { min-height: 86px; }
    }
  </style>`;
}

function renderCards(cards) {
  return cards.map(([title, copy]) => `<article class="card">
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(copy)}</p>
          </article>`).join("");
}

function renderSteps(steps) {
  return steps.map(([title, copy], index) => `<article class="card step" data-step="${index + 1}">
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(copy)}</p>
          </article>`).join("");
}

function renderListItems(items, tagName) {
  return items.map((item) => `<${tagName}>${escapeHtml(item)}</${tagName}>`).join("");
}

function renderComparisonRows(rows) {
  return rows.map(([dimension, solomap, codingAgent]) => `<tr>
              <th scope="row">${escapeHtml(dimension)}</th>
              <td>${escapeHtml(solomap)}</td>
              <td>${escapeHtml(codingAgent)}</td>
            </tr>`).join("");
}

function renderModules(modules) {
  return modules.map(([title, copy]) => `<div>
            <strong>${escapeHtml(title)}</strong>
            <p>${escapeHtml(copy)}</p>
          </div>`).join("");
}

function renderDocCards(t, docs, locale) {
  return docs.index.cards.map(([slug, title, copy]) => {
    const href = `${t.docsPath}/${slug}`;
    return `<a class="docs-card" href="${href}">
            <div>
              <h2>${escapeHtml(title)}</h2>
              <p>${escapeHtml(copy)}</p>
            </div>
            <span>${locale === "zh" ? "阅读方法" : "Read method"}</span>
          </a>`;
  }).join("");
}

function renderDocSections(sections) {
  return sections.map(([title, copy]) => `<article class="docs-section">
            <h2>${escapeHtml(title)}</h2>
            <p>${escapeHtml(copy)}</p>
          </article>`).join("");
}

function renderDocFaq(items) {
  return items.map(([question, answer]) => `<article>
            <h2>${escapeHtml(question)}</h2>
            <p>${escapeHtml(answer)}</p>
          </article>`).join("");
}

function renderFaqItems(items) {
  return items.map(([question, answer]) => `<details>
            <summary>${escapeHtml(question)}</summary>
            <p>${escapeHtml(answer)}</p>
          </details>`).join("");
}

function renderHeroPreview(locale) {
  const labels = locale === "zh"
    ? {
        title: "SoloMap 工作区",
        side: "项目",
        activeProject: "SoloMap 官网",
        build: "打造",
        sell: "触达",
        learn: "学习",
        improve: "改进",
        terminal: "Agent 执行",
        next: ["发布官网更新", "检查 AI 引用", "收集用户反馈"]
      }
    : {
        title: "SoloMap workspace",
        side: "Projects",
        activeProject: "SoloMap website",
        build: "Build",
        sell: "Sell",
        learn: "Learn",
        improve: "Improve",
        terminal: "Agent run",
        next: ["Ship website update", "Check AI citations", "Collect user feedback"]
      };

  return `<figure class="product-preview" aria-label="${escapeHtml(labels.title)}">
          <div class="preview-titlebar">
            <span class="preview-dot" aria-hidden="true"></span>
            <span>${escapeHtml(labels.title)}</span>
          </div>
          <div class="preview-body">
            <aside class="preview-side">
              <strong>${escapeHtml(labels.side)}</strong>
              <div class="project-chip">${escapeHtml(labels.activeProject)}</div>
              <div class="project-chip">Cloudapi</div>
              <div class="project-chip">Content Factory</div>
            </aside>
            <div class="preview-main">
              <strong>Roadmap</strong>
              <div class="roadmap-strip">
                <div class="roadmap-step active"><span>01</span><b>${escapeHtml(labels.build)}</b></div>
                <div class="roadmap-step"><span>02</span><b>${escapeHtml(labels.sell)}</b></div>
                <div class="roadmap-step"><span>03</span><b>${escapeHtml(labels.learn)}</b></div>
                <div class="roadmap-step"><span>04</span><b>${escapeHtml(labels.improve)}</b></div>
              </div>
              <div class="terminal">
                <strong>${escapeHtml(labels.terminal)}</strong>
                <span class="terminal-line"><span class="info">[intent]</span> improve homepage GEO surface</span>
                <span class="terminal-line"><span class="ok">[action]</span> add native product preview</span>
                <span class="terminal-line"><span class="ok">[evidence]</span> schema and docs pages verified</span>
                <span class="terminal-line"><span class="warn">[next]</span> publish and measure citations</span>
                <span class="terminal-line"><span class="ok">[closed]</span> roadmap step updated</span>
              </div>
              <div class="next-actions">
                ${renderListItems(labels.next, "div")}
              </div>
            </div>
          </div>
        </figure>`;
}

function buildStructuredData(t, origin, pagePath) {
  const pageUrl = absoluteUrl(pagePath, origin);
  const software = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "SoloMap",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "VS Code",
    url: pageUrl,
    image: SCREENSHOT_URL,
    description: t.meta.description,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock"
    },
    downloadUrl: MARKETPLACE_URL,
    sameAs: [GITHUB_URL, MARKETPLACE_URL, OPEN_VSX_URL]
  };
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: t.faq.items.map(([question, answer]) => ({
      "@type": "Question",
      name: question,
      acceptedAnswer: {
        "@type": "Answer",
        text: answer
      }
    }))
  };
  return `<script type="application/ld+json">${JSON.stringify(software)}</script>
  <script type="application/ld+json">${JSON.stringify(faq)}</script>`;
}

function buildHeader(t, locale, currentPath) {
  const productHref = currentPath === t.homePath ? "#product" : `${t.homePath}#product`;
  const proHref = currentPath === t.homePath ? "#pro" : `${t.homePath}#pro`;
  const installHref = currentPath === t.homePath ? "#install" : `${t.homePath}#install`;
  return `<header class="topbar">
    <nav class="shell nav" aria-label="Primary">
      <a class="brand" href="${t.homePath}" aria-label="SoloMap home">
        <img src="${LOGO_URL}" width="34" height="34" alt="">
        <span>SoloMap</span>
      </a>
      <div class="links">
        <a href="${productHref}">${escapeHtml(t.nav.product)}</a>
        <a href="${proHref}">${escapeHtml(t.nav.pro)}</a>
        <a href="${t.docsPath}">${escapeHtml(t.nav.docs)}</a>
        <a href="${GITHUB_URL}">${escapeHtml(t.nav.github)}</a>
        <a class="language-link" href="${alternatePathFor(currentPath, locale)}" hreflang="${locale === "en" ? "zh-Hans" : "en"}">${escapeHtml(t.alternateLabel)}</a>
        <a class="install-link" href="${installHref}">${escapeHtml(t.nav.install)}</a>
      </div>
    </nav>
  </header>`;
}

function buildFooter(t) {
  return `<footer>
    <div class="shell footer-row">
      <div>SoloMap · solomap.app · SZLK</div>
      <div class="footer-links">
        <a href="${t.docsPath}">${escapeHtml(t.nav.docs)}</a>
        <a href="${GITHUB_URL}">GitHub</a>
        <a href="${MARKETPLACE_URL}">VS Code Marketplace</a>
        <a href="${OPEN_VSX_URL}">Open VSX</a>
        <a href="${FEEDBACK_URL}">${escapeHtml(t.footer.feedback)}</a>
        <a href="${t.privacyPath}">${escapeHtml(t.footer.privacy)}</a>
      </div>
    </div>
  </footer>`;
}

function alternatePathFor(pathname, locale) {
  if (pathname === "/docs") return "/zh/docs";
  if (pathname === "/zh/docs") return "/docs";
  if (pathname.startsWith("/docs/")) return `/zh${pathname}`;
  if (pathname.startsWith("/zh/docs/")) return pathname.slice(3);
  if (pathname === "/privacy-local-first") return "/zh/privacy-local-first";
  if (pathname === "/zh/privacy-local-first") return "/privacy-local-first";
  return locale === "en" ? "/zh" : "/";
}

function buildPage(locale, origin) {
  const t = content[locale];
  return `<!doctype html>
<html lang="${t.lang}">
<head>
  ${buildHead(t, origin, t.homePath, t.alternateHomePath)}
  ${buildStructuredData(t, origin, t.homePath)}
  ${buildStyles()}
</head>
<body>
  ${buildHeader(t, locale, t.homePath)}

  <main>
    <section class="hero">
      <div class="shell hero-grid">
        <div>
          <div class="eyebrow">${escapeHtml(t.hero.eyebrow)}</div>
          <h1>${escapeHtml(t.hero.title)}</h1>
          <p class="hero-copy">${escapeHtml(t.hero.copy)}</p>
          <p class="cn-line">${escapeHtml(t.hero.support)}</p>
          <div class="cta-row">
            <a class="button primary" href="${MARKETPLACE_URL}">${escapeHtml(t.hero.primaryCta)}</a>
            <a class="button secondary" href="${OPEN_VSX_URL}">${escapeHtml(t.hero.secondaryCta)}</a>
            <a class="button ghost" href="${GITHUB_URL}">${escapeHtml(t.hero.githubCta)}</a>
          </div>
          <div class="proof" aria-label="${escapeHtml(t.hero.proofLabel)}">
            ${renderListItems(t.hero.proof, "span")}
          </div>
        </div>
        ${renderHeroPreview(locale)}
      </div>
    </section>

    <section class="section" id="product">
      <div class="shell">
        <div class="section-head">
          <h2>${escapeHtml(t.problem.title)}</h2>
          <p>${escapeHtml(t.problem.lead)}</p>
        </div>
        <div class="grid-3">
          ${renderCards(t.problem.cards)}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell">
        <div class="section-head">
          <h2>${escapeHtml(t.workflow.title)}</h2>
          <p>${escapeHtml(t.workflow.lead)}</p>
        </div>
        <div class="grid-4">
          ${renderSteps(t.workflow.steps)}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell answer-block">
        <div>
          <div class="answer-copy">
            <h2>${escapeHtml(t.answer.title)}</h2>
            <p>${escapeHtml(t.answer.lead)}</p>
          </div>
          <div class="module-list">
            ${renderModules(t.answer.modules)}
          </div>
        </div>
        <table class="comparison-table">
          <caption>${escapeHtml(t.answer.comparisonTitle)}</caption>
          <tbody>
            ${renderComparisonRows(t.answer.comparison)}
          </tbody>
        </table>
      </div>
    </section>

    <section class="section">
      <div class="shell trust-band">
        <div class="trust-copy">
          <h2>${escapeHtml(t.trust.title)}</h2>
          <p>${escapeHtml(t.trust.copy)}</p>
        </div>
        <div class="trust-list">
          ${renderListItems(t.trust.items, "div")}
        </div>
      </div>
    </section>

    <section class="section" id="pro">
      <div class="shell pro">
        <div>
          <div class="section-head" style="display:block;margin-bottom:22px">
            <h2>${escapeHtml(t.pro.title)}</h2>
          </div>
          <div class="feature-list">
            ${renderListItems(t.pro.features, "span")}
          </div>
        </div>
        <aside class="price" aria-label="${escapeHtml(t.pro.label)}">
          <span>${escapeHtml(t.pro.label)}</span>
          <strong>${escapeHtml(t.pro.price)}</strong>
          <p>${escapeHtml(t.pro.copy)}</p>
          <div class="cta-row">
            <a class="button primary" href="${FEEDBACK_URL}">${escapeHtml(t.pro.cta)}</a>
          </div>
        </aside>
      </div>
    </section>

    <section class="section">
      <div class="shell">
        <div class="section-head" style="display:block;margin-bottom:22px">
          <h2>${escapeHtml(t.faq.title)}</h2>
        </div>
        <div class="faq-list">
          ${renderFaqItems(t.faq.items)}
        </div>
      </div>
    </section>

    <section class="section" id="install">
      <div class="shell install-panel">
        <div>
          <h2>${escapeHtml(t.install.title)}</h2>
          <p class="lead">${escapeHtml(t.install.lead)}</p>
        </div>
        <div class="install-actions">
          <a class="button primary" href="${MARKETPLACE_URL}">${escapeHtml(t.install.marketplace)}</a>
          <a class="button secondary" href="${OPEN_VSX_URL}">${escapeHtml(t.install.openVsx)}</a>
          <button class="button soon" type="button" disabled>${escapeHtml(t.install.ios)} <span class="soon-tag">${escapeHtml(t.install.comingSoon)}</span></button>
          <button class="button soon" type="button" disabled>${escapeHtml(t.install.android)} <span class="soon-tag">${escapeHtml(t.install.comingSoon)}</span></button>
          <button class="button soon" type="button" disabled>${escapeHtml(t.install.webWorkspace)} <span class="soon-tag">${escapeHtml(t.install.comingSoon)}</span></button>
          <a class="button ghost" href="${GITHUB_URL}">${escapeHtml(t.install.github)}</a>
          <a class="button ghost" href="${FEEDBACK_URL}">${escapeHtml(t.install.feedback)}</a>
        </div>
      </div>
    </section>
  </main>

  ${buildFooter(t)}
</body>
</html>`;
}

function buildLocalFirstPage(locale, origin) {
  const t = content[locale];
  return `<!doctype html>
<html lang="${t.lang}">
<head>
  ${buildHead(
    { ...t, meta: { ...t.meta, title: t.privacy.title, description: t.privacy.copy, ogDescription: t.privacy.copy } },
    origin,
    t.privacyPath,
    t.alternatePrivacyPath
  )}
  ${buildStyles()}
</head>
<body>
  ${buildHeader(t, locale, t.privacyPath)}
  <main class="privacy-page">
    <h1>${escapeHtml(t.privacy.heading)}</h1>
    <p>${escapeHtml(t.privacy.copy)}</p>
    <ul>
      ${renderListItems(t.privacy.items, "li")}
    </ul>
  </main>
  ${buildFooter(t)}
</body>
</html>`;
}

function buildDocIndexPage(locale, origin) {
  const t = content[locale];
  const docs = docsContent[locale];
  const meta = {
    title: docs.index.title,
    description: docs.index.description,
    ogDescription: docs.index.description
  };
  return `<!doctype html>
<html lang="${t.lang}">
<head>
  ${buildHead({ ...t, meta }, origin, t.docsPath)}
  ${buildStyles()}
</head>
<body>
  ${buildHeader(t, locale, t.docsPath)}
  <main class="docs-page">
    <div class="docs-hero">
      <h1>${escapeHtml(docs.index.heading)}</h1>
      <p>${escapeHtml(docs.index.lead)}</p>
    </div>
    <div class="docs-grid">
      ${renderDocCards(t, docs, locale)}
    </div>
  </main>
  ${buildFooter(t)}
</body>
</html>`;
}

function buildDocPage(locale, slug, origin) {
  const t = content[locale];
  const doc = docsContent[locale].pages[slug];
  const pagePath = `${t.docsPath}/${slug}`;
  const meta = {
    title: `${doc.title} - SoloMap`,
    description: doc.description,
    ogDescription: doc.description
  };
  const articleStructuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: doc.title,
    description: doc.description,
    url: absoluteUrl(pagePath, origin),
    publisher: {
      "@type": "Organization",
      name: "SoloMap",
      url: origin
    },
    mainEntity: doc.faq.map(([question, answer]) => ({
      "@type": "Question",
      name: question,
      acceptedAnswer: {
        "@type": "Answer",
        text: answer
      }
    }))
  };
  return `<!doctype html>
<html lang="${t.lang}">
<head>
  ${buildHead({ ...t, meta }, origin, pagePath)}
  <script type="application/ld+json">${JSON.stringify(articleStructuredData)}</script>
  ${buildStyles()}
</head>
<body>
  ${buildHeader(t, locale, pagePath)}
  <main class="docs-page">
    <div class="docs-hero">
      <h1>${escapeHtml(doc.heading)}</h1>
      <p>${escapeHtml(doc.lead)}</p>
    </div>
    <div class="docs-body">
      <div class="docs-sections">
        ${renderDocSections(doc.sections)}
      </div>
      <aside class="docs-aside" aria-label="${locale === "zh" ? "常见问题" : "Questions"}">
        ${renderDocFaq(doc.faq)}
      </aside>
    </div>
  </main>
  ${buildFooter(t)}
</body>
</html>`;
}

function resolveRoute(pathname) {
  if (pathname === "/" || pathname === "/en") {
    return { type: "home", locale: "en", status: 200 };
  }
  if (pathname === "/zh" || pathname === "/zh/") {
    return { type: "home", locale: "zh", status: 200 };
  }
  if (pathname === "/docs" || pathname === "/docs/") {
    return { type: "docs-index", locale: "en", status: 200 };
  }
  if (pathname === "/zh/docs" || pathname === "/zh/docs/") {
    return { type: "docs-index", locale: "zh", status: 200 };
  }
  const englishDocMatch = pathname.match(/^\/docs\/([^/]+)$/);
  if (englishDocMatch && docsContent.en.pages[englishDocMatch[1]]) {
    return { type: "doc", locale: "en", slug: englishDocMatch[1], status: 200 };
  }
  const chineseDocMatch = pathname.match(/^\/zh\/docs\/([^/]+)$/);
  if (chineseDocMatch && docsContent.zh.pages[chineseDocMatch[1]]) {
    return { type: "doc", locale: "zh", slug: chineseDocMatch[1], status: 200 };
  }
  if (pathname === "/privacy-local-first") {
    return { type: "privacy", locale: "en", status: 200 };
  }
  if (pathname === "/zh/privacy-local-first") {
    return { type: "privacy", locale: "zh", status: 200 };
  }
  return { type: "home", locale: pathname.startsWith("/zh") ? "zh" : "en", status: 404 };
}

function buildSitemap(origin) {
  const docUrls = Object.keys(docsContent.en.pages).map((slug) => `  <url>
    <loc>${origin}/docs/${slug}</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/docs/${slug}" />
    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${origin}/zh/docs/${slug}" />
  </url>
  <url>
    <loc>${origin}/zh/docs/${slug}</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/docs/${slug}" />
    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${origin}/zh/docs/${slug}" />
  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${origin}/</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/" />
    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${origin}/zh" />
  </url>
  <url>
    <loc>${origin}/zh</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/" />
    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${origin}/zh" />
  </url>
  <url>
    <loc>${origin}/docs</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/docs" />
    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${origin}/zh/docs" />
  </url>
  <url>
    <loc>${origin}/zh/docs</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/docs" />
    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${origin}/zh/docs" />
  </url>
${docUrls}
  <url>
    <loc>${origin}/privacy-local-first</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/privacy-local-first" />
    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${origin}/zh/privacy-local-first" />
  </url>
  <url>
    <loc>${origin}/zh/privacy-local-first</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/privacy-local-first" />
    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${origin}/zh/privacy-local-first" />
  </url>
</urlset>
`;
}

function buildLlmsTxt(origin) {
  return `# SoloMap

SoloMap is a local-first VS Code extension for indie developers and solo founders building products with AI agents.

SoloMap helps users keep product direction, roadmap steps, AI agent execution history, project memory, and next actions visible inside their existing workspace. It does not replace coding agents; it gives them a product roadmap and strategy layer.

## Best short description

SoloMap is a local-first roadmap and strategy cockpit for AI-built projects in VS Code.

## Who it is for

- Indie developers building products with AI agents
- Solo founders managing multiple product ideas
- Developers who use local Agent CLIs and want clearer project continuity

## What SoloMap does

- Turns a product goal into executable roadmap steps
- Starts local AI Agent CLI work from the right roadmap context
- Keeps project memory and task records in the workspace by default
- Shows next actions when the user returns to a project
- Supports Free core workflow and Pro Early Access for strategy cockpit features

## What SoloMap is not

- SoloMap is not an AI coding agent
- SoloMap is not a hosted project management SaaS
- SoloMap is not a replacement for VS Code, Cursor, Claude Code, Codex, or other coding agents

## Important URLs

- Website: ${origin}/
- Chinese website: ${origin}/zh
- Docs: ${origin}/docs
- SoloMap method: ${origin}/docs/solomap-method
- Portfolio method: ${origin}/docs/portfolio-method
- Micro execution loop: ${origin}/docs/micro-execution-loop
- Local-first note: ${origin}/privacy-local-first
- VS Code Marketplace: ${MARKETPLACE_URL}
- Open VSX: ${OPEN_VSX_URL}
- GitHub: ${GITHUB_URL}
`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.SITE_ORIGIN || SITE_ORIGIN;

    if (url.pathname === "/health") {
      return textResponse("ok");
    }

    if (url.pathname === "/robots.txt") {
      return textResponse(`User-agent: *
Allow: /
Sitemap: ${origin}/sitemap.xml
`);
    }

    if (url.pathname === "/llms.txt") {
      return textResponse(buildLlmsTxt(origin));
    }

    if (url.pathname === "/sitemap.xml") {
      return textResponse(buildSitemap(origin), "application/xml; charset=utf-8");
    }

    const route = resolveRoute(url.pathname);
    if (route.type === "privacy") {
      return htmlResponse(buildLocalFirstPage(route.locale, origin), route.status);
    }
    if (route.type === "docs-index") {
      return htmlResponse(buildDocIndexPage(route.locale, origin), route.status);
    }
    if (route.type === "doc") {
      return htmlResponse(buildDocPage(route.locale, route.slug, origin), route.status);
    }

    return htmlResponse(buildPage(route.locale, origin), route.status);
  }
};

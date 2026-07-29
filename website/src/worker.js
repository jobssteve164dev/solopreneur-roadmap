import {
  assertSameOrigin,
  clearSessionCookie,
  createSessionCookie,
  passportHeadlessRequest,
  readSession,
  safeReturnTo
} from "./headlessAuth.js";
import {
  alternateLegalPath,
  findLegalRoute,
  getLegalContent,
  legalPath,
  legalRoutes,
  legalSupplementRoute
} from "./legalDocuments.js";
import {
  buildCollaborationRoomPage,
  collaborationRoomPageHeaders
} from "./collaborationPage.js";
import {
  CollaborationLobby,
  CollaborationQuota,
  CollaborationRoom,
  handleCollaborationDeviceRegistration,
  handleCollaborationLobbySession,
  handleCollaborationLobbySocket,
  handleCollaborationRoomCreate,
  handleCollaborationSocket
} from "./collaborationRelay.js";

const SITE_ORIGIN = "https://solomap.app";
const MARKETPLACE_URL = "https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap";
const OPEN_VSX_URL = "https://open-vsx.org/extension/SZLK/solopreneur-roadmap";
const GITHUB_URL = "https://github.com/jobssteve164dev/solopreneur-roadmap";
const FEEDBACK_URL = "https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new?template=seed-user-feedback.yml";
const SCREENSHOT_URL = "https://raw.githubusercontent.com/jobssteve164dev/solopreneur-roadmap/main/docs/assets/solomap_red_terminal.png";
const LOGO_URL = "https://raw.githubusercontent.com/jobssteve164dev/solopreneur-roadmap/main/resources/logo.svg";
const SOLOMAP_PRODUCT = "solomap";
const STRATEGY_PYRAMID_FEATURE = "strategy_pyramid";
const VSCODE_CALLBACK_PREFIXES = [
  "vscode://SZLK.solopreneur-roadmap/passport/callback",
  "vscode-insiders://SZLK.solopreneur-roadmap/passport/callback",
  "code-oss://SZLK.solopreneur-roadmap/passport/callback"
];
const PASSPORT_ISSUER = "https://passport.szlk.ai";
const PASSPORT_OIDC_AUTHORIZE_URL = `${PASSPORT_ISSUER}/api/oidc/authorize`;
const PASSPORT_OIDC_TOKEN_URL = `${PASSPORT_ISSUER}/api/oidc/token`;
const PASSPORT_OIDC_USERINFO_URL = `${PASSPORT_ISSUER}/api/oidc/userinfo`;
const PASSPORT_ACCESS_CHECK_URL = `${PASSPORT_ISSUER}/api/v1/entitlements/access-check`;
const PASSPORT_CHECKOUT_LINK_URL = `${PASSPORT_ISSUER}/api/v1/billing/checkout-link`;
const PASSPORT_ACCOUNT_URL = `${PASSPORT_ISSUER}/passport/account`;
const SOLOMAP_OIDC_CLIENT_ID = "solomap-vscode";
const SOLOMAP_PRO_PLAN_ID = "solomap_pro_early_access_yearly";
const SOLOMAP_PRO_DEVICE_LIMIT = 5;
const SITEMAP_LASTMOD = "2026-06-06";

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

const apiHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization"
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
      ogDescription: "Keep your AI-built projects moving with a local-first roadmap and strategy cockpit in VS Code.",
      keywords: "solomap, vscode extension, local-first roadmap, ai coding agents, indie hackers, solo founders, strategy cockpit, portfolio management, cursor ide, claude code"
    },
    hero: {
      eyebrow: "Local-first VS Code extension",
      title: "Let AI Agents Code. Let SoloMap Steer.",
      copy: "The local-first strategy cockpit for solo developers building with AI. Turn chaos into structured roadmaps and keep your agents on track.",
      support: "Let AI agents execute. Let SoloMap keep the direction clear.",
      primaryCta: "Install from VS Code Marketplace",
      secondaryCta: "Get it on Open VSX",
      githubCta: "View on GitHub",
      proofLabel: "Product highlights",
      proof: ["Works in your workspace", "Bring your own Agent CLI", "Free core workflow"],
      trustBadge: "Loved by 1,200+ solo developers keeping momentum",
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
        "Portfolio tradeoff view",
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
      webWorkspace: "Workbench",
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
    },
    workbench: {
      metaTitle: "SoloMap Workbench - Pro Early Access & Co-Creation Hub",
      metaDescription: "Apply for SoloMap Pro Early Access, vote on the roadmap, and manage your Pro entitlements and device activations.",
      title: "SoloMap Workbench",
      subtitle: "The co-creation hub for indie builders.",
      earlyAccess: {
        title: "Join Pro Early Access",
        desc: "Unlock advanced strategic features and help shape the product's direction. We will review applications and grant early access codes daily.",
        emailPlaceholder: "Enter your developer email",
        applyBtn: "Request Early Access",
        codePlaceholder: "Or paste your Pro activation code",
        activateBtn: "Activate Pro",
        appliedMsg: "Thank you! Your request has been registered. We will email your invite code soon.",
        activeMsg: "SoloMap Pro is active on this device!",
        invalidCodeMsg: "Invalid activation code. Please try again."
      },
      roadmap: {
        title: "Pro Feature Roadmap & Voting",
        desc: "Vote for the capabilities you need most. We build by voting weight.",
        voteSuccess: "Thank you for voting! Your priority preference has been saved.",
        items: [
          ["Strategy Pyramid", "Visual tradeoff cockpit across side projects. (Shipped)", "strategy_pyramid", "Shipped"],
          ["Project Growth Graph", "File and LOC evolution charts showing testing gaps and coverage. (Shipped)", "growth_graph", "Shipped"],
          ["Web Workbench", "A web UI to preview and co-create your roadmaps. (In Progress)", "web_workbench", "In Progress"],
          ["Telegram Bot Remote control", "Asynchronously approve agent runs and get finished notifications on mobile. (Planned)", "tg_remote", "Vote & Co-create"],
          ["GitHub Issues Inbox", "Bring open issues into SoloMap and send them directly to an Agent. (Planned)", "github_issues_inbox", "Vote & Co-create"]
        ]
      },
      proEntitlements: {
        title: "Your Pro Entitlements",
        desc: "Active plan: Pro Early Access ($29/yr value, locked-in forever).",
        limitMsg: "Active on 1 / 5 personal devices.",
        recoverBtn: "Retrieve activation code",
        manageBtn: "Manage account in Passport"
      }
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
      title: "独道 (SoloMap) - 给 AI Agent 项目的本地优先路线图与战略驾驶舱",
      description: "独道 (SoloMap) 是给使用 AI Agent 构建产品的独立开发者准备的本地优先路线图与战略驾驶舱。",
      ogDescription: "让 AI Agent 负责执行，让独道负责不丢方向。",
      keywords: "独道, SoloMap, VS Code插件, 本地优先路线图, AI Agent, 独立开发, 独立创始人, 战略驾驶舱, 项目管理, 个人商业, 独立变现"
    },
    hero: {
      eyebrow: "本地优先的 VS Code 插件",
      title: "AI 负责编写代码，独道负责掌控方向。",
      copy: "为独立开发者与个人创业者打造的本地优先战略驾驶舱。把想法变成路线图，让 Agent 奔跑在正确的道路上。",
      support: "把产品想法、路线图、Agent 执行历史和下一步动作放回你的本地工作区。",
      primaryCta: "从 VS Code Marketplace 安装",
      secondaryCta: "在 Open VSX 获取",
      githubCta: "查看 GitHub",
      proofLabel: "产品亮点",
      proof: ["在你的工作区里运行", "使用你已有的 Agent CLI", "Free 主路径保持可用"],
      trustBadge: "超过 1,200+ 位独立开发者正在使用独道保持推进",
      screenshotLabel: "独道在 VS Code 中运行",
      screenshotAlt: "独道 (SoloMap) 路线图和 Agent 终端在 Visual Studio Code 中运行"
    },
    problem: {
      title: "AI 能写代码，但不会自动帮你经营项目方向。",
      lead: "独道 (SoloMap) 把计划、Agent 执行、下一步动作和项目记忆留在你真正工作的地方。",
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
        ["添加本地项目", "选择一个工作区文件夹，让独道 (SoloMap) 在那里建立项目推进界面。"],
        ["生成路线图", "描述目标，得到一组可执行、可调整的路线图环节。"],
        ["运行你的 AI Agent", "从正确的路线图环节启动本地 Agent CLI，并自动带上上下文。"],
        ["回来继续推进", "下次打开 VS Code 时，直接看到今日安排、项目状态和最近进展。"]
      ]
    },
    answer: {
      title: "独道 (SoloMap) 是什么？",
      lead: "独道 (SoloMap) 是一个本地优先的 VS Code 插件，帮助独立开发者把 AI Agent 项目整理成清晰路线图、可执行 Agent 任务和可继续推进的下一步。它不替代编码 Agent，而是给编码 Agent 外层补上产品方向，让一个人也能持续 Build、Sell、Learn、Improve。",
      comparisonTitle: "独道与 AI 编码工具的区别",
      comparison: [
        ["管理对象", "项目方向、路线图环节、Agent 执行上下文、推进记忆", "代码生成、编辑、问答、审查和终端执行"],
        ["工作位置", "用户已有的 VS Code 本地工作区", "通常在 IDE、终端、托管聊天或 Agent 运行环境中"],
        ["最适合", "知道下一步做什么，并让一个产品持续推进", "完成一个具体编码、修改或解释任务"],
        ["数据姿态", "核心工作流默认本地优先", "取决于用户选择的 AI provider 和工具"]
      ],
      modules: [
        ["选择独道，如果", "你已经在用 AI Agent，但项目计划、对话、代码修改和后续动作总是散落。"],
        ["选择编码 Agent，如果", "你当前只需要完成一个具体的写代码、改代码、解释代码或审查任务。"],
        ["两者一起用，当", "你希望 Agent 负责执行，同时独道保持路线图、项目记忆和下一步动作清楚可见。"]
      ]
    },
    trust: {
      title: "默认本地优先。",
      copy: "独道 (SoloMap) 的核心工作流不要求托管后端。路线图、任务记录和项目记忆优先留在你的本地工作区。",
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
        "多项目取舍判断",
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
      title: "先用一个项目试试独道 (SoloMap)。",
      lead: "如果它帮你保持推进，请告诉我们金字塔战略驾驶舱下一步应该看见什么。",
      marketplace: "VS Code Marketplace",
      openVsx: "Open VSX",
      ios: "iOS 应用",
      android: "安卓应用",
      webWorkspace: "工作台",
      comingSoon: "即将推出",
      github: "GitHub 仓库",
      feedback: "提交反馈"
    },
    faq: {
      title: "独道 (SoloMap) 常见问题",
      items: [
        ["独道 (SoloMap) 是 AI 编码 Agent 吗？", "不是。独道 (SoloMap) 是你已有编码 Agent 外层的路线图和战略层。"],
        ["独道 (SoloMap) 必须使用托管后端吗？", "不需要。核心工作流默认把路线图状态、任务记录和项目记忆保存在本地工作区。"],
        ["谁适合使用独道 (SoloMap)？", "独道 (SoloMap) 适合在 VS Code 中用 AI Agent 构建产品的独立开发者和 solo founder。"],
        ["独道 (SoloMap) 解决什么问题？", "它让项目方向、下一步动作和 AI 执行历史保持可见，避免一个人做产品时在多次编码会话之间丢掉节奏。"],
        ["独道 (SoloMap) 能配合不同 Agent CLI 吗？", "可以。独道 (SoloMap) 的设计是带上你自己的本地 Agent CLI，而不是强迫你使用某一个托管编码 Agent。"]
      ]
    },
    footer: {
      feedback: "反馈",
      privacy: "隐私 / 本地优先说明"
    },
    privacy: {
      title: "独道 (SoloMap) 本地优先说明",
      back: "返回独道 (SoloMap)",
      heading: "本地优先说明",
      copy: "独道 (SoloMap) 的核心工作流默认把路线图状态、任务记录和项目记忆保存在你的本地工作区。主项目推进流程不要求托管的独道 (SoloMap) 后端。",
      items: [
        "AI 服务的使用取决于你选择的本地 Agent CLI。",
        "GitHub 数据只在你连接或刷新相关信号时使用。",
        "反馈只会在你主动打开或提交反馈 Issue 时发送。"
      ]
    },
    workbench: {
      metaTitle: "SoloMap 工作台 - Pro Early Access 与共创中心",
      metaDescription: "申请 SoloMap Pro Early Access、为路线图功能投票，并管理您的 Pro 权益与设备激活码。",
      title: "SoloMap 官网工作台",
      subtitle: "独立开发者的共创与权益中心",
      earlyAccess: {
        title: "申请 Pro Early Access",
        desc: "解锁高级战略驾驶舱并参与功能共创。我们每天会审核申请并向独立开发者发放 Early Access 激活码。",
        emailPlaceholder: "输入您的常用邮箱",
        applyBtn: "申请 Early Access",
        codePlaceholder: "或在此输入 Pro 激活码",
        activateBtn: "激活 Pro 权益",
        appliedMsg: "申请已提交！我们审核后会将 Early Access 邀请发送至您的邮箱，请耐心等待。",
        activeMsg: "SoloMap Pro 已经在当前设备激活！",
        invalidCodeMsg: "激活码无效，请检查后重试。"
      },
      roadmap: {
        title: "Pro 功能路线图与共创投票",
        desc: "为你最需要的功能投票。我们将完全按投票权重排期开发。",
        voteSuccess: "投票成功！感谢您的共创参与。",
        items: [
          ["战略金字塔", "跨 Side Project 统一全局调配驾驶舱 (已上线)", "strategy_pyramid", "已上线"],
          ["项目生长图", "显示模块文件 LOC 演进、测试空缺与覆盖度 (已上线)", "growth_graph", "已上线"],
          ["官网工作台", "脱离编辑器的路线图预览与 Early Access 控制面 (进行中)", "web_workbench", "进行中"],
          ["Telegram 远程控制", "离开电脑后接收 Agent 执行完成通知并可异步批准 (计划中)", "tg_remote", "投票共创"],
          ["GitHub Issues 收件箱", "把待处理 Issue 带入 SoloMap，并直接交给 Agent 解决 (计划中)", "github_issues_inbox", "投票共创"]
        ]
      },
      proEntitlements: {
        title: "您的 Pro 权益管理",
        desc: "当前计划：Pro Early Access（锁定年付首期 $29 优惠）。",
        limitMsg: "已激活 1 / 5 台个人设备。",
        recoverBtn: "取回激活码",
        manageBtn: "前往 Passport 账户中心"
      }
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

function htmlResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      ...securityHeaders,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      ...extraHeaders
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

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...apiHeaders, ...extraHeaders }
  });
}

function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a[index] ^ b[index];
  }
  return result === 0;
}

function randomString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function isAllowedVsCodeCallback(callback) {
  return VSCODE_CALLBACK_PREFIXES.some((prefix) => String(callback || "").startsWith(prefix));
}

function normalizeAuthMode(value) {
  return String(value || "") === "device" ? "device" : "callback";
}

function normalizeAuthNonce(value) {
  const nonce = String(value || "").trim();
  return /^[A-Za-z0-9_-]{24,160}$/.test(nonce) ? nonce : "";
}

function getDeviceAuthorizeUrl(requestUrl, deviceCode) {
  const url = new URL("/api/passport/device/authorize", requestUrl.origin);
  url.searchParams.set("device", deviceCode);
  return url.toString();
}

function getProPlanId(env) {
  return String(env.SOLOMAP_PRO_PLAN_ID || SOLOMAP_PRO_PLAN_ID);
}

function getProDeviceLimit(env) {
  const value = Number(env.SOLOMAP_PRO_DEVICE_LIMIT || SOLOMAP_PRO_DEVICE_LIMIT);
  return Number.isFinite(value) && value >= 3 ? Math.floor(value) : SOLOMAP_PRO_DEVICE_LIMIT;
}

function getPassportAccountUrl(env) {
  return String(env.SOLOMAP_PASSPORT_ACCOUNT_URL || PASSPORT_ACCOUNT_URL);
}

async function getPassportCheckoutSuccessUrl(env, requestUrl, state, userinfo = {}) {
  const payload = {
    mode: state.mode,
    callback: state.callback || "",
    deviceCode: state.deviceCode || "",
    authNonce: state.authNonce || "",
    email: userinfo.email || state.email || "",
    userId: userinfo.sub || userinfo.userId || state.userId || "",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  };
  const url = new URL("/api/passport/checkout/success", requestUrl.origin);
  url.searchParams.set("state", await signState(env, payload));
  return url.toString();
}

async function signState(env, payload) {
  if (!env.SOLOMAP_PASSPORT_PRODUCT_SECRET) {
    throw new Error("missing_product_secret");
  }
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(env.SOLOMAP_PASSPORT_PRODUCT_SECRET, encodedPayload);
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

async function verifyState(env, state) {
  const parts = String(state || "").split(".");
  if (!env.SOLOMAP_PASSPORT_PRODUCT_SECRET || parts.length !== 2) {
    return null;
  }
  const expected = await hmacSha256(env.SOLOMAP_PASSPORT_PRODUCT_SECRET, parts[0]);
  let actual;
  try {
    actual = base64UrlDecode(parts[1]);
  } catch {
    return { allowed: false, reason: "invalid_signature" };
  }
  if (base64UrlEncode(actual) !== parts[1]) return null;
  if (!timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    if (Date.parse(payload.expiresAt || "") <= Date.now()) {
      return null;
    }
    return payload;
  } catch (error) {
    return null;
  }
}

async function createUpgradeState(env, input) {
  const mode = normalizeAuthMode(input.mode);
  const authNonce = normalizeAuthNonce(input.authNonce);
  const callback = String(input.callback || "").trim();
  if (!authNonce) {
    return null;
  }
  if (mode === "callback" && !isAllowedVsCodeCallback(callback)) {
    return null;
  }
  return signState(env, {
    product: SOLOMAP_PRODUCT,
    feature: STRATEGY_PYRAMID_FEATURE,
    source: String(input.source || "vscode").slice(0, 40),
    mode,
    callback: mode === "callback" ? callback : "",
    authNonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  });
}

async function resolveUpgradeStateFromRequest(request, env) {
  const url = new URL(request.url);
  const signed = String(url.searchParams.get("upgrade_state") || "").trim();
  if (signed) {
    const payload = await verifyState(env, signed);
    if (!payload || payload.product !== SOLOMAP_PRODUCT || payload.feature !== STRATEGY_PYRAMID_FEATURE) {
      return null;
    }
    if (!normalizeAuthNonce(payload.authNonce)) {
      return null;
    }
    if (payload.mode !== "device" && !isAllowedVsCodeCallback(payload.callback)) {
      return null;
    }
    return payload;
  }
  const callback = String(url.searchParams.get("callback") || "").trim();
  const mode = normalizeAuthMode(url.searchParams.get("mode") || (callback ? "callback" : "device"));
  const authNonce = normalizeAuthNonce(url.searchParams.get("auth_nonce"));
  const upgradeState = await createUpgradeState(env, {
    mode,
    callback,
    authNonce,
    source: url.searchParams.get("source") || "vscode"
  });
  if (!upgradeState) {
    return null;
  }
  return verifyState(env, upgradeState);
}

async function createDeviceCode(env, options = {}) {
  return signState(env, {
    mode: "device",
    nonce: randomString(24),
    authNonce: normalizeAuthNonce(options.authNonce),
    intent: String(options.intent || "device").slice(0, 40),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  });
}

async function issueSoloMapGrant(env, email = "pro-test@solomap.app", options = {}) {
  if (!env.SOLOMAP_PASSPORT_PRODUCT_SECRET) {
    throw new Error("missing_product_secret");
  }
  const payload = {
    product: SOLOMAP_PRODUCT,
    feature: STRATEGY_PYRAMID_FEATURE,
    email,
    userId: options.userId || `passport:${email}`,
    entitlements: Object.prototype.hasOwnProperty.call(options, "entitlements") && Array.isArray(options.entitlements)
      ? options.entitlements
      : [STRATEGY_PYRAMID_FEATURE, "solomap_pro"],
    deviceLimit: getProDeviceLimit(env),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(env.SOLOMAP_PASSPORT_PRODUCT_SECRET, encodedPayload);
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

async function issueSoloMapExchangeCode(env, grant, context = {}) {
  return signState(env, {
    purpose: "solomap_grant_exchange",
    product: SOLOMAP_PRODUCT,
    feature: STRATEGY_PYRAMID_FEATURE,
    mode: normalizeAuthMode(context.mode),
    callback: String(context.callback || ""),
    deviceCode: String(context.deviceCode || ""),
    authNonce: normalizeAuthNonce(context.authNonce),
    grant,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  });
}

async function verifySoloMapExchangeCode(env, code, expected = {}) {
  const payload = await verifyState(env, code);
  if (!payload || payload.purpose !== "solomap_grant_exchange") {
    return null;
  }
  if (payload.product !== SOLOMAP_PRODUCT || payload.feature !== STRATEGY_PYRAMID_FEATURE) {
    return { allowed: false, reason: "invalid_exchange_scope" };
  }
  const expectedNonce = normalizeAuthNonce(expected.authNonce);
  if (!expectedNonce || payload.authNonce !== expectedNonce) {
    return { allowed: false, reason: "auth_context_mismatch" };
  }
  if (payload.mode === "callback" && String(expected.callback || "") !== String(payload.callback || "")) {
    return { allowed: false, reason: "callback_mismatch" };
  }
  if (payload.mode === "device" && payload.deviceCode && String(expected.deviceCode || "") !== String(payload.deviceCode || "")) {
    return { allowed: false, reason: "device_mismatch" };
  }
  const verified = await verifySignedGrant(env, String(payload.grant || ""));
  return {
    ...verified,
    grant: verified.allowed ? String(payload.grant || "") : ""
  };
}

async function issueCollaborationAccountExchangeCode(env, grant, context = {}) {
  return signState(env, {
    purpose: "solomap_collaboration_account_exchange",
    product: SOLOMAP_PRODUCT,
    callback: String(context.callback || ""),
    authNonce: normalizeAuthNonce(context.authNonce),
    grant,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  });
}

async function verifyCollaborationAccountExchangeCode(env, code, expected = {}) {
  const payload = await verifyState(env, code);
  if (!payload || payload.purpose !== "solomap_collaboration_account_exchange") return null;
  if (payload.product !== SOLOMAP_PRODUCT) return { authenticated: false, allowed: false, reason: "invalid_exchange_scope" };
  const expectedNonce = normalizeAuthNonce(expected.authNonce);
  if (!expectedNonce || payload.authNonce !== expectedNonce) return { authenticated: false, allowed: false, reason: "auth_context_mismatch" };
  if (String(expected.callback || "") !== String(payload.callback || "")) return { authenticated: false, allowed: false, reason: "callback_mismatch" };
  const verified = await verifySignedGrant(env, String(payload.grant || ""));
  return { ...verified, grant: verified.authenticated ? String(payload.grant || "") : "" };
}

async function verifySignedGrant(env, grant) {
  if (!env.SOLOMAP_PASSPORT_PRODUCT_SECRET) {
    return { allowed: false, reason: "missing_product_secret" };
  }
  const parts = String(grant || "").split(".");
  if (parts.length !== 2) {
    return { allowed: false, reason: "invalid_grant" };
  }
  const expected = await hmacSha256(env.SOLOMAP_PASSPORT_PRODUCT_SECRET, parts[0]);
  let actual;
  try {
    actual = base64UrlDecode(parts[1]);
  } catch {
    return { authenticated: false, allowed: false, reason: "invalid_signature" };
  }
  if (base64UrlEncode(actual) !== parts[1]) {
    return { authenticated: false, allowed: false, reason: "invalid_signature" };
  }
  if (!timingSafeEqual(expected, actual)) {
    return { allowed: false, reason: "invalid_signature" };
  }
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
  } catch (error) {
    return { allowed: false, reason: "invalid_payload" };
  }
  const entitlements = Array.isArray(payload.entitlements) ? payload.entitlements.map((item) => String(item || "")).filter(Boolean) : [];
  const expiresAtMs = Date.parse(payload.expiresAt || "");
  const authenticated = payload.product === SOLOMAP_PRODUCT &&
    Boolean(payload.userId || payload.email) &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > Date.now();
  const allowed = authenticated &&
    entitlements.includes(STRATEGY_PYRAMID_FEATURE) &&
    Number.isFinite(expiresAtMs);
  return {
    authenticated,
    allowed,
    reason: allowed ? "allowed" : authenticated ? "authenticated" : "invalid_identity",
    email: String(payload.email || ""),
    userId: String(payload.userId || ""),
    entitlements,
    deviceLimit: Number(payload.deviceLimit || payload.maxDevices || SOLOMAP_PRO_DEVICE_LIMIT),
    expiresAt: String(payload.expiresAt || "")
  };
}

async function resolveCollaborationAccountCreator(request, env) {
  const session = await readSession(request, env);
  if (session && (session.id || session.email)) {
    const stableId = base64UrlEncode(await sha256(String(session.id || session.email)));
    return { subjectId: `account:${stableId}`, tier: "account" };
  }
  const authorization = String(request.headers.get("authorization") || "");
  const grant = authorization.replace(/^Bearer\s+/i, "");
  if (!grant || grant === authorization) return null;
  let verified = await verifySignedGrant(env, grant);
  if (!verified.authenticated && !verified.allowed) {
    const passportResult = await verifyGrantWithPassport(env, grant);
    if (passportResult) verified = passportResult;
  }
  const authenticated = Boolean(verified.authenticated || (verified.allowed && (verified.userId || verified.email)));
  if (!authenticated || (!verified.userId && !verified.email)) return null;
  const stableId = base64UrlEncode(await sha256(String(verified.userId || verified.email)));
  return { subjectId: `account:${stableId}`, tier: verified.allowed ? "pro" : "account" };
}

async function handleCollaborationAccountStart(request, env) {
  const url = new URL(request.url);
  const callback = String(url.searchParams.get("callback") || "");
  const authNonce = normalizeAuthNonce(url.searchParams.get("auth_nonce"));
  if (!isAllowedVsCodeCallback(callback) || !authNonce) {
    return jsonResponse({ ok: false, reason: "invalid_auth_context" }, 400);
  }
  const session = await readSession(request, env);
  if (!session || (!session.id && !session.email)) {
    const returnTo = `${url.pathname}${url.search}`;
    return Response.redirect(`${url.origin}/login?return_to=${encodeURIComponent(returnTo)}`, 302);
  }
  const grant = await issueSoloMapGrant(env, String(session.email || ""), {
    userId: String(session.id || session.email || ""),
    entitlements: ["collaboration_lobby"]
  });
  const code = await issueCollaborationAccountExchangeCode(env, grant, { callback, authNonce });
  const callbackUrl = new URL(callback);
  callbackUrl.searchParams.set("code", code);
  callbackUrl.searchParams.set("intent", "collaboration");
  return Response.redirect(callbackUrl.toString(), 302);
}

async function verifyGrantWithPassport(env, grant) {
  if (!env.SOLOMAP_PASSPORT_VERIFY_URL) {
    return null;
  }
  const response = await fetch(env.SOLOMAP_PASSPORT_VERIFY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${grant}`,
      "x-solomap-product": SOLOMAP_PRODUCT,
      "x-solomap-product-secret": env.SOLOMAP_PASSPORT_PRODUCT_SECRET || ""
    },
    body: JSON.stringify({
      product: SOLOMAP_PRODUCT,
      feature: STRATEGY_PYRAMID_FEATURE
    })
  });
  if (!response.ok) {
    return { allowed: false, reason: `passport_http_${response.status}` };
  }
  const body = await response.json();
  const data = body && typeof body === "object" && body.ok === true && body.data ? body.data : body;
  return {
    authenticated: Boolean(data.authenticated || data.allowed) && Boolean(data.email || data.userId || data.user_id),
    allowed: Boolean(data.allowed),
    reason: String(data.reason || ""),
    email: String(data.email || ""),
    userId: String(data.userId || data.user_id || ""),
    entitlements: Array.isArray(data.entitlements) ? data.entitlements.map((item) => String(item || "")).filter(Boolean) : [],
    deviceLimit: Number(data.deviceLimit || data.device_limit || data.maxDevices || data.max_devices || SOLOMAP_PRO_DEVICE_LIMIT),
    expiresAt: String(data.expiresAt || data.expires_at || "")
  };
}

async function checkPassportAccessForUser(env, userinfo) {
  const email = String(userinfo.email || "").trim();
  const userId = String(userinfo.sub || userinfo.userId || "").trim();
  if (!email && !userId) {
    return { allowed: false, reason: "missing_user" };
  }
  const verifyUrl = env.SOLOMAP_PASSPORT_VERIFY_URL || PASSPORT_ACCESS_CHECK_URL;
  if (verifyUrl) {
    const response = await fetch(verifyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-szlk-product": SOLOMAP_PRODUCT,
        "x-szlk-secret": env.SOLOMAP_PASSPORT_PRODUCT_SECRET || ""
      },
      body: JSON.stringify({
        product: SOLOMAP_PRODUCT,
        featureKey: STRATEGY_PYRAMID_FEATURE,
        email,
        userId
      })
    });
    const body = await response.json().catch(() => ({}));
    const data = body && typeof body === "object" && body.ok === true && body.data ? body.data : body;
    if (!response.ok || body.ok === false) {
      return {
        allowed: false,
        reason: String(body?.error?.code || data?.reason || `passport_access_http_${response.status}`),
        email: String(body?.error?.details?.email || data?.email || email),
        userId: String(body?.error?.details?.userId || data?.userId || data?.user_id || userId),
        entitlements: []
      };
    }
    return {
      allowed: Boolean(data.allowed),
      reason: String(data.reason || ""),
      email: String(data.email || email),
      userId: String(data.userId || data.user_id || userId),
      entitlements: Array.isArray(data.entitlements) ? data.entitlements.map((item) => String(item || "")).filter(Boolean) : [],
      deviceLimit: Number(data.deviceLimit || data.device_limit || data.maxDevices || data.max_devices || getProDeviceLimit(env))
    };
  }
  if (env.SOLOMAP_PASSPORT_REQUIRE_UPSTREAM === "1") {
    return { allowed: false, reason: "missing_passport_verify_url" };
  }
  return {
    allowed: false,
    reason: "passport_verify_not_configured",
    email,
    userId,
    entitlements: [],
    deviceLimit: getProDeviceLimit(env)
  };
}

function buildPassportFallbackPage(callback) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SoloMap Pro</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
    main { width: min(680px, calc(100vw - 32px)); }
    h1 { font-size: 32px; margin: 0 0 12px; }
    p { color: #cbd5e1; line-height: 1.6; }
    a { color: #bfdbfe; }
  </style>
</head>
<body>
  <main>
    <h1>继续完成 SoloMap Pro</h1>
    <p>这一步只用于确认你的 Pro 使用权，不会上传你的项目计划、推进历史或本地经验。</p>
    ${callback ? `<p>完成后会回到 SoloMap 插件。</p>` : `<p>请从 SoloMap 插件里的“升级 Pro”入口重新打开。</p>`}
    <p><a href="/">返回 SoloMap</a></p>
  </main>
</body>
</html>`;
}

function buildPassportUpgradeUnavailablePage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SoloMap Pro</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #11100e; color: #f6f0e8; }
    main { width: min(680px, calc(100vw - 32px)); }
    h1 { font-size: 30px; margin: 0 0 12px; }
    p { color: #ded4c8; line-height: 1.6; }
    a { color: #fde68a; }
  </style>
</head>
<body>
  <main>
    <h1>暂时无法打开 Pro 订阅</h1>
    <p>请稍后从 SoloMap 重新尝试升级。你的本地项目数据不会被上传，Free 核心功能仍可继续使用。</p>
    <p><a href="/">返回 SoloMap</a></p>
  </main>
</body>
</html>`;
}

function buildDeviceGrantPage(grant, context = {}) {
  const escapedGrant = escapeHtml(grant);
  const email = String(context.email || "").trim();
  const deviceLimit = Number(context.deviceLimit || SOLOMAP_PRO_DEVICE_LIMIT);
  const accountUrl = escapeHtml(String(context.accountUrl || PASSPORT_ACCOUNT_URL));
  const activationCopy = deviceLimit >= 3
    ? `你的 SoloMap Pro 可在最多 ${deviceLimit} 台个人设备上激活。`
    : "你的 SoloMap Pro 已可在多台个人设备上激活。";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SoloMap Pro 已授权</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #11100e; color: #f6f0e8; }
    main { width: min(720px, calc(100vw - 32px)); }
    h1 { font-size: 30px; margin: 0 0 12px; }
    p { color: #ded4c8; line-height: 1.6; }
    textarea { width: 100%; min-height: 140px; margin-top: 12px; padding: 14px; border-radius: 8px; border: 1px solid rgba(246,240,232,.24); background: #1a1714; color: #f6f0e8; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
    button, a.button { border: 0; border-radius: 8px; padding: 11px 16px; background: #f6f0e8; color: #11100e; font-weight: 700; cursor: pointer; text-decoration: none; }
    a.button.secondary { background: transparent; color: #f6f0e8; border: 1px solid rgba(246,240,232,.24); }
  </style>
</head>
<body>
  <main>
    <h1>SoloMap Pro 已授权</h1>
    <p>复制下面的激活码，回到 SoloMap 粘贴后即可打开 Pro 功能。${email ? `当前账户：${escapeHtml(email)}。` : ""}</p>
    <p>${escapeHtml(activationCopy)}</p>
    <textarea id="code" readonly>${escapedGrant}</textarea>
    <div class="actions">
      <button id="copy" type="button">复制激活码</button>
      <a class="button secondary" href="${accountUrl}">打开账户页面</a>
    </div>
  </main>
  <script>
    document.getElementById('copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(document.getElementById('code').value);
      document.getElementById('copy').textContent = '已复制';
    });
  </script>
</body>
</html>`;
}

function getProPageCopy(locale) {
  if (locale === "en") {
    return {
      metaTitle: "SoloMap Pro - Strategy cockpit for solo founders",
      metaDescription: "SoloMap Pro helps indie developers decide which projects to double down on, pause, or turn into a stronger one-person business.",
      eyebrow: "Pro Early Access for indie builders",
      title: "Know which project deserves your next month.",
      lead: "SoloMap Pro is for solo founders who have more ideas than time. It helps you decide what to double down on, what to pause, and where your work is starting to compound into a real business.",
      primaryCta: "Join Pro Early Access",
      recoverCta: "Already subscribed? Get activation code",
      accountCta: "Open account",
      secondaryCta: "Install Free first",
      bullets: [
        ["Choose with confidence", "Stop spreading attention across every unfinished idea and see which bet has the strongest reason to continue."],
        ["Avoid expensive drift", "Catch when a project is absorbing time without improving reach, learning, revenue, or reusable capability."],
        ["Build a stronger portfolio", "Connect product work, distribution, learning, skill leverage, and revenue into one operating view."]
      ],
      offerLabel: "Early Access",
      price: "$29",
      priceSuffix: "/ year",
      offerCopy: "Lock in the first Pro price while the one-person-company cockpit is shaped with early users.",
      offerNote: "Free keeps project movement available. Pro unlocks the business-level view for serious solo builders.",
      previewTitle: "What Pro unlocks now",
      previewLead: "The first paid view is the Strategy Pyramid: a business cockpit for solo founders, not another task dashboard.",
      pyramid: [
        ["Freedom & brand", "Are you gaining optionality?"],
        ["Compounding revenue", "Are income sources getting healthier?"],
        ["Market trust", "Are discovery and feedback signals improving?"],
        ["Capability compounding", "Which skills now pay off across projects?"],
        ["Strategic inventory", "Which bets deserve the next 30 days?"]
      ],
      comparisonTitle: "Free vs Pro",
      comparisonLead: "Free keeps the core SoloMap habit. Pro is for people who need operating judgment across projects.",
      planHeader: ["Capability", "Free", "Pro Early Access"],
      plans: [
        ["Project movement", "Single-project roadmap, today plan, and basic progress history.", "Everything in Free, plus company-level project portfolio context."],
        ["Strategic view", "Know what to do next inside one project.", "See whether projects, capabilities, market trust, and revenue reinforce each other."],
        ["Decision confidence", "Know whether the latest push moved a project forward.", "Understand where progress is real, where proof is thin, and where the next focused push should go."],
        ["Portfolio decisions", "Manual project switching and local project summaries.", "Project tradeoffs, portfolio health, ability compounding, and structural risk signals."],
        ["Roadmap influence", "Use the public Free workflow and send feedback.", "Help shape the Pro roadmap while keeping the early access price."]
      ],
      roadmapTitle: "What Pro is growing into",
      roadmapLead: "Start with the strategy cockpit, then get clearer progress history and fewer manual restarts as Pro matures.",
      roadmap: [
        ["Available first", "Strategy Pyramid", "A one-person-company cockpit for portfolio structure, capability leverage, market trust, and strategic tradeoffs."],
        ["Next Pro pillar", "Reliable progress history", "A clearer account of what changed, what still needs attention, and which projects are becoming easier to maintain."],
        ["Flagship direction", "Goal-driven autopilot", "Give SoloMap a concrete outcome and let it keep pushing the work forward with fewer manual restarts."]
      ],
      trustTitle: "Still local-first.",
      trustCopy: "Your project plans, work history, and local memory stay in your workspace. Pro only unlocks paid product capabilities.",
      trustItems: [
        "No hosted SoloMap project database is required for the core workflow.",
        "You keep using the workspace and tools you already trust.",
        "Free remains useful; Pro is for sharper operating judgment and more reliable execution."
      ],
      finalTitle: "If SoloMap already helps you reopen a project without losing the thread, Pro is the next step.",
      finalLead: "Join early, lock in the first annual price, and help shape the operating cockpit you will use to make better project bets.",
      metaKeywords: "solomap pro, strategy cockpit, solo founder strategy, portfolio management, indie hacker monetization, pricing model, project priority",
      faqTitle: "Pro Subscription FAQ",
      faqItems: [
        ["Is my code sent to any servers if I subscribe to Pro?", "No. SoloMap Pro remains fully local-first. Your code, project memory, and strategic cockpit configurations never leave your machine."],
        ["How do I activate the Pro features after payment?", "After payment, SoloMap will guide you back to VS Code. If you use another machine later, open this page and get a fresh activation code from the same account."],
        ["Can I use SoloMap Pro on multiple devices?", "Yes. You can authorize up to 5 devices (like your personal laptop and work desktop) with a single subscription."],
        ["What is the refund policy?", "We offer a 14-day refund policy. If SoloMap Pro doesn't help you build and manage your solo projects better, just request a refund and we'll issue it, no questions asked."]
      ]
    };
  }
  return {
    metaTitle: "独道 (SoloMap) Pro - 一人公司的战略驾驶舱",
    metaDescription: "独道 (SoloMap) Pro 帮独立开发者判断哪些项目该加码、暂停或收缩，把多个项目经营成更清晰的一人公司系统。",
    eyebrow: "给独立开发者的 Pro Early Access",
    title: "看清下个月最值得投入的项目。",
    lead: "当你的想法、项目和机会越来越多时，真正稀缺的不是任务列表，而是取舍判断。独道 (SoloMap) Pro 帮你判断该加码什么、暂停什么，以及哪些投入正在形成一人公司的复利。",
    primaryCta: "加入 Pro Early Access",
    recoverCta: "已订阅？取回激活码",
    accountCta: "打开账户页面",
    secondaryCta: "先安装 Free",
    bullets: [
      ["更果断地取舍", "不再平均分配注意力，而是看清哪个项目最值得继续押注。"],
      ["避免昂贵漂移", "及时发现哪些项目只是在消耗时间，却没有带来触达、学习、收入或能力积累。"],
      ["经营复利组合", "把产品、分发、学习、能力杠杆和收入结构放到同一个判断面里。"]
    ],
    offerLabel: "Early Access",
    price: "$29",
    priceSuffix: "/ 年",
    offerCopy: "用首批价格解锁一人公司驾驶舱，并参与塑造独道 (SoloMap) Pro 的后续能力。",
    offerNote: "Free 保留项目推进主路径。Pro 解锁面向认真独立开发者的经营判断。",
    previewTitle: "现在 Pro 解锁什么",
    previewLead: "首个付费验收石是战略金字塔：它不是任务看板，而是一人公司的战略驾驶舱。",
    pyramid: [
      ["自由与品牌", "你是否在获得更多选择权？"],
      ["可复利收入", "收入来源是否更健康？"],
      ["市场信誉", "发现渠道和反馈是否在变强？"],
      ["能力复利", "哪些能力正在跨项目产生回报？"],
      ["战略库存", "未来 30 天该把时间押在哪里？"]
    ],
    comparisonTitle: "Free 与 Pro 的区别",
    comparisonLead: "Free 让你形成独道 (SoloMap) 使用习惯；Pro 面向已经需要跨项目经营判断的人。",
    planHeader: ["能力", "Free", "Pro Early Access"],
    plans: [
      ["项目推进", "单项目路线图、今日安排、基础推进历史。", "包含 Free 全部能力，并增加一人公司层面的项目组合上下文。"],
      ["战略视图", "知道一个项目里下一步该做什么。", "判断项目、能力、市场信誉和收入结构是否彼此增强。"],
      ["判断可信度", "知道最近一次推进是否让项目往前走。", "看清哪里进展真实、哪里判断还薄弱，以及下一轮应该集中推进什么。"],
      ["组合决策", "手动切换项目，查看本地项目摘要。", "项目取舍判断、项目组合健康度、能力复利和结构性风险信号。"],
      ["路线图共创", "使用公开 Free 主路径并提交反馈。", "参与塑造 Pro 路线图，同时锁定 Early Access 价格。"]
    ],
    roadmapTitle: "Pro 接下来会长成什么",
    roadmapLead: "先解锁战略驾驶舱，随后获得更清楚的推进历史 and 更少的手工重启成本。", // 等等，view_file 1063 行是 "并获得更清楚..."
    roadmap: [
        ["已优先开放", "战略金字塔", "面向一人公司的经营驾驶舱，覆盖项目组合、能力复利、市场信誉和战略取舍。"],
        ["下一根支柱", "可靠推进历史", "让你更容易看懂项目哪里真的变好了，哪里还会继续制造返工。"],
        ["旗舰方向", "目标自动推进", "给独道 (SoloMap) 一个具体结果，让它减少手工重启和反复追问，把工作持续推向完成。"]
    ],
    trustTitle: "仍然本地优先。",
    trustCopy: "你的项目计划、推进历史和本地经验仍留在工作区。Pro 只解锁付费产品能力。",
    trustItems: [
      "核心工作流不需要托管的独道 (SoloMap) 项目数据库。",
      "你继续使用自己信任的工具和本地工作区。",
      "Free 仍然可用；Pro 解决更清晰的经营判断和更可靠的执行。"
    ],
    finalTitle: "如果独道 (SoloMap) 已经帮你重新打开项目时不丢线索，Pro 就是下一步。",
    finalLead: "现在加入，锁定首批年付价格，并参与塑造你未来每天都会用来做项目取舍的经营驾驶舱。",
    metaKeywords: "独道, SoloMap Pro, 战略驾驶舱, 一人公司, 独立开发变现, 订阅价格, 项目取舍, 多项目管理, 独立变现",
    faqTitle: "Pro 订阅常见问题",
    faqItems: [
      ["订阅 Pro 后，我的代码会被上传到服务器吗？", "不会。独道 (SoloMap) Pro 依然遵循绝对的本地优先原则。你的代码、项目记忆和战略驾驶舱数据仅保留在你的本地，绝不会上传。"],
      ["付款后如何激活 Pro 权益？", "付款成功后，网页会引导你回到 VS Code 完成激活。之后换电脑时，也可以回到这个页面，用同一个账户取回新的激活码。"],
      ["我可以在多台设备上使用同一个订阅吗？", "可以。单个订阅支持激活最多 5 台你个人拥有的工作设备（如日常笔记本和工作台式机）。"],
      ["有退款保证吗？", "有的。我们提供 14 天退款承诺。如果独道 (SoloMap) Pro 没有达到你的预期，你可以随时申请全额退款。"]
    ]
  };
}

function renderProBullets(items) {
  return items.map(([title, copy]) => `<article class="pro-bullet">
            <strong>${escapeHtml(title)}</strong>
            <p>${escapeHtml(copy)}</p>
          </article>`).join("");
}

function renderPyramidLayers(items) {
  return items.map(([title, copy]) => `<div class="pyramid-layer">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(copy)}</span>
          </div>`).join("");
}

function renderPlanRows(copy) {
  const header = `<div class="plan-row plan-head">
          <div>${escapeHtml(copy.planHeader[0])}</div>
          <div>${escapeHtml(copy.planHeader[1])}</div>
          <div>${escapeHtml(copy.planHeader[2])}</div>
        </div>`;
  const rows = copy.plans.map(([name, free, pro]) => `<div class="plan-row">
          <div><strong>${escapeHtml(name)}</strong></div>
          <div><p>${escapeHtml(free)}</p></div>
          <div><p>${escapeHtml(pro)}</p></div>
        </div>`).join("");
  return `${header}${rows}`;
}

function renderProRoadmap(items) {
  return items.map(([phase, title, copy], index) => `<article class="timeline-item${index === 0 ? " current" : ""}">
            <span class="pro-offer-label">${escapeHtml(phase)}</span>
            <strong>${escapeHtml(title)}</strong>
            <p>${escapeHtml(copy)}</p>
          </article>`).join("");
}

async function buildProSubscriptionPage(request, env) {
  const url = new URL(request.url);
  const origin = env.SITE_ORIGIN || url.origin;
  const locale = url.pathname.startsWith("/zh") ? "zh" : "en";
  const t = content[locale];
  const copy = getProPageCopy(locale);
  const pagePath = locale === "zh" ? "/zh/pro" : "/pro";
  const alternatePath = locale === "zh" ? "/pro" : "/zh/pro";
  const mode = normalizeAuthMode(url.searchParams.get("mode"));
  const callback = String(url.searchParams.get("callback") || "").trim();
  const authNonce = normalizeAuthNonce(url.searchParams.get("auth_nonce"));
  let upgradeState = "";
  try {
    upgradeState = await createUpgradeState(env, {
      mode,
      callback,
      authNonce,
      source: url.searchParams.get("source") || "web"
    });
  } catch (_error) {
    upgradeState = "";
  }
  const ctaHref = upgradeState
    ? `/api/passport/start?upgrade_state=${encodeURIComponent(upgradeState)}`
    : "/api/passport/recover?intent=checkout";
  const recoverHref = upgradeState
    ? `/api/passport/start?upgrade_state=${encodeURIComponent(upgradeState)}`
    : "/api/passport/recover?intent=recover";
  const accountHref = getPassportAccountUrl(env);
  const installHref = `${t.homePath}#install`;
  return `<!doctype html>
<html lang="${t.lang}">
<head>
  ${buildHead(
    { ...t, meta: { ...t.meta, title: copy.metaTitle, description: copy.metaDescription, ogDescription: copy.metaDescription, keywords: copy.metaKeywords } },
    origin,
    pagePath,
    alternatePath
  )}
  ${buildProStructuredData(copy, origin, pagePath)}
  ${buildStyles()}
</head>
<body>
  ${buildHeader(t, locale, pagePath)}
  <main class="pro-page">
    <section class="hero">
      <div class="shell pro-hero-grid">
        <div>
          <div class="eyebrow">${escapeHtml(copy.eyebrow)}</div>
          <h1>${escapeHtml(copy.title)}</h1>
          <p class="pro-hero-copy">${escapeHtml(copy.lead)}</p>
          <div class="cta-row">
            <a class="button primary" href="${escapeHtml(ctaHref)}">${escapeHtml(copy.primaryCta)}</a>
            <a class="button secondary" href="${escapeHtml(recoverHref)}">${escapeHtml(copy.recoverCta)}</a>
            <a class="button ghost" href="${escapeHtml(installHref)}">${escapeHtml(copy.secondaryCta)}</a>
          </div>
          <div class="pro-bullets">
            ${renderProBullets(copy.bullets)}
          </div>
        </div>
        <aside class="pro-offer" aria-label="${escapeHtml(copy.offerLabel)}">
          <span class="pro-offer-label">${escapeHtml(copy.offerLabel)}</span>
          <div class="pro-price">${escapeHtml(copy.price)} <span>${escapeHtml(copy.priceSuffix)}</span></div>
          <p>${escapeHtml(copy.offerCopy)}</p>
          <a class="button primary" href="${escapeHtml(ctaHref)}">${escapeHtml(copy.primaryCta)}</a>
          <a class="button ghost" href="${escapeHtml(recoverHref)}">${escapeHtml(copy.recoverCta)}</a>
          <span class="pro-note">${escapeHtml(copy.offerNote)}</span>
        </aside>
      </div>
    </section>

    <section class="section">
      <div class="shell answer-block">
        <div class="pro-preview">
          <h2>${escapeHtml(copy.previewTitle)}</h2>
          <p class="pro-hero-copy">${escapeHtml(copy.previewLead)}</p>
        </div>
        <div class="pyramid-stack" aria-label="${escapeHtml(copy.previewTitle)}">
          ${renderPyramidLayers(copy.pyramid)}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell">
        <div class="section-head">
          <h2>${escapeHtml(copy.comparisonTitle)}</h2>
          <p>${escapeHtml(copy.comparisonLead)}</p>
        </div>
        <div class="plan-table">
          ${renderPlanRows(copy)}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell">
        <div class="section-head">
          <h2>${escapeHtml(copy.roadmapTitle)}</h2>
          <p>${escapeHtml(copy.roadmapLead)}</p>
        </div>
        <div class="pro-roadmap">
          ${renderProRoadmap(copy.roadmap)}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell pro-trust">
        <div class="pro-trust-panel">
          <h2>${escapeHtml(copy.trustTitle)}</h2>
          <p>${escapeHtml(copy.trustCopy)}</p>
        </div>
        <div class="trust-list">
          ${renderListItems(copy.trustItems, "div")}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell">
        <div class="section-head" style="display:block;margin-bottom:22px">
          <h2>${escapeHtml(copy.faqTitle)}</h2>
        </div>
        <div class="faq-list">
          ${renderFaqItems(copy.faqItems)}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell pro-final">
        <div>
          <h2>${escapeHtml(copy.finalTitle)}</h2>
          <p class="pro-hero-copy">${escapeHtml(copy.finalLead)}</p>
        </div>
        <div>
          <a class="button primary" href="${escapeHtml(ctaHref)}">${escapeHtml(copy.primaryCta)}</a>
          <a class="button ghost" href="${escapeHtml(accountHref)}">${escapeHtml(copy.accountCta)}</a>
        </div>
      </div>
    </section>
  </main>
  ${buildFooter(t)}
</body>
</html>`;
}

function buildPassportCheckoutPendingPage(requestUrl) {
  const retryUrl = escapeHtml(requestUrl.toString());
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5;url=${retryUrl}">
  <title>SoloMap Pro 正在确认</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #11100e; color: #f6f0e8; }
    main { width: min(680px, calc(100vw - 32px)); }
    h1 { font-size: 30px; margin: 0 0 12px; }
    p { color: #ded4c8; line-height: 1.6; }
    a { color: #fde68a; }
  </style>
</head>
<body>
  <main>
    <h1>正在确认 SoloMap Pro</h1>
    <p>付款已经返回，订阅状态正在同步。页面会自动刷新；确认完成后会显示授权码或回到插件。</p>
    <p><a href="${retryUrl}">立即重新检查</a></p>
  </main>
</body>
</html>`;
}

async function createPassportCheckoutRedirect(request, env, state, userinfo, access) {
  const requestUrl = new URL(request.url);
  const checkoutUrl = env.SOLOMAP_PASSPORT_CHECKOUT_URL || PASSPORT_CHECKOUT_LINK_URL;
  const successUrl = await getPassportCheckoutSuccessUrl(env, requestUrl, state, {
    email: String(access.email || userinfo.email || "").trim(),
    userId: String(access.userId || userinfo.sub || userinfo.userId || "").trim()
  });
  const cancelUrl = `${requestUrl.origin}/#pro`;
  const customerEmail = String(access.email || userinfo.email || "").trim();
  const userId = String(access.userId || userinfo.sub || userinfo.userId || "").trim();
  const response = await fetch(checkoutUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-szlk-product": SOLOMAP_PRODUCT,
      "x-szlk-secret": env.SOLOMAP_PASSPORT_PRODUCT_SECRET || ""
    },
    body: JSON.stringify({
      product: SOLOMAP_PRODUCT,
      planId: getProPlanId(env),
      successUrl,
      cancelUrl,
      customerEmail,
      userId,
      clientReferenceId: userId || customerEmail,
      metadata: {
        feature: STRATEGY_PYRAMID_FEATURE,
        source: "solomap_pro_upgrade",
        deviceLimit: getProDeviceLimit(env),
        maxDevices: getProDeviceLimit(env)
      }
    })
  });
  const body = await response.json().catch(() => ({}));
  const data = body && typeof body === "object" && body.ok === true && body.data ? body.data : body;
  const redirectUrl = data?.checkout?.url || data?.url || data?.checkoutUrl;
  if (!response.ok || !redirectUrl) {
    return htmlResponse(buildPassportUpgradeUnavailablePage(), 502);
  }
  return Response.redirect(String(redirectUrl), 302);
}

async function handlePassportCheckoutSuccess(request, env) {
  const url = new URL(request.url);
  const state = await verifyState(env, String(url.searchParams.get("state") || ""));
  if (!state || (state.mode !== "device" && !isAllowedVsCodeCallback(state.callback))) {
    return htmlResponse(buildPassportFallbackPage(""), 400);
  }
  const userinfo = {
    email: String(state.email || ""),
    sub: String(state.userId || ""),
    userId: String(state.userId || "")
  };
  const access = await checkPassportAccessForUser(env, userinfo);
  if (!access.allowed) {
    return htmlResponse(buildPassportCheckoutPendingPage(url), 200);
  }
  const grant = await issueSoloMapGrant(env, String(access.email || userinfo.email || "pro@solomap.app"), {
    userId: String(access.userId || userinfo.sub || ""),
    entitlements: Array.isArray(access.entitlements) && access.entitlements.length ? access.entitlements : [STRATEGY_PYRAMID_FEATURE, "solomap_pro"]
  });
  const exchangeCode = state.authNonce ? await issueSoloMapExchangeCode(env, grant, state) : grant;
  if (state.mode === "device") {
    return htmlResponse(buildDeviceGrantPage(exchangeCode, {
      email: access.email || userinfo.email,
      deviceLimit: getProDeviceLimit(env),
      accountUrl: getPassportAccountUrl(env)
    }), 200);
  }
  const callbackUrl = new URL(state.callback);
  callbackUrl.searchParams.set(state.authNonce ? "code" : "grant", exchangeCode);
  return Response.redirect(callbackUrl.toString(), 302);
}

async function handlePassportRecover(request, env) {
  const url = new URL(request.url);
  const deviceCode = await createDeviceCode(env, {
    intent: url.searchParams.get("intent") || "recover"
  });
  return Response.redirect(getDeviceAuthorizeUrl(url, deviceCode), 302);
}

async function buildPassportAuthorizeRedirect(request, env, payload) {
  const url = new URL(request.url);
  const verifier = randomString(48);
  const challenge = base64UrlEncode(await sha256(verifier));
  const state = await signState(env, {
    ...payload,
    verifier,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  });
  const authorizeUrl = new URL(env.SOLOMAP_PASSPORT_AUTH_URL || PASSPORT_OIDC_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", env.SOLOMAP_PASSPORT_OIDC_CLIENT_ID || SOLOMAP_OIDC_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", `${url.origin}/api/passport/oidc/callback`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid profile email offline_access");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  return Response.redirect(authorizeUrl.toString(), 302);
}

async function handlePassportStart(request, env) {
  const url = new URL(request.url);
  const upgradeState = String(url.searchParams.get("upgrade_state") || "").trim();
  if (upgradeState) {
    const state = await verifyState(env, upgradeState);
    if (!state || state.product !== SOLOMAP_PRODUCT || state.feature !== STRATEGY_PYRAMID_FEATURE || !normalizeAuthNonce(state.authNonce)) {
      return jsonResponse({ ok: false, reason: "invalid_upgrade_state" }, 400);
    }
    if (state.mode !== "device" && !isAllowedVsCodeCallback(state.callback)) {
      return jsonResponse({ ok: false, reason: "invalid_callback" }, 400);
    }
    return buildPassportAuthorizeRedirect(request, env, state);
  }
  const callback = String(url.searchParams.get("callback") || "");
  if (callback && !isAllowedVsCodeCallback(callback)) {
    return jsonResponse({ ok: false, reason: "invalid_callback" }, 400);
  }
  if (callback && env.SOLOMAP_PASSPORT_DEV_GRANTS === "1") {
    const grant = await issueSoloMapGrant(env, String(url.searchParams.get("email") || "pro-test@solomap.app"));
    const callbackUrl = new URL(callback);
    callbackUrl.searchParams.set("grant", grant);
    return Response.redirect(callbackUrl.toString(), 302);
  }
  if (callback) {
    return buildPassportAuthorizeRedirect(request, env, { mode: "callback", callback });
  }
  if (env.SOLOMAP_PASSPORT_AUTH_URL) {
    const authUrl = new URL(env.SOLOMAP_PASSPORT_AUTH_URL);
    authUrl.searchParams.set("product", SOLOMAP_PRODUCT);
    authUrl.searchParams.set("feature", STRATEGY_PYRAMID_FEATURE);
    if (callback) authUrl.searchParams.set("callback", callback);
    return Response.redirect(authUrl.toString(), 302);
  }
  return htmlResponse(buildPassportFallbackPage(callback), 200);
}

async function handlePassportDeviceStart(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, reason: "method_not_allowed" }, 405);
  }
  const url = new URL(request.url);
  let payload = {};
  try {
    payload = await request.json();
  } catch (error) {
    payload = {};
  }
  const deviceCode = await createDeviceCode(env, { authNonce: payload.authNonce || payload.auth_nonce });
  return jsonResponse({
    ok: true,
    deviceCode,
    loginUrl: getDeviceAuthorizeUrl(url, deviceCode),
    expiresIn: 1800
  });
}

async function handlePassportDeviceAuthorize(request, env) {
  const url = new URL(request.url);
  const deviceCode = String(url.searchParams.get("device") || "");
  const device = await verifyState(env, deviceCode);
  if (!device || device.mode !== "device") {
    return htmlResponse(buildPassportFallbackPage(""), 400);
  }
  return buildPassportAuthorizeRedirect(request, env, {
    mode: "device",
    deviceCode,
    authNonce: device.authNonce || ""
  });
}

async function handlePassportOidcCallback(request, env) {
  const url = new URL(request.url);
  const code = String(url.searchParams.get("code") || "");
  const state = await verifyState(env, String(url.searchParams.get("state") || ""));
  if (!code || !state) {
    return htmlResponse(buildPassportFallbackPage(""), 400);
  }
  if (state.mode !== "device" && !isAllowedVsCodeCallback(state.callback)) {
    return htmlResponse(buildPassportFallbackPage(""), 400);
  }
  const tokenResponse = await fetch(env.SOLOMAP_PASSPORT_TOKEN_URL || PASSPORT_OIDC_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.SOLOMAP_PASSPORT_OIDC_CLIENT_ID || SOLOMAP_OIDC_CLIENT_ID,
      code,
      redirect_uri: `${url.origin}/api/passport/oidc/callback`,
      code_verifier: state.verifier
    }).toString()
  });
  if (!tokenResponse.ok) {
    return htmlResponse(buildPassportFallbackPage(""), 401);
  }
  const token = await tokenResponse.json();
  const userinfoResponse = await fetch(env.SOLOMAP_PASSPORT_USERINFO_URL || PASSPORT_OIDC_USERINFO_URL, {
    headers: { authorization: `Bearer ${token.access_token || ""}` }
  });
  if (!userinfoResponse.ok) {
    return htmlResponse(buildPassportFallbackPage(""), 401);
  }
  const userinfo = await userinfoResponse.json();
  const access = await checkPassportAccessForUser(env, userinfo);
  if (!access.allowed) {
    return createPassportCheckoutRedirect(request, env, state, userinfo, access);
  }
  const grant = await issueSoloMapGrant(env, String(access.email || userinfo.email || "pro@solomap.app"), {
    userId: String(access.userId || userinfo.sub || ""),
    entitlements: Array.isArray(access.entitlements) && access.entitlements.length ? access.entitlements : [STRATEGY_PYRAMID_FEATURE, "solomap_pro"]
  });
  const exchangeCode = state.authNonce ? await issueSoloMapExchangeCode(env, grant, state) : grant;
  if (state.mode === "device") {
    return htmlResponse(buildDeviceGrantPage(exchangeCode, {
      email: access.email || userinfo.email,
      deviceLimit: getProDeviceLimit(env),
      accountUrl: getPassportAccountUrl(env)
    }), 200);
  }
  const callbackUrl = new URL(state.callback);
  callbackUrl.searchParams.set(state.authNonce ? "code" : "grant", exchangeCode);
  return Response.redirect(callbackUrl.toString(), 302);
}

async function handlePassportDeviceVerify(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ allowed: false, reason: "method_not_allowed" }, 405);
  }
  let payload = {};
  try {
    payload = await request.json();
  } catch (error) {
    return jsonResponse({ allowed: false, reason: "invalid_json" }, 400);
  }
  const device = await verifyState(env, String(payload.deviceCode || ""));
  if (!device || device.mode !== "device") {
    return jsonResponse({ allowed: false, reason: "invalid_device_code" }, 400);
  }
  const grant = String(payload.code || payload.grant || "").trim();
  if (!grant) {
    return jsonResponse({ allowed: false, reason: "missing_code" }, 400);
  }
  const exchanged = await verifySoloMapExchangeCode(env, grant, {
    authNonce: payload.authNonce || payload.auth_nonce || device.authNonce || "",
    deviceCode: payload.deviceCode || payload.device_code || ""
  });
  if (exchanged) {
    return jsonResponse(exchanged);
  }
  const accountExchange = await verifyCollaborationAccountExchangeCode(env, grant, {
    authNonce: payload.authNonce || payload.auth_nonce || "",
    callback: payload.callback || ""
  });
  if (accountExchange) return jsonResponse(accountExchange);
  return jsonResponse(await verifySignedGrant(env, grant));
}

async function handlePassportVerify(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: apiHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ allowed: false, reason: "method_not_allowed" }, 405);
  }
  let payload = {};
  try {
    payload = await request.json();
  } catch (error) {
    return jsonResponse({ allowed: false, reason: "invalid_json" }, 400);
  }
  const grant = String(payload.code || payload.grant || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "");
  if (!grant) {
    return jsonResponse({ allowed: false, reason: "missing_grant" }, 400);
  }
  const exchanged = await verifySoloMapExchangeCode(env, grant, {
    authNonce: payload.authNonce || payload.auth_nonce || "",
    callback: payload.callback || "",
    deviceCode: payload.deviceCode || payload.device_code || ""
  });
  if (exchanged) {
    return jsonResponse(exchanged);
  }
  const accountExchange = await verifyCollaborationAccountExchangeCode(env, grant, {
    authNonce: payload.authNonce || payload.auth_nonce || "",
    callback: payload.callback || ""
  });
  if (accountExchange) return jsonResponse(accountExchange);
  const signedGrant = await verifySignedGrant(env, grant);
  if (signedGrant.authenticated) return jsonResponse(signedGrant);
  const passportResult = await verifyGrantWithPassport(env, grant);
  if (passportResult) {
    return jsonResponse(passportResult);
  }
  return jsonResponse(signedGrant);
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
  ${t.meta.keywords ? `<meta name="keywords" content="${escapeHtml(t.meta.keywords)}">` : ""}
  <link rel="icon" href="${LOGO_URL}">
  <link rel="canonical" href="${absoluteUrl(pagePath, origin)}">
  <link rel="alternate" hreflang="en" href="${absoluteUrl(englishPathFor(pagePath), origin)}">
  <link rel="alternate" hreflang="zh-Hans" href="${absoluteUrl(chinesePathFor(pagePath), origin)}">
  <link rel="alternate" hreflang="zh-CN" href="${absoluteUrl(chinesePathFor(pagePath), origin)}">
  <link rel="alternate" hreflang="zh-TW" href="${absoluteUrl(chinesePathFor(pagePath), origin)}">
  <link rel="alternate" hreflang="zh-HK" href="${absoluteUrl(chinesePathFor(pagePath), origin)}">
  <link rel="alternate" hreflang="x-default" href="${absoluteUrl(englishPathFor(pagePath), origin)}">
  <meta property="og:title" content="${escapeHtml(t.meta.title)}">
  <meta property="og:description" content="${escapeHtml(t.meta.ogDescription)}">
  <meta property="og:image" content="${SCREENSHOT_URL}">
  <meta property="og:url" content="${absoluteUrl(pagePath, origin)}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(t.meta.title)}">
  <meta name="twitter:description" content="${escapeHtml(t.meta.description)}">`;
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
      --fg: var(--ink);
      --accent: var(--cyan);
      --accent-purple: #a99cff;
      --success: var(--green);
      --danger: #ff6b78;
      --border: var(--line);
      --glass-bg: rgba(26, 23, 20, 0.9);
      --font: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(222, 212, 200, 0.28) transparent;
    }
    *::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    *::-webkit-scrollbar-track {
      background: transparent;
    }
    *::-webkit-scrollbar-thumb {
      border: 2px solid transparent;
      border-radius: 999px;
      background: rgba(222, 212, 200, 0.26);
      background-clip: content-box;
    }
    *::-webkit-scrollbar-thumb:hover {
      background: rgba(222, 212, 200, 0.42);
      background-clip: content-box;
    }
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
      background: rgba(17, 16, 14, 0.8);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.15);
    }
    .nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 72px;
      gap: 20px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      font-weight: 760;
      letter-spacing: 0;
      transition: opacity 0.2s ease;
    }
    .brand:hover {
      opacity: 0.9;
    }
    .brand img {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      box-shadow: 0 0 15px rgba(73, 214, 208, 0.2);
    }
    .links {
      display: flex;
      align-items: center;
      gap: 24px;
      color: var(--soft);
      font-size: 14px;
    }
    .links a {
      position: relative;
      padding: 6px 0;
      transition: color 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .links a::after {
      content: '';
      position: absolute;
      width: 100%;
      transform: scaleX(0);
      height: 2px;
      bottom: 0;
      left: 0;
      background: linear-gradient(90deg, var(--cyan), var(--red));
      transform-origin: bottom right;
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .links a:hover {
      color: var(--ink);
    }
    .links a:hover::after {
      transform: scaleX(1);
      transform-origin: bottom left;
    }
    .links a.install-link::after,
    .links a.language-link::after {
      display: none;
    }
    .language-link {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 12px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
      background: rgba(255, 255, 255, 0.02);
      white-space: nowrap;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .language-link:hover {
      border-color: var(--cyan);
      background: rgba(73, 214, 208, 0.05);
      color: var(--cyan) !important;
    }
    .install-link {
      color: #11100e !important;
      background: linear-gradient(135deg, var(--soft) 0%, var(--ink) 100%);
      padding: 9px 16px;
      border-radius: 8px;
      font-weight: 720;
      box-shadow: 0 4px 14px rgba(246, 240, 232, 0.15);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
      white-space: nowrap;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .install-link:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(246, 240, 232, 0.25);
    }
    .hero {
      min-height: calc(100vh - 72px);
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
    
    /* --- CSS Agent Loop Simulator --- */
    .product-preview {
      width: 100%;
      max-width: 100%;
      margin: 0;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #0b0d0f;
      box-shadow: 0 28px 80px var(--shadow), 0 0 40px rgba(73, 214, 208, 0.03);
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
      padding: 24px;
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .roadmap-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .roadmap-step {
      min-width: 0;
      min-height: 118px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 12px;
      background: #141311;
      position: relative;
      overflow: hidden;
      transition: all 0.5s ease;
    }
    .roadmap-step::after {
      content: "";
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 12px;
      height: 4px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      transition: all 0.5s ease;
    }

    /* Steps Animation Assigning */
    .step-build {
      animation: stepBuildAnim 18s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    .step-sell {
      animation: stepSellAnim 18s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    .step-learn {
      animation: stepLearnAnim 18s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    .step-improve {
      animation: stepImproveAnim 18s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }

    @keyframes stepBuildAnim {
      0%, 30% { /* Active */
        border-color: rgba(239, 62, 70, 0.8);
        background: rgba(239, 62, 70, 0.08);
        box-shadow: 0 0 20px rgba(239, 62, 70, 0.15);
      }
      33.3%, 96.6% { /* Done */
        border-color: rgba(165, 214, 109, 0.5);
        background: rgba(165, 214, 109, 0.04);
        box-shadow: none;
      }
      97% , 100% { /* Normal */
        border-color: rgba(255, 255, 255, 0.1);
        background: #141311;
        box-shadow: none;
      }
    }
    .step-build::after {
      animation: stepBuildAfterAnim 18s ease infinite;
    }
    @keyframes stepBuildAfterAnim {
      0%, 30% { background: var(--red); width: calc(100% - 24px); }
      33.3%, 96.6% { background: var(--green); width: calc(100% - 24px); }
      97%, 100% { background: rgba(255, 255, 255, 0.08); width: calc(100% - 24px); }
    }

    @keyframes stepSellAnim {
      0%, 30% { /* Normal */
        border-color: rgba(255, 255, 255, 0.1);
        background: #141311;
        box-shadow: none;
      }
      33.3%, 63.3% { /* Active */
        border-color: rgba(73, 214, 208, 0.8);
        background: rgba(73, 214, 208, 0.08);
        box-shadow: 0 0 20px rgba(73, 214, 208, 0.15);
      }
      66.6%, 96.6% { /* Done */
        border-color: rgba(165, 214, 109, 0.5);
        background: rgba(165, 214, 109, 0.04);
        box-shadow: none;
      }
      97%, 100% { /* Normal */
        border-color: rgba(255, 255, 255, 0.1);
        background: #141311;
        box-shadow: none;
      }
    }
    .step-sell::after {
      animation: stepSellAfterAnim 18s ease infinite;
    }
    @keyframes stepSellAfterAnim {
      0%, 30% { background: rgba(255, 255, 255, 0.08); }
      33.3%, 63.3% { background: var(--cyan); }
      66.6%, 96.6% { background: var(--green); }
      97%, 100% { background: rgba(255, 255, 255, 0.08); }
    }

    @keyframes stepLearnAnim {
      0%, 63.3% { /* Normal */
        border-color: rgba(255, 255, 255, 0.1);
        background: #141311;
        box-shadow: none;
      }
      66.6%, 96.6% { /* Active */
        border-color: rgba(165, 214, 109, 0.8);
        background: rgba(165, 214, 109, 0.08);
        box-shadow: 0 0 20px rgba(165, 214, 109, 0.15);
      }
      97%, 100% { /* Normal */
        border-color: rgba(255, 255, 255, 0.1);
        background: #141311;
        box-shadow: none;
      }
    }
    .step-learn::after {
      animation: stepLearnAfterAnim 18s ease infinite;
    }
    @keyframes stepLearnAfterAnim {
      0%, 63.3% { background: rgba(255, 255, 255, 0.08); }
      66.6%, 96.6% { background: var(--green); }
      97%, 100% { background: rgba(255, 255, 255, 0.08); }
    }

    @keyframes stepImproveAnim {
      0%, 63.3% { /* Normal */
        border-color: rgba(255, 255, 255, 0.1);
        background: #141311;
        box-shadow: none;
      }
      66.6%, 96.6% { /* Active */
        border-color: rgba(239, 62, 70, 0.8);
        background: rgba(239, 62, 70, 0.08);
        box-shadow: 0 0 20px rgba(239, 62, 70, 0.15);
      }
      97%, 100% { /* Normal */
        border-color: rgba(255, 255, 255, 0.1);
        background: #141311;
        box-shadow: none;
      }
    }
    .step-improve::after {
      animation: stepImproveAfterAnim 18s ease infinite;
    }
    @keyframes stepImproveAfterAnim {
      0%, 63.3% { background: rgba(255, 255, 255, 0.08); }
      66.6%, 96.6% { background: var(--red); }
      97%, 100% { background: rgba(255, 255, 255, 0.08); }
    }

    /* Terminal content phase-toggle animation */
    .terminal {
      border: 1px solid rgba(73, 214, 208, 0.2);
      border-radius: 8px;
      background: #07090b;
      padding: 16px;
      min-height: 188px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: #b8c7d9;
      position: relative;
      overflow: hidden;
    }
    .terminal-group {
      position: absolute;
      top: 16px;
      left: 16px;
      right: 16px;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.5s ease;
      pointer-events: none;
    }
    .terminal-group.phase-1 {
      animation: termPhase1Anim 18s ease infinite;
    }
    .terminal-group.phase-2 {
      animation: termPhase2Anim 18s ease infinite;
    }
    .terminal-group.phase-3 {
      animation: termPhase3Anim 18s ease infinite;
    }

    @keyframes termPhase1Anim {
      0%, 30% { opacity: 1; transform: translateY(0); pointer-events: auto; }
      33.3%, 100% { opacity: 0; transform: translateY(-10px); pointer-events: none; }
    }
    @keyframes termPhase2Anim {
      0%, 30% { opacity: 0; transform: translateY(10px); pointer-events: none; }
      33.3%, 63.3% { opacity: 1; transform: translateY(0); pointer-events: auto; }
      66.6%, 100% { opacity: 0; transform: translateY(-10px); pointer-events: none; }
    }
    @keyframes termPhase3Anim {
      0%, 63.3% { opacity: 0; transform: translateY(10px); pointer-events: none; }
      66.6%, 96.6% { opacity: 1; transform: translateY(0); pointer-events: auto; }
      97%, 100% { opacity: 0; transform: translateY(-10px); pointer-events: none; }
    }

    .terminal-line {
      display: block;
      margin-top: 8px;
      opacity: 0;
      transform: translateX(-4px);
    }
    
    .phase-1 .terminal-line:nth-child(2) { animation: lineAppear 18s ease infinite; animation-delay: 0.5s; }
    .phase-1 .terminal-line:nth-child(3) { animation: lineAppear 18s ease infinite; animation-delay: 1.5s; }
    .phase-1 .terminal-line:nth-child(4) { animation: lineAppear 18s ease infinite; animation-delay: 2.5s; }
    .phase-1 .terminal-line:nth-child(5) { animation: lineAppear 18s ease infinite; animation-delay: 3.5s; }

    .phase-2 .terminal-line:nth-child(2) { animation: lineAppear 18s ease infinite; animation-delay: 6.5s; }
    .phase-2 .terminal-line:nth-child(3) { animation: lineAppear 18s ease infinite; animation-delay: 7.5s; }
    .phase-2 .terminal-line:nth-child(4) { animation: lineAppear 18s ease infinite; animation-delay: 8.5s; }
    .phase-2 .terminal-line:nth-child(5) { animation: lineAppear 18s ease infinite; animation-delay: 9.5s; }

    .phase-3 .terminal-line:nth-child(2) { animation: lineAppear 18s ease infinite; animation-delay: 12.5s; }
    .phase-3 .terminal-line:nth-child(3) { animation: lineAppear 18s ease infinite; animation-delay: 13.5s; }
    .phase-3 .terminal-line:nth-child(4) { animation: lineAppear 18s ease infinite; animation-delay: 14.5s; }
    .phase-3 .terminal-line:nth-child(5) { animation: lineAppear 18s ease infinite; animation-delay: 15.5s; }

    @keyframes lineAppear {
      0% { opacity: 0; transform: translateX(-4px); }
      0.5%, 100% { opacity: 1; transform: translateX(0); }
    }

    .next-actions-container {
      position: relative;
      min-height: 52px;
    }
    .next-actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      opacity: 0;
      transition: all 0.5s ease;
      pointer-events: none;
    }
    .next-actions div {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--soft);
      background: rgba(255, 255, 255, 0.02);
      font-size: 13px;
      text-align: center;
      transition: all 0.3s ease;
    }
    .next-actions.phase-1 { animation: termPhase1Anim 18s ease infinite; }
    .next-actions.phase-2 { animation: termPhase2Anim 18s ease infinite; }
    .next-actions.phase-3 { animation: termPhase3Anim 18s ease infinite; }

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
    .ok { color: var(--green); }
    .warn { color: #f0c46b; }
    .info { color: var(--cyan); }
    
    .trust-badge {
      animation: pulseText 3s ease-in-out infinite;
    }
    @keyframes pulseText {
      0%, 100% { opacity: 0.85; }
      50% { opacity: 1; filter: drop-shadow(0 0 4px rgba(73, 214, 208, 0.4)); }
    }
    @keyframes pulseStep {
      0%, 100% { box-shadow: 0 0 0 rgba(239, 62, 70, 0); }
      50% { box-shadow: 0 0 34px rgba(239, 62, 70, 0.18); }
    }
    @media (prefers-reduced-motion: reduce) {
      .terminal-line,
      .roadmap-step,
      .next-actions,
      .terminal-group {
        animation: none !important;
        opacity: 1 !important;
        transform: none !important;
        position: static !important;
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
      gap: 16px;
    }
    .faq-item {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 20px;
      background: linear-gradient(135deg, var(--panel) 0%, rgba(26, 23, 20, 0.7) 100%);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .faq-item:hover {
      border-color: rgba(73, 214, 208, 0.4);
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
      transform: translateY(-2px);
    }
    .faq-item[open] {
      border-color: rgba(73, 214, 208, 0.6);
      background: linear-gradient(135deg, var(--panel) 0%, rgba(73, 214, 208, 0.05) 100%);
    }
    .faq-item summary {
      cursor: pointer;
      color: var(--ink);
      font-weight: 760;
      font-size: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      user-select: none;
    }
    .faq-item summary::-webkit-details-marker {
      display: none;
    }
    .faq-icon {
      width: 18px;
      height: 18px;
      color: var(--cyan);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      flex-shrink: 0;
    }
    .faq-item[open] .faq-icon {
      transform: rotate(135deg);
      color: var(--red);
    }
    .faq-content {
      overflow: hidden;
    }
    .faq-item p {
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
      animation: faqFadeIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    @keyframes faqFadeIn {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
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
    .pro-page .hero {
      min-height: auto;
      padding: 74px 0 42px;
    }
    .pro-hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 0.62fr) minmax(330px, 0.38fr);
      gap: 28px;
      align-items: start;
    }
    .pro-hero-copy {
      margin: 20px 0 0;
      max-width: 720px;
      color: var(--soft);
      font-size: 20px;
    }
    .pro-bullets {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 26px;
    }
    .pro-bullet {
      min-height: 120px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      background: rgba(255, 255, 255, 0.035);
    }
    .pro-bullet strong,
    .timeline-item strong,
    .plan-row strong {
      display: block;
      margin-bottom: 8px;
      color: var(--ink);
    }
    .pro-bullet p,
    .timeline-item p,
    .plan-row p {
      margin: 0;
      color: var(--muted);
      font-size: 15px;
    }
    .pro-offer {
      border: 1px solid transparent;
      border-radius: 16px;
      padding: 30px;
      background: linear-gradient(#1a1714, #1a1714) padding-box,
                  linear-gradient(135deg, var(--red) 0%, var(--cyan) 100%) border-box;
      position: sticky;
      top: 100px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4), 
                  0 0 30px rgba(239, 62, 70, 0.05);
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
    }
    .pro-offer:hover {
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.5), 
                  0 0 40px rgba(73, 214, 208, 0.1);
      transform: translateY(-2px);
    }
    .pro-offer-label {
      display: inline-flex;
      width: fit-content;
      border: 1px solid rgba(246, 240, 232, 0.22);
      border-radius: 999px;
      padding: 7px 10px;
      color: var(--soft);
      font-size: 13px;
      font-weight: 760;
    }
    .pro-price {
      margin: 12px 0 8px;
      font-size: 52px;
      line-height: 1;
      font-weight: 850;
      letter-spacing: 0;
    }
    .pro-price span {
      font-size: 18px;
      color: var(--muted);
      font-weight: 680;
    }
    .pro-offer p {
      color: var(--soft);
      margin: 0 0 16px;
    }
    .pro-note {
      display: block;
      margin-top: 12px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .pro-preview {
      border: 1px solid rgba(73, 214, 208, 0.34);
      border-radius: 12px;
      padding: 24px;
      background: rgba(73, 214, 208, 0.07);
    }
    .pyramid-stack {
      display: grid;
      gap: 10px;
      margin-top: 20px;
    }
    .pyramid-layer {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 14px 18px;
      background: linear-gradient(90deg, rgba(255, 255, 255, 0.03) 0%, rgba(255, 255, 255, 0.06) 100%);
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }
    .pyramid-layer:hover {
      transform: scale(1.02);
      border-color: var(--cyan);
      box-shadow: 0 8px 24px rgba(73, 214, 208, 0.15);
    }
    .pyramid-layer:nth-child(1) { 
      width: 58%; 
      margin: 0 auto; 
      border-color: rgba(239, 62, 70, 0.6); 
      background: linear-gradient(90deg, rgba(239, 62, 70, 0.05) 0%, rgba(239, 62, 70, 0.15) 100%);
    }
    .pyramid-layer:nth-child(1):hover {
      border-color: var(--red);
      box-shadow: 0 8px 24px rgba(239, 62, 70, 0.25);
    }
    .pyramid-layer:nth-child(2) { width: 70%; margin: 0 auto; }
    .pyramid-layer:nth-child(3) { width: 80%; margin: 0 auto; }
    .pyramid-layer:nth-child(4) { width: 90%; margin: 0 auto; }
    .pyramid-layer:nth-child(5) { width: 100%; }
    .pyramid-layer strong {
      display: block;
      color: var(--ink);
      font-size: 14px;
    }
    .pyramid-layer span {
      display: block;
      color: var(--muted);
      font-size: 13px;
      margin-top: 4px;
    }
    .plan-table {
      display: grid;
      gap: 10px;
    }
    .plan-row {
      display: grid;
      grid-template-columns: 180px minmax(0, 1fr) minmax(0, 1fr);
      gap: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: var(--panel);
    }
    .plan-row > div {
      padding: 16px;
      border-left: 1px solid var(--line);
    }
    .plan-row > div:first-child {
      border-left: 0;
      background: rgba(255, 255, 255, 0.035);
    }
    .plan-head {
      color: var(--ink);
      font-weight: 800;
    }
    .pro-roadmap {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .timeline-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      background: rgba(255, 255, 255, 0.035);
    }
    .timeline-item.current {
      border-color: rgba(165, 214, 109, 0.42);
      background: rgba(165, 214, 109, 0.07);
    }
    .pro-trust {
      display: grid;
      grid-template-columns: minmax(0, 0.5fr) minmax(0, 0.5fr);
      gap: 14px;
      align-items: stretch;
    }
    .pro-trust-panel {
      border: 1px solid rgba(165, 214, 109, 0.34);
      border-radius: 8px;
      padding: 24px;
      background: rgba(165, 214, 109, 0.07);
    }
    .pro-final {
      display: grid;
      grid-template-columns: minmax(0, 0.62fr) minmax(300px, 0.38fr);
      gap: 16px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 28px;
      background: #171411;
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
    
    /* Footer styles */
    footer {
      border-top: 1px solid var(--line);
      padding: 60px 0 40px;
      color: var(--muted);
      font-size: 14px;
      background: linear-gradient(to bottom, #11100e 0%, #0c0b0a 100%);
    }
    .footer-grid {
      display: grid;
      grid-template-columns: 2fr repeat(3, 1fr);
      gap: 48px;
      margin-bottom: 48px;
    }
    .footer-brand {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .footer-brand-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 760;
      color: var(--ink);
      font-size: 18px;
    }
    .footer-brand-title img {
      border-radius: 6px;
      box-shadow: 0 0 10px rgba(73, 214, 208, 0.15);
    }
    .footer-brand-desc {
      font-size: 14px;
      color: var(--muted);
      max-width: 320px;
      line-height: 1.6;
    }
    .footer-col h4 {
      margin: 0 0 20px;
      color: var(--ink);
      font-size: 15px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .footer-col ul {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .footer-col a {
      color: var(--soft);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      display: inline-block;
    }
    .footer-col a:hover {
      color: var(--cyan);
      transform: translateX(4px);
    }
    .footer-bottom {
      border-top: 1px solid var(--line);
      padding-top: 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 13px;
      color: var(--muted);
    }
    .footer-legal-links {
      display: flex;
      gap: 24px;
    }
    .footer-legal-links a {
      transition: color 0.2s ease;
    }
    .footer-legal-links a:hover {
      color: var(--ink);
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
    .privacy-page li { color: var(--soft); font-size: 16px; line-height: 1.6; }
    .privacy-page ul { padding-left: 22px; }
    
    .privacy-article h2 {
      margin-top: 36px;
      margin-bottom: 12px;
      font-size: 20px;
      color: var(--ink);
      border-bottom: 1px solid var(--line);
      padding-bottom: 6px;
    }
    .privacy-article p {
      margin-bottom: 16px;
    }
    
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
      .pro-hero-grid,
      .section-head,
      .trust-band,
      .answer-block,
      .pro,
      .pro-trust,
      .pro-final,
      .install-panel {
        grid-template-columns: 1fr;
      }
      .grid-3,
      .grid-4,
      .docs-grid,
      .docs-body,
      .faq-list,
      .feature-list,
      .pro-bullets,
      .pro-roadmap {
        grid-template-columns: 1fr;
      }
      .pro-offer { position: static; }
      .plan-row { grid-template-columns: 1fr; }
      .plan-row > div,
      .plan-row > div:first-child {
        border-left: 0;
        border-top: 1px solid var(--line);
      }
      .plan-row > div:first-child { border-top: 0; }
      .product-preview { min-height: 520px; }
      .preview-body { grid-template-columns: 1fr; }
      .preview-side { display: none; }
      .footer-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 32px;
      }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 28px, 1160px); }
      .nav { min-height: 64px; gap: 10px; }
      .brand span { font-size: 15px; }
      .links { gap: 8px; }
      .install-link,
      .language-link { min-height: 44px; padding: 8px 10px; }
      h1 { font-size: clamp(38px, 12vw, 44px); line-height: 1.02; }
      .hero-copy { font-size: 17px; }
      .button { width: 100%; }
      .install-actions { grid-template-columns: 1fr; }
      .section { padding: 58px 0; }
      .section-head { margin-bottom: 24px; }
      .card,
      .answer-copy,
      .trust-copy,
      .price,
      .install-panel { padding: 20px; }
      .comparison-table,
      .comparison-table tbody,
      .comparison-table tr,
      .comparison-table th,
      .comparison-table td { display: block; width: 100%; }
      .comparison-table tr { border-top: 1px solid var(--line); }
      .comparison-table tr:first-child { border-top: 0; }
      .comparison-table th,
      .comparison-table td { border-top: 0; padding: 10px 14px; }
      .comparison-table th { padding-top: 14px; }
      .comparison-table td:last-child { padding-bottom: 14px; }
      .product-preview { min-height: 500px; }
      .preview-main { padding: 14px; }
      .roadmap-strip,
      .next-actions { grid-template-columns: 1fr; }
      .roadmap-step { min-height: 86px; }
      .footer-grid { grid-template-columns: 1fr; gap: 28px; }
      footer { padding: 44px 0 28px; }
    }
    @media (max-width: 380px) {
      .brand span { display: none; }
      .brand { flex-shrink: 0; }
    }
    @media (min-width: 1440px) {
      .shell { width: min(1280px, calc(100% - 64px)); }
      h1 { font-size: clamp(52px, 6.5vw, 92px); }
      .hero-copy { font-size: 21px; max-width: 700px; }
      .hero-grid { gap: 64px; }
      .section { padding: 96px 0; }
    }
  </style>`;
}function renderCards(cards) {
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
  return items.map(([question, answer]) => `<details class="faq-item">
            <summary>
              <span>${escapeHtml(question)}</span>
              <svg class="faq-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </summary>
            <div class="faq-content">
              <p>${escapeHtml(answer)}</p>
            </div>
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
        nextBuild: ["编译插件包", "运行66项测试", "发布至应用市场"],
        nextSell: ["更新网站地图", "验证GEO跳转", "索引规范网址"],
        nextLearn: ["收集用户反馈", "衡量Pro转换率", "规划下个产品周期"]
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
        nextBuild: ["Compile extension", "Verify test suite", "Ship to marketplace"],
        nextSell: ["Update sitemap", "Verify GEO redirects", "Index canonical URLs"],
        nextLearn: ["Read user feedback", "Measure conversion rate", "Plan next cycle"]
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
                <div class="roadmap-step step-build"><span>01</span><b>${escapeHtml(labels.build)}</b></div>
                <div class="roadmap-step step-sell"><span>02</span><b>${escapeHtml(labels.sell)}</b></div>
                <div class="roadmap-step step-learn"><span>03</span><b>${escapeHtml(labels.learn)}</b></div>
                <div class="roadmap-step step-improve"><span>04</span><b>${escapeHtml(labels.improve)}</b></div>
              </div>
              <div class="terminal">
                <div class="terminal-group phase-1">
                  <strong>${escapeHtml(labels.terminal)} (Build)</strong>
                  <div class="terminal-line"><span class="info">[intent]</span> build landing page and features</div>
                  <div class="terminal-line"><span class="ok">[action]</span> add premium glassmorphism layout</div>
                  <div class="terminal-line"><span class="ok">[evidence]</span> 66 tests compiled and passing</div>
                  <div class="terminal-line"><span class="warn">[next]</span> publish package to marketplace</div>
                </div>
                <div class="terminal-group phase-2">
                  <strong>${escapeHtml(labels.terminal)} (Sell)</strong>
                  <div class="terminal-line"><span class="info">[intent]</span> index pages and track search keywords</div>
                  <div class="terminal-line"><span class="ok">[action]</span> generate sitemap.xml & format XSLT</div>
                  <div class="terminal-line"><span class="ok">[evidence]</span> googlebot crawling verified (bypass GEO redirects)</div>
                  <div class="terminal-line"><span class="warn">[next]</span> publish terms & privacy policies</div>
                </div>
                <div class="terminal-group phase-3">
                  <strong>${escapeHtml(labels.terminal)} (Learn & Improve)</strong>
                  <div class="terminal-line"><span class="info">[intent]</span> compound solo capabilities</div>
                  <div class="terminal-line"><span class="ok">[action]</span> upgrade portfolio strategy cockpit</div>
                  <div class="terminal-line"><span class="ok">[evidence]</span> user converted to Pro Early Access</div>
                  <div class="terminal-line"><span class="ok">[closed]</span> roadmap step complete</div>
                </div>
              </div>
              <div class="next-actions-container">
                <div class="next-actions phase-1">
                  ${renderListItems(labels.nextBuild, "div")}
                </div>
                <div class="next-actions phase-2">
                  ${renderListItems(labels.nextSell, "div")}
                </div>
                <div class="next-actions phase-3">
                  ${renderListItems(labels.nextLearn, "div")}
                </div>
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

function buildProStructuredData(copy, origin, pagePath) {
  const pageUrl = absoluteUrl(pagePath, origin);
  const product = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "SoloMap Pro Early Access",
    description: copy.metaDescription,
    brand: {
      "@type": "Brand",
      name: "SoloMap"
    },
    url: pageUrl,
    image: SCREENSHOT_URL,
    offers: {
      "@type": "Offer",
      price: "29",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: pageUrl
    }
  };
  const webpage = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: copy.metaTitle,
    description: copy.metaDescription,
    url: pageUrl,
    isPartOf: {
      "@type": "WebSite",
      name: "SoloMap",
      url: origin
    },
    about: {
      "@type": "SoftwareApplication",
      name: "SoloMap",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "VS Code"
    }
  };
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "SoloMap",
        item: origin
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Pro",
        item: pageUrl
      }
    ]
  };
  return `<script type="application/ld+json">${JSON.stringify(product)}</script>
  <script type="application/ld+json">${JSON.stringify(webpage)}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>`;
}

function buildHeader(t, locale, currentPath) {
  const productHref = currentPath === t.homePath ? "#product" : `${t.homePath}#product`;
  const proHref = currentPath === "/pro" || currentPath === "/zh/pro"
    ? currentPath
    : (currentPath === t.homePath ? "#pro" : `${t.homePath}#pro`);
  const installHref = currentPath === t.homePath ? "#install" : `${t.homePath}#install`;
  const brandName = (locale === "zh" || t.lang === "zh-Hans") ? "独道 SoloMap" : "SoloMap";
  return `<header class="topbar">
    <nav class="shell nav" aria-label="Primary">
      <a class="brand" href="${t.homePath}" aria-label="SoloMap home">
        <img src="${LOGO_URL}" width="34" height="34" alt="">
        <span>${brandName}</span>
      </a>
      <div class="links">
        <a href="${productHref}">${escapeHtml(t.nav.product)}</a>
        <a href="${proHref}">${escapeHtml(t.nav.pro)}</a>
        <a href="${t.docsPath}">${escapeHtml(t.nav.docs)}</a>
        <a href="${GITHUB_URL}">${escapeHtml(t.nav.github)}</a>
        <a class="language-link" href="${alternatePathFor(currentPath, locale)}?lang=${locale === "en" ? "zh" : "en"}" hreflang="${locale === "en" ? "zh-Hans" : "en"}">${escapeHtml(t.alternateLabel)}</a>
        <a class="install-link" href="${locale === "zh" ? "/zh/workbench" : "/workbench"}">${locale === "zh" ? "工作台" : "Workbench"}</a>
      </div>
    </nav>
  </header>`;
}

function buildFooter(t) {
  const isZh = t.lang === "zh-Hans";
  const desc = isZh 
    ? "给 AI Agent 项目的本地优先路线图与战略驾驶舱。把想法变成路线图，让 Agent 执行，不丢方向。" 
    : "Local-first roadmap and strategy cockpit for AI-built projects. Turn ideas into roadmaps and let agents execute.";
  return `<footer>
    <div class="shell">
      <div class="footer-grid">
        <div class="footer-brand">
          <div class="footer-brand-title">
            <img src="${LOGO_URL}" width="28" height="28" alt="">
            <span>${isZh ? "独道 SoloMap" : "SoloMap"}</span>
          </div>
          <div class="footer-brand-desc">${escapeHtml(desc)}</div>
        </div>
        <div class="footer-col">
          <h4>${isZh ? "产品" : "Product"}</h4>
          <ul>
            <li><a href="${t.homePath}#product">${escapeHtml(t.nav.product)}</a></li>
            <li><a href="${t.pathPrefix}/pro">${escapeHtml(t.nav.pro)}</a></li>
            <li><a href="${t.docsPath}">${escapeHtml(t.nav.docs)}</a></li>
            <li><a href="${t.homePath}#install">${isZh ? "安装插件" : "Install extension"}</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h4>${isZh ? "资源" : "Resources"}</h4>
          <ul>
            <li><a href="${GITHUB_URL}">GitHub</a></li>
            <li><a href="${MARKETPLACE_URL}">VS Code Marketplace</a></li>
            <li><a href="${OPEN_VSX_URL}">Open VSX</a></li>
            <li><a href="${FEEDBACK_URL}">${escapeHtml(t.footer.feedback)}</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h4>${isZh ? "网站地图与导航" : "Sitemap & Docs"}</h4>
          <ul>
            <li><a href="${t.pathPrefix}/sitemap">${isZh ? "网站地图" : "Sitemap"}</a></li>
            <li><a href="${t.docsPath}/solomap-method">${isZh ? "SoloMap 方法" : "SoloMap Method"}</a></li>
            <li><a href="${t.docsPath}/portfolio-method">${isZh ? "项目组合方法" : "Portfolio Method"}</a></li>
            <li><a href="${t.docsPath}/micro-execution-loop">${isZh ? "Agent 执行循环" : "Micro Execution Loop"}</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        <div>
          &copy; 2026 <a href="https://szlk.ai" target="_blank" rel="noopener" style="text-decoration: underline; color: var(--ink);">SZLK LTD</a> 
          ${isZh ? "· 公司编号 16843016 · 英国 伦敦" : " (Company No. 16843016), London, UK"}. All rights reserved.
        </div>
        <div class="footer-legal-links">
          <a href="${t.privacyPath}">${escapeHtml(t.footer.privacy)}</a>
          ${legalRoutes.map((route) => `<a href="${legalPath(route.slug, isZh ? "zh" : "en")}">${escapeHtml(route.label[isZh ? "zh" : "en"])}</a>`).join("")}
          <a href="${legalPath(legalSupplementRoute.slug, isZh ? "zh" : "en")}">${escapeHtml(legalSupplementRoute.label[isZh ? "zh" : "en"])}</a>
        </div>
      </div>
    </div>
  </footer>`;
}
function buildHtmlSitemapPage(locale, origin) {
  const t = content[locale];
  const isZh = locale === "zh";
  const sitemapTitle = isZh ? "SoloMap 网站地图 - 结构化目录" : "SoloMap Sitemap - Structured Site Directory";
  const sitemapHeading = isZh ? "网站地图与结构化目录" : "Site Directory & Structured Sitemap";
  const docsList = Object.entries(docsContent[locale].pages).map(([slug, doc]) => {
    const href = `${t.docsPath}/${slug}`;
    return `<li><a href="${href}"><strong>${escapeHtml(doc.heading)}</strong> - ${escapeHtml(doc.lead)}</a></li>`;
  }).join("");

  return `<!doctype html>
<html lang="${t.lang}">
<head>
  ${buildHead(
    { ...t, meta: { ...t.meta, title: sitemapTitle, description: sitemapTitle } },
    origin,
    `${t.pathPrefix}/sitemap`,
    locale === "zh" ? "/sitemap" : "/zh/sitemap"
  )}
  ${buildStyles()}
</head>
<body>
  ${buildHeader(t, locale, `${t.pathPrefix}/sitemap`)}
  <main class="privacy-page">
    <div class="privacy-nav">
      <a href="${t.homePath}">← ${escapeHtml(t.privacy.back)}</a>
    </div>
    <h1>${escapeHtml(sitemapHeading)}</h1>
    
    <h2>${isZh ? "核心页面" : "Core Pages"}</h2>
    <ul>
      <li><a href="${t.homePath}"><strong>${isZh ? "SoloMap 首页" : "SoloMap Home"}</strong></a></li>
      <li><a href="${t.pathPrefix}/pro"><strong>SoloMap Pro ${isZh ? "订阅页" : "Subscription"}</strong></a></li>
      <li><a href="${t.privacyPath}"><strong>${isZh ? "本地优先说明" : "Local-first Note"}</strong></a></li>
      ${legalRoutes.map((route) => `<li><a href="${legalPath(route.slug, locale)}"><strong>${escapeHtml(route.label[locale])}</strong></a></li>`).join("")}
      <li><a href="${legalPath(legalSupplementRoute.slug, locale)}"><strong>${escapeHtml(legalSupplementRoute.label[locale])}</strong></a></li>
    </ul>

    <h2 style="margin-top: 32px;">${isZh ? "产品指南与文档" : "Product Guides & Documentation"}</h2>
    <ul>
      <li><a href="${t.docsPath}"><strong>${isZh ? "文档中心首页" : "Documentation Center Index"}</strong></a></li>
      ${docsList}
    </ul>
  </main>
  ${buildFooter(t)}
</body>
</html>`;
}

function buildPrivacyPolicyPage(locale, origin) {
  const t = content[locale];
  const isZh = locale === "zh";
  const title = isZh ? "独道 (SoloMap) 隐私政策" : "SoloMap Privacy Policy";
  
  const contentHtml = isZh ? `
    <h1>隐私政策</h1>
    <p>更新日期：2026年6月6日</p>
    <p>我们非常重视您的隐私。本隐私政策适用于由 SZLK LTD（运营方，注册于英国伦敦，公司编号 16843016）提供服务的独道 (SoloMap) 插件、官方网站（solomap.app）及相关授权同步服务。请在使用我们的产品前仔细阅读以下条款：</p>
    
    <h2>1. 核心本地优先（Local-First）数据架构</h2>
    <p>独道 (SoloMap) 的核心功能基于“本地优先”架构设计：</p>
    <ul>
      <li>您的项目路线图、推进环节、历史 Agent 执行记录（Journal Logs）、意图与判断，全部存储在您本地的 <code>.solopreneur</code> 文件夹中。</li>
      <li>我们没有云端数据库来同步或备份您的项目数据，我们也绝不会在后台静默收集、扫描或传输您的项目源代码、文件结构或业务机密。</li>
      <li>数据的完全控制权在您手中，您可以通过清理本地工作区的相应目录，或者卸载插件彻底移除所有数据。</li>
    </ul>

    <h2>2. 信息收集类型与合法处理目的</h2>
    <p>当您与我们的服务进行交互时，我们仅会基于合法的商业目的收集以下必要的信息：</p>
    <ul>
      <li><strong>账户与订阅激活数据</strong>：为了支持您使用独道 (SoloMap) Pro，我们会使用 OIDC 流程通过 SZLK Passport 安全登录以激活您的授权。我们只拉取您的加密用户 ID 和邮箱地址作为判定订阅状态的唯一凭证，我们不拉取也不存储您的 GitHub 密码或其他账户凭证。</li>
      <li><strong>支付与交易数据</strong>：所有的付款和订阅账单均由 Stripe 独立且安全地进行托管处理，严格遵循 PCI-DSS 支付安全标准。我们不接触、不收集、不存储您的任何信用卡号、CVV 码或敏感的交易财务数据。</li>
      <li><strong>自愿提交的环境与错误日志</strong>：仅在您主动点击“提交反馈”并选择提交 GitHub Issue 时，会上传您同意披露的必要环境数据（如插件版本号、VS Code 版本号和脱敏后的错误日志）。</li>
    </ul>

    <h2>3. 数据的安全保障与存储期限</h2>
    <ul>
      <li><strong>加密传输</strong>：本网站的所有通信均使用标准的 TLS 加密协议进行安全传输，防止数据在传输过程中被窃听或篡改。</li>
      <li><strong>存储时长</strong>：由于我们的架构是本地优先，您的所有路线图状态数据都保留在您本地。我们的服务器不会保存您的项目运行日志。对于购买 Pro 会员而生成的授权账户记录，我们会一直保留，直至您注销账户。</li>
      <li><strong>第三方服务合规</strong>：我们选用的基础设施服务商（如 Cloudflare Workers、Stripe）均符合全球领先的数据保护与安全标准。</li>
    </ul>

    <h2>4. 适用法案与您的用户权利 (GDPR, CCPA, PIPL)</h2>
    <p>我们致力于保障您的隐私权。根据您所在的司法管辖区，您可能拥有基于《通用数据保护条例》(GDPR)、《加州消费者隐私法》(CCPA) 或中国《个人信息保护法》(PIPL) 的如下权利：</p>
    <ul>
      <li><strong>知情权与访问权</strong>：您可以随时查阅我们持有的您的账户 ID 及订阅邮箱。</li>
      <li><strong>数据可携权</strong>：您可以要求我们以结构化的、常用的、机器可读的格式提供您在我们的服务中登记的个人数据。</li>
      <li><strong>删除权（被遗忘权）</strong>：您可以随时请求注销您的 SZLK Passport 账户并删除与您邮箱关联的所有订阅凭证及交易映射记录。</li>
      <li><strong>更正权</strong>：如果您的邮箱发生变动，您可以随时通过 Stripe 账单后台或联络我们的客服进行修正。</li>
    </ul>

    <h2>5. Cookies 政策声明</h2>
    <p>我们仅使用必要的、功能性的 Cookie，其有效期最长为 1 年：</p>
    <ul>
      <li><code>lang_pref</code>：用于记录您的偏好语言（中/英文），为您提供无缝的本地化访问体验，避免重复跳转。</li>
      <li>SZLK Passport 登录会话：用于在您跳转至 Passport 并返回时维持安全的临时校验会话。</li>
      <li>我们不使用任何第三方的广告追踪 Cookie，也不进行跨站行为轨迹追踪。</li>
    </ul>

    <h2>6. 变更与联系方式</h2>
    <p>我们可能会根据服务升级或法律法规的要求适时更新本隐私政策。如有任何疑问或隐私保障相关的权利主张，请通过 GitHub Issue 或发信至官方支持通道（SZLK LTD, London, UK）与我们取得联系。</p>
  ` : `
    <h1>Privacy Policy</h1>
    <p>Last updated: June 6, 2026</p>
    <p>We respect your privacy. This Privacy Policy applies to the SoloMap extension, the official website (solomap.app), and related services operated by SZLK LTD (registered in London, UK, under Company No. 16843016). Please read the terms below carefully:</p>
    
    <h2>1. Core Local-First Data Architecture</h2>
    <p>SoloMap is built around a local-first principles. Your data is your own:</p>
    <ul>
      <li>Your project roadmap, step state, AI agent execution logs (Journal), intents, and judgments are stored entirely inside the <code>.solopreneur</code> folder within your local project workspace.</li>
      <li>We do not operate a centralized cloud database to store or sync your roadmaps. We never scan, collect, or transmit your proprietary source code, folder structures, or technical documentation.</li>
      <li>You retain full ownership and control of your workspace data. You can delete it entirely at any time by deleting the local folder or uninstalling the extension.</li>
    </ul>

    <h2>2. Information We Collect and Processing Purposes</h2>
    <p>We collect only the narrowest set of data necessary to provide and secure our services under legal bases:</p>
    <ul>
      <li><strong>Account &amp; Entitlement Management</strong>: When upgrading to SoloMap Pro, we verify your subscription via OIDC using SZLK Passport. We only retrieve your unique user ID and email to associate and validate your entitlement. We never access or store your primary passwords.</li>
      <li><strong>Payment and Billing Information</strong>: All payment transactions are securely handled by Stripe under PCI-DSS compliance standards. We do not access, process, or store your credit card numbers, billing addresses, or financial credentials.</li>
      <li><strong>Diagnostic Data</strong>: Diagnostic information or usage logs are only transmitted if you explicitly choose to click "Send Feedback" to submit a GitHub issue.</li>
    </ul>

    <h2>3. Data Security and Retention</h2>
    <ul>
      <li><strong>Transit Encryption</strong>: All traffic to and from our website uses standard TLS protocols to secure your connection.</li>
      <li><strong>Retention Period</strong>: Local workspace data resides indefinitely on your hard drive until you erase it. We only persist account metadata (email and user ID) on our licensing servers to facilitate subscription status checks until you request account deletion.</li>
      <li><strong>Third-Party Processors</strong>: Our core web operations run on Cloudflare Workers and Stripe, which adhere to strict global security frameworks and privacy laws.</li>
    </ul>

    <h2>4. GDPR, CCPA and Global Rights Compliance</h2>
    <p>We honor your data rights under major global frameworks, including GDPR, CCPA, and PIPL:</p>
    <ul>
      <li><strong>Right to Access &amp; Portability</strong>: You may ask for a copy of the license entitlements and records tied to your account in a structured, machine-readable format.</li>
      <li><strong>Right of Erasure</strong>: You have the right to request the permanent deletion of your SZLK Passport account and linked subscription records.</li>
      <li><strong>Right to Rectify</strong>: You can update your payment email or details directly in the Stripe Billing Portal or by contacting support.</li>
    </ul>

    <h2>5. Cookies and Web Technologies</h2>
    <p>We do not use any tracking or advertising cookies. The only cookies we store are valid up to 1 year:</p>
    <ul>
      <li><code>lang_pref</code>: To remember your localized language preference (English/Chinese) and ensure seamless redirection.</li>
      <li>SZLK Passport session parameters: Temporary cookies required for OIDC authentication.</li>
    </ul>

    <h2>6. Updates and Contact</h2>
    <p>We may update this Privacy Policy to reflect changes in our software or legal requirements. For inquiries or data right requests, please contact us (SZLK LTD, London, UK) via our GitHub issues page.</p>
  `;

  return `<!doctype html>
<html lang="${t.lang}">
<head>
  ${buildHead(
    { ...t, meta: { ...t.meta, title, description: title } },
    origin,
    `${t.pathPrefix}/privacy-policy`,
    locale === "zh" ? "/privacy-policy" : "/zh/privacy-policy"
  )}
  ${buildStyles()}
</head>
<body>
  ${buildHeader(t, locale, `${t.pathPrefix}/privacy-policy`)}
  <main class="privacy-page">
    <div class="privacy-nav">
      <a href="${t.homePath}">← ${escapeHtml(t.privacy.back)}</a>
    </div>
    <article class="privacy-article">
      ${contentHtml}
    </article>
  </main>
  ${buildFooter(t)}
</body>
</html>`;
}
function buildTermsOfServicePage(locale, origin) {
  const t = content[locale];
  const isZh = locale === "zh";
  const title = isZh ? "独道 (SoloMap) 用户协议" : "SoloMap Terms of Service";
  
  const contentHtml = isZh ? `
    <h1>用户协议</h1>
    <p>更新日期：2026年6月6日</p>
    <p>欢迎使用独道 (SoloMap)！本用户协议是您与独道 (SoloMap) 服务提供商（由 SZLK 提供）之间关于您下载、安装和使用 SoloMap 软件所订立的法律合同。请在使用我们的产品前仔细阅读以下条款：</p>
    
    <h2>1. 许可授予与使用范围</h2>
    <p>我们授予您一项有限的、非独占的、不可转让的、可撤销的软件使用许可：</p>
    <ul>
      <li><strong>免费版（Free）</strong>：独道 (SoloMap) 核心本地路线图功能免费向个人及商业项目开放。</li>
      <li><strong>专业版（Pro）</strong>：独道 (SoloMap) Pro 授权属于个人单人订阅。单个 Pro 订阅支持您在最多 5 台您个人拥有的设备（如工作站和笔记本电脑）上激活并运行 Pro 特性（如战略驾驶舱与多项目组合管理）。</li>
    </ul>

    <h2>2. 第三方 AI 提供商与费用分担（BYO-API）</h2>
    <p>独道 (SoloMap) 支持并鼓励您带上自己喜欢的本地 AI 编码 Agent CLI（如 Cursor, Claude Code, Cline 等）。在运行这些 AI 代理工具的过程中，产生的任何第三方 API 提供商（如 OpenAI, Anthropic, DeepSeek 等）的 Token 消耗、API 计费或服务费用，均需由您自行承担。独道 (SoloMap) 不对此类费用承担任何责任。</p>

    <h2>3. 本地数据与备份义务</h2>
    <p>由于独道 (SoloMap) 的数据默认存放在您的本地计算机上，我们不提供云端路线图同步或历史记录托管服务。<strong>您有责任对自己的项目代码和 <code>.solopreneur</code> 文件夹进行日常备份（如通过 Git 提交或文件同步系统）。</strong> 我们不对任何由于硬盘故障、文件删除、操作系统问题或插件更新引发的数据丢失承担赔偿或找回责任。</p>

    <h2>4. 禁止行为</h2>
    <p>您不得进行以下行为：</p>
    <ul>
      <li>对独道 (SoloMap) 进行逆向工程、反编译或尝试提取其专有组件源代码；</li>
      <li>利用我们的 Passport 登录机制进行未经授权的订阅共享或转售；</li>
      <li>违反适用的出口管制法律或用于危害国家安全的商业行为。</li>
    </ul>

    <h2>5. 责任限制与免责声明</h2>
    <p>在适用法律允许的最大范围内，本软件以“现状（AS-IS）”提供，不带有任何明示或暗示的担保。我们不对因使用或无法使用本软件而导致的任何商业中断、利润损失、机密信息泄露或间接性损害承担赔偿责任。</p>

    <h2>6. 适用法律与争议解决</h2>
    <p>本协议受适用法及服务提供商所在地司法管辖。若您与我们之间因本协议发生任何争议，双方应首先友好协商解决；协商不成的，应提交至有管辖权的仲裁机构或法院进行审理。</p>
  ` : `
    <h1>Terms of Service</h1>
    <p>Last updated: June 6, 2026</p>
    <p>Welcome to SoloMap! These Terms of Service constitute a legal agreement between you and SoloMap (provided by SZLK) regarding your download, installation, and use of SoloMap. Please review the terms below:</p>
    
    <h2>1. License Grant and Usage Scope</h2>
    <p>We grant you a limited, non-exclusive, non-transferable, and revocable license to use the software:</p>
    <ul>
      <li><strong>SoloMap Free</strong>: The core local-first roadmap and task tracking capabilities are free for both personal and commercial projects.</li>
      <li><strong>SoloMap Pro</strong>: Pro licenses are single-user subscriptions. A single Pro subscription allows you to authorize up to 5 personal devices owned and operated by you (such as your main workstation and laptops).</li>
    </ul>

    <h2>2. Third-Party AI API &amp; Tokens (Bring Your Own API Key)</h2>
    <p>SoloMap is designed to integrate with the local AI agent CLIs you already use (e.g., Cursor, Claude Code, Cline, etc.). Any API tokens, service charges, or billing incurred by executing these agents (via providers like OpenAI, Anthropic, DeepSeek, etc.) are your sole responsibility. SoloMap is not liable for third-party AI service costs.</p>

    <h2>3. Local Data and User Backup Responsibility</h2>
    <p>Because SoloMap operates locally on your machine, we do not sync or back up your roadmaps to any cloud server. <strong>You are solely responsible for maintaining backups of your codebase and the <code>.solopreneur</code> directory (e.g., via Git version control).</strong> We are not liable for any data loss, corruption, or project downtime resulting from hardware failure, manual deletion, or system updates.</p>

    <h2>4. Prohibited Uses</h2>
    <p>You agree not to:</p>
    <ul>
      <li>Reverse engineer, decompile, or attempt to extract the source code of the proprietary features of the extension.</li>
      <li>Distribute, resell, or share your Pro subscription or SZLK Passport access codes with others.</li>
      <li>Use the software in violation of local laws, export controls, or international sanctions.</li>
    </ul>

    <h2>5. Limitation of Liability and Disclaimers</h2>
    <p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, SOLOMAP IS PROVIDED "AS IS" WITHOUT ANY WARRANTY OF ANY KIND. WE SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING LOST PROFITS, LOSS OF PROPRIETARY BUSINESS DATA, OR CODE CORRUPTION ARISING OUT OF YOUR USE OF THE SOFTWARE.</p>

    <h2>6. Governing Law and Disputes</h2>
    <p>These terms shall be governed by and construed in accordance with the laws of the service provider's jurisdiction. Any dispute arising out of this agreement shall be settled through amicable negotiation first, failing which it shall be referred to the courts of competent jurisdiction.</p>
  `;

  return `<!doctype html>
<html lang="${t.lang}">
<head>
  ${buildHead(
    { ...t, meta: { ...t.meta, title, description: title } },
    origin,
    `${t.pathPrefix}/terms-of-service`,
    locale === "zh" ? "/terms-of-service" : "/zh/terms-of-service"
  )}
  ${buildStyles()}
</head>
<body>
  ${buildHeader(t, locale, `${t.pathPrefix}/terms-of-service`)}
  <main class="privacy-page">
    <div class="privacy-nav">
      <a href="${t.homePath}">← ${escapeHtml(t.privacy.back)}</a>
    </div>
    <article class="privacy-article">
      ${contentHtml}
    </article>
  </main>
  ${buildFooter(t)}
</body>
</html>`;
}
function alternatePathFor(pathname, locale) {
  const legalRoute = findLegalRoute(pathname);
  if (legalRoute) return alternateLegalPath(legalRoute.slug, legalRoute.locale);
  if (pathname === "/") return "/zh";
  if (pathname === "/zh" || pathname === "/zh/") return "/";
  if (pathname === "/pro") return "/zh/pro";
  if (pathname === "/zh/pro") return "/pro";
  if (pathname === "/docs") return "/zh/docs";
  if (pathname === "/zh/docs") return "/docs";
  if (pathname === "/privacy-local-first") return "/zh/privacy-local-first";
  if (pathname === "/zh/privacy-local-first") return "/privacy-local-first";
  if (pathname === "/privacy-policy") return "/zh/privacy-policy";
  if (pathname === "/zh/privacy-policy") return "/privacy-policy";
  if (pathname === "/terms-of-service") return "/zh/terms-of-service";
  if (pathname === "/zh/terms-of-service") return "/terms-of-service";
  if (pathname === "/sitemap") return "/zh/sitemap";
  if (pathname === "/zh/sitemap") return "/sitemap";
  if (pathname.startsWith("/docs/")) return `/zh${pathname}`;
  if (pathname.startsWith("/zh/docs/")) return pathname.slice(3);
  return locale === "en" ? `/zh${pathname}` : (pathname.startsWith("/zh") ? (pathname.slice(3) || "/") : pathname);
}

const DEFAULT_STATS = {
  vscode: 40,
  openvsx: 9326
};

let statsCache = {
  ...DEFAULT_STATS,
  lastUpdated: 0
};
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
const STATS_REFRESH_TIMEOUT = 3500;

let updateStatsPromise = null;

async function triggerStatsUpdate() {
  if (updateStatsPromise) {
    return updateStatsPromise;
  }

  updateStatsPromise = (async () => {
    let vscodeCount = statsCache.vscode;
    let openvsxCount = statsCache.openvsx;

    try {
      // 1. Fetch VS Code Installs
      const vsPromise = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        try {
          const res = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
            method: "POST",
            headers: {
              "Accept": "application/json; charset=utf-8; api-version=3.0-preview.1",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              filters: [{
                criteria: [{ filterType: 7, value: "SZLK.solopreneur-roadmap" }],
                pageSize: 1
              }],
              flags: 914
            }),
            signal: controller.signal
          });
          if (res.ok) {
            const data = await res.json();
            const statistics = data?.results?.[0]?.extensions?.[0]?.statistics || [];
            const installStat = statistics.find(s => s.statisticName === "install");
            if (installStat && typeof installStat.value === "number") {
              vscodeCount = Math.round(installStat.value);
            }
          }
        } catch (e) {
          console.error("Failed to fetch VS Code stats:", e);
        } finally {
          clearTimeout(timeout);
        }
      })();

      // 2. Fetch Open VSX downloads
      const ovsPromise = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        try {
          const res = await fetch("https://open-vsx.org/api/SZLK/solopreneur-roadmap", {
            signal: controller.signal
          });
          if (res.ok) {
            const data = await res.json();
            const downloadCount = data?.downloadCount;
            const namespaceDownloads = data?.namespaceAccess?.downloadCount;
            if (typeof downloadCount === "number") {
              openvsxCount = downloadCount;
            } else if (typeof namespaceDownloads === "number") {
              openvsxCount = namespaceDownloads;
            }
          }
        } catch (e) {
          console.error("Failed to fetch Open VSX stats:", e);
        } finally {
          clearTimeout(timeout);
        }
      })();

      await Promise.all([vsPromise, ovsPromise]);

      statsCache = {
        vscode: vscodeCount,
        openvsx: openvsxCount,
        lastUpdated: Date.now()
      };
    } catch (e) {
      console.error("Error updating stats:", e);
    } finally {
      updateStatsPromise = null;
    }
    return statsCache;
  })();

  return updateStatsPromise;
}

async function getStats(ctx) {
  const now = Date.now();
  if (now - statsCache.lastUpdated > CACHE_DURATION) {
    const promise = triggerStatsUpdate();
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(promise);
    }
    try {
      return await Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(statsCache), STATS_REFRESH_TIMEOUT))
      ]);
    } catch (error) {
      console.error("Error awaiting stats refresh:", error);
      return statsCache;
    }
  }
  return statsCache;
}

function resetStatsCacheForTest() {
  statsCache = {
    ...DEFAULT_STATS,
    lastUpdated: 0
  };
  updateStatsPromise = null;
}

function buildPage(locale, origin, stats) {
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
          ${t.hero.trustBadge ? `<div class="trust-badge" style="margin-top: 16px; font-size: 14px; color: var(--cyan); font-weight: 700; display: flex; align-items: center; gap: 6px;">${escapeHtml(t.hero.trustBadge)}</div>` : ""}
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
            <a class="button primary" href="${t.pathPrefix}/pro">${escapeHtml(t.pro.cta)}</a>
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
          ${(() => {
            const currentStats = stats || statsCache;
            const vscodeText = locale === "zh"
              ? `${t.install.marketplace} (${currentStats.vscode.toLocaleString()} 次安装)`
              : `${t.install.marketplace} (${currentStats.vscode.toLocaleString()} installs)`;
            const openVsxText = locale === "zh"
              ? `${t.install.openVsx} (${currentStats.openvsx.toLocaleString()} 次下载)`
              : `${t.install.openVsx} (${currentStats.openvsx.toLocaleString()} downloads)`;
            return `
              <a class="button primary" href="${MARKETPLACE_URL}">${escapeHtml(vscodeText)}</a>
              <a class="button secondary" href="${OPEN_VSX_URL}">${escapeHtml(openVsxText)}</a>
            `;
          })()}
          <button class="button soon" type="button" disabled>${escapeHtml(t.install.ios)} <span class="soon-tag">${escapeHtml(t.install.comingSoon)}</span></button>
          <button class="button soon" type="button" disabled>${escapeHtml(t.install.android)} <span class="soon-tag">${escapeHtml(t.install.comingSoon)}</span></button>
          <a class="button secondary" href="${locale === 'zh' ? '/zh/workbench' : '/workbench'}">${escapeHtml(t.install.webWorkspace)}</a>
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

async function buildLegacyWorkbenchPage(request, env) {
  const url = new URL(request.url);
  const origin = env.SITE_ORIGIN || url.origin;
  const locale = url.pathname.startsWith("/zh") ? "zh" : "en";
  const t = content[locale];
  const copy = t.workbench;
  const pagePath = locale === "zh" ? "/zh/workbench" : "/workbench";
  const alternatePath = locale === "zh" ? "/workbench" : "/zh/workbench";
  const accountHref = getPassportAccountUrl(env);
  const code = url.searchParams.get("code") || "";
  const email = url.searchParams.get("email") || "";
  const isActivated = !!code;

  return `<!doctype html>
<html lang="${t.lang}">
<head>
  ${buildHead(
    { ...t, meta: { ...t.meta, title: copy.metaTitle, description: copy.metaDescription, ogDescription: copy.metaDescription } },
    origin,
    pagePath,
    alternatePath
  )}
  ${buildStyles()}
  <style>
    .workbench-hero {
      padding: 60px 0 40px 0;
      text-align: center;
      background: radial-gradient(circle at top, rgba(0, 240, 255, 0.05), transparent 60%);
    }
    .workbench-hero h1 {
      font-size: 40px;
      font-weight: 800;
      margin: 0 0 10px 0;
      background: linear-gradient(135deg, var(--accent), var(--accent-purple));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .workbench-hero p {
      color: var(--muted);
      font-size: 16px;
      margin: 0;
    }
    .workbench-grid {
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 32px;
      margin-bottom: 48px;
    }
    @media (max-width: 768px) {
      .workbench-grid {
        grid-template-columns: 1fr;
      }
    }
    .card {
      background: var(--glass-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      backdrop-filter: blur(12px);
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
      transition: all 0.3s;
      margin-bottom: 24px;
    }
    .card:hover {
      border-color: rgba(0, 240, 255, 0.15);
      box-shadow: 0 8px 32px rgba(0, 240, 255, 0.05);
    }
    .card h2 {
      margin-top: 0;
      margin-bottom: 12px;
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card p.desc {
      color: var(--muted);
      font-size: 13px;
      margin-top: 0;
      margin-bottom: 20px;
      line-height: 1.6;
    }
    .form-group {
      margin-bottom: 16px;
    }
    .form-group label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      margin-bottom: 6px;
      text-transform: uppercase;
    }
    .form-control {
      width: 100%;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--fg);
      padding: 10px 14px;
      font-family: var(--font);
      font-size: 14px;
      transition: all 0.3s;
    }
    .form-control:focus {
      outline: none;
      border-color: var(--accent);
      background: rgba(255, 255, 255, 0.06);
      box-shadow: 0 0 10px rgba(0, 240, 255, 0.2);
    }
    .btn-submit {
      width: 100%;
      background: linear-gradient(135deg, var(--accent), var(--accent-purple));
      border: none;
      border-radius: 8px;
      color: #090a10;
      font-family: var(--font);
      font-size: 14px;
      font-weight: 700;
      padding: 12px;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn-submit:hover {
      transform: translateY(-2px);
      box-shadow: 0 0 20px rgba(0, 240, 255, 0.4);
      filter: brightness(1.1);
    }
    .btn-submit:active {
      transform: translateY(0);
    }
    .roadmap-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .roadmap-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--border);
      border-radius: 8px;
      transition: all 0.3s;
    }
    .roadmap-item:hover {
      background: rgba(255, 255, 255, 0.03);
      border-color: rgba(255, 255, 255, 0.12);
    }
    .roadmap-item-info {
      flex: 1;
    }
    .roadmap-item-title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .roadmap-item-desc {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.4;
    }
    .roadmap-item-status {
      font-size: 11px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 20px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .status-shipped { color: var(--success); background: rgba(0, 230, 118, 0.1); }
    .status-progress { color: var(--accent); background: rgba(0, 240, 255, 0.1); }
    .status-vote {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border);
      cursor: pointer;
      transition: all 0.3s;
    }
    .status-vote:hover {
      background: var(--accent);
      color: #090a10;
      border-color: var(--accent);
      box-shadow: 0 0 12px rgba(0, 240, 255, 0.3);
    }
    .status-voted {
      color: var(--success);
      background: rgba(0, 230, 118, 0.1);
      border: 1px solid rgba(0, 230, 118, 0.2);
    }
    .notify {
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 16px;
      display: none;
      animation: fadeIn 0.4s ease-out forwards;
    }
    .notify.success {
      background: rgba(0, 230, 118, 0.08);
      color: var(--success);
      border: 1px solid rgba(0, 230, 118, 0.2);
      display: block;
    }
    .notify.error {
      background: rgba(255, 23, 68, 0.08);
      color: var(--danger);
      border: 1px solid rgba(255, 23, 68, 0.2);
      display: block;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  ${buildHeader(t, locale, pagePath)}
  <main>
    <section class="workbench-hero">
      <div class="shell">
        <h1>${escapeHtml(copy.title)}</h1>
        <p>${escapeHtml(copy.subtitle)}</p>
      </div>
    </section>

    <section class="section">
      <div class="shell">
        <div class="workbench-grid">
          
          <div class="card" style="margin-bottom:0">
            <h2><span class="codicon codicon-checklist"></span> ${escapeHtml(copy.roadmap.title)}</h2>
            <p class="desc">${escapeHtml(copy.roadmap.desc)}</p>
            
            <div id="vote-success-notify" class="notify" style="display:none; margin-bottom: 16px;"></div>
            
            <div class="roadmap-list">
              ${copy.roadmap.items.map(([title, desc, key, status]) => {
                let statusClass = 'status-shipped';
                if (status === 'In Progress' || status === '进行中') statusClass = 'status-progress';
                
                const isVote = status === 'Vote & Co-create' || status === '投票共创';
                const buttonHtml = isVote
                  ? `<button class="roadmap-item-status status-vote" data-vote-key="${escapeHtml(key)}" onclick="handleVote('${escapeHtml(key)}', this)">${escapeHtml(status)}</button>`
                  : `<span class="roadmap-item-status ${statusClass}">${escapeHtml(status)}</span>`;

                return `
                  <div class="roadmap-item">
                    <div class="roadmap-item-info">
                      <div class="roadmap-item-title">${escapeHtml(title)}</div>
                      <div class="roadmap-item-desc">${escapeHtml(desc)}</div>
                    </div>
                    ${buttonHtml}
                  </div>
                `;
              }).join('')}
            </div>
          </div>
          
          <div class="card-column">
            
            <div class="card">
              <h2><span class="codicon codicon-mail"></span> ${escapeHtml(copy.earlyAccess.title)}</h2>
              <p class="desc">${escapeHtml(copy.earlyAccess.desc)}</p>
              
              <div id="apply-notify" class="notify" style="display:none"></div>
              
              <form id="apply-form" onsubmit="submitApplication(event)">
                <div class="form-group">
                  <label for="apply-email">${escapeHtml(copy.earlyAccess.emailPlaceholder)}</label>
                  <input type="email" id="apply-email" class="form-control" placeholder="name@domain.com" required>
                </div>
                <button type="submit" class="btn-submit" id="apply-btn">
                  <span class="codicon codicon-send"></span> ${escapeHtml(copy.earlyAccess.applyBtn)}
                </button>
              </form>
            </div>
            
            <div class="card">
              <h2><span class="codicon codicon-key"></span> ${escapeHtml(copy.proEntitlements.title)}</h2>
              <p class="desc">${escapeHtml(copy.proEntitlements.desc)}</p>
              
              <div id="activate-notify" class="notify ${isActivated ? 'success' : ''}" style="${isActivated ? '' : 'display:none'}">
                ${isActivated ? escapeHtml(copy.earlyAccess.activeMsg) : ''}
              </div>
              
              ${isActivated ? `
                <div style="font-size: 13px; color: var(--muted); margin-bottom: 20px;">
                  <div>${escapeHtml(copy.proEntitlements.limitMsg)}</div>
                  ${email ? `<div style="margin-top: 4px;">Account: <strong>${escapeHtml(email)}</strong></div>` : ''}
                </div>
                <a class="button secondary" style="width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 10px;" href="/api/passport/recover?intent=recover">
                  <span class="codicon codicon-cloud-download"></span> ${escapeHtml(copy.proEntitlements.recoverBtn)}
                </a>
                <a class="button ghost" style="width: 100%; text-align: center;" href="${escapeHtml(accountHref)}" target="_blank">
                  ${escapeHtml(copy.proEntitlements.manageBtn)}
                </a>
              ` : `
                <form id="activate-form" onsubmit="submitActivation(event)">
                  <div class="form-group">
                    <label for="activate-code">${escapeHtml(copy.earlyAccess.codePlaceholder)}</label>
                    <input type="text" id="activate-code" class="form-control" placeholder="SOLOMAP-PRO-XXXX" required>
                  </div>
                  <button type="submit" class="btn-submit" id="activate-btn" style="background: rgba(255, 255, 255, 0.04); border: 1px solid var(--border); color: var(--fg);">
                    <span class="codicon codicon-verified"></span> ${escapeHtml(copy.earlyAccess.activateBtn)}
                  </button>
                </form>
              `}
            </div>
            
          </div>
          
        </div>
      </div>
    </section>
  </main>
  ${buildFooter(t)}
  
  <script>
    function handleVote(key, btn) {
      btn.innerText = "已投票 ✔";
      btn.className = "roadmap-item-status status-voted";
      btn.disabled = true;
      
      const notify = document.getElementById("vote-success-notify");
      notify.innerText = "${escapeHtml(copy.roadmap.voteSuccess)}";
      notify.className = "notify success";
      notify.style.display = "block";
    }
    
    async function submitApplication(event) {
      event.preventDefault();
      const email = document.getElementById("apply-email").value;
      const btn = document.getElementById("apply-btn");
      const notify = document.getElementById("apply-notify");
      
      btn.disabled = true;
      btn.innerHTML = '<span class="codicon codicon-loading codicon-modifier-spin"></span> Submitting...';
      
      try {
        const response = await fetch("/api/early-access/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email })
        });
        const res = await response.json();
        if (response.ok && res.ok) {
          notify.innerText = "${escapeHtml(copy.earlyAccess.appliedMsg)}";
          notify.className = "notify success";
          document.getElementById("apply-form").style.display = "none";
        } else {
          notify.innerText = res.message || "Failed to submit.";
          notify.className = "notify error";
          btn.disabled = false;
          btn.innerHTML = '<span class="codicon codicon-send"></span> ${escapeHtml(copy.earlyAccess.applyBtn)}';
        }
      } catch (e) {
        notify.innerText = "Error contacting server. Please try again.";
        notify.className = "notify error";
        btn.disabled = false;
        btn.innerHTML = '<span class="codicon codicon-send"></span> ${escapeHtml(copy.earlyAccess.applyBtn)}';
      }
      notify.style.display = "block";
    }
    
    async function submitActivation(event) {
      event.preventDefault();
      const code = document.getElementById("activate-code").value.trim();
      const btn = document.getElementById("activate-btn");
      const notify = document.getElementById("activate-notify");
      
      btn.disabled = true;
      
      if (/^SOLOMAP-PRO-[A-Z0-9]{4,}$/i.test(code)) {
        setTimeout(() => {
          window.location.href = window.location.pathname + "?code=" + encodeURIComponent(code) + "&email=early@solomap.app";
        }, 800);
      } else {
        setTimeout(() => {
          notify.innerText = "${escapeHtml(copy.earlyAccess.invalidCodeMsg)}";
          notify.className = "notify error";
          notify.style.display = "block";
          btn.disabled = false;
        }, 500);
      }
    }
  </script>
</body>
</html>`;
}

function authCopy(locale) {
  return locale === "zh" ? {
    loginTitle: "登录 SoloMap", registerTitle: "创建 SoloMap 账号", loginLead: "回到你的个人项目工作台。", registerLead: "一个账号，管理订阅、设备与官网工作台。",
    name: "你的名字", email: "邮箱", password: "密码", passwordHint: "至少 8 个字符", login: "登录", register: "创建账号", forgot: "忘记密码？", noAccount: "还没有账号？", hasAccount: "已有账号？", create: "立即注册", back: "返回登录",
    verifyTitle: "查收验证邮件", verifyText: "验证链接已发送到你的邮箱。完成验证后即可登录 SoloMap。", resetTitle: "重设密码", resetLead: "输入注册邮箱，我们会发送密码重设链接。", newPasswordLead: "设置一个新的登录密码。", sendReset: "发送重设邮件", savePassword: "保存新密码", resetSent: "如果该账号存在，重设邮件已经发出。", passwordSaved: "密码已更新，现在可以登录。",
    genericError: "操作没有完成，请稍后重试。", emailUnverified: "请先完成邮箱验证，再登录。", submitting: "正在处理…"
  } : {
    loginTitle: "Sign in to SoloMap", registerTitle: "Create your SoloMap account", loginLead: "Return to your personal project workbench.", registerLead: "One account for your subscription, devices, and web workbench.",
    name: "Your name", email: "Email", password: "Password", passwordHint: "At least 8 characters", login: "Sign in", register: "Create account", forgot: "Forgot password?", noAccount: "New to SoloMap?", hasAccount: "Already have an account?", create: "Create one", back: "Back to sign in",
    verifyTitle: "Check your inbox", verifyText: "We sent a verification link to your email. Verify it, then sign in to SoloMap.", resetTitle: "Reset your password", resetLead: "Enter your account email and we will send a reset link.", newPasswordLead: "Choose a new password for your account.", sendReset: "Send reset email", savePassword: "Save new password", resetSent: "If the account exists, a reset email has been sent.", passwordSaved: "Your password has been updated. You can now sign in.",
    genericError: "We could not complete that action. Please try again.", emailUnverified: "Verify your email before signing in.", submitting: "Working…"
  };
}

function buildAuthPage(request, mode) {
  const url = new URL(request.url);
  const locale = url.pathname.startsWith("/zh") ? "zh" : "en";
  const t = content[locale];
  const copy = authCopy(locale);
  const isRegister = mode === "register";
  const isForgot = mode === "forgot";
  const isReset = mode === "reset";
  const returnTo = safeReturnTo(url.searchParams.get("return_to"), locale === "zh" ? "/zh/workbench" : "/workbench");
  const pageTitle = isRegister ? copy.registerTitle : isForgot || isReset ? copy.resetTitle : copy.loginTitle;
  const lead = isRegister ? copy.registerLead : isForgot ? copy.resetLead : isReset ? copy.newPasswordLead : copy.loginLead;
  const endpoint = isRegister ? "register" : isForgot ? "forgot-password" : isReset ? "reset-password" : "login";
  return `<!doctype html><html lang="${t.lang}"><head>
  ${buildHead({ ...t, meta: { ...t.meta, title: pageTitle, description: lead, ogDescription: lead } }, url.origin, url.pathname, locale === "zh" ? url.pathname.replace(/^\/zh/, "") || "/" : `/zh${url.pathname}`)}
  ${buildStyles()}<style>
  .auth-main{min-height:calc(100dvh - 160px);display:grid;place-items:center;padding:56px 20px}.auth-shell{width:min(100%,440px)}.auth-brand{display:flex;justify-content:center;margin-bottom:24px}.auth-card{padding:32px;border:1px solid var(--border);border-radius:20px;background:var(--glass-bg);box-shadow:0 24px 70px rgba(0,0,0,.28)}.auth-card h1{font-size:30px;margin:0 0 8px}.auth-lead{color:var(--muted);margin:0 0 28px}.auth-field{margin-bottom:18px}.auth-field label{display:block;margin-bottom:7px;font-size:14px;font-weight:650}.auth-field input{box-sizing:border-box;width:100%;min-height:48px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.035);color:var(--fg);font:inherit}.auth-field input:focus{outline:3px solid rgba(0,240,255,.18);border-color:var(--accent)}.auth-help{display:block;margin-top:6px;color:var(--muted);font-size:12px}.auth-submit{width:100%;min-height:48px;border:0;border-radius:10px;background:var(--accent);color:#071014;font:inherit;font-weight:750;cursor:pointer}.auth-submit:disabled{opacity:.65;cursor:wait}.auth-message{display:none;margin:0 0 16px;padding:12px 14px;border-radius:10px;font-size:14px}.auth-message.error{display:block;color:#ffb4bf;background:rgba(255,68,96,.1);border:1px solid rgba(255,68,96,.25)}.auth-message.success{display:block;color:#96f5d7;background:rgba(0,220,160,.1);border:1px solid rgba(0,220,160,.25)}.auth-switch{text-align:center;color:var(--muted);margin:20px 0 0}.auth-switch a,.auth-links a{color:var(--accent)}.auth-links{text-align:right;margin:-8px 0 18px;font-size:13px}@media(max-width:520px){.auth-main{padding:28px 16px}.auth-card{padding:24px}}
  </style></head><body>${buildHeader(t, locale, url.pathname)}<main class="auth-main"><div class="auth-shell"><section class="auth-card"><h1>${escapeHtml(pageTitle)}</h1><p class="auth-lead">${escapeHtml(lead)}</p><div id="auth-message" class="auth-message" role="status" aria-live="polite"></div><form id="auth-form">
  ${isRegister ? `<div class="auth-field"><label for="name">${escapeHtml(copy.name)}</label><input id="name" name="name" autocomplete="name" required></div>` : ""}
  ${isReset ? "" : `<div class="auth-field"><label for="email">${escapeHtml(copy.email)}</label><input id="email" name="email" type="email" autocomplete="email" required></div>`}
  ${isForgot ? "" : `<div class="auth-field"><label for="password">${escapeHtml(copy.password)}</label><input id="password" name="password" type="password" autocomplete="${isRegister || isReset ? "new-password" : "current-password"}" minlength="8" required>${isRegister || isReset ? `<span class="auth-help">${escapeHtml(copy.passwordHint)}</span>` : ""}</div>`}
  ${!isRegister && !isForgot && !isReset ? `<div class="auth-links"><a href="${locale === "zh" ? "/zh" : ""}/forgot-password">${escapeHtml(copy.forgot)}</a></div>` : ""}
  <button class="auth-submit" id="auth-submit" type="submit">${escapeHtml(isRegister ? copy.register : isForgot ? copy.sendReset : isReset ? copy.savePassword : copy.login)}</button></form>
  <p class="auth-switch">${isRegister ? `${escapeHtml(copy.hasAccount)} <a href="${locale === "zh" ? "/zh" : ""}/login">${escapeHtml(copy.login)}</a>` : isForgot || isReset ? `<a href="${locale === "zh" ? "/zh" : ""}/login">${escapeHtml(copy.back)}</a>` : `${escapeHtml(copy.noAccount)} <a href="${locale === "zh" ? "/zh" : ""}/register?return_to=${encodeURIComponent(returnTo)}">${escapeHtml(copy.create)}</a>`}</p></section></div></main>${buildFooter(t)}
  <script>document.getElementById('auth-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget;const button=document.getElementById('auth-submit');const message=document.getElementById('auth-message');button.disabled=true;button.textContent=${JSON.stringify(copy.submitting)};message.className='auth-message';try{const body=Object.fromEntries(new FormData(form).entries());body.returnTo=${JSON.stringify(returnTo)};${isReset ? `body.token=${JSON.stringify(url.searchParams.get("token") || "")};` : ""}const response=await fetch('/api/auth/${endpoint}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.code==='email_not_verified'?${JSON.stringify(copy.emailUnverified)}:(result.message||${JSON.stringify(copy.genericError)}));if(${JSON.stringify(isRegister)}){form.style.display='none';message.textContent=${JSON.stringify(copy.verifyText)};message.className='auth-message success';}else if(${JSON.stringify(isForgot)}){form.style.display='none';message.textContent=${JSON.stringify(copy.resetSent)};message.className='auth-message success';}else if(${JSON.stringify(isReset)}){form.style.display='none';message.innerHTML=${JSON.stringify(copy.passwordSaved)}+' <a href="${locale === "zh" ? "/zh" : ""}/login">${escapeHtml(copy.login)}</a>';message.className='auth-message success';}else{location.href=result.returnTo||${JSON.stringify(returnTo)};return;}}catch(error){message.textContent=error.message||${JSON.stringify(copy.genericError)};message.className='auth-message error';}button.disabled=false;button.textContent=${JSON.stringify(isRegister ? copy.register : isForgot ? copy.sendReset : isReset ? copy.savePassword : copy.login)};});</script></body></html>`;
}

function buildWorkbenchStyles() {
  return `<style>
  .desk{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:calc(100dvh - 72px)}.desk-side{padding:34px 24px 34px 0;border-right:1px solid var(--border)}.desk-side strong{display:block;margin:0 12px 24px}.desk-nav{display:grid;gap:8px}.desk-nav a{min-height:44px;display:flex;align-items:center;padding:0 12px;border-radius:9px;color:var(--muted);text-decoration:none}.desk-nav a.active{background:rgba(0,240,255,.09);color:var(--fg)}.desk-main{min-width:0;padding:40px 0 56px 40px}.desk-top{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:38px}.desk-top h1{margin:0 0 8px;font-size:clamp(30px,3vw,38px);line-height:1.12}.desk-top p{margin:0;color:var(--muted)}.desk-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,320px);gap:24px}.desk-card{min-width:0;border:1px solid var(--border);border-radius:16px;background:var(--glass-bg);padding:24px}.desk-card h2{margin:0 0 8px;font-size:19px}.desk-card p{color:var(--muted);line-height:1.65}.empty-projects{min-height:280px;display:grid;place-items:center;text-align:center;padding:32px}.empty-projects>div{max-width:520px}.empty-projects h2{font-size:24px}.desk-actions{display:flex;justify-content:center;flex-wrap:wrap;gap:12px;margin-top:22px}.account-line{display:flex;align-items:center;gap:12px;margin:20px 0}.account-line>div:last-child{min-width:0}.avatar{width:44px;height:44px;flex:0 0 44px;display:grid;place-items:center;border-radius:50%;background:rgba(0,240,255,.12);color:var(--accent);font-weight:800}.account-line span{display:block;color:var(--muted);font-size:13px;overflow-wrap:anywhere}.logout{width:100%;min-height:44px;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--fg);cursor:pointer}.boundary-note{margin-top:18px;padding-top:18px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}@media(max-width:960px){.desk{grid-template-columns:1fr}.desk-side{padding:16px 0;border-right:0;border-bottom:1px solid var(--border)}.desk-side>strong{display:none}.desk-nav{display:flex;gap:8px;overflow-x:auto}.desk-nav a{flex:0 0 auto}.desk-main{padding:30px 0 48px}.desk-grid{grid-template-columns:1fr}}@media(max-width:600px){.desk-top{display:block;margin-bottom:26px}.desk-top .button{margin-top:18px}.desk-card{padding:20px}.empty-projects{min-height:240px;padding:24px 20px}.desk-actions{display:grid}.desk-actions .button{width:100%}}
  </style>`;
}

function buildWorkbenchSidebar(locale, activeTab) {
  const zh = locale === "zh";
  const pagePath = zh ? "/zh/workbench" : "/workbench";
  const collaborationPath = `${pagePath}/collaboration`;
  const active = (tab) => activeTab === tab ? ' class="active" aria-current="page"' : "";
  return `<aside class="desk-side"><strong>${zh ? "个人工作台" : "Personal workbench"}</strong><nav class="desk-nav" aria-label="${zh ? "工作台导航" : "Workbench navigation"}"><a${active("projects")} href="${pagePath}">${zh ? "我的项目" : "My projects"}</a><a${active("collaboration")} href="${collaborationPath}">${zh ? "共创空间" : "Co-create space"}</a><a href="${zh ? "/zh/pro" : "/pro"}">SoloMap Pro</a></nav></aside>`;
}

async function buildPersonalWorkbenchPage(request, env, session) {
  const url = new URL(request.url);
  const locale = url.pathname.startsWith("/zh") ? "zh" : "en";
  const t = content[locale];
  const zh = locale === "zh";
  const name = session.name || session.email.split("@")[0];
  const pagePath = zh ? "/zh/workbench" : "/workbench";
  return `<!doctype html><html lang="${t.lang}"><head>${buildHead({ ...t, meta: { ...t.meta, title: zh ? "SoloMap 个人工作台" : "SoloMap Personal Workbench", description: zh ? "查看并推进你的 SoloMap 项目。" : "See and move your SoloMap projects forward.", ogDescription: "SoloMap" } }, url.origin, pagePath, zh ? "/workbench" : "/zh/workbench")}${buildStyles()}${buildWorkbenchStyles()}
</head><body>${buildHeader(t, locale, pagePath)}<div class="desk shell">${buildWorkbenchSidebar(locale, "projects")}<main class="desk-main"><header class="desk-top"><div><h1>${zh ? `你好，${escapeHtml(name)}` : `Welcome back, ${escapeHtml(name)}`}</h1><p>${zh ? "从这里查看你的项目，并继续下一步。" : "See your projects here and continue with the next step."}</p></div><a class="button secondary" href="${MARKETPLACE_URL}">${zh ? "打开 VS Code 插件" : "Open the VS Code extension"}</a></header><div class="desk-grid"><section class="desk-card empty-projects"><div><h2>${zh ? "你的项目会出现在这里" : "Your projects will appear here"}</h2><p>${zh ? "目前项目仍由 SoloMap 插件保存在你的本地工作区。先在 VS Code 中打开一个项目，创建路线图并开始推进。" : "For now, SoloMap keeps projects in your local workspace. Open a project in VS Code, create its roadmap, and start moving it forward."}</p><div class="desk-actions"><a class="button primary" href="${MARKETPLACE_URL}">${zh ? "安装或打开 SoloMap" : "Install or open SoloMap"}</a><a class="button ghost" href="${zh ? "/zh/docs" : "/docs"}">${zh ? "查看使用指南" : "Read the guide"}</a></div></div></section><aside class="desk-card"><h2>${zh ? "账号" : "Account"}</h2><div class="account-line"><div class="avatar">${escapeHtml(name.slice(0,1).toUpperCase())}</div><div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(session.email)}</span></div></div><button class="logout" id="logout" type="button">${zh ? "退出登录" : "Sign out"}</button><p class="boundary-note">${zh ? "官网当前只承载账号与个人工作台。插件中的项目数据仍保存在本地，不会自动上传。" : "The website currently hosts your account and personal workbench only. Project data in the extension stays local and is not uploaded automatically."}</p></aside></div></main></div>${buildFooter(t)}<script>document.getElementById('logout').addEventListener('click',async()=>{await fetch('/api/auth/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});location.href='${zh ? "/zh/login" : "/login"}';});</script></body></html>`;
}

async function handleHeadlessAuth(request, env, mode) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    const appBaseUrl = new URL(request.url).origin;
    if (mode === "login") {
      const result = await passportHeadlessRequest(env, "auth/login", { email: body.email, password: body.password });
      if (result.needsEmailVerification || !result.user?.emailVerified) return jsonResponse({ ok: false, code: "email_not_verified", message: "Verify your email before signing in." }, 403);
      return jsonResponse({ ok: true, user: result.user, returnTo: safeReturnTo(body.returnTo) }, 200, { "set-cookie": await createSessionCookie(request, env, result.user) });
    }
    if (mode === "register") {
      const result = await passportHeadlessRequest(env, "auth/register", { email: body.email, password: body.password, name: body.name, appBaseUrl });
      return jsonResponse({ ok: true, needsEmailVerification: true, user: result.user });
    }
    if (mode === "forgot-password") {
      await passportHeadlessRequest(env, "auth/forgot-password", { email: body.email, appBaseUrl });
      return jsonResponse({ ok: true });
    }
    if (mode === "verify-email") {
      await passportHeadlessRequest(env, "auth/verify-email", { token: body.token });
      return jsonResponse({ ok: true });
    }
    if (mode === "reset-password") {
      await passportHeadlessRequest(env, "auth/reset-password", { token: body.token, password: body.password });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: false, code: "invalid_auth_mode" }, 404);
  } catch (error) {
    return jsonResponse({ ok: false, code: error.code || "auth_failed", message: error.message || "Authentication failed" }, Number(error.status) || 500);
  }
}

async function handleEarlyAccessApply(request, env) {
  try {
    const body = await request.json();
    const email = String(body.email || "").trim();
    if (!email || !email.includes("@")) {
      return jsonResponse({ ok: false, message: "Invalid email address" }, 400);
    }
    return jsonResponse({ ok: true, message: "Application submitted" });
  } catch (e) {
    return jsonResponse({ ok: false, message: "Invalid request payload" }, 400);
  }
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

const INTERNAL_LEGAL_SECTION_IDS = new Set(["product_display_boundary", "professional_review"]);

function formatLegalDate(value, locale) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function renderLegalSections(document) {
  return document.composition
    .flatMap((part) => part.sections)
    .filter((section) => !INTERNAL_LEGAL_SECTION_IDS.has(section.id))
    .map((section) => {
      const paragraphs = section.body_markdown
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
        .join("");
      return `<section><h2>${escapeHtml(section.title)}</h2>${paragraphs}</section>`;
    })
    .join("");
}

async function buildLegalDocumentPage(route, locale, origin, env) {
  const t = content[locale];
  const document = await getLegalContent(env, route);
  const title = route.supplement
    ? (locale === "zh" ? "SoloMap 产品法律补充说明" : "SoloMap Product Legal Supplement")
    : document.title;
  const effectiveLabel = locale === "zh" ? "生效日期" : "Effective date";
  const description = locale === "zh"
    ? `${title}，适用于 SoloMap 产品与服务。`
    : `${title} applicable to the SoloMap product and services.`;

  return `<!doctype html>
<html lang="${t.lang}">
<head>
  ${buildHead(
    { ...t, meta: { ...t.meta, title, description, ogDescription: description } },
    origin,
    legalPath(route.slug, locale),
    alternateLegalPath(route.slug, locale)
  )}
  ${buildStyles()}
</head>
<body>
  ${buildHeader(t, locale, legalPath(route.slug, locale))}
  <main class="privacy-page">
    <div class="privacy-nav"><a href="${t.homePath}">← ${escapeHtml(t.privacy.back)}</a></div>
    <article class="privacy-article">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(effectiveLabel)}：${escapeHtml(formatLegalDate(document.effective_at, locale))}</p>
      ${renderLegalSections(document)}
    </article>
  </main>
  ${buildFooter(t)}
</body>
</html>`;
}

function buildLegalUnavailablePage(locale, origin) {
  const t = content[locale];
  const title = locale === "zh" ? "法律文件暂时无法显示" : "Legal document temporarily unavailable";
  const message = locale === "zh"
    ? "请稍后重试。SoloMap 不会在无法确认文件适用产品时展示其他产品的法律内容。"
    : "Please try again shortly. SoloMap will not show another product's legal content when the applicable document cannot be confirmed.";
  return `<!doctype html>
<html lang="${t.lang}">
<head>${buildHead({ ...t, meta: { ...t.meta, title, description: message, ogDescription: message } }, origin, t.homePath, t.alternateHomePath)}${buildStyles()}</head>
<body>${buildHeader(t, locale, t.homePath)}<main class="privacy-page"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${t.homePath}">${locale === "zh" ? "返回首页" : "Return home"}</a></p></main>${buildFooter(t)}</body>
</html>`;
}

function resolveRoute(pathname) {
  const legalRoute = findLegalRoute(pathname);
  if (legalRoute) {
    return { type: "legal-document", locale: legalRoute.locale, legalRoute, status: 200 };
  }
  if (pathname === "/" || pathname === "/en") {
    return { type: "home", locale: "en", status: 200 };
  }
  if (pathname === "/zh" || pathname === "/zh/") {
    return { type: "home", locale: "zh", status: 200 };
  }
  if (pathname === "/sitemap" || pathname === "/sitemap/") {
    return { type: "sitemap-html", locale: "en", status: 200 };
  }
  if (pathname === "/zh/sitemap" || pathname === "/zh/sitemap/") {
    return { type: "sitemap-html", locale: "zh", status: 200 };
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
  if (pathname === "/privacy-policy" || pathname === "/privacy-policy/") {
    return { type: "privacy-policy", locale: "en", status: 200 };
  }
  if (pathname === "/zh/privacy-policy" || pathname === "/zh/privacy-policy/") {
    return { type: "privacy-policy", locale: "zh", status: 200 };
  }
  if (pathname === "/terms-of-service" || pathname === "/terms-of-service/") {
    return { type: "terms-of-service", locale: "en", status: 200 };
  }
  if (pathname === "/zh/terms-of-service" || pathname === "/zh/terms-of-service/") {
    return { type: "terms-of-service", locale: "zh", status: 200 };
  }
  return { type: "home", locale: pathname.startsWith("/zh") ? "zh" : "en", status: 404 };
}

function buildSitemap(origin) {
  const pairs = [
    { en: "/", zh: "/zh", priority: "1.0", changefreq: "weekly" },
    { en: "/pro", zh: "/zh/pro", priority: "0.9", changefreq: "weekly" },
    { en: "/docs", zh: "/zh/docs", priority: "0.7", changefreq: "monthly" },
    ...Object.keys(docsContent.en.pages).map((slug) => ({
      en: `/docs/${slug}`,
      zh: `/zh/docs/${slug}`,
      priority: "0.6",
      changefreq: "monthly"
    })),
    { en: "/privacy-local-first", zh: "/zh/privacy-local-first", priority: "0.4", changefreq: "yearly" },
    ...[...legalRoutes, legalSupplementRoute].map((route) => ({
      en: legalPath(route.slug, "en"),
      zh: legalPath(route.slug, "zh"),
      priority: "0.4",
      changefreq: "yearly"
    })),
    { en: "/sitemap", zh: "/zh/sitemap", priority: "0.5", changefreq: "weekly" }
  ];
  const renderUrl = (loc, pair) => `  <url>
    <loc>${escapeHtml(absoluteUrl(loc, origin))}</loc>
    <lastmod>${SITEMAP_LASTMOD}</lastmod>
    <changefreq>${pair.changefreq}</changefreq>
    <priority>${pair.priority}</priority>
    <xhtml:link rel="alternate" hreflang="en" href="${escapeHtml(absoluteUrl(pair.en, origin))}" />
    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${escapeHtml(absoluteUrl(pair.zh, origin))}" />
    <xhtml:link rel="alternate" hreflang="zh-CN" href="${escapeHtml(absoluteUrl(pair.zh, origin))}" />
    <xhtml:link rel="alternate" hreflang="zh-TW" href="${escapeHtml(absoluteUrl(pair.zh, origin))}" />
    <xhtml:link rel="alternate" hreflang="zh-HK" href="${escapeHtml(absoluteUrl(pair.zh, origin))}" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeHtml(absoluteUrl(pair.en, origin))}" />
  </url>`;
  const urls = pairs.flatMap((pair) => [
    renderUrl(pair.en, pair),
    renderUrl(pair.zh, pair)
  ]).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
}

function buildSitemapXsl() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9">
  <xsl:output method="html" encoding="UTF-8" indent="yes"/>
  <xsl:template match="/">
    <html lang="en">
    <head>
      <title>SoloMap XML Sitemap</title>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <style>
        body {
          margin: 0;
          padding: 40px 20px;
          background: #11100e;
          color: #f6f0e8;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
          line-height: 1.5;
        }
        .container {
          max-width: 1000px;
          margin: 0 auto;
        }
        h1 {
          font-size: 32px;
          margin-bottom: 8px;
          font-weight: 800;
          background: linear-gradient(135deg, #ef3e46 0%, #49d6d0 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        p {
          color: #bfb5a7;
          margin-bottom: 24px;
          font-size: 16px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          border: 1px solid rgba(246, 240, 232, 0.16);
          border-radius: 12px;
          overflow: hidden;
          background: #1a1714;
        }
        th, td {
          padding: 14px 18px;
          text-align: left;
          border-bottom: 1px solid rgba(246, 240, 232, 0.12);
        }
        th {
          background: rgba(255, 255, 255, 0.04);
          color: #f6f0e8;
          font-weight: 700;
          font-size: 14px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        tr:last-child td {
          border-bottom: none;
        }
        a {
          color: #49d6d0;
          text-decoration: none;
          word-break: break-all;
          transition: color 0.2s;
        }
        a:hover {
          color: #ef3e46;
        }
        .badge {
          display: inline-block;
          padding: 4px 8px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 700;
          background: rgba(73, 214, 208, 0.1);
          color: #49d6d0;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>SoloMap XML Sitemap</h1>
        <p>This is an XML sitemap generated for search engine crawlers like Google. It contains all indexable URLs on solomap.app.</p>
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Last Modified</th>
              <th>Change Frequency</th>
              <th>Priority</th>
            </tr>
          </thead>
          <tbody>
            <xsl:for-each select="s:urlset/s:url">
              <tr>
                <td>
                  <a href="{s:loc}"><xsl:value-of select="s:loc"/></a>
                </td>
                <td>
                  <xsl:value-of select="s:lastmod"/>
                </td>
                <td>
                  <xsl:value-of select="s:changefreq"/>
                </td>
                <td>
                  <span class="badge"><xsl:value-of select="s:priority"/></span>
                </td>
              </tr>
            </xsl:for-each>
          </tbody>
        </table>
      </div>
    </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
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

// 检查并处理多语言重定向及 Cookie 同步
function handleLocaleRedirect(request, env, origin) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  
  // 排除 API、静态文件、健康检查等路由
  if (
    pathname.startsWith("/api/") ||
    pathname === "/room" ||
    pathname === "/zh/room" ||
    pathname.startsWith("/room/") ||
    pathname.startsWith("/zh/room/") ||
    pathname === "/health" ||
    pathname === "/robots.txt" ||
    pathname === "/llms.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/sitemap.xsl"
  ) {
    return null;
  }

  // 爬虫直接放行，不做任何 302 跳转，确保 SEO/GEO 抓取正常
  const ua = request.headers.get("user-agent") || "";
  const isBot = /bot|spider|crawl|slurp|tracker/i.test(ua);
  if (isBot) {
    return null;
  }

  const cookie = request.headers.get("cookie") || "";
  
  // 获取已有的偏好 Cookie
  let langPref = "";
  const match = cookie.match(/lang_pref=(zh|en)/);
  if (match) {
    langPref = match[1];
  }

  // 获取 URL 参数中的显式 lang 指定
  const langParam = url.searchParams.get("lang");
  
  // 决策最终的语言偏好
  let targetLang = "";
  if (langParam === "zh" || langParam === "en") {
    targetLang = langParam;
  } else if (langPref === "zh" || langPref === "en") {
    targetLang = langPref;
  } else {
    // 仅在主页根路径上，若无明确偏好 cookie，才根据 GEO/Accept-Language 判定是否重定向到中文版
    if (pathname === "/" || pathname === "/zh" || pathname === "/zh/") {
      const country = request.cf?.country;
      const acceptLang = request.headers.get("accept-language") || "";
      const isChineseRegion = ["CN", "TW", "HK", "MO"].includes(country);
      const prefersChinese = acceptLang.toLowerCase().includes("zh");
      targetLang = (isChineseRegion || prefersChinese) ? "zh" : "en";
    } else {
      // 其他具体子路径在无偏好 cookie 时，直接遵循该 URL 路径自身的 locale，不发生 302 跳转
      targetLang = pathname.startsWith("/zh") ? "zh" : "en";
    }
  }

  const isCurrentZh = pathname.startsWith("/zh");
  const wantsZh = (targetLang === "zh");

  // 判断是否需要进行语言间的路径跳转
  let newPath = "";
  if (wantsZh && !isCurrentZh) {
    // 英文路径 -> 中文路径
    if (pathname === "/") {
      newPath = "/zh";
    } else {
      newPath = "/zh" + pathname;
    }
  } else if (!wantsZh && isCurrentZh) {
    // 中文路径 -> 英文路径
    newPath = pathname.slice(3); // 截掉 "/zh"
    if (newPath === "") {
      newPath = "/";
    }
  }

  // 如果需要重定向，或者需要写入/更新 Cookie
  const needsRedirect = (newPath !== "");
  const needsCookieUpdate = (langPref !== targetLang);

  if (needsRedirect || needsCookieUpdate) {
    const headers = new Headers();
    if (needsCookieUpdate) {
      headers.set("Set-Cookie", `lang_pref=${targetLang}; Path=/; Max-Age=31536000; SameSite=Lax`);
    }
    
    if (needsRedirect) {
      const redirectUrl = new URL(newPath, url.origin);
      // 保留原有参数（除了 lang）
      url.searchParams.forEach((val, key) => {
        if (key !== "lang") {
          redirectUrl.searchParams.set(key, val);
        }
      });
      headers.set("Location", redirectUrl.toString());
      return new Response(null, { status: 302, headers });
    } else {
      // 仅写入 Cookie，不进行重定向
      return { cookieHeader: `lang_pref=${targetLang}; Path=/; Max-Age=31536000; SameSite=Lax` };
    }
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.SITE_ORIGIN || SITE_ORIGIN;

    const redirectRes = handleLocaleRedirect(request, env, origin);
    if (redirectRes instanceof Response) {
      return redirectRes;
    }

    const extraHeaders = {};
    if (redirectRes && redirectRes.cookieHeader) {
      extraHeaders["Set-Cookie"] = redirectRes.cookieHeader;
    }

    if (url.pathname === "/health") {
      return textResponse("ok");
    }

    if (url.pathname === "/api/collaboration/devices" && (request.method === "POST" || request.method === "OPTIONS")) {
      return handleCollaborationDeviceRegistration(request, env);
    }

    if (url.pathname === "/api/collaboration/rooms" && (request.method === "POST" || request.method === "OPTIONS")) {
      const creator = request.method === "POST" ? await resolveCollaborationAccountCreator(request, env) : null;
      return handleCollaborationRoomCreate(request, env, creator);
    }

    if (url.pathname === "/api/collaboration/lobby/session" && (request.method === "POST" || request.method === "OPTIONS")) {
      const creator = request.method === "POST" ? await resolveCollaborationAccountCreator(request, env) : null;
      return handleCollaborationLobbySession(request, env, creator);
    }

    if (url.pathname === "/api/collaboration/lobby/socket") {
      return handleCollaborationLobbySocket(request, env);
    }

    if (/^\/api\/collaboration\/rooms\/[A-Za-z0-9_-]{20,64}\/socket$/.test(url.pathname)) {
      return handleCollaborationSocket(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/collaboration/account/start") {
      return handleCollaborationAccountStart(request, env);
    }

    const collaborationRoomMatch = url.pathname.match(/^\/(zh\/)?room(?:\/([A-Za-z0-9_-]{20,64}))?$/);
    if (request.method === "GET" && collaborationRoomMatch) {
      return htmlResponse(
        buildCollaborationRoomPage(collaborationRoomMatch[2] || "", collaborationRoomMatch[1] ? "zh" : "en"),
        200,
        collaborationRoomPageHeaders()
      );
    }

    const authPageMatch = url.pathname.match(/^\/(?:zh\/)?(login|register|forgot-password|reset-password)$/);
    if (request.method === "GET" && authPageMatch) {
      const session = await readSession(request, env);
      if (session && authPageMatch[1] !== "forgot-password") {
        return Response.redirect(`${url.origin}${url.pathname.startsWith("/zh") ? "/zh/workbench" : "/workbench"}`, 302);
      }
      const authMode = authPageMatch[1] === "forgot-password" ? "forgot" : authPageMatch[1] === "reset-password" ? "reset" : authPageMatch[1];
      return htmlResponse(buildAuthPage(request, authMode), 200, {
        "cache-control": "no-store",
        "content-security-policy": ["default-src 'none'", "style-src 'unsafe-inline'", "script-src 'unsafe-inline'", "connect-src 'self'", "img-src 'self' https://raw.githubusercontent.com data:", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join("; ")
      });
    }

    if (request.method === "GET" && (url.pathname === "/verify-email" || url.pathname === "/zh/verify-email")) {
      const localePath = url.pathname.startsWith("/zh") ? "/zh" : "";
      const token = String(url.searchParams.get("token") || "");
      const result = await handleHeadlessAuth(new Request(`${url.origin}/api/auth/verify-email`, { method: "POST", headers: { "content-type": "application/json", "origin": url.origin }, body: JSON.stringify({ token }) }), env, "verify-email");
      return Response.redirect(`${url.origin}${localePath}/login?verified=${result.ok ? "1" : "0"}`, 302);
    }

    const authApiMatch = url.pathname.match(/^\/api\/auth\/(login|register|forgot-password|verify-email|reset-password)$/);
    if (request.method === "POST" && authApiMatch) return handleHeadlessAuth(request, env, authApiMatch[1]);

    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      const session = await readSession(request, env);
      return jsonResponse({ authenticated: Boolean(session), user: session ? { id: session.id, email: session.email, name: session.name } : null, expiresAt: session?.expiresAt || null });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      try { assertSameOrigin(request); } catch (error) { return jsonResponse({ ok: false, code: error.code, message: error.message }, error.status); }
      return jsonResponse({ ok: true, authenticated: false }, 200, { "set-cookie": clearSessionCookie(request) });
    }

    if (url.pathname === "/api/passport/start") {
      return handlePassportStart(request, env);
    }

    if (url.pathname === "/api/passport/recover") {
      return handlePassportRecover(request, env);
    }

    if (url.pathname === "/pro" || url.pathname === "/zh/pro") {
      const proLocale = url.pathname.startsWith("/zh") ? "zh" : "en";
      const proHeaders = {
        "Set-Cookie": `lang_pref=${proLocale}; Path=/; Max-Age=31536000; SameSite=Lax`
      };
      return htmlResponse(await buildProSubscriptionPage(request, env), 200, proHeaders);
    }

    if (["/workbench", "/zh/workbench", "/workbench/collaboration", "/zh/workbench/collaboration"].includes(url.pathname)) {
      const workbenchLocale = url.pathname.startsWith("/zh") ? "zh" : "en";
      const session = await readSession(request, env);
      if (!session) {
        const loginPath = workbenchLocale === "zh" ? "/zh/login" : "/login";
        return Response.redirect(`${url.origin}${loginPath}?return_to=${encodeURIComponent(url.pathname)}`, 302);
      }
      const workbenchHeaders = {
        "Set-Cookie": `lang_pref=${workbenchLocale}; Path=/; Max-Age=31536000; SameSite=Lax`,
        "content-security-policy": [
          "default-src 'none'",
          "img-src 'self' https://raw.githubusercontent.com data:",
          "style-src 'unsafe-inline' https://fonts.googleapis.com",
          "font-src https://fonts.gstatic.com",
          "connect-src 'self'",
          "script-src 'unsafe-inline'",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'"
        ].join("; ")
      };
      if (url.pathname.endsWith("/collaboration")) {
        const workbenchContent = content[workbenchLocale];
        return htmlResponse(buildCollaborationRoomPage("", workbenchLocale, {
          workbench: true,
          displayName: session.name || session.email.split("@")[0],
          siteStyles: buildStyles(),
          workbenchStyles: buildWorkbenchStyles(),
          headerHtml: buildHeader(workbenchContent, workbenchLocale, url.pathname),
          sidebarHtml: buildWorkbenchSidebar(workbenchLocale, "collaboration"),
          footerHtml: buildFooter(workbenchContent)
        }), 200, {
          ...collaborationRoomPageHeaders({ workbench: true }),
          "Set-Cookie": workbenchHeaders["Set-Cookie"],
          "cache-control": "no-store"
        });
      }
      return htmlResponse(await buildPersonalWorkbenchPage(request, env, session), 200, { ...workbenchHeaders, "cache-control": "no-store" });
    }

    if (url.pathname === "/api/early-access/apply" && request.method === "POST") {
      return handleEarlyAccessApply(request, env);
    }

    if (url.pathname === "/api/passport/device/start") {
      return handlePassportDeviceStart(request, env);
    }

    if (url.pathname === "/api/passport/device/authorize") {
      return handlePassportDeviceAuthorize(request, env);
    }

    if (url.pathname === "/api/passport/checkout/success") {
      return handlePassportCheckoutSuccess(request, env);
    }

    if (url.pathname === "/api/passport/device/verify") {
      return handlePassportDeviceVerify(request, env);
    }

    if (url.pathname === "/api/passport/oidc/callback") {
      return handlePassportOidcCallback(request, env);
    }

    if (url.pathname === "/api/passport/verify") {
      return handlePassportVerify(request, env);
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

    if (url.pathname === "/sitemap.xsl") {
      return textResponse(buildSitemapXsl(), "application/xml; charset=utf-8");
    }

    const route = resolveRoute(url.pathname);

    if (route.type === "sitemap-html") {
      return htmlResponse(buildHtmlSitemapPage(route.locale, origin), route.status, extraHeaders);
    }
    if (route.type === "privacy") {
      return htmlResponse(buildLocalFirstPage(route.locale, origin), route.status, extraHeaders);
    }
    if (route.type === "legal-document") {
      try {
        return htmlResponse(await buildLegalDocumentPage(route.legalRoute, route.locale, origin, env), route.status, extraHeaders);
      } catch (error) {
        console.error("Unable to load SoloMap legal document", error);
        return htmlResponse(buildLegalUnavailablePage(route.locale, origin), 502, extraHeaders);
      }
    }
    if (route.type === "privacy-policy") {
      return htmlResponse(buildPrivacyPolicyPage(route.locale, origin), route.status, extraHeaders);
    }
    if (route.type === "terms-of-service") {
      return htmlResponse(buildTermsOfServicePage(route.locale, origin), route.status, extraHeaders);
    }
    if (route.type === "docs-index") {
      return htmlResponse(buildDocIndexPage(route.locale, origin), route.status, extraHeaders);
    }
    if (route.type === "doc") {
      return htmlResponse(buildDocPage(route.locale, route.slug, origin), route.status, extraHeaders);
    }

    const stats = await getStats(ctx);
    return htmlResponse(buildPage(route.locale, origin, stats), route.status, extraHeaders);
  }
};

export { CollaborationLobby, CollaborationQuota, CollaborationRoom, resetStatsCacheForTest };

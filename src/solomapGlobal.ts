import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { buildAgentDatabaseInstructions } from './agentDatabaseConfig';
import { buildSystemMaintenancePromptGuard } from './systemMaintenance';
import * as childProcess from 'child_process';
import { RoadmapNode } from './db/types';
import { appendLearningEvent, buildLearningPromotionContext, readLearningOverview, LearningEvidenceRef } from './learningLedger';
import { shellQuote } from './agentCli';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { capabilitySnapshot, capabilityVersion, refreshCapabilityRegistry, writeCapabilityEntries, captureInstallationFiles, CapabilityKind, CapabilityRegistryVersion } from './capabilityRegistry';

export async function refreshSolomapCapabilityRegistries(workspaceRoot: string, globalDataPath = ''): Promise<void> {
  await Promise.all([readSolomapSkillRegistry(workspaceRoot, globalDataPath), readSolomapMcpRegistry(workspaceRoot, globalDataPath), readSolomapEnhancementRegistry(workspaceRoot, globalDataPath)]);
}

export function getSolomapCapabilityRevision(workspaceRoot: string, globalDataPath = ''): string {
  const root = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  return (['skill', 'mcp', 'enhancement'] as CapabilityKind[]).map(kind => capabilityVersion(root, kind)).join(':');
}

export interface SolomapSkillRegistryEntry {
  id: string;
  title?: string;
  description?: string;
  entry?: string;
  packagePath?: string;
  status?: string;
  defaultCandidate?: boolean;
  source?: any;
  activation?: {
    keywords?: string[];
    useWhen?: string[];
    doNotUseWhen?: string[];
    projectTypes?: string[];
    roadmapStages?: string[];
    taskKinds?: string[];
    fileGlobs?: string[];
    manualOnly?: boolean;
  };
  risk?: {
    hasScripts?: boolean;
    hasExecutables?: boolean;
    usesNetwork?: boolean | string;
    writesFiles?: boolean | string;
    requiresUserApprovalToRunScripts?: boolean;
  };
  installedAt?: string;
  updatedAt?: string;
}

export interface SolomapSkillRegistry extends CapabilityRegistryVersion {
  version: number;
  updatedAt: string;
  skills: SolomapSkillRegistryEntry[];
}

export interface BuiltinSolomapSkillDefinition {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  useWhen: string[];
  doNotUseWhen: string[];
  skillMd: string;
  defaultCandidate?: boolean;
}

export const BUILTIN_SOLOMAP_SKILLS: BuiltinSolomapSkillDefinition[] = [{
  id: 'solomap-global-execution-guide',
  title: 'SoloMap Global Execution Guide',
  description: 'Default SoloMap execution guide for anchored, user-goal-preserving, verifiable project work.',
  keywords: ['SoloMap', '路线图', 'Solo', '执行', '验证', '闭环', '记忆', 'skill', '插件', 'UI', '界面', '文案', '修复', '实现'],
  useWhen: [
    'SoloMap 路线图环节、Solo 对话、路线图调整或项目执行任务',
    '任务需要读取项目事实、全局经验库、文档或代码后再改动',
    '任务需要交付可验证结果、用户向 UI、内容或工程闭环'
  ],
  doNotUseWhen: ['用户只是纯闲聊，且不涉及项目判断、执行、文档、代码或设计'],
  skillMd: `---
name: solomap-global-execution-guide
description: Use for SoloMap project work by default. Guides agents to anchor reality, read relevant memory, keep user goals higher than implementation preference, make minimal verifiable changes, validate final artifacts, and preserve reusable lessons.
---

# SoloMap Global Execution Guide

Use this skill for SoloMap roadmap steps, Solo conversations, roadmap revisions, and project work unless the user is only making casual conversation.

## Execution Contract

1. State the concrete deliverable in one sentence before implementation.
2. Anchor on real files, commands, logs, tests, or current user-provided evidence before judging current implementation.
3. Use the shared SoloMap context, search and read tools when the task needs project or reusable memory; treat recalled content as context, not stronger evidence than current files.
4. Preserve the user's goal, wording, boundaries, and requested path. Do not replace the task with a more familiar engineering problem.
5. Make the smallest change that directly advances the goal. Avoid unrelated architecture changes, route changes, roadmap edits, or broad rewrites.
6. For user-facing UI or content, optimize for the final user's action and comprehension. Remove engineering self-description, template language, implementation traces, and maintenance-facing copy.
7. Validate the actual artifact the user will rely on. For generated scripts, templates, webviews, or configs, validate the generated output, not only the source template.
8. Close the loop: classify temporary run artifacts, explain verification, and capture reusable lessons through the shared memory tools when they will matter later. Reviewed status is assigned by the authorized review workflow.

## Before Acting

- Identify the user's intended result.
- Identify any explicit consistency, path, interface, or boundary the user wants preserved.
- Identify anything the user explicitly rejected or is correcting.
- Decide whether the user wants a result, a correction, a discussion, or a durable rule update.

## Memory Use

- Use the SoloMap tools connected to the current project. Start with solomap_context, then search and read fixed object revisions when needed.
- Read full content; follow every content cursor until it is null. Never treat a preview as a complete source.
- Use solomap_write for captured reusable memory and retain its receipt, revision and committedSequence. Retry the same intention with the same key and immediately read back.
- Keep project-private content scoped to the current project. Cross-project publication, promotion and adoption belong to the authorized review workflow.

## Completion Standard

The task is not complete until the requested result is landed, the narrow relevant verification has run or is explicitly impossible, known tail items are classified, and the final response states what changed, what was verified, and remaining risk.
`
}, {
  id: 'solomap-roadmap-planning',
  title: 'SoloMap Roadmap Planning',
  description: 'Generate and revise SoloMap roadmaps from the user goal, project type, current project state, and validation rules.',
  keywords: ['roadmap', '路线图', '生成初始路线图', '调整路线图', 'revision', 'bootstrap', 'Build', 'Sell', 'Learn', 'Improve', '项目类型'],
  useWhen: [
    '生成初始路线图、调整路线图或重排后续环节',
    '用户改变项目目标、优先级、商业化方向或阶段边界',
    '需要把方法论转成用户可执行的路线图环节'
  ],
  doNotUseWhen: ['任务只是在既有环节内执行代码、文档或修复，不需要修改路线图'],
  skillMd: `---
name: solomap-roadmap-planning
description: Use when generating or revising SoloMap roadmaps. Converts project goals and project type into executable roadmap steps, preserves completed facts, and validates the final CSV.
---

# SoloMap Roadmap Planning

Use this skill when the task is to generate an initial roadmap, revise a roadmap, or decide how project goals should map into SoloMap steps.

## Workflow

1. Read the current user request, project files, existing \`.solopreneur/roadmap.csv\`, roadmap methodology, and validation script when present.
2. Classify the project type before choosing stages:
   - Core product: cover Build, Sell, Learn, and Improve.
   - Infrastructure: emphasize contracts, integration, versioning, compatibility, and verification.
   - Content product: emphasize production, distribution, and feedback.
   - Research or experiment: allow validation failure, but require a conclusion.
   - Tooling scaffold: emphasize reusable entrypoints and handoff.
   - Archive or maintenance: emphasize stability, monitoring, and low-risk upkeep.
3. Preserve completed work unless the user explicitly asks to undo it.
4. Turn methodology into user-executable steps. Do not create roadmap steps that merely explain methodology, internal directories, prompts, or maintenance mechanics.
5. Each step must have a concrete user-facing or project-facing outcome, a clear stage, valid dependencies, and an Agent prompt that can be executed.
6. Keep \`roadmap.csv\` schema intact: \`id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\`.
7. Run the project validation command required by the prompt, usually \`node .solopreneur/validate-roadmap.cjs --mode bootstrap\` or \`--mode revision\`, and fix failures before finalizing.

## Quality Bar

- The user should see a practical next path, not an explanation of SoloMap's internal method.
- Commercial products must not silently degrade into build-only plans.
- Non-commercial projects must not receive fake sales or marketing stages.
- Roadmap steps should be few enough to execute and specific enough to validate.
`
}, {
  id: 'solomap-project-docs-lifecycle',
  title: 'SoloMap Project Docs Lifecycle',
  description: 'Maintain long-lived project engineering documents without creating noisy summaries, logs, or prompt dumps.',
  keywords: ['文档', 'documentation', 'docs', 'README', 'business plan', 'methodology', 'architecture', 'boundary', 'manifest', '项目生命周期', '工程文档'],
  useWhen: [
    '任务需要新增、更新或审计项目长期文档',
    '蓝图、方案、路线图、工程设计、边界或方法论需要落到仓库文档',
    '需要判断某个信息应写入 README、方向文档、方法论文档、边界文档还是不应写入长期文档'
  ],
  doNotUseWhen: ['任务只是代码修复且没有长期文档判断或项目解释性产出'],
  skillMd: `---
name: solomap-project-docs-lifecycle
description: Use when creating, updating, or auditing long-lived project documents in SoloMap projects. Keeps docs tied to durable project responsibilities instead of run summaries.
---

# SoloMap Project Docs Lifecycle

Use this skill when project work needs durable documentation.

## Document Placement

1. Direction documents explain what the project is, who it serves, success criteria, and external expression.
2. Methodology documents explain lifecycle models, execution models, or harness judgment rules.
3. Boundary documents freeze product, engineering, or user-mindset boundaries to prevent future drift.
4. UI guideline documents constrain long-term UI or governance-surface behavior.
5. Reference documents hold long-lived explanatory background.
6. Data ownership documents explain project data, cache, run records, and Git management boundaries.

## Rules

- Do not create low-semantic files such as \`summary.md\`, \`notes.md\`, \`plan.md\`, or run logs as long-term documentation.
- Do not copy prompts, terminal logs, execution traces, or internal process narration into project docs.
- If adding a new official document, choose a filename that states its durable responsibility, preferably under existing \`docs/architecture/\`, \`docs/methodology/\`, \`docs/ui/\`, \`docs/product/\`, or \`docs/decisions/\`.
- Keep docs written for future project understanding, not for proving that the current run happened.
- If the repository has a plugin-managed documentation manifest, do not hand-edit the manifest unless the codebase explicitly expects manual edits.

## Completion Check

Before finalizing, confirm that the document says something future work can reuse, that it is in the right responsibility bucket, and that no run-only material leaked into long-term docs.
`
}, {
  id: 'solomap-cross-project-memory',
  title: 'SoloMap Cross-Project Memory',
  description: 'Recall and save useful SoloMap memory without leaking project-private details.',
  keywords: ['memory', '记忆', '经验库', '沉淀', 'profile', 'operating-rules', 'patterns', 'decisions', 'domains', 'inbox', 'active', 'learning candidates', '跨项目'],
  useWhen: [
    '任务结束时需要沉淀跨会话或跨项目仍有价值的信息',
    '需要判断信息应进入 profile、operating-rules、projects、patterns、decisions、domains、inbox、active 或 learning candidates',
    '需要把一次经验抽象成可复用模式，同时避免泄漏项目私有事实'
  ],
  doNotUseWhen: ['本轮没有产生未来可复用的新事实、决策、模式、领域知识或交接信息'],
  skillMd: `---
name: solomap-cross-project-memory
description: Use when recording reusable SoloMap memory. Classifies lessons into profile, operating rules, project memory, patterns, decisions, domains, inbox, active handoff, or learning candidates.
---

# SoloMap Cross-Project Memory

Use this skill when the task creates information that should survive the current conversation.

## Classification

- Choose a memory category for preferences, operating rules, project facts, patterns, decisions, domain knowledge, observations, or session handoff.
- Keep project-private facts in the current project. Shared rules and lessons require the existing authorized review flow before cross-project publication.
- New observations and handoff remain captured memory; recall alone does not make a lesson verified or adopted.

## Writing Protocol

1. Use \`solomap_context\` for relevant memory and \`solomap_search\` to locate existing records. Read the complete record with \`solomap_read\`; when paginated, follow its cursor at the fixed revision until cursor is null.
2. Read \`solomap_read({"ref":"solomap://schema"})\` before writing. Use the same tools for project memory and authorized shared memory; never append to old memory or learning files.
3. Create a captured memory using \`solomap_write\`. The current project is bound by the tool connection. Choose one unique idempotencyKey for the intent and reuse it for retries, including after a timeout.
4. To update an existing record, first read its objectId and revision, then patch only changed fields with expectedRevision. On revision_conflict, reread and coordinate the changes rather than overwriting a newer revision.
5. Confirm revision and committedSequence in the receipt and immediately read the saved record back. Preserve complete content. Do not declare captured memory verified or approved; submit reusable lessons through the authorized review flow.
6. Distill useful facts and decisions. Do not put project names, private fields, providers or deployment details into shared operating principles. Export only when the user requests an export.

Example create request for \`solomap_write\` (choose a fresh intent key and replace the example content):

\`\`\`json
{
  "action": "create",
  "kind": "memory",
  "idempotencyKey": "memory:session-fact:unique-intent",
  "data": {
    "category": "project",
    "title": "Project fact to recall",
    "status": "captured",
    "confidence": 0.8,
    "content": "The complete fact, its evidence and the conditions in which it applies."
  }
}
\`\`\`

## Completion Check

Memory is useful only if it can change a future execution decision. If it is merely a record that this run happened, do not write it as long-term memory.
`
}, {
  id: 'solomap-enhancement-installer',
  title: 'SoloMap Enhancement Installer',
  description: 'Install, configure, verify, and report curated SoloMap execution enhancements under the SoloMap global enhancement registry.',
  keywords: ['enhancement', '执行增强', '安装增强', 'rtk', 'codegraph', 'caveman', 'mcp shrink', '增强安装'],
  useWhen: [
    '用户从 SoloMap 设置页点击执行增强的安装、修复或更新',
    '需要安装或配置 rtk、CodeGraph、MCP 描述压缩等 SoloMap curated 执行增强',
    '需要写入增强 manifest、source lock、health 和 result.json 供插件复验'
  ],
  doNotUseWhen: ['普通项目执行任务不需要安装、更新或修复执行增强'],
  defaultCandidate: false,
  skillMd: `---
name: solomap-enhancement-installer
description: Use only for SoloMap curated execution enhancement installation, repair, update, and verification. Produces registry-ready manifests, health reports, and result.json for plugin validation.
---

# SoloMap Enhancement Installer

Use this skill only when SoloMap asks you to install, repair, update, or verify a curated execution enhancement.

## Workflow

1. Read the requested enhancement id, target project, SoloMap global directory, enhancement directory, and required result.json path from the prompt.
2. Install and configure only the requested curated enhancement. Do not install unrelated tools.
3. Prefer the user's existing package managers and Agent configuration conventions. If an installer modifies Agent configuration, record exactly which config files changed in the result.
4. Write the enhancement package directory under \`.solomap-global/enhancements/installed/<enhancement-id>/\`.
5. Write the following installation evidence only at the exact temporary paths supplied by the current prompt:
   - \`solomap.enhancement.json\`: id, title, description, status, version, source, adapter, activation, risk, evidencePolicy, installedAt, updatedAt, and health.
   - \`source.lock.json\`: source, package/version/commit if known, installer command summary, and updatedAt.
   - \`health.json\`: ok, version, command checks, config files touched, warnings, and lastCheckedAt.
   - the prompt-specified \`result.json\`.
6. Treat \`health.version\` as the canonical installed version. If the primary command has no useful \`--version\`, derive the version from the package manager, package metadata, source lock, smoke-tested executable package, or upstream commit.
7. Do not replace a previously known top-level version with \`版本未知\`, an empty string, or a weaker check result. Put weaker command output under \`health.commandChecks\` with the reason.
8. Read the current registered enhancement metadata through the supplied SoloMap tools. Preserve known versions and provenance unless this run has stronger evidence. Do not create permanent registry, manifest, lock or health mirrors in the execution package.
9. Do not write Agent private config unless the enhancement cannot work without it and the prompt explicitly permits it. If any installer touches Agent config, record \`configFilesTouched\` exactly in health and result.
10. If a step partially succeeds, keep the installed files and report status as \`failed\` or \`needs_repair\` with a clear repair hint. Do not hide partial failures behind a successful result.
11. Never delete existing files or clear directories. If cleanup is needed, report it in result.json instead of doing it.

## Result JSON

For success, follow the complete result JSON schema in the current installation prompt. Use its exact installedPath and temporary solomapEnhancementJson, sourceLockJson, healthJson and result.json paths. Include the observed version, command checks, provenance and configFilesTouched. The plugin validates and commits these documents together; they are not permanent package files.

Failed install:

\`\`\`json
{ "ok": false, "enhancementId": "code-structure-assistant", "error": "Clear reason", "health": { "ok": false, "message": "What failed" } }
\`\`\`

## Validation Bar

- A claimed success must include a command/version check. If any package or source version is known, top-level \`version\` and \`health.version\` must use that known value rather than \`版本未知\`.
- Critical installation logs belong in the run output, not in long-term docs.
- The plugin is the final validator; write enough structured evidence for it to decide whether the enhancement can be used.
`
}];

export interface SolomapMcpRegistryEntry {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  source?: any;
  serverPath?: string;
  configPath?: string;
  profiles?: Record<string, any>;
  activation?: {
    keywords?: string[];
    useWhen?: string[];
    doNotUseWhen?: string[];
    projectTypes?: string[];
    taskKinds?: string[];
    manualOnly?: boolean;
  };
  permissions?: {
    tools?: string[];
    resources?: string[];
    prompts?: string[];
    requiresCredentials?: boolean;
    credentialRefs?: string[];
    externalAccess?: boolean | string;
    writeAccess?: boolean | string;
  };
  risk?: {
    level?: string;
    canWriteExternal?: boolean;
    canSendMessages?: boolean;
    canModifyCloudResources?: boolean;
    canAccessSecrets?: boolean;
    requiresExplicitEnable?: boolean;
  };
  installedAt?: string;
  updatedAt?: string;
}

export interface SolomapMcpRegistry extends CapabilityRegistryVersion {
  version: number;
  updatedAt: string;
  connectors: SolomapMcpRegistryEntry[];
}

export interface SolomapEnhancementRegistryEntry {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  enabled?: boolean;
  version?: string;
  source?: any;
  capability?: string;
  benefit?: string;
  installedPath?: string;
  configPath?: string;
  adapter?: {
    type?: string;
    detect?: string;
    installCheck?: string;
    runtime?: string;
    fallback?: string;
    tools?: string[];
  };
  activation?: {
    keywords?: string[];
    useWhen?: string[];
    doNotUseWhen?: string[];
    projectTypes?: string[];
    taskKinds?: string[];
    fileGlobs?: string[];
    manualOnly?: boolean;
  };
  risk?: {
    level?: string;
    requiresExplicitEnable?: boolean;
    usesNetwork?: boolean | string;
    writesFiles?: boolean | string;
    canWriteExternal?: boolean;
    canAccessSecrets?: boolean;
    modifiesAgentConfig?: boolean;
    startsBackgroundService?: boolean;
    hidesRawOutput?: boolean;
  };
  evidencePolicy?: {
    mustReadRawWhen?: string[];
    mustVerifyWith?: string[];
  };
  installedAt?: string;
  updatedAt?: string;
  lastCheckedAt?: string;
  health?: {
    ok?: boolean;
    message?: string;
    version?: string;
    lastProbe?: {
      ok?: boolean;
      version?: string;
      message?: string;
      checkedAt?: string;
    };
    commandChecks?: any[];
  };
}

export interface SolomapEnhancementRegistry extends CapabilityRegistryVersion {
  version: number;
  updatedAt: string;
  enhancements: SolomapEnhancementRegistryEntry[];
}

export interface BuiltinSolomapEnhancementDefinition extends SolomapEnhancementRegistryEntry {
  id: string;
  title: string;
  description: string;
}

export interface SolomapEnhancementStatusSummary {
  id: string;
  title: string;
  description: string;
  status: string;
  statusLabel: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  action: string;
  message: string;
  updatedAt: string;
}

export const BUILTIN_SOLOMAP_ENHANCEMENTS: BuiltinSolomapEnhancementDefinition[] = [{
  id: 'command-output-optimizer',
  title: 'Command Output Optimizer',
  description: 'Use an external command-output proxy such as rtk to reduce routine terminal output token cost while preserving raw-output fallback requirements.',
  status: 'disabled',
  source: { kind: 'curated_builtin', repo: 'https://github.com/rtk-ai/rtk', updatePolicy: 'track_upstream_release_or_commit' },
  capability: 'Command output filtering and token reduction.',
  benefit: 'Reduces repeated terminal-output payloads for build, test, search, and log-heavy agent tasks.',
  adapter: {
    type: 'command_rewrite',
    runtime: 'external_command_proxy',
    fallback: 'run_original_command'
  },
  activation: {
    keywords: ['token', '输出', '命令', '日志', '构建', '测试', 'compile', 'test', 'rg', 'grep', 'git', 'output'],
    useWhen: [
      '命令输出很长但只需要错误摘要、匹配片段或状态结论',
      '重复执行构建、测试、搜索或日志命令，且需要节省 agent token 占用'
    ],
    doNotUseWhen: [
      '需要逐行审计原始命令输出',
      '失败原因、数据内容或安全判断依赖完整 stdout/stderr'
    ]
  },
  risk: {
    level: 'medium',
    requiresExplicitEnable: false,
    hidesRawOutput: true,
    usesNetwork: false,
    writesFiles: false
  },
  evidencePolicy: {
    mustReadRawWhen: ['命令失败', '需要引用具体日志', '输出摘要不足以支撑判断'],
    mustVerifyWith: ['必要时重新运行原始命令或打开原始日志']
  }
}, {
  id: 'code-structure-assistant',
  title: 'Code Structure Assistant',
  description: 'Use an external code graph capability to help agents inspect symbols, references, and impact paths without replacing source-file reading.',
  status: 'disabled',
  source: { kind: 'curated_builtin', name: 'CodeGraph', updatePolicy: 'track_upstream_release_or_commit' },
  capability: 'Code graph lookup, dependency navigation, and symbol/reference discovery.',
  benefit: 'Helps agents narrow source-reading scope before refactors, bug fixes, and impact analysis.',
  adapter: {
    type: 'mcp',
    runtime: 'external_mcp_connector',
    fallback: 'read_source_files_directly'
  },
  activation: {
    keywords: ['codegraph', 'code graph', '调用', '引用', '符号', '依赖', '影响面', '重构', 'debug', 'refactor', 'symbol', 'reference'],
    useWhen: [
      '需要定位函数、引用、调用链或改动影响面',
      '仓库较大，直接全文搜索不足以快速缩小代码阅读范围'
    ],
    doNotUseWhen: [
      '任务只涉及单个已知文件',
      '图谱结果与当前源码不一致或无法证明新鲜度'
    ]
  },
  risk: {
    level: 'low',
    requiresExplicitEnable: false,
    usesNetwork: 'depends_on_connector',
    writesFiles: false
  },
  evidencePolicy: {
    mustReadRawWhen: ['准备修改代码', '图谱结果影响架构判断', '引用关系存在歧义'],
    mustVerifyWith: ['读取当前源文件', '运行最窄相关测试或静态检查']
  }
}, {
  id: 'mcp-description-compressor',
  title: 'MCP Description Compressor',
  description: 'Use caveman-shrink style MCP proxying to compress tool, prompt, and resource descriptions while keeping tool calls unmodified.',
  status: 'disabled',
  source: { kind: 'curated_builtin', repo: 'https://github.com/JuliusBrussee/caveman', updatePolicy: 'track_upstream_release_or_commit' },
  capability: 'MCP schema and description compression.',
  benefit: 'Reduces MCP metadata context overhead for tool-heavy agent sessions.',
  adapter: {
    type: 'mcp',
    runtime: 'external_mcp_proxy',
    fallback: 'connect_to_original_mcp_server'
  },
  activation: {
    keywords: ['mcp', 'connector', '工具描述', 'schema', 'description', 'tool', 'resource', 'prompt', '上下文'],
    useWhen: [
      'MCP 工具、资源或 prompt 描述占用大量上下文',
      '增强只压缩描述，不改变实际 tools/call 执行'
    ],
    doNotUseWhen: [
      '需要完整阅读工具描述来判断安全或权限',
      'MCP server 本身不稳定，压缩代理会增加排障复杂度'
    ]
  },
  risk: {
    level: 'low',
    requiresExplicitEnable: false,
    usesNetwork: 'depends_on_mcp_server',
    writesFiles: false
  },
  evidencePolicy: {
    mustReadRawWhen: ['工具权限、安全边界或参数含义不清楚', '压缩描述导致可用性下降'],
    mustVerifyWith: ['必要时查看原始 MCP 描述或直接连接原 MCP server']
  }
}];

export const SOLOMAP_RTK_WRAPPED_COMMANDS = ['ls', 'tree', 'find', 'rg', 'grep', 'git', 'gh'];

function sanitizeAttachmentScope(scope: string): string {
  const normalized = String(scope || 'conversation')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'conversation';
}

export function normalizeSolomapGlobalPath(workspaceRoot: string, globalDataPath = ''): string {
  return normalizeGlobalDataPathForExtension(globalDataPath, workspaceRoot);
}

export function getSolomapMemoryRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'memory');
}

export function getSolomapSkillsRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'skills');
}

export function getSolomapMcpRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'mcp');
}

export function getSolomapEnhancementsRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'enhancements');
}

export function ensureSolomapMaintenanceWorkspace(workspaceRoot: string, globalDataPath = ''): { maintenanceRoot: string; runsRoot: string } {
  const maintenanceRoot = path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'tmp', 'maintenance-workspace');
  const runsRoot = path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'tmp', 'maintenance-runs');
  fs.mkdirSync(maintenanceRoot, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  return { maintenanceRoot, runsRoot };
}

export function getSolomapEnhancementRuntimeRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(getSolomapEnhancementsRoot(workspaceRoot, globalDataPath), 'runtime');
}

export function getProjectMemoryFilePath(workspaceRoot: string, globalDataPath = ''): string {
  const projectName = path.basename(workspaceRoot || 'project');
  const projectSlug = sanitizeAttachmentScope(projectName.toLowerCase()) || 'project';
  return path.join(getSolomapMemoryRoot(workspaceRoot, globalDataPath), 'projects', `${projectSlug}.md`);
}

export function writeFileIfMissing(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

export function writeSolomapMemoryExamples(memoryRoot: string, learningCandidatesDir: string): void {
  const examples: Array<{ filePath: string; content: string }> = [
    {
      filePath: path.join(memoryRoot, 'projects', '_example.md'),
      content: [
        '# Project Memory Example',
        '',
        'Create real project files as `projects/<project-slug>.md`. Keep only stable facts that help future work on that project.',
        '',
        '## Stable Facts',
        '- YYYY-MM-DD: Fact confirmed by current files, tests, logs, or user decision.',
        '',
        '## Decisions',
        '- YYYY-MM-DD: Decision, reason, and impact.',
        '',
        '## Current Handoff',
        '- Goal:',
        '- Confirmed state:',
        '- Next useful action:',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'patterns', '_example.md'),
      content: [
        '# Pattern Example',
        '',
        'Use one file per reusable delivery, implementation, debugging, or verification pattern.',
        '',
        '## Applies When',
        '- Situation where this pattern is useful.',
        '',
        '## Steps',
        '1. Action that reliably helps.',
        '2. Action that verifies the result.',
        '',
        '## Evidence',
        '- Where this pattern was validated.',
        '',
        '## Risks',
        '- When not to apply it.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'decisions', '_example.md'),
      content: [
        '# Decision Example',
        '',
        'Use one file per stable cross-project decision.',
        '',
        '## Status',
        '- proposed | accepted | superseded',
        '',
        '## Context',
        '- Why this decision exists.',
        '',
        '## Decision',
        '- What should happen from now on.',
        '',
        '## Impact',
        '- Projects, workflows, or user experience affected.',
        '',
        '## Review Trigger',
        '- When this decision should be revisited.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'domains', '_example.md'),
      content: [
        '# Domain Memory Example',
        '',
        'Use one file per domain that can help multiple projects.',
        '',
        '## Scope',
        '- What this domain memory covers.',
        '',
        '## Stable Knowledge',
        '- Verified domain fact or constraint.',
        '',
        '## Reuse Notes',
        '- How future projects should apply it.',
        '',
        '## Sources',
        '- File, user decision, command output, or trusted source that supports it.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'inbox', '_example.md'),
      content: [
        '# Inbox Example',
        '',
        'Use inbox for observations that may become memory but are not verified enough yet.',
        '',
        '## Observation',
        '- What was noticed.',
        '',
        '## Evidence',
        '- Where it came from.',
        '',
        '## Confidence',
        '- low | medium | high',
        '',
        '## Promotion Target',
        '- projects | patterns | decisions | domains | operating-rules | profile',
        '',
        '## Next Check',
        '- What must be verified before promotion.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'active', '_example.md'),
      content: [
        '# Active Session Example',
        '',
        'Use active memory for temporary handoff only. Promote stable information elsewhere before it becomes long-lived.',
        '',
        '## Current Goal',
        '- What is being handled now.',
        '',
        '## Confirmed Facts',
        '- Current facts verified in this session.',
        '',
        '## Next Action',
        '- The next concrete action if work resumes.',
        '',
        '## Open Risks',
        '- Known unresolved risks.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(learningCandidatesDir, '_example.md'),
      content: [
        '# Learning Candidate Example',
        '',
        'Use this area for reusable lessons before they are promoted into long-term memory.',
        '',
        '## Candidate Lesson',
        '- What future agents may reuse.',
        '',
        '## Source Task',
        '- Project, date, and task where it was observed.',
        '',
        '## Evidence',
        '- File, test, log, command output, or user decision that supports it.',
        '',
        '## Applies When',
        '- Conditions where this lesson is useful.',
        '',
        '## Promotion Target',
        '- memory/projects | memory/patterns | memory/decisions | memory/domains | memory/inbox',
        ''
      ].join('\n')
    }
  ];
  examples.forEach((example) => {
    fs.mkdirSync(path.dirname(example.filePath), { recursive: true });
    writeFileIfMissing(example.filePath, example.content);
  });
}

export function ensureSolomapMemoryStore(workspaceRoot: string, globalDataPath = ''): { globalRoot: string; memoryRoot: string; projectMemoryFile: string } {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  return { globalRoot, memoryRoot: path.join(globalRoot, 'memory'), projectMemoryFile: getProjectMemoryFilePath(workspaceRoot, globalDataPath) };
}

function copyBundledFile(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing bundled SoloMap runtime file: ${sourcePath}`);
  }
  const source = fs.readFileSync(sourcePath);
  const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath) : null;
  if (current?.equals(source)) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, source);
}

function ensureSolomapGlobalTools(globalRoot: string): void {
  const extensionRoot = path.resolve(__dirname, '..');
  const bundledToolsRoot = path.join(extensionRoot, 'resources', 'tools');
  const bundledSqlJsRoot = path.join(extensionRoot, 'node_modules', 'sql.js');
  const toolsRoot = path.join(globalRoot, 'tools');
  ['solomap-memory.cjs', 'solomap-experience.cjs', 'solomap-data-client.cjs'].forEach((fileName) => {
    const targetPath = path.join(toolsRoot, fileName);
    copyBundledFile(path.join(bundledToolsRoot, fileName), targetPath);
  });
  ['package.json', path.join('dist', 'sql-wasm.js'), path.join('dist', 'sql-wasm.wasm')].forEach((relativePath) => {
    copyBundledFile(
      path.join(bundledSqlJsRoot, relativePath),
      path.join(toolsRoot, 'node_modules', 'sql.js', relativePath)
    );
  });
}

export function solomapCsvEscape(value: string | number): string {
  const raw = String(value ?? '');
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export function countMarkdownFiles(dirPath: string): number {
  try {
    return fs.readdirSync(dirPath).filter((name) => name.endsWith('.md') && name !== '_example.md').length;
  } catch {
    return 0;
  }
}

export function appendCsvRecord(filePath: string, header: string, values: Array<string | number>): void {
  writeFileIfMissing(filePath, `${header}\n`);
  fs.appendFileSync(filePath, `${values.map(solomapCsvEscape).join(',')}\n`, 'utf8');
}

export function summarizeLearningEvidence(changedFilesSummary: string, touchedFilesSummary: string, outputTail: string): string {
  return [
    changedFilesSummary ? `- Workspace changes: ${changedFilesSummary.split('\n').filter(Boolean).slice(0, 6).join('; ')}` : '',
    touchedFilesSummary ? `- Touched files: ${touchedFilesSummary.split('\n').filter(Boolean).slice(0, 6).join('; ')}` : '',
    outputTail ? `- Agent output tail was captured in this run.` : ''
  ].filter(Boolean).join('\n') || '- This run completed and updated the SoloMap execution history.';
}

export async function recordSolomapLearningCycle(
  workspaceRoot: string,
  globalDataPath: string,
  node: RoadmapNode | null,
  nextStatus: string,
  changedFilesSummary: string,
  touchedFilesSummary: string,
  outputTail: string,
  runDurationMs: number,
  finishedAt: string
): Promise<void> {
  if (!workspaceRoot || !node || !node.id) return;
  await sendRuntimeDataRequest(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), { operation: 'record_learning_cycle', input: {
    root: workspaceRoot, node, nextStatus, changedFilesSummary, touchedFilesSummary, outputTail, runDurationMs, finishedAt
  } });
}

export async function buildSolomapLearningContext(workspaceRoot: string, globalDataPath = ''): Promise<string> {
  const ledgerSummary = await readLearningOverview(workspaceRoot, globalDataPath);
  return [
    'SoloMap 跨项目学习信号：',
    `- 待审核学习候选：${ledgerSummary.candidateCount}`,
    `- 统一学习账本事件：${ledgerSummary.eventCount}`,
    `- 已确认/已晋升经验：${ledgerSummary.approvedCount + ledgerSummary.promotedCount}`,
    ledgerSummary.projectSignals.length ? `- 最近项目学习信号：${ledgerSummary.projectSignals.slice(0, 4).map((item) => `${item.projectName}: ${item.candidateCount}候选/${item.riskSignals}风险/${item.verificationSignals}验证`).join('；')}` : '',
    '- 如果当前环节属于 Improve / 复盘 / 调整路线图，应优先参考这些信号来提出下一轮路线图调整。'
  ].filter(Boolean).join('\n');
}

export function getSolomapSkillRegistryPath(workspaceRoot: string, globalDataPath = ''): string {
  return 'solomap://capability-registry/skill';
}

export async function ensureBuiltinSolomapSkills(skillsRoot: string, _registryReference: string): Promise<void> {
  const root = path.dirname(skillsRoot);
  const releasedDocuments: Record<string, string> = {
    'solomap-global-execution-guide': '2a1ca770af66743a6f0da83ecda514e827b2b6cc4fcaae16db63d6df750a846c',
    'solomap-cross-project-memory': '1d3a28da490148d5d97c076db45c08d897a659980a24bce9406762fe64a6fd44',
    'solomap-enhancement-installer': '6b772bebbb11719ed66e8a1a9cb6fce214b4732a5ecad71ce0e8f1bc99164736'
  };
  const digest = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
  let snapshot = await refreshCapabilityRegistry(root, 'skill');
  // Historical choices must enter the authority before defaults can be supplied.
  for (const builtin of BUILTIN_SOLOMAP_SKILLS) {
    const version = digest(builtin.skillMd);
    for (;;) {
      const current = snapshot.entries.find(item => item.entry.id === builtin.id);
      if ((!current && snapshot.legacySkillsPending) || current?.entry.status === 'uninstalled') break;
      if (current && (current.entry.source?.type !== 'builtin' || current.entry.source?.owner !== 'solomap')) break;
      const previousPath = path.join(skillsRoot, current?.entry.entry || `installed/${builtin.id}/package/SKILL.md`);
      if (current?.entry.source?.builtinVersion === version && fs.existsSync(previousPath)) break;
      const previous = fs.existsSync(previousPath) ? captureInstallationFiles(root, { previous_entry_document: previousPath }) : [];
      const oldHash = previous.length ? digest(Buffer.from(previous[0].bytes, 'base64')) : undefined;
      // A shipped document may be upgraded; a user's edited document belongs to them.
      if (current && oldHash && oldHash !== version && oldHash !== releasedDocuments[builtin.id]) break;
      const packagePath = oldHash && oldHash !== version
        ? `installed/${builtin.id}/versions/${version}/package`
        : current?.entry.packagePath || `installed/${builtin.id}/package`;
      const packageRoot = path.join(skillsRoot, packagePath), entryPath = path.join(packageRoot, 'SKILL.md');
      // Check every existing ancestor before writing so package paths cannot escape the data root.
      const physicalRoot = fs.realpathSync(root);
      let ancestor = packageRoot;
      while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
      const relative = path.relative(physicalRoot, fs.realpathSync(ancestor));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('builtin_skill_package_path_invalid');
      fs.mkdirSync(packageRoot, { recursive: true });
      try { fs.writeFileSync(entryPath, builtin.skillMd, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const document = captureInstallationFiles(root, { entry_document: entryPath });
      if (digest(Buffer.from(document[0].bytes, 'base64')) !== version) throw new Error('builtin_skill_document_conflict');
      const entry: SolomapSkillRegistryEntry = current ? {
        ...current.entry, id: builtin.id, entry: path.relative(skillsRoot, entryPath).split(path.sep).join('/'), packagePath,
        source: { ...current.entry.source, builtinVersion: version }
      } : {
        id: builtin.id, title: builtin.title, description: builtin.description,
        entry: path.relative(skillsRoot, entryPath).split(path.sep).join('/'), packagePath,
        status: 'installed', defaultCandidate: builtin.defaultCandidate !== false,
        source: { type: 'builtin', owner: 'solomap', builtinVersion: version },
        activation: { keywords: builtin.keywords, useWhen: builtin.useWhen, doNotUseWhen: builtin.doNotUseWhen },
        risk: { hasScripts: false, hasExecutables: false, usesNetwork: false, writesFiles: 'guidance-only', requiresUserApprovalToRunScripts: true },
        installedAt: 'builtin', updatedAt: 'builtin'
      };
      try {
        await sendRuntimeDataRequest(root, { operation: 'patch_capability_registry', input: {
          kind: 'skill', entry, expectedRevision: current?.revision || 0,
          idempotencyKey: `builtin-skill:${builtin.id}:${version}:${current?.revision || 0}`,
          attachments: [...(oldHash !== version ? previous : []), ...document]
        } });
      } catch (error) { if ((error as Error).message !== 'revision_conflict') throw error; }
      snapshot = await refreshCapabilityRegistry(root, 'skill');
    }
  }
}

export async function ensureSolomapSkillStore(workspaceRoot: string, globalDataPath = ''): Promise<{ skillsRoot: string; installedRoot: string; runsRoot: string; registryPath: string }> {
  const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
  const installedRoot = path.join(skillsRoot, 'installed');
  const runsRoot = path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'tmp', 'skill-installs');
  const registryPath = 'solomap://capability-registry/skill';
  fs.mkdirSync(installedRoot, { recursive: true });
  await ensureBuiltinSolomapSkills(skillsRoot, registryPath);
  return { skillsRoot, installedRoot, runsRoot, registryPath };
}

export async function readSolomapSkillRegistry(workspaceRoot: string, globalDataPath = ''): Promise<SolomapSkillRegistry> {
  await ensureSolomapSkillStore(workspaceRoot, globalDataPath);
  await refreshCapabilityRegistry(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'skill');
  return readSolomapSkillRegistrySnapshot(workspaceRoot, globalDataPath);
}

export function readSolomapSkillRegistrySnapshot(workspaceRoot: string, globalDataPath = ''): SolomapSkillRegistry {
  const current = capabilitySnapshot(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'skill');
  return { version: 1, updatedAt: '', skills: current.entries.filter(item => item.entry.status !== 'uninstalled').map(item => item.entry as SolomapSkillRegistryEntry), entryVersions: Object.fromEntries(current.entries.map(item => [item.entry.id, item.revision])) };
}

export async function writeSolomapSkillRegistry(workspaceRoot: string, globalDataPath: string, registry: SolomapSkillRegistry): Promise<void> {
  await ensureSolomapSkillStore(workspaceRoot, globalDataPath);
  await writeCapabilityEntries(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'skill', registry.skills, registry.entryVersions);
}

export function normalizeSkillKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 30);
}

export function scoreSolomapSkill(skill: SolomapSkillRegistryEntry, contextText: string): { score: number; reasons: string[] } {
  if (!skill || skill.status === 'disabled' || skill.status === 'failed') {
    return { score: 0, reasons: [] };
  }
  if (skill.activation?.manualOnly) {
    return { score: 0, reasons: [] };
  }
  if (skill.risk?.hasScripts || skill.risk?.hasExecutables) {
    return { score: 0, reasons: [] };
  }
  const text = contextText.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (skill.defaultCandidate) {
    score += 1;
    reasons.push('default');
  }
  const keywords = normalizeSkillKeywords(skill.activation?.keywords);
  keywords.forEach((keyword) => {
    if (keyword && text.includes(keyword.toLowerCase())) {
      score += 3;
      if (reasons.length < 3) {
        reasons.push(`keyword:${keyword}`);
      }
    }
  });
  normalizeSkillKeywords(skill.activation?.useWhen).forEach((hint) => {
    const hintWords = hint.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((word) => word.length >= 2);
    if (hintWords.some((word) => text.includes(word))) {
      score += 1;
    }
  });
  return { score, reasons };
}

export async function selectSolomapSkillCandidates(workspaceRoot: string, globalDataPath: string, contextText: string, limit = 6): Promise<Array<{ skill: SolomapSkillRegistryEntry; reasons: string[] }>> {
  const registry = await readSolomapSkillRegistry(workspaceRoot, globalDataPath);
  return registry.skills
    .map((skill) => ({ skill, ...scoreSolomapSkill(skill, contextText) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => {
      if (a.skill.defaultCandidate !== b.skill.defaultCandidate) {
        return a.skill.defaultCandidate ? -1 : 1;
      }
      return b.score - a.score;
    })
    .slice(0, limit)
    .map(({ skill, reasons }) => ({ skill, reasons }));
}

export async function buildSolomapSkillCandidateInstructions(workspaceRoot: string, globalDataPath: string, contextText: string): Promise<string> {
  const candidates = await selectSolomapSkillCandidates(workspaceRoot, globalDataPath, contextText, 6);
  if (candidates.length === 0) {
    return '';
  }
  return [
    '本次任务可能相关的 SoloMap 技能候选：',
    ...candidates.map(({ skill, reasons }, index) => {
      const entry = skill.entry || `installed/${skill.id}/package/SKILL.md`;
      const useWhen = normalizeSkillKeywords(skill.activation?.useWhen).slice(0, 3).join('；');
      const doNotUseWhen = normalizeSkillKeywords(skill.activation?.doNotUseWhen).slice(0, 3).join('；');
      const risk = skill.risk?.hasScripts || skill.risk?.hasExecutables
        ? '包含脚本或可执行文件；除非本轮任务明确需要并说明用途与风险，否则只读取说明，不自动执行。'
        : '默认作为说明型能力读取。';
      return [
        `${index + 1}. ${skill.title || skill.id}`,
        `   - 入口：${path.join(getSolomapSkillsRoot(workspaceRoot, globalDataPath), entry)}`,
        `   - 命中原因：${reasons.join(', ') || '任务上下文相关'}`,
        useWhen ? `   - 适用：${useWhen}` : '',
        doNotUseWhen ? `   - 不适用：${doNotUseWhen}` : '',
        `   - 风险：${risk}`
      ].filter(Boolean).join('\n');
    }),
    '技能使用协议：命中的技能必须在执行前判定 used / skipped-not-applicable；判定为 used 的技能必须先读取对应 SKILL.md。不要自行安装新 skill。最终输出中简短列出本轮实际使用的 skill。'
  ].join('\n');
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function listMemoryMarkdownFiles(dirPath: string, limit = 40): string[] {
  try {
    return fs.readdirSync(dirPath)
      .filter((name) => name.endsWith('.md') && name !== '_example.md')
      .map((name) => path.join(dirPath, name))
      .filter(fileExists)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function tokenizeStartupContext(value: string): Set<string> {
  return new Set(String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9_\-/.一-龥]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 120));
}

function scoreMemoryFile(filePath: string, contextTokens: Set<string>): number {
  const baseName = path.basename(filePath).toLowerCase();
  let score = 0;
  for (const token of contextTokens) {
    if (baseName.includes(token)) {
      score += 5;
    }
  }
  try {
    const sample = fs.readFileSync(filePath, 'utf8').slice(0, 6000).toLowerCase();
    for (const token of contextTokens) {
      if (sample.includes(token)) {
        score += 1;
      }
    }
  } catch {
    return score;
  }
  return score;
}

function selectRelevantMemoryFiles(workspaceRoot: string, globalDataPath: string, contextText: string, limit = 8): string[] {
  const memoryRoot = getSolomapMemoryRoot(workspaceRoot, globalDataPath);
  const contextTokens = tokenizeStartupContext(contextText);
  const candidates = [
    ...listMemoryMarkdownFiles(path.join(memoryRoot, 'patterns')),
    ...listMemoryMarkdownFiles(path.join(memoryRoot, 'decisions')),
    ...listMemoryMarkdownFiles(path.join(memoryRoot, 'domains')),
    ...listMemoryMarkdownFiles(path.join(memoryRoot, 'inbox'), 20)
  ];
  return candidates
    .map((filePath) => ({ filePath, score: scoreMemoryFile(filePath, contextTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, limit)
    .map((entry) => entry.filePath);
}

function relativeOrAbsolute(workspaceRoot: string, filePath: string): string {
  const rel = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') ? rel : filePath;
}

export async function buildSolomapStartupPackInstructions(input: {
  workspaceRoot: string;
  globalDataPath?: string;
  runKind: string;
  role?: string;
  contextText: string;
  learningSummaryContext?: string;
  learningRetrievalContext?: string;
  executionExperienceContext?: string;
}): Promise<string> {
  const workspaceRoot = input.workspaceRoot;
  const globalDataPath = input.globalDataPath || '';
  const promotionContext = await buildLearningPromotionContext(workspaceRoot, globalDataPath, 5);
  const requiredReadFiles = [
    path.join(workspaceRoot, 'agent.md')
  ].filter((filePath, index, all) => filePath && all.indexOf(filePath) === index);
  const skillCandidates = await selectSolomapSkillCandidates(workspaceRoot, globalDataPath, input.contextText, 6);
  const skillBlocks = skillCandidates.map(({ skill, reasons }, index) => {
    const entry = skill.entry || `installed/${skill.id}/package/SKILL.md`;
    const entryPath = path.join(getSolomapSkillsRoot(workspaceRoot, globalDataPath), entry);
    const useWhen = normalizeSkillKeywords(skill.activation?.useWhen).slice(0, 3).join('；');
    const doNotUseWhen = normalizeSkillKeywords(skill.activation?.doNotUseWhen).slice(0, 3).join('；');
    return [
      `${index + 1}. ${skill.title || skill.id}`,
      `   - 入口：${entryPath}`,
      `   - 命中原因：${reasons.join(', ') || '任务上下文相关'}`,
      useWhen ? `   - 适用：${useWhen}` : '',
      doNotUseWhen ? `   - 不适用：${doNotUseWhen}` : ''
    ].filter(Boolean).join('\n');
  });
  return [
    'SoloMap 启动包（插件生成，执行前硬门禁）：',
    `- 运行类型：${input.runKind}${input.role ? ` / 角色：${input.role}` : ''}`,
    '- 这是记忆、学习、技能和执行经验的统一入口；不要再另起一套读取、沉淀或晋升机制。',
    '- 在做任何实现、判断、规划、验证或最终回答前，必须先完成本启动包。',
    '- 先读取下列存在的文件；文件不存在时记录为 skipped，不得因此中断主任务：',
    ...requiredReadFiles.map((filePath) => `  - ${relativeOrAbsolute(workspaceRoot, filePath)}`),
    buildAgentDatabaseInstructions(),
    '- 读取后用一句话形成本轮约束：用户目标、必须保留的边界、适用经验、最窄验证。',
    skillBlocks.length
      ? ['- 命中的技能必须逐一判定 used / skipped-not-applicable；判定为 used 的技能必须先读取入口 SKILL.md：', ...skillBlocks].join('\n')
      : '- 本轮没有命中需要读取的 SoloMap 技能；继续按记忆与当前项目事实执行。',
    input.learningSummaryContext ? ['', input.learningSummaryContext].join('\n') : '',
    input.learningRetrievalContext ? ['', input.learningRetrievalContext].join('\n') : '',
    promotionContext ? ['', promotionContext].join('\n') : '',
    input.executionExperienceContext ? ['', input.executionExperienceContext].join('\n') : '',
    '- 本轮经验采用与纠偏通过任务报告记录；候选提炼和晋升由用户手动“复盘经验”处理，不因本次召回自动晋升。',
    '- 经验库只能约束执行方式，不能覆盖本轮用户最新要求、当前代码、测试、日志和命令输出。'
  ].filter(Boolean).join('\n');
}

export function buildSkillInstallPrompt(skillInput: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
  const { maintenanceRoot } = ensureSolomapMaintenanceWorkspace(workspaceRoot, globalDataPath);
  const stagingRoot = path.dirname(resultFilePath);
  return [
    '你正在为 SoloMap 安装一个跨 Agent 通用 skill package。',
    '这是受控安装任务；只能按 SoloMap 指定目录和 schema 落盘，不要安装到各 Agent 自己的全局技能目录作为正式结果。',
    ...buildSystemMaintenancePromptGuard(maintenanceRoot),
    '',
    `用户提供的 skill 来源：${skillInput}`,
    `SoloMap 全局目录：${globalRoot}`,
    `SoloMap 技能目录：${skillsRoot}`,
    `安装结果 JSON：${resultFilePath}`,
    '',
    '目标目录结构：',
    '- `.solomap-global/skills/installed/<skill-id>/package/`：完整 skill package，必须包含入口 `SKILL.md`，并保留 scripts、templates、assets、examples 等同级资源。',
    `- ${path.join(stagingRoot, 'solomap.skill.json')}：本次安装的完整技能元数据，供插件提交到数据库。`,
    `- ${path.join(stagingRoot, 'source.lock.json')}：本次安装的完整来源、commit、原始 skillPath、安装时间和 hash。`,
    '',
    '安装步骤：',
    '1. 解析用户提供的来源。支持 skills.sh URL、GitHub URL、owner/repo、owner/repo@skill、仓库子目录 URL。',
    `2. 下载或克隆来源到 ${path.join(stagingRoot, 'preview')}；使用明确的目标目录参数，不修改 HOME 或用户真实 Agent 技能目录。`,
    '3. 定位目标 skill package 的实际文件夹；不要只复制 `SKILL.md`。',
    '4. 选择稳定 `skill-id`：优先用 SKILL.md frontmatter 的 `name`，否则用目录名；只允许小写字母、数字和连字符。',
    '5. 将完整 package 写入 `.solomap-global/skills/installed/<skill-id>/package/`。',
    `6. 从 SKILL.md 解析 title/name、description、version，在 ${path.join(stagingRoot, 'solomap.skill.json')} 生成元数据；至少包含 id、title、description、entry、packagePath、status、source、activation、risk、installedAt、updatedAt。`,
    '7. 扫描 package，标记风险：是否包含 scripts、可执行文件、网络访问提示、文件写入提示。默认 `requiresUserApprovalToRunScripts=true`。',
    `8. 将完整来源锁写入 ${path.join(stagingRoot, 'source.lock.json')}，不要在实际执行包旁保存第二份元数据。`,
    '9. 写入安装结果 JSON。',
    '',
    '结果 JSON schema：',
    '{',
    '  "ok": true,',
    '  "skillId": "skill-id",',
    '  "installedPath": ".solomap-global/skills/installed/skill-id",',
    '  "packagePath": ".solomap-global/skills/installed/skill-id/package",',
    '  "entryFile": ".solomap-global/skills/installed/skill-id/package/SKILL.md",',
    `  "solomapSkillJson": ${JSON.stringify(path.join(stagingRoot, 'solomap.skill.json'))},`,
    `  "sourceLockJson": ${JSON.stringify(path.join(stagingRoot, 'source.lock.json'))},`,
    '  "metadata": { "name": "skill-id", "description": "...", "version": "..." },',
    '  "source": { "input": "...", "repo": "owner/repo", "commit": "...", "skillPath": "..." },',
    '  "risk": { "hasScripts": false, "hasExecutables": false, "usesNetwork": "unknown", "writesFiles": "unknown", "requiresUserApprovalToRunScripts": true }',
    '}',
    '',
    '如果安装失败，也必须写入结果 JSON：',
    '{ "ok": false, "error": "一句话说明失败原因", "source": { "input": "..." } }',
    '',
    '安全边界：',
    '- 不要删除旧文件或清空目录。',
    '- 不要把 package 安装到 `~/.codex`、`~/.claude`、`~/.agents`、项目源码目录或其他 Agent 私有目录作为正式结果。',
    '- 不要运行 skill package 中的脚本；安装阶段只允许读取、复制、分析。',
    '- 如果来源不清楚或存在多个候选 skill，选择最匹配用户输入的一个；无法判断时写失败结果 JSON，不要猜测安装。',
    '',
    '完成后正常退出 CLI。'
  ].join('\n');
}

export function resolveSkillResultPath(globalRoot: string, value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.join(path.dirname(globalRoot), raw);
}

export function pathInside(parent: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

export async function validateAndRegisterSkillInstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string): Promise<{ ok: boolean; message: string; skillId?: string }> {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
  const installedRoot = path.join(skillsRoot, 'installed');
  if (!fs.existsSync(resultFilePath)) {
    return { ok: false, message: 'Skill install result.json was not created.' };
  }
  let result: any;
  try {
    result = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));
  } catch (error: any) {
    return { ok: false, message: `Skill install result.json is invalid: ${error.message}` };
  }
  if (!result.ok) {
    return { ok: false, message: String(result.error || 'Skill installation failed.') };
  }
  const skillId = sanitizeAttachmentScope(String(result.skillId || result.metadata?.name || '').toLowerCase());
  if (!skillId) {
    return { ok: false, message: 'Skill install result is missing skillId.' };
  }
  const installedPath = resolveSkillResultPath(globalRoot, result.installedPath || path.join(skillsRoot, 'installed', skillId));
  const packagePath = resolveSkillResultPath(globalRoot, result.packagePath || path.join(installedPath, 'package'));
  const entryFile = resolveSkillResultPath(globalRoot, result.entryFile || path.join(packagePath, 'SKILL.md'));
  const solomapSkillJson = resolveSkillResultPath(globalRoot, result.solomapSkillJson || path.join(installedPath, 'solomap.skill.json'));
  const sourceLockJson = resolveSkillResultPath(globalRoot, result.sourceLockJson || path.join(installedPath, 'source.lock.json'));
  if (!pathInside(installedRoot, installedPath)) {
    return { ok: false, message: 'Skill installedPath is outside SoloMap skills/installed.' };
  }
  if (!pathInside(installedPath, packagePath) || !pathInside(packagePath, entryFile)) {
    return { ok: false, message: 'Skill package path is outside the installed skill directory.' };
  }
  if (![entryFile, solomapSkillJson, sourceLockJson].every((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())) {
    return { ok: false, message: 'Skill package is missing SKILL.md, solomap.skill.json, or source.lock.json.' };
  }
  let skillJson: any;
  try {
    skillJson = JSON.parse(fs.readFileSync(solomapSkillJson, 'utf8'));
  } catch (error: any) {
    return { ok: false, message: `solomap.skill.json is invalid: ${error.message}` };
  }
  const entry: SolomapSkillRegistryEntry = {
    id: skillId,
    title: String(skillJson.title || skillJson.name || result.metadata?.name || skillId),
    description: String(skillJson.description || result.metadata?.description || ''),
    entry: path.relative(skillsRoot, entryFile).replace(/\\/g, '/'),
    packagePath: path.relative(skillsRoot, packagePath).replace(/\\/g, '/'),
    status: 'installed',
    source: skillJson.source || result.source || {},
    activation: {
      keywords: normalizeSkillKeywords(skillJson.activation?.keywords),
      useWhen: normalizeSkillKeywords(skillJson.activation?.useWhen),
      doNotUseWhen: normalizeSkillKeywords(skillJson.activation?.doNotUseWhen),
      projectTypes: normalizeSkillKeywords(skillJson.activation?.projectTypes),
      roadmapStages: normalizeSkillKeywords(skillJson.activation?.roadmapStages),
      taskKinds: normalizeSkillKeywords(skillJson.activation?.taskKinds),
      fileGlobs: normalizeSkillKeywords(skillJson.activation?.fileGlobs),
      manualOnly: Boolean(skillJson.activation?.manualOnly)
    },
    risk: {
      hasScripts: Boolean(skillJson.risk?.hasScripts || result.risk?.hasScripts),
      hasExecutables: Boolean(skillJson.risk?.hasExecutables || result.risk?.hasExecutables),
      usesNetwork: skillJson.risk?.usesNetwork ?? result.risk?.usesNetwork ?? 'unknown',
      writesFiles: skillJson.risk?.writesFiles ?? result.risk?.writesFiles ?? 'unknown',
      requiresUserApprovalToRunScripts: skillJson.risk?.requiresUserApprovalToRunScripts !== false
    },
    ...(skillJson.installedAt || result.installedAt ? { installedAt: String(skillJson.installedAt || result.installedAt) } : {}),
    ...(skillJson.updatedAt || result.updatedAt ? { updatedAt: String(skillJson.updatedAt || result.updatedAt) } : {})
  };
  const registry = await readSolomapSkillRegistry(workspaceRoot, globalDataPath);
  const nextSkills = registry.skills.filter((skill) => skill.id !== skillId);
  nextSkills.push(entry);
  await writeCapabilityEntries(globalRoot, 'skill', nextSkills.sort((a, b) => a.id.localeCompare(b.id)), registry.entryVersions, { [skillId]: { result: resultFilePath, manifest: solomapSkillJson, source_lock: sourceLockJson, entry_document: entryFile } });
  return { ok: true, message: `Skill installed: ${skillId}`, skillId };
}

export function getSolomapMcpRegistryPath(workspaceRoot: string, globalDataPath = ''): string {
  return 'solomap://capability-registry/mcp';
}

export function ensureSolomapMcpStore(workspaceRoot: string, globalDataPath = ''): { mcpRoot: string; serversRoot: string; runsRoot: string; profilesRoot: string; registryPath: string } {
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  const serversRoot = path.join(mcpRoot, 'servers');
  const runsRoot = path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'tmp', 'mcp-installs');
  const profilesRoot = path.join(mcpRoot, 'profiles');
  const registryPath = getSolomapMcpRegistryPath(workspaceRoot, globalDataPath);
  [mcpRoot, serversRoot, profilesRoot].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  return { mcpRoot, serversRoot, runsRoot, profilesRoot, registryPath };
}

export async function readSolomapMcpRegistry(workspaceRoot: string, globalDataPath = ''): Promise<SolomapMcpRegistry> {
  await refreshCapabilityRegistry(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'mcp');
  return readSolomapMcpRegistrySnapshot(workspaceRoot, globalDataPath);
}

export function readSolomapMcpRegistrySnapshot(workspaceRoot: string, globalDataPath = ''): SolomapMcpRegistry {
  const current = capabilitySnapshot(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'mcp');
  return { version: 1, updatedAt: '', connectors: current.entries.filter(item => item.entry.status !== 'uninstalled').map(item => item.entry as SolomapMcpRegistryEntry), entryVersions: Object.fromEntries(current.entries.map(item => [item.entry.id, item.revision])) };
}

export async function writeSolomapMcpRegistry(workspaceRoot: string, globalDataPath: string, registry: SolomapMcpRegistry): Promise<void> {
  await writeCapabilityEntries(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'mcp', registry.connectors, registry.entryVersions);
}

export function scoreSolomapMcp(connector: SolomapMcpRegistryEntry, contextText: string): { score: number; reasons: string[] } {
  if (!connector || connector.status === 'disabled' || connector.status === 'failed') {
    return { score: 0, reasons: [] };
  }
  if (
    connector.activation?.manualOnly ||
    connector.permissions?.requiresCredentials ||
    connector.permissions?.writeAccess === true ||
    connector.risk?.requiresExplicitEnable ||
    connector.risk?.canWriteExternal ||
    connector.risk?.canSendMessages ||
    connector.risk?.canModifyCloudResources ||
    connector.risk?.canAccessSecrets
  ) {
    return { score: 0, reasons: [] };
  }
  const haystack = String(contextText || '').toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  normalizeSkillKeywords(connector.activation?.keywords).forEach((keyword) => {
    if (keyword && haystack.includes(keyword.toLowerCase())) {
      score += 4;
      reasons.push(`keyword:${keyword}`);
    }
  });
  normalizeSkillKeywords(connector.activation?.useWhen).forEach((hint) => {
    if (hint && haystack.includes(hint.toLowerCase())) {
      score += 2;
      reasons.push(`useWhen:${hint.slice(0, 28)}`);
    }
  });
  return { score, reasons };
}

export async function selectSolomapMcpCandidates(workspaceRoot: string, globalDataPath: string, contextText: string, limit = 3): Promise<Array<{ connector: SolomapMcpRegistryEntry; reasons: string[] }>> {
  const registry = await readSolomapMcpRegistry(workspaceRoot, globalDataPath);
  return registry.connectors
    .map((connector) => ({ connector, ...scoreSolomapMcp(connector, contextText) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.connector.id.localeCompare(b.connector.id))
    .slice(0, limit)
    .map(({ connector, reasons }) => ({ connector, reasons }));
}

export async function buildSolomapMcpCandidateInstructions(workspaceRoot: string, globalDataPath: string, contextText: string): Promise<string> {
  const candidates = await selectSolomapMcpCandidates(workspaceRoot, globalDataPath, contextText, 3);
  if (!candidates.length) {
    return '';
  }
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  return [
    'SoloMap 跨 Agent MCP 候选连接器：',
    ...candidates.map(({ connector, reasons }, index) => {
      const configPath = connector.configPath ? path.join(mcpRoot, connector.configPath) : '';
      const tools = normalizeSkillKeywords(connector.permissions?.tools).slice(0, 5).join('、') || '-';
      const useWhen = normalizeSkillKeywords(connector.activation?.useWhen).slice(0, 3).join('；');
      const doNotUseWhen = normalizeSkillKeywords(connector.activation?.doNotUseWhen).slice(0, 3).join('；');
      return [
        `${index + 1}. ${connector.title || connector.id}`,
        `   - 能力：${connector.description || '-'}`,
        `   - 配置：${configPath || '-'}`,
        `   - 工具：${tools}`,
        `   - 适用：${useWhen || '-'}`,
        `   - 不适用：${doNotUseWhen || '-'}`,
        `   - 匹配原因：${reasons.join(', ') || '-'}`
      ].join('\n');
    }),
    'MCP 使用协议：这些只是候选能力连接器，不是强制项。只有当任务明确需要外部工具能力时才使用；涉及外部写入、发消息、云资源、密钥或付费动作时必须先停止并要求用户明确授权。不要自行安装、启用或修改 MCP 配置。最终输出中简短说明本轮是否使用了 MCP。'
  ].join('\n');
}

export function buildMcpInstallPrompt(mcpInput: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  const { maintenanceRoot } = ensureSolomapMaintenanceWorkspace(workspaceRoot, globalDataPath);
  const stagingRoot = path.dirname(resultFilePath);
  return [
    '你正在为 SoloMap 安装一个跨 Agent 通用 MCP 能力连接器。',
    ...buildSystemMaintenancePromptGuard(maintenanceRoot),
    '',
    `用户提供的 MCP 来源：${mcpInput}`,
    `SoloMap Global 目录：${globalRoot}`,
    `SoloMap MCP 目录：${mcpRoot}`,
    `安装结果 JSON 必须写入：${resultFilePath}`,
    '',
    '目标目录结构：',
    '- `.solomap-global/mcp/servers/<mcp-id>/package/`：完整 MCP server package 或配置说明。',
    `- ${path.join(stagingRoot, 'solomap.mcp.json')}：本次安装的完整 MCP 元数据，供插件提交到数据库。`,
    `- ${path.join(stagingRoot, 'source.lock.json')}：完整来源、commit、安装时间和 hash。`,
    `- ${path.join(stagingRoot, 'profiles')}：本次安装的 Agent 配置建议，供插件完整提交到数据库。`,
    '',
    '安装要求：',
    '1. 解析来源。支持 GitHub URL、npm package、MCP server 仓库、文档页或用户粘贴的 server 配置片段。',
    '2. 只做下载、复制、分析和生成配置建议；不要启动 MCP server，不要登录外部服务，不要写入任何 Agent 私有配置目录。',
    '3. 选择稳定 `mcp-id`：只允许小写字母、数字和连字符。',
    `4. 在 ${path.join(stagingRoot, 'solomap.mcp.json')} 生成元数据；至少包含 id、title、description、status、source、server、profiles、activation、permissions、risk、installedAt、updatedAt。来源锁写入 ${path.join(stagingRoot, 'source.lock.json')}。`,
    '5. 识别风险：是否需要凭证、是否访问外网、是否可外部写入、是否可发消息、是否可修改云资源、是否可访问密钥；不确定时按高风险处理并设置 `requiresExplicitEnable: true`。',
    `6. 配置建议只写入 ${path.join(stagingRoot, 'profiles')}，不要应用到真实 Agent 配置，不要在实际执行包旁保存第二份元数据。`,
    '',
    '结果 JSON 格式：',
    '{',
    '  "ok": true,',
    '  "mcpId": "mcp-id",',
    '  "installedPath": ".solomap-global/mcp/servers/mcp-id",',
    '  "packagePath": ".solomap-global/mcp/servers/mcp-id/package",',
    `  "solomapMcpJson": ${JSON.stringify(path.join(stagingRoot, 'solomap.mcp.json'))},`,
    `  "sourceLockJson": ${JSON.stringify(path.join(stagingRoot, 'source.lock.json'))},`,
    `  "profilesPath": ${JSON.stringify(path.join(stagingRoot, 'profiles'))},`,
    '  "metadata": { "name": "mcp-id", "description": "...", "version": "..." },',
    '  "source": { "input": "...", "repo": "owner/repo", "commit": "..." },',
    '  "permissions": { "tools": [], "requiresCredentials": false, "externalAccess": "unknown", "writeAccess": "unknown" },',
    '  "risk": { "level": "low|medium|high", "requiresExplicitEnable": true }',
    '}',
    '',
    '失败时也必须写 result.json：',
    '{ "ok": false, "error": "清晰说明失败原因", "source": { "input": "..." } }',
    '',
    '安全边界：不要运行 server，不要写入用户 home 下的 Agent 配置，不要保存明文密钥，不要删除任何已有文件。'
  ].join('\n');
}

export async function validateAndRegisterMcpInstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string): Promise<{ ok: boolean; message: string; mcpId?: string }> {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  const serversRoot = path.join(mcpRoot, 'servers');
  if (!fs.existsSync(resultFilePath)) {
    return { ok: false, message: 'MCP install result.json was not created.' };
  }
  let result: any;
  try {
    result = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));
  } catch (error: any) {
    return { ok: false, message: `MCP install result.json is invalid: ${error.message}` };
  }
  if (!result.ok) {
    return { ok: false, message: String(result.error || 'MCP installation failed.') };
  }
  const mcpId = sanitizeAttachmentScope(String(result.mcpId || result.metadata?.name || '').toLowerCase());
  if (!mcpId) {
    return { ok: false, message: 'MCP install result is missing mcpId.' };
  }
  const installedPath = resolveSkillResultPath(globalRoot, result.installedPath || path.join(mcpRoot, 'servers', mcpId));
  const solomapMcpJson = resolveSkillResultPath(globalRoot, result.solomapMcpJson || path.join(installedPath, 'solomap.mcp.json'));
  const sourceLockJson = resolveSkillResultPath(globalRoot, result.sourceLockJson || path.join(installedPath, 'source.lock.json'));
  const profilesPath = resolveSkillResultPath(globalRoot, result.profilesPath || path.join(installedPath, 'profiles'));
  if (!pathInside(serversRoot, installedPath)) {
    return { ok: false, message: 'MCP installedPath is outside SoloMap mcp/servers.' };
  }
  if (![solomapMcpJson, sourceLockJson].every((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())) {
    return { ok: false, message: 'MCP package is missing solomap.mcp.json or source.lock.json.' };
  }
  let mcpJson: any;
  try {
    mcpJson = JSON.parse(fs.readFileSync(solomapMcpJson, 'utf8'));
  } catch (error: any) {
    return { ok: false, message: `solomap.mcp.json is invalid: ${error.message}` };
  }
  const entry: SolomapMcpRegistryEntry = {
    id: mcpId,
    title: String(mcpJson.title || mcpJson.name || result.metadata?.name || mcpId),
    description: String(mcpJson.description || result.metadata?.description || ''),
    status: String(mcpJson.status || 'installed'),
    source: mcpJson.source || result.source || {},
    serverPath: path.relative(mcpRoot, installedPath).replace(/\\/g, '/'),
    configPath: path.relative(mcpRoot, solomapMcpJson).replace(/\\/g, '/'),
    profiles: mcpJson.profiles || result.profiles || {},
    activation: {
      keywords: normalizeSkillKeywords(mcpJson.activation?.keywords),
      useWhen: normalizeSkillKeywords(mcpJson.activation?.useWhen),
      doNotUseWhen: normalizeSkillKeywords(mcpJson.activation?.doNotUseWhen),
      projectTypes: normalizeSkillKeywords(mcpJson.activation?.projectTypes),
      taskKinds: normalizeSkillKeywords(mcpJson.activation?.taskKinds),
      manualOnly: Boolean(mcpJson.activation?.manualOnly)
    },
    permissions: {
      tools: normalizeSkillKeywords(mcpJson.permissions?.tools || result.permissions?.tools),
      resources: normalizeSkillKeywords(mcpJson.permissions?.resources || result.permissions?.resources),
      prompts: normalizeSkillKeywords(mcpJson.permissions?.prompts || result.permissions?.prompts),
      requiresCredentials: Boolean(mcpJson.permissions?.requiresCredentials || result.permissions?.requiresCredentials),
      credentialRefs: normalizeSkillKeywords(mcpJson.permissions?.credentialRefs || result.permissions?.credentialRefs),
      externalAccess: mcpJson.permissions?.externalAccess ?? result.permissions?.externalAccess ?? 'unknown',
      writeAccess: mcpJson.permissions?.writeAccess ?? result.permissions?.writeAccess ?? 'unknown'
    },
    risk: {
      level: String(mcpJson.risk?.level || result.risk?.level || 'unknown'),
      canWriteExternal: Boolean(mcpJson.risk?.canWriteExternal || result.risk?.canWriteExternal),
      canSendMessages: Boolean(mcpJson.risk?.canSendMessages || result.risk?.canSendMessages),
      canModifyCloudResources: Boolean(mcpJson.risk?.canModifyCloudResources || result.risk?.canModifyCloudResources),
      canAccessSecrets: Boolean(mcpJson.risk?.canAccessSecrets || result.risk?.canAccessSecrets),
      requiresExplicitEnable: Boolean(mcpJson.risk?.requiresExplicitEnable ?? result.risk?.requiresExplicitEnable ?? (mcpJson.permissions?.requiresCredentials || result.permissions?.requiresCredentials))
    },
    ...(mcpJson.installedAt || result.installedAt ? { installedAt: String(mcpJson.installedAt || result.installedAt) } : {}),
    ...(mcpJson.updatedAt || result.updatedAt ? { updatedAt: String(mcpJson.updatedAt || result.updatedAt) } : {})
  };
  if (profilesPath && !pathInside(installedPath, profilesPath) && !pathInside(path.dirname(resultFilePath), profilesPath)) {
    return { ok: false, message: 'MCP profiles path is outside its install or staging directory.' };
  }
  const registry = await readSolomapMcpRegistry(workspaceRoot, globalDataPath);
  const nextConnectors = registry.connectors.filter((connector) => connector.id !== mcpId);
  nextConnectors.push(entry);
  const files: Record<string, string> = { result: resultFilePath, manifest: solomapMcpJson, source_lock: sourceLockJson };
  const collectProfiles = (directory: string): void => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) collectProfiles(file);
      else if (item.isFile()) files[`profile_${Buffer.from(path.relative(profilesPath, file)).toString('hex')}`] = file;
      else throw new Error('capability_attachment_path_invalid');
    }
  };
  if (fs.existsSync(profilesPath)) collectProfiles(profilesPath);
  await writeCapabilityEntries(globalRoot, 'mcp', nextConnectors.sort((a, b) => a.id.localeCompare(b.id)), registry.entryVersions, { [mcpId]: files });
  return { ok: true, message: `MCP connector installed: ${mcpId}`, mcpId };
}

export function getSolomapEnhancementRegistryPath(workspaceRoot: string, globalDataPath = ''): string {
  return 'solomap://capability-registry/enhancement';
}

export function ensureSolomapEnhancementStore(workspaceRoot: string, globalDataPath = ''): { enhancementsRoot: string; installedRoot: string; runsRoot: string; registryPath: string } {
  const enhancementsRoot = getSolomapEnhancementsRoot(workspaceRoot, globalDataPath);
  const installedRoot = path.join(enhancementsRoot, 'installed');
  const runsRoot = path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'tmp', 'enhancement-installs');
  const registryPath = getSolomapEnhancementRegistryPath(workspaceRoot, globalDataPath);
  [enhancementsRoot, installedRoot].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  return { enhancementsRoot, installedRoot, runsRoot, registryPath };
}

export async function readSolomapEnhancementRegistry(workspaceRoot: string, globalDataPath = ''): Promise<SolomapEnhancementRegistry> {
  await refreshCapabilityRegistry(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'enhancement');
  return readSolomapEnhancementRegistrySnapshot(workspaceRoot, globalDataPath);
}

export function readSolomapEnhancementRegistrySnapshot(workspaceRoot: string, globalDataPath = ''): SolomapEnhancementRegistry {
  const current = capabilitySnapshot(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'enhancement');
  return { version: 1, updatedAt: '', enhancements: current.entries.map(item => item.entry as SolomapEnhancementRegistryEntry), entryVersions: Object.fromEntries(current.entries.map(item => [item.entry.id, item.revision])) };
}

export async function writeSolomapEnhancementRegistry(workspaceRoot: string, globalDataPath: string, registry: SolomapEnhancementRegistry): Promise<void> {
  await writeCapabilityEntries(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'enhancement', registry.enhancements, registry.entryVersions);
}

export function isEnhancementUsable(enhancement: SolomapEnhancementRegistryEntry | undefined): boolean {
  if (!enhancement) return false;
  const status = String(enhancement.status || '').toLowerCase();
  if (!['installed', 'available', 'ready'].includes(status)) return false;
  if (enhancement.health && enhancement.health.ok === false) return false;
  return true;
}

export function isEnhancementEnabled(enhancement: SolomapEnhancementRegistryEntry | undefined): boolean {
  return Boolean(enhancement?.enabled) && isEnhancementUsable(enhancement);
}

export function enabledEnhancementIds(enabledEnhancements: Record<string, boolean> = {}): string[] {
  return BUILTIN_SOLOMAP_ENHANCEMENTS
    .map((enhancement) => enhancement.id)
    .filter((id) => Boolean(enabledEnhancements[id]));
}

export function getEnabledEnhancementMap(workspaceRoot: string, globalDataPath = ''): Record<string, boolean> {
  const registry = readSolomapEnhancementRegistrySnapshot(workspaceRoot, globalDataPath);
  return mergeBuiltinSolomapEnhancements(registry.enhancements)
    .filter((enhancement) => BUILTIN_SOLOMAP_ENHANCEMENTS.some((builtin) => builtin.id === enhancement.id))
    .reduce<Record<string, boolean>>((acc, enhancement) => {
      acc[enhancement.id] = isEnhancementEnabled(enhancement);
      return acc;
    }, {});
}

export function statusLabelForEnhancement(status: string, installed: boolean, enabled = false): string {
  const normalized = String(status || '').toLowerCase();
  if (enabled) return '已启用';
  if (installed) return '已安装';
  if (normalized === 'installing') return '安装中';
  if (normalized === 'failed') return '需要修复';
  if (normalized === 'checking') return '检测中';
  if (normalized === 'unavailable') return '检测失败';
  if (normalized === 'disabled') return '已禁用';
  if (normalized === 'uninstalled') return '未安装';
  return '未安装';
}

export function getSolomapEnhancementStatusSummaries(workspaceRoot: string, globalDataPath = ''): SolomapEnhancementStatusSummary[] {
  const registry = readSolomapEnhancementRegistrySnapshot(workspaceRoot, globalDataPath);
  return mergeBuiltinSolomapEnhancements(registry.enhancements).map((enhancement) => {
    const installed = isEnhancementUsable(enhancement);
    const enabled = isEnhancementEnabled(enhancement);
    const status = String(enhancement.status || (installed ? 'installed' : 'not_installed'));
    const version = String(enhancement.health?.version || enhancement.version || enhancement.source?.version || enhancement.source?.commit || '').trim();
    return {
      id: enhancement.id,
      title: enhancement.title || enhancement.id,
      description: enhancement.description || enhancement.benefit || '',
      status,
      statusLabel: statusLabelForEnhancement(status, installed, enabled),
      version: version || (installed ? '版本未知' : '未安装'),
      installed,
      enabled,
      action: installed ? 'check' : 'install',
      message: String(enhancement.health?.message || enhancement.benefit || ''),
      updatedAt: String(enhancement.lastCheckedAt || enhancement.updatedAt || enhancement.installedAt || '')
    };
  }).filter((summary) => BUILTIN_SOLOMAP_ENHANCEMENTS.some((builtin) => builtin.id === summary.id));
}

export async function refreshSolomapEnhancementStatusSummaries(workspaceRoot: string, globalDataPath = ''): Promise<SolomapEnhancementStatusSummary[]> {
  const registry = await readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  const byId = new Map(registry.enhancements.map((enhancement) => [enhancement.id, enhancement]));
  for (const builtin of BUILTIN_SOLOMAP_ENHANCEMENTS) {
    const currentStatus = String(byId.get(builtin.id)?.status || '').toLowerCase();
    if (currentStatus === 'installing' || currentStatus === 'uninstalling' || currentStatus === 'uninstalled') {
      continue;
    }
    await checkAndRegisterEnhancement(workspaceRoot, globalDataPath, builtin.id);
  }
  return getSolomapEnhancementStatusSummaries(workspaceRoot, globalDataPath);
}

export function readJsonFileIfExists(filePath: string): any {
  try {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function isKnownEnhancementVersion(value: unknown): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return Boolean(normalized && !['版本未知', 'unknown', 'unknown version', 'version unknown', '未安装'].includes(normalized));
}

export function chooseEnhancementVersion(...values: unknown[]): string {
  for (const value of values) {
    if (isKnownEnhancementVersion(value)) {
      return String(value).trim();
    }
  }
  return '';
}

export function buildRtkCommandWrapper(commandName: string): string {
  return [
    '#!/usr/bin/env bash',
    'set -e',
    `cmd=${shellQuote(commandName)}`,
    'self_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'path_without_self="$(printf "%s" "$PATH" | awk -v RS=: -v ORS=: -v self="$self_dir" \'$0 != self && $0 != "" { print }\')"',
    'path_without_self="${path_without_self%:}"',
    'original="$(PATH="$path_without_self" command -v "$cmd" || true)"',
    'if [ "${SOLOMAP_RTK_BYPASS:-}" = "1" ]; then',
    '  if [ -n "$original" ]; then exec "$original" "$@"; fi',
    '  echo "SoloMap enhancement raw bypass failed: original command not found: $cmd" >&2',
    '  exit 127',
    'fi',
    'if PATH="$path_without_self" command -v rtk >/dev/null 2>&1 && PATH="$path_without_self" rtk gain >/dev/null 2>&1; then',
    '  exec rtk "$cmd" "$@"',
    'fi',
    'if [ -n "$original" ]; then',
    '  exec "$original" "$@"',
    'fi',
    'echo "SoloMap enhancement fallback failed: original command not found: $cmd" >&2',
    'exit 127',
    ''
  ].join('\n');
}

export function ensureSolomapEnhancementRuntime(
  workspaceRoot: string,
  globalDataPath: string,
  enabledEnhancements: Record<string, boolean> = {}
): { envLines: string[]; preflightLines: string[]; runtimeRoot: string; binRoot: string } {
  const runtimeRoot = getSolomapEnhancementRuntimeRoot(workspaceRoot, globalDataPath);
  const binRoot = path.join(runtimeRoot, 'bin');
  if (!enabledEnhancementIds(enabledEnhancements).length) {
    return { envLines: [], preflightLines: [], runtimeRoot, binRoot };
  }
  fs.mkdirSync(binRoot, { recursive: true });

  const envLines: string[] = [
    `export SOLOMAP_ENHANCEMENTS_ROOT=${shellQuote(getSolomapEnhancementsRoot(workspaceRoot, globalDataPath))}`
  ];
  const preflightLines: string[] = [];

  if (enabledEnhancements['command-output-optimizer']) {
    SOLOMAP_RTK_WRAPPED_COMMANDS.forEach((commandName) => {
      const wrapperPath = path.join(binRoot, commandName);
      fs.writeFileSync(wrapperPath, buildRtkCommandWrapper(commandName), { encoding: 'utf8', mode: 0o755 });
    });
    envLines.push(`export PATH=${shellQuote(binRoot)}:"$PATH"`);
    envLines.push('export SOLOMAP_RTK_OUTPUT_OPTIMIZER=1');
  }

  if (enabledEnhancements['code-structure-assistant']) {
    preflightLines.push([
      'if command -v codegraph >/dev/null 2>&1; then',
      '  if [ -d .git ]; then mkdir -p .git/info; grep -qxF ".codegraph/" .git/info/exclude 2>/dev/null || printf "\\n.codegraph/\\n" >> .git/info/exclude; fi',
      'fi'
    ].join('\n'));
  }

  return { envLines, preflightLines, runtimeRoot, binRoot };
}

export function buildSolomapEnhancementContextPreflight(
  workspaceRoot: string,
  contextFilePath: string,
  userMessage: string,
  runtimeRoot: string,
  enabledEnhancements: Record<string, boolean> = {}
): string[] {
  if (!enabledEnhancementIds(enabledEnhancements).length) {
    return [];
  }
  const contextSearch = String(userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const lines = [
    `enhancement_context_file=${shellQuote(contextFilePath)}`,
    `mkdir -p ${shellQuote(path.dirname(contextFilePath))} ${shellQuote(runtimeRoot)}`,
    '{',
    '  echo "# SoloMap Harness Enhancement Context"',
    '  echo ""',
    `  echo "Generated at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
    '  echo ""',
    enabledEnhancements['command-output-optimizer'] ? [
      '  echo "## Command Output Optimizer"',
      '  if command -v rtk >/dev/null 2>&1 && rtk gain >/dev/null 2>&1; then',
      '    echo "- Status: available; common shell commands are routed through rtk wrappers."',
      '  else',
      '    echo "- Status: unavailable; wrappers will fall back to original commands."',
      '  fi',
      '  echo "- Raw evidence bypass: prefix critical commands with SOLOMAP_RTK_BYPASS=1."',
      '  echo ""'
    ].join('\n') : [
      '  echo "## Command Output Optimizer"',
      '  echo "- Status: disabled."',
      '  echo ""'
    ].join('\n'),
    enabledEnhancements['code-structure-assistant'] ? [
      '  echo "## CodeGraph"',
      '  solomap_enhancement_timeout() { if command -v timeout >/dev/null 2>&1; then timeout 6s "$@"; else "$@"; fi; }',
      '  if command -v codegraph >/dev/null 2>&1; then',
      '    echo "### Status"',
      '    solomap_enhancement_timeout codegraph status . 2>&1 | head -n 80 || true',
      '    echo ""',
      contextSearch ? [
        '    echo "### Task Search"',
        `    solomap_enhancement_timeout codegraph query ${shellQuote(contextSearch)} --limit 8 2>&1 | head -n 120 || true`,
        '    echo ""'
      ].join('\n') : '',
      '    echo "### Indexed Files"',
      '    solomap_enhancement_timeout codegraph files . --format tree --max-depth 3 2>&1 | head -n 120 || true',
      '    echo ""',
      '    if [ -d .git ]; then',
      '      echo "### Affected Tests From Current Diff"',
      '      SOLOMAP_RTK_BYPASS=1 git diff --name-only HEAD 2>/dev/null | solomap_enhancement_timeout codegraph affected --stdin --quiet 2>&1 | head -n 80 || true',
      '      echo ""',
      '    fi',
      '  else',
      '    echo "- Status: unavailable; use direct file search and tests."',
      '    echo ""',
      '  fi'
    ].filter(Boolean).join('\n') : [
      '  echo "## CodeGraph"',
      '  echo "- Status: disabled."',
      '  echo ""'
    ].join('\n'),
    enabledEnhancements['mcp-description-compressor'] ? [
      '  echo "## MCP Description Compressor"',
      '  if command -v caveman >/dev/null 2>&1; then',
      '    caveman --version 2>&1 | head -n 5 || true',
      '    echo "- Status: caveman command available; MCP shrink profile may be active depending on agent profile."',
      '  else',
      '    echo "- Status: setup-managed; verify MCP shrink through the active agent MCP tool list when needed."',
      '  fi',
      '  echo "- Scope: compresses MCP catalog descriptions only; tool call results and schemas remain evidence-critical."',
      '  echo ""'
    ].join('\n') : [
      '  echo "## MCP Description Compressor"',
      '  echo "- Status: disabled."',
      '  echo ""'
    ].join('\n'),
    `} > ${shellQuote(contextFilePath)} 2>> ${shellQuote(path.join(runtimeRoot, 'enhancement-context.log'))} || true`
  ];
  return [lines.filter(Boolean).join('\n')];
}

export function buildSolomapEnhancementRuntimeInstructions(contextFilePath: string, enabledEnhancements: Record<string, boolean> = {}): string {
  if (!enabledEnhancementIds(enabledEnhancements).length) {
    return '';
  }
  const instructions = [
    'SoloMap Harness 增强运行时：',
    `- 本轮增强上下文文件：${contextFilePath}`,
    '- 如果该文件存在，先读取它，再决定是否使用增强结果；它包含 CodeGraph 状态、任务搜索、索引文件概览、受影响测试和增强健康状态。',
    '- 增强结果只用于减少探索成本和定位候选；最终判断仍以当前文件、原始日志、测试和用户最新要求为准。',
    '- 如需关键原始命令输出，使用 `SOLOMAP_RTK_BYPASS=1 <command>` 旁路 rtk wrapper。',
    '- 如 CodeGraph 可用，代码结构、调用关系、影响范围和受影响测试优先参考 CodeGraph；但修改前后仍要读取真实文件并运行最窄验证。',
    '- 如 MCP 描述压缩启用，只把它视为工具目录减噪能力；不要因为描述变短而跳过参数、权限或写入风险判断。'
  ];
  return instructions.join('\n');
}

export function scoreSolomapEnhancement(enhancement: SolomapEnhancementRegistryEntry, contextText: string): { score: number; reasons: string[] } {
  if (!isEnhancementUsable(enhancement)) {
    return { score: 0, reasons: [] };
  }
  if (
    enhancement.activation?.manualOnly ||
    enhancement.risk?.requiresExplicitEnable ||
    enhancement.risk?.canWriteExternal ||
    enhancement.risk?.canAccessSecrets ||
    enhancement.risk?.modifiesAgentConfig ||
    enhancement.risk?.startsBackgroundService
  ) {
    return { score: 0, reasons: [] };
  }
  const haystack = String(contextText || '').toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  normalizeSkillKeywords(enhancement.activation?.keywords).forEach((keyword) => {
    if (keyword && haystack.includes(keyword.toLowerCase())) {
      score += 4;
      reasons.push(`keyword:${keyword}`);
    }
  });
  normalizeSkillKeywords(enhancement.activation?.useWhen).forEach((hint) => {
    if (hint && haystack.includes(hint.toLowerCase())) {
      score += 2;
      reasons.push(`useWhen:${hint.slice(0, 28)}`);
    }
  });
  return { score, reasons };
}

export function mergeBuiltinSolomapEnhancements(
  registryEnhancements: SolomapEnhancementRegistryEntry[],
  enabledEnhancements: Record<string, boolean> = {}
): SolomapEnhancementRegistryEntry[] {
  const merged = new Map<string, SolomapEnhancementRegistryEntry>();
  (registryEnhancements || []).forEach((enhancement) => {
    if (enhancement?.id) {
      merged.set(enhancement.id, enhancement);
    }
  });
  BUILTIN_SOLOMAP_ENHANCEMENTS.forEach((builtin) => {
    const existing: Partial<SolomapEnhancementRegistryEntry> = merged.get(builtin.id) || {};
    const legacyEnabled = Boolean(enabledEnhancements[builtin.id]);
    const existingStatus = String(existing.status || '').trim();
    merged.set(builtin.id, {
      ...builtin,
      ...existing,
      source: { ...(builtin.source || {}), ...(existing.source || {}), curated: true },
      adapter: { ...(builtin.adapter || {}), ...(existing.adapter || {}) },
      activation: { ...(builtin.activation || {}), ...(existing.activation || {}) },
      risk: { ...(builtin.risk || {}), ...(existing.risk || {}) },
      evidencePolicy: { ...(builtin.evidencePolicy || {}), ...(existing.evidencePolicy || {}) },
      status: existingStatus || (legacyEnabled ? 'installed' : 'not_installed')
    });
  });
  return Array.from(merged.values());
}

export async function selectSolomapEnhancementCandidates(
  workspaceRoot: string,
  globalDataPath: string,
  contextText: string,
  limit = 3,
  enabledEnhancements: Record<string, boolean> = {}
): Promise<Array<{ enhancement: SolomapEnhancementRegistryEntry; reasons: string[] }>> {
  const registry = await readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  return mergeBuiltinSolomapEnhancements(registry.enhancements, enabledEnhancements)
    .filter((enhancement) => Boolean(enabledEnhancements[enhancement.id]))
    .map((enhancement) => ({ enhancement, ...scoreSolomapEnhancement(enhancement, contextText) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.enhancement.id.localeCompare(b.enhancement.id))
    .slice(0, limit)
    .map(({ enhancement, reasons }) => ({ enhancement, reasons }));
}

export async function buildSolomapEnhancementCandidateInstructions(
  workspaceRoot: string,
  globalDataPath: string,
  contextText: string,
  enabledEnhancements: Record<string, boolean> = {}
): Promise<string> {
  const candidates = await selectSolomapEnhancementCandidates(workspaceRoot, globalDataPath, contextText, 3, enabledEnhancements);
  if (!candidates.length) {
    return '';
  }
  const enhancementsRoot = getSolomapEnhancementsRoot(workspaceRoot, globalDataPath);
  return [
    'SoloMap Harness 增强能力候选：',
    ...candidates.map(({ enhancement, reasons }, index) => {
      const configPath = enhancement.configPath ? path.join(enhancementsRoot, enhancement.configPath) : '';
      const adapterType = enhancement.adapter?.type || 'unknown';
      const adapterRuntime = enhancement.adapter?.runtime ? ` / ${enhancement.adapter.runtime}` : '';
      const useWhen = normalizeSkillKeywords(enhancement.activation?.useWhen).slice(0, 3).join('；');
      const doNotUseWhen = normalizeSkillKeywords(enhancement.activation?.doNotUseWhen).slice(0, 3).join('；');
      const mustReadRawWhen = normalizeSkillKeywords(enhancement.evidencePolicy?.mustReadRawWhen).slice(0, 3).join('；');
      return [
        `${index + 1}. ${enhancement.title || enhancement.id}`,
        `   - 能力：${enhancement.description || enhancement.capability || '-'}`,
        `   - 收益：${enhancement.benefit || '-'}`,
        `   - 接入：${adapterType}${adapterRuntime}${configPath ? ` (${configPath})` : ''}`,
        `   - 适用：${useWhen || '-'}`,
        `   - 不适用：${doNotUseWhen || '-'}`,
        `   - 原始证据要求：${mustReadRawWhen || '关键判断必须回看当前文件、日志或测试输出'}`,
        `   - 匹配原因：${reasons.join(', ') || '-'}`
      ].join('\n');
    }),
    '增强能力使用协议：这些只是可选增强，不是强制工具。adapter 类型只是实现细节，不要把它暴露成用户需要理解的新入口；不要自行安装、启用或修改外部配置。增强结果不能替代当前文件、日志、测试和用户最新证据；遇到压缩、摘要、索引、命令改写或外部读取结果时，关键判断必须回看原始证据。增强失败时回退到原始执行路径，并在最终输出中简短说明本轮实际使用的增强能力。'
  ].join('\n');
}

export function getBuiltinEnhancementDefinition(enhancementId: string): BuiltinSolomapEnhancementDefinition | undefined {
  return BUILTIN_SOLOMAP_ENHANCEMENTS.find((enhancement) => enhancement.id === enhancementId);
}

export function buildEnhancementInstallPrompt(enhancementId: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string): string {
  const enhancement = getBuiltinEnhancementDefinition(enhancementId);
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const enhancementsRoot = getSolomapEnhancementsRoot(workspaceRoot, globalDataPath);
  const { maintenanceRoot } = ensureSolomapMaintenanceWorkspace(workspaceRoot, globalDataPath);
  const installedPath = path.join(enhancementsRoot, 'installed', enhancementId);
  const installerEntry = capabilitySnapshot(globalRoot, 'skill').entries.find(item => item.entry.id === 'solomap-enhancement-installer')?.entry.entry;
  const installerInstructions = installerEntry
    ? path.join(getSolomapSkillsRoot(workspaceRoot, globalDataPath), installerEntry)
    : BUILTIN_SOLOMAP_SKILLS.find(skill => skill.id === 'solomap-enhancement-installer')!.skillMd;
  const stagingRoot = path.dirname(resultFilePath);
  return [
    '你正在为 SoloMap 安装一个受管执行增强。',
    ...buildSystemMaintenancePromptGuard(maintenanceRoot),
    installerEntry ? '请先读取并遵守这个安装 skill：' : '请遵守以下安装 skill：',
    installerInstructions,
    '',
    `请求安装的增强 ID：${enhancementId}`,
    `增强名称：${enhancement?.title || enhancementId}`,
    `增强说明：${enhancement?.description || ''}`,
    `SoloMap 全局目录：${globalRoot}`,
    `SoloMap 增强目录：${enhancementsRoot}`,
    `目标安装目录：${installedPath}`,
    `安装结果 JSON 必须写入：${resultFilePath}`,
    `本次 manifest、source lock、health 只能写入 ${stagingRoot}，不得在执行包旁新增永久元数据。`,
    '',
    '结果 JSON 格式：',
    JSON.stringify({ ok: true, enhancementId, installedPath, solomapEnhancementJson: path.join(stagingRoot, 'solomap.enhancement.json'), sourceLockJson: path.join(stagingRoot, 'source.lock.json'), healthJson: path.join(stagingRoot, 'health.json'), metadata: { name: enhancement?.title || enhancementId, version: '' }, health: { ok: true, version: '', message: '' } }, null, 2),
    '',
    '该增强的 SoloMap manifest 基线：',
    JSON.stringify(enhancement || {}, null, 2),
    '',
    '安装边界：',
    '- 只安装或修复本次请求的增强。',
    '- 不要删除已有文件、不要清空目录、不要重写无关 Agent 配置。',
    '- 如果安装器会修改 Agent 配置，必须在 health.json/result.json 里列出 touched config files 和风险提示。',
    '- 安装完成后必须做本机可用性检测并写入版本；如果命令本身不输出版本，要从包管理器、包元数据、source lock、可用性检测对应包或上游 commit 推导版本。',
    '- `health.version` 是设置页显示的准确信息；只要包或来源能确认版本，就不要把顶层版本写成“版本未知”。',
    '- 修复或重新检测时保留已有 manifest、source lock 和已知版本；只有更强的新证据才能覆盖旧值。',
    '- 如果出现部分成功、中途失败或配置失败，result.json 必须如实写 ok=false 或 health.ok=false。',
    '',
    '完成后正常退出 CLI。'
  ].join('\n');
}

export function buildEnhancementUninstallPrompt(enhancementId: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string): string {
  const enhancement = getBuiltinEnhancementDefinition(enhancementId);
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const enhancementsRoot = getSolomapEnhancementsRoot(workspaceRoot, globalDataPath);
  const { maintenanceRoot } = ensureSolomapMaintenanceWorkspace(workspaceRoot, globalDataPath);
  const installedPath = path.join(enhancementsRoot, 'installed', enhancementId);
  const installerEntry = capabilitySnapshot(globalRoot, 'skill').entries.find(item => item.entry.id === 'solomap-enhancement-installer')?.entry.entry;
  const installerInstructions = installerEntry
    ? path.join(getSolomapSkillsRoot(workspaceRoot, globalDataPath), installerEntry)
    : BUILTIN_SOLOMAP_SKILLS.find(skill => skill.id === 'solomap-enhancement-installer')!.skillMd;
  return [
    '你正在为 SoloMap 卸载一个受管执行增强。',
    ...buildSystemMaintenancePromptGuard(maintenanceRoot),
    installerEntry ? '请先读取并遵守这个安装/卸载 skill：' : '请遵守以下安装/卸载 skill：',
    installerInstructions,
    '',
    `请求卸载的增强 ID：${enhancementId}`,
    `增强名称：${enhancement?.title || enhancementId}`,
    `增强说明：${enhancement?.description || ''}`,
    `SoloMap 全局目录：${globalRoot}`,
    `SoloMap 增强目录：${enhancementsRoot}`,
    `当前安装目录：${installedPath}`,
    `卸载结果 JSON 必须写入：${resultFilePath}`,
    '',
    '该增强的 SoloMap manifest 基线：',
    JSON.stringify(enhancement || {}, null, 2),
    '',
    '卸载边界：',
    '- 只卸载本次请求的增强。',
    '- 目标是从用户环境中彻底移除该增强的命令、包、hook、wrapper、profile、Agent 配置引用和 SoloMap 运行时接入；不要只改 registry 或状态字段。',
    '- 不要清空目录、不要删除无关文件、不要重写无关 Agent 配置。',
    '- 如果某个外部安装器提供官方 uninstall 命令，优先使用官方卸载路径；没有官方路径时，只移除可证明属于该增强的文件或配置片段。',
    '- result.json 必须写入 ok、enhancementId、removedItems、remainingItems、health 和 message；若仍有残留，ok=false 或 health.ok=false，并说明需要用户授权的残留项。',
    '',
    '完成后正常退出 CLI。'
  ].join('\n');
}

export function resolveEnhancementResultPath(globalRoot: string, value: string): string {
  return resolveSkillResultPath(globalRoot, value);
}

export async function validateAndRegisterEnhancementInstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string): Promise<{ ok: boolean; message: string; enhancementId?: string }> {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const { enhancementsRoot, installedRoot } = ensureSolomapEnhancementStore(workspaceRoot, globalDataPath);
  if (!fs.existsSync(resultFilePath)) {
    return { ok: false, message: '增强安装结果 result.json 未生成。' };
  }
  let result: any;
  try {
    result = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));
  } catch (error: any) {
    return { ok: false, message: `增强安装结果 JSON 无效：${error.message}` };
  }
  const enhancementId = sanitizeAttachmentScope(String(result.enhancementId || result.id || '').toLowerCase());
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!enhancementId || !builtin) {
    return { ok: false, message: '增强安装结果缺少有效的 enhancementId。' };
  }
  if (!result.ok || result.health?.ok === false) {
    await upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, {
      ...builtin,
      status: 'failed',
      version: String(result.metadata?.version || result.health?.version || ''),
      health: { ok: false, message: String(result.error || result.health?.message || '安装失败。'), version: String(result.health?.version || result.metadata?.version || '') },
      lastCheckedAt: new Date().toISOString()
    });
    return { ok: false, message: String(result.error || result.health?.message || '增强安装失败。'), enhancementId };
  }
  const installedPath = resolveEnhancementResultPath(globalRoot, result.installedPath || path.join(enhancementsRoot, 'installed', enhancementId));
  const solomapEnhancementJson = resolveEnhancementResultPath(globalRoot, result.solomapEnhancementJson || path.join(installedPath, 'solomap.enhancement.json'));
  const sourceLockJson = resolveEnhancementResultPath(globalRoot, result.sourceLockJson || path.join(installedPath, 'source.lock.json'));
  const healthJson = resolveEnhancementResultPath(globalRoot, result.healthJson || path.join(installedPath, 'health.json'));
  if (!pathInside(installedRoot, installedPath)) {
    return { ok: false, message: '增强 installedPath 不在 SoloMap enhancements/installed 目录内。', enhancementId };
  }
  if (![solomapEnhancementJson, sourceLockJson, healthJson].every((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())) {
    return { ok: false, message: '增强安装缺少 solomap.enhancement.json、source.lock.json 或 health.json。', enhancementId };
  }
  let enhancementJson: any;
  let health: any;
  try {
    enhancementJson = JSON.parse(fs.readFileSync(solomapEnhancementJson, 'utf8'));
    health = JSON.parse(fs.readFileSync(healthJson, 'utf8'));
  } catch (error: any) {
    return { ok: false, message: `增强 manifest 或 health JSON 无效：${error.message}`, enhancementId };
  }
  const version = String(health.version || enhancementJson.version || result.health?.version || result.metadata?.version || '').trim();
  const registry = await readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  const existingEntry = registry.enhancements.find((enhancement) => enhancement.id === enhancementId);
  const entry: SolomapEnhancementRegistryEntry = {
    ...builtin,
    ...enhancementJson,
    id: enhancementId,
    title: String(enhancementJson.title || builtin.title),
    description: String(enhancementJson.description || builtin.description),
    status: health.ok === false ? 'failed' : 'installed',
    enabled: health.ok !== false,
    version,
    source: enhancementJson.source || result.source || builtin.source || {},
    installedPath: path.relative(enhancementsRoot, installedPath).replace(/\\/g, '/'),
    configPath: path.relative(enhancementsRoot, solomapEnhancementJson).replace(/\\/g, '/'),
    adapter: { ...(builtin.adapter || {}), ...(enhancementJson.adapter || {}) },
    activation: { ...(builtin.activation || {}), ...(enhancementJson.activation || {}) },
    risk: { ...(builtin.risk || {}), ...(enhancementJson.risk || {}) },
    evidencePolicy: { ...(builtin.evidencePolicy || {}), ...(enhancementJson.evidencePolicy || {}) },
    ...(enhancementJson.installedAt || result.installedAt ? { installedAt: String(enhancementJson.installedAt || result.installedAt) } : {}),
    ...(enhancementJson.updatedAt || result.updatedAt ? { updatedAt: String(enhancementJson.updatedAt || result.updatedAt) } : {}),
    ...(health.lastCheckedAt ? { lastCheckedAt: String(health.lastCheckedAt) } : {}),
    health: {
      ok: health.ok !== false,
      message: String(health.message || result.health?.message || '可用'),
      version
    }
  };
  const nextEnhancements = registry.enhancements.filter((enhancement) => enhancement.id !== enhancementId);
  nextEnhancements.push(entry);
  await writeCapabilityEntries(globalRoot, 'enhancement', nextEnhancements.sort((a, b) => a.id.localeCompare(b.id)), registry.entryVersions, { [enhancementId]: { result: resultFilePath, manifest: solomapEnhancementJson, source_lock: sourceLockJson, health: healthJson } });
  return { ok: true, message: `执行增强已安装：${entry.title}（${version || '版本未知'}）`, enhancementId };
}

export async function validateAndRegisterEnhancementUninstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string): Promise<{ ok: boolean; message: string; enhancementId?: string }> {
  if (!fs.existsSync(resultFilePath)) {
    return { ok: false, message: '增强卸载结果 result.json 未生成。' };
  }
  let result: any;
  try {
    result = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));
  } catch (error: any) {
    return { ok: false, message: `增强卸载结果 JSON 无效：${error.message}` };
  }
  const enhancementId = sanitizeAttachmentScope(String(result.enhancementId || result.id || '').toLowerCase());
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!enhancementId || !builtin) {
    return { ok: false, message: '增强卸载结果缺少有效的 enhancementId。' };
  }
  if (!result.ok || result.health?.ok === false) {
    const message = String(result.error || result.health?.message || result.message || '增强卸载未完成。');
    await upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, {
      ...builtin,
      status: 'failed',
      enabled: false,
      updatedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      health: {
        ok: false,
        message,
        version: String(result.health?.version || result.metadata?.version || '')
      }
    });
    return { ok: false, message, enhancementId };
  }
  const resultMessage = String(result.message || result.health?.message || '已从用户环境中卸载。');
  const registryResult = await uninstallSolomapEnhancement(workspaceRoot, globalDataPath, enhancementId, resultMessage);
  return { ...registryResult, message: `执行增强已卸载：${builtin.title}` };
}

export async function upsertEnhancementRegistryEntry(workspaceRoot: string, globalDataPath: string, entry: SolomapEnhancementRegistryEntry, expectedRevision?: number): Promise<void> {
  const registry = await readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  const nextEnhancements = registry.enhancements.filter((enhancement) => enhancement.id !== entry.id);
  nextEnhancements.push(entry);
  await writeSolomapEnhancementRegistry(workspaceRoot, globalDataPath, { ...registry,
    entryVersions: { ...registry.entryVersions, ...(expectedRevision === undefined ? {} : { [entry.id]: expectedRevision }) },
    enhancements: nextEnhancements.sort((a, b) => a.id.localeCompare(b.id)) });
}

export function runEnhancementCheckCommand(enhancementId: string, workspaceRoot: string): { ok: boolean; version: string; message: string } {
  const commands: Record<string, string> = {
    'command-output-optimizer': 'command -v rtk >/dev/null 2>&1 && (rtk --version 2>/dev/null || rtk gain 2>/dev/null | head -n 1)',
    'code-structure-assistant': 'command -v codegraph >/dev/null 2>&1 && (codegraph --version 2>/dev/null || codegraph status . 2>/dev/null | head -n 1)',
    'mcp-description-compressor': [
      'if command -v caveman-shrink >/dev/null 2>&1; then',
      '  (npm list -g caveman-shrink --depth=0 2>/dev/null | sed -n "s/.*caveman-shrink@//p" | head -n 1) || caveman-shrink --version 2>/dev/null | head -n 1 || true;',
      'elif npm list -g caveman-shrink --depth=0 >/dev/null 2>&1; then',
      '  npm list -g caveman-shrink --depth=0 2>/dev/null | sed -n "s/.*caveman-shrink@//p" | head -n 1;',
      'elif command -v caveman >/dev/null 2>&1; then',
      '  caveman --version 2>/dev/null | head -n 1 || true;',
      'else',
      '  exit 1;',
      'fi'
    ].join(' ')
  };
  const command = commands[enhancementId];
  if (!command) {
    return { ok: false, version: '', message: '未知增强。' };
  }
  try {
    const output = childProcess.execFileSync('bash', ['-lc', command], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    return { ok: true, version: extractVersionText(output), message: output || '检测通过。' };
  } catch (error: any) {
    const stderr = String(error?.stderr || error?.message || '').trim();
    return { ok: false, version: '', message: stderr || '未检测到可用安装。' };
  }
}

export function extractVersionText(output: string): string {
  const text = String(output || '').replace(/\s+/g, ' ').trim();
  const match = text.match(/\b(v?\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?)/i);
  return match ? match[1] : (text ? '版本未知' : '');
}

export async function checkAndRegisterEnhancement(workspaceRoot: string, globalDataPath: string, enhancementId: string): Promise<{ ok: boolean; message: string; enhancementId?: string }> {
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!builtin) {
    return { ok: false, message: '未知执行增强。' };
  }
  const check = runEnhancementCheckCommand(enhancementId, workspaceRoot);
  const now = new Date().toISOString();
  const { enhancementsRoot, installedRoot } = ensureSolomapEnhancementStore(workspaceRoot, globalDataPath);
  const registry = await readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  const existingEntry = registry.enhancements.find((enhancement) => enhancement.id === enhancementId);
  const uninstalledEntry = String(existingEntry?.status || '').toLowerCase() === 'uninstalled' ? existingEntry : undefined;
  if (uninstalledEntry) {
    await upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, {
      ...builtin,
      ...uninstalledEntry,
      id: enhancementId,
      status: 'uninstalled',
      enabled: false,
      updatedAt: now,
      lastCheckedAt: now,
      health: {
        ...(uninstalledEntry.health || {}),
        ok: false,
        message: '已卸载；重新检测不会重新启用或重新登记。需要恢复时请点击安装或修复。',
        version: uninstalledEntry.health?.version || uninstalledEntry.version || '',
        lastProbe: {
          ok: check.ok,
          version: check.version,
          message: check.message,
          checkedAt: now
        }
      }
    }, registry.entryVersions?.[enhancementId] ?? 0);
    return {
      ok: false,
      message: `执行增强已卸载：${builtin.title}。需要恢复时请点击安装或修复。`,
      enhancementId
    };
  }
  const installedPath = path.join(installedRoot, enhancementId);
  const manifestPath = path.join(installedPath, 'solomap.enhancement.json');
  const healthPath = path.join(installedPath, 'health.json');
  const sourceLockPath = path.join(installedPath, 'source.lock.json');
  const existingManifest: Partial<SolomapEnhancementRegistryEntry> = existingEntry || {};
  const existingHealth = existingEntry?.health || {};
  const version = chooseEnhancementVersion(
    check.version,
    existingHealth.version,
    existingManifest.health?.version,
    existingManifest.version,
    existingEntry?.health?.version,
    existingEntry?.version,
    existingEntry?.source?.version
  );
  const nextHealth = {
    ...existingHealth,
    ok: check.ok,
    version,
    message: check.message || existingHealth.message || (check.ok ? '检测通过。' : '未检测到可用安装。'),
    lastCheckedAt: now,
    lastProbe: {
      ok: check.ok,
      version: check.version,
      message: check.message,
      checkedAt: now
    }
  };
  const entry: SolomapEnhancementRegistryEntry = {
    ...builtin,
    ...existingEntry,
    ...existingManifest,
    id: enhancementId,
    title: String(existingManifest.title || existingEntry?.title || builtin.title),
    description: String(existingManifest.description || existingEntry?.description || builtin.description),
    status: check.ok ? 'installed' : 'unavailable',
    enabled: Boolean(existingEntry?.enabled) && check.ok,
    version,
    source: existingManifest.source || existingEntry?.source || builtin.source || {},
    installedPath: path.relative(enhancementsRoot, installedPath).replace(/\\/g, '/'),
    configPath: path.relative(enhancementsRoot, manifestPath).replace(/\\/g, '/'),
    adapter: { ...(builtin.adapter || {}), ...(existingEntry?.adapter || {}), ...(existingManifest.adapter || {}) },
    activation: { ...(builtin.activation || {}), ...(existingEntry?.activation || {}), ...(existingManifest.activation || {}) },
    risk: { ...(builtin.risk || {}), ...(existingEntry?.risk || {}), ...(existingManifest.risk || {}) },
    evidencePolicy: { ...(builtin.evidencePolicy || {}), ...(existingEntry?.evidencePolicy || {}), ...(existingManifest.evidencePolicy || {}) },
    installedAt: String(existingManifest.installedAt || existingEntry?.installedAt || now),
    updatedAt: now,
    lastCheckedAt: now,
    health: nextHealth
  };
  await upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, entry, registry.entryVersions?.[enhancementId] ?? 0);
  return {
    ok: check.ok,
    message: check.ok ? `执行增强可用：${builtin.title}（${version || '版本未知'}）` : `执行增强检测失败：${builtin.title}。${check.message}`,
    enhancementId
  };
}

export async function setSolomapEnhancementEnabled(workspaceRoot: string, globalDataPath: string, enhancementId: string, enabled: boolean): Promise<{ ok: boolean; message: string; enhancementId?: string }> {
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!builtin) {
    return { ok: false, message: '未知执行增强。' };
  }
  const registry = await readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  const current = mergeBuiltinSolomapEnhancements(registry.enhancements).find((enhancement) => enhancement.id === enhancementId);
  if (enabled && !isEnhancementUsable(current)) {
    return { ok: false, message: `执行增强尚不可用：${builtin.title}。请先安装或修复。`, enhancementId };
  }
  const now = new Date().toISOString();
  await upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, {
    ...builtin,
    ...(current || {}),
    id: enhancementId,
    status: current?.status || (enabled ? 'installed' : 'disabled'),
    enabled,
    updatedAt: now,
    lastCheckedAt: current?.lastCheckedAt || now,
    health: current?.health || { ok: enabled, message: enabled ? '已启用。' : '已禁用。' }
  }, registry.entryVersions?.[enhancementId] ?? 0);
  return {
    ok: true,
    message: enabled ? `已启用执行增强：${builtin.title}` : `已禁用执行增强：${builtin.title}`,
    enhancementId
  };
}

export async function uninstallSolomapEnhancement(workspaceRoot: string, globalDataPath: string, enhancementId: string, healthMessage = '已从用户环境卸载。'): Promise<{ ok: boolean; message: string; enhancementId?: string }> {
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!builtin) {
    return { ok: false, message: '未知执行增强。' };
  }
  const registry = await readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  const current = mergeBuiltinSolomapEnhancements(registry.enhancements).find((enhancement) => enhancement.id === enhancementId);
  const now = new Date().toISOString();
  await upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, {
    ...builtin,
    ...(current || {}),
    id: enhancementId,
    status: 'uninstalled',
    enabled: false,
    updatedAt: now,
    lastCheckedAt: now,
    health: {
      ...(current?.health || {}),
      ok: false,
      message: healthMessage,
      version: current?.health?.version || current?.version || ''
    }
  }, registry.entryVersions?.[enhancementId] ?? 0);
  return { ok: true, message: `已卸载执行增强：${builtin.title}`, enhancementId };
}

export function buildSoloMapSystemMemoryPrompt(_workspaceRoot: string, _globalDataPath = ''): string {
  return buildAgentDatabaseInstructions();
}

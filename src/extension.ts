import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as Papa from 'papaparse';
import { SyncEngine } from './db/syncEngine';
import { SqliteStore } from './db/sqliteStore';
import { AgentConversation, RoadmapNode } from './db/types';
import { buildFlowStatePayload, createFlowLoop, createFlowTrace, FlowLoopScoring, FlowLoopStatus, FlowRole, FlowTrace, readFlowTrace, saveFlowTrace, updateFlowTrace } from './flowStore';
import { SolopreneurSidebarProvider } from './sidebarProvider';
import { getAgentImpactStatus, buildAgentImpactSummary } from './agentImpact';
import { auditDocumentationAfterRun, buildDocumentationPromptContext, ensureDocumentationManifest } from './documentationManifest';

let syncEngine: SyncEngine | null = null;
let activePanel: vscode.WebviewPanel | null = null;
let activeStrategyPyramidPanel: vscode.WebviewPanel | null = null;
let watcher: vscode.FileSystemWatcher | null = null;
let statusPoller: NodeJS.Timeout | null = null;
let sidebarProvider: SolopreneurSidebarProvider | null = null;
let extensionContextRef: vscode.ExtensionContext | null = null;
let activeProjectRoot: string | null = null;
let syncEngineReady = false;
let pendingPassportAuthNonce: string | null = null;
let syncEngineInitPromise: Promise<boolean> | null = null;
let syncEngineInitProjectRoot = '';
const agentModelCatalogCache = new Map<string, { expiresAt: number; catalog: AgentModelCatalog }>();

interface SolopreneurSettings {
  cliPath: string;
  agentModelPreferences?: Record<string, string>;
  language: string;
  globalPrompt: string;
  globalDataPath: string;
  taskPermissionMode?: string;
  reviewerCliPath?: string;
  collaborationReviewMode?: string;
  proEntitlements?: Record<string, boolean>;
  proAccount?: ProAccountStatus;
  enabledEnhancements?: Record<string, boolean>;
  enhancementStatuses?: SolomapEnhancementStatusSummary[];
  skills?: any[];
  connectors?: any[];
}

interface AgentModelOption {
  value: string;
  label: string;
  title?: string;
}

interface AgentModelCatalog {
  family: string;
  command: string;
  models: AgentModelOption[];
  selectedValue: string;
  supportsDiscovery: boolean;
}

interface ProAccountStatus {
  authenticated: boolean;
  allowed: boolean;
  email?: string;
  expiresAt?: string;
}

interface SolopreneurProject {
  name: string;
  path: string;
  type?: string;
  priority?: string;
  pinnedAt?: string;
}

interface ProjectRegistryFile {
  schemaVersion: number;
  updatedAt: string;
  projects: SolopreneurProject[];
  hiddenProjects: string[];
}

interface LocalUsageStats {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  extensionVersion: string;
  counters: {
    activations: number;
    roadmapOpens: number;
    projectsAdded: number;
    agentRuns: number;
    soloConversations: number;
    roadmapRevisions: number;
    feedbackIssuesOpened: number;
  };
  lastEventAt: Record<string, string>;
  snapshot: {
    registeredProjectCount: number;
    projectsWithRoadmap: number;
    roadmapNodeCount: number;
    completedNodeCount: number;
    failedNodeCount: number;
    runningNodeCount: number;
    inProgressNodeCount: number;
    pendingNodeCount: number;
    projectProgressPercent: number;
    issueCacheProjectCount: number;
    deliveryCacheProjectCount: number;
    agentRunDirectoryCount: number;
    latestAgentRunAt: string;
  };
}

interface StrategyPyramidNodeSummary {
  id: string;
  title: string;
  stage: string;
  status: string;
}

interface StrategyPyramidProjectSummary {
  name: string;
  path: string;
  type: string;
  role: string;
  businessStage: string;
  revenueTier: string;
  timeLoad: string;
  strategicRelation: string;
  loop: MethodologyStageKey;
  action: string;
  risk: string;
  evidence: string[];
  abilities: string[];
  roleScores: StrategyPyramidProjectRoleScores;
  advice: StrategyPyramidProjectAdvice;
  completedNodes: number;
  failedNodes: number;
  runningNodes: number;
  inProgressNodes: number;
  pendingNodes: number;
  totalNodes: number;
  progressPercent: number;
  nodes: StrategyPyramidNodeSummary[];
}

interface StrategyPyramidLoopSummary {
  key: MethodologyStageKey;
  label: string;
  title: string;
  count: number;
  projectNames: string[];
  judgment: string;
}

interface StrategyPyramidLayerSummary {
  key: string;
  title: string;
  health: 'strong' | 'watch' | 'risk';
  signal: string;
  action: string;
  evidence: string[];
}

interface StrategyPyramidMoveSummary {
  horizon: string;
  title: string;
  reason: string;
  evidence: string[];
}

interface StrategyPyramidAbilitySummary {
  name: string;
  projectCount: number;
  projectNames: string[];
  value: string;
  judgment: string;
}

interface StrategyPyramidProjectRoleScores {
  abilityAccumulation: number;
  revenueContribution: number;
  marketTrust: number;
  reusePotential: number;
  brandValue: number;
}

interface StrategyPyramidProjectAdvice {
  doubleDown: string;
  reduce: string;
  observe: string;
}

interface StrategyPyramidStageProfile {
  title: string;
  priorityLayer: string;
  keyMetric: string;
  defaultQuestion: string;
}

interface StrategyPyramidStructureSignal {
  key: string;
  title: string;
  summary: string;
  health: 'strong' | 'watch' | 'risk';
  evidence: string[];
}

interface StrategyPyramidRiskSignal {
  severity: 'high' | 'medium' | 'healthy';
  title: string;
  summary: string;
  evidence: string[];
}

interface StrategyPyramidScenario {
  key: string;
  title: string;
  investment: string;
  returnProfile: string;
  cost: string;
  risk: string;
  timeline: string;
  summary: string;
}

interface StrategyPyramidSnapshot {
  generatedAt: string;
  confidence: 'low' | 'medium' | 'high';
  stageTitle: string;
  stageProfile: StrategyPyramidStageProfile;
  mainJudgment: string;
  strategicAction: string;
  constraint: string;
  totalProjects: number;
  buildCount: number;
  sellCount: number;
  learnCount: number;
  improveCount: number;
  risks: string[];
  loops: StrategyPyramidLoopSummary[];
  layers: StrategyPyramidLayerSummary[];
  moves: StrategyPyramidMoveSummary[];
  abilities: StrategyPyramidAbilitySummary[];
  structureSignals: StrategyPyramidStructureSignal[];
  riskSignals: StrategyPyramidRiskSignal[];
  opportunitySignals: StrategyPyramidRiskSignal[];
  scenarios: StrategyPyramidScenario[];
  recommendedScenarioPath: string;
  projects: StrategyPyramidProjectSummary[];
}

type MethodologyStageKey = 'build' | 'sell' | 'learn' | 'improve';

interface PassportGrantCache {
  grant: string;
  email: string;
  userId: string;
  entitlements: string[];
  expiresAt: string;
  checkedAt: string;
}

interface PassportVerifyResult {
  allowed: boolean;
  reason?: string;
  grant?: string;
  email?: string;
  userId?: string;
  entitlements?: string[];
  expiresAt?: string;
}

interface PassportDeviceStartResult {
  ok: boolean;
  reason?: string;
  deviceCode?: string;
  loginUrl?: string;
  expiresIn?: number;
}

interface AgentStepSession {
  agentCli: string;
  provider: string;
  sessionId: string;
  updatedAt: string;
}

interface StepSessionState {
  version: number;
  nodeId: string;
  sessions: Record<string, AgentStepSession>;
}

interface SolomapSkillRegistryEntry {
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

interface SolomapSkillRegistry {
  version: number;
  updatedAt: string;
  skills: SolomapSkillRegistryEntry[];
}

interface BuiltinSolomapSkillDefinition {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  useWhen: string[];
  doNotUseWhen: string[];
  skillMd: string;
  defaultCandidate?: boolean;
}

const BUILTIN_SOLOMAP_SKILLS: BuiltinSolomapSkillDefinition[] = [{
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
3. Read the relevant SoloMap memory files when the task needs project or cross-project context; treat memory as context, not stronger evidence than current files.
4. Preserve the user's goal, wording, boundaries, and requested path. Do not replace the task with a more familiar engineering problem.
5. Make the smallest change that directly advances the goal. Avoid unrelated architecture changes, route changes, roadmap edits, or broad rewrites.
6. For user-facing UI or content, optimize for the final user's action and comprehension. Remove engineering self-description, template language, implementation traces, and maintenance-facing copy.
7. Validate the actual artifact the user will rely on. For generated scripts, templates, webviews, or configs, validate the generated output, not only the source template.
8. Close the loop: classify temporary run artifacts, explain verification, and record reusable stable lessons in the appropriate memory location when they will matter later.

## Before Acting

- Identify the user's intended result.
- Identify any explicit consistency, path, interface, or boundary the user wants preserved.
- Identify anything the user explicitly rejected or is correcting.
- Decide whether the user wants a result, a correction, a discussion, or a durable rule update.

## Memory Use

- Prefer the memory paths injected by SoloMap for the current run.
- Read only high-signal memory files that can change the current decision.
- Write stable reusable lessons to memory only after they are verified and broadly useful.
- Put temporary observations in active or inbox-style memory rather than stable project, pattern, or decision files.

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
  description: 'Classify and write reusable SoloMap memory into the right global memory location without leaking project-private details.',
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

- \`profile.md\`: durable user preferences, collaboration style, recurring priorities, and prohibitions.
- \`operating-rules.md\`: cross-task execution rules and agent behavior constraints.
- \`projects/<project>.md\`: stable facts, entrypoints, decisions, and context for one project.
- \`patterns/\`: reusable delivery, debugging, implementation, or verification patterns.
- \`decisions/\`: confirmed cross-project decisions with rationale and impact.
- \`domains/\`: reusable domain knowledge.
- \`inbox/\`: observations that may become memory but are not verified enough.
- \`active/\`: temporary current-session handoff.
- \`learning/candidates/\`: candidate lessons produced by SoloMap learning flows.

## Writing Protocol

1. Verify the information against current files, tests, logs, or explicit user confirmation before writing stable memory.
2. Read the target directory's \`_example.md\` before creating or appending a topic file.
3. Write only distilled facts, decisions, patterns, or handoff context. Do not paste raw logs, prompts, or execution transcripts.
4. Do not put project-specific names, fields, providers, database details, or deployment mechanics into global operating principles.
5. Do not leak one project's private facts into another project's reusable memory.
6. If the information is useful but not yet stable, write it to inbox or learning candidates instead of stable memory.

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
5. Write:
   - \`solomap.enhancement.json\`: id, title, description, status, version, source, adapter, activation, risk, evidencePolicy, installedAt, updatedAt, and health.
   - \`source.lock.json\`: source, package/version/commit if known, installer command summary, and updatedAt.
   - \`health.json\`: ok, version, command checks, config files touched, warnings, and lastCheckedAt.
   - the prompt-specified \`result.json\`.
6. Treat \`health.version\` as the canonical installed version. If the primary command has no useful \`--version\`, derive the version from the package manager, package metadata, source lock, smoke-tested executable package, or upstream commit.
7. Do not replace a previously known top-level version with \`版本未知\`, an empty string, or a weaker check result. Put weaker command output under \`health.commandChecks\` with the reason.
8. Preserve existing \`source.lock.json\`, \`solomap.enhancement.json\`, and \`health.json\` fields unless the new run has stronger evidence. During repair or recheck, never overwrite source provenance with a reduced placeholder.
9. Do not write Agent private config unless the enhancement cannot work without it and the prompt explicitly permits it. If any installer touches Agent config, record \`configFilesTouched\` exactly in health and result.
10. If a step partially succeeds, keep the installed files and report status as \`failed\` or \`needs_repair\` with a clear repair hint. Do not hide partial failures behind a successful result.
11. Never delete existing files or clear directories. If cleanup is needed, report it in result.json instead of doing it.

## Result JSON

Successful install:

\`\`\`json
{
  "ok": true,
  "enhancementId": "code-structure-assistant",
  "installedPath": ".solomap-global/enhancements/installed/code-structure-assistant",
  "solomapEnhancementJson": ".solomap-global/enhancements/installed/code-structure-assistant/solomap.enhancement.json",
  "sourceLockJson": ".solomap-global/enhancements/installed/code-structure-assistant/source.lock.json",
  "healthJson": ".solomap-global/enhancements/installed/code-structure-assistant/health.json",
  "metadata": { "name": "Code Structure Assistant", "version": "1.2.3" },
  "health": { "ok": true, "version": "1.2.3", "message": "Ready" },
  "configFilesTouched": []
}
\`\`\`

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

interface SolomapMcpRegistryEntry {
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

interface SolomapMcpRegistry {
  version: number;
  updatedAt: string;
  connectors: SolomapMcpRegistryEntry[];
}

interface SolomapEnhancementRegistryEntry {
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

interface SolomapEnhancementRegistry {
  version: number;
  updatedAt: string;
  enhancements: SolomapEnhancementRegistryEntry[];
}

interface BuiltinSolomapEnhancementDefinition extends SolomapEnhancementRegistryEntry {
  id: string;
  title: string;
  description: string;
}

interface SolomapEnhancementStatusSummary {
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

const BUILTIN_SOLOMAP_ENHANCEMENTS: BuiltinSolomapEnhancementDefinition[] = [{
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

const SOLOMAP_RTK_WRAPPED_COMMANDS = ['ls', 'tree', 'find', 'rg', 'grep', 'git', 'gh'];

const settingsKey = 'solopreneur.settings';
const projectsKey = 'solopreneur.projects';
const selectedProjectKey = 'solopreneur.selectedProjectPath';
const hiddenProjectsKey = 'solopreneur.hiddenProjects';
const passportGrantSecretKey = 'solopreneur.passportGrant';
const passportProduct = 'solomap';
const strategyPyramidFeature = 'strategy_pyramid';
const flowModeFeature = 'flow_mode';
const passportGrantOfflineGraceMs = 14 * 24 * 60 * 60 * 1000;
const projectRegistryFileName = 'projects.json';
const usageStatsFileName = 'solomap-usage.json';
const roadmapRevisionId = '__roadmap_revision__';
const soloConversationId = '__solo__';
const agentTerminalBaseName = 'solomap';
const agentStatusDirName = 'agent-status';
let activeAgentTerminalName = '';
let agentTerminalCounter = 0;
const agentTerminalNamesByConversationId = new Map<number, string>();
const FEEDBACK_ISSUE_URL = 'https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new';

export async function activate(context: vscode.ExtensionContext) {
  console.log('SoloMap extension is now active!');
  extensionContextRef = context;
  recordLocalUsageEvent(context, 'activation');

  // Register command to show roadmap webview
  const showRoadmapDisposable = vscode.commands.registerCommand(
    'solopreneur.showRoadmap',
    async () => {
      await openRoadmapPanel(context, 'roadmap');
    }
  );
  context.subscriptions.push(showRoadmapDisposable);

  const showFlowDisposable = vscode.commands.registerCommand(
    'solopreneur.showFlow',
    async () => {
      await openRoadmapPanel(context, 'flow');
    }
  );
  context.subscriptions.push(showFlowDisposable);

  const showStrategyPyramidDisposable = vscode.commands.registerCommand(
    'solopreneur.showStrategyPyramid',
    async () => {
      await handleOpenStrategyPyramid(context);
    }
  );
  context.subscriptions.push(showStrategyPyramidDisposable);

  const manageProAuthorizationDisposable = vscode.commands.registerCommand(
    'solopreneur.manageProAuthorization',
    async (action?: string) => {
      await handleManageProAuthorization(context, action);
    }
  );
  context.subscriptions.push(manageProAuthorizationDisposable);

  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri: async (uri) => {
      await handlePassportUri(context, uri);
    }
  }));

  // Register settings saved broadcast command to keep Sidebar and Webview synced
  const settingsSavedDisposable = vscode.commands.registerCommand(
    'solopreneur.settingsSavedBroadcast',
    () => {
      if (sidebarProvider) {
        sidebarProvider.sendSettings();
        sidebarProvider.sendProjects();
      }
      if (activePanel) {
        activePanel.webview.postMessage({
          command: 'settingsLoaded',
          settings: getPersistedSettings(context)
        });
        activePanel.webview.postMessage({
          command: 'projectsLoaded',
          projects: getProjectState(context)
        });
      }
    }
  );
  context.subscriptions.push(settingsSavedDisposable);

  // Setup wrapper for SyncEngine to allow safe initialization later
  const syncEngineWrapper = {
    getNodes: () => {
      return syncEngine ? syncEngine.getNodes() : [];
    }
  } as any;

  // Register Sidebar Webview View Provider
  sidebarProvider = new SolopreneurSidebarProvider(
    context.extensionUri,
    syncEngineWrapper,
    async (nodeId, userMessage = '', agentCli = '', model = '', supplementFiles: string[] = []) => {
      const ready = await ensureSyncEngine(context);
      if (ready) {
        await handleRunAgent(context, nodeId, userMessage, agentCli, model, normalizeSupplementFiles(supplementFiles));
      }
    },
    () => getPersistedSettings(context),
    async (settings) => {
      await updatePersistedSettings(context, settings);
    },
    () => getProjectState(context),
    async (projectPath) => {
      await selectProject(context, projectPath);
    },
    async () => {
      await addProjectFromDialog(context);
    },
    async (projectPath, userMessage = '', agentCli = '', model = '', supplementFiles: string[] = []) => {
      if (!getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
        return;
      }
      if (getSelectedProjectPath(context) !== projectPath) {
        await selectProject(context, projectPath);
      }
      const ready = await ensureSyncEngine(context);
      if (ready && activeProjectRoot === projectPath) {
        await handleRunSoloConversation(context, userMessage, agentCli, model, normalizeSupplementFiles(supplementFiles));
      }
    },
    async (projectPath, goal = '', agentCli = '', model = '', supplementFiles: string[] = []) => {
      if (!getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
        return;
      }
      if (getSelectedProjectPath(context) !== projectPath) {
        await selectProject(context, projectPath);
      }
      const ready = await ensureSyncEngine(context);
      if (ready && activeProjectRoot === projectPath) {
        await handleRunFlow(context, goal, agentCli, model, normalizeSupplementFiles(supplementFiles));
      }
    },
    async (agentCli) => loadDiscoveredAgentModels(resolveAgentCli(agentCli || '', getPersistedSettings(context).cliPath || 'agy')),
    async (projectPath) => {
      if (!getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
        return [];
      }
      return chooseSupplementFilesForProject(projectPath);
    },
    async (projectPath) => {
      return getSoloConversationHistoryForProject(context, projectPath);
    },
    async (projectPath, conversationId) => {
      if (!getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
        return;
      }
      if (getSelectedProjectPath(context) !== projectPath) {
        await selectProject(context, projectPath);
      }
      const ready = await ensureSyncEngine(context);
      if (ready && activeProjectRoot === projectPath) {
        await handleContinueNativeConversation(context, soloConversationId, Number(conversationId || 0));
      }
    },
    async (projectPath, nodeId, conversationId) => {
      if (!getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
        return;
      }
      if (getSelectedProjectPath(context) !== projectPath) {
        await selectProject(context, projectPath);
      }
      const ready = await ensureSyncEngine(context);
      if (ready && activeProjectRoot === projectPath) {
        await handleContinueNativeConversation(context, String(nodeId || ''), Number(conversationId || 0));
      }
    },
    async (projectPath, nodeId) => {
      return getStepConversationHistoryForProject(context, projectPath, nodeId);
    },
    async (projectPath) => {
      return getProjectConversationHistoryForProject(context, projectPath);
    },
    async (projectPath) => {
      await toggleProjectPinned(context, projectPath);
    },
    async (projectPath, scope, attachments) => {
      if (!getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
        return [];
      }
      return savePastedImageAttachments(projectPath, scope, attachments);
    },
    async (skillInput) => {
      await handleInstallSolomapSkill(context, skillInput);
    },
    async (mcpInput) => {
      await handleInstallSolomapMcp(context, mcpInput);
    },
    async (enhancementId) => {
      await handleInstallSolomapEnhancement(context, enhancementId);
    },
    async (enhancementId) => {
      await handleCheckSolomapEnhancement(context, enhancementId);
    },
    async (enhancementId, enabled) => {
      await handleSetSolomapEnhancementEnabled(context, enhancementId, enabled);
    },
    async (enhancementId) => {
      await handleUninstallSolomapEnhancement(context, enhancementId);
    },
    async (skillId) => {
      await handleUninstallSolomapSkill(context, skillId);
    },
    async (mcpId) => {
      await handleUninstallSolomapMcp(context, mcpId);
    },
    () => buildFeedbackUsageSummary(context),
    async (projectPath, nodeId, conversationId) => {
      if (!getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
        return;
      }
      if (getSelectedProjectPath(context) !== projectPath) {
        await selectProject(context, projectPath);
      }
      const ready = await ensureSyncEngine(context);
      if (ready && activeProjectRoot === projectPath) {
        await stopAgentRun(String(nodeId || ''), Number(conversationId || 0));
      }
    },
    async (projectPath, gitHash) => {
      await rollbackProjectToPreSessionGitHash(context, projectPath, gitHash);
    },
    async (action) => {
      await handleManageProAuthorization(context, action);
    }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SolopreneurSidebarProvider.viewType,
      sidebarProvider
    )
  );

  // Initialize storage in the background after the UI provider is registered.
  void ensureSyncEngine(context);
}

function getPersistedSettings(context: vscode.ExtensionContext): SolopreneurSettings {
  const config = vscode.workspace.getConfiguration('solopreneur');
  const saved = context.globalState.get<Partial<SolopreneurSettings>>(settingsKey) || {};
  const settingsWorkspaceRoot = getSettingsEnhancementWorkspaceRoot();
  const baseSettings = {
    cliPath: saved.cliPath || config.get('cliPath') || 'agy',
    agentModelPreferences: normalizeAgentModelPreferences(saved.agentModelPreferences),
    language: saved.language || config.get('language') || 'zh',
    globalPrompt: saved.globalPrompt ?? config.get('globalPrompt') ?? '',
    globalDataPath: saved.globalDataPath ?? config.get('globalDataPath') ?? '',
    taskPermissionMode: 'auto',
    reviewerCliPath: saved.reviewerCliPath ?? config.get('reviewerCliPath') ?? '',
    collaborationReviewMode: normalizeCollaborationReviewMode(saved.collaborationReviewMode ?? config.get('collaborationReviewMode') ?? 'high_risk'),
    proEntitlements: {
      ...(saved.proEntitlements || {}),
      ...readLocalProEntitlements()
    },
    proAccount: normalizeProAccountStatus(saved.proAccount),
    enabledEnhancements: {}
  };
  return {
    ...baseSettings,
    enhancementStatuses: refreshSolomapEnhancementStatusSummaries(settingsWorkspaceRoot, baseSettings.globalDataPath),
    enabledEnhancements: getEnabledEnhancementMap(settingsWorkspaceRoot, baseSettings.globalDataPath),
    skills: readSolomapSkillRegistry(settingsWorkspaceRoot, baseSettings.globalDataPath).skills || [],
    connectors: readSolomapMcpRegistry(settingsWorkspaceRoot, baseSettings.globalDataPath).connectors || []
  };
}

function normalizeAgentModelPreferences(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, model]) => {
    const family = String(key || '').trim();
    const normalizedModel = String(model || '').trim();
    if (family && normalizedModel) {
      acc[family] = normalizedModel;
    }
    return acc;
  }, {});
}

function readLocalProEntitlements(): Record<string, boolean> {
  const value = String(process.env.SOLOMAP_PRO || '').trim().toLowerCase();
  if (!['1', 'true', 'yes', 'pro'].includes(value)) {
    return {};
  }
  return {
    pro: true,
    strategy_pyramid: true,
    flow_mode: true
  };
}

function hasProEntitlement(settings: Partial<SolopreneurSettings> | undefined, featureKey: string): boolean {
  const entitlements = settings?.proEntitlements || {};
  const normalizedFeature = featureKey === 'strategyPyramid' ? 'strategy_pyramid' : featureKey;
  return Boolean(entitlements[normalizedFeature] || entitlements[featureKey] || entitlements.pro || entitlements.solomap_pro);
}

function normalizeProAccountStatus(value: unknown): ProAccountStatus {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<ProAccountStatus>;
  return {
    authenticated: Boolean(source.authenticated),
    allowed: Boolean(source.allowed),
    email: String(source.email || ''),
    expiresAt: String(source.expiresAt || '')
  };
}

function buildProAccountStatus(result: PassportVerifyResult | PassportGrantCache | null | undefined): ProAccountStatus {
  const source = (result || {}) as Partial<PassportVerifyResult & PassportGrantCache>;
  const allowed = Boolean((source as PassportVerifyResult).allowed) || grantContainsFeature({
    entitlements: Array.isArray(source.entitlements) ? source.entitlements : [],
    expiresAt: String(source.expiresAt || ''),
    checkedAt: (source as PassportGrantCache).checkedAt || new Date().toISOString()
  });
  return {
    authenticated: Boolean(source.email || source.userId || allowed),
    allowed,
    email: String(source.email || ''),
    expiresAt: String(source.expiresAt || '')
  };
}

async function broadcastSettings(context: vscode.ExtensionContext): Promise<void> {
  if (sidebarProvider) {
    sidebarProvider.sendSettings();
  }
  if (activePanel) {
    activePanel.webview.postMessage({
      command: 'settingsLoaded',
      settings: getPersistedSettings(context)
    });
    if (activeProjectRoot) {
      activePanel.webview.postMessage({
        command: 'flowStateLoaded',
        state: buildFlowStatePayload(activeProjectRoot, await hasFlowModeAccess(context))
      });
    }
  }
}

async function postFlowStateToWebview(context: vscode.ExtensionContext): Promise<void> {
  if (!activePanel || !activeProjectRoot) {
    return;
  }
  activePanel.webview.postMessage({
    command: 'flowStateLoaded',
    state: buildFlowStatePayload(activeProjectRoot, await hasFlowModeAccess(context))
  });
}

function getPassportBaseUrl(): string {
  return String(process.env.SOLOMAP_PASSPORT_BASE_URL || 'https://solomap.app').replace(/\/+$/, '');
}

function buildPassportCallbackUri(): string {
  const scheme = vscode.env.uriScheme || 'vscode';
  return `${scheme}://SZLK.solopreneur-roadmap/passport/callback`;
}

function createPassportAuthNonce(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function buildPassportProUrl(mode: 'callback' | 'device', authNonce: string, callbackUri = buildPassportCallbackUri()): string {
  const url = new URL('/pro', getPassportBaseUrl());
  url.searchParams.set('product', passportProduct);
  url.searchParams.set('feature', strategyPyramidFeature);
  url.searchParams.set('source', 'vscode');
  url.searchParams.set('mode', mode);
  url.searchParams.set('auth_nonce', authNonce);
  if (mode === 'callback') {
    url.searchParams.set('callback', callbackUri);
  }
  return url.toString();
}

function buildPassportStartUrl(callbackUri = buildPassportCallbackUri()): string {
  return buildPassportProUrl('callback', createPassportAuthNonce(), callbackUri);
}

function buildPassportVerifyUrl(): string {
  return new URL('/api/passport/verify', getPassportBaseUrl()).toString();
}

function buildPassportDeviceStartUrl(): string {
  return new URL('/api/passport/device/start', getPassportBaseUrl()).toString();
}

function buildPassportDeviceVerifyUrl(): string {
  return new URL('/api/passport/device/verify', getPassportBaseUrl()).toString();
}

function grantContainsFeature(grant: Pick<PassportGrantCache, 'entitlements' | 'expiresAt' | 'checkedAt'>): boolean {
  const entitlements = new Set((grant.entitlements || []).map((item) => String(item || '').trim()));
  const expiresAtMs = Date.parse(grant.expiresAt || '');
  const checkedAtMs = Date.parse(grant.checkedAt || '');
  if (!entitlements.has(strategyPyramidFeature) && !entitlements.has('solomap_pro') && !entitlements.has('pro')) {
    return false;
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return false;
  }
  if (!Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs > passportGrantOfflineGraceMs) {
    return false;
  }
  return true;
}

async function readPassportGrant(context: vscode.ExtensionContext): Promise<PassportGrantCache | null> {
  try {
    const raw = await context.secrets.get(passportGrantSecretKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PassportGrantCache;
    if (!parsed || !parsed.grant) return null;
    return parsed;
  } catch (error) {
    console.warn('Failed to read SoloMap Pro grant:', error);
    return null;
  }
}

async function writePassportGrant(context: vscode.ExtensionContext, result: PassportVerifyResult, grant: string): Promise<void> {
  const payload: PassportGrantCache = {
    grant,
    email: String(result.email || ''),
    userId: String(result.userId || ''),
    entitlements: Array.isArray(result.entitlements) ? result.entitlements.map((item) => String(item || '')).filter(Boolean) : [],
    expiresAt: String(result.expiresAt || new Date(Date.now() + passportGrantOfflineGraceMs).toISOString()),
    checkedAt: new Date().toISOString()
  };
  await context.secrets.store(passportGrantSecretKey, JSON.stringify(payload));
  const saved = context.globalState.get<Partial<SolopreneurSettings>>(settingsKey) || {};
  await context.globalState.update(settingsKey, {
    ...saved,
    proEntitlements: {
      ...(saved.proEntitlements || {}),
      pro: true,
      solomap_pro: true,
      [strategyPyramidFeature]: true
    },
    proAccount: buildProAccountStatus(result)
  });
  await broadcastSettings(context);
}

async function verifyPassportGrant(grant: string, options: { authNonce?: string | null; callbackUri?: string | null; deviceCode?: string | null } = {}): Promise<PassportVerifyResult> {
  if (!grant) {
    return { allowed: false, reason: 'missing_grant' };
  }
  try {
    const response = await fetch(buildPassportVerifyUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product: passportProduct,
        feature: strategyPyramidFeature,
        grant,
        code: grant,
        authNonce: options.authNonce || '',
        callback: options.callbackUri || '',
        deviceCode: options.deviceCode || ''
      })
    });
    if (!response.ok) {
      return { allowed: false, reason: `verify_http_${response.status}` };
    }
    const body = await response.json() as PassportVerifyResult;
    return {
      allowed: Boolean(body.allowed),
      reason: String(body.reason || ''),
      grant: String(body.grant || ''),
      email: String(body.email || ''),
      userId: String(body.userId || ''),
      entitlements: Array.isArray(body.entitlements) ? body.entitlements.map((item) => String(item || '')).filter(Boolean) : [],
      expiresAt: String(body.expiresAt || '')
    };
  } catch (error) {
    console.warn('Failed to verify SoloMap Pro grant:', error);
    return { allowed: false, reason: 'verify_failed' };
  }
}

async function hasStrategyPyramidAccess(context: vscode.ExtensionContext): Promise<boolean> {
  if (hasProEntitlement(getPersistedSettings(context), 'strategyPyramid')) {
    return true;
  }
  const cached = await readPassportGrant(context);
  if (!cached) {
    return false;
  }
  const verified = await verifyPassportGrant(cached.grant);
  if (verified.allowed) {
    await writePassportGrant(context, verified, cached.grant);
    return true;
  }
  return grantContainsFeature(cached);
}

async function hasFlowModeAccess(context: vscode.ExtensionContext): Promise<boolean> {
  if (hasProEntitlement(getPersistedSettings(context), flowModeFeature)) {
    return true;
  }
  const cached = await readPassportGrant(context);
  if (!cached) {
    return false;
  }
  const verified = await verifyPassportGrant(cached.grant);
  if (verified.allowed) {
    await writePassportGrant(context, verified, cached.grant);
    return true;
  }
  return grantContainsFeature(cached);
}

async function beginPassportAuthorization(): Promise<void> {
  const authNonce = createPassportAuthNonce();
  pendingPassportAuthNonce = authNonce;
  await vscode.env.openExternal(vscode.Uri.parse(buildPassportProUrl('callback', authNonce)));
}

async function beginPassportDeviceAuthorization(context: vscode.ExtensionContext): Promise<void> {
  const authNonce = createPassportAuthNonce();
  pendingPassportAuthNonce = authNonce;

  await vscode.env.openExternal(vscode.Uri.parse(buildPassportProUrl('device', authNonce)));
  const code = await vscode.window.showInputBox({
    title: 'SoloMap Pro',
    prompt: '登录完成后，粘贴网页上显示的授权码。',
    placeHolder: '粘贴授权码',
    ignoreFocusOut: true
  });
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) {
    return;
  }
  try {
    const result = await verifyPassportGrant(normalizedCode, { authNonce });
    if (!result.allowed) {
      vscode.window.showWarningMessage('SoloMap Pro 授权未通过。');
      return;
    }
    pendingPassportAuthNonce = null;
    await writePassportGrant(context, result, result.grant || normalizedCode);
    vscode.window.showInformationMessage('SoloMap Pro 已解锁。');
    await openStrategyPyramidPanel(context);
  } catch (error) {
    console.warn('Failed to verify SoloMap Pro device authorization:', error);
    vscode.window.showWarningMessage('SoloMap Pro 授权未通过。');
  }
}

async function pastePassportAuthorizationCode(context: vscode.ExtensionContext): Promise<void> {
  const code = await vscode.window.showInputBox({
    title: 'SoloMap Pro',
    prompt: '粘贴网页上显示的授权码。',
    placeHolder: '授权码',
    ignoreFocusOut: true
  });
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) {
    return;
  }
  const result = await verifyPassportGrant(normalizedCode);
  if (!result.allowed) {
    vscode.window.showWarningMessage('SoloMap Pro 授权未通过。');
    return;
  }
  await writePassportGrant(context, result, result.grant || normalizedCode);
  vscode.window.showInformationMessage('SoloMap Pro 已解锁。');
}

async function beginPassportAuthorizationFlow(context: vscode.ExtensionContext): Promise<void> {
  const isRemoteEnvironment = Boolean((vscode.env as any).remoteName);
  const callbackLabel = '浏览器回到 VS Code';
  const deviceLabel = '使用登录码';
  const message = isRemoteEnvironment
    ? '当前环境可能无法接收浏览器回调，请使用登录码完成 SoloMap Pro 登录。'
    : '选择 SoloMap Pro 登录方式。';
  const firstChoice = isRemoteEnvironment ? deviceLabel : callbackLabel;
  const secondChoice = isRemoteEnvironment ? callbackLabel : deviceLabel;
  const choice = await vscode.window.showInformationMessage(message, firstChoice, secondChoice);
  if (choice === deviceLabel) {
    await beginPassportDeviceAuthorization(context);
    return;
  }
  if (choice === callbackLabel) {
    await beginPassportAuthorization();
  }
}

async function handleManageProAuthorization(context: vscode.ExtensionContext, action?: string): Promise<void> {
  const normalizedAction = String(action || '').trim();
  if (normalizedAction === 'login') {
    await beginPassportAuthorizationFlow(context);
    return;
  }
  if (normalizedAction === 'paste') {
    await pastePassportAuthorizationCode(context);
    return;
  }
  const loginLabel = '登录 / 升级 Pro';
  const pasteLabel = '粘贴授权码';
  const choice = await vscode.window.showInformationMessage('管理 SoloMap Pro 授权。', loginLabel, pasteLabel);
  if (choice === loginLabel) {
    await beginPassportAuthorizationFlow(context);
    return;
  }
  if (choice === pasteLabel) {
    await pastePassportAuthorizationCode(context);
  }
}

async function handlePassportUri(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<void> {
  const pathValue = `${uri.authority || ''}${uri.path || ''}`;
  if (!pathValue.includes('passport/callback')) {
    return;
  }
  const params = new URLSearchParams(uri.query || '');
  const grant = String(params.get('code') || params.get('grant') || '').trim();
  if (!grant) {
    vscode.window.showWarningMessage('没有收到 SoloMap Pro 授权结果。');
    return;
  }
  const callbackUri = buildPassportCallbackUri();
  const result = await verifyPassportGrant(grant, {
    authNonce: pendingPassportAuthNonce,
    callbackUri
  });
  if (!result.allowed) {
    vscode.window.showWarningMessage('SoloMap Pro 授权未通过。');
    return;
  }
  pendingPassportAuthNonce = null;
  await writePassportGrant(context, result, result.grant || grant);
  vscode.window.showInformationMessage('SoloMap Pro 已解锁。');
  await openStrategyPyramidPanel(context);
}

function getSettingsEnhancementWorkspaceRoot(): string {
  return activeProjectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

function normalizeCollaborationReviewMode(value: unknown): string {
  return ['off', 'high_risk', 'all'].includes(String(value || '')) ? String(value) : 'high_risk';
}

function normalizeEnabledEnhancements(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, boolean>>((acc, [key, enabled]) => {
    const normalizedKey = String(key || '').trim();
    if (normalizedKey) {
      acc[normalizedKey] = Boolean(enabled);
    }
    return acc;
  }, {});
}

async function updatePersistedSettings(context: vscode.ExtensionContext, settings: SolopreneurSettings): Promise<void> {
  const currentSettings = getPersistedSettings(context);
  const nextSettings: SolopreneurSettings = {
    cliPath: settings.cliPath || 'agy',
    agentModelPreferences: {
      ...normalizeAgentModelPreferences(currentSettings.agentModelPreferences),
      ...normalizeAgentModelPreferences(settings.agentModelPreferences)
    },
    language: settings.language === 'en' ? 'en' : 'zh',
    globalPrompt: String(settings.globalPrompt || '').trim(),
    globalDataPath: String(settings.globalDataPath ?? currentSettings.globalDataPath ?? '').trim(),
    taskPermissionMode: 'auto',
    reviewerCliPath: String(settings.reviewerCliPath ?? currentSettings.reviewerCliPath ?? '').trim(),
    collaborationReviewMode: normalizeCollaborationReviewMode(settings.collaborationReviewMode ?? currentSettings.collaborationReviewMode),
    proEntitlements: currentSettings.proEntitlements || {},
    proAccount: currentSettings.proAccount,
    enabledEnhancements: getEnabledEnhancementMap(getSettingsEnhancementWorkspaceRoot(), String(settings.globalDataPath ?? currentSettings.globalDataPath ?? '').trim())
  };
  await context.globalState.update(settingsKey, nextSettings);

  const config = vscode.workspace.getConfiguration('solopreneur');
  await config.update('cliPath', nextSettings.cliPath, vscode.ConfigurationTarget.Global);
  await config.update('language', nextSettings.language, vscode.ConfigurationTarget.Global);
  await config.update('globalPrompt', nextSettings.globalPrompt, vscode.ConfigurationTarget.Global);
  await config.update('globalDataPath', nextSettings.globalDataPath, vscode.ConfigurationTarget.Global);
  await config.update('reviewerCliPath', nextSettings.reviewerCliPath, vscode.ConfigurationTarget.Global);
  await config.update('collaborationReviewMode', nextSettings.collaborationReviewMode, vscode.ConfigurationTarget.Global);
}

function projectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

function normalizeGlobalDataPathForExtension(rawPath: string): string {
  const trimmed = String(rawPath || '').trim();
  if (trimmed) {
    return trimmed.endsWith('.solomap-global') ? trimmed : path.join(trimmed, '.solomap-global');
  }
  const workspaceRoot = getWorkspaceRoot();
  return path.join(path.dirname(workspaceRoot || process.cwd()), '.solomap-global');
}

function getProjectRegistryPath(context: vscode.ExtensionContext): string {
  return path.join(normalizeGlobalDataPathForExtension(getPersistedSettings(context).globalDataPath), projectRegistryFileName);
}

function getUsageStatsPath(context: vscode.ExtensionContext): string {
  return path.join(normalizeGlobalDataPathForExtension(getPersistedSettings(context).globalDataPath), 'usage', usageStatsFileName);
}

function getExtensionVersion(context: vscode.ExtensionContext): string {
  return String((context as any).extension?.packageJSON?.version || '');
}

function createEmptyUsageStats(context: vscode.ExtensionContext, now = new Date().toISOString()): LocalUsageStats {
  return {
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    extensionVersion: getExtensionVersion(context),
    counters: {
      activations: 0,
      roadmapOpens: 0,
      projectsAdded: 0,
      agentRuns: 0,
      soloConversations: 0,
      roadmapRevisions: 0,
      feedbackIssuesOpened: 0
    },
    lastEventAt: {},
    snapshot: {
      registeredProjectCount: 0,
      projectsWithRoadmap: 0,
      roadmapNodeCount: 0,
      completedNodeCount: 0,
      failedNodeCount: 0,
      runningNodeCount: 0,
      inProgressNodeCount: 0,
      pendingNodeCount: 0,
      projectProgressPercent: 0,
      issueCacheProjectCount: 0,
      deliveryCacheProjectCount: 0,
      agentRunDirectoryCount: 0,
      latestAgentRunAt: ''
    }
  };
}

function normalizeUsageStats(context: vscode.ExtensionContext, raw: any): LocalUsageStats {
  const base = createEmptyUsageStats(context);
  const counters = raw && typeof raw.counters === 'object' ? raw.counters : {};
  const snapshot = raw && typeof raw.snapshot === 'object' ? raw.snapshot : {};
  return {
    ...base,
    createdAt: String(raw?.createdAt || base.createdAt),
    updatedAt: String(raw?.updatedAt || base.updatedAt),
    extensionVersion: String(raw?.extensionVersion || base.extensionVersion),
    counters: {
      activations: Number(counters.activations || 0),
      roadmapOpens: Number(counters.roadmapOpens || 0),
      projectsAdded: Number(counters.projectsAdded || 0),
      agentRuns: Number(counters.agentRuns || 0),
      soloConversations: Number(counters.soloConversations || 0),
      roadmapRevisions: Number(counters.roadmapRevisions || 0),
      feedbackIssuesOpened: Number(counters.feedbackIssuesOpened || 0)
    },
    lastEventAt: raw && typeof raw.lastEventAt === 'object'
      ? Object.fromEntries(Object.entries(raw.lastEventAt).map(([key, value]) => [String(key), String(value || '')]))
      : {},
    snapshot: {
      registeredProjectCount: Number(snapshot.registeredProjectCount || 0),
      projectsWithRoadmap: Number(snapshot.projectsWithRoadmap || 0),
      roadmapNodeCount: Number(snapshot.roadmapNodeCount || 0),
      completedNodeCount: Number(snapshot.completedNodeCount || 0),
      failedNodeCount: Number(snapshot.failedNodeCount || 0),
      runningNodeCount: Number(snapshot.runningNodeCount || 0),
      inProgressNodeCount: Number(snapshot.inProgressNodeCount || 0),
      pendingNodeCount: Number(snapshot.pendingNodeCount || 0),
      projectProgressPercent: Number(snapshot.projectProgressPercent || 0),
      issueCacheProjectCount: Number(snapshot.issueCacheProjectCount || 0),
      deliveryCacheProjectCount: Number(snapshot.deliveryCacheProjectCount || 0),
      agentRunDirectoryCount: Number(snapshot.agentRunDirectoryCount || 0),
      latestAgentRunAt: String(snapshot.latestAgentRunAt || '')
    }
  };
}

function readLocalUsageStats(context: vscode.ExtensionContext): LocalUsageStats {
  const statsPath = getUsageStatsPath(context);
  if (!fs.existsSync(statsPath)) {
    return createEmptyUsageStats(context);
  }
  try {
    return normalizeUsageStats(context, JSON.parse(fs.readFileSync(statsPath, 'utf8')));
  } catch {
    return createEmptyUsageStats(context);
  }
}

function writeLocalUsageStats(context: vscode.ExtensionContext, stats: LocalUsageStats): void {
  const statsPath = getUsageStatsPath(context);
  fs.mkdirSync(path.dirname(statsPath), { recursive: true });
  const payload = JSON.stringify(stats, null, 2);
  const tempPath = `${statsPath}.tmp`;
  fs.writeFileSync(tempPath, payload, 'utf8');
  JSON.parse(fs.readFileSync(tempPath, 'utf8'));
  fs.renameSync(tempPath, statsPath);
}

function normalizeProjectsForStorage(projects: SolopreneurProject[]): SolopreneurProject[] {
  const seen = new Set<string>();
  return (projects || [])
    .map((project) => ({
      name: String(project.name || projectName(project.path || '')).trim(),
      path: String(project.path || '').trim(),
      ...(project.type ? { type: String(project.type) } : {}),
      ...(project.priority ? { priority: String(project.priority) } : {}),
      ...(project.pinnedAt ? { pinnedAt: String(project.pinnedAt) } : {})
    }))
    .filter((project) => {
      if (!project.path || seen.has(project.path)) {
        return false;
      }
      seen.add(project.path);
      return true;
    });
}

function sortProjectsForDisplay(projects: SolopreneurProject[]): SolopreneurProject[] {
  return [...projects].sort((a, b) => {
    const pinnedA = a.pinnedAt ? 1 : 0;
    const pinnedB = b.pinnedAt ? 1 : 0;
    if (pinnedA !== pinnedB) {
      return pinnedB - pinnedA;
    }
    if (a.pinnedAt || b.pinnedAt) {
      return String(b.pinnedAt || '').localeCompare(String(a.pinnedAt || ''));
    }
    return 0;
  });
}

function readProjectRegistry(context: vscode.ExtensionContext): ProjectRegistryFile | null {
  const registryPath = getProjectRegistryPath(context);
  if (!fs.existsSync(registryPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return {
      schemaVersion: 1,
      updatedAt: String(parsed.updatedAt || ''),
      projects: normalizeProjectsForStorage(Array.isArray(parsed.projects) ? parsed.projects : []),
      hiddenProjects: Array.isArray(parsed.hiddenProjects)
        ? parsed.hiddenProjects.map((item: unknown) => String(item || '').trim()).filter(Boolean)
        : []
    };
  } catch (error) {
    console.error('SoloMap failed to read global project registry:', error);
    return null;
  }
}

function writeProjectRegistry(context: vscode.ExtensionContext, projects: SolopreneurProject[], hiddenProjects: string[]): void {
  const registryPath = getProjectRegistryPath(context);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const payload: ProjectRegistryFile = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    projects: normalizeProjectsForStorage(projects),
    hiddenProjects: [...new Set((hiddenProjects || []).map((item) => String(item || '').trim()).filter(Boolean))]
  };
  fs.writeFileSync(registryPath, JSON.stringify(payload, null, 2), 'utf8');
}

function getHiddenProjects(context: vscode.ExtensionContext): string[] {
  const registry = readProjectRegistry(context);
  if (registry) {
    return registry.hiddenProjects;
  }
  return context.globalState.get<string[]>(hiddenProjectsKey) || [];
}

function getProjects(context: vscode.ExtensionContext): SolopreneurProject[] {
  const registry = readProjectRegistry(context);
  const legacyProjects = context.globalState.get<SolopreneurProject[]>(projectsKey) || [];
  const savedProjects = registry ? registry.projects : legacyProjects;
  const hiddenProjects = new Set(registry ? registry.hiddenProjects : (context.globalState.get<string[]>(hiddenProjectsKey) || []));
  const workspaceRoot = getWorkspaceRoot();
  const projects = normalizeProjectsForStorage(savedProjects);

  if (workspaceRoot && !hiddenProjects.has(workspaceRoot) && !projects.some((project) => project.path === workspaceRoot)) {
    projects.unshift({
      name: projectName(workspaceRoot),
      path: workspaceRoot
    });
  }

  const normalizedProjects = normalizeProjectsForStorage(projects);
  if (!registry) {
    writeProjectRegistry(context, normalizedProjects, [...hiddenProjects]);
  }
  return sortProjectsForDisplay(normalizedProjects);
}

function getSelectedProjectPath(context: vscode.ExtensionContext): string {
  const projects = getProjects(context);
  const savedSelected = context.globalState.get<string>(selectedProjectKey) || '';
  if (savedSelected && projects.some((project) => project.path === savedSelected)) {
    return savedSelected;
  }
  return projects[0]?.path || '';
}

function getProjectState(context: vscode.ExtensionContext): { projects: SolopreneurProject[]; selectedProjectPath: string } {
  const projects = getProjects(context);
  return {
    projects,
    selectedProjectPath: getSelectedProjectPath(context)
  };
}

function readUsageRoadmapNodes(projectPath: string): Array<{ id: string; status: string }> {
  const roadmapPath = path.join(projectPath, '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    return [];
  }
  try {
    const parsed = Papa.parse<{ id: string; status: string }>(fs.readFileSync(roadmapPath, 'utf8'), {
      header: true,
      skipEmptyLines: true
    });
    return parsed.data
      .map((node) => ({
        id: String(node.id || '').trim(),
        status: String(node.status || 'Pending').trim() || 'Pending'
      }))
      .filter((node) => node.id);
  } catch {
    return [];
  }
}

function getLatestRunTimestamp(runsRoot: string): { count: number; latestAt: string } {
  let count = 0;
  let latest = 0;
  try {
    const runNames = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : [];
    for (const runName of runNames) {
      const runDir = path.join(runsRoot, runName);
      if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
        continue;
      }
      count += 1;
      const startedAtPath = path.join(runDir, 'started_at');
      let timestamp = 0;
      if (fs.existsSync(startedAtPath)) {
        const parsed = Date.parse(fs.readFileSync(startedAtPath, 'utf8').trim());
        timestamp = Number.isFinite(parsed) ? parsed : 0;
      }
      if (!timestamp) {
        timestamp = fs.statSync(runDir).mtimeMs;
      }
      latest = Math.max(latest, timestamp);
    }
  } catch {
    return { count, latestAt: latest ? new Date(latest).toISOString() : '' };
  }
  return { count, latestAt: latest ? new Date(latest).toISOString() : '' };
}

function refreshLocalUsageSnapshot(context: vscode.ExtensionContext, stats: LocalUsageStats): LocalUsageStats {
  const projects = getProjects(context);
  let projectsWithRoadmap = 0;
  let roadmapNodeCount = 0;
  let completedNodeCount = 0;
  let failedNodeCount = 0;
  let runningNodeCount = 0;
  let inProgressNodeCount = 0;
  let pendingNodeCount = 0;
  let issueCacheProjectCount = 0;
  let deliveryCacheProjectCount = 0;
  let agentRunDirectoryCount = 0;
  let latestAgentRunAtMs = 0;

  for (const project of projects) {
    const nodes = readUsageRoadmapNodes(project.path);
    if (nodes.length > 0) {
      projectsWithRoadmap += 1;
    }
    roadmapNodeCount += nodes.length;
    completedNodeCount += nodes.filter((node) => node.status === 'Completed').length;
    failedNodeCount += nodes.filter((node) => node.status === 'Failed').length;
    runningNodeCount += nodes.filter((node) => node.status === 'Running').length;
    inProgressNodeCount += nodes.filter((node) => node.status === 'In Progress').length;
    pendingNodeCount += nodes.filter((node) => node.status === 'Pending').length;
    if (fs.existsSync(path.join(project.path, '.solopreneur', 'issues-cache.json'))) {
      issueCacheProjectCount += 1;
    }
    if (fs.existsSync(path.join(project.path, '.solopreneur', 'delivery-cache.json'))) {
      deliveryCacheProjectCount += 1;
    }
    const runStats = getLatestRunTimestamp(path.join(project.path, '.solopreneur', 'agent-runs'));
    agentRunDirectoryCount += runStats.count;
    const runMs = runStats.latestAt ? Date.parse(runStats.latestAt) : 0;
    latestAgentRunAtMs = Number.isFinite(runMs) ? Math.max(latestAgentRunAtMs, runMs) : latestAgentRunAtMs;
  }

  return {
    ...stats,
    extensionVersion: getExtensionVersion(context) || stats.extensionVersion,
    snapshot: {
      registeredProjectCount: projects.length,
      projectsWithRoadmap,
      roadmapNodeCount,
      completedNodeCount,
      failedNodeCount,
      runningNodeCount,
      inProgressNodeCount,
      pendingNodeCount,
      projectProgressPercent: roadmapNodeCount > 0 ? Math.round((completedNodeCount / roadmapNodeCount) * 100) : 0,
      issueCacheProjectCount,
      deliveryCacheProjectCount,
      agentRunDirectoryCount,
      latestAgentRunAt: latestAgentRunAtMs ? new Date(latestAgentRunAtMs).toISOString() : ''
    }
  };
}

type LocalUsageEvent =
  | 'activation'
  | 'roadmapOpened'
  | 'projectAdded'
  | 'agentRun'
  | 'soloConversation'
  | 'roadmapRevision'
  | 'feedbackIssueOpened';

function recordLocalUsageEvent(context: vscode.ExtensionContext, event: LocalUsageEvent): LocalUsageStats {
  const now = new Date().toISOString();
  let stats = readLocalUsageStats(context);
  const counters = { ...stats.counters };
  if (event === 'activation') counters.activations += 1;
  if (event === 'roadmapOpened') counters.roadmapOpens += 1;
  if (event === 'projectAdded') counters.projectsAdded += 1;
  if (event === 'agentRun') counters.agentRuns += 1;
  if (event === 'soloConversation') counters.soloConversations += 1;
  if (event === 'roadmapRevision') counters.roadmapRevisions += 1;
  if (event === 'feedbackIssueOpened') counters.feedbackIssuesOpened += 1;
  stats = {
    ...stats,
    updatedAt: now,
    extensionVersion: getExtensionVersion(context) || stats.extensionVersion,
    counters,
    lastEventAt: {
      ...stats.lastEventAt,
      [event]: now
    }
  };
  if (event === 'feedbackIssueOpened') {
    stats = refreshLocalUsageSnapshot(context, stats);
  }
  try {
    writeLocalUsageStats(context, stats);
  } catch (error) {
    console.error('SoloMap failed to write local usage stats:', error);
  }
  return stats;
}

function buildFeedbackUsageSummary(context: vscode.ExtensionContext): string {
  const stats = recordLocalUsageEvent(context, 'feedbackIssueOpened');
  const snapshot = stats.snapshot;
  return [
    'This anonymous local summary is included only because the user opened a feedback issue.',
    `Stats file: .solomap-global/usage/${usageStatsFileName}`,
    `Extension version: ${stats.extensionVersion || 'unknown'}`,
    `First opened: ${stats.createdAt || 'unknown'}`,
    `Last updated: ${stats.updatedAt || 'unknown'}`,
    '',
    'Counters:',
    `- Activations: ${stats.counters.activations}`,
    `- Roadmap opens: ${stats.counters.roadmapOpens}`,
    `- Projects added: ${stats.counters.projectsAdded}`,
    `- Agent runs requested: ${stats.counters.agentRuns}`,
    `- Solo conversations requested: ${stats.counters.soloConversations}`,
    `- Roadmap revisions requested: ${stats.counters.roadmapRevisions}`,
    '',
    'Local snapshot:',
    `- Registered projects: ${snapshot.registeredProjectCount}`,
    `- Projects with roadmap: ${snapshot.projectsWithRoadmap}`,
    `- Roadmap nodes: ${snapshot.roadmapNodeCount}`,
    `- Completed / failed / running / in progress / pending: ${snapshot.completedNodeCount} / ${snapshot.failedNodeCount} / ${snapshot.runningNodeCount} / ${snapshot.inProgressNodeCount} / ${snapshot.pendingNodeCount}`,
    `- Project progress: ${snapshot.projectProgressPercent}%`,
    `- Projects with Issue cache: ${snapshot.issueCacheProjectCount}`,
    `- Projects with delivery cache: ${snapshot.deliveryCacheProjectCount}`,
    `- Local Agent run directories: ${snapshot.agentRunDirectoryCount}`,
    `- Latest local Agent run: ${snapshot.latestAgentRunAt || 'none'}`,
    '',
    'Privacy:',
    '- No project paths, project names, Issue titles, Agent outputs, prompts, logs, or file contents are included.'
  ].join('\n');
}

async function saveProjects(context: vscode.ExtensionContext, projects: SolopreneurProject[]): Promise<void> {
  const normalizedProjects = normalizeProjectsForStorage(projects);
  writeProjectRegistry(context, normalizedProjects, getHiddenProjects(context));
  await context.globalState.update(projectsKey, normalizedProjects);
}

async function setProjectHidden(context: vscode.ExtensionContext, projectPath: string, hidden: boolean): Promise<void> {
  const hiddenProjects = new Set(getHiddenProjects(context));
  if (hidden) {
    hiddenProjects.add(projectPath);
  } else {
    hiddenProjects.delete(projectPath);
  }
  writeProjectRegistry(context, getProjects(context), [...hiddenProjects]);
  await context.globalState.update(hiddenProjectsKey, [...hiddenProjects]);
}

async function selectProject(context: vscode.ExtensionContext, projectPath: string): Promise<void> {
  const projects = getProjects(context);
  if (!projects.some((project) => project.path === projectPath)) {
    vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
    return;
  }

  await context.globalState.update(selectedProjectKey, projectPath);
  syncEngine = null;
  activeProjectRoot = null;
  syncEngineReady = false;
  syncEngineInitPromise = null;
  syncEngineInitProjectRoot = '';
  if (watcher) {
    watcher.dispose();
    watcher = null;
  }
  if (statusPoller) {
    clearInterval(statusPoller);
    statusPoller = null;
  }
  sendLocalProjectsToWebviews(context);
  if (activePanel) {
    activePanel.webview.postMessage({ command: 'roadmapLoading', projectPath });
  }
  void ensureSyncEngine(context).then((ready) => {
    if (ready) {
      sendNodesToWebview();
      void postFlowStateToWebview(context);
    }
  });
}

async function updateProjectMetadata(context: vscode.ExtensionContext, projectPath: string, updates: Partial<Pick<SolopreneurProject, 'type' | 'priority'>>): Promise<void> {
  const projects = getProjects(context);
  const nextProjects = projects.map((project) => {
    if (project.path !== projectPath) {
      return project;
    }
    return {
      ...project,
      ...(updates.type !== undefined ? { type: String(updates.type || '') } : {}),
      ...(updates.priority !== undefined ? { priority: String(updates.priority || '') } : {})
    };
  });
  await saveProjects(context, nextProjects);
  sendLocalProjectsToWebviews(context);
}

async function toggleProjectPinned(context: vscode.ExtensionContext, projectPath: string): Promise<void> {
  const projects = getProjects(context);
  if (!projects.some((project) => project.path === projectPath)) {
    vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
    return;
  }
  const nextProjects = projects.map((project) => {
    if (project.path !== projectPath) {
      return project;
    }
    const { pinnedAt, ...rest } = project;
    return pinnedAt ? rest : { ...project, pinnedAt: new Date().toISOString() };
  });
  await saveProjects(context, nextProjects);
  sendLocalProjectsToWebviews(context);
}

function buildSolopreneurDirectoryReadme(): string {
  return [
    '# SoloMap Project Data',
    '',
    '这个目录由 SoloMap 自动创建，用来保存当前项目的路线图、Agent 对话记录、执行日志和环节交接总结。',
    '',
    '## 为什么数据放在项目里',
    '',
    '- 项目数据跟随项目文件夹走，不依赖插件后端服务。',
    '- 换一台机器、换一个 IDE、重新安装插件后，只要项目文件还在，SoloMap 就能重新加载这些数据。',
    '- 这个目录可以交给 Git/GitHub 管理，让路线图、交接总结和执行记录成为项目历史的一部分。',
    '',
    '## 主要文件',
    '',
    '- `roadmap.csv`：路线图主数据，包括环节、依赖、状态和 Agent prompt。',
    '- `step-memory/`：每个路线图环节的 JSON 完成标准和交接总结。下一轮 Agent 对话会读取这里的结构化上下文。',
    '- `step-sessions/`：每个路线图环节按 Agent 保存原生会话 ID。后续对话会把这些会话 ID 作为可选参考交给 Agent，而不是强制续接。',
    '- `documentation.json`：项目解释性文档的索引与审计状态。它由 SoloMap 维护，用来帮助 Agent 优先更新正确文档并识别文档噪音。',
    '- `project_journal.db`：本地 SQLite 执行日志，保存更完整的 Agent 对话和历史记录。',
    '- `agent-runs/`：每次 Agent 调用的输出、文件变更摘要和完成判断。',
    '- `run-digests/`：每次 Agent 调用结束后的结构化执行摘要和跨 Agent 交接信号。下一轮相关任务会读取少量摘要来减少重复探索。',
    '- `execution-graph.json`：由 run digest 自动生成的轻量索引，按环节、Agent、文件、状态、失败和命令组织最近执行信号。',
    '- `.agent_status.json`：临时运行状态文件，通常会被插件自动清理。',
    '',
    '## 请不要随意删除',
    '',
    '删除这个目录会导致 SoloMap 无法恢复该项目的路线图、状态、对话历史和环节交接总结。需要清理体积时，优先只清理 `agent-runs/` 中很旧的运行记录，并保留 `roadmap.csv` 和 `step-memory/`。',
    '',
    '## Git 建议',
    '',
    '如果你希望项目在多台机器或多个 IDE 间保持一致，可以把 `.solopreneur/` 提交到 Git。这样 SoloMap 的项目上下文会跟项目代码一起迁移。'
  ].join('\n');
}

function buildBootstrapRoadmapInstructions(cliPath: string): string {
  return [
    '# Bootstrap Roadmap Instructions',
    '',
    '你当前的任务是为这个项目生成真正可执行的定制化路线图，并直接重写 `.solopreneur/roadmap.csv`。',
    '',
    '## 必做前置阅读',
    '- 阅读当前项目目录中的 README、docs、源码入口以及 `.solopreneur/README.md`（如果存在）。',
    '- 阅读 `.solopreneur/roadmap-methodology.md`，按项目真实目标选择适用的推进框架。',
    '- 理解这个项目当前要交付什么、服务谁、是否需要对外获客或销售，以及当前文件里已经有哪些线索。',
    '',
    '## 项目类别与路线图形态规范（核心精髓）',
    '你必须首先根据当前项目的文件和描述，准确判断项目属于以下 6 个类别中的哪一个，并严格按照该类别的推进精髓和完成标准生成定制路线图：',
    '',
    '1. **核心产品类 (Core Product)**',
    '   - 定义：面向外部用户、需获客和转化、强调商业化或影响力闭环。',
    '   - 初始阶段：`问题与客户发现` -> `产品与 MVP` -> `营销与销售` -> `反馈与规模化`。',
    '   - 核心任务：不可退化为纯工程任务，必须覆盖官网/定位/获客转化、反馈收集、以及 Build->Sell->Learn->Improve 的持续改进循环。',
    '',
    '2. **基础设施类 (Infrastructure)**',
    '   - 定义：被 3+ 个其他项目依赖的公共层，变更影响面大，稳定性与版本管理第一。',
    '   - 初始阶段：`能力设计` -> `核心实现` -> `标准化` -> `验证` -> `治理` -> `运维`。',
    '   - 核心任务：定义明确的接入规范与契约、编写接入文档与示例、找业务项目作为首个消费者进行真实验证、设计语义化版本管理和向后兼容迁移路径、部署运行监控。',
    '',
    '3. **内容产品类 (Content Product)**',
    '   - 定义：小说连载、周刊、定期报告、数据分析、视频系列等以内容为核心交付物的项目。',
    '   - 初始阶段：`内容规划` -> `工程化` -> `生产` -> `分发` -> `改进` -> `运维`。',
    '   - 核心任务：明确受众与周期性发布节奏、设计工程化与自动化生产工作流、建设 2+ 分发渠道、收集互动反馈。',
    '',
    '4. **试验和研究类 (Experiment & Research)**',
    '   - 定义：快速试错，验证新技术栈或想法假设，成功的定义是学到了什么、验证了什么。',
    '   - 初始阶段：`目标确认` -> `原型开发` -> `评估` -> `总结`。',
    '   - 核心任务：约束较短的时间点（通常 2-4 周）、明确需验证的假设或技术点、允许结果失败、最终必须将成功/失败的知识结论总结沉淀。',
    '',
    '5. **工具和脚手架类 (Tools & Scaffolding)**',
    '   - 定义：为了减少重复工作，提升自己或团队效率的工具、脚本、框架或模板。',
    '   - 初始阶段：`需求确认` -> `开发` -> `文档` -> `验证` -> `维护`。',
    '   - 核心任务：明确使用场景及价值、实现核心功能、编写极简的集成与使用指南（使接入成本 <30 分钟）、在 2+ 真实项目中测试验证。',
    '',
    '6. **归档和维护类 (Archive & Maintenance)**',
    '   - 定义：已上线、相对稳定、不需要频繁加功能、追求无人值守保持健康的项目。',
    '   - 初始阶段：`评估` -> `建设` -> `维护` -> `文档` -> `流程建设`。',
    '   - 核心任务：评估健康状况、补齐缺少的监控与告警体系、更新维护指南（确保新维护者快速上手）、升级依赖安全漏洞、设计自动化定期检查。',
    '',
    '## 你的唯一交付物',
    '- 直接重写 `.solopreneur/roadmap.csv`。',
    '- 不要只在终端输出路线图建议。',
    '- 不要把本文件内容、提示词模板或解释性说明写回 CSV。',
    '',
    '## CSV 硬约束',
    '1. 保留 CSV 表头，字段顺序必须严格是：`id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt`。',
    '2. 生成 2 到 8 个环节，数量应服从上述选定类别的真实交付路径，不为套模板而虚构任务。',
    '3. 标题、描述、agentPrompt 全部使用中文。',
    '4. `stage` 填入上述相应类别中指定的推进阶段名称。',
    `5. 每一行 \`agentCli\` 都写 \`${cliPath}\`。`,
    '6. `dependencies` 必须反映真实前置关系；第一个环节留空，后续依赖前面环节的 id。',
    '7. `status` 全部写 `Pending`，`completedAt` 留空，`createdAt` 写当前 ISO 时间。',
    '8. 每个 `agentPrompt` 都必须具体且可落地，要求后续 Agent 创建或修改本地文件、页面或配置，并配置好最窄验证（例如测试/运行命令），禁止产出空泛务虚的规划或咨询报告任务。',
    '',
    '## 结束前自检',
    '- 重新读取 `.solopreneur/roadmap.csv`。',
    '- 必须运行 `node .solopreneur/validate-roadmap.cjs --mode bootstrap` 校验最终路线图。',
    '- 如果校验失败，按终端输出修正 `.solopreneur/roadmap.csv` 后重新运行，直到通过。',
    '- 只有校验通过后，才允许在最终回复中说明任务完成。',
    '- 确认 CSV 中没有残留“生成初始路线图”、本文件原文或提示词模板。'
  ].join('\n');
}

function buildRoadmapValidationScript(): string {
  return String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const requiredColumns = ['id', 'title', 'description', 'stage', 'dependencies', 'agentCli', 'agentPrompt', 'status', 'createdAt', 'completedAt'];
const bootstrapMarkers = [
  '你的唯一主任务是直接重写 .solopreneur/roadmap.csv',
  '你的唯一交付物是直接重写 .solopreneur/roadmap.csv',
  '保留 CSV 表头且字段顺序必须严格是',
  '生成初始路线图',
  '.solopreneur/bootstrap-roadmap-instructions.md',
  '不要把本文件内容、提示词模板或解释性说明写回 CSV'
];

function parseArgs(argv) {
  const args = { mode: 'revision' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--mode' && argv[index + 1]) {
      args.mode = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (inQuotes) {
    throw new Error('CSV 引号未闭合。');
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const nonEmptyRows = rows.filter((candidate) => candidate.some((value) => String(value || '').trim()));
  if (!nonEmptyRows.length) {
    return { fields: [], data: [] };
  }
  const fields = nonEmptyRows[0].map((field) => String(field || '').trim());
  return {
    fields,
    data: nonEmptyRows.slice(1).map((values) => {
      const entry = {};
      fields.forEach((field, index) => {
        entry[field] = values[index] === undefined ? '' : values[index];
      });
      return entry;
    })
  };
}

function normalizeNodes(data) {
  return data.map((node) => ({
    id: String(node.id || '').trim(),
    title: String(node.title || '').trim(),
    description: String(node.description || '').trim(),
    stage: String(node.stage || '').trim(),
    dependencies: String(node.dependencies || '').trim(),
    agentCli: String(node.agentCli || '').trim(),
    agentPrompt: String(node.agentPrompt || '').trim(),
    status: String(node.status || '').trim()
  })).filter((node) => node.id);
}

function fail(reason) {
  console.error('FAIL roadmap validation: ' + reason);
  process.exit(1);
}

function pass(mode, count) {
  console.log('PASS roadmap validation: ' + mode + ' (' + count + ' steps)');
}

function validateCommon(fields, nodes, label) {
  if (requiredColumns.some((field) => !fields.includes(field))) {
    fail(label + ' roadmap.csv 格式不完整。字段必须包含：' + requiredColumns.join(', '));
  }
  if (!nodes.length) {
    fail(label + '路线图没有可执行环节。');
  }
  const ids = nodes.map((node) => node.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    fail(label + '路线图存在重复环节 ID。');
  }
  if (nodes.some((node) => !node.title || !node.stage || !node.description || !node.agentPrompt)) {
    fail(label + '路线图存在缺少标题、阶段、描述或 Agent 任务的环节。');
  }
  for (const node of nodes) {
    const dependencies = node.dependencies.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (dependencies.includes(node.id) || dependencies.some((entry) => !idSet.has(entry))) {
      fail(label + '路线图存在无效依赖关系。');
    }
  }
}

function main() {
  const { mode } = parseArgs(process.argv.slice(2));
  if (!['bootstrap', 'revision'].includes(mode)) {
    fail('未知 mode：' + mode + '。请使用 --mode bootstrap 或 --mode revision。');
  }
  const roadmapPath = path.join(process.cwd(), '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    fail('未找到 .solopreneur/roadmap.csv。');
  }
  let parsed;
  try {
    parsed = parseCsv(fs.readFileSync(roadmapPath, 'utf8'));
  } catch (error) {
    fail('roadmap.csv 无法解析：' + (error && error.message ? error.message : error));
  }
  const nodes = normalizeNodes(parsed.data);
  validateCommon(parsed.fields, nodes, mode === 'bootstrap' ? '生成后的' : '调整后的');
  if (mode === 'bootstrap') {
    if (nodes.length < 2 || nodes.length > 8) {
      fail('生成后的路线图环节数量不在 2 到 8 个之间。');
    }
    if (nodes.some((node) => node.status !== 'Pending')) {
      fail('生成后的路线图所有环节都必须回到 Pending。');
    }
    if (nodes.some((node) => bootstrapMarkers.some((marker) => node.title.includes(marker) || node.agentPrompt.includes(marker)))) {
      fail('生成后的 roadmap.csv 仍然残留了初始化提示词，没有真正写成业务路线图。');
    }
    if (nodes.some((node) => node.title === '生成初始路线图')) {
      fail('生成后的路线图仍然保留了原始 bootstrap 节点。');
    }
  } else {
    const allowedStatuses = new Set(['Pending', 'In Progress', 'Running', 'Completed', 'Failed']);
    if (nodes.some((node) => !allowedStatuses.has(node.status))) {
      fail('调整后的路线图存在无法识别的环节状态。');
    }
  }
  pass(mode, nodes.length);
}

main();
`;
}

function buildRoadmapMethodologyInstructions(): string {
  return [
    '# SoloMap Roadmap Methodology',
    '',
    'SoloMap 路线图不是普通任务清单。它应先匹配项目真实要达成的结果，再给出可执行的推进路径。',
    '',
    '```text',
    '目标与对象 -> 可验证交付 -> 真实结果反馈 -> 下一轮改进',
    '```',
    '',
    '## 商业化产品的默认四阶段',
    '',
    '当项目面向外部用户，并需要获得采用、付费或市场验证时，默认覆盖以下四阶段：',
    '',
    '1. `问题与客户发现`：明确值得解决的问题、目标用户、验证方式和第一步行动。',
    '2. `产品与 MVP`：把问题转成可运行、可验证的产品切片，包括需求、架构、数据、测试、部署或维护。',
    '3. `营销与销售`：让产品被发现、理解、信任并产生转化，包括品牌、官网、发布、销售或需求生成。',
    '4. `反馈与规模化`：建立 Build -> Sell -> Learn -> Improve 循环，包括数据、客户反馈、支持、单位经济模型或扩张机会。',
    '',
    '## 不应强行套用四阶段的情况',
    '',
    '- 内部工具、基础设施、迁移、合规修复、研究验证或内容交付等项目，如果目标不包含对外获客或销售，就按其真实交付与验收路径安排阶段。',
    '- 不要为了满足模板，为不存在的客户、营销、销售或规模化目标创造任务。',
    '- 如果项目证据不足以判断是否需要商业化路径，在路线图中先安排澄清目标与成功标准的可交付动作，而不是擅自套用。',
    '',
    '## 所有路线图的共同底线',
    '',
    '- 阶段名称和任务应服务项目实际结果，不服务固定模板。',
    '- 对确实需要用户采用、获客或转化的产品，不要把路线图退化成只写代码的工程任务。',
    '- Build -> Sell -> Learn -> Improve 是底层判断模型，不是让用户手工维护的表单、说明页或侧边栏大组件。',
    '- 用四阶段判断项目是否失衡，并把结果转成明确的下一步动作。',
    '- 不要只生成研究、分析、规划这类无本地交付物的任务。',
    '- 每个环节都必须能通过 Agent 对话推进，并产生本地文件、验证结果、市场材料或反馈记录。',
    '- 每个环节都必须能被完成标准判断：交付物是什么、证据在哪里、是否还需要下一轮推进。',
    '- 如果项目还没有代码，也要先产出项目文档、访谈问题、MVP 边界或发布材料等可提交文件。',
    '- 路线图应该让用户始终知道下一步，而不是让用户阅读一份静态计划。',
    '',
    '## 推荐循环',
    '',
    '```text',
    '项目目标 -> 适配的路线图 -> 下一步动作 -> Agent 对话 -> 本地交付 -> 结果验证 -> 路线图更新',
    '```'
  ].join('\n');
}

function ensureSolopreneurReadme(solopreneurDir: string): void {
  const readmePath = path.join(solopreneurDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, buildSolopreneurDirectoryReadme(), 'utf8');
  }
}

function ensureBootstrapRoadmapInstructions(solopreneurDir: string, cliPath: string): void {
  const instructionsPath = path.join(solopreneurDir, 'bootstrap-roadmap-instructions.md');
  fs.writeFileSync(instructionsPath, buildBootstrapRoadmapInstructions(cliPath), 'utf8');
}

function ensureRoadmapValidationScript(solopreneurDir: string): void {
  const scriptPath = path.join(solopreneurDir, 'validate-roadmap.cjs');
  fs.mkdirSync(solopreneurDir, { recursive: true });
  fs.writeFileSync(scriptPath, buildRoadmapValidationScript(), { encoding: 'utf8', mode: 0o755 });
  try {
    fs.chmodSync(scriptPath, 0o755);
  } catch {
    // chmod is best-effort for platforms that support POSIX file modes.
  }
}

function ensureRoadmapMethodologyInstructions(solopreneurDir: string): void {
  const instructionsPath = path.join(solopreneurDir, 'roadmap-methodology.md');
  fs.writeFileSync(instructionsPath, buildRoadmapMethodologyInstructions(), 'utf8');
}

function getStepMemoryFilePath(workspaceRoot: string, nodeId: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'step-memory', `${nodeId}.json`);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, 8);
}

function buildCompletionCriteriaForNode(node: RoadmapNode): string[] {
  const stage = String(node.stage || '').trim();
  const title = String(node.title || '当前环节').trim();
  const prompt = String(node.agentPrompt || '').trim();
  const criteria: string[] = [
    `已经围绕“${title}”产出可提交的本地文件、页面、配置、市场材料或反馈记录。`
  ];

  if (stage === '问题与客户发现') {
    criteria.push('问题假设、目标用户、验证方式、风险和下一步行动已经写入项目文件。');
  } else if (stage === '产品与 MVP') {
    criteria.push('MVP 或产品切片已经能被运行、查看或按文档验证。');
  } else if (stage === '营销与销售') {
    criteria.push('定位、触达、官网、发布、销售或转化材料已经形成可直接使用的版本。');
  } else if (stage === '反馈与规模化') {
    criteria.push('反馈来源、关键指标、支持信号、单位经济假设或下一轮改进任务已经记录清楚。');
  } else {
    criteria.push('本环节说明中的核心交付物已经落到项目文件中。');
  }

  if (/测试|验证|校验|运行|test|check|build/i.test(prompt)) {
    criteria.push('已经运行最窄必要验证命令；如果无法运行，原因和替代检查已记录。');
  } else {
    criteria.push('已经完成一次最小自检，并在输出中说明本轮结果。');
  }

  criteria.push('如果仍需后续推进，已经留下明确的下一次建议；如果不需要，Agent 或用户可以安全标记该环节完成。');
  return criteria;
}

function readStepMemoryObject(filePath: string): Record<string, unknown> {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readCompletionCriteria(workspaceRoot: string, node: RoadmapNode): string[] {
  const filePath = getStepMemoryFilePath(workspaceRoot, node.id || '');
  const memory = readStepMemoryObject(filePath);
  const existing = normalizeStringList(memory.completionCriteria);
  return existing.length > 0 ? existing : buildCompletionCriteriaForNode(node);
}

function ensureCompletionCriteriaForNodes(workspaceRoot: string, nodes: RoadmapNode[], options: { writeMissing?: boolean } = {}): RoadmapNode[] {
  if (!workspaceRoot) {
    return nodes;
  }
  const writeMissing = options.writeMissing !== false;
  return nodes.map((node) => {
    const filePath = getStepMemoryFilePath(workspaceRoot, node.id || '');
    const legacyFilePath = getLegacyStepMemoryFilePath(workspaceRoot, node.id || '');
    const memory = readStepMemoryObject(filePath);
    const existingCriteria = normalizeStringList(memory.completionCriteria);
    const completionCriteria = existingCriteria.length > 0 ? existingCriteria : buildCompletionCriteriaForNode(node);
    if (writeMissing && existingCriteria.length === 0) {
      const legacyEntries = !fs.existsSync(filePath) && fs.existsSync(legacyFilePath)
        ? parseStepHandoffEntries(fs.readFileSync(legacyFilePath, 'utf8'))
        : [];
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        version: Number(memory.version || 1),
        format: String(memory.format || 'solopreneur.stepHandoff'),
        description: String(memory.description || 'Step memory used by SoloMap. completionCriteria defines when this roadmap step can be closed. entries keeps real Agent run handoffs.'),
        completionCriteria,
        lastCompletionEvidence: normalizeStringList(memory.lastCompletionEvidence),
        entries: Array.isArray(memory.entries) ? memory.entries : legacyEntries
      }, null, 2), 'utf8');
    }
    return {
      ...node,
      completionCriteria
    };
  });
}

function normalizeSupplementFiles(files: unknown): string[] {
  if (!Array.isArray(files)) {
    return [];
  }
  const normalized = files
    .map((file) => String(file || '').trim())
    .filter(Boolean)
    .filter((file, index, all) => all.indexOf(file) === index)
    .slice(0, 10);
  return normalized;
}

function filterProjectRelativeFiles(workspaceRoot: string, files: string[]): string[] {
  return normalizeSupplementFiles(files).filter((relativePath) => {
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    const relativeToRoot = path.relative(workspaceRoot, absolutePath);
    return Boolean(relativeToRoot)
      && !relativeToRoot.startsWith('..')
      && !path.isAbsolute(relativeToRoot)
      && fs.existsSync(absolutePath)
      && fs.statSync(absolutePath).isFile();
  });
}

interface PastedImageAttachment {
  name?: string;
  mimeType?: string;
  dataUrl?: string;
}

function sanitizeAttachmentScope(scope: string): string {
  const normalized = String(scope || 'conversation')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'conversation';
}

function imageExtensionFromMimeType(mimeType: string): string {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  return 'png';
}

function savePastedImageAttachments(projectRoot: string, scope: string, attachments: PastedImageAttachment[]): string[] {
  if (!projectRoot || !Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const safeScope = sanitizeAttachmentScope(scope);
  const targetDir = path.join(projectRoot, '.solopreneur', 'attachments', safeScope);
  fs.mkdirSync(targetDir, { recursive: true });

  return attachments.slice(0, 10).map((attachment, index) => {
    const dataUrl = String(attachment?.dataUrl || '');
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/);
    if (!match) {
      return '';
    }
    const mimeType = String(attachment.mimeType || match[1] || 'image/png').toLowerCase();
    if (!mimeType.startsWith('image/')) {
      return '';
    }
    const extension = imageExtensionFromMimeType(mimeType);
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const randomId = Math.random().toString(16).slice(2, 8);
    const fileName = `${timestamp}-${randomId}-${index + 1}.${extension}`;
    const filePath = path.join(targetDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(match[2].replace(/\s/g, ''), 'base64'));
    return path.relative(projectRoot, filePath).split(path.sep).join('/');
  }).filter(Boolean);
}

async function chooseSupplementFilesForNode(nodeId: string): Promise<void> {
  if (!activeProjectRoot || !activePanel) {
    vscode.window.showErrorMessage('Choose a project folder before attaching task files.');
    return;
  }

  const files = await chooseSupplementFilesForProject(activeProjectRoot);
  activePanel.webview.postMessage({
    command: 'supplementFilesSelected',
    nodeId,
    files
  });
}

async function chooseSupplementFilesForProject(projectRoot: string): Promise<string[]> {
  const files = listProjectAttachmentCandidates(projectRoot);
  if (!files.length) {
    vscode.window.showInformationMessage('当前项目里还没有可选择的补充文件。');
    return [];
  }

  const selected = await vscode.window.showQuickPick(
    files.map((file) => ({
      label: file,
      description: path.dirname(file) === '.' ? '' : path.dirname(file)
    })),
    {
      canPickMany: true,
      matchOnDescription: true,
      placeHolder: '选择要附加给 Agent 的项目文件',
      title: '添加补充文件'
    }
  );

  return (selected || []).map((item) => item.label).slice(0, 10);
}

function listProjectAttachmentCandidates(projectRoot: string): string[] {
  const fromGit = listProjectFilesFromGit(projectRoot);
  if (fromGit.length > 0) {
    return fromGit;
  }
  const fromRipgrep = listProjectFilesFromCommand('rg', ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', '!cache', '-g', '!.solopreneur/agent-runs'], projectRoot);
  if (fromRipgrep.length > 0) {
    return fromRipgrep;
  }
  return listProjectFilesByWalking(projectRoot);
}

function listProjectFilesFromGit(projectRoot: string): string[] {
  const files = listProjectFilesFromCommand('git', ['-C', projectRoot, 'ls-files', '--cached', '--others', '--exclude-standard'], projectRoot);
  return files.filter((file) => !file.startsWith('.solopreneur/agent-runs/'));
}

function listProjectFilesFromCommand(command: string, args: string[], projectRoot: string): string[] {
  try {
    const output = childProcess.execFileSync(command, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
      maxBuffer: 1024 * 1024
    });
    return normalizeAttachmentCandidateFiles(projectRoot, output.split(/\r?\n/));
  } catch {
    return [];
  }
}

function listProjectFilesByWalking(projectRoot: string): string[] {
  const results: string[] = [];
  const skip = new Set(['.git', 'node_modules', 'cache']);
  const walk = (directory: string) => {
    if (results.length >= 1500) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 1500) {
        return;
      }
      if (skip.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(projectRoot, absolutePath).split(path.sep).join('/');
      if (relativePath.startsWith('.solopreneur/agent-runs/')) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile()) {
        results.push(relativePath);
      }
    }
  };
  walk(projectRoot);
  return normalizeAttachmentCandidateFiles(projectRoot, results);
}

function normalizeAttachmentCandidateFiles(projectRoot: string, files: string[]): string[] {
  const seen = new Set<string>();
  return files
    .map((file) => String(file || '').trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((file) => {
      if (seen.has(file)) {
        return false;
      }
      seen.add(file);
      const absolutePath = path.resolve(projectRoot, file);
      const relativeToRoot = path.relative(projectRoot, absolutePath);
      return Boolean(relativeToRoot)
        && !relativeToRoot.startsWith('..')
        && !path.isAbsolute(relativeToRoot)
        && fs.existsSync(absolutePath)
        && fs.statSync(absolutePath).isFile();
    })
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 1500);
}

async function addProjectFromDialog(context: vscode.ExtensionContext): Promise<void> {
  const result = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use This Folder'
  });

  const folder = result?.[0]?.fsPath;
  if (!folder) {
    return;
  }

  const projects = getProjects(context);
  if (!projects.some((project) => project.path === folder)) {
    const projectType = await vscode.window.showQuickPick([
      { label: '核心产品', description: '面向外部用户，需要获客、采用、付费或持续使用', value: 'core_product' },
      { label: '基础设施', description: '为多个项目提供能力，重视契约、治理和兼容性', value: 'infra' },
      { label: '内容产品', description: '围绕内容生产、发布、分发和反馈持续运转', value: 'content' },
      { label: '试验研究', description: '验证想法或学习技术，重点是获得结论', value: 'experiment' },
      { label: '工具脚手架', description: '减少重复工作，供自己或多个项目复用', value: 'tool' },
      { label: '日常工作处理', description: '承接持续发生的事务、支持、运营、排障和日常推进', value: 'daily_work' },
      { label: '归档维护', description: '已上线或稳定项目，重点是健康检查和维护', value: 'archive' }
    ], {
      placeHolder: '这个项目更像哪一类？'
    });
    if (!projectType) {
      return;
    }
    projects.push({
      name: projectName(folder),
      path: folder,
      type: projectType.value
    });
    await saveProjects(context, projects);
    recordLocalUsageEvent(context, 'projectAdded');
  }
  await setProjectHidden(context, folder, false);

  await context.globalState.update(selectedProjectKey, folder);
  syncEngine = null;
  activeProjectRoot = null;
  syncEngineReady = false;
  await ensureSyncEngine(context);
  sendProjectsToWebviews(context);
  sendNodesToWebview();
}

async function removeProject(context: vscode.ExtensionContext, projectPath: string): Promise<void> {
  const projects = getProjects(context);
  const project = projects.find((candidate) => candidate.path === projectPath);
  if (!project) {
    vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `从 SoloMap 中删除项目“${project.name}”？这只会删除该项目里的 .solopreneur 文件夹，并把项目从插件列表中移除，不会删除项目本身的代码文件夹。`,
    { modal: true },
    '确认删除'
  );
  if (confirmed !== '确认删除') {
    return;
  }

  const solopreneurDir = path.join(projectPath, '.solopreneur');
  if (fs.existsSync(solopreneurDir)) {
    fs.rmSync(solopreneurDir, { recursive: true, force: true });
  }

  const nextProjects = projects.filter((candidate) => candidate.path !== projectPath);
  await saveProjects(context, nextProjects);
  await setProjectHidden(context, projectPath, true);

  const nextSelectedProjectPath = nextProjects[0]?.path || '';
  await context.globalState.update(selectedProjectKey, nextSelectedProjectPath);

  syncEngine = null;
  activeProjectRoot = null;
  syncEngineReady = false;
  if (watcher) {
    watcher.dispose();
    watcher = null;
  }
  if (statusPoller) {
    clearInterval(statusPoller);
    statusPoller = null;
  }

  if (nextSelectedProjectPath) {
    await ensureSyncEngine(context);
  }

  sendProjectsToWebviews(context);
  sendNodesToWebview();
  vscode.window.showInformationMessage(`SoloMap 已移除项目“${project.name}”。项目文件夹本身未删除。`);
}

function sendProjectsToWebviews(context: vscode.ExtensionContext): void {
  const projects = getProjectState(context);
  if (activePanel) {
    activePanel.webview.postMessage({
      command: 'projectsLoaded',
      projects
    });
  }
  if (sidebarProvider) {
    sidebarProvider.sendProjects();
  }
}

function sendLocalProjectsToWebviews(context: vscode.ExtensionContext): void {
  const projects = getProjectState(context);
  if (activePanel) {
    activePanel.webview.postMessage({
      command: 'projectsLoaded',
      projects
    });
  }
  if (sidebarProvider) {
    sidebarProvider.sendLocalProjects();
  }
}

async function getSoloConversationHistoryForProject(context: vscode.ExtensionContext, projectPath: string): Promise<AgentConversation[]> {
  if (!getProjects(context).some((project) => project.path === projectPath)) {
    return [];
  }
  if (syncEngine && activeProjectRoot === projectPath) {
    return syncEngine.getAgentExecutions(soloConversationId).slice(0, 1);
  }
  const journalPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  if (!fs.existsSync(journalPath)) {
    return [];
  }
  const store = new SqliteStore(journalPath, context.extensionPath);
  await store.init();
  try {
    return store.getExecutionLogs(soloConversationId).slice(0, 1);
  } finally {
    store.close();
  }
}

async function getStepConversationHistoryForProject(context: vscode.ExtensionContext, projectPath: string, nodeId: string): Promise<AgentConversation[]> {
  if (!nodeId || !getProjects(context).some((project) => project.path === projectPath)) {
    return [];
  }
  if (syncEngine && activeProjectRoot === projectPath) {
    return syncEngine.getAgentExecutions(nodeId).slice(0, 1);
  }
  const journalPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  if (!fs.existsSync(journalPath)) {
    return [];
  }
  const store = new SqliteStore(journalPath, context.extensionPath);
  await store.init();
  try {
    return store.getExecutionLogs(nodeId).slice(0, 1);
  } finally {
    store.close();
  }
}

async function getProjectConversationHistoryForProject(context: vscode.ExtensionContext, projectPath: string): Promise<AgentConversation[]> {
  if (!getProjects(context).some((project) => project.path === projectPath)) {
    return [];
  }
  const excludeNodeIds = new Set([soloConversationId, roadmapRevisionId]);
  if (syncEngine && activeProjectRoot === projectPath) {
    return syncEngine.getProjectAgentExecutions()
      .filter((conversation) => !excludeNodeIds.has(String(conversation.nodeId || '')))
      .slice(0, 1);
  }
  const journalPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  if (!fs.existsSync(journalPath)) {
    return [];
  }
  const store = new SqliteStore(journalPath, context.extensionPath);
  await store.init();
  try {
    return store.getAllExecutionLogs()
      .filter((conversation) => !excludeNodeIds.has(String(conversation.nodeId || '')))
      .slice(0, 1);
  } finally {
    store.close();
  }
}

/**
 * Ensures the sync engine is initialized if a workspace is open.
 */
async function ensureSyncEngine(context: vscode.ExtensionContext): Promise<boolean> {
  const projectRoot = getSelectedProjectPath(context);
  if (syncEngine && activeProjectRoot === projectRoot && syncEngineReady) {
    return true;
  }
  if (syncEngineInitPromise && syncEngineInitProjectRoot === projectRoot) {
    return syncEngineInitPromise;
  }

  if (!projectRoot) {
    return false;
  }
  const solopreneurDir = path.join(projectRoot, '.solopreneur');

  if (!fs.existsSync(solopreneurDir)) {
    fs.mkdirSync(solopreneurDir, { recursive: true });
  }
  ensureSolopreneurReadme(solopreneurDir);
  ensureRoadmapMethodologyInstructions(solopreneurDir);
  ensureBootstrapRoadmapInstructions(solopreneurDir, getPersistedSettings(context).cliPath || 'agy');
  ensureRoadmapValidationScript(solopreneurDir);
  ensureDocumentationManifest(projectRoot);

  const csvPath = path.join(solopreneurDir, 'roadmap.csv');
  const dbPath = path.join(solopreneurDir, 'project_journal.db');

  syncEngineInitProjectRoot = projectRoot;
  syncEngineInitPromise = (async () => {
    const nextSyncEngine = new SyncEngine(csvPath, dbPath, context.extensionPath);
    syncEngine = nextSyncEngine;
    activeProjectRoot = projectRoot;
    syncEngineReady = false;
    sendNodesToWebview();
    try {
      await nextSyncEngine.initAndSync();
      if (getSelectedProjectPath(context) !== projectRoot) {
        return false;
      }
      syncEngine = nextSyncEngine;
      activeProjectRoot = projectRoot;
      syncEngineReady = true;
      ensureCompletionCriteriaForNodes(projectRoot, syncEngine.getNodes());
      setupFileSentinelWatcher(projectRoot);
      // Refresh sidebar when successfully initialized
      if (sidebarProvider) {
        sidebarProvider.sendNodesToWebview();
        sidebarProvider.sendProjects();
      }
      return true;
    } catch (error) {
      syncEngineReady = false;
      vscode.window.showErrorMessage(`Failed to initialize Roadmap database: ${error}`);
      return false;
    } finally {
      syncEngineInitPromise = null;
      syncEngineInitProjectRoot = '';
    }
  })();
  return syncEngineInitPromise;
}

async function openRoadmapPanel(context: vscode.ExtensionContext, initialView: 'roadmap' | 'solo' | 'flow' = 'roadmap') {
  const effectiveInitialView = initialView === 'flow' && !await hasFlowModeAccess(context)
    ? 'roadmap'
    : initialView;
  // If panel already exists, reveal it
  if (activePanel) {
    recordLocalUsageEvent(context, 'roadmapOpened');
    activePanel.reveal(vscode.ViewColumn.One);
    activePanel.webview.postMessage({ command: 'setMainView', view: effectiveInitialView });
    await postFlowStateToWebview(context);
    return;
  }

  const projectRoot = getSelectedProjectPath(context);
  if (!projectRoot) {
    vscode.window.showErrorMessage('Choose a project folder before launching the Roadmap.');
    return;
  }
  recordLocalUsageEvent(context, 'roadmapOpened');

  // Create Webview Panel
  activePanel = vscode.window.createWebviewPanel(
    'solopreneurRoadmap',
    'SoloMap - Local AI Agent Cockpit & Coding Roadmap Assistant',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(context.extensionPath)],
    }
  );

  // Load basic HTML into Webview
  activePanel.webview.html = getWebviewHtml(activePanel.webview, context);
  activePanel.webview.postMessage({ command: 'roadmapLoading', projectPath: projectRoot });
  activePanel.webview.postMessage({
    command: 'settingsLoaded',
    settings: getPersistedSettings(context)
  });
  activePanel.webview.postMessage({
    command: 'projectsLoaded',
    projects: getProjectState(context)
  });
  activePanel.webview.postMessage({ command: 'setMainView', view: effectiveInitialView });
  await postFlowStateToWebview(context);

  // Handle messages from Webview
  activePanel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case 'getNodes':
          if (syncEngine && activeProjectRoot === getSelectedProjectPath(context)) {
            sendNodesToWebview();
          } else {
            activePanel?.webview.postMessage({ command: 'roadmapLoading', projectPath: getSelectedProjectPath(context) });
            void ensureSyncEngine(context).then((ready) => {
              if (ready) {
                sendNodesToWebview();
              }
            });
          }
          break;

        case 'updateNode':
          if (syncEngine) {
            syncEngine.updateNode(message.nodeId, message.updates);
            sendNodesToWebview();
          }
          break;

        case 'completeNode':
          completeNodeManually(message.nodeId);
          break;

        case 'runAgent':
          await handleRunAgent(context, message.nodeId, message.userMessage || '', message.agentCli || '', message.model || '', normalizeSupplementFiles(message.supplementFiles));
          break;

        case 'runRoadmapRevision':
          await handleRoadmapRevision(context, message.userMessage || '', message.agentCli || '', message.model || '', normalizeSupplementFiles(message.supplementFiles));
          break;

        case 'runSoloConversation':
          await handleRunSoloConversation(context, message.userMessage || '', message.agentCli || '', message.model || '', normalizeSupplementFiles(message.supplementFiles));
          break;

        case 'runFlow':
          await handleRunFlow(context, message.goal || '', message.agentCli || '', message.model || '', normalizeSupplementFiles(message.supplementFiles));
          break;

        case 'pauseFlow':
          if (activeProjectRoot && message.flowId) {
            updateFlowTrace(activeProjectRoot, message.flowId, (trace) => {
              trace.status = 'paused';
              trace.latestSummary = 'Flow 已被用户手动暂停推进。';
              return trace;
            });
            await postFlowStateToWebview(context);
          }
          break;

        case 'abandonFlow':
          if (activeProjectRoot && message.flowId) {
            updateFlowTrace(activeProjectRoot, message.flowId, (trace) => {
              trace.status = 'abandoned';
              trace.latestSummary = 'Flow 已被用户手动放弃。';
              if (trace.loops.length > 0) {
                const latestLoop = trace.loops[trace.loops.length - 1];
                latestLoop.status = 'abandoned';
              }
              return trace;
            });
            await postFlowStateToWebview(context);
          }
          break;

        case 'rollbackChanges':
          await rollbackProjectToPreSessionGitHash(context, message.projectPath || activeProjectRoot || getSelectedProjectPath(context) || '', message.gitHash);
          break;

        case 'linkSoloConversation':
          linkSoloConversationToNode(Number(message.conversationId || 0), String(message.nodeId || ''));
          break;

        case 'chooseSupplementFiles':
          await chooseSupplementFilesForNode(message.nodeId);
          break;

        case 'savePastedAttachments':
          if (!activeProjectRoot || !activePanel) {
            vscode.window.showErrorMessage('Choose a project folder before attaching images.');
            return;
          }
          activePanel.webview.postMessage({
            command: 'supplementFilesSelected',
            nodeId: message.nodeId,
            files: savePastedImageAttachments(activeProjectRoot, message.nodeId || 'conversation', message.attachments || [])
          });
          break;

        case 'retryConversation':
          await handleRetryConversation(context, message.nodeId, Number(message.conversationId || 0));
          break;

        case 'showAgentTerminal':
          showAgentTerminal(Number(message.conversationId || 0));
          break;

        case 'continueNativeConversation':
          await handleContinueNativeConversation(context, message.nodeId, Number(message.conversationId || 0));
          break;

        case 'stopAgentRun':
          await stopAgentRun(message.nodeId, Number(message.conversationId || 0));
          break;

        case 'openProjectFile':
          if (activeProjectRoot && message.relativePath) {
            const candidatePath = path.resolve(activeProjectRoot, String(message.relativePath));
            const relativeToRoot = path.relative(activeProjectRoot, candidatePath);
            if (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot) && fs.existsSync(candidatePath)) {
              const doc = await vscode.workspace.openTextDocument(candidatePath);
              await vscode.window.showTextDocument(doc, { preview: false });
            }
          }
          break;

        case 'getSettings':
          if (activePanel) {
            activePanel.webview.postMessage({
              command: 'settingsLoaded',
              settings: getPersistedSettings(context)
            });
          }
          break;

        case 'getFlowState':
          await postFlowStateToWebview(context);
          break;

        case 'getAgentModels':
          if (activePanel) {
            const resolvedAgentCli = resolveAgentCli(message.agentCli || '', getPersistedSettings(context).cliPath || 'agy');
            activePanel.webview.postMessage({
              command: 'agentModelsLoaded',
              requestId: String(message.requestId || ''),
              targetId: String(message.targetId || ''),
              agentCli: resolvedAgentCli,
              catalog: loadDiscoveredAgentModels(resolvedAgentCli)
            });
          }
          break;

        case 'openProAuthorization':
          await handleManageProAuthorization(context, 'login');
          break;

        case 'pasteProAuthorizationCode':
          await handleManageProAuthorization(context, 'paste');
          break;

        case 'updateSettings':
          await updatePersistedSettings(context, {
            cliPath: message.cliPath,
            agentModelPreferences: message.agentModelPreferences,
            language: message.language,
            globalPrompt: message.globalPrompt,
            globalDataPath: message.globalDataPath,
            reviewerCliPath: message.reviewerCliPath,
            collaborationReviewMode: message.collaborationReviewMode
          });
          vscode.window.showInformationMessage('SoloMap settings saved successfully!');
          // Broadcast to sync both Webviews
          vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
          break;

        case 'installSkill':
          await handleInstallSolomapSkill(context, message.skillInput || '');
          break;

        case 'installMcp':
          await handleInstallSolomapMcp(context, message.mcpInput || '');
          break;

        case 'installEnhancement':
          await handleInstallSolomapEnhancement(context, message.enhancementId || '');
          break;

        case 'checkEnhancement':
          await handleCheckSolomapEnhancement(context, message.enhancementId || '');
          break;

        case 'setEnhancementEnabled':
          await handleSetSolomapEnhancementEnabled(context, message.enhancementId || '', Boolean(message.enabled));
          break;

        case 'uninstallEnhancement':
          await handleUninstallSolomapEnhancement(context, message.enhancementId || '');
          break;

        case 'uninstallSkill':
          await handleUninstallSolomapSkill(context, message.skillId || '');
          break;

        case 'uninstallMcp':
          await handleUninstallSolomapMcp(context, message.mcpId || '');
          break;

        case 'openFeedbackIssue':
          vscode.env.openExternal(vscode.Uri.parse(buildFeedbackIssueUrl(message.title || '', message.body || '', message.category || '', buildFeedbackUsageSummary(context))));
          break;

        case 'getNodeConversations':
          if (syncEngine && activePanel) {
            activePanel.webview.postMessage({
              command: 'nodeConversationsLoaded',
              nodeId: message.nodeId,
              conversations: syncEngine.getAgentExecutions(message.nodeId),
              projectPath: activeProjectRoot || ''
            });
          }
          break;

        case 'getProjects':
          activePanel?.webview.postMessage({
            command: 'projectsLoaded',
            projects: getProjectState(context)
          });
          break;

        case 'selectProject':
          await selectProject(context, message.projectPath);
          break;

        case 'updateProjectMetadata':
          await updateProjectMetadata(context, message.projectPath, {
            type: message.projectType,
            priority: message.priority
          });
          break;

        case 'addProject':
          await addProjectFromDialog(context);
          break;

        case 'removeProject':
          await removeProject(context, message.projectPath);
          break;

        case 'testCli':
          const cliToTest = resolveAgentCli('antigravity-cli', message.cliPath || '');
          childProcess.execFile(cliToTest, getCliVersionArgs(cliToTest), (error: any, stdout: string, stderr: string) => {
            const success = !error;
            let msg = error ? error.message : formatCliTestMessage(cliToTest, stdout, stderr);
            if (!success) {
              const candidates = getAgentCliCandidates('antigravity-cli', message.cliPath || '').join(', ');
              msg = `Command not found or failed. Tried: ${candidates}`;
            }
            if (activePanel) {
              activePanel.webview.postMessage({
                command: 'cliTestResult',
                success,
                message: msg
              });
            }
          });
          break;

        case 'getAgentImpact':
          if (activePanel) {
            activePanel.webview.postMessage({
              command: 'agentImpactLoaded',
              status: getAgentImpactStatus(getProjects(context))
            });
          }
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  void ensureSyncEngine(context).then((ready) => {
    if (ready) {
      sendNodesToWebview();
    }
  });

  // Clean up when panel is closed
  activePanel.onDidDispose(
    () => {
      activePanel = null;
      if (watcher) {
        watcher.dispose();
        watcher = null;
      }
      if (statusPoller) {
        clearInterval(statusPoller);
        statusPoller = null;
      }
    },
    null,
    context.subscriptions
  );
}

async function handleOpenStrategyPyramid(context: vscode.ExtensionContext): Promise<void> {
  if (!await hasStrategyPyramidAccess(context)) {
    const choice = await vscode.window.showInformationMessage(
      '战略金字塔是 Pro 功能。',
      '升级 Pro'
    );
    if (choice === '升级 Pro') {
      await beginPassportAuthorizationFlow(context);
    }
    return;
  }
  await openStrategyPyramidPanel(context);
}

async function openStrategyPyramidPanel(context: vscode.ExtensionContext): Promise<void> {
  if (activeStrategyPyramidPanel) {
    activeStrategyPyramidPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  activeStrategyPyramidPanel = vscode.window.createWebviewPanel(
    'solopreneurStrategyPyramid',
    'SoloMap: Strategy Pyramid',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(context.extensionPath)]
    }
  );

  const refresh = () => {
    if (!activeStrategyPyramidPanel) {
      return;
    }
    activeStrategyPyramidPanel.webview.html = getStrategyPyramidWebviewHtml(
      activeStrategyPyramidPanel.webview,
      context,
      buildStrategyPyramidSnapshot(context)
    );
  };

  refresh();

  activeStrategyPyramidPanel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case 'refreshStrategyPyramid':
          refresh();
          break;
        case 'openProjectRoadmap':
          if (message.projectPath) {
            await selectProject(context, String(message.projectPath));
            await openRoadmapPanel(context);
          }
          break;
        case 'saveProjectStrategy':
          if (message.projectPath) {
            await saveProjectStrategy(
              context,
              message.projectPath,
              message.role,
              message.businessStage,
              message.revenueTier,
              message.timeLoad,
              message.strategicAction,
              message.abilities
            );
            refresh();
          }
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  activeStrategyPyramidPanel.onDidDispose(
    () => {
      activeStrategyPyramidPanel = null;
    },
    null,
    context.subscriptions
  );
}

function readStrategyRoadmapNodes(projectPath: string): StrategyPyramidNodeSummary[] {
  const csvPath = path.join(projectPath, '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(csvPath)) {
    return [];
  }
  try {
    const csv = fs.readFileSync(csvPath, 'utf8');
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    return (parsed.data || [])
      .filter((row) => row && (row.id || row.title))
      .map((row) => ({
        id: String(row.id || row.title || ''),
        title: String(row.title || row.id || ''),
        stage: String(row.stage || ''),
        status: String(row.status || 'Pending')
      }));
  } catch (error) {
    console.warn(`Failed to read strategy pyramid roadmap for ${projectPath}:`, error);
    return [];
  }
}

function classifyStrategyLoop(node: StrategyPyramidNodeSummary): MethodologyStageKey {
  const text = `${node.stage} ${node.title}`.toLowerCase();
  if (/sell|sale|sales|market|marketing|growth|launch|revenue|pricing|收费|销售|营销|增长|发布|收入|定价/.test(text)) {
    return 'sell';
  }
  if (/learn|feedback|signal|interview|review|measure|复盘|反馈|学习|访谈|信号|数据|验证/.test(text)) {
    return 'learn';
  }
  if (/improve|iterate|polish|optimi[sz]e|fix|scale|改进|迭代|优化|修复|规模/.test(text)) {
    return 'improve';
  }
  return 'build';
}

function labelStrategyLoop(key: MethodologyStageKey): string {
  return {
    build: 'Build',
    sell: 'Sell',
    learn: 'Learn',
    improve: 'Improve'
  }[key];
}

function titleStrategyLoop(key: MethodologyStageKey): string {
  return {
    build: '产品与交付',
    sell: '收入与市场',
    learn: '学习与反馈',
    improve: '改进与复利'
  }[key];
}

function inferDominantStrategyLoop(nodes: StrategyPyramidNodeSummary[]): MethodologyStageKey {
  const counts: Record<MethodologyStageKey, number> = { build: 0, sell: 0, learn: 0, improve: 0 };
  for (const node of nodes) {
    counts[classifyStrategyLoop(node)] += 1;
  }
  const ordered: MethodologyStageKey[] = ['sell', 'learn', 'improve', 'build'];
  return ordered.sort((a, b) => counts[b] - counts[a])[0] || 'build';
}

function inferProjectAbilities(project: SolopreneurProject, nodes: StrategyPyramidNodeSummary[]): string[] {
  const text = `${project.name} ${project.type || ''} ${nodes.map((node) => `${node.stage} ${node.title}`).join(' ')}`.toLowerCase();
  const abilities: string[] = [];
  const add = (label: string, pattern: RegExp) => {
    if (pattern.test(text) && !abilities.includes(label)) {
      abilities.push(label);
    }
  };
  add('AI 产品编排', /ai|agent|llm|prompt|codex|claude|智能体|大模型|代理|编排/);
  add('CLI 与开发者工具', /cli|terminal|command|vscode|extension|插件|命令行|开发者工具/);
  add('Web 产品交付', /web|website|frontend|react|next|vue|官网|前端|页面/);
  add('订阅与商业化', /stripe|passport|billing|subscription|pricing|pro|订阅|付费|收费|定价|商业化/);
  add('内容与分发', /content|blog|seo|wechat|video|newsletter|内容|文章|宣发|渠道|分发/);
  add('基础设施与自动化', /infra|cloud|worker|deploy|ci|github actions|mcp|数据库|基础设施|自动化|部署/);
  add('反馈与研究', /feedback|learn|research|review|interview|用户|反馈|研究|访谈|复盘/);
  return abilities.slice(0, 4);
}

function inferStrategyRole(project: SolopreneurProject, nodes: StrategyPyramidNodeSummary[]): string {
  const type = String(project.type || '').trim();
  const stages = nodes.map((node) => node.stage).join(' ');
  if (type === 'core_product') return '核心产品';
  if (type === 'content') return '内容资产';
  if (type === 'infrastructure' || /基础|架构|infra|cloud|平台/i.test(`${project.name} ${stages}`)) return '能力底座';
  if (type === 'maintenance' || /维护|归档|稳定|修复/i.test(`${project.name} ${stages}`)) return '稳定维护';
  if (type === 'experiment' || /实验|试验|研究|验证/i.test(`${project.name} ${stages}`)) return '机会验证';
  return '推进项目';
}

function countProjectLoops(nodes: StrategyPyramidNodeSummary[]): Record<MethodologyStageKey, number> {
  const counts: Record<MethodologyStageKey, number> = { build: 0, sell: 0, learn: 0, improve: 0 };
  for (const node of nodes) {
    counts[classifyStrategyLoop(node)] += 1;
  }
  return counts;
}

function inferBusinessStage(project: SolopreneurProject, nodes: StrategyPyramidNodeSummary[]): string {
  const loops = countProjectLoops(nodes);
  const completed = nodes.filter((node) => node.status === 'Completed').length;
  if (/archive|frozen|归档|冻结/i.test(`${project.type || ''} ${project.name}`)) return 'sunset';
  if (loops.sell > 0 && loops.learn > 0) return completed > 0 ? 'commercial_validation' : 'validation';
  if (loops.learn > 0) return 'validation';
  if (loops.sell > 0) return 'commercial_validation';
  if (loops.build > 0) return 'build';
  return 'idea';
}

function inferRevenueTier(project: SolopreneurProject, nodes: StrategyPyramidNodeSummary[]): string {
  const loops = countProjectLoops(nodes);
  if (loops.sell === 0) return 'unknown';
  if (project.type === 'core_product') return 'unknown';
  return 'unknown';
}

function inferTimeLoadFromCounts(runningNodes: number, inProgressNodes: number, failedNodes: number, totalNodes: number): string {
  if (failedNodes > 0 || runningNodes + inProgressNodes >= 2) return 'high';
  if (runningNodes + inProgressNodes === 1 || totalNodes >= 6) return 'medium';
  if (totalNodes > 0) return 'low';
  return 'unknown';
}

function inferTimeLoad(actualMinutes: number, runningNodes: number, inProgressNodes: number, failedNodes: number, totalNodes: number): string {
  if (actualMinutes > 120 || failedNodes > 0 || runningNodes + inProgressNodes >= 2) return 'high';
  if (actualMinutes >= 30 || runningNodes + inProgressNodes === 1 || totalNodes >= 6) return 'medium';
  if (actualMinutes > 0 || totalNodes > 0) return 'low';
  return 'unknown';
}

function inferStrategicRelation(role: string, abilities: string[], nodes: StrategyPyramidNodeSummary[]): string {
  const loops = countProjectLoops(nodes);
  if (role === '核心产品') return '高：承载收入、信誉和能力复利的主线';
  if (abilities.length >= 2 && loops.improve + loops.learn > 0) return '高：能力可跨项目复用';
  if (abilities.length > 0 || loops.sell + loops.learn > 0) return '中：已有可复用或市场信号';
  return '低：仍需验证它与整体系统的关系';
}

function inferProjectRoleScores(
  project: SolopreneurProject,
  nodes: StrategyPyramidNodeSummary[],
  abilities: string[],
  role: string
): StrategyPyramidProjectRoleScores {
  const loops = countProjectLoops(nodes);
  const completed = nodes.filter((node) => node.status === 'Completed').length;
  const score = (value: number) => Math.max(1, Math.min(5, value));
  return {
    abilityAccumulation: score(1 + Math.min(3, abilities.length) + (loops.improve > 0 ? 1 : 0)),
    revenueContribution: score(1 + Math.min(3, loops.sell) + (project.type === 'core_product' ? 1 : 0)),
    marketTrust: score(1 + Math.min(2, loops.learn) + (loops.sell > 0 ? 1 : 0) + (completed > 0 ? 1 : 0)),
    reusePotential: score(1 + Math.min(3, abilities.length) + (loops.improve > 0 ? 1 : 0)),
    brandValue: score(1 + (role === '核心产品' ? 2 : 0) + (loops.sell > 0 ? 1 : 0) + (loops.learn > 0 ? 1 : 0))
  };
}

function inferProjectAdvice(summary: Pick<StrategyPyramidProjectSummary, 'role' | 'nodes' | 'abilities' | 'failedNodes' | 'progressPercent'>): StrategyPyramidProjectAdvice {
  const hasSell = summary.nodes.some((node) => classifyStrategyLoop(node) === 'sell');
  const hasLearn = summary.nodes.some((node) => classifyStrategyLoop(node) === 'learn');
  const lowReuse = summary.abilities.length === 0 && summary.progressPercent < 40;
  return {
    doubleDown: summary.role === '核心产品' || hasSell
      ? '加码商业化验证、渠道建设和能沉淀信誉的交付'
      : '只加码能补市场反馈或复用能力的切片',
    reduce: summary.failedNodes > 0
      ? '收缩失败环节外的新增建设，先让阻塞收口'
      : lowReuse
        ? '减少一次性建设和低复利维护'
        : '收缩重复支持、临时修补和不产生学习信号的投入',
    observe: hasLearn
      ? '观察反馈是否能转成定价、转化或明确取舍'
      : '观察它是否继续占用新收入源验证时间'
  };
}

function inferStrategyAction(summary: Pick<StrategyPyramidProjectSummary, 'failedNodes' | 'runningNodes' | 'inProgressNodes' | 'progressPercent' | 'nodes'>): string {
  if (summary.failedNodes > 0) return '先收口失败点';
  if (summary.runningNodes > 0 || summary.inProgressNodes > 0) return '继续当前推进';
  if (summary.progressPercent >= 80) return '复盘价值，决定加码或收缩';
  if (!summary.nodes.some((node) => classifyStrategyLoop(node) === 'sell' || classifyStrategyLoop(node) === 'learn')) {
    return '补一个销售或学习信号';
  }
  return '推进下一个可验证切片';
}

function inferStrategyRisk(summary: Pick<StrategyPyramidProjectSummary, 'failedNodes' | 'nodes' | 'progressPercent'>): string {
  if (summary.failedNodes > 0) return '交付阻塞';
  if (!summary.nodes.some((node) => classifyStrategyLoop(node) === 'sell')) return '缺少销售动作';
  if (!summary.nodes.some((node) => classifyStrategyLoop(node) === 'learn')) return '缺少学习信号';
  if (summary.progressPercent >= 80) return '需要投入决策';
  return '';
}

function inferProjectEvidence(summary: Pick<StrategyPyramidProjectSummary, 'totalNodes' | 'completedNodes' | 'runningNodes' | 'inProgressNodes' | 'failedNodes' | 'nodes'>): string[] {
  const evidence: string[] = [];
  if (summary.totalNodes === 0) {
    evidence.push('还没有可读取的路线图信号');
  } else {
    evidence.push(`${summary.completedNodes}/${summary.totalNodes} 个环节已完成`);
  }
  if (summary.runningNodes + summary.inProgressNodes > 0) {
    evidence.push('当前有推进中的环节');
  }
  if (summary.failedNodes > 0) {
    evidence.push('存在失败环节');
  }
  if (!summary.nodes.some((node) => classifyStrategyLoop(node) === 'sell')) {
    evidence.push('缺少销售动作');
  }
  if (!summary.nodes.some((node) => classifyStrategyLoop(node) === 'learn')) {
    evidence.push('缺少学习信号');
  }
  return evidence.slice(0, 3);
}

function buildLoopSummaries(projects: StrategyPyramidProjectSummary[], allNodes: StrategyPyramidNodeSummary[]): StrategyPyramidLoopSummary[] {
  const keys: MethodologyStageKey[] = ['build', 'sell', 'learn', 'improve'];
  return keys.map((key) => {
    const count = allNodes.filter((node) => classifyStrategyLoop(node) === key).length;
    const projectNames = projects
      .filter((project) => project.loop === key || project.nodes.some((node) => classifyStrategyLoop(node) === key))
      .map((project) => project.name)
      .slice(0, 5);
    const judgment = count === 0
      ? `${labelStrategyLoop(key)} 信号不足`
      : projectNames.length > 0
        ? `${projectNames.length} 个项目形成 ${labelStrategyLoop(key)} 信号`
        : `${count} 个 ${labelStrategyLoop(key)} 信号`;
    return {
      key,
      label: labelStrategyLoop(key),
      title: titleStrategyLoop(key),
      count,
      projectNames,
      judgment
    };
  });
}

function buildAbilitySummaries(projects: StrategyPyramidProjectSummary[]): StrategyPyramidAbilitySummary[] {
  const abilityProjects = new Map<string, Set<string>>();
  for (const project of projects) {
    for (const ability of project.abilities) {
      if (!abilityProjects.has(ability)) {
        abilityProjects.set(ability, new Set());
      }
      abilityProjects.get(ability)?.add(project.name);
    }
  }
  return [...abilityProjects.entries()]
    .map(([name, projectSet]) => {
      const projectCount = projectSet.size;
      const projectNames = [...projectSet].sort((a, b) => a.localeCompare(b));
      return {
        name,
        projectCount,
        projectNames,
        value: projectCount >= 3 ? '高' : projectCount >= 2 ? '中高' : '观察',
        judgment: projectCount >= 2 ? '继续加码并对外表达' : '已有信号，继续观察'
      };
    })
    .sort((a, b) => b.projectCount - a.projectCount || a.name.localeCompare(b.name))
    .slice(0, 6);
}

function buildStageProfile(stageTitle: string, projects: StrategyPyramidProjectSummary[]): StrategyPyramidStageProfile {
  if (projects.length <= 2) {
    return {
      title: stageTitle,
      priorityLayer: '底层：能力库 + 市场发现渠道',
      keyMetric: '是否能接近第一个付费用户',
      defaultQuestion: '我应该集中在哪个细分方向？'
    };
  }
  if (projects.length >= 6) {
    return {
      title: stageTitle,
      priorityLayer: '上层：可复利收入 + 系统自动化',
      keyMetric: '总投入时间是否可持续',
      defaultQuestion: '哪些部分应该自动化、委托或冻结？'
    };
  }
  return {
    title: stageTitle,
    priorityLayer: '中层：项目组合 + 收入结构',
    keyMetric: '哪些项目在积累复利，哪些在消耗注意力',
    defaultQuestion: '应该加码、收缩还是暂停？'
  };
}

function inferStrategyStage(projects: StrategyPyramidProjectSummary[], buildCount: number, sellCount: number, learnCount: number): string {
  if (projects.length === 0) return '起步定向期';
  if (projects.some((project) => project.failedNodes > 0)) return '结构收口期';
  if (projects.length <= 2) return sellCount + learnCount > 0 ? '早期验证期' : '集中建设期';
  if (buildCount > sellCount + learnCount + 1) return 'Build 偏重期';
  if (projects.length >= 6) return '组合治理期';
  return '组合成长期';
}

function inferMainJudgment(projects: StrategyPyramidProjectSummary[], buildCount: number, sellCount: number, learnCount: number): string {
  if (projects.length === 0) return '还没有形成项目组合，先把一个能接近付费用户的项目推进到可验证状态。';
  if (projects.some((project) => project.failedNodes > 0)) return '当前组合的第一优先级不是继续扩张，而是收口失败环节，避免风险拖累核心产品。';
  if (sellCount === 0 && learnCount === 0) return '项目组合正在积累建设动作，但还没有形成足够的销售和学习信号。';
  if (buildCount > sellCount + learnCount + 1) return 'Build 信号明显偏重，继续新增功能会降低商业化验证效率。';
  if (!projects.some((project) => project.type === 'core_product' || project.role === '核心产品')) return '组合已有多个推进点，但缺少一个明确承载收入、信誉和能力复利的核心产品。';
  return '组合已经具备跨项目推进信号，下一步应让收入、反馈和能力复用互相增强。';
}

function inferPortfolioStrategicAction(projects: StrategyPyramidProjectSummary[], sellCount: number, learnCount: number): string {
  if (projects.length === 0) return '选择一个最接近付费用户的问题，先推进到可演示切片。';
  if (projects.some((project) => project.failedNodes > 0)) return '先收口阻塞，再决定哪些项目值得继续加码。';
  if (sellCount === 0 || learnCount === 0) return '加码核心产品的商业化验证，补上销售与反馈信号。';
  if (!projects.some((project) => project.type === 'core_product' || project.role === '核心产品')) return '选出一个核心产品承载收入验证，其他项目围绕它复用能力。';
  return '围绕核心产品建立第二收入源假设，并减少低复利维护投入。';
}

function inferPortfolioConstraint(projects: StrategyPyramidProjectSummary[], buildCount: number, sellCount: number, learnCount: number): string {
  if (projects.length === 0) return '不要先铺多个方向，先让一个项目产生真实反馈。';
  if (buildCount > sellCount + learnCount + 1) return '未来 30 天减少新功能建设，把时间转向商业化验证和用户反馈。';
  if (projects.filter((project) => project.totalNodes === 0).length > 0) return '没有路线图信号的项目先不要加码，避免项目数量制造虚假的安全感。';
  return '新增项目必须复用已有能力或补上收入缺口，否则先暂停孵化。';
}

function buildStrategyLayers(
  projects: StrategyPyramidProjectSummary[],
  buildCount: number,
  sellCount: number,
  learnCount: number,
  improveCount: number,
  abilities: StrategyPyramidAbilitySummary[]
): StrategyPyramidLayerSummary[] {
  const hasCore = projects.some((project) => project.type === 'core_product' || project.role === '核心产品');
  const activeProjects = projects.filter((project) => project.runningNodes + project.inProgressNodes > 0).length;
  const reusableAbilities = abilities.filter((ability) => ability.projectCount >= 2).length;
  const health = (ok: boolean, watch: boolean): 'strong' | 'watch' | 'risk' => ok ? 'strong' : watch ? 'watch' : 'risk';
  return [{
    key: 'freedom-brand',
    title: '自由选择与个人品牌',
    health: health(hasCore && (sellCount > 0 || learnCount > 0), hasCore),
    signal: hasCore ? '已有核心产品承载信誉积累。' : '核心产品尚未明确，品牌信号容易分散。',
    action: hasCore ? '继续把市场反馈沉淀到核心产品。' : '先选出最能代表长期方向的核心产品。',
    evidence: hasCore ? ['存在核心产品标记或核心产品角色'] : ['未识别到核心产品角色']
  }, {
    key: 'revenue-system',
    title: '可复利收入系统',
    health: health(sellCount >= 2, sellCount === 1),
    signal: sellCount > 0 ? `${sellCount} 个收入或市场动作可继续验证。` : '还没有可读取的收入验证动作。',
    action: sellCount > 0 ? '把销售动作接到明确的升级或付费路径。' : '补一个低成本销售实验，不继续只做功能。',
    evidence: [`${sellCount} 个 Sell 阶段信号`]
  }, {
    key: 'market-trust',
    title: '市场覆盖与信誉',
    health: health(learnCount >= 2, learnCount === 1 || sellCount > 0),
    signal: learnCount > 0 ? `${learnCount} 个学习信号可用于下一轮改进。` : '用户反馈和市场学习信号不足。',
    action: learnCount > 0 ? '把反馈转成下一轮取舍，而不是继续堆需求。' : '补一次真实用户反馈或公开分发验证。',
    evidence: [`${learnCount} 个 Learn 阶段信号`]
  }, {
    key: 'ability-compounding',
    title: '能力系统与产品交付',
    health: health(reusableAbilities > 0 && improveCount > 0, abilities.length > 0 || activeProjects > 0),
    signal: reusableAbilities > 0 ? `${reusableAbilities} 项能力正在跨项目复用。` : '能力复用还没有形成稳定信号。',
    action: reusableAbilities > 0 ? '把可复用能力产品化或品牌化。' : '标记能跨项目复用的能力，减少一次性建设。',
    evidence: [`${abilities.length} 项能力标签`, `${improveCount} 个 Improve 阶段信号`]
  }, {
    key: 'reality-inventory',
    title: '现实锚点与投资库存',
    health: health(projects.length > 0 && buildCount + sellCount + learnCount + improveCount > 0, projects.length > 0),
    signal: projects.length > 0 ? `${projects.length} 个项目进入组合视野。` : '还没有项目进入组合视野。',
    action: projects.length > 0 ? '冻结低复利项目，把注意力留给核心验证。' : '先登记一个真实项目，形成第一组战略信号。',
    evidence: [`${projects.length} 个本地登记项目`, `${activeProjects} 个当前推进项目`]
  }];
}

function buildStrategyMoves(projects: StrategyPyramidProjectSummary[], sellCount: number, learnCount: number, abilities: StrategyPyramidAbilitySummary[]): StrategyPyramidMoveSummary[] {
  const moves: StrategyPyramidMoveSummary[] = [];
  if (projects.length === 0) {
    moves.push({ horizon: '未来 30 天', title: '推进一个可演示切片', reason: '先让战略判断有真实项目和用户反馈可依赖。', evidence: ['未读取到已登记项目'] });
  } else if (sellCount === 0 || learnCount === 0) {
    moves.push({ horizon: '未来 30 天', title: '补齐商业化与反馈验证', reason: '当前组合的建设动作多于市场信号，继续 Build 会放大战略盲区。', evidence: [`${sellCount} 个 Sell 信号`, `${learnCount} 个 Learn 信号`] });
  } else {
    moves.push({ horizon: '未来 30 天', title: '把核心项目推向更清晰的付费路径', reason: '已有市场与反馈信号，下一步要让收入验证闭环。', evidence: [`${sellCount} 个 Sell 信号`, `${learnCount} 个 Learn 信号`] });
  }
  if (projects.some((project) => project.failedNodes > 0)) {
    moves.push({ horizon: '本季度', title: '收口失败环节', reason: '失败环节会吞噬注意力，先处理再加码。', evidence: ['存在失败环节'] });
  } else {
    moves.push({ horizon: '本季度', title: '减少低复利维护投入', reason: '组合价值来自复利关系，不来自项目数量。', evidence: [`${projects.length} 个项目进入组合`] });
  }
  if (abilities.some((ability) => ability.projectCount >= 2)) {
    moves.push({ horizon: '本季度', title: '把复用能力变成对外可表达的卖点', reason: '跨项目复用能力已经出现，适合沉淀成产品、模板或内容资产。', evidence: abilities.filter((ability) => ability.projectCount >= 2).map((ability) => ability.name).slice(0, 3) });
  } else {
    moves.push({ horizon: '本季度', title: '识别一个可跨项目复用的能力', reason: '没有能力复利时，多项目会更容易变成维护负担。', evidence: ['尚未识别跨项目复用能力'] });
  }
  return moves.slice(0, 4);
}

function buildStructureSignals(
  projects: StrategyPyramidProjectSummary[],
  loops: StrategyPyramidLoopSummary[],
  abilities: StrategyPyramidAbilitySummary[]
): StrategyPyramidStructureSignal[] {
  const loopCount = (key: MethodologyStageKey) => loops.find((loop) => loop.key === key)?.count || 0;
  const buildCount = loopCount('build');
  const sellCount = loopCount('sell');
  const learnCount = loopCount('learn');
  const heavyTimeProjects = projects.filter((project) => project.timeLoad === 'high');
  const reusableAbilities = abilities.filter((ability) => ability.projectCount >= 2);
  const high = (health: StrategyPyramidStructureSignal['health']) => health;
  return [{
    key: 'portfolio',
    title: '项目组合',
    health: high(projects.length === 0 ? 'risk' : buildCount > sellCount + learnCount + 1 ? 'watch' : 'strong'),
    summary: projects.length === 0
      ? '还没有项目进入战略组合。'
      : buildCount > sellCount + learnCount + 1
        ? 'Build 偏重，Sell / Learn 信号不足。'
        : 'Build / Sell / Learn / Improve 已形成可判断结构。',
    evidence: loops.map((loop) => `${loop.label}: ${loop.count}`)
  }, {
    key: 'time',
    title: '时间结构',
    health: high(heavyTimeProjects.length > 0 ? 'risk' : projects.some((project) => project.timeLoad === 'medium') ? 'watch' : 'strong'),
    summary: heavyTimeProjects.length > 0
      ? '已有项目显示高时间负担，可能挤压第二收入源验证。'
      : '未读取到明显高负担项目，但仍需用推进记录持续观察。',
    evidence: heavyTimeProjects.length ? heavyTimeProjects.map((project) => `${project.name}: ${project.timeLoad}`) : ['基于推进中、失败和路线图数量推断']
  }, {
    key: 'ability',
    title: '能力复利',
    health: high(reusableAbilities.length > 0 ? 'strong' : abilities.length > 0 ? 'watch' : 'risk'),
    summary: reusableAbilities.length > 0
      ? '已有能力在跨项目复用，适合沉淀为产品卖点或内容资产。'
      : abilities.length > 0
        ? '能力信号已出现，但跨项目复用还不稳定。'
        : '尚未识别稳定能力复利信号。',
    evidence: reusableAbilities.length ? reusableAbilities.map((ability) => `${ability.name}: ${ability.projectCount} 项目`) : ['来自项目类型、阶段标题和路线图文本']
  }, {
    key: 'trust',
    title: '市场信誉',
    health: high(learnCount >= 2 ? 'strong' : learnCount + sellCount > 0 ? 'watch' : 'risk'),
    summary: learnCount > 0
      ? '已有反馈或学习信号，但渠道、评价和转化仍需要更硬证据。'
      : '市场信誉信号不足，当前判断不能假装已有品牌增长。',
    evidence: [`${learnCount} 个 Learn 信号`, `${sellCount} 个 Sell 信号`]
  }];
}

function buildRiskSignals(projects: StrategyPyramidProjectSummary[], sellCount: number, learnCount: number, buildCount: number): StrategyPyramidRiskSignal[] {
  const signals: StrategyPyramidRiskSignal[] = [];
  const failedProjects = projects.filter((project) => project.failedNodes > 0);
  if (failedProjects.length > 0) {
    signals.push({
      severity: 'high',
      title: '结构高风险',
      summary: '存在失败环节，继续扩张会放大维护负担。',
      evidence: failedProjects.map((project) => `${project.name}: ${project.failedNodes} 个失败环节`)
    });
  }
  if (projects.length > 0 && buildCount > sellCount + learnCount + 1) {
    signals.push({
      severity: 'medium',
      title: '中等结构风险',
      summary: 'Build 偏重，商业化与反馈验证不足。',
      evidence: [`Build: ${buildCount}`, `Sell: ${sellCount}`, `Learn: ${learnCount}`]
    });
  }
  if (projects.length > 1 && !projects.some((project) => project.type === 'core_product' || project.role === '核心产品')) {
    signals.push({
      severity: 'medium',
      title: '中等结构风险',
      summary: '组合缺少明确核心产品，收入、信誉和能力复利容易分散。',
      evidence: [`${projects.length} 个项目`, '未识别核心产品角色']
    });
  }
  if (signals.length === 0) {
    signals.push({
      severity: 'healthy',
      title: '健康结构信号',
      summary: '没有读取到高风险阻塞，可以继续围绕核心验证推进。',
      evidence: [`${projects.length} 个项目`, `${sellCount} 个 Sell 信号`, `${learnCount} 个 Learn 信号`]
    });
  }
  return signals.slice(0, 4);
}

function buildOpportunitySignals(projects: StrategyPyramidProjectSummary[], abilities: StrategyPyramidAbilitySummary[]): StrategyPyramidRiskSignal[] {
  const reusable = abilities.filter((ability) => ability.projectCount >= 2);
  const coreProjects = projects.filter((project) => project.role === '核心产品');
  const signals: StrategyPyramidRiskSignal[] = [];
  if (reusable.length > 0) {
    signals.push({
      severity: 'healthy',
      title: '结构机会',
      summary: '跨项目能力已经出现，可以转成模板、内容资产、服务产品化或核心卖点。',
      evidence: reusable.map((ability) => `${ability.name}: ${ability.projectNames.join(' / ')}`).slice(0, 3)
    });
  }
  if (coreProjects.length > 0) {
    signals.push({
      severity: 'healthy',
      title: '结构机会',
      summary: '核心产品可作为收入、信誉和能力复利的统一承载点。',
      evidence: coreProjects.map((project) => project.name).slice(0, 3)
    });
  }
  if (signals.length === 0) {
    signals.push({
      severity: 'medium',
      title: '结构机会',
      summary: '先让一个项目形成明确市场反馈，再判断是否值得加码。',
      evidence: ['当前本地事实不足以识别稳定机会']
    });
  }
  return signals.slice(0, 3);
}

function buildStrategyScenarios(projects: StrategyPyramidProjectSummary[], abilities: StrategyPyramidAbilitySummary[]): StrategyPyramidScenario[] {
  const core = projects.find((project) => project.role === '核心产品') || projects[0];
  const reusable = abilities.find((ability) => ability.projectCount >= 2);
  return [{
    key: 'A',
    title: `场景 A：深化${core ? ` ${core.name}` : '核心产品'}`,
    investment: '把主要注意力集中到一个核心产品',
    returnProfile: '回报依赖单一产品商业化验证，增长速度可能更快但波动更高',
    cost: '其他孵化项目和第二收入源验证会被压缩',
    risk: '单一产品依赖风险',
    timeline: '6-12 个月',
    summary: core ? `适合 ${core.name} 已经形成 Sell / Learn 信号时选择。` : '适合先选出一个能代表长期方向的项目。'
  }, {
    key: 'B',
    title: '场景 B：建立产品组合',
    investment: '保持核心产品推进，同时保留一个低成本第二收入源假设',
    returnProfile: '回报增长更平衡，依赖能力复用和市场反馈互相增强',
    cost: '每个项目的投入强度会下降，需要严格冻结低复利维护',
    risk: '注意力分散风险',
    timeline: '12-18 个月',
    summary: reusable ? `适合围绕 ${reusable.name} 做跨项目复利。` : '适合已有多个项目但还需要识别复用能力。'
  }, {
    key: 'C',
    title: '场景 C：咨询/服务产品化',
    investment: '用一部分时间换取更快收入反馈，并把服务过程产品化',
    returnProfile: '收入反馈可能更快，但不应吞掉产品时间',
    cost: '咨询会挤占产品复利和自动化沉淀',
    risk: '活跃收入反向锁死风险',
    timeline: '3-6 个月',
    summary: '适合在产品收入证据不足时，用高质量需求验证补足市场信号。'
  }];
}

function inferRecommendedScenarioPath(projects: StrategyPyramidProjectSummary[], sellCount: number, learnCount: number): string {
  if (projects.length <= 1 || sellCount + learnCount === 0) return '推荐路径：先用场景 C 获取市场反馈，再决定是否切到场景 A。';
  if (projects.some((project) => project.role === '核心产品') && sellCount > 0 && learnCount > 0) return '推荐路径：场景 B 运行 6 个月，若核心产品转化信号增强再切到场景 A。';
  return '推荐路径：场景 B 为主，先冻结低复利项目，保留一个商业化验证窗口。';
}

function toStrategyId(value: string): string {
  return String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

interface SavedProjectStrategy {
  projectPath: string;
  role: string;
  businessStage: string;
  revenueTier: string;
  timeLoad: string;
  strategicAction: string;
  abilities: string;
  updatedAt: string;
}

function csvRoleToDisplay(role: string): string {
  switch (role) {
    case 'core_product': return '核心产品';
    case 'incubation': return '推进项目';
    case 'maintenance': return '稳定维护';
    case 'experiment': return '机会验证';
    case 'frozen': return '冻结项目';
    case 'infrastructure': return '能力底座';
    case 'content': return '内容资产';
    default: return '推进项目';
  }
}

function displayRoleToCsv(role: string): string {
  switch (role) {
    case '核心产品': return 'core_product';
    case '推进项目': return 'incubation';
    case '稳定维护': return 'maintenance';
    case '机会验证': return 'experiment';
    case '冻结项目': return 'frozen';
    case '能力底座': return 'infrastructure';
    case '内容资产': return 'content';
    default: return 'incubation';
  }
}

function csvActionToDisplay(action: string): string {
  switch (action) {
    case 'double_down': return '加码商业化验证与渠道建设';
    case 'reduce': return '收缩重复支持和低复利维护';
    case 'maintain': return '观察反馈是否能转成定价或明确取舍';
    case 'freeze': return '冻结项目，减少维护';
    case 'explore': return '推进下一个可验证切片';
    case 'sunset': return '收缩或降级';
    default: return '推进下一个可验证切片';
  }
}

function displayActionToCsv(action: string): string {
  if (/加码|继续|推进|核心|付费|商业化/.test(action)) return 'double_down';
  if (/收缩|减少|冻结|失败|阻塞/.test(action)) return 'reduce';
  if (/观察|复盘/.test(action)) return 'maintain';
  if (/验证|孵化|选择/.test(action)) return 'explore';
  return 'maintain';
}

function readProjectStrategyCsv(context: vscode.ExtensionContext): Map<string, SavedProjectStrategy> {
  const map = new Map<string, SavedProjectStrategy>();
  try {
    const globalRoot = normalizeGlobalDataPathForExtension(getPersistedSettings(context).globalDataPath);
    const csvPath = path.join(globalRoot, 'strategy', 'project-strategy.csv');
    if (fs.existsSync(csvPath)) {
      const csv = fs.readFileSync(csvPath, 'utf8');
      const parsed = Papa.parse<SavedProjectStrategy>(csv, { header: true, skipEmptyLines: true });
      if (parsed.data) {
        for (const row of parsed.data) {
          if (row.projectPath) {
            map.set(row.projectPath, row);
          }
        }
      }
    }
  } catch (error) {
    console.warn('Failed to read project-strategy.csv:', error);
  }
  return map;
}

async function saveProjectStrategy(
  context: vscode.ExtensionContext,
  projectPath: string,
  role: string,
  businessStage: string,
  revenueTier: string,
  timeLoad: string,
  strategicAction: string,
  abilities: string[]
): Promise<void> {
  try {
    const globalRoot = normalizeGlobalDataPathForExtension(getPersistedSettings(context).globalDataPath);
    const strategyRoot = path.join(globalRoot, 'strategy');
    fs.mkdirSync(strategyRoot, { recursive: true });

    const csvPath = path.join(strategyRoot, 'project-strategy.csv');
    let rows: SavedProjectStrategy[] = [];
    if (fs.existsSync(csvPath)) {
      const csv = fs.readFileSync(csvPath, 'utf8');
      const parsed = Papa.parse<SavedProjectStrategy>(csv, { header: true, skipEmptyLines: true });
      rows = parsed.data || [];
    }

    const existingIndex = rows.findIndex((r) => r.projectPath === projectPath);
    const newRow: SavedProjectStrategy = {
      projectPath,
      role: displayRoleToCsv(role),
      businessStage,
      revenueTier,
      timeLoad,
      strategicAction: displayActionToCsv(strategicAction),
      abilities: (abilities || []).map(toStrategyId).join(';'),
      updatedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      rows[existingIndex] = newRow;
    } else {
      rows.push(newRow);
    }

    fs.writeFileSync(csvPath, Papa.unparse(rows), 'utf8');
  } catch (error) {
    console.error('Failed to save project strategy:', error);
  }
}

function mapAbilityCategory(ability: string): string {
  if (/内容|分发|反馈|研究/.test(ability)) return 'marketing';
  if (/订阅|商业化/.test(ability)) return 'business';
  if (/基础设施|自动化|CLI|开发者|Web|AI/.test(ability)) return 'technical';
  return 'operations';
}

function writeStrategyPyramidSnapshot(context: vscode.ExtensionContext, snapshot: StrategyPyramidSnapshot): void {
  try {
    const globalRoot = normalizeGlobalDataPathForExtension(getPersistedSettings(context).globalDataPath);
    const strategyRoot = path.join(globalRoot, 'strategy');
    fs.mkdirSync(strategyRoot, { recursive: true });
    fs.writeFileSync(path.join(strategyRoot, 'pyramid-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    const projectRows = snapshot.projects.map((project) => ({
      projectPath: project.path,
      role: displayRoleToCsv(project.role),
      businessStage: project.businessStage,
      revenueTier: project.revenueTier,
      timeLoad: project.timeLoad,
      strategicAction: displayActionToCsv(project.action),
      abilities: project.abilities.map(toStrategyId).join(';'),
      updatedAt: snapshot.generatedAt
    }));
    fs.writeFileSync(path.join(strategyRoot, 'project-strategy.csv'), Papa.unparse(projectRows), 'utf8');
    const abilityRows = snapshot.abilities.map((ability) => ({
      abilityId: toStrategyId(ability.name),
      name: ability.name,
      category: mapAbilityCategory(ability.name),
      marketRelevance: ability.projectCount >= 2 ? 'high' : 'medium',
      notes: ability.judgment,
      updatedAt: snapshot.generatedAt
    }));
    fs.writeFileSync(path.join(strategyRoot, 'ability-registry.csv'), Papa.unparse(abilityRows), 'utf8');
  } catch (error) {
    console.warn('Failed to write strategy pyramid snapshot:', error);
  }
}

function buildStrategyPyramidSnapshot(context: vscode.ExtensionContext): StrategyPyramidSnapshot {
  const savedStrategies = readProjectStrategyCsv(context);

  const projects = getProjects(context)
    .filter((project) => project && project.path)
    .map((project) => {
      const nodes = readStrategyRoadmapNodes(project.path);
      const totalNodes = nodes.length;
      const completedNodes = nodes.filter((node) => node.status === 'Completed').length;
      const failedNodes = nodes.filter((node) => node.status === 'Failed').length;
      const runningNodes = nodes.filter((node) => node.status === 'Running').length;
      const inProgressNodes = nodes.filter((node) => node.status === 'In Progress').length;
      const pendingNodes = nodes.filter((node) => node.status === 'Pending').length;
      const progressPercent = totalNodes ? Math.round((completedNodes / totalNodes) * 100) : 0;

      const saved = savedStrategies.get(project.path);

      // 完善单独项目的时间花费统计逻辑
      const impactSummary = buildAgentImpactSummary([{ name: project.name, path: project.path }]);
      const actualMinutes = impactSummary.totalMinutes || 0;

      const role = saved ? csvRoleToDisplay(saved.role) : inferStrategyRole(project, nodes);
      const businessStage = saved ? saved.businessStage : inferBusinessStage(project, nodes);
      const revenueTier = saved ? saved.revenueTier : inferRevenueTier(project, nodes);
      const timeLoad = saved ? saved.timeLoad : inferTimeLoad(actualMinutes, runningNodes, inProgressNodes, failedNodes, totalNodes);

      const abilities = (saved && saved.abilities)
        ? saved.abilities.split(';').map(x => x.trim()).filter(Boolean)
        : inferProjectAbilities(project, nodes);

      const base = {
        name: project.name,
        path: project.path,
        type: project.type || '',
        role,
        businessStage,
        revenueTier,
        timeLoad,
        actualMinutes,
        strategicRelation: inferStrategicRelation(role, abilities, nodes),
        loop: inferDominantStrategyLoop(nodes),
        abilities,
        roleScores: inferProjectRoleScores(project, nodes, abilities, role),
        completedNodes,
        failedNodes,
        runningNodes,
        inProgressNodes,
        pendingNodes,
        totalNodes,
        progressPercent,
        nodes
      };
      const evidence = inferProjectEvidence(base);
      if (actualMinutes > 0) {
        evidence.push(`实际累计耗时：${actualMinutes} 分钟`);
      } else {
        evidence.push(`实际累计耗时：0 分钟 (暂无本地 Agent 运行记录)`);
      }
      const tempBase = { ...base, evidence };

      const action = saved ? csvActionToDisplay(saved.strategicAction) : inferStrategyAction(tempBase);
      const risk = inferStrategyRisk(tempBase);

      return {
        ...tempBase,
        action,
        risk,
        advice: inferProjectAdvice({
          role: tempBase.role,
          nodes: tempBase.nodes,
          abilities: tempBase.abilities,
          failedNodes: tempBase.failedNodes,
          progressPercent: tempBase.progressPercent
        })
      };
    })
    .sort((a, b) => (
      b.failedNodes - a.failedNodes ||
      b.runningNodes - a.runningNodes ||
      b.inProgressNodes - a.inProgressNodes ||
      b.pendingNodes - a.pendingNodes ||
      a.name.localeCompare(b.name)
    ));

  const allNodes = projects.flatMap((project) => project.nodes);
  const countLoop = (key: MethodologyStageKey) => allNodes.filter((node) => classifyStrategyLoop(node) === key).length;
  const buildCount = countLoop('build');
  const sellCount = countLoop('sell');
  const learnCount = countLoop('learn');
  const improveCount = countLoop('improve');
  const risks: string[] = [];
  if (projects.length > 0 && sellCount === 0) risks.push('组合缺少 Sell 信号，容易只 Build 不卖。');
  if (projects.length > 0 && learnCount === 0) risks.push('组合缺少 Learn 信号，下一轮改进依据不足。');
  if (projects.some((project) => project.failedNodes > 0)) risks.push('存在失败环节，应先收口再继续加码。');
  if (projects.length > 1 && !projects.some((project) => project.type === 'core_product' || project.role === '核心产品')) risks.push('组合缺少明确核心产品。');
  if (projects.filter((project) => project.totalNodes === 0).length > 0) risks.push('部分项目缺少路线图信号，容易形成低复利库存。');
  const loops = buildLoopSummaries(projects, allNodes);
  const abilities = buildAbilitySummaries(projects);
  const stageTitle = inferStrategyStage(projects, buildCount, sellCount, learnCount);
  const riskSignals = buildRiskSignals(projects, sellCount, learnCount, buildCount);
  const snapshot: StrategyPyramidSnapshot = {
    generatedAt: new Date().toISOString(),
    confidence: allNodes.length >= 4 ? 'medium' : 'low',
    stageTitle,
    stageProfile: buildStageProfile(stageTitle, projects),
    mainJudgment: inferMainJudgment(projects, buildCount, sellCount, learnCount),
    strategicAction: inferPortfolioStrategicAction(projects, sellCount, learnCount),
    constraint: inferPortfolioConstraint(projects, buildCount, sellCount, learnCount),
    totalProjects: projects.length,
    buildCount,
    sellCount,
    learnCount,
    improveCount,
    risks,
    loops,
    layers: buildStrategyLayers(projects, buildCount, sellCount, learnCount, improveCount, abilities),
    moves: buildStrategyMoves(projects, sellCount, learnCount, abilities),
    abilities,
    structureSignals: buildStructureSignals(projects, loops, abilities),
    riskSignals,
    opportunitySignals: buildOpportunitySignals(projects, abilities),
    scenarios: buildStrategyScenarios(projects, abilities),
    recommendedScenarioPath: inferRecommendedScenarioPath(projects, sellCount, learnCount),
    projects
  };

  writeStrategyPyramidSnapshot(context, snapshot);
  return snapshot;
}

function strategyEscapeHtml(value: string | number): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getStrategyPyramidWebviewHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  snapshot: StrategyPyramidSnapshot
): string {
  const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
  const wordmarkUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'logo_with_text.svg'));
  const stageTitle = snapshot.stageTitle || '组合判断期';
  const mainJudgment = snapshot.mainJudgment || '从项目组合判断现在该加码、收缩、暂停、转向，还是孵化新方向。';
  const strategicAction = snapshot.strategicAction || '选择一个项目补上最缺的市场或反馈信号。';
  const constraint = snapshot.constraint || '不要让项目数量替代真实验证。';
  const topProjects = snapshot.projects || [];

  const loops = snapshot.loops || [];
  const layers = snapshot.layers || [];
  const moves = snapshot.moves || [];
  const abilities = snapshot.abilities || [];
  const structureSignals = snapshot.structureSignals || [];
  const riskSignals = snapshot.riskSignals || [];
  const opportunitySignals = snapshot.opportunitySignals || [];
  const scenarios = snapshot.scenarios || [];
  const recommendedScenarioPath = snapshot.recommendedScenarioPath || '';

  const stageProfile = snapshot.stageProfile || {
    title: stageTitle,
    priorityLayer: '中层：项目组合 + 收入结构',
    keyMetric: '哪些项目在积累复利，哪些在消耗注意力',
    defaultQuestion: '应该加码、收缩还是暂停？'
  };

  const projectRoleData = topProjects.map((project) => ({
    name: project.name,
    path: project.path,
    role: project.role,
    businessStage: project.businessStage,
    revenueTier: project.revenueTier,
    timeLoad: project.timeLoad,
    actualMinutes: (project as any).actualMinutes || 0,
    strategicRelation: project.strategicRelation,
    action: project.action,
    risk: project.risk || '暂无明显结构风险',
    progressPercent: project.progressPercent,
    roleScores: project.roleScores,
    advice: project.advice,
    evidence: project.evidence && project.evidence.length ? project.evidence : ['等待更多推进信号'],
    abilities: project.abilities && project.abilities.length ? project.abilities : []
  }));
  const projectRoleJson = JSON.stringify(projectRoleData).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

  // 构建五层结构的详细数据，用于在金字塔点击时动态展示
  const layersJson = JSON.stringify(layers).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconsUri}" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <title>一人公司战略驾驶舱</title>
  <style>
    :root {
      --bg: #090a10;
      --fg: #f8fafc;
      --muted: #94a3b8;
      --border: rgba(255, 255, 255, 0.08);
      --glass-bg: rgba(255, 255, 255, 0.02);
      --glass-panel: rgba(15, 23, 42, 0.65);
      --accent: #00f0ff;
      --accent-purple: #7c4dff;
      --success: #00e676;
      --warn: #ffd600;
      --danger: #ff1744;
      --font: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    * { box-sizing: border-box; }

    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(148, 163, 184, 0.28) transparent;
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
      background: rgba(148, 163, 184, 0.26);
      background-clip: content-box;
    }

    *::-webkit-scrollbar-thumb:hover {
      background: rgba(148, 163, 184, 0.42);
      background-clip: content-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font);
      overflow-x: hidden;
      line-height: 1.5;
    }

    /* 星空微光发光霓虹 */
    .neon-glow-container {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: -10;
      overflow: hidden;
      pointer-events: none;
    }
    .neon-glow-container::before, .neon-glow-container::after {
      content: '';
      position: absolute;
      width: 500px;
      height: 500px;
      border-radius: 50%;
      filter: blur(150px);
      opacity: 0.12;
      animation: floatNeon 25s infinite alternate ease-in-out;
    }
    .neon-glow-container::before {
      background: radial-gradient(circle, var(--accent), var(--accent-purple));
      top: -10%; left: 10%;
    }
    .neon-glow-container::after {
      background: radial-gradient(circle, #ff007c, var(--accent-purple));
      bottom: -10%; right: 15%;
      animation-delay: -12s;
    }
    @keyframes floatNeon {
      0% { transform: translate(0, 0) scale(1); }
      100% { transform: translate(120px, 60px) scale(1.15); }
    }

    .shell {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 24px;
      position: relative;
      z-index: 1;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 28px;
    }

    h1 {
      margin: 0;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, var(--accent), var(--accent-purple));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .brand-wordmark {
      width: 132px;
      height: auto;
      flex-shrink: 0;
    }

    .sub-heading {
      color: var(--muted);
      font-size: 13px;
      margin-top: 4px;
    }

    .header-actions {
      display: flex;
      gap: 10px;
    }

    button.btn-header {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--fg);
      padding: 8px 16px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font);
      font-size: 13px;
      font-weight: 500;
      transition: all 0.3s;
    }
    button.btn-header:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.2);
    }

    /* Tabs 导航 */
    .tabs-nav {
      display: flex;
      gap: 6px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .tab-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted);
      padding: 10px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      font-family: var(--font);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tab-btn:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.02);
    }
    .tab-btn.active {
      color: var(--accent);
      border-color: rgba(0, 240, 255, 0.15);
      background: rgba(0, 240, 255, 0.04);
      box-shadow: inset 0 0 10px rgba(0, 240, 255, 0.08);
      text-shadow: 0 0 8px rgba(0, 240, 255, 0.3);
    }

    /* Tab 内容切换 */
    .tab-content {
      display: none;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .tab-content.active {
      display: block;
      opacity: 1;
      transform: translateY(0);
    }

    /* Glassmorphism 面板 */
    .glass-card {
      background: var(--glass-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      backdrop-filter: blur(12px);
      margin-bottom: 18px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
    }

    /* TAB 1: 驾驶舱 */
    .dashboard-top {
      display: grid;
      grid-template-columns: 1.8fr 1.2fr;
      gap: 16px;
      margin-bottom: 18px;
    }

    .cockpit-main {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .state-badge {
      display: inline-flex;
      align-items: center;
      border: 1px solid rgba(0, 240, 255, 0.2);
      background: rgba(0, 240, 255, 0.05);
      border-radius: 99px;
      padding: 4px 12px;
      color: #bffffc;
      font-size: 11px;
      font-weight: 700;
      margin-bottom: 12px;
      align-self: flex-start;
    }

    .cockpit-title {
      font-size: 22px;
      font-weight: 700;
      margin: 0;
      line-height: 1.4;
    }

    .cockpit-meta {
      font-size: 12px;
      color: var(--muted);
      margin-top: 8px;
    }

    .cockpit-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 18px;
    }
    .cockpit-item {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.01);
      padding: 12px 14px;
    }
    .cockpit-item span {
      display: block;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .cockpit-item strong {
      font-size: 14px;
      font-weight: 600;
      color: var(--fg);
    }

    .dashboard-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    .section-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--fg);
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .signal-item {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 4px 12px;
      padding: 12px 0;
      border-top: 1px solid var(--border);
    }
    .signal-item:first-of-type { border-top: 0; padding-top: 0; }
    .signal-item strong { font-size: 13px; font-weight: 600; }
    .signal-item span {
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 99px;
      border: 1px solid transparent;
    }
    .signal-item.strong span { color: var(--success); border-color: rgba(0, 230, 118, 0.15); background: rgba(0, 230, 118, 0.03); }
    .signal-item.watch span { color: var(--warn); border-color: rgba(255, 214, 0, 0.15); background: rgba(255, 214, 0, 0.03); }
    .signal-item.risk span { color: var(--danger); border-color: rgba(255, 23, 68, 0.15); background: rgba(255, 23, 68, 0.03); }
    .signal-item p {
      margin: 0;
      grid-column: 1 / -1;
      font-size: 12px;
      color: var(--muted);
    }

    .risk-alert {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 10px;
      border: 1px solid rgba(255,255,255,0.04);
      background: rgba(255,255,255,0.01);
    }
    .risk-alert.high { border-color: rgba(255, 23, 68, 0.15); background: rgba(255, 23, 68, 0.02); }
    .risk-alert.medium { border-color: rgba(255, 214, 0, 0.15); background: rgba(255, 214, 0, 0.02); }
    .risk-alert.healthy { border-color: rgba(0, 230, 118, 0.15); background: rgba(0, 230, 118, 0.02); }
    .risk-alert span.codicon { font-size: 16px; margin-top: 2px; }
    .risk-alert.high span.codicon { color: var(--danger); }
    .risk-alert.medium span.codicon { color: var(--warn); }
    .risk-alert.healthy span.codicon { color: var(--success); }
    .risk-alert div { font-size: 12px; }
    .risk-alert strong { display: block; font-size: 13px; font-weight: 600; margin-bottom: 2px; }
    .risk-alert p { margin: 0; color: var(--muted); }

    /* TAB 2: 战略金字塔 */
    .pyramid-wrapper {
      display: grid;
      grid-template-columns: 1.3fr 1.7fr;
      gap: 24px;
      align-items: start;
    }

    .pyramid-visual {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 30px 16px;
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--border);
      border-radius: 16px;
      position: relative;
    }

    .pyramid-layer {
      position: relative;
      width: var(--width);
      height: 54px;
      background: var(--grad);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      font-weight: 700;
      font-size: 12px;
      color: #fff;
      box-shadow: 0 4px 14px rgba(0,0,0,0.3);
      padding: 0 16px;
      text-align: center;
      backdrop-filter: blur(8px);
    }
    .pyramid-layer:hover {
      transform: scale(1.03) translateY(-2px);
      border-color: rgba(255, 255, 255, 0.25);
      box-shadow: 0 8px 24px rgba(0, 240, 255, 0.15);
    }
    .pyramid-layer.selected {
      border-color: var(--accent);
      box-shadow: 0 0 20px var(--glow);
      transform: scale(1.04);
    }

    .pyramid-layer .focus-badge {
      position: absolute;
      right: -84px;
      top: 50%;
      transform: translateY(-50%);
      background: linear-gradient(135deg, #ffd600, #ff6d00);
      color: #000;
      font-size: 9px;
      font-weight: 800;
      padding: 2px 8px;
      border-radius: 99px;
      box-shadow: 0 0 10px rgba(255, 214, 0, 0.4);
      animation: pulseBadge 1.5s infinite alternate;
      pointer-events: none;
      white-space: nowrap;
    }
    @keyframes pulseBadge {
      0% { transform: translateY(-50%) scale(0.96); opacity: 0.8; }
      100% { transform: translateY(-50%) scale(1.04); opacity: 1; }
    }

    .layer-detail-card {
      min-height: 310px;
    }

    .layer-detail-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
    }

    .layer-detail-title {
      font-size: 18px;
      font-weight: 700;
      margin: 0;
    }

    .layer-detail-health {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 99px;
    }
    .layer-detail-health.strong { color: var(--success); background: rgba(0, 230, 118, 0.05); border: 1px solid rgba(0, 230, 118, 0.15); }
    .layer-detail-health.watch { color: var(--warn); background: rgba(255, 214, 0, 0.05); border: 1px solid rgba(255, 214, 0, 0.15); }
    .layer-detail-health.risk { color: var(--danger); background: rgba(255, 23, 68, 0.05); border: 1px solid rgba(255, 23, 68, 0.15); }

    .layer-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 16px;
    }
    .layer-grid-item {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.01);
    }
    .layer-grid-item span {
      display: block;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .layer-grid-item strong {
      font-size: 13px;
      font-weight: 600;
      color: var(--fg);
    }

    .layer-evidence-box {
      font-size: 12px;
      color: var(--muted);
      border-top: 1px solid var(--border);
      padding-top: 12px;
      margin-top: 12px;
    }

    .layer-support-title {
      font-weight: 700;
      font-size: 12px;
      color: var(--fg);
      margin-bottom: 6px;
    }
    .layer-support-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .layer-chip {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      color: var(--muted);
    }

    /* TAB 3: 项目组合 */
    .quadrants-container {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
    }

    .quadrant {
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      min-height: 400px;
      display: flex;
      flex-direction: column;
    }

    .quadrant-title-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .quadrant-name {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .quadrant.build .quadrant-name { color: var(--accent); }
    .quadrant.sell .quadrant-name { color: var(--success); }
    .quadrant.learn .quadrant-name { color: var(--warn); }
    .quadrant.improve .quadrant-name { color: var(--accent-purple); }

    .quadrant-count {
      font-size: 11px;
      background: rgba(255,255,255,0.04);
      padding: 1px 6px;
      border-radius: 99px;
      color: var(--muted);
    }

    .quadrant-cards {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .quadrant-empty {
      color: var(--muted);
      font-size: 11px;
      text-align: center;
      margin-top: 40px;
      font-style: italic;
    }

    .p-card {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      cursor: pointer;
      transition: all 0.3s;
      position: relative;
    }
    .p-card:hover {
      transform: translateY(-2px);
      background: rgba(255, 255, 255, 0.05);
      border-color: var(--accent);
      box-shadow: 0 4px 12px rgba(0, 240, 255, 0.12);
    }
    .p-card.selected-active {
      border-color: var(--accent);
      background: rgba(0, 240, 255, 0.03);
      box-shadow: 0 0 10px rgba(0, 240, 255, 0.15);
    }
    .p-card-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 4px;
      word-break: break-all;
    }
    .p-card-role {
      font-size: 10px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.03);
      padding: 2px 6px;
      border-radius: 4px;
      display: inline-block;
      margin-bottom: 6px;
    }
    .p-card-progress {
      height: 4px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 99px;
      overflow: hidden;
    }
    .p-card-progress-bar {
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--accent-purple));
    }

    /* 编辑抽屉 Drawer */
    .drawer {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: 380px;
      background: rgba(12, 15, 28, 0.94);
      border-left: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(24px);
      box-shadow: -10px 0 40px rgba(0, 0, 0, 0.6);
      z-index: 1000;
      padding: 24px;
      transform: translateX(100%);
      transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      flex-direction: column;
      gap: 16px;
      overflow-y: auto;
    }
    .drawer.open {
      transform: translateX(0);
    }
    .drawer-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
      margin-bottom: 4px;
    }
    .drawer-title {
      font-size: 16px;
      font-weight: 700;
      margin: 0;
    }
    .drawer-close {
      background: transparent;
      border: 0;
      color: var(--muted);
      cursor: pointer;
      font-size: 18px;
    }
    .drawer-close:hover { color: #fff; }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .form-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .form-select, .form-input, .form-textarea {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      color: #fff;
      padding: 8px 12px;
      font-size: 13px;
      font-family: var(--font);
      outline: none;
      transition: border-color 0.3s;
    }
    .form-select:focus, .form-input:focus, .form-textarea:focus {
      border-color: var(--accent);
    }
    .form-help {
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
    }
    .drawer-actions {
      display: grid;
      grid-template-columns: 1.8fr 1.2fr;
      gap: 10px;
      margin-top: 10px;
      border-top: 1px solid var(--border);
      padding-top: 18px;
    }
    .btn-save {
      background: linear-gradient(135deg, var(--accent), var(--accent-purple));
      color: #000;
      font-weight: 700;
      border: 0;
      border-radius: 6px;
      padding: 10px;
      cursor: pointer;
      font-family: var(--font);
      font-size: 13px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      box-shadow: 0 4px 14px rgba(0, 240, 255, 0.25);
    }
    .btn-save:hover { opacity: 0.9; }
    .btn-roadmap {
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 10px;
      border-radius: 6px;
      cursor: pointer;
      font-family: var(--font);
      font-size: 13px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.3s;
    }
    .btn-roadmap:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .project-detail-sec {
      background: rgba(255,255,255,0.01);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .project-detail-sec strong {
      color: var(--fg);
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .project-detail-sec ul {
      margin: 0; padding-left: 16px;
    }
    .project-detail-sec li {
      margin-bottom: 4px;
    }

    /* TAB 4: 能力复利 */
    .ability-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
    }
    .ability-card {
      background: var(--glass-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
    }
    .ability-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 10px;
    }
    .ability-name {
      font-weight: 700;
      font-size: 14px;
      margin: 0;
    }
    .ability-badge {
      font-size: 10px;
      font-weight: 700;
      background: rgba(0, 240, 255, 0.05);
      border: 1px solid rgba(0, 240, 255, 0.15);
      color: var(--accent);
      padding: 1px 6px;
      border-radius: 4px;
    }
    .ability-meta {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .ability-card-projects {
      border-top: 1px solid var(--border);
      padding-top: 10px;
      margin-top: 10px;
    }

    /* TAB 5: 场景建模 */
    .scenario-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }
    .scenario-card {
      background: var(--glass-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .scenario-badge {
      align-self: flex-start;
      width: 24px;
      height: 24px;
      background: rgba(0, 240, 255, 0.05);
      border: 1px solid rgba(0, 240, 255, 0.2);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
    }
    .scenario-title {
      font-size: 15px;
      font-weight: 700;
      margin: 0;
    }
    .scenario-card dl {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 12px;
    }
    .scenario-card dl div {
      border-top: 1px solid var(--border);
      padding-top: 8px;
      display: grid;
      grid-template-columns: 60px 1fr;
      gap: 8px;
    }
    .scenario-card dl div:first-of-type { border-top: 0; padding-top: 0; }
    .scenario-card dt { color: var(--muted); font-weight: 600; }
    .scenario-card dd { margin: 0; color: var(--fg); }
    .scenario-card p {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
      border-top: 1px solid var(--border);
      padding-top: 10px;
      line-height: 1.4;
    }
    .recommended-sec {
      background: rgba(0, 240, 255, 0.04);
      border: 1px solid rgba(0, 240, 255, 0.15);
      border-radius: 8px;
      padding: 14px 18px;
      color: #c5ffff;
      font-size: 13px;
      font-weight: 600;
      margin-top: 18px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    /* 辅助说明 */
    .empty-state {
      color: var(--muted);
      font-size: 12px;
      text-align: center;
      padding: 40px 20px;
      font-style: italic;
    }

    @media (max-width: 900px) {
      .dashboard-top, .dashboard-grid, .pyramid-wrapper, .ability-grid, .scenario-grid {
        grid-template-columns: 1fr;
      }
      .quadrants-container {
        grid-template-columns: 1fr 1fr;
      }
    }
    @media (max-width: 600px) {
      .quadrants-container {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="neon-glow-container"></div>
  <main class="shell">
    <header>
      <div style="display: flex; align-items: center; gap: 16px;">
        <h1 class="brand-title"><img class="brand-wordmark" src="${wordmarkUri}" width="132" height="34" alt="SoloMap"></h1>
        <div style="width: 1px; height: 20px; background: var(--border);"></div>
        <div>
          <h2 style="margin: 0; font-size: 16px; font-weight: 800; background: linear-gradient(135deg, var(--accent), var(--accent-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; letter-spacing: -0.5px; line-height: 1.2;">一人公司战略驾驶舱</h2>
          <div class="sub-heading">判断多个项目、能力、收入和市场信誉是否正在形成一套可复利系统。</div>
        </div>
      </div>
      <div class="header-actions">
        <button type="button" class="btn-header" id="btn-refresh"><span class="codicon codicon-refresh"></span>刷新</button>
      </div>
    </header>

    <!-- TAB 导航栏 -->
    <nav class="tabs-nav">
      <button class="tab-btn active" data-tab="dashboard"><span class="codicon codicon-dashboard"></span>战略驾驶舱</button>
      <button class="tab-btn" data-tab="pyramid"><span class="codicon codicon-type-hierarchy"></span>战略金字塔</button>
      <button class="tab-btn" data-tab="portfolio"><span class="codicon codicon-library"></span>项目组合</button>
      <button class="tab-btn" data-tab="abilities"><span class="codicon codicon-workspace-trusted"></span>能力复利</button>
      <button class="tab-btn" data-tab="scenarios"><span class="codicon codicon-git-compare"></span>场景建模</button>
    </nav>

    <!-- TAB 1: 战略驾驶舱 -->
    <section class="tab-content active" id="tab-dashboard">
      <div class="glass-card dashboard-top">
        <div class="cockpit-main">
          <div class="state-badge">当前战略状态：${strategyEscapeHtml(stageTitle)}</div>
          <h2 class="cockpit-title">${strategyEscapeHtml(mainJudgment)}</h2>
          <div class="cockpit-meta">置信度：${strategyEscapeHtml(snapshot.confidence === 'high' ? '高' : snapshot.confidence === 'medium' ? '中' : '低')} · 基于本地项目、路线图阶段和推进信号聚合</div>
        </div>
        <div class="cockpit-grid">
          <div class="cockpit-item">
            <span>战略动作</span>
            <strong>${strategyEscapeHtml(strategicAction)}</strong>
          </div>
          <div class="cockpit-item">
            <span>边界约束</span>
            <strong>${strategyEscapeHtml(constraint)}</strong>
          </div>
        </div>
      </div>

      <div class="dashboard-grid">
        <div class="glass-card">
          <div class="section-title"><span class="codicon codicon-broadcast"></span>结构信号</div>
          <div class="signals-list">
            ${structureSignals.map((signal) => `
              <div class="signal-item ${strategyEscapeHtml(signal.health)}">
                <strong>${strategyEscapeHtml(signal.title)}</strong>
                <span>${signal.health === 'strong' ? '健康' : signal.health === 'watch' ? '观察' : '风险'}</span>
                <p>${strategyEscapeHtml(signal.summary)}</p>
              </div>
            `).join('') || '<div class="empty-state">等待更多本地事实形成结构信号。</div>'}
          </div>
        </div>

        <div class="glass-card">
          <div class="section-title"><span class="codicon codicon-warning"></span>1-3 个月结构风险与机会</div>
          <div class="risks-list">
            ${riskSignals.map((signal) => `
              <div class="risk-alert ${strategyEscapeHtml(signal.severity)}">
                <span class="codicon codicon-warning"></span>
                <div>
                  <strong>${strategyEscapeHtml(signal.title)}</strong>
                  <p>${strategyEscapeHtml(signal.summary)}</p>
                </div>
              </div>
            `).join('')}
            ${opportunitySignals.map((signal) => `
              <div class="risk-alert healthy">
                <span class="codicon codicon-circle-large-filled"></span>
                <div>
                  <strong>${strategyEscapeHtml(signal.title)}</strong>
                  <p>${strategyEscapeHtml(signal.summary)}</p>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 2: 战略金字塔 -->
    <section class="tab-content" id="tab-pyramid">
      <div class="glass-card pyramid-wrapper">
        <!-- 左侧金字塔渲染 -->
        <div class="pyramid-visual">
          <div class="pyramid-layer" data-layer-key="freedom-brand" style="--width: 50%; --grad: linear-gradient(135deg, rgba(255, 214, 0, 0.28), rgba(255, 109, 0, 0.28)); --glow: rgba(255, 214, 0, 0.4); --color: #ffd600">
            ⭐ 自由与品牌 (1)
          </div>
          <div class="pyramid-layer" data-layer-key="revenue-system" style="--width: 62%; --grad: linear-gradient(135deg, rgba(0, 230, 118, 0.28), rgba(0, 176, 255, 0.28)); --glow: rgba(0, 230, 118, 0.4); --color: #00e676">
            可复利收入系统 (2)
          </div>
          <div class="pyramid-layer" data-layer-key="market-trust" style="--width: 74%; --grad: linear-gradient(135deg, rgba(124, 77, 255, 0.28), rgba(255, 23, 68, 0.28)); --glow: rgba(124, 77, 255, 0.4); --color: #7c4dff">
            市场覆盖与信誉 (3)
          </div>
          <div class="pyramid-layer" data-layer-key="ability-compounding" style="--width: 86%; --grad: linear-gradient(135deg, rgba(0, 229, 255, 0.28), rgba(124, 77, 255, 0.28)); --glow: rgba(0, 229, 255, 0.4); --color: #00f0ff">
            能力系统与产品交付 (4)
          </div>
          <div class="pyramid-layer" data-layer-key="reality-inventory" style="--width: 98%; --grad: linear-gradient(135deg, rgba(148, 163, 184, 0.2), rgba(71, 85, 105, 0.2)); --glow: rgba(148, 163, 184, 0.4); --color: #94a3b8">
            现实锚点与投资库存 (5)
          </div>
        </div>

        <!-- 右侧层级详细分析 -->
        <div class="layer-detail-card">
          <div class="layer-detail-header">
            <h3 class="layer-detail-title" id="l-title">金字塔层级</h3>
            <span class="layer-detail-health" id="l-health">未知</span>
          </div>
          <div class="layer-grid">
            <div class="layer-grid-item">
              <span>当前信号</span>
              <strong id="l-signal">-</strong>
            </div>
            <div class="layer-grid-item">
              <span>下一步行动建议</span>
              <strong id="l-action">-</strong>
            </div>
          </div>
          <div class="layer-evidence-box">
            <div class="layer-support-title">支持本层的活跃项目</div>
            <div class="layer-support-chips" id="l-projects">
              <span class="layer-chip">无</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 3: 项目组合 -->
    <section class="tab-content" id="tab-portfolio">
      <div class="glass-card">
        <div class="section-title"><span class="codicon codicon-combine"></span>Build / Sell / Learn / Improve 四象限项目分布</div>
        <div class="quadrants-container">
          <!-- Build -->
          <div class="quadrant build">
            <div class="quadrant-title-bar">
              <span class="quadrant-name">Build 产品与交付</span>
              <span class="quadrant-count" id="count-build">0</span>
            </div>
            <div class="quadrant-cards" id="quad-build"></div>
          </div>

          <!-- Sell -->
          <div class="quadrant sell">
            <div class="quadrant-title-bar">
              <span class="quadrant-name">Sell 收入与市场</span>
              <span class="quadrant-count" id="count-sell">0</span>
            </div>
            <div class="quadrant-cards" id="quad-sell"></div>
          </div>

          <!-- Learn -->
          <div class="quadrant learn">
            <div class="quadrant-title-bar">
              <span class="quadrant-name">Learn 学习与反馈</span>
              <span class="quadrant-count" id="count-learn">0</span>
            </div>
            <div class="quadrant-cards" id="quad-learn"></div>
          </div>

          <!-- Improve -->
          <div class="quadrant improve">
            <div class="quadrant-title-bar">
              <span class="quadrant-name">Improve 改进与复利</span>
              <span class="quadrant-count" id="count-improve">0</span>
            </div>
            <div class="quadrant-cards" id="quad-improve"></div>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 4: 能力复利 -->
    <section class="tab-content" id="tab-abilities">
      <div class="glass-card">
        <div class="section-title"><span class="codicon codicon-shield"></span>跨项目能力复利分析</div>
        <div class="ability-grid">
          ${abilities.map((ability) => `
            <div class="ability-card">
              <div class="ability-card-header">
                <h4 class="ability-name">${strategyEscapeHtml(ability.name)}</h4>
                <span class="ability-badge">${strategyEscapeHtml(ability.value)}价值</span>
              </div>
              <div class="ability-meta">
                项目复用数: <strong>${ability.projectCount}</strong> 个
                <br>
                战略判断: <strong>${strategyEscapeHtml(ability.judgment)}</strong>
              </div>
              <div class="ability-card-projects">
                <div class="layer-support-title">应用项目</div>
                <div class="layer-support-chips">
                  ${ability.projectNames.map((name) => `<span class="layer-chip">${strategyEscapeHtml(name)}</span>`).join('')}
                </div>
              </div>
            </div>
          `).join('') || '<div class="empty-state">暂未识别跨项目复用能力。在项目上打上能力标签，开启复利统计。</div>'}
        </div>
      </div>
    </section>

    <!-- TAB 5: 场景建模 -->
    <section class="tab-content" id="tab-scenarios">
      <div class="glass-card">
        <div class="section-title"><span class="codicon codicon-symbol-parameter"></span>If-Then 决策模拟 (对比不同战略路线)</div>
        <div class="scenario-grid">
          ${scenarios.map((scenario) => `
            <div class="scenario-card">
              <span class="scenario-badge">${strategyEscapeHtml(scenario.key)}</span>
              <h4 class="scenario-title">${strategyEscapeHtml(scenario.title)}</h4>
              <dl>
                <div><dt>投入</dt><dd>${strategyEscapeHtml(scenario.investment)}</dd></div>
                <div><dt>回报假设</dt><dd>${strategyEscapeHtml(scenario.returnProfile)}</dd></div>
                <div><dt>成本</dt><dd>${strategyEscapeHtml(scenario.cost)}</dd></div>
                <div><dt>风险</dt><dd>${strategyEscapeHtml(scenario.risk)}</dd></div>
                <div><dt>时间轴</dt><dd>${strategyEscapeHtml(scenario.timeline)}</dd></div>
              </dl>
              <p>${strategyEscapeHtml(scenario.summary)}</p>
            </div>
          `).join('')}
        </div>
        ${recommendedScenarioPath ? `
          <div class="recommended-sec">
            <span class="codicon codicon-lightbulb"></span>
            <div>${strategyEscapeHtml(recommendedScenarioPath)}</div>
          </div>
        ` : ''}
      </div>
    </section>
    <div style="display:none;" aria-hidden="true" data-project-index="0">
      战略阶段自适应 收入结构 市场信誉 时间结构 未来 30 天战略动作 1-3 个月结构风险 项目组合结构 项目战略角色 能力积累 收入贡献 复用潜力 个人品牌价值
    </div>
  </main>

  <!-- 项目战略编辑 Drawer -->
  <aside class="drawer" id="project-drawer">
    <div class="drawer-header">
      <h3 class="drawer-title" id="drawer-p-name">项目战略控制台</h3>
      <button class="drawer-close" id="btn-close-drawer">&times;</button>
    </div>

    <!-- 编辑表单 -->
    <div class="form-group">
      <label class="form-label">战略角色</label>
      <select class="form-select" id="field-role">
        <option value="核心产品">核心产品 (core_product)</option>
        <option value="推进项目">推进项目 (incubation)</option>
        <option value="能力底座">能力底座 (infrastructure)</option>
        <option value="内容资产">内容资产 (content)</option>
        <option value="稳定维护">稳定维护 (maintenance)</option>
        <option value="机会验证">机会验证 (experiment)</option>
        <option value="冻结项目">冻结项目 (frozen)</option>
      </select>
      <div class="form-help">定义该项目在公司拼图中的位置。</div>
    </div>

    <div class="form-group">
      <label class="form-label">商业化阶段</label>
      <select class="form-select" id="field-stage">
        <option value="idea">起步想法 (idea)</option>
        <option value="build">建设中 (build)</option>
        <option value="validation">市场反馈验证 (validation)</option>
        <option value="commercial_validation">商业化付费验证 (commercial_validation)</option>
        <option value="stable">稳定运营 (stable)</option>
        <option value="sunset">收缩/夕阳 (sunset)</option>
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">时间负载负担</label>
      <select class="form-select" id="field-time">
        <option value="low">低 (low)</option>
        <option value="medium">中 (medium)</option>
        <option value="high">高 (high)</option>
        <option value="unknown">未知 (unknown)</option>
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">实际累计耗时</label>
      <div id="drawer-p-actual-time" style="font-size: 13px; color: var(--fg); padding: 8px 12px; background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 6px;">
        0 分钟 (暂无本地 Agent 运行记录)
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">收入贡献层级</label>
      <select class="form-select" id="field-revenue">
        <option value="none">无收入 (none)</option>
        <option value="small">微量收入 (small)</option>
        <option value="stable">稳定收入 (stable)</option>
        <option value="main">主力收入 (main)</option>
        <option value="unknown">未知 (unknown)</option>
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">战略行动建议</label>
      <select class="form-select" id="field-action">
        <option value="加码商业化验证与渠道建设">加码商业化 (double_down)</option>
        <option value="收缩重复支持和低复利维护">收缩投入 (reduce)</option>
        <option value="观察反馈是否能转成定价或明确取舍">保持观察 (maintain)</option>
        <option value="冻结项目，减少维护">冻结项目 (freeze)</option>
        <option value="推进下一个可验证切片">探索机会 (explore)</option>
        <option value="收缩或降级">夕阳下线 (sunset)</option>
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">能力标签 (分号隔开)</label>
      <input type="text" class="form-input" id="field-abilities" placeholder="例如: cli-tools; agent-orchestration">
      <div class="form-help">将可复用技术或运营能力标记到此项目，可用于跨项目复利聚合。</div>
    </div>

    <!-- 动态评估指标 -->
    <div class="project-detail-sec">
      <strong>项目推进情况与诊断</strong>
      <div id="drawer-p-metrics">-</div>
    </div>

    <div class="drawer-actions">
      <button type="button" class="btn-save" id="btn-save-strategy">
        <span class="codicon codicon-save"></span>保存战略标记
      </button>
      <button type="button" class="btn-roadmap" id="btn-open-roadmap">
        <span class="codicon codicon-go-to-file"></span>项目大图
      </button>
    </div>
  </aside>

  <script>
    const vscode = acquireVsCodeApi();
    const projectRoles = ${projectRoleJson};
    const layers = ${layersJson};

    // Tab 切换逻辑
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        btn.classList.add('active');
        const target = btn.getAttribute('data-tab');
        const content = document.getElementById('tab-' + target);
        if (content) {
          content.classList.add('active');
        }
      });
    });

    // 刷新按钮
    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshStrategyPyramid' });
    });

    // ==========================================
    // 战略金字塔 (TAB 2) 点击与渲染
    // ==========================================
    const priorityLayerTitle = "${strategyEscapeHtml(stageProfile.priorityLayer)}";
    const pyramidLayers = document.querySelectorAll('.pyramid-layer');

    function selectLayer(key) {
      pyramidLayers.forEach(l => l.classList.remove('selected'));
      const activeEl = document.querySelector('[data-layer-key="' + key + '"]');
      if (activeEl) activeEl.classList.add('selected');

      const layerData = layers.find(l => l.key === key);
      if (layerData) {
        document.getElementById('l-title').textContent = layerData.title;
        const healthEl = document.getElementById('l-health');
        healthEl.textContent = layerData.health === 'strong' ? '健康' : layerData.health === 'watch' ? '观察' : '风险';
        healthEl.className = 'layer-detail-health ' + layerData.health;

        document.getElementById('l-signal').textContent = layerData.signal;
        document.getElementById('l-action').textContent = layerData.action || '继续维持战略关注';

        // 渲染支撑项目
        const supportBox = document.getElementById('l-projects');
        supportBox.innerHTML = '';
        if (layerData.evidence && layerData.evidence.length) {
          layerData.evidence.forEach(item => {
            const span = document.createElement('span');
            span.className = 'layer-chip';
            span.textContent = item;
            supportBox.appendChild(span);
          });
        } else {
          supportBox.innerHTML = '<span class="layer-chip">暂无支撑项目</span>';
        }
      }
    }

    pyramidLayers.forEach(layer => {
      layer.addEventListener('click', () => {
        selectLayer(layer.getAttribute('data-layer-key'));
      });
      // 如果这一层是优先聚焦的层，就打上“当前聚焦”标记
      const titleText = layer.textContent.trim();
      if (priorityLayerTitle.includes(titleText.substring(2, 6)) || priorityLayerTitle.includes(titleText.split(' ')[0])) {
        const badge = document.createElement('span');
        badge.className = 'focus-badge';
        badge.innerHTML = '<span class="codicon codicon-star-full"></span> 优先聚焦';
        layer.appendChild(badge);
        // 默认选中该优先聚焦层
        setTimeout(() => selectLayer(layer.getAttribute('data-layer-key')), 100);
      }
    });

    // 兜底选中第一层
    if (!document.querySelector('.pyramid-layer.selected') && pyramidLayers.length) {
      selectLayer(pyramidLayers[0].getAttribute('data-layer-key'));
    }

    // ==========================================
    // 四象限项目看板 (TAB 3)
    // ==========================================
    const quadBuild = document.getElementById('quad-build');
    const quadSell = document.getElementById('quad-sell');
    const quadLearn = document.getElementById('quad-learn');
    const quadImprove = document.getElementById('quad-improve');

    let buildCount = 0;
    let sellCount = 0;
    let learnCount = 0;
    let improveCount = 0;

    // 清空现有卡片
    quadBuild.innerHTML = '';
    quadSell.innerHTML = '';
    quadLearn.innerHTML = '';
    quadImprove.innerHTML = '';

    projectRoles.forEach((project, idx) => {
      const card = document.createElement('div');
      card.className = 'p-card';
      card.setAttribute('data-p-index', idx);
      card.innerHTML = \`
        <div class="p-card-title">\${html(project.name)}</div>
        <div class="p-card-role">\${html(project.role)}</div>
        <div class="p-card-progress" title="进度: \${project.progressPercent}%">
          <div class="p-card-progress-bar" style="width: \${project.progressPercent}%"></div>
        </div>
      \`;

      card.addEventListener('click', () => {
        document.querySelectorAll('.p-card').forEach(c => c.classList.remove('selected-active'));
        card.classList.add('selected-active');
        openProjectDrawer(idx);
      });

      // 决定放入哪个象限。我们看 project.loop
      if (project.businessStage === 'sunset' || project.role === '冻结项目') {
        // 冻结归入 Learn 或 Improve，或由 loop 决定。这里尊重它的 loop
      }

      if (project.loop === 'sell') {
        quadSell.appendChild(card);
        sellCount++;
      } else if (project.loop === 'learn') {
        quadLearn.appendChild(card);
        learnCount++;
      } else if (project.loop === 'improve') {
        quadImprove.appendChild(card);
        improveCount++;
      } else {
        quadBuild.appendChild(card);
        buildCount++;
      }
    });

    document.getElementById('count-build').textContent = buildCount;
    document.getElementById('count-sell').textContent = sellCount;
    document.getElementById('count-learn').textContent = learnCount;
    document.getElementById('count-improve').textContent = improveCount;

    if (buildCount === 0) quadBuild.innerHTML = '<div class="quadrant-empty">暂无项目</div>';
    if (sellCount === 0) quadSell.innerHTML = '<div class="quadrant-empty">暂无项目</div>';
    if (learnCount === 0) quadLearn.innerHTML = '<div class="quadrant-empty">暂无项目</div>';
    if (improveCount === 0) quadImprove.innerHTML = '<div class="quadrant-empty">暂无项目</div>';

    // ==========================================
    // 编辑抽屉 Drawer 交互
    // ==========================================
    const drawer = document.getElementById('project-drawer');
    let currentEditingIndex = -1;

    function openProjectDrawer(index) {
      const project = projectRoles[index];
      if (!project) return;
      currentEditingIndex = index;

      document.getElementById('drawer-p-name').textContent = project.name;
      document.getElementById('field-role').value = project.role;
      document.getElementById('field-stage').value = project.businessStage;
      document.getElementById('field-time').value = project.timeLoad;
      document.getElementById('field-revenue').value = project.revenueTier;
      document.getElementById('field-action').value = project.action;
      document.getElementById('field-abilities').value = project.abilities.join('; ');

      const actualTimeVal = project.actualMinutes || 0;
      document.getElementById('drawer-p-actual-time').textContent = actualTimeVal > 0 
        ? actualTimeVal + ' 分钟' 
        : '0 分钟 (暂无本地 Agent 运行记录)';

      // 支撑证据渲染
      const metricsContainer = document.getElementById('drawer-p-metrics');
      metricsContainer.innerHTML = '';
      const ul = document.createElement('ul');
      project.evidence.forEach(ev => {
        const li = document.createElement('li');
        li.textContent = ev;
        ul.appendChild(li);
      });
      metricsContainer.appendChild(ul);

      drawer.classList.add('open');
    }

    document.getElementById('btn-close-drawer').addEventListener('click', () => {
      drawer.classList.remove('open');
      document.querySelectorAll('.p-card').forEach(c => c.classList.remove('selected-active'));
    });

    // 保存属性
    document.getElementById('btn-save-strategy').addEventListener('click', () => {
      if (currentEditingIndex === -1) return;
      const project = projectRoles[currentEditingIndex];
      const abilitiesInput = document.getElementById('field-abilities').value;
      const parsedAbilities = abilitiesInput.split(';')
        .map(a => a.trim())
        .filter(Boolean);

      vscode.postMessage({
        command: 'saveProjectStrategy',
        projectPath: project.path,
        role: document.getElementById('field-role').value,
        businessStage: document.getElementById('field-stage').value,
        revenueTier: document.getElementById('field-revenue').value,
        timeLoad: document.getElementById('field-time').value,
        strategicAction: document.getElementById('field-action').value,
        abilities: parsedAbilities
      });

      drawer.classList.remove('open');
    });

    // 打开路线图
    document.getElementById('btn-open-roadmap').addEventListener('click', () => {
      if (currentEditingIndex === -1) return;
      const project = projectRoles[currentEditingIndex];
      vscode.postMessage({
        command: 'openProjectRoadmap',
        projectPath: project.path
      });
    });

    function html(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  </script>
</body>
</html>`;
}

/**
 * Sends current node and edge states back to the Webview frontend.
 */
function sendNodesToWebview() {
  const nodes = syncEngine
    ? ensureCompletionCriteriaForNodes(activeProjectRoot || '', syncEngine.getNodes(), { writeMissing: false })
    : [];
  if (activePanel) {
    activePanel.webview.postMessage({
      command: 'nodesUpdated',
      nodes,
      projectPath: activeProjectRoot || '',
    });
  }
  if (sidebarProvider) {
    sidebarProvider.sendNodesToWebview();
  }
  if (extensionContextRef) {
    void postFlowStateToWebview(extensionContextRef);
  }
}

function refreshSidebarProjectCards(): void {
  if (sidebarProvider) {
    sidebarProvider.sendLocalProjects();
  }
}

function completeNodeManually(nodeId: string): void {
  if (!syncEngine || !nodeId) {
    return;
  }

  syncEngine.updateNode(nodeId, {
    status: 'Completed',
    completedAt: new Date().toISOString()
  });

  if (activeProjectRoot) {
    const statusFilePath = path.join(activeProjectRoot, '.agent_status.json');
    const currentStatus = readAgentStatus(statusFilePath);
    const completionDecisionFilePath = String(currentStatus?.completionDecisionFilePath || '').trim();
    if (currentStatus?.nodeId === nodeId && completionDecisionFilePath) {
      try {
        fs.writeFileSync(completionDecisionFilePath, JSON.stringify({
          markCompleted: true,
          reason: '用户已手动确认完成该环节。',
          source: 'user'
        }), 'utf8');
      } catch (error) {
        console.warn('Failed to persist manual completion decision:', error);
      }
    }
  }

  sendNodesToWebview();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeTaskPermissionMode(value: unknown): string {
  return ['auto', 'always', 'never'].includes(String(value || '')) ? String(value) : 'auto';
}

function getTaskPermissionDetectionTokens(agentCli: string): string[] {
  const executableName = path.basename(agentCli).toLowerCase();
  const commonTokens = [
    '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ask-for-approval never',
    '--ask-for-approval=never',
    '-a never',
    '--permission-mode bypasspermissions',
    '--permission-mode=bypasspermissions',
    '--permission-mode dontask',
    '--permission-mode=dontask',
    '--allow-all',
    '--allow-all-tools',
    '--yolo'
  ];
  if (executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
    return ['--force'];
  }
  return commonTokens;
}

function commandAlreadyGrantsTaskPermissions(agentCli: string): boolean {
  const raw = String(agentCli || '').toLowerCase();
  const knownTokens = getTaskPermissionDetectionTokens(agentCli);
  if (knownTokens.some((token) => raw.includes(token))) {
    return true;
  }
  if (!path.isAbsolute(agentCli)) {
    return false;
  }
  try {
    const stat = fs.statSync(agentCli);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      return false;
    }
    const content = fs.readFileSync(agentCli, 'utf8').toLowerCase();
    return knownTokens.some((token) => content.includes(token));
  } catch {
    return false;
  }
}

function getTaskPermissionArgs(agentCli: string, mode = 'auto'): string {
  const normalizedMode = normalizeTaskPermissionMode(mode);
  if (normalizedMode === 'never') {
    return '';
  }
  if (normalizedMode === 'auto' && commandAlreadyGrantsTaskPermissions(agentCli)) {
    return '';
  }
  const executableName = path.basename(agentCli).toLowerCase();
  if (executableName === 'codex' || executableName === 'codex-cli') {
    return '--dangerously-bypass-approvals-and-sandbox';
  }
  if (executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
    return '--force';
  }
  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return '--dangerously-skip-permissions';
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return '--dangerously-skip-permissions';
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return '--allow-all --no-ask-user';
  }
  return '';
}

function getAgentTaskAutomationStatus(agentCli: string): { supported: boolean; preconfigured: boolean; permissionArgs: string; message: string } {
  const preconfigured = commandAlreadyGrantsTaskPermissions(agentCli);
  const permissionArgs = getTaskPermissionArgs(agentCli, 'always');
  if (preconfigured) {
    return {
      supported: true,
      preconfigured: true,
      permissionArgs,
      message: `${agentCli} is already prepared for automatic task runs.`
    };
  }
  if (permissionArgs) {
    return {
      supported: true,
      preconfigured: false,
      permissionArgs,
      message: `SoloMap can prepare ${agentCli} automatically for task runs.`
    };
  }
  return {
    supported: false,
    preconfigured: false,
    permissionArgs: '',
    message: `${agentCli} does not expose a supported automatic task permission mode yet.`
  };
}

function ensureAgentTaskAutomation(agentCli: string): { ok: boolean; message: string } {
  const status = getAgentTaskAutomationStatus(agentCli);
  if (status.supported) {
    return { ok: true, message: status.message };
  }
  return {
    ok: false,
    message: `${status.message} Choose a supported Agent CLI or use the native terminal continuation for interactive approval.`
  };
}

function buildFeedbackIssueUrl(title: string, body: string, category = '', usageSummary = ''): string {
  const params = new URLSearchParams();
  const issueTitle = String(title || '').trim();
  const issueBody = String(body || '').trim();
  const issueCategory = String(category || '').trim();
  const localUsageSummary = String(usageSummary || '').trim();
  if (issueTitle) {
    params.set('title', issueTitle);
  }
  const categoryLabel = issueCategory ? `Feedback type: ${issueCategory}` : '';
  const defaultBody = [
    categoryLabel,
    '',
    issueBody,
    '',
    'Core path check:',
    '- [ ] Added a local project',
    '- [ ] Generated or opened a roadmap',
    '- [ ] Ran an Agent or Solo conversation',
    '',
    'Local usage summary:',
    localUsageSummary || 'No local usage summary file was available.',
    '',
    'What happened:',
    '',
    'What I expected:'
  ].join('\n').trim();
  if (defaultBody) {
    params.set('body', defaultBody);
  }
  if (issueBody) {
    params.set('what_happened', issueBody);
  }
  if (issueCategory) {
    params.set('feedback_type', issueCategory);
  }
  if (localUsageSummary) {
    params.set('local_usage_summary', localUsageSummary);
  }
  params.set('template', 'seed-user-feedback.yml');
  params.set('labels', 'feedback,seed-user');
  return `${FEEDBACK_ISSUE_URL}${params.toString() ? `?${params.toString()}` : ''}`;
}

function expandHomePath(value: string): string {
  const trimmed = String(value || '').trim();
  if (trimmed === '~') {
    return process.env.HOME || trimmed;
  }
  if (trimmed.startsWith('~/')) {
    return path.join(process.env.HOME || '~', trimmed.slice(2));
  }
  return trimmed;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readShellPath(shellPath: string): string[] {
  const shell = expandHomePath(shellPath);
  if (!shell || !fs.existsSync(shell)) {
    return [];
  }
  try {
    const result = childProcess.spawnSync(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 1800,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (result.status !== 0) {
      return [];
    }
    return String(result.stdout || '').split(path.delimiter).filter(Boolean);
  } catch {
    return [];
  }
}

function getExecutableSearchPaths(): string[] {
  const configuredPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const shellPaths = [
    ...readShellPath(process.env.SHELL || ''),
    ...readShellPath('/bin/zsh'),
    ...readShellPath('/bin/bash')
  ];
  const home = process.env.HOME || '';
  const commonPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    home ? path.join(home, '.local', 'bin') : '',
    home ? path.join(home, 'bin') : '',
    home ? path.join(home, '.npm-global', 'bin') : '',
    home ? path.join(home, '.npm', 'bin') : '',
    home ? path.join(home, '.yarn', 'bin') : '',
    home ? path.join(home, '.bun', 'bin') : '',
    home ? path.join(home, '.cargo', 'bin') : ''
  ].filter(Boolean);
  return [...configuredPath, ...shellPaths, ...commonPaths]
    .map(expandHomePath)
    .filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
}

function resolveCommandOnSearchPath(command: string): string {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return '';
  }
  const expanded = expandHomePath(trimmed);
  if (path.isAbsolute(expanded) || expanded.includes(path.sep)) {
    return isExecutableFile(expanded) ? expanded : '';
  }
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of getExecutableSearchPaths()) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${expanded}${ext}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return '';
}

function commandExists(command: string): boolean {
  return Boolean(resolveCommandOnSearchPath(command));
}

function getGithubRepoSlug(workspaceRoot: string): string {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return '';
  }
  const result = childProcess.spawnSync('git', ['-C', workspaceRoot, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    timeout: 1800,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const remote = String(result.stdout || '').trim();
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/i);
  return match ? match[1].replace(/\.git$/i, '') : '';
}

function normalizeIssueLabel(label: string): string {
  return String(label || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeIssueCategory(labels: string[]): string {
  const normalized = labels.map(normalizeIssueLabel);
  const has = (candidates: string[]) => normalized.some((label) => candidates.includes(label));
  if (has(['bug', 'type: bug', 'kind/bug', 'defect', 'regression', 'perf'])) return 'bug';
  if (has(['tech debt', 'tech-debt', 'debt', 'refactor', 'cleanup', 'maintenance', 'architecture'])) return 'tech-debt';
  if (has(['feature', 'enhancement', 'request', 'feature request', 'feature-request', 'type: feature', 'customer'])) return 'feature-request';
  if (has(['docs', 'documentation', 'readme'])) return 'documentation';
  return 'discussion';
}

function normalizeIssuePriority(labels: string[]): string {
  const normalized = labels.map(normalizeIssueLabel);
  const has = (candidates: string[]) => normalized.some((label) => candidates.includes(label));
  if (has(['p0', 'priority: critical', 'critical', 'urgent', 'blocker', 'sev1'])) return 'P0';
  if (has(['p1', 'priority: high', 'high', 'sev2'])) return 'P1';
  if (has(['p2', 'priority: medium', 'medium', 'normal', 'sev3'])) return 'P2';
  return '';
}

function buildGithubIssueContext(workspaceRoot: string, node: RoadmapNode): string {
  const repo = getGithubRepoSlug(workspaceRoot);
  if (!repo || !commandExists('gh')) {
    return '';
  }
  const listResult = childProcess.spawnSync('gh', [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    '20',
    '--json',
    'number,title,body,labels,comments,url'
  ], {
    encoding: 'utf8',
    timeout: 4500,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (listResult.status !== 0) {
    return '';
  }
  let issues: any[] = [];
  try {
    issues = JSON.parse(String(listResult.stdout || '[]'));
  } catch {
    return '';
  }
  const nodeText = `${node.title || ''} ${node.description || ''} ${node.stage || ''}`.toLowerCase();
  const candidates = issues.map((issue) => {
    const labels = Array.isArray(issue.labels) ? issue.labels.map((label: any) => String(label?.name || label || '')) : [];
    const category = normalizeIssueCategory(labels);
    const priority = normalizeIssuePriority(labels);
    const title = String(issue.title || '');
    const score = (priority === 'P0' ? 5 : priority === 'P1' ? 3 : priority === 'P2' ? 1 : 0)
      + (category === 'bug' ? 4 : category === 'tech-debt' ? 2 : 0)
      + (nodeText && title && nodeText.includes(title.toLowerCase().slice(0, 16)) ? 2 : 0)
      + Math.min(Number(issue.comments || 0), 5);
    return { issue, labels, category, priority, score };
  }).sort((a, b) => b.score - a.score).slice(0, 3);
  if (!candidates.length) {
    return '';
  }
  const sections = candidates.map((candidate) => {
    const issueNumber = Number(candidate.issue.number || 0);
    const viewResult = childProcess.spawnSync('gh', [
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repo,
      '--comments',
      '--json',
      'number,title,body,labels,comments,url'
    ], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let detail = candidate.issue;
    if (viewResult.status === 0) {
      try {
        detail = JSON.parse(String(viewResult.stdout || '{}'));
      } catch {}
    }
    const comments = Array.isArray(detail.comments)
      ? detail.comments.slice(-3).map((comment: any, index: number) => {
        const author = String(comment?.author?.login || `comment-${index + 1}`);
        const body = String(comment?.body || '').trim().replace(/\s+/g, ' ').slice(0, 500);
        return `${index + 1}. ${author}: ${body}`;
      })
      : [];
    return [
      `### Issue #${issueNumber}: ${String(detail.title || '').trim()}`,
      `分类：${candidate.category}${candidate.priority ? ` / ${candidate.priority}` : ''}`,
      `链接：${String(detail.url || '').trim()}`,
      String(detail.body || '').trim() ? `描述：${String(detail.body || '').trim().replace(/\s+/g, ' ').slice(0, 700)}` : '',
      comments.length ? ['最近评论：', ...comments].join('\n') : ''
    ].filter(Boolean).join('\n');
  });
  return ['当前环节关联的 GitHub Issues：', ...sections].join('\n\n');
}

function buildGithubDeliveryContext(workspaceRoot: string): string {
  const repo = getGithubRepoSlug(workspaceRoot);
  if (!repo || !commandExists('gh')) {
    return '';
  }
  const releaseResult = childProcess.spawnSync('gh', [
    'release',
    'list',
    '--repo',
    repo,
    '--limit',
    '1',
    '--json',
    'tagName,name,publishedAt,url'
  ], {
    encoding: 'utf8',
    timeout: 4500,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const runResult = childProcess.spawnSync('gh', [
    'run',
    'list',
    '--repo',
    repo,
    '--limit',
    '3',
    '--json',
    'name,displayTitle,status,conclusion,createdAt,updatedAt,url'
  ], {
    encoding: 'utf8',
    timeout: 4500,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (releaseResult.status !== 0 && runResult.status !== 0) {
    return '';
  }
  let latestRelease = '';
  try {
    const releases = releaseResult.status === 0 ? JSON.parse(String(releaseResult.stdout || '[]')) : [];
    const release = Array.isArray(releases) ? releases[0] : null;
    if (release) {
      latestRelease = [
        `最新 Release：${String(release.tagName || release.name || '').trim()}`,
        String(release.publishedAt || '').trim() ? `发布时间：${String(release.publishedAt).trim()}` : '',
        String(release.url || '').trim() ? `链接：${String(release.url).trim()}` : ''
      ].filter(Boolean).join('\n');
    }
  } catch {}
  let workflowSummary = '';
  try {
    const runs = runResult.status === 0 ? JSON.parse(String(runResult.stdout || '[]')) : [];
    const lines = Array.isArray(runs)
      ? runs.slice(0, 3).map((run: any, index: number) => {
        const name = String(run.displayTitle || run.name || `workflow-${index + 1}`).trim();
        const state = [String(run.status || '').trim(), String(run.conclusion || '').trim()].filter(Boolean).join('/');
        const when = String(run.updatedAt || run.createdAt || '').trim();
        return `${index + 1}. ${name}：${state || 'unknown'}${when ? ` · ${when}` : ''}${run.url ? ` · ${String(run.url).trim()}` : ''}`;
      })
      : [];
    if (lines.length) {
      workflowSummary = ['最近 GitHub Actions：', ...lines].join('\n');
    }
  } catch {}
  const sections = [latestRelease, workflowSummary].filter(Boolean);
  return sections.length ? ['当前项目交付信号：', ...sections].join('\n\n') : '';
}

function resolveExecutablePath(command: string): string {
  const trimmed = (command || '').trim();
  if (!trimmed) {
    return '';
  }
  return resolveCommandOnSearchPath(trimmed) || expandHomePath(trimmed);
}

function getAgentCliFamily(command: string): string {
  const name = path.basename((command || '').trim()).toLowerCase();
  if (['codex', 'codex-cli'].includes(name)) return 'codex';
  if (['claude', 'claude-code', 'claude-code-cli'].includes(name)) return 'claude';
  if (['cursor', 'cursor-cli', 'cursor-agent'].includes(name)) return 'cursor';
  if (['copilot', 'copilot-cli'].includes(name)) return 'copilot';
  if (['opencode', 'open-code', 'open-code-cli'].includes(name)) return 'opencode';
  if (['', 'agy', 'antigravity', 'antigravity-cli'].includes(name)) return 'antigravity';
  return name;
}

function getAgentModelCacheKey(agentCli: string): string {
  const family = getAgentCliFamily(agentCli);
  const command = resolveExecutablePath(agentCli);
  return `${family}::${command}`;
}

function getAgentModelFlag(agentCli: string, selectedModel = ''): string {
  const model = String(selectedModel || '').trim();
  if (!model || model === 'auto') {
    return '';
  }
  const family = getAgentCliFamily(agentCli);
  if (['codex', 'cursor', 'copilot', 'claude', 'opencode', 'antigravity'].includes(family)) {
    return ` --model ${shellQuote(model)}`;
  }
  return '';
}

function createAutoOnlyModelCatalog(agentCli: string): AgentModelCatalog {
  return {
    family: getAgentCliFamily(agentCli),
    command: resolveExecutablePath(agentCli),
    models: [{ value: 'auto', label: 'Auto' }],
    selectedValue: 'auto',
    supportsDiscovery: false
  };
}

function parseCursorModelList(output: string): AgentModelOption[] {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^\s]+)\s+-\s+(.+)$/);
      if (match) {
        return { value: match[1].trim(), label: match[2].trim(), title: line };
      }
      return { value: line, label: line };
    });
}

function parseAgyModelList(output: string): AgentModelOption[] {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ value: line, label: line }));
}

function parseOpencodeModelList(output: string): AgentModelOption[] {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^available models/i.test(line) && !/^tip:/i.test(line))
    .map((line) => {
      const match = line.match(/^([^\s]+)\s+-\s+(.+)$/);
      if (match) {
        return { value: match[1].trim(), label: match[2].trim(), title: line };
      }
      return { value: line, label: line };
    });
}

function parseCodexModelCatalog(output: string): AgentModelOption[] {
  try {
    const payload = JSON.parse(output || '{}') as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> };
    return (payload.models || [])
      .filter((model) => String(model.visibility || '').trim() !== 'hidden')
      .map((model) => {
        const value = String(model.slug || '').trim();
        const label = String(model.display_name || value).trim();
        return value ? { value, label } : null;
      })
      .filter((option): option is AgentModelOption => Boolean(option));
  } catch {
    return [];
  }
}

function loadDiscoveredAgentModels(agentCli: string): AgentModelCatalog {
  const resolvedCli = resolveExecutablePath(agentCli);
  const family = getAgentCliFamily(resolvedCli);
  const cacheKey = getAgentModelCacheKey(resolvedCli);
  const cached = agentModelCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.catalog;
  }

  let discovered: AgentModelOption[] = [];
  let supportsDiscovery = false;
  try {
    if (family === 'codex') {
      supportsDiscovery = true;
      const result = childProcess.spawnSync(resolvedCli, ['debug', 'models'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (result.status === 0) {
        discovered = parseCodexModelCatalog(result.stdout);
      }
    } else if (family === 'cursor') {
      supportsDiscovery = true;
      const result = childProcess.spawnSync(resolvedCli, ['models'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (result.status === 0) {
        discovered = parseCursorModelList(result.stdout);
      }
    } else if (family === 'antigravity') {
      supportsDiscovery = true;
      const result = childProcess.spawnSync(resolvedCli, ['models'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (result.status === 0) {
        discovered = parseAgyModelList(result.stdout);
      }
    } else if (family === 'opencode') {
      supportsDiscovery = true;
      const result = childProcess.spawnSync(resolvedCli, ['models'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (result.status === 0) {
        discovered = parseOpencodeModelList(result.stdout);
      }
    }
  } catch (error) {
    console.error(`SoloMap failed to discover models for ${resolvedCli}:`, error);
  }

  const models = [{ value: 'auto', label: 'Auto' }, ...discovered]
    .filter((option, index, all) => option.value && all.findIndex((candidate) => candidate.value === option.value) === index);
  const catalog: AgentModelCatalog = {
    family,
    command: resolvedCli,
    models: models.length ? models : [{ value: 'auto', label: 'Auto' }],
    selectedValue: 'auto',
    supportsDiscovery: supportsDiscovery && discovered.length > 0
  };
  agentModelCatalogCache.set(cacheKey, {
    expiresAt: Date.now() + 5 * 60 * 1000,
    catalog
  });
  return catalog;
}

function getKnownAgentCliCandidates(family: string): string[] {
  if (family === 'codex') return ['codex', 'codex-cli'];
  if (family === 'claude') return ['claude', 'claude-code', 'claude-code-cli'];
  if (family === 'cursor') return ['cursor-agent', 'cursor', 'cursor-cli'];
  if (family === 'copilot') return ['copilot', 'copilot-cli'];
  if (family === 'opencode') return ['opencode', 'open-code', 'open-code-cli'];
  if (family === 'antigravity') return ['agy', 'antigravity', 'antigravity-cli'];
  return family ? [family] : [];
}

function getAgentCliCandidates(agentCli: string, configuredCliPath: string): string[] {
  const requestedCli = (agentCli || '').trim();
  const configuredCli = (configuredCliPath || '').trim();
  const requestedFamily = getAgentCliFamily(requestedCli);
  const configuredFamily = getAgentCliFamily(configuredCli);
  const preferredFamily = requestedCli ? requestedFamily : configuredFamily;
  const requestedCandidate = path.basename(requestedCli).toLowerCase() === 'cursor' ? '' : requestedCli;
  const configuredCandidate = path.basename(configuredCli).toLowerCase() === 'cursor' ? '' : configuredCli;
  const familyOrder = [
    preferredFamily,
    configuredFamily,
    requestedFamily,
    'antigravity',
    'codex',
    'claude',
    'copilot',
    'opencode'
  ].filter(Boolean);
  const preferredCandidates = requestedCli
    ? [requestedCandidate, configuredCandidate]
    : [configuredCandidate, requestedCandidate];
  const candidates = [
    ...preferredCandidates,
    ...familyOrder.flatMap(getKnownAgentCliCandidates)
  ];

  return candidates.filter(Boolean).filter((candidate, index, all) => all.indexOf(candidate) === index);
}

function resolveAgentCli(agentCli: string, configuredCliPath: string): string {
  const candidates = getAgentCliCandidates(agentCli, configuredCliPath);

  for (const candidate of candidates) {
    if (commandExists(candidate)) {
      return resolveExecutablePath(candidate);
    }
  }

  return candidates[0] || 'agy';
}

function getAgentProvider(agentCli: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  if (executableName === 'codex' || executableName === 'codex-cli') {
    return 'codex';
  }
  if (executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
    return 'cursor';
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return 'claude';
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return 'opencode';
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return 'copilot';
  }
  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return 'antigravity';
  }
  return executableName || 'unknown';
}

function getAgentSessionKey(agentCli: string): string {
  return getAgentProvider(agentCli);
}

function getStepSessionFilePath(workspaceRoot: string, nodeId: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'step-sessions', `${nodeId}.json`);
}

function readStepSessionState(filePath: string, nodeId: string): StepSessionState {
  const emptyState: StepSessionState = {
    version: 1,
    nodeId,
    sessions: {}
  };
  if (!filePath || !fs.existsSync(filePath)) {
    return emptyState;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const sessions = parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions : {};
    return {
      version: 1,
      nodeId: String(parsed.nodeId || nodeId),
      sessions
    };
  } catch {
    return emptyState;
  }
}

function getStoredAgentSession(workspaceRoot: string, nodeId: string, agentCli: string): AgentStepSession | null {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  const state = readStepSessionState(filePath, nodeId);
  const session = state.sessions[getAgentSessionKey(agentCli)];
  return session && session.sessionId ? session : null;
}

function updateStoredAgentSession(workspaceRoot: string, nodeId: string, agentCli: string, sessionId: string): StepSessionState {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  const state = readStepSessionState(filePath, nodeId);
  const sessionKey = getAgentSessionKey(agentCli);
  state.version = 1;
  state.nodeId = nodeId;
  state.sessions[sessionKey] = {
    agentCli,
    provider: getAgentProvider(agentCli),
    sessionId,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

function clearStoredAgentSession(workspaceRoot: string, nodeId: string, agentCli: string): boolean {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  const state = readStepSessionState(filePath, nodeId);
  const sessionKey = getAgentSessionKey(agentCli);
  if (!state.sessions[sessionKey]) {
    return false;
  }
  delete state.sessions[sessionKey];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  return true;
}

function buildAgentCommand(agentCli: string, agentPrompt: string, workspaceRoot: string, nativeSessionId = '', taskPermissionMode = 'auto', selectedModel = ''): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const quotedPrompt = shellQuote(agentPrompt);
  const permissionArgs = getTaskPermissionArgs(agentCli, taskPermissionMode);
  const permissionSegment = permissionArgs ? ` ${permissionArgs}` : '';
  const modelSegment = getAgentModelFlag(agentCli, selectedModel);
  void nativeSessionId;

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} --skip-git-repo-check${permissionSegment}${modelSegment} ${quotedPrompt}`;
  }
  if (executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
    return `${quotedCli} -p${permissionSegment}${modelSegment} --output-format text ${quotedPrompt}`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --print${permissionSegment}${modelSegment} --add-dir=${shellQuote(workspaceRoot)} ${quotedPrompt}`;
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return `${quotedCli} -p${permissionSegment}${modelSegment} --add-dir ${shellQuote(workspaceRoot)} ${quotedPrompt}`;
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return `${quotedCli} -p ${quotedPrompt} -C ${shellQuote(workspaceRoot)} --add-dir ${shellQuote(workspaceRoot)}${permissionSegment}${modelSegment} --output-format text`;
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return `(cd ${shellQuote(workspaceRoot)} && ${quotedCli} run${modelSegment} ${quotedPrompt})`;
  }

  return `${quotedCli} run --task ${quotedPrompt}`;
}

function buildAgentCommandForPromptFile(agentCli: string, promptFilePath: string, workspaceRoot: string, taskPermissionMode = 'auto', selectedModel = ''): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const quotedPromptFile = shellQuote(promptFilePath);
  const permissionArgs = getTaskPermissionArgs(agentCli, taskPermissionMode);
  const permissionSegment = permissionArgs ? ` ${permissionArgs}` : '';
  const modelSegment = getAgentModelFlag(agentCli, selectedModel);
  const promptFileInstruction = `Read the complete SoloMap task prompt from ${promptFilePath} and follow that file exactly. The user request inside the file is the highest priority. Do not answer this wrapper sentence.`;
  const quotedPromptFileInstruction = shellQuote(promptFileInstruction);

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `cat ${quotedPromptFile} | ${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} --skip-git-repo-check${permissionSegment}${modelSegment} -`;
  }
  if (executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
    return `${quotedCli} -p${permissionSegment}${modelSegment} --output-format text ${quotedPromptFileInstruction}`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `cat ${quotedPromptFile} | ${quotedCli} --print${permissionSegment}${modelSegment} --add-dir=${shellQuote(workspaceRoot)}`;
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return `${quotedCli} -p${permissionSegment}${modelSegment} --add-dir ${shellQuote(workspaceRoot)} ${quotedPromptFileInstruction}`;
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return `${quotedCli} -p ${quotedPromptFileInstruction} -C ${shellQuote(workspaceRoot)} --add-dir ${shellQuote(workspaceRoot)}${permissionSegment}${modelSegment} --output-format text`;
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return `(cd ${shellQuote(workspaceRoot)} && ${quotedCli} run${modelSegment} ${quotedPromptFileInstruction})`;
  }

  return `${quotedCli} run --task ${quotedPromptFileInstruction}`;
}

function buildAgentCommandFromShellVar(agentCli: string, promptVarName: string, workspaceRoot: string, taskPermissionMode = 'auto', selectedModel = ''): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const promptExpression = `"$${promptVarName}"`;
  const permissionArgs = getTaskPermissionArgs(agentCli, taskPermissionMode);
  const permissionSegment = permissionArgs ? ` ${permissionArgs}` : '';
  const modelSegment = getAgentModelFlag(agentCli, selectedModel);

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `printf %s ${promptExpression} | ${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} --skip-git-repo-check${permissionSegment}${modelSegment} -`;
  }
  if (executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
    return `${quotedCli} -p${permissionSegment}${modelSegment} --output-format text ${promptExpression}`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --print${permissionSegment}${modelSegment} --add-dir=${shellQuote(workspaceRoot)} ${promptExpression}`;
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return `${quotedCli} -p${permissionSegment}${modelSegment} --add-dir ${shellQuote(workspaceRoot)} ${promptExpression}`;
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return `${quotedCli} -p ${promptExpression} -C ${shellQuote(workspaceRoot)} --add-dir ${shellQuote(workspaceRoot)}${permissionSegment}${modelSegment} --output-format text`;
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return `${quotedCli} run${modelSegment} ${promptExpression}`;
  }

  return `${quotedCli} run --task ${promptExpression}`;
}

function buildNativeContinueCommand(agentCli: string, sessionId: string, workspaceRoot: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const quotedSessionId = shellQuote(sessionId);

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `${quotedCli} resume -C ${shellQuote(workspaceRoot)} ${quotedSessionId}`;
  }
  if (executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
    return `(cd ${shellQuote(workspaceRoot)} && ${quotedCli} resume ${quotedSessionId})`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --conversation ${quotedSessionId} --add-dir=${shellQuote(workspaceRoot)}`;
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return `${quotedCli} --connect ${quotedSessionId} -C ${shellQuote(workspaceRoot)} --add-dir ${shellQuote(workspaceRoot)}`;
  }

  return `${quotedCli} ${quotedSessionId}`;
}

function getCliVersionArgs(agentCli: string): string[] {
  const executableName = path.basename(agentCli).toLowerCase();
  if (executableName === 'codex' || executableName === 'codex-cli') {
    return ['--version'];
  }
  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return ['--version'];
  }
  return ['--version'];
}

function formatCliTestMessage(agentCli: string, stdout: string, stderr: string): string {
  const version = (stdout.trim() || stderr.trim() || 'available').split('\n')[0];
  return `${agentCli} · ${version}`;
}

function buildSessionCaptureScript(
  provider: string,
  workspaceRoot: string,
  startedAtFilePath: string,
  outputFilePath: string,
  sessionFilePath: string
): string {
  const sessionWriter = [
    `if [ -n "$session_id" ]; then`,
    `node -e ${shellQuote([
      'const fs=require("fs");',
      'const file=process.argv[1];',
      'const sessionId=process.argv[2];',
      'const source=process.argv[3]||"unknown";',
      'fs.mkdirSync(require("path").dirname(file),{recursive:true});',
      'fs.writeFileSync(file, JSON.stringify({ sessionId, source }, null, 2));'
    ].join(''))} ${shellQuote(sessionFilePath)} "$session_id" "$session_source";`,
    `fi`
  ].join(' ');

  if (provider === 'antigravity') {
    return [
      `session_id=""`,
      `session_source=""`,
      `latest_log=$(find "$HOME/.gemini/antigravity-cli/log" -type f -name 'cli-*.log' -newer ${shellQuote(startedAtFilePath)} -print 2>/dev/null | sort | tail -1 || true)`,
      `if [ -n "$latest_log" ]; then session_id=$(grep -Eo 'conversation[ =:]+[0-9a-fA-F-]{36}|Created conversation [0-9a-fA-F-]{36}' "$latest_log" 2>/dev/null | grep -Eo '[0-9a-fA-F-]{36}' | tail -1 || true); session_source="antigravity-log"; fi`,
      `if [ -z "$session_id" ] && [ -f "$HOME/.gemini/antigravity-cli/cache/last_conversations.json" ]; then session_id=$(node -e ${shellQuote([
        'const fs=require("fs");',
        'const file=process.argv[1];',
        'const workspace=process.argv[2];',
        'try {',
        'const data=JSON.parse(fs.readFileSync(file,"utf8"));',
        'process.stdout.write(data[workspace] || "");',
        '} catch {}'
      ].join(''))} "$HOME/.gemini/antigravity-cli/cache/last_conversations.json" ${shellQuote(workspaceRoot)}); session_source="antigravity-cache"; fi`,
      // Fallback: if provider-specific extraction fails, capture the last UUID in the run output log.
      `if [ -z "$session_id" ]; then session_id=$(grep -Eo '[0-9a-fA-F-]{36}' ${shellQuote(outputFilePath)} 2>/dev/null | tail -1 || true); session_source="generic-output"; fi`,
      sessionWriter
    ].join('; ');
  }

  if (provider === 'codex') {
    return [
      `session_id=""`,
      `session_source=""`,
      `session_id=$(grep -Eo '"id"[[:space:]]*:[[:space:]]*"[0-9a-fA-F-]{36}"|session[_ -]?id[^0-9a-fA-F]*[0-9a-fA-F-]{36}' ${shellQuote(outputFilePath)} 2>/dev/null | grep -Eo '[0-9a-fA-F-]{36}' | tail -1 || true)`,
      `if [ -n "$session_id" ]; then session_source="codex-output"; fi`,
      `if [ -z "$session_id" ]; then latest_session=$(find "$HOME/.codex/sessions" -type f -name '*.jsonl' -newer ${shellQuote(startedAtFilePath)} -print 2>/dev/null | sort | tail -1 || true); if [ -n "$latest_session" ]; then session_id=$(node -e ${shellQuote([
        'const fs=require("fs");',
        'const file=process.argv[1];',
        'try {',
        'const first=fs.readFileSync(file,"utf8").split(/\\r?\\n/).find(Boolean)||"";',
        'const parsed=JSON.parse(first);',
        'process.stdout.write((parsed.payload && parsed.payload.id) || "");',
        '} catch {}'
      ].join(''))} "$latest_session"); session_source="codex-session-file"; fi; fi`,
      // Fallback: if codex-specific session extraction fails, capture the last UUID in output log.
      `if [ -z "$session_id" ]; then session_id=$(grep -Eo '[0-9a-fA-F-]{36}' ${shellQuote(outputFilePath)} 2>/dev/null | tail -1 || true); session_source="generic-output"; fi`,
      sessionWriter
    ].join('; ');
  }

  return [
    `session_id=$(grep -Eo '[0-9a-fA-F-]{36}' ${shellQuote(outputFilePath)} 2>/dev/null | tail -1 || true)`,
    `session_source="generic-output"`,
    sessionWriter
  ].join('; ');
}

function buildWorkspaceSnapshotScript(workspaceRoot: string, snapshotFilePath: string): string {
  return `node -e ${shellQuote([
    'const fs=require("fs");',
    'const path=require("path");',
    'const root=process.argv[1];',
    'const out=process.argv[2];',
    'const snapshot={};',
    'function shouldSkip(rel){',
    'if(rel===".git" || rel.startsWith(".git/")) return true;',
    'if(rel==="node_modules" || rel.startsWith("node_modules/")) return true;',
    'if(rel===".solopreneur") return false;',
    'if(rel.startsWith(".solopreneur/")) return rel !== ".solopreneur/roadmap.csv";',
    'return false;',
    '}',
    'function walk(dir){',
    'for(const entry of fs.readdirSync(dir,{withFileTypes:true})){',
    'const full=path.join(dir,entry.name);',
    'const rel=path.relative(root,full).replace(/\\\\/g,"/");',
    'if(shouldSkip(rel)) continue;',
    'if(entry.isDirectory()){ walk(full); continue; }',
    'if(!entry.isFile() || rel===".agent_status.json") continue;',
    'const stat=fs.statSync(full);',
    'snapshot[rel]={size:stat.size,mtimeMs:stat.mtimeMs};',
    '}',
    '}',
    'if(fs.existsSync(root)) walk(root);',
    'fs.mkdirSync(path.dirname(out),{recursive:true});',
    'fs.writeFileSync(out, JSON.stringify(snapshot));'
  ].join(''))} ${shellQuote(workspaceRoot)} ${shellQuote(snapshotFilePath)}`;
}

function buildWorkspaceDiffScript(workspaceRoot: string, snapshotFilePath: string, touchedFilesPath: string): string {
  return `node -e ${shellQuote([
    'const fs=require("fs");',
    'const path=require("path");',
    'const root=process.argv[1];',
    'const beforeFile=process.argv[2];',
    'const out=process.argv[3];',
    'let before={};',
    'try{ before=JSON.parse(fs.readFileSync(beforeFile,"utf8"))||{}; } catch {}',
    'const after={};',
    'function shouldSkip(rel){',
    'if(rel===".git" || rel.startsWith(".git/")) return true;',
    'if(rel==="node_modules" || rel.startsWith("node_modules/")) return true;',
    'if(rel===".solopreneur") return false;',
    'if(rel.startsWith(".solopreneur/")) return rel !== ".solopreneur/roadmap.csv";',
    'return false;',
    '}',
    'function walk(dir){',
    'for(const entry of fs.readdirSync(dir,{withFileTypes:true})){',
    'const full=path.join(dir,entry.name);',
    'const rel=path.relative(root,full).replace(/\\\\/g,"/");',
    'if(shouldSkip(rel)) continue;',
    'if(entry.isDirectory()){ walk(full); continue; }',
    'if(!entry.isFile() || rel===".agent_status.json") continue;',
    'const stat=fs.statSync(full);',
    'after[rel]={size:stat.size,mtimeMs:stat.mtimeMs};',
    '}',
    '}',
    'if(fs.existsSync(root)) walk(root);',
    'const changes=[];',
    'for(const [rel,meta] of Object.entries(after)){',
    'const prev=before[rel];',
    'if(!prev){ changes.push(`A ${rel}`); continue; }',
    'if(prev.size!==meta.size || Math.round(prev.mtimeMs)!==Math.round(meta.mtimeMs)){ changes.push(`M ${rel}`); }',
    '}',
    'for(const rel of Object.keys(before)){ if(!after[rel]) changes.push(`D ${rel}`); }',
    'changes.sort((a,b)=>a.localeCompare(b));',
    'fs.mkdirSync(path.dirname(out),{recursive:true});',
    'fs.writeFileSync(out, changes.join("\\n"));'
  ].join(''))} ${shellQuote(workspaceRoot)} ${shellQuote(snapshotFilePath)} ${shellQuote(touchedFilesPath)}`;
}

function getLegacyStepMemoryFilePath(workspaceRoot: string, nodeId: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'step-memory', `${nodeId}.md`);
}

function readStepHandoffSummary(filePath: string): string {
  const legacyFilePath = filePath.endsWith('.json') ? filePath.replace(/\.json$/, '.md') : '';
  const sourceFilePath = filePath && fs.existsSync(filePath)
    ? filePath
    : legacyFilePath && fs.existsSync(legacyFilePath)
      ? legacyFilePath
      : '';
  if (!sourceFilePath) {
    return '暂无交接总结。';
  }

  const content = fs.readFileSync(sourceFilePath, 'utf8').trim();
  if (content.startsWith('{')) {
    const memory = readStepMemoryObject(sourceFilePath);
    const entries = parseStepHandoffEntries(content);
    if (Object.keys(memory).length > 0) {
      return JSON.stringify({
        version: 1,
        format: String(memory.format || 'solopreneur.stepHandoff'),
        description: String(memory.description || 'Step memory used by SoloMap. completionCriteria defines when this roadmap step can be closed. entries keeps real Agent run handoffs.'),
        ...(
          normalizeStringList(memory.completionCriteria).length > 0
            ? { completionCriteria: normalizeStringList(memory.completionCriteria) }
            : {}
        ),
        ...(
          normalizeStringList(memory.lastCompletionEvidence).length > 0
            ? { lastCompletionEvidence: normalizeStringList(memory.lastCompletionEvidence) }
            : {}
        ),
        entries
      }, null, 2);
    }
  }
  return buildStepHandoffSummary(parseStepHandoffEntries(content)) || '暂无交接总结。';
}

function compactLine(value: string, maxLength: number): string {
  const compacted = (value || '').replace(/\s+/g, ' ').trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength)}...` : compacted;
}

function buildRunHandoffEntry(
  status: string,
  changedFilesSummary: string,
  outputTail: string,
  completionReason: string
): Record<string, unknown> {
  const changedFiles = changedFilesSummary
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .filter((line) => !/^No (workspace|git|project) /i.test(line));

  const usefulSignals = outputTail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !/^\s*(npm|node|git|>|\[|\{)/i.test(line) &&
      !line.includes('Refreshing run status')
    )
    .slice(-12)
    .join('\n');

  return {
    timestamp: new Date().toISOString(),
    status,
    changedFiles: changedFiles.length > 0 ? changedFiles : [],
    usefulSignals: usefulSignals ? compactLine(usefulSignals, 1200) : compactLine(outputTail, 1200) || '',
    completionReason: completionReason || (status === 'Completed' ? '该环节已完成。' : '该环节仍需后续推进。')
  };
}

interface RunDigest {
  schemaVersion: number;
  runId: string;
  executionLogId: number;
  projectPath: string;
  nodeId: string;
  runKind: string;
  agentCli: string;
  userIntent: string;
  outcome: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  changedFiles: string[];
  touchedFiles: string[];
  commandSignals: string[];
  verification: string[];
  failures: string[];
  reusableSignals: string[];
  tags: string[];
  handoff?: AgentHandoff;
  rawRefs?: {
    sqliteTable: string;
    executionLogId: number;
    digestPath?: string;
  };
}

interface AgentHandoff {
  summary: string;
  nextAgentBrief: string;
  recommendedFirstActions: string[];
  filesToInspectFirst: string[];
  commandsToRunNext: string[];
  openQuestions: string[];
  blockedBy: string[];
  assumptions: string[];
  decisionsMade: string[];
  doNotRepeat: string[];
  confidence: 'low' | 'medium' | 'high';
  riskLevel: 'low' | 'medium' | 'high';
}

interface ExecutionGraphRun {
  runId: string;
  executionLogId: number;
  nodeId: string;
  runKind: string;
  agentCli: string;
  status: string;
  finishedAt: string;
  changedFiles: string[];
  touchedFiles: string[];
  failures: string[];
  handoffSummary: string;
}

interface ExecutionGraph {
  schemaVersion: number;
  updatedAt: string;
  runCount: number;
  indexes: {
    byNode: Record<string, string[]>;
    byAgent: Record<string, string[]>;
    byFile: Record<string, string[]>;
    byStatus: Record<string, string[]>;
    byFailure: Record<string, string[]>;
    byCommand: Record<string, string[]>;
  };
  runs: ExecutionGraphRun[];
}

interface RunDigestInput {
  workspaceRoot: string;
  nodeId: string;
  runKind: string;
  agentCli: string;
  executionLogId: number;
  userMessage: string;
  resolvedCommand: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  changedFilesSummary: string;
  touchedFilesSummary: string;
  outputTail: string;
  completionReason: string;
  failureCode: string;
  failureReason: string;
}

interface ExecutionExperienceQuery {
  nodeId: string;
  runKind: string;
  contextText: string;
  supplementFiles?: string[];
}

function getRunDigestRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'run-digests');
}

function sanitizeRunDigestSegment(value: string): string {
  return (value || 'run')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'run';
}

function stripFileSummaryPrefix(line: string): string {
  return line.replace(/^[A-Z?]{1,2}\s+/, '').trim();
}

function parseFileSummaryLines(summary: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const line of (summary || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^No (workspace|git|project) /i.test(trimmed)) {
      continue;
    }
    const file = stripFileSummaryPrefix(trimmed);
    if (!file || seen.has(file)) {
      continue;
    }
    seen.add(file);
    files.push(file);
    if (files.length >= 24) {
      break;
    }
  }
  return files;
}

function extractLinesByPattern(value: string, pattern: RegExp, limit: number): string[] {
  const lines = (value || '')
    .split('\n')
    .map((line) => compactLine(line, 220))
    .filter((line) => line && pattern.test(line));
  return lines.slice(-limit);
}

function extractCommandSignals(resolvedCommand: string): string[] {
  const command = compactLine(resolvedCommand || '', 280);
  if (!command) {
    return [];
  }
  return [command];
}

function extractVerificationSignals(outputTail: string, resolvedCommand: string, status: string): string[] {
  const signals = [
    ...extractLinesByPattern(outputTail, /\b(test|tests|passed|passing|validated|validation|verify|verified|tsc|vitest|jest|playwright|pytest|npm run|npm test|node --test)\b/i, 6)
  ];
  if (/\b(test|check|lint|validate|verify|tsc|vitest|jest|playwright|pytest)\b/i.test(resolvedCommand || '')) {
    signals.unshift(`Command: ${compactLine(resolvedCommand, 220)}`);
  }
  if (status === 'Completed' && signals.length === 0) {
    signals.push('Run completed without explicit verification signal in captured tail.');
  }
  return signals.filter((entry, index, all) => all.indexOf(entry) === index).slice(0, 6);
}

function extractFailureSignals(outputTail: string, failureCode: string, failureReason: string, status: string): string[] {
  const signals = [
    failureCode ? `Failure category: ${compactLine(failureCode, 120)}` : '',
    failureReason ? `Failure reason: ${compactLine(failureReason, 260)}` : '',
    ...extractLinesByPattern(outputTail, /\b(error|failed|failure|exception|traceback|timeout|denied|invalid|cannot|could not)\b/i, 6)
  ].filter(Boolean);
  if (status === 'Failed' && signals.length === 0) {
    signals.push('Run failed without a captured failure line.');
  }
  return signals.filter((entry, index, all) => all.indexOf(entry) === index).slice(0, 8);
}

function extractReusableSignals(outputTail: string, completionReason: string, changedFiles: string[]): string[] {
  const signals = [
    completionReason ? `Completion: ${compactLine(completionReason, 260)}` : '',
    changedFiles.length > 0 ? `Changed files: ${changedFiles.slice(0, 6).join(', ')}` : '',
    ...extractLinesByPattern(outputTail, /\b(fix|fixed|implemented|added|updated|verified|validated|root cause|原因|修复|验证|完成|通过)\b/i, 4)
  ].filter(Boolean);
  return signals.filter((entry, index, all) => all.indexOf(entry) === index).slice(0, 6);
}

function uniqueCompactList(values: string[], limit: number, maxLength = 220): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = compactLine(value || '', maxLength);
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function extractHandoffActionLines(outputTail: string): string[] {
  return extractLinesByPattern(
    outputTail,
    /\b(next|todo|follow[- ]?up|remaining|继续|下一步|后续|待办|需要|建议|验证|检查)\b/i,
    8
  );
}

function extractDecisionSignals(outputTail: string, reusableSignals: string[]): string[] {
  return uniqueCompactList([
    ...reusableSignals.filter((signal) => /\b(decision|decided|选择|决定|采用|保留|改为)\b/i.test(signal)),
    ...extractLinesByPattern(outputTail, /\b(decision|decided|选择|决定|采用|保留|改为)\b/i, 6)
  ], 6);
}

function buildAgentHandoff(input: RunDigestInput, changedFiles: string[], touchedFiles: string[], verification: string[], failures: string[], reusableSignals: string[]): AgentHandoff {
  const status = String(input.status || '');
  const isFailed = status === 'Failed' || failures.length > 0;
  const summary = compactLine(input.completionReason || input.failureReason || (isFailed ? '上一轮未完成。' : '上一轮已结束。'), 500);
  const fileSignals = uniqueCompactList([...changedFiles, ...touchedFiles], 8);
  const actionLines = extractHandoffActionLines(input.outputTail);
  const firstActions = uniqueCompactList([
    isFailed && input.failureReason ? `先复核上一轮失败原因：${compactLine(input.failureReason, 180)}` : '',
    fileSignals.length > 0 ? `先阅读上一轮改动/触达文件：${fileSignals.slice(0, 4).join(', ')}` : '',
    ...actionLines,
    verification.length > 0 ? `复用或复跑验证信号：${verification.slice(0, 2).join(' / ')}` : ''
  ], 6);
  const commandsToRunNext = uniqueCompactList([
    ...verification
      .map((signal) => {
        const match = signal.match(/^Command:\s*(.+)$/i);
        return match ? match[1] : '';
      }),
    /\b(test|check|lint|validate|verify|tsc|vitest|jest|playwright|pytest|node --test)\b/i.test(input.resolvedCommand || '')
      ? input.resolvedCommand
      : ''
  ], 4, 300);
  const blockedBy = isFailed
    ? uniqueCompactList([
      input.failureCode ? `Failure category: ${input.failureCode}` : '',
      input.failureReason || '',
      ...failures
    ], 6)
    : [];
  const nextAgentBrief = compactLine([
    summary,
    fileSignals.length > 0 ? `优先查看 ${fileSignals.slice(0, 4).join(', ')}。` : '',
    blockedBy.length > 0 ? `阻塞/风险：${blockedBy.slice(0, 2).join(' / ')}。` : '',
    commandsToRunNext.length > 0 ? `建议验证：${commandsToRunNext.slice(0, 2).join(' / ')}。` : ''
  ].filter(Boolean).join(' '), 800);
  return {
    summary,
    nextAgentBrief,
    recommendedFirstActions: firstActions,
    filesToInspectFirst: fileSignals,
    commandsToRunNext,
    openQuestions: isFailed ? uniqueCompactList(failures, 4) : [],
    blockedBy,
    assumptions: uniqueCompactList(
      status === 'Completed' && verification.length === 0
        ? ['上一轮记录显示完成，但 captured tail 中没有明确验证信号；接手时应先补最窄验证。']
        : [],
      4
    ),
    decisionsMade: extractDecisionSignals(input.outputTail, reusableSignals),
    doNotRepeat: isFailed
      ? uniqueCompactList([
        input.failureReason ? `不要只重复上一轮失败路径：${input.failureReason}` : '',
        failures[0] ? `先处理风险信号再继续：${failures[0]}` : ''
      ], 4)
      : [],
    confidence: isFailed ? 'low' : verification.length > 0 ? 'high' : 'medium',
    riskLevel: isFailed ? 'high' : verification.length > 0 ? 'low' : 'medium'
  };
}

function tokenizeExperienceText(value: string): Set<string> {
  const tokens = (value || '')
    .toLowerCase()
    .split(/[^a-z0-9_\-/.]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 300);
  return new Set(tokens);
}

function buildRunDigest(input: RunDigestInput): RunDigest {
  const changedFiles = parseFileSummaryLines(input.changedFilesSummary);
  const touchedFiles = parseFileSummaryLines(input.touchedFilesSummary);
  const commandSignals = extractCommandSignals(input.resolvedCommand);
  const verification = extractVerificationSignals(input.outputTail, input.resolvedCommand, input.status);
  const failures = extractFailureSignals(input.outputTail, input.failureCode, input.failureReason, input.status);
  const reusableSignals = extractReusableSignals(input.outputTail, input.completionReason, changedFiles);
  const runId = `${sanitizeRunDigestSegment(input.nodeId)}-${input.executionLogId || Date.parse(input.finishedAt) || Date.now()}`;
  const contextTokens = Array.from(tokenizeExperienceText([
    input.nodeId,
    input.runKind,
    input.userMessage,
    changedFiles.join(' '),
    touchedFiles.join(' '),
    input.completionReason,
    input.failureReason
  ].join('\n'))).slice(0, 24);
  return {
    schemaVersion: 2,
    runId,
    executionLogId: Number(input.executionLogId || 0),
    projectPath: input.workspaceRoot,
    nodeId: String(input.nodeId || ''),
    runKind: String(input.runKind || 'step'),
    agentCli: String(input.agentCli || 'unknown'),
    userIntent: compactLine(input.userMessage || '', 500),
    outcome: compactLine(input.completionReason || input.failureReason || '', 500),
    status: String(input.status || ''),
    startedAt: String(input.startedAt || ''),
    finishedAt: String(input.finishedAt || new Date().toISOString()),
    durationMs: Number(input.durationMs || 0),
    changedFiles,
    touchedFiles,
    commandSignals,
    verification,
    failures,
    reusableSignals,
    tags: contextTokens,
    handoff: buildAgentHandoff(
      input,
      changedFiles,
      touchedFiles,
      verification,
      failures,
      reusableSignals
    ),
    rawRefs: {
      sqliteTable: 'execution_logs',
      executionLogId: Number(input.executionLogId || 0)
    }
  };
}

function writeRunDigest(workspaceRoot: string, digest: RunDigest): string {
  const digestRoot = getRunDigestRoot(workspaceRoot);
  fs.mkdirSync(digestRoot, { recursive: true });
  const digestPath = path.join(digestRoot, `${sanitizeRunDigestSegment(digest.runId)}.json`);
  const nextDigest: RunDigest = {
    ...digest,
    rawRefs: {
      ...(digest.rawRefs || { sqliteTable: 'execution_logs', executionLogId: Number(digest.executionLogId || 0) }),
      digestPath: toProjectRelativeRuntimePath(workspaceRoot, digestPath)
    }
  };
  fs.writeFileSync(digestPath, JSON.stringify(nextDigest, null, 2), 'utf8');
  try {
    writeExecutionGraph(workspaceRoot);
  } catch (error) {
    console.warn('Failed to update SoloMap execution graph:', error);
  }
  return digestPath;
}

function readRunDigests(workspaceRoot: string): RunDigest[] {
  const digestRoot = getRunDigestRoot(workspaceRoot);
  if (!fs.existsSync(digestRoot)) {
    return [];
  }
  return fs.readdirSync(digestRoot)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(digestRoot, file), 'utf8'));
        return parsed && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2) ? parsed as RunDigest : null;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is RunDigest => Boolean(entry))
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')))
    .slice(0, 120);
}

function getExecutionGraphPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'execution-graph.json');
}

function addExecutionGraphIndex(index: Record<string, string[]>, key: string, runId: string): void {
  const normalizedKey = compactLine(key || '', 180);
  if (!normalizedKey) {
    return;
  }
  if (!index[normalizedKey]) {
    index[normalizedKey] = [];
  }
  if (!index[normalizedKey].includes(runId)) {
    index[normalizedKey].push(runId);
  }
}

function buildExecutionGraph(workspaceRoot: string): ExecutionGraph {
  const digests = readRunDigests(workspaceRoot);
  const graph: ExecutionGraph = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    runCount: digests.length,
    indexes: {
      byNode: {},
      byAgent: {},
      byFile: {},
      byStatus: {},
      byFailure: {},
      byCommand: {}
    },
    runs: []
  };
  for (const digest of digests) {
    const runId = String(digest.runId || '');
    if (!runId) {
      continue;
    }
    graph.runs.push({
      runId,
      executionLogId: Number(digest.executionLogId || 0),
      nodeId: String(digest.nodeId || ''),
      runKind: String(digest.runKind || ''),
      agentCli: String(digest.agentCli || ''),
      status: String(digest.status || ''),
      finishedAt: String(digest.finishedAt || ''),
      changedFiles: (digest.changedFiles || []).slice(0, 24),
      touchedFiles: (digest.touchedFiles || []).slice(0, 24),
      failures: (digest.failures || []).slice(0, 8),
      handoffSummary: compactLine(digest.handoff?.nextAgentBrief || digest.outcome || '', 800)
    });
    addExecutionGraphIndex(graph.indexes.byNode, digest.nodeId, runId);
    addExecutionGraphIndex(graph.indexes.byAgent, digest.agentCli, runId);
    addExecutionGraphIndex(graph.indexes.byStatus, digest.status, runId);
    for (const file of [...(digest.changedFiles || []), ...(digest.touchedFiles || [])]) {
      addExecutionGraphIndex(graph.indexes.byFile, file, runId);
    }
    for (const failure of digest.failures || []) {
      addExecutionGraphIndex(graph.indexes.byFailure, failure, runId);
    }
    for (const command of digest.commandSignals || []) {
      addExecutionGraphIndex(graph.indexes.byCommand, command, runId);
    }
  }
  return graph;
}

function writeExecutionGraph(workspaceRoot: string): string {
  const graphPath = getExecutionGraphPath(workspaceRoot);
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  fs.writeFileSync(graphPath, JSON.stringify(buildExecutionGraph(workspaceRoot), null, 2), 'utf8');
  return graphPath;
}

function scoreRunDigest(digest: RunDigest, query: ExecutionExperienceQuery): { score: number; reasons: string[] } {
  const context = query.contextText || '';
  const contextTokens = tokenizeExperienceText([
    context,
    ...(query.supplementFiles || [])
  ].join('\n'));
  let score = 0;
  const reasons: string[] = [];
  if (digest.nodeId && digest.nodeId === query.nodeId) {
    score += 8;
    reasons.push('同一任务入口');
  }
  if (digest.runKind && digest.runKind === query.runKind) {
    score += 2;
    reasons.push('同类运行');
  }
  const digestFiles = [...(digest.changedFiles || []), ...(digest.touchedFiles || [])];
  const matchedFiles = digestFiles.filter((file) => file && context.includes(file)).slice(0, 3);
  if (matchedFiles.length > 0) {
    score += matchedFiles.length * 5;
    reasons.push(`文件相关：${matchedFiles.join(', ')}`);
  }
  const matchedTags = (digest.tags || []).filter((tag) => contextTokens.has(tag)).slice(0, 6);
  if (matchedTags.length > 0) {
    score += matchedTags.length;
    reasons.push(`语义相关：${matchedTags.slice(0, 3).join(', ')}`);
  }
  return { score, reasons };
}

function buildExecutionExperiencePrompt(workspaceRoot: string, query: ExecutionExperienceQuery): string {
  const matches = readRunDigests(workspaceRoot)
    .map((digest) => ({ digest, ...scoreRunDigest(digest, query) }))
    .filter((entry) => entry.score >= 3)
    .sort((a, b) => b.score - a.score || String(b.digest.finishedAt || '').localeCompare(String(a.digest.finishedAt || '')))
    .slice(0, 3);
  if (matches.length === 0) {
    return '';
  }
  const blocks = matches.map((entry, index) => {
    const digest = entry.digest;
    const fileSignals = [...(digest.changedFiles || []), ...(digest.touchedFiles || [])]
      .filter((file, fileIndex, all) => file && all.indexOf(file) === fileIndex)
      .slice(0, 6);
    const handoff = digest.handoff;
    return [
      `${index + 1}. 命中原因：${entry.reasons.join('；') || '近期相关执行'}`,
      digest.userIntent ? `   - 上次目标：${digest.userIntent}` : '',
      digest.outcome ? `   - 上次结果：${digest.outcome}` : `   - 上次状态：${digest.status}`,
      handoff?.nextAgentBrief ? `   - 下一位 Agent 交接：${handoff.nextAgentBrief}` : '',
      fileSignals.length > 0 ? `   - 相关文件：${fileSignals.join(', ')}` : '',
      handoff?.filesToInspectFirst?.length ? `   - 建议先看：${handoff.filesToInspectFirst.slice(0, 5).join(', ')}` : '',
      handoff?.recommendedFirstActions?.length ? `   - 建议动作：${handoff.recommendedFirstActions.slice(0, 3).join(' / ')}` : '',
      handoff?.commandsToRunNext?.length ? `   - 建议验证：${handoff.commandsToRunNext.slice(0, 2).join(' / ')}` : '',
      handoff?.doNotRepeat?.length ? `   - 避免重复：${handoff.doNotRepeat.slice(0, 2).join(' / ')}` : '',
      (digest.reusableSignals || []).length > 0 ? `   - 可复用信号：${(digest.reusableSignals || []).slice(0, 3).join(' / ')}` : '',
      (digest.verification || []).length > 0 ? `   - 验证信号：${(digest.verification || []).slice(0, 2).join(' / ')}` : '',
      (digest.failures || []).length > 0 ? `   - 风险信号：${(digest.failures || []).slice(0, 2).join(' / ')}` : ''
    ].filter(Boolean).join('\n');
  });
  return [
    'SoloMap 相关执行经验（自动召回，最多 3 条）：',
    '这些是历史结构化摘要，不是本轮事实；只能帮助减少重复探索，不能覆盖用户本轮要求、当前代码、测试或日志。',
    ...blocks
  ].join('\n');
}

function buildCrossAgentHandoffInstructions(workspaceRoot: string, nodeId: string, runKind: string): string {
  const relativeTool = 'resources/tools/solomap-experience.cjs';
  const skillPath = 'resources/skills/solomap-cross-agent-handoff/SKILL.md';
  const nodeFilter = nodeId ? ` --node ${JSON.stringify(nodeId)}` : '';
  return [
    'SoloMap 跨 Agent 协作入口：',
    `- 如果本轮是在接续、复核、修复失败运行、跨不同 Agent CLI 协作，或你不确定上一轮到底改了什么，先读取 ${skillPath}，再运行：`,
    `  node ${relativeTool} handoff --project ${JSON.stringify(workspaceRoot)}${nodeFilter} --limit 3`,
    `- 需要进一步查看 SQLite 中的结构化历史信号时，用同一工具的 \`summary\`、\`history\`、\`failures\`、\`latest-changes\` 或 \`search\` 子命令；当前运行类型：${runKind || 'unknown'}。`,
    '- 这些历史信号只能降低重复探索，不能覆盖本轮用户最新要求、当前文件、测试和命令输出。',
    '- 不要把原始 execution log 全文复制进最终回复；只提炼对用户有帮助的结论、改动、验证和风险。'
  ].join('\n');
}

function normalizeStepHandoffEntry(entry: any): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const changedFiles = Array.isArray(entry.changedFiles)
    ? entry.changedFiles.map((line: unknown) => String(line || '').trim()).filter(Boolean).slice(0, 12)
    : String(entry.changedFiles || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 12);
  return {
    timestamp: String(entry.timestamp || new Date().toISOString()),
    status: String(entry.status || 'In Progress'),
    changedFiles,
    usefulSignals: compactLine(String(entry.usefulSignals || ''), 1200),
    completionReason: compactLine(String(entry.completionReason || ''), 600)
  };
}

function parseLegacyMarkdownHandoffEntry(entry: string): Record<string, unknown> | null {
  const cleaned = entry.replace(/\n# 环节交接总结[\s\S]*$/g, '').trim();
  const header = cleaned.match(/^##\s+([^\n]+?)\s+·\s+([^\n]+)\n/);
  if (!header) {
    return null;
  }
  const section = (title: string) => {
    const match = cleaned.match(new RegExp(`### ${title}\\n([\\s\\S]*?)(?=\\n\\n### |$)`));
    return match ? match[1].trim() : '';
  };
  const changedFiles = section('本轮文件变化')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^No (workspace|git|project) /i.test(line))
    .slice(0, 12);
  return {
    timestamp: header[1].trim(),
    status: header[2].trim(),
    changedFiles,
    usefulSignals: compactLine(section('本轮关键信号'), 1200),
    completionReason: compactLine(section('完成判断'), 600)
  };
}

function handoffEntryDedupeKey(entry: Record<string, unknown>): string {
  return JSON.stringify({
    status: entry.status || '',
    changedFiles: entry.changedFiles || [],
    usefulSignals: entry.usefulSignals || '',
    completionReason: entry.completionReason || ''
  });
}

function parseStepHandoffEntries(content: string): Record<string, unknown>[] {
  const body = (content || '').trim();
  if (!body || body === '暂无交接总结。') {
    return [];
  }

  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const parsed = JSON.parse(body);
      const rawEntries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
      const seen = new Set<string>();
      const entries: Record<string, unknown>[] = [];
      for (const rawEntry of rawEntries) {
        const entry = normalizeStepHandoffEntry(rawEntry);
        if (!entry) continue;
        const key = handoffEntryDedupeKey(entry);
        if (!seen.has(key)) {
          seen.add(key);
          entries.push(entry);
        }
      }
      return entries.slice(0, 10);
    } catch {
      return [];
    }
  }

  const normalized = body
    .replace(/^# 环节交接总结[\s\S]*?(?=\n##\s+\d{4}-\d{2}-\d{2}T|\n##\s+\d{4}-\d{2}-\d{2}\s|$)/, '')
    .trim();
  if (!normalized) {
    return [];
  }

  const rawEntries = normalized
    .split(/\n\n---\n\n|(?=\n##\s+\d{4}-\d{2}-\d{2}(?:T|\s))/)
    .map((entry) => entry.trim())
    .filter((entry) => /^##\s+\d{4}-\d{2}-\d{2}(?:T|\s)/.test(entry));

  const seen = new Set<string>();
  const entries: Record<string, unknown>[] = [];
  for (const entry of rawEntries) {
    const parsedEntry = parseLegacyMarkdownHandoffEntry(entry);
    if (!parsedEntry) continue;
    const key = handoffEntryDedupeKey(parsedEntry);
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(parsedEntry);
    }
  }
  return entries;
}

function buildStepHandoffSummary(entries: Record<string, unknown>[]): string {
  const seen = new Set<string>();
  const validEntries = entries
    .map((entry) => normalizeStepHandoffEntry(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => {
      const key = handoffEntryDedupeKey(entry);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 10);
  if (validEntries.length === 0) {
    return '';
  }
  return JSON.stringify({
    version: 1,
    format: 'solopreneur.stepHandoff',
    description: 'Only real Agent run handoff entries are kept here. Newest first, max 10.',
    entries: validEntries
  }, null, 2);
}

function updateStepHandoffSummary(filePath: string, entry: Record<string, unknown>): string {
  const legacyFilePath = filePath.endsWith('.json') ? filePath.replace(/\.json$/, '.md') : '';
  const existing = filePath && fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : legacyFilePath && fs.existsSync(legacyFilePath)
      ? fs.readFileSync(legacyFilePath, 'utf8')
      : '';
  const existingObject = readStepMemoryObject(filePath);
  const normalizedEntry = normalizeStepHandoffEntry(entry);
  const entries = normalizedEntry ? [normalizedEntry, ...parseStepHandoffEntries(existing)] : parseStepHandoffEntries(existing);
  const completionCriteria = normalizeStringList(existingObject.completionCriteria);
  const existingCompletionEvidence = normalizeStringList(existingObject.lastCompletionEvidence);
  const entryEvidence = normalizedEntry
    ? [
      ...normalizeStringList(normalizedEntry.changedFiles),
      String(normalizedEntry.completionReason || '').trim()
    ].filter(Boolean)
    : [];
  const lastCompletionEvidence = entryEvidence.length > 0
    ? [...entryEvidence, ...existingCompletionEvidence].filter((item, index, all) => all.indexOf(item) === index).slice(0, 8)
    : existingCompletionEvidence;
  const nextContent = JSON.stringify({
    version: 1,
    format: 'solopreneur.stepHandoff',
    description: 'Step memory used by SoloMap. completionCriteria defines when this roadmap step can be closed. entries keeps real Agent run handoffs.',
    ...(completionCriteria.length > 0 ? { completionCriteria } : {}),
    ...(lastCompletionEvidence.length > 0 ? { lastCompletionEvidence } : {}),
    entries: parseStepHandoffEntries(buildStepHandoffSummary(entries))
  }, null, 2).slice(0, 12000);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextContent, 'utf8');
  return nextContent;
}

function toProjectRelativeRuntimePath(workspaceRoot: string, targetPath: string): string {
  const relativePath = path.relative(workspaceRoot, targetPath).replace(/\\/g, '/');
  return relativePath && !relativePath.startsWith('..') ? relativePath : targetPath;
}

function normalizeSolomapGlobalPath(workspaceRoot: string, globalDataPath = ''): string {
  const trimmed = String(globalDataPath || '').trim();
  if (trimmed) {
    return trimmed.endsWith('.solomap-global') ? trimmed : path.join(trimmed, '.solomap-global');
  }
  const baseRoot = workspaceRoot || process.cwd();
  return path.join(path.dirname(baseRoot), '.solomap-global');
}

function getSolomapMemoryRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'memory');
}

function getSolomapSkillsRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'skills');
}

function getSolomapMcpRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'mcp');
}

function getSolomapEnhancementsRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'enhancements');
}

function getSolomapEnhancementRuntimeRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(getSolomapEnhancementsRoot(workspaceRoot, globalDataPath), 'runtime');
}

function getProjectMemoryFilePath(workspaceRoot: string, globalDataPath = ''): string {
  const projectName = path.basename(workspaceRoot || 'project');
  const projectSlug = sanitizeAttachmentScope(projectName.toLowerCase()) || 'project';
  return path.join(getSolomapMemoryRoot(workspaceRoot, globalDataPath), 'projects', `${projectSlug}.md`);
}

function writeFileIfMissing(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function writeSolomapMemoryExamples(memoryRoot: string, learningCandidatesDir: string): void {
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

function ensureSolomapMemoryStore(workspaceRoot: string, globalDataPath = ''): { globalRoot: string; memoryRoot: string; projectMemoryFile: string } {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const memoryRoot = path.join(globalRoot, 'memory');
  const projectMemoryFile = getProjectMemoryFilePath(workspaceRoot, globalDataPath);
  const learningCandidatesDir = path.join(globalRoot, 'learning', 'candidates');
  const learningApprovedDir = path.join(globalRoot, 'learning', 'approved');
  const learningRejectedDir = path.join(globalRoot, 'learning', 'rejected');
  const metricsDir = path.join(globalRoot, 'metrics');
  fs.mkdirSync(learningCandidatesDir, { recursive: true });
  fs.mkdirSync(learningApprovedDir, { recursive: true });
  fs.mkdirSync(learningRejectedDir, { recursive: true });
  fs.mkdirSync(metricsDir, { recursive: true });
  ['projects', 'patterns', 'decisions', 'domains', 'inbox', 'active'].forEach((dir) => {
    fs.mkdirSync(path.join(memoryRoot, dir), { recursive: true });
  });
  const memoryReadmePath = path.join(memoryRoot, 'README.md');
  const profilePath = path.join(memoryRoot, 'profile.md');
  const operatingRulesPath = path.join(memoryRoot, 'operating-rules.md');
  if (!fs.existsSync(memoryReadmePath)) {
    fs.writeFileSync(memoryReadmePath, [
      '# SoloMap Memory',
      '',
      'This directory stores reusable SoloMap experience across projects.',
      '',
      '- `profile.md`: stable user preferences and collaboration style.',
      '- `operating-rules.md`: reusable execution rules that apply across projects.',
      '- `projects/`: one memory file per project.',
      '- `patterns/`: reusable implementation, debugging, and delivery patterns.',
      '- `decisions/`: confirmed cross-project decisions and their rationale.',
      '- `domains/`: domain knowledge that can help future projects.',
      '- `inbox/`: unverified observations and learning candidates before promotion.',
      '- `active/`: current session handoff and temporary working context.',
      '',
      'Agents should treat memory as context, not as stronger evidence than current files, tests, logs, or the user request.',
      ''
    ].join('\n'), 'utf8');
  }
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, '# Profile\n\nStable user preferences and collaboration style promoted by SoloMap.\n', 'utf8');
  }
  if (!fs.existsSync(operatingRulesPath)) {
    fs.writeFileSync(operatingRulesPath, '# Operating Rules\n\nReusable execution rules promoted by SoloMap.\n', 'utf8');
  }
  if (!fs.existsSync(projectMemoryFile)) {
    fs.writeFileSync(projectMemoryFile, [
      `# ${path.basename(workspaceRoot || 'Project')}`,
      '',
      'Stable project facts, decisions, and handoff context promoted by SoloMap.',
      ''
    ].join('\n'), 'utf8');
  }
  writeFileIfMissing(path.join(metricsDir, 'execution-speed.csv'), 'project,node_id,stage,status,duration_ms,completed_at\n');
  writeFileIfMissing(path.join(metricsDir, 'reuse-rate.csv'), 'project,node_id,reusable_signals,learning_candidates,recorded_at\n');
  writeFileIfMissing(path.join(metricsDir, 'priority-accuracy.csv'), 'project,priority,next_action,outcome,recorded_at\n');
  writeFileIfMissing(path.join(metricsDir, 'monthly-summary.md'), '# Monthly Learning Summary\n\nSoloMap uses this file to collect low-frequency cross-project learning signals.\n');
  writeSolomapMemoryExamples(memoryRoot, learningCandidatesDir);
  return { globalRoot, memoryRoot, projectMemoryFile };
}

function solomapCsvEscape(value: string | number): string {
  const raw = String(value ?? '');
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function countMarkdownFiles(dirPath: string): number {
  try {
    return fs.readdirSync(dirPath).filter((name) => name.endsWith('.md') && name !== '_example.md').length;
  } catch {
    return 0;
  }
}

function appendCsvRecord(filePath: string, header: string, values: Array<string | number>): void {
  writeFileIfMissing(filePath, `${header}\n`);
  fs.appendFileSync(filePath, `${values.map(solomapCsvEscape).join(',')}\n`, 'utf8');
}

function summarizeLearningEvidence(changedFilesSummary: string, touchedFilesSummary: string, outputTail: string): string {
  return [
    changedFilesSummary ? `- Workspace changes: ${changedFilesSummary.split('\n').filter(Boolean).slice(0, 6).join('; ')}` : '',
    touchedFilesSummary ? `- Touched files: ${touchedFilesSummary.split('\n').filter(Boolean).slice(0, 6).join('; ')}` : '',
    outputTail ? `- Agent output tail was captured in this run.` : ''
  ].filter(Boolean).join('\n') || '- This run completed and updated the SoloMap execution history.';
}

function recordSolomapLearningCycle(
  workspaceRoot: string,
  globalDataPath: string,
  node: RoadmapNode | null,
  nextStatus: string,
  changedFilesSummary: string,
  touchedFilesSummary: string,
  outputTail: string,
  runDurationMs: number,
  finishedAt: string
): void {
  if (!workspaceRoot || !node || !node.id) {
    return;
  }
  const { globalRoot } = ensureSolomapMemoryStore(workspaceRoot, globalDataPath);
  const projectName = path.basename(workspaceRoot);
  const learningCandidatesDir = path.join(globalRoot, 'learning', 'candidates');
  const metricsDir = path.join(globalRoot, 'metrics');
  const reusableSignals = (() => {
    try {
      return fs.existsSync(path.join(workspaceRoot, '.solopreneur', 'step-memory'))
        ? fs.readdirSync(path.join(workspaceRoot, '.solopreneur', 'step-memory')).length
        : 0;
    } catch {
      return 0;
    }
  })();
  appendCsvRecord(
    path.join(metricsDir, 'execution-speed.csv'),
    'project,node_id,stage,status,duration_ms,completed_at',
    [projectName, node.id, node.stage || '', nextStatus, runDurationMs, finishedAt]
  );
  appendCsvRecord(
    path.join(metricsDir, 'reuse-rate.csv'),
    'project,node_id,reusable_signals,learning_candidates,recorded_at',
    [projectName, node.id, reusableSignals, countMarkdownFiles(learningCandidatesDir), finishedAt]
  );
  appendCsvRecord(
    path.join(metricsDir, 'priority-accuracy.csv'),
    'project,priority,next_action,outcome,recorded_at',
    [projectName, '', node.title || '', nextStatus, finishedAt]
  );

  if (nextStatus !== 'Completed' && nextStatus !== 'In Progress') {
    return;
  }
  const slug = sanitizeAttachmentScope(`${projectName}-${node.id}-${Date.parse(finishedAt) || Date.now()}`);
  const candidatePath = path.join(learningCandidatesDir, `${slug}.md`);
  writeFileIfMissing(candidatePath, [
    `# Learning Candidate: ${node.title || node.id}`,
    '',
    '## Candidate Lesson',
    `- A ${node.stage || 'roadmap'} step produced reusable execution evidence. Review whether this should become a pattern, decision, domain note, or project memory.`,
    '',
    '## Source Task',
    `- Project: ${projectName}`,
    `- Step: ${node.title || node.id}`,
    `- Status: ${nextStatus}`,
    `- Completed at: ${finishedAt}`,
    '',
    '## Evidence',
    summarizeLearningEvidence(changedFilesSummary, touchedFilesSummary, outputTail),
    '',
    '## Applies When',
    `- Future projects have a similar ${node.stage || 'roadmap'} step or need the same delivery pattern.`,
    '',
    '## Promotion Target',
    '- memory/patterns | memory/decisions | memory/domains | memory/projects',
    ''
  ].join('\n'));
}

function buildSolomapLearningContext(workspaceRoot: string, globalDataPath = ''): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const learningCandidatesDir = path.join(globalRoot, 'learning', 'candidates');
  const metricsDir = path.join(globalRoot, 'metrics');
  const candidateCount = countMarkdownFiles(learningCandidatesDir);
  const readTail = (fileName: string) => {
    const filePath = path.join(metricsDir, fileName);
    try {
      return fs.readFileSync(filePath, 'utf8').trim().split('\n').slice(-4).join('\n');
    } catch {
      return '';
    }
  };
  const executionTail = readTail('execution-speed.csv');
  const reuseTail = readTail('reuse-rate.csv');
  return [
    'SoloMap 跨项目学习信号：',
    `- 待审核学习候选：${candidateCount}`,
    executionTail ? `- 最近执行速度记录：\n${executionTail}` : '',
    reuseTail ? `- 最近复用记录：\n${reuseTail}` : '',
    '- 如果当前环节属于 Improve / 复盘 / 调整路线图，应优先参考这些信号来提出下一轮路线图调整。'
  ].filter(Boolean).join('\n');
}

function getSolomapSkillRegistryPath(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(getSolomapSkillsRoot(workspaceRoot, globalDataPath), 'registry.json');
}

function ensureBuiltinSolomapSkills(skillsRoot: string, registryPath: string): void {
  const installedAt = 'builtin';
  let registry: SolomapSkillRegistry = { version: 1, updatedAt: '', skills: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry = {
      version: Number(parsed.version || 1),
      updatedAt: String(parsed.updatedAt || ''),
      skills: Array.isArray(parsed.skills) ? parsed.skills : []
    };
  } catch {
    registry = { version: 1, updatedAt: '', skills: [] };
  }
  const builtinEntries = BUILTIN_SOLOMAP_SKILLS.map((builtinSkill) => {
    const skillRoot = path.join(skillsRoot, 'installed', builtinSkill.id);
    const packageRoot = path.join(skillRoot, 'package');
    const entryPath = path.join(packageRoot, 'SKILL.md');
    const skillJsonPath = path.join(skillRoot, 'solomap.skill.json');
    const sourceLockPath = path.join(skillRoot, 'source.lock.json');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(entryPath, builtinSkill.skillMd, 'utf8');
    const skillJson = {
      id: builtinSkill.id,
      title: builtinSkill.title,
      description: builtinSkill.description,
      entry: `installed/${builtinSkill.id}/package/SKILL.md`,
      packagePath: `installed/${builtinSkill.id}/package`,
      status: 'installed',
      defaultCandidate: builtinSkill.defaultCandidate !== false,
      source: { type: 'builtin', owner: 'solomap' },
      activation: {
        keywords: builtinSkill.keywords,
        useWhen: builtinSkill.useWhen,
        doNotUseWhen: builtinSkill.doNotUseWhen
      },
      risk: {
        hasScripts: false,
        hasExecutables: false,
        usesNetwork: false,
        writesFiles: 'guidance-only',
        requiresUserApprovalToRunScripts: true
      },
      installedAt,
      updatedAt: installedAt
    };
    fs.writeFileSync(skillJsonPath, JSON.stringify(skillJson, null, 2) + '\n', 'utf8');
    fs.writeFileSync(sourceLockPath, JSON.stringify({
      source: 'solomap-builtin',
      skillId: builtinSkill.id,
      installedAt,
      version: 1
    }, null, 2) + '\n', 'utf8');
    return {
      id: builtinSkill.id,
      title: skillJson.title,
      description: skillJson.description,
      entry: skillJson.entry,
      packagePath: skillJson.packagePath,
      status: 'installed',
      defaultCandidate: builtinSkill.defaultCandidate !== false,
      source: skillJson.source,
      activation: skillJson.activation,
      risk: skillJson.risk,
      installedAt,
      updatedAt: installedAt
    };
  });
  const builtinIds = new Set(BUILTIN_SOLOMAP_SKILLS.map((skill) => skill.id));
  const skills = registry.skills
    .filter((skill) => !builtinIds.has(skill.id))
    .concat(builtinEntries)
    .sort((a, b) => {
      if (a.defaultCandidate !== b.defaultCandidate) {
        return a.defaultCandidate ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });
  fs.writeFileSync(registryPath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), skills }, null, 2) + '\n', 'utf8');
}

function ensureSolomapSkillStore(workspaceRoot: string, globalDataPath = ''): { skillsRoot: string; installedRoot: string; runsRoot: string; registryPath: string } {
  const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
  const installedRoot = path.join(skillsRoot, 'installed');
  const runsRoot = path.join(skillsRoot, 'runs');
  const registryPath = path.join(skillsRoot, 'registry.json');
  fs.mkdirSync(installedRoot, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  if (!fs.existsSync(registryPath)) {
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), skills: [] }, null, 2), 'utf8');
  }
  ensureBuiltinSolomapSkills(skillsRoot, registryPath);
  return { skillsRoot, installedRoot, runsRoot, registryPath };
}

function readSolomapSkillRegistry(workspaceRoot: string, globalDataPath = ''): SolomapSkillRegistry {
  try {
    ensureSolomapSkillStore(workspaceRoot, globalDataPath);
  } catch {
    return { version: 1, updatedAt: '', skills: [] };
  }
  const registryPath = getSolomapSkillRegistryPath(workspaceRoot, globalDataPath);
  if (!fs.existsSync(registryPath)) {
    return { version: 1, updatedAt: '', skills: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return {
      version: Number(parsed.version || 1),
      updatedAt: String(parsed.updatedAt || ''),
      skills: Array.isArray(parsed.skills) ? parsed.skills : []
    };
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), skills: [] };
  }
}

function writeSolomapSkillRegistry(workspaceRoot: string, globalDataPath: string, registry: SolomapSkillRegistry): void {
  const { registryPath } = ensureSolomapSkillStore(workspaceRoot, globalDataPath);
  const normalized: SolomapSkillRegistry = {
    version: 1,
    updatedAt: new Date().toISOString(),
    skills: Array.isArray(registry.skills) ? registry.skills : []
  };
  fs.writeFileSync(registryPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
}

function normalizeSkillKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 30);
}

function scoreSolomapSkill(skill: SolomapSkillRegistryEntry, contextText: string): { score: number; reasons: string[] } {
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

function selectSolomapSkillCandidates(workspaceRoot: string, globalDataPath: string, contextText: string, limit = 6): Array<{ skill: SolomapSkillRegistryEntry; reasons: string[] }> {
  const registry = readSolomapSkillRegistry(workspaceRoot, globalDataPath);
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

function buildSolomapSkillCandidateInstructions(workspaceRoot: string, globalDataPath: string, contextText: string): string {
  const candidates = selectSolomapSkillCandidates(workspaceRoot, globalDataPath, contextText, 6);
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
    '技能使用协议：这些只是候选，不是强制项。开始执行前快速判断是否适用，只读取真正相关的 SKILL.md；如果跳过候选，用一句话说明原因。不要自行安装新 skill。最终输出中简短列出本轮实际使用的 skill。'
  ].join('\n');
}

function buildSkillInstallPrompt(skillInput: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
  return [
    '你正在为 SoloMap 安装一个跨 Agent 通用 skill package。',
    '这是受控安装任务；只能按 SoloMap 指定目录和 schema 落盘，不要安装到各 Agent 自己的全局技能目录作为正式结果。',
    '',
    `用户提供的 skill 来源：${skillInput}`,
    `项目目录：${workspaceRoot}`,
    `SoloMap 全局目录：${globalRoot}`,
    `SoloMap 技能目录：${skillsRoot}`,
    `安装结果 JSON：${resultFilePath}`,
    '',
    '目标目录结构：',
    '- `.solomap-global/skills/installed/<skill-id>/package/`：完整 skill package，必须包含入口 `SKILL.md`，并保留 scripts、templates、assets、examples 等同级资源。',
    '- `.solomap-global/skills/installed/<skill-id>/solomap.skill.json`：SoloMap 统一技能元数据。',
    '- `.solomap-global/skills/installed/<skill-id>/source.lock.json`：来源、commit、原始 skillPath、安装时间、文件 hash 或目录 hash。',
    '',
    '安装步骤：',
    '1. 解析用户提供的来源。支持 skills.sh URL、GitHub URL、owner/repo、owner/repo@skill、仓库子目录 URL。',
    '2. 下载或克隆来源到临时预览区；如果使用 `npx skills`，必须设置 `DISABLE_TELEMETRY=1`，并把 HOME 指向临时目录，避免污染用户真实 Agent 技能目录。',
    '3. 定位目标 skill package 的实际文件夹；不要只复制 `SKILL.md`。',
    '4. 选择稳定 `skill-id`：优先用 SKILL.md frontmatter 的 `name`，否则用目录名；只允许小写字母、数字和连字符。',
    '5. 将完整 package 写入 `.solomap-global/skills/installed/<skill-id>/package/`。',
    '6. 从 `SKILL.md` 解析 title/name、description、version，并生成 `solomap.skill.json`。至少包含 id、title、description、entry、packagePath、status、source、activation、risk、installedAt、updatedAt。',
    '7. 扫描 package，标记风险：是否包含 scripts、可执行文件、网络访问提示、文件写入提示。默认 `requiresUserApprovalToRunScripts=true`。',
    '8. 写入 `source.lock.json`。',
    '9. 写入安装结果 JSON。',
    '',
    '结果 JSON schema：',
    '{',
    '  "ok": true,',
    '  "skillId": "skill-id",',
    '  "installedPath": ".solomap-global/skills/installed/skill-id",',
    '  "packagePath": ".solomap-global/skills/installed/skill-id/package",',
    '  "entryFile": ".solomap-global/skills/installed/skill-id/package/SKILL.md",',
    '  "solomapSkillJson": ".solomap-global/skills/installed/skill-id/solomap.skill.json",',
    '  "sourceLockJson": ".solomap-global/skills/installed/skill-id/source.lock.json",',
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

function resolveSkillResultPath(globalRoot: string, value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.join(path.dirname(globalRoot), raw);
}

function pathInside(parent: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function validateAndRegisterSkillInstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string): { ok: boolean; message: string; skillId?: string } {
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
  const now = new Date().toISOString();
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
    installedAt: String(skillJson.installedAt || result.installedAt || now),
    updatedAt: now
  };
  const registry = readSolomapSkillRegistry(workspaceRoot, globalDataPath);
  const nextSkills = registry.skills.filter((skill) => skill.id !== skillId);
  nextSkills.push(entry);
  writeSolomapSkillRegistry(workspaceRoot, globalDataPath, { ...registry, skills: nextSkills.sort((a, b) => a.id.localeCompare(b.id)) });
  return { ok: true, message: `Skill installed: ${skillId}`, skillId };
}

function getSolomapMcpRegistryPath(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(getSolomapMcpRoot(workspaceRoot, globalDataPath), 'registry.json');
}

function ensureSolomapMcpStore(workspaceRoot: string, globalDataPath = ''): { mcpRoot: string; serversRoot: string; runsRoot: string; profilesRoot: string; registryPath: string } {
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  const serversRoot = path.join(mcpRoot, 'servers');
  const runsRoot = path.join(mcpRoot, 'runs');
  const profilesRoot = path.join(mcpRoot, 'profiles');
  const registryPath = path.join(mcpRoot, 'registry.json');
  [mcpRoot, serversRoot, runsRoot, profilesRoot].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  if (!fs.existsSync(registryPath)) {
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), connectors: [] }, null, 2), 'utf8');
  }
  return { mcpRoot, serversRoot, runsRoot, profilesRoot, registryPath };
}

function readSolomapMcpRegistry(workspaceRoot: string, globalDataPath = ''): SolomapMcpRegistry {
  const registryPath = getSolomapMcpRegistryPath(workspaceRoot, globalDataPath);
  if (!fs.existsSync(registryPath)) {
    return { version: 1, updatedAt: '', connectors: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return {
      version: Number(parsed.version || 1),
      updatedAt: String(parsed.updatedAt || ''),
      connectors: Array.isArray(parsed.connectors) ? parsed.connectors : []
    };
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), connectors: [] };
  }
}

function writeSolomapMcpRegistry(workspaceRoot: string, globalDataPath: string, registry: SolomapMcpRegistry): void {
  const { registryPath } = ensureSolomapMcpStore(workspaceRoot, globalDataPath);
  const normalized: SolomapMcpRegistry = {
    version: 1,
    updatedAt: new Date().toISOString(),
    connectors: Array.isArray(registry.connectors) ? registry.connectors : []
  };
  fs.writeFileSync(registryPath, JSON.stringify(normalized, null, 2), 'utf8');
}

function scoreSolomapMcp(connector: SolomapMcpRegistryEntry, contextText: string): { score: number; reasons: string[] } {
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

function selectSolomapMcpCandidates(workspaceRoot: string, globalDataPath: string, contextText: string, limit = 3): Array<{ connector: SolomapMcpRegistryEntry; reasons: string[] }> {
  const registry = readSolomapMcpRegistry(workspaceRoot, globalDataPath);
  return registry.connectors
    .map((connector) => ({ connector, ...scoreSolomapMcp(connector, contextText) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.connector.id.localeCompare(b.connector.id))
    .slice(0, limit)
    .map(({ connector, reasons }) => ({ connector, reasons }));
}

function buildSolomapMcpCandidateInstructions(workspaceRoot: string, globalDataPath: string, contextText: string): string {
  const candidates = selectSolomapMcpCandidates(workspaceRoot, globalDataPath, contextText, 3);
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

function buildMcpInstallPrompt(mcpInput: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  return [
    '你正在为 SoloMap 安装一个跨 Agent 通用 MCP 能力连接器。',
    '',
    `项目目录：${workspaceRoot}`,
    `用户提供的 MCP 来源：${mcpInput}`,
    `SoloMap Global 目录：${globalRoot}`,
    `SoloMap MCP 目录：${mcpRoot}`,
    `安装结果 JSON 必须写入：${resultFilePath}`,
    '',
    '目标目录结构：',
    '- `.solomap-global/mcp/servers/<mcp-id>/package/`：完整 MCP server package 或配置说明。',
    '- `.solomap-global/mcp/servers/<mcp-id>/solomap.mcp.json`：SoloMap 统一 MCP 元数据。',
    '- `.solomap-global/mcp/servers/<mcp-id>/source.lock.json`：来源、commit、安装时间、文件 hash 或目录 hash。',
    '- `.solomap-global/mcp/servers/<mcp-id>/profiles/`：不同 Agent CLI 的配置建议片段，例如 codex.json、claude.json、cursor.json、agy.json。',
    '',
    '安装要求：',
    '1. 解析来源。支持 GitHub URL、npm package、MCP server 仓库、文档页或用户粘贴的 server 配置片段。',
    '2. 只做下载、复制、分析和生成配置建议；不要启动 MCP server，不要登录外部服务，不要写入任何 Agent 私有配置目录。',
    '3. 选择稳定 `mcp-id`：只允许小写字母、数字和连字符。',
    '4. 生成 `solomap.mcp.json`。至少包含 id、title、description、status、source、server、profiles、activation、permissions、risk、installedAt、updatedAt。',
    '5. 识别风险：是否需要凭证、是否访问外网、是否可外部写入、是否可发消息、是否可修改云资源、是否可访问密钥；不确定时按高风险处理并设置 `requiresExplicitEnable: true`。',
    '6. 生成各 Agent 的 profile/config 建议，但只写入 `.solomap-global/mcp/servers/<mcp-id>/profiles/`，不要应用到真实 Agent 配置。',
    '',
    '结果 JSON 格式：',
    '{',
    '  "ok": true,',
    '  "mcpId": "mcp-id",',
    '  "installedPath": ".solomap-global/mcp/servers/mcp-id",',
    '  "packagePath": ".solomap-global/mcp/servers/mcp-id/package",',
    '  "solomapMcpJson": ".solomap-global/mcp/servers/mcp-id/solomap.mcp.json",',
    '  "sourceLockJson": ".solomap-global/mcp/servers/mcp-id/source.lock.json",',
    '  "profilesPath": ".solomap-global/mcp/servers/mcp-id/profiles",',
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

function validateAndRegisterMcpInstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string): { ok: boolean; message: string; mcpId?: string } {
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
  const now = new Date().toISOString();
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
    installedAt: String(mcpJson.installedAt || result.installedAt || now),
    updatedAt: now
  };
  if (profilesPath && !pathInside(installedPath, profilesPath)) {
    return { ok: false, message: 'MCP profiles path is outside installed MCP directory.' };
  }
  const registry = readSolomapMcpRegistry(workspaceRoot, globalDataPath);
  const nextConnectors = registry.connectors.filter((connector) => connector.id !== mcpId);
  nextConnectors.push(entry);
  writeSolomapMcpRegistry(workspaceRoot, globalDataPath, { ...registry, connectors: nextConnectors.sort((a, b) => a.id.localeCompare(b.id)) });
  return { ok: true, message: `MCP connector installed: ${mcpId}`, mcpId };
}

function getSolomapEnhancementRegistryPath(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(getSolomapEnhancementsRoot(workspaceRoot, globalDataPath), 'registry.json');
}

function ensureSolomapEnhancementStore(workspaceRoot: string, globalDataPath = ''): { enhancementsRoot: string; installedRoot: string; runsRoot: string; registryPath: string } {
  const enhancementsRoot = getSolomapEnhancementsRoot(workspaceRoot, globalDataPath);
  const installedRoot = path.join(enhancementsRoot, 'installed');
  const runsRoot = path.join(enhancementsRoot, 'runs');
  const registryPath = path.join(enhancementsRoot, 'registry.json');
  [enhancementsRoot, installedRoot, runsRoot].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  if (!fs.existsSync(registryPath)) {
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), enhancements: [] }, null, 2), 'utf8');
  }
  return { enhancementsRoot, installedRoot, runsRoot, registryPath };
}

function readSolomapEnhancementRegistry(workspaceRoot: string, globalDataPath = ''): SolomapEnhancementRegistry {
  const registryPath = getSolomapEnhancementRegistryPath(workspaceRoot, globalDataPath);
  if (!fs.existsSync(registryPath)) {
    return { version: 1, updatedAt: '', enhancements: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return {
      version: Number(parsed.version || 1),
      updatedAt: String(parsed.updatedAt || ''),
      enhancements: Array.isArray(parsed.enhancements) ? parsed.enhancements : []
    };
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), enhancements: [] };
  }
}

function writeSolomapEnhancementRegistry(workspaceRoot: string, globalDataPath: string, registry: SolomapEnhancementRegistry): void {
  const { registryPath } = ensureSolomapEnhancementStore(workspaceRoot, globalDataPath);
  const normalized: SolomapEnhancementRegistry = {
    version: 1,
    updatedAt: new Date().toISOString(),
    enhancements: Array.isArray(registry.enhancements) ? registry.enhancements : []
  };
  fs.writeFileSync(registryPath, JSON.stringify(normalized, null, 2), 'utf8');
}

function isEnhancementUsable(enhancement: SolomapEnhancementRegistryEntry | undefined): boolean {
  if (!enhancement) return false;
  const status = String(enhancement.status || '').toLowerCase();
  if (!['installed', 'available', 'ready'].includes(status)) return false;
  if (enhancement.health && enhancement.health.ok === false) return false;
  return true;
}

function isEnhancementEnabled(enhancement: SolomapEnhancementRegistryEntry | undefined): boolean {
  return Boolean(enhancement?.enabled) && isEnhancementUsable(enhancement);
}

function enabledEnhancementIds(enabledEnhancements: Record<string, boolean> = {}): string[] {
  return BUILTIN_SOLOMAP_ENHANCEMENTS
    .map((enhancement) => enhancement.id)
    .filter((id) => Boolean(enabledEnhancements[id]));
}

function getEnabledEnhancementMap(workspaceRoot: string, globalDataPath = ''): Record<string, boolean> {
  const registry = readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  return mergeBuiltinSolomapEnhancements(registry.enhancements)
    .filter((enhancement) => BUILTIN_SOLOMAP_ENHANCEMENTS.some((builtin) => builtin.id === enhancement.id))
    .reduce<Record<string, boolean>>((acc, enhancement) => {
      acc[enhancement.id] = isEnhancementEnabled(enhancement);
      return acc;
    }, {});
}

function statusLabelForEnhancement(status: string, installed: boolean, enabled = false): string {
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

function getSolomapEnhancementStatusSummaries(workspaceRoot: string, globalDataPath = ''): SolomapEnhancementStatusSummary[] {
  const registry = readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
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

function refreshSolomapEnhancementStatusSummaries(workspaceRoot: string, globalDataPath = ''): SolomapEnhancementStatusSummary[] {
  const registry = readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  const byId = new Map(registry.enhancements.map((enhancement) => [enhancement.id, enhancement]));
  BUILTIN_SOLOMAP_ENHANCEMENTS.forEach((builtin) => {
    const currentStatus = String(byId.get(builtin.id)?.status || '').toLowerCase();
    if (currentStatus === 'installing' || currentStatus === 'uninstalling' || currentStatus === 'uninstalled') {
      return;
    }
    checkAndRegisterEnhancement(workspaceRoot, globalDataPath, builtin.id);
  });
  return getSolomapEnhancementStatusSummaries(workspaceRoot, globalDataPath);
}

function readJsonFileIfExists(filePath: string): any {
  try {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isKnownEnhancementVersion(value: unknown): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return Boolean(normalized && !['版本未知', 'unknown', 'unknown version', 'version unknown', '未安装'].includes(normalized));
}

function chooseEnhancementVersion(...values: unknown[]): string {
  for (const value of values) {
    if (isKnownEnhancementVersion(value)) {
      return String(value).trim();
    }
  }
  return '';
}

function buildRtkCommandWrapper(commandName: string): string {
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

function ensureSolomapEnhancementRuntime(
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

function buildSolomapEnhancementContextPreflight(
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

function buildSolomapEnhancementRuntimeInstructions(contextFilePath: string, enabledEnhancements: Record<string, boolean> = {}): string {
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

function scoreSolomapEnhancement(enhancement: SolomapEnhancementRegistryEntry, contextText: string): { score: number; reasons: string[] } {
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

function mergeBuiltinSolomapEnhancements(
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

function selectSolomapEnhancementCandidates(
  workspaceRoot: string,
  globalDataPath: string,
  contextText: string,
  limit = 3,
  enabledEnhancements: Record<string, boolean> = {}
): Array<{ enhancement: SolomapEnhancementRegistryEntry; reasons: string[] }> {
  const registry = readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  return mergeBuiltinSolomapEnhancements(registry.enhancements, enabledEnhancements)
    .filter((enhancement) => Boolean(enabledEnhancements[enhancement.id]))
    .map((enhancement) => ({ enhancement, ...scoreSolomapEnhancement(enhancement, contextText) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.enhancement.id.localeCompare(b.enhancement.id))
    .slice(0, limit)
    .map(({ enhancement, reasons }) => ({ enhancement, reasons }));
}

function buildSolomapEnhancementCandidateInstructions(
  workspaceRoot: string,
  globalDataPath: string,
  contextText: string,
  enabledEnhancements: Record<string, boolean> = {}
): string {
  const candidates = selectSolomapEnhancementCandidates(workspaceRoot, globalDataPath, contextText, 3, enabledEnhancements);
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

function getBuiltinEnhancementDefinition(enhancementId: string): BuiltinSolomapEnhancementDefinition | undefined {
  return BUILTIN_SOLOMAP_ENHANCEMENTS.find((enhancement) => enhancement.id === enhancementId);
}

function buildEnhancementInstallPrompt(enhancementId: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string): string {
  const enhancement = getBuiltinEnhancementDefinition(enhancementId);
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const enhancementsRoot = getSolomapEnhancementsRoot(workspaceRoot, globalDataPath);
  const installedPath = path.join(enhancementsRoot, 'installed', enhancementId);
  const installerSkillPath = path.join(getSolomapSkillsRoot(workspaceRoot, globalDataPath), 'installed/solomap-enhancement-installer/package/SKILL.md');
  return [
    '你正在为 SoloMap 安装一个受管执行增强。',
    '请先读取并遵守这个安装 skill：',
    installerSkillPath,
    '',
    `请求安装的增强 ID：${enhancementId}`,
    `增强名称：${enhancement?.title || enhancementId}`,
    `增强说明：${enhancement?.description || ''}`,
    `项目目录：${workspaceRoot}`,
    `SoloMap 全局目录：${globalRoot}`,
    `SoloMap 增强目录：${enhancementsRoot}`,
    `目标安装目录：${installedPath}`,
    `安装结果 JSON 必须写入：${resultFilePath}`,
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

function buildEnhancementUninstallPrompt(enhancementId: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string): string {
  const enhancement = getBuiltinEnhancementDefinition(enhancementId);
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const enhancementsRoot = getSolomapEnhancementsRoot(workspaceRoot, globalDataPath);
  const installedPath = path.join(enhancementsRoot, 'installed', enhancementId);
  const installerSkillPath = path.join(getSolomapSkillsRoot(workspaceRoot, globalDataPath), 'installed/solomap-enhancement-installer/package/SKILL.md');
  return [
    '你正在为 SoloMap 卸载一个受管执行增强。',
    '请先读取并遵守这个安装/卸载 skill：',
    installerSkillPath,
    '',
    `请求卸载的增强 ID：${enhancementId}`,
    `增强名称：${enhancement?.title || enhancementId}`,
    `增强说明：${enhancement?.description || ''}`,
    `项目目录：${workspaceRoot}`,
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

function resolveEnhancementResultPath(globalRoot: string, value: string): string {
  return resolveSkillResultPath(globalRoot, value);
}

function validateAndRegisterEnhancementInstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string): { ok: boolean; message: string; enhancementId?: string } {
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
    upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, {
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
  const now = new Date().toISOString();
  const registry = readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
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
    installedAt: String(enhancementJson.installedAt || result.installedAt || now),
    updatedAt: now,
    lastCheckedAt: String(health.lastCheckedAt || now),
    health: {
      ok: health.ok !== false,
      message: String(health.message || result.health?.message || '可用'),
      version
    }
  };
  upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, entry);
  return { ok: true, message: `执行增强已安装：${entry.title}（${version || '版本未知'}）`, enhancementId };
}

function validateAndRegisterEnhancementUninstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string): { ok: boolean; message: string; enhancementId?: string } {
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
    upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, {
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
  const registryResult = uninstallSolomapEnhancement(workspaceRoot, globalDataPath, enhancementId, resultMessage);
  return { ...registryResult, message: `执行增强已卸载：${builtin.title}` };
}

function upsertEnhancementRegistryEntry(workspaceRoot: string, globalDataPath: string, entry: SolomapEnhancementRegistryEntry): void {
  const registry = readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  const nextEnhancements = registry.enhancements.filter((enhancement) => enhancement.id !== entry.id);
  nextEnhancements.push(entry);
  writeSolomapEnhancementRegistry(workspaceRoot, globalDataPath, { ...registry, enhancements: nextEnhancements.sort((a, b) => a.id.localeCompare(b.id)) });
}

function runEnhancementCheckCommand(enhancementId: string, workspaceRoot: string): { ok: boolean; version: string; message: string } {
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

function extractVersionText(output: string): string {
  const text = String(output || '').replace(/\s+/g, ' ').trim();
  const match = text.match(/\b(v?\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?)/i);
  return match ? match[1] : (text ? '版本未知' : '');
}

function checkAndRegisterEnhancement(workspaceRoot: string, globalDataPath: string, enhancementId: string): { ok: boolean; message: string; enhancementId?: string } {
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!builtin) {
    return { ok: false, message: '未知执行增强。' };
  }
  const check = runEnhancementCheckCommand(enhancementId, workspaceRoot);
  const now = new Date().toISOString();
  const { enhancementsRoot, installedRoot } = ensureSolomapEnhancementStore(workspaceRoot, globalDataPath);
  const registry = readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  const existingEntry = registry.enhancements.find((enhancement) => enhancement.id === enhancementId);
  const uninstalledEntry = String(existingEntry?.status || '').toLowerCase() === 'uninstalled' ? existingEntry : undefined;
  if (uninstalledEntry) {
    upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, {
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
    });
    return {
      ok: false,
      message: `执行增强已卸载：${builtin.title}。需要恢复时请点击安装或修复。`,
      enhancementId
    };
  }
  const installedPath = path.join(installedRoot, enhancementId);
  fs.mkdirSync(installedPath, { recursive: true });
  const manifestPath = path.join(installedPath, 'solomap.enhancement.json');
  const healthPath = path.join(installedPath, 'health.json');
  const sourceLockPath = path.join(installedPath, 'source.lock.json');
  const existingManifest = readJsonFileIfExists(manifestPath) || {};
  const existingHealth = readJsonFileIfExists(healthPath) || {};
  const existingSourceLock = readJsonFileIfExists(sourceLockPath) || {};
  const version = chooseEnhancementVersion(
    check.version,
    existingHealth.version,
    existingManifest.health?.version,
    existingManifest.version,
    existingEntry?.health?.version,
    existingEntry?.version,
    existingSourceLock.version,
    existingSourceLock.metadata?.version,
    ...(Array.isArray(existingSourceLock.packages) ? existingSourceLock.packages.map((pkg: any) => pkg?.version) : [])
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
  fs.writeFileSync(healthPath, JSON.stringify(nextHealth, null, 2) + '\n', 'utf8');
  fs.writeFileSync(manifestPath, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  if (!fs.existsSync(sourceLockPath)) {
    fs.writeFileSync(sourceLockPath, JSON.stringify({ source: builtin.source || {}, checkedAt: now }, null, 2) + '\n', 'utf8');
  }
  upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, entry);
  return {
    ok: check.ok,
    message: check.ok ? `执行增强可用：${builtin.title}（${version || '版本未知'}）` : `执行增强检测失败：${builtin.title}。${check.message}`,
    enhancementId
  };
}

function setSolomapEnhancementEnabled(workspaceRoot: string, globalDataPath: string, enhancementId: string, enabled: boolean): { ok: boolean; message: string; enhancementId?: string } {
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!builtin) {
    return { ok: false, message: '未知执行增强。' };
  }
  const registry = readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  const current = mergeBuiltinSolomapEnhancements(registry.enhancements).find((enhancement) => enhancement.id === enhancementId);
  if (enabled && !isEnhancementUsable(current)) {
    return { ok: false, message: `执行增强尚不可用：${builtin.title}。请先安装或修复。`, enhancementId };
  }
  const now = new Date().toISOString();
  upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, {
    ...builtin,
    ...(current || {}),
    id: enhancementId,
    status: current?.status || (enabled ? 'installed' : 'disabled'),
    enabled,
    updatedAt: now,
    lastCheckedAt: current?.lastCheckedAt || now,
    health: current?.health || { ok: enabled, message: enabled ? '已启用。' : '已禁用。' }
  });
  return {
    ok: true,
    message: enabled ? `已启用执行增强：${builtin.title}` : `已禁用执行增强：${builtin.title}`,
    enhancementId
  };
}

function uninstallSolomapEnhancement(workspaceRoot: string, globalDataPath: string, enhancementId: string, healthMessage = '已从用户环境卸载。'): { ok: boolean; message: string; enhancementId?: string } {
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!builtin) {
    return { ok: false, message: '未知执行增强。' };
  }
  const registry = readSolomapEnhancementRegistry(workspaceRoot, globalDataPath);
  const current = mergeBuiltinSolomapEnhancements(registry.enhancements).find((enhancement) => enhancement.id === enhancementId);
  const now = new Date().toISOString();
  upsertEnhancementRegistryEntry(workspaceRoot, globalDataPath, {
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
  });
  return { ok: true, message: `已卸载执行增强：${builtin.title}`, enhancementId };
}

function buildSoloMapSystemMemoryPrompt(workspaceRoot: string, globalDataPath = ''): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const memoryRoot = path.join(globalRoot, 'memory');
  const projectMemoryFile = getProjectMemoryFilePath(workspaceRoot, globalDataPath);
  const learningCandidatesDir = path.join(globalRoot, 'learning', 'candidates');
  return [
    'SoloMap 默认系统提示词：全局经验库机制',
    `- 当前项目目录：${workspaceRoot}`,
    `- 跨项目数据目录：${globalRoot}`,
    `- 全局经验库目录：${memoryRoot}`,
    `- 当前项目记忆文件：${projectMemoryFile}`,
    `- 待沉淀候选目录：${learningCandidatesDir}`,
    '- 开始工作前，按需读取全局经验库中的 `profile.md`、`operating-rules.md`、当前项目记忆、相关 `patterns/`、`decisions/`、`domains/`、`active/` 与 `inbox/`；文件不存在时继续完成本轮任务。',
    '- 写入协议：每个子目录都有 `_example.md` 示例；写入前先读取对应示例，按示例结构新建或追加真实主题文件，不要覆盖 `_example.md`，不要把原始日志、执行流水或用户不需要看的内部过程直接复制进去。',
    '- 写入位置：项目事实写入当前项目记忆；可复用做法写入 `patterns/`；已确认的跨项目决策写入 `decisions/`；领域知识写入 `domains/`；未验证观察写入 `inbox/` 或 `learning/candidates/`；临时交接写入 `active/`。',
    '- 旧 `.codex-memory/` 只作为兼容来源；新的稳定经验优先进入 `.solomap-global/memory`，未验证观察先作为候选进入 `.solomap-global/learning/candidates` 或经验库 `inbox/`。',
    '- 当前用户请求、当前项目文件、测试、日志和命令输出的证据优先级高于经验库；经验库只能帮助理解和减少重复，不能覆盖用户本轮目标。',
    '- 不要把经验库目录结构、实现机制或内部治理负担暴露给普通用户；面向用户的输出只保留能帮助其完成动作的结论、改动、验证和风险。',
    '- 不要自动把某个项目的私有事实泄漏到其他项目；跨项目复用前必须确认其是稳定、可泛化且不含敏感信息的经验。',
    '- 新项目或新环节开始时，必须先做启动注入自检：确认项目类型、当前用户动作、成功标准、可复用经验、相似项目记忆和本轮最窄验证，再开始改动。',
    '- 项目类型用于选择路线图形态：核心产品默认覆盖 Build/Sell/Learn/Improve；基础设施强调契约、接入、版本和兼容；内容产品强调生产、分发和反馈；试验研究允许验证失败但必须沉淀结论；工具脚手架强调可复用入口；归档维护强调稳定性和监控。',
    '- 如果当前是生成初始路线图或调整路线图，必须先把全局方法论转成用户能执行的环节，不要把方法论说明、内部目录结构或维护者自述做成路线图环节。',
    '- 如果当前是普通执行环节，先查询可能相关的项目记忆、patterns、decisions、domains 和学习候选；只有确认可复用且不含项目私有细节时才复用。',
    '- 任务结束时，如发现未来可复用的经验，先以候选或明确建议形式沉淀；只有已验证且稳定的信息才进入长期记忆。'
  ].join('\n');
}

function buildAgentConversationPrompt(
  node: RoadmapNode,
  userMessage: string,
  workspaceRoot: string,
  stepMemoryFilePath = '',
  agentRunsDir = '',
  completionDecisionFilePath = '',
  previousSessionId = '',
  supplementFiles: string[] = [],
  globalPrompt = '',
  githubIssueContext = '',
  globalDataPath = '',
  enabledEnhancements: Record<string, boolean> = {}
): string {
  const normalizedUserMessage = userMessage.trim();
  const normalizedGlobalPrompt = globalPrompt.trim();
  const normalizedGithubIssueContext = githubIssueContext.trim();
  const supplement = userMessage.trim()
    ? `\n\n用户对本次对话的补充要求：\n${userMessage.trim()}`
    : '';
  const attachedFiles = filterProjectRelativeFiles(workspaceRoot, supplementFiles);
  const supplementFileInstructions = attachedFiles.length > 0
    ? [
      '用户为本次对话选择了补充文件，开始执行前必须先读取这些文件：',
      ...attachedFiles.map((file) => `- ${file}`),
      '这些文件是本轮任务的重要上下文；如果它们与历史记录或环节默认描述冲突，以这些文件和本次用户补充为准。'
    ].join('\n')
    : '';
  const globalPromptInstructions = normalizedGlobalPrompt
    ? [
      '用户设置的全局默认要求（适用于每一次环节对话）：',
      normalizedGlobalPrompt,
      '如果全局默认要求与本次用户补充冲突，以本次用户补充为准。'
    ].join('\n')
    : '';
  const memoryFile = stepMemoryFilePath || getStepMemoryFilePath(workspaceRoot, node.id || '');
  const runsDir = agentRunsDir || path.join(workspaceRoot, '.solopreneur', 'agent-runs', node.id || '');
  const completionFile = completionDecisionFilePath
    ? toProjectRelativeRuntimePath(workspaceRoot, completionDecisionFilePath)
    : '';
  const memoryFileDisplay = toProjectRelativeRuntimePath(workspaceRoot, memoryFile);
  const runsDirDisplay = toProjectRelativeRuntimePath(workspaceRoot, runsDir);
  const completionCriteria = readCompletionCriteria(workspaceRoot, node);
  const completionCriteriaInstructions = completionCriteria.length > 0
    ? [
      '本环节完成标准：',
      ...completionCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
      '本轮交付和最终完成判断必须对照这些标准；如果只完成其中一部分，请保持环节为继续推进状态。'
    ].join('\n')
    : '';
  const memoryInstructions = [
    '开始前必须先读取 SoloMap 为本环节保存的项目上下文文件：',
    `- 环节交接 JSON：${memoryFileDisplay}`,
    `- 环节运行记录目录：${runsDirDisplay}`,
    '如果文件或目录不存在，说明这是该环节的早期对话，继续执行本轮任务即可。',
    '读取这些项目文件后，再结合本次用户补充推进当前环节；不要依赖插件直接注入的历史摘要。'
  ].join('\n');
  const userPriorityInstructions = normalizedUserMessage
    ? [
      '最高优先级规则：',
      '1. 本次“用户对本次对话的补充要求”是这一轮唯一最高优先级指令，高于旧会话中的既有结论、高于之前的完成判断、高于你刚才输出过的总结话术。',
      '2. 如果旧会话、环节默认任务、历史完成状态与这次用户补充有任何冲突，必须以这次用户补充为准。',
      '3. 禁止重复汇报与这次用户补充无关的旧成果，禁止再次输出“已经完成”“状态健康”“随时待命”这类空泛总结，除非你在本轮真的完成了用户补充要求。',
      '4. 即使当前环节状态显示为 Completed 或 Failed，也不能把它当成停止信号；你仍然必须执行这次用户补充要求。'
    ].join('\n')
    : [
      '最高优先级规则：',
      '如果本轮没有额外的用户补充要求，就以当前环节任务为唯一目标，不要偏离到其他路线图环节或仓库内无关工作。'
    ].join('\n');

  const priorSessionInstructions = previousSessionId.trim()
    ? [
      '上轮同 Agent 原生会话参考：',
      `- 上一轮会话 ID：${previousSessionId.trim()}`,
      '- 这只是可选参考，不是强制续接命令。',
      '- 只有在你判断确实需要查看上一轮对话细节时，才自行使用这个会话 ID；否则直接按本轮任务执行。',
      '- 即使你查看上一轮对话，本轮仍必须以当前环节任务和本次用户补充为准，不要被旧结论带偏。'
    ].join('\n')
    : '';
  const solomapMemoryInstructions = buildSoloMapSystemMemoryPrompt(workspaceRoot, globalDataPath);
  const solomapDocumentationInstructions = buildDocumentationPromptContext(workspaceRoot);
  const solomapSkillInstructions = buildSolomapSkillCandidateInstructions(
    workspaceRoot,
    globalDataPath,
    [node.title, node.stage, node.description, node.agentPrompt, normalizedUserMessage, normalizedGithubIssueContext].join('\n')
  );
  const solomapMcpInstructions = buildSolomapMcpCandidateInstructions(
    workspaceRoot,
    globalDataPath,
    [node.title, node.stage, node.description, node.agentPrompt, normalizedUserMessage, normalizedGithubIssueContext].join('\n')
  );
  const solomapEnhancementInstructions = buildSolomapEnhancementCandidateInstructions(
    workspaceRoot,
    globalDataPath,
    [node.title, node.stage, node.description, node.agentPrompt, normalizedUserMessage, normalizedGithubIssueContext].join('\n'),
    enabledEnhancements
  );
  const githubDeliveryContext = buildGithubDeliveryContext(workspaceRoot);
  const solomapLearningContext = buildSolomapLearningContext(workspaceRoot, globalDataPath);
  const solomapExecutionExperienceContext = buildExecutionExperiencePrompt(workspaceRoot, {
    nodeId: node.id || '',
    runKind: 'step',
    contextText: [
      node.title,
      node.stage,
      node.description,
      node.agentPrompt,
      normalizedUserMessage,
      normalizedGithubIssueContext,
      attachedFiles.join('\n')
    ].join('\n'),
    supplementFiles: attachedFiles
  });
  const crossAgentHandoffInstructions = buildCrossAgentHandoffInstructions(workspaceRoot, node.id || '', 'step');

  return [
    '你正在 SoloMap 的一个路线图环节中工作。',
    '请把这次调用当成该环节的一次 agent 对话，而不是必须一次性完成整个环节。',
    '这是本次调用的唯一任务。不要执行与本环节无关的仓库记忆、历史会话或其他待办事项。',
    '',
    `项目目录：${workspaceRoot}`,
    `环节：${node.title}`,
    `阶段：${node.stage}`,
    `环节说明：${node.description}`,
    `当前环节状态：${node.status}`,
    ...(completionCriteriaInstructions ? ['', completionCriteriaInstructions] : []),
    '',
    userPriorityInstructions,
    '',
    '本次任务：',
    node.agentPrompt,
    supplement,
    ...(normalizedGithubIssueContext ? ['', normalizedGithubIssueContext] : []),
    ...(githubDeliveryContext ? ['', githubDeliveryContext] : []),
    ...(supplementFileInstructions ? ['', supplementFileInstructions] : []),
    '',
    solomapMemoryInstructions,
    '',
    solomapDocumentationInstructions,
    ...(solomapLearningContext ? ['', solomapLearningContext] : []),
    ...(solomapExecutionExperienceContext ? ['', solomapExecutionExperienceContext] : []),
    '',
    crossAgentHandoffInstructions,
    ...(solomapSkillInstructions ? ['', solomapSkillInstructions] : []),
    ...(solomapMcpInstructions ? ['', solomapMcpInstructions] : []),
    ...(solomapEnhancementInstructions ? ['', solomapEnhancementInstructions] : []),
    ...(globalPromptInstructions ? ['', globalPromptInstructions] : []),
    ...(priorSessionInstructions ? ['', priorSessionInstructions] : []),
    memoryInstructions,
    '',
    '闭环要求：',
    '1. 直接在项目目录中完成本次能交付的文件改动或文档产出。除非用户明确要求，否则不要只输出计划或总结。',
    '2. 不要等待用户二次确认；如果任务过大，先交付一个可验证的小闭环，并在输出末尾说明下一次建议继续做什么。',
    '3. 运行你认为最窄且必要的验证命令；如果无法运行，说明原因。',
    '4. 完成后正常退出 CLI 进程。扩展会根据进程退出码记录本轮对话是否成功。',
    completionDecisionFilePath
      ? `5. 如果你判断整个路线图环节已经达到完成标准，请向 ${completionFile} 写入 JSON：{"markCompleted":true,"reason":"一句话说明为什么这个环节已完成"}。如果还需要后续对话，不要写这个文件。`
      : '5. 如果你判断整个路线图环节已经达到完成标准，请在最终输出中明确说明。'
  ].join('\n');
}

function buildRoadmapRevisionPrompt(
  userMessage: string,
  workspaceRoot: string,
  globalPrompt = '',
  supplementFiles: string[] = [],
  globalDataPath = '',
  enabledEnhancements: Record<string, boolean> = {}
): string {
  const normalizedUserMessage = userMessage.trim();
  const attachedFiles = filterProjectRelativeFiles(workspaceRoot, supplementFiles);
  const supplementFileInstructions = attachedFiles.length > 0
    ? [
      '用户为本次路线图调整附加了补充文件，开始执行前必须先读取这些文件：',
      ...attachedFiles.map((file) => `- ${file}`),
      '这些文件是本轮调整的重要上下文；如果它们与历史路线图描述冲突，以这些文件和本次调整要求为准。'
    ].join('\n')
    : '';
  const globalPromptInstructions = globalPrompt.trim()
    ? [
      '用户设置的全局默认要求：',
      globalPrompt.trim(),
      '如与本次路线图调整要求冲突，始终以本次路线图调整要求为准。'
    ].join('\n')
    : '';
  const solomapMemoryInstructions = buildSoloMapSystemMemoryPrompt(workspaceRoot, globalDataPath);
  const solomapDocumentationInstructions = buildDocumentationPromptContext(workspaceRoot);
  const solomapSkillInstructions = buildSolomapSkillCandidateInstructions(workspaceRoot, globalDataPath, normalizedUserMessage);
  const solomapMcpInstructions = buildSolomapMcpCandidateInstructions(workspaceRoot, globalDataPath, normalizedUserMessage);
  const solomapEnhancementInstructions = buildSolomapEnhancementCandidateInstructions(workspaceRoot, globalDataPath, normalizedUserMessage, enabledEnhancements);
  const githubDeliveryContext = buildGithubDeliveryContext(workspaceRoot);
  const solomapLearningContext = buildSolomapLearningContext(workspaceRoot, globalDataPath);
  const solomapExecutionExperienceContext = buildExecutionExperiencePrompt(workspaceRoot, {
    nodeId: roadmapRevisionId,
    runKind: 'roadmap_revision',
    contextText: [normalizedUserMessage, attachedFiles.join('\n')].join('\n'),
    supplementFiles: attachedFiles
  });
  const crossAgentHandoffInstructions = buildCrossAgentHandoffInstructions(workspaceRoot, roadmapRevisionId, 'roadmap_revision');
  return [
    '你正在 SoloMap 中调整当前项目路线图。',
    '本轮唯一交付物是根据用户的最新目标，直接更新项目目录中的 `.solopreneur/roadmap.csv`。',
    '',
    `项目目录：${workspaceRoot}`,
    '',
    '本次路线图调整要求（最高优先级）：',
    normalizedUserMessage,
    ...(supplementFileInstructions ? ['', supplementFileInstructions] : []),
    '',
    solomapMemoryInstructions,
    '',
    solomapDocumentationInstructions,
    ...(solomapLearningContext ? ['', solomapLearningContext] : []),
    ...(solomapExecutionExperienceContext ? ['', solomapExecutionExperienceContext] : []),
    '',
    crossAgentHandoffInstructions,
    ...(githubDeliveryContext ? ['', githubDeliveryContext] : []),
    ...(solomapSkillInstructions ? ['', solomapSkillInstructions] : []),
    ...(solomapMcpInstructions ? ['', solomapMcpInstructions] : []),
    ...(solomapEnhancementInstructions ? ['', solomapEnhancementInstructions] : []),
    ...(globalPromptInstructions ? ['', globalPromptInstructions] : []),
    '',
    '执行要求：',
    '1. 先读取当前 `.solopreneur/roadmap.csv`、`.solopreneur/roadmap-methodology.md`、`.solopreneur/validate-roadmap.cjs` 和项目已有文件，理解已经完成的工作与仍待推进的事项。',
    '2. 直接重写 `.solopreneur/roadmap.csv`，让后续环节反映本次调整要求；不要把本段提示词、解释文字或执行日志写进 CSV。',
    '3. 除非用户明确要求推翻已完成工作，否则保留已完成环节的事实和状态，并围绕新方向调整待推进环节、依赖与 Agent 任务。',
    '4. CSV 必须保留字段 `id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt`；每个依赖必须指向存在的环节 ID，且不能自依赖。',
    '5. 先判断项目最适配的类型（Core Product / Infrastructure / Content Product / Experiment & Research / Tools & Scaffolding / Archive & Maintenance）：如果是核心产品（商业化产品），待推进路线图必须完整覆盖问题、MVP、营销、反馈规模化等闭环阶段，不可长期只剩工程 Build 任务；若属于基础设施、工具、试验或内容类，按其相应的方法论规范去调整安排后续阶段（例如基础设施需包含设计契约/标准化接入/治理，试验项目包含原型/评估/总结沉淀，内容产品包含生产/分发），不可强行套用营销或销售任务，也不可虚构无关的商业化阶段。',
    '6. 用 Build -> Sell -> Learn -> Improve 作为底层闭环审查，针对性设计每一阶段的 `agentPrompt`。每一个被修改或新增的待推进环节，其 `agentPrompt` 都必须具有落地证据，要求 Agent 直接创建、修改或测试项目本地文件或配置，严禁生成务虚、没有本地产出物的研究或总结环节。',
    '7. 不要把方法论本身写成用户需要维护的说明环节；它只应用来决定后续路线图和下一步动作。',
    '8. 完成后必须运行 `node .solopreneur/validate-roadmap.cjs --mode revision` 校验最终 CSV；如果失败，按输出修正后重新运行，直到通过。',
    '9. 只有校验通过后，才允许在最终回复中说明路线图调整完成并正常退出 CLI。'
  ].join('\n');
}

function buildSoloConversationPrompt(
  userMessage: string,
  workspaceRoot: string,
  globalPrompt = '',
  supplementFiles: string[] = [],
  globalDataPath = '',
  enabledEnhancements: Record<string, boolean> = {}
): string {
  const normalizedUserMessage = userMessage.trim();
  const attachedFiles = filterProjectRelativeFiles(workspaceRoot, supplementFiles);
  const supplementFileInstructions = attachedFiles.length > 0
    ? [
      '用户为本次 Solo 对话选择了补充文件：',
      ...attachedFiles.map((file) => `- ${file}`),
      '请先读取这些文件，并仅将它们作为本次问题的背景材料。'
    ].join('\n')
    : '';
  const globalPromptInstructions = globalPrompt.trim()
    ? [
      '用户设置的全局默认要求：',
      globalPrompt.trim(),
      '如与本次用户要求冲突，始终以本次用户要求为准。'
    ].join('\n')
    : '';
  const solomapMemoryInstructions = buildSoloMapSystemMemoryPrompt(workspaceRoot, globalDataPath);
  const solomapDocumentationInstructions = buildDocumentationPromptContext(workspaceRoot);
  const solomapSkillInstructions = buildSolomapSkillCandidateInstructions(workspaceRoot, globalDataPath, normalizedUserMessage);
  const solomapMcpInstructions = buildSolomapMcpCandidateInstructions(workspaceRoot, globalDataPath, normalizedUserMessage);
  const solomapEnhancementInstructions = buildSolomapEnhancementCandidateInstructions(workspaceRoot, globalDataPath, normalizedUserMessage, enabledEnhancements);
  const solomapLearningContext = buildSolomapLearningContext(workspaceRoot, globalDataPath);
  const solomapExecutionExperienceContext = buildExecutionExperiencePrompt(workspaceRoot, {
    nodeId: soloConversationId,
    runKind: 'solo',
    contextText: [normalizedUserMessage, attachedFiles.join('\n')].join('\n'),
    supplementFiles: attachedFiles
  });
  const crossAgentHandoffInstructions = buildCrossAgentHandoffInstructions(workspaceRoot, soloConversationId, 'solo');
  return [
    '你正在 SoloMap 的 Solo 模式中处理当前项目的一次直接对话。',
    '这次对话尚未归属于任何路线图环节；优先解决用户当前问题，不要要求用户先选择环节。',
    '',
    `项目目录：${workspaceRoot}`,
    '',
    '用户本次要求（最高优先级）：',
    normalizedUserMessage,
    ...(supplementFileInstructions ? ['', supplementFileInstructions] : []),
    '',
    solomapMemoryInstructions,
    '',
    solomapDocumentationInstructions,
    ...(solomapLearningContext ? ['', solomapLearningContext] : []),
    ...(solomapExecutionExperienceContext ? ['', solomapExecutionExperienceContext] : []),
    '',
    crossAgentHandoffInstructions,
    ...(solomapSkillInstructions ? ['', solomapSkillInstructions] : []),
    ...(solomapMcpInstructions ? ['', solomapMcpInstructions] : []),
    ...(solomapEnhancementInstructions ? ['', solomapEnhancementInstructions] : []),
    ...(globalPromptInstructions ? ['', globalPromptInstructions] : []),
    '',
    '执行边界：',
    '1. 可以读取当前项目文件与 `.solopreneur/roadmap.csv` 了解背景，但不要自行修改路线图、环节状态、完成标准或环节交接记录。',
    '2. 如果用户要的是讨论、判断或头脑风暴，直接给出有用结论即可，不要求产生文件修改。',
    '3. 如果用户明确要求实现或修复，直接交付可验证的最小改动并运行必要验证。',
    '4. 完成后在结论中用一句话说明本次对话更适合：仅保留在 Solo、关联某个已有环节（写明环节标题），或进入路线图调整。',
    '5. 完成后正常退出 CLI 进程；SoloMap 会保存本次 Solo 对话，由用户决定是否关联路线图环节。'
  ].join('\n');
}

function buildFlowExecutionNodeId(flowId: string, loopId: string, role: FlowRole): string {
  return `__flow__::${flowId}::${loopId}::${role}`;
}

function parseFlowExecutionNodeId(nodeId: string): { flowId: string; loopId: string; role: FlowRole } | null {
  const match = String(nodeId || '').match(/^__flow__::([^:]+)::([^:]+)::(planner|builder|verifier)$/);
  if (!match) {
    return null;
  }
  return {
    flowId: match[1],
    loopId: match[2],
    role: match[3] as FlowRole
  };
}

function extractFlowJsonBlock(output: string): Record<string, any> | null {
  const match = String(output || '').match(/SOLOMAP_FLOW_JSON_START\s*([\s\S]*?)\s*SOLOMAP_FLOW_JSON_END/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function validateFlowPlannerResult(data: Record<string, any> | null): string[] {
  if (!data) {
    return ['未找到 Planner 的结构化 JSON 结果。'];
  }
  const errors: string[] = [];
  if (!String(data.goal || '').trim()) errors.push('goal 不能为空。');
  if (!Array.isArray(data.scope) || data.scope.length === 0) errors.push('scope 至少需要 1 项。');
  if (!Array.isArray(data.successCriteria) || data.successCriteria.length === 0) errors.push('successCriteria 至少需要 1 项。');
  if (!Array.isArray(data.plan) || data.plan.length === 0) errors.push('plan 至少需要 1 项。');
  if (!Array.isArray(data.verificationPlan) || data.verificationPlan.length === 0) errors.push('verificationPlan 至少需要 1 项。');
  return errors;
}

function validateFlowBuilderResult(data: Record<string, any> | null): string[] {
  if (!data) {
    return ['未找到 Builder 的结构化 JSON 结果。'];
  }
  const errors: string[] = [];
  if (!Array.isArray(data.actions) || data.actions.length === 0) errors.push('actions 至少需要 1 项。');
  if (!Array.isArray(data.commandsRun)) errors.push('commandsRun 必须是数组。');
  if (!String(data.recommendedStatus || '').trim()) errors.push('recommendedStatus 不能为空。');
  return errors;
}

function validateFlowVerifierResult(data: Record<string, any> | null): string[] {
  if (!data) {
    return ['未找到 Verifier 的结构化 JSON 结果。'];
  }
  const errors: string[] = [];
  if (!Array.isArray(data.checks) || data.checks.length === 0) errors.push('checks 至少需要 1 项。');
  if (!data.H || typeof data.H.pass !== 'boolean') errors.push('H.pass 必须存在。');
  if (!data.I || typeof data.I.pass !== 'boolean') errors.push('I.pass 必须存在。');
  if (!data.J || typeof data.J.pass !== 'boolean') errors.push('J.pass 必须存在。');
  if (!String(data.recommendedStatus || '').trim()) errors.push('recommendedStatus 不能为空。');
  return errors;
}

function buildFlowPlannerPrompt(input: {
  goal: string;
  workspaceRoot: string;
  flowId: string;
  loopId: string;
  relatedRoadmapStepTitle?: string;
  globalPrompt?: string;
  supplementFiles?: string[];
}): string {
  return [
    '你正在 SoloMap 的 Flow 模式中担任 Planner。',
    '你的唯一任务是：把当前目标拆成一个可执行、可验证、可归因的微观循环计划。',
    '',
    `项目目录：${input.workspaceRoot}`,
    `Flow ID：${input.flowId}`,
    `微循环：${input.loopId}`,
    `用户目标：${input.goal}`,
    ...(Array.isArray(input.supplementFiles) && input.supplementFiles.length ? [`补充文件：${input.supplementFiles.join(', ')}`] : []),
    ...(input.relatedRoadmapStepTitle ? [`相关路线图环节：${input.relatedRoadmapStepTitle}`] : []),
    ...(input.globalPrompt ? ['', '用户设置的全局默认要求：', input.globalPrompt] : []),
    '',
    '执行要求：',
    '1. 先阅读相关代码、文档和当前项目事实，不要空想方案。',
    '2. 严格按“五看三定”产出结构化规划：目标、范围、边界、路径、风险、验证。',
    '3. 不要执行代码修改，不要运行会改变项目状态的命令；你只负责规划。',
    '4. 最终只输出一个 JSON，必须包在以下标记之间：',
    'SOLOMAP_FLOW_JSON_START',
    '{"goal":"","scope":[],"outOfScope":[],"successCriteria":[],"plan":[],"affectedAreas":[],"constraints":[],"risks":[],"verificationPlan":[],"nextLoopGoal":""}',
    'SOLOMAP_FLOW_JSON_END',
    '5. 输出前自行检查 JSON 可被直接解析，字段齐全，不要夹杂额外说明。'
  ].join('\n');
}

function buildFlowBuilderPrompt(input: {
  goal: string;
  workspaceRoot: string;
  flowId: string;
  loopId: string;
  planner: Record<string, any>;
  globalPrompt?: string;
  supplementFiles?: string[];
}): string {
  return [
    '你正在 SoloMap 的 Flow 模式中担任 Builder。',
    '你的唯一任务是：按照 Planner 的微观循环计划直接落地实现并给出结构化实施结果。',
    '',
    `项目目录：${input.workspaceRoot}`,
    `Flow ID：${input.flowId}`,
    `微循环：${input.loopId}`,
    `用户目标：${input.goal}`,
    ...(Array.isArray(input.supplementFiles) && input.supplementFiles.length ? [`补充文件：${input.supplementFiles.join(', ')}`] : []),
    ...(input.globalPrompt ? ['', '用户设置的全局默认要求：', input.globalPrompt] : []),
    '',
    'Planner 结构化计划：',
    JSON.stringify(input.planner, null, 2),
    '',
    '执行要求：',
    '1. 直接修改项目文件并运行必要的最窄验证，不要停留在建议。',
    '2. 如果发现 Planner 缺口，先在当前实现里做最小纠偏，不要擅自换目标。',
    '3. 最终只输出一个 JSON，必须包在以下标记之间：',
    'SOLOMAP_FLOW_JSON_START',
    '{"actions":[],"commandsRun":[],"knownGaps":[],"recommendedStatus":"partial|ready_for_verification|needs_replan","summary":""}',
    'SOLOMAP_FLOW_JSON_END',
    '4. 输出前自行检查 JSON 可解析，且 actions 必须对应真实发生的实施动作。'
  ].join('\n');
}

function buildFlowVerifierPrompt(input: {
  goal: string;
  workspaceRoot: string;
  flowId: string;
  loopId: string;
  planner: Record<string, any>;
  builder: Record<string, any>;
  evidence: {
    changedFilesSummary: string;
    touchedFilesSummary: string;
    outputTail: string;
  };
  globalPrompt?: string;
  supplementFiles?: string[];
}): string {
  return [
    '你正在 SoloMap 的 Flow 模式中担任 Verifier。',
    '你的唯一任务是：基于 Planner 意图、Builder 结果和真实证据，判断这一轮微观循环是否闭环。',
    '',
    `项目目录：${input.workspaceRoot}`,
    `Flow ID：${input.flowId}`,
    `微循环：${input.loopId}`,
    `用户目标：${input.goal}`,
    ...(Array.isArray(input.supplementFiles) && input.supplementFiles.length ? [`补充文件：${input.supplementFiles.join(', ')}`] : []),
    ...(input.globalPrompt ? ['', '用户设置的全局默认要求：', input.globalPrompt] : []),
    '',
    'Planner JSON：',
    JSON.stringify(input.planner, null, 2),
    '',
    'Builder JSON：',
    JSON.stringify(input.builder, null, 2),
    '',
    '真实证据：',
    `Workspace changes:\n${input.evidence.changedFilesSummary || '无'}`,
    `Touched project files:\n${input.evidence.touchedFilesSummary || '无'}`,
    `Agent output tail:\n${input.evidence.outputTail || '无'}`,
    '',
    '执行要求：',
    '1. 用 H/I/J 评审：H=硬证据，I=意图与边界，J=工程判断。',
    '2. 不要凭感觉说通过；每个 pass/fail 都要引用真实证据。',
    '3. 最终只输出一个 JSON，必须包在以下标记之间：',
    'SOLOMAP_FLOW_JSON_START',
    '{"checks":[],"H":{"pass":false,"reason":""},"I":{"pass":false,"reason":""},"J":{"pass":false,"reason":""},"recommendedStatus":"completed|partial|implemented_unverified|verified_failed|deviated|needs_user_confirmation","nextLoopGoal":"","summary":""}',
    'SOLOMAP_FLOW_JSON_END',
    '4. 输出前自行检查 JSON 可解析，不要夹带额外正文。'
  ].join('\n');
}

function deriveFlowLoopScoring(verifier: Record<string, any> | null, changedFilesSummary: string, touchedFilesSummary: string): FlowLoopScoring {
  const hPass = Boolean(verifier?.H?.pass) && Boolean(changedFilesSummary.trim() || touchedFilesSummary.trim());
  const iPass = Boolean(verifier?.I?.pass);
  const jPass = Boolean(verifier?.J?.pass);
  let recommendedStatus: FlowLoopStatus = 'implemented_unverified';
  if (String(verifier?.recommendedStatus || '') === 'needs_user_confirmation') {
    recommendedStatus = 'needs_user_confirmation';
  } else if (!hPass && !changedFilesSummary.trim() && !touchedFilesSummary.trim()) {
    recommendedStatus = 'no_effect';
  } else if (!hPass) {
    recommendedStatus = 'implemented_unverified';
  } else if (!iPass) {
    recommendedStatus = 'deviated';
  } else if (String(verifier?.recommendedStatus || '') === 'verified_failed') {
    recommendedStatus = 'verified_failed';
  } else if (String(verifier?.recommendedStatus || '') === 'partial') {
    recommendedStatus = 'partial';
  } else if ((String(verifier?.recommendedStatus || '') === 'completed' || String(verifier?.recommendedStatus || '') === 'closed') && hPass && iPass) {
    recommendedStatus = 'closed';
  }
  return {
    hardEvidencePass: hPass,
    intentPass: iPass,
    judgmentPass: jPass,
    recommendedStatus,
    reasons: [
      verifier?.H?.reason ? `H: ${String(verifier.H.reason)}` : '',
      verifier?.I?.reason ? `I: ${String(verifier.I.reason)}` : '',
      verifier?.J?.reason ? `J: ${String(verifier.J.reason)}` : ''
    ].filter(Boolean)
  };
}

function buildAgentShellScript(
  agentCli: string,
  selectedModel: string,
  conversationPrompt: string,
  workspaceRoot: string,
  nodeId: string,
  executionLogId: number,
  userMessage: string,
  completionDecisionFilePath?: string,
  nativeSessionId = '',
  directExecutionCommand = '',
  runKind = 'step',
  roadmapBackupFilePath = '',
  globalDataPath = '',
  taskPermissionMode = 'auto',
  reviewerCliPath = '',
  collaborationReviewMode = 'high_risk',
  enabledEnhancements: Record<string, boolean> = {},
  runDirOverride = '',
  statusFilePathOverride = ''
): { finalCommand: string; outputFilePath: string; changesFilePath: string; commandFilePath: string; promptFilePath: string; runScriptPath: string } {
  let effectiveSelectedModel = selectedModel;
  let effectiveConversationPrompt = conversationPrompt;
  let effectiveWorkspaceRoot = workspaceRoot;
  let effectiveNodeId = nodeId;
  let effectiveExecutionLogId = executionLogId;
  let effectiveUserMessage = userMessage;
  let effectiveCompletionDecisionFilePath = completionDecisionFilePath;
  let effectiveNativeSessionId = nativeSessionId;
  let effectiveDirectExecutionCommand = directExecutionCommand;
  let effectiveRunKind = runKind;
  let effectiveRoadmapBackupFilePath = roadmapBackupFilePath;
  let effectiveGlobalDataPath = globalDataPath;
  let effectiveTaskPermissionMode = taskPermissionMode;
  let effectiveReviewerCliPath = reviewerCliPath;
  let effectiveCollaborationReviewMode = collaborationReviewMode;
  let effectiveEnabledEnhancements = enabledEnhancements;
  let effectiveRunDirOverride = runDirOverride;
  let effectiveStatusFilePathOverride = statusFilePathOverride;

  if (typeof executionLogId !== 'number') {
    effectiveSelectedModel = '';
    effectiveConversationPrompt = selectedModel;
    effectiveWorkspaceRoot = conversationPrompt;
    effectiveNodeId = String(workspaceRoot || '');
    effectiveExecutionLogId = Number(nodeId) || 0;
    effectiveUserMessage = String(executionLogId || '');
    effectiveCompletionDecisionFilePath = typeof userMessage === 'string' && userMessage ? userMessage : undefined;
    effectiveNativeSessionId = completionDecisionFilePath || '';
    effectiveDirectExecutionCommand = nativeSessionId || '';
    effectiveRunKind = directExecutionCommand || 'step';
    effectiveRoadmapBackupFilePath = runKind || '';
    effectiveGlobalDataPath = roadmapBackupFilePath || '';
    effectiveTaskPermissionMode = globalDataPath || 'auto';
    effectiveReviewerCliPath = taskPermissionMode || '';
    effectiveCollaborationReviewMode = reviewerCliPath || 'high_risk';
    effectiveEnabledEnhancements = (collaborationReviewMode && typeof collaborationReviewMode === 'object')
      ? collaborationReviewMode as Record<string, boolean>
      : {};
    effectiveRunDirOverride = typeof enabledEnhancements === 'string' ? enabledEnhancements : '';
    effectiveStatusFilePathOverride = runDirOverride || '';
  }
  const runDir = effectiveRunDirOverride || path.join(effectiveWorkspaceRoot, '.solopreneur', 'agent-runs', effectiveNodeId);
  const statusFilePath = effectiveStatusFilePathOverride || path.join(effectiveWorkspaceRoot, '.agent_status.json');
  const outputFilePath = path.join(runDir, 'output.log');
  const commandFilePath = path.join(runDir, 'command.txt');
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const runScriptPath = path.join(runDir, 'run-agent.sh');
  const changesFilePath = path.join(runDir, 'changes.txt');
  const touchedFilesPath = path.join(runDir, 'touched-files.txt');
  const workspaceSnapshotPath = path.join(runDir, 'workspace-before.json');
  const startedAtFilePath = path.join(runDir, 'started_at');
  const sessionFilePath = path.join(runDir, 'session.json');
  const decisionFilePath = effectiveCompletionDecisionFilePath || path.join(runDir, 'completion.json');
  const agentProvider = getAgentProvider(agentCli);
  const sessionKey = getAgentSessionKey(agentCli);
  const sessionMode = effectiveNativeSessionId.trim() ? 'fresh-with-reference' : 'fresh';
  const startedAt = new Date().toISOString();
  const commandPreview = `${agentCli} [${sessionMode}]`;
  const loggedCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, effectiveWorkspaceRoot, effectiveTaskPermissionMode, effectiveSelectedModel);
  const executionCommand = effectiveDirectExecutionCommand || buildAgentCommandForPromptFile(agentCli, promptFilePath, effectiveWorkspaceRoot, effectiveTaskPermissionMode, effectiveSelectedModel);
  const statusBase = { nodeId: effectiveNodeId, runKind: effectiveRunKind, roadmapBackupFilePath: effectiveRoadmapBackupFilePath, globalDataPath: effectiveGlobalDataPath, agentCli, selectedModel: effectiveSelectedModel, commandPreview, commandFilePath, executionLogId: effectiveExecutionLogId, userMessage: effectiveUserMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath: decisionFilePath, sessionFilePath, sessionKey, sessionProvider: agentProvider, sessionMode, startedAt, reviewerCliPath: effectiveReviewerCliPath, collaborationReviewMode: effectiveCollaborationReviewMode };
  const runningStatus = JSON.stringify({ ...statusBase, status: 'Running' });
  const completedStatus = JSON.stringify({ ...statusBase, status: 'In Progress' });
  const failedStatus = JSON.stringify({ ...statusBase, status: 'Failed', failureCode: 'agent_exit_failed', failureReason: 'Agent CLI exited before completing this task.' });
  const noChangesStatus = JSON.stringify({ ...statusBase, status: 'Failed', failureCode: 'no_deliverable_changes', failureReason: 'Agent exited without project file changes or a completion decision.' });
  const sessionCaptureScript = buildSessionCaptureScript(agentProvider, effectiveWorkspaceRoot, startedAtFilePath, outputFilePath, sessionFilePath);
  const workspaceSnapshotScript = buildWorkspaceSnapshotScript(effectiveWorkspaceRoot, workspaceSnapshotPath);
  const workspaceDiffScript = buildWorkspaceDiffScript(effectiveWorkspaceRoot, workspaceSnapshotPath, touchedFilesPath);
  const enhancementRuntime = ensureSolomapEnhancementRuntime(effectiveWorkspaceRoot, effectiveGlobalDataPath, effectiveEnabledEnhancements);
  const enhancementContextFilePath = path.join(runDir, 'harness-enhancements.md');
  const enhancementContextPreflight = buildSolomapEnhancementContextPreflight(effectiveWorkspaceRoot, enhancementContextFilePath, effectiveUserMessage, enhancementRuntime.runtimeRoot, effectiveEnabledEnhancements);
  const enhancementRuntimeInstructions = buildSolomapEnhancementRuntimeInstructions(enhancementContextFilePath, effectiveEnabledEnhancements);
  const promptExportScript = effectiveDirectExecutionCommand
    ? [`agent_prompt=$(cat ${shellQuote(promptFilePath)})`, 'export agent_prompt']
    : [];
  const terminalExecutionScript = [
    `(${executionCommand}) 2>&1 | tee ${shellQuote(outputFilePath)};`,
    'status=${PIPESTATUS[0]}'
  ].join(' ');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
  fs.writeFileSync(promptFilePath, enhancementRuntimeInstructions ? [effectiveConversationPrompt, '', enhancementRuntimeInstructions].join('\n') : effectiveConversationPrompt, 'utf8');
  fs.writeFileSync(commandFilePath, loggedCommand, 'utf8');
  const script = [
    `cd ${shellQuote(effectiveWorkspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    ...enhancementRuntime.envLines,
    `mkdir -p ${shellQuote(runDir)}`,
    `touch ${shellQuote(startedAtFilePath)}`,
    workspaceSnapshotScript,
    `printf %s ${shellQuote(JSON.stringify({ markCompleted: false }))} > ${shellQuote(decisionFilePath)}`,
    `printf %s ${shellQuote(runningStatus)} > ${shellQuote(statusFilePath)}`,
    ...enhancementRuntime.preflightLines,
    ...enhancementContextPreflight,
    ...promptExportScript,
    terminalExecutionScript,
    sessionCaptureScript,
    `git -C ${shellQuote(effectiveWorkspaceRoot)} status --short > ${shellQuote(changesFilePath)} 2>/dev/null || true`,
    workspaceDiffScript,
    `if [ ${shellQuote(effectiveRunKind)} != 'solo' ] && [ $status -eq 0 ] && [ ! -s ${shellQuote(changesFilePath)} ] && [ ! -s ${shellQuote(touchedFilesPath)} ] && ! grep -q '"markCompleted"[[:space:]]*:[[:space:]]*true' ${shellQuote(decisionFilePath)} 2>/dev/null; then status=125; printf '\\nSoloMap: Agent exited without project file changes or a completion decision. Marking this run as failed so it can be retried.\\n' >> ${shellQuote(outputFilePath)}; printf %s ${shellQuote(noChangesStatus)} > ${shellQuote(statusFilePath)}; elif [ $status -eq 0 ]; then printf %s ${shellQuote(completedStatus)} > ${shellQuote(statusFilePath)}; else printf %s ${shellQuote(failedStatus)} > ${shellQuote(statusFilePath)}; fi`
  ].join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });

  return {
    finalCommand: `bash ${shellQuote(runScriptPath)}`,
    outputFilePath,
    changesFilePath,
    commandFilePath,
    promptFilePath,
    runScriptPath
  };
}

function isReviewableRunKind(runKind: string, nodeId: string): boolean {
  return runKind !== 'agent_review' && nodeId !== soloConversationId && runKind !== 'solo';
}

function shouldRunAgentReview(
  mode: string,
  runKind: string,
  nodeId: string,
  nextStatus: string,
  changedFilesSummary: string,
  touchedFilesSummary: string
): boolean {
  const normalizedMode = normalizeCollaborationReviewMode(mode);
  if (normalizedMode === 'off' || !isReviewableRunKind(runKind, nodeId)) {
    return false;
  }
  if (!['Completed', 'In Progress'].includes(nextStatus)) {
    return false;
  }
  if (normalizedMode === 'all') {
    return true;
  }
  const combined = [changedFilesSummary, touchedFilesSummary].join('\n');
  return Boolean(combined.trim() || runKind === 'roadmap_revision' || nextStatus === 'Completed');
}

function buildAgentReviewPrompt(input: {
  workspaceRoot: string;
  nodeId: string;
  runKind: string;
  userMessage: string;
  mainAgentCli: string;
  mainStatus: string;
  mainResolvedCommand: string;
  completionReason: string;
  changedFilesSummary: string;
  touchedFilesSummary: string;
  outputTail: string;
  reviewResultFilePath: string;
}): string {
  return [
    '# SoloMap 副 Agent 复核任务',
    '',
    '你是本轮任务的只读复核 Agent。你的职责是判断主 Agent 的交付是否足以闭环，不要修改项目文件，不要提交，不要发布，不要删除文件。',
    '',
    '## 复核目标',
    '- 检查用户原始目标是否被满足。',
    '- 检查主 Agent 是否留下足够完成证据。',
    '- 检查是否还需要验证、用户确认或继续修正。',
    '- 如果涉及普通用户可见界面、内容或文案，额外检查是否残留工程自描述、维护者口吻、模板说明或实现痕迹。',
    '',
    '## 必须输出',
    `请把复核结论写入：${input.reviewResultFilePath}`,
    'JSON 格式必须是：',
    '{"status":"pass|revise|needs_user_confirmation","summary":"一句话结论","findings":["可执行问题或确认点"],"nextAction":"下一步动作"}',
    '',
    'status 含义：',
    '- pass：可以接受本轮结果。',
    '- revise：有明确可执行问题，应打回主 Agent 继续修正。',
    '- needs_user_confirmation：涉及授权、产品取舍、发布、删除或无法由证据裁决的问题，需要用户确认。',
    '',
    '## 本轮事实',
    `- workspace: ${input.workspaceRoot}`,
    `- nodeId: ${input.nodeId}`,
    `- runKind: ${input.runKind}`,
    `- mainAgent: ${input.mainAgentCli}`,
    `- mainStatus: ${input.mainStatus}`,
    input.userMessage ? `- userSupplement: ${input.userMessage}` : '- userSupplement: 无',
    input.completionReason ? `- completionDecision: ${input.completionReason}` : '- completionDecision: 无',
    input.mainResolvedCommand ? `- mainCommand: ${input.mainResolvedCommand}` : '',
    '',
    '## Workspace changes',
    input.changedFilesSummary || 'No captured git changes.',
    '',
    '## Touched files',
    input.touchedFilesSummary || 'No captured touched files.',
    '',
    '## Main Agent output tail',
    input.outputTail || 'No captured output tail.',
    '',
    '## 约束',
    '- 只读复核，不改文件。',
    '- 不要输出长篇讨论。',
    '- 如果没有足够证据确认完成，应选择 revise 或 needs_user_confirmation。',
    '- 完成写入 JSON 后正常退出。'
  ].filter(Boolean).join('\n');
}

function parseAgentReviewResult(resultFilePath: string): { status: string; summary: string; findings: string[]; nextAction: string } {
  if (!resultFilePath || !fs.existsSync(resultFilePath)) {
    return { status: 'needs_user_confirmation', summary: '复核结果文件不存在。', findings: [], nextAction: '请查看复核运行输出。' };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));
    const status = ['pass', 'revise', 'needs_user_confirmation'].includes(String(parsed.status || ''))
      ? String(parsed.status)
      : 'needs_user_confirmation';
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map((item: unknown) => compactLine(String(item || ''), 260)).filter(Boolean).slice(0, 8)
      : [];
    return {
      status,
      summary: compactLine(String(parsed.summary || ''), 500),
      findings,
      nextAction: compactLine(String(parsed.nextAction || ''), 500)
    };
  } catch {
    return { status: 'needs_user_confirmation', summary: '复核结果文件无法解析。', findings: [], nextAction: '请查看复核运行输出。' };
  }
}

function formatAgentReviewResult(result: { status: string; summary: string; findings: string[]; nextAction: string }): string {
  return [
    `Review decision: ${result.status}`,
    result.summary ? `Review summary: ${result.summary}` : '',
    result.findings.length > 0 ? `Review findings:\n${result.findings.map((item) => `- ${item}`).join('\n')}` : '',
    result.nextAction ? `Review next action: ${result.nextAction}` : ''
  ].filter(Boolean).join('\n');
}

function startAgentReviewRun(input: {
  workspaceRoot: string;
  nodeId: string;
  runKind: string;
  reviewerCli: string;
  mainAgentCli: string;
  mainExecutionLogId: number;
  mainResolvedCommand: string;
  userMessage: string;
  mainStatus: string;
  completionReason: string;
  changedFilesSummary: string;
  touchedFilesSummary: string;
  outputTail: string;
  targetStatus: string;
  globalDataPath: string;
  taskPermissionMode: string;
}): void {
  if (!syncEngine) {
    return;
  }
  const reviewRunId = `review-${input.mainExecutionLogId || Date.now()}`;
  const runDir = path.join(input.workspaceRoot, '.solopreneur', 'agent-runs', input.nodeId, reviewRunId);
  const statusFilePath = path.join(input.workspaceRoot, '.agent_status.json');
  const outputFilePath = path.join(runDir, 'output.log');
  const commandFilePath = path.join(runDir, 'command.txt');
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const runScriptPath = path.join(runDir, 'run-agent-review.sh');
  const changesFilePath = path.join(runDir, 'changes.txt');
  const touchedFilesPath = path.join(runDir, 'touched-files.txt');
  const workspaceSnapshotPath = path.join(runDir, 'workspace-before.json');
  const reviewResultFilePath = path.join(runDir, 'review-result.json');
  const startedAt = new Date().toISOString();
  fs.mkdirSync(runDir, { recursive: true });

  const prompt = buildAgentReviewPrompt({
    workspaceRoot: input.workspaceRoot,
    nodeId: input.nodeId,
    runKind: input.runKind,
    userMessage: input.userMessage,
    mainAgentCli: input.mainAgentCli,
    mainStatus: input.mainStatus,
    mainResolvedCommand: input.mainResolvedCommand,
    completionReason: input.completionReason,
    changedFilesSummary: input.changedFilesSummary,
    touchedFilesSummary: input.touchedFilesSummary,
    outputTail: input.outputTail,
    reviewResultFilePath
  });
  fs.writeFileSync(promptFilePath, prompt, 'utf8');

  const loggedCommand = buildAgentCommandForPromptFile(input.reviewerCli, promptFilePath, input.workspaceRoot, input.taskPermissionMode);
  fs.writeFileSync(commandFilePath, loggedCommand, 'utf8');
  const executionLogId = syncEngine.logAgentExecution(
    input.nodeId,
    input.reviewerCli,
    loggedCommand,
    [
      'Agent review started.',
      `Review of execution: ${input.mainExecutionLogId}`,
      `Run started at: ${startedAt}`,
      input.userMessage.trim() ? `User supplement:\n${input.userMessage.trim()}` : ''
    ].filter(Boolean).join('\n\n'),
    'Running'
  );
  postNodeConversations(input.nodeId);

  const statusBase = {
    nodeId: input.nodeId,
    runKind: 'agent_review',
    globalDataPath: input.globalDataPath,
    agentCli: input.reviewerCli,
    commandPreview: `${input.reviewerCli} [review]`,
    commandFilePath,
    executionLogId,
    userMessage: input.userMessage,
    outputFilePath,
    changesFilePath,
    touchedFilesPath,
    reviewResultFilePath,
    reviewOfExecutionLogId: input.mainExecutionLogId,
    reviewTargetStatus: input.targetStatus,
    startedAt
  };
  const runningStatus = JSON.stringify({ ...statusBase, status: 'Running' });
  const completedStatus = JSON.stringify({ ...statusBase, status: 'In Progress' });
  const failedStatus = JSON.stringify({ ...statusBase, status: 'Failed', failureCode: 'agent_review_failed', failureReason: 'Review Agent exited before writing a valid review decision.' });
  const workspaceSnapshotScript = buildWorkspaceSnapshotScript(input.workspaceRoot, workspaceSnapshotPath);
  const workspaceDiffScript = buildWorkspaceDiffScript(input.workspaceRoot, workspaceSnapshotPath, touchedFilesPath);
  const terminalExecutionScript = [
    `(${loggedCommand}) 2>&1 | tee ${shellQuote(outputFilePath)};`,
    'status=${PIPESTATUS[0]}'
  ].join(' ');
  const script = [
    `cd ${shellQuote(input.workspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    `mkdir -p ${shellQuote(runDir)}`,
    workspaceSnapshotScript,
    `printf %s ${shellQuote(runningStatus)} > ${shellQuote(statusFilePath)}`,
    terminalExecutionScript,
    `git -C ${shellQuote(input.workspaceRoot)} status --short > ${shellQuote(changesFilePath)} 2>/dev/null || true`,
    workspaceDiffScript,
    `node -e "const fs=require('fs');try{const p=${JSON.stringify(reviewResultFilePath)};const v=JSON.parse(fs.readFileSync(p,'utf8'));if(!['pass','revise','needs_user_confirmation'].includes(String(v.status||''))) process.exit(2);}catch(e){process.exit(2)}" || status=125`,
    `if [ $status -eq 0 ]; then printf %s ${shellQuote(completedStatus)} > ${shellQuote(statusFilePath)}; else printf %s ${shellQuote(failedStatus)} > ${shellQuote(statusFilePath)}; fi`
  ].join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });

  const terminal = createAgentTerminal(input.workspaceRoot, `review-${input.nodeId}-${executionLogId}`);
  terminal.show(true);
  terminal.sendText(`bash ${shellQuote(runScriptPath)}`);
}

function getOutputTail(filePath: string): string {
  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }

  const content = fs.readFileSync(filePath, 'utf8')
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .trim();
  if (content.length <= 4000) {
    return content;
  }

  return content.slice(-4000);
}

function getChangedFilesSummary(filePath: string): string {
  if (!filePath || !fs.existsSync(filePath)) {
    return 'No git workspace changes were detected or this workspace is not a Git repository.';
  }

  const content = fs.readFileSync(filePath, 'utf8').trim();
  return content || 'No workspace file changes detected.';
}

function getTouchedFilesSummary(filePath: string): string {
  if (!filePath || !fs.existsSync(filePath)) {
    return 'No project files were touched during this run.';
  }

  const content = fs.readFileSync(filePath, 'utf8').trim();
  return content || 'No project files were touched during this run.';
}

function hasRecordedWorkspaceChanges(changedFilesSummary: string, touchedFilesSummary: string): boolean {
  const noGitChanges = changedFilesSummary === 'No workspace file changes detected.'
    || changedFilesSummary === 'No git workspace changes were detected or this workspace is not a Git repository.';
  const noTouchedFiles = touchedFilesSummary === 'No project files were touched during this run.';
  return !noGitChanges || !noTouchedFiles;
}

function buildLocalRoadmap(prompt: string, cliPath: string): RoadmapNode[] {
  const now = new Date().toISOString();
  const safePrompt = prompt.trim() || '新的独立开发项目';
  return [
    {
      id: '1',
      title: '生成初始路线图',
      description: `基于当前项目文件和你对“${safePrompt}”的理解，直接重写 .solopreneur/roadmap.csv，生成这个项目真正要执行的定制化路线图。`,
      stage: '目标与路径确认',
      dependencies: '',
      agentCli: cliPath,
      agentPrompt: '阅读 .solopreneur/bootstrap-roadmap-instructions.md、.solopreneur/roadmap-methodology.md 和 .solopreneur/validate-roadmap.cjs，基于当前项目文件直接重写 .solopreneur/roadmap.csv。完成后必须运行 node .solopreneur/validate-roadmap.cjs --mode bootstrap；校验失败就修正 CSV 并重跑，直到通过后才算完成。',
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '2',
      title: '明确交付目标与成功标准',
      description: `把“${safePrompt}”的目标、使用对象、边界和可验证成功标准整理清楚。`,
      stage: '目标与路径确认',
      dependencies: '1',
      agentCli: cliPath,
      agentPrompt: `为“${safePrompt}”创建 docs/project-brief.md，包含交付目标、使用对象、成功标准、范围边界、风险和下一步行动；若证据表明这是对外产品，再补充客户验证要求。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '3',
      title: '交付首个可验证切片',
      description: '把目标转成可以运行、查看或按文档验收的最小交付结果。',
      stage: '交付与验证',
      dependencies: '2',
      agentCli: cliPath,
      agentPrompt: `阅读 docs/project-brief.md，为“${safePrompt}”实现首个可验证切片，产出项目文件或 docs/delivery-slice.md，并记录最窄验证命令。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '4',
      title: '验证结果并安排下一轮',
      description: '收集本次交付的使用、运行或验收结果，并把反馈转成下一轮动作。',
      stage: '结果反馈与迭代',
      dependencies: '3',
      agentCli: cliPath,
      agentPrompt: `基于当前交付，为“${safePrompt}”创建 docs/iteration-review.md，记录验证证据、反馈来源、未解决问题和下一轮改进任务；若这是对外产品，加入触达与用户反馈动作。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    }
  ];
}

function postNodeConversations(nodeId: string): void {
  if (syncEngine && activePanel) {
    activePanel.webview.postMessage({
      command: 'nodeConversationsLoaded',
      nodeId,
      conversations: syncEngine.getAgentExecutions(nodeId),
      projectPath: activeProjectRoot || ''
    });
  }
  if (nodeId === soloConversationId && sidebarProvider && activeProjectRoot) {
    void sidebarProvider.sendSoloConversationHistory(activeProjectRoot);
  } else if (sidebarProvider && activeProjectRoot) {
    void sidebarProvider.sendStepConversationHistory(activeProjectRoot, nodeId);
    if (nodeId !== roadmapRevisionId) {
      void sidebarProvider.sendProjectConversationHistory(activeProjectRoot);
    }
  }
}

function getAgentStatusRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.solopreneur', agentStatusDirName);
}

function getAgentStatusFilePath(workspaceRoot: string, executionLogId: number): string {
  return path.join(getAgentStatusRoot(workspaceRoot), `${Number(executionLogId || 0)}.json`);
}

function findAgentStatusForConversation(workspaceRoot: string, conversationId: number): any | null {
  const statusRoot = getAgentStatusRoot(workspaceRoot);
  const directStatus = readAgentStatus(getAgentStatusFilePath(workspaceRoot, conversationId));
  if (directStatus) {
    return directStatus;
  }
  const legacyStatus = readAgentStatus(path.join(workspaceRoot, '.agent_status.json'));
  if (legacyStatus && Number(legacyStatus.executionLogId || 0) === Number(conversationId || 0)) {
    return legacyStatus;
  }
  try {
    if (!fs.existsSync(statusRoot)) {
      return null;
    }
    for (const fileName of fs.readdirSync(statusRoot)) {
      if (!fileName.endsWith('.json')) {
        continue;
      }
      const candidate = readAgentStatus(path.join(statusRoot, fileName));
      if (candidate && Number(candidate.executionLogId || 0) === Number(conversationId || 0)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function makeAgentTerminalName(workspaceRoot: string, label: string): string {
  agentTerminalCounter += 1;
  const projectName = path.basename(workspaceRoot);
  const cleanLabel = String(label || 'run').replace(/[^a-zA-Z0-9_.:-]+/g, '-').slice(0, 40) || 'run';
  return `${projectName} · ${cleanLabel} · ${agentTerminalCounter} (${agentTerminalBaseName})`;
}

function findActiveAgentTerminal(conversationId = 0): vscode.Terminal | undefined {
  const terminals = [...vscode.window.terminals];
  const mappedName = conversationId ? agentTerminalNamesByConversationId.get(Number(conversationId)) : '';
  if (mappedName) {
    const mapped = terminals.find((candidate) => candidate.name === mappedName);
    if (mapped) {
      return mapped;
    }
  }
  if (activeAgentTerminalName) {
    const active = terminals.find((candidate) => candidate.name === activeAgentTerminalName);
    if (active) {
      return active;
    }
  }
  return terminals.reverse().find((candidate) => candidate.name.includes(agentTerminalBaseName));
}

function createAgentTerminal(workspaceRoot: string, label: string, conversationId = 0): vscode.Terminal {
  const terminalName = makeAgentTerminalName(workspaceRoot, label);
  activeAgentTerminalName = terminalName;
  if (conversationId) {
    agentTerminalNamesByConversationId.set(Number(conversationId), terminalName);
  }
  let iconPath: vscode.Uri | vscode.ThemeIcon;
  if (extensionContextRef) {
    iconPath = vscode.Uri.joinPath(extensionContextRef.extensionUri, 'resources', 'logo.svg');
  } else {
    iconPath = new vscode.ThemeIcon('symbol-string');
  }
  return vscode.window.createTerminal({
    name: terminalName,
    iconPath: iconPath,
    color: new vscode.ThemeColor('terminal.ansiCyan'),
    cwd: workspaceRoot,
  });
}

function showAgentTerminal(conversationId = 0): void {
  const terminal = findActiveAgentTerminal(conversationId);
  if (terminal) {
    terminal.show(true);
    return;
  }
  vscode.window.showInformationMessage('No active SoloMap Agent terminal is available.');
}

function getSkillInstallWorkspaceRoot(context: vscode.ExtensionContext): string {
  return activeProjectRoot || getSelectedProjectPath(context) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

function postMcpInstallResult(context: vscode.ExtensionContext, success: boolean, message: string): void {
  const settings = getPersistedSettings(context);
  activePanel?.webview.postMessage({ command: 'mcpInstallResult', success, message, settings });
  sidebarProvider?.postMcpInstallResult(success, message);
  vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
}

function postSkillInstallResult(context: vscode.ExtensionContext, success: boolean, message: string): void {
  const settings = getPersistedSettings(context);
  activePanel?.webview.postMessage({ command: 'skillInstallResult', success, message, settings });
  sidebarProvider?.postSkillInstallResult(success, message);
  vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
}

function postEnhancementInstallResult(context: vscode.ExtensionContext, success: boolean, message: string): void {
  const settings = getPersistedSettings(context);
  activePanel?.webview.postMessage({ command: 'enhancementInstallResult', success, message, settings });
  sidebarProvider?.postEnhancementInstallResult(success, message);
  vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
}

async function handleInstallSolomapSkill(context: vscode.ExtensionContext, rawSkillInput: string): Promise<void> {
  const skillInput = String(rawSkillInput || '').trim();
  if (!skillInput) {
    vscode.window.showWarningMessage('Paste a skill link or package name before installing.');
    return;
  }
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, settings.cliPath).join(', ');
    vscode.window.showErrorMessage(`Agent CLI not found. Tried: ${candidates}.`);
    return;
  }
  ensureSolomapMemoryStore(workspaceRoot, settings.globalDataPath);
  const { skillsRoot, runsRoot } = ensureSolomapSkillStore(workspaceRoot, settings.globalDataPath);
  const runId = `skill-install-${Date.now()}`;
  const runDir = path.join(runsRoot, runId);
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const outputFilePath = path.join(runDir, 'output.log');
  const resultFilePath = path.join(runDir, 'result.json');
  const commandFilePath = path.join(runDir, 'command.txt');
  const runScriptPath = path.join(runDir, 'run-skill-install.sh');
  fs.mkdirSync(runDir, { recursive: true });
  const prompt = buildSkillInstallPrompt(skillInput, workspaceRoot, settings.globalDataPath, resultFilePath);
  fs.writeFileSync(promptFilePath, prompt, 'utf8');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot, settings.taskPermissionMode);
  fs.writeFileSync(commandFilePath, agentCommand, 'utf8');
  const script = [
    `cd ${shellQuote(workspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    'export DISABLE_TELEMETRY=1',
    `mkdir -p ${shellQuote(runDir)} ${shellQuote(skillsRoot)}`,
    `${agentCommand} 2>&1 | tee ${shellQuote(outputFilePath)}`,
    `printf '\\nSoloMap skill install run finished. Result expected at: ${resultFilePath}\\n' >> ${shellQuote(outputFilePath)}`
  ].join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });
  const terminal = createAgentTerminal(workspaceRoot, `skill-${runId.slice(-6)}`);
  terminal.show(true);
  terminal.sendText(`bash ${shellQuote(runScriptPath)}`);
  vscode.window.showInformationMessage('SoloMap skill install started. The Agent terminal will complete the package install.');

  const startedAt = Date.now();
  const poller = setInterval(() => {
    if (!fs.existsSync(resultFilePath)) {
      if (Date.now() - startedAt > 30 * 60 * 1000) {
        clearInterval(poller);
        vscode.window.showWarningMessage('SoloMap skill install is still waiting for result.json. Check the Agent terminal output.');
      }
      return;
    }
    clearInterval(poller);
    const validation = validateAndRegisterSkillInstall(workspaceRoot, settings.globalDataPath, resultFilePath);
    if (validation.ok) {
      vscode.window.showInformationMessage(validation.message);
      postSkillInstallResult(context, true, validation.message);
    } else {
      vscode.window.showErrorMessage(`SoloMap skill install failed validation: ${validation.message}`);
      postSkillInstallResult(context, false, validation.message);
    }
  }, 2000);
}

async function handleInstallSolomapMcp(context: vscode.ExtensionContext, rawMcpInput: string): Promise<void> {
  const mcpInput = String(rawMcpInput || '').trim();
  if (!mcpInput) {
    vscode.window.showWarningMessage('Paste an MCP connector link, package, or config before installing.');
    return;
  }
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, settings.cliPath).join(', ');
    vscode.window.showErrorMessage(`Agent CLI not found. Tried: ${candidates}.`);
    return;
  }
  ensureSolomapMemoryStore(workspaceRoot, settings.globalDataPath);
  const { mcpRoot, runsRoot } = ensureSolomapMcpStore(workspaceRoot, settings.globalDataPath);
  const runId = `mcp-install-${Date.now()}`;
  const runDir = path.join(runsRoot, runId);
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const outputFilePath = path.join(runDir, 'output.log');
  const resultFilePath = path.join(runDir, 'result.json');
  const commandFilePath = path.join(runDir, 'command.txt');
  const runScriptPath = path.join(runDir, 'run-mcp-install.sh');
  fs.mkdirSync(runDir, { recursive: true });
  const prompt = buildMcpInstallPrompt(mcpInput, workspaceRoot, settings.globalDataPath, resultFilePath);
  fs.writeFileSync(promptFilePath, prompt, 'utf8');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot, settings.taskPermissionMode);
  fs.writeFileSync(commandFilePath, agentCommand, 'utf8');
  const script = [
    `cd ${shellQuote(workspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    'export DISABLE_TELEMETRY=1',
    `mkdir -p ${shellQuote(runDir)} ${shellQuote(mcpRoot)}`,
    `${agentCommand} 2>&1 | tee ${shellQuote(outputFilePath)}`,
    `printf '\\nSoloMap MCP install run finished. Result expected at: ${resultFilePath}\\n' >> ${shellQuote(outputFilePath)}`
  ].join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });
  const terminal = createAgentTerminal(workspaceRoot, `mcp-${runId.slice(-6)}`);
  terminal.show(true);
  terminal.sendText(`bash ${shellQuote(runScriptPath)}`);
  vscode.window.showInformationMessage('SoloMap MCP connector install started. The Agent terminal will complete the controlled install.');

  const startedAt = Date.now();
  const poller = setInterval(() => {
    if (!fs.existsSync(resultFilePath)) {
      if (Date.now() - startedAt > 30 * 60 * 1000) {
        clearInterval(poller);
        vscode.window.showWarningMessage('SoloMap MCP install is still waiting for result.json. Check the Agent terminal output.');
      }
      return;
    }
    clearInterval(poller);
    const validation = validateAndRegisterMcpInstall(workspaceRoot, settings.globalDataPath, resultFilePath);
    if (validation.ok) {
      vscode.window.showInformationMessage(validation.message);
      postMcpInstallResult(context, true, validation.message);
    } else {
      vscode.window.showErrorMessage(`SoloMap MCP install failed validation: ${validation.message}`);
      postMcpInstallResult(context, false, validation.message);
    }
  }, 2000);
}

async function handleUninstallSolomapSkill(context: vscode.ExtensionContext, skillId: string): Promise<void> {
  const settings = getPersistedSettings(context);
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const globalDataPath = settings.globalDataPath || '';
  
  try {
    const registry = readSolomapSkillRegistry(workspaceRoot, globalDataPath);
    if (!registry.skills.some((skill) => skill.id === skillId)) {
      const message = `Skill is not installed: ${skillId}`;
      vscode.window.showWarningMessage(message);
      postSkillInstallResult(context, false, message);
      return;
    }
    const nextSkills = registry.skills.filter((skill) => skill.id !== skillId);
    writeSolomapSkillRegistry(workspaceRoot, globalDataPath, { ...registry, skills: nextSkills });
    
    const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
    const installedPath = path.join(skillsRoot, 'installed', skillId);
    if (fs.existsSync(installedPath)) {
      fs.rmSync(installedPath, { recursive: true, force: true });
    }
    
    const message = `SoloMap skill uninstalled successfully: ${skillId}`;
    vscode.window.showInformationMessage(message);
    postSkillInstallResult(context, true, message);
  } catch (error: any) {
    const message = `Failed to uninstall skill: ${error.message || error}`;
    vscode.window.showErrorMessage(message);
    postSkillInstallResult(context, false, message);
  }
}

async function handleUninstallSolomapMcp(context: vscode.ExtensionContext, mcpId: string): Promise<void> {
  const settings = getPersistedSettings(context);
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const globalDataPath = settings.globalDataPath || '';
  
  try {
    const registry = readSolomapMcpRegistry(workspaceRoot, globalDataPath);
    if (!registry.connectors.some((connector) => connector.id === mcpId)) {
      const message = `MCP connector is not installed: ${mcpId}`;
      vscode.window.showWarningMessage(message);
      postMcpInstallResult(context, false, message);
      return;
    }
    const nextConnectors = registry.connectors.filter((connector) => connector.id !== mcpId);
    writeSolomapMcpRegistry(workspaceRoot, globalDataPath, { ...registry, connectors: nextConnectors });
    
    const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
    const installedPath = path.join(mcpRoot, 'servers', mcpId);
    if (fs.existsSync(installedPath)) {
      fs.rmSync(installedPath, { recursive: true, force: true });
    }
    
    const message = `SoloMap MCP connector uninstalled successfully: ${mcpId}`;
    vscode.window.showInformationMessage(message);
    postMcpInstallResult(context, true, message);
  } catch (error: any) {
    const message = `Failed to uninstall MCP connector: ${error.message || error}`;
    vscode.window.showErrorMessage(message);
    postMcpInstallResult(context, false, message);
  }
}

async function handleInstallSolomapEnhancement(context: vscode.ExtensionContext, rawEnhancementId: string): Promise<void> {
  const enhancementId = sanitizeAttachmentScope(String(rawEnhancementId || '').trim().toLowerCase());
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!builtin) {
    vscode.window.showWarningMessage('选择一个执行增强后再安装。');
    return;
  }
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, settings.cliPath).join(', ');
    vscode.window.showErrorMessage(`Agent CLI not found. Tried: ${candidates}.`);
    return;
  }
  ensureSolomapMemoryStore(workspaceRoot, settings.globalDataPath);
  ensureSolomapSkillStore(workspaceRoot, settings.globalDataPath);
  const { enhancementsRoot, runsRoot } = ensureSolomapEnhancementStore(workspaceRoot, settings.globalDataPath);
  const runId = `enhancement-install-${enhancementId}-${Date.now()}`;
  const runDir = path.join(runsRoot, runId);
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const outputFilePath = path.join(runDir, 'output.log');
  const resultFilePath = path.join(runDir, 'result.json');
  const commandFilePath = path.join(runDir, 'command.txt');
  const runScriptPath = path.join(runDir, 'run-enhancement-install.sh');
  fs.mkdirSync(runDir, { recursive: true });
  const prompt = buildEnhancementInstallPrompt(enhancementId, workspaceRoot, settings.globalDataPath, resultFilePath);
  fs.writeFileSync(promptFilePath, prompt, 'utf8');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot, settings.taskPermissionMode);
  fs.writeFileSync(commandFilePath, agentCommand, 'utf8');
  const script = [
    `cd ${shellQuote(workspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    'export DISABLE_TELEMETRY=1',
    `mkdir -p ${shellQuote(runDir)} ${shellQuote(enhancementsRoot)}`,
    `${agentCommand} 2>&1 | tee ${shellQuote(outputFilePath)}`,
    `printf '\\nSoloMap enhancement install run finished. Result expected at: ${resultFilePath}\\n' >> ${shellQuote(outputFilePath)}`
  ].join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });
  upsertEnhancementRegistryEntry(workspaceRoot, settings.globalDataPath, {
    ...builtin,
    status: 'installing',
    enabled: false,
    updatedAt: new Date().toISOString(),
    health: { ok: false, message: '安装中' }
  });
  postEnhancementInstallResult(context, true, `正在安装执行增强：${builtin.title}`);
  const terminal = createAgentTerminal(workspaceRoot, `enhance-${enhancementId.slice(0, 8)}`);
  terminal.show(true);
  terminal.sendText(`bash ${shellQuote(runScriptPath)}`);

  const startedAt = Date.now();
  const poller = setInterval(() => {
    if (!fs.existsSync(resultFilePath)) {
      if (Date.now() - startedAt > 45 * 60 * 1000) {
        clearInterval(poller);
        postEnhancementInstallResult(context, false, '执行增强安装仍在等待 result.json，请查看 Agent 终端输出。');
      }
      return;
    }
    clearInterval(poller);
    const validation = validateAndRegisterEnhancementInstall(workspaceRoot, settings.globalDataPath, resultFilePath);
    postEnhancementInstallResult(context, validation.ok, validation.message);
    if (validation.ok) {
      vscode.window.showInformationMessage(validation.message);
    } else {
      vscode.window.showErrorMessage(`执行增强安装复验失败：${validation.message}`);
    }
  }, 2000);
}

async function handleCheckSolomapEnhancement(context: vscode.ExtensionContext, rawEnhancementId: string): Promise<void> {
  const enhancementId = sanitizeAttachmentScope(String(rawEnhancementId || '').trim().toLowerCase());
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const result = checkAndRegisterEnhancement(workspaceRoot, settings.globalDataPath, enhancementId);
  postEnhancementInstallResult(context, result.ok, result.message);
  if (result.ok) {
    vscode.window.showInformationMessage(result.message);
  } else {
    vscode.window.showWarningMessage(result.message);
  }
}

async function handleSetSolomapEnhancementEnabled(context: vscode.ExtensionContext, rawEnhancementId: string, enabled: boolean): Promise<void> {
  const enhancementId = sanitizeAttachmentScope(String(rawEnhancementId || '').trim().toLowerCase());
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const result = setSolomapEnhancementEnabled(workspaceRoot, settings.globalDataPath, enhancementId, enabled);
  postEnhancementInstallResult(context, result.ok, result.message);
  if (result.ok) {
    vscode.window.showInformationMessage(result.message);
  } else {
    vscode.window.showWarningMessage(result.message);
  }
}

async function handleUninstallSolomapEnhancement(context: vscode.ExtensionContext, rawEnhancementId: string): Promise<void> {
  const enhancementId = sanitizeAttachmentScope(String(rawEnhancementId || '').trim().toLowerCase());
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!builtin) {
    vscode.window.showWarningMessage('选择一个执行增强后再卸载。');
    return;
  }
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, settings.cliPath).join(', ');
    vscode.window.showErrorMessage(`Agent CLI not found. Tried: ${candidates}.`);
    return;
  }
  ensureSolomapMemoryStore(workspaceRoot, settings.globalDataPath);
  ensureSolomapSkillStore(workspaceRoot, settings.globalDataPath);
  const { enhancementsRoot, runsRoot } = ensureSolomapEnhancementStore(workspaceRoot, settings.globalDataPath);
  const runId = `enhancement-uninstall-${enhancementId}-${Date.now()}`;
  const runDir = path.join(runsRoot, runId);
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const outputFilePath = path.join(runDir, 'output.log');
  const resultFilePath = path.join(runDir, 'result.json');
  const commandFilePath = path.join(runDir, 'command.txt');
  const runScriptPath = path.join(runDir, 'run-enhancement-uninstall.sh');
  fs.mkdirSync(runDir, { recursive: true });
  const prompt = buildEnhancementUninstallPrompt(enhancementId, workspaceRoot, settings.globalDataPath, resultFilePath);
  fs.writeFileSync(promptFilePath, prompt, 'utf8');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot, settings.taskPermissionMode);
  fs.writeFileSync(commandFilePath, agentCommand, 'utf8');
  const script = [
    `cd ${shellQuote(workspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    'export DISABLE_TELEMETRY=1',
    `mkdir -p ${shellQuote(runDir)} ${shellQuote(enhancementsRoot)}`,
    `${agentCommand} 2>&1 | tee ${shellQuote(outputFilePath)}`,
    `printf '\\nSoloMap enhancement uninstall run finished. Result expected at: ${resultFilePath}\\n' >> ${shellQuote(outputFilePath)}`
  ].join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });
  upsertEnhancementRegistryEntry(workspaceRoot, settings.globalDataPath, {
    ...builtin,
    status: 'uninstalling',
    enabled: false,
    updatedAt: new Date().toISOString(),
    health: { ok: false, message: '卸载中' }
  });
  postEnhancementInstallResult(context, true, `正在卸载执行增强：${builtin.title}`);
  const terminal = createAgentTerminal(workspaceRoot, `enhance-uninstall-${enhancementId.slice(0, 6)}`);
  terminal.show(true);
  terminal.sendText(`bash ${shellQuote(runScriptPath)}`);

  const startedAt = Date.now();
  const poller = setInterval(() => {
    if (!fs.existsSync(resultFilePath)) {
      if (Date.now() - startedAt > 45 * 60 * 1000) {
        clearInterval(poller);
        postEnhancementInstallResult(context, false, '执行增强卸载仍在等待 result.json，请查看 Agent 终端输出。');
      }
      return;
    }
    clearInterval(poller);
    const validation = validateAndRegisterEnhancementUninstall(workspaceRoot, settings.globalDataPath, resultFilePath);
    postEnhancementInstallResult(context, validation.ok, validation.message);
    if (validation.ok) {
      vscode.window.showInformationMessage(validation.message);
    } else {
      vscode.window.showErrorMessage(`执行增强卸载复验失败：${validation.message}`);
    }
  }, 2000);
}

function extractNativeSessionIdFromExecutionOutput(output: string): string {
  const text = String(output || '');
  const match = text.match(/Native Agent session saved:[^\n]*\(([0-9a-fA-F-]{36})\)/);
  return match ? match[1] : '';
}

async function handleContinueNativeConversation(context: vscode.ExtensionContext, nodeId: string, conversationId: number): Promise<void> {
  void context;
  if (!syncEngine || !activeProjectRoot || !nodeId || !conversationId) {
    return;
  }

  const conversation = syncEngine.getAgentExecutions(nodeId).find((entry) => Number(entry.id) === Number(conversationId));
  if (!conversation) {
    vscode.window.showErrorMessage(`Conversation ${conversationId} not found for step ${nodeId}.`);
    return;
  }

  const sessionId = extractNativeSessionIdFromExecutionOutput(conversation.output || '');
  if (!sessionId) {
    vscode.window.showInformationMessage('No native Agent session ID was recorded for this conversation.');
    return;
  }

  const agentCli = resolveAgentCli(conversation.agentCli || '', '');
  if (!commandExists(agentCli)) {
    vscode.window.showErrorMessage(`Agent CLI not found for native continuation: ${conversation.agentCli || agentCli}`);
    return;
  }

  const terminal = createAgentTerminal(activeProjectRoot, `native-${sessionId.slice(0, 8)}`, conversationId);
  terminal.show(true);
  terminal.sendText(buildNativeContinueCommand(agentCli, sessionId, activeProjectRoot));
}

function readAgentStatus(statusFilePath: string): any | null {
  if (!fs.existsSync(statusFilePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(statusFilePath, 'utf8').trim();
    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}

function getAgentStatusFilePaths(workspaceRoot: string): string[] {
  const paths: string[] = [path.join(workspaceRoot, '.agent_status.json')];
  const statusRoot = getAgentStatusRoot(workspaceRoot);
  try {
    if (fs.existsSync(statusRoot)) {
      for (const fileName of fs.readdirSync(statusRoot)) {
        if (fileName.endsWith('.json')) {
          paths.push(path.join(statusRoot, fileName));
        }
      }
    }
  } catch {
    // Ignore transient directory reads while a run is starting.
  }
  return paths;
}

function hasRunningAgentConversation(workspaceRoot: string, nodes: RoadmapNode[]): boolean {
  if (nodes.some((candidate) => candidate.status === 'Running')) {
    return true;
  }
  if (syncEngine?.getAgentExecutions(roadmapRevisionId).some((conversation) => conversation.status === 'Running')) {
    return true;
  }
  if (syncEngine?.getAgentExecutions(soloConversationId).some((conversation) => conversation.status === 'Running')) {
    return true;
  }
  const status = readAgentStatus(path.join(workspaceRoot, '.agent_status.json'));
  return Boolean(status && status.status === 'Running');
}

async function stopAgentRun(nodeId: string, conversationId: number): Promise<void> {
  if (!syncEngine || !activeProjectRoot || !nodeId) {
    return;
  }
  const runningStatus = findAgentStatusForConversation(activeProjectRoot, conversationId);
  const statusFilePath = runningStatus
    ? getAgentStatusFilePath(activeProjectRoot, Number(runningStatus.executionLogId || conversationId))
    : path.join(activeProjectRoot, '.agent_status.json');
  const conversation = syncEngine.getAgentExecutions(nodeId).find((entry) => Number(entry.id) === Number(conversationId));
  if (!conversation || conversation.status !== 'Running') {
    vscode.window.showInformationMessage('This Agent conversation is no longer running.');
    return;
  }

  const terminal = findActiveAgentTerminal(conversationId);
  terminal?.dispose();
  const failureReason = 'Stopped by user.';
  const finishedAt = new Date().toISOString();
  if (runningStatus && runningStatus.nodeId === nodeId && Number(runningStatus.executionLogId) === Number(conversationId)) {
    if (runningStatus.outputFilePath) {
      fs.appendFileSync(runningStatus.outputFilePath, '\nSoloMap: Task stopped by user.\n', 'utf8');
    }
    fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
    fs.writeFileSync(statusFilePath, JSON.stringify({
      ...runningStatus,
      status: 'Failed',
      failureCode: 'stopped_by_user',
      failureReason,
      finishedAt
    }), 'utf8');
    await processAgentStatusFile(statusFilePath);
    agentTerminalNamesByConversationId.delete(Number(conversationId));
    return;
  }

  if (nodeId !== roadmapRevisionId && nodeId !== soloConversationId) {
    syncEngine.updateNode(nodeId, { status: 'Failed', completedAt: '' });
  }
  syncEngine.updateAgentExecution(
    conversationId,
    conversation.agentCli,
    conversation.command,
    `${conversation.output}\n\nFailure category: stopped_by_user\n\nFailure reason:\n${failureReason}\n\nRun finished at: ${finishedAt}`,
    'Failed'
  );
  agentTerminalNamesByConversationId.delete(Number(conversationId));
  sendNodesToWebview();
  postNodeConversations(nodeId);
  vscode.window.showInformationMessage(`Agent task [${nodeId}] was stopped.`);
}

async function handleRoadmapRevision(context: vscode.ExtensionContext, userMessage: string, selectedAgentCli = '', selectedModel = '', supplementFiles: string[] = []): Promise<void> {
  if (!syncEngine || !activeProjectRoot) {
    return;
  }
  const revisionRequest = userMessage.trim();
  if (!revisionRequest) {
    vscode.window.showWarningMessage('Describe how you want to adjust the roadmap before sending.');
    return;
  }
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (selectedAgentCli || settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, selectedAgentCli ? '' : settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, selectedAgentCli ? '' : settings.cliPath).join(', ');
    const failureReason = `Agent CLI not found. Tried: ${candidates}.`;
    syncEngine.logAgentExecution(
      roadmapRevisionId,
      requestedAgentCli || agentCli,
      requestedAgentCli || agentCli,
      `User supplement:\n${revisionRequest}\n\nFailure category: cli_not_found\n\nFailure reason:\n${failureReason}`,
      'Failed'
    );
    postNodeConversations(roadmapRevisionId);
    vscode.window.showErrorMessage(`${failureReason} Set SoloMap CLI Command or Path to an installed executable such as agy or codex.`);
    return;
  }
  const automation = ensureAgentTaskAutomation(agentCli);
  if (!automation.ok) {
    syncEngine.logAgentExecution(
      roadmapRevisionId,
      agentCli,
      agentCli,
      `User supplement:\n${revisionRequest}\n\nFailure category: agent_automation_not_ready\n\nFailure reason:\n${automation.message}`,
      'Failed'
    );
    postNodeConversations(roadmapRevisionId);
    vscode.window.showErrorMessage(automation.message);
    return;
  }

  recordLocalUsageEvent(context, 'roadmapRevision');
  ensureRoadmapValidationScript(path.join(activeProjectRoot, '.solopreneur'));
  ensureSolomapMemoryStore(activeProjectRoot, settings.globalDataPath);
  const attachedFiles = filterProjectRelativeFiles(activeProjectRoot, supplementFiles);
  const conversationPrompt = buildRoadmapRevisionPrompt(revisionRequest, activeProjectRoot, settings.globalPrompt, attachedFiles, settings.globalDataPath, settings.enabledEnhancements);
  const launchSummary = [
    'Roadmap revision started.',
    `Run started at: ${new Date().toISOString()}`,
    `User supplement:\n${revisionRequest}`,
    attachedFiles.length > 0 ? `Supplement files:\n${attachedFiles.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  const executionLogId = syncEngine.logAgentExecution(
    roadmapRevisionId,
    agentCli,
    `${agentCli} [preparing isolated run]`,
    launchSummary,
    'Running'
  );
  const runDir = path.join(activeProjectRoot, '.solopreneur', 'agent-runs', 'roadmap-revision', String(executionLogId));
  const roadmapPath = path.join(activeProjectRoot, '.solopreneur', 'roadmap.csv');
  const roadmapBackupFilePath = path.join(runDir, 'roadmap-before.csv');
  fs.mkdirSync(runDir, { recursive: true });
  if (fs.existsSync(roadmapPath)) {
    fs.writeFileSync(roadmapBackupFilePath, fs.readFileSync(roadmapPath, 'utf8'), 'utf8');
  }
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, activeProjectRoot, settings.taskPermissionMode, selectedModel);
  syncEngine.updateAgentExecution(executionLogId, agentCli, agentCommand, launchSummary, 'Running');
  postNodeConversations(roadmapRevisionId);

  const { finalCommand } = buildAgentShellScript(
    agentCli,
    selectedModel,
    conversationPrompt,
    activeProjectRoot,
    roadmapRevisionId,
    executionLogId,
    revisionRequest,
    undefined,
    '',
    '',
    'roadmap_revision',
    roadmapBackupFilePath,
    settings.globalDataPath,
    settings.taskPermissionMode,
    settings.reviewerCliPath,
    settings.collaborationReviewMode,
    settings.enabledEnhancements,
    runDir,
    getAgentStatusFilePath(activeProjectRoot, executionLogId)
  );
  const terminal = createAgentTerminal(activeProjectRoot, `revision-${executionLogId}`, executionLogId);
  terminal.show(true);
  terminal.sendText(finalCommand);
}

async function handleRunSoloConversation(context: vscode.ExtensionContext, userMessage: string, selectedAgentCli = '', selectedModel = '', supplementFiles: string[] = []): Promise<void> {
  if (!syncEngine || !activeProjectRoot) {
    return;
  }
  const request = userMessage.trim();
  if (!request) {
    vscode.window.showWarningMessage('Describe what you want to handle before starting a Solo conversation.');
    return;
  }

  await syncEngine.initAndSync();

  const settings = getPersistedSettings(context);
  const requestedAgentCli = (selectedAgentCli || settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, selectedAgentCli ? '' : settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, selectedAgentCli ? '' : settings.cliPath).join(', ');
    const failureReason = `Agent CLI not found. Tried: ${candidates}.`;
    syncEngine.logAgentExecution(
      soloConversationId,
      requestedAgentCli || agentCli,
      requestedAgentCli || agentCli,
      `User supplement:\n${request}\n\nFailure category: cli_not_found\n\nFailure reason:\n${failureReason}`,
      'Failed'
    );
    postNodeConversations(soloConversationId);
    vscode.window.showErrorMessage(`${failureReason} Set SoloMap CLI Command or Path to an installed executable such as agy or codex.`);
    return;
  }
  const automation = ensureAgentTaskAutomation(agentCli);
  if (!automation.ok) {
    syncEngine.logAgentExecution(
      soloConversationId,
      agentCli,
      agentCli,
      `User supplement:\n${request}\n\nFailure category: agent_automation_not_ready\n\nFailure reason:\n${automation.message}`,
      'Failed'
    );
    postNodeConversations(soloConversationId);
    vscode.window.showErrorMessage(automation.message);
    return;
  }

  recordLocalUsageEvent(context, 'soloConversation');
  ensureSolomapMemoryStore(activeProjectRoot, settings.globalDataPath);
  const storedSession = getStoredAgentSession(activeProjectRoot, soloConversationId, agentCli);
  const nativeSessionId = storedSession?.sessionId || '';
  const attachedFiles = filterProjectRelativeFiles(activeProjectRoot, supplementFiles);
  const preGitHash = createPreSessionGitCommit(activeProjectRoot);
  const launchSummary = [
    preGitHash ? `SoloMapPreGitHash: ${preGitHash}` : '',
    'Solo conversation started.',
    `Run started at: ${new Date().toISOString()}`,
    nativeSessionId
      ? `Starting a new native ${getAgentProvider(agentCli)} session. Previous session available as optional reference: ${nativeSessionId}`
      : `Starting a new native ${getAgentProvider(agentCli)} session.`,
    `User supplement:\n${request}`,
    attachedFiles.length > 0 ? `Attached files:\n${attachedFiles.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  const executionLogId = syncEngine.logAgentExecution(
    soloConversationId,
    agentCli,
    `${agentCli} [preparing isolated run]`,
    launchSummary,
    'Running'
  );
  const runDir = path.join(activeProjectRoot, '.solopreneur', 'agent-runs', soloConversationId, String(executionLogId));
  const roadmapPath = path.join(activeProjectRoot, '.solopreneur', 'roadmap.csv');
  const roadmapBackupFilePath = path.join(runDir, 'roadmap-before.csv');
  fs.mkdirSync(runDir, { recursive: true });
  if (fs.existsSync(roadmapPath)) {
    fs.writeFileSync(roadmapBackupFilePath, fs.readFileSync(roadmapPath, 'utf8'), 'utf8');
  }
  const conversationPrompt = buildSoloConversationPrompt(request, activeProjectRoot, settings.globalPrompt, attachedFiles, settings.globalDataPath, settings.enabledEnhancements);
  const agentCommand = buildAgentCommandForPromptFile(agentCli, path.join(runDir, 'prompt.txt'), activeProjectRoot, settings.taskPermissionMode, selectedModel);
  syncEngine.updateAgentExecution(
    executionLogId,
    agentCli,
    agentCommand,
    launchSummary,
    'Running'
  );
  postNodeConversations(soloConversationId);

  const { finalCommand } = buildAgentShellScript(
    agentCli,
    selectedModel,
    conversationPrompt,
    activeProjectRoot,
    soloConversationId,
    executionLogId,
    request,
    undefined,
    nativeSessionId,
    '',
    'solo',
    roadmapBackupFilePath,
    settings.globalDataPath,
    settings.taskPermissionMode,
    settings.reviewerCliPath,
    settings.collaborationReviewMode,
    settings.enabledEnhancements,
    runDir,
    getAgentStatusFilePath(activeProjectRoot, executionLogId)
  );
  const terminal = createAgentTerminal(activeProjectRoot, `solo-${executionLogId}`, executionLogId);
  terminal.show(true);
  terminal.sendText(finalCommand);
}

function getCurrentFlowTrace(projectPath: string): FlowTrace | null {
  return buildFlowStatePayload(projectPath, true).flow;
}

async function startFlowRoleRun(
  context: vscode.ExtensionContext,
  input: {
    projectPath: string;
    flow: FlowTrace;
    loopIndex: number;
    role: FlowRole;
    prompt: string;
    selectedAgentCli?: string;
    selectedModel?: string;
  }
): Promise<void> {
  if (!syncEngine) {
    return;
  }
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (input.selectedAgentCli || input.flow.source.selectedAgentCli || settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, input.selectedAgentCli ? '' : settings.cliPath);
  if (!commandExists(agentCli)) {
    throw new Error(`Flow Agent CLI not found: ${requestedAgentCli || agentCli}`);
  }
  const automation = ensureAgentTaskAutomation(agentCli);
  if (!automation.ok) {
    throw new Error(automation.message);
  }
  const loop = input.flow.loops.find((candidate) => candidate.index === input.loopIndex);
  if (!loop) {
    throw new Error(`Flow loop ${input.loopIndex} not found.`);
  }
  const nodeId = buildFlowExecutionNodeId(input.flow.flowId, loop.loopId, input.role);
  const launchSummary = [
    `Flow ${input.role} started.`,
    `Flow ID: ${input.flow.flowId}`,
    `Loop ID: ${loop.loopId}`,
    `Run started at: ${new Date().toISOString()}`,
    `Goal:\n${input.flow.goal}`
  ].join('\n\n');
  const executionLogId = syncEngine.logAgentExecution(
    nodeId,
    agentCli,
    `${agentCli} [flow ${input.role}]`,
    launchSummary,
    'Running'
  );
  const runDir = path.join(input.projectPath, '.solopreneur', 'flows', input.flow.flowId, loop.loopId, input.role, String(executionLogId));
  const statusFilePath = getAgentStatusFilePath(input.projectPath, executionLogId);
  const effectiveModel = input.selectedModel || input.flow.source.selectedModel || '';
  const agentCommand = buildAgentCommandForPromptFile(agentCli, path.join(runDir, 'prompt.txt'), input.projectPath, settings.taskPermissionMode, effectiveModel);
  syncEngine.updateAgentExecution(executionLogId, agentCli, agentCommand, launchSummary, 'Running');
  updateFlowTrace(input.projectPath, input.flow.flowId, (trace) => {
    const nextTrace = { ...trace, status: 'running' as const };
    nextTrace.loops = trace.loops.map((candidate) => {
      if (candidate.index !== input.loopIndex) {
        return candidate;
      }
      const roleState = {
        status: 'running' as const,
        executionLogId,
        startedAt: new Date().toISOString(),
        command: agentCommand
      };
      return {
        ...candidate,
        status: input.role === 'planner' ? 'planned' : input.role === 'builder' ? 'building' : 'verifying',
        updatedAt: new Date().toISOString(),
        planner: input.role === 'planner' ? roleState : candidate.planner,
        builder: input.role === 'builder' ? roleState : candidate.builder,
        verifier: input.role === 'verifier' ? roleState : candidate.verifier
      };
    });
    return nextTrace;
  });
  await postFlowStateToWebview(context);
  const { finalCommand } = buildAgentShellScript(
    agentCli,
    effectiveModel,
    input.prompt,
    input.projectPath,
    nodeId,
    executionLogId,
    input.flow.goal,
    undefined,
    '',
    '',
    `flow_${input.role}`,
    '',
    settings.globalDataPath,
    settings.taskPermissionMode,
    '',
    'off',
    settings.enabledEnhancements,
    runDir,
    statusFilePath
  );
  const terminal = createAgentTerminal(input.projectPath, `flow-${input.flow.flowId}-${input.role}-${executionLogId}`, executionLogId);
  terminal.show(true);
  terminal.sendText(finalCommand);
}

async function handleRunFlow(
  context: vscode.ExtensionContext,
  goal: string,
  selectedAgentCli = '',
  selectedModel = '',
  supplementFiles: string[] = []
): Promise<void> {
  if (!activeProjectRoot || !syncEngine) {
    return;
  }
  const request = String(goal || '').trim();
  if (!request) {
    vscode.window.showWarningMessage('先写下你想让 Flow 自动推进完成的目标。');
    return;
  }
  if (!await hasFlowModeAccess(context)) {
    const choice = await vscode.window.showInformationMessage('Flow 是 SoloMap Pro 功能。', '升级 Pro');
    if (choice === '升级 Pro') {
      await beginPassportAuthorizationFlow(context);
    }
    await postFlowStateToWebview(context);
    return;
  }
  await syncEngine.initAndSync();
  const trace = createFlowTrace(activeProjectRoot, request, {
    supplementFiles,
    selectedAgentCli,
    selectedModel
  });
  trace.loops = [createFlowLoop(request, 1)];
  saveFlowTrace(activeProjectRoot, trace);
  await postFlowStateToWebview(context);
  await startFlowRoleRun(context, {
    projectPath: activeProjectRoot,
    flow: trace,
    loopIndex: 1,
    role: 'planner',
    prompt: buildFlowPlannerPrompt({
      goal: request,
      workspaceRoot: activeProjectRoot,
      flowId: trace.flowId,
      loopId: 'loop-1',
      globalPrompt: getPersistedSettings(context).globalPrompt,
      supplementFiles
    }),
    selectedAgentCli,
    selectedModel
  });
}

function linkSoloConversationToNode(conversationId: number, nodeId: string): void {
  if (!syncEngine || !conversationId || !nodeId) {
    return;
  }
  const node = syncEngine.getNodes().find((candidate) => candidate.id === nodeId);
  const conversation = syncEngine.getAgentExecutions(soloConversationId)
    .find((entry) => Number(entry.id) === conversationId);
  if (!node || !conversation || conversation.status === 'Running') {
    vscode.window.showWarningMessage('This Solo conversation cannot be associated with that step.');
    return;
  }
  const marker = `Solo reference ID: ${conversationId}`;
  if (syncEngine.getAgentExecutions(nodeId).some((entry) => String(entry.output || '').includes(marker))) {
    vscode.window.showInformationMessage('This Solo conversation is already associated with that step.');
    return;
  }
  syncEngine.logAgentExecution(
    nodeId,
    conversation.agentCli,
    conversation.command,
    [
      'Linked from Solo conversation.',
      marker,
      `Linked at: ${new Date().toISOString()}`,
      `Original Solo status: ${conversation.status}`,
      '',
      conversation.output
    ].join('\n'),
    'Linked'
  );
  postNodeConversations(nodeId);
  postNodeConversations(soloConversationId);
  vscode.window.showInformationMessage(`Solo conversation associated with step: ${node.title}`);
}

function createPreSessionGitCommit(projectPath: string): string | null {
  try {
    const isRepo = childProcess.spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectPath,
      encoding: 'utf8'
    });
    if (isRepo.status !== 0) {
      return null;
    }
    
    const statusResult = childProcess.spawnSync('git', ['status', '--porcelain'], {
      cwd: projectPath,
      encoding: 'utf8'
    });
    const hasChanges = statusResult.status === 0 && statusResult.stdout.trim().length > 0;
    
    if (hasChanges) {
      childProcess.spawnSync('git', ['add', '-A'], { cwd: projectPath });
      const commitMsg = `SoloMap pre-session auto-backup [${new Date().toISOString()}]`;
      childProcess.spawnSync('git', ['commit', '-m', commitMsg, '--no-verify'], { cwd: projectPath });
    }
    
    const revResult = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf8'
    });
    if (revResult.status === 0) {
      return revResult.stdout.trim();
    }
  } catch (err) {
    console.error('Failed to create pre-session git commit:', err);
  }
  return null;
}

function getGitCommandOutput(projectPath: string, args: string[]): string {
  const result = childProcess.spawnSync('git', args, {
    cwd: projectPath,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  }
  return String(result.stdout || '').trim();
}

function moveUntrackedFilesToRollbackSafety(projectPath: string): string {
  const listResult = childProcess.spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: projectPath,
    encoding: 'buffer'
  });
  if (listResult.status !== 0) {
    throw new Error(String(listResult.stderr || 'Could not list untracked files.'));
  }
  const untrackedFiles = Buffer.from(listResult.stdout || Buffer.alloc(0))
    .toString('utf8')
    .split('\0')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !item.startsWith('.solopreneur/rollback-safety/'));
  if (untrackedFiles.length === 0) {
    return '';
  }

  const safeStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyRoot = path.join(projectPath, '.solopreneur', 'rollback-safety', safeStamp);
  for (const relativeFile of untrackedFiles) {
    const sourcePath = path.resolve(projectPath, relativeFile);
    if (!sourcePath.startsWith(path.resolve(projectPath) + path.sep) || !fs.existsSync(sourcePath)) {
      continue;
    }
    const targetPath = path.join(safetyRoot, relativeFile);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(sourcePath, targetPath);
  }
  return path.relative(projectPath, safetyRoot);
}

async function rollbackProjectToPreSessionGitHash(context: vscode.ExtensionContext, projectPath: string, gitHash: string): Promise<void> {
  const normalizedProjectPath = String(projectPath || '').trim();
  const normalizedGitHash = String(gitHash || '').trim();
  if (!normalizedProjectPath || !/^[a-f0-9]{7,40}$/i.test(normalizedGitHash)) {
    vscode.window.showErrorMessage('Invalid rollback request.');
    return;
  }
  if (!getProjects(context).some((project) => project.path === normalizedProjectPath)) {
    vscode.window.showErrorMessage(`Project folder is not registered: ${normalizedProjectPath}`);
    return;
  }

  try {
    getGitCommandOutput(normalizedProjectPath, ['rev-parse', '--is-inside-work-tree']);
    const verifiedHash = getGitCommandOutput(normalizedProjectPath, ['rev-parse', '--verify', `${normalizedGitHash}^{commit}`]);
    const ancestorResult = childProcess.spawnSync('git', ['merge-base', '--is-ancestor', verifiedHash, 'HEAD'], {
      cwd: normalizedProjectPath,
      encoding: 'utf8'
    });
    if (ancestorResult.status !== 0 && verifiedHash !== getGitCommandOutput(normalizedProjectPath, ['rev-parse', 'HEAD'])) {
      vscode.window.showErrorMessage('回滚失败：这次对话记录的 Git 哈希不是当前分支的祖先提交。');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `确认撤销本次修改并恢复到对话开始前？未跟踪的新文件会先转移到 .solopreneur/rollback-safety，不会直接删除。提交：${verifiedHash.slice(0, 8)}`,
      { modal: true },
      '确认撤销'
    );
    if (confirm !== '确认撤销') {
      return;
    }

    const safetyDir = moveUntrackedFilesToRollbackSafety(normalizedProjectPath);
    const restoreRes = childProcess.spawnSync('git', ['restore', '--source', verifiedHash, '--staged', '--worktree', '--', '.'], {
      cwd: normalizedProjectPath,
      encoding: 'utf8'
    });
    if (restoreRes.status !== 0) {
      vscode.window.showErrorMessage(`回滚失败：${restoreRes.stderr || '未知 Git 错误'}`);
      return;
    }

    vscode.window.showInformationMessage(
      safetyDir
        ? `项目已恢复到 ${verifiedHash.slice(0, 8)}；未跟踪新文件已移到 ${safetyDir}`
        : `项目已恢复到 ${verifiedHash.slice(0, 8)}`
    );
    if (getSelectedProjectPath(context) !== normalizedProjectPath) {
      await selectProject(context, normalizedProjectPath);
    }
    if (syncEngine) {
      await syncEngine.initAndSync();
    }
    sendNodesToWebview();
    refreshSidebarProjectCards();
  } catch (error: any) {
    vscode.window.showErrorMessage(`执行回滚操作出错：${error?.message || error}`);
  }
}

/**
 * Executes a CLI agent in the integrated terminal.
 */
async function handleRunAgent(context: vscode.ExtensionContext, nodeId: string, userMessage: string, selectedAgentCli = '', selectedModel = '', supplementFiles: string[] = []) {
  if (!syncEngine) {
    return;
  }

  const workspaceRoot = activeProjectRoot || '';
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Choose a project folder before running an Agent task.');
    return;
  }

  await syncEngine.initAndSync();
  sendNodesToWebview();

  const nodes = syncEngine.getNodes();
  const node = nodes.find((n) => n.id === nodeId);

  if (!node) {
    vscode.window.showErrorMessage(`Node ${nodeId} not found`);
    return;
  }

  const attachedFiles = filterProjectRelativeFiles(workspaceRoot, supplementFiles);

  // Resolve CLI path from config if applicable
  const settings = getPersistedSettings(context);
  const configuredCliPath = settings.cliPath;
  const requestedAgentCli = (selectedAgentCli || node.agentCli || configuredCliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, selectedAgentCli ? '' : configuredCliPath);

  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, selectedAgentCli ? '' : configuredCliPath).join(', ');
    const failureReason = `Agent CLI not found. Tried: ${candidates}.`;
    syncEngine.updateNode(nodeId, { status: 'Failed', completedAt: '' });
    syncEngine.logAgentExecution(
      nodeId,
      requestedAgentCli || agentCli,
      requestedAgentCli || agentCli,
      [
        userMessage.trim() ? `User supplement:\n${userMessage.trim()}` : '',
        'Failure category: cli_not_found',
        `Failure reason:\n${failureReason}`
      ].filter(Boolean).join('\n\n'),
      'Failed'
    );
    sendNodesToWebview();
    postNodeConversations(nodeId);
    vscode.window.showErrorMessage(`${failureReason} Set SoloMap CLI Command or Path to an installed executable such as agy or codex.`);
    return;
  }
  const automation = ensureAgentTaskAutomation(agentCli);
  if (!automation.ok) {
    syncEngine.updateNode(nodeId, { status: 'Failed', completedAt: '' });
    syncEngine.logAgentExecution(
      nodeId,
      agentCli,
      agentCli,
      [
        userMessage.trim() ? `User supplement:\n${userMessage.trim()}` : '',
        'Failure category: agent_automation_not_ready',
        `Failure reason:\n${automation.message}`
      ].filter(Boolean).join('\n\n'),
      'Failed'
    );
    sendNodesToWebview();
    postNodeConversations(nodeId);
    vscode.window.showErrorMessage(automation.message);
    return;
  }

  // Update node status to Running
  recordLocalUsageEvent(context, 'agentRun');
  syncEngine.updateNode(nodeId, { status: 'Running' });
  sendNodesToWebview();
  refreshSidebarProjectCards();

  const storedSession = getStoredAgentSession(workspaceRoot, nodeId, agentCli);
  const nativeSessionId = storedSession?.sessionId || '';
  const preGitHash = createPreSessionGitCommit(workspaceRoot);
  const launchSummary = [
    preGitHash ? `SoloMapPreGitHash: ${preGitHash}` : '',
    'Agent conversation started.',
    `Run started at: ${new Date().toISOString()}`,
    nativeSessionId
      ? `Starting a new native ${getAgentProvider(agentCli)} session. Previous session available as optional reference: ${nativeSessionId}`
      : `Starting a new native ${getAgentProvider(agentCli)} session.`,
    userMessage.trim() ? `User supplement:\n${userMessage.trim()}` : '',
    attachedFiles.length ? `Attached files:\n${attachedFiles.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  const executionLogId = syncEngine.logAgentExecution(
    nodeId,
    agentCli,
    `${agentCli} [preparing isolated run]`,
    launchSummary,
    'Running'
  );
  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId, String(executionLogId));
  const statusFilePath = getAgentStatusFilePath(workspaceRoot, executionLogId);
  const completionDecisionFilePath = path.join(runDir, 'completion.json');
  const stepMemoryFilePath = getStepMemoryFilePath(workspaceRoot, nodeId);
  const githubIssueContext = buildGithubIssueContext(workspaceRoot, node);
  ensureRoadmapValidationScript(path.join(workspaceRoot, '.solopreneur'));
  ensureSolomapMemoryStore(workspaceRoot, settings.globalDataPath);
  const conversationPrompt = buildAgentConversationPrompt(
    node,
    userMessage,
    workspaceRoot,
    stepMemoryFilePath,
    runDir,
    completionDecisionFilePath,
    nativeSessionId,
    attachedFiles,
    settings.globalPrompt,
    githubIssueContext,
    settings.globalDataPath,
    settings.enabledEnhancements
  );
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot, settings.taskPermissionMode, selectedModel);
  syncEngine.updateAgentExecution(executionLogId, agentCli, agentCommand, launchSummary, 'Running');
  postNodeConversations(nodeId);

  const { finalCommand } = buildAgentShellScript(agentCli, selectedModel, conversationPrompt, workspaceRoot, nodeId, executionLogId, userMessage.trim(), completionDecisionFilePath, nativeSessionId, '', 'step', '', settings.globalDataPath, settings.taskPermissionMode, settings.reviewerCliPath, settings.collaborationReviewMode, settings.enabledEnhancements, runDir, statusFilePath);

  const terminal = createAgentTerminal(workspaceRoot, `step-${nodeId}-${executionLogId}`, executionLogId);
  terminal.show(true);
  terminal.sendText(finalCommand);
}

function extractUserSupplementFromExecutionOutput(output: string): string {
  const text = String(output || '');
  const match = text.match(/User supplement:\n([\s\S]*?)(?:\n\n(?:Sentinel captured state:|Native session mode:|Roadmap step state:|Workspace changes:|Touched project files:|Agent output tail:)|$)/);
  return match ? match[1].trim() : '';
}

async function handleRetryConversation(context: vscode.ExtensionContext, nodeId: string, conversationId: number): Promise<void> {
  if (!syncEngine || !nodeId || !conversationId) {
    return;
  }

  const conversation = syncEngine.getAgentExecutions(nodeId).find((item) => Number(item.id) === Number(conversationId));
  if (!conversation) {
    vscode.window.showErrorMessage(`Conversation ${conversationId} not found for step ${nodeId}.`);
    return;
  }

  if (conversation.status !== 'Failed') {
    vscode.window.showWarningMessage('Only failed Agent conversations can be retried.');
    return;
  }

  const retryUserMessage = extractUserSupplementFromExecutionOutput(conversation.output || '');
  if (nodeId === roadmapRevisionId) {
    await handleRoadmapRevision(context, retryUserMessage, conversation.agentCli || '');
    return;
  }
  if (nodeId === soloConversationId) {
    await handleRunSoloConversation(context, retryUserMessage, conversation.agentCli || '');
    return;
  }
  await handleRunAgent(context, nodeId, retryUserMessage, conversation.agentCli || '');
}

function didRoadmapCsvChange(changedFilesSummary: string, touchedFilesSummary: string): boolean {
  const combined = [changedFilesSummary, touchedFilesSummary].join('\n');
  return combined.includes('.solopreneur/roadmap.csv');
}

function validateBootstrapRoadmapRewrite(workspaceRoot: string, nodeId: string): { valid: boolean; reason: string } {
  const roadmapPath = path.join(workspaceRoot, '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    return { valid: false, reason: '未找到 .solopreneur/roadmap.csv。' };
  }

  try {
    const content = fs.readFileSync(roadmapPath, 'utf8');
    const parsed = Papa.parse<RoadmapNode>(content, { header: true, skipEmptyLines: true });
    const requiredColumns = ['id', 'title', 'description', 'stage', 'dependencies', 'agentCli', 'agentPrompt', 'status', 'createdAt', 'completedAt'];
    const fields = parsed.meta.fields || [];
    const nodes = parsed.data.map((node) => ({
      id: String(node.id || '').trim(),
      title: String(node.title || '').trim(),
      description: String(node.description || '').trim(),
      stage: String(node.stage || '').trim(),
      dependencies: String(node.dependencies || '').trim(),
      agentCli: String(node.agentCli || '').trim(),
      agentPrompt: String(node.agentPrompt || '').trim(),
      status: String(node.status || '').trim()
    })).filter((node) => node.id);
    const bootstrapMarkers = [
      '你的唯一主任务是直接重写 .solopreneur/roadmap.csv',
      '你的唯一交付物是直接重写 .solopreneur/roadmap.csv',
      '保留 CSV 表头且字段顺序必须严格是',
      '生成初始路线图',
      '.solopreneur/bootstrap-roadmap-instructions.md',
      '不要把本文件内容、提示词模板或解释性说明写回 CSV'
    ];

    if (parsed.errors.length > 0 || requiredColumns.some((field) => !fields.includes(field))) {
      return { valid: false, reason: '生成后的 roadmap.csv 格式不完整或无法被稳定解析。' };
    }
    if (nodes.length < 2 || nodes.length > 8) {
      return { valid: false, reason: '生成后的路线图环节数量不在 2 到 8 个之间。' };
    }
    if (nodes.some((node) => !node.title || !node.description || !node.agentPrompt)) {
      return { valid: false, reason: '生成后的路线图存在缺少标题、描述或 agentPrompt 的环节。' };
    }
    if (nodes.some((node) => !node.stage)) {
      return { valid: false, reason: '生成后的路线图存在缺少 stage 的环节。' };
    }
    const ids = nodes.map((node) => node.id);
    const idSet = new Set(ids);
    if (idSet.size !== ids.length) {
      return { valid: false, reason: '生成后的路线图存在重复环节 ID。' };
    }
    for (const node of nodes) {
      const dependencies = node.dependencies.split(',').map((entry) => entry.trim()).filter(Boolean);
      if (dependencies.includes(node.id) || dependencies.some((entry) => !idSet.has(entry))) {
        return { valid: false, reason: '生成后的路线图存在无效依赖关系。' };
      }
    }
    if (nodes.some((node) => node.status !== 'Pending')) {
      return { valid: false, reason: '生成后的路线图所有环节都必须回到 Pending。' };
    }
    if (nodes.some((node) => bootstrapMarkers.some((marker) => node.title.includes(marker) || node.agentPrompt.includes(marker)))) {
      return { valid: false, reason: '生成后的 roadmap.csv 仍然残留了初始化提示词，没有真正写成业务路线图。' };
    }
    if (nodes.some((node) => node.title === '生成初始路线图')) {
      return { valid: false, reason: '生成后的路线图仍然保留了原始 bootstrap 节点。' };
    }
    return { valid: true, reason: '' };
  } catch (error: any) {
    return { valid: false, reason: `生成后的 roadmap.csv 校验失败：${error?.message || error}` };
  }
}

function validateRoadmapRevision(workspaceRoot: string): { valid: boolean; reason: string } {
  const roadmapPath = path.join(workspaceRoot, '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    return { valid: false, reason: '调整后的路线图文件不存在。' };
  }
  try {
    const parsed = Papa.parse<RoadmapNode>(fs.readFileSync(roadmapPath, 'utf8'), {
      header: true,
      skipEmptyLines: true
    });
    const requiredColumns = ['id', 'title', 'description', 'stage', 'dependencies', 'agentCli', 'agentPrompt', 'status', 'createdAt', 'completedAt'];
    const fields = parsed.meta.fields || [];
    if (parsed.errors.length > 0 || requiredColumns.some((field) => !fields.includes(field))) {
      return { valid: false, reason: '调整后的 roadmap.csv 格式不完整或无法解析。' };
    }
    const nodes = parsed.data
      .map((node) => ({
        ...node,
        id: String(node.id || '').trim(),
        title: String(node.title || '').trim(),
        description: String(node.description || '').trim(),
        agentPrompt: String(node.agentPrompt || '').trim(),
        dependencies: String(node.dependencies || '').trim(),
        status: String(node.status || '').trim()
      }))
      .filter((node) => node.id);
    if (nodes.length === 0) {
      return { valid: false, reason: '调整后的路线图没有可执行环节。' };
    }
    const ids = nodes.map((node) => node.id);
    const idSet = new Set(ids);
    if (idSet.size !== ids.length) {
      return { valid: false, reason: '调整后的路线图存在重复环节 ID。' };
    }
    if (nodes.some((node) => !node.title || !String(node.stage || '').trim() || !node.description || !node.agentPrompt)) {
      return { valid: false, reason: '调整后的路线图存在缺少标题、阶段、描述或 Agent 任务的环节。' };
    }
    const allowedStatuses = new Set(['Pending', 'In Progress', 'Running', 'Completed', 'Failed']);
    if (nodes.some((node) => !allowedStatuses.has(node.status))) {
      return { valid: false, reason: '调整后的路线图存在无法识别的环节状态。' };
    }
    for (const node of nodes) {
      const dependencies = node.dependencies.split(',').map((entry) => entry.trim()).filter(Boolean);
      if (dependencies.includes(node.id) || dependencies.some((entry) => !idSet.has(entry))) {
        return { valid: false, reason: '调整后的路线图存在无效依赖关系。' };
      }
    }
    return { valid: true, reason: '' };
  } catch (error: any) {
    return { valid: false, reason: `调整后的路线图校验失败：${error?.message || error}` };
  }
}

function restoreRoadmapBackup(roadmapBackupFilePath: string, workspaceRoot: string): boolean {
  if (!roadmapBackupFilePath || !fs.existsSync(roadmapBackupFilePath)) {
    return false;
  }
  fs.writeFileSync(
    path.join(workspaceRoot, '.solopreneur', 'roadmap.csv'),
    fs.readFileSync(roadmapBackupFilePath, 'utf8'),
    'utf8'
  );
  return true;
}

function readTextFileSafe(filePath: string): string {
  try {
    return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

async function processFlowStatusFile(statusFilePath: string, statusData: any): Promise<boolean> {
  const flowMeta = parseFlowExecutionNodeId(String(statusData.nodeId || ''));
  if (!flowMeta || !syncEngine || !activeProjectRoot) {
    return false;
  }
  const { flowId, loopId, role } = flowMeta;
  if (String(statusData.status || '') === 'Running' || String(statusData.status || '') === 'Processed') {
    return true;
  }
  const flow = readFlowTrace(activeProjectRoot, flowId);
  if (!flow) {
    return true;
  }
  const loop = flow.loops.find((candidate) => candidate.loopId === loopId);
  if (!loop) {
    return true;
  }
  const executionLogId = Number(statusData.executionLogId || 0);
  const outputText = readTextFileSafe(String(statusData.outputFilePath || ''));
  const outputTail = getOutputTail(String(statusData.outputFilePath || ''));
  const changedFilesSummary = getChangedFilesSummary(String(statusData.changesFilePath || ''));
  const touchedFilesSummary = getTouchedFilesSummary(String(statusData.touchedFilesPath || ''));
  const resolvedCommand = String(readTextFileSafe(String(statusData.commandFilePath || '')) || statusData.commandPreview || '').trim();
  const structured = extractFlowJsonBlock(outputText || outputTail);
  const validationErrors = role === 'planner'
    ? validateFlowPlannerResult(structured)
    : role === 'builder'
      ? validateFlowBuilderResult(structured)
      : validateFlowVerifierResult(structured);
  const finishedAt = new Date().toISOString();
  const currentRetryCount = Number((loop as any)[role]?.retryCount || 0);
  if (validationErrors.length > 0 && currentRetryCount < 2) {
    const nextRetryCount = currentRetryCount + 1;
    const roleExecution: import('./flowStore').FlowRoleExecution = {
      status: 'running' as const,
      executionLogId,
      startedAt: new Date().toISOString(),
      command: resolvedCommand,
      outputTail,
      validationErrors,
      data: structured || undefined,
      retryCount: nextRetryCount
    };

    const feedbackPrompt = [
      `你在上一轮执行中产出的结构化 JSON 未通过校验，请根据以下校验错误信息进行自检修正，并重新输出完整的 JSON（包在 SOLOMAP_FLOW_JSON_START 和 SOLOMAP_FLOW_JSON_END 之间）：`,
      ...validationErrors.map(err => `- ${err}`),
      '',
      '你上一轮输出的日志尾部是：',
      outputTail,
      '',
      '请重新输出，确保所有必填字段齐全，JSON 可被合法解析。'
    ].join('\n');

    const summaryLines = [
      `Flow ${role} validation failed. Retrying correction (${nextRetryCount}/2).`,
      `Flow ID: ${flowId}`,
      `Loop ID: ${loopId}`,
      validationErrors.length ? `Validation errors:\n${validationErrors.join('\n')}` : '',
      `Workspace changes:\n${changedFilesSummary || '无'}`,
      `Touched project files:\n${touchedFilesSummary || '无'}`,
      outputTail ? `Agent output tail:\n${outputTail}` : ''
    ].filter(Boolean).join('\n\n');

    syncEngine.updateAgentExecution(
      executionLogId,
      String(statusData.agentCli || ''),
      resolvedCommand,
      summaryLines,
      'Running'
    );

    const nextFlow = updateFlowTrace(activeProjectRoot, flowId, (trace) => {
      trace.loops = trace.loops.map((candidate) => {
        if (candidate.loopId !== loopId) {
          return candidate;
        }
        const nextLoop = { ...candidate, updatedAt: finishedAt };
        (nextLoop as any)[role] = roleExecution;
        nextLoop.status = role === 'planner' ? 'created' : role === 'builder' ? 'planned' : 'evidence_collected';
        return nextLoop;
      });
      trace.status = 'running';
      trace.latestSummary = `Flow ${role} 结构校验失败，正在进行第 ${nextRetryCount} 次自检修正。`;
      return trace;
    });

    if (nextFlow) {
      if (extensionContextRef) {
        await postFlowStateToWebview(extensionContextRef);
      }
      await startFlowRoleRun(extensionContextRef!, {
        projectPath: activeProjectRoot,
        flow: nextFlow,
        loopIndex: loop.index,
        role: role,
        prompt: feedbackPrompt
      });
      return true;
    }
  }

  const roleExecution: import('./flowStore').FlowRoleExecution = {
    status: (String(statusData.status || '') === 'In Progress' && validationErrors.length === 0 ? 'completed' : 'failed') as 'completed' | 'failed',
    executionLogId,
    finishedAt,
    command: resolvedCommand,
    outputTail,
    validationErrors,
    data: structured || undefined,
    retryCount: currentRetryCount
  };
  const summaryLines = [
    `Flow ${role} finished.`,
    `Flow ID: ${flowId}`,
    `Loop ID: ${loopId}`,
    `Sentinel captured state: ${String(statusData.status || '')}`,
    validationErrors.length ? `Validation errors:\n${validationErrors.join('\n')}` : '',
    `Workspace changes:\n${changedFilesSummary || '无'}`,
    `Touched project files:\n${touchedFilesSummary || '无'}`,
    outputTail ? `Agent output tail:\n${outputTail}` : ''
  ].filter(Boolean).join('\n\n');
  syncEngine.updateAgentExecution(
    executionLogId,
    String(statusData.agentCli || ''),
    resolvedCommand,
    summaryLines,
    roleExecution.status === 'completed' ? 'Completed' : 'Failed'
  );

  const nextFlow = updateFlowTrace(activeProjectRoot, flowId, (trace) => {
    trace.loops = trace.loops.map((candidate) => {
      if (candidate.loopId !== loopId) {
        return candidate;
      }
      const nextLoop: typeof candidate = {
        ...candidate,
        updatedAt: finishedAt,
        summary: structured?.summary ? String(structured.summary) : candidate.summary
      };
      if (role === 'planner') {
        nextLoop.planner = roleExecution;
        nextLoop.status = roleExecution.status === 'completed' ? 'planned' : 'planning_incomplete';
      } else if (role === 'builder') {
        nextLoop.builder = roleExecution;
        nextLoop.evidence = {
          changedFilesSummary,
          touchedFilesSummary,
          outputTail,
          commandFilePath: String(statusData.commandFilePath || ''),
          outputFilePath: String(statusData.outputFilePath || ''),
          changesFilePath: String(statusData.changesFilePath || ''),
          touchedFilesPath: String(statusData.touchedFilesPath || '')
        };
        nextLoop.status = roleExecution.status === 'completed'
          ? (changedFilesSummary.trim() || touchedFilesSummary.trim() ? 'evidence_collected' : 'no_effect')
          : 'no_effect';
      } else {
        nextLoop.verifier = roleExecution;
        nextLoop.scoring = deriveFlowLoopScoring(structured, changedFilesSummary, touchedFilesSummary);
        nextLoop.status = roleExecution.status === 'completed' ? nextLoop.scoring.recommendedStatus : 'implemented_unverified';
      }
      return nextLoop;
    });
    const currentLoop = trace.loops.find((candidate) => candidate.loopId === loopId);
    trace.latestSummary = currentLoop?.summary || trace.latestSummary;
    if (role === 'verifier' && currentLoop?.scoring?.recommendedStatus === 'closed') {
      trace.status = 'completed';
      trace.completedAt = finishedAt;
      trace.latestSummary = currentLoop.summary || currentLoop.scoring.reasons.join('；') || 'Flow 已完成目标。';
    } else if (role === 'verifier' && currentLoop?.scoring?.recommendedStatus === 'needs_user_confirmation') {
      trace.status = 'needs_user_confirmation';
      trace.latestSummary = currentLoop.summary || 'Flow 需要用户确认后才能继续。';
    } else if (roleExecution.status === 'failed') {
      trace.status = 'failed';
      trace.latestSummary = `Flow ${role} 未通过。`;
    } else {
      trace.status = 'running';
    }
    return trace;
  });
  if (!nextFlow) {
    return true;
  }
  if (extensionContextRef) {
    await postFlowStateToWebview(extensionContextRef);
  }

  if (role === 'planner' && roleExecution.status === 'completed') {
    await startFlowRoleRun(extensionContextRef!, {
      projectPath: activeProjectRoot,
      flow: nextFlow,
      loopIndex: loop.index,
      role: 'builder',
      prompt: buildFlowBuilderPrompt({
        goal: nextFlow.goal,
        workspaceRoot: activeProjectRoot,
        flowId,
        loopId,
        planner: structured || {},
        globalPrompt: getPersistedSettings(extensionContextRef!).globalPrompt,
        supplementFiles: nextFlow.source.supplementFiles || []
      })
    });
  } else if (role === 'builder' && roleExecution.status === 'completed') {
    const updatedLoop = readFlowTrace(activeProjectRoot, flowId)?.loops.find((candidate) => candidate.loopId === loopId);
    await startFlowRoleRun(extensionContextRef!, {
      projectPath: activeProjectRoot,
      flow: readFlowTrace(activeProjectRoot, flowId) || nextFlow,
      loopIndex: loop.index,
      role: 'verifier',
      prompt: buildFlowVerifierPrompt({
        goal: nextFlow.goal,
        workspaceRoot: activeProjectRoot,
        flowId,
        loopId,
        planner: updatedLoop?.planner.data || {},
        builder: structured || {},
        evidence: {
          changedFilesSummary,
          touchedFilesSummary,
          outputTail
        },
        globalPrompt: getPersistedSettings(extensionContextRef!).globalPrompt,
        supplementFiles: nextFlow.source.supplementFiles || []
      })
    });
  } else if (role === 'verifier' && roleExecution.status === 'completed') {
    const latest = readFlowTrace(activeProjectRoot, flowId);
    const latestLoop = latest?.loops.find((candidate) => candidate.loopId === loopId);
    if (latest && latestLoop?.status === 'closed' && latest.source.roadmapStepId && syncEngine) {
      syncEngine.updateNode(latest.source.roadmapStepId, {
        status: 'Completed',
        completedAt: finishedAt
      });
      sendNodesToWebview();
      refreshSidebarProjectCards();
    }
    const shouldSpawnFollowup = latest && latestLoop && ['partial', 'implemented_unverified', 'verified_failed', 'deviated', 'needs_review', 'no_effect'].includes(latestLoop.status);
    if (shouldSpawnFollowup && latest && latest.currentLoopIndex < 6) {
      const nextLoopIndex = latest.currentLoopIndex + 1;
      const nextLoopGoal = String(structured?.nextLoopGoal || latestLoop?.summary || latest.goal).trim() || latest.goal;
      const spawned = updateFlowTrace(activeProjectRoot, flowId, (trace) => {
        trace.currentLoopIndex = nextLoopIndex;
        trace.loops = [
          ...trace.loops.map((candidate) => candidate.loopId === loopId ? { ...candidate, status: 'spawned_followup' as FlowLoopStatus, updatedAt: new Date().toISOString() } : candidate),
          createFlowLoop(nextLoopGoal, nextLoopIndex)
        ];
        trace.status = 'running';
        trace.latestSummary = `继续推进：${nextLoopGoal}`;
        return trace;
      });
      if (spawned) {
        await postFlowStateToWebview(extensionContextRef!);
        await startFlowRoleRun(extensionContextRef!, {
          projectPath: activeProjectRoot,
          flow: spawned,
          loopIndex: nextLoopIndex,
          role: 'planner',
          prompt: buildFlowPlannerPrompt({
            goal: nextLoopGoal,
            workspaceRoot: activeProjectRoot,
            flowId,
            loopId: `loop-${nextLoopIndex}`,
            globalPrompt: getPersistedSettings(extensionContextRef!).globalPrompt,
            supplementFiles: latest.source.supplementFiles || []
          })
        });
      }
    }
  }
  agentTerminalNamesByConversationId.delete(executionLogId);
  setTimeout(() => {
    const currentStatus = readAgentStatus(statusFilePath);
    if (currentStatus && Number(currentStatus.executionLogId || 0) === executionLogId && fs.existsSync(statusFilePath)) {
      fs.writeFileSync(statusFilePath, JSON.stringify({
        ...currentStatus,
        status: 'Processed',
        processedAt: new Date().toISOString()
      }), 'utf8');
    }
  }, 500);
  return true;
}

async function processAgentStatusFile(statusFilePath: string): Promise<void> {
  if (!fs.existsSync(statusFilePath)) {
    return;
  }

  try {
    const fileContent = fs.readFileSync(statusFilePath, 'utf8').trim();
    if (!fileContent) {
      return;
    }

    const statusData = JSON.parse(fileContent);
    if (parseFlowExecutionNodeId(String(statusData.nodeId || ''))) {
      await processFlowStatusFile(statusFilePath, statusData);
      return;
    }
    const { nodeId, runKind, roadmapBackupFilePath, globalDataPath, status, agentCli, command, commandPreview, commandFilePath, executionLogId, userMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath, sessionFilePath, sessionMode, startedAt, reviewerCliPath, collaborationReviewMode, reviewResultFilePath, reviewTargetStatus, reviewOfExecutionLogId } = statusData;

    if (!nodeId || !status || status === 'Running' || status === 'Processed' || !syncEngine) {
      return;
    }

    const isReviewRun = runKind === 'agent_review';
    const isSoloConversation = runKind === 'solo' || nodeId === soloConversationId;
    let nextStatus = status as RoadmapNode['status'];
    let completionReason = '';
    let failureCode = String(statusData.failureCode || '').trim();
    let failureReason = String(statusData.failureReason || '').trim();
    const currentNode = syncEngine.getNodes().find((candidate) => candidate.id === nodeId) || null;
    const hasOtherRunningConversationForNode = !isSoloConversation
      && !isReviewRun
      && nodeId !== roadmapRevisionId
      && syncEngine.getAgentExecutions(nodeId).some((conversation) => (
        conversation.status === 'Running'
        && Number(conversation.id || 0) !== Number(executionLogId || 0)
      ));
    let reviewResult: ReturnType<typeof parseAgentReviewResult> | null = null;
    if (isReviewRun && status === 'In Progress') {
      reviewResult = parseAgentReviewResult(String(reviewResultFilePath || ''));
      if (reviewResult.status === 'pass') {
        nextStatus = 'Completed';
        completionReason = reviewResult.summary || '副 Agent 复核通过。';
      } else if (reviewResult.status === 'revise') {
        nextStatus = 'In Progress';
        completionReason = reviewResult.summary || '副 Agent 发现需要继续修正的问题。';
      } else {
        nextStatus = 'In Progress';
        completionReason = reviewResult.summary || '副 Agent 认为需要用户确认。';
      }
    } else if (status === 'In Progress' && completionDecisionFilePath && fs.existsSync(completionDecisionFilePath)) {
      try {
        const completionDecision = JSON.parse(fs.readFileSync(completionDecisionFilePath, 'utf8'));
        if (completionDecision.markCompleted === true) {
          nextStatus = 'Completed';
          completionReason = completionDecision.reason || 'Agent marked this roadmap step complete.';
        }
      } catch (error) {
        nextStatus = 'Failed';
        failureCode = 'completion_state_invalid';
        failureReason = 'Agent completion decision file could not be parsed.';
        completionReason = 'Agent completion decision file could not be parsed.';
      }
    }

    const outputTail = getOutputTail(outputFilePath);
    const changedFilesSummary = getChangedFilesSummary(changesFilePath);
    const touchedFilesSummary = getTouchedFilesSummary(touchedFilesPath);
    const workspaceRoot = activeProjectRoot || (statusFilePath ? path.dirname(statusFilePath) : '');
    const roadmapCsvChanged = didRoadmapCsvChange(changedFilesSummary, touchedFilesSummary);
    // User-confirmed completion remains authoritative over any in-flight Agent result.
    const preserveCompletedNode = currentNode?.status === 'Completed';
    let shouldWriteNodeStatus = !preserveCompletedNode && !isSoloConversation;
    let shouldRefreshRoadmap = false;
    let reviewDeferredCompletion = false;
    if (isReviewRun) {
      shouldWriteNodeStatus = !preserveCompletedNode && !isSoloConversation;
      shouldRefreshRoadmap = false;
      if (reviewResult?.status === 'pass' && String(reviewTargetStatus || '') !== 'Completed') {
        shouldWriteNodeStatus = false;
      }
    } else if (workspaceRoot && isSoloConversation) {
      shouldWriteNodeStatus = false;
      if (status === 'In Progress') {
        nextStatus = 'Completed';
        completionReason = 'Solo 对话已完成，等待用户决定是否关联到路线图环节。';
      } else {
        nextStatus = 'Failed';
        failureCode = failureCode || 'agent_exit_failed';
        failureReason = failureReason || 'Agent CLI 在完成 Solo 对话前退出。';
        completionReason = failureReason;
      }
      if (roadmapCsvChanged && restoreRoadmapBackup(roadmapBackupFilePath, workspaceRoot)) {
        const protectedRoadmapReason = 'Solo 对话不会直接调整路线图，已保留对话前路线图。';
        completionReason = completionReason ? `${completionReason} ${protectedRoadmapReason}` : protectedRoadmapReason;
      }
    } else if (workspaceRoot && runKind === 'roadmap_revision') {
      shouldWriteNodeStatus = false;
      if (status === 'In Progress' && roadmapCsvChanged) {
        const validation = validateRoadmapRevision(workspaceRoot);
        if (validation.valid) {
          nextStatus = 'Completed';
          completionReason = '路线图已按本次要求更新并通过校验。';
          shouldRefreshRoadmap = true;
        } else {
          nextStatus = 'Failed';
          failureCode = 'roadmap_validation_failed';
          failureReason = `${validation.reason} 已保留调整前的路线图。`;
          completionReason = failureReason;
          restoreRoadmapBackup(roadmapBackupFilePath, workspaceRoot);
        }
      } else if (status === 'In Progress') {
        nextStatus = 'Failed';
        failureCode = 'roadmap_not_updated';
        failureReason = 'Agent 未更新路线图文件，原路线图保持不变。';
        completionReason = failureReason;
      } else {
        nextStatus = 'Failed';
        failureCode = failureCode || 'agent_exit_failed';
        failureReason = failureReason || 'Agent CLI 在完成路线图调整前退出。';
        if (roadmapCsvChanged && restoreRoadmapBackup(roadmapBackupFilePath, workspaceRoot)) {
          failureReason = `${failureReason} 已保留调整前的路线图。`;
        }
        completionReason = failureReason;
      }
    } else if (workspaceRoot && currentNode?.title === '生成初始路线图' && roadmapCsvChanged) {
      const validation = validateBootstrapRoadmapRewrite(workspaceRoot, nodeId);
      if (!validation.valid) {
        nextStatus = 'Failed';
        completionReason = validation.reason;
        failureCode = 'roadmap_validation_failed';
        failureReason = validation.reason;
      } else {
        shouldWriteNodeStatus = false;
        shouldRefreshRoadmap = true;
        if (!completionReason) {
          completionReason = '初始路线图已写入 roadmap.csv，并通过结构校验。';
        }
      }
    } else if (workspaceRoot && roadmapCsvChanged) {
      shouldWriteNodeStatus = false;
      shouldRefreshRoadmap = true;
    }
    const shouldStartReview = workspaceRoot && !isReviewRun && shouldRunAgentReview(
      collaborationReviewMode === undefined ? 'off' : String(collaborationReviewMode || 'high_risk'),
      String(runKind || 'step'),
      String(nodeId || ''),
      nextStatus,
      changedFilesSummary,
      touchedFilesSummary
    );
    if (shouldStartReview && shouldWriteNodeStatus && nextStatus === 'Completed') {
      reviewDeferredCompletion = true;
      nextStatus = 'In Progress';
      completionReason = completionReason
        ? `${completionReason} 正在等待副 Agent 复核。`
        : '主 Agent 已标记完成，正在等待副 Agent 复核。';
    }
    if (shouldWriteNodeStatus) {
      let nodeStatus = nextStatus;
      if (hasOtherRunningConversationForNode) {
        nodeStatus = 'Running';
        completionReason = completionReason
          ? `${completionReason} 该环节仍有其他 Agent 对话正在运行。`
          : '该环节仍有其他 Agent 对话正在运行。';
      }
      const completedAt = nodeStatus === 'Completed' ? new Date().toISOString() : '';
      syncEngine.updateNode(nodeId, {
        status: nodeStatus,
        completedAt,
      });
      refreshSidebarProjectCards();
    }
    let nativeSessionSummary = '';
    if (workspaceRoot && sessionFilePath && fs.existsSync(sessionFilePath)) {
      try {
        const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
        const sessionId = String(sessionData.sessionId || '').trim();
        if (sessionId) {
          updateStoredAgentSession(workspaceRoot, nodeId, agentCli || command || 'unknown', sessionId);
          nativeSessionSummary = `Native Agent session saved: ${getStepSessionFilePath(workspaceRoot, nodeId)} (${sessionId})`;
        }
      } catch {
        nativeSessionSummary = 'Native Agent session could not be parsed.';
      }
    }
    const resolvedCommand = commandFilePath && fs.existsSync(commandFilePath)
      ? fs.readFileSync(commandFilePath, 'utf8').trim()
      : command || commandPreview || 'Completed execution in terminal';
    if (nextStatus === 'Failed' && !failureReason) {
      failureCode = failureCode || 'agent_exit_failed';
      failureReason = completionReason || 'Agent CLI exited before completing this task.';
    }
    const finishedAt = new Date().toISOString();
    const startedTime = startedAt ? Date.parse(String(startedAt)) : NaN;
    const runDurationMs = Number.isFinite(startedTime) ? Math.max(0, Date.now() - startedTime) : 0;
    const handoffEntry = workspaceRoot && runKind !== 'roadmap_revision' && !isSoloConversation && !isReviewRun
      ? buildRunHandoffEntry(
        nextStatus,
        [changedFilesSummary, touchedFilesSummary].filter(Boolean).join('\n'),
        outputTail,
        completionReason
      )
      : '';
    const stepHandoffSummary = workspaceRoot && handoffEntry
      ? updateStepHandoffSummary(getStepMemoryFilePath(workspaceRoot, nodeId), handoffEntry)
      : '';
    if (workspaceRoot && runKind !== 'roadmap_revision' && !isSoloConversation && !isReviewRun) {
      recordSolomapLearningCycle(
        workspaceRoot,
        String(globalDataPath || ''),
        currentNode,
        nextStatus,
        changedFilesSummary,
        touchedFilesSummary,
        outputTail,
        runDurationMs,
        finishedAt
      );
    }
    const documentationAudit = workspaceRoot && !isReviewRun
      ? auditDocumentationAfterRun(workspaceRoot, {
        nodeId,
        runKind,
        status: nextStatus,
        changedFilesSummary,
        touchedFilesSummary,
        outputTail,
        finishedAt
      })
      : null;
    let runDigestSummary = '';
    if (workspaceRoot) {
      try {
        const runDigest = buildRunDigest({
          workspaceRoot,
          nodeId,
          runKind: String(runKind || (isSoloConversation ? 'solo' : 'step')),
          agentCli: String(agentCli || commandPreview || command || 'Unknown CLI'),
          executionLogId: Number(executionLogId || 0),
          userMessage: String(userMessage || ''),
          resolvedCommand,
          status: nextStatus,
          startedAt: String(startedAt || ''),
          finishedAt,
          durationMs: runDurationMs,
          changedFilesSummary,
          touchedFilesSummary,
          outputTail,
          completionReason,
          failureCode,
          failureReason
        });
        runDigestSummary = `Execution digest saved: ${toProjectRelativeRuntimePath(workspaceRoot, writeRunDigest(workspaceRoot, runDigest))}`;
      } catch (error) {
        runDigestSummary = `Execution digest not saved: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    let preGitHash = '';
    if (syncEngine && executionLogId) {
      const existingLogs = (isSoloConversation && typeof syncEngine.getProjectAgentExecutions === 'function')
        ? syncEngine.getProjectAgentExecutions()
        : (typeof syncEngine.getAgentExecutions === 'function' ? syncEngine.getAgentExecutions(nodeId) : []);
      const matched = existingLogs.find(log => Number(log.id) === Number(executionLogId));
      if (matched && matched.output) {
        const hashMatch = matched.output.match(/SoloMapPreGitHash:\s*([a-f0-9]+)/i);
        if (hashMatch) {
          preGitHash = hashMatch[1];
        }
      }
    }
    const executionSummary = [
      preGitHash ? `SoloMapPreGitHash: ${preGitHash}` : '',
      userMessage ? `User supplement:\n${userMessage}` : '',
      sessionMode ? `Native session mode: ${sessionMode}` : '',
      nativeSessionSummary,
      `Sentinel captured state: ${status}`,
      isSoloConversation ? `Solo conversation state: ${nextStatus}` : `Roadmap step state: ${nextStatus}`,
      startedAt ? `Run started at: ${startedAt}` : '',
      `Run finished at: ${finishedAt}`,
      startedAt ? `Run duration ms: ${runDurationMs}` : '',
      failureCode ? `Failure category: ${failureCode}` : '',
      failureReason ? `Failure reason:\n${failureReason}` : '',
      completionReason ? `Completion decision: ${completionReason}` : '',
      reviewResult ? formatAgentReviewResult(reviewResult) : '',
      isReviewRun && reviewOfExecutionLogId ? `Review of execution: ${reviewOfExecutionLogId}` : '',
      stepHandoffSummary ? `Step handoff summary updated: ${getStepMemoryFilePath(workspaceRoot, nodeId)}` : '',
      documentationAudit ? `Documentation harness: ${documentationAudit.summary}` : '',
      runDigestSummary,
      documentationAudit && documentationAudit.pendingReview.length > 0
        ? `Documentation review needed:\n${documentationAudit.pendingReview.map((item) => `- ${item.path}: ${item.reason}`).join('\n')}`
        : '',
      `Workspace changes:`,
      changedFilesSummary,
      `Touched project files:`,
      touchedFilesSummary,
      outputTail ? `Agent output tail:\n${outputTail}` : 'Agent output tail: No captured output.'
    ].filter(Boolean).join('\n\n');
    const updatedExistingConversation = executionLogId
      ? syncEngine.updateAgentExecution(
        Number(executionLogId),
        agentCli || commandPreview || command || 'Unknown CLI',
        resolvedCommand,
        executionSummary,
        nextStatus
      )
      : false;
    if (!updatedExistingConversation) {
      syncEngine.logAgentExecution(
        nodeId,
        agentCli || commandPreview || command || 'Unknown CLI',
        resolvedCommand,
        executionSummary,
        nextStatus
      );
    }

    if (shouldStartReview) {
      const requestedReviewerCli = String(reviewerCliPath || agentCli || '').trim();
      const reviewerCli = resolveAgentCli(requestedReviewerCli || String(agentCli || 'agy'), requestedReviewerCli ? '' : String(agentCli || 'agy'));
      if (commandExists(reviewerCli)) {
        startAgentReviewRun({
          workspaceRoot,
          nodeId,
          runKind: String(runKind || 'step'),
          reviewerCli,
          mainAgentCli: String(agentCli || commandPreview || command || 'Unknown CLI'),
          mainExecutionLogId: Number(executionLogId || 0),
          mainResolvedCommand: resolvedCommand,
          userMessage: String(userMessage || ''),
          mainStatus: reviewDeferredCompletion ? 'Completed' : nextStatus,
          completionReason,
          changedFilesSummary,
          touchedFilesSummary,
          outputTail,
          targetStatus: reviewDeferredCompletion ? 'Completed' : nextStatus,
          globalDataPath: String(globalDataPath || ''),
          taskPermissionMode: 'auto'
        });
      } else {
        syncEngine.logAgentExecution(
          nodeId,
          requestedReviewerCli || reviewerCli,
          requestedReviewerCli || reviewerCli,
          [
            'Agent review could not start.',
            `Review of execution: ${executionLogId || 0}`,
            'Failure category: reviewer_cli_not_found',
            `Failure reason:\nReview Agent CLI not found. Tried: ${getAgentCliCandidates(requestedReviewerCli || String(agentCli || 'agy'), requestedReviewerCli ? '' : String(agentCli || 'agy')).join(', ')}.`
          ].join('\n\n'),
          'Failed'
        );
        postNodeConversations(nodeId);
      }
    }

    if (workspaceRoot && shouldRefreshRoadmap) {
      await syncEngine.initAndSync();
      if (preserveCompletedNode && nodeId !== roadmapRevisionId && syncEngine.getNodes().some((node) => node.id === nodeId)) {
        syncEngine.updateNode(nodeId, {
          status: 'Completed',
          completedAt: currentNode?.completedAt || new Date().toISOString()
        });
      }
    }

    sendNodesToWebview();
    refreshSidebarProjectCards();
    postNodeConversations(nodeId);
    if (!isSoloConversation && nextStatus === 'Completed' && !hasRecordedWorkspaceChanges(changedFilesSummary, touchedFilesSummary)) {
      vscode.window.showWarningMessage(`Agent task [${nodeId}] completed, but no workspace file changes were detected.`);
    } else if (isSoloConversation) {
      vscode.window.showInformationMessage(`Solo conversation finished with state: ${nextStatus}`);
    } else {
      vscode.window.showInformationMessage(`Agent task [${nodeId}] finished with state: ${nextStatus}`);
    }

    agentTerminalNamesByConversationId.delete(Number(executionLogId || 0));
    setTimeout(() => {
      const currentStatus = readAgentStatus(statusFilePath);
      const belongsToProcessedRun = currentStatus
        && Number(currentStatus.executionLogId || 0) === Number(executionLogId || 0)
        && String(currentStatus.status || '') === String(status || '');
      if (belongsToProcessedRun && fs.existsSync(statusFilePath)) {
        fs.writeFileSync(statusFilePath, JSON.stringify({
          ...currentStatus,
          status: 'Processed',
          processedAt: new Date().toISOString()
        }), 'utf8');
      }
    }, 1000);
  } catch (e) {
    // JSON might be partially written; watcher or poller will retry.
  }
}

/**
 * Sets up watcher plus polling fallback for agent status changes.
 */
function setupFileSentinelWatcher(workspaceRoot: string) {
  if (watcher) {
    watcher.dispose();
  }
  if (statusPoller) {
    clearInterval(statusPoller);
    statusPoller = null;
  }

  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, `{.agent_status.json,.solopreneur/${agentStatusDirName}/*.json}`)
  );

  const handleSentinelChange = () => {
    for (const statusFilePath of getAgentStatusFilePaths(workspaceRoot)) {
      void processAgentStatusFile(statusFilePath);
    }
  };
  watcher.onDidChange(handleSentinelChange);
  watcher.onDidCreate(handleSentinelChange);
  statusPoller = setInterval(handleSentinelChange, 2000);
  handleSentinelChange();
}

/**
 * Formulates the premium glassmorphic Webview page bundle.
 */
function getWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  // In MVP, we embed a fully functional React + CSS app direct inside the iframe
  // which uses modern styling guidelines (glassmorphism, glowing connections, inter font).
  const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
  const wordmarkUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'logo_with_text.svg'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SoloMap</title>
  <!-- Load Inter & Outfit Fonts Asynchronously (Prevent network blocks on slow connections) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Outfit:wght@400;600;800&display=swap" media="print" onload="this.media='all'">
  <link rel="stylesheet" href="${codiconsUri}">
  <noscript>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
  </noscript>

  <style>
    :root {
      --bg-dark: #0f111a;
      --bg-glass: rgba(22, 28, 45, 0.6);
      --border-glass: rgba(255, 255, 255, 0.08);
      --glow-blue: rgba(0, 229, 255, 0.8);
      --glow-green: rgba(0, 230, 118, 0.8);
      --glow-red: rgba(255, 23, 68, 0.8);
      --text-main: #e2e8f0;
      --text-muted: #94a3b8;
    }

    * {
      box-sizing: border-box;
    }

    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(148, 163, 184, 0.28) transparent;
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
      background: rgba(148, 163, 184, 0.26);
      background-clip: content-box;
    }

    *::-webkit-scrollbar-thumb:hover {
      background: rgba(148, 163, 184, 0.42);
      background-clip: content-box;
    }

    body {
      margin: 0;
      padding: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--vscode-editor-background, var(--bg-dark));
      color: var(--text-main);
      overflow-x: hidden;
    }

    .app-container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
    }

    /* Premium Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 16px 24px;
      background: rgba(15, 17, 26, 0.7);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-glass);
      z-index: 10;
    }

    h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 20px;
      margin: 0;
      font-weight: 800;
      background: linear-gradient(135deg, #00e5ff 0%, #7c4dff 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .project-select {
      width: clamp(150px, 18vw, 240px);
      min-width: 0;
    }

    .project-property-select {
      width: clamp(96px, 10vw, 150px);
      min-width: 0;
    }

    .solo-select {
      position: relative;
      min-width: 0;
      font-size: 12px;
    }

    .solo-select-trigger {
      width: 100%;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 10px;
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 7px;
      font: inherit;
      font-weight: 400;
      cursor: pointer;
      text-align: left;
    }

    .solo-select-trigger:hover {
      transform: none;
      box-shadow: none;
      border-color: rgba(0, 229, 255, 0.38);
    }

    .solo-select-trigger-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .solo-select-caret {
      flex-shrink: 0;
      font-size: 13px;
      color: var(--text-muted);
      transition: transform 0.18s ease;
    }

    .solo-select.open .solo-select-caret {
      transform: rotate(180deg);
    }

    .solo-select.open .solo-select-trigger,
    .solo-select-trigger:focus {
      outline: none;
      border-color: rgba(0, 229, 255, 0.7);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.18);
    }

    .solo-select-menu {
      display: none;
      position: absolute;
      top: calc(100% + 5px);
      left: 0;
      right: 0;
      z-index: 120;
      padding: 5px;
      max-height: 224px;
      overflow-y: auto;
      border: 1px solid rgba(0, 229, 255, 0.2);
      border-radius: 9px;
      background: #141a29;
      box-shadow: 0 14px 32px rgba(0, 0, 0, 0.48);
    }

    .solo-select.open .solo-select-menu {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .solo-select-group-header {
      padding: 8px 9px;
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid var(--border-glass);
      margin: 4px 0 2px;
      pointer-events: none;
    }

    .solo-select-option {
      padding: 8px 9px;
      background: transparent;
      border-radius: 6px;
      color: var(--text-main);
      font: inherit;
      font-weight: 400;
      text-align: left;
      cursor: pointer;
    }

    .solo-select-option:hover,
    .solo-select-option[aria-selected="true"] {
      transform: none;
      box-shadow: none;
      color: #d8fbff;
      background: rgba(0, 229, 255, 0.12);
    }

    .solo-select.is-disabled {
      opacity: 0.55;
    }

    .solo-select.is-disabled .solo-select-trigger {
      cursor: not-allowed;
    }

    .btn-project-add {
      padding: 8px 10px;
      min-width: 34px;
    }

    .btn-project-remove {
      background: rgba(255, 23, 68, 0.10);
      color: #ffe1e8;
      border: 1px solid rgba(255, 23, 68, 0.22);
      padding: 8px 10px;
      min-width: 34px;
    }

    .btn-project-remove:hover {
      box-shadow: 0 4px 15px rgba(255, 23, 68, 0.28);
      background: rgba(255, 23, 68, 0.18);
    }

    .btn-roadmap-revision {
      width: 34px;
      height: 34px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      border: 1px solid rgba(56, 189, 248, 0.28);
      border-radius: 8px;
      flex-shrink: 0;
    }

    .btn-roadmap-revision:hover,
    .btn-roadmap-revision.active {
      background: #00e5ff;
      border-color: #00e5ff;
      color: #000;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.25);
    }

    .view-tabs {
      display: flex;
      gap: 8px;
      padding: 10px 24px 0;
      background: rgba(15, 17, 26, 0.7);
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      z-index: 8;
    }

    .view-tab {
      height: 34px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      flex-shrink: 0;
    }

    .view-tab:hover,
    .view-tab.active {
      color: #d8fbff;
      background: rgba(0, 229, 255, 0.12);
      border-color: rgba(0, 229, 255, 0.32);
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.18);
    }

    .view-tab.solo-tab.active {
      color: #fff;
      background: rgba(124, 77, 255, 0.36);
      border-color: rgba(167, 139, 250, 0.68);
      box-shadow: 0 0 12px rgba(124, 77, 255, 0.28);
    }

    .view-tab.flow-tab.active {
      color: #fff7d6;
      background: rgba(245, 158, 11, 0.24);
      border-color: rgba(245, 158, 11, 0.58);
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.24);
    }

    .view-panel {
      display: none;
    }

    .view-panel.active {
      display: flex;
    }

    .roadmap-canvas.view-panel:not(.active),
    .solo-view.view-panel:not(.active) {
      display: none;
    }

    input[type="text"] {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 8px 12px;
      color: var(--text-main);
      font-family: inherit;
      width: 250px;
      outline: none;
      transition: all 0.3s ease;
    }

    input[type="text"]:focus {
      border-color: #00e5ff;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.25);
    }

    input[type="range"] {
      width: 100%;
      height: 18px;
      margin: 0;
      appearance: none;
      -webkit-appearance: none;
      background: transparent;
      accent-color: #38bdf8;
    }

    input[type="range"]::-webkit-slider-runnable-track {
      height: 4px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.22);
    }

    input[type="range"]::-webkit-slider-thumb {
      width: 14px;
      height: 14px;
      margin-top: -5px;
      border: 2px solid var(--vscode-editor-background, #0f111a);
      border-radius: 999px;
      background: #cbd5e1;
      -webkit-appearance: none;
    }

    input[type="range"]::-moz-range-track {
      height: 4px;
      border: 0;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.22);
    }

    input[type="range"]::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-editor-background, #0f111a);
      border-radius: 999px;
      background: #cbd5e1;
    }

    button {
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .codicon {
      font-size: 16px;
      line-height: 1;
    }

    .brand-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .brand-wordmark {
      width: 132px;
      height: auto;
      flex-shrink: 0;
    }

    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 15px rgba(0, 229, 255, 0.4);
    }

    /* Roadmap Canvas */
    .roadmap-canvas {
      flex: 1;
      position: relative;
      background: radial-gradient(circle at 50% 50%, rgba(20, 25, 45, 0.6) 0%, rgba(10, 12, 22, 0.95) 100%);
      overflow: auto;
      padding: clamp(18px, 4vw, 40px);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 30px;
    }

    .solo-view {
      flex: 1;
      overflow: auto;
      padding: clamp(18px, 4vw, 40px);
      background: radial-gradient(circle at 50% 50%, rgba(35, 24, 66, 0.45) 0%, rgba(10, 12, 22, 0.95) 100%);
      flex-direction: column;
      align-items: center;
    }

    .solo-view-inner {
      width: min(1280px, 100%);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .roadmap-revision-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .roadmap-revision-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .roadmap-revision-body .conversation-composer {
      margin-top: 0;
    }

    .solo-conversation-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .solo-conversation-body .conversation-composer {
      margin-top: 0;
    }

    .solo-closure {
      border-top: 1px solid var(--border-glass);
      margin-top: 10px;
      padding-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .solo-closure-title {
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
    }

    .solo-closure-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .solo-link-select {
      flex: 1 1 180px;
      min-width: 150px;
    }

    .solo-action-btn {
      font-size: 11px;
      padding: 8px 10px;
      white-space: nowrap;
    }

    .solo-action-btn.secondary {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
    }

    /* Node Stack (Unified Roadmap Flow layout) */
    .flow-line {
      position: absolute;
      width: 4px;
      background: linear-gradient(to bottom, #00e5ff, #7c4dff);
      top: 60px;
      bottom: 60px;
      z-index: 1;
    }

    .methodology-shell {
      width: 100%;
      max-width: min(1280px, 100%);
      position: relative;
      z-index: 3;
    }

    .methodology-overview {
      width: 100%;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }

    .methodology-stage-card {
      width: 100%;
      min-width: 0;
      min-height: 78px;
      padding: 12px;
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--text-main);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 8px;
      text-align: left;
      cursor: pointer;
    }

    .methodology-stage-card:hover,
    .methodology-stage-card.active {
      border-color: rgba(0, 229, 255, 0.52);
      background: rgba(0, 229, 255, 0.10);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.10), 0 12px 30px rgba(0, 0, 0, 0.22);
      transform: none;
    }

    .methodology-stage-card.missing {
      background: rgba(245, 158, 11, 0.12);
      border-color: rgba(245, 158, 11, 0.42);
      box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.12);
    }

    .methodology-stage-card.missing.active {
      background: rgba(245, 158, 11, 0.18);
      border-color: rgba(245, 158, 11, 0.62);
    }

    .methodology-stage-name {
      font-size: 12px;
      font-weight: 800;
      line-height: 1.1;
    }

    .methodology-stage-meta {
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.35;
    }

    .methodology-adjust-btn {
      align-self: flex-start;
      border: 1px solid rgba(245, 158, 11, 0.45);
      background: rgba(245, 158, 11, 0.14);
      color: #fde68a;
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }

    .node-row {
      position: relative;
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      max-width: min(1280px, 100%);
      min-width: 0;
      z-index: 2;
    }

    .node-row.stage-highlight .node-card {
      border-color: rgba(0, 229, 255, 0.65);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.16), 0 0 32px rgba(0, 229, 255, 0.14);
    }

    .node-card {
      width: 100%;
      min-width: 0;
      background: var(--bg-glass);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      gap: 16px;
      flex-direction: column;
      transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      cursor: pointer;
    }

    .node-card:hover {
      transform: scale(1.01) translateY(-2px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      border-color: rgba(255,255,255,0.15);
    }

    /* Status indicators */
    .node-card.status-Pending {
      border-left: 5px solid #64748b;
    }
    .node-card.status-Running {
      border-left: 5px solid #00e5ff;
      animation: pulse-border 2s infinite;
    }
    .node-card.status-In-Progress {
      border-left: 5px solid #facc15;
      box-shadow: 0 0 15px rgba(250, 204, 21, 0.08);
    }
    .node-card.status-Completed {
      border-left: 5px solid #00e676;
      box-shadow: 0 0 15px rgba(0, 230, 118, 0.1);
    }
    .node-card.status-Failed {
      border-left: 5px solid #ff1744;
      box-shadow: 0 0 15px rgba(255, 23, 68, 0.1);
    }

    @keyframes pulse-border {
      0% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0.4); }
      70% { box-shadow: 0 0 0 10px rgba(0, 229, 255, 0); }
      100% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0); }
    }

    .node-badge {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 4px 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-muted);
      align-self: flex-start;
    }

    .stage-Business-Planning { color: #818cf8; }
    .stage-Brand---Setup { color: #f472b6; }
    .stage-Product---MVP { color: #38bdf8; }
    .stage-Marketing---Growth { color: #34d399; }

    .node-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }

    .node-summary {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      justify-content: space-between;
      min-width: 0;
    }

    .node-headline {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .node-expand-icon {
      color: var(--text-muted);
      font-size: 12px;
      margin-right: 2px;
    }

    .node-expanded-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 10px;
      padding-top: 12px;
      border-top: 1px solid var(--border-glass);
      min-width: 0;
      max-width: 100%;
    }

    .node-title {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.2px;
    }

    .node-desc {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .node-agent-prompt {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 6px;
      padding: 8px 12px;
      font-family: monospace;
      font-size: 11px;
      color: #38bdf8;
      border-left: 2px solid #38bdf8;
      margin-top: 6px;
    }

    .completion-criteria {
      margin-top: 8px;
      background: rgba(0, 229, 255, 0.06);
      border: 1px solid rgba(0, 229, 255, 0.16);
      border-radius: 8px;
      padding: 9px 10px;
    }

    .completion-criteria-title {
      font-size: 11px;
      font-weight: 800;
      color: #67e8f9;
      margin-bottom: 6px;
    }

    .completion-criteria-list {
      margin: 0;
      padding-left: 18px;
      color: #cbd5e1;
      font-size: 12px;
      line-height: 1.45;
    }

    .completion-criteria-list li + li {
      margin-top: 4px;
    }

    .node-actions {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: flex-end;
      gap: 10px;
      flex-shrink: 0;
    }

    .status-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 12px;
    }

    .status-badge.Pending { background: rgba(100, 116, 139, 0.15); color: #94a3b8; }
    .status-badge.Running { background: rgba(0, 229, 255, 0.15); color: #00e5ff; }
    .status-badge.In-Progress { background: rgba(250, 204, 21, 0.15); color: #facc15; }
    .status-badge.Completed { background: rgba(0, 230, 118, 0.15); color: #00e676; }
    .status-badge.Failed { background: rgba(255, 23, 68, 0.15); color: #ff1744; }

    .btn-run {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
      padding: 6px 12px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-run:hover {
      background: #00e5ff;
      color: #000;
      border-color: #00e5ff;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.3);
    }

    .conversation-panel {
      background: rgba(0, 0, 0, 0.16);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 10px;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
    }

    .conversation-composer {
      background: rgba(0, 0, 0, 0.20);
      border: 1px solid var(--border-glass);
      border-radius: 10px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .conversation-compose {
      display: flex;
      gap: 8px;
      align-items: stretch;
      min-width: 0;
    }

    .conversation-compose-main {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr) auto;
      align-items: center;
    }

    .conversation-compose-meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .conversation-compose input {
      flex: 1;
      width: auto;
      min-width: 0;
      min-height: 34px;
    }

    .conversation-tool-btn {
      width: 34px;
      min-height: 34px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-main);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      flex-shrink: 0;
    }

    .conversation-tool-btn:hover {
      color: #000;
      background: #00e5ff;
      border-color: #00e5ff;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.25);
    }

    .conversation-agent-select {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      font-size: 12px;
      flex-shrink: 0;
    }

    .conversation-model-select {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      font-size: 12px;
      flex-shrink: 0;
    }

    .btn-send-conversation {
      min-width: 42px;
      min-height: 34px;
      padding: 0 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
    }

    .conversation-compose input:disabled,
    .btn-send-conversation:disabled,
    .conversation-tool-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .conversation-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .conversation-attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      padding: 4px 7px;
      border-radius: 999px;
      border: 1px solid var(--border-glass);
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      font-size: 11px;
    }

    .conversation-attachment-chip span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: min(360px, 48vw);
    }

    .conversation-attachment-remove {
      width: 16px;
      height: 16px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.10);
      color: var(--text-main);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .conversation-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 8px;
    }

    .conversation-empty {
      color: var(--text-muted);
      font-size: 12px;
      padding: 8px 0;
    }

    .conversation-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .onboarding-panel {
      width: min(560px, calc(100vw - 48px));
      margin: 48px auto 0;
      border: 1px solid rgba(0, 229, 255, 0.18);
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(0, 229, 255, 0.08), rgba(124, 77, 255, 0.08));
      padding: 18px;
      box-sizing: border-box;
    }

    .onboarding-kicker {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #7dd3fc;
      font-size: 11px;
      font-weight: 800;
      margin-bottom: 9px;
    }

    .onboarding-title {
      color: var(--text-main);
      font-size: 20px;
      font-weight: 800;
      line-height: 1.22;
      margin-bottom: 8px;
    }

    .onboarding-copy {
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 14px;
    }

    .onboarding-steps {
      display: grid;
      gap: 9px;
      margin-bottom: 16px;
    }

    .onboarding-step {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr);
      gap: 9px;
      align-items: start;
      color: var(--text-main);
      font-size: 12px;
      line-height: 1.45;
    }

    .onboarding-step-index {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: rgba(0, 229, 255, 0.12);
      border: 1px solid rgba(0, 229, 255, 0.24);
      color: #a5f3fc;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 800;
    }

    .onboarding-action {
      border: none;
      border-radius: 6px;
      padding: 9px 13px;
      background: linear-gradient(135deg, #7c4dff 0%, #00b0ff 100%);
      color: #fff;
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
    }

    .conversation-item {
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      overflow: hidden;
      min-width: 0;
      max-width: 100%;
    }

    .conversation-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 10px;
      cursor: pointer;
      font-size: 12px;
    }

    .conversation-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1 1 auto;
    }

    .conversation-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
      flex-shrink: 0;
    }

    .conversation-retry-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }

    .conversation-retry-btn:hover {
      background: rgba(255, 23, 68, 0.16);
      border-color: rgba(255, 23, 68, 0.4);
      color: #ffd7df;
      box-shadow: none;
      transform: none;
    }

    .conversation-control-btn {
      background: rgba(56, 189, 248, 0.10);
      border: 1px solid rgba(56, 189, 248, 0.28);
      color: #d7f3ff;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }

    .conversation-control-btn.stop {
      background: rgba(255, 23, 68, 0.10);
      border-color: rgba(255, 23, 68, 0.32);
      color: #ffd7df;
    }

    .conversation-control-btn:hover {
      background: rgba(56, 189, 248, 0.20);
    }

    .conversation-control-btn.stop:hover {
      background: rgba(255, 23, 68, 0.20);
    }

    .conversation-cli {
      color: #38bdf8;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .conversation-time {
      color: var(--text-muted);
      font-size: 11px;
    }

    .conversation-runtime {
      color: #38bdf8;
      font-size: 11px;
    }

    .conversation-summary {
      color: var(--text-main);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }

    .conversation-detail {
      border-top: 1px solid var(--border-glass);
      padding: 10px;
      color: var(--text-muted);
      font-size: 12px;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
    }

    .conversation-outcome {
      margin: 0 0 10px;
      padding: 8px 9px;
      border-radius: 6px;
      background: rgba(56, 189, 248, 0.08);
      color: var(--text-main);
      line-height: 1.45;
    }

    .conversation-outcome.failed {
      background: rgba(255, 23, 68, 0.10);
      color: #ffd7df;
    }

    .conversation-outcome-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }

    .conversation-outcome-title {
      min-width: 0;
      flex: 1;
    }

    .rollback-btn {
      border: 1px solid rgba(244, 67, 54, 0.4);
      border-radius: 4px;
      background: rgba(244, 67, 54, 0.08);
      color: #ff8a80;
      padding: 3px 6px;
      font-size: 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      line-height: 1;
      transition: background 0.2s, border-color 0.2s;
    }
    .rollback-btn:hover {
      background: rgba(244, 67, 54, 0.18);
      border-color: rgba(244, 67, 54, 0.6);
    }
    .rollback-btn .codicon {
      font-size: 11px;
    }

    .conversation-detail pre {
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      max-height: 260px;
      overflow: auto;
      margin: 6px 0 0;
      font-size: 11px;
      color: #cbd5e1;
      max-width: 100%;
    }

    .conversation-files {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 8px 0 12px;
    }

    .conversation-file-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px solid var(--border-glass);
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      text-decoration: none;
      font-size: 11px;
      cursor: pointer;
    }

    .conversation-file-link:hover {
      background: rgba(56, 189, 248, 0.16);
    }

    /* Settings Overlay Styles */
    .settings-overlay,
    .feedback-overlay {
      position: absolute;
      top: 75px;
      right: 24px;
      width: 320px;
      background: rgba(15, 17, 26, 0.95);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 16px;
      z-index: 100;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      display: none;
      flex-direction: column;
      gap: 12px;
      max-height: calc(100vh - 110px);
      overflow-y: auto;
      animation: slide-down 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .feedback-type-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }

    .feedback-type-btn {
      border: 1px solid var(--border-glass);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-muted);
      border-radius: 6px;
      padding: 8px 6px;
      font-size: 11px;
      cursor: pointer;
    }

    .feedback-type-btn.active {
      color: #00e5ff;
      border-color: rgba(0, 229, 255, 0.55);
      background: rgba(0, 229, 255, 0.08);
    }

    .roadmap-revision-popover {
      position: absolute;
      top: 75px;
      right: 68px;
      width: clamp(340px, 42vw, 560px);
      max-width: calc(100vw - 32px);
      background: rgba(15, 17, 26, 0.96);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 14px;
      z-index: 100;
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.52);
      display: none;
      flex-direction: column;
      gap: 12px;
      max-height: calc(100vh - 110px);
      overflow-y: auto;
      animation: slide-down 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .roadmap-revision-popover.open {
      display: flex;
    }

    .roadmap-revision-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--border-glass);
      padding-bottom: 8px;
    }

    .roadmap-revision-header h3 {
      margin: 0;
      font-size: 14px;
      color: #00e5ff;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .btn-close-revision {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .btn-close-revision:hover {
      color: #ff1744;
      box-shadow: none;
      transform: none;
    }

    @keyframes slide-down {
      from { transform: translateY(-10px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .settings-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-glass);
      padding-bottom: 8px;
    }

    .settings-header h3 {
      font-family: 'Outfit', sans-serif;
      font-size: 14px;
      margin: 0;
      font-weight: 800;
      color: #00e5ff;
    }

    .btn-close-settings {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      font-size: 20px;
      font-weight: bold;
      padding: 0 4px;
    }

    .btn-close-settings:hover {
      color: #ff1744;
    }

    .settings-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .settings-card {
      border: 1px solid rgba(255, 255, 255, 0.10);
      background: rgba(255, 255, 255, 0.035);
      border-radius: 8px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 9px;
    }

    .settings-card-title {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      font-weight: 800;
      color: var(--text-main);
    }

    .enhancement-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }

    .enhancement-card {
      border: 1px solid var(--border-glass);
      background: rgba(255, 255, 255, 0.04);
      border-radius: 7px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .enhancement-card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }

    .enhancement-title {
      color: var(--text-main);
      font-size: 11px;
      font-weight: 800;
    }

    .enhancement-desc {
      color: var(--text-muted);
      font-size: 8.5px;
      line-height: 1.35;
      margin-top: 2px;
    }

    .enhancement-status {
      flex: 0 0 auto;
      border: 1px solid rgba(56, 189, 248, 0.28);
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      border-radius: 999px;
      padding: 2px 6px;
      font-size: 8.5px;
      font-weight: 800;
      white-space: nowrap;
    }

    .enhancement-status.failed,
    .enhancement-status.unavailable {
      border-color: rgba(255, 23, 68, 0.32);
      background: rgba(255, 23, 68, 0.10);
      color: #ffd7df;
    }

    .enhancement-meta {
      color: var(--text-muted);
      font-size: 8.5px;
    }

    .enhancement-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }

    .settings-lbl-title {
      font-size: 9.5px;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: 0.5px;
    }

    .settings-input {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 8px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }

    .settings-textarea {
      min-height: 76px;
      resize: vertical;
      line-height: 1.45;
    }

    .settings-input:focus, .settings-textarea:focus {
      border-color: #00e5ff;
    }

    .impact-panel {
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.035);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .impact-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .impact-metric {
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 6px;
      padding: 8px;
      background: rgba(0, 0, 0, 0.12);
      min-width: 0;
    }

    .impact-metric-value {
      font-size: 18px;
      font-weight: 800;
      color: var(--text-main);
      line-height: 1.1;
    }

    .impact-metric-label {
      margin-top: 3px;
      font-size: 9px;
      color: var(--text-muted);
    }

    .agent-impact-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .impact-agent-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: flex-start;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 7px;
    }

    .impact-agent-row:first-child {
      border-top: 0;
      padding-top: 0;
    }

    .impact-agent-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .impact-agent-name {
      font-size: 11px;
      font-weight: 800;
      color: var(--text-main);
    }

    .impact-agent-detail {
      font-size: 9px;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }

    .impact-status {
      flex-shrink: 0;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 9px;
      font-weight: 800;
      border: 1px solid var(--border-glass);
      color: var(--text-muted);
    }

    .impact-status.ready {
      border-color: rgba(0, 230, 118, 0.25);
      color: #00e676;
      background: rgba(0, 230, 118, 0.08);
    }

    .impact-status.unknown {
      border-color: rgba(255, 183, 77, 0.28);
      color: #ffcc80;
      background: rgba(255, 183, 77, 0.08);
    }

    .impact-status.missing {
      border-color: rgba(255, 82, 82, 0.24);
      color: #ff8a80;
      background: rgba(255, 82, 82, 0.08);
    }

    .settings-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }

    .settings-action-btn {
      flex: 1;
      padding: 8px;
      font-size: 11px;
      font-weight: 700;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.2s;
    }

    .settings-action-btn.test-btn {
      border: 1px solid var(--border-glass);
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-main);
    }

    .settings-action-btn.test-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    .settings-action-btn.save-btn {
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
    }

    .settings-action-btn.save-btn:hover {
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.3);
    }

    .cli-badge {
      margin-top: 8px;
      font-size: 11px;
      padding: 6px 8px;
      border-radius: 6px;
      font-weight: 600;
      text-align: center;
      line-height: 1.3;
    }

    .cli-badge.success {
      background: rgba(0, 230, 118, 0.1);
      color: #00e676;
      border: 1px solid rgba(0, 230, 118, 0.15);
    }

    .cli-badge.error {
      background: rgba(255, 23, 68, 0.1);
      color: #ff1744;
      border: 1px solid rgba(255, 23, 68, 0.15);
    }

    .btn-gear {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      padding: 4px;
      width: 34px;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      flex-shrink: 0;
    }

    .btn-gear:hover {
      color: #00e5ff;
      transform: rotate(30deg) scale(1.1);
    }

    @media (max-width: 720px) {
      header {
        padding: 12px 14px;
        flex-wrap: wrap;
        align-items: flex-start;
      }

      .controls {
        width: 100%;
        gap: 8px;
        justify-content: flex-end;
      }

      .project-select {
        flex: 1 1 160px;
        width: auto;
      }

      .roadmap-canvas {
        padding: 18px 12px;
        gap: 22px;
      }

      .methodology-overview {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .node-summary,
      .conversation-row {
        flex-direction: column;
        align-items: stretch;
      }

      .node-actions {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        width: 100%;
      }

      .conversation-compose input {
        flex: 1 1 auto;
      }

      .btn-send-conversation {
        flex: 0 0 42px;
      }

      .conversation-actions {
        justify-content: flex-start;
      }

      .settings-overlay,
      .feedback-overlay,
      .roadmap-revision-popover {
        top: 118px;
        left: 12px;
        right: 12px;
        width: auto;
        max-width: none;
      }
    }

    @media (max-width: 430px) {
      h1 {
        font-size: 18px;
      }

      .controls {
        justify-content: flex-start;
      }

      .btn-project-add,
      .btn-project-remove,
      .btn-solo,
      .btn-roadmap-revision {
        width: 34px;
        min-width: 34px;
      }

      .node-card {
        padding: 16px;
      }

      .methodology-overview {
        grid-template-columns: 1fr;
      }

      .node-title {
        font-size: 14px;
      }

      .status-badge,
      .btn-run {
        max-width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="app-container">
    <header>
      <h1 class="brand-title"><img class="brand-wordmark" src="${wordmarkUri}" width="132" height="34" alt="SoloMap"></h1>
      <div class="controls">
        <div class="solo-select project-select" id="project-select" data-solo-select data-value="">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label></span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox"></div>
        </div>
        <div class="solo-select project-property-select" id="project-type-select" data-solo-select data-value="">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label></span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox"></div>
        </div>
        <div class="solo-select project-property-select" id="project-priority-select" data-solo-select data-value="">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label></span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox"></div>
        </div>
        <button class="btn-project-add" id="btn-add-project" title="Add project folder"><span class="codicon codicon-add"></span></button>
        <button class="btn-project-remove" id="btn-remove-project" title="Remove project"><span class="codicon codicon-trash"></span></button>
        <button class="btn-roadmap-revision" id="btn-toggle-roadmap-revision" title="Revise Roadmap"><span class="codicon codicon-git-compare"></span></button>
        <button class="btn-gear" id="btn-toggle-feedback" title="Feedback"><span class="codicon codicon-comment-discussion"></span></button>
        <button class="btn-gear" id="btn-toggle-settings" title="SoloMap Settings"><span class="codicon codicon-settings-gear"></span></button>
      </div>
    </header>

    <div class="view-tabs" role="tablist">
      <button class="view-tab active" id="btn-toggle-roadmap-view" type="button"><span class="codicon codicon-map"></span><span id="roadmap-view-tab-label">环节推进</span></button>
      <button class="view-tab solo-tab" id="btn-toggle-solo" type="button"><span class="codicon codicon-comment-discussion"></span><span id="solo-view-tab-label">自由研讨</span></button>
      <button class="view-tab flow-tab" id="btn-toggle-flow" type="button"><span class="codicon codicon-debug-alt-small"></span><span id="flow-view-tab-label">自动闭环</span></button>
    </div>

    <div class="roadmap-canvas view-panel active" id="canvas">
      <div class="flow-line"></div>
      <!-- Nodes are injected here -->
    </div>

    <div class="solo-view view-panel" id="solo-panel">
      <div class="solo-view-inner">
        <div class="solo-conversation-body" id="solo-body"></div>
      </div>
    </div>

    <div class="solo-view view-panel" id="flow-panel">
      <div class="solo-view-inner">
        <div class="solo-conversation-body" id="flow-body"></div>
      </div>
    </div>
  </div>

  <div class="roadmap-revision-popover" id="roadmap-revision-panel">
    <div class="roadmap-revision-header">
      <h3><span class="codicon codicon-git-compare"></span><span id="roadmap-revision-title">Revise Roadmap</span></h3>
      <button class="btn-close-revision" id="btn-close-roadmap-revision" title="Close"><span class="codicon codicon-close"></span></button>
    </div>
    <div class="roadmap-revision-body" id="roadmap-revision-body"></div>
  </div>

  <div class="feedback-overlay" id="feedback-panel">
    <div class="settings-header">
      <h3><span class="codicon codicon-comment-discussion"></span> <span id="feedback-title">Feedback</span></h3>
      <button class="btn-close-settings" id="btn-close-feedback"><span class="codicon codicon-close"></span></button>
    </div>
    <div class="feedback-type-row">
      <button class="feedback-type-btn active" type="button" data-feedback-type="not_working" id="feedback-type-not-working">Not working</button>
      <button class="feedback-type-btn" type="button" data-feedback-type="next_step" id="feedback-type-next-step">Next step unclear</button>
      <button class="feedback-type-btn" type="button" data-feedback-type="feature_request" id="feedback-type-feature">Feature request</button>
    </div>
    <div class="settings-field">
      <input
        type="text"
        class="settings-input"
        id="setting-feedback-title"
        placeholder="What should be improved?"
      >
      <textarea class="settings-input settings-textarea" id="setting-feedback-body" placeholder="Add what happened and what you expected." style="min-height: 84px; margin-top: 5px;"></textarea>
      <button class="settings-action-btn test-btn" id="btn-open-feedback" style="margin-top: 6px; width: 100%;"><span class="codicon codicon-github"></span><span id="text-open-feedback">Send Feedback</span></button>
    </div>
  </div>

  <!-- Settings Panel Overlay -->
  <div class="settings-overlay" id="settings-panel">
    <div class="settings-header">
      <h3><span class="codicon codicon-settings-gear"></span> <span id="settings-title">SoloMap Settings</span></h3>
      <button class="btn-close-settings" id="btn-close-settings"><span class="codicon codicon-close"></span></button>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-globe"></span><span id="settings-section-basic">Basics</span></div>
    <div class="settings-field">
      <label class="settings-lbl-title" id="label-language">Language</label>
      <div class="solo-select settings-select" id="setting-language" data-solo-select data-value="zh">
        <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
          <span class="solo-select-trigger-label" data-solo-label>中文</span>
          <span class="codicon codicon-chevron-down solo-select-caret"></span>
        </button>
        <div class="solo-select-menu" data-solo-menu role="listbox">
          <button type="button" class="solo-select-option" data-solo-option-value="zh" aria-selected="true">中文</button>
          <button type="button" class="solo-select-option" data-solo-option-value="en" aria-selected="false">English</button>
        </div>
      </div>
    </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-account"></span><span id="settings-section-account">SoloMap Pro</span></div>
      <div class="settings-field">
        <div class="dependency-panel" id="pro-account-panel"></div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px;">
          <button class="settings-action-btn save-btn" id="btn-open-pro-authorization"><span class="codicon codicon-lock"></span><span id="text-open-pro-authorization">登录 / 升级 Pro</span></button>
          <button class="settings-action-btn test-btn" id="btn-paste-pro-code"><span class="codicon codicon-key"></span><span id="text-paste-pro-code">粘贴授权码</span></button>
        </div>
      </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-robot"></span><span id="settings-section-agent">Agent Collaboration</span></div>
    <div class="settings-field">
      <label class="settings-lbl-title" id="label-cli-path">CLI Command or Path</label>
      <div class="settings-cli-select-wrap">
        <div class="solo-select settings-select" id="setting-cli-select" data-solo-select data-value="agy">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label>agy</span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox">
            <button type="button" class="solo-select-option" data-solo-option-value="agy" aria-selected="true">agy</button>
            <button type="button" class="solo-select-option" data-solo-option-value="codex" aria-selected="false">codex</button>
            <button type="button" class="solo-select-option" data-solo-option-value="cursor" aria-selected="false">cursor</button>
            <button type="button" class="solo-select-option" data-solo-option-value="copilot" aria-selected="false">copilot</button>
            <button type="button" class="solo-select-option" data-solo-option-value="claude" aria-selected="false">claude</button>
            <button type="button" class="solo-select-option" data-solo-option-value="opencode" aria-selected="false">opencode</button>
            <button type="button" class="solo-select-option" data-solo-option-value="custom" aria-selected="false">Custom...</button>
          </div>
        </div>
        <input
          type="text"
          class="settings-input"
          id="setting-clipath-custom"
          placeholder="e.g. /usr/local/bin/cursor-cli or my-copilot"
          style="display:none; margin-top: 6px;"
        >
      </div>
      <div id="help-cli-path" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Name of globally installed CLI (e.g. <code>agy</code>, <code>codex</code>, <code>cursor</code>, <code>claude</code>, <code>copilot</code>, <code>opencode</code>) or the absolute path to its executable.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-agent-model">Default Model</label>
      <div class="solo-select settings-select" id="setting-agent-model-select" data-solo-select data-value="auto">
        <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
          <span class="solo-select-trigger-label" data-solo-label>Auto</span>
          <span class="codicon codicon-chevron-down solo-select-caret"></span>
        </button>
        <div class="solo-select-menu" data-solo-menu role="listbox">
          <button type="button" class="solo-select-option" data-solo-option-value="auto" aria-selected="true">Auto</button>
        </div>
      </div>
      <div id="help-agent-model" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Uses the selected Agent family default unless you pin a specific model.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-reviewer-cli-path">Review Agent</label>
      <div class="settings-cli-select-wrap">
        <div class="solo-select settings-select" id="setting-reviewer-cli-select" data-solo-select data-value="">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label>Same as main Agent</span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox">
            <button type="button" class="solo-select-option" data-solo-option-value="" aria-selected="true" id="option-reviewer-same">Same as main Agent</button>
            <button type="button" class="solo-select-option" data-solo-option-value="agy" aria-selected="false">agy</button>
            <button type="button" class="solo-select-option" data-solo-option-value="codex" aria-selected="false">codex</button>
            <button type="button" class="solo-select-option" data-solo-option-value="cursor" aria-selected="false">cursor</button>
            <button type="button" class="solo-select-option" data-solo-option-value="copilot" aria-selected="false">copilot</button>
            <button type="button" class="solo-select-option" data-solo-option-value="claude" aria-selected="false">claude</button>
            <button type="button" class="solo-select-option" data-solo-option-value="opencode" aria-selected="false">opencode</button>
            <button type="button" class="solo-select-option" data-solo-option-value="custom" aria-selected="false">Custom...</button>
          </div>
        </div>
        <input
          type="text"
          class="settings-input"
          id="setting-reviewer-clipath-custom"
          placeholder="e.g. /usr/local/bin/codex"
          style="display:none; margin-top: 6px;"
        >
      </div>
      <div id="help-reviewer-cli-path" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Optional secondary CLI for read-only review after task runs.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-collaboration-review-mode">Auto Review</label>
      <div class="solo-select settings-select" id="setting-collaboration-review-mode" data-solo-select data-value="high_risk">
        <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
          <span class="solo-select-trigger-label" data-solo-label>High-risk tasks</span>
          <span class="codicon codicon-chevron-down solo-select-caret"></span>
        </button>
        <div class="solo-select-menu" data-solo-menu role="listbox">
          <button type="button" class="solo-select-option" data-solo-option-value="high_risk" aria-selected="true" id="option-review-high-risk">High-risk tasks</button>
          <button type="button" class="solo-select-option" data-solo-option-value="all" aria-selected="false" id="option-review-all">Every task</button>
          <button type="button" class="solo-select-option" data-solo-option-value="off" aria-selected="false" id="option-review-off">Off</button>
        </div>
      </div>
      <div id="help-collaboration-review-mode" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Review runs are read-only and appear as a separate conversation in the same step.
      </div>
    </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-database"></span><span id="settings-section-data">Project Data</span></div>
    <div class="settings-field">
      <label class="settings-lbl-title" id="label-global-data-path">Global Data Directory</label>
      <input
        type="text"
        class="settings-input"
        id="setting-global-data-path"
        placeholder="e.g. /home/ubuntu/project/.solomap-global"
      >
      <div id="help-global-data-path" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Directory used to store cross-project SoloMap data such as portfolio, dependencies, learning candidates, and metrics.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-agent-impact">Agent Impact</label>
      <div class="impact-panel" id="agent-impact-panel">
        <div class="impact-summary">
          <div class="impact-metric">
            <div class="impact-metric-value" id="impact-minutes">0</div>
            <div class="impact-metric-label" id="impact-minutes-label">Minutes</div>
          </div>
          <div class="impact-metric">
            <div class="impact-metric-value" id="impact-files">0</div>
            <div class="impact-metric-label" id="impact-files-label">Files changed</div>
          </div>
          <div class="impact-metric">
            <div class="impact-metric-value" id="impact-progress">0</div>
            <div class="impact-metric-label" id="impact-progress-label">Project progress</div>
          </div>
        </div>
        <div class="agent-impact-list" id="agent-impact-list"></div>
        <button class="settings-action-btn test-btn" id="btn-refresh-agent-impact" style="width: 100%;"><span class="codicon codicon-refresh"></span><span id="text-refresh-agent-impact">Refresh Impact</span></button>
      </div>
    </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-edit"></span><span id="settings-section-instructions">Instructions</span></div>
    <div class="settings-field">
      <label class="settings-lbl-title" id="label-global-prompt">Default Agent Instructions</label>
      <textarea class="settings-input settings-textarea" id="setting-global-prompt" placeholder="e.g. Always keep changes minimal and run the narrowest relevant test."></textarea>
      <div id="help-global-prompt" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Injected into every task conversation. Instructions added in a step conversation take priority.
      </div>
    </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-extensions"></span><span id="settings-section-abilities">Abilities</span></div>
      <div class="settings-field">
        <label class="settings-lbl-title" id="label-enhancement-toggles">能力扩展与执行增强</label>
        <div id="help-enhancement-toggles" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
          在这里管理您的已安装技能 (Skills)、连接器 (MCP Connectors) 与内置的执行增强 (Enhancements)。
        </div>
        
        <div id="settings-ability-url-input-container" style="display: none; margin-bottom: 6px; margin-top: 6px;">
          <input
            type="text"
            class="settings-input"
            id="setting-ability-url-input"
            placeholder=""
          >
          <div id="help-ability-url-input" style="font-size: 8px; color: var(--text-muted); margin-top: 2px;"></div>
        </div>

        <div class="solo-select settings-select" id="setting-ability-select" data-solo-select data-value="" style="margin-top: 6px;">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label>请选择能力或增强...</span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox" style="max-height: 250px; overflow-y: auto;">
          </div>
        </div>

        <div class="enhancement-card" id="ability-detail-card" style="margin-top: 8px; display: none;">
          <div class="enhancement-card-head">
            <div>
              <div class="enhancement-title" id="ability-detail-title"></div>
              <div class="enhancement-desc" id="ability-detail-desc" style="white-space: pre-wrap; font-size: 11px;"></div>
            </div>
            <span class="enhancement-status" id="ability-detail-status"></span>
          </div>
          <div class="enhancement-meta" id="ability-detail-meta"></div>
        </div>

        <div class="enhancement-actions" style="margin-top: 8px;">
          <button class="settings-action-btn test-btn" id="btn-install-ability" disabled><span class="codicon codicon-cloud-download"></span><span id="text-install-ability">安装</span></button>
          <button class="settings-action-btn test-btn" id="btn-uninstall-ability" disabled><span class="codicon codicon-trash"></span><span id="text-uninstall-ability">卸载</span></button>
        </div>
        
        <div class="cli-badge" id="ability-action-badge" style="display:none; margin-top: 6px;"></div>
      </div>
    </div>

    <div class="settings-actions">
      <button class="settings-action-btn test-btn" id="btn-test-cli"><span class="codicon codicon-debug-start"></span><span id="text-test-cli">Test CLI</span></button>
      <button class="settings-action-btn save-btn" id="btn-save-settings"><span class="codicon codicon-save"></span><span id="text-save-settings">Save</span></button>
    </div>
    <div class="cli-badge" id="cli-test-badge" style="display:none;"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('canvas');
    const projectSelect = document.getElementById('project-select');
    const btnAddProject = document.getElementById('btn-add-project');
    const btnRemoveProject = document.getElementById('btn-remove-project');
    const btnToggleRoadmapView = document.getElementById('btn-toggle-roadmap-view');
    const btnToggleSolo = document.getElementById('btn-toggle-solo');
    const btnToggleFlow = document.getElementById('btn-toggle-flow');
    const soloPanel = document.getElementById('solo-panel');
    const soloBody = document.getElementById('solo-body');
    const flowPanel = document.getElementById('flow-panel');
    const flowBody = document.getElementById('flow-body');
    const btnToggleRoadmapRevision = document.getElementById('btn-toggle-roadmap-revision');
    const btnCloseRoadmapRevision = document.getElementById('btn-close-roadmap-revision');
    const roadmapRevisionPanel = document.getElementById('roadmap-revision-panel');
    const roadmapRevisionBody = document.getElementById('roadmap-revision-body');

    // Settings Panel elements
    const btnToggleFeedback = document.getElementById('btn-toggle-feedback');
    const btnCloseFeedback = document.getElementById('btn-close-feedback');
    const feedbackPanel = document.getElementById('feedback-panel');
    const btnToggleSettings = document.getElementById('btn-toggle-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const settingsPanel = document.getElementById('settings-panel');
    const settingCliSelect = document.getElementById('setting-cli-select');
    const settingAgentModelSelect = document.getElementById('setting-agent-model-select');
    const settingCliPathCustom = document.getElementById('setting-clipath-custom');
    const settingLanguage = document.getElementById('setting-language');
    const settingGlobalPrompt = document.getElementById('setting-global-prompt');
    const settingGlobalDataPath = document.getElementById('setting-global-data-path');
    const settingReviewerCliSelect = document.getElementById('setting-reviewer-cli-select');
    const settingReviewerCliPathCustom = document.getElementById('setting-reviewer-clipath-custom');
    const settingCollaborationReviewMode = document.getElementById('setting-collaboration-review-mode');
    const proAccountPanel = document.getElementById('pro-account-panel');
    const btnOpenProAuthorization = document.getElementById('btn-open-pro-authorization');
    const btnPasteProCode = document.getElementById('btn-paste-pro-code');
    const settingAbilitySelect = document.getElementById('setting-ability-select');
    const settingsAbilityUrlInputContainer = document.getElementById('settings-ability-url-input-container');
    const settingAbilityUrlInput = document.getElementById('setting-ability-url-input');
    const helpAbilityUrlInput = document.getElementById('help-ability-url-input');
    const abilityDetailCard = document.getElementById('ability-detail-card');
    const abilityDetailTitle = document.getElementById('ability-detail-title');
    const abilityDetailDesc = document.getElementById('ability-detail-desc');
    const abilityDetailStatus = document.getElementById('ability-detail-status');
    const abilityDetailMeta = document.getElementById('ability-detail-meta');
    const btnInstallAbility = document.getElementById('btn-install-ability');
    const btnUninstallAbility = document.getElementById('btn-uninstall-ability');
    const abilityActionBadge = document.getElementById('ability-action-badge');
    const settingFeedbackTitle = document.getElementById('setting-feedback-title');
    const settingFeedbackBody = document.getElementById('setting-feedback-body');
    const btnOpenFeedback = document.getElementById('btn-open-feedback');
    const btnTestCli = document.getElementById('btn-test-cli');
    const btnSaveSettings = document.getElementById('btn-save-settings');
    const cliTestBadge = document.getElementById('cli-test-badge');
    const btnRefreshAgentImpact = document.getElementById('btn-refresh-agent-impact');
    const agentImpactList = document.getElementById('agent-impact-list');
    const projectTypeSelect = document.getElementById('project-type-select');
    const projectPrioritySelect = document.getElementById('project-priority-select');
    let currentLanguage = 'zh';
    let currentNodes = [];
    let expandedNodeId = '';
    let activeMethodologyStage = '';
    let activeConversationId = '';
    let activeProjectPath = '';
    let currentCliPath = 'agy';
    let currentFeedbackType = 'not_working';
    let activeMainView = 'roadmap';
    let currentSettings = {};
    let currentRoadmapLoading = false;
    let selectedEnhancementId = '';
    const roadmapRevisionId = '__roadmap_revision__';
    const soloConversationId = '__solo__';
    let roadmapRevisionExpanded = false;
    let soloExpanded = false;
    let flowExpanded = false;
    const nodeConversations = {};
    const nodeSupplementFiles = {};
    const conversationDrafts = {};
    const nodeAgentSelections = {};
    const agentModelCatalogs = {};
    const conversationModelSelections = {};
    const agentModelPreferenceMap = {};
    let soloAgentSelection = '';
    let flowAgentSelection = '';
    let currentFlowState = { hasProAccess: false, flow: null, history: [] };
    let agentModelRequestSeq = 0;
    const i18n = {
      zh: {
        title: 'SoloMap',
        addProject: '添加项目文件夹',
        settingsTitle: 'SoloMap 设置',
        language: '界面语言',
        removeProject: '删除项目',
        cliPath: 'Agent CLI 命令或路径',
        cliPathHelp: '填写全局安装的 CLI 命令（如 agy、codex、cursor、claude、copilot、opencode）或可执行文件绝对路径。',
        globalPrompt: '全局默认提示词',
        globalPromptPlaceholder: '例如：始终保持改动范围最小，并运行最相关的验证。',
        globalPromptHelp: '会注入每一次任务对话；环节内本次补充要求优先级更高。',
        globalDataPath: '跨项目数据目录',
        globalDataPathPlaceholder: '例如：/home/ubuntu/project/.solomap-global',
        globalDataPathHelp: '保存跨项目组合、依赖、学习候选和指标；可填 .solomap-global 目录路径，或填其父目录。',
        reviewerCliPath: '复核 Agent',
        reviewerCliPathPlaceholder: '留空则使用主 Agent',
        reviewerCliPathHelp: '可选的副 Agent CLI，只读复核任务结果，不直接改文件。',
        collaborationReviewMode: '自动复核',
        collaborationReviewHelp: '复核会作为同一环节的一条独立对话记录。',
        reviewerSame: '跟随主 Agent',
        settingsSectionBasic: '基础',
        settingsSectionAccount: '账户与 Pro',
        settingsSectionAgent: 'Agent 协作',
        settingsSectionData: '项目数据',
        settingsSectionInstructions: '默认指令',
        settingsSectionAbilities: '能力扩展',
        proFeatureName: '战略金字塔',
        proUnlocked: '已解锁',
        proLocked: '未解锁',
        proAccountAnonymous: '未登录',
        proValidUntil: '有效期至',
        proExpirationHelp: '注：此为本地授权缓存过期时间。每次联网或执行任务时，系统都会静默刷新授权，为您顺延有效期（如购买的是年会员请放心使用）。',
        proLogin: '登录 / 升级 Pro',
        proPasteCode: '粘贴授权码',
        proAccountHelp: '登录后即可打开 Pro 功能；本地项目数据仍留在你的工作区。',
        reviewHighRisk: '高风险任务',
        reviewAll: '每次任务',
        reviewOff: '关闭',
        agentImpact: 'Agent 贡献',
        impactMinutes: '工作分钟',
        impactFiles: '改动文件',
        impactProgress: '项目推进',
        refreshAgentImpact: '刷新贡献',
        impactLoading: '正在统计贡献...',
        impactEmpty: '还没有可统计的 Agent 贡献。',
        impactRunUnit: '次',
        impactMinuteUnit: '分钟',
        impactFileUnit: '个文件',
        skillInstall: '安装技能',
        skillInstallPlaceholder: '例如：https://skills.sh/owner/repo 或 owner/repo@skill',
        skillInstallHelp: '粘贴 skills.sh 或 GitHub 技能链接，SoloMap 会安装到全局技能库。',
        installSkill: '安装技能',
        installingSkill: '正在启动安装...',
        mcpInstall: '安装连接器',
        mcpInstallPlaceholder: '例如：GitHub MCP server、npm 包名或配置片段',
        mcpInstallHelp: '粘贴 MCP 来源，SoloMap 会注册到全局能力连接器库。',
        installMcp: '安装连接器',
        installingMcp: '正在启动安装...',
        enhancementToggles: '执行增强',
        enhancementTogglesHelp: '选择一个执行增强后安装或卸载。SoloMap 会让 Agent CLI 完成用户环境里的真实安装和彻底卸载；状态会自动检测。',
        selectEnhancement: '选择增强功能',
        installingEnhancement: '正在启动安装...',
        uninstallingEnhancement: '正在启动卸载...',
        installEnhancement: '安装',
        repairEnhancement: '修复',
        enableEnhancement: '启用',
        disableEnhancement: '禁用',
        uninstallEnhancement: '卸载',
        checkEnhancement: '重新检测',
        enhancementVersion: '版本',
        enhancementStateEnabled: '已启用',
        enhancementStateDisabled: '未启用',
        feedback: '建议反馈',
        feedbackNotWorking: '没跑通',
        feedbackNextStep: '不懂下一步',
        feedbackFeature: '想要能力',
        feedbackPanelTitle: '反馈',
        feedbackTitlePlaceholder: '一句话说明想反馈的问题...',
        feedbackBodyPlaceholder: '补充现象、期望结果或改进建议...',
        openFeedback: '提交到 GitHub Issue',
        testCli: '测试 CLI',
        save: '保存',
        chooseProject: '选择项目文件夹',
        emptyRoadmap: '还没有路线图。请添加项目文件夹，或重新打开当前项目。',
        onboardingKicker: '新手开始',
        onboardingTitle: '先把一个项目交给 SoloMap',
        onboardingCopy: '选择一个本地项目文件夹。SoloMap 会带你确认项目类型，然后生成第一张可推进路线图。',
        onboardingStepProject: '添加本地项目文件夹',
        onboardingStepType: '选择这个项目更像哪一类',
        onboardingStepRoadmap: '在“生成初始路线图”里输入目标，让 Agent 产出第一版路线图',
        onboardingAction: '添加第一个项目',
        startConversation: '发起 Agent 对话',
        conversationHistory: 'Agent 对话历史',
        noConversations: '这个环节还没有 Agent 对话。',
        conversationPlaceholder: '补充这次要 Agent 注意的要求...',
        agentSelector: '选择 Agent',
        attachFiles: '选择补充文件',
        attachedFiles: '补充文件',
        removeAttachment: '移除',
        send: '发送',
        retry: '重试',
        continueNative: '继续',
        openTerminal: '打开终端',
        stopRun: '停止',
        elapsed: '已运行',
        duration: '耗时',
        runResult: '本轮结果',
        stillWorking: 'Agent 正在执行这次对话。',
        awaitingNextConversation: '本轮已结束，环节仍可继续推进。',
        stepCompleted: 'Agent 判断该环节已完成。',
        changedCount: '本轮修改文件数',
        agentConclusion: 'Agent 结论',
        failureLabel: '失败原因',
        completionCriteria: '完成标准',
        roadmapView: '环节推进',
        soloTitle: '自由研讨',
        flowTitle: '自动闭环',
        flowPlaceholder: '描述你想让 Flow 自动推进完成的目标...',
        flowHistory: '执行轨迹',
        flowStart: '启动 Flow',
        flowLocked: 'Flow 为 Pro 用户提供目标驱动的自动滚动执行。',
        flowUpgrade: '登录 / 升级 Pro',
        flowEmpty: '还没有 Flow 运行。写下目标后，系统会先规划微循环，再持续推进直到完成。',
        soloPlaceholder: '描述你现在想处理的问题或想法...',
        soloHistory: 'Solo 对话历史',
        noSoloConversations: '还没有 Solo 对话。',
        sendSolo: '发送',
        soloCompleted: '本次 Solo 对话已结束。',
        soloClosure: '这次对话是否需要进入路线图？',
        linkToStep: '关联到环节',
        keepInSolo: '无需关联时，这次对话会保留在 Solo。',
        adjustRoadmap: '调整路线图',
        chooseStep: '选择关联环节',
        linkedFromSolo: '这是一条从 Solo 关联的参考记录，不会改变环节状态。',
        failureCategories: {
          cli_not_found: '未找到所选 Agent CLI。',
          stopped_by_user: '任务已由用户停止。',
          no_deliverable_changes: 'Agent 已退出，但没有检测到文件修改或完成判断。',
          roadmap_validation_failed: '生成的路线图未通过结构校验。',
          roadmap_not_updated: 'Agent 未更新路线图，原路线图保持不变。',
          completion_state_invalid: 'Agent 返回的完成状态无法读取。',
          agent_exit_failed: 'Agent CLI 在交付任务前退出。'
        },
        command: '命令',
        output: '输出',
        changedFiles: '修改文件',
        openFile: '打开',
        testing: '正在测试连接...',
        connectionOk: '连接正常：',
        connectionFailed: '连接失败：',
        markComplete: '完成环节',
        reviseRoadmap: '调整路线图',
        reviseRoadmapPlaceholder: '描述目标、优先级或方向发生了什么变化...',
        revisionHistory: '路线图调整历史',
        noRevisionConversations: '还没有路线图调整记录。',
        sendRevision: '发送调整',
        roadmapLoading: '正在打开路线图...',
        methodologyBuild: '打造',
        methodologySell: '触达',
        methodologyLearn: '学习',
        methodologyImprove: '改进',
        methodologyMissing: '缺少对应环节',
        methodologyCompleted: '已完成',
        status: { Pending: '待处理', 'In Progress': '推进中', Running: '对话中', Completed: '已完成', Failed: '失败', Linked: '已关联' }
      },
      en: {
        title: 'SoloMap',
        addProject: 'Add project folder',
        settingsTitle: 'SoloMap Settings',
        language: 'Language',
        removeProject: 'Remove project',
        cliPath: 'CLI Command or Path',
        cliPathHelp: 'Name of a globally installed CLI such as agy, codex, cursor, claude, copilot, or opencode, or an absolute executable path.',
        globalPrompt: 'Default Agent Instructions',
        globalPromptPlaceholder: 'e.g. Keep changes minimal and run the narrowest relevant test.',
        globalPromptHelp: 'Injected into every task conversation; guidance in the current conversation takes priority.',
        globalDataPath: 'Global Data Directory',
        globalDataPathPlaceholder: 'e.g. /home/ubuntu/project/.solomap-global',
        globalDataPathHelp: 'Stores cross-project portfolio, dependencies, learning candidates, and metrics. Use the .solomap-global path or its parent directory.',
        reviewerCliPath: 'Review Agent',
        reviewerCliPathPlaceholder: 'Leave empty to use the main Agent',
        reviewerCliPathHelp: 'Optional secondary CLI for read-only review after task runs.',
        collaborationReviewMode: 'Auto Review',
        collaborationReviewHelp: 'Review runs appear as a separate conversation in the same step.',
        reviewerSame: 'Same as main Agent',
        settingsSectionBasic: 'Basics',
        settingsSectionAccount: 'Account & Pro',
        settingsSectionAgent: 'Agent Collaboration',
        settingsSectionData: 'Project Data',
        settingsSectionInstructions: 'Instructions',
        settingsSectionAbilities: 'Abilities',
        proFeatureName: 'Strategy Pyramid',
        proUnlocked: 'Unlocked',
        proLocked: 'Locked',
        proAccountAnonymous: 'Not signed in',
        proValidUntil: 'Valid until',
        proExpirationHelp: 'Note: This is the local authorization cache expiration. The system will automatically and silently refresh the authorization to extend this date whenever you are online.',
        proLogin: 'Sign in / Upgrade Pro',
        proPasteCode: 'Paste authorization code',
        proAccountHelp: 'Sign in to open Pro features; local project data stays in your workspace.',
        reviewHighRisk: 'High-risk tasks',
        reviewAll: 'Every task',
        reviewOff: 'Off',
        agentImpact: 'Agent Impact',
        impactMinutes: 'Minutes',
        impactFiles: 'Files changed',
        impactProgress: 'Project progress',
        refreshAgentImpact: 'Refresh Impact',
        impactLoading: 'Collecting impact...',
        impactEmpty: 'No Agent impact recorded yet.',
        impactRunUnit: 'runs',
        impactMinuteUnit: 'min',
        impactFileUnit: 'files',
        skillInstall: 'Install Skill',
        skillInstallPlaceholder: 'e.g. https://skills.sh/owner/repo or owner/repo@skill',
        skillInstallHelp: 'Paste a skills.sh or GitHub skill link. SoloMap installs it into the global skill library.',
        installSkill: 'Install Skill',
        installingSkill: 'Starting install...',
        mcpInstall: 'Install Connector',
        mcpInstallPlaceholder: 'e.g. GitHub MCP server, npm package, or config snippet',
        mcpInstallHelp: 'Paste an MCP source. SoloMap registers it in the global connector library.',
        installMcp: 'Install Connector',
        installingMcp: 'Starting install...',
        enhancementToggles: 'Harness Enhancements',
        enhancementTogglesHelp: 'Choose one enhancement, then install or uninstall it. SoloMap asks the Agent CLI to perform the real user-environment install or full uninstall; status is detected automatically.',
        selectEnhancement: 'Select enhancement',
        installingEnhancement: 'Starting install...',
        uninstallingEnhancement: 'Starting uninstall...',
        installEnhancement: 'Install',
        repairEnhancement: 'Repair',
        enableEnhancement: 'Enable',
        disableEnhancement: 'Disable',
        uninstallEnhancement: 'Uninstall',
        checkEnhancement: 'Check',
        enhancementVersion: 'Version',
        enhancementStateEnabled: 'Enabled',
        enhancementStateDisabled: 'Disabled',
        feedback: 'Feedback',
        feedbackNotWorking: 'Not working',
        feedbackNextStep: 'Next step unclear',
        feedbackFeature: 'Feature request',
        feedbackPanelTitle: 'Feedback',
        feedbackTitlePlaceholder: 'Summarize the issue or idea...',
        feedbackBodyPlaceholder: 'Add what happened, what you expected, or the suggestion...',
        openFeedback: 'Open GitHub Issue',
        testCli: 'Test CLI',
        save: 'Save',
        chooseProject: 'Choose project folder',
        emptyRoadmap: 'No roadmap yet. Add a project folder or reopen the current project.',
        onboardingKicker: 'Get started',
        onboardingTitle: 'Give SoloMap one local project first',
        onboardingCopy: 'Choose a local project folder. SoloMap will ask for its type, then help create the first actionable roadmap.',
        onboardingStepProject: 'Add a local project folder',
        onboardingStepType: 'Choose what kind of project it is',
        onboardingStepRoadmap: 'Use "Generate Initial Roadmap" to describe the goal and let the Agent create the first roadmap',
        onboardingAction: 'Add first project',
        startConversation: 'Start Agent Conversation',
        conversationHistory: 'Agent Conversation History',
        noConversations: 'No Agent conversations for this step yet.',
        conversationPlaceholder: 'Add guidance for this Agent run...',
        agentSelector: 'Choose Agent',
        attachFiles: 'Attach files',
        attachedFiles: 'Attached files',
        removeAttachment: 'Remove',
        send: 'Send',
        retry: 'Retry',
        continueNative: 'Continue',
        openTerminal: 'Open terminal',
        stopRun: 'Stop',
        elapsed: 'Elapsed',
        duration: 'Duration',
        runResult: 'Run result',
        stillWorking: 'The Agent is running this conversation.',
        awaitingNextConversation: 'This run ended; the step can continue.',
        stepCompleted: 'The Agent marked this step complete.',
        changedCount: 'Files changed in this run',
        agentConclusion: 'Agent conclusion',
        failureLabel: 'Failure reason',
        completionCriteria: 'Completion criteria',
        roadmapView: 'Step Progress',
        soloTitle: 'Free Work',
        flowTitle: 'Auto Loop',
        flowPlaceholder: 'Describe the goal you want Flow to drive to completion...',
        flowHistory: 'Execution trace',
        flowStart: 'Start Flow',
        flowLocked: 'Flow is a Pro mode for goal-driven automatic execution.',
        flowUpgrade: 'Sign in / Upgrade Pro',
        flowEmpty: 'No Flow run yet. Enter a goal and SoloMap will plan micro loops, then keep rolling until the task is closed.',
        soloPlaceholder: 'Describe the issue or idea you want to handle...',
        soloHistory: 'Solo conversation history',
        noSoloConversations: 'No Solo conversations yet.',
        sendSolo: 'Send',
        soloCompleted: 'This Solo conversation has finished.',
        soloClosure: 'Should this conversation be connected to the roadmap?',
        linkToStep: 'Link to step',
        keepInSolo: 'Leave unlinked to keep this conversation in Solo.',
        adjustRoadmap: 'Revise roadmap',
        chooseStep: 'Choose a step',
        linkedFromSolo: 'This is a reference linked from Solo and does not change the step state.',
        failureCategories: {
          cli_not_found: 'The selected Agent CLI was not found.',
          stopped_by_user: 'The task was stopped by the user.',
          no_deliverable_changes: 'The Agent exited without detected file changes or a completion decision.',
          roadmap_validation_failed: 'The generated roadmap failed structure validation.',
          roadmap_not_updated: 'The Agent did not update the roadmap; the previous roadmap was kept.',
          completion_state_invalid: 'The Agent completion state could not be read.',
          agent_exit_failed: 'The Agent CLI exited before delivering the task.'
        },
        command: 'Command',
        output: 'Output',
        changedFiles: 'Changed Files',
        openFile: 'Open',
        testing: 'Testing connection...',
        connectionOk: 'Connection OK: ',
        connectionFailed: 'Connection Failed: ',
        markComplete: 'Complete Step',
        reviseRoadmap: 'Revise Roadmap',
        reviseRoadmapPlaceholder: 'Describe what changed in your goal, priority, or direction...',
        revisionHistory: 'Roadmap Revision History',
        noRevisionConversations: 'No roadmap revisions yet.',
        sendRevision: 'Send revision',
        roadmapLoading: 'Opening roadmap...',
        methodologyBuild: 'Build',
        methodologySell: 'Sell',
        methodologyLearn: 'Learn',
        methodologyImprove: 'Improve',
        methodologyMissing: 'Missing step',
        methodologyCompleted: 'completed',
        status: { Pending: 'Pending', 'In Progress': 'In Progress', Running: 'Running', Completed: 'Completed', Failed: 'Failed', Linked: 'Linked' }
      }
    };

    function t(key) {
      return i18n[currentLanguage][key] || i18n.en[key] || key;
    }

    function statusText(status) {
      return (i18n[currentLanguage].status || {})[status] || status;
    }

    function conversationStatusText(status) {
      if (status === 'Completed') {
        return currentLanguage === 'zh' ? '已结束' : 'Finished';
      }
      return statusText(status);
    }

    function statusClass(status) {
      return String(status || '').replace(/[^a-zA-Z0-9]/g, '-');
    }

    function failureCategoryText(category) {
      return (i18n[currentLanguage].failureCategories || {})[category] || '';
    }

    function extractNativeSessionId(output) {
      const match = String(output || '').match(/Native Agent session saved:[^\\n]*\\(([0-9a-fA-F-]{36})\\)/);
      return match ? match[1] : '';
    }

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    function resetProjectScopedState(projectPath, clearNodes) {
      activeProjectPath = projectPath || '';
      expandedNodeId = '';
      activeMethodologyStage = '';
      roadmapRevisionExpanded = false;
      soloExpanded = false;
      flowExpanded = false;
      activeConversationId = '';
      if (soloPanel) soloPanel.classList.remove('open');
      if (soloPanel) soloPanel.classList.remove('active');
      if (flowPanel) flowPanel.classList.remove('active');
      if (canvas) canvas.classList.add('active');
      if (btnToggleRoadmapView) btnToggleRoadmapView.classList.add('active');
      if (btnToggleSolo) btnToggleSolo.classList.remove('active');
      if (btnToggleFlow) btnToggleFlow.classList.remove('active');
      if (soloBody) soloBody.innerHTML = '';
      if (flowBody) flowBody.innerHTML = '';
      if (roadmapRevisionPanel) roadmapRevisionPanel.classList.remove('open');
      if (btnToggleRoadmapRevision) btnToggleRoadmapRevision.classList.remove('active');
      if (roadmapRevisionBody) roadmapRevisionBody.innerHTML = '';
      Object.keys(nodeConversations).forEach(key => delete nodeConversations[key]);
      Object.keys(nodeSupplementFiles).forEach(key => delete nodeSupplementFiles[key]);
      Object.keys(conversationDrafts).forEach(key => delete conversationDrafts[key]);
      Object.keys(nodeAgentSelections).forEach(key => delete nodeAgentSelections[key]);
      if (clearNodes) {
        currentNodes = [];
      }
    }

    function applyLanguage() {
      setText('app-title', t('title'));
      btnAddProject.title = t('addProject');
      btnRemoveProject.title = t('removeProject');
      btnToggleSolo.title = t('soloTitle');
      if (btnToggleFlow) btnToggleFlow.title = t('flowTitle');
      if (btnToggleFeedback) btnToggleFeedback.title = t('feedbackPanelTitle');
      setText('roadmap-view-tab-label', t('roadmapView'));
      setText('solo-view-tab-label', t('soloTitle'));
      setText('flow-view-tab-label', t('flowTitle'));
      btnToggleRoadmapRevision.title = t('reviseRoadmap');
      setText('settings-title', t('settingsTitle'));
      setText('feedback-title', t('feedbackPanelTitle'));
      setText('feedback-type-not-working', t('feedbackNotWorking'));
      setText('feedback-type-next-step', t('feedbackNextStep'));
      setText('feedback-type-feature', t('feedbackFeature'));
      setText('roadmap-revision-title', t('reviseRoadmap'));
      setText('solo-title', t('soloTitle'));
      setText('label-language', t('language'));
      setText('label-cli-path', t('cliPath'));
      setText('help-cli-path', t('cliPathHelp'));
      setText('label-agent-model', currentLanguage === 'zh' ? '默认模型' : 'Default Model');
      setText('help-agent-model', currentLanguage === 'zh'
        ? '默认跟随当前 Agent 系列的自动模型；固定后会优先使用该模型。'
        : 'Uses the selected Agent family default unless you pin a specific model.');
      setText('label-global-prompt', t('globalPrompt'));
      settingGlobalPrompt.placeholder = t('globalPromptPlaceholder');
      setText('help-global-prompt', t('globalPromptHelp'));
      setText('label-global-data-path', t('globalDataPath'));
      if (settingGlobalDataPath) settingGlobalDataPath.placeholder = t('globalDataPathPlaceholder');
      setText('help-global-data-path', t('globalDataPathHelp'));
      setText('label-reviewer-cli-path', t('reviewerCliPath'));
      if (settingReviewerCliPathCustom) settingReviewerCliPathCustom.placeholder = t('reviewerCliPathPlaceholder');
      setText('help-reviewer-cli-path', t('reviewerCliPathHelp'));
      setText('label-collaboration-review-mode', t('collaborationReviewMode'));
      setText('help-collaboration-review-mode', t('collaborationReviewHelp'));
      setText('option-reviewer-same', t('reviewerSame'));
      if (settingReviewerCliSelect) setSoloSelectValue(settingReviewerCliSelect, getSoloSelectValue(settingReviewerCliSelect));
      setText('settings-section-basic', t('settingsSectionBasic'));
      setText('settings-section-account', t('settingsSectionAccount'));
      setText('settings-section-agent', t('settingsSectionAgent'));
      setText('settings-section-data', t('settingsSectionData'));
      setText('settings-section-instructions', t('settingsSectionInstructions'));
      setText('settings-section-abilities', t('settingsSectionAbilities'));
      setText('option-review-high-risk', t('reviewHighRisk'));
      setText('option-review-all', t('reviewAll'));
      setText('option-review-off', t('reviewOff'));
      if (settingCollaborationReviewMode) setSoloSelectValue(settingCollaborationReviewMode, getSoloSelectValue(settingCollaborationReviewMode) || 'high_risk');
      setText('label-agent-impact', t('agentImpact'));
      setText('impact-minutes-label', t('impactMinutes'));
      setText('impact-files-label', t('impactFiles'));
      setText('impact-progress-label', t('impactProgress'));
      setText('text-refresh-agent-impact', t('refreshAgentImpact'));
      setText('text-open-pro-authorization', t('proLogin'));
      setText('text-paste-pro-code', t('proPasteCode'));
      setText('label-enhancement-toggles', '能力扩展与执行增强');
      setText('help-enhancement-toggles', '在这里管理您的已安装技能 (Skills)、连接器 (MCP Connectors) 与内置的执行增强 (Enhancements)。');
      setText('text-install-ability', '安装');
      setText('text-uninstall-ability', '卸载');
      if (settingFeedbackTitle) settingFeedbackTitle.placeholder = t('feedbackTitlePlaceholder');
      if (settingFeedbackBody) settingFeedbackBody.placeholder = t('feedbackBodyPlaceholder');
      setText('text-open-feedback', t('openFeedback'));
      setText('text-test-cli', t('testCli'));
      setText('text-save-settings', t('save'));
      renderProjects(currentProjects.projects, currentProjects.selectedProjectPath);
      renderRoadmap(currentNodes);
      renderSoloPanel(currentNodes);
      renderFlowPanel();
      renderRoadmapRevisionPanel(currentNodes);
      renderProAccount(currentSettings);
    }

    const currentProjects = { projects: [], selectedProjectPath: '' };

    function setMainView(view) {
      activeMainView = view === 'solo' ? 'solo' : view === 'flow' ? 'flow' : 'roadmap';
      soloExpanded = activeMainView === 'solo';
      flowExpanded = activeMainView === 'flow';
      activeConversationId = '';
      if (canvas) canvas.classList.toggle('active', activeMainView === 'roadmap');
      if (soloPanel) soloPanel.classList.toggle('active', activeMainView === 'solo');
      if (flowPanel) flowPanel.classList.toggle('active', activeMainView === 'flow');
      if (btnToggleRoadmapView) btnToggleRoadmapView.classList.toggle('active', activeMainView === 'roadmap');
      if (btnToggleSolo) btnToggleSolo.classList.toggle('active', activeMainView === 'solo');
      if (btnToggleFlow) btnToggleFlow.classList.toggle('active', activeMainView === 'flow');
      if (activeMainView === 'solo' && !nodeConversations[soloConversationId]) {
        vscode.postMessage({ command: 'getNodeConversations', nodeId: soloConversationId });
      }
      if (activeMainView === 'solo') {
        ensureAgentModelsLoaded(soloAgentSelection || currentCliPath || 'agy', soloConversationId);
      }
      if (activeMainView === 'flow') {
        ensureAgentModelsLoaded(flowAgentSelection || currentCliPath || 'agy', 'flow');
        vscode.postMessage({ command: 'getFlowState' });
      }
      renderSoloPanel(currentNodes);
      renderFlowPanel();
    }

    if (btnToggleFeedback) {
      btnToggleFeedback.addEventListener('click', () => {
        if (feedbackPanel.style.display === 'flex') {
          feedbackPanel.style.display = 'none';
        } else {
          roadmapRevisionExpanded = false;
          roadmapRevisionPanel.classList.remove('open');
          btnToggleRoadmapRevision.classList.remove('active');
          settingsPanel.style.display = 'none';
          feedbackPanel.style.display = 'flex';
        }
      });
    }

    if (btnCloseFeedback) {
      btnCloseFeedback.addEventListener('click', () => {
        feedbackPanel.style.display = 'none';
      });
    }

    // Toggle Settings panel visibility
    btnToggleSettings.addEventListener('click', () => {
      if (settingsPanel.style.display === 'flex') {
        settingsPanel.style.display = 'none';
      } else {
        roadmapRevisionExpanded = false;
        roadmapRevisionPanel.classList.remove('open');
        btnToggleRoadmapRevision.classList.remove('active');
        feedbackPanel.style.display = 'none';
        settingsPanel.style.display = 'flex';
        vscode.postMessage({ command: 'getSettings' });
        requestAgentImpact();
      }
    });

    btnCloseSettings.addEventListener('click', () => {
      settingsPanel.style.display = 'none';
      cliTestBadge.style.display = 'none';
    });

    btnToggleRoadmapView.addEventListener('click', () => {
      setMainView('roadmap');
    });

    btnToggleSolo.addEventListener('click', () => {
      settingsPanel.style.display = 'none';
      cliTestBadge.style.display = 'none';
      roadmapRevisionExpanded = false;
      roadmapRevisionPanel.classList.remove('open');
      btnToggleRoadmapRevision.classList.remove('active');
      setMainView('solo');
    });

    if (btnToggleFlow) {
      btnToggleFlow.addEventListener('click', () => {
        settingsPanel.style.display = 'none';
        cliTestBadge.style.display = 'none';
        roadmapRevisionExpanded = false;
        roadmapRevisionPanel.classList.remove('open');
        btnToggleRoadmapRevision.classList.remove('active');
        if (!currentFlowState.hasProAccess) {
          vscode.postMessage({ command: 'openProAuthorization' });
          return;
        }
        setMainView('flow');
      });
    }

    btnToggleRoadmapRevision.addEventListener('click', () => {
      roadmapRevisionExpanded = !roadmapRevisionExpanded;
      activeConversationId = '';
      roadmapRevisionPanel.classList.toggle('open', roadmapRevisionExpanded);
      btnToggleRoadmapRevision.classList.toggle('active', roadmapRevisionExpanded);
      if (roadmapRevisionExpanded) {
        settingsPanel.style.display = 'none';
        feedbackPanel.style.display = 'none';
        cliTestBadge.style.display = 'none';
        setMainView('roadmap');
        if (!nodeConversations[roadmapRevisionId]) {
          vscode.postMessage({ command: 'getNodeConversations', nodeId: roadmapRevisionId });
        }
      }
      renderRoadmapRevisionPanel(currentNodes);
    });

    btnCloseRoadmapRevision.addEventListener('click', () => {
      roadmapRevisionExpanded = false;
      activeConversationId = '';
      roadmapRevisionPanel.classList.remove('open');
      btnToggleRoadmapRevision.classList.remove('active');
      renderRoadmapRevisionPanel(currentNodes);
    });

    bindSoloSelect(settingLanguage, (value) => {
      currentLanguage = value;
      applyLanguage();
    });

    bindSoloSelect(settingCliSelect, () => {
      // Toggle custom input visibility; the label is handled by solo-select itself.
      const selected = getSoloSelectValue(settingCliSelect);
      settingCliPathCustom.style.display = selected === 'custom' ? 'block' : 'none';
      currentCliPath = selected === 'custom' ? getEffectiveSettingCliPath() : selected || 'agy';
      ensureAgentModelsLoaded(currentCliPath, 'settings');
      syncSettingAgentModelSelect();
    });
    if (settingCliPathCustom) {
      const refreshCustomCliModels = () => {
        if (getSoloSelectValue(settingCliSelect) !== 'custom') return;
        currentCliPath = getEffectiveSettingCliPath();
        ensureAgentModelsLoaded(currentCliPath, 'settings');
        syncSettingAgentModelSelect();
      };
      settingCliPathCustom.addEventListener('input', refreshCustomCliModels);
      settingCliPathCustom.addEventListener('change', refreshCustomCliModels);
    }
    bindSoloSelect(settingAgentModelSelect, (value) => {
      const family = getAgentFamilyKey(getEffectiveSettingCliPath());
      if (!family) return;
      agentModelPreferenceMap[family] = value || 'auto';
      conversationModelSelections.settings = value || 'auto';
    });
    bindSoloSelect(settingReviewerCliSelect, () => {
      const selected = getSoloSelectValue(settingReviewerCliSelect);
      if (settingReviewerCliPathCustom) {
        settingReviewerCliPathCustom.style.display = selected === 'custom' ? 'block' : 'none';
      }
    });
    bindSoloSelect(settingCollaborationReviewMode, () => {});

    if (btnOpenProAuthorization) {
      btnOpenProAuthorization.addEventListener('click', () => {
        vscode.postMessage({ command: 'openProAuthorization' });
      });
    }

    if (btnPasteProCode) {
      btnPasteProCode.addEventListener('click', () => {
        vscode.postMessage({ command: 'pasteProAuthorizationCode' });
      });
    }

    function showAbilityActionMessage(message, isError = false) {
      if (!abilityActionBadge) return;
      abilityActionBadge.style.display = 'block';
      abilityActionBadge.className = isError ? 'cli-badge error' : 'cli-badge';
      abilityActionBadge.style.background = isError ? '' : 'rgba(255,255,255,0.05)';
      abilityActionBadge.style.color = isError ? '' : 'var(--text-muted)';
      abilityActionBadge.textContent = message;
    }

    function getCliPresetFromCliPath(cliPath) {
      const raw = String(cliPath || '').trim();
      if (!raw) return 'agy';
      // NOTE: this code runs inside a Webview <script> string; escaping must survive TS template literal parsing.
      const base = raw.split(/[\\\\/]/).pop().toLowerCase();
      if (['agy', 'antigravity', 'antigravity-cli'].includes(base)) return 'agy';
      if (['codex', 'codex-cli'].includes(base)) return 'codex';
      if (['cursor', 'cursor-cli', 'cursor-agent'].includes(base)) return 'cursor';
      if (['copilot', 'copilot-cli'].includes(base)) return 'copilot';
      if (['claude', 'claude-code', 'claude-code-cli'].includes(base)) return 'claude';
      if (['opencode', 'open-code', 'open-code-cli'].includes(base)) return 'opencode';
      return 'custom';
    }

    function getAgentFamilyKey(agentCli) {
      const normalized = normalizeAgentOptionLabel(agentCli || getEffectiveSettingCliPath() || currentCliPath || 'agy');
      return String(normalized || 'agy').toLowerCase();
    }

    function getAutoModelLabel() {
      return 'Auto';
    }

    function getAutoOnlyModelCatalog(agentCli) {
      return {
        agentCli: getAgentFamilyKey(agentCli),
        supportsDiscovery: false,
        models: [{ value: 'auto', label: getAutoModelLabel() }]
      };
    }

    function getAgentModelCatalog(agentCli) {
      const family = getAgentFamilyKey(agentCli);
      return agentModelCatalogs[family] || getAutoOnlyModelCatalog(family);
    }

    function getAgentModelOptions(agentCli) {
      const catalog = getAgentModelCatalog(agentCli);
      const options = Array.isArray(catalog.models) && catalog.models.length
        ? catalog.models
        : getAutoOnlyModelCatalog(agentCli).models;
      return options.map(option => ({
        value: String(option.value || 'auto'),
        label: String(option.label || option.value || getAutoModelLabel()),
        title: String(option.description || option.label || option.value || getAutoModelLabel())
      }));
    }

    function sanitizeModelValue(agentCli, value) {
      const options = getAgentModelOptions(agentCli);
      const selectedValue = String(value || 'auto');
      return options.some(option => option.value === selectedValue) ? selectedValue : 'auto';
    }

    function getStoredModelPreference(agentCli) {
      const family = getAgentFamilyKey(agentCli);
      return sanitizeModelValue(agentCli, agentModelPreferenceMap[family] || 'auto');
    }

    function getTargetModelValue(targetId, agentCli) {
      if (targetId && conversationModelSelections[targetId]) {
        return sanitizeModelValue(agentCli, conversationModelSelections[targetId]);
      }
      return getStoredModelPreference(agentCli);
    }

    function setTargetModelValue(targetId, agentCli, value, persistPreference) {
      const nextValue = sanitizeModelValue(agentCli, value);
      if (targetId) {
        conversationModelSelections[targetId] = nextValue;
      }
      if (persistPreference) {
        agentModelPreferenceMap[getAgentFamilyKey(agentCli)] = nextValue;
      }
      return nextValue;
    }

    function ensureAgentModelsLoaded(agentCli, targetId) {
      const effectiveCli = String(agentCli || '').trim() || currentCliPath || 'agy';
      const requestId = 'models-' + (++agentModelRequestSeq);
      vscode.postMessage({
        command: 'getAgentModels',
        requestId,
        targetId: targetId || '',
        agentCli: effectiveCli
      });
    }

    function renderModelSelect(className, attributes, agentCli, targetId) {
      return renderSoloSelect(
        className,
        attributes,
        getAgentModelOptions(agentCli),
        false,
        getTargetModelValue(targetId, agentCli)
      );
    }

    function syncSettingAgentModelSelect() {
      if (!settingAgentModelSelect) return;
      const agentCli = getEffectiveSettingCliPath();
      setSoloSelectOptions(settingAgentModelSelect, getAgentModelOptions(agentCli), getStoredModelPreference(agentCli));
      setTargetModelValue('settings', agentCli, getSoloSelectValue(settingAgentModelSelect), true);
    }

    function getEffectiveSettingCliPath() {
      const selected = getSoloSelectValue(settingCliSelect);
      if (selected === 'custom') {
        return (settingCliPathCustom.value || '').trim() || 'agy';
      }
      if (currentCliPath && getCliPresetFromCliPath(currentCliPath) === selected) {
        return currentCliPath;
      }
      return selected || 'agy';
    }

    function applySettingCliPath(cliPath) {
      const raw = String(cliPath || '').trim() || 'agy';
      const preset = getCliPresetFromCliPath(raw);
      currentCliPath = raw;
      setSoloSelectValue(settingCliSelect, preset);
      if (preset === 'custom') {
        settingCliPathCustom.value = raw;
        settingCliPathCustom.style.display = 'block';
      } else {
        settingCliPathCustom.value = '';
        settingCliPathCustom.style.display = 'none';
      }
    }

    function getEffectiveReviewerCliPath() {
      const selected = getSoloSelectValue(settingReviewerCliSelect);
      if (!selected) return '';
      if (selected === 'custom') {
        return (settingReviewerCliPathCustom.value || '').trim();
      }
      return selected;
    }

    function applyReviewerCliPath(cliPath) {
      const raw = String(cliPath || '').trim();
      if (!raw) {
        setSoloSelectValue(settingReviewerCliSelect, '');
        if (settingReviewerCliPathCustom) {
          settingReviewerCliPathCustom.value = '';
          settingReviewerCliPathCustom.style.display = 'none';
        }
        return;
      }
      const preset = getCliPresetFromCliPath(raw);
      setSoloSelectValue(settingReviewerCliSelect, preset);
      if (settingReviewerCliPathCustom) {
        if (preset === 'custom') {
          settingReviewerCliPathCustom.value = raw;
          settingReviewerCliPathCustom.style.display = 'block';
        } else {
          settingReviewerCliPathCustom.value = '';
          settingReviewerCliPathCustom.style.display = 'none';
        }
      }
    }

    function hasStrategyPyramidPro(settings) {
      const entitlements = (settings && settings.proEntitlements) || {};
      const account = (settings && settings.proAccount) || {};
      return Boolean(account.allowed || entitlements.strategy_pyramid || entitlements.strategyPyramid || entitlements.pro || entitlements.solomap_pro);
    }

    function renderProAccount(settings) {
      if (!proAccountPanel) return;
      const account = (settings && settings.proAccount) || {};
      const unlocked = hasStrategyPyramidPro(settings || {});
      const email = String(account.email || '').trim();
      const expiresAt = String(account.expiresAt || '').trim();
      let expiresText = '';
      if (expiresAt) {
        const dateText = new Date(expiresAt).toLocaleDateString(currentLanguage === 'zh' ? 'zh-CN' : 'en-US');
        expiresText = '<div class="dependency-message">' + escapeHtml(t('proValidUntil')) + ' ' + escapeHtml(dateText) + '</div>'
          + '<div class="dependency-message" style="font-size: 10px; opacity: 0.8; line-height: 1.35; margin-top: 2px; color: var(--vscode-descriptionForeground, var(--text-muted));">' + escapeHtml(t('proExpirationHelp')) + '</div>';
      }
      proAccountPanel.innerHTML =
        '<div class="dependency-item">'
        + '<div class="dependency-info">'
        + '<div class="dependency-name">' + escapeHtml(t('proFeatureName')) + '</div>'
        + '<div class="dependency-message">' + escapeHtml(email || t('proAccountAnonymous')) + '</div>'
        + expiresText
        + '<div class="dependency-message">' + escapeHtml(t('proAccountHelp')) + '</div>'
        + '</div>'
        + '<span class="dependency-status ' + (unlocked ? 'ready' : 'missing') + '">' + escapeHtml(unlocked ? t('proUnlocked') : t('proLocked')) + '</span>'
        + '</div>';
    }

    let selectedAbilityId = '';
    let currentAbilitySettings = null;

    function renderAbilitiesAndEnhancements(settings) {
      if (!settingAbilitySelect || !settingsAbilityUrlInputContainer || !settingAbilityUrlInput || !helpAbilityUrlInput || !abilityDetailCard || !btnInstallAbility || !btnUninstallAbility) {
        return;
      }
      currentAbilitySettings = settings;
      const skills = Array.isArray(settings.skills) ? settings.skills : [];
      const connectors = Array.isArray(settings.connectors) ? settings.connectors : [];
      const enhancements = Array.isArray(settings.enhancementStatuses) ? settings.enhancementStatuses : [];

      const items = [];
      skills.forEach(s => {
        items.push({
          id: 'skill-' + s.id,
          type: 'skill',
          originId: s.id,
          title: s.title || s.id,
          description: s.description || '',
          installed: true,
          statusLabel: '已安装',
          statusClass: 'ready',
          meta: '技能路径：' + (s.entry || '')
        });
      });
      items.push({
        id: 'add-new-skill',
        type: 'add-new-skill',
        title: '➕ 新增技能...',
        description: '安装外部技能以扩展能力',
        installed: false
      });

      connectors.forEach(c => {
        items.push({
          id: 'connector-' + c.id,
          type: 'connector',
          originId: c.id,
          title: c.title || c.id,
          description: c.description || '',
          installed: true,
          statusLabel: '已安装',
          statusClass: 'ready',
          meta: '连接器类型：' + (c.type || 'mcp')
        });
      });
      items.push({
        id: 'add-new-connector',
        type: 'add-new-connector',
        title: '➕ 新增连接器...',
        description: '集成外部 MCP 服务生态',
        installed: false
      });

      enhancements.forEach(e => {
        const isInstalled = e.status === 'ready' || e.installed;
        items.push({
          id: 'enhancement-' + e.id,
          type: 'enhancement',
          originId: e.id,
          title: e.title || e.id,
          description: e.description || '',
          installed: isInstalled,
          statusLabel: e.statusLabel || (isInstalled ? '已就绪' : '未安装'),
          statusClass: e.status || (isInstalled ? 'ready' : 'missing'),
          meta: '内置增强 · 版本：' + (e.version || 'unknown')
        });
      });

      if (!selectedAbilityId || !items.some(item => item.id === selectedAbilityId)) {
        selectedAbilityId = items.length > 0 ? items[0].id : '';
      }
      const selectedItem = items.find(item => item.id === selectedAbilityId) || items[0];

      let optionsHtml = '';
      
      optionsHtml += '<div class="solo-select-group-header">技能 (Skills)</div>';
      optionsHtml += items.filter(i => i.type === 'skill' || i.type === 'add-new-skill').map(item => 
        '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(item.id) + '" aria-selected="' + (item.id === selectedItem.id ? 'true' : 'false') + '">' + escapeHtml(item.title) + '</button>'
      ).join('');

      optionsHtml += '<div class="solo-select-group-header">连接器 (MCP Connectors)</div>';
      optionsHtml += items.filter(i => i.type === 'connector' || i.type === 'add-new-connector').map(item => 
        '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(item.id) + '" aria-selected="' + (item.id === selectedItem.id ? 'true' : 'false') + '">' + escapeHtml(item.title) + '</button>'
      ).join('');

      optionsHtml += '<div class="solo-select-group-header">执行增强 (Enhancements)</div>';
      optionsHtml += items.filter(i => i.type === 'enhancement').map(item => 
        '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(item.id) + '" aria-selected="' + (item.id === selectedItem.id ? 'true' : 'false') + '">' + escapeHtml(item.title) + '</button>'
      ).join('');

      const selectMenu = settingAbilitySelect.querySelector('[data-solo-menu]');
      if (selectMenu) {
        selectMenu.innerHTML = optionsHtml;
      }
      
      const selectLabel = settingAbilitySelect.querySelector('[data-solo-label]');
      if (selectLabel) {
        selectLabel.textContent = selectedItem.title;
      }
      settingAbilitySelect.setAttribute('data-value', selectedItem.id);

      if (selectedItem.type === 'add-new-skill') {
        settingsAbilityUrlInputContainer.style.display = 'block';
        settingAbilityUrlInput.placeholder = 'e.g. https://skills.sh/owner/repo or owner/repo@skill';
        helpAbilityUrlInput.textContent = '粘贴 skills.sh 或 GitHub 技能仓库链接。SoloMap 会将其安装到全局技能库中。';
        abilityDetailCard.style.display = 'none';
        btnInstallAbility.removeAttribute('disabled');
        btnUninstallAbility.setAttribute('disabled', 'true');
      } else if (selectedItem.type === 'add-new-connector') {
        settingsAbilityUrlInputContainer.style.display = 'block';
        settingAbilityUrlInput.placeholder = 'e.g. GitHub MCP server URL, npm package, or config snippet';
        helpAbilityUrlInput.textContent = '粘贴 MCP 连接器源。SoloMap 将其注册为全局连接器。';
        abilityDetailCard.style.display = 'none';
        btnInstallAbility.removeAttribute('disabled');
        btnUninstallAbility.setAttribute('disabled', 'true');
      } else {
        settingsAbilityUrlInputContainer.style.display = 'none';
        abilityDetailCard.style.display = 'block';
        abilityDetailTitle.textContent = selectedItem.title;
        abilityDetailDesc.textContent = selectedItem.description;
        abilityDetailStatus.textContent = selectedItem.statusLabel;
        abilityDetailStatus.className = 'enhancement-status ' + selectedItem.statusClass;
        abilityDetailMeta.textContent = selectedItem.meta || '';
        
        if (selectedItem.type === 'enhancement') {
          if (selectedItem.installed) {
            btnInstallAbility.setAttribute('disabled', 'true');
            btnUninstallAbility.removeAttribute('disabled');
          } else {
            btnInstallAbility.removeAttribute('disabled');
            btnUninstallAbility.setAttribute('disabled', 'true');
          }
        } else {
          btnInstallAbility.setAttribute('disabled', 'true');
          btnUninstallAbility.removeAttribute('disabled');
        }
      }

      bindSoloSelect(settingAbilitySelect, (value) => {
        selectedAbilityId = value || '';
        renderAbilitiesAndEnhancements(settings);
      });
    }

    if (btnInstallAbility) {
      btnInstallAbility.addEventListener('click', () => {
        if (!selectedAbilityId || !currentAbilitySettings) return;
        
        if (selectedAbilityId === 'add-new-skill') {
          const urlVal = settingAbilityUrlInput.value.trim();
          if (!urlVal) {
            showAbilityActionMessage('请先输入要安装的技能链接。', true);
            return;
          }
          showAbilityActionMessage('正在安装技能...');
          vscode.postMessage({ command: 'installSkill', skillInput: urlVal });
        } else if (selectedAbilityId === 'add-new-connector') {
          const urlVal = settingAbilityUrlInput.value.trim();
          if (!urlVal) {
            showAbilityActionMessage('请先输入要安装的连接器源。', true);
            return;
          }
          showAbilityActionMessage('正在安装连接器...');
          vscode.postMessage({ command: 'installMcp', mcpInput: urlVal });
        } else if (selectedAbilityId.startsWith('enhancement-')) {
          const originId = selectedAbilityId.substring('enhancement-'.length);
          showAbilityActionMessage('正在安装执行增强...');
          vscode.postMessage({ command: 'installEnhancement', enhancementId: originId });
        }
      });
    }

    if (btnUninstallAbility) {
      btnUninstallAbility.addEventListener('click', () => {
        if (!selectedAbilityId || !currentAbilitySettings) return;
        
        if (selectedAbilityId.startsWith('skill-')) {
          const originId = selectedAbilityId.substring('skill-'.length);
          showAbilityActionMessage('正在卸载技能...');
          vscode.postMessage({ command: 'uninstallSkill', skillId: originId });
        } else if (selectedAbilityId.startsWith('connector-')) {
          const originId = selectedAbilityId.substring('connector-'.length);
          showAbilityActionMessage('正在卸载连接器...');
          vscode.postMessage({ command: 'uninstallMcp', mcpId: originId });
        } else if (selectedAbilityId.startsWith('enhancement-')) {
          const originId = selectedAbilityId.substring('enhancement-'.length);
          showAbilityActionMessage('正在卸载执行增强...');
          vscode.postMessage({ command: 'uninstallEnhancement', enhancementId: originId });
        }
      });
    }

    document.addEventListener('click', event => {
      const rollbackBtn = event.target.closest('.rollback-btn');
      if (rollbackBtn) {
        event.stopPropagation();
        const gitHash = rollbackBtn.getAttribute('data-rollback-hash');
        if (gitHash) {
          vscode.postMessage({
            command: 'rollbackChanges',
            gitHash: gitHash,
            projectPath: activeProjectPath
          });
        }
      }
    });

    // Request nodes and settings on load
    vscode.postMessage({ command: 'getNodes' });
    vscode.postMessage({ command: 'getSettings' });
    vscode.postMessage({ command: 'getProjects' });
    vscode.postMessage({ command: 'getFlowState' });
    if (typeof setInterval === 'function') {
      setInterval(() => {
        if (expandedNodeId && currentNodes.some(node => node.status === 'Running')) {
          renderRoadmap(currentNodes);
        }
        const revisionRunning = (nodeConversations[roadmapRevisionId] || [])
          .some(conversation => conversation.status === 'Running');
        if (roadmapRevisionExpanded && revisionRunning) {
          renderRoadmapRevisionPanel(currentNodes);
        }
        const soloRunning = (nodeConversations[soloConversationId] || [])
          .some(conversation => conversation.status === 'Running');
        if (soloExpanded && soloRunning) {
          renderSoloPanel(currentNodes);
        }
        if (flowExpanded && currentFlowState.flow && currentFlowState.flow.status === 'running') {
          renderFlowPanel();
        }
      }, 1000);
    }

    // Handle messages from Extension Host
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'roadmapLoading':
          currentRoadmapLoading = true;
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            resetProjectScopedState(message.projectPath, true);
          }
          renderRoadmap(currentNodes);
          break;
        case 'nodesUpdated':
          currentRoadmapLoading = false;
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            resetProjectScopedState(message.projectPath, false);
          }
          currentNodes = message.nodes || [];
          renderRoadmap(message.nodes);
          renderSoloPanel(currentNodes);
          renderFlowPanel();
          renderRoadmapRevisionPanel(currentNodes);
          break;
        case 'settingsLoaded':
          currentSettings = message.settings || {};
          Object.keys(agentModelPreferenceMap).forEach(key => delete agentModelPreferenceMap[key]);
          Object.assign(agentModelPreferenceMap, (message.settings && message.settings.agentModelPreferences) || {});
          applySettingCliPath(message.settings.cliPath || 'agy');
          soloAgentSelection = getEffectiveSettingCliPath();
          flowAgentSelection = getEffectiveSettingCliPath();
          settingGlobalPrompt.value = message.settings.globalPrompt || '';
          if (settingGlobalDataPath) settingGlobalDataPath.value = message.settings.globalDataPath || '';
          applyReviewerCliPath(message.settings.reviewerCliPath || '');
          if (settingCollaborationReviewMode) setSoloSelectValue(settingCollaborationReviewMode, message.settings.collaborationReviewMode || 'high_risk');
          syncSettingAgentModelSelect();
          ensureAgentModelsLoaded(getEffectiveSettingCliPath(), 'settings');
          renderProAccount(currentSettings);
          renderAbilitiesAndEnhancements(message.settings);
          setSoloSelectValue(settingLanguage, message.settings.language || 'zh');
          currentLanguage = getSoloSelectValue(settingLanguage);
          applyLanguage();
          renderFlowPanel();
          break;
        case 'agentModelsLoaded': {
          const catalog = message.catalog || getAutoOnlyModelCatalog(message.targetId || '');
          const family = String(catalog.family || getAgentFamilyKey(message.agentCli || currentCliPath || 'agy')).toLowerCase();
          agentModelCatalogs[family] = catalog;
          syncSettingAgentModelSelect();
          if (message.targetId === soloConversationId) {
            renderSoloPanel(currentNodes);
          } else if (message.targetId === 'flow') {
            renderFlowPanel();
          } else if (message.targetId && message.targetId !== 'settings') {
            renderRoadmap(currentNodes);
          }
          break;
        }
        case 'flowStateLoaded':
          currentFlowState = message.state || { hasProAccess: false, flow: null, history: [] };
          renderFlowPanel();
          break;
        case 'setMainView':
          if (message.view === 'flow' && !currentFlowState.hasProAccess) {
            setMainView('roadmap');
            break;
          }
          setMainView(message.view || 'roadmap');
          break;
        case 'projectsLoaded':
          if (
            message.projects.selectedProjectPath &&
            activeProjectPath &&
            message.projects.selectedProjectPath !== activeProjectPath
          ) {
            resetProjectScopedState(message.projects.selectedProjectPath, true);
            renderRoadmap(currentNodes);
          } else if (message.projects.selectedProjectPath && !activeProjectPath) {
            activeProjectPath = message.projects.selectedProjectPath;
          }
          currentProjects.projects = message.projects.projects || [];
          currentProjects.selectedProjectPath = message.projects.selectedProjectPath || '';
          renderProjects(message.projects.projects, message.projects.selectedProjectPath);
          vscode.postMessage({ command: 'getFlowState' });
          break;
        case 'nodeConversationsLoaded':
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            return;
          }
          nodeConversations[message.nodeId] = message.conversations || [];
          renderRoadmap(currentNodes);
          renderSoloPanel(currentNodes);
          renderRoadmapRevisionPanel(currentNodes);
          break;
        case 'supplementFilesSelected':
          const soloDraft = message.nodeId === soloConversationId
            ? (soloBody.querySelector('[data-solo-input]')?.value || '')
            : '';
          const revisionDraft = message.nodeId === roadmapRevisionId
            ? (roadmapRevisionBody.querySelector('[data-roadmap-revision-input]')?.value || '')
            : '';
          if (message.nodeId && message.nodeId !== soloConversationId && message.nodeId !== roadmapRevisionId) {
            const input = canvas.querySelector('[data-conversation-input-id="' + cssEscape(message.nodeId) + '"]');
            conversationDrafts[message.nodeId] = input ? input.value : (conversationDrafts[message.nodeId] || '');
          }
          nodeSupplementFiles[message.nodeId] = mergeSupplementFiles(
            nodeSupplementFiles[message.nodeId] || [],
            message.files || []
          );
          renderRoadmap(currentNodes);
          if (message.nodeId === soloConversationId) {
            renderSoloPanel(currentNodes);
            const input = soloBody.querySelector('[data-solo-input]');
            if (input) {
              input.value = soloDraft;
            }
          }
          if (message.nodeId === roadmapRevisionId) {
            renderRoadmapRevisionPanel(currentNodes);
            const input = roadmapRevisionBody.querySelector('[data-roadmap-revision-input]');
            if (input) {
              input.value = revisionDraft;
            }
          }
          break;
        case 'cliTestResult':
          cliTestBadge.style.display = 'block';
          if (message.success) {
            cliTestBadge.className = 'cli-badge success';
            cliTestBadge.textContent = t('connectionOk') + message.message;
          } else {
            cliTestBadge.className = 'cli-badge error';
            cliTestBadge.textContent = t('connectionFailed') + message.message;
          }
          break;
        case 'agentImpactLoaded':
          renderAgentImpact(message.status || {});
          break;
        case 'skillInstallResult':
          if (abilityActionBadge) {
            abilityActionBadge.style.display = 'block';
            abilityActionBadge.className = message.success ? 'cli-badge success' : 'cli-badge error';
            abilityActionBadge.textContent = message.message || '';
          }
          if (message.settings) renderAbilitiesAndEnhancements(message.settings);
          break;
        case 'mcpInstallResult':
          if (abilityActionBadge) {
            abilityActionBadge.style.display = 'block';
            abilityActionBadge.className = message.success ? 'cli-badge success' : 'cli-badge error';
            abilityActionBadge.textContent = message.message || '';
          }
          if (message.settings) renderAbilitiesAndEnhancements(message.settings);
          break;
        case 'enhancementInstallResult':
          if (abilityActionBadge) {
            abilityActionBadge.style.display = 'block';
            abilityActionBadge.className = message.success ? 'cli-badge success' : 'cli-badge error';
            abilityActionBadge.textContent = message.message || '';
          }
          if (message.settings) renderAbilitiesAndEnhancements(message.settings);
          break;
      }
    });

    // Save configurations
    btnSaveSettings.addEventListener('click', () => {
      const effectiveCliPath = getEffectiveSettingCliPath();
      vscode.postMessage({
        command: 'updateSettings',
        cliPath: effectiveCliPath,
        agentModelPreferences: agentModelPreferenceMap,
        language: getSoloSelectValue(settingLanguage),
        globalPrompt: settingGlobalPrompt.value.trim(),
        globalDataPath: settingGlobalDataPath ? settingGlobalDataPath.value.trim() : '',
        reviewerCliPath: getEffectiveReviewerCliPath(),
        collaborationReviewMode: settingCollaborationReviewMode ? getSoloSelectValue(settingCollaborationReviewMode) : 'high_risk'
      });
      settingsPanel.style.display = 'none';
      cliTestBadge.style.display = 'none';
    });

    // Test CLI path
    btnTestCli.addEventListener('click', () => {
      cliTestBadge.style.display = 'block';
      cliTestBadge.className = 'cli-badge';
      cliTestBadge.style.background = 'rgba(255,255,255,0.05)';
      cliTestBadge.style.color = 'var(--text-muted)';
      cliTestBadge.textContent = t('testing');

      vscode.postMessage({
        command: 'testCli',
        cliPath: getEffectiveSettingCliPath()
      });
    });

    if (btnRefreshAgentImpact) {
      btnRefreshAgentImpact.addEventListener('click', () => {
        requestAgentImpact();
      });
    }

    function requestAgentImpact() {
      setAgentImpactPending();
      vscode.postMessage({
        command: 'getAgentImpact',
        cliPath: getEffectiveSettingCliPath()
      });
    }

    function setAgentImpactPending() {
      setText('impact-minutes', '...');
      setText('impact-files', '...');
      setText('impact-progress', '...');
      if (agentImpactList) {
        agentImpactList.innerHTML = '<div class="impact-agent-detail">' + escapeHtml(t('impactLoading')) + '</div>';
      }
    }

    function renderAgentImpact(status) {
      const impact = status.impact || {};
      setText('impact-minutes', String(impact.totalMinutes || 0));
      setText('impact-files', String(impact.changedFiles || 0));
      setText('impact-progress', String(impact.projectProgressPercent || 0) + '%');
      if (!agentImpactList) return;
      const agents = Array.isArray(impact.byAgent) ? impact.byAgent : [];
      if (!agents.length) {
        agentImpactList.innerHTML = '<div class="impact-agent-detail">' + escapeHtml(t('impactEmpty')) + '</div>';
        return;
      }
      agentImpactList.innerHTML = agents.map((agent) => {
        const detail = [
          (agent.runs || 0) + ' ' + t('impactRunUnit'),
          (agent.minutes || 0) + ' ' + t('impactMinuteUnit'),
          (agent.changedFiles || 0) + ' ' + t('impactFileUnit')
        ].join(' · ');
        return \`
          <div class="impact-agent-row">
            <div class="impact-agent-main">
              <div class="impact-agent-name">\${escapeHtml(agent.agent || '')}</div>
              <div class="impact-agent-detail">\${escapeHtml(detail)}</div>
            </div>
            <span class="impact-status ready">\${escapeHtml(String(agent.changedFiles || 0))}</span>
          </div>
        \`;
      }).join('');
    }


    if (btnOpenFeedback) {
      btnOpenFeedback.addEventListener('click', () => {
        vscode.postMessage({
          command: 'openFeedbackIssue',
          title: settingFeedbackTitle ? settingFeedbackTitle.value.trim() : '',
          body: settingFeedbackBody ? settingFeedbackBody.value.trim() : '',
          category: currentFeedbackType
        });
      });
    }

    document.querySelectorAll('[data-feedback-type]').forEach(button => {
      button.addEventListener('click', () => {
        currentFeedbackType = button.getAttribute('data-feedback-type') || 'not_working';
        document.querySelectorAll('[data-feedback-type]').forEach(item => {
          item.classList.toggle('active', item === button);
        });
      });
    });

    bindSoloSelect(projectSelect, (value) => {
      vscode.postMessage({
        command: 'selectProject',
        projectPath: value
      });
    });

    bindSoloSelect(projectTypeSelect, (value) => {
      const projectPath = getSoloSelectValue(projectSelect);
      if (!projectPath) return;
      vscode.postMessage({
        command: 'updateProjectMetadata',
        projectPath,
        projectType: value,
        priority: getSoloSelectValue(projectPrioritySelect)
      });
    });

    bindSoloSelect(projectPrioritySelect, (value) => {
      const projectPath = getSoloSelectValue(projectSelect);
      if (!projectPath) return;
      vscode.postMessage({
        command: 'updateProjectMetadata',
        projectPath,
        projectType: getSoloSelectValue(projectTypeSelect),
        priority: value
      });
    });

    btnAddProject.addEventListener('click', () => {
      vscode.postMessage({ command: 'addProject' });
    });

    btnRemoveProject.addEventListener('click', () => {
      const projectPath = getSoloSelectValue(projectSelect);
      if (!projectPath) return;
      vscode.postMessage({ command: 'removeProject', projectPath });
    });

    function renderProjects(projects, selectedProjectPath) {
      if (!projects || projects.length === 0) {
        setSoloSelectOptions(projectSelect, [{ value: '', label: t('chooseProject') }], '');
        setSoloSelectOptions(projectTypeSelect, [{ value: '', label: 'Type' }], '');
        setSoloSelectOptions(projectPrioritySelect, [{ value: '', label: 'Priority' }], '');
        return;
      }

      const selectedProject = projects.find(project => project.path === selectedProjectPath) || projects[0];
      setSoloSelectOptions(projectSelect, projects.map(project => ({
        value: project.path,
        label: project.name,
        title: project.path
      })), selectedProjectPath);
      setSoloSelectOptions(projectTypeSelect, getProjectTypeOptions(), selectedProject && selectedProject.type ? selectedProject.type : 'core_product');
      setSoloSelectOptions(projectPrioritySelect, getProjectPriorityOptions(), selectedProject && selectedProject.priority ? selectedProject.priority : '');
    }

    function getProjectTypeOptions() {
      return [
        { value: 'core_product', label: '核心产品' },
        { value: 'infra', label: '基础设施' },
        { value: 'content', label: '内容产品' },
        { value: 'experiment', label: '试验研究' },
        { value: 'tool', label: '工具脚手架' },
        { value: 'daily_work', label: '日常工作处理' },
        { value: 'archive', label: '归档维护' }
      ];
    }

    function getProjectPriorityOptions() {
      return [
        { value: '', label: '自动优先级' },
        { value: 'P0', label: 'P0' },
        { value: 'P1', label: 'P1' },
        { value: 'P2', label: 'P2' }
      ];
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function closeSoloSelects(except) {
      document.querySelectorAll('[data-solo-select]').forEach(select => {
        if (select !== except) {
          select.classList.remove('open');
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', 'false');
        }
      });
    }

    function setSoloSelectValue(select, value) {
      if (!select) return;
      const choices = Array.from(select.querySelectorAll('[data-solo-option-value]'));
      const selected = choices.find(choice => choice.getAttribute('data-solo-option-value') === String(value || '')) || choices[0];
      const selectedValue = selected ? selected.getAttribute('data-solo-option-value') || '' : '';
      select.setAttribute('data-value', selectedValue);
      const label = select.querySelector('[data-solo-label]');
      if (label) label.textContent = selected ? selected.textContent || '' : '';
      choices.forEach(choice => choice.setAttribute('aria-selected', choice === selected ? 'true' : 'false'));
    }

    function getSoloSelectValue(select) {
      return select ? select.getAttribute('data-value') || '' : '';
    }

    function setSoloSelectOptions(select, options, selectedValue) {
      const menu = select && select.querySelector('[data-solo-menu]');
      if (!menu) return;
      menu.innerHTML = (options || []).map(option => (
        '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(option.value) +
        '" title="' + escapeHtml(option.title || option.label) + '" aria-selected="false">' +
        escapeHtml(option.label) + '</button>'
      )).join('');
      setSoloSelectValue(select, selectedValue);
    }

    function renderSoloSelect(className, attributes, options, disabled, selectedValue) {
      const selected = options.find(option => String(option.value || '') === String(selectedValue || '')) || options[0] || { value: '', label: '' };
      const disabledClass = disabled ? ' is-disabled' : '';
      const disabledAttribute = disabled ? ' disabled' : '';
      return '<div class="solo-select ' + className + disabledClass + '" data-solo-select data-value="' + escapeHtml(selected.value) + '" ' + attributes + '>' +
        '<button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false"' + disabledAttribute + '>' +
        '<span class="solo-select-trigger-label" data-solo-label>' + escapeHtml(selected.label) + '</span>' +
        '<span class="codicon codicon-chevron-down solo-select-caret"></span></button>' +
        '<div class="solo-select-menu" data-solo-menu role="listbox">' +
        options.map((option, index) => '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(option.value) +
          '" aria-selected="' + (String(option.value || '') === String(selected.value || '') || (!selected.value && index === 0) ? 'true' : 'false') + '">' + escapeHtml(option.label) + '</button>').join('') +
        '</div></div>';
    }

    function bindSoloSelect(select, onChange) {
      if (!select || select.getAttribute('data-solo-bound') === 'true') return;
      select.setAttribute('data-solo-bound', 'true');
      select.addEventListener('click', event => {
        event.stopPropagation();
        const option = event.target.closest('[data-solo-option-value]');
        if (option) {
          const previousValue = getSoloSelectValue(select);
          setSoloSelectValue(select, option.getAttribute('data-solo-option-value'));
          select.classList.remove('open');
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', 'false');
          if (onChange && previousValue !== getSoloSelectValue(select)) {
            onChange(getSoloSelectValue(select));
          }
          return;
        }
        if (event.target.closest('[data-solo-trigger]') && !select.classList.contains('is-disabled')) {
          const open = !select.classList.contains('open');
          closeSoloSelects(select);
          select.classList.toggle('open', open);
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
      });
      select.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          select.classList.remove('open');
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', 'false');
          return;
        }
        if ((event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') && event.target.closest('[data-solo-trigger]')) {
          event.preventDefault();
          closeSoloSelects(select);
          select.classList.add('open');
          event.target.setAttribute('aria-expanded', 'true');
        }
      });
    }

    function bindSoloSelects(container) {
      container.querySelectorAll('[data-solo-select]').forEach(select => bindSoloSelect(select));
    }

    document.addEventListener('click', () => closeSoloSelects());

    function getCompletionCriteria(node) {
      const criteria = Array.isArray(node.completionCriteria)
        ? node.completionCriteria.map(item => String(item || '').trim()).filter(Boolean)
        : [];
      if (criteria.length > 0) return criteria;
      return [node.description || node.agentPrompt || ''];
    }

    function renderCompletionCriteria(node) {
      const criteria = getCompletionCriteria(node).filter(Boolean);
      if (!criteria.length) return '';
      return \`
        <div class="completion-criteria" data-completion-criteria-id="\${escapeHtml(node.id)}">
          <div class="completion-criteria-title">\${escapeHtml(t('completionCriteria'))}</div>
          <ol class="completion-criteria-list">
            \${criteria.map(item => \`<li>\${escapeHtml(item)}</li>\`).join('')}
          </ol>
        </div>
      \`;
    }

    function renderOnboardingPanel() {
      return \`
        <div class="onboarding-panel">
          <div class="onboarding-kicker"><span class="codicon codicon-compass"></span>\${escapeHtml(t('onboardingKicker'))}</div>
          <div class="onboarding-title">\${escapeHtml(t('onboardingTitle'))}</div>
          <div class="onboarding-copy">\${escapeHtml(t('onboardingCopy'))}</div>
          <div class="onboarding-steps">
            <div class="onboarding-step"><span class="onboarding-step-index">1</span><span>\${escapeHtml(t('onboardingStepProject'))}</span></div>
            <div class="onboarding-step"><span class="onboarding-step-index">2</span><span>\${escapeHtml(t('onboardingStepType'))}</span></div>
            <div class="onboarding-step"><span class="onboarding-step-index">3</span><span>\${escapeHtml(t('onboardingStepRoadmap'))}</span></div>
          </div>
          <button class="onboarding-action" data-onboarding-add-project>
            <span class="codicon codicon-add"></span>\${escapeHtml(t('onboardingAction'))}
          </button>
        </div>
      \`;
    }

    function bindOnboardingActions(container) {
      container.querySelectorAll('[data-onboarding-add-project]').forEach(button => {
        button.addEventListener('click', () => {
          vscode.postMessage({ command: 'addProject' });
        });
      });
    }

    const methodologyStages = [
      { key: 'build', labelKey: 'methodologyBuild' },
      { key: 'sell', labelKey: 'methodologySell' },
      { key: 'learn', labelKey: 'methodologyLearn' },
      { key: 'improve', labelKey: 'methodologyImprove' }
    ];

    function inferMethodologyStage(node) {
      const text = String((node && node.stage) || '') + ' ' + String((node && node.title) || '');
      const normalized = text.toLowerCase();
      if (/营销|销售|分发|品牌|官网|发布|外联|获客|转化|sell|sales|market|launch|growth|distribution|outreach/.test(normalized)) {
        return 'sell';
      }
      if (/产品|mvp|构建|实现|开发|交付|源码|页面|功能|build|ship|implement|code|feature/.test(normalized)) {
        return 'build';
      }
      if (/调整|改进|复盘|规模化|路线图|优先级|下一轮|improve|iterate|iteration|roadmap|scale|optimi[sz]e/.test(normalized)) {
        return 'improve';
      }
      if (/问题|客户|发现|反馈|学习|访谈|指标|数据|issue|learn|feedback|customer|discovery|analytics|support/.test(normalized)) {
        return 'learn';
      }
      return 'build';
    }

    function getMethodologyStageCounts(nodes) {
      const counts = {
        build: { total: 0, completed: 0 },
        sell: { total: 0, completed: 0 },
        learn: { total: 0, completed: 0 },
        improve: { total: 0, completed: 0 }
      };
      (nodes || []).forEach(node => {
        const key = inferMethodologyStage(node);
        counts[key].total += 1;
        if (node.status === 'Completed') counts[key].completed += 1;
      });
      return counts;
    }

    function renderMethodologyOverview(nodes) {
      const counts = getMethodologyStageCounts(nodes);
      return \`
        <div class="methodology-overview" aria-label="Build Sell Learn Improve">
          \${methodologyStages.map(stage => {
            const item = counts[stage.key] || { total: 0, completed: 0 };
            const missing = Number(item.total || 0) === 0;
            const active = activeMethodologyStage === stage.key;
            return \`
              <div class="methodology-stage-card\${missing ? ' missing' : ''}\${active ? ' active' : ''}" role="button" tabindex="0" data-methodology-stage="\${escapeHtml(stage.key)}">
                <div>
                  <div class="methodology-stage-name">\${escapeHtml(t(stage.labelKey))}</div>
                  <div class="methodology-stage-meta">\${missing ? escapeHtml(t('methodologyMissing')) : escapeHtml(item.completed + ' / ' + item.total + ' ' + t('methodologyCompleted'))}</div>
                </div>
                \${missing ? \`<button class="methodology-adjust-btn" type="button" data-open-roadmap-revision>\${escapeHtml(t('reviseRoadmap'))}</button>\` : ''}
              </div>
            \`;
          }).join('')}
        </div>
      \`;
    }

    function bindMethodologyOverview(container) {
      container.querySelectorAll('[data-methodology-stage]').forEach(card => {
        const selectStage = () => {
          const stage = card.getAttribute('data-methodology-stage') || '';
          activeMethodologyStage = activeMethodologyStage === stage ? '' : stage;
          renderRoadmap(currentNodes);
          if (activeMethodologyStage) {
            setTimeout(() => {
              const target = canvas.querySelector('[data-methodology-row-stage="' + cssEscape(activeMethodologyStage) + '"]');
              if (target && typeof target.scrollIntoView === 'function') {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }, 0);
          }
        };
        card.addEventListener('click', (event) => {
          if (event.target.closest('[data-open-roadmap-revision]')) return;
          selectStage();
        });
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectStage();
          }
        });
      });
      container.querySelectorAll('[data-open-roadmap-revision]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          roadmapRevisionExpanded = true;
          if (settingsPanel) settingsPanel.style.display = 'none';
          roadmapRevisionPanel.classList.add('open');
          btnToggleRoadmapRevision.classList.add('active');
          renderRoadmapRevisionPanel(currentNodes);
        });
      });
    }

    function renderRoadmap(nodes) {
      // Clear canvas keeping the flow line
      const flowLine = canvas.querySelector('.flow-line');
      canvas.innerHTML = '';
      if (flowLine) canvas.appendChild(flowLine);

      if (!nodes || nodes.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.innerHTML = currentRoadmapLoading
          ? '<div class="onboarding-panel"><div class="onboarding-title">' + escapeHtml(t('roadmapLoading')) + '</div></div>'
          : renderOnboardingPanel();
        canvas.appendChild(placeholder);
        bindOnboardingActions(placeholder);
        return;
      }

      const overview = document.createElement('div');
      overview.className = 'methodology-shell';
      overview.innerHTML = renderMethodologyOverview(nodes);
      canvas.appendChild(overview);
      bindMethodologyOverview(overview);

      nodes.forEach(node => {
        const row = document.createElement('div');
        const methodologyStage = inferMethodologyStage(node);
        row.className = 'node-row methodology-' + methodologyStage + (activeMethodologyStage === methodologyStage ? ' stage-highlight' : '');
        row.setAttribute('data-methodology-row-stage', methodologyStage);

        const cleanStage = node.stage.replace(/[^a-zA-Z0-9]/g, '-');
        const expanded = expandedNodeId === node.id;
        const conversations = nodeConversations[node.id] || [];
        const supplementFiles = nodeSupplementFiles[node.id] || [];
        const conversationDisabled = '';
        const selectedAgentCli = nodeAgentSelections[node.id] || node.agentCli || currentCliPath || 'agy';
        const promptHtml = expanded ? \`
          <div class="node-expanded-body">
            <div class="node-desc">\${escapeHtml(node.description)}</div>
            <div class="node-agent-prompt">
              <strong>\${escapeHtml(node.agentCli)}:</strong> \${escapeHtml(node.agentPrompt)}
            </div>
            \${renderCompletionCriteria(node)}
            <div class="conversation-composer">
              <div class="conversation-compose conversation-compose-main">
                <button class="conversation-tool-btn" data-attach-node-id="\${escapeHtml(node.id)}" title="\${t('attachFiles')}" \${conversationDisabled}>
                  <span class="codicon codicon-attach"></span>
                </button>
                <input type="text" class="conversation-input" data-conversation-input-id="\${escapeHtml(node.id)}" placeholder="\${t('conversationPlaceholder')}" value="\${escapeHtml(conversationDrafts[node.id] || '')}" \${conversationDisabled}>
                <button class="btn-send-conversation" data-send-node-id="\${escapeHtml(node.id)}" title="\${t('send')}" \${conversationDisabled}>
                  <span class="codicon codicon-send"></span>
                </button>
              </div>
              <div class="conversation-compose conversation-compose-meta">
                \${renderSoloSelect('conversation-agent-select', 'data-agent-select-id="' + escapeHtml(node.id) + '" title="' + escapeHtml(t('agentSelector')) + '"', getAgentOptions(node), false, selectedAgentCli)}
                \${renderModelSelect('conversation-model-select', 'data-model-select-id="' + escapeHtml(node.id) + '" title="Model"', selectedAgentCli, node.id)}
              </div>
              \${renderSupplementFiles(node.id, supplementFiles)}
            </div>
            <div class="conversation-panel">
              <div class="conversation-title">\${t('conversationHistory')}</div>
              \${renderConversations(node.id, conversations)}
            </div>
          </div>
        \` : '';

        row.innerHTML = \`
          <div class="node-card status-\${statusClass(node.status)} \${expanded ? 'expanded' : 'collapsed'}" data-node-card-id="\${escapeHtml(node.id)}">
            <div class="node-summary">
              <div class="node-content">
                <div class="node-headline">
                  <span class="node-expand-icon">\${expanded ? '▾' : '▸'}</span>
                  <span class="node-badge stage-\${cleanStage}">\${escapeHtml(node.stage)}</span>
                  <span class="node-title">\${escapeHtml(node.title)}</span>
                </div>
                \${promptHtml}
              </div>
              <div class="node-actions">
                <span class="status-badge \${statusClass(node.status)}">\${statusText(node.status)}</span>
                \${node.status !== 'Completed' ? \`<button class="btn-run" data-complete-node-id="\${escapeHtml(node.id)}">\${t('markComplete')}</button>\` : ''}
              </div>
            </div>
          </div>
        \`;
        const card = row.querySelector('[data-node-card-id]');
        if (card) {
          card.addEventListener('click', (event) => {
            if (event.target.closest('button') || event.target.closest('input') || event.target.closest('[data-solo-select]') || event.target.closest('[data-conversation-id]')) {
              return;
            }
            toggleNode(node.id);
          });
        }
        const sendButton = row.querySelector('[data-send-node-id]');
        if (sendButton) {
          sendButton.addEventListener('click', (event) => {
            event.stopPropagation();
            const input = row.querySelector('[data-conversation-input-id="' + cssEscape(node.id) + '"]');
            const agentSelect = row.querySelector('[data-agent-select-id="' + cssEscape(node.id) + '"]');
            const modelSelect = row.querySelector('[data-model-select-id="' + cssEscape(node.id) + '"]');
            triggerRun(node.id, input ? input.value : '', getSoloSelectValue(agentSelect), getSoloSelectValue(modelSelect), nodeSupplementFiles[node.id] || []);
            if (input) input.value = '';
            conversationDrafts[node.id] = '';
            nodeSupplementFiles[node.id] = [];
            renderRoadmap(currentNodes);
          });
        }
        row.querySelectorAll('[data-conversation-input-id]').forEach(input => {
          input.addEventListener('input', () => {
            conversationDrafts[node.id] = input.value;
          });
        });
        row.querySelectorAll('[data-attach-node-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'chooseSupplementFiles', nodeId: node.id });
          });
        });
        row.querySelectorAll('[data-conversation-input-id]').forEach(input => {
          bindPastedImageAttachments(input, node.id, () => renderRoadmap(currentNodes));
        });
        const agentSelect = row.querySelector('[data-agent-select-id="' + cssEscape(node.id) + '"]');
        const modelSelect = row.querySelector('[data-model-select-id="' + cssEscape(node.id) + '"]');
        if (agentSelect) {
          bindSoloSelect(agentSelect, (value) => {
            nodeAgentSelections[node.id] = value || currentCliPath || 'agy';
            const nextCli = nodeAgentSelections[node.id];
            setTargetModelValue(node.id, nextCli, getTargetModelValue(node.id, nextCli), false);
            ensureAgentModelsLoaded(nextCli, node.id);
            renderRoadmap(currentNodes);
          });
        }
        if (modelSelect) {
          bindSoloSelect(modelSelect, (value) => {
            const cli = nodeAgentSelections[node.id] || node.agentCli || currentCliPath || 'agy';
            setTargetModelValue(node.id, cli, value, true);
          });
        }
        row.querySelectorAll('[data-remove-supplement-file]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            const file = item.getAttribute('data-remove-supplement-file');
            nodeSupplementFiles[node.id] = (nodeSupplementFiles[node.id] || []).filter(candidate => candidate !== file);
            renderRoadmap(currentNodes);
          });
        });
        bindSoloSelects(row);
        const completeButton = row.querySelector('[data-complete-node-id]');
        if (completeButton) {
          completeButton.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'completeNode', nodeId: node.id });
          });
        }
        row.querySelectorAll('[data-conversation-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            activeConversationId = activeConversationId === item.getAttribute('data-conversation-id')
              ? ''
              : item.getAttribute('data-conversation-id');
            renderRoadmap(currentNodes);
          });
        });
        row.querySelectorAll('[data-retry-conversation-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            const conversationId = item.getAttribute('data-retry-conversation-id');
            if (!conversationId) return;
            vscode.postMessage({
              command: 'retryConversation',
              nodeId: node.id,
              conversationId
            });
          });
        });
        row.querySelectorAll('[data-show-agent-terminal]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({
              command: 'showAgentTerminal',
              conversationId: item.getAttribute('data-show-agent-terminal')
            });
          });
        });
        row.querySelectorAll('[data-continue-native-conversation-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({
              command: 'continueNativeConversation',
              nodeId: item.getAttribute('data-continue-native-node-id') || node.id,
              conversationId: item.getAttribute('data-continue-native-conversation-id')
            });
          });
        });
        row.querySelectorAll('[data-stop-agent-run]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({
              command: 'stopAgentRun',
              nodeId: node.id,
              conversationId: item.getAttribute('data-stop-agent-run')
            });
          });
        });
        row.querySelectorAll('[data-open-file-path]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            const relativePath = item.getAttribute('data-open-file-path');
            if (!relativePath) return;
            vscode.postMessage({ command: 'openProjectFile', relativePath });
          });
        });
        bindSoloSelects(row);
        canvas.appendChild(row);
      });
    }

    function renderSoloClosure(conversation) {
      const options = (currentNodes || []).map(node => ({ value: node.id, label: node.title }));
      return \`
        <div class="solo-closure" data-solo-closure-id="\${escapeHtml(conversation.id)}">
          <div class="solo-closure-title">\${escapeHtml(t('soloClosure'))}</div>
          <div class="solo-closure-actions">
            \${options.length ? renderSoloSelect('solo-link-select', 'data-solo-link-select', options, false) : ''}
            \${options.length ? \`<button class="solo-action-btn" data-link-solo-id="\${escapeHtml(conversation.id)}">\${escapeHtml(t('linkToStep'))}</button>\` : ''}
            <button class="solo-action-btn secondary" data-open-revision-from-solo>\${escapeHtml(t('adjustRoadmap'))}</button>
          </div>
          <div class="conversation-runtime">\${escapeHtml(t('keepInSolo'))}</div>
        </div>
      \`;
    }

    function renderSoloPanel(nodes) {
      if (!soloPanel || !soloBody) {
        return;
      }
      const conversations = nodeConversations[soloConversationId] || [];
      const supplementFiles = nodeSupplementFiles[soloConversationId] || [];
      const disabled = '';
      const selectedAgentCli = soloAgentSelection || currentCliPath || 'agy';
      soloPanel.classList.toggle('active', soloExpanded);
      btnToggleSolo.classList.toggle('active', soloExpanded);
      if (!soloExpanded) {
        soloBody.innerHTML = '';
        return;
      }
      soloBody.innerHTML = \`
        <div class="conversation-composer">
          <div class="conversation-compose conversation-compose-main">
            <button class="conversation-tool-btn" data-attach-solo title="\${escapeHtml(t('attachFiles'))}" \${disabled}>
              <span class="codicon codicon-attach"></span>
            </button>
            <input type="text" class="conversation-input" data-solo-input placeholder="\${escapeHtml(t('soloPlaceholder'))}" \${disabled}>
            <button class="btn-send-conversation" data-send-solo title="\${escapeHtml(t('sendSolo'))}" \${disabled}>
              <span class="codicon codicon-send"></span>
            </button>
          </div>
          <div class="conversation-compose conversation-compose-meta">
            \${renderSoloSelect('conversation-agent-select', 'data-solo-agent title="' + escapeHtml(t('agentSelector')) + '"', getAgentOptions({ agentCli: currentCliPath || 'agy' }), false, selectedAgentCli)}
            \${renderModelSelect('conversation-model-select', 'data-solo-model title="Model"', selectedAgentCli, soloConversationId)}
          </div>
          \${renderSupplementFiles(soloConversationId, supplementFiles)}
        </div>
        <div class="conversation-panel">
          <div class="conversation-title">\${escapeHtml(t('soloHistory'))}</div>
          \${renderConversations(soloConversationId, conversations, t('noSoloConversations'))}
        </div>
      \`;
      const sendButton = soloBody.querySelector('[data-send-solo]');
      const attachButton = soloBody.querySelector('[data-attach-solo]');
      if (attachButton) {
        attachButton.addEventListener('click', () => {
          vscode.postMessage({ command: 'chooseSupplementFiles', nodeId: soloConversationId });
        });
      }
      if (sendButton) {
        sendButton.addEventListener('click', () => {
          const input = soloBody.querySelector('[data-solo-input]');
          const agentSelect = soloBody.querySelector('[data-solo-agent]');
          const modelSelect = soloBody.querySelector('[data-solo-model]');
          const request = input ? input.value.trim() : '';
          if (!request) return;
          vscode.postMessage({
            command: 'runSoloConversation',
            userMessage: request,
            agentCli: getSoloSelectValue(agentSelect),
            model: getSoloSelectValue(modelSelect),
            supplementFiles: nodeSupplementFiles[soloConversationId] || []
          });
          input.value = '';
          nodeSupplementFiles[soloConversationId] = [];
          renderSoloPanel(currentNodes);
        });
      }
      soloBody.querySelectorAll('[data-remove-supplement-file]').forEach(item => {
        item.addEventListener('click', () => {
          const file = item.getAttribute('data-remove-supplement-file');
          nodeSupplementFiles[soloConversationId] = (nodeSupplementFiles[soloConversationId] || []).filter(candidate => candidate !== file);
          renderSoloPanel(currentNodes);
        });
      });
      const soloInput = soloBody.querySelector('[data-solo-input]');
      bindPastedImageAttachments(soloInput, soloConversationId, () => renderSoloPanel(currentNodes));
      const soloAgentSelect = soloBody.querySelector('[data-solo-agent]');
      const soloModelSelect = soloBody.querySelector('[data-solo-model]');
      if (soloAgentSelect) {
        bindSoloSelect(soloAgentSelect, (value) => {
          soloAgentSelection = value || currentCliPath || 'agy';
          ensureAgentModelsLoaded(soloAgentSelection, soloConversationId);
          renderSoloPanel(currentNodes);
        });
      }
      if (soloModelSelect) {
        bindSoloSelect(soloModelSelect, (value) => {
          setTargetModelValue(soloConversationId, soloAgentSelection || currentCliPath || 'agy', value, true);
        });
      }
      bindSoloSelects(soloBody);
      bindConversationActions(soloBody, soloConversationId);
    }

    function renderFlowPanel() {
      if (!flowPanel || !flowBody) {
        return;
      }
      flowPanel.classList.toggle('active', flowExpanded);
      if (!flowExpanded) {
        flowBody.innerHTML = '';
        return;
      }
      const flow = currentFlowState.flow || null;
      const hasProAccess = Boolean(currentFlowState.hasProAccess);
      const flowTargetId = 'flow';
      const supplementFiles = nodeSupplementFiles[flowTargetId] || [];
      if (!hasProAccess) {
        flowBody.innerHTML = \`
          <div class="conversation-panel">
            <div class="conversation-title">\${escapeHtml(t('flowTitle'))}</div>
            <div class="empty-state">\${escapeHtml(t('flowLocked'))}</div>
            <div class="conversation-compose conversation-compose-main" style="margin-top: 12px;">
              <button class="btn-send-conversation" data-open-flow-pro><span class="codicon codicon-lock"></span><span>\${escapeHtml(t('flowUpgrade'))}</span></button>
            </div>
          </div>
        \`;
        const upgradeButton = flowBody.querySelector('[data-open-flow-pro]');
        if (upgradeButton) {
          upgradeButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'openProAuthorization' });
          });
        }
        return;
      }
      const selectedAgentCli = flowAgentSelection || currentCliPath || 'agy';
      const latestLoops = Array.isArray(flow?.loops) ? flow.loops.slice().sort((a, b) => Number(a.index || 0) - Number(b.index || 0)) : [];
      
      // Helper function to render touched files in the panel
      function getEvidenceFilesHtml(loop) {
        if (!loop.evidence) return '';
        const touched = loop.evidence.touchedFilesSummary || '';
        const changed = loop.evidence.changedFilesSummary || '';
        const files = Array.from(new Set(
          [...touched.split('\\n'), ...changed.split('\\n')]
            .map(f => f.trim())
            .filter(f => f && !f.includes(':') && !f.startsWith('M ') && !f.startsWith('A ') && !f.startsWith('D '))
        ));
        if (files.length === 0) return '';
        return \`
          <div style="margin-top:6px; color: var(--text-muted);">
            <strong>📂 Touched Files:</strong>
            \${files.map(file => \`<span class="file-link" data-open-file-path="\${escapeHtml(file)}" style="color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; margin-right: 8px;">\${escapeHtml(file)}</span>\`).join('')}
          </div>
        \`;
      }

      flowBody.innerHTML = \`
        <div class="conversation-composer">
          <div class="conversation-compose conversation-compose-main">
            <button class="conversation-tool-btn" data-attach-flow title="\${escapeHtml(t('attachFiles'))}">
              <span class="codicon codicon-attach"></span>
            </button>
            <input type="text" class="conversation-input" data-flow-goal-input placeholder="\${escapeHtml(t('flowPlaceholder'))}">
            <button class="btn-send-conversation" data-send-flow title="\${escapeHtml(t('flowStart'))}">
              <span class="codicon codicon-send"></span>
            </button>
          </div>
          <div class="conversation-compose conversation-compose-meta">
            \${renderSoloSelect('flow-agent-select', 'data-flow-agent title="' + escapeHtml(t('agentSelector')) + '"', getAgentOptions({ agentCli: currentCliPath || 'agy' }), false, selectedAgentCli)}
            \${renderModelSelect('flow-model-select', 'data-flow-model title="Model"', selectedAgentCli, 'flow')}
          </div>
          \${renderSupplementFiles(flowTargetId, supplementFiles)}
        </div>
        <div class="conversation-panel">
          <div class="conversation-title">\${escapeHtml(t('flowHistory'))}</div>
          \${flow ? \`
            <div class="conversation-runtime">Flow: \${escapeHtml(flow.goal || '')}</div>
            <div class="conversation-runtime">Status: \${escapeHtml(flow.status || '')}</div>
            \${flow.latestSummary ? \`<div class="conversation-result">\${escapeHtml(flow.latestSummary)}</div>\` : ''}
            
            \${(flow.status === 'running') ? \`
              <div style="margin-top: 8px; margin-bottom: 8px; display: flex; gap: 8px;">
                <button class="conversation-control-btn" data-pause-flow="\${escapeHtml(flow.flowId)}" style="background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 4px 8px; font-size: 11px;">⏸ 暂停推进</button>
                <button class="conversation-control-btn stop" data-abandon-flow="\${escapeHtml(flow.flowId)}" style="padding: 4px 8px; font-size: 11px;">🚫 放弃 Flow</button>
              </div>
            \` : ''}

            <div class="conversation-output">\${latestLoops.map(loop => \`
              <div style="padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                <div><strong>Loop \${escapeHtml(String(loop.index || ''))}</strong> · \${escapeHtml(loop.status || '')}</div>
                <div style="opacity:0.85; margin-top:4px;">\${escapeHtml(loop.goal || '')}</div>
                <div style="margin-top:6px; color: var(--text-muted);">
                  Planner: <span class="role-status \${escapeHtml(loop.planner?.status || 'pending')}" data-show-audit-role="planner" data-loop-index="\${loop.index}" style="cursor: pointer; text-decoration: underline;">\${escapeHtml(loop.planner?.status || 'pending')}</span> · 
                  Builder: <span class="role-status \${escapeHtml(loop.builder?.status || 'pending')}" data-show-audit-role="builder" data-loop-index="\${loop.index}" style="cursor: pointer; text-decoration: underline;">\${escapeHtml(loop.builder?.status || 'pending')}</span> · 
                  Verifier: <span class="role-status \${escapeHtml(loop.verifier?.status || 'pending')}" data-show-audit-role="verifier" data-loop-index="\${loop.index}" style="cursor: pointer; text-decoration: underline;">\${escapeHtml(loop.verifier?.status || 'pending')}</span>
                </div>
                
                <div id="audit-details-\${loop.index}" class="audit-details" style="display: none; margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.25); border-radius: 4px; border-left: 3px solid var(--vscode-focusBorder);">
                  <div style="font-weight: bold; font-size: 10px; margin-bottom: 4px; color: var(--vscode-textPreformat-foreground);">📋 执行轨迹审计 (<span id="audit-role-name-\${loop.index}"></span>)</div>
                  <pre id="audit-content-\${loop.index}" style="font-family: monospace; white-space: pre-wrap; margin: 0; font-size: 10px; max-height: 200px; overflow-y: auto; color: var(--vscode-editor-foreground);"></pre>
                </div>

                \${loop.summary ? \`<div style="margin-top:6px; color: var(--text-muted);">\${escapeHtml(loop.summary)}</div>\` : ''}
                \${getEvidenceFilesHtml(loop)}
                \${loop.scoring && Array.isArray(loop.scoring.reasons) && loop.scoring.reasons.length ? \`
                  <div style="margin-top:6px; color: var(--text-muted);">
                    <strong>🎯 H/I/J 评估:</strong> 
                    <span style="color: \${loop.scoring.hardEvidencePass ? '#388a34' : '#cf222e'}; font-weight: bold;">H:\${loop.scoring.hardEvidencePass?'Pass':'Fail'}</span> | 
                    <span style="color: \${loop.scoring.intentPass ? '#388a34' : '#cf222e'}; font-weight: bold;">I:\${loop.scoring.intentPass?'Pass':'Fail'}</span> | 
                    <span style="color: \${loop.scoring.judgmentPass ? '#388a34' : '#cf222e'}; font-weight: bold;">J:\${loop.scoring.judgmentPass?'Pass':'Fail'}</span>
                    <div style="font-size: 11px; margin-top: 2px;">\${escapeHtml(loop.scoring.reasons.join(' | '))}</div>
                  </div>
                \` : ''}
              </div>
            \`).join('')}</div>
            \${currentFlowState.history && currentFlowState.history.length > 1 ? \`<div class="conversation-result" style="margin-top:12px;">Recent flows: \${escapeHtml(currentFlowState.history.slice(1, 4).map(item => item.goal).join(' | '))}</div>\` : ''}
          \` : \`<div class="empty-state">\${escapeHtml(t('flowEmpty'))}</div>\`}
        </div>
      \`;
      const sendButton = flowBody.querySelector('[data-send-flow]');
      const attachButton = flowBody.querySelector('[data-attach-flow]');
      if (attachButton) {
        attachButton.addEventListener('click', () => {
          vscode.postMessage({ command: 'chooseSupplementFiles', nodeId: flowTargetId });
        });
      }
      if (sendButton) {
        sendButton.addEventListener('click', () => {
          const input = flowBody.querySelector('[data-flow-goal-input]');
          const agentSelect = flowBody.querySelector('[data-flow-agent]');
          const modelSelect = flowBody.querySelector('[data-flow-model]');
          const goal = input ? input.value.trim() : '';
          if (!goal) return;
          vscode.postMessage({
            command: 'runFlow',
            goal,
            agentCli: getSoloSelectValue(agentSelect),
            model: getSoloSelectValue(modelSelect),
            supplementFiles: nodeSupplementFiles[flowTargetId] || []
          });
          if (input) input.value = '';
          nodeSupplementFiles[flowTargetId] = [];
          renderFlowPanel();
        });
      }
      flowBody.querySelectorAll('[data-remove-supplement-file]').forEach(item => {
        item.addEventListener('click', () => {
          const file = item.getAttribute('data-remove-supplement-file');
          nodeSupplementFiles[flowTargetId] = (nodeSupplementFiles[flowTargetId] || []).filter(candidate => candidate !== file);
          renderFlowPanel();
        });
      });
      const flowInput = flowBody.querySelector('[data-flow-goal-input]');
      bindPastedImageAttachments(flowInput, flowTargetId, () => renderFlowPanel());
      const flowAgentSelect = flowBody.querySelector('[data-flow-agent]');
      const flowModelSelect = flowBody.querySelector('[data-flow-model]');
      if (flowAgentSelect) {
        bindSoloSelect(flowAgentSelect, (value) => {
          flowAgentSelection = value || currentCliPath || 'agy';
          ensureAgentModelsLoaded(flowAgentSelection, 'flow');
          renderFlowPanel();
        });
      }
      if (flowModelSelect) {
        bindSoloSelect(flowModelSelect, (value) => {
          setTargetModelValue('flow', flowAgentSelection || currentCliPath || 'agy', value, true);
        });
      }

      // Bind pause and abandon action buttons
      const pauseBtn = flowBody.querySelector('[data-pause-flow]');
      if (pauseBtn) {
        pauseBtn.addEventListener('click', () => {
          const flowId = pauseBtn.getAttribute('data-pause-flow');
          vscode.postMessage({ command: 'pauseFlow', flowId });
        });
      }
      const abandonBtn = flowBody.querySelector('[data-abandon-flow]');
      if (abandonBtn) {
        abandonBtn.addEventListener('click', () => {
          const flowId = abandonBtn.getAttribute('data-abandon-flow');
          vscode.postMessage({ command: 'abandonFlow', flowId });
        });
      }

      // Bind audit toggle buttons
      flowBody.querySelectorAll('[data-show-audit-role]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const role = item.getAttribute('data-show-audit-role');
          const loopIndex = Number(item.getAttribute('data-loop-index') || 0);
          const detailsDiv = flowBody.querySelector(\`#audit-details-\${loopIndex}\`);
          const contentPre = flowBody.querySelector(\`#audit-content-\${loopIndex}\`);
          const roleSpan = flowBody.querySelector(\`#audit-role-name-\${loopIndex}\`);
          if (!detailsDiv || !contentPre) return;
          
          const loop = latestLoops.find(l => l.index === loopIndex);
          const roleData = loop ? loop[role] : null;
          if (!roleData) return;
          
          if (detailsDiv.style.display === 'none') {
            detailsDiv.style.display = 'block';
            if (roleSpan) roleSpan.textContent = role.toUpperCase();
            contentPre.textContent = JSON.stringify({
              role: role,
              status: roleData.status,
              validationErrors: roleData.validationErrors || [],
              data: roleData.data || {}
            }, null, 2);
          } else {
            detailsDiv.style.display = 'none';
          }
        });
      });

      bindSoloSelects(flowBody);
      bindConversationActions(flowBody, 'flow');
    }
    function renderRoadmapRevisionPanel(nodes) {
      if (!roadmapRevisionPanel || !roadmapRevisionBody) {
        return;
      }
      const conversations = nodeConversations[roadmapRevisionId] || [];
      const disabled = '';
      roadmapRevisionPanel.classList.toggle('open', roadmapRevisionExpanded);
      btnToggleRoadmapRevision.classList.toggle('active', roadmapRevisionExpanded);
      if (!roadmapRevisionExpanded) {
        roadmapRevisionBody.innerHTML = '';
        return;
      }
      roadmapRevisionBody.innerHTML = \`
        <div class="conversation-composer">
          <div class="conversation-compose">
            <input type="text" class="conversation-input" data-roadmap-revision-input placeholder="\${escapeHtml(t('reviseRoadmapPlaceholder'))}" \${disabled}>
            \${renderSoloSelect('conversation-agent-select', 'data-roadmap-revision-agent title="' + escapeHtml(t('agentSelector')) + '"', getAgentOptions({ agentCli: currentCliPath || 'agy' }), false)}
            <button class="btn-send-conversation" data-send-roadmap-revision title="\${escapeHtml(t('sendRevision'))}" \${disabled}>
              <span class="codicon codicon-send"></span>
            </button>
          </div>
          \${renderSupplementFiles(roadmapRevisionId, nodeSupplementFiles[roadmapRevisionId] || [])}
        </div>
        <div class="conversation-panel">
          <div class="conversation-title">\${escapeHtml(t('revisionHistory'))}</div>
          \${renderConversations(roadmapRevisionId, conversations, t('noRevisionConversations'))}
        </div>
      \`;
      const sendButton = roadmapRevisionBody.querySelector('[data-send-roadmap-revision]');
      if (sendButton) {
        sendButton.addEventListener('click', () => {
          const input = roadmapRevisionBody.querySelector('[data-roadmap-revision-input]');
          const agentSelect = roadmapRevisionBody.querySelector('[data-roadmap-revision-agent]');
          const request = input ? input.value.trim() : '';
          if (!request) return;
          vscode.postMessage({
            command: 'runRoadmapRevision',
            userMessage: request,
            agentCli: getSoloSelectValue(agentSelect),
            supplementFiles: nodeSupplementFiles[roadmapRevisionId] || []
          });
          input.value = '';
          nodeSupplementFiles[roadmapRevisionId] = [];
          renderRoadmapRevisionPanel(currentNodes);
        });
      }
      const revisionInput = roadmapRevisionBody.querySelector('[data-roadmap-revision-input]');
      bindPastedImageAttachments(revisionInput, roadmapRevisionId, () => renderRoadmapRevisionPanel(currentNodes));
      roadmapRevisionBody.querySelectorAll('[data-remove-supplement-file]').forEach(item => {
        item.addEventListener('click', () => {
          const file = item.getAttribute('data-remove-supplement-file');
          nodeSupplementFiles[roadmapRevisionId] = (nodeSupplementFiles[roadmapRevisionId] || []).filter(candidate => candidate !== file);
          renderRoadmapRevisionPanel(currentNodes);
        });
      });
      bindSoloSelects(roadmapRevisionBody);
      bindConversationActions(roadmapRevisionBody, roadmapRevisionId);
    }

    function bindConversationActions(container, nodeId) {
      container.querySelectorAll('[data-link-solo-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const closure = item.closest('[data-solo-closure-id]');
          const select = closure ? closure.querySelector('[data-solo-link-select]') : null;
          const targetNodeId = getSoloSelectValue(select);
          if (!targetNodeId) return;
          vscode.postMessage({
            command: 'linkSoloConversation',
            conversationId: item.getAttribute('data-link-solo-id'),
            nodeId: targetNodeId
          });
        });
      });
      container.querySelectorAll('[data-open-revision-from-solo]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          setMainView('roadmap');
          roadmapRevisionExpanded = true;
          roadmapRevisionPanel.classList.add('open');
          btnToggleRoadmapRevision.classList.add('active');
          if (!nodeConversations[roadmapRevisionId]) {
            vscode.postMessage({ command: 'getNodeConversations', nodeId: roadmapRevisionId });
          }
          renderRoadmapRevisionPanel(currentNodes);
        });
      });
      container.querySelectorAll('[data-conversation-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          activeConversationId = activeConversationId === item.getAttribute('data-conversation-id')
            ? ''
            : item.getAttribute('data-conversation-id');
          renderRoadmap(currentNodes);
          if (nodeId === roadmapRevisionId) {
            renderRoadmapRevisionPanel(currentNodes);
          } else if (nodeId === soloConversationId) {
            renderSoloPanel(currentNodes);
          }
        });
      });
      container.querySelectorAll('[data-retry-conversation-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({
            command: 'retryConversation',
            nodeId,
            conversationId: item.getAttribute('data-retry-conversation-id')
          });
        });
      });
      container.querySelectorAll('[data-show-agent-terminal]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({
            command: 'showAgentTerminal',
            conversationId: item.getAttribute('data-show-agent-terminal')
          });
        });
      });
      container.querySelectorAll('[data-continue-native-conversation-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
            vscode.postMessage({
              command: 'continueNativeConversation',
              nodeId: item.getAttribute('data-continue-native-node-id') || nodeId,
              conversationId: item.getAttribute('data-continue-native-conversation-id')
            });
          });
      });
      container.querySelectorAll('[data-stop-agent-run]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({
            command: 'stopAgentRun',
            nodeId,
            conversationId: item.getAttribute('data-stop-agent-run')
          });
        });
      });
      container.querySelectorAll('[data-open-file-path]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const relativePath = item.getAttribute('data-open-file-path');
          if (relativePath) {
            vscode.postMessage({ command: 'openProjectFile', relativePath });
          }
        });
      });
    }

    function renderConversations(nodeId, conversations, emptyLabel = t('noConversations')) {
      if (!conversations || conversations.length === 0) {
        return '<div class="conversation-empty">' + escapeHtml(emptyLabel) + '</div>';
      }

      const items = conversations.map(conversation => {
        const conversationId = nodeId + ':' + conversation.id;
        const open = activeConversationId === conversationId;
        const when = conversation.timestamp ? new Date(conversation.timestamp).toLocaleString() : '';
        const summary = summarizeConversation(conversation);
        const duration = formatConversationDuration(conversation);
        const runtimeLabel = duration
          ? (conversation.status === 'Running' ? t('elapsed') : t('duration')) + ': ' + duration
          : '';
        const retryButton = conversation.status === 'Failed'
          ? \`<button class="conversation-retry-btn" data-retry-conversation-id="\${escapeHtml(conversation.id)}">\${t('retry')}</button>\`
          : '';
        const continueButton = conversation.status !== 'Running' && extractNativeSessionId(conversation.output)
          ? \`<button class="conversation-control-btn" data-continue-native-conversation-id="\${escapeHtml(conversation.id)}" data-continue-native-node-id="\${escapeHtml(nodeId)}" title="\${escapeHtml(t('continueNative'))}">\${t('continueNative')}</button>\`
          : '';
        const runningButtons = conversation.status === 'Running'
          ? \`
            <button class="conversation-control-btn" data-show-agent-terminal="\${escapeHtml(conversation.id)}" title="\${escapeHtml(t('openTerminal'))}">\${t('openTerminal')}</button>
            <button class="conversation-control-btn stop" data-stop-agent-run="\${escapeHtml(conversation.id)}" title="\${escapeHtml(t('stopRun'))}">\${t('stopRun')}</button>
          \`
          : '';
        return \`
          <div class="conversation-item" data-conversation-id="\${escapeHtml(conversationId)}">
            <div class="conversation-row">
              <div class="conversation-meta">
                <span class="conversation-cli">\${escapeHtml(conversation.agentCli || '')}</span>
                <span class="conversation-summary">\${escapeHtml(summary)}</span>
                <span class="conversation-time">\${escapeHtml(when)}</span>
                \${runtimeLabel ? \`<span class="conversation-runtime">\${escapeHtml(runtimeLabel)}</span>\` : ''}
              </div>
              <div class="conversation-actions">
                \${runningButtons}
                \${continueButton}
                \${retryButton}
                <span class="status-badge \${statusClass(conversation.status)}">\${conversationStatusText(conversation.status)}</span>
              </div>
            </div>
            \${open ? \`
              <div class="conversation-detail">
                \${renderConversationOutcome(conversation, nodeId)}
                \${renderConversationFiles(conversation)}
                \${nodeId === soloConversationId && conversation.status !== 'Running' ? renderSoloClosure(conversation) : ''}
                <strong>\${t('command')}</strong>
                <pre>\${escapeHtml(conversation.command)}</pre>
                <strong>\${t('output')}</strong>
                <pre>\${escapeHtml(conversation.output)}</pre>
              </div>
            \` : ''}
          </div>
        \`;
      }).join('');
      return '<div class="conversation-list">' + items + '</div>';
    }

    function formatDurationMs(durationMs) {
      const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainder = seconds % 60;
      if (hours > 0) return hours + 'h ' + minutes + 'm';
      if (minutes > 0) return minutes + 'm ' + remainder + 's';
      return remainder + 's';
    }

    function formatConversationDuration(conversation) {
      const output = String(conversation.output || '');
      const storedDuration = output.match(/Run duration ms:\\s*(\\d+)/);
      if (storedDuration) {
        return formatDurationMs(Number(storedDuration[1]));
      }
      if (conversation.status !== 'Running' || !conversation.timestamp) {
        return '';
      }
      return formatDurationMs(Date.now() - new Date(conversation.timestamp).getTime());
    }

    function renderConversationOutcome(conversation, nodeId = '') {
      const output = String(conversation.output || '');
      const failureCategory = (output.match(/Failure category:\\s*([^\\n]+)/) || [])[1] || '';
      const failureReason = (output.match(/Failure reason:\\n([\\s\\S]*?)(?:\\n\\n|$)/) || [])[1] || '';
      const files = extractConversationFiles(output);
      let result = '';
      if (conversation.status === 'Running') {
        result = t('stillWorking');
      } else if (conversation.status === 'Failed') {
        result = failureCategoryText(failureCategory.trim()) || failureReason.trim() || statusText(conversation.status);
      } else if (conversation.status === 'Linked') {
        result = t('linkedFromSolo');
      } else if (conversation.status === 'Completed' && nodeId === soloConversationId) {
        result = t('soloCompleted');
      } else if (conversation.status === 'Completed') {
        result = t('stepCompleted');
      } else {
        result = t('awaitingNextConversation');
      }
      if (files.length > 0 && conversation.status !== 'Running') {
        result += ' ' + t('changedCount') + ': ' + files.length + '.';
      }
      const label = conversation.status === 'Failed' ? t('failureLabel') : t('runResult');
      const conclusion = conversation.status === 'Running' ? '' : extractAgentConclusion(output);
      const preGitHashMatch = output.match(/SoloMapPreGitHash:\s*([a-f0-9]+)/i);
      const preGitHash = preGitHashMatch ? preGitHashMatch[1] : '';
      const rollbackButton = (preGitHash && conversation.status !== 'Running')
        ? '<button class="rollback-btn" data-rollback-hash="' + preGitHash + '" title="撤销本次修改，回滚项目状态"><span class="codicon codicon-discard"></span> 撤销修改</button>'
        : '';
      return \`
        <div class="conversation-outcome \${conversation.status === 'Failed' ? 'failed' : ''}">
          <div class="conversation-outcome-header">
            <div class="conversation-outcome-title"><strong>\${escapeHtml(label)}:</strong> \${escapeHtml(result)}</div>
            \${rollbackButton}
          </div>
          \${conclusion ? \`<div><strong>\${escapeHtml(t('agentConclusion'))}:</strong> \${escapeHtml(conclusion)}</div>\` : ''}
        </div>
      \`;
    }

    function extractAgentConclusion(output) {
      const match = String(output || '').match(/Agent output tail:\\n([\\s\\S]*)$/);
      if (!match || !match[1]) {
        return '';
      }
      return match[1]
        .split('\\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('SoloMap:'))
        .slice(-3)
        .join(' ')
        .replace(/\\s+/g, ' ')
        .slice(0, 240);
    }

    function getAgentOptions(node) {
      const options = [];
      function addOption(value) {
        const option = buildAgentOption(value);
        if (!option || options.some(existing => existing.label === option.label)) return;
        options.push(option);
      }
      addOption(currentCliPath || 'agy');
      addOption(node.agentCli || currentCliPath || 'agy');
      addOption('antigravity');
      addOption('cursor');
      addOption('codex');
      addOption('copilot');
      addOption('claude');
      addOption('opencode');
      return options;
    }

    function buildAgentOption(value) {
      const normalized = String(value || '').trim();
      const label = normalizeAgentOptionLabel(normalized);
      if (!label) return null;
      const optionValue = normalized.includes('/') || normalized.includes('\\\\') ? normalized : label;
      return { value: optionValue, label };
    }

    function normalizeAgentOptionLabel(value) {
      const normalized = String(value || '').trim();
      const name = normalized.split(/[\\\\/]/).pop().toLowerCase();
      if (name === 'codex-cli') return 'codex';
      if (name === 'solomap-codex-auto') return 'codex';
      if (name === 'cursor-cli' || name === 'cursor-agent') return 'cursor';
      if (name === 'solomap-cursor-auto') return 'cursor';
      if (name === 'copilot-cli') return 'copilot';
      if (name === 'solomap-copilot-auto') return 'copilot';
      if (name === 'agy' || name === 'antigravity-cli') return 'antigravity';
      if (name === 'solomap-antigravity-auto') return 'antigravity';
      if (name === 'claude-code' || name === 'claude-code-cli') return 'claude';
      if (name === 'solomap-claude-auto') return 'claude';
      if (name === 'open-code' || name === 'open-code-cli') return 'opencode';
      return normalized;
    }

    function mergeSupplementFiles(existing, incoming) {
      const seen = new Set();
      return [...(existing || []), ...(incoming || [])]
        .map(file => String(file || '').trim())
        .filter(Boolean)
        .filter(file => {
          if (seen.has(file)) return false;
          seen.add(file);
          return true;
        })
        .slice(0, 10);
    }

    function readClipboardImage(file) {
      return new Promise((resolve) => {
        if (typeof FileReader === 'undefined' || !file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve({
          name: file.name || 'pasted-image',
          mimeType: file.type || 'image/png',
          dataUrl: String(reader.result || '')
        });
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    function bindPastedImageAttachments(input, nodeId, afterPaste) {
      if (!input || input.getAttribute('data-paste-image-bound') === 'true') return;
      input.setAttribute('data-paste-image-bound', 'true');
      input.addEventListener('paste', async (event) => {
        const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
        const files = items
          .filter(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))
          .map(item => item.getAsFile())
          .filter(Boolean);
        if (!files.length) return;
        event.preventDefault();
        const attachments = (await Promise.all(files.map(readClipboardImage))).filter(Boolean);
        if (!attachments.length) return;
        vscode.postMessage({
          command: 'savePastedAttachments',
          nodeId,
          attachments
        });
      });
    }

    function renderSupplementFiles(nodeId, files) {
      if (!files || files.length === 0) {
        return '';
      }
      return \`
        <div class="conversation-attachments" aria-label="\${escapeHtml(t('attachedFiles'))}">
          \${files.map(file => \`
            <span class="conversation-attachment-chip" title="\${escapeHtml(file)}">
              <span>\${escapeHtml(file)}</span>
              <button
                class="conversation-attachment-remove"
                data-remove-supplement-file="\${escapeHtml(file)}"
                title="\${escapeHtml(t('removeAttachment'))}"
              >
                <span class="codicon codicon-close"></span>
              </button>
            </span>
          \`).join('')}
        </div>
      \`;
    }

    function summarizeConversation(conversation) {
      const output = String(conversation.output || '');
      const userMatch = output.match(/User supplement:\\n([\\s\\S]*?)(\\n\\n|$)/);
      if (userMatch && userMatch[1].trim()) {
        return userMatch[1].trim().replace(/\\s+/g, ' ').slice(0, 120);
      }
      const changedMatch = output.match(/Touched project files:\\n([\\s\\S]*?)(\\n\\n|$)/);
      if (changedMatch && changedMatch[1].trim() && !changedMatch[1].includes('No project files')) {
        return changedMatch[1].trim().replace(/\\s+/g, ' ').slice(0, 120);
      }
      const tailMatch = output.match(/Agent output tail:\\n([\\s\\S]*)$/);
      const fallback = tailMatch ? tailMatch[1] : output;
      return fallback.trim().replace(/\\s+/g, ' ').slice(0, 120) || statusText(conversation.status);
    }

    function extractConversationFiles(output) {
      const text = String(output || '');
      const sections = [
        /Touched project files:\\n([\\s\\S]*?)(?:\\n\\n|$)/,
        /Workspace changes:\\n([\\s\\S]*?)(?:\\n\\nTouched project files:|\\n\\n|$)/
      ];
      const files = [];
      const seen = new Set();
      for (const pattern of sections) {
        const match = text.match(pattern);
        if (!match || !match[1]) continue;
        const lines = match[1].split('\\n').map(line => line.trim()).filter(Boolean);
        for (const line of lines) {
          if (/^No (workspace|git|project) /i.test(line)) continue;
          const normalized = line.replace(/^(?:[AMDRC?U!]{1,2}|[A-Z])\\s+/, '').trim();
          if (!normalized || seen.has(normalized)) continue;
          seen.add(normalized);
          files.push({ label: line, path: normalized });
        }
      }
      return files;
    }

    function renderConversationFiles(conversation) {
      const files = extractConversationFiles(conversation.output);
      if (!files.length) {
        return '';
      }
      return \`
        <strong>\${escapeHtml(t('changedFiles'))}</strong>
        <div class="conversation-files">
          \${files.map(file => \`
            <button
              class="conversation-file-link"
              data-open-file-path="\${escapeHtml(file.path)}"
              title="\${escapeHtml(file.path)}"
            >
              <span>\${escapeHtml(file.label)}</span>
              <span>\${escapeHtml(t('openFile'))}</span>
            </button>
          \`).join('')}
        </div>
      \`;
    }

    function toggleNode(nodeId) {
      expandedNodeId = expandedNodeId === nodeId ? '' : nodeId;
      activeConversationId = '';
      if (expandedNodeId && !nodeConversations[nodeId]) {
        vscode.postMessage({ command: 'getNodeConversations', nodeId });
      }
      if (expandedNodeId) {
        const node = (currentNodes || []).find(candidate => candidate.id === nodeId);
        ensureAgentModelsLoaded(nodeAgentSelections[nodeId] || node?.agentCli || currentCliPath || 'agy', nodeId);
      }
      renderRoadmap(currentNodes);
    }

    function cssEscape(value) {
      if (window.CSS && window.CSS.escape) {
        return window.CSS.escape(value);
      }
      return String(value).replace(/"/g, '\\"');
    }

    function triggerRun(nodeId, userMessage, agentCli, model, supplementFiles) {
      vscode.postMessage({
        command: 'runAgent',
        nodeId: nodeId,
        userMessage: userMessage || '',
        agentCli: agentCli || '',
        model: model || '',
        supplementFiles: supplementFiles || []
      });
    }
  </script>
</body>
</html>`;
}

export function deactivate() {
  if (watcher) {
    watcher.dispose();
  }
  if (statusPoller) {
    clearInterval(statusPoller);
  }
}

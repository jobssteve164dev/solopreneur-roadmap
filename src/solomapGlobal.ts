import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { buildAgentDatabaseInstructions } from './agentDatabaseConfig';
import { buildSystemMaintenancePromptGuard } from './systemMaintenance';
import { RoadmapNode } from './db/types';
import { readLearningOverview } from './learningLedger';
import { shellQuote } from './agentCli';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { capabilitySnapshot, capabilityVersion, refreshCapabilityRegistry, writeCapabilityEntries, captureInstallationFiles, completeCapabilityEntry, setCapabilityEnabled, readCapabilityOperation, CapabilityKind, CapabilityRegistryVersion } from './capabilityRegistry';

export async function refreshSolomapCapabilityRegistries(workspaceRoot: string, globalDataPath = ''): Promise<void> {
  await Promise.all([readSolomapSkillRegistry(workspaceRoot, globalDataPath), readSolomapMcpRegistry(workspaceRoot, globalDataPath)]);
}

export function getSolomapCapabilityRevision(workspaceRoot: string, globalDataPath = ''): string {
  const root = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  return (['skill', 'mcp'] as CapabilityKind[]).map(kind => capabilityVersion(root, kind)).join(':');
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
7. Run the shared SoloMap roadmap validation command provided in the task prompt, and fix failures before finalizing.

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

export function ensureSolomapMaintenanceWorkspace(workspaceRoot: string, globalDataPath = ''): { maintenanceRoot: string; runsRoot: string } {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const maintenanceRoot = path.join(globalRoot, 'tmp', 'maintenance-workspace');
  const runsRoot = path.join(globalRoot, 'tmp', 'maintenance-runs');
  ensureManagedDirectory(globalRoot, maintenanceRoot);
  ensureManagedDirectory(globalRoot, runsRoot);
  return { maintenanceRoot, runsRoot };
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
      ensureManagedDirectory(root, packageRoot);
      try { fs.writeFileSync(entryPath, builtin.skillMd, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!realFileInside(packageRoot, entryPath)) throw new Error('builtin_skill_package_path_invalid');
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
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
  const installedRoot = path.join(skillsRoot, 'installed');
  const runsRoot = path.join(globalRoot, 'tmp', 'skill-installs');
  const registryPath = 'solomap://capability-registry/skill';
  ensureManagedDirectory(globalRoot, installedRoot);
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
  const visible = current.entries.filter(item => item.entry.status !== 'uninstalled' && item.entry.id !== 'solomap-enhancement-installer');
  return { version: 1, updatedAt: '', skills: visible.map(item => item.entry as SolomapSkillRegistryEntry), entryVersions: Object.fromEntries(current.entries.filter(item => item.entry.id !== 'solomap-enhancement-installer').map(item => [item.entry.id, item.revision])) };
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
    buildAgentDatabaseInstructions({ migrationTools: ['solo', 'solo_continue'].includes(String(input.runKind || '')) }),
    '- 读取后用一句话形成本轮约束：用户目标、必须保留的边界、适用经验、最窄验证。',
    skillBlocks.length
      ? ['- 命中的技能必须逐一判定 used / skipped-not-applicable；判定为 used 的技能必须先读取入口 SKILL.md：', ...skillBlocks].join('\n')
      : '- 本轮没有命中需要读取的 SoloMap 技能；继续按记忆与当前项目事实执行。',
    input.learningSummaryContext ? ['', input.learningSummaryContext].join('\n') : '',
    input.learningRetrievalContext ? ['', input.learningRetrievalContext].join('\n') : '',
    input.executionExperienceContext ? ['', input.executionExperienceContext].join('\n') : '',
    '- 本轮经验采用与纠偏通过任务报告记录；候选提炼和晋升由用户手动“复盘经验”处理，不因本次召回自动晋升。',
    '- 经验库只能约束执行方式，不能覆盖本轮用户最新要求、当前代码、测试、日志和命令输出。'
  ].filter(Boolean).join('\n');
}

function buildCapabilityResultPublicationInstructions(resultFilePath: string): string[] {
  return [
    '结果发布协议：',
    `- 全部物理操作和最终验证完成后，先把完整 JSON 写入 ${resultFilePath}.tmp，再原子重命名为 ${resultFilePath}。`,
    '- result.json 是宿主结算信号，只能在最终状态确定后发布，写入后不得再次修改。',
    '- result.json 原子发布并完成任务报告预检后，用检查点命令的 complete 动作结算本轮，成功时必须传入 `--outcome candidate_complete`、非空 `--summary` 和完整 `--report-json`。',
    '- `success` 或 `completed` 不是合法的 outcome；合法值只有 partial、candidate_complete、blocked_user、blocked_external、failed。',
    '- 这是非交互维护运行。complete 成功后直接正常退出 CLI，不要调用 session-close。'
  ];
}

function buildCapabilityInstallActionInstructions(kindLabel: string, targetId: string, installedPath: string, stagingRoot: string): string[] {
  const candidateRoot = path.join(stagingRoot, 'candidate');
  if (!targetId) return [
    `本次动作是首次安装 ${kindLabel}。如果目标 ID 已存在，写入失败结果，不要覆盖已有能力。`,
    `完整候选只能写入 ${candidateRoot}/<最终 ID>；不得写入正式 installed/servers 目录。宿主核验通过后会原子提交。`
  ];
  return [
    `本次动作是更新现有 ${kindLabel}，目标 ID 必须保持为：${targetId}。`,
    `用户已在 SoloMap 界面明确请求更新 ${targetId}；正式目录 ${installedPath} 只能由宿主在核验通过后原子替换。`,
    `完整候选只能写入 ${path.join(candidateRoot, targetId)}；不得直接修改正式目录、同级其他能力、数据库、registry 或用户项目文件。`,
    `在本次暂存目录完成新版本与全部校验：${stagingRoot}；result.json 发布后由宿主提交或按启动前基线回滚。`,
    '- 更新后的结果 JSON 必须仍使用上述目标 ID；来源声明了不同 ID 时写失败结果，不得新建第二个能力。'
  ];
}

export function buildSkillInstallPrompt(skillInput: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string, upgradeTargetId = ''): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
  const { maintenanceRoot } = ensureSolomapMaintenanceWorkspace(workspaceRoot, globalDataPath);
  const stagingRoot = path.dirname(resultFilePath);
  const candidateRoot = path.join(stagingRoot, 'candidate');
  const upgradeInstalledPath = upgradeTargetId ? path.join(skillsRoot, 'installed', upgradeTargetId) : '';
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
    ...buildCapabilityInstallActionInstructions('skill', upgradeTargetId, upgradeInstalledPath, stagingRoot),
    '',
    '目标目录结构：',
    `- ${path.join(candidateRoot, '<skill-id>', 'package')}：完整 skill package，必须包含入口 SKILL.md，并保留 scripts、templates、assets、examples 等同级资源。`,
    `- ${path.join(stagingRoot, 'solomap.skill.json')}：本次安装的完整技能元数据，供插件提交到数据库。`,
    `- ${path.join(stagingRoot, 'source.lock.json')}：本次安装的完整来源、commit、原始 skillPath、安装时间和 hash。`,
    '',
    '安装步骤：',
    '1. 解析用户提供的来源。支持 skills.sh URL、GitHub URL、owner/repo、owner/repo@skill、仓库子目录 URL。',
    `2. 下载或克隆来源到 ${path.join(stagingRoot, 'preview')}；使用明确的目标目录参数，不修改 HOME 或用户真实 Agent 技能目录。`,
    '3. 定位目标 skill package 的实际文件夹；不要只复制 `SKILL.md`。',
    '4. 选择稳定 `skill-id`：优先用 SKILL.md frontmatter 的 `name`，否则用目录名；只允许小写字母、数字和连字符。',
    `5. 将完整 package 写入 ${path.join(candidateRoot, '<skill-id>', 'package')}；不得直接写正式 installed 目录。`,
    `6. 从 SKILL.md 解析 title/name、description、version，在 ${path.join(stagingRoot, 'solomap.skill.json')} 生成元数据；至少包含 id、title、description、entry、packagePath、status、source、activation、risk、installedAt、updatedAt。`,
    '7. 扫描 package，标记风险：是否包含 scripts、可执行文件、网络访问提示、文件写入提示。默认 `requiresUserApprovalToRunScripts=true`。',
    `8. 将完整来源锁写入 ${path.join(stagingRoot, 'source.lock.json')}，不要在实际执行包旁保存第二份元数据。`,
    '9. 写入安装结果 JSON。',
    '',
    '结果 JSON schema：',
    '{',
    '  "ok": true,',
    '  "skillId": "skill-id",',
    `  "installedPath": ${JSON.stringify(path.join(candidateRoot, 'skill-id'))},`,
    `  "packagePath": ${JSON.stringify(path.join(candidateRoot, 'skill-id', 'package'))},`,
    `  "entryFile": ${JSON.stringify(path.join(candidateRoot, 'skill-id', 'package', 'SKILL.md'))},`,
    `  "solomapSkillJson": ${JSON.stringify(path.join(stagingRoot, 'solomap.skill.json'))},`,
    `  "sourceLockJson": ${JSON.stringify(path.join(stagingRoot, 'source.lock.json'))},`,
    '  "metadata": { "name": "skill-id", "description": "...", "version": "..." },',
    '  "source": { "input": "...", "repo": "owner/repo", "commit": "...", "skillPath": "..." },',
    '  "risk": { "hasScripts": false, "hasExecutables": false, "usesNetwork": "unknown", "writesFiles": "unknown", "requiresUserApprovalToRunScripts": true }',
    '}',
    `source.lock.json 必须使用单一来源结构并记录 {"input":${JSON.stringify(skillInput)},"packageHash":"sha256:<包摘要>"}；不得同时提供顶层来源字段和嵌套 source。包摘要算法固定为：枚举 package 内全部普通文件，按使用 / 分隔符的 UTF-8 相对路径排序，对每个文件依次写入相对路径、一个 NUL 字节、完整文件字节、一个 NUL 字节，最后取 SHA-256；遇到符号链接或非普通文件必须失败。更新时必须原样保留已登记来源的 repo、url、package、packageManager、executable 等稳定身份，并记录本次实际核验的新 commit/version。`,
    '',
    '如果安装失败，也必须写入结果 JSON：',
    '{ "ok": false, "error": "一句话说明失败原因", "source": { "input": "..." } }',
    '',
    '安全边界：',
    upgradeTargetId ? '- 只允许按上面的更新授权处理确切目标目录；不要清空目录。' : '- 不要删除旧文件或清空目录。',
    '- 不要把 package 安装到 `~/.codex`、`~/.claude`、`~/.agents`、项目源码目录或其他 Agent 私有目录作为正式结果。',
    '- 不要运行 skill package 中的脚本；安装阶段只允许读取、复制、分析。',
    '- 如果来源不清楚或存在多个候选 skill，选择最匹配用户输入的一个；无法判断时写失败结果 JSON，不要猜测安装。',
    '',
    ...buildCapabilityResultPublicationInstructions(resultFilePath),
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

export function managedCapabilityPathIsSafe(globalRoot: string, candidate: string): boolean {
  try {
    const root = path.resolve(globalRoot), target = path.resolve(candidate);
    if (target !== root && !pathInside(root, target)) return false;
    const rootInfo = fs.lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
    const physicalRoot = fs.realpathSync(root);
    let current = root;
    const segments = path.relative(root, target).split(path.sep).filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      let info: fs.Stats;
      try { info = fs.lstatSync(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
      if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory())) return false;
      const physical = fs.realpathSync(current);
      if (physical !== physicalRoot && !pathInside(physicalRoot, physical)) return false;
    }
    return true;
  } catch { return false; }
}

function physicalPathEntryExists(candidate: string): boolean {
  try { fs.lstatSync(candidate); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function ensureManagedDirectory(globalRoot: string, directory: string): void {
  if (!fs.existsSync(globalRoot)) fs.mkdirSync(globalRoot, { recursive: true });
  if (!managedCapabilityPathIsSafe(globalRoot, directory)) throw new Error('capability_managed_path_invalid');
  fs.mkdirSync(directory, { recursive: true });
  if (!managedCapabilityPathIsSafe(globalRoot, directory) || !fs.lstatSync(directory).isDirectory()) throw new Error('capability_managed_path_invalid');
}

function exactPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function realFileInside(root: string, candidate: string): boolean {
  try {
    if (!managedCapabilityPathIsSafe(root, candidate)) return false;
    const info = fs.lstatSync(candidate);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    return pathInside(fs.realpathSync(root), fs.realpathSync(candidate));
  } catch { return false; }
}

function realDirectoryInside(root: string, candidate: string): boolean {
  try {
    if (!managedCapabilityPathIsSafe(root, candidate)) return false;
    const info = fs.lstatSync(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    return pathInside(fs.realpathSync(root), fs.realpathSync(candidate));
  } catch { return false; }
}

function capabilityIdentity(value: unknown): string {
  const identity = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*$/.test(identity) ? identity : '';
}

function realCapabilityResult(globalRoot: string, candidate: string): boolean {
  const temporaryRoot = path.join(globalRoot, 'tmp');
  return realDirectoryInside(globalRoot, temporaryRoot) && realFileInside(temporaryRoot, candidate);
}

function realCapabilityEvidence(globalRoot: string, installedPath: string, resultFilePath: string, candidate: string): boolean {
  const stagingRoot = path.dirname(resultFilePath);
  return realFileInside(globalRoot, candidate)
    && (realFileInside(installedPath, candidate) || realFileInside(stagingRoot, candidate));
}

type ManagedInstallKind = 'skill' | 'mcp';

function managedInstallRoot(globalRoot: string, kind: ManagedInstallKind): string {
  return kind === 'skill' ? path.join(globalRoot, 'skills', 'installed') : path.join(globalRoot, 'mcp', 'servers');
}

function capabilityBaselineRoot(globalRoot: string, operationId: string): string {
  return path.join(globalRoot, 'tmp', 'capability-operation-baselines', operationId);
}

function removeManagedTreeExact(globalRoot: string, target: string): void {
  if (!physicalPathEntryExists(target)) return;
  if (!managedCapabilityPathIsSafe(globalRoot, path.dirname(target)) || (!pathInside(globalRoot, target) && path.resolve(globalRoot) !== path.resolve(target))) throw new Error('capability_rollback_path_invalid');
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink() || info.isFile()) { fs.unlinkSync(target); return; }
  if (!info.isDirectory()) throw new Error('capability_rollback_entry_invalid');
  for (const name of fs.readdirSync(target).sort()) removeManagedTreeExact(globalRoot, path.join(target, name));
  fs.rmdirSync(target);
}

function copyManagedTreeExact(source: string, target: string): void {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) throw new Error('capability_baseline_symlink');
  if (info.isFile()) { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); return; }
  if (!info.isDirectory()) throw new Error('capability_baseline_entry_invalid');
  fs.mkdirSync(target);
  for (const name of fs.readdirSync(source).sort()) copyManagedTreeExact(path.join(source, name), path.join(target, name));
}

function managedTreeInventory(actualRoot: string, reportedRoot = actualRoot): string[] {
  if (!physicalPathEntryExists(actualRoot)) throw new Error('capability_uninstall_target_missing');
  const result: string[] = [];
  const visit = (actual: string): void => {
    const info = fs.lstatSync(actual);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('capability_uninstall_entry_invalid');
    result.push(path.join(reportedRoot, path.relative(actualRoot, actual)));
    if (info.isDirectory()) for (const name of fs.readdirSync(actual).sort()) visit(path.join(actual, name));
  };
  visit(actualRoot);
  return result.map(item => path.resolve(item)).sort();
}

export async function prepareCapabilityOperationFilesystemBaseline(globalRoot: string, operationId: string): Promise<void> {
  const operation = await readCapabilityOperation(globalRoot, operationId);
  if (!['skill', 'mcp'].includes(operation.kind) || !['install', 'upgrade', 'uninstall'].includes(operation.action)) return;
  const kind = operation.kind as ManagedInstallKind;
  const installedRoot = managedInstallRoot(globalRoot, kind);
  ensureManagedDirectory(globalRoot, installedRoot);
  const baselineRoot = capabilityBaselineRoot(globalRoot, operationId);
  const manifestPath = path.join(baselineRoot, 'baseline.json');
  if (physicalPathEntryExists(manifestPath)) return;
  if (physicalPathEntryExists(baselineRoot)) throw new Error('capability_baseline_incomplete');
  fs.mkdirSync(baselineRoot, { recursive: true });
  const existingNames = fs.readdirSync(installedRoot).sort();
  const targetPath = operation.targetId ? path.join(installedRoot, operation.targetId) : '';
  const targetExisted = Boolean(targetPath && physicalPathEntryExists(targetPath));
  if (targetExisted) copyManagedTreeExact(targetPath, path.join(baselineRoot, 'target'));
  fs.writeFileSync(manifestPath, JSON.stringify({ kind, action: operation.action, targetId: operation.targetId, existingNames, targetExisted }), { encoding: 'utf8', flag: 'wx' });
}

export async function rollbackCapabilityOperationFilesystem(globalRoot: string, operationId: string): Promise<void> {
  const baselineRoot = capabilityBaselineRoot(globalRoot, operationId);
  const manifestPath = path.join(baselineRoot, 'baseline.json');
  if (!physicalPathEntryExists(manifestPath)) {
    if (!physicalPathEntryExists(baselineRoot)) return;
    const baselinesRoot = path.dirname(baselineRoot);
    if (!realDirectoryInside(baselinesRoot, baselineRoot)) throw new Error('capability_baseline_invalid');
    removeManagedTreeExact(globalRoot, baselineRoot);
    if (physicalPathEntryExists(baselinesRoot) && fs.readdirSync(baselinesRoot).length === 0) fs.rmdirSync(baselinesRoot);
    return;
  }
  const manifest = readJsonObject(manifestPath);
  const kind = manifest.kind as ManagedInstallKind;
  if (!['skill', 'mcp'].includes(kind) || !Array.isArray(manifest.existingNames)) throw new Error('capability_baseline_invalid');
  const installedRoot = managedInstallRoot(globalRoot, kind);
  const liveBackup = path.join(baselineRoot, 'live');
  if (manifest.targetId && physicalPathEntryExists(liveBackup)) {
    const target = path.join(installedRoot, String(manifest.targetId));
    removeManagedTreeExact(globalRoot, target);
    fs.renameSync(liveBackup, target);
  } else if (manifest.targetId && manifest.targetExisted) {
    const target = path.join(installedRoot, String(manifest.targetId));
    removeManagedTreeExact(globalRoot, target);
    const backup = path.join(baselineRoot, 'target');
    if (!physicalPathEntryExists(backup)) throw new Error('capability_baseline_target_missing');
    fs.renameSync(backup, target);
  }
  removeManagedTreeExact(globalRoot, baselineRoot);
  const parent = path.dirname(baselineRoot);
  if (physicalPathEntryExists(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
}

function completeCapabilityFilesystemCommit(globalRoot: string, operationId: string): void {
  const baselineRoot = capabilityBaselineRoot(globalRoot, operationId);
  if (!physicalPathEntryExists(baselineRoot)) return;
  for (const name of fs.readdirSync(baselineRoot).sort()) removeManagedTreeExact(globalRoot, path.join(baselineRoot, name));
  fs.rmdirSync(baselineRoot);
  const parent = path.dirname(baselineRoot);
  if (physicalPathEntryExists(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
}

export async function reconcileCapabilityOperationFilesystems(globalRoot: string): Promise<void> {
  const baselinesRoot = path.join(globalRoot, 'tmp', 'capability-operation-baselines');
  if (!physicalPathEntryExists(baselinesRoot)) return;
  if (!realDirectoryInside(globalRoot, baselinesRoot)) throw new Error('capability_baseline_root_invalid');
  for (const operationId of fs.readdirSync(baselinesRoot).sort()) {
    const baselineRoot = path.join(baselinesRoot, operationId);
    if (!realDirectoryInside(baselinesRoot, baselineRoot)) throw new Error('capability_baseline_invalid');
    let operation;
    try { operation = await readCapabilityOperation(globalRoot, operationId); }
    catch { continue; }
    if (operation.status === 'succeeded') completeCapabilityFilesystemCommit(globalRoot, operationId);
    else if (operation.status === 'failed' || operation.status === 'stale') await rollbackCapabilityOperationFilesystem(globalRoot, operationId);
  }
}

async function commitStagedCapabilityDirectory<T>(globalRoot: string, operationId: string, kind: ManagedInstallKind, targetId: string, stagedPath: string, commit: (finalPath: string) => Promise<T>): Promise<T> {
  const operation = await readCapabilityOperation(globalRoot, operationId);
  if (operation.kind !== kind || !['install', 'upgrade'].includes(operation.action) || (operation.targetId && operation.targetId !== targetId)) throw new Error('capability_operation_identity_conflict');
  const finalPath = path.join(managedInstallRoot(globalRoot, kind), targetId);
  const expectedStagedPath = path.join(path.dirname(String(operation.resultPath || '')), 'candidate', targetId);
  if (!operation.resultPath || !exactPath(stagedPath, expectedStagedPath) || !realDirectoryInside(path.dirname(operation.resultPath), stagedPath)) throw new Error('capability_staged_path_invalid');
  const baselineRoot = capabilityBaselineRoot(globalRoot, operationId);
  if (!physicalPathEntryExists(path.join(baselineRoot, 'baseline.json'))) throw new Error('capability_baseline_missing');
  const liveBackup = path.join(baselineRoot, 'live');
  const stagedExists = physicalPathEntryExists(stagedPath);
  if (stagedExists && physicalPathEntryExists(finalPath)) fs.renameSync(finalPath, liveBackup);
  try {
    if (stagedExists) fs.renameSync(stagedPath, finalPath);
    else if (!physicalPathEntryExists(finalPath)) throw new Error('capability_staged_path_missing');
    const result = await commit(finalPath);
    completeCapabilityFilesystemCommit(globalRoot, operationId);
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'capability_commit_state_unknown') throw error;
    if (!physicalPathEntryExists(stagedPath) && physicalPathEntryExists(finalPath)) {
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      fs.renameSync(finalPath, stagedPath);
    }
    if (physicalPathEntryExists(liveBackup) && !physicalPathEntryExists(finalPath)) fs.renameSync(liveBackup, finalPath);
    throw error;
  }
}

async function commitManagedCapabilityUninstall<T>(globalRoot: string, operationId: string, kind: ManagedInstallKind, targetId: string, installedPath: string, commit: () => Promise<T>): Promise<T> {
  const operation = await readCapabilityOperation(globalRoot, operationId);
  if (operation.kind !== kind || operation.action !== 'uninstall' || operation.targetId !== targetId) throw new Error('capability_operation_identity_conflict');
  const expectedPath = path.join(managedInstallRoot(globalRoot, kind), targetId);
  if (!exactPath(installedPath, expectedPath)) throw new Error('capability_uninstall_path_invalid');
  const baselineRoot = capabilityBaselineRoot(globalRoot, operationId), manifestPath = path.join(baselineRoot, 'baseline.json');
  if (!physicalPathEntryExists(manifestPath)) throw new Error('capability_baseline_missing');
  const liveBackup = path.join(baselineRoot, 'live');
  if (physicalPathEntryExists(installedPath)) {
    if (physicalPathEntryExists(liveBackup)) throw new Error('capability_uninstall_state_conflict');
    fs.renameSync(installedPath, liveBackup);
  } else if (!physicalPathEntryExists(liveBackup)) throw new Error('capability_uninstall_target_missing');
  try {
    const result = await commit();
    completeCapabilityFilesystemCommit(globalRoot, operationId);
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'capability_commit_state_unknown') throw error;
    if (physicalPathEntryExists(liveBackup) && !physicalPathEntryExists(installedPath)) fs.renameSync(liveBackup, installedPath);
    throw error;
  }
}

function readJsonObject(filePath: string): any {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('expected a JSON object');
  return value;
}

export function validateCapabilitySourceLock(sourceLock: any, sourceIntent: Record<string, any>): Record<string, any> {
  if (!sourceLock || typeof sourceLock !== 'object' || Array.isArray(sourceLock)) throw new Error('capability_source_lock_invalid');
  const nested = sourceLock.source;
  if (nested !== undefined && (!nested || typeof nested !== 'object' || Array.isArray(nested))) throw new Error('capability_source_lock_invalid');
  if (nested && Object.keys(sourceLock).some(key => !['source', 'packageHash'].includes(key))) throw new Error('capability_source_lock_ambiguous');
  const source = nested || sourceLock;
  const authorizedInput = String(sourceIntent?.input || '').trim();
  const lockedInput = String(source.input || '').trim();
  if (!authorizedInput || lockedInput !== authorizedInput) throw new Error('capability_source_mismatch');
  const previous = sourceIntent.registrySource && typeof sourceIntent.registrySource === 'object' ? sourceIntent.registrySource : {};
  for (const key of ['input', 'url', 'repo', 'repository', 'package', 'packageManager', 'executable', 'releaseBase', 'checksumAsset']) {
    const expected = String(previous[key] || '').trim();
    if (!expected) continue;
    const actual = String(source[key] || '').trim();
    if (actual !== expected) throw new Error('capability_source_mismatch');
  }
  return Object.fromEntries(Object.entries({ ...source, input: authorizedInput })
    .filter(([key, value]) => key !== 'source' && key !== 'packageHash' && value !== undefined));
}

export function capabilityPackageHash(packagePath: string): string {
  const root = fs.realpathSync(packagePath), files: string[] = [], pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    for (const name of fs.readdirSync(current).sort().reverse()) {
      const file = path.join(current, name), info = fs.lstatSync(file);
      if (info.isSymbolicLink()) throw new Error('capability_package_symlink');
      if (info.isDirectory()) pending.push(file);
      else if (info.isFile()) files.push(file);
      else throw new Error('capability_package_entry_invalid');
    }
  }
  const digest = crypto.createHash('sha256');
  for (const file of files.sort()) digest.update(path.relative(root, file).replace(/\\/g, '/')).update('\0').update(fs.readFileSync(file)).update('\0');
  return `sha256:${digest.digest('hex')}`;
}

async function validatedOperationSource(globalRoot: string, operationId: string, sourceLock: any, packagePath: string): Promise<Record<string, any>> {
  if (!operationId) return sourceLock.source || sourceLock;
  const operation = await readCapabilityOperation(globalRoot, operationId);
  const source = validateCapabilitySourceLock(sourceLock, operation.sourceIntent);
  if (String(sourceLock.packageHash || '') !== capabilityPackageHash(packagePath)) throw new Error('capability_source_hash_mismatch');
  return source;
}

export async function validateAndRegisterSkillInstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string, operationId = ''): Promise<{ ok: boolean; message: string; skillId?: string }> {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
  const installedRoot = path.join(skillsRoot, 'installed');
  if (!realCapabilityResult(globalRoot, resultFilePath)) {
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
  const skillId = capabilityIdentity(result.skillId || result.metadata?.name);
  if (!skillId) {
    return { ok: false, message: 'Skill install result is missing skillId.' };
  }
  const claimedInstalledPath = resolveSkillResultPath(globalRoot, result.installedPath || path.join(skillsRoot, 'installed', skillId));
  const claimedPackagePath = resolveSkillResultPath(globalRoot, result.packagePath || path.join(claimedInstalledPath, 'package'));
  const claimedEntryFile = resolveSkillResultPath(globalRoot, result.entryFile || path.join(claimedPackagePath, 'SKILL.md'));
  const solomapSkillJson = resolveSkillResultPath(globalRoot, result.solomapSkillJson || path.join(claimedInstalledPath, 'solomap.skill.json'));
  const sourceLockJson = resolveSkillResultPath(globalRoot, result.sourceLockJson || path.join(claimedInstalledPath, 'source.lock.json'));
  const operation = operationId ? await readCapabilityOperation(globalRoot, operationId) : undefined;
  const finalInstalledPath = path.join(installedRoot, skillId);
  const expectedInstalledPath = operation ? path.join(path.dirname(String(operation.resultPath || resultFilePath)), 'candidate', skillId) : finalInstalledPath;
  const stagingRoot = path.dirname(String(operation?.resultPath || resultFilePath));
  if (operation?.status === 'succeeded') {
    if (operation.targetId !== skillId || !realDirectoryInside(installedRoot, finalInstalledPath)) return { ok: false, message: 'capability_committed_filesystem_missing' };
    completeCapabilityFilesystemCommit(globalRoot, operationId);
    return { ok: true, message: `技能已安装：${skillId}`, skillId };
  }
  const recoveredSwap = Boolean(operation && !physicalPathEntryExists(claimedInstalledPath)
    && physicalPathEntryExists(path.join(capabilityBaselineRoot(globalRoot, operationId), 'baseline.json'))
    && physicalPathEntryExists(finalInstalledPath));
  const installedPath = recoveredSwap ? finalInstalledPath : claimedInstalledPath;
  const physicalClaim = (claimed: string): string => recoveredSwap && (exactPath(claimed, claimedInstalledPath) || pathInside(claimedInstalledPath, claimed))
    ? path.join(finalInstalledPath, path.relative(claimedInstalledPath, claimed)) : claimed;
  const packagePath = physicalClaim(claimedPackagePath), entryFile = physicalClaim(claimedEntryFile);
  if (operation && (!exactPath(resultFilePath, String(operation.resultPath || ''))
    || !exactPath(solomapSkillJson, path.join(stagingRoot, 'solomap.skill.json'))
    || !exactPath(sourceLockJson, path.join(stagingRoot, 'source.lock.json')))) {
    return { ok: false, message: 'capability_staged_evidence_path_invalid' };
  }
  if (!exactPath(claimedInstalledPath, expectedInstalledPath)) {
    return { ok: false, message: 'Skill installedPath does not match the install target.' };
  }
  if (!managedCapabilityPathIsSafe(globalRoot, installedPath)) {
    return { ok: false, message: 'Skill installedPath contains a linked parent or escapes the SoloMap data root.' };
  }
  const candidateParent = recoveredSwap ? installedRoot : operation ? path.dirname(String(operation.resultPath || resultFilePath)) : installedRoot;
  if (!realDirectoryInside(candidateParent, installedPath)) {
    return { ok: false, message: 'Skill installedPath is outside the authorized install candidate.' };
  }
  if (!realDirectoryInside(installedPath, packagePath) || !pathInside(packagePath, entryFile)) {
    return { ok: false, message: 'Skill package path is outside the installed skill directory.' };
  }
  if (!realFileInside(packagePath, entryFile) || ![solomapSkillJson, sourceLockJson].every((filePath) => realCapabilityEvidence(globalRoot, installedPath, resultFilePath, filePath))) {
    return { ok: false, message: 'Skill package is missing SKILL.md, solomap.skill.json, or source.lock.json.' };
  }
  let skillJson: any;
  try {
    skillJson = readJsonObject(solomapSkillJson);
  } catch (error: any) {
    return { ok: false, message: `solomap.skill.json is invalid: ${error.message}` };
  }
  let sourceLock: any;
  try { sourceLock = readJsonObject(sourceLockJson); }
  catch (error: any) { return { ok: false, message: `source.lock.json is invalid: ${error.message}` }; }
  if (skillJson.id && capabilityIdentity(skillJson.id) !== skillId) {
    return { ok: false, message: 'Skill manifest id does not match the install target.' };
  }
  let source: Record<string, any>;
  try { source = await validatedOperationSource(globalRoot, operationId, sourceLock, packagePath); }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  const entry: SolomapSkillRegistryEntry = {
    id: skillId,
    title: String(skillJson.title || skillJson.name || result.metadata?.name || skillId),
    description: String(skillJson.description || result.metadata?.description || ''),
    entry: path.relative(skillsRoot, path.join(finalInstalledPath, path.relative(installedPath, entryFile))).replace(/\\/g, '/'),
    packagePath: path.relative(skillsRoot, path.join(finalInstalledPath, path.relative(installedPath, packagePath))).replace(/\\/g, '/'),
    status: 'installed',
    source,
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
  const finalEntryFile = path.join(finalInstalledPath, path.relative(installedPath, entryFile));
  const files = { result: resultFilePath, manifest: solomapSkillJson, source_lock: sourceLockJson, entry_document: operationId ? finalEntryFile : entryFile };
  if (operationId) await commitStagedCapabilityDirectory(globalRoot, operationId, 'skill', skillId, claimedInstalledPath,
    async () => { await completeCapabilityEntry(globalRoot, operationId, 'skill', entry, files); });
  else await writeCapabilityEntries(globalRoot, 'skill', nextSkills.sort((a, b) => a.id.localeCompare(b.id)), registry.entryVersions, { [skillId]: files });
  return { ok: true, message: `技能已安装：${skillId}`, skillId };
}

export function getSolomapMcpRegistryPath(workspaceRoot: string, globalDataPath = ''): string {
  return 'solomap://capability-registry/mcp';
}

export function ensureSolomapMcpStore(workspaceRoot: string, globalDataPath = ''): { mcpRoot: string; serversRoot: string; runsRoot: string; profilesRoot: string; registryPath: string } {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  const serversRoot = path.join(mcpRoot, 'servers');
  const runsRoot = path.join(globalRoot, 'tmp', 'mcp-installs');
  const profilesRoot = path.join(mcpRoot, 'profiles');
  const registryPath = getSolomapMcpRegistryPath(workspaceRoot, globalDataPath);
  [mcpRoot, serversRoot, profilesRoot].forEach((dir) => ensureManagedDirectory(globalRoot, dir));
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

export function buildMcpInstallPrompt(mcpInput: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string, upgradeTargetId = ''): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  const { maintenanceRoot } = ensureSolomapMaintenanceWorkspace(workspaceRoot, globalDataPath);
  const stagingRoot = path.dirname(resultFilePath);
  const candidateRoot = path.join(stagingRoot, 'candidate');
  const upgradeInstalledPath = upgradeTargetId ? path.join(mcpRoot, 'servers', upgradeTargetId) : '';
  return [
    '你正在为 SoloMap 安装一个跨 Agent 通用 MCP 能力连接器。',
    ...buildSystemMaintenancePromptGuard(maintenanceRoot),
    '',
    `用户提供的 MCP 来源：${mcpInput}`,
    `SoloMap Global 目录：${globalRoot}`,
    `SoloMap MCP 目录：${mcpRoot}`,
    `安装结果 JSON 必须写入：${resultFilePath}`,
    '',
    ...buildCapabilityInstallActionInstructions('MCP', upgradeTargetId, upgradeInstalledPath, stagingRoot),
    '',
    '目标目录结构：',
    `- ${path.join(candidateRoot, '<mcp-id>', 'package')}：完整 MCP server package 或配置说明。`,
    `- ${path.join(stagingRoot, 'solomap.mcp.json')}：本次安装的完整 MCP 元数据，供插件提交到数据库。`,
    `- ${path.join(stagingRoot, 'source.lock.json')}：完整来源、commit、安装时间和 hash。`,
    `- ${path.join(stagingRoot, 'profiles')}：本次安装的 Agent 配置建议，供插件完整提交到数据库。`,
    '',
    '安装要求：',
    '1. 解析来源。支持 GitHub URL、npm package、MCP server 仓库、文档页或用户粘贴的 server 配置片段。',
    '2. 只做下载、复制、分析和生成配置建议；不要启动 MCP server，不要登录外部服务，不要写入任何 Agent 私有配置目录。',
    '3. 选择稳定 `mcp-id`：只允许小写字母、数字和连字符。',
    `4. 在 ${path.join(stagingRoot, 'solomap.mcp.json')} 生成元数据；至少包含 id、title、description、status、source、server、profiles、activation、permissions、risk、installedAt、updatedAt。server 中将来执行本地包所需的绝对路径必须指向提交后的正式目录 ${path.join(mcpRoot, 'servers', '<mcp-id>', 'package')}；宿主会把它映射到候选包核验，Agent 仍只能写候选目录。来源锁写入 ${path.join(stagingRoot, 'source.lock.json')}。`,
    '5. 识别风险：是否需要凭证、是否访问外网、是否可外部写入、是否可发消息、是否可修改云资源、是否可访问密钥；不确定时按高风险处理并设置 `requiresExplicitEnable: true`。',
    `6. 配置建议只写入 ${path.join(stagingRoot, 'profiles')}，不要应用到真实 Agent 配置，不要在实际执行包旁保存第二份元数据。`,
    '',
    '结果 JSON 格式：',
    '{',
    '  "ok": true,',
    '  "mcpId": "mcp-id",',
    `  "installedPath": ${JSON.stringify(path.join(candidateRoot, 'mcp-id'))},`,
    `  "packagePath": ${JSON.stringify(path.join(candidateRoot, 'mcp-id', 'package'))},`,
    `  "solomapMcpJson": ${JSON.stringify(path.join(stagingRoot, 'solomap.mcp.json'))},`,
    `  "sourceLockJson": ${JSON.stringify(path.join(stagingRoot, 'source.lock.json'))},`,
    `  "profilesPath": ${JSON.stringify(path.join(stagingRoot, 'profiles'))},`,
    '  "metadata": { "name": "mcp-id", "description": "...", "version": "..." },',
    '  "source": { "input": "...", "repo": "owner/repo", "commit": "..." },',
    '  "permissions": { "tools": [], "requiresCredentials": false, "externalAccess": "unknown", "writeAccess": "unknown" },',
    '  "risk": { "level": "low|medium|high", "requiresExplicitEnable": true }',
    '}',
    `source.lock.json 必须使用单一来源结构并记录 {"input":${JSON.stringify(mcpInput)},"packageHash":"sha256:<包摘要>"}；不得同时提供顶层来源字段和嵌套 source。包摘要算法固定为：枚举 package 内全部普通文件，按使用 / 分隔符的 UTF-8 相对路径排序，对每个文件依次写入相对路径、一个 NUL 字节、完整文件字节、一个 NUL 字节，最后取 SHA-256；遇到符号链接或非普通文件必须失败。更新时必须原样保留已登记来源的 repo、url、package、packageManager、executable 等稳定身份，并记录本次实际核验的新 commit/version。`,
    '',
    '失败时也必须写 result.json：',
    '{ "ok": false, "error": "清晰说明失败原因", "source": { "input": "..." } }',
    '',
    upgradeTargetId
      ? '安全边界：不要运行 server，不要写入用户 home 下的 Agent 配置，不要保存明文密钥；只允许按上面的更新授权处理确切目标目录。'
      : '安全边界：不要运行 server，不要写入用户 home 下的 Agent 配置，不要保存明文密钥，不要删除任何已有文件。',
    '',
    ...buildCapabilityResultPublicationInstructions(resultFilePath)
  ].join('\n');
}

export function buildCapabilityUninstallPrompt(kind: 'skill' | 'mcp', targetId: string, installedPath: string, resultFilePath: string): string {
  const idField = kind === 'skill' ? 'skillId' : 'mcpId';
  return [
    `你正在执行 SoloMap ${kind === 'skill' ? '技能' : 'MCP'} 卸载。`,
    `目标 ID：${targetId}`,
    `唯一允许处理的安装目录：${installedPath}`,
    `卸载结果 JSON：${resultFilePath}`,
    `用户已在 SoloMap 界面明确请求卸载 ${targetId}，授权范围仅限下面的确切目标目录。`,
    '只核对并记录上述目标目录内的完整物理清单；不得处理同级目录、数据库、registry、用户项目文件或其他能力。',
    '不得删除、移动或修改目标目录中的任何内容。宿主会核对清单，并在数据库提交边界内原子移走确切目标。',
    '清单必须包含目标目录本身、全部子目录和全部普通文件的绝对路径；遇到符号链接、特殊文件或无法确认归属的内容立即失败。',
    `完成后写入严格 JSON：{"ok":true,"${idField}":"${targetId}","inventoryPaths":["绝对路径"],"message":"已核对卸载清单"}。`,
    `失败时写入：{"ok":false,"${idField}":"${targetId}","inventoryPaths":[],"error":"具体原因"}。`,
    '不要修改 SoloMap 的能力登记；宿主会在核验回执、路径边界和目标状态后原子提交。',
    '',
    ...buildCapabilityResultPublicationInstructions(resultFilePath)
  ].join('\n');
}

export async function validateAndRegisterCapabilityUninstall(workspaceRoot: string, globalDataPath: string, kind: 'skill' | 'mcp', targetId: string, installedPath: string, resultFilePath: string, operationId: string): Promise<{ ok: boolean; message: string }> {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  if (!managedCapabilityPathIsSafe(globalRoot, installedPath)) return { ok: false, message: '能力受管安装路径包含符号链接或越过数据根。' };
  if (!realCapabilityResult(globalRoot, resultFilePath)) return { ok: false, message: '卸载结果 result.json 未生成。' };
  let result: any;
  try { result = JSON.parse(fs.readFileSync(resultFilePath, 'utf8')); }
  catch (error) { return { ok: false, message: `卸载结果 JSON 无效：${error instanceof Error ? error.message : String(error)}` }; }
  const resultId = capabilityIdentity(result[kind === 'skill' ? 'skillId' : 'mcpId']);
  if (resultId !== targetId) return { ok: false, message: '卸载回执与目标能力不一致。' };
  if (!result.ok) return { ok: false, message: String(result.error || result.message || '卸载未完成。') };
  const operation = await readCapabilityOperation(globalRoot, operationId);
  if (operation.kind !== kind || operation.action !== 'uninstall' || operation.targetId !== targetId) return { ok: false, message: '卸载操作与目标能力不一致。' };
  if (operation.status === 'succeeded') {
    if (physicalPathEntryExists(installedPath)) return { ok: false, message: 'capability_committed_filesystem_conflict' };
    completeCapabilityFilesystemCommit(globalRoot, operationId);
    return { ok: true, message: kind === 'skill' ? `技能已卸载：${targetId}` : `MCP 已卸载：${targetId}` };
  }
  const baselineRoot = capabilityBaselineRoot(globalRoot, operationId), liveBackup = path.join(baselineRoot, 'live');
  const inventoryRoot = physicalPathEntryExists(installedPath) ? installedPath : liveBackup;
  let expectedInventory: string[];
  try { expectedInventory = managedTreeInventory(inventoryRoot, installedPath); }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  if (!Array.isArray(result.inventoryPaths) || result.inventoryPaths.some((item: unknown) => typeof item !== 'string')) return { ok: false, message: '卸载回执缺少完整物理清单。' };
  const inventory = result.inventoryPaths.map((item: string) => path.resolve(item)).sort();
  if (new Set(inventory).size !== inventory.length || inventory.length !== expectedInventory.length || inventory.some((item: string, index: number) => item !== expectedInventory[index])) return { ok: false, message: '卸载回执与目标目录的完整物理清单不一致。' };
  const snapshot = await refreshCapabilityRegistry(globalRoot, kind);
  const current = snapshot.entries.find(item => item.entry.id === targetId);
  if (!current) return { ok: false, message: '能力登记不存在。' };
  await commitManagedCapabilityUninstall(globalRoot, operationId, kind, targetId, installedPath,
    async () => { await completeCapabilityEntry(globalRoot, operationId, kind, { ...current.entry, id: targetId, status: 'uninstalled', enabled: false }, { result: resultFilePath }); });
  return { ok: true, message: kind === 'skill' ? `技能已卸载：${targetId}` : `MCP 已卸载：${targetId}` };
}

export async function validateAndRegisterMcpInstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string, operationId = ''): Promise<{ ok: boolean; message: string; mcpId?: string }> {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  const serversRoot = path.join(mcpRoot, 'servers');
  if (!realCapabilityResult(globalRoot, resultFilePath)) {
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
  const mcpId = capabilityIdentity(result.mcpId || result.metadata?.name);
  if (!mcpId) {
    return { ok: false, message: 'MCP install result is missing mcpId.' };
  }
  const claimedInstalledPath = resolveSkillResultPath(globalRoot, result.installedPath || path.join(mcpRoot, 'servers', mcpId));
  const claimedPackagePath = resolveSkillResultPath(globalRoot, result.packagePath || path.join(claimedInstalledPath, 'package'));
  const solomapMcpJson = resolveSkillResultPath(globalRoot, result.solomapMcpJson || path.join(claimedInstalledPath, 'solomap.mcp.json'));
  const sourceLockJson = resolveSkillResultPath(globalRoot, result.sourceLockJson || path.join(claimedInstalledPath, 'source.lock.json'));
  const claimedProfilesPath = resolveSkillResultPath(globalRoot, result.profilesPath || path.join(claimedInstalledPath, 'profiles'));
  const operation = operationId ? await readCapabilityOperation(globalRoot, operationId) : undefined;
  const finalInstalledPath = path.join(serversRoot, mcpId);
  const expectedInstalledPath = operation ? path.join(path.dirname(String(operation.resultPath || resultFilePath)), 'candidate', mcpId) : finalInstalledPath;
  const stagingRoot = path.dirname(String(operation?.resultPath || resultFilePath));
  if (operation?.status === 'succeeded') {
    if (operation.targetId !== mcpId || !realDirectoryInside(serversRoot, finalInstalledPath)) return { ok: false, message: 'capability_committed_filesystem_missing' };
    completeCapabilityFilesystemCommit(globalRoot, operationId);
    return { ok: true, message: `MCP 已安装：${mcpId}`, mcpId };
  }
  const recoveredSwap = Boolean(operation && !physicalPathEntryExists(claimedInstalledPath)
    && physicalPathEntryExists(path.join(capabilityBaselineRoot(globalRoot, operationId), 'baseline.json'))
    && physicalPathEntryExists(finalInstalledPath));
  const physicalClaim = (claimed: string): string => recoveredSwap && (exactPath(claimed, claimedInstalledPath) || pathInside(claimedInstalledPath, claimed))
    ? path.join(finalInstalledPath, path.relative(claimedInstalledPath, claimed)) : claimed;
  const installedPath = recoveredSwap ? finalInstalledPath : claimedInstalledPath;
  const packagePath = physicalClaim(claimedPackagePath), profilesPath = physicalClaim(claimedProfilesPath);
  if (operation && (!exactPath(resultFilePath, String(operation.resultPath || ''))
    || !exactPath(solomapMcpJson, path.join(stagingRoot, 'solomap.mcp.json'))
    || !exactPath(sourceLockJson, path.join(stagingRoot, 'source.lock.json'))
    || !exactPath(profilesPath, path.join(stagingRoot, 'profiles')))) {
    return { ok: false, message: 'capability_staged_evidence_path_invalid' };
  }
  if (!exactPath(claimedInstalledPath, expectedInstalledPath)) {
    return { ok: false, message: 'MCP installedPath does not match the install target.' };
  }
  if (!managedCapabilityPathIsSafe(globalRoot, installedPath)) {
    return { ok: false, message: 'MCP installedPath contains a linked parent or escapes the SoloMap data root.' };
  }
  const candidateParent = recoveredSwap ? serversRoot : operation ? path.dirname(String(operation.resultPath || resultFilePath)) : serversRoot;
  if (!realDirectoryInside(candidateParent, installedPath)) {
    return { ok: false, message: 'MCP installedPath is outside the authorized install candidate.' };
  }
  if (!realDirectoryInside(installedPath, packagePath)
    || fs.readdirSync(packagePath).length === 0) {
    return { ok: false, message: 'MCP managed package is missing or empty.' };
  }
  if (![solomapMcpJson, sourceLockJson].every((filePath) => realCapabilityEvidence(globalRoot, installedPath, resultFilePath, filePath))) {
    return { ok: false, message: 'MCP package is missing solomap.mcp.json or source.lock.json.' };
  }
  let mcpJson: any;
  try {
    mcpJson = readJsonObject(solomapMcpJson);
  } catch (error: any) {
    return { ok: false, message: `solomap.mcp.json is invalid: ${error.message}` };
  }
  let sourceLock: any;
  try { sourceLock = readJsonObject(sourceLockJson); }
  catch (error: any) { return { ok: false, message: `source.lock.json is invalid: ${error.message}` }; }
  if (mcpJson.id && capabilityIdentity(mcpJson.id) !== mcpId) {
    return { ok: false, message: 'MCP manifest id does not match the install target.' };
  }
  const server = mcpJson.server || result.server;
  const serverPaths = [server?.entry, server?.script, server?.module, ...(Array.isArray(server?.args) ? server.args : [])]
    .filter((value: unknown) => typeof value === 'string' && String(value).trim() && !String(value).startsWith('-'))
    .map((value: unknown) => {
      const resolved = path.isAbsolute(String(value)) ? path.resolve(String(value)) : path.resolve(packagePath, String(value));
      if (operation && (exactPath(resolved, finalInstalledPath) || pathInside(finalInstalledPath, resolved))) {
        return path.join(installedPath, path.relative(finalInstalledPath, resolved));
      }
      return resolved;
    });
  const localServer = serverPaths.some((filePath: string) => realFileInside(packagePath, filePath));
  const remoteServer = typeof server?.url === 'string' && /^https?:\/\/[^\s]+$/i.test(server.url);
  if (!server || (!localServer && !remoteServer)) {
    return { ok: false, message: 'MCP manifest does not reference an existing managed server entry or valid remote endpoint.' };
  }
  let source: Record<string, any>;
  try { source = await validatedOperationSource(globalRoot, operationId, sourceLock, packagePath); }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  const entry: SolomapMcpRegistryEntry = {
    id: mcpId,
    title: String(mcpJson.title || mcpJson.name || result.metadata?.name || mcpId),
    description: String(mcpJson.description || result.metadata?.description || ''),
    status: String(mcpJson.status || 'installed'),
    source,
    serverPath: path.relative(mcpRoot, finalInstalledPath).replace(/\\/g, '/'),
    configPath: '',
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
  if (fs.existsSync(profilesPath) && !realDirectoryInside(installedPath, profilesPath) && !realDirectoryInside(path.dirname(resultFilePath), profilesPath)) {
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
  if (operationId) await commitStagedCapabilityDirectory(globalRoot, operationId, 'mcp', mcpId, claimedInstalledPath,
    async () => { await completeCapabilityEntry(globalRoot, operationId, 'mcp', entry, files); });
  else await writeCapabilityEntries(globalRoot, 'mcp', nextConnectors.sort((a, b) => a.id.localeCompare(b.id)), registry.entryVersions, { [mcpId]: files });
  return { ok: true, message: `MCP 已安装：${mcpId}`, mcpId };
}

export async function setSolomapSkillEnabled(workspaceRoot: string, globalDataPath: string, skillId: string, enabled: boolean): Promise<{ ok: boolean; message: string; skillId?: string }> {
  try {
    await setCapabilityEnabled(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'skill', skillId, enabled);
    return { ok: true, message: enabled ? `已启用技能：${skillId}` : `已禁用技能：${skillId}`, skillId };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error), skillId }; }
}

export async function setSolomapMcpEnabled(workspaceRoot: string, globalDataPath: string, mcpId: string, enabled: boolean): Promise<{ ok: boolean; message: string; mcpId?: string }> {
  try {
    await setCapabilityEnabled(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'mcp', mcpId, enabled);
    return { ok: true, message: enabled ? `已启用 MCP：${mcpId}` : `已禁用 MCP：${mcpId}`, mcpId };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error), mcpId }; }
}

export function buildSoloMapSystemMemoryPrompt(_workspaceRoot: string, _globalDataPath = ''): string {
  return buildAgentDatabaseInstructions();
}

import { RuntimeDataRequest, sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { DataWrite, UnifiedDataStore } from './db/unifiedDataStore';
import type { UnifiedMcpSource } from './unifiedMcp';
import * as crypto from 'crypto';
import type { DataObject, ContentPublicationCommit, WriteReceipt } from './db/unifiedDataStore';
import { agentReadableObject as agentObject, canAgentDiscover, canAgentRead, normalizeObjectReference } from './dataAuthorization.js';
import { snapshotDataWrite } from './db/dataWritePublication.js';
import { McpMutationAuthorizationChanged, type McpMutationIntent, type McpMutationAuthorizationHandle } from './db/mcpMutationAuthorization.js';
import { DatabaseMigrationCoordinator } from './databaseMigrationCoordinator';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { RunInputMaterialization } from './runInputMaterialization';
import { configureAgentDatabase, databaseAgentProviders, DatabaseAgentProvider, isAgentDatabaseConfigPath, retireManagedCodexBaseConfig } from './agentDatabaseConfig';
import { MigrationProjectScope, MigrationRecycling } from './migrationRecycling';
import { RecyclingProjectScopePending, recyclingProjectScopeOperations } from './db/recyclingProjectScopeProof.js';
import { initializeProjectJournalAllocation } from './projectDataMigration';
import { enqueueAvailableDataMigrations } from './runtimeDatabaseBootstrap';
import { validateTaskReport } from './taskReport';
import { RunRecovery } from './runRecovery';
import { RunNativeObserver } from './runNativeObserver';
import { snapshotWorkspace, captureRunGitEvidence, readWorkspaceGitHead, RunGitEvidence, WorkspaceSnapshot } from './runWorkspace';
import { RunStop } from './runStop';
import { executeTelegramExtensionCommand } from './telegramExtensionBridge';
import { persistTelegramRuntimeSecret } from './telegramRuntimeConfig';
import { migrationRunKinds, soloConversationRunKinds } from './runLifecycleTypes';
import { projectSignalProjects, readProjectSignals } from './projectSignalsRead';
import { closeProjectIssue, closeProjectPullRequest, createProjectIssue, loadExternalDeliverySummary, loadExternalIssueSummary, loadExternalPullRequestSummary, loadExternalSecuritySummary, readCachedIssueDetails, readProjectIssueDetails, resolveGithubRepoSlug } from './projectExternalSignals';
import { createInteractionBudgetAt } from './interactionBudget';
import { createLocalDiagnosticTrace, withLocalDiagnosticTrace } from './localDiagnostics';
import { createPreSessionGitCommit, retainPreSessionGitCommit } from './preSessionGit';
import { moveUntrackedFilesToRollbackSafety } from './rollbackSafety';
import { buildAgentImpactSummaryFromProjectRuns, readRunsFromRunIndexEntries, type AgentImpactProject, type AgentImpactRun } from './agentImpact';
import type { AgentRunPreparationInput } from './agentRunPreparation.js';
import type { AgentLaunchOptions } from './db/agentLaunchPublication.js';
import { todayRoadmapSnapshotRevision } from './todayDecisionInputs.js';
import { signLearningDelivery, verifyLearningDelivery } from './learningDelivery.js';
import { continueRuntimeWork, readRuntimeWorkContinuation, RuntimeExecutionScheduler } from './runtimePriorityScheduler.js';

const PROJECT_RUN_INDEX_PAGE_SIZE = 200;

export interface RuntimeDataOperations {
  (request: RuntimeDataRequest): Promise<unknown>;
  setStorageMaintenanceBarrier(barrier: Promise<unknown>): void;
  recoverMigrations(): void;
  recoverRuns(): void;
  interruptMigrations(): void;
  interruptRuns(): void;
  waitForMigrations(): Promise<void>;
  quiesceForDatabaseGeneration(): Promise<void>;
  close(): Promise<void>;
  setIntelligenceRuntime(runtime: IntelligenceRuntimeActions): void;
}

export interface IntelligenceRuntimeActions {
  mode(): { mode: 'legacy' | 'harness' };
  admit(input: Record<string, unknown>): Promise<unknown>;
  send(input: Record<string, unknown>): Promise<unknown>;
  run(operationId: string): Promise<unknown>;
  cancel(input: Record<string, unknown>): Promise<unknown>;
  recover(): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpRunIdentity { executionLogId: number; generation: number; proof: string }
type MigrationRunKind = typeof migrationRunKinds[number];

function executeExternal(command: string, args: string[], options: { cwd?: string; maxBuffer?: number; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, {
    cwd: options.cwd, encoding: 'utf8', maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    timeout: options.timeout || 10_000
  }, (error: Error | null, stdout: string) => error ? reject(error) : resolve(String(stdout))));
}

function validGitRoot(value: unknown): string {
  const root = String(value || '');
  if (!path.isAbsolute(root)) throw new Error('invalid_git_root');
  return root;
}

export interface ProjectSourceBranch {
  name: string;
  current: boolean;
}

export interface ProjectSourceSnapshot {
  available: boolean;
  currentBranch: string;
  detachedHead: string;
  branches: ProjectSourceBranch[];
  changedFiles: number;
  upstream: string;
  ahead: number;
  behind: number;
  statusLoaded: boolean;
  statusError: boolean;
  truncated: boolean;
  unavailableReason: '' | 'not_repository' | 'read_error';
}

export interface ProjectSourceStatus {
  changedFiles: number;
  upstream: string;
  ahead: number;
  behind: number;
  statusLoaded: boolean;
  statusError: boolean;
}

export type ProjectSourceGitRunner = (root: string, args: string[]) => Promise<string>;

const runProjectSourceGit: ProjectSourceGitRunner = (root, args) => executeExternal('git', args, {
  cwd: validGitRoot(root), timeout: 5_000, maxBuffer: 2 * 1024 * 1024
});

export async function readProjectSourceSnapshot(
  rootValue: unknown,
  runGit: ProjectSourceGitRunner = runProjectSourceGit
): Promise<ProjectSourceSnapshot> {
  const root = validGitRoot(rootValue);
  const unavailable = (unavailableReason: 'not_repository' | 'read_error'): ProjectSourceSnapshot => ({
    available: false, currentBranch: '', detachedHead: '', branches: [], changedFiles: 0,
    upstream: '', ahead: 0, behind: 0, statusLoaded: false, statusError: false, truncated: false, unavailableReason
  });
  try {
    if ((await runGit(root, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return unavailable('not_repository');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unavailable(/not a git repository|not a work tree/i.test(detail) ? 'not_repository' : 'read_error');
  }
  let currentBranch = '';
  let detachedHead = '';
  try { currentBranch = (await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim(); }
  catch {
    try { detachedHead = (await runGit(root, ['rev-parse', '--short', 'HEAD'])).trim(); } catch {}
  }
  let branchOutput = '';
  try {
    branchOutput = await runGit(root, ['for-each-ref', '--count=201', '--sort=-committerdate', '--format=%(refname:short)%00%(HEAD)', 'refs/heads']);
  } catch {
    return unavailable('read_error');
  }
  const allBranches = branchOutput.split(/\r?\n/).filter(Boolean).map(line => {
    const [name = '', marker = ''] = line.split('\0');
    return { name, current: marker.trim() === '*' || Boolean(currentBranch && name === currentBranch) };
  }).filter(branch => branch.name);
  const branchLimit = 200;
  const branches = allBranches.slice(0, branchLimit);
  if (currentBranch && !branches.some(branch => branch.name === currentBranch)) {
    if (branches.length >= branchLimit) branches[branchLimit - 1] = { name: currentBranch, current: true };
    else branches.push({ name: currentBranch, current: true });
  }
  return { available: true, currentBranch, detachedHead, branches, changedFiles: 0,
    upstream: '', ahead: 0, behind: 0, statusLoaded: false, statusError: false,
    truncated: allBranches.length > branchLimit, unavailableReason: '' };
}

export async function readProjectSourceStatus(
  rootValue: unknown,
  runGit: ProjectSourceGitRunner = runProjectSourceGit
): Promise<ProjectSourceStatus> {
  const root = validGitRoot(rootValue);
  let changedFiles = 0;
  let statusLoaded = false;
  try {
    changedFiles = (await runGit(root, ['status', '--porcelain=v1'])).split(/\r?\n/).filter(Boolean).length;
    statusLoaded = true;
  } catch {
    return { changedFiles: 0, upstream: '', ahead: 0, behind: 0, statusLoaded: false, statusError: true };
  }
  let upstream = '';
  let ahead = 0;
  let behind = 0;
  try {
    upstream = (await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim();
    const counts = (await runGit(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).trim().split(/\s+/).map(Number);
    behind = Number.isFinite(counts[0]) ? counts[0] : 0;
    ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
  } catch {}
  return { changedFiles, upstream, ahead, behind, statusLoaded: true, statusError: false };
}

export async function confirmProjectSourceMutation(
  targetBranch: string,
  errorCode: string,
  readSnapshot: () => Promise<ProjectSourceSnapshot>
): Promise<{ success: boolean; recovered: boolean; snapshot?: ProjectSourceSnapshot }> {
  try {
    const snapshot = await readSnapshot();
    return {
      success: errorCode === 'action_failed' && snapshot.available && snapshot.currentBranch === targetBranch,
      recovered: errorCode === 'action_failed' && snapshot.available && snapshot.currentBranch === targetBranch,
      snapshot
    };
  } catch {
    return { success: false, recovered: false };
  }
}

export function projectSourceMutationSettledError(errorCode: string, success: boolean): string {
  if (success) return '';
  return errorCode === 'action_failed' ? 'result_unknown' : errorCode;
}

async function validateProjectSourceBranch(root: string, branchValue: unknown, runGit: ProjectSourceGitRunner): Promise<string> {
  const branch = String(branchValue || '').trim();
  if (!branch || branch.length > 200 || /[\r\n\0]/.test(branch)) throw new Error('invalid_source_branch');
  try { await runGit(root, ['check-ref-format', '--branch', branch]); }
  catch { throw new Error('invalid_source_branch'); }
  return branch;
}

export async function createProjectBranch(
  rootValue: unknown,
  branchValue: unknown,
  runGit: ProjectSourceGitRunner = runProjectSourceGit
): Promise<ProjectSourceSnapshot> {
  const root = validGitRoot(rootValue);
  const branch = await validateProjectSourceBranch(root, branchValue, runGit);
  await runGit(root, ['switch', '-c', branch]);
  const snapshot = await readProjectSourceSnapshot(root, runGit);
  if (!snapshot.available || snapshot.currentBranch !== branch) throw new Error('source_mutation_unconfirmed');
  return snapshot;
}

export async function switchProjectBranch(
  rootValue: unknown,
  branchValue: unknown,
  runGit: ProjectSourceGitRunner = runProjectSourceGit
): Promise<ProjectSourceSnapshot> {
  const root = validGitRoot(rootValue);
  const branch = await validateProjectSourceBranch(root, branchValue, runGit);
  await runGit(root, ['switch', branch]);
  const snapshot = await readProjectSourceSnapshot(root, runGit);
  if (!snapshot.available || snapshot.currentBranch !== branch) throw new Error('source_mutation_unconfirmed');
  return snapshot;
}

async function inspectReportGitState(input: Record<string, unknown>): Promise<{ versions: string[]; history: boolean[] }> {
  const root = validGitRoot(input.root);
  const versions = Array.isArray(input.versions) ? input.versions as Array<{ sha?: unknown; files?: unknown }> : [];
  const history = Array.isArray(input.history) ? input.history as Array<{ sha?: unknown; file?: unknown }> : [];
  if (versions.length > 1000 || history.length > 5000) throw new Error('git_inspection_limit');
  const versionStates: string[] = [];
  for (const item of versions) {
    const sha = String(item.sha || ''), files = Array.isArray(item.files) ? item.files.map(String) : [];
    if (!/^[a-f0-9]{40}$/.test(sha) || !files.length || files.length > 500 || files.some(file => !file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))) {
      versionStates.push('unknown'); continue;
    }
    try {
      await executeExternal('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root });
      const changed = await executeExternal('git', ['diff', '--name-only', sha, '--', ...files], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
      versionStates.push(changed.trim() ? 'stale' : 'current');
    } catch { versionStates.push('unknown'); }
  }
  const historyStates: boolean[] = [];
  for (const item of history) {
    const sha = String(item.sha || ''), file = String(item.file || '');
    if (!/^[a-f0-9]{40}$/.test(sha) || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) { historyStates.push(false); continue; }
    try {
      await executeExternal('git', ['cat-file', '-e', `${sha}:${file}`], { cwd: root });
      await executeExternal('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: root });
      const discontinuity = await executeExternal('git', ['log', '--format=%H', '--diff-filter=DR', `${sha}..HEAD`, '--', file], { cwd: root });
      historyStates.push(!discontinuity.trim());
    } catch { historyStates.push(false); }
  }
  return { versions: versionStates, history: historyStates };
}

async function readProjectGrowthGitFacts(input: Record<string, unknown>): Promise<{ head: string; churn: Array<[string, number]> }> {
  const root = validGitRoot(input.root);
  let head = '';
  try { head = (await executeExternal('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 2_000 })).trim(); } catch {}
  const churn = new Map<string, number>();
  try {
    const output = await executeExternal('git', ['log', '--name-only', '--pretty=format:', '--since=90 days'], { cwd: root, timeout: 3_000, maxBuffer: 4 * 1024 * 1024 });
    for (const line of output.split(/\r?\n/)) {
      const file = line.trim().replace(/\\/g, '/');
      if (!file || file.startsWith('/') || file.split('/').includes('..')) continue;
      churn.set(file, (churn.get(file) || 0) + 1);
    }
  } catch {}
  return { head, churn: [...churn.entries()] };
}

async function compareGitFileVersion(input: Record<string, unknown>): Promise<{ sameVersion: boolean }> {
  const root = validGitRoot(input.root), sha = String(input.sha || ''), file = String(input.file || '');
  if (!/^[a-f0-9]{40}$/.test(sha) || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return { sameVersion: false };
  const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { sameVersion: false };
  try {
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return { sameVersion: false };
    const [original, current] = await Promise.all([
      new Promise<Buffer>((resolve, reject) => execFile('git', ['show', `${sha}:${file}`], { cwd: root, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
        (error, stdout) => error ? reject(error) : resolve(Buffer.from(stdout)))),
      fs.promises.readFile(absolute)
    ]);
    return { sameVersion: Buffer.compare(original, current) === 0 };
  } catch { return { sameVersion: false }; }
}

async function readGithubApiInWorker(input: Record<string, unknown>): Promise<unknown> {
  const endpoint = String(input.endpoint || '');
  if (!endpoint || endpoint.length > 4096 || !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(endpoint)) throw new Error('github_endpoint_invalid');
  let output: string;
  try { output = await executeExternal('gh', ['api', '--method', 'GET', endpoint], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }); }
  catch { throw new Error(`GitHub read unavailable: ${endpoint.split('?')[0]}`); }
  try { return JSON.parse(output); } catch { throw new Error('GitHub returned invalid JSON'); }
}

export interface RuntimeWorkspaceCompute {
  snapshot(root: string): Promise<WorkspaceSnapshot>;
  gitHead(root: string): Promise<string>;
  gitEvidence(root: string, baseGitHash: string, workspace?: WorkspaceSnapshot): Promise<RunGitEvidence>;
}

export interface RuntimeSupervisorActions {
  executeTelegramEditorCommand(command: string, args: string[]): Promise<unknown>;
}

export interface RuntimeDataOperationObserver {
  phase(phase: string): void;
}

export function createRuntimeDataOperations(store: UnifiedDataStore, workspaceCompute: RuntimeWorkspaceCompute = {
  snapshot: snapshotWorkspace,
  gitHead: readWorkspaceGitHead,
  gitEvidence: captureRunGitEvidence
}, readAuthoritySecret?: string, supervisor: RuntimeSupervisorActions = {
  executeTelegramEditorCommand: (command, args) => executeTelegramExtensionCommand(store.root, command, args)
}, observer?: RuntimeDataOperationObserver, databaseGenerationExecutor?: (request: RuntimeDataRequest) => Promise<unknown>, execution: {storageContinuations?:boolean;wakeStorageMaintenance?:()=>void} = {}): RuntimeDataOperations {
  const migrations = new DatabaseMigrationCoordinator(store);
  const recycling = new MigrationRecycling(store,root=>store.recyclingProjectScopes(root));
  const runStops = new RunStop(store, workspaceCompute);
  const runs = new RunRecovery(store, runStops, undefined, workspaceCompute);
  const runInputs = new RunInputMaterialization(store);
  let storageMaintenanceTail: Promise<void> = Promise.resolve();
  const recyclingScopeFlights = new Set<Promise<void>>();
  let recyclingScopeRevision=0;
  let storageMaintenanceBarrier: Promise<unknown> = Promise.resolve();
  let standaloneStorageScheduler: RuntimeExecutionScheduler | undefined;
  let intelligenceRuntime: IntelligenceRuntimeActions | undefined;
  type ProjectSession = { kind: 'project'; actorId: string; scope: string; intelligenceOperationId?: string; runIdentity?: McpRunIdentity; reviewBatchId?: string; migrationKind?: MigrationRunKind; migrationTargetId?: string | null; migrationProjectRoot?: string | null; migrationProjectId?: string | null; migrationPhysicalRoot?: string | null };
  type McpSessionResponse = { actorId: string; proof: string; authorityActorId: string; sessionToken: string; readAuthority: string; runKind: string; migrationKind: MigrationRunKind | null };
  const sessions = new Map<string, ProjectSession>();
  const deliverySecret = readAuthoritySecret || crypto.randomBytes(32).toString('base64url');
  const openSessions = new Map<string, { intent: string; response: McpSessionResponse }>();
  const signReadAuthority = (sessionToken: string, session: ProjectSession): string => {
    if (!readAuthoritySecret) return '';
    const encoded = Buffer.from(JSON.stringify({ schemaVersion: 1, sessionToken, session }), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', readAuthoritySecret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  };
  const verifyReadAuthority = (request: RuntimeDataRequest): ProjectSession | undefined => {
    if (!request.readAuthority) return undefined;
    if (!readAuthoritySecret || !request.sessionToken) throw new Error('mcp_read_authority_invalid');
    const [encoded, signature, extra] = request.readAuthority.split('.');
    if (!encoded || !signature || extra !== undefined) throw new Error('mcp_read_authority_invalid');
    const expected = crypto.createHmac('sha256', readAuthoritySecret).update(encoded).digest();
    let received: Buffer;
    try { received = Buffer.from(signature, 'base64url'); } catch { throw new Error('mcp_read_authority_invalid'); }
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) throw new Error('mcp_read_authority_invalid');
    let payload: { schemaVersion?: number; sessionToken?: string; session?: ProjectSession };
    try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new Error('mcp_read_authority_invalid'); }
    const session = payload.session;
    if (payload.schemaVersion !== 1 || payload.sessionToken !== request.sessionToken || !session
      || session.kind !== 'project' || !session.actorId || !session.scope) throw new Error('mcp_read_authority_invalid');
    return session;
  };
  const samePhysicalRoot = (left: string, right: string): boolean => {
    try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return path.resolve(left) === path.resolve(right); }
  };
  const migrationScope = async (input: Record<string, unknown>): Promise<MigrationProjectScope | undefined> => {
    if (input.projectRoot === undefined) return undefined;
    const requested = String(input.projectRoot || '');
    if (!path.isAbsolute(requested)) throw new Error('project_scope_required');
    const registered = store.existingRegisteredProjectScopes().find(candidate => samePhysicalRoot(candidate.root, requested));
    if (!registered) throw new Error('project_scope_denied');
    let physicalRoot: string;
    try { physicalRoot = fs.realpathSync(registered.root); } catch { throw new Error('project_scope_denied'); }
    return { root: path.resolve(registered.root), projectId: registered.projectId, physicalRoot };
  };
  const allowedRead = (object: DataObject, session: ProjectSession): boolean => canAgentRead(object, session.scope, session.reviewBatchId, store.learningReviewScopeCurrent(object));
  const normalizeMcpMutation = (request: RuntimeDataRequest): RuntimeDataRequest => {
    const input = request.input;
    if (request.operation === 'write') {
      if (input.kind === 'lesson' && input.action === 'patch') return { ...request,
        input: { ...input, data: { external_updated_at: null, ...(input.data as Record<string, unknown>), semantic_review_json: null,
          ...(Object.prototype.hasOwnProperty.call(input.data, 'confidence') ? { external_confidence: null } : {}) } } };
      if (input.kind === 'learning_event' && input.action === 'patch') return { ...request,
        input: { ...input, data: { ...(input.data as Record<string, unknown>), verification_signal: 0 } } };
      return request;
    }
    return request;
  };
  const publishRuntimeMutation = async (request: RuntimeDataRequest, fenced=false): Promise<unknown> => {
    const snapshot={...request,input:snapshotDataWrite(request.input),...(request.piToolFence?{piToolFence:{...request.piToolFence}}:{})},session=request.sessionToken?sessions.get(request.sessionToken):undefined;
    if(snapshot.sessionToken && (!session || session.kind!=='project'))throw new Error('invalid_session');
    const fence=snapshot.piToolFence;
    const owner=fence?{ownerId:fence.ownerId,generation:fence.ownerGeneration}:undefined;
    const authorize=()=>{if(session && session.kind==='project'){store.authorizeMcpAction(session.actorId,session.scope,snapshot.operation);if(session.runIdentity)store.authorizedLearningReviewBatch(session.scope,session.runIdentity);}};
    const action=async()=>{for(;;){
      let authorization:McpMutationAuthorizationHandle|undefined;
      let publishing=false;
      try{
        authorize();
        if(session && session.kind==='project')authorization=await store.stageMcpMutationAuthorization({operation:snapshot.operation,input:snapshot.input} as unknown as McpMutationIntent,session.scope,session.reviewBatchId);
        const applied=session?normalizeMcpMutation(snapshot):snapshot;
        if(fenced && fence && owner)store.assertPiToolInvocationActive(fence.operationId,fence.invocationId,owner);
        const guarded=(commit:()=>WriteReceipt):WriteReceipt=>{
          const checked=()=>{
            authorization?.check();authorize();publishing=true;
            const receipt=commit();
            if(receipt===undefined)publishing=false;
            return receipt;
          };
          return fenced && fence && owner?store.withPiToolInvocationFenceSync(fence.operationId,fence.invocationId,owner,checked):checked();
        };
        const publish=()=>applied.operation==='link'?store.publishLink(applied.input as unknown as Parameters<UnifiedDataStore['publishLink']>[0],guarded,true):store.publishWrite(applied.input as unknown as DataWrite,guarded,true);
        return await publish();
      }catch(error){
        if(publishing)throw error;
        if(error instanceof McpMutationAuthorizationChanged)continue;
        try{authorization?.check();}catch(changed){if(changed instanceof McpMutationAuthorizationChanged)continue;throw changed;}
        throw error;
      }finally{await authorization?.release();}
    }};
    const publish=()=>store.withMutationPublication({operation:snapshot.operation,input:snapshot.input} as unknown as McpMutationIntent,action);
    return session?store.withActor(session.actorId,publish):publish();
  };
  const runProject = async (input: Record<string, unknown>): Promise<{ projectId: string }> => {
    if (input.projectId) {
      const projectId = String(input.projectId);
      if (store.readMetadata(projectId).kind !== 'project') throw new Error('project_scope_required');
      return { projectId };
    }
    return store.registerProject({ root: String(input.root || '') });
  };
  const readProject = async (input: Record<string, unknown>): Promise<{ projectId: string } | null> => {
    if (input.projectId) {
      const projectId = String(input.projectId);
      if (store.readMetadata(projectId).kind !== 'project') throw new Error('project_scope_required');
      return { projectId };
    }
    const projectId = store.lookupProjectForRead(String(input.root || ''));
    return projectId ? { projectId } : null;
  };
  const withRoadmapBackup = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if ((input.metadata as Record<string, unknown> | undefined)?.captureRoadmapBackup !== true) return input;
    try {
      const bytes = await fs.promises.readFile(path.join(String(input.root), '.solopreneur', 'roadmap.csv'));
      return { ...input, roadmapBackup: bytes.toString('base64') };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return input; throw error; }
  };
  const publicationCommit = (request: RuntimeDataRequest): ContentPublicationCommit => {
    const fence=request.piToolFence?{...request.piToolFence}:undefined;
    return publish=>fence?store.withPiToolInvocationFenceSync(fence.operationId,fence.invocationId,
      {ownerId:fence.ownerId,generation:fence.ownerGeneration},publish):publish();
  };
  const maintainDatabaseStorage = (compact: boolean, automatic: boolean,commit:ContentPublicationCommit=publish=>publish()) => {
    if (compact) return Promise.reject(new Error('runtime_online_compaction_retired'));
    const previous=storageMaintenanceTail;
    let resolveDone!:()=>void,rejectDone!:(error:unknown)=>void;
    const done=new Promise<void>((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
    storageMaintenanceTail=done.catch(()=>undefined);
    const dependency=Promise.all([previous,storageMaintenanceBarrier]).catch(error=>{rejectDone(error);throw error;});
    const generator=(async function*(){
      const currentSize = store.databaseStorageFileSizes();
      for(;;){const recovery=store.recoverInterruptedDatabaseStorageMaintenanceBatch(128);if(!recovery.pending)break;yield undefined;}
      let projectPage=await store.projectRetirementPage('');
      while(!projectPage.projects.length && !projectPage.complete){yield undefined;projectPage=await store.projectRetirementPage(projectPage.cursor);}
      if (automatic && !store.hasPendingAutomaticDatabaseStorageCleanup() && !projectPage.projects.length) return { skipped: true, reason: 'storage_current' };
      const startedAt = Date.now(), before = currentSize;
      const totals = { deletedArtifacts: 0, deletedSources: 0, deletedContents: 0, reclaimedStoredBytes: 0 };
      const maintenanceId = store.beginDatabaseStorageMaintenance(startedAt, before.databaseBytes, true);
      try {
        let retiredTestProjects=0;
        for(;;){
          for(const project of projectPage.projects)for(;;){
            const attempt=await store.retireStaleProjectRegistration(project,commit);retiredTestProjects+=attempt.retired;
            yield undefined;if(!attempt.retry)break;
          }
          if(projectPage.complete)break;
          yield undefined;projectPage=await store.projectRetirementPage(projectPage.cursor);
        }
        for (;;) {
          const batch = await store.maintainStorageByproductsQuantum(128,commit,!automatic || store.usesStorageContentLifecycle(),maintenanceId);
          totals.deletedArtifacts += batch.deletedArtifacts; totals.deletedSources += batch.deletedSources;
          yield undefined;
          if (!batch.pending) break;
        }
        while(store.hasDatabaseStorageCleanupCandidates()){
          commit(()=>store.finalizeDatabaseStorageCleanupBatch(128,maintenanceId));
          yield undefined;
        }
        let lifecyclePending=false;
        if(store.usesStorageContentLifecycle())for(;;){
          const quantum=await store.maintainStorageLifecycleQuantum(128,commit,counts=>{
            totals.deletedArtifacts+=counts.deletedArtifacts || 0;totals.deletedSources+=counts.deletedSources || 0;
            totals.deletedContents+=counts.deletedContents || 0;totals.reclaimedStoredBytes+=counts.reclaimedStoredBytes || 0;
          },maintenanceId);
          lifecyclePending=quantum.pending;
          if(!quantum.pending || !quantum.runnable)break;
          yield undefined;
        }
        const integrity = 'not_checked';
        const after = store.databaseStorageFileSizes(); const finishedAt = Date.now();
        store.settleDatabaseStorageMaintenance(maintenanceId, { status: 'completed', finishedAt, ...totals, compacted: compact, afterBytes: after.databaseBytes, integrity });
        return { ...totals, retiredTestProjects, compacted: compact, integrity, beforeBytes: before.databaseBytes, afterBytes: after.databaseBytes, pendingByproductRecords: store.pendingDatabaseStorageCleanupRecords(),pending:lifecyclePending };
      } catch (error) {
        try{
          const after = store.databaseStorageFileSizes();
          store.settleDatabaseStorageMaintenance(maintenanceId, { status: 'failed', finishedAt: Date.now(), error: String(error), ...totals, compacted: false, afterBytes: after.databaseBytes, integrity: 'not_checked' });
        }catch(settlementError){process.stderr.write(`SoloMap storage audit settlement pending (${maintenanceId}): ${String(settlementError)}\n`);}
        throw error;
      } finally {
        store.releaseDatabaseStorageMaintenance(maintenanceId);
      }
    })();
    const advance=async():Promise<unknown>=>{
      try{commit(()=>undefined);const piece=await generator.next();commit(()=>undefined);if(piece.done){resolveDone();return piece.value;}return continueRuntimeWork(advance);}
      catch(error){try{await generator.throw(error);}catch{/* Close the suspended generator's original audit/finally without replacing the root error. */}rejectDone(error);throw error;}
    };
    const initial=continueRuntimeWork(advance,dependency);
    if(execution.storageContinuations)return Promise.resolve(initial);
    standaloneStorageScheduler ||= new RuntimeExecutionScheduler();
    return standaloneStorageScheduler.submit('maintenance',async()=>initial,{label:'standalone:maintain_database_storage'});
  };
  const afterStorageMaintenance=(request:RuntimeDataRequest):unknown=>{
    let tail=storageMaintenanceTail,scopeRevision=recyclingScopeRevision;
    let dependency=Promise.all([tail,...recyclingScopeFlights]);
    const begin=async():Promise<unknown>=>{
      if(storageMaintenanceTail!==tail || recyclingScopeRevision!==scopeRevision){
        tail=storageMaintenanceTail;scopeRevision=recyclingScopeRevision;
        dependency=Promise.all([tail,...recyclingScopeFlights]);return continueRuntimeWork(begin,dependency);
      }
      return databaseGenerationExecutor!(request);
    };
    return continueRuntimeWork(begin,dependency);
  };
  const wakeStorageMaintenance=():void=>{
    if(execution.storageContinuations){execution.wakeStorageMaintenance?.();return;}
    void maintainDatabaseStorage(false,true).catch(()=>undefined);
  };
  const dispatch = async (request: RuntimeDataRequest, authenticatedSession?: ProjectSession): Promise<unknown> => {
    if (!request || typeof request.operation !== 'string' || !request.input || typeof request.input !== 'object') throw new Error('invalid_data_request');
    const input = request.input;
    switch (request.operation) {
      case 'install_runtime_secret': persistTelegramRuntimeSecret(store.root, String(input.secretRef || ''), String(input.value || '')); return { installed: true };
      case 'accept_roadmap_csv': return store.acceptRoadmapCsv(input as unknown as Parameters<UnifiedDataStore['acceptRoadmapCsv']>[0]);
      case 'read_roadmap': {
        const project = await readProject(input);
        if (!project) throw new Error('roadmap_import_required');
        return store.readRoadmapByProject(project.projectId);
      }
      case 'read_today_roadmaps': {
        if (!Array.isArray(input.roots) || input.roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('invalid_today_roadmap_query');
        const offset = Math.max(0, Number(input.offset || 0));
        const limit = Math.max(1, Math.min(20, Number(input.limit || 20)));
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit)) throw new Error('invalid_today_roadmap_query');
        const roots = input.roots.slice(offset, offset + limit);
        const items = await Promise.all(roots.map(async rawRoot => {
          const root = String(rawRoot);
          try {
            const project = await readProject({ root });
            if (!project) return { root, revision: '' };
            return { root, revision: store.readTodayRoadmapRevision(project.projectId) };
          } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (error instanceof Error && error.message === 'roadmap_import_required') return { root, revision: '', unavailable: true };
            if (code === 'ENOENT' || (error instanceof Error && (error.message.startsWith('roadmap_csv_invalid:') || /\bENOENT\b/.test(error.message)))) return { root, revision: '' };
            throw error;
          }
        }));
        return { items, ...(offset === 0 ? { learningRevision: store.readTodayLearningRevision(input.roots.map(String)) } : {}), nextOffset: offset + items.length < input.roots.length ? offset + items.length : null };
      }
      case 'read_shadow_decision_inputs': {
        if (!Array.isArray(input.roots) || input.roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('invalid_shadow_decision_query');
        const offset = Math.max(0, Number(input.offset || 0));
        const limit = Math.max(1, Math.min(20, Number(input.limit || 20)));
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit)) throw new Error('invalid_shadow_decision_query');
        const roots = input.roots.slice(offset, offset + limit);
        const items: Array<{ root: string; nodes: unknown[]; revision?: string; unavailable?: boolean; invalid?: boolean }> = [];
        for (const rawRoot of roots) {
          const root = String(rawRoot);
          try {
            const project = await readProject({ root });
            if (!project) {
              items.push({ root, nodes: [], unavailable: true });
              continue;
            }
            const snapshot = store.readRoadmapByProject(project.projectId);
            items.push({ root, nodes: snapshot.nodes, revision: todayRoadmapSnapshotRevision(snapshot) });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (error instanceof Error && error.message === 'roadmap_import_required') {
              items.push({ root, nodes: [], unavailable: true });
              continue;
            }
            if (code === 'ENOENT' || (error instanceof Error && (error.message.startsWith('roadmap_csv_invalid:') || /\bENOENT\b/.test(error.message)))) {
              items.push({ root, nodes: [], invalid: true });
              continue;
            }
            throw error;
          }
        }
        return { items, ...(offset === 0 ? { learning: store.readTodayLearningInputs(input.roots.map(String)) } : {}), nextOffset: offset + items.length < input.roots.length ? offset + items.length : null };
      }
      case 'update_roadmap': return store.updateRoadmap(input as unknown as Parameters<UnifiedDataStore['updateRoadmap']>[0]);
      case 'resolve_roadmap_conflict': return store.resolveRoadmapConflict(input as unknown as Parameters<UnifiedDataStore['resolveRoadmapConflict']>[0]);
      case 'open_mcp_session': {
        const scope = String(input.projectId || '');
        const openRequestId = String(input.openRequestId || '');
        if (openRequestId && (openRequestId.length < 16 || openRequestId.length > 128)) throw new Error('invalid_mcp_open_request');
        const openIntent = JSON.stringify({ scope, runIdentity: input.runIdentity || null, resume: input.resume || null, intelligenceOperationId: input.intelligenceOperationId || null });
        const previous = openRequestId ? openSessions.get(openRequestId) : undefined;
        if (previous) {
          if (previous.intent !== openIntent) throw new Error('idempotency_conflict');
          return previous.response;
        }
        const runIdentity = input.runIdentity as McpRunIdentity | undefined;
        const authorizedRun = runIdentity ? (await store.readRunContextPublication(scope,runIdentity)).state : undefined;
        const runKind = String(authorizedRun?.status.runKind || '');
        const migrationKind = migrationRunKinds.includes(runKind as MigrationRunKind) ? runKind as MigrationRunKind : undefined;
        const migrationProjectRoot = migrationKind ? String(authorizedRun?.status.migrationProjectRoot || '') || null : null;
        const soloProjectRoot = soloConversationRunKinds.includes(runKind as typeof soloConversationRunKinds[number])
          ? String(authorizedRun?.status.workspaceRoot || '') || null
          : null;
        const migrationProject = migrationProjectRoot || soloProjectRoot
          ? await migrationScope({ projectRoot: migrationProjectRoot || soloProjectRoot })
          : undefined;
        if (migrationProject && migrationProject.projectId !== scope) throw new Error('maintenance_scope_denied');
        const reviewBatchId = runIdentity ? store.authorizedLearningReviewBatch(scope, runIdentity) : undefined;
        const identity = store.establishMcpActor(scope, input.resume as { actorId: string; proof: string } | undefined, openRequestId || undefined);
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const session: ProjectSession = { kind: 'project', actorId: identity.actorId, scope, runIdentity, reviewBatchId, migrationKind,
          intelligenceOperationId: String(input.intelligenceOperationId || '') || undefined,
          migrationTargetId: migrationKind ? String(authorizedRun?.status.migrationTargetId || '') || null : undefined,
          migrationProjectRoot: migrationProject?.root || null,
          migrationProjectId: migrationProject?.projectId || null,
          migrationPhysicalRoot: migrationProject?.physicalRoot || null };
        sessions.set(sessionToken, session);
        const response = { ...identity, sessionToken, readAuthority: signReadAuthority(sessionToken, session), runKind, migrationKind: migrationKind || null };
        if (openRequestId) openSessions.set(openRequestId, { intent: openIntent, response });
        return response;
      }
      case 'close_mcp_session': {
        const token = String(input.sessionToken || '');
        const session = sessions.get(token);
        if (session?.kind === 'project') store.closeMcpActor(session.actorId, session.scope);
        sessions.delete(token);
        for (const [requestId, opened] of openSessions) if (opened.response.sessionToken === token) openSessions.delete(requestId);
        return { closed: true };
      }
      case 'register_project': return store.registerProject(input as unknown as Parameters<UnifiedDataStore['registerProject']>[0]);
      case 'read_capability_registry': return store.readCapabilityRegistry(input as unknown as Parameters<UnifiedDataStore['readCapabilityRegistry']>[0]);
      case 'patch_capability_registry': return store.patchCapabilityRegistry(input as unknown as Parameters<UnifiedDataStore['patchCapabilityRegistry']>[0]);
      case 'begin_capability_operation': return store.beginCapabilityOperation(input as unknown as Parameters<UnifiedDataStore['beginCapabilityOperation']>[0]);
      case 'attach_capability_operation': return store.attachCapabilityOperation(input as unknown as Parameters<UnifiedDataStore['attachCapabilityOperation']>[0]);
      case 'read_capability_operations': return store.readCapabilityOperations(input as unknown as Parameters<UnifiedDataStore['readCapabilityOperations']>[0]);
      case 'read_capability_operation_run_state': return store.readCapabilityOperationRunState(input as unknown as Parameters<UnifiedDataStore['readCapabilityOperationRunState']>[0]);
      case 'read_capability_operation_result': return store.readCapabilityOperationResult(input as unknown as Parameters<UnifiedDataStore['readCapabilityOperationResult']>[0]);
      case 'fail_capability_operation': return store.failCapabilityOperation(input as unknown as Parameters<UnifiedDataStore['failCapabilityOperation']>[0]);
      case 'complete_capability_operation': return store.completeCapabilityOperation(input as unknown as Parameters<UnifiedDataStore['completeCapabilityOperation']>[0]);
      case 'read_capability_evidence': return store.readCapabilityEvidence(input as unknown as Parameters<UnifiedDataStore['readCapabilityEvidence']>[0]);
      case 'write_internal_attachment': {
        const project = await runProject(input);
        return store.writeInternalAttachment(project.projectId, input as unknown as Parameters<UnifiedDataStore['writeInternalAttachment']>[1]);
      }
      case 'read_internal_attachment': {
        const project = await readProject(input);
        if (!project) throw new Error('project_scope_required');
        return store.readInternalAttachment(project.projectId, input as unknown as Parameters<UnifiedDataStore['readInternalAttachment']>[1]);
      }
      case 'initialize_project_registry': return store.initializeProjectRegistry(input as Parameters<UnifiedDataStore['initializeProjectRegistry']>[0]);
      case 'read_project_registry': return store.readProjectRegistry(input as Parameters<UnifiedDataStore['readProjectRegistry']>[0]);
      case 'project_signals': return readProjectSignals(store, input);
      case 'resolve_project_repository': {
        const root = String(input.root || '');
        if (!path.isAbsolute(root)) throw new Error('invalid_project_repository');
        return { repo: await resolveGithubRepoSlug(root) };
      }
      case 'read_project_source_snapshot': return readProjectSourceSnapshot(input.root);
      case 'read_project_source_status': return readProjectSourceStatus(input.root);
      case 'create_project_branch': return createProjectBranch(input.root, input.branch);
      case 'switch_project_branch': return switchProjectBranch(input.root, input.branch);
      case 'compute_workspace_snapshot': return snapshotWorkspace(String(input.root || ''));
      case 'compute_workspace_git_head': return readWorkspaceGitHead(String(input.root || ''));
      case 'compute_workspace_git_evidence': return captureRunGitEvidence(
        String(input.root || ''), String(input.baseGitHash || ''), input.workspace as WorkspaceSnapshot | undefined);
      case 'capture_pre_session_git_snapshot': {
        const root = validGitRoot(input.root);
        const revision = String(input.revision || '');
        return { revision: revision ? await retainPreSessionGitCommit(root, revision) : await createPreSessionGitCommit(root) };
      }
      case 'read_git_file_at_revision': {
        const root = validGitRoot(input.root), revision = String(input.revision || ''), relativePath = String(input.relativePath || '').replace(/\\/g, '/');
        if (!/^[a-f0-9]{7,64}$/i.test(revision) || !relativePath || path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) throw new Error('invalid_git_file_revision');
        try { return { exists: true, content: await executeExternal('git', ['show', `${revision}:${relativePath}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 }) }; }
        catch { return { exists: false, content: '' }; }
      }
      case 'inspect_project_git_rollback': {
        const root = validGitRoot(input.root), revision = String(input.revision || '');
        if (!/^[a-f0-9]{7,64}$/i.test(revision)) throw new Error('invalid_git_rollback');
        await executeExternal('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
        const verifiedHash = (await executeExternal('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: root })).trim();
        const head = (await executeExternal('git', ['rev-parse', 'HEAD'], { cwd: root })).trim();
        let ancestor = false, retained = false;
        try { await executeExternal('git', ['merge-base', '--is-ancestor', verifiedHash, 'HEAD'], { cwd: root }); ancestor = true; } catch {}
        try { retained = (await executeExternal('git', ['rev-parse', '--verify', `refs/solomap/backups/${verifiedHash}`], { cwd: root })).trim() === verifiedHash; } catch {}
        return { verifiedHash, eligible: ancestor || retained || verifiedHash === head };
      }
      case 'execute_project_git_rollback': {
        const root = validGitRoot(input.root), revision = String(input.revision || '');
        const inspected = await dispatch({ operation: 'inspect_project_git_rollback', input: { root, revision } }) as { verifiedHash: string; eligible: boolean };
        if (!inspected.eligible) throw new Error('git_rollback_not_ancestor');
        const safetyDir = moveUntrackedFilesToRollbackSafety(root, store.root);
        await executeExternal('git', ['restore', '--source', inspected.verifiedHash, '--staged', '--worktree', '--', '.'], { cwd: root, timeout: 30_000 });
        return { verifiedHash: inspected.verifiedHash, safetyDir };
      }
      case 'inspect_report_git_state': return inspectReportGitState(input);
      case 'read_project_growth_git_facts': return readProjectGrowthGitFacts(input);
      case 'compare_git_file_version': return compareGitFileVersion(input);
      case 'read_github_api': return readGithubApiInWorker(input);
      case 'read_cached_project_issue_details': {
        const root = validGitRoot(input.root), repo = String(input.repo || '');
        return readCachedIssueDetails(root, Number(input.issueNumber || 0), store.root, repo);
      }
      case 'read_project_issue_details': {
        const root = validGitRoot(input.root), repo = String(input.repo || '');
        return readProjectIssueDetails(root, Number(input.issueNumber || 0), store.root, repo);
      }
      case 'create_project_issue': {
        const root = validGitRoot(input.root), repo = String(input.repo || '');
        return createProjectIssue(root, String(input.title || ''), String(input.body || ''), String(input.category || ''), String(input.priority || ''), repo);
      }
      case 'close_project_issue': {
        const root = validGitRoot(input.root), repo = String(input.repo || '');
        return closeProjectIssue(root, Number(input.issueNumber || 0), repo);
      }
      case 'close_project_pull_request': {
        const root = validGitRoot(input.root), repo = String(input.repo || '');
        return closeProjectPullRequest(root, Number(input.pullRequestNumber || 0), repo);
      }
      case 'refresh_project_signal': {
        const root = String(input.root || '');
        const kind = String(input.kind || '');
        if (!path.isAbsolute(root) || !['issues', 'pullRequests', 'delivery', 'security'].includes(kind)) throw new Error('invalid_project_signal_refresh');
        const repo = input.repo === null ? null : String(input.repo || '');
        if (repo === null) return { repo: null, value: null };
        if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return { repo: '', value: null };
        const options = { force: input.force === true, globalDataPath: store.root, resolvedRepo: repo };
        const value = kind === 'issues' ? await loadExternalIssueSummary(root, options)
          : kind === 'pullRequests' ? await loadExternalPullRequestSummary(root, options)
            : kind === 'delivery' ? await loadExternalDeliverySummary(root, options)
              : await loadExternalSecuritySummary(root, options);
        return { repo, value };
      }
      case 'resolve_project_signals_scope': {
        const { projects } = projectSignalProjects(store);
        const root = String(input.root || '');
        const selected = root ? projects.find(project => path.resolve(project.path) === path.resolve(root)) : projects.find(project => project.projectId);
        return { projectId: selected?.projectId || null };
      }
      case 'patch_project_registry': return store.publishProjectRegistryPatch(input as unknown as Parameters<UnifiedDataStore['publishProjectRegistryPatch']>[0],publicationCommit(request));
      case 'read_host_settings': return store.readHostSettings(input as unknown as Parameters<UnifiedDataStore['readHostSettings']>[0]);
      case 'patch_host_settings': return store.publishHostSettings(input as unknown as Parameters<UnifiedDataStore['publishHostSettings']>[0], publicationCommit(request));
      case 'migrate_host_secret_state': return store.publishHostSecretMigration(input as unknown as Parameters<UnifiedDataStore['publishHostSecretMigration']>[0],publicationCommit(request));
      case 'project_cognitive_runtime_config': return store.publishCognitiveRuntimeConfig(input as Parameters<UnifiedDataStore['projectCognitiveRuntimeConfig']>[0], publicationCommit(request));
      case 'read_project_autonomy_authorization': return store.readProjectAutonomyAuthorization(input as Parameters<UnifiedDataStore['readProjectAutonomyAuthorization']>[0]);
      case 'patch_project_autonomy_authorization': return store.publishProjectAutonomyAuthorization(input as unknown as Parameters<UnifiedDataStore['publishProjectAutonomyAuthorization']>[0],publicationCommit(request));
      case 'revoke_project_autonomy_authorizations': return store.publishProjectAutonomyRevocation(input as Parameters<UnifiedDataStore['publishProjectAutonomyRevocation']>[0],publicationCommit(request));
      case 'append_diagnostic_event': return store.publishDiagnosticEvent(input as unknown as Parameters<UnifiedDataStore['publishDiagnosticEvent']>[0], publicationCommit(request));
      case 'read_diagnostic_events': return store.readDiagnosticEvents(input as Parameters<UnifiedDataStore['readDiagnosticEvents']>[0]);
      case 'record_native_projection': return store.recordNativeProjection(input as Parameters<UnifiedDataStore['recordNativeProjection']>[0]);
      case 'is_recent_native_projection': return store.isRecentNativeProjection(input as Parameters<UnifiedDataStore['isRecentNativeProjection']>[0]);
      case 'consume_native_projection': return store.consumeNativeProjection(input as Parameters<UnifiedDataStore['consumeNativeProjection']>[0]);
      case 'cancel_native_projection': return store.cancelNativeProjection(input as Parameters<UnifiedDataStore['cancelNativeProjection']>[0]);
      case 'supersede_native_projections': return store.supersedeNativeProjections(input as Parameters<UnifiedDataStore['supersedeNativeProjections']>[0]);
      case 'read_ui_state': return store.readUiState(input as Parameters<UnifiedDataStore['readUiState']>[0]);
      case 'patch_ui_state': return store.patchUiState(input as unknown as Parameters<UnifiedDataStore['patchUiState']>[0]);
      case 'sync_schedules': return store.publishScheduleSync(input as unknown as Parameters<UnifiedDataStore['publishScheduleSync']>[0],publicationCommit(request));
      case 'read_schedule_sync_state': return store.readScheduleSyncState();
      case 'claim_due_schedules': return store.publishScheduleClaims(input as unknown as Parameters<UnifiedDataStore['publishScheduleClaims']>[0],publicationCommit(request));
      case 'read_schedule_ledger': return store.readScheduleLedger(input as Parameters<UnifiedDataStore['readScheduleLedger']>[0]);
      case 'restore_legacy_scheduled_occurrences': return store.publishLegacyScheduledOccurrences(input as unknown as Parameters<UnifiedDataStore['publishLegacyScheduledOccurrences']>[0], publicationCommit(request));
      case 'settle_schedule_occurrence': return store.publishScheduleSettlement(input as unknown as Parameters<UnifiedDataStore['publishScheduleSettlement']>[0],publicationCommit(request));
      case 'accept_inbox_message': return store.acceptInboxMessage(input as unknown as Parameters<UnifiedDataStore['acceptInboxMessage']>[0]);
      case 'claim_inbox_messages': return store.claimInboxMessages(input as unknown as Parameters<UnifiedDataStore['claimInboxMessages']>[0]);
      case 'begin_inbox_action': return store.beginInboxAction(input as unknown as Parameters<UnifiedDataStore['beginInboxAction']>[0]);
      case 'settle_inbox_action': return store.settleInboxAction(input as unknown as Parameters<UnifiedDataStore['settleInboxAction']>[0]);
      case 'import_legacy_telegram_conversations': return store.publishLegacyTelegramConversationIds(input as Parameters<UnifiedDataStore['importLegacyTelegramConversationIds']>[0], publicationCommit(request));
      case 'reconcile_unknown_inbox_actions': return store.reconcileUnknownInboxActions(input as unknown as Parameters<UnifiedDataStore['reconcileUnknownInboxActions']>[0]);
      case 'acknowledge_inbox_message': return store.acknowledgeInboxMessage(input as unknown as Parameters<UnifiedDataStore['acknowledgeInboxMessage']>[0]);
      case 'release_inbox_message': return store.releaseInboxMessage(input as unknown as Parameters<UnifiedDataStore['releaseInboxMessage']>[0]);
      case 'register_runtime_instance': return store.registerRuntimeInstance(input as unknown as Parameters<UnifiedDataStore['registerRuntimeInstance']>[0]);
      case 'heartbeat_runtime_instance': return store.heartbeatRuntimeInstance(input as unknown as Parameters<UnifiedDataStore['heartbeatRuntimeInstance']>[0]);
      case 'read_learning_overview': return store.readLearningOverview();
      case 'read_rsi_cycles': {
        const project = await readProject(input);
        return project ? store.readRsiCycles(project.projectId, input) : [];
      }
      case 'record_run_verification': {
        const project = await runProject(input);
        return store.publishRunVerification(project.projectId, input as unknown as Parameters<UnifiedDataStore['publishRunVerification']>[1],publicationCommit(request));
      }
      case 'sync_external_memory': {
        const project = await runProject(input);
        return store.publishExternalMemorySync(project.projectId, input as unknown as Parameters<UnifiedDataStore['syncExternalMemory']>[1],publicationCommit(request));
      }
      case 'read_external_memory_targets': {
        const project = await readProject(input);
        return project ? store.readExternalMemoryTargets(project.projectId) : [];
      }
      case 'revoke_external_memory_target': {
        const project = await runProject(input);
        return store.publishExternalMemoryTarget(project.projectId, {operation:'revoke',input:input as unknown as Parameters<UnifiedDataStore['revokeExternalMemoryTarget']>[1]},publicationCommit(request));
      }
      case 'reconcile_external_memory_target': {
        const project = await runProject(input);
        return store.publishExternalMemoryTarget(project.projectId, {operation:'reconcile',input:input as unknown as Parameters<UnifiedDataStore['reconcileExternalMemoryTarget']>[1]},publicationCommit(request));
      }
      case 'record_learning_cycle': {
        const project = await runProject(input);
        const { root: _root, projectId: _projectId, ...cycle } = input;
        return store.publishLearningCycle(project.projectId, cycle as unknown as Parameters<UnifiedDataStore['publishLearningCycle']>[1],publicationCommit(request));
      }
      case 'read_learning_source_revision': return store.readLearningSourceRevision();
      case 'read_global_prompt_policy': return store.readGlobalPromptPolicy();
      case 'save_global_prompt': return store.publishGlobalPromptSave(input as unknown as Parameters<UnifiedDataStore['saveGlobalPrompt']>[0],publicationCommit(request));
      case 'prepare_learning_review': return input.resultMode==='identity'?store.publishLearningReviewPrepare(input as unknown as Parameters<UnifiedDataStore['prepareLearningReview']>[0],publicationCommit(request),{resultMode:'identity'}):store.publishLearningReviewPrepare(input as unknown as Parameters<UnifiedDataStore['prepareLearningReview']>[0],publicationCommit(request));
      case 'apply_learning_review': return store.publishLearningReviewApply(input as unknown as Parameters<UnifiedDataStore['publishLearningReviewApply']>[0],publicationCommit(request));
      case 'finish_learning_review': return store.publishLearningReviewFinish(input as unknown as Parameters<UnifiedDataStore['publishLearningReviewFinish']>[0],publicationCommit(request));
      case 'interrupt_learning_review': return store.publishLearningReviewInterrupt(String(input.batchId || ''),publicationCommit(request));
      case 'recover_run_inputs': return runInputs.recover();
      case 'materialize_run_prompt':
      case 'release_run_prompt': {
        const project = await runProject(input);
        const executionLogId = Number(input.executionLogId); const generation = Number(input.generation);
        store.verifyRunExecutionProof(project.projectId, executionLogId, generation, String(input.proof || ''));
        return request.operation === 'materialize_run_prompt' ? runInputs.materialize({ projectId: project.projectId, executionLogId, generation }) : runInputs.release({ projectId: project.projectId, executionLogId, generation });
      }
      case 'prepare_flow_role': {
        await initializeProjectJournalAllocation(store, String(input.root || ''));
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.publishFlowRole(project.projectId, project.locationId, await withRoadmapBackup(input) as unknown as Parameters<UnifiedDataStore['publishFlowRole']>[2],publicationCommit(request));
      }
      case 'read_run_intent': {
        const project = await readProject(input);
        if (!project) return null;
        return store.readRunIntent(project.projectId, String(input.launchIntentId || ''));
      }
      case 'prepare_run_intent': {
        await initializeProjectJournalAllocation(store, String(input.root || ''));
        const project = await store.registerProject({ root: String(input.root || '') });
        const prepared = store.hasRunAllocation(project.projectId,'intent',String(input.launchIntentId || '')) ? input : await withRoadmapBackup(input);
        return store.publishRunAllocation(project.projectId, project.locationId, prepared as unknown as Parameters<UnifiedDataStore['publishRunAllocation']>[2],'intent',publicationCommit(request));
      }
      case 'read_run_slot': {
        const project = await readProject(input);
        if (!project) return null;
        return store.readRunSlot(project.projectId, String(input.launchSlotId || ''), input.launchSlotScope === 'global' ? 'global' : 'project');
      }
      case 'prepare_run_slot': {
        await initializeProjectJournalAllocation(store, String(input.root || ''));
        const project = await store.registerProject({ root: String(input.root || '') });
        const scope = input.launchSlotScope === 'global' ? 'global' : 'project';
        const prepared = store.hasRunAllocation(project.projectId,'slot',String(input.launchSlotId || ''),scope) ? input : await withRoadmapBackup(input);
        return store.publishRunAllocation(project.projectId, project.locationId, prepared as unknown as Parameters<UnifiedDataStore['publishRunAllocation']>[2],'slot',publicationCommit(request));
      }
      case 'prepare_run': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.publishRunCreation(project.projectId, project.locationId, await withRoadmapBackup(input) as unknown as Parameters<UnifiedDataStore['prepareRun']>[2],publicationCommit(request));
      }
      case 'prepare_agent_launch': {
        const {resumeRun,preparationOwner,providerContext,resumeSavedIntent,...launchInput}=input;
        const options:AgentLaunchOptions={...(preparationOwner?{deliveryOwner:preparationOwner as NonNullable<AgentLaunchOptions['deliveryOwner']>}:{}),...(providerContext?{providerContext:providerContext as Record<string,unknown>}:{}),...(resumeSavedIntent===false?{resumeSavedIntent:false}:{})};
        if(resumeRun){
          const reference=resumeRun as {projectId:string;runId:string;executionLogId:number};
          if(!reference.projectId || !reference.runId || !Number.isInteger(reference.executionLogId) || reference.executionLogId<1)throw new Error('invalid_run_request');
          const project=await readProject({projectId:reference.projectId});
          return store.publishAgentLaunch(project!.projectId,undefined,undefined,publicationCommit(request),{...options,resumeRun:{runId:reference.runId,executionLogId:reference.executionLogId},interactionBudget:input.interactionBudget as AgentLaunchOptions['interactionBudget']});
        }
        const launch = { ...(launchInput as unknown as AgentRunPreparationInput), globalDataPath: store.root };
        if (!path.isAbsolute(String(launch.workspaceRoot || ''))) throw new Error('invalid_run_request');
        if (launch.launchIntentId) {
          const project = await readProject({ root: launch.workspaceRoot });
          if (project) {
            const existing = await store.publishAgentLaunch(project.projectId,undefined,launch,publicationCommit(request),options);
            if (existing) return existing;
          }
        }
        const registration = await store.registerProject({ root: launch.workspaceRoot });
        if ((launch.flowRole || launch.launchIntentId || launch.launchSlotId) && store.readProjectJournalMinimum(registration.projectId) === null) {
          await initializeProjectJournalAllocation(store, launch.workspaceRoot);
        }
        return store.publishAgentLaunch(registration.projectId,registration.locationId,launch,publicationCommit(request),options);
      }
      case 'read_run_state': {
        const project = await readProject(input);
        if (!project) throw new Error('run_missing');
        return store.readRunState(project.projectId, Number(input.executionLogId), input.revision === undefined ? undefined : Number(input.revision));
      }
      case 'read_run_execution_plan': {
        const project = await readProject(input);
        if (!project) throw new Error('project_scope_required');
        return store.readRunExecutionPlan(project.projectId, Number(input.executionLogId));
      }
      case 'read_run_launch_permission': {
        const project = await readProject(input);
        if (!project) throw new Error('project_scope_required');
        return store.readRunLaunchPermission(project.projectId, input as unknown as Parameters<UnifiedDataStore['readRunLaunchPermission']>[1]);
      }
      case 'read_run_checkpoint_state': {
        const project = await readProject(input);
        if (!project) throw new Error('project_scope_required');
        return store.readRunCheckpointState(project.projectId, Number(input.executionLogId));
      }
      case 'read_run_turn_journal': {
        const project = await readProject(input);
        if (!project) throw new Error('project_scope_required');
        return store.readRunTurnJournal(project.projectId, Number(input.executionLogId), input.turnId === undefined ? undefined : String(input.turnId));
      }
      case 'resolve_run_conversation': {
        const project = await readProject(input);
        if (!project) return null;
        return store.resolveRunConversation(project.projectId, Number(input.executionLogId));
      }
      case 'list_conversation_run_states': {
        const project = await readProject(input);
        if (!project) return { items: [], nextCursor: null };
        return store.listConversationRunStates(project.projectId, Number(input.executionLogId), {
          ...(input.cursor !== undefined ? { cursor: Number(input.cursor) } : {}),
          ...(input.limit !== undefined ? { limit: Number(input.limit) } : {})
        });
      }
      case 'resolve_run_conversation_turn': {
        const project = await readProject(input);
        if (!project) return null;
        return store.resolveRunConversationTurn(project.projectId, Number(input.executionLogId));
      }
      case 'patch_run_inputs': {
        const commit=publicationCommit(request);
        const project = await runProject(input);
        return store.publishRunInputs(project.projectId, input as unknown as Parameters<UnifiedDataStore['publishRunInputs']>[1],commit);
      }
      case 'list_run_states': {
        const project = input.projectId || input.root ? await runProject(input) : undefined;
        return store.listRunStates({ ...(project ? { projectId: project.projectId } : {}), ...(input.pendingConsumer === true ? { pendingConsumer: true } : {}), ...(input.cursor !== undefined ? { cursor: Number(input.cursor) } : {}), ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}) });
      }
      case 'list_recoverable_run_states': return store.recoverableRunStates(Number(input.cursor || 0));
      case 'list_run_deliveries': {
        const project = input.projectId || input.root ? await runProject(input) : undefined;
        return store.listRunDeliveries({ ...input, ...(project ? { projectId: project.projectId } : {}) });
      }
      case 'release_run_delivery': {
        const project = await runProject(input);
        return store.publishRunControl(project.projectId,{type:'deliveryRelease',input:input as unknown as Parameters<UnifiedDataStore['releaseRunDelivery']>[1]},publicationCommit(request));
      }
      case 'claim_run_terminal_owner': {
        const project = await runProject(input);
        return store.publishRunControl(project.projectId,{type:'terminalOwner',input:input as unknown as Parameters<UnifiedDataStore['claimRunTerminalOwner']>[1]},publicationCommit(request));
      }
      case 'patch_run_state': {
        const project = await runProject(input);
        return store.publishRunControl(project.projectId,{type:'state',input:input as unknown as Parameters<UnifiedDataStore['patchRunState']>[1]},publicationCommit(request));
      }
      case 'claim_run_consumer': {
        const project = await runProject(input);
        return store.publishRunConsumerClaim(project.projectId, input as unknown as Parameters<UnifiedDataStore['publishRunConsumerClaim']>[1],publicationCommit(request));
      }
      case 'release_run_consumer': {
        const project = await runProject(input);
        store.releaseRunConsumer(project.projectId, input as unknown as Parameters<UnifiedDataStore['releaseRunConsumer']>[1]);
        return { released: true };
      }
      case 'commit_run_settlement': {
        const project = await runProject(input);
        return store.publishRunSettlement(project.projectId, input as unknown as Parameters<UnifiedDataStore['publishRunSettlement']>[1],publicationCommit(request));
      }
      case 'read_run_settlements': {
        const project = await readProject(input);
        return project ? store.readRunSettlements(project.projectId, input) : { items: [], nextCursor: null };
      }
      case 'query_run_digests': {
        const project = await readProject(input);
        return project ? store.queryRunDigests(project.projectId, input as unknown as Parameters<UnifiedDataStore['queryRunDigests']>[1]) : { items: [], nextCursor: null };
      }
      case 'read_run_digests': {
        const project = await readProject(input);
        return project ? store.readRunDigests(project.projectId, input) : [];
      }
      case 'read_run_index_health': {
        const project = await readProject(input);
        return project ? store.readRunIndexHealth(project.projectId) : null;
      }
      case 'list_run_effects': {
        const project = input.projectId || input.root ? await runProject(input) : undefined;
        return store.listRunEffects({ ...input, ...(project ? { projectId: project.projectId } : {}) });
      }
      case 'claim_run_effect': {
        const project = await runProject(input);
        return store.claimRunEffect(project.projectId, input as unknown as Parameters<UnifiedDataStore['claimRunEffect']>[1]);
      }
      case 'finish_run_effect': {
        const project = await runProject(input);
        return store.finishRunEffect(project.projectId, input as unknown as Parameters<UnifiedDataStore['finishRunEffect']>[1]);
      }
      case 'read_step_memory_state': {
        const project = await readProject(input);
        return project ? store.readStepMemoryState(project.projectId) : null;
      }
      case 'read_step_memory': {
        const project = await readProject(input);
        return project ? store.readStepMemory(project.projectId, String(input.nodeId || ''), { ...(input.revision === undefined ? {} : { revision: Number(input.revision) }), includeEntries: input.includeEntries !== false }) : null;
      }
      case 'read_notification': return store.readNotification(String(input.intentId || ''));
      case 'enqueue_notification': return store.enqueueNotification(input as unknown as Parameters<UnifiedDataStore['enqueueNotification']>[0]);
      case 'list_notification_deliveries': return store.listNotificationDeliveries(input as unknown as Parameters<UnifiedDataStore['listNotificationDeliveries']>[0]);
      case 'begin_notification_delivery': return store.beginNotificationDelivery(input as unknown as Parameters<UnifiedDataStore['beginNotificationDelivery']>[0]);
      case 'settle_notification_delivery': return store.settleNotificationDelivery(input as unknown as Parameters<UnifiedDataStore['settleNotificationDelivery']>[0]);
      case 'append_automation_event': {
        const commit=publicationCommit(request);
        const project = await runProject(input);
        return store.publishAutomationEvent(project.projectId, input as unknown as Parameters<UnifiedDataStore['appendAutomationEvent']>[1],commit);
      }
      case 'prepare_automation_delivery': {
        const project = await runProject(input);
        return store.prepareAutomationDelivery(project.projectId, input as unknown as Parameters<UnifiedDataStore['prepareAutomationDelivery']>[1]);
      }
      case 'prepare_automation_deliveries': {
        const project = await runProject(input);
        return store.prepareAutomationDeliveries(project.projectId, input as unknown as Parameters<UnifiedDataStore['prepareAutomationDeliveries']>[1]);
      }
      case 'list_automation_deliveries': return store.listAutomationDeliveries(input as unknown as Parameters<UnifiedDataStore['listAutomationDeliveries']>[0]);
      case 'claim_automation_delivery': return store.claimAutomationDelivery(input as unknown as Parameters<UnifiedDataStore['claimAutomationDelivery']>[0]);
      case 'begin_automation_delivery': return store.beginAutomationDelivery(input as unknown as Parameters<UnifiedDataStore['beginAutomationDelivery']>[0]);
      case 'register_automation_ui_owner': return store.registerAutomationUiOwner(input as unknown as Parameters<UnifiedDataStore['registerAutomationUiOwner']>[0]);
      case 'settle_automation_delivery': return store.settleAutomationDelivery(input as unknown as Parameters<UnifiedDataStore['settleAutomationDelivery']>[0]);
      case 'write_step_memory': {
        const commit=publicationCommit(request);
        const project = await runProject(input);
        return store.publishStepMemory(project.projectId, input as unknown as Parameters<UnifiedDataStore['writeStepMemory']>[1],commit);
      }
      case 'read_flow_trace': {
        const project = await readProject(input);
        return project ? store.readFlowTrace(project.projectId, String(input.flowId), input.revision === undefined ? undefined : Number(input.revision)) : null;
      }
      case 'write_flow_trace': {
        const project = await runProject(input);
        return store.publishFlowTrace(project.projectId, input as unknown as Parameters<UnifiedDataStore['writeFlowTrace']>[1],publicationCommit(request));
      }
      case 'list_flow_traces': {
        const project = await readProject(input);
        return project ? store.listFlowTraces(project.projectId, input) : [];
      }
      case 'read_documentation_manifest': {
        const project = await readProject(input);
        return project ? store.readDocumentationManifest(project.projectId) : { schemaVersion: 1, updatedAt: '', documents: [], pendingReview: [] };
      }
      case 'audit_documentation_manifest': {
        // The production execution-domain worker replaces this compatibility
        // branch with isolated filesystem audit computation before the request
        // reaches the Writer. Direct embedded callers still need a deterministic
        // database-only result so durable settlement effects can drain.
        const project = await readProject(input);
        if (!project) throw new Error('project_not_registered');
        const manifest = store.readDocumentationManifest(project.projectId);
        return { manifest, touchedDocuments: [], pendingReview: manifest.pendingReview, summary: '' };
      }
      case 'sync_documentation_manifest': {
        const project = await runProject(input);
        return store.syncDocumentationManifest(project.projectId, input as unknown as Parameters<UnifiedDataStore['syncDocumentationManifest']>[1]);
      }
      case 'claim_run': {
        const project = await runProject(input);
        return store.publishRunControl(project.projectId,{type:'runClaim',input:input as unknown as Parameters<UnifiedDataStore['claimRun']>[1]},publicationCommit(request));
      }
      case 'claim_run_delivery': {
        const project = await runProject(input);
        return store.publishRunControl(project.projectId,{type:'deliveryClaim',input:input as unknown as Parameters<UnifiedDataStore['claimRunDelivery']>[1]},publicationCommit(request));
      }
      case 'begin_run_delivery': {
        const project = await runProject(input);
        return store.publishRunDeliveryStart(project.projectId,input as unknown as Parameters<UnifiedDataStore['beginRunDelivery']>[1],publicationCommit(request));
      }
      case 'stop_run': {
        const project = await runProject(input);
        return runStops.stop(project.projectId, input as unknown as Parameters<RunStop['stop']>[1],publicationCommit(request));
      }
      case 'write_run_binding': {
        observer?.phase('binding.resolve-project');
        const project = await runProject(input);
        observer?.phase('binding.commit');
        const binding = await store.publishRunControl(project.projectId,{type:'binding',input:input as unknown as Parameters<UnifiedDataStore['writeRunBinding']>[1]},publicationCommit(request));
        observer?.phase('binding.committed');
        return binding;
      }
      case 'read_run_binding': {
        const project = await readProject(input);
        if (!project) throw new Error('project_scope_required');
        return store.readRunBinding(project.projectId, Number(input.executionLogId), input.revision === undefined ? undefined : Number(input.revision));
      }
      case 'read_recent_run_session': {
        const project = await readProject(input);
        return project ? store.readRecentRunSession(project.projectId, String(input.nodeId || ''), String(input.provider || '')) : null;
      }
      case 'submit_run_report': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.publishRunReport(project.projectId,{...input,root:String(input.root)} as unknown as Parameters<UnifiedDataStore['publishRunReport']>[1],publicationCommit(request));
      }
      case 'record_claude_native_ready': {
        const project = await runProject(input);
        return store.publishRunNative(project.projectId,{type:'ready',input:input as unknown as Parameters<UnifiedDataStore['recordClaudeNativeReady']>[1]},publicationCommit(request));
      }
      case 'record_claude_native_append': {
        const project = await runProject(input);
        return store.publishRunNative(project.projectId,{type:'append',input:input as unknown as Parameters<UnifiedDataStore['recordClaudeNativeAppend']>[1]},publicationCommit(request));
      }
      case 'record_claude_native_event': {
        const project = await runProject(input);
        const state = await store.publishRunNative(project.projectId,{type:'event',input:input as unknown as Parameters<UnifiedDataStore['recordClaudeNativeEvent']>[1]},publicationCommit(request));
        await new RunNativeObserver(store, workspaceCompute).observe(state);
        return (await store.readRunContextPublication(project.projectId,{executionLogId:Number(input.executionLogId)})).state;
      }
      case 'checkpoint_run': {
        const project = await runProject(input);
        const inspected=await store.inspectRunCheckpointPublication(project.projectId,input as unknown as Parameters<UnifiedDataStore['checkpointRun']>[1],String(input.root || ''),true),checkpoint=inspected.input;
        let state=inspected.state;
        if(inspected.replay)return store.publishRunCheckpoint(project.projectId,checkpoint,publicationCommit(request));
        if ((checkpoint.action === 'session-close' || checkpoint.action === 'complete' && checkpoint.exitCode !== undefined && state.status.sessionProvider === 'claude')
          && state.status.interactiveSession && !state.status.interactiveSessionClosed) {
          if (state.revision !== Number(checkpoint.expectedRevision)) throw new Error('revision_conflict');
          if (checkpoint.expectedTurnId && checkpoint.expectedTurnId !== state.turnId) throw new Error('checkpoint_turn_conflict');
          await new RunNativeObserver(store, workspaceCompute).observe(state, false, checkpoint.exitCode as number | undefined);
          state = (await store.inspectRunCheckpointPublication(project.projectId,checkpoint)).state;
          if (checkpoint.action === 'complete' && checkpoint.report === undefined && state.status.nativeReplyObjectId
            && state.status.nativeOutputPending !== true && store.readMetadata(state.turnId).data.finished_at !== null
            && !store.runChildProcessAlive(project.projectId, Number(input.executionLogId))) return state;
          if (state.revision !== Number(checkpoint.expectedRevision)) throw new Error('revision_conflict');
        }
        if (checkpoint.action === 'start' && state.status.nativeOutputPending === true) {
          await new RunNativeObserver(store, workspaceCompute).observe(state);
          state = (await store.inspectRunCheckpointPublication(project.projectId,checkpoint)).state;
          if (state.revision !== Number(checkpoint.expectedRevision)) throw new Error('revision_conflict');
        }
        if (checkpoint.action === 'start' && checkpoint.foregroundStart !== true) {
          checkpoint.gitBaseline = String(state.status.baseGitHash || '') || await workspaceCompute.gitHead(String(state.status.workspaceRoot));
        }
        if ((checkpoint.action === 'start' && checkpoint.foregroundStart !== true) || checkpoint.action === 'complete'
          || (checkpoint.action === 'session-close' && (store.readMetadata(state.turnId).data.finished_at === null || state.status.nativeOutputPending === true))) {
          checkpoint.workspaceSnapshot = await workspaceCompute.snapshot(String(state.status.workspaceRoot));
        }
        if (checkpoint.action !== 'start') checkpoint.gitEvidence = await workspaceCompute.gitEvidence(String(state.status.workspaceRoot), String(state.status.baseGitHash || ''), checkpoint.workspaceSnapshot as WorkspaceSnapshot | undefined);
        const result = await store.publishRunCheckpoint(project.projectId,checkpoint,publicationCommit(request));
        if (checkpoint.action === 'session-close') await new RunNativeObserver(store, workspaceCompute).forget(result);
        return result;
      }
      case 'finalize_run_output': {
        const project = await runProject(input);
        const finalize = input as unknown as Parameters<UnifiedDataStore['finalizeRunOutput']>[1];
        const inspected = await store.inspectRunOutputPublication(project.projectId, finalize);
        if (inspected.replay) return store.publishRunOutput(project.projectId,finalize,publicationCommit(request));
        const state = inspected.state;
        const workspaceSnapshot = await workspaceCompute.snapshot(String(state.status.workspaceRoot));
        return store.publishRunOutput(project.projectId, { ...finalize, workspaceSnapshot, gitEvidence: await workspaceCompute.gitEvidence(String(state.status.workspaceRoot), String(state.status.baseGitHash || ''), workspaceSnapshot) },publicationCommit(request));
      }
      case 'append_run_log': {
        const commit=publicationCommit(request);
        const project = await runProject(input);
        return store.publishRunLog(project.projectId, input as unknown as Parameters<UnifiedDataStore['appendRunLog']>[1],commit);
      }
      case 'read_run_log': {
        const project = await readProject(input);
        if (!project) throw new Error('project_scope_required');
        return store.readRunLog(project.projectId, input as unknown as Parameters<UnifiedDataStore['readRunLog']>[1]);
      }
      case 'read_run_log_head': {
        const project = await readProject(input);
        if (!project) throw new Error('project_scope_required');
        return store.readRunLogHead(project.projectId, Number(input.executionLogId), String(input.stream || ''));
      }
      case 'write_run_document': {
        const commit=publicationCommit(request);
        const project = await runProject(input);
        return store.publishRunDocument(project.projectId, input as unknown as Parameters<UnifiedDataStore['writeRunDocument']>[1],commit);
      }
      case 'read_run_document': {
        const project = await readProject(input);
        if (!project) throw new Error('project_scope_required');
        return store.readRunDocument(project.projectId, Number(input.executionLogId), String(input.purpose || ''), input.revision === undefined ? undefined : Number(input.revision),
          input.tailBytes === undefined ? undefined : Number(input.tailBytes), input.tailBytes === undefined ? Number(input.offset || 0) : undefined,
          input.tailBytes === undefined ? Number(input.limit || 65536) : undefined);
      }
      case 'recover_run_executions': {
        if (input.identityOnly === true) {
          const executionLogId = Number(input.executionLogId);
          if (!Number.isSafeInteger(executionLogId) || executionLogId < 1) throw new Error('invalid_execution_log_id');
          const project = await runProject(input);
          const state = store.readRunState(project.projectId, executionLogId);
          if (state.generation !== Number(input.generation)) throw new Error('run_owner_conflict');
          await new RunNativeObserver(store, workspaceCompute).observe(state, true);
        } else await runs.recover();
        return { recovered: true };
      }
      case 'observe_run_task_ingress': {
        const executionLogId = Number(input.executionLogId);
        if (!Number.isSafeInteger(executionLogId) || executionLogId < 1) throw new Error('invalid_execution_log_id');
        const project = await runProject(input);
        const state = store.readRunCheckpointState(project.projectId, executionLogId);
        if (state.generation !== Number(input.generation)) throw new Error('run_owner_conflict');
        if (input.expectedTurnId && state.turnId !== String(input.expectedTurnId)) throw new Error('checkpoint_turn_conflict');
        await new RunNativeObserver(store, workspaceCompute).observe(state);
        return store.readRunState(project.projectId, executionLogId);
      }
      case 'read_project_growth': {
        const project = await readProject(input);
        if (!project) return { latest: null, history: [] };
        const detailOffset = input.detailOffset === undefined ? 0 : Number(input.detailOffset);
        const detailLimit = input.detailLimit === undefined ? 200 : Number(input.detailLimit);
        if (!Number.isInteger(detailOffset) || detailOffset < 0 || !Number.isInteger(detailLimit) || detailLimit < 1 || detailLimit > 500) throw new Error('invalid_growth_detail_page');
        return store.readProjectGrowth(project.projectId, Number(input.historyLimit || 12), input.snapshotId === undefined ? undefined : String(input.snapshotId), detailOffset, detailLimit, input.detailToken === undefined ? undefined : String(input.detailToken));
      }
      case 'preview_growth_snapshot_detail_cleanup': return store.previewGrowthSnapshotDetailCleanup(input as unknown as Parameters<UnifiedDataStore['previewGrowthSnapshotDetailCleanup']>[0]);
      case 'apply_growth_snapshot_detail_cleanup': return store.applyGrowthSnapshotDetailCleanup(input as unknown as Parameters<UnifiedDataStore['applyGrowthSnapshotDetailCleanup']>[0]);
      case 'preview_growth_snapshot_cleanup': return store.summarizeGrowthSnapshotCleanupPlan(store.previewGrowthSnapshotCleanup(input as unknown as Parameters<UnifiedDataStore['previewGrowthSnapshotCleanup']>[0]));
      case 'read_growth_snapshot_cleanup_plan': return store.summarizeGrowthSnapshotCleanupPlan(store.readGrowthSnapshotCleanupPlan(String(input.planId || '')));
      case 'read_growth_snapshot_cleanup_manifest_page': return store.readGrowthSnapshotCleanupManifestPage(input as unknown as Parameters<UnifiedDataStore['readGrowthSnapshotCleanupManifestPage']>[0]);
      case 'apply_growth_snapshot_cleanup': return store.applyGrowthSnapshotCleanup(input as unknown as Parameters<UnifiedDataStore['applyGrowthSnapshotCleanup']>[0]);
      case 'initialize_project_journal': return { minimumExecutionLogId: await initializeProjectJournalAllocation(store, String(input.root || '')) };
      case 'append_project_journal': {
        await initializeProjectJournalAllocation(store, String(input.root || ''));
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.publishAppendProjectJournal(project.projectId,String(input.idempotencyKey || ''),input.entry as any,
          Number(input.executionLogId || 0),Number(input.minimumExecutionLogId || 1),publicationCommit(request));
      }
      case 'update_project_journal': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.publishUpdateProjectJournal(project.projectId,Number(input.executionLogId || 0),input as any,publicationCommit(request));
      }
      case 'link_project_journal': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.publishProjectJournalLink(project.projectId, Number(input.executionLogId), String(input.nodeId || ''), String(input.linkedAt || ''),publicationCommit(request));
      }
      case 'read_project_journal': {
        const project = await readProject(input);
        if (!project) return { logs: [], nextCursor: null, revision: 0 };
        return store.readProjectJournal(project.projectId, input as any);
      }
      case 'upsert_project_run_index': {
        const project = await store.registerProject({ root: String(input.root || '') });
        await store.publishProjectRunIndex(project.projectId, input.record as any, input.files as any, input.signals as any,publicationCommit(request));
        return { written: true };
      }
      case 'read_project_run_indexes': {
        const project = await readProject(input);
        if (!project) return [];
        const limit = Math.max(1, Math.min(PROJECT_RUN_INDEX_PAGE_SIZE, Math.trunc(Number(input.limit || PROJECT_RUN_INDEX_PAGE_SIZE))));
        const beforeExecutionLogId = Math.max(0, Math.trunc(Number(input.beforeExecutionLogId || 0)));
        return store.readProjectRunIndexes(project.projectId, { limit, beforeExecutionLogId });
      }
      case 'read_project_investment_runs': {
        const projectId = store.lookupProjectForRead(String(input.root || ''));
        const limit = Math.max(1, Math.min(PROJECT_RUN_INDEX_PAGE_SIZE, Math.trunc(Number(input.limit || PROJECT_RUN_INDEX_PAGE_SIZE))));
        const beforeExecutionLogId = Math.max(0, Math.trunc(Number(input.beforeExecutionLogId || 0)));
        return projectId ? store.readProjectInvestmentRuns(projectId, { limit, beforeExecutionLogId }) : [];
      }
      case 'read_project_impact_runs': {
        const project = await readProject(input);
        const limit = Math.max(1, Math.min(PROJECT_RUN_INDEX_PAGE_SIZE, Math.trunc(Number(input.limit || PROJECT_RUN_INDEX_PAGE_SIZE))));
        const beforeExecutionLogId = Math.max(0, Math.trunc(Number(input.beforeExecutionLogId || 0)));
        return project ? store.readProjectImpactRuns(project.projectId, { limit, beforeExecutionLogId }) : [];
      }
      case 'read_agent_impact_summary': {
        const projects: AgentImpactProject[] = Array.isArray(input.projects)
          ? input.projects.slice(0, 500).map(project => ({ name: String(project?.name || ''), path: String(project?.path || '') }))
            .filter(project => path.isAbsolute(project.path))
          : [];
        const now = new Date(String(input.now || ''));
        if (!Number.isFinite(now.getTime())) throw new Error('agent_impact_time_invalid');
        const runs = new Map<string, AgentImpactRun[]>(), roadmaps = new Map<string, Array<{ id: string; status: string }>>();
        for (const project of projects) {
          const projectId = store.lookupProjectForRead(project.path);
          if (!projectId) { runs.set(project.path, []); roadmaps.set(project.path, []); continue; }
          runs.set(project.path, readRunsFromRunIndexEntries(store.readProjectImpactRuns(projectId)));
          try {
            roadmaps.set(project.path, store.readRoadmapByProject(projectId).nodes.map(node => ({ id: node.id, status: node.status })));
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'roadmap_import_required') throw error;
            roadmaps.set(project.path, []);
          }
        }
        return buildAgentImpactSummaryFromProjectRuns(projects,
          project => runs.get(project.path) || [], project => roadmaps.get(project.path) || [], now);
      }
      case 'read_project_reusable_source_count': {
        const project = await readProject(input); return project ? store.readProjectReusableSourceCount(project.projectId) : 0;
      }
      case 'read_project_analysis_source': {
        const project = await readProject(input); return project ? store.readProjectAnalysisSource(project.projectId) : null;
      }
      case 'read_sidebar_core_projections': return store.readSidebarCoreProjections(Array.isArray(input.projectPaths) ? input.projectPaths.map(String) : []);
      case 'wait_sidebar_core_projection_revision': throw new Error('runtime_memory_operation_misrouted');
      case 'read_analysis_state':
      case 'write_analysis_state': {
        if (request.operation === 'read_analysis_state') {
          const project = input.root === undefined ? null : (await readProject(input))?.projectId;
          if (input.root !== undefined && !project) return { objectId: null, revision: 0, value: null };
          return store.readAnalysisState(project || null, String(input.namespace || ''), String(input.key || ''));
        }
        const project = input.root === undefined ? null : (await store.registerProject({ root: String(input.root) })).projectId;
        return store.writeAnalysisState(project, input as unknown as Parameters<UnifiedDataStore['writeAnalysisState']>[1],publicationCommit(request));
      }
      case 'reserve_external_refresh': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.reserveExternalRefresh(project.projectId, String(input.key || ''), String(input.requestId || ''),publicationCommit(request));
      }
      case 'commit_external_refresh': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.commitExternalRefresh(project.projectId, input as unknown as Parameters<UnifiedDataStore['commitExternalRefresh']>[1],publicationCommit(request));
      }
      case 'read_strategy_source_revision': {
        if (!Array.isArray(input.roots) || input.roots.some(root => typeof root !== 'string')) throw new Error('strategy_source_roots_required');
        const projectIds: string[] = [];
        for (const root of input.roots) {
          const projectId = store.lookupProjectForRead(root);
          if (projectId) projectIds.push(projectId);
        }
        return { revision: store.readStrategySourceRevision(projectIds), projectIds };
      }
      case 'read_strategy_state': {
        const project = input.root === undefined ? null : store.lookupProjectForRead(String(input.root));
        return input.root !== undefined && !project ? { objectId: null, revision: 0, value: null } : store.readStrategyState(project);
      }
      case 'write_strategy_state': {
        const project = input.root === undefined ? null : (await store.registerProject({ root: String(input.root) })).projectId;
        return store.writeStrategyState(project, input as unknown as Parameters<UnifiedDataStore['writeStrategyState']>[1],publicationCommit(request));
      }
      case 'write_run_artifact': {
        const commit=publicationCommit(request);
        const root = String(input.root || ''); const project = await store.registerProject({ root }); await store.publishRunArtifact(project.projectId, input as any,undefined,commit);
        if (typeof input.sourceKey === 'string') {
          const bytes = Buffer.from(String(input.bytes || ''), 'base64'); const identity = `agent-runs:${root}`;
          await store.publishMigrationSource({ identity, key: input.sourceKey, hash: String(input.hash || '') }, bytes, { mimeType: String(input.mimeType || 'application/octet-stream'), encoding: 'binary' },commit);
        }
        return { written: true };
      }
      case 'read_run_artifact': {
        const project = await readProject(input);
        if (!project) throw new Error('project_scope_required');
        return store.readRunArtifactPage(project.projectId, Number(input.executionLogId || 0), String(input.relativePath || ''), input.offset === undefined ? 0 : Number(input.offset), input.limit === undefined ? 65536 : Number(input.limit));
      }
      case 'read_growth_report_projection': {
        const project = await readProject(input);
        const limit = input.limit === undefined ? 200 : Number(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid_growth_projection_page');
        return project ? store.readGrowthReportProjection(project.projectId, String(input.prefix || ''), String(input.afterKey || ''), limit) : [];
      }
      case 'read_registered_report_sources': {
        const project = await readProject(input);
        return project ? store.readRegisteredReportSourcePage(project.projectId, input as unknown as Parameters<UnifiedDataStore['readRegisteredReportSourcePage']>[1])
          : { items: [], nextCursor: null, sourceRevision: 0 };
      }
      case 'runtime_writer_barrier': return store.readRuntimeWriterBarrier();
      case 'runtime_write_probe': return store.writeRuntimeGateProbe(String(input.probeId || ''));
      case 'read_report_versions': {
        const project = await readProject(input);
        return project ? store.readReportVersionPage(project.projectId, input.ref as { objectId: string; revision: number }, Number(input.offset || 0), Number(input.limit || 65536)) : null;
      }
      case 'read_report_source_revision': {
        const project = await readProject(input);
        return { revision: project ? store.reportSourceRevision(project.projectId) : 0 };
      }
      case 'read_github_facts':
      case 'write_github_facts': {
        if (request.operation === 'read_github_facts') {
          const project = await readProject(input);
          return project ? store.readGithubFacts(project.projectId, String(input.repository || '')) : null;
        }
        const project = await store.registerProject({ root: String(input.root || '') });
        store.writeGithubFacts(project.projectId, input as unknown as Parameters<UnifiedDataStore['writeGithubFacts']>[1]);
        return { written: true };
      }
      case 'write_growth_report_projection': {
        const project = await store.registerProject({ root: String(input.root || '') });
        const revisions = store.writeGrowthReportProjection(project.projectId, input.updates as Parameters<UnifiedDataStore['writeGrowthReportProjection']>[1], input.expectedSourceRevision as number | undefined);
        return { written: Array.isArray(input.updates) ? input.updates.length : 0, revisions };
      }
      case 'prepare_agent_database': {
        const provider = String(input.provider);
        if (!databaseAgentProviders.includes(provider as DatabaseAgentProvider) || typeof input.command !== 'string' || !path.isAbsolute(input.command)) throw new Error('invalid_agent_database_configuration');
        const configuration = input.configPath;
        if (configuration !== undefined && !isAgentDatabaseConfigPath(provider as DatabaseAgentProvider, configuration)) throw new Error('invalid_agent_database_configuration');
        const project = await store.registerProject({ root: String(input.root || '') });
        const configPath = configureAgentDatabase({ provider: provider as DatabaseAgentProvider, configPath: configuration as string | undefined, command: input.command, globalDataPath: store.root });
        if (provider === 'codex' && path.basename(configPath) !== 'config.toml') retireManagedCodexBaseConfig(path.dirname(configPath));
        return { ...project, configPath };
      }
      case 'import_memory': return migrations.enqueue(input);
      case 'import_intelligence': return migrations.enqueue({ ...input, collection: 'intelligence' });
      case 'import_project_data': return migrations.enqueue(input);
      case 'read_intelligence_conversation': {
        const messageOffset = input.messageOffset === undefined ? 0 : Number(input.messageOffset);
        const messageLimit = input.messageLimit === undefined ? 200 : Number(input.messageLimit);
        if (!Number.isInteger(messageOffset) || messageOffset < 0 || !Number.isInteger(messageLimit) || messageLimit < 1 || messageLimit > 200) throw new Error('invalid_conversation_page');
        return store.readIntelligenceConversation(String(input.id || ''), messageOffset, messageLimit);
      }
      case 'list_intelligence_conversations': return store.listIntelligenceConversations(input as Parameters<UnifiedDataStore['listIntelligenceConversations']>[0]);
      case 'write_intelligence_conversation': {
        const result = store.writeIntelligenceConversation(input as unknown as Parameters<UnifiedDataStore['writeIntelligenceConversation']>[0]);
        if (input.contextCheckpoint)wakeStorageMaintenance();
        return result;
      }
      case 'begin_legacy_intelligence_operation': return store.admitLegacyIntelligenceOperation(input as unknown as Parameters<UnifiedDataStore['admitLegacyIntelligenceOperation']>[0]);
      case 'read_legacy_intelligence_operation': return store.readLegacyIntelligenceOperation(String(input.operationId || ''));
      case 'mark_legacy_intelligence_operation': return store.markLegacyIntelligenceOperation(String(input.operationId || ''), String(input.status || '') as 'failed' | 'unknown');
      case 'mark_legacy_intelligence_side_effect': return store.markLegacyIntelligenceSideEffect(String(input.operationId || ''));
      case 'fail_legacy_intelligence_operation': return store.failLegacyIntelligenceOperation(String(input.operationId || ''));
      case 'write_legacy_intelligence_conversation': {
        const { operationId, ...writeInput } = input;
        const result = store.writeLegacyIntelligenceConversation(String(operationId || ''), writeInput as unknown as Parameters<UnifiedDataStore['writeIntelligenceConversation']>[0]);
        if (writeInput.contextCheckpoint)wakeStorageMaintenance();
        return result;
      }
      case 'claim_pi_execution_owner': {
        const runtimeId = String(input.runtimeId || '');
        const owner = store.claimPiExecutionOwner(runtimeId);
        return { owner, mode: store.registerPiCompatibilityRelease(String(input.releaseVersion || ''), String(input.buildId || ''), runtimeId).mode };
      }
      case 'abandon_conversation_dispatches': {
        if (input.ownerPrefix) store.conversationTracking().abandonDispatchesByPrefix(String(input.ownerPrefix));
        else store.conversationTracking().abandonDispatches(String(input.ownerId || ''));
        return { abandoned: true };
      }
      case 'admit_intelligence_message': {
        if (intelligenceRuntime) return intelligenceRuntime.admit(input);
        const operationId = String(input.operationId || input.requestId || '');
        const requestId = String(input.requestId || operationId);
        const ingress = store.admitPiConversationIngress({
          conversationId: String(input.conversationId || ''), operationId, requestKey: requestId,
          text: String(input.text || ''), source: String(input.source || 'sidebar'),
          sourceGeneration: Number((input.commitGuard as { generation?: number } | undefined)?.generation || 0),
          requireExisting: input.requireExisting === true,
          ...(input.commitGuard ? { commitGuard: input.commitGuard as any } : {})
        }, store.currentPiExecutionOwner());
        return { operationId: ingress.operationId, requestId: ingress.requestKey, conversationId: ingress.conversationId,
          status: ingress.status === 'cancelled' ? 'cancelled' : 'accepted', acceptedAt: ingress.createdAt };
      }
      case 'admit_intelligence_ingress': return store.admitPiConversationIngress(input.request as any, input.owner as any);
      case 'record_intelligence_ingress_failure': return store.recordPiConversationIngressFailure(String(input.operationId || ''), input.owner as any, input.error);
      case 'read_intelligence_ingress': return store.readPiConversationIngress(String(input.operationId || ''));
      case 'materialize_pi_acceptance': return store.materializePiConversationIngress(String(input.operationId || ''), input.acceptance as any, input.owner as any);
      case 'list_recoverable_intelligence_ingress': return store.listRecoverablePiConversationIngresses(input.conversationId ? String(input.conversationId) : undefined);
      case 'read_pi_operation': return store.readPiConversationOperation(String(input.operationId || ''));
      case 'admit_pi_operation': return store.admitPiConversationOperation(input.acceptance as any, input.owner as any);
      case 'mark_pi_operation': return store.markPiConversationOperation(String(input.operationId || ''), input.owner as any, input.terminal as any);
      case 'settle_pi_operation': store.settlePiConversationOperation(String(input.operationId || ''), input.owner as any, input.terminal as any); return { settled: true };
      case 'discard_pi_completed': store.discardCompletedPiConversationOperation(String(input.operationId || ''), input.owner as any, String(input.reason || '')); return { discarded: true };
      case 'promote_next_pi_operation': return store.promoteNextPiConversationOperation(String(input.conversationId || ''), input.owner as any);
      case 'maintain_pi_retention': store.maintainPiExecutionRetention(String(input.conversationId || ''), input.owner as any); return { maintained: true };
      case 'promote_recoverable_pi_operations': store.promoteRecoverablePiConversationOperations(input.owner as any); return { promoted: true };
      case 'list_recoverable_pi_operations': return store.listRecoverablePiConversationOperations(String(input.conversationId || '') || undefined);
      case 'next_intelligence_ingress_retry_at': return store.nextPiConversationIngressRetryAt();
      case 'request_pi_cancellation': return store.requestPiConversationCancellation(input.request as any, input.owner as any);
      case 'admit_pi_tool_invocation': return store.admitPiToolInvocation(String(input.operationId || ''), input.owner as any, input.invocation as any);
      case 'complete_pi_tool_invocation': store.completePiToolInvocation(String(input.operationId || ''), String(input.invocationId || ''), input.owner as any, input.result); return { completed: true };
      case 'initialize_pi_session': {
        const storage = store.createPiSessionStorage(String(input.sessionId || ''));
        try { return storage.metadata; } finally { await storage.close(); }
      }
      case 'commit_pi_session_batch': {
        const operationId = String(input.operationId || '');
        const storage = store.createPiSessionStorage(String(input.sessionId || ''), input.owner as any, operationId || undefined);
        try { return await storage.commit(input.writes as any[], {
          commitId: String(input.commitId || '') || undefined, operationId: operationId || undefined
        }); } finally { await storage.close(); }
      }
      case 'ack_pi_session_commit':
        store.acknowledgePiSessionCommit(String(input.sessionId || ''), String(input.operationId || ''), String(input.commitId || ''), input.owner as any);
        return { acknowledged: true };
      case 'read_pi_session_storage': {
        const storage = store.createPiSessionStorage(String(input.sessionId || ''));
        try {
          const args = Array.isArray(input.args) ? input.args : [];
          const methods: Record<string, () => Promise<unknown>> = {
            getEntries: async () => [...(await storage.getEntries(args[0] as string[])).entries()],
            getValue: () => storage.getValue(args[0] as any),
            scanValues: () => storage.scanValues(args[0] as any),
            readList: () => storage.readList(args[0] as any, args[1] as any),
            scanBranch: () => storage.scanBranch(args[0] as any),
            scanBranchStructure: () => storage.scanBranchStructure(args[0] as any),
            scanEntries: () => storage.scanEntries(args[0] as any),
            scanUsage: () => storage.scanUsage(args[0] as any),
            getStats: () => storage.getStats()
          };
          const method = methods[String(input.method || '')];
          if (!method) throw new Error('pi_storage_read_method_invalid');
          return method();
        } finally { await storage.close(); }
      }
      case 'await_intelligence_message': {
        if (!intelligenceRuntime) throw new Error('intelligence_runtime_unavailable');
        const diagnostic = input.diagnostic && typeof input.diagnostic === 'object'
          ? input.diagnostic as Record<string, unknown> : {};
        const token = (value: unknown) => typeof value === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(value) ? value : undefined;
        const trace = createLocalDiagnosticTrace(store.root, 'conversation.runtime', {
          ...(token(diagnostic.interactionId) ? { interactionId: token(diagnostic.interactionId) } : {}),
          ...(token(diagnostic.targetId) ? { targetId: token(diagnostic.targetId) } : {})
        });
        return withLocalDiagnosticTrace(trace, () => intelligenceRuntime!.run(String(input.operationId || '')));
      }
      case 'cancel_intelligence_operation': {
        if (!intelligenceRuntime) throw new Error('intelligence_runtime_unavailable');
        return intelligenceRuntime.cancel(input);
      }
      case 'migration_status': {
        const scope = await migrationScope(input); const job = store.readMigrationJob(String(input.jobId || ''));
        if (scope && !recycling.jobBelongsToProject(job, scope)) throw new Error('maintenance_scope_denied');
        if (input.verifySourceKey !== undefined) return { ...job, sourceVerification: recycling.verifyJobSource(job, String(input.verifySourceKey), scope) };
        return input.metadataOnly === true ? store.readMigrationJobStatus(job.jobId) : job;
      }
      case 'discover_migrations': {
        const scope = await migrationScope(input);
        return enqueueAvailableDataMigrations(store, operations, () => true, true, scope?.root);
      }
      case 'migration_overview': {
        const scope = await migrationScope(input);
        const formalRuns = store.migrationAgentRuns().filter(run => !scope || run.projectId === scope.projectId);
        const projectedRuns = formalRuns.map(run => {
          const active = !run.status.finishedAt;
          return {
            taskId: run.taskId,
            kind: String(run.status.runKind),
            targetId: String(run.status.migrationTargetId || '') || null,
            status: active ? (String(run.status.status) === 'Preparing' ? 'ready' : 'running') : String(run.status.status) === 'Failed' ? 'failed' : 'completed',
            error: run.status.failureReason ? String(run.status.failureReason) : null,
            createdAt: Date.parse(String(run.status.startedAt || '')) || 0,
            updatedAt: Date.parse(String(run.status.finishedAt || run.status.startedAt || '')) || 0,
            validUntil: active ? Number.MAX_SAFE_INTEGER : Date.parse(String(run.status.finishedAt || '')) || 0
          };
        });
        const overview = await recycling.overview(scope, {
          jobOffset: Number(input.jobOffset || 0), jobLimit: Number(input.jobLimit || 100),
          recyclingOffset: Number(input.recyclingOffset || 0), recyclingLimit: Number(input.recyclingLimit || 100)
        });
        const projectedOverview = input.summaryOnly === true ? {
          ...overview,
          jobs: overview.jobs.map(job => {
            const { conflicts: _conflicts, ...progress } = job.progress;
            return { ...job, progress };
          })
        } : overview;
        return {
          ...projectedOverview,
          maintenanceTasks: projectedRuns,
          activeMaintenanceTaskIds: projectedRuns.filter(task => ['ready', 'running'].includes(task.status)).map(task => task.taskId),
          launchingMaintenanceTaskIds: []
        };
      }
      case 'prepare_recycling': return recycling.prepare(await migrationScope(input));
      case 'read_recycling_plan': return recycling.readPlan(String(input.planId || ''), await migrationScope(input));
      case 'discard_recycling_plan': return recycling.discardPlan(String(input.planId || ''));
      case 'retry_migration': {
        const scope = await migrationScope(input); const job = store.readMigrationJob(String(input.jobId || ''));
        if (scope && !recycling.jobBelongsToProject(job, scope)) throw new Error('maintenance_scope_denied');
        return migrations.retry(job.jobId);
      }
      case 'confirm_recycling': return recycling.confirm(String(input.planId || ''), input.files as Array<{ itemId: string; path: string; hash: string; bytes: number }> | undefined, await migrationScope(input));
      case 'hold_recycling_file': return recycling.hold(String(input.itemId || ''));
      case 'finish_recycling_file': return recycling.finish(String(input.itemId || ''));
      case 'retire_recycling_file': return recycling.retire(String(input.itemId || ''));
      case 'restore_recycling_file': return recycling.restore(String(input.itemId || ''), input.destination === undefined ? undefined : String(input.destination), await migrationScope(input));
      case 'execute_recycling_plan': {
        const scope = await migrationScope(input);
        const plan = recycling.readPlan(String(input.planId || ''), scope);
        const failures: string[] = [];
        const pending = plan.files.filter(file => file.status !== 'restored');
        for (let offset = 0; offset < pending.length; offset += 128) {
          const result = await recycling.recycleBatch(pending.slice(offset, offset + 128).map(file => file.itemId));
          failures.push(...result.failures);
        }
        if (failures.length) throw new Error(`recycling_items_retained:${failures.join(',')}`);
        return recycling.overview(scope);
      }
      case 'write': return publishRuntimeMutation(request);
      case 'record_learning_delivery': throw new Error('mcp_session_required');
      case 'read': {
        const ref = normalizeObjectReference(input.ref);
        const revision = input.revision as number | undefined;
        const session = authenticatedSession || (request.sessionToken ? sessions.get(request.sessionToken) : undefined);
        if (input.view === 'metadata') return store.readMetadata(ref, revision);
        if (input.view === 'content') return store.readPage({ ...input, ref } as unknown as Parameters<UnifiedDataStore['readPage']>[0], session?.kind === 'project' ? (object, field) => {
          if (!allowedRead(object, session)) throw new Error('scope_denied');
          if (object.projection?.hostReview === true && field === 'review_content') throw new Error('review_input_requires_host');
        } : undefined);
        if (input.view && input.view !== 'full') throw new Error('unknown_read_view');
        return store.read(ref, revision, session?.kind === 'project' ? agentObject : undefined);
      }
      case 'search': {
        const session = authenticatedSession || (request.sessionToken ? sessions.get(request.sessionToken) : undefined);
        return store.search(input as unknown as Parameters<UnifiedDataStore['search']>[0], session?.kind === 'project' ? object => allowedRead(object, session) && canAgentDiscover(object) : undefined, session?.kind === 'project' ? agentObject : undefined);
      }
      case 'link': return publishRuntimeMutation(request);
      case 'context': {
        const session = authenticatedSession || (request.sessionToken ? sessions.get(request.sessionToken) : undefined);
        return store.context(input as unknown as Parameters<UnifiedDataStore['context']>[0], session?.kind === 'project' ? object => allowedRead(object, session) : undefined);
      }
      case 'export': {
        const session = authenticatedSession || (request.sessionToken ? sessions.get(request.sessionToken) : undefined);
        return store.export(input as unknown as Parameters<UnifiedDataStore['export']>[0], session?.kind === 'project' ? object => {
          store.authorizeMcpAction(session.actorId, session.scope, 'export');
          if (!allowedRead(object, session) || !allowedRead(store.readMetadata(object.objectId), session) || !canAgentDiscover(object)) throw new Error('scope_denied');
          return agentObject(object);
        } : undefined, session?.kind === 'project' || request.piToolFence ? {
          ...(session?.kind === 'project' ? { agentProjection: true } : {}),
          ...(request.piToolFence ? { invocationFence: request.piToolFence } : {}),
          authorize: () => request.piToolFence ? store.assertPiToolInvocationActive(request.piToolFence.operationId, request.piToolFence.invocationId, {
            ownerId: request.piToolFence!.ownerId, generation: request.piToolFence!.ownerGeneration
          }) : undefined
        } : undefined);
      }
      case 'backup': return store.backup({ destination: String(input.destination || ''), idempotencyKey: String(input.idempotencyKey || '') });
      case 'backfill_database_overview_projection': return store.backfillDatabaseOverviewProjectionBatch(Number(input.limit || 2_000));
      case 'read_database_overview': return store.readDatabaseOverview();
      case 'read_database_storage': return store.readDatabaseStorage();
      case 'maintain_database_storage': return input.compact === true && databaseGenerationExecutor ? execution.storageContinuations
        ? afterStorageMaintenance(request) : databaseGenerationExecutor(request) : input.phase === 'lifecycle' || input.phase === undefined && input.automatic === true && input.compact !== true && store.usesStorageContentLifecycle()
        ? store.maintainStorageLifecycleQuantum(Number(input.limit || 64),publicationCommit(request)) : input.phase === 'cold' ? store.maintainStorageColdQuantum(Number(input.limit || 64),publicationCommit(request)) : maintainDatabaseStorage(input.compact === true, input.automatic === true,publicationCommit(request));
      case 'restore_backup': return store.restoreBackup({ source: String(input.source || ''), destinationRoot: String(input.destinationRoot || ''), idempotencyKey: String(input.idempotencyKey || '') });
      case 'export_project': return store.exportProject(input as unknown as Parameters<UnifiedDataStore['exportProject']>[0]);
      case 'import_project': return databaseGenerationExecutor ? execution.storageContinuations
        ? afterStorageMaintenance(request) : databaseGenerationExecutor(request) : store.importProject(input as unknown as Parameters<UnifiedDataStore['importProject']>[0]);
      default: throw new Error(`unknown_data_operation:${request.operation}`);
    }
  };
  const executeOperation = async (request: RuntimeDataRequest) => {
    if (request.operation === 'prepare_conversation_launch') {
      return executeOperation({ ...request, operation: 'start_conversation', input: { ...request.input, __prepareOnly: true } });
    }
    if (request.operation === 'settle_conversation_launch') {
      const tracking = store.conversationTracking();
      const launch = tracking.settleDispatch(String(request.input.dispatchToken || ''), String(request.input.ref || ''), String(request.input.error || ''));
      const project = store.existingRegisteredProjectScopes().find(candidate => candidate.projectId === String(launch.project_id));
      if (!project) throw new Error('project_scope_denied');
      const view = tracking.describe(launch);
      return { status: request.input.error ? 'failed' : 'started', projectPath: project.root, mode: launch.mode,
        conversationRef: launch.ref, projectId: launch.project_id,
        ...(view.runId ? { runId: view.runId, executionLogId: view.executionLogId } : {}), ...(launch.flow_id ? { flowId: launch.flow_id } : {}) };
    }
    if (!request.sessionToken) return dispatch(request);
    const session = sessions.get(request.sessionToken) || verifyReadAuthority(request);
    if (!session) throw new Error('mcp_session_expired');
    const input = request.input;
    if (request.operation === 'record_learning_delivery') {
      if (!session.runIdentity) throw new Error('action_denied');
      store.authorizeMcpAction(session.actorId, session.scope, 'read');
      const state = store.authorizedRunState(session.scope, session.runIdentity);
      const receipt = verifyLearningDelivery(String(input.receipt || ''), deliverySecret);
      if (receipt.sessionToken !== request.sessionToken || receipt.actorId !== session.actorId || receipt.projectId !== session.scope || receipt.runId !== state.runId || receipt.turnId !== state.turnId) throw new Error('learning_delivery_scope_mismatch');
      if (store.readMetadata(state.turnId).data.finished_at != null) throw new Error('learning_delivery_turn_closed');
      if (JSON.stringify(receipt.piToolFence || null) !== JSON.stringify(request.piToolFence || null)) throw new Error('learning_delivery_invocation_mismatch');
      const offset = Number(input.offset || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= receipt.lessons.length) throw new Error('learning_delivery_page_invalid');
      const refs = receipt.lessons.slice(offset, offset + 20);
      for (const ref of refs) {
        const current = store.readMetadata(ref.objectId);
        if (!allowedRead(current, session) || current.kind !== 'lesson' || current.data.status !== 'approved' || current.revision !== ref.revision) throw new Error('learning_delivery_source_changed');
      }
      return store.recordLearningDelivery(state, refs);
    }
    if (request.operation === 'checkpoint_current_run') {
      if (!session.runIdentity) throw new Error('action_denied');
      const prepared=await store.prepareCurrentRunCheckpointPublication(session.scope,session.runIdentity,input);
      const recordTaskIngress = async (state: import('./runLifecycleTypes').RunState): Promise<import('./runLifecycleTypes').RunState> => {
        const {patch,key,diagnostic}=await store.prepareRunTaskIngressPublication(state);
        if (!Object.keys(patch).length) {
          if (diagnostic) await store.publishDiagnosticEvent(diagnostic,publicationCommit(request));
          return state;
        }
        const updated = await store.publishRunControl(session.scope,{type:'state',input:{
          executionLogId: session.runIdentity!.executionLogId,
          generation: session.runIdentity!.generation,
          expectedRevision: state.revision,
          patch,
          idempotencyKey:key
        }},publicationCommit(request));
        if (diagnostic) await store.publishDiagnosticEvent(diagnostic,publicationCommit(request));
        return updated as import('./runLifecycleTypes').RunState;
      };
      if(prepared.ingressOnly)return recordTaskIngress(prepared.state);
      if(!prepared.input)throw new Error('run_checkpoint_input_missing');
      const result = await dispatch({ operation: 'checkpoint_run',...(request.piToolFence?{piToolFence:{...request.piToolFence}}:{}),input: {
        projectId: session.scope,
        ...prepared.input
      } }) as import('./runLifecycleTypes').RunState;
      return prepared.input.action === 'start' ? recordTaskIngress(result) : result;
    }
    if (session.migrationKind) {
      if (!session.runIdentity) throw new Error('action_denied');
      store.authorizedRunState(session.scope, session.runIdentity);
      const memoryReadActions = ['search', 'read', 'context'];
      const reviewActions = [...memoryReadActions, 'migration_overview', 'migration_status', 'retry_migration', 'prepare_recycling', 'read_recycling_plan'];
      const migrationActions = ['discover_migrations', ...reviewActions];
      const recyclingActions = [...memoryReadActions, 'migration_overview', 'read_recycling_plan', 'execute_recycling_plan'];
      if (!(session.migrationKind === 'migration_apply' ? migrationActions : session.migrationKind === 'migration_review' ? reviewActions : recyclingActions).includes(request.operation)) throw new Error('action_denied');
      if (memoryReadActions.includes(request.operation)) {
        store.authorizeMcpAction(session.actorId, session.scope, request.operation);
        if (request.operation === 'search' && input.scope !== session.scope) throw new Error('scope_denied');
        if (request.operation === 'context' && input.project !== session.scope) throw new Error('scope_denied');
        if (request.operation === 'read' && input.ref && !allowedRead(store.readMetadata(normalizeObjectReference(input.ref)), session)) throw new Error('scope_denied');
        return store.withActor(session.actorId, async () => {
          const result = await dispatch(request, session);
          if (request.operation === 'read') {
            const value = result as DataObject | { object: DataObject };
            if (!allowedRead('object' in value ? value.object : value, session)) throw new Error('scope_denied');
            return 'object' in value ? { ...value, object: agentObject(value.object) } : agentObject(value);
          }
          if (request.operation === 'context') {
            const context = result as { items: DataObject[] };
            return { ...context, items: context.items.filter(item => allowedRead(item, session)) };
          }
          return result;
        });
      }
      if (session.migrationProjectRoot) {
        const scope = await migrationScope(input);
        if (!scope || scope.projectId !== session.migrationProjectId || scope.physicalRoot !== session.migrationPhysicalRoot) throw new Error('maintenance_scope_denied');
      }
      if (session.migrationKind === 'recycling_apply' && ['read_recycling_plan', 'execute_recycling_plan'].includes(request.operation) && String(input.planId || '') !== session.migrationTargetId) throw new Error('maintenance_target_denied');
      return dispatch(request, session);
    }
    const ordinaryMigrationActions = ['discover_migrations', 'migration_overview', 'migration_status', 'retry_migration', 'prepare_recycling'];
    if (ordinaryMigrationActions.includes(request.operation)) {
      if (!session.runIdentity) throw new Error('action_denied');
      const run = store.authorizedRunState(session.scope, session.runIdentity);
      if (!soloConversationRunKinds.includes(String(run.status.runKind) as typeof soloConversationRunKinds[number])) throw new Error('action_denied');
      const scope = await migrationScope(input);
      if (!scope) throw new Error('project_scope_required');
      if (scope.projectId !== session.scope || scope.physicalRoot !== session.migrationPhysicalRoot) throw new Error('maintenance_scope_denied');
      return dispatch(request, session);
    }
    if (request.operation === 'project_signals') {
      store.authorizeMcpAction(session.actorId, session.scope, 'read');
      return readProjectSignals(store, input);
    }
    if (request.operation === 'get_conversation') {
      store.authorizeMcpAction(session.actorId, session.scope, 'read');
      const tracking = store.conversationTracking();
      const parent = session.runIdentity ? store.authorizedRunState(session.scope, session.runIdentity).conversationId : undefined;
      const origin = tracking.origin(session.actorId, request.piToolFence?.operationId || session.intelligenceOperationId, parent);
      return tracking.query(origin, input);
    }
    if (request.operation === 'start_conversation') {
      const tracking = store.conversationTracking();
      const authorizeLaunch = () => {
        store.authorizeMcpAction(session.actorId, session.scope, request.operation);
        if (request.piToolFence) store.assertPiToolInvocationActive(request.piToolFence.operationId, request.piToolFence.invocationId, {
          ownerId: request.piToolFence.ownerId, generation: request.piToolFence.ownerGeneration
        });
      };
      const reserveLaunch = () => {
        authorizeLaunch();
        const selector = String(input.project || '').trim();
        const mode = String(input.mode || '');
        const message = String(input.message || '').trim();
        const stepId = String(input.stepId || '').trim();
        const idempotencyKey = String(input.idempotencyKey || '').trim();
        if (!selector || selector.length > 4096 || !['step', 'solo', 'flow'].includes(mode) || !message || message.length > 32768
          || stepId.length > 1024 || String(input.agentCli || '').length > 4096 || String(input.model || '').length > 1024
          || !idempotencyKey || idempotencyKey.length > 256) throw new Error('invalid_conversation_request');
        if (mode === 'step' && !stepId) throw new Error('step_id_required');
        if (mode !== 'step' && stepId) throw new Error('step_id_not_allowed');
        const registry = store.readProjectRegistry() as { registry?: { projects?: Array<{ name?: string; path?: string }>; hiddenProjects?: string[] } } | null;
        const hidden = new Set((registry?.registry?.hiddenProjects || []).map(value => path.resolve(String(value))));
        const registered = store.existingRegisteredProjectScopes().filter(candidate => !hidden.has(path.resolve(candidate.root)));
        const metadataByRoot = new Map((registry?.registry?.projects || []).map(project => [path.resolve(String(project.path || '')), project]));
        const matches = registered.filter(candidate => {
          const root = path.resolve(candidate.root);
          const metadata = metadataByRoot.get(root);
          return selector === candidate.projectId || selector === candidate.root || selector === root || selector === String(metadata?.name || '');
        });
        if (matches.length !== 1) throw new Error(matches.length ? 'project_selector_ambiguous' : 'project_scope_denied');
        const projectPath = path.resolve(matches[0].root);
        const agentCli = String(input.agentCli || '').trim();
        const model = String(input.model || '').trim();
        const parent = session.runIdentity ? store.authorizedRunState(session.scope, session.runIdentity).conversationId : undefined;
        const origin = tracking.origin(session.actorId, request.piToolFence?.operationId || session.intelligenceOperationId, parent);
        const reservation = tracking.reserve(session.scope, matches[0].projectId, origin, { ...input, mode, message, stepId, agentCli, model, idempotencyKey });
        const interactionBudget = createInteractionBudgetAt(Number(reservation.launch.created_at), `conversation:${reservation.launch.ref}`);
        return { ...reservation, args: [JSON.stringify({
          projectPath, mode, message, ...(stepId ? { stepId } : {}),
          ...(agentCli ? { agentCli } : {}),
          ...(model ? { model } : {}),
          launchIntentId: reservation.launch.launch_intent_id,
          interactionBudget
        })] };
      };
      // Commit the launch reservation before the editor makes its own Runtime writes.
      const { launch, dispatchToken, args } = request.piToolFence
        ? store.withPiToolInvocationFenceSync(request.piToolFence.operationId, request.piToolFence.invocationId, {
          ownerId: request.piToolFence.ownerId, generation: request.piToolFence.ownerGeneration
        }, reserveLaunch)
        : reserveLaunch();
      const receipt = () => {
        const view = tracking.describe(launch);
        return { status: 'started', projectPath: JSON.parse(args[0]).projectPath, mode: launch.mode,
          conversationRef: launch.ref, projectId: launch.project_id,
          ...(view.runId ? { runId: view.runId, executionLogId: view.executionLogId } : {}), ...(launch.flow_id ? { flowId: launch.flow_id } : {}) };
      };
      const existing = tracking.describe(launch);
      const existingRun = existing.runId ? store.readRunIntent(String(launch.project_id), String(launch.launch_intent_id)) : null;
      const existingReceipt = existingRun?.status.taskIngressReceipt as { interactionId?: string } | undefined;
      const existingVerdict = String(existingRun?.status.taskIngressVerdict || '');
      if (launch.acknowledged || (existingRun && existingReceipt?.interactionId === existingRun.status.interactionId
        && ['normal', 'degraded'].includes(existingVerdict))) {
        if (!launch.acknowledged) tracking.acknowledge(launch);
        if (dispatchToken) tracking.finishDispatch(dispatchToken, String(launch.origin_key));
        return receipt();
      }
      if (input.__prepareOnly === true) return { phase: 'dispatch', ref: String(launch.ref), dispatchToken: String(dispatchToken || ''), args, receipt: receipt() };
      try {
        const authorize = () => store.withMcpActionAuthorizationSync(session.actorId, session.scope, request.operation, () => {
          tracking.origin(session.actorId, request.piToolFence?.operationId || session.intelligenceOperationId);
        });
        if (request.piToolFence) store.withPiToolInvocationFenceSync(request.piToolFence.operationId, request.piToolFence.invocationId, {
          ownerId: request.piToolFence.ownerId, generation: request.piToolFence.ownerGeneration
        }, authorize);
        else authorize();
        const result = await supervisor.executeTelegramEditorCommand('solopreneur.internalStartConversation', args);
        if ((result as { status?: string })?.status !== 'started') throw new Error('conversation_not_started');
        tracking.acknowledge(launch);
        return receipt();
      } catch (error) {
        tracking.fail(String(launch.ref), error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        if (dispatchToken) tracking.finishDispatch(dispatchToken, String(launch.origin_key));
      }
    }
    if (!['write', 'read', 'search', 'link', 'context', 'export'].includes(request.operation)) throw new Error('action_denied');
    if (request.operation === 'write' || request.operation === 'link') {
      return publishRuntimeMutation(request);
    }
    store.authorizeMcpAction(session.actorId, session.scope, request.operation);
    if (session.runIdentity) store.authorizedLearningReviewBatch(session.scope, session.runIdentity);
    if (request.operation === 'search' && input.scope !== session.scope) throw new Error('scope_denied');
    if (request.operation === 'context' && input.project !== session.scope) throw new Error('scope_denied');
    for (const key of request.operation === 'link' ? ['source', 'target'] : ['ref', 'objectId']) {
      if (input[key] && !allowedRead(store.readMetadata(normalizeObjectReference(input[key])), session)) throw new Error('scope_denied');
    }
    return store.withActor(session.actorId, async () => {
      const sourceState = session.runIdentity && ['read', 'context'].includes(request.operation) ? store.authorizedRunState(session.scope, session.runIdentity) : null;
      const result = await dispatch(request, session);
      const delivered = (value: unknown, objects: DataObject[]): unknown => {
        if (!session.runIdentity) return value;
        const lessons = objects.filter(item => {
          if (item.kind !== 'lesson' || item.data.status !== 'approved') return false;
          const current = store.readMetadata(item.objectId);
          return current.archivedAt === null && current.data.status === 'approved' && current.revision === item.revision && allowedRead(current, session);
        })
          .map(item => ({ objectId: item.objectId, revision: item.revision }));
        if (!lessons.length) return value;
        const state = store.authorizedRunState(session.scope, session.runIdentity);
        if (!sourceState || sourceState.runId !== state.runId || sourceState.turnId !== state.turnId || sourceState.generation !== state.generation) return value;
        if (store.readMetadata(state.turnId).data.finished_at != null) return value;
        return { ...(value as Record<string, unknown>), __solomapLearningDelivery: signLearningDelivery({ sessionToken: request.sessionToken!, actorId: session.actorId, projectId: session.scope, runId: state.runId, turnId: state.turnId, lessons, ...(request.piToolFence ? { piToolFence: request.piToolFence } : {}) }, deliverySecret) };
      };
      if (request.operation === 'read') {
        const value = result as DataObject | { object: DataObject };
        if (!allowedRead('object' in value ? value.object : value, session)) throw new Error('scope_denied');
        return delivered('object' in value ? { ...value, object: agentObject(value.object) } : agentObject(value), 'object' in value ? [] : [value]);
      }
      if (request.operation === 'context') {
        const context = result as { items: DataObject[] };
        const items = context.items.filter(item => allowedRead(item, session));
        return delivered({ ...context, items }, items);
      }
      return result;
    });
  };
  const performOperation = async (request: RuntimeDataRequest): Promise<unknown> => {
    if (request.operation === 'set_intelligence_time_schedule') {
      if (!request.piToolFence) throw new Error('pi_tool_invocation_fenced');
      const { operationId, invocationId, ownerId, ownerGeneration } = request.piToolFence;
      return store.publishPiTimeSchedule(request.input, { operationId, invocationId, owner: { ownerId, generation: ownerGeneration } });
    }
    if (!request.piToolFence || request.operation === 'start_conversation') return executeOperation(request);
    if(request.operation==='write' || request.operation==='link')return publishRuntimeMutation(request,true);
    const owner = { ownerId: request.piToolFence.ownerId, generation: request.piToolFence.ownerGeneration };
    return store.withPiToolInvocationGuard(request.piToolFence.operationId, request.piToolFence.invocationId, owner, () => executeOperation(request));
  };
  const operations = async (request:RuntimeDataRequest):Promise<unknown> => {
    if(!recyclingProjectScopeOperations.has(request.operation))return performOperation(request);
    const plan=store.createRecyclingProjectScopePlan();
    let resolveDone!:()=>void;const done=new Promise<void>(resolve=>{resolveDone=resolve;});
    recyclingScopeFlights.add(done);recyclingScopeRevision++;
    let outcome:{failed:boolean;value:unknown}|undefined;
    const cleanup=():unknown=>{
      if(store.releaseRecyclingProjectScopePlanBatch(plan,128))return continueRuntimeWork(async()=>cleanup());
      recyclingScopeFlights.delete(done);resolveDone();
      if(outcome!.failed)throw outcome!.value;
      return outcome!.value;
    };
    const advance=async():Promise<unknown>=>{
      try{outcome={failed:false,value:await store.withRecyclingProjectScopePlan(plan,()=>performOperation(request))};}
      catch(error){
        if(error instanceof RecyclingProjectScopePending)return continueRuntimeWork(async()=>{
          try{await store.prepareRecyclingProjectScope(plan,error.candidate);}
          catch(preparationError){outcome={failed:true,value:preparationError};return cleanup();}
          return continueRuntimeWork(advance);
        });
        outcome={failed:true,value:error};
      }
      return cleanup();
    };
    const initial=await advance();
    if(execution.storageContinuations || !readRuntimeWorkContinuation(initial))return initial;
    standaloneStorageScheduler ||= new RuntimeExecutionScheduler();
    let admitted=false;
    try{return await standaloneStorageScheduler.submit('maintenance',async()=>{admitted=true;return initial;},{label:`standalone:${request.operation}`});}
    catch(error){
      if(!admitted){store.releaseRecyclingProjectScopePlanBatch(plan,128);recyclingScopeFlights.delete(done);resolveDone();}
      throw error;
    }
  };
  return Object.assign(operations, {
    setStorageMaintenanceBarrier: (barrier: Promise<unknown>) => { storageMaintenanceBarrier = barrier; },
    setIntelligenceRuntime: (runtime: IntelligenceRuntimeActions) => { intelligenceRuntime = runtime; },
    recoverMigrations: () => migrations.recover(), recoverRuns: () => { store.conversationTracking().recoverDispatches(); runs.start(); }, interruptMigrations: () => migrations.interrupt(), interruptRuns: () => runStops.interrupt(),
    waitForMigrations: () => migrations.wait(),
    quiesceForDatabaseGeneration: async () => {
      migrations.interrupt();
      runStops.interrupt();
      await intelligenceRuntime?.close();
      await storageMaintenanceTail;
      await Promise.all(recyclingScopeFlights);
      await store.waitForStorageLifecycle();
      await runs.close();
      await migrations.close();
    },
    close: async () => { await intelligenceRuntime?.close(); await storageMaintenanceTail;await Promise.all(recyclingScopeFlights); await store.waitForStorageLifecycle(); await runs.close(); await migrations.close(); }
  });
}

export function runtimeMcpSource(globalDataPath: string, scope: string | null, globalReads = false, runIdentity?: McpRunIdentity, intelligenceOperationId?: string,
  transport: (request: RuntimeDataRequest) => Promise<unknown> = request => sendRuntimeDataRequest(globalDataPath, request)): UnifiedMcpSource {
  type McpSession = { actorId: string; proof: string; sessionToken: string; readAuthority: string; runKind: string; migrationKind: string | null };
  let session: McpSession | undefined;
  let resume: { actorId: string; proof: string } | undefined;
  let openRequestId = crypto.randomUUID();
  let opening: Promise<void> | undefined;
  let piToolFence: RuntimeDataRequest['piToolFence'];
  const establish = async (): Promise<void> => {
    if (session) return;
    if (!opening) opening = (transport({ operation: 'open_mcp_session', input: { projectId: scope, openRequestId, ...(runIdentity ? { runIdentity } : {}), ...(resume ? { resume } : {}), ...(intelligenceOperationId ? { intelligenceOperationId } : {}) } }) as Promise<McpSession>).then(value => {
      session = value;
      resume = value ? { actorId: value.actorId, proof: value.proof } : resume;
    }).finally(() => { opening = undefined; });
    await opening;
  };
  const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
  const retryableHandshake = (error: unknown): boolean => /(?:ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|runtime_data_response_incomplete|Invalid Runtime endpoint|ENOENT|different_runtime)/.test(errorMessage(error));
  const safeReplay = (operation: string, input: Record<string, unknown>): boolean =>
    ['read', 'search', 'context', 'project_signals', 'get_conversation', 'migration_overview', 'migration_status', 'read_recycling_plan'].includes(operation) ||
    operation === 'checkpoint_current_run' ||
    (['write', 'link', 'export', 'start_conversation'].includes(operation) && typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0);
  const retryOperation = (error: unknown, operation: string, input: Record<string, unknown>): { retry: boolean; resetSession: boolean } => {
    const message = errorMessage(error);
    if (/(?:mcp_session_expired|mcp_read_authority_invalid|different_runtime)/.test(message)) return { retry: true, resetSession: true };
    const preconnect = Boolean((error as NodeJS.ErrnoException & { runtimeDataPreconnect?: boolean })?.runtimeDataPreconnect) || /(?:ECONNREFUSED|Invalid Runtime endpoint|ENOENT)/.test(message);
    if (preconnect) return { retry: true, resetSession: false };
    const ambiguous = /(?:ECONNRESET|EPIPE|socket hang up|runtime_data_response_incomplete)/.test(message);
    return { retry: ambiguous && safeReplay(operation, input), resetSession: false };
  };
  return { scope, globalReads, setPiToolFence(fence) { piToolFence = fence; }, async sessionInfo() {
    const deadline = Date.now() + 10_000;
    for (let attempt = 1; !session; attempt += 1) {
      try { await establish(); }
      catch (error) {
        if (!retryableHandshake(error) || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(250, attempt * 50)));
      }
    }
    return { runKind: String(session!.runKind || ''), migrationKind: session!.migrationKind || null };
  }, async close() {
    if (opening) await opening;
    try { if (session) await transport({ operation: 'close_mcp_session', input: { sessionToken: session.sessionToken } }); }
    finally { session = undefined; resume = undefined; openRequestId = crypto.randomUUID(); }
  }, async call(operation, input) {
    const deadline = Date.now() + 10_000;
    for (let attempt = 1; ; attempt += 1) {
      if (!session) {
        try { await establish(); }
        catch (error) {
          if (!retryableHandshake(error) || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(250, attempt * 50)));
          continue;
        }
      }
      const attempted = session!;
      try {
        const result = await transport({ operation, input, sessionToken: attempted.sessionToken,
          ...(attempted.readAuthority ? { readAuthority: attempted.readAuthority } : {}), ...(piToolFence ? { piToolFence } : {}) });
        if (result && typeof result === 'object' && '__solomapLearningDelivery' in result) {
          const { __solomapLearningDelivery, ...body } = result as Record<string, unknown>;
          const payload = JSON.parse(Buffer.from(String(__solomapLearningDelivery).split('.')[0], 'base64url').toString('utf8')) as { lessons: unknown[] };
          for (let offset = 0; offset < payload.lessons.length; offset += 20) {
            await transport({ operation: 'record_learning_delivery', input: { receipt: __solomapLearningDelivery, offset }, sessionToken: attempted.sessionToken, ...(piToolFence ? { piToolFence } : {}) });
          }
          return body;
        }
        return result;
      } catch (error) {
        const decision = retryOperation(error, operation, input);
        if (!decision.retry || Date.now() >= deadline) throw error;
        if (decision.resetSession && session === attempted) session = undefined;
        await new Promise(resolve => setTimeout(resolve, Math.min(250, attempt * 50)));
      }
    }
  } };
}

export async function runtimeProjectMcpSource(globalDataPath: string, projectRoot: string, intelligenceOperationId?: string,
  transport: (request: RuntimeDataRequest) => Promise<unknown> = request => sendRuntimeDataRequest(globalDataPath, request)): Promise<UnifiedMcpSource | undefined> {
  if (!fs.existsSync(path.join(globalDataPath, 'solomap.db'))) return undefined;
  const existing = await transport({ operation: 'resolve_project_signals_scope', input: { root: projectRoot } }) as { projectId: string | null };
  if (!existing.projectId && !projectRoot) return undefined;
  const project = existing.projectId ? existing : await transport({ operation: 'register_project', input: { root: projectRoot } }) as { projectId: string };
  const source = runtimeMcpSource(globalDataPath, project.projectId, true, undefined, intelligenceOperationId, transport);
  if (projectRoot && fs.existsSync(projectRoot)) return source;
  return { ...source, projectSignalsOnly: true, call: (operation, input) => {
    if (!['project_signals', 'start_conversation', 'get_conversation'].includes(operation)) return Promise.reject(new Error('action_denied'));
    return source.call(operation, input);
  } };
}

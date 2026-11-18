import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { readRegisteredTaskSources } from './growthReports.js';
import { extractClaudeTranscriptUsage, extractCodexTranscriptUsage, extractTokenUsageFromOutput } from './tokenUsage.js';
import { canonicalJson } from './contentReferences.js';
import { mergeProjectRegistryPatch, normalizeProjectsForStorage, projectName, type ProjectRegistryBootstrap, type ProjectRegistryFile, type ProjectRegistryPatch, type ProjectRegistrySnapshot } from './projectRegistry.js';
import type { DataObject, DataWrite, HistoricalRunIndexInput, LegacyProjectJournalInput, RunIndexBackfillCandidate, UnifiedDataStore } from './db/unifiedDataStore.js';
import type { RunIndexFile, RunIndexRecord, RunIndexSignal } from './db/types.js';
import type { DataWriteDatabaseIdentity, PreparedMutationReplay, RecordedObjectRead } from './db/dataWritePublication.js';
import type { DataValueTransfer } from './db/dataValueTransfer.js';
import type { PreparedRunSettlementDigest, RunDigestPublicationRequest } from './db/runSettlementPublication.js';
import type { PiTimeSchedulePlan, PiTimeSchedulePreparation, PreparedScheduleClaims, ScheduleClaimPreparation, PreparedScheduleSettlement, ScheduleSettlementPreparation } from './db/schedulePublication.js';
import type { SqlValue } from './db/diskDatabase.js';
import { SqliteStore } from './db/sqliteStore.js';
import { resolveLegacyProjectScope, type MemoryImportOptions } from './memoryDatabaseMigration.js';
import type { HostSecretMigrationPreparation, PreparedHostSecretMigration, LegacyTelegramStartupPreparation, PreparedLegacyTelegramStartup } from './db/hostSettingsPublication.js';

type ArchivedArtifact = { bytes: Uint8Array; hash: string; mimeType: string };
type ArtifactAddress = { projectId: string; executionLogId: number; relativePath: string };
type LegacyProjectSqliteSchema = 'journal' | 'growth';
export interface LegacyProjectSqliteIdentity {
  device: string;
  inode: string;
  size: string;
  modified: string;
}
type LegacyProjectSqliteFile = { file: string; identity?: LegacyProjectSqliteIdentity };
export type LegacyGrowthProjectionSource = {file:string;identity:LegacyProjectSqliteIdentity;key:string};
type LegacyGrowthProjectionPlan = {state:'unchanged'|'conflict'} | {state:'publish';valueJson:string};
export interface PreparedRegistryContext {
  bytes: Uint8Array;
  hash: string;
  patch?: { input: ProjectRegistryPatch; registry: ProjectRegistryFile; content: string; inputHash: string };
  patchFailure?: { name: string; message: string; code?: string };
}
export type RegistryPatchReplayRequest = DataWriteDatabaseIdentity & { input: ProjectRegistryPatch; actorId: string };
export interface PreparedRegistryPatchReplay extends RecordedObjectRead {
  inputHash: string;
  replay?: PreparedMutationReplay;
  replayFailure?: { name: string; message: string; code?: string };
  resultFailure?: { name: string; message: string; code?: string };
  result?: { snapshot: ProjectRegistrySnapshot; registryJson: string };
}
export interface RegistryMetadataTarget {
  root: string;
  physicalRoot?: string;
  projectId?: string;
  revision?: number;
  locationFailure?: {name:string;message:string;code?:string};
  metadata?: { project: ProjectRegistryFile['projects'][number]; hidden: boolean };
}
export interface RegistryMoveLocation {
  projectId:string;
  physicalRoot:string;
  retiredRoots:string[];
}
export type RegistryMetadataTargetsRequest = DataWriteDatabaseIdentity & {
  registry: ProjectRegistryFile; roots?: string[]; previous?: ProjectRegistryFile; move?:RegistryMoveLocation;
};
export type RegistryMetadataDraftRequest = DataWriteDatabaseIdentity & {
  target: RegistryMetadataTarget; previous?: DataObject;
};
type Inspection = {
  stableFile: { input: { file: string }; result: { bytes: Uint8Array; hash: string } };
  stableLearningFile: {input:{file:string;boundary?:string};result:{bytes:Uint8Array;hash:string}};
  legacyReviewJson: {input:{bytes:Uint8Array};result:any};
  autonomyFile: {input:{file:string;key:string;projectId?:string};result:Awaited<ReturnType<typeof inspectProjectAutonomyFile>>};
  fileDetails: { input: { file: string }; result: { byteLength: number; hash: string } };
  legacyProjectSqliteBackup: { input: LegacyProjectSqliteFile & { destination: string; schema: LegacyProjectSqliteSchema }; result: LegacyProjectSqliteIdentity };
  legacyJournalLastId: { input: LegacyProjectSqliteFile; result: number };
  legacyJournalPage: { input: LegacyProjectSqliteFile & { offset: number }; result: ReturnType<SqliteStore['getExecutionJournalPageRaw']> };
  legacyJournalIndexPage: { input: LegacyProjectSqliteFile & { offset: number }; result: ReturnType<SqliteStore['getRunIndexEntries']> };
  legacyProjectJournalPublication: { input: {value:DataWriteDatabaseIdentity & {input:LegacyProjectJournalInput}}; result:ReturnType<UnifiedDataStore['prepareLegacyProjectJournal']> };
  legacyGrowthSnapshotIds: { input: LegacyProjectSqliteFile; result: string[] };
  legacyGrowthSnapshot: { input: LegacyProjectSqliteFile & { id: string }; result: ReturnType<SqliteStore['getGrowthSnapshotById']> };
  legacyGrowthProjectionKeys: { input: LegacyProjectSqliteFile; result: string[] };
  legacyGrowthProjectionValue: { input: LegacyGrowthProjectionSource; result: {value:unknown}|undefined };
  legacyGrowthProjectionPublication: { input: {value:DataWriteDatabaseIdentity & {projectId:string;source:LegacyGrowthProjectionSource}}; result: LegacyGrowthProjectionPlan };
  digest: { input: { bytes: Uint8Array }; result: string };
  json: { input: { value: string | Uint8Array; firstLine?: boolean }; result: any };
  tasks: { input: { projectRoot: string }; result: ReturnType<typeof readRegisteredTaskSources> };
  archivedArtifact: { input: ArtifactAddress & { verifyHash?: true }; result: ArchivedArtifact | null };
  appendedOutput: { input: ArtifactAddress & { bytes: Uint8Array }; result: boolean };
  outputUsage: { input: { output: string; agentCli: string }; result: ReturnType<typeof extractTokenUsageFromOutput> };
  transcriptPaths: { input: { bytes: Uint8Array }; result: string[] };
  transcriptUsage: { input: { bytes: Uint8Array; codex: boolean; startedAt: string; finishedAt: string }; result: ReturnType<typeof extractCodexTranscriptUsage> };
  registryFile: { input: { file: string; late?: true }; result: { bytes: Uint8Array; hash: string; legacy: Partial<ProjectRegistryFile> | null } | null };
  canonicalObject: { input: { value: unknown }; result: { bytes: Uint8Array; hash: string } };
  canonicalHash: { input: { value: unknown }; result: string };
  initialRegistry: { input: { input: ProjectRegistryBootstrap; legacy: Partial<ProjectRegistryFile>; now: string }; result: { registry: ProjectRegistryFile; write: DataWrite } };
  registryContext: { input: { input: ProjectRegistryBootstrap; current: { registry: ProjectRegistryFile; revision: number }; fileImported: boolean; now: string }; result: PreparedRegistryContext };
  registrySnapshot: { input: { value: DataWriteDatabaseIdentity }; result: { snapshot: ProjectRegistrySnapshot; registryJson: string } | null };
  firstRegistrationMetadata: { input: { value: DataWriteDatabaseIdentity & { projectId: string; root: string; registryRoot: string } }; result: DataWrite | undefined };
  registryMetadataTargets: { input: { value: RegistryMetadataTargetsRequest }; result: RegistryMetadataTarget[] };
  registryMetadataDraft: { input: { value: RegistryMetadataDraftRequest }; result: { write?: DataWrite; inputHash?: string; oldNotesId?: string } };
  registryPatchReplay: { input: { value: RegistryPatchReplayRequest }; result: PreparedRegistryPatchReplay };
  projectAutonomy: { input: { value: Parameters<UnifiedDataStore['prepareProjectAutonomy']>[0] }; result: ReturnType<UnifiedDataStore['prepareProjectAutonomy']> };
  registryMove: { input: {value:Parameters<UnifiedDataStore['prepareRegistryMove']>[0]}; result:ReturnType<UnifiedDataStore['prepareRegistryMove']> };
  lateRegistryMatch: { input: { value: DataWriteDatabaseIdentity & { legacy: Partial<ProjectRegistryFile> } }; result: boolean };
  registryPatch: { input: { current: ProjectRegistryFile; input: ProjectRegistryPatch; now: string }; result: { registry: ProjectRegistryFile; content: string; inputHash: string } };
  runDigestPublication: { input: { value: RunDigestPublicationRequest }; result: PreparedRunSettlementDigest };
  runIndexBackfillCandidates: { input: { value: DataWriteDatabaseIdentity & { projectId: string; limit: number } }; result: ReturnType<UnifiedDataStore['selectRunIndexBackfillCandidates']> };
  runIndexBackfill: { input: { value: DataWriteDatabaseIdentity & { projectId: string; candidates: RunIndexBackfillCandidate[] } }; result: ReturnType<UnifiedDataStore['prepareRunIndexBackfillPublication']> };
  historicalRunIndex: { input: { value: DataWriteDatabaseIdentity & { input:HistoricalRunIndexInput } }; result: ReturnType<UnifiedDataStore['prepareHistoricalRunIndex']> };
  formalRunIndex: { input: { value:DataWriteDatabaseIdentity & {record:RunIndexRecord;files:RunIndexFile[];signals:RunIndexSignal[]} }; result:ReturnType<UnifiedDataStore['encodeRunIndex']> };
  linkedJournal: { input: {value:Parameters<UnifiedDataStore['readLinkedJournal']>[0]}; result:ReturnType<UnifiedDataStore['readLinkedJournal']> };
  capturedMigrationSource: {input:{value:DataWriteDatabaseIdentity & {identity:string;key:string}};result:ReturnType<UnifiedDataStore['readMigrationSource']>};
  capturedLegacyReviewJson: {input:{value:DataWriteDatabaseIdentity & {identity:string;key:string}};result:any};
  migrationSourceJsonVersion: {input:{value:Parameters<UnifiedDataStore['prepareMigrationSourceJsonVersion']>[0]};result:ReturnType<UnifiedDataStore['prepareMigrationSourceJsonVersion']>};
  piTimeSchedule: { input: { value: PiTimeSchedulePreparation }; result: PiTimeSchedulePlan };
  scheduleClaimCandidates: { input: { value: DataWriteDatabaseIdentity & { now: number; limit: number } }; result: Array<Record<string, SqlValue>> };
  scheduleClaims: { input: { value: ScheduleClaimPreparation }; result: PreparedScheduleClaims };
  scheduleSettlement: { input: { value: ScheduleSettlementPreparation }; result: PreparedScheduleSettlement };
  hostSecretMigration: { input: { value: HostSecretMigrationPreparation }; result: PreparedHostSecretMigration };
  legacyTelegramStartup: { input: {value:LegacyTelegramStartupPreparation}; result:PreparedLegacyTelegramStartup };
  runtimeStateFile: { input: { file: string; mode: 'json' | 'jsonl' | 'telegram-config' | 'telegram-state'; secretRef?: string };
    result: { bytes: Uint8Array; hash: string; value?: Record<string, unknown>; feedback?: unknown[]; token?: string; error?: string } | null };
};

export type ProjectMigrationInspectionKind = keyof Inspection;
export type ProjectMigrationInspection<K extends ProjectMigrationInspectionKind = ProjectMigrationInspectionKind> =
  { [P in K]: { kind: P } & Inspection[P]['input'] }[K];
export type ProjectMigrationInspectionResult<K extends ProjectMigrationInspectionKind> = Inspection[K]['result'];
export type ProjectMigrationInspectionReply<K extends ProjectMigrationInspectionKind> =
  { value: ProjectMigrationInspectionResult<K> } | { valueTransfer:DataValueTransfer } | { failure: { message: string; code?: string } };
export type ProjectMigrationInspectionCompute = <K extends ProjectMigrationInspectionKind>(
  request: ProjectMigrationInspection<K>
) => Promise<ProjectMigrationInspectionReply<K>>;

export class ProjectMigrationInspectionUnavailable extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ProjectMigrationInspectionUnavailable';
  }
}

export function isMaintenanceComputeExit(error:unknown):boolean {
  return error instanceof Error && error.message.startsWith('maintenance_compute_exited:');
}

export async function retryMaintenanceComputeExit<T>(run:()=>Promise<T>):Promise<T> {
  try{return await run();}
  catch(error){if(!isMaintenanceComputeExit(error))throw error;return run();}
}

type ArtifactReader = (address: ArtifactAddress) => ArchivedArtifact | null;

const digest = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const asBuffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

async function stableFile(file: string): Promise<{ bytes: Buffer; hash: string }> {
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('migration_source_invalid');
  const bytes = await fs.promises.readFile(file);
  const after = await fs.promises.lstat(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('migration_source_changed');
  }
  return { bytes, hash: digest(bytes) };
}

async function stableLearningFile(file: string, boundary?: string): Promise<{ bytes: Buffer; hash: string }> {
  const confined = async (): Promise<void> => {
    if (!boundary) return;
    const relative = path.relative(boundary, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('migration_source_invalid');
    let current = boundary;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new Error('migration_source_invalid');
    }
    if (await fs.promises.realpath(file) !== path.resolve(file)) throw new Error('migration_source_invalid');
  };
  await confined();
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('migration_source_invalid');
  const bytes = await fs.promises.readFile(file); const after = await fs.promises.lstat(file);
  await confined();
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) throw new Error('source_changed_during_read');
  return { bytes, hash: digest(bytes) };
}

export function parseLegacyReviewSourceJson(bytes:Uint8Array):any {
  const source=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength),text=source.toString('utf8');
  if(!Buffer.from(text).equals(source))throw new Error('legacy_review_encoding_invalid');
  try{return JSON.parse(text.replace(/^\uFEFF/,''));}
  catch{throw new Error('legacy_review_encoding_invalid');}
}

export function lessonSource(bytes: Buffer, options: MemoryImportOptions): { id: string; scope: string; updatedAt: number; data: Record<string, unknown> } {
  let entry: any;
  try { entry = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('legacy_lesson_invalid'); }
  if (!entry || entry.schemaVersion !== 1 || typeof entry.id !== 'string' || !entry.id || typeof entry.projectPath !== 'string' || !path.isAbsolute(entry.projectPath) || !['candidate', 'approved', 'promoted', 'rejected'].includes(entry.status) || ['summary', 'appliesWhen', 'doThis', 'avoidThis'].some(key => typeof entry[key] !== 'string') || !Array.isArray(entry.evidenceRefs) || entry.evidenceRefs.some((ref: any) => !ref || typeof ref.type !== 'string' || typeof ref.ref !== 'string')) throw new Error('legacy_lesson_invalid');
  const scope = resolveLegacyProjectScope(options, path.resolve(entry.projectPath));
  if (!scope) throw new Error('project_scope_mapping_required');
  const timestamp = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;
    const result = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(result)) throw new Error('legacy_lesson_timestamp_invalid');
    return result;
  };
  const updatedAt = timestamp(entry.updatedAt); const createdAt = timestamp(entry.createdAt);
  const confidence = typeof entry.confidence === 'number' ? entry.confidence : ({ low: 0, medium: 0.5, high: 1 } as Record<string, number>)[entry.confidence] ?? 0;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('legacy_lesson_confidence_invalid');
  if (entry.sourceEventIds !== undefined && (!Array.isArray(entry.sourceEventIds) || entry.sourceEventIds.some((id: unknown) => typeof id !== 'string'))) throw new Error('legacy_lesson_events_invalid');
  return { id: entry.id, scope, updatedAt: updatedAt ?? 0, data: {
    status: entry.status, summary: entry.summary, applies_when: entry.appliesWhen, do_this: entry.doThis, avoid_this: entry.avoidThis,
    does_not_apply_when: entry.doesNotApplyWhen ?? null, verification: entry.verification ?? null, confidence,
    lesson_type: entry.lessonType ?? null, source_type: entry.sourceType ?? null, promotion_target: entry.promotionTarget ?? null,
    evidence_refs_json: entry.evidenceRefs, source_event_ids_json: entry.sourceEventIds ?? [], legacy_lesson_id: entry.id,
    external_created_at: createdAt, external_updated_at: updatedAt,
    external_confidence: typeof entry.confidence === 'string' ? entry.confidence : null,
    semantic_review_json: entry.semanticReview ?? null
  } };
}

export interface HistoricalLessonIdentity {id:string;scope:string;projectScopes?:Record<string,string>}

export function prepareHistoricalLessonAfterImage(bytes:Buffer,jsonHash:string,lesson:HistoricalLessonIdentity):string {
  const parsed=lessonSource(bytes,{projectScopes:lesson.projectScopes});
  const content=JSON.stringify(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')));
  if(parsed.id!==lesson.id || parsed.scope!==lesson.scope || digest(Buffer.from(content))!==jsonHash)throw new Error('legacy_review_lesson_after_invalid');
  return content;
}

async function inspectProjectAutonomyFile(file:string,key:string,projectId?:string) {
  const before=await fs.promises.lstat(file);
  if(!before.isFile() || before.isSymbolicLink())throw new Error('migration_source_invalid');
  const handle=await fs.promises.open(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes:Buffer;
  try{
    const opened=await handle.stat();
    if(opened.dev!==before.dev || opened.ino!==before.ino)throw new Error('migration_source_changed');
    bytes=await handle.readFile();
    const after=await handle.stat();
    if(after.size!==before.size || after.mtimeMs!==before.mtimeMs)throw new Error('migration_source_changed');
  }finally{await handle.close();}
  const hash=digest(bytes),candidates:Array<{projectId:string;projectPath:string;enabled:boolean;toolNetworkDisabled:boolean;epoch:number;updatedAt:string}>=[];
  const conflicts:Array<{key:string;error:string}>=[];
  const message=(error:unknown)=>error instanceof Error?error.message:String(error);
  const normalize=(id:string,value:unknown)=>{
    if(!/^[a-f0-9]{64}$/.test(id) || !value || typeof value!=='object')throw new Error('project_autonomy_source_invalid');
    const record=value as Record<string,unknown>,requested=String(record.projectPath || '').trim();
    if(!requested)throw new Error('project_autonomy_source_invalid');
    let projectPath:string;
    try{projectPath=fs.realpathSync(requested);}catch{projectPath=path.resolve(requested);}
    if(digest(Buffer.from(projectPath))!==id || record.projectId!==undefined && String(record.projectId)!==id)throw new Error('project_autonomy_identity_invalid');
    const epoch=Number(record.epoch || 0);
    if(!Number.isInteger(epoch) || epoch<0)throw new Error('project_autonomy_source_invalid');
    return {projectId:id,projectPath,enabled:Boolean(record.enabled),toolNetworkDisabled:Boolean(record.toolNetworkDisabled),epoch,updatedAt:String(record.updatedAt || '')};
  };
  try{
    const parsed=JSON.parse(bytes.toString('utf8'));
    if(projectId!==undefined)candidates.push(normalize(projectId,parsed));
    else{
      if(parsed.schemaVersion!==1 || !parsed.projects || typeof parsed.projects!=='object' || Array.isArray(parsed.projects))throw new Error('project_autonomy_source_invalid');
      for(const [id,value] of Object.entries(parsed.projects)){
        try{candidates.push(normalize(id,value));}
        catch(error){conflicts.push({key:`${key}#${id}`,error:message(error)});}
      }
    }
  }catch(error){conflicts.push({key,error:message(error)});}
  return {bytes,hash,candidates,conflicts};
}

async function migrationFileIdentity(file:string):Promise<LegacyProjectSqliteIdentity> {
  const stat=await fs.promises.lstat(file,{bigint:true});
  if(!stat.isFile() || stat.isSymbolicLink())throw new Error('migration_source_invalid');
  return {device:String(stat.dev),inode:String(stat.ino),size:String(stat.size),modified:String(stat.mtimeNs)};
}

async function stableFileDetails(file:string):Promise<{byteLength:number;hash:string}> {
  const before=await migrationFileIdentity(file),handle=await fs.promises.open(file,'r');
  try{
    const opened=await handle.stat({bigint:true});
    if(String(opened.dev)!==before.device || String(opened.ino)!==before.inode)throw new Error('migration_source_changed');
    const hash=crypto.createHash('sha256');
    let byteLength=0;
    for await(const chunk of handle.createReadStream({autoClose:false})){
      hash.update(chunk);byteLength+=chunk.length;
    }
    const after=await migrationFileIdentity(file);
    if(Object.entries(before).some(([key,value])=>after[key as keyof LegacyProjectSqliteIdentity]!==value)
      || String(byteLength)!==before.size)throw new Error('migration_source_changed');
    return {byteLength,hash:hash.digest('hex')};
  }finally{await handle.close();}
}

async function readLegacyProjectSqlite<T>(input:LegacyProjectSqliteFile,schema:LegacyProjectSqliteSchema,read:(store:SqliteStore)=>T|Promise<T>):Promise<T> {
  const before=await migrationFileIdentity(input.file);
  const check=(actual:LegacyProjectSqliteIdentity)=>{
    if(actual.device!==before.device || actual.inode!==before.inode ||
      input.identity && Object.entries(input.identity).some(([key,value])=>actual[key as keyof LegacyProjectSqliteIdentity]!==value))throw new Error('migration_source_changed');
  };
  check(before);
  const store=new SqliteStore(input.file,path.resolve(__dirname,'..'));
  try{
    if(schema==='journal')await store.initJournalReadOnly();else await store.initReadOnly();
    check(await migrationFileIdentity(input.file));
    const result=await read(store);
    check(await migrationFileIdentity(input.file));
    return result;
  }finally{store.close();}
}

export function projectRegistryContextIntent(input: ProjectRegistryBootstrap, current: { registry: ProjectRegistryFile; revision: number }, fileImported: boolean, hash: string): ProjectRegistryPatch | null {
  const additions = fileImported ? [] : normalizeProjectsForStorage(input.legacyProjects || []).filter(project => path.isAbsolute(project.path) && !current.registry.projects.some(existing => existing.path === project.path));
  const workspace = String(input.workspaceRoot || '').trim();
  if (workspace && path.isAbsolute(workspace) && !current.registry.projects.some(project => project.path === workspace) && !additions.some(project => project.path === workspace) && !(input.legacyHiddenProjects || []).includes(workspace)) additions.push({ name: projectName(workspace), path: workspace });
  const selected = String(input.legacySelectedProjectPath || '');
  const seedSelection = current.revision === 1 && !current.registry.selectedProjectPath && selected && [...current.registry.projects, ...additions].some(project => project.path === selected);
  const hiddenPatches = fileImported ? [] : (input.legacyHiddenProjects || []).filter(projectPath => path.isAbsolute(projectPath) && !current.registry.hiddenProjects.includes(projectPath)).map(projectPath => ({ path: projectPath, hidden: true }));
  return additions.length || hiddenPatches.length || seedSelection ? {
    expectedRevision: current.revision, projectPatches: additions.map(({ path: projectPath, ...fields }) => ({ path: projectPath, fields })), hiddenPatches,
    ...(seedSelection ? { selectedProjectPath: selected } : {}), idempotencyKey: `project-registry-context:${hash}`
  } : null;
}

export function matchingLegacyRegistry(legacy: Partial<ProjectRegistryFile>, current: ProjectRegistryFile): boolean {
  const comparable = (registry: Partial<ProjectRegistryFile>) => ({
    projects: normalizeProjectsForStorage(registry.projects || []),
    hiddenProjects: [...new Set((registry.hiddenProjects || []).map(item => String(item).trim()).filter(Boolean))].sort(),
    selectedProjectPath: String(registry.selectedProjectPath || '')
  });
  return canonicalJson(comparable(legacy)) === canonicalJson(comparable(current));
}

function prepareRegistryPatch(current: ProjectRegistryFile, input: ProjectRegistryPatch, now: string) {
  const {expectedRevision:_expectedRevision,...intent}=input;
  const registry=mergeProjectRegistryPatch(current,input,now);
  const content=canonicalJson(registry);
  return {registry:JSON.parse(content) as ProjectRegistryFile,content,inputHash:digest(Buffer.from(canonicalJson({operation:'patch_project_registry',input:intent})))};
}

export async function inspectProjectMigration(
  request: ProjectMigrationInspection,
  readArtifact: ArtifactReader
): Promise<ProjectMigrationInspectionResult<ProjectMigrationInspectionKind>> {
  switch (request.kind) {
    case 'stableFile':
      return stableFile(request.file);
    case 'stableLearningFile':
      return stableLearningFile(request.file,request.boundary);
    case 'legacyReviewJson':
      return parseLegacyReviewSourceJson(request.bytes);
    case 'autonomyFile':
      return inspectProjectAutonomyFile(request.file,request.key,request.projectId);
    case 'fileDetails':
      return stableFileDetails(request.file);
    case 'legacyProjectSqliteBackup':
      return readLegacyProjectSqlite(request,request.schema,async store=>{
        await store.backup(request.destination);
        return migrationFileIdentity(request.destination);
      });
    case 'legacyJournalLastId':
      return readLegacyProjectSqlite(request,'journal',store=>store.getLastExecutionLogId());
    case 'legacyJournalPage':
      return readLegacyProjectSqlite(request,'journal',store=>store.getExecutionJournalPageRaw({limit:200,offset:request.offset,maxPayloadBytes:2*1024*1024}));
    case 'legacyJournalIndexPage':
      return readLegacyProjectSqlite(request,'journal',store=>store.getRunIndexEntries(200,request.offset));
    case 'legacyGrowthSnapshotIds':
      return readLegacyProjectSqlite(request,'growth',store=>store.getAllGrowthSnapshotHistory().reverse().map(row=>row.id));
    case 'legacyGrowthSnapshot':
      return readLegacyProjectSqlite(request,'growth',store=>store.getGrowthSnapshotById(request.id));
    case 'legacyGrowthProjectionKeys':
      return readLegacyProjectSqlite(request,'growth',store=>store.getGrowthReportProjectionKeys(''));
    case 'legacyGrowthProjectionValue':
      return readLegacyProjectSqlite(request,'growth',store=>store.getGrowthReportProjectionValue(request.key));
    case 'digest':
      return digest(request.bytes);
    case 'json': {
      if (typeof request.value === 'string') return JSON.parse(request.value);
      const bytes = asBuffer(request.value);
      const end = request.firstLine ? bytes.indexOf(10) : -1;
      return JSON.parse(bytes.toString('utf8', 0, end < 0 ? bytes.length : end));
    }
    case 'tasks':
      return readRegisteredTaskSources(request.projectRoot);
    case 'archivedArtifact': {
      const archived = readArtifact(request);
      if (request.verifyHash && archived && digest(archived.bytes) !== archived.hash) throw new Error('historical_run_output_hash_mismatch');
      return archived;
    }
    case 'appendedOutput': {
      const archived = readArtifact(request);
      return Boolean(archived && request.bytes.length > archived.bytes.length
        && digest(archived.bytes) === archived.hash
        && digest(request.bytes.subarray(0, archived.bytes.length)) === archived.hash);
    }
    case 'outputUsage':
      return extractTokenUsageFromOutput(request.output, request.agentCli);
    case 'transcriptPaths': {
      const paths = new Set<string>();
      for (const line of asBuffer(request.bytes).toString('utf8').split(/\r?\n/)) {
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        const cwd = event?.type === 'session_meta' ? event.payload?.cwd : event.cwd;
        if (cwd) paths.add(cwd);
      }
      return [...paths];
    }
    case 'transcriptUsage': {
      const extract = request.codex ? extractCodexTranscriptUsage : extractClaudeTranscriptUsage;
      return extract(asBuffer(request.bytes).toString('utf8'), request.startedAt, request.finishedAt);
    }
    case 'registryFile': {
      let before: fs.Stats;
      try { before = await fs.promises.lstat(request.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      if (!before.isFile() || before.isSymbolicLink()) {
        if (request.late) return null;
        throw new Error('project_registry_source_invalid');
      }
      const bytes = await fs.promises.readFile(request.file);
      const after = await fs.promises.lstat(request.file);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || request.late && (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev)) {
        if (request.late) return null;
        throw new Error('project_registry_source_changed');
      }
      let legacy: Partial<ProjectRegistryFile> | null = null;
      try {
        const value = JSON.parse(bytes.toString('utf8'));
        if (value && Array.isArray(value.projects) && (value.hiddenProjects === undefined || Array.isArray(value.hiddenProjects))) legacy = value;
      } catch { /* Capture the actual unreadable source at the original Native position. */ }
      return {bytes,hash:digest(bytes),legacy};
    }
    case 'canonicalObject': {
      const bytes = Buffer.from(canonicalJson(request.value));
      return {bytes,hash:digest(bytes)};
    }
    case 'canonicalHash':
      return digest(Buffer.from(canonicalJson(request.value)));
    case 'registryPatch': return prepareRegistryPatch(request.current,request.input,request.now);
    case 'registryContext': {
      const { input, current, fileImported, now } = request;
      const bytes = Buffer.from(canonicalJson(input)), hash = digest(bytes);
      const plan: PreparedRegistryContext = { bytes, hash };
      try {
        const patch = projectRegistryContextIntent(input,current,fileImported,hash);
        if(patch)plan.patch={ input:patch, ...prepareRegistryPatch(current.registry,patch,now) };
      }catch(error){
        const failure=error instanceof Error?error:new Error(String(error));
        plan.patchFailure={name:failure.name,message:failure.message,...('code' in failure && typeof failure.code==='string'?{code:failure.code}:{})};
      }
      return plan;
    }
    case 'runDigestPublication':
    case 'runIndexBackfillCandidates':
    case 'runIndexBackfill':
    case 'historicalRunIndex':
    case 'formalRunIndex':
    case 'linkedJournal':
    case 'capturedMigrationSource':
    case 'capturedLegacyReviewJson':
    case 'migrationSourceJsonVersion':
    case 'legacyProjectJournalPublication':
    case 'piTimeSchedule':
    case 'scheduleClaimCandidates':
    case 'scheduleClaims':
    case 'scheduleSettlement':
    case 'hostSecretMigration':
    case 'legacyTelegramStartup':
    case 'registrySnapshot':
    case 'firstRegistrationMetadata':
    case 'legacyGrowthProjectionPublication':
    case 'registryMetadataTargets':
    case 'registryMetadataDraft':
    case 'registryPatchReplay':
    case 'projectAutonomy':
    case 'registryMove':
    case 'lateRegistryMatch':
      throw new Error('maintenance_database_identity_missing');
    case 'initialRegistry': {
      const {input,legacy,now} = request;
      const projects = normalizeProjectsForStorage(legacy.projects || []);
      const hiddenProjects = [...new Set((legacy.hiddenProjects || []).map(item => String(item).trim()).filter(Boolean))];
      const root = String(input.workspaceRoot || '').trim();
      if (root && !hiddenProjects.includes(root) && !projects.some(project => project.path === root)) projects.unshift({name:projectName(root),path:root});
      const selected = String(input.legacySelectedProjectPath || '');
      const registry: ProjectRegistryFile = {
        schemaVersion:1,updatedAt:String(legacy.updatedAt || now),projects,hiddenProjects,
        selectedProjectPath:projects.some(project => project.path === selected) ? selected : ''
      };
      const content = canonicalJson(registry);
      return {registry:JSON.parse(content) as ProjectRegistryFile,write:{kind:'setting',action:'create',scope:null,idempotencyKey:`initialize-project-registry:${digest(Buffer.from(content))}`,
        data:{namespace:'project_registry',key:'registry',owner_scope:'global',content}}};
    }
    case 'runtimeStateFile': {
      let before: fs.Stats;
      try { before=fs.lstatSync(request.file); }
      catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error; }
      if(!before.isFile() || before.isSymbolicLink())return null;
      const original=fs.readFileSync(request.file);
      const after=fs.lstatSync(request.file);
      if(after.dev!==before.dev || after.ino!==before.ino || after.size!==before.size || after.mtimeMs!==before.mtimeMs)throw new Error('legacy_runtime_source_changed');
      const telegram=request.mode==='telegram-config' || request.mode==='telegram-state';
      try {
        if(request.mode==='jsonl')return {bytes:original,hash:digest(original),feedback:original.toString('utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line))};
        const value=JSON.parse(original.toString('utf8'));
        if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('legacy_runtime_source_invalid');
        if(!telegram)return {bytes:original,hash:digest(original),value};
        const {botToken,...safe}=value;
        const sanitized=botToken?{...safe,botTokenSecretRef:request.secretRef,botTokenFingerprint:digest(Buffer.from(String(botToken)))}:safe;
        const bytes=Buffer.from(JSON.stringify(sanitized));
        return {bytes,hash:digest(bytes),value:sanitized,...(request.mode==='telegram-config' && botToken?{token:String(botToken)}:{})};
      }catch(error){
        const bytes=telegram?Buffer.from(JSON.stringify({redacted:true,sourceFingerprint:digest(original)})):original;
        return {bytes,hash:digest(bytes),error:telegram?'legacy_runtime_source_invalid':error instanceof Error?error.message:String(error)};
      }
    }
  }
}

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';
import { readWindowsProcessBirthMarker } from '../processIdentity.js';
import { AsyncLocalStorage } from 'async_hooks';
import { gzipSync, gunzipSync } from 'zlib';
import { DiskDatabase, SqlValue } from './diskDatabase';
import { unifiedSchemaSql } from './unifiedSchema';
import { indexTokens, queryTokens } from './searchIndex';
import { agentReadableObject, canAgentRead } from '../dataAuthorization';
import { unifiedSchemaMigrations, runtimeEntityDefinitions as entityDefinitions } from './unifiedSchemaMigrations';
import type { IntelligenceConversation } from '../intelligenceChat';
import type { GrowthSnapshotData, GrowthSnapshotRecord } from './types';
import type { AgentConversation, RunIndexEntry, RunIndexFile, RunIndexRecord, RunIndexSignal, RunImpactRecord } from './types';
import type { PrepareRunInput, RunState, RunCheckpointInput, RunOutputFinalizationInput, RunLogInput, RunConsumerInput, RunConsumerLease, RunSettlementInput, RunEffect, RunEffectReference } from '../runLifecycleTypes';
import { createSessionBindingValue, appendSessionBindingValue, confirmSessionBindingValue, assertVersion2Binding, getResumableSessionValue } from '../sessionIdentity';
import { maintenanceRunKinds } from '../runLifecycleTypes';
import type { NativeSessionBinding, SessionBindingSeed, SessionBindingRevisionInput } from '../sessionIdentity';
import { normalizeProjectsForStorage, projectName, ProjectRegistryFile, ProjectRegistryPatch, ProjectRegistrySnapshot, ProjectRegistryBootstrap } from '../projectRegistry';
import { workspaceChanges, workspaceDocumentPurpose, WorkspaceSnapshot, gitEvidenceDocumentPurpose, RunGitEvidence } from '../runWorkspace';
import type { DocumentationManifest } from '../documentationManifest';
import type { FlowTrace } from '../flowStore';
import { parseStepMemorySource } from '../stepMemorySource.js';
import { digestToRunIndex, executionQueryTokens, parseRunDigestSource, RunDigestReference } from '../runDigestData.js';
import type { RunDigest, ExecutionExperienceQuery } from '../runDigest';
import type { LearningOverview } from '../learningLedger';
import { isTrashOrLocalPrivate, isUsefulVerificationSignal } from '../learningQuality.js';
import { extractTokenUsageFromOutput, normalizeTokenUsage } from '../tokenUsage';
import { reportFiles } from '../growthReports.js';
import { validateDirectGlobalPromptReview } from '../learningReviewApply.js';
import { legacyReviewSourceBody } from '../learningReview.js';
import type { ReviewManifest, ReviewSource } from '../learningReview.js';

export interface FlowSnapshot {
  projectId: string;
  objectId: string;
  taskId: string;
  revision: number;
  flow: FlowTrace;
}

export interface LegacyReviewTarget {
  key: string;
  kind: 'policy' | 'memory' | 'lesson';
  scope: string | null;
  data: Record<string, unknown>;
  before: string | null;
  beforeData?: Record<string, unknown>;
  after: string;
  afterSource?: { identity: string; key: string; hash: string; sourceRevision: number; jsonHash: string };
  afterError?: string;
  status: string;
  path?: string;
  legacyId?: string;
  binding: { identity: string; key: string } | null;
}

export interface StepMemorySourceReference {
  key: string; objectId: string; revision: number; sha256: string; entryCount: number; format: 'json' | 'md';
}

export interface MigrationJob {
  jobId: string;
  status: 'queued' | 'running' | 'interrupted' | 'completed' | 'completed_with_conflicts' | 'failed';
  args: Record<string, unknown>;
  progress: Record<string, unknown>;
  error: string | null;
}

export interface RecyclingItem {
  itemId: string; planId: string; identity: string; key: string; hash: string; path: string;
  restorePath?: string | null;
  bytes: number; status: 'prepared' | 'approved' | 'moving' | 'held' | 'trashed' | 'restoring' | 'restored' | 'changed'; error: string | null;
}

export interface MaintenanceTask {
  taskId: string;
  kind: 'migration_review' | 'migration_apply' | 'recycling_apply';
  targetId: string | null;
  status: 'ready' | 'running' | 'completed' | 'failed' | 'revoked';
  error: string | null;
  createdAt: number;
  updatedAt: number;
  validUntil: number;
}

export interface DataWrite {
  kind: string;
  action: 'create' | 'patch' | 'archive';
  scope: string | null;
  objectId?: string;
  expectedRevision?: number;
  idempotencyKey: string;
  data: Record<string, unknown>;
}
export interface DataObject {
  objectId: string;
  kind: string;
  projectId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  data: Record<string, unknown>;
  relations: Array<{ relation: string; target: string }>;
  projection?: Record<string, unknown>;
}
export interface WriteReceipt {
  requestId: string;
  objectId: string;
  revision: number;
  committedSequence: number;
  status: 'committed';
  pendingEffects: string[];
}
interface ImportedSource { identity: string; key: string; hash: string }
interface ContentChunk { offset: number; byteLength: number; storedOffset: number; storedByteLength: number; sha256: string; compressed: boolean }
export interface ContentPage {
  object: DataObject;
  revision: number;
  field: string;
  encoding: 'base64';
  data: string;
  byteOffset: number;
  byteLength: number;
  totalBytes: number;
  sha256: string;
  mimeType: string;
  cursor: string | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('invalid_data: undefined is not a persisted value');
  return encoded;
}
function digest(data: Uint8Array | string): string { return crypto.createHash('sha256').update(data).digest('hex'); }

/** Authoritative domain operations. Only Runtime exposes this owner to other processes. */
export class UnifiedDataStore {
  private readonly capabilityReadEpoch = crypto.randomUUID();
  private capabilityLegacySkillsPending: boolean | undefined;
  private readonly projectRegistrations = new Map<string, Promise<{ projectId: string; locationId: string; identityPath: string }>>();
  public get databaseId(): string {
    return String(this.rows("SELECT value FROM database_meta WHERE key='database_id'")[0].value);
  }
  public static open(root: string, expectedDatabaseId?: string): UnifiedDataStore {
    if (!fs.existsSync(path.join(root, 'solomap.db'))) throw new Error('database_restore_required');
    const store = new UnifiedDataStore(root);
    if (expectedDatabaseId && store.rows("SELECT value FROM database_meta WHERE key='database_id'")[0]?.value !== expectedDatabaseId) {
      store.close();
      throw new Error('database_identity_mismatch');
    }
    return store;
  }
  private readonly db: DiskDatabase;
  private readonly columns = new Map<string, Set<string>>();
  private readonly deviceId: string;
  private readonly ownerActorId: string;
  private readonly actorContext = new AsyncLocalStorage<string>();
  private transactionDepth = 0;
  private get actorId(): string { return this.actorContext.getStore() || this.ownerActorId; }
  public readonly filePath: string;
  constructor(public readonly root: string, actorId = 'local-runtime') {
    this.ownerActorId = actorId;
    this.filePath = path.join(root, 'solomap.db');
    const existed = fs.existsSync(this.filePath);
    this.db = new DiskDatabase(this.filePath);
    try {
      if (!existed) fs.chmodSync(this.filePath, 0o600);
      const sql = unifiedSchemaSql();
      const migrationsExist = this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").length;
      const rebuildTables = !migrationsExist || !this.rows('SELECT version FROM schema_migrations WHERE version=18').length;
      // SQLite requires FK enforcement outside the transaction to replace a referenced table.
      // Every reference is checked before committing; normal writes always enforce constraints.
      if (rebuildTables) this.db.run('PRAGMA foreign_keys=OFF');
      this.transaction(() => {
        const existing = this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
        if (!existing.length) {
          if (existed || this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length) throw new Error('unrecognized_database');
          this.db.run(sql);
          this.db.run('INSERT INTO schema_migrations VALUES(1,?,?)', [digest(sql), Date.now()]);
          this.db.run('INSERT INTO database_meta VALUES(?,?)', ['database_id', crypto.randomUUID()]);
          this.db.run('INSERT INTO database_meta VALUES(?,?)', ['protocol_version', '1']);
        } else if (this.rows('SELECT checksum FROM schema_migrations WHERE version=1')[0]?.checksum !== digest(sql)) {
          throw new Error('schema_checksum_mismatch');
        }
        this.db.run('INSERT OR IGNORE INTO actors(id,kind,provider) VALUES(?,?,?)', [actorId, 'runtime', 'solomap']);
        const versions = this.rows('SELECT version,checksum FROM schema_migrations ORDER BY version');
        if (versions.some(row => Number(row.version) !== 1 && !unifiedSchemaMigrations.some(migration => migration.version === row.version))) throw new Error('unsupported_schema_version');
        for (const migration of unifiedSchemaMigrations) {
          const applied = versions.find(row => row.version === migration.version);
          if (applied && applied.checksum !== digest(migration.sql)) throw new Error('schema_checksum_mismatch');
          if (!applied) {
            this.db.run(migration.sql);
            this.db.run('INSERT INTO schema_migrations VALUES(?,?,?)', [migration.version, digest(migration.sql), Date.now()]);
          }
        }
        if (rebuildTables && this.rows('PRAGMA foreign_key_check').length) throw new Error('migration_foreign_key_violation');
      });
      if (rebuildTables) this.db.run('PRAGMA foreign_keys=ON');
      for (const definition of Object.values(entityDefinitions)) {
        this.columns.set(definition.table, new Set(this.rows(`PRAGMA table_info(${definition.table})`).map(row => String(row.name)).filter(name => !['id', 'object_kind', 'project_id'].includes(name))));
      }
      const environment = canonical({ schemaVersion: 1, platform: process.platform, hostname: os.hostname(), user: os.userInfo().username });
      if (!this.rows("SELECT value FROM database_meta WHERE key='maintenance_secret'").length) {
        this.db.run('INSERT INTO database_meta VALUES(?,?)', ['maintenance_secret', crypto.randomBytes(32).toString('hex')]);
      }
      const device = this.rows('SELECT id FROM devices WHERE environment=?', [environment])[0];
      this.deviceId = device ? String(device.id) : crypto.randomUUID();
      if (!device) this.db.run('INSERT INTO devices VALUES(?,?,?,NULL,?)', [this.deviceId, os.hostname(), environment, Date.now()]);
    } catch (error) { this.db.close(); throw error; }
  }
  public withActor<T>(actorId: string, action: () => T): T {
    if (!this.rows('SELECT id FROM actors WHERE id=?', [actorId]).length) throw new Error('actor_missing');
    return this.actorContext.run(actorId, action);
  }
  public enqueueMemoryMigration(args: Record<string, unknown>, idempotencyKey: string): MigrationJob {
    if (!idempotencyKey || typeof args.sourceRoot !== 'string' || !args.sourceRoot) throw new Error('invalid_migration_request');
    return this.transaction(() => {
      const hash = digest(canonical(args));
      const previous = this.rows('SELECT id,input_hash FROM migration_jobs WHERE actor_id=? AND idempotency_key=?', [this.ownerActorId, idempotencyKey])[0];
      if (previous) {
        if (previous.input_hash !== hash) throw new Error('idempotency_conflict');
        return this.readMigrationJob(String(previous.id));
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      this.db.run('INSERT INTO migration_jobs VALUES(?,?,?,?,?,?,?,?,?,?)', [id, this.ownerActorId, idempotencyKey, hash, canonical(args), 'queued', '{}', null, now, now]);
      if (args.collection === 'capabilities') this.capabilityLegacySkillsPending = undefined;
      this.beginMigrationReconciliation(id, args);
      return this.readMigrationJob(id);
    });
  }
  public readMigrationJob(jobId: string): MigrationJob {
    const row = this.rows('SELECT * FROM migration_jobs WHERE id=?', [jobId])[0];
    if (!row) throw new Error('migration_job_missing');
    return { jobId: String(row.id), status: row.status as MigrationJob['status'], args: JSON.parse(String(row.args_json)), progress: JSON.parse(String(row.progress_json)), error: row.error === null ? null : String(row.error) };
  }
  public pendingMigrationJobs(): MigrationJob[] {
    return this.rows("SELECT id FROM migration_jobs WHERE status IN ('queued','running','interrupted') ORDER BY created_at,id").map(row => this.readMigrationJob(String(row.id)));
  }
  public migrationJobs(): MigrationJob[] {
    return this.rows('SELECT id FROM migration_jobs ORDER BY created_at,id').map(row => this.readMigrationJob(String(row.id)));
  }
  public migrationJobCount(): number {
    return Number(this.rows('SELECT COUNT(*) AS count FROM migration_jobs')[0].count);
  }
  public migrationJobSummaries(): MigrationJob[] {
    const rows = this.rows(`WITH ranked AS (
      SELECT jobs.rowid AS insertion_order,ROW_NUMBER() OVER (
        PARTITION BY CASE WHEN json_extract(jobs.args_json,'$.collection') IS NULL
          OR json_extract(jobs.args_json,'$.collection') IN ('',0) THEN 'memory'
          ELSE json_extract(jobs.args_json,'$.collection') END,json_extract(jobs.args_json,'$.sourceRoot')
        ORDER BY CASE WHEN json_extract(jobs.args_json,'$.collection') IN ('project-journal','project-growth')
          AND jobs.status IN ('queued','running','interrupted') THEN 1 ELSE 0 END DESC,
          COALESCE(CAST(attempt.value AS INTEGER),jobs.rowid) DESC
      ) AS source_rank FROM migration_jobs jobs
      LEFT JOIN database_meta attempt ON attempt.key='migration_reconciliation_attempt:' || jobs.id
    ), latest AS MATERIALIZED (
      SELECT jobs.id,jobs.args_json,jobs.status,jobs.error,ranked.insertion_order,
        jsonb(jobs.progress_json) AS progress_json
      FROM ranked JOIN migration_jobs jobs ON jobs.rowid=ranked.insertion_order WHERE source_rank=1
    ) SELECT id,args_json,status,error,
      json_remove(progress_json,'$.retainedFiles') AS progress_json,
      COALESCE(json_array_length(progress_json,'$.retainedFiles'),0) AS retained_file_count,
      COALESCE(json_array_length(progress_json,'$.conflicts'),0) AS conflict_count
      FROM latest ORDER BY insertion_order`);
    return rows.map(row => ({ jobId: String(row.id), args: JSON.parse(String(row.args_json)), status: row.status as MigrationJob['status'],
        progress: { ...JSON.parse(String(row.progress_json)), retainedFileCount: Number(row.retained_file_count), conflictCount: Number(row.conflict_count) },
        error: row.error === null ? null : String(row.error) }));
  }
  public capturedMigrationSources(): Array<{ identity: string; key: string; hash: string; stage: string }> {
    return this.rows('SELECT source_identity,source_key,contents.sha256 AS hash,stage FROM migration_items JOIN contents ON contents.id=source_content_id ORDER BY source_identity,source_key')
      .map(row => ({ identity: String(row.source_identity), key: String(row.source_key), hash: String(row.hash), stage: String(row.stage) }));
  }
  public migrationSourceState(identity: string, key: string): { hash: string; stage: string; reconciled: boolean } | null {
    const row = this.rows('SELECT contents.sha256 AS hash,stage FROM migration_items JOIN contents ON contents.id=source_content_id WHERE source_identity=? AND source_key=?', [identity, key])[0];
    if (!row) return null;
    let reconciled = true;
    for (const collection of ['project-journal', 'project-growth']) if (identity.startsWith(collection + ':')) {
      const jobs = this.rows("SELECT status,json_extract(args_json,'$.projectRoot') AS root FROM migration_jobs LEFT JOIN database_meta attempt ON attempt.key='migration_reconciliation_attempt:' || migration_jobs.id WHERE json_extract(args_json,'$.collection')=? AND COALESCE(json_extract(args_json,'$.mode'),'')<>'unified' ORDER BY COALESCE(CAST(attempt.value AS INTEGER),migration_jobs.rowid) DESC", [collection])
        .filter(job => typeof job.root === 'string' && this.samePhysicalMigrationSource(identity, `${collection}:${job.root}`));
      reconciled = !jobs.some(job => ['queued', 'running', 'interrupted'].includes(String(job.status))) && (!jobs.length || jobs[0].status === 'completed');
    }
    return { hash: String(row.hash), stage: String(row.stage), reconciled };
  }
  public markMigrationSourceRechecking(identity: string, key: string): void {
    for (const source of this.equivalentMigrationSources(identity, key)) {
      this.db.run("UPDATE migration_items SET stage='captured',error='migration_reconciliation_pending' WHERE source_identity=? AND source_key=? AND stage='imported'", [source.identity, key]);
    }
  }
  private samePhysicalMigrationSource(left: string, right: string): boolean {
    if (left === right) return true;
    const parse = (identity: string) => /^(project-journal|project-growth|agent-runs):(.+)$/.exec(identity);
    const a = parse(left); const b = parse(right);
    if (!a || !b || a[1] !== b[1]) return false;
    try { return fs.realpathSync(a[2]) === fs.realpathSync(b[2]); } catch { return false; }
  }
  private equivalentMigrationSources(identity: string, key: string): Array<{ identity: string; hash: string }> {
    const collection = /^(project-journal|project-growth):/.exec(identity)?.[1];
    const rows = collection
      ? this.rows('SELECT source_identity,contents.sha256 AS hash FROM migration_items JOIN contents ON contents.id=source_content_id WHERE source_key=? AND source_identity>=? AND source_identity<?', [key, `${collection}:`, `${collection};`])
      : this.rows('SELECT source_identity,contents.sha256 AS hash FROM migration_items JOIN contents ON contents.id=source_content_id WHERE source_identity=? AND source_key=?', [identity, key]);
    return rows.filter(row => this.samePhysicalMigrationSource(identity, String(row.source_identity))).map(row => ({ identity: String(row.source_identity), hash: String(row.hash) }));
  }
  private beginMigrationReconciliation(jobId: string, args: Record<string, unknown>): void {
    if (args.mode === 'unified' || typeof args.projectRoot !== 'string') return;
    if (args.collection === 'project-journal' || args.collection === 'project-growth') {
      // Persist attempt order separately from wall time and original job creation.
      const counter = this.rows("SELECT value FROM database_meta WHERE key='migration_reconciliation_sequence'")[0];
      const sequence = (counter ? Number(counter.value) : Number(this.rows('SELECT COALESCE(MAX(rowid),0) AS last FROM migration_jobs')[0].last)) + 1;
      this.db.run('INSERT INTO database_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['migration_reconciliation_sequence', String(sequence)]);
      this.db.run('INSERT INTO database_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [`migration_reconciliation_attempt:${jobId}`, String(sequence)]);
      this.markMigrationSourceRechecking(`${args.collection}:${args.projectRoot}`, args.collection === 'project-journal' ? 'project_journal.db' : 'project_growth.db');
    }
  }
  public migrationSourceOverview(intelligenceIdentity: string): { capturedFiles: number; migratedFiles: number; reviewableFiles: number } {
    const row = this.rows(`SELECT
      COUNT(*) AS captured_files,
      COALESCE(SUM(CASE WHEN stage='imported' OR (
        source_identity=? AND substr(source_key,-5)='.json' AND EXISTS(
          SELECT 1 FROM objects WHERE objects.id=substr(migration_items.source_key,1,length(migration_items.source_key)-5)
        )
      ) THEN 1 ELSE 0 END),0) AS migrated_files,
      COALESCE(SUM(CASE WHEN (
        (stage='imported' AND (source_identity LIKE 'project-journal:%' OR source_identity LIKE 'project-growth:%')) OR
        (source_identity=? AND substr(source_key,-5)='.json' AND EXISTS(
          SELECT 1 FROM objects WHERE objects.id=substr(migration_items.source_key,1,length(migration_items.source_key)-5)
        ))
      ) AND NOT EXISTS(
        SELECT 1 FROM migration_recycling WHERE migration_recycling.source_identity=migration_items.source_identity
          AND migration_recycling.source_key=migration_items.source_key
          AND migration_recycling.status IN ('prepared','approved','moving','held','restoring','trashed','changed')
      ) THEN 1 ELSE 0 END),0) AS reviewable_files
      FROM migration_items WHERE source_content_id IS NOT NULL`, [intelligenceIdentity, intelligenceIdentity])[0];
    return { capturedFiles: Number(row.captured_files), migratedFiles: Number(row.migrated_files), reviewableFiles: Number(row.reviewable_files) };
  }
  public markMigrationSourceImported(identity: string, key: string): void {
    this.db.run("UPDATE migration_items SET stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [identity, key]);
    if (!/^(project-journal|project-growth):/.test(identity)) return;
    const sources = this.equivalentMigrationSources(identity, key);
    const current = sources.find(source => source.identity === identity);
    for (const source of sources) if (source.identity !== identity && current && source.hash === current.hash) {
      this.db.run("UPDATE migration_items SET stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [source.identity, key]);
    }
  }
  public markMigrationSourceConflict(identity: string, key: string, error: string): void {
    this.db.run("UPDATE migration_items SET stage='conflict',error=? WHERE source_identity=? AND source_key=?", [error, identity, key]);
  }
  public recyclingItems(): RecyclingItem[] {
    return this.rows('SELECT * FROM migration_recycling ORDER BY created_at,id').map(row => ({ itemId: String(row.id), planId: String(row.plan_id), identity: String(row.source_identity), key: String(row.source_key), hash: String(row.source_hash), path: String(row.authorized_path ?? row.original_path), restorePath: row.restore_path === null ? null : String(row.restore_path), bytes: Number(row.byte_count), status: row.status as RecyclingItem['status'], error: row.error === null ? null : String(row.error) }));
  }
  public createRecyclingPlan(files: Array<Omit<RecyclingItem, 'itemId' | 'planId' | 'status' | 'error'>>): { planId: string; files: RecyclingItem[] } {
    return this.transaction(() => {
      const prepared = this.recyclingItems().filter(item => item.status === 'prepared');
      for (const existing of new Set(prepared.map(item => item.planId))) {
        const items = prepared.filter(item => item.planId === existing);
        if (items.length === files.length && items.every(item => files.some(file => file.path === item.path && file.hash === item.hash))) return { planId: existing, files: items };
      }
      const planId = crypto.randomUUID();
      for (const file of files) {
        const snapshot = this.rows('SELECT source_content_id FROM migration_items JOIN contents ON contents.id=source_content_id WHERE source_identity=? AND source_key=? AND contents.sha256=?', [file.identity, file.key, file.hash])[0];
        if (!snapshot) throw new Error('recycling_snapshot_missing');
        this.db.run('INSERT INTO migration_recycling(id,plan_id,source_identity,source_key,source_hash,source_content_id,original_path,byte_count,status,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [crypto.randomUUID(), planId, file.identity, file.key, file.hash, snapshot.source_content_id, file.path, file.bytes, 'prepared', null, Date.now(), Date.now()]);
      }
      return { planId, files: this.recyclingItems().filter(item => item.planId === planId) };
    });
  }
  public recyclingSnapshot(itemId: string): { bytes: Buffer; hash: string } {
    const item = this.rows('SELECT source_content_id,source_hash FROM migration_recycling WHERE id=?', [itemId])[0];
    if (!item) throw new Error('recycling_item_missing');
    const bytes = this.content(String(item.source_content_id));
    if (digest(bytes) !== item.source_hash) throw new Error('recycling_snapshot_corrupt');
    return { bytes, hash: String(item.source_hash) };
  }
  public approveRecyclingFiles(files: Array<{ itemId: string; expectedPath: string; path: string }>): void {
    this.transaction(() => {
      for (const file of files) {
        this.db.run("UPDATE migration_recycling SET authorized_path=?,status='approved',updated_at=? WHERE id=? AND COALESCE(authorized_path,original_path)=? AND status IN ('prepared','approved')", [file.path, Date.now(), file.itemId, file.expectedPath]);
        if (this.db.getRowsModified() !== 1) throw new Error('recycling_path_invalid');
      }
    });
  }
  public bindRecyclingRestorePath(itemId: string, destination: string, previousPath?: string | null): void {
    const item = this.rows('SELECT status,restore_path FROM migration_recycling WHERE id=?', [itemId])[0];
    if (item && ['restoring', 'restored'].includes(String(item.status)) && item.restore_path === destination) return;
    if (item?.status === 'restoring' && previousPath !== undefined && item.restore_path === previousPath) {
      this.db.run("UPDATE migration_recycling SET restore_path=? WHERE id=? AND status='restoring' AND restore_path IS ?", [destination, itemId, previousPath]);
      if (this.db.getRowsModified() !== 1) throw new Error('recycling_state_invalid');
      return;
    }
    this.db.run("UPDATE migration_recycling SET restore_path=? WHERE id=? AND status IN ('moving','held','trashed','changed')", [destination, itemId]);
    if (this.db.getRowsModified() !== 1) throw new Error('recycling_state_invalid');
  }
  public recyclingRestoreStage(itemId: string): { directory: string; device: string; inode: string } | null {
    const row = this.rows('SELECT directory,device,inode FROM recycling_restore_stages WHERE item_id=?', [itemId])[0];
    return row ? { directory: String(row.directory), device: String(row.device), inode: String(row.inode) } : null;
  }
  public registerRecyclingRestoreStage(itemId: string, stage: { directory: string; device: string; inode: string }): void {
    this.transaction(() => {
      this.db.run("UPDATE recycling_restore_intents SET status='owned',device=?,inode=? WHERE item_id=? AND directory=? AND status='planned'", [stage.device, stage.inode, itemId, stage.directory]);
      if (this.db.getRowsModified() !== 1) throw new Error('recycling_state_invalid');
      this.db.run('INSERT INTO recycling_restore_stages VALUES(?,?,?,?)', [itemId, stage.directory, stage.device, stage.inode]);
    });
  }
  public clearRecyclingRestoreStage(itemId: string, directory: string): void {
    this.transaction(() => {
      this.db.run('DELETE FROM recycling_restore_stages WHERE item_id=? AND directory=?', [itemId, directory]);
      this.db.run("UPDATE recycling_restore_intents SET status='cleaned' WHERE item_id=? AND directory=? AND status='owned'", [itemId, directory]);
    });
  }
  public recyclingRestoreIntents(itemId: string): Array<{ id: string; directory: string; status: string }> {
    return this.rows('SELECT id,directory,status FROM recycling_restore_intents WHERE item_id=? ORDER BY created_at,id', [itemId]) as Array<{ id: string; directory: string; status: string }>;
  }
  public reserveRecyclingRestoreIntent(itemId: string, parent: string): { id: string; directory: string } {
    const id = crypto.randomUUID(); const directory = path.join(parent, '.solomap-restore-' + id);
    this.db.run("INSERT INTO recycling_restore_intents(id,item_id,directory,status,created_at) VALUES(?,?,?,'planned',?)", [id, itemId, directory, Date.now()]);
    return { id, directory };
  }
  public settleRecyclingRestoreIntent(id: string, status: 'ownership_unknown' | 'cleaned'): void {
    this.db.run("UPDATE recycling_restore_intents SET status=? WHERE id=? AND status='planned'", [status, id]);
    if (this.db.getRowsModified() !== 1) throw new Error('recycling_state_invalid');
  }
  public recyclingRestoreConflicts(): Array<{ itemId: string; path: string }> {
    return this.rows("SELECT item_id AS itemId,directory AS path FROM recycling_restore_intents WHERE status='ownership_unknown' ORDER BY created_at,id") as Array<{ itemId: string; path: string }>;
  }
  public setRecyclingStatus(itemId: string, status: RecyclingItem['status'], error: string | null = null): void {
    if (!this.rows('SELECT id FROM migration_recycling WHERE id=?', [itemId]).length) throw new Error('recycling_item_missing');
    this.db.run('UPDATE migration_recycling SET status=?,error=?,updated_at=? WHERE id=?', [status, error, Date.now(), itemId]);
  }
  public updateMigrationJob(jobId: string, status: MigrationJob['status'], progress: Record<string, unknown>, error: string | null = null): void {
    this.transaction(() => {
      this.db.run('UPDATE migration_jobs SET status=?,progress_json=?,error=?,updated_at=? WHERE id=?', [status, canonical(progress), error, Date.now(), jobId]);
      if (status !== 'running') {
        const args = JSON.parse(String(this.rows('SELECT args_json FROM migration_jobs WHERE id=?', [jobId])[0].args_json));
        if (args.collection === 'capabilities') this.capabilityLegacySkillsPending = undefined;
        if (status === 'queued') this.beginMigrationReconciliation(jobId, args);
      }
    });
  }
  public requeueCompletedMigration(jobId: string): boolean {
    return this.transaction(() => {
      this.db.run("UPDATE migration_jobs SET status='queued',progress_json='{}',error=NULL,updated_at=? WHERE id=? AND status IN ('completed','completed_with_conflicts')", [Date.now(), jobId]);
      const requeued = this.db.getRowsModified() === 1;
      if (requeued) {
        const args = JSON.parse(String(this.rows('SELECT args_json FROM migration_jobs WHERE id=?', [jobId])[0].args_json));
        if (args.collection === 'capabilities') this.capabilityLegacySkillsPending = undefined;
        this.beginMigrationReconciliation(jobId, args);
      }
      return requeued;
    });
  }
  public authorizeMcpAction(actorId: string, projectId: string, action: string): void {
    const actor = this.rows('SELECT COALESCE(authority_id,id) AS authority,identity_ref,kind FROM actors WHERE id=?', [actorId])[0];
    if (!actor || (actor.kind === 'mcp' && !actor.identity_ref)) throw new Error('action_denied');
    const grants = this.rows("SELECT action_set_json FROM grants JOIN objects ON objects.id=grants.id WHERE actor_id=? AND target_id=? AND status='active' AND objects.archived_at IS NULL AND (valid_until IS NULL OR valid_until>?)", [actor.authority, projectId, Date.now()]);
    if (!grants.some(grant => {
      const value = JSON.parse(String(grant.action_set_json)) as { schemaVersion: number; actions: string[] };
      return value.schemaVersion === 1 && Array.isArray(value.actions) && value.actions.includes(action);
    })) throw new Error('action_denied');
  }
  public closeMcpActor(actorId: string, projectId: string): void {
    this.db.run("UPDATE actors SET identity_ref=NULL WHERE id=? AND kind='mcp' AND authority_id IN (SELECT actor_id FROM grants WHERE target_id=?)", [actorId, projectId]);
  }
  public establishMcpActor(projectId: string, resume?: { actorId: string; proof: string }): { actorId: string; proof: string; authorityActorId: string } {
    if (this.current(projectId).kind !== 'project') throw new Error('project_identity_invalid');
    const authorityActorId = `solomap-stdio:${projectId}`;
    if (resume) {
      const actor = this.rows('SELECT identity_ref,authority_id FROM actors WHERE id=? AND kind=?', [resume.actorId, 'mcp'])[0];
      const grant = this.rows("SELECT grants.id FROM grants JOIN objects ON objects.id=grants.id WHERE actor_id=? AND target_id=? AND status='active' AND objects.archived_at IS NULL AND (valid_until IS NULL OR valid_until>?)", [authorityActorId, projectId, Date.now()])[0];
      if (!actor || !grant || actor.authority_id !== authorityActorId || actor.identity_ref !== digest(resume.proof)) throw new Error('actor_resume_denied');
      return { ...resume, authorityActorId };
    }
    // The authenticated host provisions this connector once. Sessions never reset its grant.
    if (!this.rows('SELECT id FROM actors WHERE id=?', [authorityActorId]).length) {
      const grantId = crypto.randomUUID();
      this.recordMutation({ operation: 'mcp_grant', authorityActorId, projectId }, `mcp-grant:${authorityActorId}`, 'grant', () => {
        const time = Date.now();
        this.db.run('INSERT INTO actors(id,kind,provider,identity_ref) VALUES(?,?,?,?)', [authorityActorId, 'mcp_principal', 'solomap-stdio', projectId]);
        this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [grantId, 'grant', projectId, 1, time, time]);
        this.db.run('INSERT INTO grants(id,project_id,actor_id,target_id,action_set_json,revision,status) VALUES(?,?,?,?,?,?,?)', [grantId, projectId, authorityActorId, projectId, canonical({ schemaVersion: 1, actions: ['search', 'read', 'write', 'link', 'context', 'export'] }), 1, 'active']);
        return this.current(grantId);
      });
    }
    if (!this.rows("SELECT grants.id FROM grants JOIN objects ON objects.id=grants.id WHERE actor_id=? AND target_id=? AND status='active' AND objects.archived_at IS NULL AND (valid_until IS NULL OR valid_until>?)", [authorityActorId, projectId, Date.now()]).length) throw new Error('action_denied');
    const actorId = crypto.randomUUID();
    const proof = crypto.randomBytes(32).toString('hex');
    this.db.run('INSERT INTO actors(id,kind,provider,identity_ref,authority_id) VALUES(?,?,?,?,?)', [actorId, 'mcp', 'solomap-stdio', digest(proof), authorityActorId]);
    return { actorId, proof, authorityActorId };
  }

  private maintenanceProof(taskId: string): string {
    const secret = String(this.rows("SELECT value FROM database_meta WHERE key='maintenance_secret'")[0]?.value || '');
    if (!secret) throw new Error('maintenance_authority_missing');
    return crypto.createHmac('sha256', secret).update(taskId).digest('hex');
  }
  public readMaintenanceTask(taskId: string): MaintenanceTask {
    const row = this.rows('SELECT * FROM maintenance_tasks WHERE id=?', [taskId])[0];
    if (!row) throw new Error('maintenance_task_missing');
    return {
      taskId: String(row.id), kind: row.kind as MaintenanceTask['kind'], targetId: row.target_id === null ? null : String(row.target_id),
      status: row.status as MaintenanceTask['status'], error: row.error === null ? null : String(row.error),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), validUntil: Number(row.valid_until)
    };
  }
  public maintenanceTasks(limit = 10): MaintenanceTask[] {
    this.db.run("UPDATE maintenance_tasks SET status='failed',error='maintenance_task_expired',updated_at=? WHERE status IN ('ready','running') AND valid_until<=?", [Date.now(), Date.now()]);
    const historyLimit = Math.max(1, Math.min(100, limit));
    const active = this.rows("SELECT id FROM maintenance_tasks WHERE status IN ('ready','running') ORDER BY created_at DESC,id DESC");
    const history = this.rows("SELECT id FROM maintenance_tasks WHERE status NOT IN ('ready','running') ORDER BY created_at DESC,id DESC LIMIT ?", [historyLimit]);
    return [...active, ...history]
      .map(row => this.readMaintenanceTask(String(row.id)));
  }
  public createMaintenanceTask(kind: MaintenanceTask['kind'], targetId?: string): MaintenanceTask & { proof: string } {
    if (!['migration_review', 'migration_apply', 'recycling_apply'].includes(kind) || (kind === 'recycling_apply' && !targetId)) throw new Error('invalid_maintenance_task');
    const now = Date.now();
    this.db.run("UPDATE maintenance_tasks SET status='failed',error='maintenance_task_expired',updated_at=? WHERE status IN ('ready','running') AND valid_until<=?", [now, now]);
    const active = this.rows("SELECT id FROM maintenance_tasks WHERE kind=? AND COALESCE(target_id,'')=? AND status IN ('ready','running') LIMIT 1", [kind, targetId || '']);
    if (active.length) throw new Error('maintenance_task_in_use');
    if (kind === 'recycling_apply') {
      const rows = this.rows('SELECT status FROM migration_recycling WHERE plan_id=?', [String(targetId)]);
      if (!rows.length || rows.some(row => row.status === 'prepared')) throw new Error('maintenance_target_unconfirmed');
    }
    const taskId = crypto.randomUUID();
    this.db.run('INSERT INTO maintenance_tasks VALUES(?,?,?,?,?,?,?,?)', [taskId, kind, targetId || null, 'ready', null, now, now, now + 7 * 24 * 60 * 60 * 1000]);
    return { ...this.readMaintenanceTask(taskId), proof: this.maintenanceProof(taskId) };
  }
  public resumeMaintenanceTask(taskId: string): MaintenanceTask & { proof: string } {
    const task = this.readMaintenanceTask(taskId);
    if (!['ready', 'running'].includes(task.status) || task.validUntil <= Date.now()) throw new Error('maintenance_task_expired');
    return { ...task, proof: this.maintenanceProof(taskId) };
  }
  public establishMaintenanceTask(taskId: string, proof: string): MaintenanceTask {
    const task = this.verifyMaintenanceTaskProof(taskId, proof);
    this.db.run("UPDATE maintenance_tasks SET status='running',updated_at=? WHERE id=?", [Date.now(), taskId]);
    return this.readMaintenanceTask(taskId);
  }
  public verifyMaintenanceTaskIdentity(taskId: string, proof: string): MaintenanceTask {
    const task = this.readMaintenanceTask(taskId);
    const expected = this.maintenanceProof(taskId);
    if (!proof || proof.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(expected))) throw new Error('maintenance_resume_denied');
    return task;
  }
  public verifyMaintenanceTaskProof(taskId: string, proof: string): MaintenanceTask {
    const task = this.verifyMaintenanceTaskIdentity(taskId, proof);
    if (!['ready', 'running'].includes(task.status) || task.validUntil <= Date.now()) throw new Error('maintenance_task_expired');
    return task;
  }
  public authorizeMaintenanceTask(taskId: string, kind: MaintenanceTask['kind'], targetId: string | null): MaintenanceTask {
    const task = this.readMaintenanceTask(taskId);
    if (task.status !== 'running' || task.validUntil <= Date.now() || task.kind !== kind || task.targetId !== targetId) throw new Error('maintenance_task_inactive');
    return task;
  }
  public completeMaintenanceTask(taskId: string, error: string | null = null): MaintenanceTask {
    const task = this.readMaintenanceTask(taskId);
    if (!['ready', 'running'].includes(task.status)) throw new Error('maintenance_task_not_active');
    this.db.run('UPDATE maintenance_tasks SET status=?,error=?,updated_at=? WHERE id=?', [error ? 'failed' : 'completed', error, Date.now(), taskId]);
    return this.readMaintenanceTask(taskId);
  }

  private rows(sql: string, values: SqlValue[] = []): Record<string, SqlValue>[] {
    const statement = this.db.prepare(sql);
    const result: Record<string, SqlValue>[] = [];
    try {
      statement.bind(values);
      while (statement.step()) result.push(statement.getAsObject());
    } finally { statement.free(); }
    return result;
  }
  private transaction<T>(operation: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `domain_${depth}`;
    this.db.run(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = operation();
      this.db.run(depth ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.db.run(depth ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
      if (depth) this.db.run(`RELEASE ${savepoint}`);
      throw error;
    } finally { this.transactionDepth--; }
  }
  private putContent(data: Uint8Array | string, mimeType = 'text/plain', encoding = 'utf8'): string {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const hash = digest(bytes);
    const existing = this.rows('SELECT id FROM contents WHERE sha256=? AND mime_type=? AND encoding IN (?,?,?)', [hash, mimeType, encoding, `gzip:${encoding}`, `chunked:${encoding}`])[0];
    if (existing) {
      this.content(String(existing.id));
      return String(existing.id);
    }
    let stored: Buffer;
    let storedEncoding: string;
    let chunkIndex: string | null = null;
    let chunkParts: Buffer[] | undefined;
    let storedLength: number;
    if (bytes.length > 65536) {
      const chunks: ContentChunk[] = [];
      const parts: Buffer[] = [];
      let storedOffset = 0;
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const part = bytes.subarray(offset, offset + 65536);
        const compressed = gzipSync(part, { level: 1 });
        const encoded = compressed.length < part.length * 0.9 ? compressed : part;
        chunks.push({ offset, byteLength: part.length, storedOffset, storedByteLength: encoded.length, sha256: digest(part), compressed: encoded === compressed });
        parts.push(encoded);
        storedOffset += encoded.length;
      }
      chunkParts = parts;
      stored = Buffer.alloc(0);
      storedLength = storedOffset;
      storedEncoding = `chunked:${encoding}`;
      chunkIndex = canonical(chunks);
    } else {
      const compressed = bytes.length >= 16384 ? gzipSync(bytes, { level: 1 }) : bytes;
      stored = compressed.length < bytes.length * 0.9 ? compressed : bytes;
      storedEncoding = stored === bytes ? encoding : `gzip:${encoding}`;
      storedLength = stored.length;
    }
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,?)', [id, hash, mimeType, storedEncoding, bytes.length, storedLength, stored, chunkIndex]);
    chunkParts?.forEach((part, ordinal) => this.db.run('INSERT INTO content_chunks VALUES(?,?,?)', [id, ordinal, part]));
    return id;
  }
  private content(id: string): Buffer {
    const row = this.rows('SELECT sha256,byte_length,stored_byte_length,encoding,chunk_index_json FROM contents WHERE id=?', [id])[0];
    if (!row) throw new Error('content_missing');
    const bytes = this.contentRange(id, row, 0, Number(row.byte_length));
    if (bytes.length !== row.byte_length || digest(bytes) !== row.sha256) throw new Error('content_integrity_error');
    return bytes;
  }
  private contentRange(id: string, metadata: Record<string, SqlValue>, offset: number, end: number): Buffer {
    if (!String(metadata.encoding).startsWith('chunked:')) {
      const row = this.rows('SELECT data FROM contents WHERE id=?', [id])[0];
      const stored = Buffer.from(row.data as Uint8Array);
      if (stored.length !== metadata.stored_byte_length) throw new Error('content_integrity_error');
      let bytes: Buffer;
      try { bytes = String(metadata.encoding).startsWith('gzip:') ? gunzipSync(stored, { maxOutputLength: Number(metadata.byte_length) }) : stored; }
      catch { throw new Error('content_integrity_error'); }
      if (bytes.length !== metadata.byte_length || digest(bytes) !== metadata.sha256) throw new Error('content_integrity_error');
      return bytes.subarray(offset, end);
    }
    let chunks: ContentChunk[];
    try { chunks = JSON.parse(String(metadata.chunk_index_json)); } catch { throw new Error('content_integrity_error'); }
    if (!Array.isArray(chunks) || !chunks.length) throw new Error('content_integrity_error');
    let rawOffset = 0;
    let storedOffset = 0;
    const parts: Buffer[] = [];
    for (const [ordinal, chunk] of chunks.entries()) {
      if (chunk.offset !== rawOffset || chunk.storedOffset !== storedOffset || !Number.isInteger(chunk.byteLength) || chunk.byteLength < 1 || chunk.byteLength > 65536 || !Number.isInteger(chunk.storedByteLength) || chunk.storedByteLength < 1 || chunk.storedByteLength > 65536 || !/^[a-f0-9]{64}$/.test(chunk.sha256) || typeof chunk.compressed !== 'boolean') throw new Error('content_integrity_error');
      rawOffset += chunk.byteLength;
      storedOffset += chunk.storedByteLength;
      if (chunk.offset >= end || rawOffset <= offset) continue;
      const row = this.rows('SELECT data FROM content_chunks WHERE content_id=? AND ordinal=?', [id, ordinal])[0];
      if (!row) throw new Error('content_integrity_error');
      const stored = Buffer.from(row.data as Uint8Array);
      if (stored.length !== chunk.storedByteLength) throw new Error('content_integrity_error');
      let bytes: Buffer;
      try { bytes = chunk.compressed ? gunzipSync(stored, { maxOutputLength: chunk.byteLength }) : stored; }
      catch { throw new Error('content_integrity_error'); }
      if (bytes.length !== chunk.byteLength || digest(bytes) !== chunk.sha256) throw new Error('content_integrity_error');
      parts.push(bytes.subarray(Math.max(0, offset - chunk.offset), Math.min(bytes.length, end - chunk.offset)));
    }
    if (rawOffset !== metadata.byte_length || storedOffset !== metadata.stored_byte_length) throw new Error('content_integrity_error');
    return Buffer.concat(parts);
  }
  private decodedContent(id: string): unknown {
    const row = this.rows('SELECT encoding,mime_type FROM contents WHERE id=?', [id])[0];
    const bytes = this.content(id);
    return String(row.encoding).endsWith('binary') ? { encoding: 'base64', data: bytes.toString('base64'), mimeType: String(row.mime_type) } : bytes.toString('utf8');
  }
  private definition(kind: string): typeof entityDefinitions[string] {
    if (!Object.prototype.hasOwnProperty.call(entityDefinitions, kind)) throw new Error('unknown_kind');
    return entityDefinitions[kind];
  }
  private normalizeData(kind: string, input: Record<string, unknown>): Record<string, SqlValue> {
    const definition = this.definition(kind);
    if (kind === 'learning_event' && input.occurred_at != null) {
      const value = input.occurred_at;
      if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > 8.64e15) throw new Error('learning_timestamp_invalid: occurred_at');
    }
    if (kind === 'lesson' && input.semantic_review_json != null) {
      let value: any;
      try { value = typeof input.semantic_review_json === 'string' ? JSON.parse(input.semantic_review_json) : input.semantic_review_json; }
      catch { throw new Error('lesson_field_invalid: semantic_review_json'); }
      if (!value || value.schemaVersion !== 2 || typeof value.runId !== 'string' || !value.runId || typeof value.proposalHash !== 'string' || !value.proposalHash || !Array.isArray(value.evidence) || value.evidence.some((id: unknown) => typeof id !== 'string') || typeof value.target !== 'string' || typeof value.reason !== 'string') throw new Error('lesson_field_invalid: semantic_review_json');
    }
    if (kind === 'lesson') for (const field of ['external_created_at', 'external_updated_at']) {
      const value = input[field];
      if (value == null) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > 8.64e15) throw new Error(`lesson_timestamp_invalid: ${field}`);
    }
    if (kind === 'lesson') for (const field of ['evidence_refs_json', 'source_event_ids_json']) {
      if (input[field] == null) continue;
      let value: unknown;
      try { value = typeof input[field] === 'string' ? JSON.parse(input[field]) : input[field]; }
      catch { throw new Error(`lesson_field_invalid: ${field}`); }
      const valid = Array.isArray(value) && value.every(item => field === 'source_event_ids_json' ? typeof item === 'string' : item && typeof item === 'object' && typeof item.type === 'string' && typeof item.ref === 'string' && (item.summary === undefined || typeof item.summary === 'string'));
      if (!valid) throw new Error(`lesson_field_invalid: ${field}`);
    }
    const allowed = this.columns.get(definition.table)!;
    const result: Record<string, SqlValue> = {};
    for (const [inputKey, value] of Object.entries(input)) {
      if (kind === 'lesson_decision' && inputKey === 'candidate_refs') continue;
      if (kind === 'lesson' && inputKey === 'event_refs') continue;
      const key = inputKey === 'content' ? 'content_id' : (inputKey.endsWith('_content') ? `${inputKey}_id` : inputKey);
      if (!allowed.has(key)) throw new Error(`invalid_field: ${kind}.${inputKey}`);
      if (key !== inputKey) {
        const binary = value as { encoding?: string; data?: string; mimeType?: string } | null;
        if (binary && binary.encoding === 'base64') {
          if (typeof binary.data !== 'string') throw new Error('invalid_binary_content');
          const bytes = Buffer.from(binary.data, 'base64');
          if (bytes.toString('base64') !== binary.data) throw new Error('invalid_binary_content');
          result[key] = this.putContent(bytes, binary.mimeType || 'application/octet-stream', 'binary');
        } else result[key] = value === null ? null : this.putContent(typeof value === 'string' ? value : canonical(value), typeof value === 'string' ? 'text/plain' : 'application/json');
      } else if (typeof value === 'boolean') result[key] = value ? 1 : 0;
      else if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
      else if (key.endsWith('_json')) result[key] = canonical(value);
      else throw new Error(`invalid_value: ${kind}.${inputKey}`);
    }
    return result;
  }
  private current(id: string, full = true): DataObject {
    const object = this.rows('SELECT * FROM objects WHERE id=?', [id])[0];
    if (!object) throw new Error('object_missing');
    const definition = this.definition(String(object.kind));
    const row = this.rows(`SELECT * FROM ${definition.table} WHERE id=?`, [id])[0];
    if (!row) throw new Error('entity_missing');
    const data: Record<string, unknown> = {};
    for (const key of this.columns.get(definition.table)!) {
      const value = row[key];
      if (key.endsWith('_content_id') || key === 'content_id') {
        data[key] = value;
        if (value && full) data[key === 'content_id' ? 'content' : key.slice(0, -3)] = this.decodedContent(String(value));
      } else data[key] = value;
    }
    const relations = this.rows('SELECT relation,target_id FROM relations WHERE source_id=? ORDER BY relation,target_id', [id]).map(row => ({ relation: String(row.relation), target: String(row.target_id) }));
    return { objectId: id, kind: String(object.kind), projectId: object.project_id === null ? null : String(object.project_id), revision: Number(object.revision), createdAt: Number(object.created_at), updatedAt: Number(object.updated_at), archivedAt: object.archived_at === null ? null : Number(object.archived_at), data, relations };
  }
  public read(ref: string, revision?: number, projectObject?: (object: DataObject) => DataObject): DataObject {
    const metadata = this.readMetadata(ref, revision), object = projectObject ? projectObject(metadata) : metadata;
    for (const [key, value] of Object.entries(object.data)) {
      if (value && (key.endsWith('_content_id') || key === 'content_id')) object.data[key === 'content_id' ? 'content' : key.slice(0, -3)] = this.decodedContent(String(value));
    }
    return object;
  }
  public readMetadata(ref: string, revision?: number): DataObject {
    const current = this.current(ref, false);
    let result = current;
    if (revision !== undefined && revision !== current.revision) {
      const row = this.rows('SELECT content_id FROM object_revisions WHERE object_id=? AND revision=?', [ref, revision])[0];
      if (!row) throw new Error('revision_missing');
      result = JSON.parse(this.content(String(row.content_id)).toString('utf8')) as DataObject;
    }
    if (result.kind === 'lesson_decision') {
      const candidates = this.rows('SELECT lesson_id,lesson_revision FROM lesson_decision_candidates WHERE decision_id=? AND decision_revision=? ORDER BY ordinal', [result.objectId, result.revision]).map(row => ({ objectId: String(row.lesson_id), revision: row.lesson_revision === null ? null : Number(row.lesson_revision) }));
      // Published decisions had a candidate ID but no pinned version. Keep that original uncertainty.
      result.data.candidate_refs = candidates.length || !result.data.lesson_id || result.data.lesson_revision != null ? candidates : [{ objectId: result.data.lesson_id, revision: null }];
    }
    if (result.kind === 'lesson') {
      const refs = this.rows('SELECT source_id,event_id,event_revision FROM lesson_event_refs WHERE lesson_id=? AND lesson_revision=? ORDER BY ordinal', [result.objectId, result.revision]);
      const ids: string[] = result.data.source_event_ids_json ? JSON.parse(String(result.data.source_event_ids_json)) : [];
      result.data.event_refs = refs.length ? refs.map(row => ({ sourceId: String(row.source_id), objectId: row.event_id === null ? null : String(row.event_id), revision: row.event_revision === null ? null : Number(row.event_revision) })) : ids.map(sourceId => ({ sourceId, objectId: null, revision: null }));
    }
    const reviewControl = result.kind === 'review_batch' ? this.rows('SELECT input_content_id FROM learning_review_controls WHERE batch_id=?', [result.objectId])[0] : null;
    if (reviewControl) {
      const saved = JSON.parse(this.content(String(reviewControl.input_content_id)).toString('utf8'));
      const projectIds = saved.projectIds || saved.manifest.projects.map((root: string) => {
        const matches = this.rows('SELECT DISTINCT project_id FROM project_locations WHERE device_id=? AND root_path=?', [this.deviceId, root]);
        return matches.length === 1 ? String(matches[0].project_id) : null;
      });
      if (saved.manifest) result.projection = { runId: saved.runId, manifestHash: result.data.input_hash, globalPrompt: saved.manifest.globalPrompt, projectIds, sources: saved.manifest.sources.map((source: ReviewSource) => {
        const { content, ...header } = source; return header;
      }), hostReview: true, gaps: saved.manifest.gaps, pending: saved.pending };
    }
    return result;
  }
  public learningReviewScopeCurrent(object: DataObject): boolean {
    if (object.kind !== 'review_batch' || object.projection?.hostReview !== true) return true;
    const projects = object.projection.projectIds;
    return Array.isArray(projects) && projects.every(id => typeof id === 'string' && this.rows('SELECT p.id FROM projects p JOIN objects o ON o.id=p.id WHERE p.id=? AND p.hidden=0 AND o.archived_at IS NULL', [id]).length === 1);
  }
  public readPage(input: { ref: string; revision?: number; field?: string; cursor?: string; limit?: number }, authorizeField?: (object: DataObject, field: string) => void): ContentPage {
    const limit = input.limit ?? 65536;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1048576) throw new Error('invalid_page_limit');
    const cursor = input.cursor ? JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { ref: string; revision: number; field: string; offset: number; contentId: string } : undefined;
    const field = input.field ?? cursor?.field ?? 'content';
    if (cursor && (cursor.ref !== input.ref || cursor.field !== field || (input.revision !== undefined && input.revision !== cursor.revision))) throw new Error('cursor_scope_mismatch');
    const object = this.readMetadata(input.ref, cursor?.revision ?? input.revision);
    authorizeField?.(object, field);
    if (object.kind === 'review_batch' && field.startsWith('review_source:')) {
      const control = this.rows('SELECT input_content_id FROM learning_review_controls WHERE batch_id=?', [object.objectId])[0];
      if (!control) throw new Error('review_source_missing');
      const saved = JSON.parse(this.content(String(control.input_content_id)).toString('utf8'));
      const [sourceId, sourceRevision] = field.slice('review_source:'.length).split(':');
      let source = saved.manifest.sources.find((item: ReviewSource) => item.id === sourceId);
      if (sourceRevision && source?.hash !== sourceRevision && source?.contentHash !== sourceRevision && source?.ref?.revision !== Number(sourceRevision)) source = source?.previousVersions?.find((item: ReviewSource) => item.hash === sourceRevision || item.contentHash === sourceRevision || item.ref?.revision === Number(sourceRevision));
      if (!source || (sourceRevision && !/^(?:[1-9]\d*|[a-f0-9]{64})$/.test(sourceRevision))) throw new Error('review_source_missing');
      const contentId = String(saved.sourceContents[`${source.id}:${source.hash}:${source.contentHash}`] || saved.sourceContents[`${source.id}:${source.hash}`] || '');
      if (!contentId || (cursor && cursor.contentId !== contentId)) throw new Error('cursor_content_mismatch');
      const metadata = this.rows('SELECT * FROM contents WHERE id=?', [contentId])[0];
      const totalBytes = Number(metadata.byte_length), offset = cursor?.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > totalBytes) throw new Error('invalid_page_offset');
      const end = Math.min(totalBytes, offset + limit), bytes = this.contentRange(contentId, metadata, offset, end);
      if (metadata.sha256 !== (source.contentHash || source.hash)) throw new Error('content_integrity_error');
      return { object, revision: object.revision, field, encoding: 'base64', data: bytes.toString('base64'), byteOffset: offset, byteLength: end - offset, totalBytes, sha256: String(metadata.sha256), mimeType: String(metadata.mime_type), cursor: end < totalBytes ? Buffer.from(canonical({ ref: input.ref, revision: object.revision, field, offset: end, contentId })).toString('base64url') : null };
    }
    const contentId = object.data[field + '_id'];
    if (typeof contentId !== 'string' || (field !== 'content' && !field.endsWith('_content'))) throw new Error('content_field_missing');
    if (cursor && cursor.contentId !== contentId) throw new Error('cursor_content_mismatch');
    const metadata = this.rows('SELECT sha256,mime_type,byte_length,stored_byte_length,encoding,chunk_index_json FROM contents WHERE id=?', [contentId])[0];
    if (!metadata) throw new Error('content_missing');
    const totalBytes = Number(metadata.byte_length);
    const offset = cursor?.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > totalBytes) throw new Error('invalid_page_offset');
    const end = Math.min(totalBytes, offset + limit);
    const bytes = this.contentRange(contentId, metadata, offset, end);
    return { object, revision: object.revision, field, encoding: 'base64', data: bytes.toString('base64'), byteOffset: offset, byteLength: end - offset, totalBytes, sha256: String(metadata.sha256), mimeType: String(metadata.mime_type), cursor: end < totalBytes ? Buffer.from(canonical({ ref: input.ref, revision: object.revision, field, offset: end, contentId })).toString('base64url') : null };
  }
  private snapshot(object: DataObject): string {
    const data = { ...object.data };
    for (const key of Object.keys(data)) {
      if (key.endsWith('_content_id') || key === 'content_id') delete data[key === 'content_id' ? 'content' : key.slice(0, -3)];
    }
    return canonical({ ...object, data });
  }
  private checkReferences(projectId: string | null, data: Record<string, SqlValue>): void {
    for (const [key, value] of Object.entries(data)) {
      if (!value || !key.endsWith('_id') || key.endsWith('content_id') || key.endsWith('actor_id') || key === 'device_id') continue;
      const referenced = this.rows('SELECT project_id FROM objects WHERE id=?', [value])[0];
      if (referenced?.project_id !== null && referenced?.project_id !== undefined && referenced.project_id !== projectId) throw new Error('scope_mismatch');
    }
  }
  public write(input: DataWrite): WriteReceipt {
    return this.writeMutation(input);
  }
  public readCapabilityRegistry(input: { kind: string; knownSequence?: number; knownEpoch?: string }): { kind: string; sourceSequence: number; readEpoch: string; legacySkillsPending?: true; entries?: Array<{ objectId: string; revision: number; entry: Record<string, unknown> }>; unchanged?: true } {
    if (!['skill', 'mcp', 'enhancement'].includes(input.kind)) throw new Error('capability_kind_invalid');
    return this.transaction(() => {
      const sourceSequence = Number(this.rows('SELECT COALESCE(MAX(e.sequence),0) AS value FROM capability_registry c JOIN events e ON e.subject_id=c.integration_id WHERE c.kind=?', [input.kind])[0].value);
      if (input.kind === 'skill' && this.capabilityLegacySkillsPending === undefined) {
        // Presence is only a migration barrier. Live choices still come solely
        // from typed registrations; no legacy configuration is read here.
        const legacyExists = fs.existsSync(path.join(this.root, 'skills', 'registry.json'));
        const lastImport = legacyExists ? this.rows("SELECT status FROM migration_jobs WHERE json_extract(args_json,'$.collection')='capabilities' ORDER BY rowid DESC LIMIT 1")[0] : undefined;
        this.capabilityLegacySkillsPending = legacyExists && lastImport?.status !== 'completed';
      }
      const legacySkillsPending = input.kind === 'skill' && this.capabilityLegacySkillsPending;
      const readEpoch = this.capabilityReadEpoch + (legacySkillsPending ? ':legacy-skills-pending' : '');
      if (input.knownSequence !== undefined && input.knownSequence === sourceSequence && input.knownEpoch === readEpoch) return { kind: input.kind, sourceSequence, readEpoch, unchanged: true };
      const entries = this.rows('SELECT c.integration_id FROM capability_registry c JOIN objects o ON o.id=c.integration_id WHERE c.kind=? AND o.archived_at IS NULL ORDER BY c.legacy_id', [input.kind]).map(row => {
        const object = this.read(String(row.integration_id));
        return { objectId: object.objectId, revision: object.revision, entry: JSON.parse(String(object.data.config_content)) as Record<string, unknown> };
      });
      return { kind: input.kind, sourceSequence, readEpoch, ...(legacySkillsPending ? { legacySkillsPending: true as const } : {}), entries };
    });
  }
  public patchCapabilityRegistry(input: { kind: string; entry: Record<string, unknown>; expectedRevision: number; idempotencyKey: string; installationReceiptId?: string; attachments?: Array<{ purpose: string; bytes: string; mimeType?: string }> }): WriteReceipt {
    if (!['skill', 'mcp', 'enhancement'].includes(input.kind)) throw new Error('capability_kind_invalid');
    if (!input.entry || typeof input.entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.entry.id)) throw new Error('capability_identity_invalid');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('revision_conflict');
    if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.some(item => !item || !/^[a-zA-Z0-9_-]+$/.test(item.purpose) || typeof item.bytes !== 'string' || Buffer.from(item.bytes, 'base64').toString('base64') !== item.bytes))) throw new Error('capability_attachment_invalid');
    if (input.installationReceiptId !== undefined && (!/^[a-f0-9]{64}$/.test(input.installationReceiptId) || !input.attachments?.some(item => item.purpose === 'result'))) throw new Error('capability_installation_receipt_invalid');
    // A receipt retry can observe a newer registry revision. Its immutable
    // payload still identifies the original intent; CAS applies only once.
    const { expectedRevision: _expectedRevision, ...installationIntent } = input;
    return this.recordMutation(input.installationReceiptId ? installationIntent : input, input.idempotencyKey, 'capability.registered', () => {
      const binding = this.rows('SELECT integration_id FROM capability_registry WHERE kind=? AND legacy_id=?', [input.kind, input.entry.id as string])[0];
      const current = binding ? this.current(String(binding.integration_id)) : undefined;
      if ((current?.revision || 0) !== input.expectedRevision) throw new Error('revision_conflict');
      const id = current?.objectId || crypto.randomUUID();
      const time = Date.now();
      const entry = input.installationReceiptId ? {
        ...input.entry, installedAt: input.entry.installedAt || new Date(time).toISOString(),
        updatedAt: input.entry.updatedAt || new Date(time).toISOString(),
        ...(input.kind === 'enhancement' ? { lastCheckedAt: input.entry.lastCheckedAt || new Date(time).toISOString() } : {})
      } : input.entry;
      const config = this.putContent(canonical(entry), 'application/json');
      const title = String(input.entry.title || input.entry.id), status = String(input.entry.status || 'installed');
      const health = input.entry.health === undefined ? null : this.putContent(canonical(input.entry.health), 'application/json');
      if (current) {
        this.db.run('UPDATE integrations SET title=?,status=?,config_content_id=?,health_content_id=? WHERE id=?', [title, status, config, health, id]);
        this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [time, id]);
      } else {
        this.db.run("INSERT INTO objects VALUES(?,'integration',NULL,1,?,?,NULL)", [id, time, time]);
        this.db.run('INSERT INTO integrations(id,project_id,kind,title,status,config_content_id,health_content_id) VALUES(?,NULL,?,?,?,?,?)', [id, input.kind, title, status, config, health]);
        this.db.run('INSERT INTO capability_registry VALUES(?,?,?)', [input.kind, input.entry.id as string, id]);
      }
      for (const [ordinal, attachment] of (input.attachments || []).entries()) {
        const receipt = this.writeMutation({ kind: 'evidence', action: 'create', scope: null, idempotencyKey: `${input.idempotencyKey}:attachment:${ordinal}`, data: {
          type: `installation:${attachment.purpose}`, source_actor_id: this.actorId, observed_at: time,
          content: { encoding: 'base64', data: attachment.bytes, mimeType: attachment.mimeType || 'application/octet-stream' }
        } });
        this.db.run("INSERT INTO relations VALUES(?,'evidence',?)", [id, receipt.objectId]);
      }
      return this.current(id);
    });
  }
  public importCapabilityEntry(kind: string, entry: Record<string, unknown>, source: ImportedSource, attachments: Array<{ purpose: string; bytes: string; mimeType?: string }> = []): { unchanged: boolean; receipt?: WriteReceipt } {
    return this.transaction(() => {
      const previous = this.rows('SELECT object_id,source_hash,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
      const binding = this.rows('SELECT integration_id FROM capability_registry WHERE kind=? AND legacy_id=?', [kind, String(entry.id)])[0];
      if (binding && previous?.object_id !== binding.integration_id) throw new Error('migration_conflict: existing_database_choice');
      if (binding && previous.source_hash === source.hash) { this.markMigrationSourceImported(source.identity, source.key); return { unchanged: true }; }
      const current = binding ? this.readMetadata(String(binding.integration_id)) : undefined;
      if (current && current.revision !== previous.imported_revision) throw new Error('migration_conflict: newer_database_revision');
      const receipt = this.patchCapabilityRegistry({ kind, entry, expectedRevision: current?.revision || 0,
        idempotencyKey: `import-capability:${digest(canonical(source))}`, attachments });
      this.db.run("UPDATE migration_items SET object_id=?,source_hash=?,imported_revision=?,stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [receipt.objectId, source.hash, receipt.revision, source.identity, source.key]);
      return { unchanged: false, receipt };
    });
  }
  public recordLearningCycle(projectId: string, input: { node: Record<string, unknown>; nextStatus: string; changedFilesSummary: string; touchedFilesSummary: string; outputTail: string; runDurationMs: number; finishedAt: string }): WriteReceipt {
    const occurredAt = Date.parse(input.finishedAt);
    if (!input.node.id || !Number.isFinite(occurredAt) || !Number.isFinite(input.runDurationMs) || input.runDurationMs < 0) throw new Error('learning_cycle_invalid');
    const intent = `learning-cycle:${digest(canonical([projectId, input.node.id, input.finishedAt]))}`;
    return this.transaction(() => {
      const source = this.write({ action: 'create', kind: 'evidence', scope: projectId, idempotencyKey: `${intent}:source`, data: {
        type: 'learning_cycle', source_actor_id: this.actorId, observed_at: occurredAt, content: canonical(input)
      } });
      return this.write({ action: 'create', kind: 'learning_event', scope: projectId, idempotencyKey: `${intent}:event`, data: {
        source_object_id: source.objectId, source_revision: source.revision, occurred_at: occurredAt,
        event_type: input.nextStatus === 'Completed' ? 'completed' : input.nextStatus === 'Failed' ? 'failed' : 'partial',
        summary: String(input.node.title || input.node.id), source_type: 'step_run', verification_signal: 0
      } });
    });
  }
  public captureMigrationSource(source: ImportedSource, bytes: Uint8Array, options: { mimeType?: string; encoding?: string; error?: string; pending?: boolean } = {}): { unchanged: boolean; requestId: string; committedSequence: number; stage: string } {
    if (!source.identity || !source.key || source.hash !== digest(bytes)) throw new Error('migration_source_invalid');
    return this.transaction(() => {
      const previous = this.rows('SELECT migration_items.*,contents.sha256 AS captured_hash FROM migration_items LEFT JOIN contents ON contents.id=migration_items.source_content_id WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
      const revision = Number(previous?.source_capture_revision || 0);
      const classificationChanged = options.error ? previous?.stage !== 'unmapped' || previous.error !== options.error : previous?.stage === 'unmapped' && !options.pending;
      if (previous?.captured_hash === source.hash && !classificationChanged) {
        const request = this.rows('SELECT id,committed_sequence FROM requests WHERE id=?', [previous.source_capture_request_id])[0];
        if (!request) throw new Error('migration_capture_receipt_missing');
        return { unchanged: true, requestId: String(request.id), committedSequence: Number(request.committed_sequence), stage: String(previous.stage) };
      }
      const contentId = this.putContent(bytes, options.mimeType || 'application/octet-stream', options.encoding || 'binary');
      const error = options.error || (options.pending && previous?.stage === 'unmapped' ? String(previous.error || '') : null);
      const stage = error ? 'unmapped' : 'captured';
      const descriptor = canonical({ source, contentId, revision: revision + 1, stage, error });
      const requestId = crypto.randomUUID();
      const nextKey = `migration-capture:${canonical([source.identity, source.key])}:${revision + 1}`;
      this.db.run('INSERT INTO requests(actor_id,idempotency_key,id,input_hash,status) VALUES(?,?,?,?,?)', [this.actorId, nextKey, requestId, digest(descriptor), 'pending']);
      this.db.run('INSERT INTO migration_items(source_identity,source_key,source_hash,stage,error,source_content_id,source_capture_revision,source_capture_request_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_identity,source_key) DO UPDATE SET source_content_id=excluded.source_content_id,source_capture_revision=excluded.source_capture_revision,source_capture_request_id=excluded.source_capture_request_id,stage=excluded.stage,error=excluded.error', [source.identity, source.key, source.hash, stage, error, contentId, revision + 1, requestId]);
      const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM events')[0].next);
      const eventContent = this.putContent(descriptor, 'application/json');
      this.db.run('INSERT INTO events VALUES(?,?,NULL,?,?,?,?,?)', [crypto.randomUUID(), sequence, this.actorId, 'migration.source_captured', eventContent, Date.now(), requestId]);
      const resultContent = this.putContent(canonical({ requestId, committedSequence: sequence }), 'application/json');
      this.db.run("UPDATE requests SET status='committed',result_content_id=?,committed_sequence=? WHERE id=?", [resultContent, sequence, requestId]);
      if (source.identity.startsWith('learning:') && /^candidates\/[^/\\]+\.json$/.test(source.key)) {
        this.recordMigrationJsonVersion(source, revision + 1, contentId, requestId, Buffer.from(bytes));
        const head = this.rows('SELECT through_revision FROM migration_source_json_heads WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
        if (Number(head?.through_revision || 0) === revision) this.db.run('INSERT INTO migration_source_json_heads VALUES(?,?,?) ON CONFLICT(source_identity,source_key) DO UPDATE SET through_revision=excluded.through_revision', [source.identity, source.key, revision + 1]);
      }
      return { unchanged: false, requestId, committedSequence: sequence, stage };
    });
  }
  public readMigrationSource(identity: string, key: string): { bytes: Buffer; hash: string; sourceRevision: number; stage: string } {
    const item = this.rows('SELECT migration_items.*,contents.sha256 AS captured_hash FROM migration_items JOIN contents ON contents.id=migration_items.source_content_id WHERE source_identity=? AND source_key=?', [identity, key])[0];
    if (!item) throw new Error('migration_source_missing');
    return { bytes: this.content(String(item.source_content_id)), hash: String(item.captured_hash), sourceRevision: Number(item.source_capture_revision), stage: String(item.stage) };
  }
  private recordMigrationJsonVersion(source: ImportedSource, revision: number, contentId: string, requestId: string, bytes: Buffer): void {
    let jsonHash: string | null = null;
    try {
      const text = bytes.toString('utf8');
      if (Buffer.from(text).equals(bytes)) jsonHash = digest(JSON.stringify(JSON.parse(text.replace(/^\uFEFF/, ''))));
    } catch { /* Invalid original bytes remain retained and cannot match a JSON after-image. */ }
    this.db.run('INSERT INTO migration_source_json_versions VALUES(?,?,?,?,?,?,?)', [source.identity, source.key, revision, contentId, source.hash, jsonHash, requestId]);
  }
  public readMigrationSourceJsonVersion(identity: string, key: string, jsonHash: string): { bytes: Buffer; hash: string; sourceRevision: number } | null {
    if (!identity.startsWith('learning:') || !/^candidates\/[^/\\]+\.json$/.test(key) || !/^[a-f0-9]{64}$/.test(jsonHash)) throw new Error('migration_source_invalid');
    return this.transaction(() => {
      const latest = this.rows('SELECT source_capture_revision FROM migration_items WHERE source_identity=? AND source_key=?', [identity, key])[0];
      if (!latest) return null;
      const revision = Number(latest.source_capture_revision), head = Number(this.rows('SELECT through_revision FROM migration_source_json_heads WHERE source_identity=? AND source_key=?', [identity, key])[0]?.through_revision || 0);
      if (head < revision) {
        // Older captures already own immutable bytes and receipts; project only this exact source.
        const prefix = `migration-capture:${canonical([identity, key])}:`;
        const receipts = this.rows("SELECT r.id,r.idempotency_key,e.content_id FROM requests r JOIN events e ON e.sequence=r.committed_sequence WHERE r.idempotency_key>='migration-capture:' AND r.idempotency_key<'migration-capture;' AND r.idempotency_key>=? AND r.idempotency_key<? AND e.kind='migration.source_captured'", [prefix, `${prefix.slice(0, -1)};`]);
        const seen = new Set<number>();
        for (const receipt of receipts) {
          const captureRevision = Number(String(receipt.idempotency_key).slice(prefix.length));
          if (!Number.isSafeInteger(captureRevision) || captureRevision <= head || captureRevision > revision) continue;
          if (seen.has(captureRevision)) throw new Error('migration_capture_receipt_invalid');
          seen.add(captureRevision);
          if (this.rows('SELECT content_id FROM migration_source_json_versions WHERE source_identity=? AND source_key=? AND capture_revision=?', [identity, key, captureRevision]).length) continue;
          const descriptor = JSON.parse(this.content(String(receipt.content_id)).toString('utf8'));
          const metadata = this.rows('SELECT sha256 FROM contents WHERE id=?', [descriptor.contentId])[0];
          if (descriptor.source?.identity !== identity || descriptor.source?.key !== key || descriptor.revision !== captureRevision || descriptor.source.hash !== metadata?.sha256) throw new Error('migration_capture_receipt_invalid');
          this.recordMigrationJsonVersion(descriptor.source, captureRevision, descriptor.contentId, String(receipt.id), this.content(descriptor.contentId));
        }
        if (seen.size !== revision - head) throw new Error('migration_capture_receipt_missing');
        this.db.run('INSERT INTO migration_source_json_heads VALUES(?,?,?) ON CONFLICT(source_identity,source_key) DO UPDATE SET through_revision=excluded.through_revision', [identity, key, revision]);
      }
      const saved = this.rows('SELECT content_id,transport_hash,capture_revision FROM migration_source_json_versions WHERE source_identity=? AND source_key=? AND json_hash=? ORDER BY capture_revision LIMIT 1', [identity, key, jsonHash])[0];
      return saved ? { bytes: this.content(String(saved.content_id)), hash: String(saved.transport_hash), sourceRevision: Number(saved.capture_revision) } : null;
    });
  }
  public importObject(input: DataWrite, source: ImportedSource): { receipt?: WriteReceipt; unchanged: boolean } {
    if (!source.identity || !source.key || !/^[a-f0-9]{64}$/.test(source.hash)) throw new Error('migration_source_invalid');
    const previous = this.rows('SELECT * FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
    const bound = previous?.object_id ? this.current(String(previous.object_id), false) : undefined;
    if (bound && (bound.kind !== input.kind || bound.projectId !== input.scope)) {
      this.db.run("UPDATE migration_items SET stage='conflict',error='source_binding_mismatch' WHERE source_identity=? AND source_key=?", [source.identity, source.key]);
      throw new Error('migration_conflict: source_binding_mismatch');
    }
    if (previous?.object_id && previous.source_hash === source.hash) {
      this.db.run("UPDATE migration_items SET stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [source.identity, source.key]);
      return { unchanged: true };
    }
    if (previous?.object_id) {
      const current = bound!;
      if (current.revision !== previous.imported_revision || current.kind !== input.kind || current.projectId !== input.scope) {
        this.db.run("UPDATE migration_items SET stage='conflict',error='newer_database_revision' WHERE source_identity=? AND source_key=?", [source.identity, source.key]);
        throw new Error('migration_conflict: newer_database_revision');
      }
      input = { ...input, action: 'patch', objectId: current.objectId, expectedRevision: current.revision, idempotencyKey: `${input.idempotencyKey}:after:${current.revision}` };
    }
    return { receipt: this.writeMutation(input, source), unchanged: false };
  }
  public importLessonSource(projectId: string, legacyId: string, data: Record<string, unknown>, source: ImportedSource, updatedAt: number, bytes: Uint8Array): { receipt?: WriteReceipt; unchanged: boolean } {
    return this.transaction(() => {
      const ids: string[] = typeof data.source_event_ids_json === 'string' ? JSON.parse(data.source_event_ids_json) : (data.source_event_ids_json as string[] || []);
      data = { ...data, event_refs: ids.map(sourceId => {
        const event = this.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [`${source.identity}:event`, canonical([projectId, sourceId])])[0];
        return { sourceId, objectId: event ? String(event.object_id) : null, revision: event ? Number(event.imported_revision) : null };
      }) };
      const binding = this.rows('SELECT * FROM legacy_lesson_sources WHERE source_identity=? AND project_id=? AND legacy_lesson_id=?', [source.identity, projectId, legacyId])[0];
      const previous = this.rows('SELECT object_id,source_hash FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
      if (binding && previous?.object_id === binding.object_id && previous.source_hash === source.hash) {
        this.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8' });
        const current = this.readMetadata(String(binding.object_id));
        {
          const existing = current.data.event_refs as Array<{ sourceId: string; objectId: string | null; revision: number | null }>;
          const mapped = new Map((data.event_refs as typeof existing).map(ref => [ref.sourceId, ref]));
          const resolved = existing.map(ref => ref.objectId === null ? mapped.get(ref.sourceId) || ref : ref);
          if (canonical(resolved) !== canonical(existing)) {
            const sourceOwned = current.revision === binding.imported_revision;
            const receipt = this.writeMutation({ kind: 'lesson', action: 'patch', scope: projectId, objectId: current.objectId, expectedRevision: current.revision, idempotencyKey: `resolve-lesson-events:${source.identity}:${legacyId}:${current.revision}:${digest(canonical(resolved))}`, data: { event_refs: resolved } }, sourceOwned ? source : undefined, source);
            if (sourceOwned) this.db.run('UPDATE legacy_lesson_sources SET imported_revision=? WHERE source_identity=? AND project_id=? AND legacy_lesson_id=?', [receipt.revision, source.identity, projectId, legacyId]);
            return { receipt, unchanged: false };
          }
        }
        return this.importObject({ kind: 'lesson', action: 'create', scope: projectId, idempotencyKey: `import-lesson:${source.identity}:${source.key}:${source.hash}`, data }, source);
      }
      const current = binding ? this.readMetadata(String(binding.object_id)) : undefined;
      if (current && current.revision !== binding.imported_revision) throw new Error('migration_conflict: newer_database_revision');
      if (binding && updatedAt < Number(binding.source_updated_at)) throw new Error('migration_conflict: older_learning_source_revision');
      if (binding && updatedAt === Number(binding.source_updated_at) && source.key !== binding.source_key) throw new Error('migration_conflict: ambiguous_learning_source_revision');
      this.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8' });
      const result = this.importObject({ kind: 'lesson', action: current ? 'patch' : 'create', scope: projectId, ...(current ? { objectId: current.objectId, expectedRevision: current.revision } : {}), idempotencyKey: `import-lesson:${source.identity}:${source.key}:${source.hash}:${current?.revision || 0}`, data }, source);
      if (result.receipt) this.db.run('INSERT INTO legacy_lesson_sources VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_identity,project_id,legacy_lesson_id) DO UPDATE SET imported_revision=excluded.imported_revision,source_updated_at=excluded.source_updated_at,source_key=excluded.source_key', [source.identity, projectId, legacyId, result.receipt.objectId, result.receipt.revision, updatedAt, source.key]);
      return result;
    });
  }
  public importLearningEventSource(projectId: string, legacyId: string, data: Record<string, unknown>, identity: string, bytes: Uint8Array): { receipt?: WriteReceipt; unchanged: boolean } {
    return this.transaction(() => {
      const key = canonical([projectId, legacyId]); const hash = digest(bytes);
      const source = { identity: `${identity}:event`, key, hash };
      const evidenceSource = { identity: `${identity}:event-evidence`, key, hash };
      const evidence = this.importObject({ kind: 'evidence', action: 'create', scope: projectId, idempotencyKey: `import-learning-evidence:${canonical(evidenceSource)}`, data: { type: 'legacy_learning_source', source_actor_id: this.actorId, content: Buffer.from(bytes).toString('utf8'), observed_at: Date.now() } }, evidenceSource);
      const binding = this.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [evidenceSource.identity, key])[0];
      if (!binding) throw new Error('migration_learning_source_missing');
      return this.importObject({ kind: 'learning_event', action: 'create', scope: projectId, idempotencyKey: `import-learning-event:${canonical(source)}`, data: { ...data, source_object_id: evidence.receipt?.objectId || String(binding.object_id), source_revision: evidence.receipt?.revision || Number(binding.imported_revision) } }, source);
    });
  }
  public importLearningDecisionSource(projectId: string, legacyId: string, eventId: string, candidateIds: string[], data: Record<string, unknown>, source: ImportedSource, bytes: Uint8Array): { receipt?: WriteReceipt; unchanged: boolean } {
    return this.transaction(() => {
      if (source.hash !== digest(bytes)) throw new Error('migration_source_invalid');
      const physical = this.rows('SELECT object_id,source_hash,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
      if (physical?.object_id && physical.source_hash === source.hash) {
        const original = this.readMetadata(String(physical.object_id), Number(physical.imported_revision));
        if (original.kind !== 'lesson_decision' || original.projectId !== projectId) throw new Error('migration_conflict: source_binding_mismatch');
        this.markMigrationSourceImported(source.identity, source.key); return { unchanged: true };
      }
      const key = canonical([projectId, legacyId]);
      const event = this.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [`${source.identity}:event`, canonical([projectId, eventId])])[0];
      if (!event) throw new Error('learning_event_mapping_required');
      const candidates = candidateIds.map(id => {
        const lesson = this.rows('SELECT object_id,imported_revision FROM legacy_lesson_sources WHERE source_identity=? AND project_id=? AND legacy_lesson_id=?', [source.identity, projectId, id])[0];
        if (!lesson) throw new Error('learning_lesson_mapping_required');
        return { objectId: String(lesson.object_id), revision: Number(lesson.imported_revision) };
      });
      const decisionSource = { identity: `${source.identity}:decision`, key, hash: source.hash };
      const previous = this.rows('SELECT object_id,source_hash,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [decisionSource.identity, key])[0];
      if (previous?.object_id && previous.source_hash !== source.hash) {
        const current = this.readMetadata(String(previous.object_id));
        if (current.revision !== previous.imported_revision) throw new Error('migration_conflict: newer_database_revision');
        if (Number(data.external_updated_at) < Number(current.data.external_updated_at)) throw new Error('migration_conflict: older_learning_source_revision');
        if (Number(data.external_updated_at) === Number(current.data.external_updated_at) && data.external_source !== current.data.external_source) throw new Error('migration_conflict: ambiguous_learning_source_revision');
      }
      const evidenceSource = { identity: `${source.identity}:decision-evidence`, key, hash: source.hash };
      const evidence = this.importObject({ kind: 'evidence', action: 'create', scope: projectId, idempotencyKey: `import-learning-decision-evidence:${canonical(evidenceSource)}`, data: { type: 'legacy_learning_decision_source', source_actor_id: this.actorId, content: Buffer.from(bytes).toString('utf8'), observed_at: Date.now() } }, evidenceSource);
      const evidenceBinding = this.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [evidenceSource.identity, key])[0];
      const imported = this.importObject({ kind: 'lesson_decision', action: 'create', scope: projectId, idempotencyKey: `import-learning-decision:${canonical(decisionSource)}`, data: { ...data, actor_id: this.actorId, legacy_decision_id: legacyId, event_id: String(event.object_id), event_revision: Number(event.imported_revision), lesson_id: candidates[0]?.objectId || null, lesson_revision: candidates[0]?.revision || null, candidate_refs: candidates, source_object_id: evidence.receipt?.objectId || String(evidenceBinding.object_id), source_revision: evidence.receipt?.revision || Number(evidenceBinding.imported_revision) } }, decisionSource);
      const decisionBinding = this.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [decisionSource.identity, key])[0];
      this.db.run('UPDATE migration_items SET source_hash=?,object_id=?,imported_revision=? WHERE source_identity=? AND source_key=?', [source.hash, decisionBinding.object_id, decisionBinding.imported_revision, source.identity, source.key]);
      this.markMigrationSourceImported(source.identity, source.key);
      return imported;
    });
  }
  private writeMutation(input: DataWrite, source?: ImportedSource, importedSource = source, updateSearch = true): WriteReceipt {
    const definition = this.definition(input.kind);
    if (!['create', 'patch', 'archive'].includes(input.action)) throw new Error('unknown_action');
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw new Error('idempotency_key_required');
    if (input.scope !== null && typeof input.scope !== 'string') throw new Error('scope_required');
    if (definition.project && !input.scope) throw new Error('project_scope_required');
    if (input.kind === 'project' && input.scope !== null) throw new Error('project_is_global');
    return this.recordMutation(source ? { input, source } : input, input.idempotencyKey, input.action, () => {
      const id = input.action === 'create' ? crypto.randomUUID() : input.objectId;
      if (!id) throw new Error('object_id_required');
      const time = Date.now();
      const fields = { ...input.data };
      if (input.kind === 'lesson' && Object.prototype.hasOwnProperty.call(fields, 'event_refs')) {
        if (!Array.isArray(fields.event_refs) || fields.event_refs.some(ref => !ref || typeof ref.sourceId !== 'string')) throw new Error('learning_event_reference_invalid');
        if (!Object.prototype.hasOwnProperty.call(fields, 'source_event_ids_json')) fields.source_event_ids_json = fields.event_refs.map(ref => ref.sourceId);
      }
      if (input.kind === 'lesson_decision' && Object.prototype.hasOwnProperty.call(fields, 'candidate_refs')) {
        if (!Array.isArray(fields.candidate_refs) || fields.candidate_refs.some(ref => !ref || typeof ref.objectId !== 'string' || !Number.isInteger(ref.revision) || ref.revision < 1)) throw new Error('learning_candidate_reference_invalid');
        const first = fields.candidate_refs[0];
        if (first && this.readMetadata(first.objectId, first.revision).kind !== 'lesson') throw new Error('relation_kind_mismatch');
        if (!Object.prototype.hasOwnProperty.call(fields, 'lesson_id')) fields.lesson_id = fields.candidate_refs[0]?.objectId ?? null;
        if (!Object.prototype.hasOwnProperty.call(fields, 'lesson_revision')) fields.lesson_revision = fields.candidate_refs[0]?.revision ?? null;
      }
      const data = this.normalizeData(input.kind, fields);
      if (input.kind === 'lesson_decision' && data.lesson_id && data.lesson_revision === undefined) {
        const previous = input.action === 'create' ? null : this.current(id);
        data.lesson_revision = previous?.data.lesson_id === data.lesson_id && previous.data.lesson_revision != null ? Number(previous.data.lesson_revision) : this.current(String(data.lesson_id), false).revision;
      }
      if (input.kind === 'lesson_decision' && data.lesson_id === null && data.lesson_revision === undefined) data.lesson_revision = null;
      if (input.kind === 'evidence' && this.rows("SELECT id FROM actors WHERE id=? AND kind='mcp'", [this.actorId]).length) {
        if (data.type !== 'agent_claim' || input.action !== 'create') throw new Error('host_observation_requires_authorization');
        data.source_actor_id = this.actorId;
        data.observed_at = time;
      }
      this.checkReferences(input.scope, data);
      const keys = Object.keys(data);
      if (input.action === 'create') {
        this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [id, input.kind, input.scope, 1, time, time]);
        this.db.run(`INSERT INTO ${definition.table}(id,project_id${keys.length ? ',' + keys.join(',') : ''}) VALUES(?,?${keys.map(() => ',?').join('')})`, [id, input.scope, ...keys.map(key => data[key])]);
      } else {
        const object = this.current(id);
        if (object.kind !== input.kind || object.projectId !== input.scope) throw new Error('scope_mismatch');
        if (!Number.isInteger(input.expectedRevision) || object.revision !== input.expectedRevision) throw new Error('revision_conflict');
        if (keys.length) this.db.run(`UPDATE ${definition.table} SET ${keys.map(key => key + '=?').join(',')} WHERE id=?`, [...keys.map(key => data[key]), id]);
        this.db.run('UPDATE objects SET revision=revision+1,updated_at=?,archived_at=? WHERE id=? AND revision=?', [time, input.action === 'archive' ? time : object.archivedAt, id, input.expectedRevision!]);
      }
      const object = this.current(id);
      if (input.kind === 'lesson_decision' && Object.prototype.hasOwnProperty.call(input.data, 'candidate_refs')) object.data.candidate_refs = input.data.candidate_refs;
      if (input.kind === 'lesson' && Object.prototype.hasOwnProperty.call(input.data, 'event_refs')) object.data.event_refs = input.data.event_refs;
      return object;
    }, (_eventId, object) => {
      if (source) this.db.run("INSERT INTO migration_items(source_identity,source_key,source_hash,object_id,imported_revision,stage,error) VALUES(?,?,?,?,?,'imported',NULL) ON CONFLICT(source_identity,source_key) DO UPDATE SET source_hash=excluded.source_hash,object_id=excluded.object_id,imported_revision=excluded.imported_revision,stage='imported',error=NULL", [source.identity, source.key, source.hash, object.objectId, object.revision]);
    }, updateSearch, importedSource);
  }
  private indexSearchObject(object: DataObject): void {
    const rowid = this.rows('SELECT rowid FROM objects WHERE id=?', [object.objectId])[0].rowid;
    const hostReview = object.kind === 'review_batch' && this.rows('SELECT 1 FROM learning_review_controls WHERE batch_id=?', [object.objectId]).length > 0;
    const data = hostReview ? agentReadableObject({ ...object, projection: { ...object.projection, hostReview: true } }).data : object.data;
    this.db.run('INSERT OR REPLACE INTO object_search(rowid,terms) VALUES(?,?)', [rowid, indexTokens(canonical(data))]);
  }
  private recordMutation(input: unknown, idempotencyKey: string, reason: string, mutation: () => DataObject, enqueue?: (eventId: string, object: DataObject) => void, updateSearch = true, importedSource?: ImportedSource): WriteReceipt {
    if (!idempotencyKey.trim()) throw new Error('idempotency_key_required');
    const inputHash = digest(canonical(input));
    return this.transaction(() => {
      const previous = this.rows('SELECT * FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, idempotencyKey])[0];
      if (previous) {
        if (previous.input_hash !== inputHash) throw new Error('idempotency_conflict');
        return JSON.parse(this.content(String(previous.result_content_id)).toString('utf8')) as WriteReceipt;
      }
      const requestId = crypto.randomUUID();
      this.db.run('INSERT INTO requests(actor_id,idempotency_key,id,input_hash,status) VALUES(?,?,?,?,?)', [this.actorId, idempotencyKey, requestId, inputHash, 'pending']);
      const object = mutation();
      const id = object.objectId;
      if (object.kind === 'lesson') {
        const ids: string[] = object.data.source_event_ids_json ? JSON.parse(String(object.data.source_event_ids_json)) : [];
        const previous = object.revision > 1 ? this.readMetadata(id, object.revision - 1) : null;
        const previousRefs = (previous?.data.event_refs || []) as Array<{ sourceId: string; objectId: string | null; revision: number | null }>;
        const legacyEvent = (sourceId: string) => this.rows("SELECT e.object_id,e.imported_revision FROM legacy_lesson_sources l JOIN migration_items e ON e.source_identity=l.source_identity || ':event' AND e.source_key=? WHERE l.object_id=?", [canonical([object.projectId, sourceId]), id])[0];
        const inherited = new Set(previousRefs.map(ref => canonical([ref.sourceId, ref.objectId, ref.revision])));
        const retained = new Map<string, { refs: typeof previousRefs; offset: number }>();
        for (const ref of previousRefs) {
          const group = retained.get(ref.sourceId) || { refs: [], offset: 0 };
          group.refs.push(ref); retained.set(ref.sourceId, group);
        }
        const unchanged = previous && canonical(previous.data.source_event_ids_json ? JSON.parse(String(previous.data.source_event_ids_json)) : []) === canonical(ids);
        const refs = Object.prototype.hasOwnProperty.call(object.data, 'event_refs') ? object.data.event_refs : unchanged ? previous.data.event_refs : ids.map(sourceId => {
          const group = retained.get(sourceId);
          const prior = group?.refs[group.offset++];
          if (prior) return prior;
          const event = this.rows('SELECT kind,revision FROM objects WHERE id=?', [sourceId])[0];
          if (event && event.kind !== 'learning_event') throw new Error('relation_kind_mismatch');
          if (!event) {
            const mapped = legacyEvent(sourceId);
            if (mapped) return { sourceId, objectId: String(mapped.object_id), revision: Number(mapped.imported_revision) };
          }
          return { sourceId, objectId: event ? sourceId : null, revision: event ? Number(event.revision) : null };
        });
        if (!Array.isArray(refs) || refs.length !== ids.length) throw new Error('learning_event_reference_invalid');
        for (const [ordinal, ref] of refs.entries()) {
          if (!ref || ref.sourceId !== ids[ordinal] || (ref.objectId === null) !== (ref.revision === null)) throw new Error('learning_event_reference_invalid');
          const historical = !!importedSource || inherited.has(canonical([ref.sourceId, ref.objectId, ref.revision]));
          const mapped = !historical && ref.sourceId !== ref.objectId ? legacyEvent(ref.sourceId) : undefined;
          if (mapped && mapped.object_id !== ref.objectId) throw new Error('learning_event_reference_mismatch');
          if (ref.objectId === null) {
            if (!historical && this.rows('SELECT 1 FROM objects WHERE id=?', [ref.sourceId]).length) throw new Error('learning_event_reference_mismatch');
            continue;
          }
          if (typeof ref.objectId !== 'string' || !Number.isInteger(ref.revision) || ref.revision < 1) throw new Error('learning_event_reference_invalid');
          const event = this.readMetadata(ref.objectId, ref.revision);
          if (event.kind !== 'learning_event') throw new Error('relation_kind_mismatch');
          if (event.projectId !== null && event.projectId !== object.projectId) throw new Error('scope_mismatch');
          if (!historical && ref.sourceId !== ref.objectId && (!mapped || mapped.object_id !== ref.objectId)) throw new Error('learning_event_reference_mismatch');
        }
        object.data.event_refs = refs;
      }
      if (object.kind === 'lesson_decision') {
        const previous = object.revision > 1 ? this.readMetadata(id, object.revision - 1) : null;
        const explicit = Object.prototype.hasOwnProperty.call(object.data, 'candidate_refs');
        const inherited = !explicit && previous && previous.data.lesson_id === object.data.lesson_id && (previous.data.lesson_revision ?? null) === object.data.lesson_revision;
        const refs = explicit ? object.data.candidate_refs : inherited ? previous.data.candidate_refs : object.data.lesson_id ? [{ objectId: object.data.lesson_id, revision: object.data.lesson_revision }] : [];
        if (!Array.isArray(refs) || refs.some(ref => !ref || typeof ref.objectId !== 'string' || !(inherited && ref.revision === null) && (!Number.isInteger(ref.revision) || ref.revision < 1))) throw new Error('learning_candidate_reference_invalid');
        for (const ref of refs) {
          const lesson = this.readMetadata(ref.objectId, ref.revision ?? undefined);
          if (lesson.kind !== 'lesson') throw new Error('relation_kind_mismatch');
          if (lesson.projectId !== null && lesson.projectId !== object.projectId) throw new Error('scope_mismatch');
        }
        if ((refs[0]?.objectId ?? null) !== object.data.lesson_id || (refs[0]?.revision ?? null) !== object.data.lesson_revision) throw new Error('learning_candidate_reference_mismatch');
        object.data.candidate_refs = refs;
      }
      if (updateSearch) this.indexSearchObject(object);
      const time = Date.now();
      const snapshotId = this.putContent(this.snapshot(object), 'application/json');
      this.db.run('INSERT INTO object_revisions VALUES(?,?,?,?,?,?)', [id, object.revision, snapshotId, this.actorId, reason, time]);
      if (object.kind === 'report') this.indexReportRevision(object, time);
      if (object.projectId && ['task', 'turn', 'conversation', 'report', 'growth_snapshot'].includes(object.kind)) this.bumpReportSourceRevision(object.projectId);
      if (object.kind === 'lesson') (object.data.event_refs as Array<{ sourceId: string; objectId: string | null; revision: number | null }>).forEach((ref, ordinal) => this.db.run('INSERT INTO lesson_event_refs VALUES(?,?,?,?,?,?,?)', [id, object.revision, ordinal, object.projectId, ref.sourceId, ref.objectId, ref.revision]));
      if (object.kind === 'lesson_decision') (object.data.candidate_refs as Array<{ objectId: string; revision: number | null }>).forEach((candidate, ordinal) => this.db.run('INSERT INTO lesson_decision_candidates VALUES(?,?,?,?,?,?)', [id, object.revision, ordinal, object.projectId, candidate.objectId, candidate.revision]));
      const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM events')[0].next);
      const eventId = crypto.randomUUID();
      this.db.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', [eventId, sequence, id, this.actorId, `${object.kind}.${reason}`, snapshotId, time, requestId]);
      enqueue?.(eventId, object);
      const pendingEffects = this.rows("SELECT id FROM outbox WHERE event_id=? AND state<>'delivered'", [eventId]).map(row => String(row.id));
      const receipt: WriteReceipt = { requestId, objectId: id, revision: object.revision, committedSequence: sequence, status: 'committed', pendingEffects };
      const resultId = this.putContent(canonical(receipt), 'application/json');
      this.db.run('UPDATE requests SET status=?,result_content_id=?,committed_sequence=? WHERE id=?', ['committed', resultId, sequence, requestId]);
      return receipt;
    });
  }
  private syncProjectRegistryMetadata(projectId: string, project: ProjectRegistryFile['projects'][number], hidden: boolean): void {
    const current = this.current(projectId, false);
    const pinnedAt = project.pinnedAt ? Date.parse(project.pinnedAt) : null;
    if (pinnedAt !== null && !Number.isFinite(pinnedAt)) throw new Error('project_registry_pin_invalid');
    const desired: Record<string, unknown> = { name: project.name, type: project.type || null, priority: project.priority || null, description: project.description || null, hidden: hidden ? 1 : 0, pinned_at: pinnedAt };
    const data = Object.fromEntries(Object.entries(desired).filter(([key, value]) => current.data[key] !== value));
    const notesId = current.data.notes_content_id;
    const notesHash = notesId ? this.rows('SELECT sha256 FROM contents WHERE id=?', [String(notesId)])[0]?.sha256 : null;
    if (notesHash !== (project.notes ? digest(project.notes) : null)) data.notes_content = project.notes || null;
    if (!Object.keys(data).length) return;
    this.write({ kind: 'project', action: 'patch', scope: null, objectId: projectId, expectedRevision: current.revision,
      idempotencyKey: `project-registry-metadata:${projectId}:${current.revision}:${digest(canonical(data))}`, data });
  }

  private syncKnownRegistryProjects(registry: ProjectRegistryFile, roots?: string[], previous?: ProjectRegistryFile): void {
    const selectedRoots = roots || registry.projects.map(project => project.path);
    for (const root of new Set(selectedRoots)) {
      const logicalRoot = path.resolve(root);
      let physicalRoot: string | undefined;
      try { physicalRoot = fs.realpathSync(root); } catch { /* Offline aliases keep their accepted database binding. */ }
      const binding = physicalRoot ? this.projectRegistryAliasTarget(logicalRoot, physicalRoot) : undefined;
      const locations = this.rows(`SELECT DISTINCT project_id FROM project_locations WHERE device_id=? AND root_path=? AND ${physicalRoot ? "status='active'" : "status IN ('active','alias')"}`, [this.deviceId, physicalRoot || logicalRoot]);
      if (!locations.length && binding) locations.push({ project_id: binding });
      if (locations.length !== 1) continue;
      if (physicalRoot) this.bindProjectRegistryAlias(String(locations[0].project_id), logicalRoot, physicalRoot);
      const project = registry.projects.find(item => item.path === root) || previous?.projects.find(item => item.path === root);
      if (project) this.syncProjectRegistryMetadata(String(locations[0].project_id), project, !registry.projects.some(item => item.path === root) || registry.hiddenProjects.includes(root));
    }
  }

  private projectRegistryAliasTarget(logicalRoot: string, physicalRoot: string): string | undefined {
    const bindings = this.rows("SELECT DISTINCT project_id FROM project_locations WHERE device_id=? AND root_path=? AND status='alias'", [this.deviceId, logicalRoot]);
    if (!bindings.length) return;
    if (bindings.length !== 1) throw new Error('project_registry_alias_conflict');
    const projectId = String(bindings[0].project_id);
    const targets = this.rows("SELECT DISTINCT project_id FROM project_locations WHERE device_id=? AND root_path=? AND status='active'", [this.deviceId, physicalRoot]);
    if (targets.length) {
      if (targets.length !== 1 || targets[0].project_id !== projectId) throw new Error('project_registry_alias_conflict');
    } else {
      try {
        const identity = JSON.parse(fs.readFileSync(path.join(physicalRoot, '.solopreneur', 'project.json'), 'utf8'));
        if (identity.schemaVersion !== 1 || identity.projectId !== projectId) throw new Error('project_registry_alias_conflict');
      } catch { throw new Error('project_registry_alias_conflict'); }
    }
    return projectId;
  }

  private bindProjectRegistryAlias(projectId: string, logicalRoot: string, physicalRoot: string): boolean {
    if (logicalRoot === physicalRoot) return false;
    const locations = this.rows("SELECT project_id FROM project_locations WHERE device_id=? AND root_path=? AND status IN ('active','alias')", [this.deviceId, logicalRoot]);
    if (locations.some(location => location.project_id !== projectId)) throw new Error('project_registry_alias_conflict');
    if (locations.length) return false;
    this.db.run('INSERT INTO project_locations VALUES(?,?,?,?,?)', [crypto.randomUUID(), projectId, this.deviceId, logicalRoot, 'alias']);
    return true;
  }

  private projectRegistryContextImported(): boolean {
    return Boolean(this.rows("SELECT 1 FROM migration_items WHERE source_identity=? AND source_key='vscode-project-state' AND stage='imported'", [`project-registry:${this.root}`]).length);
  }

  private importProjectRegistryContext(input: ProjectRegistryBootstrap): ProjectRegistrySnapshot {
    return this.transaction(() => {
      const current = this.readProjectRegistry() as ProjectRegistrySnapshot;
      const hasContext = ['legacyProjects', 'legacyHiddenProjects', 'legacySelectedProjectPath'].some(key => Object.prototype.hasOwnProperty.call(input, key));
      if (!hasContext || current.legacyContextImported) return current;
      const bytes = Buffer.from(canonical(input));
      const source = { identity: `project-registry:${this.root}`, key: 'vscode-project-state', hash: digest(bytes) };
      this.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8' });
      const fileImported = this.rows("SELECT 1 FROM migration_items WHERE source_identity=? AND source_key='projects.json' AND stage='imported'", [source.identity]).length > 0;
      const additions = fileImported ? [] : normalizeProjectsForStorage(input.legacyProjects || []).filter(project => path.isAbsolute(project.path) && !current.registry.projects.some(existing => existing.path === project.path));
      const workspace = String(input.workspaceRoot || '').trim();
      if (workspace && path.isAbsolute(workspace) && !current.registry.projects.some(project => project.path === workspace) && !additions.some(project => project.path === workspace) && !(input.legacyHiddenProjects || []).includes(workspace)) additions.push({ name: projectName(workspace), path: workspace });
      const selected = String(input.legacySelectedProjectPath || '');
      const seedSelection = current.revision === 1 && !current.registry.selectedProjectPath && selected && [...current.registry.projects, ...additions].some(project => project.path === selected);
      const hiddenPatches = fileImported ? [] : (input.legacyHiddenProjects || []).filter(projectPath => path.isAbsolute(projectPath) && !current.registry.hiddenProjects.includes(projectPath)).map(projectPath => ({ path: projectPath, hidden: true }));
      const target = additions.length || hiddenPatches.length || seedSelection
        ? this.patchProjectRegistry({ expectedRevision: current.revision, projectPatches: additions.map(({ path: projectPath, ...fields }) => ({ path: projectPath, fields })), hiddenPatches, ...(seedSelection ? { selectedProjectPath: selected } : {}), idempotencyKey: `project-registry-context:${source.hash}` })
        : current;
      this.db.run("UPDATE migration_items SET source_hash=?,object_id=?,imported_revision=?,stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [source.hash, target.objectId, target.revision, source.identity, source.key]);
      return this.readProjectRegistry() as ProjectRegistrySnapshot;
    });
  }

  public readProjectRegistry(input: { revision?: number; knownRevision?: number; knownObjectId?: string } = {}): ProjectRegistrySnapshot | { objectId: string; revision: number; unchanged: true; legacyContextImported: boolean } | null {
    const row = this.rows("SELECT s.id,o.revision FROM settings s JOIN objects o ON o.id=s.id WHERE s.namespace='project_registry' AND s.key='registry' AND s.owner_scope='global' AND o.archived_at IS NULL")[0];
    if (!row) return null;
    const legacyContextImported = this.projectRegistryContextImported();
    if (input.revision === undefined && input.knownRevision === Number(row.revision) && (!input.knownObjectId || input.knownObjectId === row.id)) return { objectId: String(row.id), revision: Number(row.revision), unchanged: true, legacyContextImported };
    const object = this.read(String(row.id), input.revision);
    return { objectId: object.objectId, revision: object.revision, legacyContextImported, registry: JSON.parse(String(object.data.content)) };
  }

  public async initializeProjectRegistry(input: { legacyProjects?: ProjectRegistryFile['projects']; legacyHiddenProjects?: string[]; legacySelectedProjectPath?: string; workspaceRoot?: string } = {}): Promise<ProjectRegistrySnapshot> {
    const existing = this.readProjectRegistry();
    if (existing) return this.importProjectRegistryContext(input);
    const file = path.join(this.root, 'projects.json');
    let legacy: Partial<ProjectRegistryFile> = {};
    let registrySource: ImportedSource | undefined;
    try {
      const before = await fs.promises.lstat(file);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('project_registry_source_invalid');
      const bytes = await fs.promises.readFile(file);
      const after = await fs.promises.lstat(file);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('project_registry_source_changed');
      registrySource = { identity: `project-registry:${this.root}`, key: 'projects.json', hash: digest(bytes) };
      try {
        legacy = JSON.parse(bytes.toString('utf8'));
        if (!legacy || !Array.isArray(legacy.projects) || legacy.hiddenProjects !== undefined && !Array.isArray(legacy.hiddenProjects)) throw new Error('project_registry_source_invalid');
      } catch {
        this.captureMigrationSource(registrySource, bytes, { mimeType: 'application/json', encoding: 'utf8', error: 'project_registry_source_invalid' });
        throw new Error('project_registry_source_invalid');
      }
      this.captureMigrationSource(registrySource, bytes, { mimeType: 'application/json', encoding: 'utf8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      legacy = { projects: input.legacyProjects || [], hiddenProjects: input.legacyHiddenProjects || [] };
    }
    if (!registrySource) {
      const bytes = Buffer.from(canonical(input));
      registrySource = { identity: `project-registry:${this.root}`, key: 'registry-bootstrap', hash: digest(bytes) };
      this.captureMigrationSource(registrySource, bytes, { mimeType: 'application/json', encoding: 'utf8' });
    }
    return this.transaction(() => {
      const current = this.readProjectRegistry();
      if (current) return this.importProjectRegistryContext(input);
      const projects = normalizeProjectsForStorage(legacy.projects || []);
      const hiddenProjects = [...new Set((legacy.hiddenProjects || []).map(item => String(item).trim()).filter(Boolean))];
      const workspaceRoot = String(input.workspaceRoot || '').trim();
      if (workspaceRoot && !hiddenProjects.includes(workspaceRoot) && !projects.some(project => project.path === workspaceRoot)) projects.unshift({ name: projectName(workspaceRoot), path: workspaceRoot });
      const selected = String(input.legacySelectedProjectPath || '');
      const registry: ProjectRegistryFile = { schemaVersion: 1, updatedAt: String(legacy.updatedAt || new Date().toISOString()), projects, hiddenProjects, selectedProjectPath: projects.some(project => project.path === selected) ? selected : '' };
      const imported = this.importObject({ kind: 'setting', action: 'create', scope: null, idempotencyKey: `initialize-project-registry:${digest(canonical(registry))}`, data: { namespace: 'project_registry', key: 'registry', owner_scope: 'global', content: canonical(registry) } }, registrySource!);
      if (!imported.receipt) throw new Error('project_registry_import_missing');
      this.syncKnownRegistryProjects(registry);
      return this.importProjectRegistryContext(input);
    });
  }

  public patchProjectRegistry(input: ProjectRegistryPatch): ProjectRegistrySnapshot {
    const fields = new Set(['name', 'type', 'priority', 'description', 'notes', 'pinnedAt']);
    const validPath = (value: unknown) => typeof value === 'string' && value.trim() === value && path.isAbsolute(value);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1 || !input.idempotencyKey
      || input.projectPatches !== undefined && !Array.isArray(input.projectPatches)
      || input.hiddenPatches !== undefined && !Array.isArray(input.hiddenPatches)
      || input.selectedProjectPath !== undefined && input.selectedProjectPath !== '' && !validPath(input.selectedProjectPath)) throw new Error('invalid_project_registry_patch');
    for (const patch of input.projectPatches || []) {
      if (!patch || !validPath(patch.path) || patch.remove !== undefined && typeof patch.remove !== 'boolean'
        || patch.fields !== undefined && (!patch.fields || Array.isArray(patch.fields) || typeof patch.fields !== 'object' || Object.entries(patch.fields).some(([key, value]) => !fields.has(key) || typeof value !== 'string'))
        || patch.remove !== true && patch.fields === undefined) throw new Error('invalid_project_registry_patch');
    }
    for (const patch of input.hiddenPatches || []) if (!patch || !validPath(patch.path) || typeof patch.hidden !== 'boolean') throw new Error('invalid_project_registry_patch');
    const { expectedRevision: _expectedRevision, ...intent } = input;
    const receipt = this.recordMutation({ operation: 'patch_project_registry', input: intent }, input.idempotencyKey, 'project_registry', () => {
      const current = this.readProjectRegistry() as ProjectRegistrySnapshot | null;
      if (!current || current.revision !== input.expectedRevision) throw new Error('revision_conflict');
      let projects = [...current.registry.projects];
      for (const patch of input.projectPatches || []) {
        if (patch.remove) projects = projects.filter(project => project.path !== patch.path);
        else {
          const index = projects.findIndex(project => project.path === patch.path);
          const project = { ...(index < 0 ? { name: projectName(patch.path), path: patch.path } : projects[index]), ...patch.fields };
          if (index < 0) projects.push(project); else projects[index] = project;
        }
      }
      const hidden = new Set(current.registry.hiddenProjects);
      for (const patch of input.hiddenPatches || []) { if (patch.hidden) hidden.add(patch.path); else hidden.delete(patch.path); }
      const selected = input.selectedProjectPath ?? current.registry.selectedProjectPath ?? '';
      const registry: ProjectRegistryFile = { schemaVersion: 1, updatedAt: new Date().toISOString(), projects: normalizeProjectsForStorage(projects), hiddenProjects: [...hidden], selectedProjectPath: projects.some(project => project.path === selected) ? selected : '' };
      this.syncKnownRegistryProjects(registry, [...(input.projectPatches || []).map(patch => patch.path), ...(input.hiddenPatches || []).map(patch => patch.path)], current.registry);
      this.db.run('UPDATE settings SET content_id=? WHERE id=?', [this.putContent(canonical(registry), 'application/json'), current.objectId]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), current.objectId]);
      return this.current(current.objectId, false);
    });
    const object = this.read(receipt.objectId, receipt.revision);
    return { objectId: object.objectId, revision: object.revision, legacyContextImported: this.projectRegistryContextImported(), registry: JSON.parse(String(object.data.content)) };
  }

  public async registerProject(input: { root: string; name?: string }): Promise<{ projectId: string; locationId: string; identityPath: string }> {
    if (!input.root || !fs.statSync(input.root).isDirectory()) throw new Error('project_root_required');
    const root = fs.realpathSync(input.root);
    this.projectRegistryAliasTarget(path.resolve(input.root), root);
    let registration = this.projectRegistrations.get(root);
    if (!registration) {
      registration = this.registerProjectOnce({ ...input, root, registryRoot: path.resolve(input.root) }).finally(() => { this.projectRegistrations.delete(root); });
      this.projectRegistrations.set(root, registration);
    }
    const registered = await registration;
    const logicalRoot = path.resolve(input.root);
    if (logicalRoot !== root) this.transaction(() => {
      if (!this.bindProjectRegistryAlias(registered.projectId, logicalRoot, root)) return;
      this.recordMutation({ operation: 'register_project_alias', root: logicalRoot, projectId: registered.projectId }, `project-alias:${this.deviceId}:${logicalRoot}:${registered.projectId}`, 'register', () => {
        this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), registered.projectId]);
        return this.current(registered.projectId);
      });
    });
    return registered;
  }
  private async registerProjectOnce(input: { root: string; name?: string; registryRoot: string }): Promise<{ projectId: string; locationId: string; identityPath: string }> {
    const root = input.root;
    const identityPath = path.join(root, '.solopreneur', 'project.json');
    let identityId: string | undefined;
    try {
      const value = JSON.parse(await fs.promises.readFile(identityPath, 'utf8')) as { schemaVersion: number; projectId: string };
      if (value.schemaVersion !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.projectId)) throw new Error('project_identity_invalid');
      identityId = value.projectId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`project_identity_invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const location = this.rows("SELECT * FROM project_locations WHERE device_id=? AND root_path=? AND status='active'", [this.deviceId, root])[0];
    if (identityId && location && identityId !== location.project_id) throw new Error('project_identity_conflict');
    const projectId = identityId || (location ? String(location.project_id) : crypto.randomUUID());
    const registrationKey = `project-location:${this.deviceId}:${root}:${projectId}`;
    const identityBody = JSON.stringify({ schemaVersion: 1, projectId }) + '\n';
    const receipt = this.recordMutation({ operation: 'register_project', root, projectId }, registrationKey, 'register', () => {
      const existing = this.rows('SELECT * FROM objects WHERE id=?', [projectId])[0];
      const time = Date.now();
      if (existing) {
        if (existing.kind !== 'project') throw new Error('project_identity_conflict');
        this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [time, projectId]);
      } else {
        this.db.run('INSERT INTO objects VALUES(?,?,NULL,?,?,?,NULL)', [projectId, 'project', 1, time, time]);
        this.db.run('INSERT INTO projects(id,name) VALUES(?,?)', [projectId, input.name || path.basename(root)]);
      }
      if (!location) this.db.run('INSERT INTO project_locations VALUES(?,?,?,?,?)', [crypto.randomUUID(), projectId, this.deviceId, root, 'active']);
      return this.current(projectId);
    }, (eventId) => {
      this.db.run('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,0,NULL)', [crypto.randomUUID(), eventId, 'project_identity', identityPath, this.putContent(identityBody, 'application/json'), 1, 'pending']);
    });
    await fs.promises.mkdir(path.dirname(identityPath), { recursive: true });
    try { await fs.promises.writeFile(identityPath, identityBody, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = JSON.parse(await fs.promises.readFile(identityPath, 'utf8')) as { schemaVersion: number; projectId: string };
      if (current.schemaVersion !== 1 || current.projectId !== projectId) throw new Error('project_identity_conflict');
    }
    this.db.run("UPDATE outbox SET state='delivered',attempt=attempt+1 WHERE state<>'delivered' AND event_id IN (SELECT id FROM events WHERE request_id=?)", [receipt.requestId]);
    const saved = this.rows("SELECT id FROM project_locations WHERE project_id=? AND device_id=? AND root_path=? AND status='active'", [projectId, this.deviceId, root])[0];
    if (!location) {
      const registry = (this.readProjectRegistry() as ProjectRegistrySnapshot | null)?.registry;
      const metadata = registry?.projects.find(project => path.resolve(project.path) === root || path.resolve(project.path) === input.registryRoot);
      if (metadata) this.syncProjectRegistryMetadata(projectId, metadata, registry!.hiddenProjects.includes(metadata.path));
    }
    return { projectId, locationId: String(saved.id), identityPath };
  }
  public registeredProjectRoots(): string[] {
    return this.rows("SELECT root_path FROM project_locations WHERE device_id=? AND status='active' ORDER BY root_path", [this.deviceId])
      .map(row => String(row.root_path));
  }
  private learningReviewManifest(saved: any): ReviewManifest {
    const restore = (source: ReviewSource): ReviewSource => ({ ...source, content: this.content(String(saved.sourceContents[`${source.id}:${source.hash}:${source.contentHash}`] || saved.sourceContents[`${source.id}:${source.hash}`])).toString('utf8'), ...(source.previousVersions ? { previousVersions: source.previousVersions.map(restore) } : {}) });
    return { ...saved.manifest, sources: saved.manifest.sources.map(restore) };
  }
  public importLegacyLearningReview(input: { identity: string; runKey: string; manifest: ReviewManifest; proposal: string | null; application: any | null; targets?: LegacyReviewTarget[]; files: Array<{ key: string; hash: string }> }): { unchanged: boolean } {
    return this.transaction(() => {
      const sourceContents: Record<string, string> = {};
      const compact = (source: ReviewSource): ReviewSource => {
        const body = legacyReviewSourceBody(source);
        sourceContents[`${source.id}:${source.hash}:${digest(body)}`] = this.putContent(body);
        return { ...source, content: '', contentHash: digest(body), ...(source.previousVersions ? { previousVersions: source.previousVersions.map(compact) } : {}) };
      };
      const manifest = { ...input.manifest, sources: input.manifest.sources.map(compact) };
      const applicationSources = [...(input.application?.sourceCursor || []), ...(input.application?.deferredSources || [])].map(compact);
      const saved = { runId: input.manifest.runId, manifest, sourceContents, applicationSources, legacy: true, sourceIdentity: input.identity, sourceKey: input.runKey, ...(input.targets ? { legacyTargets: input.targets, legacyApplication: input.application } : {}) };
      const targetProofs = input.targets?.map(target => ({ key: target.key, afterSource: target.afterSource || null, afterError: target.afterError || null }));
      const hash = digest(canonical({ files: input.files.map(file => ({ key: file.key, hash: file.hash })), ...(targetProofs ? { targetProofs } : {}) }));
      const batchSource = { identity: `${input.identity}:batch`, key: input.runKey, hash };
      const afterErrors = input.targets?.filter(target => target.afterError).map(target => `${target.key}: ${target.afterError}`).join('; ');
      const markFiles = (): void => {
        for (const file of input.files) {
          if (afterErrors) this.markMigrationSourceConflict(input.identity, file.key, afterErrors);
          else this.markMigrationSourceImported(input.identity, file.key);
        }
      };
      const imported = this.importObject({ kind: 'review_batch', action: 'create', scope: null, idempotencyKey: `legacy-review:${canonical(batchSource)}`, data: { input_cursor: 0, input_hash: digest(JSON.stringify(input.manifest)), proposal_content: input.proposal, review_content: JSON.stringify(saved), status: input.application?.status || 'interrupted' } }, batchSource);
      if (imported.unchanged) {
        markFiles();
        return { unchanged: true };
      }
      const bound = this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [batchSource.identity, batchSource.key])[0];
      const batchId = imported.receipt?.objectId || String(bound.object_id);
      this.db.run('INSERT INTO legacy_learning_review_controls VALUES(?,?,?,?) ON CONFLICT(batch_id) DO UPDATE SET input_content_id=excluded.input_content_id', [batchId, this.readMetadata(batchId).data.review_content_id as string, input.identity, input.runKey]);
      if (input.application) {
        const application = input.application;
        const file = input.files.find(item => item.key === `${input.runKey}/application.json`)!;
        const targets: LegacyReviewTarget[] = input.targets || [{ key: 'globalPrompt', kind: 'policy', scope: null, data: { kind: 'legacy_global_prompt', status: 'historical', content: application.targetPrompt }, before: null, after: application.targetPrompt, status: application.status, binding: null }];
        for (const entry of targets) {
          const key = input.targets ? `${input.runKey}#${entry.key}` : input.runKey;
          const targetSource = { identity: `${input.identity}:target`, key, hash: input.targets ? digest(canonical(entry.data)) : digest(application.targetPrompt) };
          const target = this.importObject({ kind: entry.kind, action: 'create', scope: entry.scope, idempotencyKey: `legacy-review:${canonical(targetSource)}`, data: entry.data }, targetSource);
          const targetId = target.receipt?.objectId || String(this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [targetSource.identity, targetSource.key])[0].object_id);
          const snapshot = this.readMetadata(targetId);
          if (entry.kind !== 'policy' && snapshot.archivedAt === null) this.writeMutation({ kind: entry.kind, action: 'archive', scope: entry.scope, objectId: targetId, expectedRevision: snapshot.revision, idempotencyKey: `legacy-review-target:${canonical(targetSource)}:archive`, data: {} }, targetSource);
          const applicationSource = { identity: `${input.identity}:application`, key, hash: input.targets ? digest(canonical({ journal: file.hash, afterSource: entry.afterSource || null, afterError: entry.afterError || null })) : file.hash };
          this.importObject({ kind: 'application', action: 'create', scope: entry.scope, idempotencyKey: `legacy-review:${canonical(applicationSource)}`, data: { review_id: batchId, target_object_id: targetId, expected_revision: 0, before_content: entry.before, after_content: entry.after, status: entry.status, applied_revision: null } }, applicationSource);
        }
      }
      for (const file of input.files) {
        const captured = this.readMigrationSource(input.identity, file.key);
        if (captured.hash !== file.hash) throw new Error('legacy_review_artifact_changed');
        const source = { identity: input.identity, key: file.key, hash: file.hash };
        const artifact = this.importObject({ kind: 'evidence', action: 'create', scope: null, idempotencyKey: `legacy-review-artifact:${canonical(source)}`, data: { type: 'legacy_review_artifact', source_actor_id: this.actorId, observed_at: 0, content: { encoding: 'base64', data: captured.bytes.toString('base64'), mimeType: 'application/octet-stream' } } }, source);
        const artifactId = artifact.receipt?.objectId || String(this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [input.identity, file.key])[0].object_id);
        const batch = this.readMetadata(batchId);
        if (!batch.relations.some(link => link.relation === 'source' && link.target === artifactId)) this.link({ source: batchId, relation: 'source', target: artifactId, expectedRevision: batch.revision, idempotencyKey: `legacy-review-artifact-link:${canonical(batchSource)}:${artifactId}` });
      }
      this.db.run('UPDATE migration_items SET imported_revision=? WHERE source_identity=? AND source_key=?', [this.readMetadata(batchId).revision, batchSource.identity, batchSource.key]);
      markFiles();
      return { unchanged: false };
    });
  }
  private globalPromptPolicyReference(): { objectId: string; revision: number } | null {
    const policies = this.rows("SELECT p.id,o.revision FROM policies p JOIN objects o ON o.id=p.id WHERE p.kind='global_prompt' AND p.status='active' AND o.project_id IS NULL AND o.archived_at IS NULL");
    if (policies.length > 1) throw new Error('global_prompt_policy_conflict');
    return policies.length ? { objectId: String(policies[0].id), revision: Number(policies[0].revision) } : null;
  }
  public readGlobalPromptPolicy(): DataObject | null {
    const reference = this.globalPromptPolicyReference();
    return reference ? this.read(reference.objectId, reference.revision) : null;
  }
  private canonicalLegacyReviewTarget(target: LegacyReviewTarget): DataObject | null {
    if (!target.binding) return null;
    if (target.kind === 'lesson' && (!target.legacyId || !target.scope)) throw new Error('legacy_review_target_missing');
    const row = target.kind === 'lesson'
      ? this.rows('SELECT object_id FROM legacy_lesson_sources WHERE source_identity=? AND project_id=? AND legacy_lesson_id=?', [target.binding.identity, target.scope, target.legacyId!])[0]
      : this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [target.binding.identity, target.binding.key])[0];
    if (!row?.object_id) return null;
    const object = this.read(String(row.object_id));
    if (object.kind !== target.kind || object.projectId !== target.scope) throw new Error('legacy_review_target_scope_mismatch');
    return object;
  }
  private legacyReviewApplicationTargets(saved: any): Map<string, LegacyReviewTarget> {
    const result = new Map<string, LegacyReviewTarget>();
    if (!saved.legacyTargets?.length) return result;
    const targets = new Map<string, LegacyReviewTarget>(saved.legacyTargets.map((target: LegacyReviewTarget) => [target.key, target]));
    const prefix = `${saved.sourceKey}#`;
    for (const row of this.rows('SELECT source_key,object_id FROM migration_items WHERE source_identity=? AND source_key>=? AND source_key<?', [`${saved.sourceIdentity}:target`, prefix, `${saved.sourceKey}$`])) {
      const target = targets.get(String(row.source_key).slice(prefix.length));
      if (target && row.object_id) result.set(String(row.object_id), target);
    }
    return result;
  }
  private resumeLegacyReviewTarget(pending: any, idempotencyKey: string): WriteReceipt | { objectId: string; revision: number } {
    const source = this.read(pending.legacyTarget.batchId, pending.legacyTarget.revision);
    const saved = JSON.parse(String(source.data.review_content));
    const target = (saved.legacyTargets || []).find((target: LegacyReviewTarget) => target.key === pending.legacyTarget.key) as LegacyReviewTarget | undefined;
    if (!target || !target.binding || target.kind === 'policy') throw new Error('legacy_review_target_missing');
    const current = this.canonicalLegacyReviewTarget(target);
    if ((current?.objectId || null) !== (pending.targetRef?.objectId || null) || (current?.revision || null) !== (pending.targetRef?.revision || null)) throw new Error('learning_review_target_revision_conflict');
    if (current && current.archivedAt !== null) throw new Error('learning_review_target_archived');
    if (target.kind === 'memory') {
      if (!current) throw new Error('learning_review_target_import_required');
      if (current.data.content === target.after) return { objectId: current.objectId, revision: current.revision };
      if (current.data.content !== target.before) throw new Error('learning_review_target_changed');
      return this.write({ kind: 'memory', action: 'patch', scope: target.scope, objectId: current.objectId, expectedRevision: current.revision, idempotencyKey, data: { content: target.after } });
    }
    if (!target.legacyId || !target.scope) throw new Error('legacy_review_target_missing');
    if (target.afterError || target.after === 'null') throw new Error('legacy_review_lesson_after_missing');
    const lesson = JSON.parse(target.after);
    const sourceRef = { objectId: source.objectId, revision: source.revision, scope: source.projectId };
    const data = { status: lesson.status, summary: lesson.summary, applies_when: lesson.appliesWhen, does_not_apply_when: lesson.doesNotApplyWhen, do_this: lesson.doThis, avoid_this: lesson.avoidThis, verification: lesson.verification,
      legacy_lesson_id: target.legacyId, semantic_review_json: { schemaVersion: 2, runId: saved.runId, proposalHash: saved.legacyApplication.proposalHash, evidence: lesson.evidence, target: lesson.target || '', reason: lesson.reason, sourceRef } };
    if (current) {
      const same = Object.entries(data).filter(([key]) => key !== 'semantic_review_json').every(([key, value]) => current.data[key] === value);
      const prior = typeof current.data.semantic_review_json === 'string' ? JSON.parse(current.data.semantic_review_json) : current.data.semantic_review_json as any;
      if (same && prior?.proposalHash === saved.legacyApplication.proposalHash) return { objectId: current.objectId, revision: current.revision };
      if (!target.beforeData || !Object.entries(target.beforeData).every(([key, value]) => {
        const currentValue = key.endsWith('_json') && typeof current.data[key] === 'string' ? JSON.parse(current.data[key] as string) : current.data[key];
        return currentValue !== undefined && canonical(currentValue) === canonical(value);
      })) throw new Error('learning_review_target_changed');
    } else if (target.before !== null) throw new Error('learning_review_target_import_required');
    if (lesson.status === 'promoted') {
      const memory = (saved.legacyTargets || []).find((entry: LegacyReviewTarget) => entry.kind === 'memory' && entry.path === lesson.target);
      const canonical = memory ? this.canonicalLegacyReviewTarget(memory) : null;
      if (!canonical || canonical.archivedAt !== null || canonical.data.content !== memory.after) throw new Error('learning_review_promotion_target_unapplied');
    }
    const receipt = this.write({ kind: 'lesson', action: current ? 'patch' : 'create', scope: target.scope, ...(current ? { objectId: current.objectId, expectedRevision: current.revision } : {}), idempotencyKey,
      data: { ...data, ...(current ? {} : { confidence: 0, source_type: 'review', lesson_type: 'implementation_pattern', evidence_refs_json: [{ type: 'trace', ref: `solomap://objects/${source.objectId}`, revision: source.revision, summary: lesson.reason }], source_event_ids_json: [] }) } });
    if (!current) this.db.run('INSERT INTO legacy_lesson_sources VALUES(?,?,?,?,?,?,?)', [target.binding.identity, target.scope, target.legacyId, receipt.objectId, 0, 0, target.binding.key]);
    return receipt;
  }
  private legacyLearningReviewCursorInput(identity: string, state: any, hash: string): { runKey: string; inputContentId: string } {
    if (typeof state.lastAppliedRunId !== 'string' || !state.lastAppliedRunId || /[\\/]/.test(state.lastAppliedRunId)) throw new Error('legacy_review_cursor_source_missing');
    const runKey = `runs/${state.lastAppliedRunId}`;
    const pinned = this.rows('SELECT run_key,input_content_id FROM legacy_learning_review_cursor_inputs WHERE source_identity=? AND cursor_hash=?', [identity, hash])[0];
    if (pinned && pinned.run_key !== runKey) throw new Error('legacy_review_cursor_source_mismatch');
    const row = pinned || this.rows('SELECT input_content_id FROM legacy_learning_review_controls WHERE source_identity=? AND source_key=?', [identity, runKey])[0];
    if (!row) throw new Error('legacy_review_cursor_source_missing');
    return { runKey, inputContentId: String(row.input_content_id) };
  }
  public resolveLegacyLearningReviewCursorSources(identity: string, state: any, hash: string): ReviewSource[] {
    const sources = state.deferredSources || [];
    const minimal = sources.some((source: ReviewSource) => source.content === undefined && source.value === undefined);
    const input = minimal ? this.legacyLearningReviewCursorInput(identity, state, hash) : null;
    const manifest = input ? this.learningReviewManifest(JSON.parse(this.content(input.inputContentId).toString('utf8'))) : null;
    const original = (source: ReviewSource): ReviewSource => {
      const { content, ...metadata } = source;
      const restored = source.kind === 'deleted_source' && source.value?.contentUnavailable === true ? metadata : source;
      return { ...restored, ...(source.previousVersions ? { previousVersions: source.previousVersions.map(original) } : {}) };
    };
    return sources.map((source: ReviewSource) => {
      if (source.content !== undefined || source.value !== undefined) return source;
      if (Object.keys(source).some(key => !['id','hash','projectPath'].includes(key))) throw new Error('legacy_review_cursor_source_mismatch');
      const matches = manifest!.sources.filter(original => original.id === source.id && original.hash === source.hash);
      if (matches.length !== 1 || (source.projectPath && source.projectPath !== matches[0].projectPath)) throw new Error('legacy_review_cursor_source_mismatch');
      return original(matches[0]);
    });
  }
  public importLegacyLearningReviewCursor(identity: string, bytes: Buffer, hash: string, projects: string[] = []): { unchanged: boolean } {
    return this.transaction(() => {
      const source = { identity, key: 'review-state.json', hash };
      const state = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      const input = (state.deferredSources || []).some((source: ReviewSource) => source.content === undefined && source.value === undefined) ? this.legacyLearningReviewCursorInput(identity, state, hash) : null;
      const validate = (source: ReviewSource): void => {
        legacyReviewSourceBody(source);
        if (source.projectPath && !projects.includes(source.projectPath)) throw new Error('legacy_review_source_invalid');
        for (const version of source.previousVersions || []) validate(version);
      };
      for (const source of this.resolveLegacyLearningReviewCursorSources(identity, state, hash)) validate(source);
      const imported = this.importObject({ kind: 'setting', action: 'create', scope: null, idempotencyKey: `legacy-review-cursor:${canonical(source)}`, data: { namespace: 'learning_review_legacy', key: identity, owner_scope: 'global', content: bytes.toString('utf8') } }, source);
      if (input) {
        const cursorId = imported.receipt?.objectId || String(this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [identity, source.key])[0].object_id);
        this.db.run('INSERT OR IGNORE INTO legacy_learning_review_cursor_inputs VALUES(?,?,?,?,?,?)', [identity, hash, input.runKey, cursorId, this.readMetadata(cursorId).revision, input.inputContentId]);
      }
      this.markMigrationSourceImported(identity, source.key);
      return { unchanged: imported.unchanged };
    });
  }
  public saveGlobalPrompt(input: { policy: { objectId: string; revision: number } | null; content: string; source: 'user' | 'review_projection'; idempotencyKey: string }): { objectId: string; revision: number } {
    if (typeof input.content !== 'string' || !['user', 'review_projection'].includes(input.source) || !input.idempotencyKey) throw new Error('invalid_global_prompt_save');
    return this.transaction(() => {
      const policy = this.readGlobalPromptPolicy();
      if (input.source === 'review_projection') {
        if (!policy || policy.data.content !== input.content || policy.objectId !== input.policy?.objectId || policy.revision !== input.policy.revision) throw new Error('global_prompt_revision_conflict');
        return { objectId: policy.objectId, revision: policy.revision };
      }
      if ((input.policy?.objectId || null) !== (policy?.objectId || null) && !this.rows('SELECT id FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, input.idempotencyKey]).length) throw new Error('global_prompt_revision_conflict');
      const receipt = this.write({ kind: 'policy', action: input.policy ? 'patch' : 'create', scope: null, ...(input.policy ? { objectId: input.policy.objectId, expectedRevision: input.policy.revision } : {}), idempotencyKey: input.idempotencyKey, data: { kind: 'global_prompt', status: 'active', content: input.content } });
      if (this.readMetadata(receipt.objectId).revision === receipt.revision) {
        const pending = this.rows("SELECT a.id FROM applications a JOIN policies p ON p.id=a.target_object_id LEFT JOIN legacy_learning_review_controls l ON l.batch_id=a.review_id WHERE (a.target_object_id=? AND a.status='applying') OR (l.batch_id IS NOT NULL AND a.status IN ('applying','partial'))", [receipt.objectId]);
        for (const row of pending) {
          const application = this.read(String(row.id));
          if (application.data.after_content === input.content) continue;
          const evidence = this.write({ kind: 'evidence', action: 'create', scope: application.projectId, idempotencyKey: `${input.idempotencyKey}:override:${application.objectId}`, data: { type: 'host_observation', source_actor_id: this.actorId, observed_at: Date.now(), content: JSON.stringify({ event: 'user_saved_global_prompt', policy: { objectId: receipt.objectId, revision: receipt.revision }, previousApplication: { objectId: application.objectId, revision: application.revision } }) } });
          this.link({ source: application.objectId, relation: 'source', target: evidence.objectId, expectedRevision: application.revision, idempotencyKey: `${input.idempotencyKey}:override-source:${application.objectId}` });
          const linked = this.readMetadata(application.objectId);
          this.write({ kind: 'application', action: 'patch', scope: application.projectId, objectId: application.objectId, expectedRevision: linked.revision, idempotencyKey: `${input.idempotencyKey}:supersede:${application.objectId}`, data: { status: 'superseded' } });
        }
      }
      return { objectId: receipt.objectId, revision: receipt.revision };
    });
  }
  public prepareLearningReview(input: { runId: string; workspaceRoot: string; globalPrompt: string; persistedGlobalPrompt: string; owner?: { id: string; pid: number; birth: string } }): { objectId: string; revision: number; manifest: ReviewManifest; policy: { objectId: string; revision: number }; pending: any[] } {
    if (!input.runId || typeof input.globalPrompt !== 'string' || typeof input.persistedGlobalPrompt !== 'string') throw new Error('invalid_learning_review');
    return this.transaction(() => {
      const requestProject = this.rows("SELECT project_id FROM project_locations WHERE device_id=? AND root_path=? AND status='active'", [this.deviceId, path.resolve(input.workspaceRoot || '')])[0];
      if (!requestProject) throw new Error('review_project_not_registered');
      const active = this.rows("SELECT r.id,r.status FROM review_batches r JOIN learning_review_controls c ON c.batch_id=r.id WHERE r.status IN ('draft','interrupted')");
      for (const entry of active) {
        const run = this.rows('SELECT r.* FROM run_control r JOIN learning_review_controls c ON c.run_id=r.run_id WHERE c.batch_id=?', [entry.id])[0];
        if (entry.status === 'interrupted') {
          if (run && this.hasLiveRunProcess(run)) throw new Error('learning_review_owner_alive');
          if (run) {
            const state = this.readRunState(String(run.project_id), Number(run.execution_log_id));
            if (!state.status.finishedAt && !state.status.stopRequested) this.interruptLearningReview(String(entry.id));
          }
          continue;
        }
        const batch = this.read(String(entry.id)), saved = JSON.parse(String(batch.data.review_content));
        if (saved.runId === input.runId) {
          if (saved.manifest.globalPrompt !== input.globalPrompt || saved.manifest.persistedPromptHash !== digest(input.persistedGlobalPrompt)) throw new Error('idempotency_conflict');
          return { objectId: batch.objectId, revision: batch.revision, manifest: this.learningReviewManifest(saved), policy: saved.policy, pending: saved.pending };
        }
        if (saved.owner && !saved.ownerReleased && this.hasLiveRunProcess({ process_pid: saved.owner.pid, process_birth: saved.owner.birth })) throw new Error('learning_review_owner_alive');
        if (run && this.hasLiveRunProcess(run)) throw new Error('learning_review_owner_alive');
        this.interruptLearningReview(batch.objectId);
      }
      const existingPolicy = this.readGlobalPromptPolicy();
      const policyId = existingPolicy?.objectId || this.write({ kind: 'policy', action: 'create', scope: null, idempotencyKey: 'learning-review:initial-global-prompt', data: { kind: 'global_prompt', status: 'active', content: input.persistedGlobalPrompt } }).objectId;
      const policy = this.read(policyId);
      if (policy.data.content !== input.persistedGlobalPrompt) {
        const interruptedProjection = this.rows("SELECT a.before_content_id,a.after_content_id FROM applications a JOIN learning_review_controls c ON c.batch_id=a.review_id WHERE a.status='applying' AND a.target_object_id=?", [policyId]).some(row => this.content(String(row.before_content_id)).toString('utf8') === input.persistedGlobalPrompt && this.content(String(row.after_content_id)).toString('utf8') === policy.data.content);
        if (!interruptedProjection) throw new Error('global_prompt_revision_conflict');
      }
      const cursorRow = this.rows("SELECT id FROM settings WHERE namespace='learning_review' AND key='cursor' AND owner_scope='global'")[0];
      const cursorObject = cursorRow ? this.read(String(cursorRow.id)) : null;
      const previous = cursorObject ? JSON.parse(String(cursorObject.data.content)) : { sources: {}, deferredSources: [] };
      previous.legacyCursorRevisions = { ...(previous.legacyCursorRevisions || {}) };
      for (const row of this.rows("SELECT id FROM settings WHERE namespace='learning_review_legacy' AND owner_scope='global' ORDER BY id")) {
        const legacy = this.read(String(row.id));
        if (previous.legacyCursorRevisions[legacy.objectId] === legacy.revision) continue;
        const state = JSON.parse(String(legacy.data.content).replace(/^\uFEFF/, ''));
        previous.sources = { ...(state.sources || {}), ...previous.sources };
        const deferred = new Map<string, ReviewSource>((previous.deferredSources || []).map((source: ReviewSource) => [source.id, source]));
        const restore = (source: ReviewSource): ReviewSource => {
          const content = legacyReviewSourceBody(source);
          return { ...source, content, contentHash: digest(content), ...(source.previousVersions ? { previousVersions: source.previousVersions.map(restore) } : {}) };
        };
        for (const source of this.resolveLegacyLearningReviewCursorSources(String(legacy.data.key), state, digest(String(legacy.data.content)))) if (!previous.sources[source.id] && !deferred.has(source.id)) deferred.set(source.id, restore(source));
        previous.deferredSources = [...deferred.values()];
        previous.unresolved = [...new Set([...(previous.unresolved || []), ...(state.unresolved || [])])];
        previous.legacyCursorRevisions[legacy.objectId] = legacy.revision;
      }
      const projects = this.rows("SELECT p.id,l.root_path FROM projects p JOIN objects o ON o.id=p.id JOIN project_locations l ON l.project_id=p.id WHERE p.hidden=0 AND o.archived_at IS NULL AND l.device_id=? AND l.status='active' ORDER BY l.root_path", [this.deviceId]);
      const projectPaths = new Map(projects.map(row => [String(row.id), String(row.root_path)]));
      const manifest: ReviewManifest = { schemaVersion: 1, runId: input.runId, globalRoot: this.root, globalPrompt: input.globalPrompt, promptHash: digest(input.globalPrompt), persistedPromptHash: digest(input.persistedGlobalPrompt), projects: [...projectPaths.values()], sources: [], memory: [], gaps: [] };
      const deferred = new Map<string, ReviewSource>((previous.deferredSources || []).map((source: ReviewSource) => [source.id, source]));
      const addUserFile = (file: string, kind: string, root: string, projectPath?: string): void => {
        const relative = path.relative(path.resolve(root), path.resolve(file));
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('review_user_file_scope_mismatch');
        try {
          let current = path.resolve(root);
          for (const part of relative.split(path.sep)) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error('review_user_file_symlink'); }
          const before = fs.statSync(file);
          if (!before.isFile()) throw new Error('review_user_file_not_regular');
          const content = fs.readFileSync(file, 'utf8'), after = fs.statSync(file);
          if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('review_user_file_changed');
          const id = `file-${digest(`${path.resolve(file)}:${kind}`).slice(0, 24)}`, hash = digest(content), held = deferred.get(id);
          if (!held && previous.sources?.[id]?.hash === hash) return;
          const source: ReviewSource = { id, kind, file: path.resolve(file), ...(projectPath ? { projectPath } : {}), hash, content, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, dev: after.dev, ino: after.ino };
          if (held && held.hash !== hash) { const { previousVersions, ...old } = held; source.previousVersions = [...(previousVersions || []), old]; }
          else if (held?.previousVersions) source.previousVersions = held.previousVersions;
          manifest.sources.push(source); deferred.delete(id);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
      addUserFile(path.join(path.dirname(this.root), 'agent.md'), 'global_constraint', path.dirname(this.root));
      for (const [projectId, root] of projectPaths) {
        for (const name of ['agent.md', 'AGENTS.md', 'PROJECT_MEMORY.md']) {
          const file = path.join(root, name);
          if (file === path.join(path.dirname(this.root), 'agent.md')) continue;
          addUserFile(file, name === 'PROJECT_MEMORY.md' ? 'project_memory_legacy' : 'project_constraint', root, root);
        }
        for (const document of this.readDocumentationManifest(projectId).documents) if (document.status === 'active') addUserFile(path.resolve(root, document.path), 'project_document', root, root);
      }
      const pendingBatches = new Map<string, { batch: DataObject; saved: any; manifest: ReviewManifest; targets: Map<string, LegacyReviewTarget> }>();
      const pending = this.rows("SELECT a.id FROM applications a LEFT JOIN learning_review_controls c ON c.batch_id=a.review_id LEFT JOIN legacy_learning_review_controls l ON l.batch_id=a.review_id WHERE (c.batch_id IS NOT NULL OR l.batch_id IS NOT NULL) AND a.status IN ('applying','partial') ORDER BY a.id").map(row => {
        const application = this.read(String(row.id)), batchId = String(application.data.review_id);
        let original = pendingBatches.get(batchId);
        if (!original) {
          const batch = this.read(batchId), saved = JSON.parse(String(batch.data.review_content));
          original = { batch, saved, manifest: this.learningReviewManifest({ ...saved, manifest: { ...saved.manifest, sources: [...saved.manifest.sources, ...(saved.applicationSources || [])] } }), targets: this.legacyReviewApplicationTargets(saved) };
          pendingBatches.set(batchId, original);
        }
        const old = original.batch, oldManifest = original.manifest;
        if (oldManifest.projects.some(root => ![...projectPaths.values()].includes(root))) {
          manifest.gaps.push(`旧复盘应用 ${application.objectId} 的来源当前不可访问，原文仍保留。`);
          return null;
        }
        const target = original.targets.get(String(application.data.target_object_id));
        const canonical = target && target.kind !== 'policy' ? this.canonicalLegacyReviewTarget(target) : null;
        return { objectId: application.objectId, revision: application.revision, batchId: old.objectId, targetKind: target?.kind || 'policy',
          ...(target && target.kind !== 'policy' ? { targetContent: application.data.after_content, targetRef: canonical ? { objectId: canonical.objectId, revision: canonical.revision } : null, legacyTarget: { batchId: old.objectId, revision: old.revision, key: target.key } }
            : { targetPrompt: application.data.after_content, targetPromptHash: digest(String(application.data.after_content)) }), result: JSON.parse(String(old.data.proposal_content)), manifest: oldManifest };
      }).filter((item): item is NonNullable<typeof item> => item !== null);
      const kinds = ['memory', 'lesson', 'lesson_decision', 'learning_event', 'task', 'turn', 'report', 'verification', 'evidence'];
      const scopes: Array<string | null> = [null, ...projectPaths.keys()];
      for (const scope of scopes) {
        let cursor: string | undefined;
        do {
          const page = this.search({ scope, kinds, limit: 500, ...(cursor ? { cursor } : {}) }, object => object.kind !== 'evidence' || ['run_digest_source', 'session_binding', 'verification', 'project_journal', 'github_host_facts'].includes(String(object.data.type)) || String(object.data.type).startsWith('run_document:settlement_'));
          for (const object of page.items) {
            const id = `object-${object.objectId}`, done = previous.sources?.[id], held = deferred.get(id);
            if (!held && done?.ref?.revision === object.revision) continue;
            const full = this.read(object.objectId, object.revision), content = JSON.stringify(full.data);
            const source: ReviewSource = { id, kind: object.kind === 'report' ? 'agent_report' : object.kind === 'evidence' && object.data.type === 'run_digest_source' ? 'run_digest' : object.kind, ...(scope ? { projectPath: projectPaths.get(scope) } : {}), ref: { objectId: object.objectId, revision: object.revision, scope }, hash: digest(content), content };
            const versions: ReviewSource[] = [...(held?.previousVersions || [])];
            const from = Number(done?.ref?.revision || 0) + 1;
            for (let revision = from; revision < object.revision; revision += 1) {
              if (versions.some(version => version.ref?.revision === revision)) continue;
              const text = JSON.stringify(this.read(object.objectId, revision).data);
              versions.push({ id, kind: source.kind, ...(source.projectPath ? { projectPath: source.projectPath } : {}), ref: { objectId: object.objectId, revision, scope }, hash: digest(text), content: text });
            }
            if (versions.length) source.previousVersions = versions;
            manifest.sources.push(source); deferred.delete(id);
          }
          cursor = page.cursor || undefined;
        } while (cursor);
      }
      // An archived or newly hidden source remains readable at its pinned version.
      for (const source of deferred.values()) if (!source.projectPath || [...projectPaths.values()].includes(source.projectPath)) manifest.sources.push(source);
      const proposals: ReviewManifest[] = [];
      const interrupted = this.rows("SELECT r.id,COALESCE(c.input_content_id,l.input_content_id) AS input_content_id FROM review_batches r LEFT JOIN learning_review_controls c ON c.batch_id=r.id LEFT JOIN legacy_learning_review_controls l ON l.batch_id=r.id JOIN objects o ON o.id=r.id WHERE (c.batch_id IS NOT NULL OR l.batch_id IS NOT NULL) AND r.status='interrupted' AND r.proposal_content_id IS NOT NULL AND o.archived_at IS NULL ORDER BY o.created_at,r.id");
      for (const row of interrupted) {
        const old = this.read(String(row.id)), id = `proposal-${old.objectId}`, held = deferred.get(id);
        if (!held && previous.sources?.[id]?.ref?.revision === old.revision) continue;
        const oldManifest = this.learningReviewManifest(JSON.parse(this.content(String(row.input_content_id)).toString('utf8')));
        if (oldManifest.projects.some(root => ![...projectPaths.values()].includes(root))) {
          const obsolete = manifest.sources.findIndex(source => source.id === id);
          if (obsolete >= 0) manifest.sources.splice(obsolete, 1);
          manifest.gaps.push(`旧复盘提案 ${old.objectId} 的来源当前不可访问，原文仍保留。`);
          continue;
        }
        let result: unknown = null;
        try { result = JSON.parse(String(old.data.proposal_content)); } catch { /* Keep malformed original text for review, without applying it. */ }
        const proposalHeader = (source: ReviewSource): ReviewSource => source.kind === 'review_proposal'
          ? { ...source, content: '', ...(source.previousVersions ? { previousVersions: source.previousVersions.map(proposalHeader) } : {}) }
          : source;
        const content = JSON.stringify({ batchId: old.objectId, status: old.data.status, proposalContent: old.data.proposal_content, result, manifestHash: old.data.input_hash, manifest: { ...oldManifest, sources: oldManifest.sources.map(proposalHeader) } });
        const source: ReviewSource = { id, kind: 'review_proposal', ref: { objectId: old.objectId, revision: old.revision, scope: old.projectId }, hash: digest(content), content };
        if (held) {
          const { previousVersions, ...version } = held;
          source.previousVersions = [...(previousVersions || []), ...(held.ref?.revision !== old.revision ? [version] : [])];
        }
        const existing = manifest.sources.findIndex(item => item.id === id);
        if (existing >= 0) manifest.sources[existing] = source;
        else manifest.sources.push(source);
        proposals.push(oldManifest);
      }
      const versionKey = (source: ReviewSource): string => canonical({ hash: source.hash, contentHash: source.contentHash || source.hash, ref: source.ref || null });
      for (const source of [...pending.flatMap(item => item.manifest.sources), ...proposals.flatMap(item => item.sources)] as ReviewSource[]) {
        const current = manifest.sources.find(item => item.id === source.id);
        if (!current) manifest.sources.push(source);
        else {
          const { previousVersions, ...version } = source;
          const known = new Set([current, ...(current.previousVersions || [])].map(versionKey));
          const added = [...(previousVersions || []), version].filter(item => {
            const key = versionKey(item); if (known.has(key)) return false; known.add(key); return true;
          });
          if (added.length) current.previousVersions = [...(current.previousVersions || []), ...added];
        }
      }
      const pendingHeaders = pending.map(({ manifest, ...item }) => ({ ...item, sourceIds: manifest.sources.map((source: ReviewSource) => source.id) }));
      const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0) AS value FROM events')[0].value);
      const policyRef = { objectId: policy.objectId, revision: policy.revision };
      const sourceContents: Record<string, string> = {};
      const compact = (source: ReviewSource): ReviewSource => {
        sourceContents[source.contentHash ? `${source.id}:${source.hash}:${source.contentHash}` : `${source.id}:${source.hash}`] = this.putContent(source.content || '');
        return { ...source, content: '', ...(source.previousVersions ? { previousVersions: source.previousVersions.map(compact) } : {}) };
      };
      const storedManifest = { ...manifest, sources: manifest.sources.map(compact) };
      const receipt = this.writeMutation({ kind: 'review_batch', action: 'create', scope: String(requestProject.project_id), idempotencyKey: `learning-review:${input.runId}:prepare`, data: { input_cursor: sequence, input_hash: digest(JSON.stringify(manifest)), status: 'draft', review_content: JSON.stringify({ runId: input.runId, manifest: storedManifest, projectIds: [...projectPaths.keys()], sourceContents, policy: policyRef, cursor: cursorObject ? { objectId: cursorObject.objectId, revision: cursorObject.revision } : null, previous, pending: pendingHeaders, ...(input.owner ? { owner: input.owner } : {}) }) } }, undefined, undefined, false);
      this.db.run('INSERT INTO learning_review_controls(batch_id,request_project_id,run_key,input_content_id) VALUES(?,?,?,?)', [receipt.objectId, requestProject.project_id, input.runId, this.readMetadata(receipt.objectId).data.review_content_id as string]);
      this.indexSearchObject(this.readMetadata(receipt.objectId));
      return { objectId: receipt.objectId, revision: receipt.revision, manifest, policy: policyRef, pending: pendingHeaders };
    });
  }
  public applyLearningReview(input: { batchId: string; expectedRevision: number; manifestHash: string; result: any; idempotencyKey: string }): { application: WriteReceipt; policy: WriteReceipt } {
    const batch = this.read(input.batchId);
    const control = this.rows('SELECT input_content_id FROM learning_review_controls WHERE batch_id=?', [input.batchId])[0];
    if (batch.kind !== 'review_batch' || !control) throw new Error('learning_review_batch_required');
    const saved = JSON.parse(this.content(String(control.input_content_id)).toString('utf8')), manifest = this.learningReviewManifest(saved);
    if (input.manifestHash !== batch.data.input_hash || digest(JSON.stringify(manifest)) !== input.manifestHash) throw new Error('learning_review_manifest_mismatch');
    validateDirectGlobalPromptReview(manifest, input.result);
    if (!Array.isArray(input.result.recovery) || input.result.recovery.length !== saved.pending.length) throw new Error('learning_review_recovery_missing');
    const recoveries = new Set<string>();
    for (const disposition of input.result.recovery) {
      const pending = saved.pending.find((item: any) => item.objectId === disposition.applicationId && item.revision === disposition.revision);
      if (!pending || recoveries.has(pending.objectId) || !(pending.targetKind && pending.targetKind !== 'policy' ? ['resumed', 'deferred'] : ['resumed', 'superseded']).includes(disposition.decision) || !String(disposition.reason || '').trim()) throw new Error('learning_review_recovery_invalid');
      if ((!pending.targetKind || pending.targetKind === 'policy') && disposition.decision === 'resumed' && pending.targetPrompt !== input.result.globalPrompt) throw new Error('learning_review_recovery_prompt_mismatch');
      if ((!pending.targetKind || pending.targetKind === 'policy') && disposition.decision === 'superseded' && pending.targetPrompt !== manifest.globalPrompt) throw new Error('learning_review_unapplied_result');
      recoveries.add(pending.objectId);
    }
    return this.transaction(() => {
      if (!this.learningReviewScopeCurrent(batch)) throw new Error('learning_review_source_scope_changed');
      // write() replays an identical accepted intent before checking its old revision.
      const application = this.write({ kind: 'application', action: 'create', scope: batch.projectId, idempotencyKey: input.idempotencyKey, data: { review_id: batch.objectId, target_object_id: saved.policy.objectId, expected_revision: saved.policy.revision, before_content: this.read(saved.policy.objectId, saved.policy.revision).data.content, after_content: input.result.globalPrompt, status: 'applying' } });
      const currentBatch = this.read(batch.objectId);
      if (currentBatch.data.status !== 'draft') {
        const accepted = JSON.parse(String(currentBatch.data.review_content));
        if (accepted.acceptedIntent !== input.idempotencyKey) throw new Error('learning_review_already_accepted');
        if (currentBatch.data.proposal_content !== JSON.stringify(input.result)) throw new Error('idempotency_conflict');
        const policyReceipt = this.write({ kind: 'policy', action: 'patch', scope: null, objectId: saved.policy.objectId, expectedRevision: saved.policy.revision, idempotencyKey: `${input.idempotencyKey}:policy`, data: { content: input.result.globalPrompt } });
        return { application, policy: policyReceipt };
      }
      if (currentBatch.revision !== input.expectedRevision) throw new Error('revision_conflict');
      const policy = this.write({ kind: 'policy', action: 'patch', scope: null, objectId: saved.policy.objectId, expectedRevision: saved.policy.revision, idempotencyKey: `${input.idempotencyKey}:policy`, data: { content: input.result.globalPrompt } });
      const sources = { ...saved.previous.sources }, deferred = new Set<string>(input.result.deferredSourceIds || []);
      for (const source of manifest.sources) {
        if (deferred.has(source.id)) delete sources[source.id];
        else sources[source.id] = { id: source.id, kind: source.kind, hash: source.hash, ...(source.ref ? { ref: source.ref } : {}), ...(source.file ? { file: source.file } : {}) };
      }
      const presented = new Set(manifest.sources.map(source => source.id));
      const deferredSources = [...(saved.previous.deferredSources || []).filter((source: ReviewSource) => !presented.has(source.id)), ...manifest.sources.filter(source => deferred.has(source.id))];
      this.write({ kind: 'setting', action: saved.cursor ? 'patch' : 'create', scope: null, ...(saved.cursor ? { objectId: saved.cursor.objectId, expectedRevision: saved.cursor.revision } : {}), idempotencyKey: `${input.idempotencyKey}:cursor`, data: { namespace: 'learning_review', key: 'cursor', owner_scope: 'global', content: JSON.stringify({ sources, deferredSources, unresolved: input.result.unresolved || [], legacyCursorRevisions: saved.previous.legacyCursorRevisions || {}, lastAppliedBatchId: batch.objectId }) } });
      const recoveries = [...input.result.recovery].sort((a: any, b: any) => Number(saved.pending.find((item: any) => item.objectId === a.applicationId)?.targetKind === 'lesson') - Number(saved.pending.find((item: any) => item.objectId === b.applicationId)?.targetKind === 'lesson'));
      for (const disposition of recoveries) {
        if (disposition.decision === 'deferred') continue;
        const pending = saved.pending.find((item: any) => item.objectId === disposition.applicationId);
        const target = pending.targetKind && pending.targetKind !== 'policy' ? this.resumeLegacyReviewTarget(pending, `${input.idempotencyKey}:target:${disposition.applicationId}`) : null;
        this.write({ kind: 'application', action: 'patch', scope: this.read(disposition.applicationId).projectId, objectId: disposition.applicationId, expectedRevision: disposition.revision, idempotencyKey: `${input.idempotencyKey}:recovery:${disposition.applicationId}`, data: { status: disposition.decision, ...(target ? { target_object_id: target.objectId, applied_revision: target.revision } : {}) } });
      }
      this.write({ kind: 'review_batch', action: 'patch', scope: batch.projectId, objectId: batch.objectId, expectedRevision: input.expectedRevision, idempotencyKey: `${input.idempotencyKey}:batch`, data: { status: 'applying', proposal_content: JSON.stringify(input.result), review_content: JSON.stringify({ ...saved, acceptedIntent: input.idempotencyKey }) } });
      return { application, policy };
    });
  }
  public finishLearningReview(input: { applicationId: string; expectedRevision: number; promptHash: string; idempotencyKey: string }): WriteReceipt {
    return this.transaction(() => {
      const application = this.read(input.applicationId);
      if (application.kind !== 'application' || !application.data.review_id || digest(String(application.data.after_content)) !== input.promptHash) throw new Error('learning_review_prompt_mismatch');
      const policy = this.read(String(application.data.target_object_id));
      if (application.data.status !== 'applied' && policy.data.content !== application.data.after_content) throw new Error('global_prompt_revision_conflict');
      const receipt = this.write({ kind: 'application', action: 'patch', scope: application.projectId, objectId: application.objectId, expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey, data: { status: 'applied', applied_revision: application.data.status === 'applied' ? application.data.applied_revision : policy.revision } });
      const batch = this.read(String(application.data.review_id));
      if (batch.data.status !== 'applied') this.write({ kind: 'review_batch', action: 'patch', scope: batch.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: `${input.idempotencyKey}:batch`, data: { status: 'applied' } });
      return receipt;
    });
  }
  public interruptLearningReview(batchId: string): void {
    this.transaction(() => {
      const batch = this.read(batchId);
      if (batch.kind !== 'review_batch') throw new Error('learning_review_batch_required');
      const run = this.rows('SELECT r.* FROM run_control r JOIN learning_review_controls c ON c.run_id=r.run_id WHERE c.batch_id=?', [batchId])[0];
      if (run && this.hasLiveRunProcess(run)) {
        if (batch.data.status === 'draft') {
          const saved = JSON.parse(String(batch.data.review_content));
          if (!saved.ownerReleased) this.write({ kind: 'review_batch', action: 'patch', scope: batch.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: `learning-review:${batchId}:owner-released:${batch.revision}`, data: { review_content: JSON.stringify({ ...saved, ownerReleased: true }) } });
        }
        return;
      }
      if (run) {
        const state = this.readRunState(String(run.project_id), Number(run.execution_log_id));
        if (!state.status.finishedAt && !state.status.stopRequested) this.requestRunStop(state.projectId, { executionLogId: Number(run.execution_log_id), generation: state.generation, expectedRevision: state.revision, expectedTurnId: state.turnId, reason: '复盘启动或等待已中断，原运行不再重新投递。', idempotencyKey: `learning-review:${batchId}:stop:${state.generation}:${state.turnId}` });
      }
      if (batch.data.status === 'draft') this.write({ kind: 'review_batch', action: 'patch', scope: batch.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: `learning-review:${batchId}:interrupted:${batch.revision}`, data: { status: 'interrupted' } });
    });
  }
  private hasLearningReviewDeliverable(projectId: string, metadata: Record<string, any>): boolean {
    const batchId = String(metadata.learningReviewBatchId || '');
    const control = this.rows('SELECT input_content_id FROM learning_review_controls WHERE batch_id=? AND request_project_id=?', [batchId, projectId])[0];
    if (!control) return false;
    try {
      const batch = this.read(batchId), saved = JSON.parse(this.content(String(control.input_content_id)).toString('utf8'));
      validateDirectGlobalPromptReview(this.learningReviewManifest(saved), JSON.parse(String(batch.data.proposal_content)));
      return true;
    } catch { return false; }
  }
  public readLearningOverview(): LearningOverview {
    return this.transaction(() => {
      const overview: LearningOverview = { eventCount: 0, candidateCount: 0, candidateDecisionCount: 0, skippedCandidateDecisionCount: 0, approvedCount: 0, promotedCount: 0, projectSignals: [] };
      const projects = new Map(this.rows(`SELECT p.id,p.name,(SELECT root_path FROM project_locations l WHERE l.project_id=p.id AND l.device_id=? AND l.status='active' ORDER BY root_path LIMIT 1) AS root FROM projects p`, [this.deviceId]).map(row => [String(row.id), row]));
      const signals = new Map<string, LearningOverview['projectSignals'][number]>();
      const signal = (id: SqlValue) => {
        const key = id == null ? '' : String(id);
        let value = signals.get(key);
        if (!value) {
          const project = projects.get(key);
          value = { projectId: key, projectName: key ? String(project?.name || '') : '全局', projectPath: String(project?.root || ''), eventCount: 0, candidateCount: 0, promotedCount: 0, latestAt: '', riskSignals: 0, verificationSignals: 0, strategySignals: 0 };
          signals.set(key, value);
        }
        return value;
      };
      const events = this.rows(`SELECT e.project_id,count(*) AS count,max(e.occurred_at) AS latest,sum(CASE WHEN e.event_type IN ('failed','blocked','deviated','partial','needs_confirmation') THEN 1 ELSE 0 END) AS risks,sum(COALESCE(e.verification_signal,0)) AS verification,sum(CASE WHEN e.source_type='strategy' THEN 1 ELSE 0 END) AS strategies FROM learning_events e JOIN objects o ON o.id=e.id WHERE o.archived_at IS NULL GROUP BY e.project_id`);
      for (const event of events) {
        const value = signal(event.project_id);
        value.eventCount = Number(event.count); overview.eventCount += value.eventCount;
        value.riskSignals = Number(event.risks); value.verificationSignals = Number(event.verification); value.strategySignals = Number(event.strategies);
        value.latestAt = new Date(Number(event.latest)).toISOString();
      }
      const lessons = this.rows(`SELECT l.project_id,l.status,l.summary,l.applies_when,l.do_this,l.avoid_this,l.evidence_refs_json,l.promotion_target,l.lesson_type,COALESCE(l.external_updated_at,o.updated_at) AS latest FROM lessons l CROSS JOIN objects o ON o.id=l.id WHERE o.archived_at IS NULL AND l.status IN ('candidate','approved','promoted')`);
      for (const lesson of lessons) {
        if (isTrashOrLocalPrivate({ summary: String(lesson.summary || ''), appliesWhen: String(lesson.applies_when || ''), doThis: String(lesson.do_this || ''), avoidThis: String(lesson.avoid_this || ''), promotionTarget: String(lesson.promotion_target || ''), evidenceRefs: lesson.evidence_refs_json == null ? [] : JSON.parse(String(lesson.evidence_refs_json)) })) continue;
        const value = signal(lesson.project_id); value.candidateCount++;
        if (lesson.status === 'candidate') overview.candidateCount++;
        else { value.promotedCount++; if (lesson.status === 'approved') overview.approvedCount++; else overview.promotedCount++; }
        if (lesson.lesson_type === 'risk_pattern') value.riskSignals++;
        if (lesson.lesson_type === 'verification_pattern') value.verificationSignals++;
        if (lesson.lesson_type === 'strategy_signal') value.strategySignals++;
        const latest = new Date(Number(lesson.latest)).toISOString();
        if (latest > value.latestAt) value.latestAt = latest;
      }
      const decisions = this.rows(`SELECT count(*) AS count,sum(CASE WHEN d.decision='skipped' THEN 1 ELSE 0 END) AS skipped FROM lesson_decisions d CROSS JOIN objects o ON o.id=d.id WHERE o.archived_at IS NULL`)[0];
      overview.candidateDecisionCount = Number(decisions.count); overview.skippedCandidateDecisionCount = Number(decisions.skipped || 0);
      overview.projectSignals = [...signals.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt) || a.projectId.localeCompare(b.projectId));
      return overview;
    });
  }
  public readLearningSourceRevision(): string {
    return digest(canonical(this.rows("SELECT * FROM (SELECT 'event' AS kind,o.id,o.revision,o.archived_at FROM learning_events d CROSS JOIN objects o ON o.id=d.id UNION ALL SELECT 'lesson',o.id,o.revision,o.archived_at FROM lessons d CROSS JOIN objects o ON o.id=d.id UNION ALL SELECT 'decision',o.id,o.revision,o.archived_at FROM lesson_decisions d CROSS JOIN objects o ON o.id=d.id) ORDER BY kind,id")));
  }
  private runControl(projectId: string, executionLogId: number): Record<string, SqlValue> {
    const row = this.rows('SELECT run_control.*,runs.task_id,runs.conversation_id,runs.run_kind,runs.status,runs.started_at,runs.finished_at,runs.exit_code,objects.revision FROM run_control JOIN runs ON runs.id=run_control.run_id JOIN objects ON objects.id=runs.id WHERE run_control.project_id=? AND execution_log_id=?', [projectId, executionLogId])[0];
    if (!row) throw new Error('run_missing');
    return row;
  }
  private runProof(runId: string, generation: number): string {
    const secret = String(this.rows("SELECT value FROM database_meta WHERE key='maintenance_secret'")[0].value);
    return crypto.createHmac('sha256', secret).update(`run:${runId}:${generation}`).digest('hex');
  }
  private saveRunControlRevision(runId: string): void {
    this.db.run('INSERT INTO run_control_revisions SELECT run_id,objects.revision,generation,checkpoint_sequence,current_turn_id,metadata_content_id,binding_content_id,process_pid,process_birth,child_pid,child_birth,recovery_needed,delivery_pending,delivery_owner_id,delivery_pid,delivery_birth FROM run_control JOIN objects ON objects.id=run_id WHERE run_id=?', [runId]);
  }
  private verifyRunProof(projectId: string, executionLogId: number, generation: number, proof: string): Record<string, SqlValue> {
    const row = this.runControl(projectId, executionLogId);
    if (generation !== row.generation) throw new Error('run_owner_conflict');
    const expected = this.runProof(String(row.run_id), generation);
    if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(proof))) throw new Error('run_proof_denied');
    return row;
  }
  private hasLiveRunProcess(row: Record<string, SqlValue>): boolean {
    for (const [pidColumn, birthColumn] of [['process_pid', 'process_birth'], ['child_pid', 'child_birth']] as const) {
      const pid = Number(row[pidColumn] || 0);
      if (pid < 1) continue;
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM'; }
      if (!alive) continue;
      let birth = '';
      if (process.platform === 'win32' && String(row[birthColumn] || '').startsWith('win32:')) birth = readWindowsProcessBirthMarker(pid);
      else {
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
          if (fields[0] === 'Z') continue;
          birth = 'proc:' + fields[19];
        } catch {
          try { const value = childProcess.execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (value) birth = 'ps:' + value; } catch {}
        }
      }
      if (!row[birthColumn] || !birth || birth === row[birthColumn]) return true;
    }
    return false;
  }
  public runProcessAlive(projectId: string, executionLogId: number): boolean { return this.hasLiveRunProcess(this.runControl(projectId, executionLogId)); }
  public historicalRunOwnerAlive(status: Record<string, unknown>): boolean {
    return this.hasLiveRunProcess({ process_pid: Number(status.agentPid || 0), process_birth: String(status.processBirth || ''), child_pid: Number(status.agentChildPid || 0), child_birth: String(status.processChildBirth || '') });
  }
  public runChildProcessAlive(projectId: string, executionLogId: number): boolean { return this.hasLiveRunProcess({ ...this.runControl(projectId, executionLogId), process_pid: 0 }); }
  public runDeliveryOwnerAlive(projectId: string, executionLogId: number): boolean {
    const row = this.runControl(projectId, executionLogId);
    return this.hasLiveRunProcess({ process_pid: row.delivery_pid, process_birth: row.delivery_birth });
  }
  public verifyRunExecutionProof(projectId: string, executionLogId: number, generation: number, proof: string): void { this.verifyRunProof(projectId, executionLogId, generation, proof); }
  public authorizedLearningReviewBatch(projectId: string, input: { executionLogId: number; generation: number; proof: string }): string | undefined {
    const run = this.verifyRunProof(projectId, input.executionLogId, input.generation, input.proof);
    const control = this.rows('SELECT batch_id FROM learning_review_controls WHERE request_project_id=? AND run_id=?', [projectId, run.run_id])[0];
    return control ? String(control.batch_id) : undefined;
  }
  public recoverableRunStates(cursor = 0): { items: RunState[]; nextCursor: number | null } {
    const rows = this.rows('SELECT rowid,project_id,execution_log_id FROM run_control WHERE recovery_needed=1 AND rowid>? ORDER BY rowid LIMIT 101', [cursor]);
    const page = rows.slice(0, 100);
    return { items: page.map(row => this.readRunState(String(row.project_id), Number(row.execution_log_id))), nextCursor: rows.length > 100 ? Number(page[page.length - 1].rowid) : null };
  }
  public readRunState(projectId: string, executionLogId: number, revision?: number): RunState {
    let row = this.runControl(projectId, executionLogId);
    if (revision !== undefined && revision !== row.revision) {
      const historical = this.rows('SELECT * FROM run_control_revisions WHERE run_id=? AND revision=?', [row.run_id, revision])[0];
      if (!historical) throw new Error('revision_missing');
      const object = this.readMetadata(String(row.run_id), revision);
      row = { ...row, ...historical, status: String(object.data.status), started_at: Number(object.data.started_at), finished_at: object.data.finished_at as SqlValue, exit_code: object.data.exit_code as SqlValue };
    }
    const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8')) as Record<string, unknown>;
    const journal = this.rows('SELECT execution_log_id FROM run_turn_journals WHERE project_id=? AND run_id=? AND turn_id=?', [projectId, row.run_id, row.current_turn_id])[0];
    return { projectId, runId: String(row.run_id), taskId: String(row.task_id), turnId: String(row.current_turn_id), conversationId: String(row.conversation_id), generation: Number(row.generation), revision: Number(row.revision),
      status: { ...metadata, deliveryPending: Boolean(row.delivery_pending), deliveryOwnerId: String(row.delivery_owner_id || ''), deliveryOwnerPid: Number(row.delivery_pid || 0), deliveryOwnerBirth: String(row.delivery_birth || ''), journalExecutionLogId: journal ? Number(journal.execution_log_id) : null, learningTaskId: String(this.rows('SELECT legacy_task_id FROM legacy_report_tasks WHERE project_id=? AND task_id=?', [projectId, row.task_id])[0]?.legacy_task_id || `task-${row.task_id}`), executionLogId, rootExecutionLogId: executionLogId, nodeId: String(row.node_key), status: String(row.status), checkpointSequence: Number(row.checkpoint_sequence), agentPid: Number(row.process_pid || 0), processBirth: String(row.process_birth || ''), agentChildPid: Number(row.child_pid || 0), processChildBirth: String(row.child_birth || ''), exitCode: row.exit_code, startedAt: new Date(Number(row.started_at)).toISOString(), finishedAt: row.finished_at === null ? '' : new Date(Number(row.finished_at)).toISOString() } };
  }
  private bindRunTurnJournal(projectId: string, runId: string, turnId: string, nodeId: string, metadata: Record<string, unknown>, requestedExecutionLogId = 0): void {
    if (requestedExecutionLogId && this.rows('SELECT turn_id FROM run_turn_journals WHERE project_id=? AND execution_log_id=?', [projectId, requestedExecutionLogId]).length) throw new Error('execution_identity_conflict');
    const current = requestedExecutionLogId ? this.rows('SELECT node_id FROM project_journal_entries WHERE project_id=? AND execution_log_id=?', [projectId, requestedExecutionLogId])[0] : undefined;
    if (current && current.node_id !== nodeId) throw new Error('execution_identity_conflict');
    const timestamp = String(metadata.turnStartedAt || metadata.startedAt || new Date().toISOString());
    const result = current ? { executionLogId: requestedExecutionLogId } : this.appendProjectJournal(projectId, `run:${runId}:turn:${turnId}`, {
      nodeId, timestamp, agentCli: String(metadata.agentCli || ''), command: String(metadata.commandPreview || ''),
      output: [String(metadata.checkpointMessage || metadata.userMessage || ''), `Run started at: ${timestamp}`].filter(Boolean).join('\n\n'), status: 'Running'
    }, requestedExecutionLogId);
    this.db.run('INSERT INTO run_turn_journals VALUES(?,?,?,?)', [projectId, runId, turnId, result.executionLogId]);
  }
  public readRunTurnJournal(projectId: string, executionLogId: number, turnId?: string): { turnId: string; executionLogId: number; entry: AgentConversation } {
    const run = this.runControl(projectId, executionLogId);
    const selectedTurnId = turnId || String(run.current_turn_id);
    if (!this.rows("SELECT source_id FROM relations WHERE source_id=? AND relation='source' AND target_id=?", [run.run_id, selectedTurnId]).length) throw new Error('run_turn_mismatch');
    const mapping = this.rows('SELECT execution_log_id FROM run_turn_journals WHERE project_id=? AND run_id=? AND turn_id=?', [projectId, run.run_id, selectedTurnId])[0];
    if (!mapping) throw new Error('run_turn_journal_missing');
    const journalId = Number(mapping.execution_log_id);
    return { turnId: selectedTurnId, executionLogId: journalId, entry: this.readProjectJournal(projectId, { executionLogId: journalId }).logs[0] };
  }
  public resolveRunConversation(projectId: string, executionLogId: number): { state: RunState; turnId: string } | null {
    if (!Number.isInteger(executionLogId) || executionLogId < 1) throw new Error('invalid_execution_log_id');
    const row = this.rows('SELECT run_control.execution_log_id,run_turn_journals.turn_id FROM run_turn_journals JOIN run_control ON run_control.run_id=run_turn_journals.run_id AND run_control.project_id=run_turn_journals.project_id WHERE run_turn_journals.project_id=? AND run_turn_journals.execution_log_id=?', [projectId, executionLogId])[0];
    return row ? { state: this.readRunState(projectId, Number(row.execution_log_id)), turnId: String(row.turn_id) } : null;
  }
  public readRunIntent(projectId: string, launchIntentId: string): RunState | null {
    const row = this.rows('SELECT execution_log_id FROM run_launch_intents JOIN run_control ON run_control.run_id=run_launch_intents.run_id WHERE run_launch_intents.project_id=? AND launch_intent_id=?', [projectId, launchIntentId])[0];
    return row ? this.readRunCheckpointState(projectId, Number(row.execution_log_id)) : null;
  }
  public prepareRunIntent(projectId: string, locationId: string, input: Omit<PrepareRunInput, 'executionLogId'> & { launchIntentId: string }): RunState {
    if (!input.launchIntentId || !input.metadata?.launchIntentHash) throw new Error('invalid_launch_intent');
    return this.transaction(() => {
      const existing = this.readRunIntent(projectId, input.launchIntentId);
      if (existing) {
        if (existing.status.launchIntentHash !== input.metadata?.launchIntentHash) throw new Error('execution_identity_conflict');
        return existing;
      }
      const key = `run-launch-intent:${input.launchIntentId}`;
      const { executionLogId } = this.appendProjectJournal(projectId, key, { nodeId: input.nodeId, timestamp: new Date().toISOString(), agentCli: String(input.metadata?.agentCli || ''), command: input.command, output: String(input.metadata?.launchSummary || input.userMessage), status: input.status || 'Preparing' });
      const state = this.prepareRun(projectId, locationId, { ...input, executionLogId, ...(input.launchRequest ? { launchRequest: { ...input.launchRequest, executionLogId } } : {}), idempotencyKey: key });
      this.db.run('INSERT INTO run_launch_intents VALUES(?,?,?)', [projectId, input.launchIntentId, state.runId]);
      return state;
    });
  }
  public prepareRun(projectId: string, locationId: string, input: PrepareRunInput): RunState {
    if (!Number.isInteger(input.executionLogId) || input.executionLogId < 1 || !input.nodeId || !input.runKind || typeof input.prompt !== 'string' || typeof input.command !== 'string' || typeof input.userMessage !== 'string') throw new Error('invalid_run_request');
    if (input.globalPrompt !== undefined && typeof input.globalPrompt !== 'string') throw new Error('invalid_run_global_prompt');
    if (input.deliveryOwner && (!input.deliveryOwner.id || !Number.isInteger(input.deliveryOwner.pid) || input.deliveryOwner.pid < 1 || typeof input.deliveryOwner.birth !== 'string')) throw new Error('invalid_run_delivery_owner');
    const receipt = this.recordMutation({ operation: 'prepare_run', projectId, locationId, input }, input.idempotencyKey, 'prepare', () => {
      if (this.rows('SELECT run_id FROM run_control WHERE project_id=? AND execution_log_id=?', [projectId, input.executionLogId]).length) throw new Error('execution_identity_conflict');
      const parent = input.parentExecutionLogId ? this.runControl(projectId, input.parentExecutionLogId) : undefined;
      if (input.expectedParentTurnId && (!parent || parent.current_turn_id !== input.expectedParentTurnId)) throw new Error('run_source_turn_changed');
      const now = Date.now();
      const create = (kind: string, suffix: string, data: Record<string, unknown>) => this.write({ kind, action: 'create', scope: projectId, idempotencyKey: `${input.idempotencyKey}:${suffix}`, data }).objectId;
      const conversationId = parent ? String(parent.conversation_id) : create('conversation', 'conversation', { mode: input.runKind, status: 'active', title: input.userMessage });
      const taskId = parent ? String(parent.task_id) : create('task', 'task', { conversation_id: conversationId, original_request_content: input.userMessage, status: 'active' });
      const turnSequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM turns WHERE task_id=?', [taskId])[0].next);
      const turnId = create('turn', 'turn', { task_id: taskId, sequence: turnSequence, request_content: input.userMessage, started_at: now });
      const runId = crypto.randomUUID();
      this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [runId, 'run', projectId, 1, now, now]);
      this.db.run('INSERT INTO runs(id,project_id,task_id,turn_id,conversation_id,location_id,run_kind,actor_id,command_content_id,prompt_content_id,status,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [runId, projectId, taskId, turnId, conversationId, locationId, input.runKind, this.actorId, this.putContent(input.command), this.putContent(input.prompt), input.status || 'Running', now]);
      let globalPolicy = this.globalPromptPolicyReference();
      if (!globalPolicy && input.globalPrompt !== undefined) {
        const imported = this.write({ kind: 'policy', action: 'create', scope: null, idempotencyKey: `${input.idempotencyKey}:global-prompt-bootstrap`, data: { kind: 'global_prompt', status: 'active', content: input.globalPrompt } });
        globalPolicy = { objectId: imported.objectId, revision: imported.revision };
      }
      const metadata = { ...(input.metadata || {}), globalPromptPolicyRef: globalPolicy ? { objectId: globalPolicy.objectId, revision: globalPolicy.revision } : null, workspaceRoot: input.root, runKind: input.runKind, userMessage: input.userMessage };
      if (parent && input.expectedParentTurnId) Object.assign(metadata, { sourceParentRunId: String(parent.run_id), sourceParentTurnId: input.expectedParentTurnId });
      delete (metadata as Record<string, unknown>).checkpointToken;
      this.db.run('INSERT INTO run_control(run_id,project_id,execution_log_id,node_key,current_turn_id,metadata_content_id) VALUES(?,?,?,?,?,?)', [runId, projectId, input.executionLogId, input.nodeId, turnId, this.putContent(canonical(metadata), 'application/json')]);
      if (input.runKind === 'learning_review') {
        const batchId = String(input.metadata?.learningReviewBatchId || '');
        const control = this.rows('SELECT run_id FROM learning_review_controls WHERE batch_id=? AND request_project_id=?', [batchId, projectId])[0];
        if (!control || control.run_id !== null || this.readMetadata(batchId).data.status !== 'draft') throw new Error('learning_review_run_conflict');
        this.db.run('UPDATE learning_review_controls SET run_id=? WHERE batch_id=?', [runId, batchId]);
      }
      this.db.run('UPDATE run_control SET process_pid=?,process_birth=? WHERE run_id=?', [Number(input.metadata?.agentPid || 0), String(input.metadata?.processBirth || ''), runId]);
      if (input.deliveryOwner) this.db.run('UPDATE run_control SET delivery_pending=1,delivery_owner_id=?,delivery_pid=?,delivery_birth=?,recovery_needed=1 WHERE run_id=?', [input.deliveryOwner.id, input.deliveryOwner.pid, input.deliveryOwner.birth, runId]);
      this.db.run('INSERT INTO relations VALUES(?,?,?)', [runId, 'source', turnId]);
      if (input.roadmapBackup !== undefined) {
        const backup = this.writeRunDocument(projectId, { executionLogId: input.executionLogId, generation: 1, turnId, purpose: 'roadmap_backup', bytes: input.roadmapBackup, mimeType: 'text/csv', expectedRevision: 0, idempotencyKey: `${input.idempotencyKey}:roadmap-backup` });
        Object.assign(metadata, { roadmapBackupObjectId: backup.objectId, roadmapBackupRevision: backup.revision });
        this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putContent(canonical(metadata), 'application/json'), runId]);
      }
      this.saveRunControlRevision(runId);
      if (input.launchRequest) this.writeRunDocument(projectId, { executionLogId: input.executionLogId, generation: 1, purpose: 'launch_request', bytes: Buffer.from(JSON.stringify(input.launchRequest)).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: `${input.idempotencyKey}:launch-request` });
      this.bindRunTurnJournal(projectId, runId, turnId, input.nodeId, metadata, input.executionLogId);
      if (parent) this.db.run('INSERT INTO relations VALUES(?,?,?)', [runId, 'source', parent.run_id]);
      return this.current(runId);
    });
    const state = this.readRunState(projectId, input.executionLogId, receipt.revision);
    return { ...state, receipt, proof: this.runProof(state.runId, state.generation) };
  }
  public readRunExecutionPlan(projectId: string, executionLogId: number): RunState & { command: string; prompt: string } {
    const state = this.readRunCheckpointState(projectId, executionLogId);
    const run = this.current(state.runId);
    return { ...state, command: String(run.data.command_content), prompt: String(run.data.prompt_content) };
  }
  public readRunCheckpointState(projectId: string, executionLogId: number): RunState {
    const state = this.readRunState(projectId, executionLogId);
    return { ...state, proof: this.runProof(state.runId, state.generation) };
  }
  public patchRunInputs(projectId: string, input: { executionLogId: number; generation: number; expectedRevision: number; prompt?: string; command?: string; status?: string; idempotencyKey: string }): RunState {
    const initial = this.runControl(projectId, input.executionLogId);
    if (initial.generation !== input.generation) throw new Error('run_owner_conflict');
    if (['prompt', 'command', 'status'].some(key => Object.prototype.hasOwnProperty.call(input, key) && typeof input[key as keyof typeof input] !== 'string')) throw new Error('invalid_run_inputs');
    const receipt = this.recordMutation({ operation: 'patch_run_inputs', projectId, input }, input.idempotencyKey, 'inputs', () => {
      const row = this.runControl(projectId, input.executionLogId);
      if (row.revision !== input.expectedRevision) throw new Error('revision_conflict');
      if (input.status !== undefined) {
        const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
        if (metadata.interactiveSessionClosed === true && ['Preparing', 'Running', 'Waiting', 'Turn Started'].includes(input.status)) throw new Error('session_already_closed');
      }
      for (const [key, column] of [['prompt', 'prompt_content_id'], ['command', 'command_content_id']] as const) {
        if (input[key] !== undefined) this.db.run(`UPDATE runs SET ${column}=? WHERE id=?`, [this.putContent(input[key]!), row.run_id]);
      }
      if (input.status !== undefined) this.db.run('UPDATE runs SET status=? WHERE id=?', [input.status, row.run_id]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
      this.saveRunControlRevision(String(row.run_id));
      return this.current(String(row.run_id));
    });
    return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
  }
  public listRunStates(input: { projectId?: string; cursor?: number; limit?: number; pendingConsumer?: boolean }): { items: RunState[]; nextCursor: number | null } {
    const cursor = input.cursor ?? 0; const limit = input.limit ?? 100;
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_run_list');
    const rows = input.pendingConsumer
      ? this.rows(`SELECT run_consumer_sources.rowid,run_consumer_sources.project_id,run_control.execution_log_id,run_consumer_sources.source_revision FROM run_consumer_sources JOIN run_control ON run_control.run_id=run_consumer_sources.run_id WHERE run_consumer_sources.state='queued' AND run_consumer_sources.rowid>?${input.projectId ? ' AND run_consumer_sources.project_id=?' : ''} ORDER BY run_consumer_sources.rowid LIMIT ?`, [cursor, ...(input.projectId ? [input.projectId] : []), limit + 1])
      : this.rows(`SELECT rowid,project_id,execution_log_id FROM run_control WHERE rowid>?${input.projectId ? ' AND project_id=?' : ''} ORDER BY rowid LIMIT ?`, [cursor, ...(input.projectId ? [input.projectId] : []), limit + 1]);
    const page = rows.slice(0, limit);
    return { items: page.map(row => this.readRunState(String(row.project_id), Number(row.execution_log_id), input.pendingConsumer ? Number(row.source_revision) : undefined)), nextCursor: rows.length > limit ? Number(page[page.length - 1].rowid) : null };
  }
  private saveRunGitEvidence(projectId: string, executionLogId: number, generation: number, turnId: string, evidence: RunGitEvidence, metadata: Record<string, unknown>, key: string): void {
    const purpose = gitEvidenceDocumentPurpose(turnId);
    const previous = this.readRunDocument(projectId, executionLogId, purpose);
    const saved = this.writeRunDocument(projectId, { executionLogId, generation, turnId, purpose, bytes: Buffer.from(JSON.stringify(evidence)).toString('base64'), mimeType: 'application/json', expectedRevision: previous?.revision || 0, idempotencyKey: `${key}:git-evidence` });
    Object.assign(metadata, { gitEvidenceObjectId: saved.objectId, gitEvidenceRevision: saved.revision });
  }
  public checkpointRun(projectId: string, input: RunCheckpointInput): RunState {
    this.verifyRunProof(projectId, input.executionLogId, input.generation, input.proof);
    const receipt = this.recordMutation(this.checkpointIntent(projectId, input), input.idempotencyKey, 'checkpoint', () => {
      const row = this.runControl(projectId, input.executionLogId);
      if (row.revision !== input.expectedRevision) throw new Error('revision_conflict');
      if (input.expectedTurnId && input.expectedTurnId !== row.current_turn_id) throw new Error('checkpoint_turn_conflict');
      const nativeTimestamp = input.action === 'start' ? input.nativeStartedAt : input.action === 'complete' ? input.nativeCompletedAt : undefined;
      const now = input.workspaceEvidenceSource === 'native' && Number.isFinite(nativeTimestamp) ? nativeTimestamp! : Date.now();
      const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8')) as Record<string, unknown>;
      let status: string;
      let turnId = String(row.current_turn_id);
      let finishedAt: number | null = null;
      let exitCode = input.exitCode;
      let unreportedClose = false;
      const sealingNativeOnClose = input.action === 'session-close' && metadata.nativeOutputPending === true;
      const finalizingNative = input.action === 'complete' && input.workspaceEvidenceSource === 'native' && metadata.nativeOutputPending === true && this.readMetadata(turnId).data.finished_at !== null;
      const logOffsets = Object.fromEntries(['output', 'stdout', 'stderr'].map(stream => [stream, this.readRunLogHead(projectId, input.executionLogId, stream).totalBytes]));
      if (input.action === 'start') {
        if (metadata.hostOutputPending === true || metadata.nativeOutputPending === true) throw new Error('run_output_pending');
        if (metadata.interactiveSessionClosed === true) throw new Error('session_already_closed');
        if (metadata.stopRequested === true) throw new Error('run_stop_requested');
        if (input.exitCode !== undefined) throw new Error('invalid_checkpoint_exit_code');
        if (['Running', 'Turn Started'].includes(String(row.status))) throw new Error('turn_already_running');
        if (!String(input.message || '').trim()) throw new Error('checkpoint_message_required');
        const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM turns WHERE task_id=?', [row.task_id])[0].next);
        turnId = this.write({ kind: 'turn', action: 'create', scope: projectId, idempotencyKey: `${input.idempotencyKey}:turn`, data: { task_id: String(row.task_id), sequence, request_content: input.message!, started_at: now } }).objectId;
        status = 'Running';
        this.db.run('UPDATE run_control SET recovery_needed=1 WHERE run_id=?', [row.run_id]);
        this.db.run('UPDATE runs SET exit_code=NULL WHERE id=?', [row.run_id]);
        Object.assign(metadata, { userMessage: input.message, checkpointMessage: input.message, checkpointOutcome: '', checkpointSummary: '', checkpointNext: '', checkpointImplicitTurn: false, checkpointStartSourceTurnId: String(row.current_turn_id), turnStartedAt: new Date(now).toISOString() });
        // Replaying a machine event cannot prove delivery of a subsequently saved policy.
        if (input.workspaceEvidenceSource !== 'native') {
          const globalPolicy = this.globalPromptPolicyReference();
          metadata.globalPromptPolicyRef = globalPolicy ? { objectId: globalPolicy.objectId, revision: globalPolicy.revision } : null;
        }
        metadata.turnLogStartOffsets = logOffsets;
        if (input.preserveRoadmapState !== undefined) metadata.checkpointPreserveRoadmapState = input.preserveRoadmapState;
        delete metadata.turnLogEndOffsets;
        delete metadata.codexNativeAwaitingRequest;
        delete metadata.failureCode;
        delete metadata.failureReason;
        delete metadata.taskReportObjectId;
        delete metadata.taskReportRevision;
        delete metadata.taskReportStatus;
        delete metadata.taskReportError;
        this.db.run('INSERT INTO relations VALUES(?,?,?)', [row.run_id, 'source', turnId]);
        this.bindRunTurnJournal(projectId, String(row.run_id), turnId, String(row.node_key), metadata);
      } else if (input.action === 'complete') {
        if (finalizingNative) {
          const turn = this.readMetadata(turnId);
          const aborted = input.outcome === 'failed';
          this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: turnId, expectedRevision: turn.revision, data: { finished_at: now, ...(Number.isFinite(input.nativeStartedAt) ? { started_at: input.nativeStartedAt! } : {}), ...(aborted ? { outcome: 'failed', summary_content: input.summary! } : {}) }, idempotencyKey: `${input.idempotencyKey}:native-finished` });
          if (aborted) Object.assign(metadata, { checkpointOutcome: 'failed', checkpointSummary: input.summary });
          metadata.nativeOutputPending = false;
          status = aborted ? 'Failed' : String(row.status);
          finishedAt = now;
        } else {
        if (metadata.interactiveSessionClosed === true) throw new Error('session_already_closed');
        if (!['Preparing', 'Running', 'Waiting', 'Processed', 'Turn Started'].includes(String(row.status))) throw new Error('turn_already_settled');
        if (!['partial', 'candidate_complete', 'blocked_user', 'blocked_external', 'failed'].includes(String(input.outcome))) throw new Error('invalid_checkpoint_outcome');
        if (!String(input.summary || '').trim()) throw new Error('checkpoint_summary_required');
        let outcome = input.outcome!;
        let summary = input.summary!;
        if (input.requireDeliverable && !metadata.interactiveSession && !['solo', 'solo_background', 'solo_continue', 'step_continue'].includes(String(row.run_kind)) && exitCode === 0 && outcome === 'partial') {
          const baseline = this.readRunDocument(projectId, input.executionLogId, workspaceDocumentPurpose(turnId, 'before'));
          if (!baseline || !input.workspaceSnapshot) throw new Error('workspace_baseline_required');
          const before: WorkspaceSnapshot = JSON.parse(Buffer.from(baseline.bytes, 'base64').toString('utf8'));
          if (workspaceChanges(before, input.workspaceSnapshot).length === 0 && !(row.run_kind === 'learning_review' && this.hasLearningReviewDeliverable(projectId, metadata))) {
            outcome = 'failed'; exitCode = 125;
            summary = '本轮未产生项目变更，也未提交完成候选，请继续执行。';
            Object.assign(metadata, { failureCode: 'no_deliverable_changes', failureReason: summary });
          }
        }
        if (this.current(turnId, false).data.finished_at !== null) {
          const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM turns WHERE task_id=?', [row.task_id])[0].next);
          turnId = this.write({ kind: 'turn', action: 'create', scope: projectId, idempotencyKey: `${input.idempotencyKey}:implicit-turn`, data: { task_id: String(row.task_id), sequence, request_content: input.message || String(metadata.userMessage || ''), started_at: now } }).objectId;
          this.db.run('INSERT INTO relations VALUES(?,?,?)', [row.run_id, 'source', turnId]);
          Object.assign(metadata, { checkpointImplicitTurn: true, turnStartedAt: new Date(now).toISOString() });
          this.bindRunTurnJournal(projectId, String(row.run_id), turnId, String(row.node_key), metadata);
        }
        const turn = this.current(turnId, false);
        this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: turnId, expectedRevision: turn.revision, idempotencyKey: `${input.idempotencyKey}:turn`, data: { outcome, summary_content: summary, finished_at: now, ...(input.workspaceEvidenceSource === 'native' && Number.isFinite(input.nativeStartedAt) ? { started_at: input.nativeStartedAt! } : {}) } });
        status = outcome === 'failed' ? 'Failed' : 'In Progress';
        finishedAt = now;
        Object.assign(metadata, { checkpointMessage: input.message || metadata.userMessage || '', checkpointOutcome: outcome, checkpointSummary: summary, checkpointNext: input.next || '', checkpointAt: new Date(now).toISOString() });
        const reportInput = { report: input.report ?? null, availability: input.reportAvailability || 'missing', validationError: input.reportValidationError || '' };
        const reportReceipt = this.recordMutation({ operation: 'checkpoint_report', projectId, runId: row.run_id, turnId, ...reportInput }, `${input.idempotencyKey}:report`, 'report', () => this.createRunReport(projectId, String(row.run_id), turnId, reportInput));
        Object.assign(metadata, { taskReportObjectId: reportReceipt.objectId, taskReportRevision: reportReceipt.revision, taskReportStatus: reportInput.availability === 'available' ? 'recorded' : reportInput.availability, taskReportError: reportInput.validationError });
        }
      } else if (input.action === 'session-close') {
        status = ['In Progress', 'Failed', 'Completed', 'Stopped'].includes(String(row.status)) ? String(row.status) : 'Session Closed';
        finishedAt = now;
        const turn = this.current(turnId, false);
        if (turn.data.finished_at === null) {
          unreportedClose = true;
          if (['Preparing', 'Running', 'Turn Started'].includes(String(row.status))) status = 'Failed';
          const summary = '会话已关闭，本轮尚未提交结果；已保留执行记录，可继续处理。';
          this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: turnId, expectedRevision: turn.revision, idempotencyKey: `${input.idempotencyKey}:turn`, data: { outcome: 'failed', summary_content: summary, finished_at: now } });
          const reportInput = { report: null, availability: 'missing', validationError: '' };
          const reportReceipt = this.recordMutation({ operation: 'checkpoint_report', projectId, runId: row.run_id, turnId, ...reportInput }, `${input.idempotencyKey}:report`, 'report', () => this.createRunReport(projectId, String(row.run_id), turnId, reportInput));
          Object.assign(metadata, { failureCode: 'checkpoint_missing', failureReason: summary, checkpointOutcome: 'failed', checkpointSummary: summary, checkpointAt: new Date(now).toISOString(), taskReportObjectId: reportReceipt.objectId, taskReportRevision: reportReceipt.revision, taskReportStatus: 'missing', taskReportError: '' });
        }
        metadata.nativeOutputPending = false;
        Object.assign(metadata, { interactiveSessionClosed: true, sessionExitCode: input.exitCode ?? 0, sessionClosePreviousStatus: row.status });
      } else throw new Error('invalid_checkpoint_action');
      if (input.action === 'start') {
        for (const key of ['nativeTokenUsage', 'nativeReplyObjectId', 'nativeReplyRevision', 'nativeWorkspaceObservationObjectId', 'nativeWorkspaceObservationRevision', 'workspaceEvidenceBoundary', 'workspaceSnapshotObjectId', 'workspaceSnapshotRevision', 'workspaceChangesObjectId', 'workspaceChangesRevision', 'workspaceAfterObjectId', 'workspaceAfterRevision', 'workspaceChangeCount']) delete metadata[key];
        metadata.baseGitHash = input.gitBaseline || '';
        delete metadata.gitEvidenceObjectId;
        delete metadata.gitEvidenceRevision;
      } else if (input.gitEvidence && (input.action !== 'session-close' || unreportedClose || sealingNativeOnClose)) {
        this.saveRunGitEvidence(projectId, input.executionLogId, input.generation, turnId, input.gitEvidence, metadata, input.idempotencyKey);
      }
      if (input.gitAfterHash !== undefined) metadata.workspaceAfterGitHash = input.gitAfterHash;
      if (input.workspaceEvidenceSource === 'native' && input.nativeWorkspaceObservation) {
        const observed = this.writeRunDocument(projectId, { executionLogId: input.executionLogId, generation: input.generation, turnId, purpose: `native_workspace_observation_${turnId.replace(/-/g, '')}`, bytes: Buffer.from(JSON.stringify(input.nativeWorkspaceObservation)).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: `${input.idempotencyKey}:native-workspace-observation` });
        Object.assign(metadata, { workspaceEvidenceBoundary: finalizingNative && metadata.workspaceEvidenceSource === 'checkpoint' ? 'recorded_at_business_completion' : 'unavailable', nativeWorkspaceObservationObjectId: observed.objectId, nativeWorkspaceObservationRevision: observed.revision });
        if (!finalizingNative) for (const key of ['gitEvidenceObjectId', 'gitEvidenceRevision', 'workspaceChangesObjectId', 'workspaceChangesRevision', 'workspaceAfterObjectId', 'workspaceAfterRevision', 'workspaceChangeCount']) delete metadata[key];
      } else if (input.workspaceEvidenceSource === 'native' && input.workspaceSnapshot) metadata.workspaceEvidenceBoundary = 'recorded';
      if (input.action === 'complete' && input.workspaceEvidenceSource === 'native' && input.nativeReply !== undefined) {
        const reply = this.writeRunDocument(projectId, { executionLogId: input.executionLogId, generation: input.generation, turnId, purpose: `native_reply_${turnId.replace(/-/g, '')}`, bytes: Buffer.from(input.nativeReply).toString('base64'), mimeType: 'text/plain', expectedRevision: 0, idempotencyKey: `${input.idempotencyKey}:native-reply` });
        Object.assign(metadata, { nativeReplyObjectId: reply.objectId, nativeReplyRevision: reply.revision });
      }
      if (input.workspaceEvidenceSource === 'native' && input.nativeTokenUsage) {
        const usage = input.nativeTokenUsage;
        if (Object.values(usage).some(value => !Number.isInteger(value) || value < 0)) throw new Error('invalid_run_usage');
        metadata.nativeTokenUsage = usage;
        this.db.run('UPDATE runs SET input_tokens=?,cached_input_tokens=?,output_tokens=?,reasoning_output_tokens=?,total_tokens=? WHERE id=?', [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.reasoningOutputTokens, usage.totalTokens, row.run_id]);
      }
      if (input.workspaceSnapshot && (input.action !== 'session-close' || unreportedClose || sealingNativeOnClose)) {
        metadata.workspaceObservedAt = new Date().toISOString();
        metadata.workspaceEvidenceSource = input.workspaceEvidenceSource || 'checkpoint';
        const save = (phase: 'before' | 'after' | 'changes', value: string) => {
          const purpose = workspaceDocumentPurpose(turnId, phase);
          const previous = this.readRunDocument(projectId, input.executionLogId, purpose);
          const saved = this.writeRunDocument(projectId, { executionLogId: input.executionLogId, generation: input.generation, turnId, purpose, bytes: Buffer.from(value).toString('base64'), mimeType: phase === 'changes' ? 'text/plain' : 'application/json', expectedRevision: previous?.revision || 0, idempotencyKey: `${input.idempotencyKey}:workspace:${phase}` });
          metadata[phase === 'before' ? 'workspaceSnapshotRevision' : phase === 'after' ? 'workspaceAfterRevision' : 'workspaceChangesRevision'] = saved.revision;
          return saved.objectId;
        };
        if (input.action === 'start') {
          metadata.workspaceSnapshotObjectId = save('before', JSON.stringify(input.workspaceSnapshot));
          delete metadata.workspaceChangesObjectId;
          delete metadata.workspaceChangesRevision;
          delete metadata.workspaceAfterObjectId;
          delete metadata.workspaceAfterRevision;
          delete metadata.workspaceChangeCount;
        } else {
          const implicit = turnId !== row.current_turn_id;
          const baseline = this.readRunDocument(projectId, input.executionLogId, workspaceDocumentPurpose(String(row.current_turn_id), implicit ? 'after' : 'before'));
          const before: WorkspaceSnapshot = baseline ? JSON.parse(Buffer.from(baseline.bytes, 'base64').toString('utf8')) : {};
          if (implicit) metadata.workspaceSnapshotObjectId = save('before', JSON.stringify(before));
          else if (baseline) { metadata.workspaceSnapshotObjectId = baseline.objectId; metadata.workspaceSnapshotRevision = baseline.revision; }
          const changes = workspaceChanges(before, input.workspaceSnapshot);
          metadata.workspaceChangesObjectId = save('changes', changes.join('\n'));
          metadata.workspaceAfterObjectId = save('after', JSON.stringify(input.workspaceSnapshot));
          metadata.workspaceChangeCount = changes.length;
        }
      }
      if (input.action === 'complete' && !metadata.interactiveSession && this.hasLiveRunProcess(row)) metadata.hostOutputPending = true;
      if (input.action === 'complete' && metadata.interactiveSession && metadata.sessionProvider === 'codex' && input.workspaceEvidenceSource !== 'native' && input.exitCode === undefined && (metadata.codexNativeBoundTurnId === turnId || this.readRunBinding(projectId, input.executionLogId))) metadata.nativeOutputPending = true;
      if (input.action !== 'start') metadata.turnLogEndOffsets = logOffsets;
      if (input.workspaceEvidenceSource === 'native' && input.nativeLogRange) {
        const { start, end } = input.nativeLogRange;
        const head = this.readRunLogHead(projectId, input.executionLogId, 'native:codex');
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > head.totalBytes) throw new Error('native_source_range_invalid');
        metadata.turnLogStartOffsets = { ...(metadata.turnLogStartOffsets as Record<string, unknown> || {}), 'native:codex': start };
        metadata.turnLogEndOffsets = { ...(metadata.turnLogEndOffsets as Record<string, unknown> || {}), 'native:codex': end };
      }
      if (input.nativeSessionObservation && input.action !== 'session-close') {
        const observation = input.nativeSessionObservation;
        if (observation.provider !== 'claude' || observation.source !== 'CLAUDE_CODE_SESSION_ID' || typeof observation.sessionId !== 'string') throw new Error('invalid_native_session_observation');
        const binding = this.readRunBinding(projectId, input.executionLogId);
        const head = binding?.revisions[binding.headRevision - 1];
        if (binding?.provider === observation.provider && path.resolve(binding.workspaceRoot) === path.resolve(String(metadata.workspaceRoot)) && head?.state === 'planned' && head.sessionId === metadata.plannedNativeSessionId) {
          const evidence = { source: observation.source, turnId, generation: input.generation };
          const confirmed = this.writeRunBinding(projectId, {
            executionLogId: input.executionLogId, generation: input.generation, expectedHeadRevision: binding.headRevision,
            ...(observation.sessionId === head.sessionId ? { confirmSessionId: head.sessionId, evidence } : { revision: {
              ...(observation.sessionId ? { sessionId: observation.sessionId } : {}), supersedesRevision: binding.headRevision,
              method: head.method, contract: head.contract, state: 'conflict', errorCode: 'identity_provider_mismatch', ...(head.providerContext ? { providerContext: head.providerContext } : {}), evidence
            } }), idempotencyKey: `${input.idempotencyKey}:provider-observation`
          });
          const resumable = confirmed.resumableRevision === confirmed.headRevision && confirmed.revisions[confirmed.headRevision - 1].state === 'confirmed';
          Object.assign(metadata, { sessionProvider: confirmed.provider, sessionBindingHeadRevision: confirmed.headRevision, nativeSessionId: resumable ? observation.sessionId : '', nativeSessionIdIsCurrent: resumable });
        }
      }
      const unverifiedProviderCompletion = input.action === 'complete' && metadata.interactiveSession && ['opencode', 'antigravity'].includes(String(metadata.sessionProvider));
      const unobservedSessionClose = input.action === 'session-close' && metadata.interactiveSession;
      if (unverifiedProviderCompletion || unobservedSessionClose) {
        const binding = this.readRunBinding(projectId, input.executionLogId);
        const head = binding?.revisions[binding.headRevision - 1];
        if (binding && head && (head.state === 'preparing' || unobservedSessionClose && head.state === 'planned')) {
          const unavailable = this.writeRunBinding(projectId, {
            executionLogId: input.executionLogId, generation: input.generation, expectedHeadRevision: binding.headRevision,
            revision: { supersedesRevision: binding.headRevision, method: head.method, contract: head.contract,
              state: 'unavailable', errorCode: unverifiedProviderCompletion ? 'identity_capability_unverified' : 'identity_not_observed',
              ...(head.providerContext ? { providerContext: head.providerContext } : {}), evidence: { ...(head.evidence || {}), source: 'business_checkpoint', turnId } },
            idempotencyKey: `${input.idempotencyKey}:unobserved-identity`
          });
          Object.assign(metadata, { sessionBindingHeadRevision: unavailable.headRevision, nativeSessionId: '', nativeSessionIdIsCurrent: false });
        }
      }
      metadata.checkpointEventId = `${Number(row.checkpoint_sequence) + 1}:${input.action}`;
      this.db.run('UPDATE run_control SET checkpoint_sequence=checkpoint_sequence+1,current_turn_id=?,metadata_content_id=? WHERE run_id=?', [turnId, this.putContent(canonical(metadata), 'application/json'), row.run_id]);
      this.db.run('UPDATE runs SET turn_id=?,status=?,finished_at=? WHERE id=?', [turnId, status, finishedAt, row.run_id]);
      if (exitCode !== undefined) {
        if (!Number.isInteger(exitCode) || exitCode < 0) throw new Error('invalid_run_exit_code');
        this.db.run('UPDATE runs SET exit_code=? WHERE id=?', [exitCode, row.run_id]);
      }
      if (metadata.hostOutputPending) this.db.run('UPDATE run_control SET recovery_needed=1 WHERE run_id=?', [row.run_id]);
      else if (input.action === 'session-close' || (exitCode !== undefined && !metadata.interactiveSession)) this.db.run('UPDATE run_control SET recovery_needed=0 WHERE run_id=?', [row.run_id]);
      else if (metadata.interactiveSession) this.db.run('UPDATE run_control SET recovery_needed=1 WHERE run_id=?', [row.run_id]);
      if (input.action !== 'start') {
        const journal = this.readRunTurnJournal(projectId, input.executionLogId, turnId);
        const evidence = input.action === 'complete' || unreportedClose ? [
          `Completion decision:\n${String(metadata.checkpointSummary || '')}`,
          `Checkpoint outcome: ${String(metadata.checkpointOutcome || '')}`,
          ...(metadata.workspaceChangesObjectId ? [`Workspace changes:\n${Buffer.from(this.readRunDocument(projectId, input.executionLogId, workspaceDocumentPurpose(turnId, 'changes'))!.bytes, 'base64').toString('utf8')}`] : []),
        ] : ['Interactive session state: Closed'];
        this.updateProjectJournal(projectId, journal.executionLogId, { ...journal.entry, status, output: [journal.entry.output, ...evidence].filter(Boolean).join('\n\n') });
      }
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [now, row.run_id]);
      this.saveRunControlRevision(String(row.run_id));
      const current = this.current(String(row.run_id), false);
      if (input.action !== 'start' && !metadata.hostOutputPending && !metadata.nativeOutputPending) this.db.run("INSERT INTO run_consumer_sources VALUES(?,?,?,?,?,'queued')", [row.run_id, projectId, turnId, Number(row.checkpoint_sequence) + 1, current.revision]);
      return current;
    }, undefined, false);
    return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
  }
  private checkpointIntent(projectId: string, input: RunCheckpointInput): unknown {
    const { proof: _proof, expectedRevision: _expectedRevision, reportAvailability: _availability, reportValidationError: _validationError, workspaceSnapshot: _workspaceSnapshot, gitEvidence: _gitEvidence, gitBaseline: _gitBaseline, nativeWorkspaceObservation: _nativeObservation, nativeReply: _nativeReply, ...intent } = input;
    return { operation: 'checkpoint_run', projectId, input: intent };
  }
  public readRunCheckpointReplay(projectId: string, input: RunCheckpointInput): RunState | null {
    this.verifyRunProof(projectId, input.executionLogId, input.generation, input.proof);
    const previous = this.rows('SELECT input_hash,result_content_id FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, input.idempotencyKey])[0];
    if (!previous) return null;
    if (previous.input_hash !== digest(canonical(this.checkpointIntent(projectId, input)))) throw new Error('idempotency_conflict');
    const receipt = JSON.parse(this.content(String(previous.result_content_id)).toString('utf8')) as WriteReceipt;
    return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
  }
  private runOutputFinalizationIntent(projectId: string, input: RunOutputFinalizationInput): unknown {
    const { proof: _proof, expectedRevision: _expectedRevision, workspaceSnapshot: _workspaceSnapshot, gitEvidence: _gitEvidence, ...intent } = input;
    return { operation: 'finalize_run_output', projectId, input: intent };
  }
  public readRunOutputFinalizationReplay(projectId: string, input: RunOutputFinalizationInput): RunState | null {
    this.verifyRunProof(projectId, input.executionLogId, input.generation, input.proof);
    const previous = this.rows('SELECT input_hash,result_content_id FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, input.idempotencyKey])[0];
    if (!previous) return null;
    if (previous.input_hash !== digest(canonical(this.runOutputFinalizationIntent(projectId, input)))) throw new Error('idempotency_conflict');
    const receipt = JSON.parse(this.content(String(previous.result_content_id)).toString('utf8')) as WriteReceipt;
    return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
  }
  public finalizeRunOutput(projectId: string, input: RunOutputFinalizationInput): RunState {
    this.verifyRunProof(projectId, input.executionLogId, input.generation, input.proof);
    if (!Number.isInteger(input.exitCode) || input.exitCode < 0 || !['host', 'recovery'].includes(input.source)) throw new Error('invalid_run_finalization');
    const receipt = this.recordMutation(this.runOutputFinalizationIntent(projectId, input), input.idempotencyKey, 'output_finalized', () => {
      const row = this.runControl(projectId, input.executionLogId);
      if (row.revision !== input.expectedRevision) throw new Error('revision_conflict');
      if (row.current_turn_id !== input.expectedTurnId) throw new Error('checkpoint_turn_conflict');
      const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
      if (!metadata.hostOutputPending || metadata.interactiveSession || this.readMetadata(input.expectedTurnId).data.finished_at === null) throw new Error('run_output_not_pending');
      if (input.source === 'recovery' && this.hasLiveRunProcess(row)) throw new Error('run_owner_alive');
      if (!input.workspaceSnapshot) throw new Error('workspace_snapshot_required');
      const now = Date.now();
      const baseline = this.readRunDocument(projectId, input.executionLogId, workspaceDocumentPurpose(input.expectedTurnId, 'before'));
      if (input.gitEvidence) this.saveRunGitEvidence(projectId, input.executionLogId, input.generation, input.expectedTurnId, input.gitEvidence, metadata, input.idempotencyKey);
      const before = baseline ? JSON.parse(Buffer.from(baseline.bytes, 'base64').toString('utf8')) as WorkspaceSnapshot : {};
      const changes = workspaceChanges(before, input.workspaceSnapshot);
      for (const [phase, bytes] of [['after', JSON.stringify(input.workspaceSnapshot)], ['changes', changes.join('\n')]] as const) {
        const purpose = workspaceDocumentPurpose(input.expectedTurnId, phase);
        const previous = this.readRunDocument(projectId, input.executionLogId, purpose);
        const document = this.writeRunDocument(projectId, { executionLogId: input.executionLogId, generation: input.generation, turnId: input.expectedTurnId, purpose, bytes: Buffer.from(bytes).toString('base64'), mimeType: phase === 'after' ? 'application/json' : 'text/plain', expectedRevision: previous?.revision || 0, idempotencyKey: `${input.idempotencyKey}:${phase}` });
        metadata[phase === 'after' ? 'workspaceAfterObjectId' : 'workspaceChangesObjectId'] = document.objectId;
        metadata[phase === 'after' ? 'workspaceAfterRevision' : 'workspaceChangesRevision'] = document.revision;
      }
      metadata.workspaceChangeCount = changes.length;
      metadata.workspaceObservedAt = new Date(now).toISOString();
      metadata.workspaceEvidenceSource = input.source;
      metadata.turnLogEndOffsets = Object.fromEntries(['output', 'stdout', 'stderr'].map(stream => [stream, this.readRunLogHead(projectId, input.executionLogId, stream).totalBytes]));
      metadata.hostOutputPending = false; metadata.hostOutputFinalizedAt = new Date(now).toISOString(); metadata.hostOutputSource = input.source;
      let exitCode = row.status === 'Failed' && Number(row.exit_code) !== 0 ? Number(row.exit_code) : input.exitCode;
      const maintenanceResult = maintenanceRunKinds.includes(String(row.run_kind)) && this.readRunDocument(projectId, input.executionLogId, 'maintenance_result');
      const noDeliverable = exitCode === 0 && metadata.checkpointOutcome === 'partial' && !maintenanceResult && !(row.run_kind === 'agent_review' && metadata.agentLaunch?.readOnly) && !['solo', 'solo_background', 'solo_continue', 'step_continue', 'flow_planner', 'flow_verifier'].includes(String(row.run_kind)) && changes.length === 0 && !(row.run_kind === 'learning_review' && this.hasLearningReviewDeliverable(projectId, metadata));
      if (noDeliverable) exitCode = 125;
      const status = exitCode === 0 ? String(row.status) : 'Failed';
      if ((input.exitCode !== 0 || noDeliverable) && metadata.checkpointOutcome !== 'failed') {
        const turn = this.readMetadata(input.expectedTurnId);
        const summary = noDeliverable ? '本轮未产生项目变更，也未提交完成候选，请继续执行。' : input.source === 'recovery' ? '执行在宿主收口前中断，完整已提交记录已保留。' : `执行最终退出码为 ${input.exitCode}，完整输出已保存。`;
        this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: turn.objectId, expectedRevision: turn.revision, data: { outcome: 'failed', summary_content: summary }, idempotencyKey: `${input.idempotencyKey}:turn` });
        Object.assign(metadata, { checkpointOutcome: 'failed', checkpointSummary: summary, failureCode: noDeliverable ? 'no_deliverable_changes' : input.source === 'recovery' ? 'host_interrupted' : 'agent_exit_nonzero', failureReason: summary });
      }
      this.db.run('UPDATE run_control SET metadata_content_id=?,recovery_needed=0 WHERE run_id=?', [this.putContent(canonical(metadata), 'application/json'), row.run_id]);
      this.db.run('UPDATE runs SET status=?,exit_code=?,finished_at=? WHERE id=?', [status, exitCode, now, row.run_id]);
      const journal = this.readRunTurnJournal(projectId, input.executionLogId, input.expectedTurnId);
      this.updateProjectJournal(projectId, journal.executionLogId, { ...journal.entry, status });
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [now, row.run_id]);
      this.saveRunControlRevision(String(row.run_id));
      this.db.run("INSERT INTO run_consumer_sources VALUES(?,?,?,?,?,'queued')", [row.run_id, projectId, input.expectedTurnId, row.checkpoint_sequence, Number(row.revision) + 1]);
      return this.current(String(row.run_id), false);
    }, undefined, false);
    return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
  }
  public claimRunConsumer(projectId: string, input: RunConsumerInput & { owner: { id: string; pid: number; birth: string } }): RunConsumerLease | null {
    if (!input.owner?.id || !Number.isInteger(input.owner.pid) || input.owner.pid < 1 || !input.owner.birth) throw new Error('run_consumer_owner_required');
    return this.transaction(() => {
      const row = this.runControl(projectId, input.executionLogId);
      const source = this.rows('SELECT * FROM run_consumer_sources WHERE run_id=? AND source_revision=?', [row.run_id, input.expectedRevision])[0];
      if (!source) {
        if (row.revision === input.expectedRevision && ['Waiting', 'Processed', 'Preparing', 'Running'].includes(String(row.status))) return null;
        throw new Error('run_consumer_source_changed');
      }
      const original = this.readRunState(projectId, input.executionLogId, input.expectedRevision);
      if (source.turn_id !== input.expectedTurnId || original.generation !== input.generation) throw new Error('run_consumer_source_changed');
      if (source.state === 'committed') return null;
      const current = this.rows('SELECT * FROM run_consumer_leases WHERE run_id=?', [row.run_id])[0];
      const sameSource = current && current.generation === row.generation && current.turn_id === source.turn_id && current.source_revision === source.source_revision && current.checkpoint_sequence === source.checkpoint_sequence && current.head_revision === row.revision;
      if (sameSource && current.state === 'committed') return null;
      if (current?.state === 'claimed' && this.hasLiveRunProcess({ process_pid: current.pid, process_birth: current.birth })) {
        if (sameSource && current.owner_id === input.owner.id && current.pid === input.owner.pid && current.birth === input.owner.birth) return { executionLogId: input.executionLogId, generation: Number(row.generation), expectedRevision: input.expectedRevision, expectedTurnId: input.expectedTurnId, token: String(current.token) };
        return null;
      }
      const token = crypto.randomBytes(32).toString('hex');
      this.db.run("INSERT INTO run_consumer_leases VALUES(?,?,?,?,?,?,?,?,?,?,'claimed') ON CONFLICT(run_id) DO UPDATE SET owner_id=excluded.owner_id,pid=excluded.pid,birth=excluded.birth,token=excluded.token,generation=excluded.generation,source_revision=excluded.source_revision,turn_id=excluded.turn_id,checkpoint_sequence=excluded.checkpoint_sequence,head_revision=excluded.head_revision,state='claimed'", [row.run_id, input.owner.id, input.owner.pid, input.owner.birth, token, row.generation, input.expectedRevision, input.expectedTurnId, source.checkpoint_sequence, row.revision]);
      return { executionLogId: input.executionLogId, generation: Number(row.generation), expectedRevision: input.expectedRevision, expectedTurnId: input.expectedTurnId, token };
    });
  }
  public releaseRunConsumer(projectId: string, input: RunConsumerLease): void {
    const row = this.runControl(projectId, input.executionLogId);
    this.db.run("UPDATE run_consumer_leases SET state='released' WHERE run_id=? AND token=? AND generation=? AND state='claimed'", [row.run_id, input.token, input.generation]);
  }
  public commitRunSettlement(projectId: string, input: RunSettlementInput): RunState {
    if (!input.journal || ['agentCli', 'command', 'output', 'status'].some(key => typeof input.journal[key as keyof typeof input.journal] !== 'string') || !input.digest || typeof input.digest !== 'object') throw new Error('invalid_run_settlement');
    const receipt = this.recordMutation({ operation: 'commit_run_settlement', projectId, input }, input.idempotencyKey, 'settle', () => {
      const row = this.runControl(projectId, input.executionLogId);
      const lease = this.rows('SELECT * FROM run_consumer_leases WHERE run_id=?', [row.run_id])[0];
      if (!lease || lease.state !== 'claimed' || lease.token !== input.token) throw new Error('run_consumer_lease_lost');
      if (lease.head_revision !== row.revision || row.generation !== input.generation) throw new Error('run_consumer_source_changed');
      const source = this.rows('SELECT * FROM run_consumer_sources WHERE run_id=? AND source_revision=?', [row.run_id, input.expectedRevision])[0];
      if (!source || source.state !== 'queued' || source.turn_id !== input.expectedTurnId || lease.source_revision !== input.expectedRevision || lease.turn_id !== input.expectedTurnId || lease.checkpoint_sequence !== source.checkpoint_sequence) throw new Error('run_consumer_source_changed');
      const journal = this.readRunTurnJournal(projectId, input.executionLogId, input.expectedTurnId);
      if (input.digest.nodeId !== row.node_key || input.digest.executionLogId !== journal.executionLogId) throw new Error('run_settlement_identity_mismatch');
      const original = this.readRunState(projectId, input.executionLogId, input.expectedRevision);
      const metadata = original.status;
      const previousTurn = this.rows('SELECT learning_event_id FROM run_settlements WHERE run_id=? AND turn_id=? ORDER BY checkpoint_sequence LIMIT 1', [row.run_id, input.expectedTurnId])[0];
      let settledFlow: FlowSnapshot | undefined;
      if (input.flowUpdate && !previousTurn) {
        if (!String(row.node_key).startsWith(`__flow__::${input.flowUpdate.flow.flowId}::`)) throw new Error('flow_role_identity_mismatch');
        settledFlow = this.writeFlowTrace(projectId, { ...input.flowUpdate, idempotencyKey: `${input.idempotencyKey}:flow` });
      }
      const payload = { journal: input.journal, digest: input.digest, ...(settledFlow ? { flowObjectId: settledFlow.objectId, flowRevision: settledFlow.revision } : {}), ...(input.documentationAudit ? { documentationAudit: input.documentationAudit } : {}), ...(input.handoff ? { handoff: input.handoff } : {}), ...(input.learning ? { learning: input.learning } : {}), ...(input.index ? { index: input.index } : {}), reportObjectId: String(metadata.taskReportObjectId || ''), reportRevision: Number(metadata.taskReportRevision || 0), sourceRevision: input.expectedRevision };
      const payloadId = this.putContent(canonical(payload), 'application/json');
      const digestId = this.putContent(canonical(input.digest), 'application/json');
      const handoffId = input.handoff ? this.putContent(canonical(input.handoff), 'application/json') : null;
      const now = Date.now();
      const sourceKey = `${input.expectedTurnId.replace(/-/g, '')}_${Number(source.checkpoint_sequence)}`;
      const document = this.writeRunDocument(projectId, { executionLogId: input.executionLogId, generation: input.generation, turnId: input.expectedTurnId, purpose: `settlement_${sourceKey}`, bytes: this.content(payloadId).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: `${input.idempotencyKey}:evidence` });
      this.saveRunDigestSource(projectId, `native:${row.run_id}:${input.expectedTurnId}:${source.checkpoint_sequence}`, Buffer.from(canonical(input.digest)), document.objectId);
      if (input.documentationAudit && !previousTurn) this.writeDocumentationManifest(projectId, input.documentationAudit.manifest, String(row.run_id), input.expectedRevision, `${input.idempotencyKey}:documentation`);
      let learningEventId: string | null = null;
      if (input.learning) {
        if (!input.learning.eventType || typeof input.learning.summary !== 'string' || !input.learning.metadata) throw new Error('invalid_settlement_learning');
        const learningMetadata = input.learning.metadata;
        const verification = Array.isArray(learningMetadata.verification) ? learningMetadata.verification : (learningMetadata.metadata as Record<string, unknown> | undefined)?.verification;
        const verificationSignal = (input.learning.eventType === 'verified' && Array.isArray(verification) && verification.some(isUsefulVerificationSignal)) || learningMetadata.recommendedStatus === 'closed';
        learningEventId = previousTurn?.learning_event_id ? String(previousTurn.learning_event_id) : this.write({ kind: 'learning_event', action: 'create', scope: projectId, data: { source_object_id: input.expectedTurnId, event_type: input.learning.eventType, summary: input.learning.summary, occurred_at: now, source_revision: this.readMetadata(input.expectedTurnId).revision, source_type: String(learningMetadata.sourceType || ''), verification_signal: verificationSignal }, idempotencyKey: `${input.idempotencyKey}:learning` }).objectId;
        this.db.run('INSERT INTO relations VALUES(?,?,?)', [learningEventId, 'source', document.objectId]);
        if (metadata.taskReportObjectId) this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [learningEventId, 'source', String(metadata.taskReportObjectId)]);
      }
      if (input.handoff && !previousTurn) {
        this.db.run('INSERT INTO step_handoffs VALUES(?,?,?,?,?,?)', [projectId, row.node_key, row.run_id, input.expectedTurnId, source.checkpoint_sequence, handoffId]);
        this.recordMutation({ operation: 'settlement_step_memory', projectId, nodeId: row.node_key, sourceObjectId: document.objectId }, `${input.idempotencyKey}:step-memory`, 'step_memory', () => this.saveStepMemoryRevision(projectId, String(row.node_key), undefined, document.objectId));
      }
      this.updateProjectJournal(projectId, journal.executionLogId, input.journal);
      if (metadata.interactiveSessionClosed === true) {
        const closedJournals = this.rows("SELECT j.execution_log_id FROM relations r JOIN run_turn_journals j ON j.project_id=? AND j.turn_id=r.target_id WHERE r.source_id=? AND r.relation='source' AND j.run_id=?", [projectId, row.run_id, row.run_id]);
        for (const mapping of closedJournals) {
          const old = this.readProjectJournal(projectId, { executionLogId: Number(mapping.execution_log_id) }).logs[0];
          const output = old.output.replace(/Interactive session state:\s*(?:Open|Waiting|Running)/gi, 'Interactive session state: Closed');
          if (output !== old.output) this.updateProjectJournal(projectId, old.id, { ...old, output });
        }
      }
      if (input.index) {
        if (input.index.record.executionLogId !== journal.executionLogId || input.index.record.nodeId !== row.node_key) throw new Error('run_settlement_identity_mismatch');
        this.upsertProjectRunIndex(projectId, input.index.record as unknown as RunIndexRecord, input.index.files as unknown as RunIndexFile[], input.index.signals as unknown as RunIndexSignal[]);
      }
      this.db.run('INSERT INTO run_settlements VALUES(?,?,?,?,?,?,?,?,?,?,?)', [row.run_id, input.expectedTurnId, source.checkpoint_sequence, projectId, journal.executionLogId, input.expectedRevision, payloadId, digestId, handoffId, learningEventId, now]);
      const effectKinds = new Set<string>();
      for (const effect of input.effects || []) {
        if (!effect || !['roadmap', 'review', 'revision', 'refresh', 'telegram', 'automation', 'flow'].includes(effect.kind) || !effect.payload || typeof effect.payload !== 'object' || Array.isArray(effect.payload) || effectKinds.has(effect.kind)) throw new Error('invalid_run_effect');
        effectKinds.add(effect.kind);
        if (previousTurn && effect.kind !== 'refresh') continue;
        this.db.run("INSERT INTO run_effects(id,project_id,run_id,turn_id,checkpoint_sequence,execution_log_id,source_revision,kind,payload_content_id,state) VALUES(?,?,?,?,?,?,?,?,?,'queued')", [crypto.randomUUID(), projectId, row.run_id, input.expectedTurnId, source.checkpoint_sequence, journal.executionLogId, input.expectedRevision, effect.kind, this.putContent(canonical(effect.payload), 'application/json')]);
      }
      this.db.run('INSERT INTO run_summaries VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET summary_content_id=excluded.summary_content_id,handoff_content_id=excluded.handoff_content_id,source_revision=excluded.source_revision WHERE run_summaries.source_revision<=excluded.source_revision', [row.run_id, digestId, handoffId, input.expectedRevision]);
      if (row.current_turn_id === input.expectedTurnId && row.checkpoint_sequence === source.checkpoint_sequence) {
        const currentMetadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8')) as Record<string, unknown>;
        const keepOpen = currentMetadata.interactiveSession === true && currentMetadata.interactiveSessionClosed !== true;
        Object.assign(currentMetadata, { checkpointSettledStatus: input.journal.status, processedAt: new Date(now).toISOString(), processedCheckpointSequence: Number(source.checkpoint_sequence), ...(keepOpen ? { waitingSince: new Date(now).toISOString() } : {}) });
        this.db.run('UPDATE runs SET status=? WHERE id=?', [keepOpen ? 'Waiting' : 'Processed', row.run_id]);
        this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putContent(canonical(currentMetadata), 'application/json'), row.run_id]);
      }
      this.db.run("UPDATE run_consumer_sources SET state='committed' WHERE run_id=? AND source_revision=?", [row.run_id, input.expectedRevision]);
      this.db.run("UPDATE run_consumer_leases SET state='committed' WHERE run_id=? AND token=?", [row.run_id, input.token]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [now, row.run_id]);
      this.saveRunControlRevision(String(row.run_id));
      return this.current(String(row.run_id), false);
    }, undefined, false);
    return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
  }
  public readRunSettlements(projectId: string, input: { executionLogId?: number; turnId?: string; cursor?: number; limit?: number }): { items: Array<Record<string, unknown>>; nextCursor: number | null } {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(input.cursor ?? 0) || (input.cursor ?? 0) < 0) throw new Error('invalid_settlement_page');
    const values: SqlValue[] = [projectId, input.cursor ?? 0];
    if (input.executionLogId !== undefined) values.push(this.runControl(projectId, input.executionLogId).run_id);
    if (input.turnId !== undefined) {
      if (!this.rows('SELECT id FROM turns WHERE id=? AND project_id=?', [input.turnId, projectId]).length) throw new Error('run_turn_mismatch');
      values.push(input.turnId);
    }
    const rows = this.rows(`SELECT rowid,* FROM run_settlements WHERE project_id=? AND rowid>? ${input.executionLogId === undefined ? '' : 'AND run_id=?'} ${input.turnId === undefined ? '' : 'AND turn_id=?'} ORDER BY rowid LIMIT ?`, [...values, limit + 1]);
    const page = rows.slice(0, limit);
    return { items: page.map(row => ({ ...JSON.parse(this.content(String(row.payload_content_id)).toString('utf8')), runId: String(row.run_id), turnId: String(row.turn_id), checkpointSequence: Number(row.checkpoint_sequence), executionLogId: Number(row.execution_log_id), learningEventId: row.learning_event_id, committedAt: Number(row.committed_at) })), nextCursor: rows.length > limit ? Number(page[page.length - 1].rowid) : null };
  }
  private saveRunDigestSource(projectId: string, sourceKey: string, bytes: Buffer, sourceObjectId?: string): WriteReceipt {
    const value = parseRunDigestSource(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const previous = this.rows('SELECT object_id,projection_object_id FROM run_digest_sources WHERE project_id=? AND source_key=?', [projectId, sourceKey])[0];
    const hash = digest(bytes);
    return this.recordMutation({ operation: 'run_digest', projectId, sourceKey, hash, previous: previous?.object_id || null }, `run-digest:${canonical([projectId, sourceKey, previous?.object_id || null, hash])}`, 'run_digest', () => {
      const id = crypto.randomUUID(); const now = Date.now(); const contentId = this.putContent(bytes, 'application/json');
      this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [id, 'evidence', projectId, 1, now, now]);
      this.db.run('INSERT INTO evidence(id,project_id,type,source_actor_id,content_id,observed_at,source_revision) VALUES(?,?,?,?,?,?,1)', [id, projectId, 'run_digest', this.actorId, contentId, now]);
      this.db.run('INSERT INTO run_digests VALUES(?,?,?,?,?,?,?,?)', [id, projectId, contentId, value.nodeId, value.runKind || '', value.runId, value.finishedAt || '', value.executionLogId]);
      for (const [kind, signals] of [['file', [...(value.changedFiles || []), ...(value.touchedFiles || [])]], ['tag', value.tags || []]] as const) {
        signals.forEach((signal, ordinal) => this.db.run('INSERT INTO run_digest_signals VALUES(?,?,?,?,?)', [projectId, id, kind, ordinal, signal]));
      }
      const header = { sourceRef: { objectId: id, revision: 1 }, runId: value.runId, nodeId: value.nodeId, runKind: value.runKind || '', executionLogId: value.executionLogId, finishedAt: value.finishedAt || '', agentCli: value.agentCli || '', status: value.status || '', failureCount: (value.failures || []).length };
      const pointer = previous ? this.current(String(previous.projection_object_id), false) : undefined;
      const projection = this.write({ kind: 'evidence', scope: projectId, action: pointer ? 'patch' : 'create', ...(pointer ? { objectId: pointer.objectId, expectedRevision: pointer.revision } : {}), idempotencyKey: `run-digest-source:${canonical([projectId, sourceKey, id])}`, data: { type: 'run_digest_source', source_actor_id: this.actorId, observed_at: now, content: canonical(header) } });
      this.db.run('INSERT INTO run_digest_sources VALUES(?,?,?,?,?) ON CONFLICT(project_id,source_key) DO UPDATE SET object_id=excluded.object_id,source_hash=excluded.source_hash', [projectId, sourceKey, id, projection.objectId, hash]);
      this.db.run('INSERT INTO run_digest_generations VALUES(?,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1', [projectId]);
      if (previous) this.db.run('INSERT INTO relations VALUES(?,?,?)', [id, 'previous', previous.object_id]);
      if (sourceObjectId) this.db.run('INSERT INTO relations VALUES(?,?,?)', [id, 'source', sourceObjectId]);
      return this.current(id);
    });
  }
  public importRunDigestSource(projectId: string, input: { source: ImportedSource; bytes: Buffer }): { unchanged: boolean } {
    const { source, bytes } = input;
    if (!source.key || source.identity !== `run-digests:${projectId}` || source.hash !== digest(bytes)) throw new Error('run_digest_source_invalid');
    return this.transaction(() => {
      const key = `legacy:${source.key}`;
      const existing = this.rows('SELECT * FROM run_digest_sources WHERE project_id=? AND source_key=?', [projectId, key])[0];
      if (existing?.source_hash === source.hash) {
        this.db.run("UPDATE migration_items SET source_hash=?,object_id=?,imported_revision=1,stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [source.hash, existing.object_id, source.identity, source.key]);
        return { unchanged: true };
      }
      const receipt = this.saveRunDigestSource(projectId, key, bytes);
      this.db.run("UPDATE migration_items SET source_hash=?,object_id=?,imported_revision=?,stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [source.hash, receipt.objectId, receipt.revision, source.identity, source.key]);
      return { unchanged: false };
    });
  }
  private runDigestReference(row: Record<string, SqlValue>): RunDigestReference {
    return { digest: parseRunDigestSource(this.content(String(row.content_id)).toString('utf8')), ref: { objectId: String(row.object_id), revision: 1 } };
  }
  public queryRunDigests(projectId: string, query: ExecutionExperienceQuery): RunDigestReference[] {
    const rows = this.rows(`SELECT * FROM (
      SELECT d.*,
        CASE WHEN d.node_key=? THEN 8 ELSE 0 END + CASE WHEN d.run_kind<>'' AND d.run_kind=? THEN 2 ELSE 0 END +
        5*MIN(3,(SELECT COUNT(*) FROM run_digest_signals s WHERE s.project_id=d.project_id AND s.object_id=d.object_id AND s.kind='file' AND s.value<>'' AND instr(?,s.value)>0)) +
        MIN(6,(SELECT COUNT(*) FROM run_digest_signals s WHERE s.project_id=d.project_id AND s.object_id=d.object_id AND s.kind='tag' AND s.value IN (SELECT value FROM json_each(?)))) AS score
      FROM run_digests d JOIN run_digest_sources c ON c.object_id=d.object_id AND c.project_id=d.project_id WHERE d.project_id=?
    ) WHERE score>=3 ORDER BY score DESC,finished_at DESC,object_id LIMIT 3`, [query.nodeId || '', query.runKind || '', query.contextText || '', JSON.stringify(executionQueryTokens(query.contextText, query.supplementFiles)), projectId]);
    return rows.map(row => this.runDigestReference(row));
  }
  public readRunDigests(projectId: string, input: { cursor?: number; limit?: number; sourceRevision?: number } = {}): { items: RunDigestReference[]; nextCursor: number | null; sourceRevision: number; sourceChanged: boolean } {
    const cursor = input.cursor ?? 0; const limit = input.limit ?? 100;
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500 || (input.sourceRevision !== undefined && (!Number.isInteger(input.sourceRevision) || input.sourceRevision < 0))) throw new Error('invalid_run_digest_page');
    const sourceRevision = Number(this.rows('SELECT revision FROM run_digest_generations WHERE project_id=?', [projectId])[0]?.revision || 0);
    if (input.sourceRevision !== undefined && sourceRevision !== input.sourceRevision) return { items: [], nextCursor: null, sourceRevision, sourceChanged: true };
    const rows = this.rows('SELECT d.rowid AS cursor,d.* FROM run_digests d JOIN run_digest_sources c ON c.object_id=d.object_id AND c.project_id=d.project_id WHERE d.project_id=? AND d.rowid>? ORDER BY d.rowid LIMIT ?', [projectId, cursor, limit + 1]);
    const page = rows.slice(0, limit);
    return { items: page.map(row => this.runDigestReference(row)), nextCursor: rows.length > limit ? Number(page[page.length - 1].cursor) : null, sourceRevision, sourceChanged: false };
  }
  public readRunIndexHealth(projectId: string): { digestCount: number; indexedCount: number; missingDigestCount: number; backfilledCount: number; ok: boolean; error: string } {
    const summary = this.rows(`SELECT COUNT(*) AS digests,SUM(CASE WHEN i.execution_log_id IS NULL OR (((p.object_id IS NOT NULL AND p.object_id<>d.object_id) OR (p.object_id IS NULL AND EXISTS(SELECT 1 FROM run_index_import_sources h WHERE h.project_id=d.project_id AND h.execution_log_id=d.execution_log_id AND h.priority=10))) AND d.rowid=(SELECT MAX(n.rowid) FROM run_digests n JOIN run_digest_sources nc ON nc.object_id=n.object_id WHERE n.project_id=d.project_id AND n.execution_log_id=d.execution_log_id)) THEN 1 ELSE 0 END) AS missing
      FROM run_digests d JOIN run_digest_sources c ON c.object_id=d.object_id AND c.project_id=d.project_id
      LEFT JOIN project_run_indexes i ON i.project_id=d.project_id AND i.execution_log_id=d.execution_log_id
      LEFT JOIN run_digest_index_sources p ON p.project_id=d.project_id AND p.execution_log_id=d.execution_log_id WHERE d.project_id=?`, [projectId])[0];
    const missing = Number(summary.missing || 0);
    return { digestCount: Number(summary.digests), indexedCount: Number(this.rows('SELECT COUNT(*) AS count FROM project_run_indexes WHERE project_id=?', [projectId])[0].count), missingDigestCount: missing, backfilledCount: 0, ok: missing === 0, error: '' };
  }
  public backfillRunIndexes(projectId: string, limit?: number): ReturnType<UnifiedDataStore['readRunIndexHealth']> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('invalid_backfill_limit');
    return this.transaction(() => {
      const missing = this.rows(`SELECT d.* FROM run_digests d JOIN run_digest_sources c ON c.object_id=d.object_id AND c.project_id=d.project_id
        LEFT JOIN project_run_indexes i ON i.project_id=d.project_id AND i.execution_log_id=d.execution_log_id
        LEFT JOIN run_digest_index_sources p ON p.project_id=d.project_id AND p.execution_log_id=d.execution_log_id
        WHERE d.project_id=? AND (i.execution_log_id IS NULL OR (p.object_id IS NOT NULL AND p.object_id<>d.object_id) OR (p.object_id IS NULL AND EXISTS(SELECT 1 FROM run_index_import_sources h WHERE h.project_id=d.project_id AND h.execution_log_id=d.execution_log_id AND h.priority=10)))
          AND d.rowid=(SELECT MAX(n.rowid) FROM run_digests n JOIN run_digest_sources nc ON nc.object_id=n.object_id AND nc.project_id=n.project_id WHERE n.project_id=d.project_id AND n.execution_log_id=d.execution_log_id)
        ORDER BY d.rowid DESC ${limit === undefined ? '' : 'LIMIT ?'}`, limit === undefined ? [projectId] : [projectId, limit]);
      const inserted = new Set<number>();
      for (const row of missing) {
        const executionLogId = Number(row.execution_log_id); if (inserted.has(executionLogId)) continue;
        const latest = this.rows('SELECT d.object_id FROM run_digests d JOIN run_digest_sources c ON c.object_id=d.object_id WHERE d.project_id=? AND d.execution_log_id=? ORDER BY d.rowid DESC LIMIT 1', [projectId, executionLogId])[0];
        if (latest.object_id !== row.object_id) continue;
        const index = digestToRunIndex(this.runDigestReference(row).digest);
        const tokenSource = this.enrichRunIndexFromArchivedOutput(projectId, index.record);
        this.upsertProjectRunIndex(projectId, index.record, index.files, index.signals);
        this.db.run('DELETE FROM run_index_import_sources WHERE project_id=? AND execution_log_id=?', [projectId, executionLogId]);
        if (tokenSource) this.db.run('INSERT INTO run_index_import_sources VALUES(?,?,?,?,?,?,10)', [projectId, executionLogId, `archived-run-output:${projectId}`, tokenSource.key, tokenSource.hash, digest(canonical([index.record, index.files, index.signals]))]);
        this.db.run('INSERT INTO run_digest_index_sources VALUES(?,?,?) ON CONFLICT(project_id,execution_log_id) DO UPDATE SET object_id=excluded.object_id', [projectId, executionLogId, row.object_id]);
        inserted.add(executionLogId);
      }
      return { ...this.readRunIndexHealth(projectId), backfilledCount: inserted.size };
    });
  }
  private runEffectReference(row: Record<string, SqlValue>): RunEffectReference {
    return { effectId: String(row.id), projectId: String(row.project_id), runId: String(row.run_id), turnId: String(row.turn_id), executionLogId: Number(row.execution_log_id), sourceRevision: Number(row.source_revision), checkpointSequence: Number(row.checkpoint_sequence), kind: row.kind as RunEffect['kind'], error: String(row.error), ...(row.state === 'claimed' ? { token: String(row.token) } : {}) };
  }
  private runEffect(row: Record<string, SqlValue>): RunEffect {
    return { ...this.runEffectReference(row), payload: JSON.parse(this.content(String(row.payload_content_id)).toString('utf8')) };
  }
  public listRunEffects(input: { projectId?: string; state?: 'done'; cursor?: number; limit?: number }): { items: RunEffectReference[]; nextCursor: number | null } {
    const cursor = input.cursor ?? 0; const limit = input.limit ?? 100;
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500 || (input.state !== undefined && input.state !== 'done')) throw new Error('invalid_run_effect_page');
    const rows = this.rows(`SELECT rowid,* FROM run_effects WHERE ${input.state === 'done' ? "state='done'" : "state IN ('queued','claimed')"} AND rowid>?${input.projectId ? ' AND project_id=?' : ''} ORDER BY rowid LIMIT ?`, [cursor, ...(input.projectId ? [input.projectId] : []), limit + 1]);
    const page = rows.slice(0, limit);
    return { items: page.map(row => this.runEffectReference(row)), nextCursor: rows.length > limit ? Number(page[page.length - 1].rowid) : null };
  }
  public claimRunEffect(projectId: string, input: { effectId: string; owner: { id: string; pid: number; birth: string } }): RunEffect | null {
    if (!input.owner?.id || !Number.isInteger(input.owner.pid) || input.owner.pid <= 0 || !input.owner.birth) throw new Error('invalid_run_effect_owner');
    return this.transaction(() => {
      const row = this.rows('SELECT * FROM run_effects WHERE id=? AND project_id=?', [input.effectId, projectId])[0];
      if (!row) throw new Error('run_effect_scope_mismatch');
      if (row.state === 'done') return null;
      if (row.state === 'claimed' && this.hasLiveRunProcess({ process_pid: row.pid, process_birth: row.birth })) {
        return row.owner_id === input.owner.id && row.pid === input.owner.pid && row.birth === input.owner.birth ? this.runEffect(row) : null;
      }
      const token = crypto.randomBytes(32).toString('hex');
      this.db.run("UPDATE run_effects SET state='claimed',owner_id=?,pid=?,birth=?,token=? WHERE id=?", [input.owner.id, input.owner.pid, input.owner.birth, token, input.effectId]);
      return this.runEffect({ ...row, state: 'claimed', token });
    });
  }
  public finishRunEffect(projectId: string, input: { effectId: string; token: string; result: 'done' | 'retry'; error?: string }): { state: string } {
    if (!['done', 'retry'].includes(input.result)) throw new Error('invalid_run_effect_result');
    return this.transaction(() => {
      const row = this.rows('SELECT * FROM run_effects WHERE id=? AND project_id=?', [input.effectId, projectId])[0];
      if (!row) throw new Error('run_effect_scope_mismatch');
      if (!input.token || row.token !== input.token || !['claimed', 'done'].includes(String(row.state))) throw new Error('run_effect_lease_lost');
      if (row.state === 'done') return { state: 'done' };
      const state = input.result === 'done' ? 'done' : 'queued';
      this.db.run('UPDATE run_effects SET state=?,error=?,completed_at=? WHERE id=?', [state, input.error || '', input.result === 'done' ? Date.now() : null, input.effectId]);
      return { state };
    });
  }
  public readFlowTrace(projectId: string, flowId: string, revision?: number): FlowSnapshot | null {
    const row = this.rows('SELECT * FROM flow_control WHERE project_id=? AND flow_id=?', [projectId, flowId])[0];
    if (!row) return null;
    const objectId = String(row.object_id);
    const header = this.read(objectId, revision);
    const saved = this.rows('SELECT loop_versions_content_id FROM flow_revisions WHERE object_id=? AND revision=?', [objectId, header.revision])[0];
    if (!saved) throw new Error('flow_revision_missing');
    const versions = JSON.parse(this.content(String(saved.loop_versions_content_id)).toString('utf8')) as Array<{ objectId: string; revision: number }>;
    const loops = versions.map(version => {
      const evidence = this.read(version.objectId, version.revision);
      if (evidence.projectId !== projectId || evidence.kind !== 'evidence' || evidence.data.type !== 'flow_loop') throw new Error('flow_loop_scope_mismatch');
      return JSON.parse(String(evidence.data.content));
    });
    return { projectId, objectId, taskId: String(row.task_id), revision: header.revision, flow: { ...JSON.parse(String(header.data.content)), loops } };
  }
  public prepareFlowRole(projectId: string, locationId: string, input: Omit<PrepareRunInput, 'executionLogId' | 'nodeId' | 'runKind'> & { flowId: string; loopId: string; role: 'planner' | 'builder' | 'verifier'; attempt: number; initialFlow?: FlowTrace }): RunState {
    if (!['planner', 'builder', 'verifier'].includes(input.role) || !Number.isInteger(input.attempt) || input.attempt < 0) throw new Error('invalid_flow_role');
    return this.transaction(() => {
      let snapshot = this.readFlowTrace(projectId, input.flowId);
      if (!snapshot && input.initialFlow) {
        if (input.initialFlow.flowId !== input.flowId || input.role !== 'planner' || input.attempt !== 0 || input.initialFlow.goal !== input.userMessage) throw new Error('flow_initial_identity_mismatch');
        snapshot = this.writeFlowTrace(projectId, { flow: input.initialFlow, expectedRevision: 0, idempotencyKey: `${input.idempotencyKey}:initial-flow` });
      }
      if (!snapshot) throw new Error('flow_trace_missing');
      const loop = snapshot.flow.loops.find(item => item.loopId === input.loopId);
      if (!loop || loop.index !== snapshot.flow.currentLoopIndex) throw new Error('flow_loop_not_current');
      if (snapshot.flow.status !== 'running') throw new Error('flow_not_running');
      const existing = this.rows('SELECT run_control.execution_log_id FROM flow_role_runs JOIN run_control ON run_control.run_id=flow_role_runs.run_id WHERE flow_role_runs.project_id=? AND flow_id=? AND loop_id=? AND role=? AND attempt=?', [projectId, input.flowId, input.loopId, input.role, input.attempt])[0];
      if (existing) {
        const state = this.readRunCheckpointState(projectId, Number(existing.execution_log_id));
        if (state.status.launchIntentHash !== input.metadata?.launchIntentHash) throw new Error('execution_identity_conflict');
        return state;
      }
      if (input.attempt !== (loop[input.role].retryCount || 0)) throw new Error('flow_role_attempt_conflict');
      const nodeId = `__flow__::${input.flowId}::${input.loopId}::${input.role}`;
      const key = `flow-role:${projectId}:${input.flowId}:${input.loopId}:${input.role}:${input.attempt}`;
      const { executionLogId } = this.appendProjectJournal(projectId, key, { nodeId, timestamp: new Date().toISOString(), agentCli: String(input.metadata?.agentCli || ''), command: input.command, output: input.userMessage, status: input.status || 'Preparing' });
      const state = this.prepareRun(projectId, locationId, { ...input, executionLogId, nodeId, runKind: `flow_${input.role}`, ...(input.launchRequest ? { launchRequest: { ...input.launchRequest, executionLogId } } : {}), idempotencyKey: key });
      this.db.run('INSERT INTO flow_role_runs VALUES(?,?,?,?,?,?)', [projectId, input.flowId, input.loopId, input.role, input.attempt, state.runId]);
      loop[input.role] = { ...loop[input.role], status: 'running', executionLogId, startedAt: String(state.status.startedAt), command: input.command };
      loop.status = input.role === 'planner' ? 'planned' : input.role === 'builder' ? 'building' : 'verifying';
      loop.updatedAt = new Date().toISOString();
      this.writeFlowTrace(projectId, { flow: snapshot.flow, expectedRevision: snapshot.revision, idempotencyKey: `${key}:attach` });
      return state;
    });
  }
  public readRunLaunchPermission(projectId: string, input: { executionLogId: number; generation: number; proof: string; expectedTurnId: string }): { permission: 'allow' | 'wait' | 'deny'; reason: string } {
    const row = this.verifyRunProof(projectId, input.executionLogId, input.generation, input.proof);
    if (row.current_turn_id !== input.expectedTurnId) throw new Error('checkpoint_turn_conflict');
    const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
    if (metadata.stopRequested || metadata.interactiveSessionClosed || row.finished_at !== null) return { permission: 'deny', reason: 'run_stop_requested' };
    if (metadata.sourceParentRunId) {
      const parent = this.rows('SELECT current_turn_id FROM run_control WHERE project_id=? AND run_id=?', [projectId, metadata.sourceParentRunId])[0];
      if (!parent || parent.current_turn_id !== metadata.sourceParentTurnId) return { permission: 'deny', reason: 'run_source_turn_changed' };
    }
    const flow = this.rows('SELECT evidence.content_id FROM flow_role_runs JOIN flow_control USING(project_id,flow_id) JOIN evidence ON evidence.id=flow_control.object_id WHERE flow_role_runs.project_id=? AND flow_role_runs.run_id=?', [projectId, row.run_id])[0];
    if (flow) {
      const status = JSON.parse(this.content(String(flow.content_id)).toString('utf8')).status;
      if (status === 'paused') return { permission: 'wait', reason: 'flow_paused' };
      if (status !== 'running') return { permission: 'deny', reason: 'flow_not_running' };
    }
    return { permission: 'allow', reason: '' };
  }
  private runFlowLaunchAllowed(projectId: string, runId: string): boolean {
    const row = this.rows('SELECT evidence.content_id FROM flow_role_runs JOIN flow_control USING(project_id,flow_id) JOIN evidence ON evidence.id=flow_control.object_id WHERE flow_role_runs.project_id=? AND flow_role_runs.run_id=?', [projectId, runId])[0];
    return !row || JSON.parse(this.content(String(row.content_id)).toString('utf8')).status === 'running';
  }
  public writeFlowTrace(projectId: string, input: { flow: FlowTrace; expectedRevision: number; idempotencyKey: string }): FlowSnapshot {
    const flow = input.flow;
    if (!flow || flow.schemaVersion !== 1 || typeof flow.flowId !== 'string' || !flow.flowId || typeof flow.goal !== 'string' || !flow.source || !Array.isArray(flow.loops) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('invalid_flow_trace');
    if (!this.rows("SELECT id FROM project_locations WHERE project_id=? AND root_path=? AND status='active'", [projectId, path.resolve(flow.projectPath)]).length) throw new Error('flow_project_mismatch');
    const receipt = this.recordMutation({ operation: 'write_flow_trace', projectId, input }, input.idempotencyKey, 'flow', () => {
      let row = this.rows('SELECT * FROM flow_control WHERE project_id=? AND flow_id=?', [projectId, flow.flowId])[0];
      if (row ? this.readMetadata(String(row.object_id)).revision !== input.expectedRevision : input.expectedRevision !== 0) throw new Error('revision_conflict');
      const { loops, ...header } = flow;
      const now = Date.now();
      const headerReceipt = { objectId: row ? String(row.object_id) : crypto.randomUUID(), revision: input.expectedRevision + 1 };
      const headerContentId = this.putContent(canonical(header));
      if (row) {
        this.db.run('UPDATE evidence SET content_id=?,source_actor_id=?,observed_at=? WHERE id=?', [headerContentId, this.actorId, now, headerReceipt.objectId]);
        this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [now, headerReceipt.objectId]);
      } else {
        this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [headerReceipt.objectId, 'evidence', projectId, 1, now, now]);
        this.db.run("INSERT INTO evidence(id,project_id,type,source_actor_id,observed_at,content_id) VALUES(?,?,'flow',?,?,?)", [headerReceipt.objectId, projectId, this.actorId, now, headerContentId]);
      }
      if (!row) {
        const conversation = this.write({ kind: 'conversation', action: 'create', scope: projectId, data: { mode: 'flow', status: flow.status, title: flow.goal }, idempotencyKey: `${input.idempotencyKey}:conversation` });
        const task = this.write({ kind: 'task', action: 'create', scope: projectId, data: { conversation_id: conversation.objectId, original_request_content: flow.source.userInput || flow.goal, status: flow.status }, idempotencyKey: `${input.idempotencyKey}:task` });
        this.db.run('INSERT INTO flow_control VALUES(?,?,?,?)', [projectId, flow.flowId, task.objectId, headerReceipt.objectId]);
        this.db.run('INSERT INTO relations VALUES(?,?,?)', [task.objectId, 'source', headerReceipt.objectId]);
        row = { project_id: projectId, flow_id: flow.flowId, task_id: task.objectId, object_id: headerReceipt.objectId };
      } else {
        const task = this.readMetadata(String(row.task_id));
        if (task.data.status !== flow.status) this.write({ kind: 'task', action: 'patch', scope: projectId, objectId: task.objectId, expectedRevision: task.revision, data: { status: flow.status }, idempotencyKey: `${input.idempotencyKey}:task` });
      }
      const known = this.rows('SELECT * FROM flow_loop_details WHERE project_id=? AND flow_id=?', [projectId, flow.flowId]);
      if (known.some(item => !loops.some(loop => loop.loopId === item.loop_id))) throw new Error('flow_history_cannot_be_removed');
      const seenIds = new Set<string>(); const seenSequences = new Set<number>(); const versions: Array<{ objectId: string; revision: number }> = [];
      for (const loop of loops) {
        if (!loop.loopId || !Number.isInteger(loop.index) || loop.index < 1 || seenIds.has(loop.loopId) || seenSequences.has(loop.index) || !loop.planner || !loop.builder || !loop.verifier) throw new Error('invalid_flow_loop');
        seenIds.add(loop.loopId); seenSequences.add(loop.index);
        const previous = known.find(item => item.loop_id === loop.loopId);
        const roleRefs: Record<string, string | null> = {};
        for (const role of ['planner', 'builder', 'verifier'] as const) {
          const executionLogId = loop[role].executionLogId;
          const run = executionLogId === undefined ? undefined : this.runControl(projectId, Number(executionLogId));
          if (run && run.node_key !== `__flow__::${flow.flowId}::${loop.loopId}::${role}`) throw new Error('flow_role_identity_mismatch');
          roleRefs[`${role}_run_id`] = run ? String(run.run_id) : null;
        }
        const bytes = canonical(loop);
        const evidence = previous ? this.readMetadata(String(previous.evidence_object_id)) : null;
        if (evidence && this.rows('SELECT sha256 FROM contents WHERE id=?', [String(evidence.data.content_id)])[0]?.sha256 === digest(bytes)) {
          versions.push({ objectId: evidence.objectId, revision: evidence.revision });
          continue;
        }
        const workflow = previous ? this.readMetadata(String(previous.loop_object_id)) : null;
        const loopReceipt = this.write({ kind: 'workflow_loop', action: workflow ? 'patch' : 'create', scope: projectId, ...(workflow ? { objectId: workflow.objectId, expectedRevision: workflow.revision } : {}), data: { task_id: row.task_id, sequence: loop.index, goal: loop.goal, status: loop.status, ...roleRefs, scoring_content: loop.scoring ? canonical(loop.scoring) : null }, idempotencyKey: `${input.idempotencyKey}:loop:${loop.loopId}` });
        const evidenceReceipt = this.write({ kind: 'evidence', action: evidence ? 'patch' : 'create', scope: projectId, ...(evidence ? { objectId: evidence.objectId, expectedRevision: evidence.revision } : {}), data: { type: 'flow_loop', source_actor_id: this.actorId, content: bytes, observed_at: Date.now() }, idempotencyKey: `${input.idempotencyKey}:loop-evidence:${loop.loopId}` });
        if (!previous) {
          this.db.run('INSERT INTO flow_loop_details VALUES(?,?,?,?,?)', [projectId, flow.flowId, loop.loopId, loopReceipt.objectId, evidenceReceipt.objectId]);
          this.db.run('INSERT INTO relations VALUES(?,?,?)', [headerReceipt.objectId, 'source', loopReceipt.objectId]);
          this.db.run('INSERT INTO relations VALUES(?,?,?)', [loopReceipt.objectId, 'source', evidenceReceipt.objectId]);
        }
        versions.push({ objectId: evidenceReceipt.objectId, revision: evidenceReceipt.revision });
      }
      this.db.run('INSERT INTO flow_revisions VALUES(?,?,?)', [headerReceipt.objectId, headerReceipt.revision, this.putContent(canonical(versions), 'application/json')]);
      return this.current(headerReceipt.objectId);
    });
    return this.readFlowTrace(projectId, flow.flowId, receipt.revision)!;
  }
  public listFlowTraces(projectId: string, input: { cursor?: number; limit?: number }): { items: Array<Omit<FlowSnapshot, 'flow'> & { flow: Omit<FlowTrace, 'loops'> }>; nextCursor: number | null } {
    const limit = input.limit ?? 100; const cursor = input.cursor ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(cursor) || cursor < 0) throw new Error('invalid_flow_page');
    const rows = this.rows('SELECT flow_control.rowid AS cursor,flow_control.*,objects.revision,evidence.content_id FROM flow_control JOIN objects ON objects.id=flow_control.object_id JOIN evidence ON evidence.id=flow_control.object_id WHERE flow_control.project_id=? AND flow_control.rowid>? ORDER BY flow_control.rowid LIMIT ?', [projectId, cursor, limit + 1]);
    const page = rows.slice(0, limit);
    return { items: page.map(row => ({ projectId, objectId: String(row.object_id), taskId: String(row.task_id), revision: Number(row.revision), flow: JSON.parse(this.content(String(row.content_id)).toString('utf8')) })), nextCursor: rows.length > limit ? Number(page[page.length - 1].cursor) : null };
  }
  public readStepMemoryState(projectId: string): { revision: number } {
    return { revision: Number(this.rows('SELECT revision FROM project_step_memory_state WHERE project_id=?', [projectId])[0]?.revision || 0) };
  }
  private saveStepMemoryRevision(projectId: string, nodeId: string, data?: Record<string, unknown>, sourceObjectId?: string): DataObject {
    const current = this.rows('SELECT r.* FROM project_step_memory c JOIN project_step_memory_revisions r USING(project_id,node_key,revision) WHERE c.project_id=? AND c.node_key=?', [projectId, nodeId])[0];
    const revision = Number(current?.revision || 0) + 1;
    const contentId = data === undefined && current ? String(current.content_id) : this.putContent(canonical(data || {}), 'application/json');
    const cursor = Number(this.rows('SELECT COALESCE(MAX(rowid),0) AS cursor FROM step_handoffs WHERE project_id=? AND node_key=?', [projectId, nodeId])[0].cursor);
    const objectId = crypto.randomUUID(); const now = Date.now();
    const sources: StepMemorySourceReference[] = this.rows('SELECT * FROM step_memory_sources WHERE project_id=? AND node_key=? ORDER BY source_key', [projectId, nodeId]).map(row => ({ key: String(row.source_key), objectId: String(row.object_id), revision: 1, sha256: String(row.source_hash), entryCount: Number(row.entry_count), format: row.format as 'json' | 'md' }));
    const sameMetadata = current?.content_id === contentId;
    const metadataObjectId = sameMetadata ? String(current.metadata_object_id) : objectId;
    const snapshot = { nodeId, revision, ...(sameMetadata ? { dataRef: { objectId: metadataObjectId, revision: 1 } } : { data: data || {} }), handoffCursor: cursor, sources,
      ...(current ? { previousRef: { objectId: String(current.object_id), revision: 1 } } : {}),
      ...(sourceObjectId ? { latestHandoffRef: { objectId: sourceObjectId, revision: this.readMetadata(sourceObjectId).revision } } : {}) };
    this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [objectId, 'evidence', projectId, 1, now, now]);
    this.db.run('INSERT INTO evidence(id,project_id,type,source_actor_id,content_id,observed_at,source_revision) VALUES(?,?,?,?,?,?,?)', [objectId, projectId, 'step_memory', this.actorId, this.putContent(canonical(snapshot), 'application/json'), now, revision]);
    const evidence = { objectId };
    this.db.run('INSERT INTO project_step_memory VALUES(?,?,?,?) ON CONFLICT(project_id,node_key) DO UPDATE SET content_id=excluded.content_id,revision=excluded.revision', [projectId, nodeId, contentId, revision]);
    if (!sameMetadata) this.db.run('INSERT INTO project_step_memory_state VALUES(?,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1', [projectId]);
    this.db.run('INSERT INTO project_step_memory_revisions VALUES(?,?,?,?,?,?,?,?)', [projectId, nodeId, revision, contentId, cursor, evidence.objectId, metadataObjectId, this.putContent(canonical(sources), 'application/json')]);
    if (sourceObjectId) this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [evidence.objectId, 'source', sourceObjectId]);
    if (current) this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [evidence.objectId, 'previous', current.object_id]);
    if (sameMetadata) this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [evidence.objectId, 'metadata', metadataObjectId]);
    for (const source of sources) this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [evidence.objectId, 'source', source.objectId]);
    return this.current(evidence.objectId);
  }
  public writeStepMemory(projectId: string, input: { nodeId: string; expectedRevision: number; patch: Record<string, unknown>; origin?: 'default' | 'user'; idempotencyKey: string }): { revision: number; objectId: string; data: Record<string, unknown>; receipt: WriteReceipt } {
    if (!input.nodeId || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) throw new Error('invalid_step_memory');
    if (Object.prototype.hasOwnProperty.call(input.patch, 'entries')) throw new Error('step_handoff_requires_settlement');
    if (Object.values(input.patch).some(value => value === undefined)) throw new Error('invalid_step_memory');
    if (input.origin !== undefined && !['default', 'user'].includes(input.origin)) throw new Error('invalid_step_memory_origin');
    const { expectedRevision: _expectedRevision, ...intent } = input;
    const receipt = this.recordMutation({ operation: 'write_step_memory', projectId, input: intent }, input.idempotencyKey, 'step_memory', () => {
      const current = this.readStepMemory(projectId, input.nodeId, { includeEntries: false });
      if ((current?.revision || 0) !== input.expectedRevision) throw new Error('revision_conflict');
      for (const field of Object.keys(input.patch)) this.db.run("INSERT INTO step_memory_field_origins VALUES(?,?,?,?,NULL,NULL) ON CONFLICT(project_id,node_key,field) DO UPDATE SET origin=excluded.origin,source_key=NULL,source_hash=NULL", [projectId, input.nodeId, field, input.origin || 'user']);
      return this.saveStepMemoryRevision(projectId, input.nodeId, { ...current?.data, ...input.patch });
    });
    const snapshot = JSON.parse(String(this.read(receipt.objectId, receipt.revision).data.content)) as { revision: number };
    const saved = this.readStepMemory(projectId, input.nodeId, { revision: snapshot.revision, includeEntries: false })!;
    return { revision: saved.revision, objectId: receipt.objectId, data: saved.data, receipt };
  }
  public readStepMemory(projectId: string, nodeId: string, input: { revision?: number; includeEntries?: boolean } = {}): { revision: number; objectId: string; data: Record<string, unknown>; sources: StepMemorySourceReference[] } | null {
    if (input.revision !== undefined && (!Number.isInteger(input.revision) || input.revision < 1)) throw new Error('invalid_step_memory_revision');
    const row = this.rows(`SELECT r.* FROM project_step_memory_revisions r JOIN project_step_memory c USING(project_id,node_key) WHERE r.project_id=? AND r.node_key=? AND r.revision=${input.revision === undefined ? 'c.revision' : '?'}`, [projectId, nodeId, ...(input.revision === undefined ? [] : [input.revision])])[0];
    if (!row) { if (input.revision !== undefined) throw new Error('revision_not_found'); return null; }
    const data = JSON.parse(this.content(String(row.content_id)).toString('utf8'));
    const sources: StepMemorySourceReference[] = JSON.parse(this.content(String(row.source_refs_content_id)).toString('utf8'));
    if (input.includeEntries === false) return { revision: Number(row.revision), objectId: String(row.object_id), data, sources };
    const legacyEntries = sources.flatMap(source => parseStepMemorySource(String(this.read(source.objectId, source.revision).data.content), source.format).entries);
    const entries = this.rows('SELECT run_id,turn_id,checkpoint_sequence,content_id FROM step_handoffs WHERE project_id=? AND node_key=? AND rowid<=? ORDER BY rowid', [projectId, nodeId, row.handoff_cursor]).map(entry => ({ ...JSON.parse(this.content(String(entry.content_id)).toString('utf8')), sourceRunId: String(entry.run_id), sourceTurnId: String(entry.turn_id), sourceCheckpointSequence: Number(entry.checkpoint_sequence) }));
    return { revision: Number(row.revision), objectId: String(row.object_id), data: { ...data, entries: [...legacyEntries, ...entries] }, sources };
  }
  public importStepMemorySource(projectId: string, input: { nodeId: string; source: ImportedSource; bytes: Buffer; format: 'json' | 'md' }): { unchanged: boolean } {
    const { nodeId, source, bytes, format } = input;
    if (!nodeId || !source.key || !source.identity || source.hash !== digest(bytes) || !['json', 'md'].includes(format)) throw new Error('step_memory_source_invalid');
    return this.transaction(() => {
      const existing = this.rows('SELECT * FROM step_memory_sources WHERE project_id=? AND node_key=? AND source_key=?', [projectId, nodeId, source.key])[0];
      if (existing?.source_hash === source.hash) {
        this.db.run("UPDATE migration_items SET source_hash=?,object_id=?,imported_revision=1,stage='imported',error=NULL WHERE source_identity=? AND source_key=? AND (stage<>'imported' OR source_hash<>?)", [source.hash, existing.object_id, source.identity, source.key, source.hash]);
        return { unchanged: true };
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed = parseStepMemorySource(text, format);
      const descriptor = { projectId, nodeId, source, format };
      const key = `step-memory-source:${canonical([projectId, nodeId, source.key, existing?.object_id || null, source.hash])}`;
      const sourceReceipt = this.recordMutation(descriptor, key, 'step_memory_source', () => {
        const id = crypto.randomUUID(); const now = Date.now();
        this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [id, 'evidence', projectId, 1, now, now]);
        this.db.run('INSERT INTO evidence(id,project_id,type,source_actor_id,content_id,observed_at) VALUES(?,?,?,?,?,?)', [id, projectId, 'step_memory_source', this.actorId, this.putContent(bytes, format === 'json' ? 'application/json' : 'text/markdown', 'utf8'), now]);
        return this.current(id);
      });
      this.db.run('INSERT INTO step_memory_sources VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,node_key,source_key) DO UPDATE SET object_id=excluded.object_id,source_hash=excluded.source_hash,entry_count=excluded.entry_count,format=excluded.format', [projectId, nodeId, source.key, sourceReceipt.objectId, source.hash, parsed.entries.length, format]);
      const current = this.readStepMemory(projectId, nodeId, { includeEntries: false });
      const data = { ...current?.data };
      const owned = this.rows("SELECT field FROM step_memory_field_origins WHERE project_id=? AND node_key=? AND origin='import' AND source_key=?", [projectId, nodeId, source.key]);
      for (const previous of owned) if (!Object.prototype.hasOwnProperty.call(parsed.metadata, String(previous.field))) {
        delete data[String(previous.field)];
        this.db.run('DELETE FROM step_memory_field_origins WHERE project_id=? AND node_key=? AND field=?', [projectId, nodeId, previous.field]);
      }
      for (const [field, value] of Object.entries(parsed.metadata)) {
        const origin = this.rows('SELECT * FROM step_memory_field_origins WHERE project_id=? AND node_key=? AND field=?', [projectId, nodeId, field])[0];
        if (origin?.origin === 'user' || (origin?.origin === 'import' && origin.source_key !== source.key) || (!origin && Object.prototype.hasOwnProperty.call(data, field))) continue;
        Object.defineProperty(data, field, { value, enumerable: true, writable: true, configurable: true });
        this.db.run("INSERT INTO step_memory_field_origins VALUES(?,?,?,'import',?,?) ON CONFLICT(project_id,node_key,field) DO UPDATE SET origin='import',source_key=excluded.source_key,source_hash=excluded.source_hash", [projectId, nodeId, field, source.key, source.hash]);
      }
      this.recordMutation(descriptor, `${key}:projection`, 'step_memory', () => this.saveStepMemoryRevision(projectId, nodeId, data));
      this.db.run("UPDATE migration_items SET source_hash=?,object_id=?,imported_revision=?,stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [source.hash, sourceReceipt.objectId, sourceReceipt.revision, source.identity, source.key]);
      return { unchanged: false };
    });
  }
  private createNotificationEvidence(type: string, data: Record<string, unknown>): DataObject {
    const id = crypto.randomUUID(); const now = Date.now();
    this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [id, 'evidence', null, 1, now, now]);
    this.db.run('INSERT INTO evidence(id,project_id,type,source_actor_id,content_id,observed_at) VALUES(?,?,?,?,?,?)', [id, null, type, this.actorId, this.putContent(canonical(data), 'application/json'), now]);
    return this.current(id);
  }
  private notificationDelivery(row: Record<string, SqlValue>): Record<string, unknown> {
    return { id: String(row.id), intentId: String(row.intent_id), channel: String(row.channel), objectId: String(row.object_id), messageHash: String(row.message_hash), revision: Number(row.revision), state: String(row.state), payload: JSON.parse(this.content(String(row.payload_content_id)).toString('utf8')), response: row.response_content_id ? JSON.parse(this.content(String(row.response_content_id)).toString('utf8')) : null, error: String(row.error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }
  private validateNotificationPayload(payload: Record<string, unknown>): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['replyGeneration', 'chatId', 'text', 'parseMode'].includes(key)) || !Number.isInteger(payload.replyGeneration) || Number(payload.replyGeneration) < 0 || typeof payload.chatId !== 'string' || !payload.chatId || typeof payload.text !== 'string' || !payload.text || (payload.parseMode !== undefined && payload.parseMode !== 'HTML')) throw new Error('invalid_notification_payload');
  }
  public readNotification(intentId: string): Record<string, unknown> | null {
    const row = this.rows('SELECT * FROM notification_deliveries WHERE intent_id=?', [intentId])[0];
    return row ? this.notificationDelivery(row) : null;
  }
  public enqueueNotification(input: { channel: string; intentId: string; payload: Record<string, unknown>; idempotencyKey: string }): Record<string, unknown> {
    if (input.channel !== 'telegram' || !input.intentId) throw new Error('invalid_notification');
    this.validateNotificationPayload(input.payload);
    const intent = { channel: input.channel, intentId: input.intentId, payload: input.payload };
    const receipt = this.recordMutation({ operation: 'enqueue_notification', ...intent }, input.idempotencyKey, 'notification', () => {
      const existing = this.rows('SELECT * FROM notification_deliveries WHERE intent_id=?', [input.intentId])[0];
      if (existing) {
        if (String(existing.original_hash) !== digest(canonical(intent))) throw new Error('notification_identity_conflict');
        return this.current(String(existing.object_id));
      }
      const evidence = this.createNotificationEvidence('notification', intent);
      const id = crypto.randomUUID(); const now = Date.now();
      this.db.run('INSERT INTO notification_deliveries(id,intent_id,channel,object_id,original_hash,message_hash,payload_content_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [id, input.intentId, input.channel, evidence.objectId, digest(canonical(intent)), digest(canonical({ parseMode: input.payload.parseMode || '', text: input.payload.text })), this.putContent(canonical(input.payload), 'application/json'), 'queued', now, now]);
      return evidence;
    });
    return { ...this.readNotification(input.intentId)!, receipt };
  }
  public listNotificationDeliveries(input: { channel: string; cursor?: { createdAt: number; id: string }; limit?: number }): { items: Array<Record<string, unknown>>; nextCursor: { createdAt: number; id: string } | null } {
    const limit = input.limit ?? 100;
    if (input.channel !== 'telegram' || !Number.isInteger(limit) || limit < 1 || limit > 1000 || (input.cursor && (!Number.isInteger(input.cursor.createdAt) || !input.cursor.id))) throw new Error('invalid_notification_list');
    const rows = this.rows(`SELECT * FROM notification_deliveries WHERE channel=? AND state='queued'${input.cursor ? ' AND (created_at,id)>(?,?)' : ''} ORDER BY created_at,id LIMIT ?`, [input.channel, ...(input.cursor ? [input.cursor.createdAt, input.cursor.id] : []), limit + 1]);
    const page = rows.slice(0, limit);
    return { items: page.map(row => this.notificationDelivery(row)), nextCursor: rows.length > limit ? { createdAt: Number(page[page.length - 1].created_at), id: String(page[page.length - 1].id) } : null };
  }
  public settleNotificationDelivery(input: { id: string; expectedRevision: number; state: string; payload?: Record<string, unknown>; response?: unknown; error?: string; idempotencyKey: string }): Record<string, unknown> {
    if (!input.id || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1 || !['queued', 'delivered', 'cancelled', 'failed'].includes(input.state)) throw new Error('invalid_notification_settlement');
    if (input.payload) this.validateNotificationPayload(input.payload);
    const { expectedRevision: _expectedRevision, idempotencyKey, ...intent } = input;
    const receipt = this.recordMutation({ operation: 'settle_notification_delivery', ...intent }, idempotencyKey, 'notification_delivery', () => {
      const current = this.rows('SELECT * FROM notification_deliveries WHERE id=?', [input.id])[0];
      if (!current) throw new Error('notification_missing');
      if (Number(current.revision) !== input.expectedRevision) throw new Error('revision_conflict');
      if (current.state !== 'queued') throw new Error('notification_already_settled');
      const payload = input.payload || JSON.parse(this.content(String(current.payload_content_id)).toString('utf8'));
      const previous = JSON.parse(this.content(String(current.payload_content_id)).toString('utf8'));
      if (payload.chatId !== previous.chatId || payload.replyGeneration !== previous.replyGeneration) throw new Error('notification_binding_immutable');
      this.db.run('UPDATE notification_deliveries SET state=?,revision=revision+1,payload_content_id=?,response_content_id=?,error=?,updated_at=? WHERE id=?', [input.state, this.putContent(canonical(payload), 'application/json'), input.response === undefined ? null : this.putContent(canonical(input.response), 'application/json'), input.error || '', Date.now(), input.id]);
      return this.createNotificationEvidence('notification_delivery', this.notificationDelivery(this.rows('SELECT * FROM notification_deliveries WHERE id=?', [input.id])[0]));
    });
    return { ...JSON.parse(String(this.read(receipt.objectId, receipt.revision).data.content)), receipt };
  }
  public appendAutomationEvent(projectId: string, input: { event: Record<string, unknown>; idempotencyKey: string }): { receipt: WriteReceipt; replayed: boolean } {
    if (!input.event || typeof input.event !== 'object' || Array.isArray(input.event)) throw new Error('invalid_automation_event');
    const replayed = this.rows('SELECT 1 FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, input.idempotencyKey]).length > 0;
    const receipt = this.recordMutation({ operation: 'append_automation_event', projectId, event: input.event }, input.idempotencyKey, 'automation', () => {
      const id = crypto.randomUUID(); const now = Date.now();
      this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [id, 'evidence', projectId, 1, now, now]);
      this.db.run('INSERT INTO evidence(id,project_id,type,source_actor_id,content_id,observed_at) VALUES(?,?,?,?,?,?)', [id, projectId, 'automation_event', this.actorId, this.putContent(canonical(input.event), 'application/json'), now]);
      return this.current(id);
    });
    return { receipt, replayed };
  }
  private automationDelivery(row: Record<string, SqlValue>, metadataOnly = false): Record<string, unknown> {
    if (metadataOnly) return { id: String(row.id), projectId: String(row.project_id), intentId: String(row.intent_id), objectId: String(row.object_id), kind: String(row.kind), state: String(row.state), revision: Number(row.revision), payload: { kind: String(row.kind) }, event: { trigger: String(row.event_trigger), action: String(row.event_action) }, error: String(row.error) };
    const { delivery, ...event } = JSON.parse(this.content(String(row.payload_content_id)).toString('utf8'));
    return { id: String(row.id), projectId: String(row.project_id), intentId: String(row.intent_id), objectId: String(row.object_id), kind: String(row.kind), state: String(row.state), revision: Number(row.revision), payload: delivery.payload, event, error: String(row.error) };
  }
  public prepareAutomationDelivery(projectId: string, input: { intentId: string; event: Record<string, unknown>; payload: Record<string, unknown>; metadataOnly?: boolean }): Record<string, unknown> {
    const payload = input.payload;
    if (!input.intentId || !input.event || typeof input.event !== 'object' || Array.isArray(input.event) || !payload || typeof payload !== 'object' || Array.isArray(payload) || !['notification', 'sound'].includes(String(payload.kind)) || Object.keys(payload).some(key => !['kind', 'message', 'warning'].includes(key)) || (payload.kind === 'notification' && (typeof payload.message !== 'string' || !payload.message || typeof payload.warning !== 'boolean'))) throw new Error('invalid_automation_delivery');
    return this.transaction(() => {
      const current = this.rows('SELECT * FROM automation_deliveries WHERE project_id=? AND intent_id=?', [projectId, input.intentId])[0];
      if (current) {
        if (current.kind !== payload.kind || current.event_trigger !== String(input.event.trigger || '') || current.event_action !== String(input.event.action || '')) throw new Error('automation_delivery_identity_conflict');
        return this.automationDelivery(current, input.metadataOnly);
      }
      this.recordMutation({ operation: 'prepare_automation_delivery', projectId, input }, `automation-delivery:${projectId}:${input.intentId}`, 'automation_delivery', () => {
        const id = crypto.randomUUID(); const objectId = crypto.randomUUID(); const now = Date.now();
        const contentId = this.putContent(canonical({ ...input.event, delivery: { intentId: input.intentId, payload } }), 'application/json');
        this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [objectId, 'evidence', projectId, 1, now, now]);
        this.db.run('INSERT INTO evidence(id,project_id,type,source_actor_id,content_id,observed_at) VALUES(?,?,?,?,?,?)', [objectId, projectId, 'automation_event', this.actorId, contentId, now]);
        this.db.run("INSERT INTO automation_deliveries(id,project_id,intent_id,object_id,kind,event_trigger,event_action,payload_content_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'queued',?,?)", [id, projectId, input.intentId, objectId, String(payload.kind), String(input.event.trigger || ''), String(input.event.action || ''), contentId, now, now]);
        return this.current(objectId);
      });
      return this.automationDelivery(this.rows('SELECT * FROM automation_deliveries WHERE project_id=? AND intent_id=?', [projectId, input.intentId])[0], input.metadataOnly);
    });
  }
  public listAutomationDeliveries(input: { cursor?: { createdAt: number; id: string }; limit?: number }): { items: Record<string, unknown>[]; nextCursor: { createdAt: number; id: string } | null } {
    const limit = input.limit ?? 100; const cursor = input.cursor;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (cursor && (!Number.isFinite(cursor.createdAt) || typeof cursor.id !== 'string'))) throw new Error('invalid_automation_delivery_page');
    const rows = this.rows("SELECT id,project_id,kind,event_trigger,state,created_at FROM automation_deliveries WHERE state IN ('queued','claimed')" + (cursor ? ' AND (created_at>? OR (created_at=? AND id>?))' : '') + ' ORDER BY created_at,id LIMIT ?', [...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []), limit + 1]);
    const page = rows.slice(0, limit);
    return { items: page.map(row => ({ id: String(row.id), projectId: String(row.project_id), kind: String(row.kind), trigger: String(row.event_trigger), state: String(row.state) })), nextCursor: rows.length > limit ? { createdAt: Number(page.at(-1)!.created_at), id: String(page.at(-1)!.id) } : null };
  }
  public claimAutomationDelivery(input: { id: string; owner: { id: string; pid: number; birth: string }; token: string }): Record<string, unknown> | null {
    if (!input.owner?.id || !Number.isInteger(input.owner.pid) || input.owner.pid < 1 || !input.owner.birth || !input.token) throw new Error('invalid_automation_delivery_owner');
    return this.transaction(() => {
      const row = this.rows('SELECT * FROM automation_deliveries WHERE id=?', [input.id])[0];
      if (!row) throw new Error('automation_delivery_missing');
      const registered = this.rows('SELECT owner_id,active FROM automation_ui_owners WHERE pid=? AND birth=?', [input.owner.pid, input.owner.birth])[0];
      if (registered && (registered.owner_id !== input.owner.id || !registered.active)) throw new Error('automation_ui_owner_obsolete');
      if (row.state === 'delivered' || row.state === 'cancelled') return null;
      if (row.state === 'claimed') {
        if (row.owner_id === input.owner.id && row.owner_pid === input.owner.pid && row.owner_birth === input.owner.birth) return { ...this.automationDelivery(row), token: String(row.claim_token) };
        if (this.hasLiveRunProcess({ process_pid: row.owner_pid, process_birth: row.owner_birth })) return null;
      }
      if (this.rows('SELECT 1 FROM automation_delivery_receipts WHERE delivery_id=? AND claim_token=? LIMIT 1', [input.id, input.token]).length) throw new Error('automation_delivery_token_reused');
      const now = Date.now();
      this.db.run("UPDATE automation_deliveries SET state='claimed',revision=revision+1,owner_id=?,owner_pid=?,owner_birth=?,claim_token=?,claimed_at=?,updated_at=? WHERE id=?", [input.owner.id, input.owner.pid, input.owner.birth, input.token, now, now, input.id]);
      return { ...this.automationDelivery(this.rows('SELECT * FROM automation_deliveries WHERE id=?', [input.id])[0]), token: input.token };
    });
  }
  public settleAutomationDelivery(input: { id: string; token: string; state: 'queued' | 'delivered' | 'cancelled'; error?: string }): Record<string, unknown> {
    if (!input.id || !input.token || !['queued', 'delivered', 'cancelled'].includes(input.state)) throw new Error('invalid_automation_delivery_settlement');
    return this.transaction(() => {
      const previous = this.rows('SELECT content_id FROM automation_delivery_receipts WHERE delivery_id=? AND claim_token=? AND state=?', [input.id, input.token, input.state])[0];
      if (previous) return JSON.parse(this.content(String(previous.content_id)).toString('utf8'));
      const current = this.rows('SELECT * FROM automation_deliveries WHERE id=?', [input.id])[0];
      if (!current || current.state !== 'claimed' || current.claim_token !== input.token) throw new Error('automation_delivery_lease_lost');
      this.db.run('UPDATE automation_deliveries SET state=?,revision=revision+1,error=?,updated_at=? WHERE id=?', [input.state, input.error || '', Date.now(), input.id]);
      const result = { id: input.id, state: input.state, revision: Number(current.revision) + 1, error: input.error || '' };
      const contentId = this.putContent(canonical(result), 'application/json');
      this.db.run('INSERT INTO automation_delivery_receipts VALUES(?,?,?,?)', [input.id, input.token, input.state, contentId]);
      return result;
    });
  }
  public prepareAutomationDeliveries(projectId: string, input: { deliveries: Array<{ intentId: string; event: Record<string, unknown>; payload: Record<string, unknown> }>; metadataOnly?: boolean }): Record<string, unknown>[] {
    if (!Array.isArray(input.deliveries) || !input.deliveries.length) throw new Error('invalid_automation_deliveries');
    return this.transaction(() => input.deliveries.map(delivery => this.prepareAutomationDelivery(projectId, { ...delivery, ...(input.metadataOnly === undefined ? {} : { metadataOnly: input.metadataOnly }) })));
  }
  public registerAutomationUiOwner(input: { owner: { id: string; pid: number; birth: string }; release?: boolean }): { registered: boolean } {
    const owner = input.owner;
    if (!owner?.id || !Number.isInteger(owner.pid) || owner.pid < 1 || !owner.birth) throw new Error('invalid_automation_delivery_owner');
    const release = Boolean(input.release);
    const receipt = this.recordMutation({ operation: 'register_automation_ui_owner', owner, release }, `automation-ui-owner:${owner.id}:${release ? 'release' : 'register'}`, 'automation_ui_owner', () => {
      const previous = this.rows('SELECT owner_id,active FROM automation_ui_owners WHERE pid=? AND birth=?', [owner.pid, owner.birth])[0];
      if (release && previous && previous.owner_id !== owner.id) return this.createNotificationEvidence('automation_ui_owner', { registered: false });
      if (!release && previous?.owner_id === owner.id && !previous.active) throw new Error('automation_ui_owner_obsolete');
      if (previous && (previous.owner_id !== owner.id || release)) {
        this.db.run("UPDATE automation_deliveries SET state='queued',revision=revision+1,owner_id=NULL,owner_pid=NULL,owner_birth=NULL,claim_token=NULL,claimed_at=NULL,updated_at=? WHERE state='claimed' AND owner_id=? AND owner_pid=? AND owner_birth=?", [Date.now(), previous.owner_id, owner.pid, owner.birth]);
      }
      this.db.run('INSERT INTO automation_ui_owners VALUES(?,?,?,?) ON CONFLICT(pid,birth) DO UPDATE SET owner_id=excluded.owner_id,active=excluded.active', [owner.pid, owner.birth, owner.id, release ? 0 : 1]);
      return this.createNotificationEvidence('automation_ui_owner', { registered: !release });
    });
    return JSON.parse(String(this.read(receipt.objectId, receipt.revision).data.content));
  }
  public readDocumentationManifest(projectId: string): DocumentationManifest {
    const row = this.rows("SELECT evidence.content_id FROM evidence JOIN objects ON objects.id=evidence.id WHERE evidence.project_id=? AND evidence.type='documentation_manifest' ORDER BY objects.updated_at DESC,objects.rowid DESC LIMIT 1", [projectId])[0];
    return row ? JSON.parse(this.content(String(row.content_id)).toString('utf8')) : { schemaVersion: 1, updatedAt: '', documents: [], pendingReview: [] };
  }
  private writeDocumentationManifest(projectId: string, manifest: DocumentationManifest, runId: string, sourceRevision: number, idempotencyKey: string): void {
    if (!manifest || !Array.isArray(manifest.documents) || !Array.isArray(manifest.pendingReview)) throw new Error('invalid_documentation_manifest');
    const current = this.readDocumentationManifest(projectId);
    const documents = new Map(current.documents.map(document => [document.path, document]));
    for (const document of manifest.documents) {
      const previous = documents.get(document.path);
      if (!previous || Date.parse(document.lastTouchedAt || manifest.updatedAt) >= Date.parse(previous.lastTouchedAt || current.updatedAt)) documents.set(document.path, document);
    }
    const reviews = new Map([...current.pendingReview, ...manifest.pendingReview].map(review => [`${review.path}\n${review.reason}`, review]));
    manifest = { ...manifest, documents: [...documents.values()], pendingReview: [...reviews.values()] };
    for (let index = 0; index < manifest.documents.length; index++) {
      const value = manifest.documents[index];
      if (!value.path || path.isAbsolute(value.path) || value.path.split(/[\\/]/).includes('..')) throw new Error('invalid_documentation_path');
      const existingBinding = this.rows("SELECT id FROM file_bindings WHERE project_id=? AND role='documentation' AND relative_path=?", [projectId, value.path])[0];
      const bindingId = existingBinding ? String(existingBinding.id) : this.write({ kind: 'file_binding', action: 'create', scope: projectId, data: { role: 'documentation', relative_path: value.path }, idempotencyKey: `${idempotencyKey}:binding:${index}` }).objectId;
      const existing = this.rows('SELECT id FROM documents WHERE project_id=? AND file_binding_id=?', [projectId, bindingId])[0];
      const data = { file_binding_id: bindingId, role: value.role, status: value.status, solves: value.solves || '', last_reviewed_at: Number.isFinite(Date.parse(value.lastReviewedAt || '')) ? Date.parse(value.lastReviewedAt!) : null };
      this.write({ kind: 'document', action: existing ? 'patch' : 'create', scope: projectId, ...(existing ? { objectId: String(existing.id), expectedRevision: this.readMetadata(String(existing.id)).revision } : {}), data, idempotencyKey: `${idempotencyKey}:document:${index}` });
    }
    this.write({ kind: 'evidence', action: 'create', scope: projectId, data: { run_id: runId, type: 'documentation_manifest', source_actor_id: this.actorId, content: canonical(manifest), observed_at: Date.now(), source_revision: sourceRevision }, idempotencyKey });
  }
  public patchRunState(projectId: string, input: { executionLogId: number; generation: number; expectedRevision: number; patch: Record<string, unknown>; idempotencyKey: string }): RunState {
    const initial = this.runControl(projectId, input.executionLogId);
    if (initial.generation !== input.generation) throw new Error('run_owner_conflict');
    const immutable = ['turnId', 'executionLogId', 'journalExecutionLogId', 'rootExecutionLogId', 'nodeId', 'workspaceRoot', 'learningTaskId', 'checkpointSequence', 'checkpointToken', 'deliveryPending', 'deliveryOwnerId', 'deliveryOwnerPid', 'deliveryOwnerBirth', 'hostOutputPending', 'hostOutputFinalizedAt', 'hostOutputSource', 'nativeOutputPending', 'nativeReplyObjectId', 'nativeReplyRevision', 'nativeTokenUsage', 'nativeWorkspaceObservationObjectId', 'nativeWorkspaceObservationRevision', 'workspaceEvidenceBoundary', 'workspaceSnapshotObjectId', 'workspaceSnapshotRevision', 'workspaceAfterObjectId', 'workspaceAfterRevision', 'workspaceChangesObjectId', 'workspaceChangesRevision', 'workspaceEvidenceSource', 'workspaceObservedAt', 'workspaceAfterGitHash', 'taskReportObjectId', 'taskReportRevision', 'taskReportStatus', 'taskReportError', 'roadmapBackupObjectId', 'roadmapBackupRevision', 'turnLogStartOffsets', 'turnLogEndOffsets', 'gitEvidenceObjectId', 'gitEvidenceRevision', 'sourceParentRunId', 'sourceParentTurnId'];
    if (!input.patch || Object.keys(input.patch).some(key => immutable.includes(key) || input.patch[key] === undefined)) throw new Error('invalid_run_patch');
    const receipt = this.recordMutation({ operation: 'patch_run_state', projectId, input }, input.idempotencyKey, 'state', () => {
      const row = this.runControl(projectId, input.executionLogId);
      if (row.revision !== input.expectedRevision) throw new Error('revision_conflict');
      const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8')) as Record<string, unknown>;
      const patch = { ...input.patch };
      if (metadata.interactiveSessionClosed === true && (
        ['Preparing', 'Running', 'Waiting', 'Turn Started'].includes(String(patch.status || ''))
        || (Object.prototype.hasOwnProperty.call(patch, 'interactiveSessionClosed') && patch.interactiveSessionClosed !== true)
        || (Object.prototype.hasOwnProperty.call(patch, 'finishedAt') && (patch.finishedAt === '' || patch.finishedAt === null))
      )) throw new Error('session_already_closed');
      for (const [key, column] of [['agentPid', 'process_pid'], ['processBirth', 'process_birth'], ['agentChildPid', 'child_pid'], ['processChildBirth', 'child_birth']] as const) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        const isPid = key === 'agentPid' || key === 'agentChildPid';
        const value = isPid ? Number(patch[key] || 0) : String(patch[key] || '');
        if (isPid && (!Number.isInteger(value) || Number(value) < 0)) throw new Error('invalid_run_pid');
        this.db.run(`UPDATE run_control SET ${column}=? WHERE run_id=?`, [value, row.run_id]);
        delete patch[key];
      }
      for (const [key, column] of [['status', 'status'], ['startedAt', 'started_at'], ['finishedAt', 'finished_at']] as const) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        const value = key === 'status' ? String(patch[key]) : patch[key] === '' || patch[key] === null ? null : Date.parse(String(patch[key]));
        if (value !== null && typeof value === 'number' && !Number.isFinite(value)) throw new Error('invalid_run_time');
        this.db.run(`UPDATE runs SET ${column}=? WHERE id=?`, [value, row.run_id]);
        delete patch[key];
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'exitCode')) {
        if (patch.exitCode !== null && (!Number.isInteger(patch.exitCode) || Number(patch.exitCode) < 0)) throw new Error('invalid_run_exit_code');
        this.db.run('UPDATE runs SET exit_code=? WHERE id=?', [patch.exitCode as number | null, row.run_id]);
        delete patch.exitCode;
      }
      this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putContent(canonical({ ...metadata, ...patch }), 'application/json'), row.run_id]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
      this.saveRunControlRevision(String(row.run_id));
      return this.current(String(row.run_id), false);
    }, undefined, false);
    return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
  }
  public patchRunTurnRequest(projectId: string, input: { executionLogId: number; generation: number; expectedRevision: number; turnId: string; message: string; idempotencyKey: string }): RunState {
    const initial = this.runControl(projectId, input.executionLogId);
    if (initial.generation !== input.generation) throw new Error('run_owner_conflict');
    if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('checkpoint_message_required');
    const { expectedRevision: _expectedRevision, ...intent } = input;
    const receipt = this.recordMutation({ operation: 'patch_run_turn_request', projectId, input: intent }, input.idempotencyKey, 'request', () => {
      const row = this.runControl(projectId, input.executionLogId);
      if (row.revision !== input.expectedRevision) throw new Error('revision_conflict');
      if (row.current_turn_id !== input.turnId) throw new Error('checkpoint_turn_conflict');
      const turn = this.current(input.turnId, false);
      if (turn.data.finished_at !== null) throw new Error('turn_already_settled');
      this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: input.turnId, expectedRevision: turn.revision, data: { request_content: input.message }, idempotencyKey: `${input.idempotencyKey}:turn` });
      const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
      Object.assign(metadata, { userMessage: input.message, checkpointMessage: input.message });
      const journal = this.readRunTurnJournal(projectId, input.executionLogId, input.turnId);
      this.updateProjectJournal(projectId, journal.executionLogId, { ...journal.entry, output: [journal.entry.output, `User message:\n${input.message}`].filter(Boolean).join('\n\n') });
      this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putContent(canonical(metadata), 'application/json'), row.run_id]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
      this.saveRunControlRevision(String(row.run_id));
      return this.current(String(row.run_id), false);
    }, undefined, false);
    return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
  }
  public claimRunDelivery(projectId: string, input: { executionLogId: number; generation: number; expectedRevision: number; owner: { id: string; pid: number; birth: string }; idempotencyKey: string }): RunState {
    if (!input.owner?.id || !Number.isInteger(input.owner.pid) || input.owner.pid < 1 || typeof input.owner.birth !== 'string') throw new Error('invalid_run_delivery_owner');
    const initial = this.runControl(projectId, input.executionLogId);
    if (initial.generation !== input.generation) throw new Error('run_owner_conflict');
    const receipt = this.recordMutation({ operation: 'claim_run_delivery', projectId, input }, input.idempotencyKey, 'delivery', () => {
      const row = this.runControl(projectId, input.executionLogId);
      if (row.revision !== input.expectedRevision) throw new Error('revision_conflict');
      if (!this.runFlowLaunchAllowed(projectId, String(row.run_id))) throw new Error('flow_not_running');
      if (JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8')).stopRequested) throw new Error('run_stop_requested');
      if (!row.delivery_pending || row.finished_at !== null || this.hasLiveRunProcess(row)) throw new Error('run_already_delivered');
      if (row.delivery_owner_id !== input.owner.id && this.runDeliveryOwnerAlive(projectId, input.executionLogId)) throw new Error('run_delivery_owner_alive');
      this.db.run('UPDATE run_control SET delivery_owner_id=?,delivery_pid=?,delivery_birth=? WHERE run_id=?', [input.owner.id, input.owner.pid, input.owner.birth, row.run_id]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
      this.saveRunControlRevision(String(row.run_id));
      return this.current(String(row.run_id), false);
    }, undefined, false);
    return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
  }
  public listRunDeliveries(input: { projectId?: string; cursor?: number; limit?: number }): { items: RunState[]; nextCursor: number | null } {
    const limit = input.limit ?? 100; let cursor = input.cursor ?? 0;
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('invalid_run_delivery_page');
    const items: RunState[] = []; let lastEligible = cursor;
    for (;;) {
      const rows = this.rows(`SELECT run_control.rowid AS cursor,run_control.*,runs.finished_at FROM run_control JOIN runs ON runs.id=run_control.run_id WHERE run_control.delivery_pending=1 AND runs.finished_at IS NULL AND run_control.rowid>?${input.projectId ? ' AND run_control.project_id=?' : ''} ORDER BY run_control.rowid LIMIT 100`, [cursor, ...(input.projectId ? [input.projectId] : [])]);
      for (const row of rows) {
        cursor = Number(row.cursor);
        if (this.hasLiveRunProcess(row) || this.hasLiveRunProcess({ process_pid: row.delivery_pid, process_birth: row.delivery_birth })) continue;
        const state = this.readRunState(String(row.project_id), Number(row.execution_log_id));
        if (state.status.stopRequested || state.status.interactiveSessionClosed || !this.runFlowLaunchAllowed(String(row.project_id), String(row.run_id))) continue;
        if (items.length === limit) return { items, nextCursor: lastEligible };
        items.push(state); lastEligible = cursor;
      }
      if (rows.length < 100) return { items, nextCursor: null };
    }
  }
  public releaseRunDelivery(projectId: string, input: { executionLogId: number; generation: number; owner: { id: string; pid: number; birth: string }; error: string; idempotencyKey: string }): RunState {
    const initial = this.runControl(projectId, input.executionLogId);
    if (initial.generation !== input.generation) throw new Error('run_owner_conflict');
    const receipt = this.recordMutation({ operation: 'release_run_delivery', projectId, input }, input.idempotencyKey, 'delivery_release', () => {
      const row = this.runControl(projectId, input.executionLogId);
      if (!row.delivery_pending || row.finished_at !== null || this.hasLiveRunProcess(row)) throw new Error('run_already_delivered');
      if (!input.owner || row.delivery_owner_id !== input.owner.id || row.delivery_pid !== input.owner.pid || row.delivery_birth !== input.owner.birth) throw new Error('run_delivery_lease_lost');
      const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
      metadata.deliveryLastError = String(input.error || '');
      this.db.run("UPDATE run_control SET delivery_owner_id='',delivery_pid=0,delivery_birth='',metadata_content_id=? WHERE run_id=?", [this.putContent(canonical(metadata), 'application/json'), row.run_id]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
      this.saveRunControlRevision(String(row.run_id));
      return this.current(String(row.run_id), false);
    }, undefined, false);
    return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
  }
  public claimRun(projectId: string, input: { executionLogId: number; expectedRevision: number; agentPid?: number; processBirth?: string; terminalDeliveryId?: string; idempotencyKey: string }): RunState {
    if (input.agentPid !== undefined && (!Number.isInteger(input.agentPid) || input.agentPid < 1)) throw new Error('invalid_run_pid');
    const receipt = this.recordMutation({ operation: 'claim_run', projectId, input }, input.idempotencyKey, 'claim', () => {
      const row = this.runControl(projectId, input.executionLogId);
      if (!this.runFlowLaunchAllowed(projectId, String(row.run_id))) throw new Error('flow_not_running');
      if (row.revision !== input.expectedRevision) throw new Error('revision_conflict');
      const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
      if (metadata.stopRequested) throw new Error('run_stop_requested');
      if (input.terminalDeliveryId && input.terminalDeliveryId !== metadata.terminalDeliveryId) throw new Error('run_delivery_identity_changed');
      if (row.finished_at !== null) throw new Error('run_already_finished');
      if (this.hasLiveRunProcess(row)) throw new Error('run_owner_alive');
      this.db.run('UPDATE run_control SET generation=generation+1,recovery_needed=1,delivery_pending=0 WHERE run_id=?', [row.run_id]);
      this.db.run('UPDATE run_control SET child_pid=NULL,child_birth=NULL WHERE run_id=?', [row.run_id]);
      metadata.terminalClaimDeliveryId = input.terminalDeliveryId || '';
      this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putContent(canonical(metadata), 'application/json'), row.run_id]);
      if (input.agentPid !== undefined) this.db.run('UPDATE run_control SET process_pid=?,process_birth=? WHERE run_id=?', [input.agentPid, input.processBirth || '', row.run_id]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
      this.saveRunControlRevision(String(row.run_id));
      return this.current(String(row.run_id), false);
    }, undefined, false);
    const state = this.readRunState(projectId, input.executionLogId, receipt.revision);
    return { ...state, receipt, proof: this.runProof(state.runId, state.generation) };
  }
  public requestRunStop(projectId: string, input: { executionLogId: number; generation: number; expectedRevision: number; expectedTurnId: string; reason: string; idempotencyKey: string; requireVerifiedIdentity?: boolean; outcome?: 'partial' }): RunState {
    if (!input.expectedTurnId || !String(input.reason || '').trim()) throw new Error('invalid_run_stop');
    const initial = this.runControl(projectId, input.executionLogId);
    if (initial.generation !== input.generation) throw new Error('run_owner_conflict');
    const { expectedRevision: _expectedRevision, ...intent } = input;
    const receipt = this.recordMutation({ operation: 'request_run_stop', projectId, input: intent }, input.idempotencyKey, 'stop', () => {
      const row = this.runControl(projectId, input.executionLogId);
      if (row.revision !== input.expectedRevision) throw new Error('revision_conflict');
      if (row.current_turn_id !== input.expectedTurnId) throw new Error('checkpoint_turn_conflict');
      const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
      this.db.run('UPDATE run_control SET metadata_content_id=?,delivery_pending=0,recovery_needed=1 WHERE run_id=?', [this.putContent(canonical({ ...metadata, stopRequested: true, stopReason: input.reason, stopRequestKey: input.idempotencyKey, stopRequestedAt: new Date().toISOString(), stopRequestIntent: intent, ...(input.requireVerifiedIdentity ? { stopRequireVerifiedIdentity: true } : {}) }), 'application/json'), row.run_id]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
      this.saveRunControlRevision(String(row.run_id));
      return this.current(String(row.run_id), false);
    }, undefined, false);
    return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
  }
  public readRunBinding(projectId: string, executionLogId: number, revision?: number): NativeSessionBinding | null {
    let row = this.runControl(projectId, executionLogId);
    if (revision !== undefined && revision !== row.revision) {
      const historical = this.rows('SELECT binding_content_id FROM run_control_revisions WHERE run_id=? AND revision=?', [row.run_id, revision])[0];
      if (!historical) throw new Error('revision_missing');
      row = { ...row, ...historical };
    }
    if (!row.binding_content_id) return null;
    let value: unknown;
    try { value = JSON.parse(this.content(String(row.binding_content_id)).toString('utf8')); }
    catch { value = null; }
    return assertVersion2Binding(value, String(row.run_id));
  }
  public writeRunBinding(projectId: string, input: { executionLogId: number; generation: number; expectedHeadRevision: number; seed?: SessionBindingSeed; revision?: SessionBindingRevisionInput; confirmSessionId?: string; evidence?: Record<string, unknown>; idempotencyKey: string }): NativeSessionBinding {
    const initial = this.runControl(projectId, input.executionLogId);
    if (initial.generation !== input.generation) throw new Error('run_owner_conflict');
    const receipt = this.recordMutation({ operation: 'write_run_binding', projectId, input }, input.idempotencyKey, 'binding', () => {
      const row = this.runControl(projectId, input.executionLogId);
      const previous = this.readRunBinding(projectId, input.executionLogId);
      if ((previous?.headRevision || 0) !== input.expectedHeadRevision) throw new Error('identity_index_conflict');
      const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8')) as Record<string, unknown>;
      let next: NativeSessionBinding;
      try { if (!previous) {
        if (!input.seed || Number(input.seed.runId) !== input.executionLogId) throw new Error('identity_binding_invalid');
        if (path.resolve(input.seed.workspaceRoot) !== path.resolve(String(metadata.workspaceRoot))) throw new Error('identity_workspace_mismatch');
        next = createSessionBindingValue(input.seed);
      } else if (input.confirmSessionId) next = confirmSessionBindingValue(previous, input.expectedHeadRevision, input.confirmSessionId, new Date().toISOString(), input.evidence);
      else {
        if (!input.revision) throw new Error('identity_binding_invalid');
        next = appendSessionBindingValue(previous, input.expectedHeadRevision, input.revision);
      } } catch (error) {
        const coded = error as Error & { code?: string };
        if (coded.code) throw Object.assign(new Error(`${coded.code}: ${coded.message}`), { code: coded.code });
        throw error;
      }
      const head = next.revisions[next.headRevision - 1];
      const bindingRevision = Number(this.rows('SELECT COALESCE(MAX(binding_revision),0)+1 AS next FROM session_bindings WHERE conversation_id=?', [row.conversation_id])[0].next);
      const evidenceId = this.write({ kind: 'evidence', action: 'create', scope: projectId, idempotencyKey: `${input.idempotencyKey}:evidence`, data: { run_id: String(row.run_id), type: 'session_binding', source_actor_id: this.actorId, content: next, observed_at: Date.now(), source_revision: next.headRevision } }).objectId;
      this.db.run('INSERT INTO session_bindings VALUES(?,?,?,?,?,?,?,?)', [row.conversation_id, bindingRevision, next.provider, head.sessionId || null, head.state, head.contract, evidenceId, head.providerContext ? this.putContent(canonical(head.providerContext), 'application/json') : null]);
      const resumable = head.state === 'confirmed' && next.resumableRevision === next.headRevision && Boolean(head.sessionId);
      Object.assign(metadata, { sessionProvider: next.provider, sessionBindingHeadRevision: next.headRevision, nativeSessionId: resumable ? String(head.sessionId) : '', nativeSessionIdIsCurrent: resumable });
      this.db.run('UPDATE run_control SET binding_content_id=?,metadata_content_id=? WHERE run_id=?', [this.putContent(canonical(next), 'application/json'), this.putContent(canonical(metadata), 'application/json'), row.run_id]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
      this.saveRunControlRevision(String(row.run_id));
      return this.current(String(row.run_id), false);
    }, undefined, false);
    const history = this.rows('SELECT binding_content_id FROM run_control_revisions WHERE run_id=? AND revision=?', [receipt.objectId, receipt.revision])[0];
    return JSON.parse(this.content(String(history.binding_content_id)).toString('utf8'));
  }
  public submitRunReport(projectId: string, input: { executionLogId: number; generation: number; turnId: string; report: unknown; availability: string; validationError?: string; idempotencyKey: string }): WriteReceipt & { availability: string } {
    const row = this.runControl(projectId, input.executionLogId);
    if (row.generation !== input.generation) throw new Error('run_owner_conflict');
    if (!input.turnId) throw new Error('report_turn_required');
    if (!this.rows("SELECT 1 AS allowed FROM relations WHERE source_id=? AND relation='source' AND target_id=?", [row.run_id, input.turnId]).length || this.readMetadata(input.turnId).kind !== 'turn') throw new Error('report_turn_denied');
    const receipt = this.recordMutation({ operation: 'submit_run_report', projectId, executionLogId: input.executionLogId, generation: input.generation, turnId: input.turnId, report: input.report, availability: input.availability, validationError: input.validationError || '' }, input.idempotencyKey, 'submit', () => this.createRunReport(projectId, String(row.run_id), input.turnId, input));
    return { ...receipt, availability: String(this.current(receipt.objectId, false).data.availability) };
  }
  private createRunReport(projectId: string, runId: string, turnId: string, input: { report: unknown; availability: string; validationError?: string }): DataObject {
    const id = crypto.randomUUID(); const now = Date.now();
    this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [id, 'report', projectId, 1, now, now]);
    this.db.run('INSERT INTO reports(id,project_id,turn_id,run_id,schema_version,content_id,availability,validation_error) VALUES(?,?,?,?,?,?,?,?)', [id, projectId, turnId, runId, 1, this.putContent(canonical(input.report), 'application/json'), input.availability, input.validationError || null]);
    return this.current(id);
  }
  public appendRunLog(projectId: string, input: RunLogInput): { requestId: string; committedSequence: number; nextSequence: number; totalBytes: number } {
    const run = this.runControl(projectId, input.executionLogId);
    if (run.generation !== input.generation) throw new Error('run_owner_conflict');
    if (input.stream === 'output') throw new Error('reserved_log_stream');
    if (!input.stream || !Number.isInteger(input.sequence) || input.sequence < 0 || !Number.isInteger(input.offset) || input.offset < 0 || !input.idempotencyKey) throw new Error('invalid_log_chunk');
    const bytes = Buffer.from(input.bytes, 'base64');
    if (!bytes.length || bytes.toString('base64') !== input.bytes) throw new Error('invalid_log_bytes');
    const inputHash = digest(canonical({ operation: 'append_run_log', projectId, input }));
    return this.transaction(() => {
      const previous = this.rows('SELECT input_hash,result_content_id FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, input.idempotencyKey])[0];
      if (previous) {
        if (previous.input_hash !== inputHash) throw new Error('idempotency_conflict');
        return JSON.parse(this.content(String(previous.result_content_id)).toString('utf8'));
      }
      const last = this.rows('SELECT sequence,byte_offset,byte_length FROM log_chunks JOIN contents ON contents.id=log_chunks.content_id WHERE run_id=? AND stream=? ORDER BY sequence DESC LIMIT 1', [run.run_id, input.stream])[0];
      const sequence = last ? Number(last.sequence) + 1 : 0;
      const offset = last ? Number(last.byte_offset) + Number(last.byte_length) : 0;
      if (input.sequence !== sequence || input.offset !== offset) throw new Error('log_sequence_conflict');
      const requestId = crypto.randomUUID();
      const now = Date.now();
      this.db.run('INSERT INTO requests(actor_id,idempotency_key,id,input_hash,status) VALUES(?,?,?,?,?)', [this.actorId, input.idempotencyKey, requestId, inputHash, 'pending']);
      const contentId = this.putContent(bytes, 'application/octet-stream', 'binary');
      this.db.run('INSERT INTO log_chunks VALUES(?,?,?,?,?,?)', [run.run_id, input.stream, sequence, contentId, now, offset]);
      if (input.stream === 'stdout' || input.stream === 'stderr') {
        const output = this.readRunLogHead(projectId, input.executionLogId, 'output');
        this.db.run('INSERT INTO log_chunks VALUES(?,?,?,?,?,?)', [run.run_id, 'output', output.nextSequence, contentId, now, output.totalBytes]);
      }
      const committedSequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM events')[0].next);
      const descriptor = this.putContent(canonical({ stream: input.stream, sequence, offset, byteLength: bytes.length, sha256: digest(bytes) }), 'application/json');
      this.db.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', [crypto.randomUUID(), committedSequence, run.run_id, this.actorId, 'run.log_appended', descriptor, now, requestId]);
      const result = { requestId, committedSequence, nextSequence: sequence + 1, totalBytes: offset + bytes.length };
      this.db.run("UPDATE requests SET status='committed',committed_sequence=?,result_content_id=? WHERE id=?", [committedSequence, this.putContent(canonical(result), 'application/json'), requestId]);
      return result;
    });
  }
  public readRunLog(projectId: string, input: { executionLogId: number; stream: string; offset?: number; limit?: number }): { bytes: string; offset: number; totalBytes: number; nextOffset: number | null } {
    const run = this.runControl(projectId, input.executionLogId);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 65536;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1048576) throw new Error('invalid_log_page');
    const last = this.rows('SELECT byte_offset,byte_length FROM log_chunks JOIN contents ON contents.id=log_chunks.content_id WHERE run_id=? AND stream=? ORDER BY sequence DESC LIMIT 1', [run.run_id, input.stream])[0];
    const totalBytes = last ? Number(last.byte_offset) + Number(last.byte_length) : 0;
    if (offset > totalBytes) throw new Error('invalid_log_offset');
    const end = Math.min(totalBytes, offset + limit);
    const parts = this.rows('SELECT content_id,byte_offset FROM log_chunks JOIN contents ON contents.id=log_chunks.content_id WHERE run_id=? AND stream=? AND byte_offset<? AND byte_offset+byte_length>? ORDER BY sequence', [run.run_id, input.stream, end, offset])
      .map(row => { const bytes = this.content(String(row.content_id)); return bytes.subarray(Math.max(0, offset - Number(row.byte_offset)), Math.min(bytes.length, end - Number(row.byte_offset))); });
    return { bytes: Buffer.concat(parts).toString('base64'), offset, totalBytes, nextOffset: end < totalBytes ? end : null };
  }
  public readRunLogHead(projectId: string, executionLogId: number, stream: string): { nextSequence: number; totalBytes: number } {
    const run = this.runControl(projectId, executionLogId);
    const last = this.rows('SELECT sequence,byte_offset,byte_length FROM log_chunks JOIN contents ON contents.id=log_chunks.content_id WHERE run_id=? AND stream=? ORDER BY sequence DESC LIMIT 1', [run.run_id, stream])[0];
    return { nextSequence: last ? Number(last.sequence) + 1 : 0, totalBytes: last ? Number(last.byte_offset) + Number(last.byte_length) : 0 };
  }
  public reserveRunInputMaterialization(projectId: string, executionLogId: number, generation: number): { path: string; sha256: string; size: number } {
    return this.transaction(() => {
      const run = this.runControl(projectId, executionLogId);
      if (run.generation !== generation) throw new Error('run_owner_conflict');
      const existing = this.rows('SELECT path,sha256,size,state FROM run_input_materializations WHERE run_id=? AND generation=?', [run.run_id, generation])[0];
      if (existing) {
        if (existing.state !== 'active') throw new Error('run_input_released');
        return { path: String(existing.path), sha256: String(existing.sha256), size: Number(existing.size) };
      }
      const bytes = Buffer.from(this.readRunExecutionPlan(projectId, executionLogId).prompt);
      const entry = { path: path.join(this.root, 'tmp', `run-input-${run.run_id}-${generation}-${crypto.randomUUID()}.txt`), sha256: digest(bytes), size: bytes.length };
      const evidence = this.writeRunDocument(projectId, { executionLogId, generation, purpose: `temporary_input_${generation}`, bytes: Buffer.from(canonical(entry)).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: `run:${run.run_id}:${generation}:temporary-input` });
      this.db.run("INSERT INTO run_input_materializations VALUES(?,?,?,?,?,?,?,?,0,'active')", [run.run_id, projectId, generation, entry.path, entry.sha256, entry.size, evidence.objectId, this.putContent(bytes)]);
      return entry;
    });
  }
  public listRunInputMaterializations(cursor = 0): { items: Array<{ projectId: string; executionLogId: number; generation: number; path: string; sha256: string; size: number }>; nextCursor: number | null } {
    const rows = this.rows("SELECT m.rowid AS cursor,m.*,c.execution_log_id FROM run_input_materializations m JOIN run_control c ON c.run_id=m.run_id WHERE m.state='active' AND m.rowid>? ORDER BY m.rowid LIMIT 100", [cursor]);
    return { items: rows.map(row => ({ projectId: String(row.project_id), executionLogId: Number(row.execution_log_id), generation: Number(row.generation), path: String(row.path), sha256: String(row.sha256), size: Number(row.size) })), nextCursor: rows.length === 100 ? Number(rows.at(-1)!.cursor) : null };
  }
  public releaseRunInputMaterialization(projectId: string, executionLogId: number, generation: number): void {
    const run = this.runControl(projectId, executionLogId);
    this.db.run("UPDATE run_input_materializations SET state='released' WHERE run_id=? AND generation=?", [run.run_id, generation]);
  }
  public readRunInputMaterialization(projectId: string, executionLogId: number, generation: number): { path: string; sha256: string; size: number; written: boolean } | null {
    const run = this.runControl(projectId, executionLogId);
    const row = this.rows("SELECT path,sha256,size,written FROM run_input_materializations WHERE run_id=? AND generation=? AND state='active'", [run.run_id, generation])[0];
    return row ? { path: String(row.path), sha256: String(row.sha256), size: Number(row.size), written: Boolean(row.written) } : null;
  }
  public readRunInputMaterializationBytes(projectId: string, executionLogId: number, generation: number): Buffer {
    const run = this.runControl(projectId, executionLogId);
    const row = this.rows('SELECT input_content_id FROM run_input_materializations WHERE run_id=? AND generation=?', [run.run_id, generation])[0];
    if (!row) throw new Error('run_input_missing');
    return this.content(String(row.input_content_id));
  }
  public markRunInputWritten(projectId: string, executionLogId: number, generation: number): void {
    const run = this.runControl(projectId, executionLogId);
    if (run.generation !== generation) throw new Error('run_owner_conflict');
    this.db.run('UPDATE run_input_materializations SET written=1 WHERE run_id=? AND generation=?', [run.run_id, generation]);
  }
  public writeRunDocument(projectId: string, input: { executionLogId: number; generation: number; turnId?: string; purpose: string; bytes: string; mimeType: string; expectedRevision: number; idempotencyKey: string }): WriteReceipt {
    const run = this.runControl(projectId, input.executionLogId);
    if (input.generation !== run.generation) throw new Error('run_owner_conflict');
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.purpose) || !input.mimeType || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('invalid_run_document');
    if (typeof input.bytes !== 'string') throw new Error('invalid_run_document_bytes');
    const bytes = Buffer.from(input.bytes, 'base64');
    if (bytes.toString('base64') !== input.bytes) throw new Error('invalid_run_document_bytes');
    if (input.turnId && !this.rows('SELECT 1 FROM relations WHERE source_id=? AND relation=? AND target_id=?', [run.run_id, 'source', input.turnId]).length) throw new Error('run_turn_conflict');
    const receipt = this.recordMutation({ operation: 'write_run_document', projectId, executionLogId: input.executionLogId, generation: input.generation, ...(input.turnId ? { turnId: input.turnId } : {}), purpose: input.purpose, mimeType: input.mimeType, sha256: digest(bytes) }, input.idempotencyKey, 'document', () => {
      const existing = this.rows('SELECT object_id FROM run_documents WHERE run_id=? AND purpose=?', [run.run_id, input.purpose])[0];
      const now = Date.now(); let id: string;
      const contentId = this.putContent(bytes, input.mimeType, 'binary');
      if (existing) {
        id = String(existing.object_id);
        const object = this.current(id, false);
        if (object.revision !== input.expectedRevision) throw new Error('revision_conflict');
        this.db.run('UPDATE evidence SET content_id=?,observed_at=? WHERE id=?', [contentId, now, id]);
        this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [now, id]);
      } else {
        if (input.expectedRevision !== 0) throw new Error('revision_conflict');
        id = crypto.randomUUID();
        this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [id, 'evidence', projectId, 1, now, now]);
        this.db.run('INSERT INTO evidence(id,project_id,run_id,type,source_actor_id,content_id,observed_at) VALUES(?,?,?,?,?,?,?)', [id, projectId, run.run_id, `run_document:${input.purpose}`, this.actorId, contentId, now]);
        this.db.run('INSERT INTO run_documents VALUES(?,?,?)', [run.run_id, input.purpose, id]);
        this.db.run('INSERT INTO relations VALUES(?,?,?)', [run.run_id, 'source', id]);
      }
      if (input.turnId) this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [id, 'source', input.turnId]);
      return this.current(id, false);
    });
    return receipt;
  }
  public readRunDocument(projectId: string, executionLogId: number, purpose: string, revision?: number): { objectId: string; revision: number; bytes: string; hash: string; mimeType: string } | null {
    const run = this.runControl(projectId, executionLogId);
    const row = this.rows('SELECT object_id FROM run_documents WHERE run_id=? AND purpose=?', [run.run_id, purpose])[0];
    if (!row) return null;
    const object = this.readMetadata(String(row.object_id), revision);
    const contentId = String(object.data.content_id);
    const content = this.rows('SELECT sha256,mime_type FROM contents WHERE id=?', [contentId])[0];
    return { objectId: object.objectId, revision: object.revision, bytes: this.content(contentId).toString('base64'), hash: String(content.sha256), mimeType: String(content.mime_type) };
  }
  public writeProjectGrowth(projectId: string, data: GrowthSnapshotData, idempotencyKey: string): WriteReceipt {
    if (!data?.snapshot?.id || data.snapshot.projectPath === '') throw new Error('invalid_growth_snapshot');
    const nodeIds = new Set(data.nodes.map(node => node.nodeId));
    for (const node of data.nodes) if (node.parentId && !nodeIds.has(node.parentId)) throw new Error(`growth_parent_missing:${node.parentId}`);
    for (const edge of data.edges) if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId)) throw new Error(`growth_edge_node_missing:${edge.sourceId}:${edge.targetId}`);
    for (const signal of data.signals) if (!nodeIds.has(signal.nodeId)) throw new Error(`growth_signal_node_missing:${signal.nodeId}`);
    return this.transaction(() => {
      const snapshot = data.snapshot;
      const replay = this.rows('SELECT id FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, idempotencyKey]).length > 0;
      const receipt = this.write({
        kind: 'growth_snapshot', action: 'create', scope: projectId, idempotencyKey,
        data: { git_head: snapshot.gitHead || null, reason: snapshot.scanReason, status: snapshot.status, duration_ms: snapshot.durationMs, created_at: Date.parse(snapshot.createdAt), project_path: snapshot.projectPath, error: snapshot.error || '', payload_hash: digest(canonical(data)) }
      });
      if (replay) return receipt;
      const storedSnapshotId = receipt.objectId;
      this.db.run('DELETE FROM growth_items WHERE snapshot_id=?', [storedSnapshotId]);
      try {
        const children = new Map<string, typeof data.nodes>();
        const ordered = data.nodes.filter(node => !node.parentId);
        for (const node of data.nodes) {
          if (!node.parentId) continue;
          const siblings = children.get(node.parentId) || [];
          siblings.push(node);
          children.set(node.parentId, siblings);
        }
        for (let index = 0; index < ordered.length; index++) {
          const node = ordered[index];
          ordered.push(...(children.get(node.nodeId) || []));
        }
        if (ordered.length !== data.nodes.length) throw new Error('growth_parent_cycle');
        for (const node of ordered) {
          this.db.run('INSERT INTO growth_items VALUES(?,?,?,?,?,?,?,?,?,?,?)', [storedSnapshotId, node.nodeId, node.parentId || null, node.kind, node.path, node.label, canonical({ ...node, snapshotId: storedSnapshotId }), node.fileCount - node.testFileCount, node.testFileCount, null, node.bytes]);
        }
      }
      catch (error) { throw new Error(`growth_items_write:${String(error)}`); }
      this.db.run('DELETE FROM growth_edges WHERE snapshot_id=?', [storedSnapshotId]);
      try { for (const edge of data.edges) this.db.run('INSERT INTO growth_edges(snapshot_id,source_item_id,target_item_id,kind,weight,evidence_id,evidence) VALUES(?,?,?,?,?,NULL,?)', [storedSnapshotId, edge.sourceId, edge.targetId, edge.kind, edge.weight, edge.evidence || '']); }
      catch (error) { throw new Error(`growth_edges_write:${String(error)}`); }
      this.db.run('DELETE FROM growth_signals WHERE snapshot_id=?', [storedSnapshotId]);
      try { data.signals.forEach((signal, index) => this.db.run('INSERT INTO growth_signals(snapshot_id,signal_key,item_id,type,level,value,evidence_id,source,source_ref,created_at) VALUES(?,?,?,?,?,?,NULL,?,?,?)', [storedSnapshotId, `${signal.nodeId}:${signal.type}:${index}`, signal.nodeId, signal.type, signal.level, signal.value, signal.source, signal.sourceRef, Date.parse(signal.createdAt)])); }
      catch (error) { throw new Error(`growth_signals_write:${String(error)}`); }
      this.db.run('DELETE FROM growth_module_labels WHERE snapshot_id=?', [storedSnapshotId]);
      try { for (const label of data.labels) this.db.run('INSERT INTO growth_module_labels VALUES(?,?,?,?,?,?,?)', [storedSnapshotId, label.nodeId, label.label, label.role, label.source, label.confidence, Date.parse(label.updatedAt)]); }
      catch (error) { throw new Error(`growth_labels_write:${String(error)}`); }
      return receipt;
    });
  }
  public readProjectGrowth(projectId: string, historyLimit = 12): { latest: GrowthSnapshotData | null; history: GrowthSnapshotData[] } {
    const ids = this.rows('SELECT id FROM growth_snapshots WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?', [projectId, Math.max(1, Math.min(50, historyLimit))]).map(row => String(row.id));
    const read = (id: string): GrowthSnapshotData => {
      const row = this.rows('SELECT * FROM growth_snapshots WHERE id=? AND project_id=?', [id, projectId])[0];
      if (!row) throw new Error('growth_snapshot_missing');
      const snapshot: GrowthSnapshotRecord = { id, createdAt: new Date(Number(row.created_at)).toISOString(), projectPath: String(row.project_path), gitHead: String(row.git_head || ''), scanReason: String(row.reason), status: String(row.status), durationMs: Number(row.duration_ms || 0), error: String(row.error || '') };
      const nodes = this.rows('SELECT metrics_json FROM growth_items WHERE snapshot_id=? ORDER BY rowid', [id]).map(item => JSON.parse(String(item.metrics_json)));
      const edges = this.rows('SELECT source_item_id,target_item_id,kind,weight,evidence FROM growth_edges WHERE snapshot_id=? ORDER BY rowid', [id]).map(edge => ({ snapshotId: id, sourceId: String(edge.source_item_id), targetId: String(edge.target_item_id), kind: String(edge.kind), weight: Number(edge.weight || 0), evidence: String(edge.evidence || '') }));
      const signals = this.rows('SELECT item_id,type,level,value,source,source_ref,created_at FROM growth_signals WHERE snapshot_id=? ORDER BY rowid', [id]).map(signal => ({ snapshotId: id, nodeId: String(signal.item_id), type: String(signal.type), level: String(signal.level), value: String(signal.value || ''), source: String(signal.source), sourceRef: String(signal.source_ref), createdAt: new Date(Number(signal.created_at)).toISOString() }));
      const labels = this.rows('SELECT node_id,label,role,source,confidence,updated_at FROM growth_module_labels WHERE snapshot_id=? ORDER BY rowid', [id]).map(label => ({ snapshotId: id, nodeId: String(label.node_id), label: String(label.label), role: String(label.role), source: String(label.source), confidence: Number(label.confidence), updatedAt: new Date(Number(label.updated_at)).toISOString() }));
      return { snapshot, nodes, edges, signals, labels } as GrowthSnapshotData;
    };
    const history = ids.map(read);
    return { latest: history[0] || null, history };
  }
  public importRegisteredReportTask(projectId: string, source: ImportedSource, bytes: Uint8Array, task: { taskId: string; userMessage: string; startedAt: string; executions: Array<{ id: number; nodeId: string }> }): string {
    return this.transaction(() => {
      this.captureMigrationSource(source, bytes);
      const previous = this.rows('SELECT * FROM legacy_report_tasks WHERE project_id=? AND legacy_task_id=?', [projectId, task.taskId])[0];
      if (previous && (previous.source_identity !== source.identity || previous.source_key !== source.key)) throw new Error('legacy_task_source_conflict');
      const conversationId = previous ? String(this.readMetadata(String(previous.task_id)).data.conversation_id)
        : this.write({ kind: 'conversation', action: 'create', scope: projectId, idempotencyKey: `legacy-report-conversation:${canonical(source)}`, data: { mode: 'legacy', status: 'historical', title: task.userMessage } }).objectId;
      const imported = this.importObject({ kind: 'task', action: 'create', scope: projectId, idempotencyKey: `legacy-report-task:${canonical(source)}`, data: { conversation_id: conversationId, original_request_content: task.userMessage, status: 'historical' } }, source);
      const taskId = imported.receipt?.objectId || String(previous.task_id);
      const executions = new Map<number, { id: number; nodeId: string }>((previous ? JSON.parse(String(previous.executions_json)) : []).map((run: { id: number; nodeId: string }) => [run.id, run]));
      for (const run of task.executions) {
        if (executions.has(run.id) && executions.get(run.id)!.nodeId !== run.nodeId) throw new Error('legacy_task_execution_conflict');
        executions.set(run.id, run);
      }
      const executionsJson = canonical([...executions.values()].sort((a, b) => a.id - b.id));
      const startedAt = Number.isFinite(Date.parse(task.startedAt)) ? task.startedAt : '';
      const titlePreview = task.userMessage.slice(0, 120);
      if (!previous || previous.started_at !== startedAt || previous.title_preview !== titlePreview || previous.executions_json !== executionsJson) {
        this.db.run('INSERT INTO legacy_report_tasks VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,legacy_task_id) DO UPDATE SET started_at=excluded.started_at,title_preview=excluded.title_preview,executions_json=excluded.executions_json', [projectId, task.taskId, taskId, source.identity, source.key, startedAt, titlePreview, executionsJson]);
        this.bumpReportSourceRevision(projectId);
      }
      return taskId;
    });
  }
  public importRegisteredReport(projectId: string, taskId: string, observation: { executionLogId: number; sequence: number; availability: string; envelope: any }, source: ImportedSource, bytes: Uint8Array): void {
    this.transaction(() => {
      this.captureMigrationSource(source, bytes);
      const registration = this.rows('SELECT executions_json FROM legacy_report_tasks WHERE project_id=? AND task_id=?', [projectId, taskId])[0];
      if (!registration || !JSON.parse(String(registration.executions_json)).some((run: any) => run.id === observation.executionLogId)) throw new Error('legacy_report_execution_denied');
      let turnId = this.rows('SELECT turn_id FROM legacy_report_turns WHERE project_id=? AND task_id=? AND execution_log_id=? AND legacy_sequence=?', [projectId, taskId, observation.executionLogId, observation.sequence])[0]?.turn_id;
      if (!turnId) {
        const next = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM turns WHERE task_id=?', [taskId])[0].n);
        turnId = this.write({ kind: 'turn', action: 'create', scope: projectId, idempotencyKey: `legacy-report-turn:${canonical([projectId, taskId, observation.executionLogId, observation.sequence])}`, data: { task_id: taskId, sequence: next, request_content: null, started_at: null } }).objectId;
        this.db.run('INSERT INTO legacy_report_turns VALUES(?,?,?,?,?)', [projectId, taskId, observation.executionLogId, observation.sequence, turnId]);
      }
      const bound = this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
      if (bound?.object_id && this.readMetadata(String(bound.object_id)).data.turn_id !== turnId) throw new Error('legacy_report_source_conflict');
      const imported = this.importObject({ kind: 'report', action: 'create', scope: projectId, idempotencyKey: `legacy-report:${canonical(source)}`, data: { turn_id: String(turnId), run_id: null, schema_version: 1,
        content: observation.envelope?.report ?? 'null', availability: observation.availability, validation_error: observation.availability === 'invalid' ? 'legacy_report_invalid' : null } }, source);
      if (imported.receipt) {
        const captured = this.rows('SELECT source_content_id,source_capture_revision FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
        const sourceTime = String(observation.envelope?.createdAt || '');
        this.db.run('INSERT INTO report_version_sources VALUES(?,?,?,?,?,?,?,?)', [imported.receipt.objectId, imported.receipt.revision, source.identity, source.key, source.hash, captured.source_content_id, captured.source_capture_revision, Number.isFinite(Date.parse(sourceTime)) ? sourceTime : '']);
      }
    });
  }

  /** Only the bounded, captured legacy importer calls this; it is not an Agent operation. */
  public adoptHistoricalRun(projectId: string, locationId: string, source: ImportedSource, input: { status: Record<string, unknown>; binding: NativeSessionBinding | null; prompt: string; command: string; output: Buffer; outputSource?: ImportedSource; nativeTranscript?: { source: ImportedSource; bytes: Buffer }; legacyCompletion?: { source: ImportedSource; bytes: Buffer }; workspaceBefore?: Buffer; changes?: Buffer; roadmapBackup?: Buffer; registeredTaskAlias?: string; unregisteredTaskAlias?: string; unregisteredReports?: Array<{ source: ImportedSource; bytes: Buffer; observation: { executionLogId: number; sequence: number; availability: string; envelope: any } }> }): { unchanged: boolean; state: RunState } {
    return this.transaction(() => {
      const status = input.status, executionLogId = Number(status.rootExecutionLogId || status.executionLogId), nodeId = String(status.nodeId || '');
      const captured = this.readMigrationSource(source.identity, source.key);
      if (captured.hash !== source.hash || canonical(JSON.parse(captured.bytes.toString('utf8'))) !== canonical(status)) throw new Error('historical_run_source_changed');
      let registration = this.rows('SELECT * FROM legacy_report_tasks WHERE project_id=? AND legacy_task_id=?', [projectId, String(status.learningTaskId || input.unregisteredTaskAlias || input.registeredTaskAlias || '')])[0];
      if (input.unregisteredReports !== undefined) {
        if (typeof status.userMessage !== 'string' || !status.userMessage.trim()) throw new Error('historical_run_task_source_missing');
        if (!registration && !status.learningTaskId) registration = this.rows('SELECT * FROM legacy_report_tasks WHERE project_id=? AND source_identity=? AND source_key=?', [projectId, source.identity, source.key])[0];
        if (!registration) {
          const conversationId = this.write({ kind: 'conversation', action: 'create', scope: projectId, idempotencyKey: `historical-status-conversation:${canonical([projectId, source])}`, data: { mode: 'legacy', status: 'historical', title: status.userMessage } }).objectId;
          const taskId = this.write({ kind: 'task', action: 'create', scope: projectId, idempotencyKey: `historical-status-task:${canonical([projectId, source])}`, data: { conversation_id: conversationId, original_request_content: status.userMessage, status: 'historical' } }).objectId;
          const alias = String(status.learningTaskId || input.unregisteredTaskAlias || `task-${taskId}`);
          if (!/^task-[a-zA-Z0-9-]+$/.test(alias)) throw new Error('historical_run_task_mismatch');
          this.db.run('INSERT INTO legacy_report_tasks VALUES(?,?,?,?,?,?,?,?)', [projectId, alias, taskId, source.identity, source.key, String(status.startedAt || ''), status.userMessage.slice(0, 120), canonical([{ id: executionLogId, nodeId }])]);
          this.bumpReportSourceRevision(projectId);
          registration = this.rows('SELECT * FROM legacy_report_tasks WHERE project_id=? AND legacy_task_id=?', [projectId, alias])[0];
        } else {
          const executions = JSON.parse(String(registration.executions_json)) as Array<{ id: number; nodeId: string }>;
          if (!executions.some(run => run.id === executionLogId)) {
            executions.push({ id: executionLogId, nodeId }); executions.sort((a, b) => a.id - b.id);
            this.db.run('UPDATE legacy_report_tasks SET executions_json=? WHERE project_id=? AND legacy_task_id=?', [canonical(executions), projectId, registration.legacy_task_id]);
            this.bumpReportSourceRevision(projectId);
            registration = { ...registration, executions_json: canonical(executions) };
          }
        }
        for (const report of input.unregisteredReports) this.importRegisteredReport(projectId, String(registration.task_id), report.observation, report.source, report.bytes);
      }
      if (!registration || !JSON.parse(String(registration.executions_json)).some((run: any) => run.id === executionLogId && run.nodeId === nodeId)) throw new Error('historical_run_task_mismatch');
      if (!Number.isSafeInteger(executionLogId) || executionLogId < 1 || Number(status.executionLogId) !== executionLogId || !nodeId || !status.runKind) throw new Error('historical_run_identity_invalid');
      const taskId = String(registration.task_id), conversationId = String(this.readMetadata(taskId).data.conversation_id);
      const location = this.rows('SELECT root_path FROM project_locations WHERE id=? AND project_id=?', [locationId, projectId])[0];
      const binding = input.binding && assertVersion2Binding(input.binding, source.key);
      const declaredWorkspace = status.workspaceRoot || binding?.workspaceRoot;
      if (!location || !declaredWorkspace || path.resolve(String(declaredWorkspace)) !== path.resolve(String(location.root_path))) throw new Error('historical_run_workspace_mismatch');
      if (binding) {
        if (binding.runId !== String(executionLogId) || path.resolve(binding.workspaceRoot) !== path.resolve(String(location.root_path)) || status.bindingNonce && binding.bindingNonce !== status.bindingNonce || status.sessionProvider && binding.provider !== status.sessionProvider) throw new Error('historical_run_binding_mismatch');
        const head = binding.revisions[binding.headRevision - 1];
        if (status.sessionBindingHeadRevision && Number(status.sessionBindingHeadRevision) !== binding.headRevision || status.nativeSessionIdIsCurrent === true && (head.state !== 'confirmed' || head.sessionId !== status.nativeSessionId || binding.resumableRevision !== binding.headRevision)) throw new Error('historical_run_session_mismatch');
      } else if (status.nativeSessionIdIsCurrent === true) throw new Error('historical_run_binding_missing');
      if (input.outputSource) {
        const outputCapture = this.readMigrationSource(input.outputSource.identity, input.outputSource.key), journal = JSON.parse(outputCapture.bytes.toString('utf8'));
        if (outputCapture.hash !== input.outputSource.hash || journal.id !== executionLogId || journal.nodeId !== nodeId || !Buffer.from(String(journal.output || '')).equals(input.output)) throw new Error('historical_run_output_source_mismatch');
      }
      if (input.nativeTranscript) {
        const nativeCapture = this.readMigrationSource(input.nativeTranscript.source.identity, input.nativeTranscript.source.key);
        if (nativeCapture.hash !== input.nativeTranscript.source.hash || !nativeCapture.bytes.equals(input.nativeTranscript.bytes)) throw new Error('historical_run_native_source_mismatch');
      }
      let legacyDecision: Record<string, unknown> = {};
      if (input.legacyCompletion) {
        const completionCapture = this.readMigrationSource(input.legacyCompletion.source.identity, input.legacyCompletion.source.key);
        if (completionCapture.hash !== input.legacyCompletion.source.hash || !completionCapture.bytes.equals(input.legacyCompletion.bytes)) throw new Error('historical_run_completion_source_changed');
        if (status.status === 'In Progress' && status.interactiveSession !== true && !status.checkpointOutcome) {
          try {
            const decision = JSON.parse(input.legacyCompletion.bytes.toString('utf8'));
            if (!decision || typeof decision !== 'object' || Array.isArray(decision) || typeof decision.markCompleted !== 'boolean' || decision.reason !== undefined && typeof decision.reason !== 'string') throw new Error('invalid_completion_decision');
            if (decision.markCompleted) legacyDecision = { checkpointOutcome: 'candidate_complete', checkpointSummary: decision.reason || '' };
          } catch {
            legacyDecision = { status: 'Failed', checkpointOutcome: 'failed', failureCode: 'completion_state_invalid', failureReason: 'Agent completion decision file could not be parsed.' };
          }
        }
      }
      const sourceIdentity = { source, status, binding, prompt: digest(input.prompt), command: digest(input.command), output: digest(input.output), ...(input.outputSource ? { outputSource: input.outputSource } : {}), ...(input.nativeTranscript ? { nativeSource: input.nativeTranscript.source } : {}), workspaceBefore: input.workspaceBefore ? digest(input.workspaceBefore) : null, changes: input.changes ? digest(input.changes) : null, roadmapBackup: input.roadmapBackup ? digest(input.roadmapBackup) : null };
      const sourceHash = digest(canonical({ ...sourceIdentity, ...(input.legacyCompletion ? { completionSource: input.legacyCompletion.source } : {}) }));
      const consumerStatus = String(legacyDecision.status || status.status);
      const needsConsumer = ['In Progress', 'Failed'].includes(consumerStatus);
      const restoreCurrentTurnTimes = (turnId: string) => {
        const turn = this.readMetadata(turnId), start = Date.parse(String(status.turnStartedAt || '')), finish = Date.parse(String(status.finishedAt || status.checkpointAt || ''));
        const data: Record<string, number> = {};
        if (Number.isFinite(start)) data.started_at = start;
        if (['Waiting', 'Processed', 'Completed', 'Failed', 'Stopped'].includes(String(status.status)) && Number.isFinite(finish)) data.finished_at = finish;
        for (const key of Object.keys(data)) {
          if (turn.data[key] === data[key]) delete data[key];
          else if (turn.data[key] !== null) throw new Error('historical_run_turn_source_conflict');
        }
        if (Object.keys(data).length) this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: turnId, expectedRevision: turn.revision, idempotencyKey: `historical-turn-times:${canonical([projectId, source, turnId, data])}`, data });
      };
      const existing = this.rows('SELECT run_id FROM run_control WHERE project_id=? AND execution_log_id=?', [projectId, executionLogId])[0];
      if (existing) {
        const state = this.readRunState(projectId, executionLogId);
        if (state.taskId !== taskId) throw new Error('historical_run_target_conflict');
        if (state.status.historicalSourceHash !== sourceHash) {
          if (!input.legacyCompletion || state.status.historicalCompletionSource || state.status.historicalSourceHash !== digest(canonical(sourceIdentity))) throw new Error('historical_run_target_conflict');
          const completion = input.legacyCompletion;
          const mayNormalize = state.revision === 1 && state.status.status === status.status;
          const receipt = this.recordMutation({ projectId, source, completionSource: completion.source }, `adopt-historical-completion:${canonical([projectId, sourceHash])}`, 'historical_adoption', () => {
            const control = this.runControl(projectId, executionLogId);
            const metadata = { ...JSON.parse(this.content(String(control.metadata_content_id)).toString('utf8')), ...(mayNormalize ? legacyDecision : {}), historicalCompletionSource: completion.source, historicalSourceHash: sourceHash };
            if (mayNormalize && legacyDecision.status) this.db.run('UPDATE runs SET status=? WHERE id=?', [String(legacyDecision.status), state.runId]);
            this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putContent(canonical(metadata), 'application/json'), state.runId]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), state.runId]);
            this.saveRunControlRevision(state.runId);
            if (mayNormalize && Object.keys(legacyDecision).length) this.db.run("INSERT INTO run_consumer_sources VALUES(?,?,?,?,?,'queued') ON CONFLICT(run_id,turn_id,checkpoint_sequence) DO UPDATE SET source_revision=excluded.source_revision WHERE run_consumer_sources.state='queued'", [state.runId, projectId, state.turnId, Number(control.checkpoint_sequence), state.revision + 1]);
            return this.current(state.runId);
          });
          this.db.run("UPDATE migration_items SET object_id=?,imported_revision=?,stage='imported',error=NULL WHERE source_identity=? AND source_key=? AND source_hash=?", [receipt.objectId, receipt.revision, completion.source.identity, completion.source.key, completion.source.hash]);
          this.markMigrationSourceImported(source.identity, source.key);
          return { unchanged: false, state: this.readRunState(projectId, executionLogId) };
        }
        const legacyTurn = this.rows('SELECT turn_id FROM legacy_report_turns WHERE project_id=? AND task_id=? AND execution_log_id=? AND legacy_sequence=?', [projectId, taskId, executionLogId, Number(status.checkpointSequence || 0)])[0];
        if (legacyTurn?.turn_id === state.turnId && Number(state.status.checkpointSequence) === Number(status.checkpointSequence || 0)) restoreCurrentTurnTimes(state.turnId);
        if (needsConsumer && state.revision === 1 && state.status.status === consumerStatus && !this.rows('SELECT 1 FROM run_consumer_sources WHERE run_id=? AND source_revision=?', [state.runId, state.revision]).length) {
          // Repair only the queue; the accepted historical run revision stays immutable.
          this.db.run("INSERT INTO run_consumer_sources VALUES(?,?,?,?,?,'queued')", [state.runId, projectId, state.turnId, Number(state.status.checkpointSequence || 0), state.revision]);
          this.markMigrationSourceImported(source.identity, source.key);
          return { unchanged: false, state };
        }
        this.markMigrationSourceImported(source.identity, source.key);
        return { unchanged: true, state };
      }
      if (this.historicalRunOwnerAlive(status)) throw new Error('historical_run_owner_alive');
      const startedAt = Date.parse(String(status.startedAt || '')), finishedAt = Date.parse(String(status.finishedAt || ''));
      const checkpointSequence = Number(status.checkpointSequence || 0);
      if (!Number.isFinite(startedAt) || !Number.isSafeInteger(checkpointSequence) || checkpointSequence < 0 || !status.status) throw new Error('historical_run_state_incomplete');
      const idempotencyKey = `adopt-historical-run:${canonical([projectId, source, sourceHash])}`;
      const receipt = this.recordMutation({ projectId, locationId, source, sourceHash }, idempotencyKey, 'historical_adoption', () => {
        const previousTurns = this.rows('SELECT legacy_sequence,turn_id FROM legacy_report_turns WHERE project_id=? AND task_id=? AND execution_log_id=? ORDER BY legacy_sequence', [projectId, taskId, executionLogId]);
        let turnId = previousTurns.find(turn => Number(turn.legacy_sequence) === checkpointSequence)?.turn_id;
        if (!turnId) {
          const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM turns WHERE task_id=?', [taskId])[0].next);
          turnId = this.write({ kind: 'turn', action: 'create', scope: projectId, idempotencyKey: `${idempotencyKey}:turn`, data: { task_id: taskId, sequence, request_content: typeof status.checkpointMessage === 'string' ? status.checkpointMessage : null, started_at: Number.isFinite(Date.parse(String(status.turnStartedAt))) ? Date.parse(String(status.turnStartedAt)) : null } }).objectId;
          this.db.run('INSERT INTO legacy_report_turns VALUES(?,?,?,?,?)', [projectId, taskId, executionLogId, checkpointSequence, turnId]);
        }
        restoreCurrentTurnTimes(String(turnId));
        const runId = crypto.randomUUID(), now = Date.now();
        this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [runId, 'run', projectId, 1, now, now]);
        this.db.run('INSERT INTO runs(id,project_id,task_id,turn_id,conversation_id,location_id,run_kind,actor_id,command_content_id,prompt_content_id,status,started_at,finished_at,exit_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [runId, projectId, taskId, turnId, conversationId, locationId, String(status.runKind), this.actorId, this.putContent(input.command), this.putContent(input.prompt), String(legacyDecision.status || status.status), startedAt, Number.isFinite(finishedAt) ? finishedAt : null, Number.isInteger(status.exitCode) ? Number(status.exitCode) : null]);
        const metadata: Record<string, unknown> = { ...status, ...legacyDecision, workspaceRoot: String(location.root_path), historicalSourceHash: sourceHash, historicalStatusSource: source, historicalAdopted: true };
        if (input.legacyCompletion) metadata.historicalCompletionSource = input.legacyCompletion.source;
        if (input.outputSource) metadata.historicalOutputSource = input.outputSource;
        if (binding?.revisions[binding.headRevision - 1]?.evidence?.source === 'legacy_session_file') Object.assign(metadata, { bindingNonce: binding.bindingNonce, sessionProvider: binding.provider, sessionBindingHeadRevision: binding.headRevision, nativeSessionId: binding.revisions[binding.headRevision - 1].sessionId, nativeSessionIdIsCurrent: true });
        if (input.nativeTranscript) Object.assign(metadata, { codexNativeCursor: input.nativeTranscript.bytes.lastIndexOf(10) + 1, historicalNativeSource: input.nativeTranscript.source });
        delete metadata.checkpointToken;
        this.db.run('INSERT INTO run_control(run_id,project_id,execution_log_id,node_key,checkpoint_sequence,current_turn_id,metadata_content_id,binding_content_id,recovery_needed) VALUES(?,?,?,?,?,?,?,?,?)', [runId, projectId, executionLogId, nodeId, checkpointSequence, turnId, this.putContent(canonical(metadata), 'application/json'), binding ? this.putContent(canonical(binding), 'application/json') : null, ['Running', 'Preparing', 'Turn Started'].includes(String(status.status)) ? 1 : 0]);
        const turnIds = new Set([...previousTurns.map(turn => String(turn.turn_id)), String(turnId)]);
        for (const oldTurn of turnIds) this.db.run('INSERT INTO relations VALUES(?,?,?)', [runId, 'source', oldTurn]);
        this.bindRunTurnJournal(projectId, runId, String(turnId), nodeId, metadata, executionLogId);
        if (input.output.length) this.db.run('INSERT INTO log_chunks VALUES(?,?,?,?,?,?)', [runId, 'output', 0, this.putContent(input.output, 'application/octet-stream', 'binary'), now, 0]);
        if (input.nativeTranscript?.bytes.length) this.db.run('INSERT INTO log_chunks VALUES(?,?,?,?,?,?)', [runId, 'native:codex', 0, this.putContent(input.nativeTranscript.bytes, 'application/x-ndjson', 'binary'), now, 0]);
        if (binding) for (const revision of binding.revisions) {
          const prefix = { ...binding, headRevision: revision.revision, revisions: binding.revisions.slice(0, revision.revision) };
          if (revision.state === 'confirmed' && revision.sessionId) prefix.resumableRevision = revision.revision; else delete prefix.resumableRevision;
          const evidenceId = this.write({ kind: 'evidence', action: 'create', scope: projectId, idempotencyKey: `${idempotencyKey}:binding:${revision.revision}`, data: { run_id: runId, type: 'session_binding', source_actor_id: this.actorId, observed_at: now, source_revision: revision.revision, content: prefix } }).objectId;
          const ordinal = Number(this.rows('SELECT COALESCE(MAX(binding_revision),0)+1 AS next FROM session_bindings WHERE conversation_id=?', [conversationId])[0].next);
          this.db.run('INSERT INTO session_bindings VALUES(?,?,?,?,?,?,?,?)', [conversationId, ordinal, binding.provider, revision.sessionId || null, revision.state, revision.contract, evidenceId, revision.providerContext ? this.putContent(canonical(revision.providerContext), 'application/json') : null]);
        }
        for (const [field, purpose, mimeType, objectKey, revisionKey] of [
          ['workspaceBefore', workspaceDocumentPurpose(String(turnId), 'before'), 'application/json', 'workspaceSnapshotObjectId', 'workspaceSnapshotRevision'],
          ['changes', workspaceDocumentPurpose(String(turnId), 'changes'), 'text/plain', 'workspaceChangesObjectId', 'workspaceChangesRevision'],
          ['roadmapBackup', 'roadmap_backup', 'text/csv', 'roadmapBackupObjectId', 'roadmapBackupRevision']
        ] as const) {
          const bytes = input[field];
          if (!bytes) continue;
          const saved = this.writeRunDocument(projectId, { executionLogId, generation: 1, turnId: String(turnId), purpose, bytes: bytes.toString('base64'), mimeType, expectedRevision: 0, idempotencyKey: `${idempotencyKey}:document:${purpose}` });
          Object.assign(metadata, { [objectKey]: saved.objectId, [revisionKey]: saved.revision });
        }
        for (const report of this.rows('SELECT id,turn_id FROM reports WHERE project_id=? AND turn_id IN (SELECT turn_id FROM legacy_report_turns WHERE project_id=? AND task_id=? AND execution_log_id=?)', [projectId, projectId, taskId, executionLogId])) {
          const old = this.readMetadata(String(report.id));
          if (old.data.run_id && old.data.run_id !== runId) throw new Error('historical_run_report_mismatch');
          const associated = this.write({ kind: 'report', action: 'patch', scope: projectId, objectId: old.objectId, expectedRevision: old.revision, idempotencyKey: `${idempotencyKey}:report:${old.objectId}`, data: { run_id: runId } });
          this.db.run('INSERT INTO report_version_sources SELECT object_id,?,source_identity,source_key,source_hash,source_content_id,source_capture_revision,source_created_at FROM report_version_sources WHERE object_id=? AND revision=?', [associated.revision, old.objectId, old.revision]);
          if (report.turn_id === turnId) Object.assign(metadata, { taskReportObjectId: associated.objectId, taskReportRevision: associated.revision, taskReportStatus: String(old.data.availability) });
        }
        this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putContent(canonical(metadata), 'application/json'), runId]);
        this.saveRunControlRevision(runId);
        if (needsConsumer) this.db.run("INSERT INTO run_consumer_sources VALUES(?,?,?,?,?,'queued')", [runId, projectId, String(turnId), checkpointSequence, 1]);
        return this.current(runId);
      });
      this.db.run("UPDATE migration_items SET source_hash=?,object_id=?,imported_revision=?,stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [source.hash, receipt.objectId, receipt.revision, source.identity, source.key]);
      if (input.legacyCompletion) this.db.run("UPDATE migration_items SET object_id=?,imported_revision=?,stage='imported',error=NULL WHERE source_identity=? AND source_key=? AND source_hash=?", [receipt.objectId, receipt.revision, input.legacyCompletion.source.identity, input.legacyCompletion.source.key, input.legacyCompletion.source.hash]);
      return { unchanged: false, state: this.readRunState(projectId, executionLogId) };
    });
  }
  private indexReportRevision(object: DataObject, recordedAt: number): void {
    const turn = this.rows('SELECT task_id FROM turns WHERE id=? AND project_id=?', [String(object.data.turn_id), object.projectId])[0];
    if (!turn) throw new Error('report_turn_denied');
    if (object.data.run_id && !this.rows("SELECT 1 FROM runs r JOIN relations l ON l.source_id=r.id AND l.relation='source' AND l.target_id=? WHERE r.id=? AND r.task_id=? AND r.project_id=?", [String(object.data.turn_id), String(object.data.run_id), turn.task_id, object.projectId]).length) throw new Error('report_run_turn_mismatch');
    let body: any = object.data.content;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    const valid = ['available', 'recorded'].includes(String(object.data.availability)) && body && typeof body.summary === 'string';
    const contentId = String(object.data.content_id);
    const metadata = { availability: valid ? 'recorded' : ['missing', 'invalid', 'save_failed'].includes(String(object.data.availability)) ? String(object.data.availability) : 'invalid',
      summary: valid ? body.summary : '', unmet: valid && Array.isArray(body.unmetRequirements) ? body.unmetRequirements.length > 0 : null,
      commits: valid && Array.isArray(body.commits) ? body.commits : [], files: valid ? reportFiles(body) : [], archived: object.archivedAt !== null };
    this.db.run('INSERT OR IGNORE INTO report_versions(object_id,revision,project_id,task_id,turn_id,run_id,content_id,sha256,metadata_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [object.objectId, object.revision, object.projectId, turn.task_id, object.data.turn_id as string, object.data.run_id as string || null, contentId,
        this.rows('SELECT sha256 FROM contents WHERE id=?', [contentId])[0].sha256, canonical(metadata), recordedAt]);
  }
  public backfillReportVersions(projectId: string, limit = 50): number {
    const marker = `report-versions-ready:${projectId}`;
    if (this.rows('SELECT 1 FROM database_meta WHERE key=?', [marker]).length) return 0;
    const missing = this.rows('SELECT v.object_id,v.revision,v.created_at FROM object_revisions v JOIN objects o ON o.id=v.object_id LEFT JOIN report_versions r ON r.object_id=v.object_id AND r.revision=v.revision WHERE o.project_id=? AND o.kind=\'report\' AND r.object_id IS NULL ORDER BY v.created_at,v.rowid LIMIT ?', [projectId, limit]);
    if (missing.length) this.transaction(() => { for (const row of missing) this.indexReportRevision(this.read(String(row.object_id), Number(row.revision)), Number(row.created_at)); });
    else this.db.run('INSERT OR IGNORE INTO database_meta VALUES(?,?)', [marker, '17']);
    return missing.length;
  }
  private bumpReportSourceRevision(projectId: string): void {
    this.db.run('INSERT INTO report_source_generations VALUES(?,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1', [projectId]);
  }
  public reportSourceRevision(projectId: string): number {
    return Number(this.rows('SELECT revision FROM report_source_generations WHERE project_id=?', [projectId])[0]?.revision || 0);
  }
  public readRegisteredReportSources(projectId: string, input: { taskId?: string; metadataOnly?: boolean } = {}): { tasks: any[]; reports: any[]; observations: any[]; runFiles: any[]; sourceRevision: number } {
    const taskId = input.taskId ? String(this.rows('SELECT task_id FROM legacy_report_tasks WHERE project_id=? AND legacy_task_id=?', [projectId, input.taskId])[0]?.task_id || input.taskId.replace(/^task-/, '')) : '';
    const taskRows = this.rows('SELECT t.id,t.original_request_content_id,substr(c.title,1,120) AS title,o.created_at,o.revision,l.legacy_task_id,l.started_at,l.title_preview,l.executions_json FROM tasks t JOIN objects o ON o.id=t.id JOIN conversations c ON c.id=t.conversation_id LEFT JOIN legacy_report_tasks l ON l.task_id=t.id WHERE t.project_id=? AND o.archived_at IS NULL' + (taskId ? ' AND t.id=?' : '') + ' ORDER BY o.created_at,t.id', [projectId, ...(taskId ? [taskId] : [])]);
    const tasks = taskRows.map(row => {
      const executions = new Map<number, { id: number; nodeId: string }>((row.executions_json ? JSON.parse(String(row.executions_json)) : []).map((run: { id: number; nodeId: string }) => [run.id, run]));
      for (const run of this.rows('SELECT j.execution_log_id,c.node_key FROM run_turn_journals j JOIN turns t ON t.id=j.turn_id LEFT JOIN run_control c ON c.run_id=j.run_id WHERE j.project_id=? AND t.task_id=? ORDER BY j.execution_log_id', [projectId, row.id])) {
        const id = Number(run.execution_log_id), nodeId = String(run.node_key || '');
        if (executions.has(id) && executions.get(id)!.nodeId !== nodeId) throw new Error('legacy_task_execution_conflict');
        executions.set(id, { id, nodeId });
      }
      return { taskId: row.legacy_task_id ? String(row.legacy_task_id) : `task-${row.id}`, userMessage: input.metadataOnly ? String(row.title_preview ?? row.title ?? '') : this.decodedContent(String(row.original_request_content_id)),
        startedAt: row.legacy_task_id ? String(row.started_at || '') : new Date(Number(row.created_at)).toISOString(), sourceRef: { objectId: String(row.id), revision: Number(row.revision) }, executions: [...executions.values()].sort((a, b) => a.id - b.id) };
    });
    const taskIds = new Map(taskRows.map(row => [String(row.id), row.legacy_task_id ? String(row.legacy_task_id) : `task-${row.id}`]));
    const versions = this.rows('SELECT v.*,e.sequence AS committed_sequence,o.archived_at AS object_archived_at,COALESCE(l.legacy_sequence,t.sequence) AS sequence,COALESCE(l.execution_log_id,j.execution_log_id) AS execution_log_id,s.source_created_at FROM report_versions v JOIN objects o ON o.id=v.object_id JOIN object_revisions r ON r.object_id=v.object_id AND r.revision=v.revision JOIN events e ON e.subject_id=r.object_id AND e.content_id=r.content_id JOIN turns t ON t.id=v.turn_id LEFT JOIN run_turn_journals j ON j.project_id=v.project_id AND j.turn_id=v.turn_id LEFT JOIN legacy_report_turns l ON l.turn_id=v.turn_id LEFT JOIN report_version_sources s ON s.object_id=v.object_id AND s.revision=v.revision WHERE v.project_id=?' + (taskId ? ' AND v.task_id=?' : '') + (input.metadataOnly ? ' AND o.archived_at IS NULL' : '') + ' ORDER BY e.sequence', [projectId, ...(taskId ? [taskId] : [])]);
    const latestReports = new Map<string, any>();
    const observations = versions.filter(row => taskIds.has(String(row.task_id))).map(row => {
      const metadata = JSON.parse(String(row.metadata_json));
      const sourceRef = { objectId: String(row.object_id), revision: Number(row.revision) };
      const value = { ...metadata, objectArchived: row.object_archived_at !== null, taskId: taskIds.get(String(row.task_id)), executionLogId: row.execution_log_id === null ? null : Number(row.execution_log_id), sequence: Number(row.sequence), turnId: String(row.turn_id),
        hash: String(row.sha256), createdAt: row.source_created_at === null ? new Date(Number(row.recorded_at)).toISOString() : String(row.source_created_at), sourceRef, versionKey: `${row.object_id}:${row.revision}`, ordinal: Number(row.committed_sequence), agent: '', envelope: null as any };
      if (!input.metadataOnly && metadata.availability === 'recorded' && !metadata.archived) {
        value.envelope = { schemaVersion: 1, taskId: value.taskId, executionLogId: value.executionLogId, turnId: value.turnId, createdAt: value.createdAt, sourceRef, report: JSON.parse(this.content(String(row.content_id)).toString('utf8')) };
        if (!value.objectArchived) latestReports.set(value.turnId, value.envelope);
      }
      return value;
    });
    const runFiles = this.rows('SELECT execution_log_id,files_json FROM project_run_indexes WHERE project_id=?', [projectId]).flatMap(row => JSON.parse(String(row.files_json)).map((file: any) => ({ ...file, executionLogId: Number(row.execution_log_id) })));
    return { tasks, reports: [...latestReports.values()], observations, runFiles, sourceRevision: this.reportSourceRevision(projectId) };
  }
  public readReportVersions(projectId: string, refs: Array<{ objectId: string; revision: number }>): Array<{ key: string; report: unknown }> {
    return refs.map(ref => {
      const row = this.rows('SELECT content_id FROM report_versions WHERE project_id=? AND object_id=? AND revision=?', [projectId, ref.objectId, ref.revision])[0];
      if (!row) throw new Error('report_version_denied');
      return { key: `${ref.objectId}:${ref.revision}`, report: JSON.parse(this.content(String(row.content_id)).toString('utf8')) };
    });
  }
  public readGithubFacts(projectId: string, repository: string): { revision: number; facts: any } {
    const reference = this.readGrowthReportProjection(projectId, `github-facts:${repository}`).find(row => row.key === `github-facts:${repository}`)?.value as { objectId: string; revision: number } | undefined;
    if (!reference) return { revision: 0, facts: null };
    const evidence = this.read(reference.objectId, reference.revision);
    if (evidence.projectId !== projectId || evidence.kind !== 'evidence' || evidence.data.type !== 'github_host_facts') throw new Error('github_evidence_scope_mismatch');
    return { revision: reference.revision, facts: JSON.parse(String(evidence.data.content)) };
  }
  public writeGithubFacts(projectId: string, input: { repository: string; expectedRevision: number; facts: any; summary: any }): void {
    this.transaction(() => {
      const key = `github-facts:${input.repository}`;
      const reference = this.readGrowthReportProjection(projectId, key).find(row => row.key === key)?.value as { objectId: string; revision: number } | undefined;
      if ((reference?.revision || 0) !== input.expectedRevision) throw new Error('revision_conflict');
      const receipt = this.write({ kind: 'evidence', action: reference ? 'patch' : 'create', scope: projectId, ...(reference ? { objectId: reference.objectId, expectedRevision: reference.revision } : {}),
        idempotencyKey: `github-host-facts:${canonical([projectId, input.repository, input.expectedRevision, digest(canonical(input.facts))])}`,
        data: { type: 'github_host_facts', source_actor_id: this.actorId, observed_at: Date.now(), content: input.facts } });
      const sourceRef = { objectId: receipt.objectId, revision: receipt.revision };
      this.writeGrowthReportProjection(projectId, [{ key, value: sourceRef }, { key: `github-summary:${input.repository}`, value: { ...input.summary, sourceRef } }]);
      this.bumpReportSourceRevision(projectId);
    });
  }
  public readGrowthReportProjection(projectId: string, prefix = ''): Array<{ key: string; value: unknown; revision: number }> {
    return this.rows('SELECT key,value_json,revision FROM growth_report_projection WHERE project_id=? AND key LIKE ? ORDER BY key', [projectId, `${prefix}%`]).map(row => ({ key: String(row.key), value: JSON.parse(String(row.value_json)), revision: Number(row.revision) }));
  }
  public writeGrowthReportProjection(projectId: string, updates: Array<{ key: string; value: unknown; expectedRevision?: number }>, expectedSourceRevision?: number): Array<{ key: string; revision: number }> {
    return this.transaction(() => {
      if (expectedSourceRevision !== undefined && expectedSourceRevision !== this.reportSourceRevision(projectId)) throw new Error('report_source_changed');
      return updates.map(update => {
        if (!update.key) throw new Error('growth_projection_key_required');
        const old = this.rows('SELECT value_json,revision FROM growth_report_projection WHERE project_id=? AND key=?', [projectId, update.key])[0];
        const revision = old ? Number(old.revision) : 0;
        if (update.expectedRevision !== undefined && update.expectedRevision !== revision) throw new Error('revision_conflict');
        const value = canonical(update.value);
        if (old?.value_json === value) return { key: update.key, revision };
        this.db.run('INSERT INTO growth_report_projection(project_id,key,value_json,updated_at,revision) VALUES(?,?,?,?,?) ON CONFLICT(project_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,revision=excluded.revision', [projectId, update.key, value, Date.now(), revision + 1]);
        return { key: update.key, revision: revision + 1 };
      });
    });
  }
  public link(input: { source: string; relation: string; target: string; expectedRevision: number; idempotencyKey: string }): WriteReceipt {
    const allowed = ['parent', 'source', 'evidence', 'depends_on', 'adopts', 'supersedes', 'feedback'];
    if (!allowed.includes(input.relation)) throw new Error('unknown_relation');
    return this.recordMutation(input, input.idempotencyKey, 'link', () => {
      const source = this.current(input.source);
      const target = this.current(input.target);
      if (source.revision !== input.expectedRevision) throw new Error('revision_conflict');
      if (source.objectId === target.objectId) throw new Error('self_relation');
      if (source.projectId !== target.projectId && target.projectId !== null) throw new Error('scope_mismatch');
      if (input.relation === 'depends_on' && (source.kind !== 'roadmap_node' || target.kind !== 'roadmap_node')) throw new Error('relation_kind_mismatch');
      if (input.relation === 'parent' && (source.kind !== 'conversation' || target.kind !== 'conversation')) throw new Error('relation_kind_mismatch');
      if (input.relation === 'evidence' && target.kind !== 'evidence') throw new Error('relation_kind_mismatch');
      this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [input.source, input.relation, input.target]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), source.objectId]);
      return this.current(source.objectId);
    });
  }
  public context(input: { project: string; query?: string; terms?: string[]; categories?: string[]; kinds?: string[]; budget?: number; view?: 'full' | 'metadata'; limit?: number; cursor?: string }, canRead: (object: DataObject) => boolean = () => true): { items: DataObject[]; sourceSequence: number; remaining: boolean; cursor?: string | null; sourceChanged?: boolean } {
    const budget = input.budget === undefined ? 16000 : input.budget;
    if (!Number.isInteger(budget) || budget < 1) throw new Error('invalid_budget');
    const kinds = input.kinds ?? ['memory', 'lesson', 'policy'];
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some(kind => !['memory', 'lesson', 'policy'].includes(kind))) throw new Error('invalid_context_kinds');
    const now = Date.now();
    const eligible = (item: DataObject): boolean => canRead(item) && (!input.categories || input.categories.includes(String(item.data.category))) && !['rejected', 'invalidated', 'superseded', 'expired'].includes(String(item.data.status)) && (item.data.valid_from == null || Number(item.data.valid_from) <= now) && (item.data.valid_until == null || Number(item.data.valid_until) > now) && item.archivedAt === null;
    if (input.view && !['full', 'metadata'].includes(input.view)) throw new Error('unknown_context_view');
    if (input.view === 'metadata') {
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('invalid_limit');
      const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0) AS seq FROM events')[0].seq);
      const fingerprint = digest(canonical({ project: input.project, query: input.query || '', terms: input.terms || [], categories: input.categories || [], ...(input.kinds ? { kinds } : {}) }));
      const after = input.cursor ? JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { phase: number; searchCursor: string | null; sequence: number; fingerprint: string } : null;
      if (after && (after.fingerprint !== fingerprint || ![0, 1].includes(after.phase) || !Number.isInteger(after.sequence) || after.sequence < 0 || !(after.searchCursor === null || typeof after.searchCursor === 'string'))) throw new Error('cursor_scope_mismatch');
      const changed = after !== null && after.sequence !== sequence && this.rows(`SELECT 1 FROM events e JOIN objects o ON o.id=e.subject_id WHERE e.sequence>? AND (o.project_id IS ? OR o.project_id IS NULL) AND o.kind IN (${kinds.map(() => '?').join(',')}) LIMIT 1`, [after.sequence, input.project, ...kinds]).length > 0;
      if (changed) return { items: [], sourceSequence: sequence, remaining: true, cursor: null, sourceChanged: true };
      let phase = after?.phase ?? 0;
      let searchCursor = after?.searchCursor;
      for (;;) {
        const page = this.search({ scope: phase === 0 ? input.project : null, query: input.query, terms: input.terms, kinds, limit, ...(searchCursor ? { cursor: searchCursor } : {}) }, eligible);
        const nextPhase = page.cursor ? phase : phase + 1;
        const cursor = nextPhase <= 1 ? Buffer.from(canonical({ phase: nextPhase, searchCursor: page.cursor, sequence: after?.sequence ?? sequence, fingerprint })).toString('base64url') : null;
        if (page.items.length || cursor === null) return { items: page.items, sourceSequence: sequence, remaining: cursor !== null, cursor, sourceChanged: false };
        phase = nextPhase; searchCursor = null;
      }
    }
    if (input.cursor) throw new Error('context_cursor_requires_metadata');
    const result = this.search({ scope: input.project, query: input.query, terms: input.terms, kinds, limit: 500 }, eligible);
    const global = this.search({ scope: null, query: input.query, terms: input.terms, kinds, limit: 500 }, eligible);
    const candidates = [...result.items, ...global.items];
    const items: DataObject[] = [];
    let size = 0;
    for (const metadata of candidates) {
      const item = this.read(metadata.objectId);
      const length = canonical(item).length;
      if (size + length > budget) continue;
      items.push(item);
      size += length;
    }
    return { items, sourceSequence: Math.max(result.sourceSequence, global.sourceSequence), remaining: items.length !== candidates.length || result.cursor !== null || global.cursor !== null };
  }
  public async export(input: { ref: string; format: 'json' | 'md' | 'text'; destination: string; idempotencyKey: string }, projectObject?: (object: DataObject) => DataObject): Promise<{ destination: string; sha256: string; revision: number }> {
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw new Error('idempotency_key_required');
    if (!['json', 'md', 'text'].includes(input.format)) throw new Error('unknown_export_format');
    const destination = path.resolve(input.destination);
    const exportRoot = path.resolve(this.root, 'exports');
    const relative = path.relative(exportRoot, destination);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('export_destination_outside_exports');
    this.validateExportPath(destination);
    const render = (object: DataObject): string | Buffer => this.exportBody(object, input.format);
    const stored = this.transaction(() => {
      const hash = digest(canonical(input));
      const previous = this.rows('SELECT * FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, input.idempotencyKey])[0];
      if (previous) {
        if (previous.input_hash !== hash) throw new Error('idempotency_conflict');
        const result = JSON.parse(this.content(String(previous.result_content_id)).toString('utf8')) as { destination: string; sha256: string; revision: number; contentId: string; outboxId: string };
        if (projectObject && digest(render(this.read(input.ref, result.revision, projectObject))) !== result.sha256) throw new Error('export_authorization_changed');
        return result;
      }
      const object = this.read(input.ref, undefined, projectObject);
      const data = render(object);
      const contentId = this.putContent(data, input.format === 'json' ? 'application/json' : 'text/plain');
      const requestId = crypto.randomUUID();
      const outboxId = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS seq FROM events')[0].seq);
      const result = { destination, sha256: digest(data), revision: object.revision, contentId, outboxId, ref: object.objectId, format: input.format };
      const resultId = this.putContent(canonical(result), 'application/json');
      this.db.run('INSERT INTO requests VALUES(?,?,?,?,?,?,?)', [this.actorId, input.idempotencyKey, requestId, hash, resultId, 'committed', sequence]);
      this.db.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', [eventId, sequence, object.objectId, this.actorId, 'object.export', contentId, Date.now(), requestId]);
      this.db.run('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,0,NULL)', [outboxId, eventId, 'file_export', destination, contentId, 1, 'pending']);
      return result;
    });
    const bytes = this.content(stored.contentId);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    this.validateExportPath(destination);
    projectObject?.(this.readMetadata(input.ref));
    // Existing user exports are never overwritten. A replay may accept only identical bytes.
    try { await fs.promises.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || digest(await fs.promises.readFile(destination)) !== stored.sha256) throw error;
    }
    this.db.run("UPDATE outbox SET state='delivered',attempt=attempt+1 WHERE id=?", [stored.outboxId]);
    return { destination: stored.destination, sha256: stored.sha256, revision: stored.revision };
  }
  private exportBody(object: DataObject, format: 'json' | 'md' | 'text'): string | Buffer {
    const body = object.data.content as { encoding?: string; data?: string } | undefined;
    return format === 'json' ? canonical(object) : body && body.encoding === 'base64' ? Buffer.from(body.data!, 'base64') : String(object.data.content ?? canonical(object.data));
  }
  private exportRecoveryAuthorization(effect: Record<string, SqlValue>): (() => void) | undefined {
    const event = this.rows('SELECT e.subject_id,e.actor_id,r.result_content_id,a.kind,a.authority_id,p.identity_ref AS project_scope FROM events e JOIN requests r ON r.id=e.request_id JOIN actors a ON a.id=e.actor_id LEFT JOIN actors p ON p.id=a.authority_id WHERE e.id=?', [effect.event_id])[0];
    if (!event || event.kind !== 'mcp') return undefined;
    const scope = String(event.project_scope || ''), ref = String(event.subject_id || '');
    const projectObject = (object: DataObject): DataObject => {
      this.authorizeMcpAction(String(event.authority_id), scope, 'export');
      if (!canAgentRead(object, scope, ref, this.learningReviewScopeCurrent(object))) throw new Error('scope_denied');
      return agentReadableObject(object);
    };
    const check = () => { projectObject(this.readMetadata(ref)); };
    check();
    const saved = JSON.parse(this.content(String(event.result_content_id)).toString('utf8'));
    if (saved.outboxId !== effect.id || saved.contentId !== effect.content_id || saved.destination !== effect.destination_ref || (saved.ref && saved.ref !== ref)) throw new Error('export_authorization_changed');
    const object = this.read(ref, saved.revision, projectObject);
    const formats: Array<'json' | 'md' | 'text'> = saved.format ? [saved.format] : ['json', 'md', 'text'];
    if (!formats.some(format => digest(this.exportBody(object, format)) === saved.sha256)) throw new Error('export_authorization_changed');
    return check;
  }
  private validateExportPath(destination: string): void {
    const relative = path.relative(path.resolve(this.root), destination);
    let current = path.resolve(this.root);
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('export_destination_symlink');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
  }
  public async recoverOutbox(): Promise<{ delivered: number; pending: Array<{ id: string; error: string }> }> {
    const effects = this.rows("SELECT * FROM outbox WHERE state<>'delivered' AND channel IN ('project_identity','file_export') ORDER BY rowid");
    const pending: Array<{ id: string; error: string }> = [];
    let delivered = 0;
    for (const effect of effects) {
      const id = String(effect.id);
      try {
        const destination = String(effect.destination_ref);
        let authorize: (() => void) | undefined;
        if (effect.channel === 'file_export') {
          const relative = path.relative(path.resolve(this.root, 'exports'), destination);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('export_destination_outside_exports');
          this.validateExportPath(destination);
          authorize = this.exportRecoveryAuthorization(effect);
        } else {
          if (path.basename(destination) !== 'project.json' || path.basename(path.dirname(destination)) !== '.solopreneur') throw new Error('project_identity_invalid');
          const projectRoot = fs.realpathSync(path.dirname(path.dirname(destination)));
          if (!this.rows("SELECT id FROM project_locations WHERE root_path=? AND status='active'", [projectRoot]).length) throw new Error('project_location_missing');
          if (fs.existsSync(path.dirname(destination)) && fs.lstatSync(path.dirname(destination)).isSymbolicLink()) throw new Error('project_identity_symlink');
        }
        const bytes = this.content(String(effect.content_id));
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        if (effect.channel === 'file_export') { this.validateExportPath(destination); authorize?.(); }
        try { await fs.promises.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || fs.lstatSync(destination).isSymbolicLink() || digest(await fs.promises.readFile(destination)) !== digest(bytes)) throw error;
        }
        this.db.run("UPDATE outbox SET state='delivered',attempt=attempt+1,next_attempt_at=NULL WHERE id=?", [id]);
        delivered++;
      } catch (error) {
        this.db.run("UPDATE outbox SET attempt=attempt+1 WHERE id=?", [id]);
        pending.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { delivered, pending };
  }
  public search(input: { scope: string | null; query?: string; terms?: string[]; kinds?: string[]; limit?: number; cursor?: string }, canRead: (object: DataObject) => boolean = () => true, projectObject?: (object: DataObject) => DataObject): { items: DataObject[]; cursor: string | null; sourceSequence: number; sourceChanged: boolean } {
    if (input.scope !== null && typeof input.scope !== 'string') throw new Error('scope_required');
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('invalid_limit');
    if (input.terms && (!Array.isArray(input.terms) || !input.terms.length || input.terms.some(term => typeof term !== 'string' || !term.trim()))) throw new Error('invalid_search_terms');
    if (input.terms && input.query) throw new Error('search_query_conflict');
    const terms = input.terms || (input.query ? [input.query] : []);
    const match = terms.map(term => `(${queryTokens(term)})`).join(' OR ');
    const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0) AS seq FROM events')[0].seq);
    const after = input.cursor ? JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { id: string; sequence: number; fingerprint: string } : null;
    const fingerprint = digest(canonical({ scope: input.scope, query: input.query || '', ...(input.terms ? { terms: input.terms } : {}), kinds: input.kinds || [] }));
    if (after && after.fingerprint !== fingerprint) throw new Error('cursor_scope_mismatch');
    const kinds = input.kinds || Object.keys(entityDefinitions);
    kinds.forEach(kind => this.definition(kind));
    const sourceChanged = after !== null && after.sequence !== sequence && this.rows(`SELECT 1 FROM events e JOIN objects o ON o.id=e.subject_id WHERE e.sequence>? AND o.project_id IS ? AND o.kind IN (${kinds.map(() => '?').join(',')}) LIMIT 1`, [after.sequence, input.scope, ...kinds]).length > 0;
    const matches: DataObject[] = [];
    let lastId = after?.id || '';
    while (matches.length <= limit) {
      const candidates = this.rows(`SELECT id FROM objects WHERE project_id IS ? AND archived_at IS NULL AND kind IN (${kinds.map(() => '?').join(',')}) AND id>? ${terms.length ? 'AND rowid IN (SELECT rowid FROM object_search WHERE object_search MATCH ?)' : ''} ORDER BY id LIMIT ?`, [input.scope, ...kinds, lastId, ...(terms.length ? [match] : []), limit + 1]);
      if (!candidates.length) break;
      for (const row of candidates) {
        lastId = String(row.id);
        const metadata = this.readMetadata(lastId);
        if (!canRead(metadata)) continue;
        const searchable = terms.length ? canonical(this.read(lastId, undefined, projectObject).data).toLowerCase() : '';
        if (!terms.length || terms.some(term => searchable.includes(term.toLowerCase()))) {
          if (metadata.kind === 'evidence' && metadata.data.type === 'run_digest_source') {
            const header = JSON.parse(this.content(String(metadata.data.content_id)).toString('utf8'));
            const settlement = this.rows("SELECT r.target_id FROM relations r JOIN evidence e ON e.id=r.target_id WHERE r.source_id=? AND r.relation='source' AND e.type GLOB 'run_document:settlement_*'", [header.sourceRef.objectId])[0];
            metadata.projection = { ...header, ...(settlement ? { settlementRef: { objectId: String(settlement.target_id), revision: 1 } } : {}) };
          }
          if (metadata.kind === 'evidence' && metadata.data.type === 'project_journal') {
            const journal = this.rows('SELECT j.execution_log_id,j.node_id,j.agent_cli,j.status,j.timestamp FROM project_journal_sources s JOIN project_journal_entries j ON j.project_id=s.project_id AND j.execution_log_id=s.execution_log_id WHERE s.object_id=?', [metadata.objectId])[0];
            if (journal) metadata.projection = { sourceRef: { objectId: metadata.objectId, revision: metadata.revision }, executionLogId: Number(journal.execution_log_id), nodeId: String(journal.node_id), agentCli: String(journal.agent_cli), status: String(journal.status), finishedAt: String(journal.timestamp) };
          }
          matches.push(projectObject ? projectObject(metadata) : metadata);
        }
        if (matches.length > limit) break;
      }
      if (candidates.length < limit + 1) break;
    }
    const items = matches.slice(0, limit);
    return { items, cursor: matches.length > limit ? Buffer.from(canonical({ id: items[items.length - 1].objectId, sequence: after?.sequence ?? sequence, fingerprint })).toString('base64url') : null, sourceSequence: sequence, sourceChanged };
  }
  public readIntelligenceConversation(id: string): { conversation: IntelligenceConversation; revision: number } | null {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid intelligence conversation ID.');
    const row = this.rows("SELECT o.* FROM objects o JOIN conversations c ON c.id=o.id WHERE o.id=? AND o.project_id IS NULL AND c.mode='intelligence' AND o.archived_at IS NULL", [id])[0];
    if (!row) return null;
    const object = this.current(id, false);
    const messages = this.rows('SELECT role,content_id FROM messages WHERE conversation_id=? ORDER BY sequence', [id]).map(message => ({ role: String(message.role) as 'user' | 'assistant', content: this.decodedContent(String(message.content_id)) as string }));
    return { revision: Number(row.revision), conversation: { id, title: String(object.data.title), createdAt: new Date(Number(row.created_at)).toISOString(), updatedAt: new Date(Number(row.updated_at)).toISOString(), messages } };
  }
  public listIntelligenceConversations(): Array<Pick<IntelligenceConversation, 'id' | 'title' | 'updatedAt'>> {
    return this.rows("SELECT o.id,c.title,o.updated_at FROM objects o JOIN conversations c ON c.id=o.id WHERE o.project_id IS NULL AND c.mode='intelligence' AND o.archived_at IS NULL ORDER BY o.updated_at DESC,o.id").map(row => ({ id: String(row.id), title: String(row.title), updatedAt: new Date(Number(row.updated_at)).toISOString() }));
  }
  public writeIntelligenceConversation(input: { conversation: IntelligenceConversation; expectedRevision: number; idempotencyKey: string }): WriteReceipt {
    const value = input.conversation;
    if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id) || typeof value.title !== 'string' || !Array.isArray(value.messages) || value.messages.some(message => !message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Intelligence conversation data is invalid.');
    return this.recordMutation(input, input.idempotencyKey, 'append_messages', () => {
      const current = this.readIntelligenceConversation(value.id);
      if ((current?.revision || 0) !== input.expectedRevision) throw new Error('revision_conflict');
      const oldMessages = current?.conversation.messages || [];
      if (value.messages.length < oldMessages.length || canonical(value.messages.slice(0, oldMessages.length)) !== canonical(oldMessages)) throw new Error('conversation_history_conflict');
      if (current) {
        if (value.createdAt !== current.conversation.createdAt) throw new Error('conversation_identity_conflict');
        this.db.run('UPDATE conversations SET title=? WHERE id=?', [value.title, value.id]);
        this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.parse(value.updatedAt), value.id]);
      } else {
        this.db.run("INSERT INTO objects VALUES(?,'conversation',NULL,1,?,?,NULL)", [value.id, Date.parse(value.createdAt), Date.parse(value.updatedAt)]);
        this.db.run("INSERT INTO conversations(id,project_id,mode,status,title) VALUES(?,NULL,'intelligence','active',?)", [value.id, value.title]);
      }
      for (let i = oldMessages.length; i < value.messages.length; i++) {
        this.write({ kind: 'message', action: 'create', scope: null, idempotencyKey: `${input.idempotencyKey}:message:${i}`, data: { conversation_id: value.id, sequence: i, role: value.messages[i].role, content: value.messages[i].content } });
      }
      return this.current(value.id);
    });
  }
  public appendProjectJournal(projectId: string, idempotencyKey: string, entry: Omit<AgentConversation, 'id'>, requestedExecutionLogId = 0, minimumExecutionLogId = 1): { executionLogId: number } {
    if (!idempotencyKey || !entry || !entry.nodeId || !entry.timestamp) throw new Error('invalid_project_journal_entry');
    return this.transaction(() => {
      const existing = this.rows('SELECT execution_log_id FROM project_journal_entries WHERE project_id=? AND idempotency_key=?', [projectId, idempotencyKey])[0];
      if (existing) { this.syncProjectJournalSource(projectId, Number(existing.execution_log_id)); return { executionLogId: Number(existing.execution_log_id) }; }
      const nextDatabaseId = Number(this.rows('SELECT COALESCE(MAX(execution_log_id),0)+1 AS id FROM project_journal_entries WHERE project_id=?', [projectId])[0].id);
      const executionLogId = requestedExecutionLogId || Math.max(nextDatabaseId, Math.max(1, Number(minimumExecutionLogId || 1)));
      this.db.run('INSERT INTO project_journal_entries(execution_log_id,project_id,idempotency_key,node_id,timestamp,agent_cli,command,output,status) VALUES(?,?,?,?,?,?,?,?,?)', [executionLogId, projectId, idempotencyKey, entry.nodeId, entry.timestamp, entry.agentCli || '', entry.command || '', entry.output || '', entry.status || 'Running']);
      this.syncProjectJournalSource(projectId, executionLogId);
      return { executionLogId };
    });
  }
  public importProjectJournal(projectId: string, entry: AgentConversation): { executionLogId: number } {
    const executionLogId = Number(entry.id || 0);
    if (!executionLogId) throw new Error('invalid_project_journal_entry');
    return this.transaction(() => {
      this.db.run('INSERT INTO project_journal_entries(execution_log_id,project_id,idempotency_key,node_id,timestamp,agent_cli,command,output,status) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,execution_log_id) DO NOTHING', [executionLogId, projectId, `legacy:${executionLogId}`, entry.nodeId || '', entry.timestamp || '', entry.agentCli || '', entry.command || '', entry.output || '', entry.status || 'Processed']);
      this.syncProjectJournalSource(projectId, executionLogId);
      return { executionLogId };
    });
  }
  public updateProjectJournal(projectId: string, executionLogId: number, input: Pick<AgentConversation, 'agentCli' | 'command' | 'output' | 'status'>): { updated: boolean } {
    return this.transaction(() => {
      this.db.run('UPDATE project_journal_entries SET agent_cli=?,command=?,output=?,status=? WHERE project_id=? AND execution_log_id=?', [input.agentCli || '', input.command || '', input.output || '', input.status || '', projectId, executionLogId]);
      const updated = this.db.getRowsModified() > 0;
      if (updated) this.syncProjectJournalSource(projectId, executionLogId);
      return { updated };
    });
  }
  public syncProjectJournalSource(projectId: string, executionLogId: number): void {
    this.transaction(() => {
      const journal = this.readProjectJournal(projectId, { executionLogId, limit: 1 }).logs[0];
      if (!journal) throw new Error('project_journal_entry_missing');
      const body = canonical(journal);
      const previous = this.rows('SELECT o.*,e.content_id,c.sha256 FROM project_journal_sources s JOIN objects o ON o.id=s.object_id JOIN evidence e ON e.id=o.id JOIN contents c ON c.id=e.content_id WHERE s.project_id=? AND s.execution_log_id=?', [projectId, executionLogId])[0];
      if (previous?.sha256 === digest(body)) return;
      const receipt = this.write({ kind: 'evidence', scope: projectId, action: previous ? 'patch' : 'create', ...(previous ? { objectId: String(previous.id), expectedRevision: Number(previous.revision) } : {}), idempotencyKey: `project-journal-source:${canonical([projectId, executionLogId, previous?.revision || 0, digest(body)])}`, data: { type: 'project_journal', source_actor_id: this.actorId, observed_at: Date.now(), content: body } });
      this.db.run('INSERT INTO project_journal_sources VALUES(?,?,?) ON CONFLICT(project_id,execution_log_id) DO NOTHING', [projectId, executionLogId, receipt.objectId]);
    });
  }
  public missingProjectJournalSources(projectId: string, limit = 100): number[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('invalid_project_journal_page');
    return this.rows('SELECT j.execution_log_id FROM project_journal_entries j LEFT JOIN project_journal_sources s ON s.project_id=j.project_id AND s.execution_log_id=j.execution_log_id WHERE j.project_id=? AND s.object_id IS NULL ORDER BY j.execution_log_id LIMIT ?', [projectId, limit]).map(row => Number(row.execution_log_id));
  }
  public readProjectJournal(projectId: string, input: { nodeId?: string; executionLogId?: number; limit?: number; offset?: number } = {}): { logs: AgentConversation[]; hasMore: boolean } {
    const limit = Math.max(1, Math.min(500, Number(input.limit || 200)));
    const offset = Math.max(0, Number(input.offset || 0));
    const clauses = ['project_id=?']; const values: SqlValue[] = [projectId];
    if (input.nodeId) { clauses.push('node_id=?'); values.push(input.nodeId); }
    if (input.executionLogId) { clauses.push('execution_log_id=?'); values.push(input.executionLogId); }
    const rows = this.rows(`SELECT * FROM project_journal_entries WHERE ${clauses.join(' AND ')} ORDER BY execution_log_id DESC LIMIT ? OFFSET ?`, [...values, limit + 1, offset]);
    return { logs: rows.slice(0, limit).map(row => {
      const id = Number(row.execution_log_id);
      const source = this.resolveRunConversation(projectId, id);
      const binding = source ? this.readRunBinding(projectId, Number(source.state.status.rootExecutionLogId)) : null;
      const resumable = binding ? getResumableSessionValue(binding) : null;
      return { id, nodeId: String(row.node_id), timestamp: String(row.timestamp), agentCli: String(row.agent_cli), command: String(row.command), output: String(row.output), status: String(row.status),
        dataState: { resumableSessionId: resumable?.sessionId || '', sessionOpen: Boolean(source?.state.status.interactiveSession && !source.state.status.interactiveSessionClosed) } };
    }), hasMore: rows.length > limit };
  }
  public upsertProjectRunIndex(projectId: string, record: RunIndexRecord, files: RunIndexFile[] = [], signals: RunIndexSignal[] = []): void {
    this.transaction(() => {
      this.bumpReportSourceRevision(projectId);
      this.db.run('INSERT INTO project_run_indexes VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,execution_log_id) DO UPDATE SET record_json=excluded.record_json,files_json=excluded.files_json,signals_json=excluded.signals_json,updated_at=excluded.updated_at', [projectId, Number(record.executionLogId), canonical(record), canonical(files), canonical(signals), Date.now()]);
      this.db.run('DELETE FROM run_digest_index_sources WHERE project_id=? AND execution_log_id=?', [projectId, Number(record.executionLogId)]);
      this.db.run('DELETE FROM run_index_import_sources WHERE project_id=? AND execution_log_id=?', [projectId, Number(record.executionLogId)]);
      this.db.run('INSERT INTO run_index_import_sources VALUES(?,?,?,?,?,?,0)', [projectId, Number(record.executionLogId), 'native', String(record.executionLogId), '', digest(canonical([record, files, signals]))]);
    });
  }
  public importProjectRunIndex(projectId: string, record: RunIndexRecord, files: RunIndexFile[] = [], signals: RunIndexSignal[] = []): void {
    this.db.run('INSERT INTO project_run_indexes VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,execution_log_id) DO NOTHING', [projectId, Number(record.executionLogId), canonical(record), canonical(files), canonical(signals), Date.now()]);
  }
  public importHistoricalRunIndex(projectId: string, record: RunIndexRecord, files: RunIndexFile[], signals: RunIndexSignal[], source: ImportedSource, priority: 10 | 20): boolean {
    if (!source.identity || !source.key || !source.hash || !Number.isSafeInteger(record.executionLogId) || record.executionLogId < 1) throw new Error('historical_run_index_source_invalid');
    return this.transaction(() => {
      const id = record.executionLogId;
      const current = this.rows('SELECT record_json,files_json,signals_json FROM project_run_indexes WHERE project_id=? AND execution_log_id=?', [projectId, id])[0];
      const previous = this.rows('SELECT * FROM run_index_import_sources WHERE project_id=? AND execution_log_id=?', [projectId, id])[0];
      const digestSource = this.rows('SELECT object_id FROM run_digest_index_sources WHERE project_id=? AND execution_log_id=?', [projectId, id])[0];
      if (current) {
        const currentHash = digest(canonical([JSON.parse(String(current.record_json)), JSON.parse(String(current.files_json)), JSON.parse(String(current.signals_json))]));
        if (previous && Number(previous.priority) === 0) return false;
        if (previous && currentHash !== previous.index_hash) throw new Error('migration_target_changed');
        if (JSON.parse(String(current.record_json)).nodeId !== record.nodeId) throw new Error('historical_run_identity_ambiguous');
        if (digestSource && priority === 10) {
          const derived: RunIndexRecord = JSON.parse(String(current.record_json));
          if (derived.nodeId !== record.nodeId) throw new Error('historical_run_identity_ambiguous');
          const tokens = this.enrichRunIndexFromArchivedOutput(projectId, derived);
          if (!tokens) return false;
          this.db.run('UPDATE project_run_indexes SET record_json=?,updated_at=? WHERE project_id=? AND execution_log_id=?', [canonical(derived), Date.now(), projectId, id]);
          this.db.run('INSERT INTO run_index_import_sources VALUES(?,?,?,?,?,?,10) ON CONFLICT(project_id,execution_log_id) DO UPDATE SET source_identity=excluded.source_identity,source_key=excluded.source_key,source_hash=excluded.source_hash,index_hash=excluded.index_hash,priority=10', [projectId, id, `archived-run-output:${projectId}`, tokens.key, tokens.hash, digest(canonical([derived, JSON.parse(String(current.files_json)), JSON.parse(String(current.signals_json))]))]);
          return true;
        }
        if (previous && Number(previous.priority) > priority) return false;
        if (previous && Number(previous.priority) === priority && (!this.samePhysicalMigrationSource(String(previous.source_identity), source.identity) || previous.source_key !== source.key)) throw new Error('historical_run_identity_ambiguous');
        if (!previous && (!digestSource || priority === 10)) {
          throw new Error('historical_run_index_owner_unknown');
        }
        record = { ...record };
        this.enrichRunIndexFromArchivedOutput(projectId, record);
        const existingUsage = normalizeTokenUsage(JSON.parse(String(current.record_json)));
        if (existingUsage.totalTokens > 0 && normalizeTokenUsage(record).totalTokens === 0) Object.assign(record, existingUsage);
        if (previous?.source_hash === source.hash && currentHash === digest(canonical([record, files, signals]))) return false;
      }
      const indexHash = digest(canonical([record, files, signals]));
      this.upsertProjectRunIndex(projectId, record, files, signals);
      this.db.run('DELETE FROM run_index_import_sources WHERE project_id=? AND execution_log_id=?', [projectId, id]);
      this.db.run('INSERT INTO run_index_import_sources VALUES(?,?,?,?,?,?,?)', [projectId, id, source.identity, source.key, source.hash, indexHash, priority]);
      return true;
    });
  }
  private enrichRunIndexFromArchivedOutput(projectId: string, record: RunIndexRecord): { key: string; hash: string } | null {
    if (normalizeTokenUsage(record).totalTokens > 0) return null;
    const candidates = new Set<string>();
    const outputPath = String(record.outputPath || '');
    const prefix = '.solopreneur/agent-runs/';
    if (outputPath.startsWith(prefix)) candidates.add(outputPath.slice(prefix.length).split(path.sep).join('/'));
    else if (path.isAbsolute(outputPath)) for (const location of this.rows('SELECT root_path FROM project_locations WHERE project_id=?', [projectId])) {
      const relative = path.relative(String(location.root_path), outputPath).split(path.sep).join('/');
      if (relative.startsWith(prefix)) candidates.add(relative.slice(prefix.length));
    }
    if (record.nodeId && !record.nodeId.includes('/') && !record.nodeId.includes('\\')) {
      candidates.add(`${record.nodeId}/${record.executionLogId}/output.log`);
      candidates.add(`${record.nodeId}/output.log`);
    }
    if (!candidates.size) return null;
    const rows = this.rows('SELECT relative_path,content_id,sha256 FROM project_run_artifacts WHERE project_id=? AND execution_log_id=? AND relative_path IN (SELECT value FROM json_each(?))', [projectId, record.executionLogId, canonical([...candidates])]);
    if (!rows.length) return null;
    if (new Set(rows.map(row => row.sha256)).size > 1) throw new Error('historical_run_token_source_ambiguous');
    const usage = extractTokenUsageFromOutput(this.content(String(rows[0].content_id)).toString('utf8'), record.agentCli);
    if (usage.totalTokens <= 0) return null;
    Object.assign(record, usage);
    return { key: String(rows[0].relative_path), hash: String(rows[0].sha256) };
  }
  public reserveHistoricalRunId(projectId: string, sourceKey: string, entry: Omit<AgentConversation, 'id'>, minimumExecutionLogId = 1): number {
    return this.transaction(() => {
      const next = Number(this.rows('SELECT COALESCE(MAX(execution_log_id),0)+1 AS next FROM (SELECT execution_log_id FROM project_journal_entries WHERE project_id=? UNION ALL SELECT execution_log_id FROM project_run_indexes WHERE project_id=? UNION ALL SELECT execution_log_id FROM project_run_artifacts WHERE project_id=?)', [projectId, projectId, projectId])[0].next);
      return this.appendProjectJournal(projectId, `historical-raw:${sourceKey}`, entry, 0, Math.max(next, minimumExecutionLogId)).executionLogId;
    });
  }
  public readProjectRunIndexes(projectId: string, input: { limit?: number; offset?: number } = {}): RunIndexEntry[] {
    const values: SqlValue[] = [projectId];
    if (input.limit !== undefined) values.push(Math.max(1, Math.min(500, Number(input.limit || 200))), Math.max(0, Number(input.offset || 0)));
    return this.rows(`SELECT record_json,files_json,signals_json FROM project_run_indexes WHERE project_id=? ORDER BY execution_log_id DESC ${input.limit === undefined ? '' : 'LIMIT ? OFFSET ?'}`, values).map(row => ({ ...JSON.parse(String(row.record_json)), files: JSON.parse(String(row.files_json)), signals: JSON.parse(String(row.signals_json)) }));
  }
  public readProjectInvestmentRuns(projectId: string): Array<{ runKind: string; status: string; startedAt: string; finishedAt: string; durationMs: number }> {
    return this.rows(`SELECT json_extract(record_json,'$.runKind') AS kind,json_extract(record_json,'$.status') AS status,json_extract(record_json,'$.startedAt') AS started,json_extract(record_json,'$.finishedAt') AS finished,json_extract(record_json,'$.durationMs') AS duration FROM project_run_indexes WHERE project_id=? ORDER BY execution_log_id DESC`, [projectId]).map(row => ({
      runKind: String(row.kind || 'step'), status: String(row.status || ''), startedAt: String(row.started || ''), finishedAt: String(row.finished || row.started || ''), durationMs: Math.max(0, Number(row.duration || 0))
    }));
  }
  public readProjectImpactRuns(projectId: string): RunImpactRecord[] {
    const fields = ['runKind', 'agentCli', 'status', 'startedAt', 'finishedAt', 'durationMs', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
    const projection = fields.map(field => `json_extract(record_json,'$.${field}') AS "${field}"`).join(',');
    return this.rows(`SELECT ${projection},(SELECT json_group_array(json_object('filePath',json_extract(f.value,'$.filePath'),'role',json_extract(f.value,'$.role'))) FROM json_each(files_json) f WHERE json_extract(f.value,'$.role') IN ('changed','touched')) AS files FROM project_run_indexes WHERE project_id=? ORDER BY execution_log_id DESC`, [projectId]).map(row => ({
      runKind: String(row.runKind || 'step'), agentCli: String(row.agentCli || ''), status: String(row.status || ''), startedAt: String(row.startedAt || ''), finishedAt: String(row.finishedAt || row.startedAt || ''), durationMs: Math.max(0, Number(row.durationMs || 0)),
      inputTokens: Number(row.inputTokens || 0), cachedInputTokens: Number(row.cachedInputTokens || 0), outputTokens: Number(row.outputTokens || 0), reasoningOutputTokens: Number(row.reasoningOutputTokens || 0), totalTokens: Number(row.totalTokens || 0), files: JSON.parse(String(row.files))
    }));
  }
  public readProjectReusableSourceCount(projectId: string): number {
    const memories = Number(this.rows('SELECT count(*) AS n FROM project_step_memory WHERE project_id=?', [projectId])[0].n);
    const runs = Number(this.rows("SELECT count(DISTINCT COALESCE(json_extract(record_json,'$.nodeId'),'')) AS n FROM project_run_indexes WHERE project_id=?", [projectId])[0].n);
    return memories + runs;
  }
  public readStrategyState(projectId: string | null): { objectId: string | null; revision: number; value: unknown } {
    const key = projectId === null ? 'cache' : 'preferences';
    const row = this.rows('SELECT s.id FROM settings s JOIN objects o ON o.id=s.id WHERE s.namespace=? AND s.key=? AND s.owner_scope=? AND o.project_id IS ? AND o.archived_at IS NULL', ['strategy', key, projectId || 'global', projectId])[0];
    if (!row) return { objectId: null, revision: 0, value: null };
    const object = this.read(String(row.id));
    return { objectId: object.objectId, revision: object.revision, value: JSON.parse(String(object.data.content)) };
  }
  public readStrategySourceRevision(projectIds: string[]): string {
    return digest(canonical([this.readLearningSourceRevision(), [...new Set(projectIds)].sort().map(id => {
      const row = this.rows("SELECT s.id,o.revision FROM settings s JOIN objects o ON o.id=s.id WHERE s.namespace='strategy' AND s.key='preferences' AND s.owner_scope=? AND o.project_id=? AND o.archived_at IS NULL", [id, id])[0];
      return [id, row ? [row.id, row.revision] : null, this.readProjectInvestmentRuns(id)];
    })]));
  }
  public writeStrategyState(projectId: string | null, input: { expectedRevision: number; value: unknown; idempotencyKey: string; expectedSourceRevision?: string; sourceProjectIds?: string[] }): { objectId: string; revision: number; value: unknown } {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.value === undefined || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw new Error('invalid_strategy_state');
    return this.transaction(() => {
      const current = this.readStrategyState(projectId);
      const key = `strategy-state:${projectId || 'global'}:${input.idempotencyKey}`;
      const retried = this.rows('SELECT 1 FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, key]).length > 0;
      if (!retried && input.expectedSourceRevision !== undefined && input.expectedSourceRevision !== this.readStrategySourceRevision(input.sourceProjectIds || [])) throw new Error('strategy_source_conflict');
      if (input.expectedRevision === 0 && current.objectId && !retried) throw new Error('revision_conflict');
      const receipt = this.write({ kind: 'setting', action: input.expectedRevision === 0 ? 'create' : 'patch', scope: projectId,
        ...(input.expectedRevision === 0 ? {} : { objectId: current.objectId || undefined, expectedRevision: input.expectedRevision }), idempotencyKey: key,
        data: { namespace: 'strategy', key: projectId === null ? 'cache' : 'preferences', owner_scope: projectId || 'global', content: JSON.stringify(input.value) } });
      return { objectId: receipt.objectId, revision: receipt.revision, value: JSON.parse(String(this.read(receipt.objectId, receipt.revision).data.content)) };
    });
  }
  public importStrategyState(projectId: string | null, value: unknown, source: ImportedSource): { receipt?: WriteReceipt; unchanged: boolean } {
    return this.transaction(() => {
      const current = this.readStrategyState(projectId);
      const binding = this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
      if (current.objectId && binding?.object_id !== current.objectId) throw new Error('migration_conflict: existing_database_choice');
      return this.importObject({ kind: 'setting', action: 'create', scope: projectId, idempotencyKey: `import-strategy:${canonical(source)}`,
        data: { namespace: 'strategy', key: projectId === null ? 'cache' : 'preferences', owner_scope: projectId || 'global', content: JSON.stringify(value) } }, source);
    });
  }
  public writeRunArtifact(projectId: string, input: { executionLogId: number; relativePath: string; bytes: string; hash: string; mimeType?: string }): void {
    if (!Number.isFinite(input.executionLogId) || !input.relativePath || path.isAbsolute(input.relativePath) || input.relativePath.split(/[\\/]/).includes('..')) throw new Error('invalid_run_artifact');
    const bytes = Buffer.from(input.bytes, 'base64');
    if (bytes.toString('base64') !== input.bytes || digest(bytes) !== input.hash) throw new Error('run_artifact_hash_mismatch');
    const contentId = this.putContent(bytes, input.mimeType || 'application/octet-stream', 'binary');
    this.db.run('INSERT INTO project_run_artifacts VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,execution_log_id,relative_path) DO UPDATE SET content_id=excluded.content_id,sha256=excluded.sha256,mime_type=excluded.mime_type,updated_at=excluded.updated_at', [projectId, input.executionLogId, input.relativePath, contentId, input.hash, input.mimeType || 'application/octet-stream', Date.now()]);
  }
  public readRunArtifact(projectId: string, executionLogId: number, relativePath: string): { bytes: string; hash: string; mimeType: string } | null {
    const row = this.rows('SELECT content_id,sha256,mime_type FROM project_run_artifacts WHERE project_id=? AND execution_log_id=? AND relative_path=?', [projectId, executionLogId, relativePath])[0];
    return row ? { bytes: this.content(String(row.content_id)).toString('base64'), hash: String(row.sha256), mimeType: String(row.mime_type) } : null;
  }
  public async backup(destination: string): Promise<void> {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const fd = fs.openSync(destination, 'wx', 0o600);
    fs.closeSync(fd);
    await this.db.backup(destination);
  }
  public close(): void { this.db.close(); }
}

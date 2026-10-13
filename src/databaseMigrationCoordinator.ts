import { UnifiedDataStore, MigrationJob } from './db/unifiedDataStore';
import { importMemoryDirectory, MemoryImportResult } from './memoryDatabaseMigration';
import { importIntelligenceDirectory } from './intelligenceConversationData';
import { importLearningDirectory, importLearningReviewDirectory } from './learningDatabaseMigration';
import { importStrategyDirectory } from './strategyDatabaseMigration';
import { importCapabilityDirectory } from './capabilityDatabaseMigration';
import { importAgentRuns, importProjectGrowth, importProjectJournal, importStepMemoryDirectory, importRunDigestDirectory } from './projectDataMigration';
import { importAnalysisCaches } from './analysisDatabaseMigration';
import { importDocumentationManifest } from './documentationDatabaseMigration';
import { importProjectAutonomyAuthorizations } from './projectAutonomyDatabaseMigration';

/** One background queue belongs to the existing Runtime database owner. */
export class DatabaseMigrationCoordinator {
  private stopping = false;
  private work: Promise<void> | undefined;
  constructor(private readonly store: UnifiedDataStore) {}
  enqueue(input: Record<string, unknown>): MigrationJob & { scheduled: boolean } {
    if (this.stopping) throw new Error('migration_coordinator_stopping');
    const { idempotencyKey, refreshCompleted, ...args } = input;
    if (typeof idempotencyKey !== 'string') throw new Error('migration_idempotency_key_required');
    const before = this.store.migrationJobCount();
    const job = this.store.enqueueMemoryMigration(args, idempotencyKey);
    const scheduled = this.store.migrationJobCount() > before
      || (refreshCompleted === true && this.store.requeueCompletedMigration(job.jobId));
    this.recover();
    return { ...this.store.readMigrationJob(job.jobId), scheduled };
  }
  recover(): void {
    if (this.stopping || this.work) return;
    this.work = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      for (;;) {
        if (this.stopping) return;
        const job = this.store.pendingMigrationJobs()[0];
        if (!job) return;
        this.store.updateMigrationJob(job.jobId, 'running', job.progress);
        let processed = 0;
        try {
          const collection = job.args.collection || 'memory';
          if (!['memory', 'learning', 'learning-review', 'strategy', 'capabilities', 'documentation', 'analysis-caches', 'intelligence', 'project-autonomy', 'project-journal', 'agent-runs', 'project-growth', 'step-memory', 'run-digests'].includes(String(collection))) throw new Error('migration_collection_unsupported');
          const importer: (store: UnifiedDataStore, source: string, options: any) => Promise<MemoryImportResult> = job.args.collection === 'intelligence' ? importIntelligenceDirectory
            : job.args.collection === 'learning' ? importLearningDirectory
            : job.args.collection === 'learning-review' ? importLearningReviewDirectory
            : job.args.collection === 'strategy' ? importStrategyDirectory
            : job.args.collection === 'capabilities' ? importCapabilityDirectory
            : job.args.collection === 'documentation' ? importDocumentationManifest
            : job.args.collection === 'analysis-caches' ? importAnalysisCaches
            : job.args.collection === 'project-autonomy' ? importProjectAutonomyAuthorizations
            : job.args.collection === 'project-journal' ? importProjectJournal
            : job.args.collection === 'agent-runs' ? importAgentRuns
            : job.args.collection === 'project-growth' ? importProjectGrowth
            : job.args.collection === 'step-memory' ? importStepMemoryDirectory
            : job.args.collection === 'run-digests' ? importRunDigestDirectory
            : importMemoryDirectory;
          const result = await importer(this.store, String(job.args.sourceRoot), {
            mode: job.args.mode,
            projectRoot: job.args.projectRoot,
            sourceIdentity: job.args.sourceIdentity as string | undefined,
            projectScopes: job.args.projectScopes as Record<string, string> | undefined,
            shouldContinue: () => !this.stopping,
            onProgress: (progress: MemoryImportResult) => {
              if (++processed % 32 === 0) this.store.updateMigrationJob(job.jobId, 'running', { ...progress });
            }
          });
          this.store.updateMigrationJob(job.jobId, result.interrupted ? 'interrupted' : result.conflicts.length ? 'completed_with_conflicts' : 'completed', { ...result });
        } catch (error) {
          this.store.updateMigrationJob(job.jobId, this.stopping ? 'interrupted' : 'failed', {}, error instanceof Error ? error.message : String(error));
        }
      }
    }).finally(() => { this.work = undefined; });
  }
  retry(jobId: string): MigrationJob {
    const job = this.store.readMigrationJob(jobId);
    if (!['failed', 'completed_with_conflicts', 'interrupted'].includes(job.status)) throw new Error('migration_not_retryable');
    this.store.updateMigrationJob(jobId, 'queued', {});
    this.recover();
    return this.store.readMigrationJob(jobId);
  }
  async wait(): Promise<void> { await this.work; }
  async close(): Promise<void> { this.stopping = true; await this.work; }
}

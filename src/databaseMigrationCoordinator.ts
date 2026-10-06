import { UnifiedDataStore, MigrationJob } from './db/unifiedDataStore';
import { importMemoryDirectory, MemoryImportResult } from './memoryDatabaseMigration';
import { importIntelligenceDirectory } from './intelligenceConversationData';
import { importAgentRuns, importProjectGrowth, importProjectJournal } from './projectDataMigration';

/** One background queue belongs to the existing Runtime database owner. */
export class DatabaseMigrationCoordinator {
  private stopping = false;
  private work: Promise<void> | undefined;
  constructor(private readonly store: UnifiedDataStore) {}
  enqueue(input: Record<string, unknown>): MigrationJob {
    if (this.stopping) throw new Error('migration_coordinator_stopping');
    const { idempotencyKey, ...args } = input;
    if (typeof idempotencyKey !== 'string') throw new Error('migration_idempotency_key_required');
    const job = this.store.enqueueMemoryMigration(args, idempotencyKey);
    this.recover();
    return job;
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
          const importer: (store: UnifiedDataStore, source: string, options: any) => Promise<MemoryImportResult> = job.args.collection === 'intelligence' ? importIntelligenceDirectory
            : job.args.collection === 'project-journal' ? importProjectJournal
            : job.args.collection === 'agent-runs' ? importAgentRuns
            : job.args.collection === 'project-growth' ? importProjectGrowth
            : importMemoryDirectory;
          const result = await importer(this.store, String(job.args.sourceRoot), {
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

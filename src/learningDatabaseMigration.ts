import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { UnifiedDataStore } from './db/unifiedDataStore';
import type { LegacyReviewTarget } from './db/unifiedDataStore';
import { archiveUnresolvedMigrationSource, isArchivableMigrationConflict, resolveLegacyProjectScope, type MemoryImportOptions, type MemoryImportResult } from './memoryDatabaseMigration';
import { isUsefulVerificationSignal } from './learningQuality.js';
import { reviewHash, legacyReviewSourceBody, ReviewManifest, ReviewSource } from './learningReview.js';
import { validateLearningReview } from './learningReviewApply.js';
import { sanitizeAttachmentScope } from './attachments.js';

/** Legacy review files are read only by the existing asynchronous migration owner. */
export async function importLearningReviewDirectory(store: UnifiedDataStore, sourceRoot: string, options: MemoryImportOptions = {}): Promise<MemoryImportResult> {
  if ((await fs.promises.lstat(sourceRoot)).isSymbolicLink()) throw new Error('migration_source_invalid');
  const root = await fs.promises.realpath(sourceRoot), identity = options.sourceIdentity || `learning-review:${root}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [] };
  try {
    const file = path.join(root, 'review.lock'), captured = await stableSource(file, root);
    let owner: any;
    try { owner = JSON.parse(captured.bytes.toString('utf8')); }
    catch { throw new Error('legacy_review_lock_invalid'); }
    if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.runId !== 'string') throw new Error('legacy_review_lock_invalid');
    result.retainedFiles.push('review.lock');
    if (store.historicalRunOwnerAlive({ agentPid: owner.pid, processBirth: owner.processStart ? `proc:${owner.processStart}` : '' })) {
      result.conflicts.push({ source: 'review.lock', error: 'legacy_review_owner_alive' });
      return result;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const capture = async (file: string): Promise<{ key: string; hash: string; bytes: Buffer }> => {
    const captured = await stableSource(file, root), key = path.relative(root, file).split(path.sep).join('/');
    result.originalBytes += captured.bytes.length;
    store.captureMigrationSource({ identity, key, hash: captured.hash }, captured.bytes, { mimeType: 'application/octet-stream', encoding: 'binary', pending: true });
    return { key, ...captured };
  };
  const captureSymlink = async (file: string): Promise<{ key: string; hash: string; bytes: Buffer }> => {
    const before = await fs.promises.lstat(file);
    if (!before.isSymbolicLink()) throw new Error('migration_source_invalid');
    const target = await fs.promises.readlink(file), bytes = Buffer.from(target, 'utf8');
    const after = await fs.promises.lstat(file);
    if (!after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || await fs.promises.readlink(file) !== target) throw new Error('migration_source_changed');
    const key = path.relative(root, file).split(path.sep).join('/'), source = { identity, key, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
    result.originalBytes += bytes.length;
    store.captureMigrationSource(source, bytes, { mimeType: 'application/vnd.solomap.symlink', encoding: 'utf8', pending: true, physicalKind: 'symlink' });
    return { key, hash: source.hash, bytes };
  };
  const json = (file: { bytes: Buffer }): any => {
    const text = file.bytes.toString('utf8');
    if (!Buffer.from(text).equals(file.bytes)) throw new Error('legacy_review_encoding_invalid');
    try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new Error('legacy_review_encoding_invalid'); }
  };
  const validateSource = (source: ReviewSource, projects: string[]): void => {
    legacyReviewSourceBody(source);
    if (source.projectPath && !projects.includes(source.projectPath)) throw new Error('legacy_review_source_invalid');
    for (const version of source.previousVersions || []) validateSource(version, projects);
  };
  const importCursor = async (): Promise<void> => {
    let cursor: Awaited<ReturnType<typeof capture>> | undefined;
    try {
      cursor = await capture(path.join(root, 'review-state.json'));
      const state = json(cursor), projects = Object.keys(options.projectScopes || {});
      if (state.schemaVersion !== 1 || (state.sources !== undefined && (!state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources)))
        || (state.deferredSources !== undefined && !Array.isArray(state.deferredSources)) || (state.unresolved !== undefined && !Array.isArray(state.unresolved))) throw new Error('legacy_review_cursor_invalid');
      for (const [id, value] of Object.entries(state.sources || {})) {
        const source = { ...(value as any), id };
        if (!/^[a-f0-9]{64}$/.test(source.hash || '') || (source.projectPath && !resolveLegacyProjectScope(options, source.projectPath))) throw new Error('legacy_review_cursor_invalid');
        if (source.content !== undefined || source.value !== undefined) validateSource(source, projects);
      }
      if ((await stableSource(path.join(root, cursor.key), root)).hash !== cursor.hash) throw new Error('source_changed_during_import');
      const imported = store.importLegacyLearningReviewCursor(identity, cursor.bytes, cursor.hash, projects);
      if (imported.unchanged) result.unchanged++; else result.imported++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        if (cursor) {
          const descriptor = { identity, key: cursor.key, hash: cursor.hash };
          store.captureMigrationSource(descriptor, cursor.bytes, { mimeType: 'application/json', encoding: 'utf8', error: message });
          if (!archiveUnresolvedMigrationSource(store, result, descriptor, cursor.bytes, message, options, { displaySource: 'review-state.json', mimeType: 'application/json' })) result.conflicts.push({ source: 'review-state.json', error: message });
        } else result.conflicts.push({ source: 'review-state.json', error: message });
      }
    }
  };
  let runs: fs.Dirent[] = [];
  try {
    const directory = path.join(root, 'runs'), info = await fs.promises.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('migration_source_invalid');
    runs = await fs.promises.readdir(directory, { withFileTypes: true });
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const entry of runs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    const runKey = `runs/${entry.name}`, run = path.join(root, runKey), files: Array<{ key: string; hash: string }> = [];
    if (!entry.isDirectory() || entry.isSymbolicLink()) { result.conflicts.push({ source: runKey, error: 'migration_source_invalid' }); continue; }
    try {
      const directories = [run];
      while (directories.length) {
        if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
        const directory = directories.shift()!;
        const info = await fs.promises.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || await fs.promises.realpath(directory) !== directory) throw new Error('migration_source_invalid');
        const entries = await fs.promises.readdir(directory, { withFileTypes: true });
        for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const file = path.join(directory, item.name);
          if (item.isSymbolicLink()) { const captured = await captureSymlink(file); files.push({ key: captured.key, hash: captured.hash }); }
          if (item.isDirectory()) directories.push(file);
          else if (item.isFile()) { const captured = await capture(file); files.push({ key: captured.key, hash: captured.hash }); }
          else if (item.isSymbolicLink()) { /* Captured as exact link metadata above. */ }
          else throw new Error('migration_source_invalid');
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      files.sort((a, b) => a.key.localeCompare(b.key));
      const read = (name: string): any => {
        const file = files.find(file => file.key === `${runKey}/${name}`);
        return file ? json(store.readMigrationSource(identity, file.key)) : null;
      };
      const manifest = read('manifest.json') as ReviewManifest;
      if (!manifest) throw new Error('legacy_review_manifest_missing');
      if (manifest.schemaVersion !== 1 || manifest.runId !== entry.name || typeof manifest.globalRoot !== 'string' || typeof manifest.globalPrompt !== 'string'
        || manifest.promptHash !== reviewHash(manifest.globalPrompt) || !Array.isArray(manifest.projects) || !Array.isArray(manifest.sources) || !Array.isArray(manifest.memory) || !Array.isArray(manifest.gaps)
        || manifest.projects.some(project => typeof project !== 'string' || !resolveLegacyProjectScope(options, project))) throw new Error('legacy_review_manifest_invalid');
      for (const source of manifest.sources) validateSource(source, manifest.projects);
      const references = read('result.json');
      const referencedFile = (value: unknown): string => {
        if (typeof value !== 'string') throw new Error('legacy_review_result_invalid');
        const flavor = value.includes('\\') || /^[A-Za-z]:/.test(value) ? path.win32 : path;
        const declared = flavor.join(manifest.globalRoot, 'maintenance', 'runs', manifest.runId);
        if (!flavor.isAbsolute(value) || ![flavor.resolve(run), flavor.resolve(declared)].includes(flavor.dirname(flavor.resolve(value)))) throw new Error('legacy_review_result_invalid');
        return flavor.basename(value);
      };
      const proposal = references?.proposalFile ? read(referencedFile(references.proposalFile)) : read('proposal.json');
      const application = read('application.json');
      const targets = application && proposal?.schemaVersion === 2 ? await legacySemanticReviewTargets(store, manifest, proposal, read(referencedFile(references?.checkFile)), application, read, options, root) : undefined;
      if (application && !targets && (application.schemaVersion !== 1 || !['applying', 'partial', 'applied', 'resumed', 'superseded'].includes(application.status)
        || typeof application.targetPrompt !== 'string' || application.targetPromptHash !== reviewHash(application.targetPrompt)
        || !proposal || application.proposalHash !== reviewHash(JSON.stringify(proposal)) || proposal.globalPrompt !== application.targetPrompt)) throw new Error('legacy_review_application_invalid');
      if (application) for (const key of ['sourceCursor', 'deferredSources']) {
        if (application[key] !== undefined && !Array.isArray(application[key])) throw new Error('legacy_review_application_sources_invalid');
        for (const source of application[key] || []) validateSource(source, manifest.projects);
      }
      for (const file of files) {
        const source = path.join(root, file.key);
        const current = (await fs.promises.lstat(source)).isSymbolicLink()
          ? crypto.createHash('sha256').update(Buffer.from(await fs.promises.readlink(source), 'utf8')).digest('hex')
          : (await stableSource(source, root)).hash;
        if (current !== file.hash) throw new Error('source_changed_during_import');
      }
      const imported = store.importLegacyLearningReview({ identity, runKey, manifest, proposal: proposal ? JSON.stringify(proposal) : null, application, ...(targets ? { targets } : {}), files });
      if (imported.unchanged) result.unchanged++; else result.imported++;
      for (const target of targets || []) if (target.afterError) result.conflicts.push({ source: `${runKey}#${target.key}`, error: target.afterError });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const file of files) {
        const captured = store.readMigrationSource(identity, file.key);
        const symlink = store.migrationSourceKind(identity, file.key) === 'symlink';
        store.captureMigrationSource({ identity, key: file.key, hash: captured.hash }, captured.bytes, { mimeType: symlink ? 'application/vnd.solomap.symlink' : 'application/octet-stream', encoding: symlink ? 'utf8' : 'binary', error: message, ...(symlink ? { physicalKind: 'symlink' as const } : {}) });
      }
      if (options.archiveUnresolved && files.length && isArchivableMigrationConflict(message)) {
        const archived = store.archiveMigrationSourceGroup(identity, runKey, files.map(file => file.key), { reason: message });
        result.archivedSources ||= [];
        result.archivedSources.push({ source: runKey, error: message, evidenceRef: `solomap://evidence/${archived.objectId}` });
        if (archived.unchanged) result.unchanged++; else result.imported++;
      } else if (!(options.archiveUnresolved && message === 'legacy_review_manifest_missing')) result.conflicts.push({ source: runKey, error: message });
    }
    options.onProgress?.(result); await new Promise<void>(resolve => setImmediate(resolve));
  }
  await importCursor();
  return result;
}

async function legacySemanticReviewTargets(store: UnifiedDataStore, manifest: ReviewManifest, proposal: any, review: any, application: any, read: (name: string) => any, options: MemoryImportOptions, sourceRoot: string): Promise<LegacyReviewTarget[]> {
  validateLearningReview(manifest, proposal, review, { historical: true });
  const before = read('before-application.json');
  if (!before || before.globalPrompt !== manifest.globalPrompt || JSON.stringify(before.memory) !== JSON.stringify(manifest.memory)
    || application.proposalHash !== reviewHash(JSON.stringify(proposal)) || !['applying', 'partial', 'applied', 'resumed', 'superseded'].includes(application.status)
    || !application.items || typeof application.items !== 'object' || Array.isArray(application.items)
    || !application.pending || typeof application.pending !== 'object' || Array.isArray(application.pending)
    || !Array.isArray(application.errors) || application.errors.some((error: unknown) => typeof error !== 'string')) throw new Error('legacy_review_application_invalid');
  for (const entry of manifest.memory) if (!entry || typeof entry.relativePath !== 'string' || typeof entry.content !== 'string' || entry.hash !== reviewHash(entry.content)) throw new Error('legacy_review_memory_invalid');
  const targets: LegacyReviewTarget[] = [];
  const status = (key: string, hash: string, item = hash): string => {
    if (application.pending[key] !== undefined && application.pending[key] !== hash) throw new Error('legacy_review_application_target_invalid');
    if (application.items[key] !== undefined && application.items[key] !== item) throw new Error('legacy_review_application_target_invalid');
    if (application.items[key] !== undefined && application.pending[key] === undefined) throw new Error('legacy_review_application_target_invalid');
    if (application.status === 'applied' && application.items[key] === undefined) throw new Error('legacy_review_application_target_invalid');
    return ['resumed', 'superseded'].includes(application.status) ? application.status : application.items[key] !== undefined ? 'applied' : application.status;
  };
  const prompt = proposal.globalPrompt?.value ?? manifest.globalPrompt;
  targets.push({ key: 'globalPrompt', kind: 'policy', scope: null, before: null, after: prompt, status: status('globalPrompt', reviewHash(prompt)), data: { kind: 'legacy_global_prompt', status: 'historical', content: prompt }, binding: null });
  for (const change of proposal.memoryChanges) {
    const original = manifest.memory.find(entry => entry.relativePath === change.path)?.content || '';
    const after = change.before ? original.replace(change.before, () => change.after) : change.after;
    let scope: string | null = null;
    if (change.path.startsWith('projects/')) {
      const project = manifest.projects.find(project => `projects/${sanitizeAttachmentScope(path.basename(project).toLowerCase()) || 'project'}.md` === change.path);
      scope = project ? resolveLegacyProjectScope(options, project) : null;
      if (!scope) throw new Error('project_scope_mapping_required');
    }
    const category = change.path === 'profile.md' ? 'profile' : change.path === 'operating-rules.md' ? 'rules' : ({ projects: 'project', decisions: 'decision', patterns: 'pattern', domains: 'domain', active: 'active', inbox: 'inbox' } as Record<string, string>)[change.path.split('/')[0]] || 'inbox';
    targets.push({ key: `memory:${change.path}`, kind: 'memory', scope, path: change.path, before: original, after, status: status(`memory:${change.path}`, reviewHash(after)), data: { category, title: path.basename(change.path, '.md'), status: 'captured', confidence: 0, content: after }, binding: { identity: `memory:${path.join(path.dirname(sourceRoot), 'memory')}`, key: change.path } });
  }
  for (const [index, lesson] of proposal.lessons.entries()) {
    const key = `lesson:${index}`, id = lesson.id || `lesson-${reviewHash(`${manifest.runId}:${index}`).slice(0, 24)}`;
    const scope = resolveLegacyProjectScope(options, lesson.projectPath);
    if (!scope) throw new Error('project_scope_mapping_required');
    if (application.pending[key] !== undefined && !/^[a-f0-9]{64}$/.test(application.pending[key])) throw new Error('legacy_review_application_target_invalid');
    const data = { status: 'historical', summary: lesson.summary, applies_when: lesson.appliesWhen, does_not_apply_when: lesson.doesNotApplyWhen, do_this: lesson.doThis, avoid_this: lesson.avoidThis, verification: lesson.verification,
      confidence: 0, legacy_lesson_id: id, semantic_review_json: { schemaVersion: 2, proposal: lesson, runId: manifest.runId, proposalHash: application.proposalHash, evidence: lesson.evidence, target: lesson.target || '', reason: lesson.reason, pendingHash: application.pending[key] ?? null } };
    const previous = read(`before-${id}.json`);
    const beforeData = previous ? lessonSource(Buffer.from(JSON.stringify(previous)), options) : null;
    if (beforeData) {
      const flavor = manifest.globalRoot.includes('\\') || /^[A-Za-z]:/.test(manifest.globalRoot) ? path.win32 : path;
      const files = [flavor.join(manifest.globalRoot, 'learning', 'candidates', `${id}.json`), path.join(path.dirname(sourceRoot), 'learning', 'candidates', `${id}.json`)];
      const source = manifest.sources.find(source => source.projectPath === lesson.projectPath && !!source.file && files.includes(source.file));
      let sourceBody: unknown;
      try { sourceBody = source ? JSON.parse(legacyReviewSourceBody(source)) : null; }
      catch { throw new Error('legacy_review_lesson_before_invalid'); }
      if (beforeData.id !== id || beforeData.scope !== scope || !source || JSON.stringify(sourceBody) !== JSON.stringify(previous)) throw new Error('legacy_review_lesson_before_invalid');
    }
    const binding = { identity: `learning:${path.join(path.dirname(sourceRoot), 'learning')}`, key: `candidates/${id}.json` }, targetStatus = status(key, application.pending[key], id);
    let after: string = JSON.stringify(lesson), afterSource: LegacyReviewTarget['afterSource'], afterError: string | undefined;
    if (application.items[key] !== undefined) {
      after = 'null';
      try {
        let captured = store.readMigrationSourceJsonVersion(binding.identity, binding.key, application.pending[key]);
        if (!captured) {
          const directory = path.join(path.dirname(sourceRoot), 'learning');
          try {
            const original = await stableSource(path.join(directory, binding.key), directory);
            store.captureMigrationSource({ ...binding, hash: original.hash }, original.bytes, { mimeType: 'application/json', encoding: 'utf8', pending: true });
            captured = store.readMigrationSourceJsonVersion(binding.identity, binding.key, application.pending[key]);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (captured) {
          const parsed = lessonSource(captured.bytes, options);
          const value = JSON.parse(captured.bytes.toString('utf8').replace(/^\uFEFF/, ''));
          if (parsed.id !== id || parsed.scope !== scope || reviewHash(JSON.stringify(value)) !== application.pending[key]) throw new Error('legacy_review_lesson_after_invalid');
          after = JSON.stringify(value);
          afterSource = { ...binding, hash: captured.hash, sourceRevision: captured.sourceRevision, jsonHash: application.pending[key] };
        } else afterError = 'legacy_review_lesson_after_missing';
      } catch (error) {
        afterError = error instanceof Error ? `legacy_review_lesson_after_invalid: ${error.message}` : 'legacy_review_lesson_after_invalid';
      }
    }
    targets.push({ key, kind: 'lesson', scope, legacyId: id, before: previous ? JSON.stringify(previous) : null, after, afterSource, afterError,
      ...(beforeData ? { beforeData: beforeData.data } : {}), status: targetStatus, data, binding });
  }
  const keys = new Set(targets.map(target => target.key));
  if ([...Object.keys(application.items), ...Object.keys(application.pending)].some(key => !keys.has(key))) throw new Error('legacy_review_application_target_invalid');
  return targets;
}

async function stableSource(file: string, boundary?: string): Promise<{ bytes: Buffer; hash: string }> {
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
  return { bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function lessonSource(bytes: Buffer, options: MemoryImportOptions): { id: string; scope: string; updatedAt: number; data: Record<string, unknown> } {
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

function learningEventSource(bytes: Buffer, options: MemoryImportOptions): { id: string; scope: string; data: Record<string, unknown> } {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('legacy_learning_event_encoding_invalid');
  let event: any;
  try { event = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('legacy_learning_event_invalid'); }
  if (!event || event.schemaVersion !== 1 || typeof event.id !== 'string' || !event.id || typeof event.projectPath !== 'string' || !path.isAbsolute(event.projectPath) || typeof event.summary !== 'string' || typeof event.sourceType !== 'string' || typeof event.sourceRef !== 'string' || !['completed', 'failed', 'verified', 'deviated', 'corrected', 'blocked', 'reused', 'partial', 'needs_confirmation'].includes(event.eventType) || !Array.isArray(event.evidenceRefs) || !Array.isArray(event.tags)) throw new Error('legacy_learning_event_invalid');
  const scope = resolveLegacyProjectScope(options, path.resolve(event.projectPath));
  if (!scope) throw new Error('project_scope_mapping_required');
  const occurredAt = typeof event.createdAt === 'string' ? Date.parse(event.createdAt) : Number.NaN;
  if (!Number.isFinite(occurredAt)) throw new Error('legacy_learning_event_timestamp_invalid');
  const verification = Array.isArray(event.metadata?.verification) ? event.metadata.verification.filter(isUsefulVerificationSignal) : [];
  return { id: event.id, scope, data: { event_type: event.eventType, summary: event.summary, occurred_at: occurredAt, source_type: event.sourceType, verification_signal: (event.eventType === 'verified' && verification.length > 0) || event.metadata?.recommendedStatus === 'closed' ? 1 : 0 } };
}

function learningDecisionSource(bytes: Buffer, options: MemoryImportOptions): { id: string; scope: string; eventId: string; candidateIds: string[]; updatedAt: number; data: Record<string, unknown> } {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('legacy_learning_decision_encoding_invalid');
  let entry: any;
  try { entry = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('legacy_learning_decision_invalid'); }
  if (!entry || entry.schemaVersion !== 1 || typeof entry.id !== 'string' || !entry.id || typeof entry.eventId !== 'string' || !entry.eventId || typeof entry.projectPath !== 'string' || !path.isAbsolute(entry.projectPath) || !['created', 'skipped'].includes(entry.decision) || typeof entry.reason !== 'string' || !Array.isArray(entry.candidateIds) || entry.candidateIds.some((id: unknown) => typeof id !== 'string' || !id) || !Array.isArray(entry.checkedSignals) || !Array.isArray(entry.evidenceRefs)) throw new Error('legacy_learning_decision_invalid');
  const scope = resolveLegacyProjectScope(options, path.resolve(entry.projectPath));
  if (!scope) throw new Error('project_scope_mapping_required');
  const createdAt = typeof entry.createdAt === 'string' ? Date.parse(entry.createdAt) : Number.NaN;
  const updatedAt = typeof entry.updatedAt === 'string' ? Date.parse(entry.updatedAt) : Number.NaN;
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) throw new Error('legacy_learning_decision_timestamp_invalid');
  return { id: entry.id, scope, eventId: entry.eventId, candidateIds: entry.candidateIds, updatedAt, data: { decision: entry.decision, reason: entry.reason, external_created_at: createdAt, external_updated_at: updatedAt } };
}

async function importLearningLedger(store: UnifiedDataStore, file: string, identity: string, options: MemoryImportOptions, result: MemoryImportResult): Promise<void> {
  const key = 'ledger/events.jsonl'; let captured: Awaited<ReturnType<typeof stableSource>> | undefined;
  try {
    captured = await stableSource(file); result.originalBytes += captured.bytes.length;
    store.captureMigrationSource({ identity, key, hash: captured.hash }, captured.bytes, { mimeType: 'application/x-ndjson', encoding: 'utf8', pending: true });
    const records: Array<{ start: number; end: number; line: number; id: string; scope: string; hash: string }> = [];
    const identities = new Map<string, Set<string>>(); const conflictStart = result.conflicts.length;
    for (let start = 0, line = 1; start < captured.bytes.length; line++) {
      if (options.shouldContinue && !options.shouldContinue()) { result.interrupted = true; return; }
      const newline = captured.bytes.indexOf(10, start); const end = newline < 0 ? captured.bytes.length : newline;
      const bytes = captured.bytes.subarray(start, end > start && captured.bytes[end - 1] === 13 ? end - 1 : end);
      if (bytes.toString('utf8').trim()) {
        try {
          const event = learningEventSource(bytes, options); const hash = crypto.createHash('sha256').update(bytes).digest('hex');
          const id = JSON.stringify([event.scope, event.id]); const hashes = identities.get(id) || new Set<string>(); hashes.add(hash); identities.set(id, hashes);
          records.push({ start, end: start + bytes.length, line, id: event.id, scope: event.scope, hash });
        } catch (error) { result.conflicts.push({ source: `${key}:${line}`, error: error instanceof Error ? error.message : String(error) }); }
      }
      start = end + 1;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const seen = new Set<string>();
    for (const record of records) {
      if (options.shouldContinue && !options.shouldContinue()) { result.interrupted = true; return; }
      const id = JSON.stringify([record.scope, record.id]);
      if (identities.get(id)!.size > 1) { result.conflicts.push({ source: `${key}:${record.line}`, error: 'migration_conflict: ambiguous_learning_event_identity' }); continue; }
      if (seen.has(id)) continue;
      seen.add(id);
      const bytes = captured.bytes.subarray(record.start, record.end);
      try {
        const event = learningEventSource(bytes, options);
        const imported = store.importLearningEventSource(event.scope, event.id, event.data, identity, bytes);
        if (imported.unchanged) result.unchanged++; else result.imported++;
      } catch (error) { result.conflicts.push({ source: `${key}:${record.line}`, error: error instanceof Error ? error.message : String(error) }); }
      options.onProgress?.(result); await new Promise<void>(resolve => setImmediate(resolve));
    }
    if ((await stableSource(file)).hash !== captured.hash) throw new Error('source_changed_during_import');
    if (result.conflicts.length === conflictStart) {
      store.captureMigrationSource({ identity, key, hash: captured.hash }, captured.bytes, { mimeType: 'application/x-ndjson', encoding: 'utf8' });
      store.markMigrationSourceImported(identity, key);
    } else {
      store.captureMigrationSource({ identity, key, hash: captured.hash }, captured.bytes, { mimeType: 'application/x-ndjson', encoding: 'utf8', error: 'learning_ledger_mapping_incomplete' });
      if (archiveUnresolvedMigrationSource(store, result, { identity, key, hash: captured.hash }, captured.bytes, 'learning_ledger_mapping_incomplete', options, { displaySource: key, mimeType: 'application/x-ndjson' })) {
        result.conflicts.splice(conflictStart);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (captured) store.captureMigrationSource({ identity, key, hash: captured.hash }, captured.bytes, { mimeType: 'application/x-ndjson', encoding: 'utf8', error: message });
    if (!captured || !archiveUnresolvedMigrationSource(store, result, { identity, key, hash: captured.hash }, captured.bytes, message, options, { displaySource: key, mimeType: 'application/x-ndjson' })) result.conflicts.push({ source: key, error: message });
  }
}

/** Only the explicit background importer reads these sources; normal consumers never do. */
export async function importLearningDirectory(store: UnifiedDataStore, sourceRoot: string, options: MemoryImportOptions = {}): Promise<MemoryImportResult> {
  if ((await fs.promises.lstat(sourceRoot)).isSymbolicLink()) throw new Error('migration_source_invalid');
  const root = await fs.promises.realpath(sourceRoot); const identity = options.sourceIdentity || `learning:${root}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [] };
  const sources: Array<{ file: string; key: string; hash: string; updatedAt: number; scope: string; id: string }> = [];
  const decisions: typeof sources = [];
  const pending = [root];
  while (pending.length) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    const directory = pending.shift()!;
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); const key = path.relative(root, file).split(path.sep).join('/');
      if (entry.isSymbolicLink()) { result.conflicts.push({ source: key, error: 'migration_source_invalid' }); continue; }
      if (entry.isDirectory()) { pending.push(file); continue; }
      if (entry.isFile() && key === 'ledger/events.jsonl') {
        await importLearningLedger(store, file, identity, options, result);
        if (result.interrupted) return result;
        continue;
      }
      if (!entry.isFile() || !/^(?:candidates|approved|rejected|candidate-decisions)\/[^/]+\.json$/.test(key)) { result.retainedFiles.push(key); continue; }
      let captured: Awaited<ReturnType<typeof stableSource>> | undefined;
      try {
        captured = await stableSource(file);
        const decision = key.startsWith('candidate-decisions/');
        const mapped = decision ? learningDecisionSource(captured.bytes, options) : lessonSource(captured.bytes, options);
        (decision ? decisions : sources).push({ file, key, hash: captured.hash, updatedAt: mapped.updatedAt, scope: mapped.scope, id: mapped.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (captured) {
          const descriptor = { identity, key, hash: captured.hash };
          store.captureMigrationSource(descriptor, captured.bytes, { mimeType: 'application/json', encoding: 'utf8', error: message });
          if (!archiveUnresolvedMigrationSource(store, result, descriptor, captured.bytes, message, options, { displaySource: key, mimeType: 'application/json' })) result.conflicts.push({ source: key, error: message });
        } else result.conflicts.push({ source: key, error: message });
      }
      result.originalBytes += captured?.bytes.length ?? 0;
      options.onProgress?.(result); await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  // Only references are sorted; one full source is retained in memory at a time.
  sources.sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id) || a.updatedAt - b.updatedAt || a.key.localeCompare(b.key));
  for (const source of sources) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    let captured: Awaited<ReturnType<typeof stableSource>> | undefined;
    try {
      captured = await stableSource(source.file);
      if (captured.hash !== source.hash) throw new Error('source_changed_during_import');
      const lesson = lessonSource(captured.bytes, options);
      const imported = store.importLessonSource(lesson.scope, lesson.id, lesson.data, { identity, key: source.key, hash: captured.hash }, lesson.updatedAt, captured.bytes);
      if (imported.unchanged) result.unchanged++; else result.imported++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (captured) {
        const descriptor = { identity, key: source.key, hash: captured.hash };
        store.captureMigrationSource(descriptor, captured.bytes, { mimeType: 'application/json', encoding: 'utf8', error: message });
        if (!archiveUnresolvedMigrationSource(store, result, descriptor, captured.bytes, message, options, { displaySource: source.key, mimeType: 'application/json', projectId: source.scope })) result.conflicts.push({ source: source.key, error: message });
      } else result.conflicts.push({ source: source.key, error: message });
    }
    options.onProgress?.(result); await new Promise<void>(resolve => setImmediate(resolve));
  }
  decisions.sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id) || a.updatedAt - b.updatedAt || a.key.localeCompare(b.key));
  for (const source of decisions) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    let captured: Awaited<ReturnType<typeof stableSource>> | undefined;
    try {
      captured = await stableSource(source.file);
      if (captured.hash !== source.hash) throw new Error('source_changed_during_import');
      const decision = learningDecisionSource(captured.bytes, options);
      const descriptor = { identity, key: source.key, hash: captured.hash };
      store.captureMigrationSource(descriptor, captured.bytes, { mimeType: 'application/json', encoding: 'utf8', pending: true });
      const imported = store.importLearningDecisionSource(decision.scope, decision.id, decision.eventId, decision.candidateIds, { ...decision.data, external_source: `${identity}/${source.key}` }, descriptor, captured.bytes);
      if (imported.unchanged) result.unchanged++; else result.imported++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (captured) {
        const descriptor = { identity, key: source.key, hash: captured.hash };
        store.captureMigrationSource(descriptor, captured.bytes, { mimeType: 'application/json', encoding: 'utf8', error: message });
        if (!archiveUnresolvedMigrationSource(store, result, descriptor, captured.bytes, message, options, { displaySource: source.key, mimeType: 'application/json', projectId: source.scope })) result.conflicts.push({ source: source.key, error: message });
      } else result.conflicts.push({ source: source.key, error: message });
    }
    options.onProgress?.(result); await new Promise<void>(resolve => setImmediate(resolve));
  }
  return result;
}

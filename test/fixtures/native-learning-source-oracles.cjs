const {createHash}=require('node:crypto'),{canonicalJson:canonical}=require('../../out/contentReferences.js');
const digest=value=>createHash('sha256').update(value).digest('hex');
const native={
    importLearningEventSource(projectId, legacyId, data, identity, bytes) {
        return this.transaction(() => {
            const key = canonical([projectId, legacyId]);
            const hash = digest(bytes);
            const source = { identity: `${identity}:event`, key, hash };
            const evidenceSource = { identity: `${identity}:event-evidence`, key, hash };
            const evidence = this.importObjectInternal({ kind: 'evidence', action: 'create', scope: projectId, idempotencyKey: `import-learning-evidence:${canonical(evidenceSource)}`, data: { type: 'legacy_learning_source', source_actor_id: this.actorId, content: Buffer.from(bytes).toString('utf8'), observed_at: Date.now() } }, evidenceSource);
            const binding = this.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [evidenceSource.identity, key])[0];
            if (!binding)
                throw new Error('migration_learning_source_missing');
            return this.importObjectInternal({ kind: 'learning_event', action: 'create', scope: projectId, idempotencyKey: `import-learning-event:${canonical(source)}`, data: { ...data, source_object_id: evidence.receipt?.objectId || String(binding.object_id), source_revision: evidence.receipt?.revision || Number(binding.imported_revision) } }, source);
        });
    },
    importLessonSource(projectId, legacyId, data, source, updatedAt, bytes) {
        return this.transaction(() => {
            const ids = typeof data.source_event_ids_json === 'string' ? JSON.parse(data.source_event_ids_json) : (data.source_event_ids_json || []);
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
                    const existing = current.data.event_refs;
                    const mapped = new Map(data.event_refs.map(ref => [ref.sourceId, ref]));
                    const resolved = existing.map(ref => ref.objectId === null ? mapped.get(ref.sourceId) || ref : ref);
                    if (canonical(resolved) !== canonical(existing)) {
                        const sourceOwned = current.revision === binding.imported_revision;
                        const receipt = this.writeMutation({ kind: 'lesson', action: 'patch', scope: projectId, objectId: current.objectId, expectedRevision: current.revision, idempotencyKey: `resolve-lesson-events:${source.identity}:${legacyId}:${current.revision}:${digest(canonical(resolved))}`, data: { event_refs: resolved } }, sourceOwned ? source : undefined, source);
                        if (sourceOwned)
                            this.db.run('UPDATE legacy_lesson_sources SET imported_revision=? WHERE source_identity=? AND project_id=? AND legacy_lesson_id=?', [receipt.revision, source.identity, projectId, legacyId]);
                        return { receipt, unchanged: false };
                    }
                }
                return this.importObjectInternal({ kind: 'lesson', action: 'create', scope: projectId, idempotencyKey: `import-lesson:${source.identity}:${source.key}:${source.hash}`, data }, source);
            }
            const current = binding ? this.readMetadata(String(binding.object_id)) : undefined;
            if (current && current.revision !== binding.imported_revision)
                throw new Error('migration_conflict: newer_database_revision');
            if (binding && updatedAt < Number(binding.source_updated_at))
                throw new Error('migration_conflict: older_learning_source_revision');
            if (binding && updatedAt === Number(binding.source_updated_at) && source.key !== binding.source_key)
                throw new Error('migration_conflict: ambiguous_learning_source_revision');
            this.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8' });
            const result = this.importObjectInternal({ kind: 'lesson', action: current ? 'patch' : 'create', scope: projectId, ...(current ? { objectId: current.objectId, expectedRevision: current.revision } : {}), idempotencyKey: `import-lesson:${source.identity}:${source.key}:${source.hash}:${current?.revision || 0}`, data }, source);
            if (result.receipt)
                this.db.run('INSERT INTO legacy_lesson_sources VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_identity,project_id,legacy_lesson_id) DO UPDATE SET imported_revision=excluded.imported_revision,source_updated_at=excluded.source_updated_at,source_key=excluded.source_key', [source.identity, projectId, legacyId, result.receipt.objectId, result.receipt.revision, updatedAt, source.key]);
            return result;
        });
    },
    importLearningDecisionSource(projectId, legacyId, eventId, candidateIds, data, source, bytes) {
        return this.transaction(() => {
            if (source.hash !== digest(bytes))
                throw new Error('migration_source_invalid');
            const physical = this.rows('SELECT object_id,source_hash,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
            if (physical?.object_id && physical.source_hash === source.hash) {
                const original = this.readMetadata(String(physical.object_id), Number(physical.imported_revision));
                if (original.kind !== 'lesson_decision' || original.projectId !== projectId)
                    throw new Error('migration_conflict: source_binding_mismatch');
                this.markMigrationSourceImported(source.identity, source.key);
                return { unchanged: true };
            }
            const key = canonical([projectId, legacyId]);
            const event = this.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [`${source.identity}:event`, canonical([projectId, eventId])])[0];
            if (!event)
                throw new Error('learning_event_mapping_required');
            const candidates = candidateIds.map(id => {
                const lesson = this.rows('SELECT object_id,imported_revision FROM legacy_lesson_sources WHERE source_identity=? AND project_id=? AND legacy_lesson_id=?', [source.identity, projectId, id])[0];
                if (!lesson)
                    throw new Error('learning_lesson_mapping_required');
                return { objectId: String(lesson.object_id), revision: Number(lesson.imported_revision) };
            });
            const decisionSource = { identity: `${source.identity}:decision`, key, hash: source.hash };
            const previous = this.rows('SELECT object_id,source_hash,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [decisionSource.identity, key])[0];
            if (previous?.object_id && previous.source_hash !== source.hash) {
                const current = this.readMetadata(String(previous.object_id));
                if (current.revision !== previous.imported_revision)
                    throw new Error('migration_conflict: newer_database_revision');
                if (Number(data.external_updated_at) < Number(current.data.external_updated_at))
                    throw new Error('migration_conflict: older_learning_source_revision');
                if (Number(data.external_updated_at) === Number(current.data.external_updated_at) && data.external_source !== current.data.external_source)
                    throw new Error('migration_conflict: ambiguous_learning_source_revision');
            }
            const evidenceSource = { identity: `${source.identity}:decision-evidence`, key, hash: source.hash };
            const evidence = this.importObjectInternal({ kind: 'evidence', action: 'create', scope: projectId, idempotencyKey: `import-learning-decision-evidence:${canonical(evidenceSource)}`, data: { type: 'legacy_learning_decision_source', source_actor_id: this.actorId, content: Buffer.from(bytes).toString('utf8'), observed_at: Date.now() } }, evidenceSource);
            const evidenceBinding = this.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [evidenceSource.identity, key])[0];
            const imported = this.importObjectInternal({ kind: 'lesson_decision', action: 'create', scope: projectId, idempotencyKey: `import-learning-decision:${canonical(decisionSource)}`, data: { ...data, actor_id: this.actorId, legacy_decision_id: legacyId, event_id: String(event.object_id), event_revision: Number(event.imported_revision), lesson_id: candidates[0]?.objectId || null, lesson_revision: candidates[0]?.revision || null, candidate_refs: candidates, source_object_id: evidence.receipt?.objectId || String(evidenceBinding.object_id), source_revision: evidence.receipt?.revision || Number(evidenceBinding.imported_revision) } }, decisionSource);
            const decisionBinding = this.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [decisionSource.identity, key])[0];
            this.db.run('UPDATE migration_items SET source_hash=?,object_id=?,imported_revision=? WHERE source_identity=? AND source_key=?', [source.hash, decisionBinding.object_id, decisionBinding.imported_revision, source.identity, source.key]);
            this.markMigrationSourceImported(source.identity, source.key);
            return imported;
        });
    },
    importObjectInternal(input, source, contentBindings = {}) {
        if (!source.identity || !source.key || !/^[a-f0-9]{64}$/.test(source.hash))
            throw new Error('migration_source_invalid');
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
            const current = bound;
            if (current.revision !== previous.imported_revision || current.kind !== input.kind || current.projectId !== input.scope) {
                this.db.run("UPDATE migration_items SET stage='conflict',error='newer_database_revision' WHERE source_identity=? AND source_key=?", [source.identity, source.key]);
                throw new Error('migration_conflict: newer_database_revision');
            }
            input = { ...input, action: 'patch', objectId: current.objectId, expectedRevision: current.revision, idempotencyKey: `${input.idempotencyKey}:after:${current.revision}` };
        }
        return { receipt: this.writeMutation(input, source, source, true, contentBindings), unchanged: false };
    }
};
function nativeLearningSource(store,method,...args){const previous=Object.getOwnPropertyDescriptor(store,'importObjectInternal');Object.defineProperty(store,'importObjectInternal',{value:native.importObjectInternal,writable:true,configurable:true});try{return native[method].apply(store,args);}finally{if(previous)Object.defineProperty(store,'importObjectInternal',previous);else delete store.importObjectInternal;}}
module.exports={native,nativeLearningSource};

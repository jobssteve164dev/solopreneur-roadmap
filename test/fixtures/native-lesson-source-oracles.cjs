const {createHash}=require('node:crypto'),{canonicalJson:canonical}=require('../../out/contentReferences.js'),runArtifactPolicy_js_1=require('../../out/runArtifactPolicy.js');
const digest=value=>createHash('sha256').update(value).digest('hex');
const native={
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
    },
    captureMigrationSource(source, bytes, options = {}) {
        return this.captureMigrationSourceContent(source, bytes, options);
    },
    captureMigrationSourceContent(source, bytes, options, binding) {
        if (!source.identity || !source.key || (binding ? this.rows('SELECT sha256 FROM contents WHERE id=?', [binding.contentId])[0]?.sha256 !== source.hash : source.hash !== digest(bytes)))
            throw new Error('migration_source_invalid');
        return this.transaction(() => {
            const previous = this.rows('SELECT migration_items.*,contents.sha256 AS captured_hash FROM migration_items LEFT JOIN contents ON contents.id=migration_items.source_content_id WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
            const sourceKind = options.physicalKind || (source.identity.startsWith('agent-runs:') ? options.sourceKind || (0, runArtifactPolicy_js_1.runArtifactStorageKind)(source.key) : 'source');
            const classificationChanged = options.error ? previous?.stage !== 'unmapped' || previous.error !== options.error : previous?.stage === 'unmapped' && !options.pending;
            if (previous && previous.source_kind !== sourceKind)
                this.db.run('UPDATE migration_items SET source_kind=? WHERE source_identity=? AND source_key=?', [sourceKind, source.identity, source.key]);
            const contentId = binding?.contentId || this.putContent(bytes, options.mimeType || 'application/octet-stream', options.encoding || 'binary');
            if (previous?.captured_hash === source.hash && !classificationChanged) {
                if (previous.source_content_id !== contentId)
                    this.db.run('UPDATE migration_items SET source_content_id=? WHERE source_identity=? AND source_key=?', [contentId, source.identity, source.key]);
                const request = this.rows('SELECT id,committed_sequence FROM requests WHERE id=?', [previous.source_capture_request_id])[0];
                if (!request)
                    throw new Error('migration_capture_receipt_missing');
                return { unchanged: true, requestId: String(request.id), committedSequence: Number(request.committed_sequence), stage: String(previous.stage) };
            }
            const capturePrefix = `migration-capture:${canonical([source.identity, source.key])}:`;
            const captureUpper = `${capturePrefix.slice(0, -1)};`;
            if (this.captureHeadsReplayRevision !== this.db.changesetReplayRevision) {
                this.resolvedCaptureHeads.clear();
                this.captureHeadsReplayRevision = this.db.changesetReplayRevision;
            }
            const head = this.rows('SELECT revision,resolved FROM content_lifecycle_capture_heads WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
            const imported = this.rows('SELECT revision FROM content_lifecycle_capture_imports WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
            let revision = Math.max(Number(previous?.source_capture_revision || 0), Number(head?.revision || 0), Number(imported?.revision || 0));
            const verifiedFloor = this.resolvedCaptureHeads.get(capturePrefix);
            let verifiedRevision = Number(head?.revision || 0);
            if (Number(head?.resolved) !== 1 || verifiedFloor === undefined || verifiedFloor > verifiedRevision) {
                // A persisted flag alone cannot prove imported or replayed history was checked.
                const recorded = this.rows(`SELECT COALESCE(MAX(CAST(substr(requests.idempotency_key,length(?)+1) AS INTEGER)),0) AS revision
          FROM actors CROSS JOIN requests CROSS JOIN events
          WHERE requests.actor_id=actors.id AND requests.idempotency_key>=? AND requests.idempotency_key<?
          AND events.sequence=requests.committed_sequence AND requests.status='committed' AND events.request_id=requests.id
          AND events.actor_id=requests.actor_id AND events.subject_id IS NULL AND events.kind='migration.source_captured'`, [capturePrefix, capturePrefix, captureUpper])[0];
                revision = Math.max(revision, Number(recorded.revision));
                this.db.run(`INSERT INTO content_lifecycle_capture_heads VALUES(?,?,?,1)
          ON CONFLICT(source_identity,source_key) DO UPDATE SET revision=MAX(revision,excluded.revision),resolved=1`, [source.identity, source.key, revision]);
                verifiedRevision = revision;
            }
            this.resolvedCaptureHeads.delete(capturePrefix);
            if (this.resolvedCaptureHeads.size >= 1024)
                this.resolvedCaptureHeads.delete(this.resolvedCaptureHeads.keys().next().value);
            // If this transaction rolls back a raised head, this floor forces revalidation.
            this.resolvedCaptureHeads.set(capturePrefix, verifiedRevision);
            if (this.rows('SELECT 1 FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, `${capturePrefix}${revision + 1}`])[0]) {
                revision = Math.max(revision, Number(this.rows(`SELECT COALESCE(MAX(CAST(substr(idempotency_key,length(?)+1) AS INTEGER)),0) AS revision
          FROM requests WHERE actor_id=? AND idempotency_key>=? AND idempotency_key<?`, [capturePrefix, this.actorId, capturePrefix, captureUpper])[0].revision));
            }
            if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
                throw new Error('migration_capture_revision_invalid');
            const error = options.error || (options.pending && previous?.stage === 'unmapped' ? String(previous.error || '') : null);
            const stage = error ? 'unmapped' : 'captured';
            const descriptorValue = { source, contentId, revision: revision + 1, stage, error };
            const descriptor = canonical(descriptorValue);
            const requestId = crypto.randomUUID();
            const nextKey = `${capturePrefix}${revision + 1}`;
            this.db.run('INSERT INTO requests(actor_id,idempotency_key,id,input_hash,status) VALUES(?,?,?,?,?)', [this.actorId, nextKey, requestId, digest(descriptor), 'pending']);
            this.db.run('INSERT INTO migration_items(source_identity,source_key,source_hash,stage,error,source_content_id,source_capture_revision,source_capture_request_id,source_kind) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_identity,source_key) DO UPDATE SET source_content_id=excluded.source_content_id,source_capture_revision=excluded.source_capture_revision,source_capture_request_id=excluded.source_capture_request_id,source_kind=excluded.source_kind,stage=excluded.stage,error=excluded.error', [source.identity, source.key, source.hash, stage, error, contentId, revision + 1, requestId, sourceKind]);
            const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM events')[0].next);
            const eventContent = this.putStructuredContent(descriptorValue);
            this.db.run('INSERT INTO events VALUES(?,?,NULL,?,?,?,?,?)', [crypto.randomUUID(), sequence, this.actorId, 'migration.source_captured', eventContent, Date.now(), requestId]);
            const resultContent = this.putStructuredContent({ requestId, committedSequence: sequence });
            this.db.run("UPDATE requests SET status='committed',result_content_id=?,committed_sequence=? WHERE id=?", [resultContent, sequence, requestId]);
            if (source.identity.startsWith('learning:') && /^candidates\/[^/\\]+\.json$/.test(source.key)) {
                if (binding) {
                    if (binding.jsonHash === undefined)
                        throw new Error('migration_source_json_version_missing');
                    this.db.run('INSERT INTO migration_source_json_versions VALUES(?,?,?,?,?,?,?)', [source.identity, source.key, revision + 1, contentId, source.hash, binding.jsonHash, requestId]);
                }
                else
                    this.recordMigrationJsonVersion(source, revision + 1, contentId, requestId, Buffer.from(bytes));
                const head = this.rows('SELECT through_revision FROM migration_source_json_heads WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
                if (Number(head?.through_revision || 0) === revision)
                    this.db.run('INSERT INTO migration_source_json_heads VALUES(?,?,?) ON CONFLICT(source_identity,source_key) DO UPDATE SET through_revision=excluded.through_revision', [source.identity, source.key, revision + 1]);
            }
            return { unchanged: false, requestId, committedSequence: sequence, stage };
        });
    },
    recordMigrationJsonVersion(source, revision, contentId, requestId, bytes) {
        let jsonHash = null;
        try {
            const text = bytes.toString('utf8');
            if (Buffer.from(text).equals(bytes))
                jsonHash = digest(JSON.stringify(JSON.parse(text.replace(/^\uFEFF/, ''))));
        }
        catch { /* Invalid original bytes remain retained and cannot match a JSON after-image. */ }
        this.db.run('INSERT INTO migration_source_json_versions VALUES(?,?,?,?,?,?,?)', [source.identity, source.key, revision, contentId, source.hash, jsonHash, requestId]);
    }
};
exports.nativeLessonSource=function nativeLessonSource(store,...args){
 const names=['importObjectInternal','captureMigrationSource','captureMigrationSourceContent','recordMigrationJsonVersion'],before=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(store,name)]));
 try{for(const name of names)Object.defineProperty(store,name,{configurable:true,writable:true,value:native[name]});return native.importLessonSource.apply(store,args);}
 finally{for(const name of names){const descriptor=before.get(name);if(descriptor)Object.defineProperty(store,name,descriptor);else delete store[name];}}
};

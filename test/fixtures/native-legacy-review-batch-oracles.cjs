const crypto=require('node:crypto'),{canonicalJson:canonical}=require('../../out/contentReferences.js'),learningReview_js_1=require('../../out/learningReview.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const native={
    importLegacyLearningReview(input) {
        return this.transaction(() => {
            const sourceContents = {};
            const compact = (source) => {
                const body = (0, learningReview_js_1.legacyReviewSourceBody)(source);
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
            const markFiles = () => {
                for (const file of input.files) {
                    if (afterErrors)
                        this.markMigrationSourceConflict(input.identity, file.key, afterErrors);
                    else
                        this.markMigrationSourceImported(input.identity, file.key);
                }
            };
            const imported = this.importObjectInternal({ kind: 'review_batch', action: 'create', scope: null, idempotencyKey: `legacy-review:${canonical(batchSource)}`, data: { input_cursor: 0, input_hash: digest(JSON.stringify(input.manifest)), proposal_content: input.proposal, review_content: JSON.stringify(saved), status: input.application?.status || 'interrupted' } }, batchSource);
            if (imported.unchanged) {
                markFiles();
                return { unchanged: true };
            }
            const bound = this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [batchSource.identity, batchSource.key])[0];
            const batchId = imported.receipt?.objectId || String(bound.object_id);
            this.db.run('INSERT INTO legacy_learning_review_controls VALUES(?,?,?,?) ON CONFLICT(batch_id) DO UPDATE SET input_content_id=excluded.input_content_id', [batchId, this.readMetadata(batchId).data.review_content_id, input.identity, input.runKey]);
            if (input.application) {
                const application = input.application;
                const file = input.files.find(item => item.key === `${input.runKey}/application.json`);
                const targets = input.targets || [{ key: 'globalPrompt', kind: 'policy', scope: null, data: { kind: 'legacy_global_prompt', status: 'historical', content: application.targetPrompt }, before: null, after: application.targetPrompt, status: application.status, binding: null }];
                for (const entry of targets) {
                    const key = input.targets ? `${input.runKey}#${entry.key}` : input.runKey;
                    const targetSource = { identity: `${input.identity}:target`, key, hash: input.targets ? digest(canonical(entry.data)) : digest(application.targetPrompt) };
                    const target = this.importObjectInternal({ kind: entry.kind, action: 'create', scope: entry.scope, idempotencyKey: `legacy-review:${canonical(targetSource)}`, data: entry.data }, targetSource);
                    const targetId = target.receipt?.objectId || String(this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [targetSource.identity, targetSource.key])[0].object_id);
                    const snapshot = this.readMetadata(targetId);
                    if (entry.kind !== 'policy' && snapshot.archivedAt === null)
                        this.writeMutation({ kind: entry.kind, action: 'archive', scope: entry.scope, objectId: targetId, expectedRevision: snapshot.revision, idempotencyKey: `legacy-review-target:${canonical(targetSource)}:archive`, data: {} }, targetSource);
                    const applicationSource = { identity: `${input.identity}:application`, key, hash: input.targets ? digest(canonical({ journal: file.hash, afterSource: entry.afterSource || null, afterError: entry.afterError || null })) : file.hash };
                    this.importObjectInternal({ kind: 'application', action: 'create', scope: entry.scope, idempotencyKey: `legacy-review:${canonical(applicationSource)}`, data: { review_id: batchId, target_object_id: targetId, expected_revision: 0, before_content: entry.before, after_content: entry.after, status: entry.status, applied_revision: null } }, applicationSource);
                }
            }
            for (const file of input.files) {
                const captured = this.readMigrationSource(input.identity, file.key);
                if (captured.hash !== file.hash)
                    throw new Error('legacy_review_artifact_changed');
                const source = { identity: input.identity, key: file.key, hash: file.hash };
                const artifact = this.importObjectInternal({ kind: 'evidence', action: 'create', scope: null, idempotencyKey: `legacy-review-artifact:${canonical(source)}`, data: { type: 'legacy_review_artifact', source_actor_id: this.actorId, observed_at: 0, content: { encoding: 'base64', data: captured.bytes.toString('base64'), mimeType: 'application/octet-stream' } } }, source);
                const artifactId = artifact.receipt?.objectId || String(this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [input.identity, file.key])[0].object_id);
                const batch = this.readMetadata(batchId);
                if (!batch.relations.some(link => link.relation === 'source' && link.target === artifactId))
                    this.link({ source: batchId, relation: 'source', target: artifactId, expectedRevision: batch.revision, idempotencyKey: `legacy-review-artifact-link:${canonical(batchSource)}:${artifactId}` });
            }
            this.db.run('UPDATE migration_items SET imported_revision=? WHERE source_identity=? AND source_key=?', [this.readMetadata(batchId).revision, batchSource.identity, batchSource.key]);
            markFiles();
            return { unchanged: false };
        });
    },
    link(input) {
        const allowed = ['parent', 'source', 'evidence', 'depends_on', 'adopts', 'supersedes', 'feedback'];
        if (!allowed.includes(input.relation))
            throw new Error('unknown_relation');
        return this.recordMutation(input, input.idempotencyKey, 'link', () => {
            const source = this.current(input.source);
            const target = this.current(input.target);
            if (source.revision !== input.expectedRevision)
                throw new Error('revision_conflict');
            if (source.objectId === target.objectId)
                throw new Error('self_relation');
            if (source.projectId !== target.projectId && target.projectId !== null)
                throw new Error('scope_mismatch');
            if (input.relation === 'depends_on' && (source.kind !== 'roadmap_node' || target.kind !== 'roadmap_node'))
                throw new Error('relation_kind_mismatch');
            if (input.relation === 'parent' && (source.kind !== 'conversation' || target.kind !== 'conversation'))
                throw new Error('relation_kind_mismatch');
            if (input.relation === 'evidence' && target.kind !== 'evidence')
                throw new Error('relation_kind_mismatch');
            this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [input.source, input.relation, input.target]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), source.objectId]);
            return this.current(source.objectId);
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
exports.nativeLegacyReviewBatch=function nativeLegacyReviewBatch(store,...args){const before=new Map();for(const name of ['link','importObjectInternal']){before.set(name,Object.getOwnPropertyDescriptor(store,name));Object.defineProperty(store,name,{value:native[name],writable:true,configurable:true});}try{return native.importLegacyLearningReview.apply(store,args);}finally{for(const [name,descriptor]of before){if(descriptor)Object.defineProperty(store,name,descriptor);else delete store[name];}}};

// Exact complete Native archive methods captured before archive publication migration.
const crypto=require('node:crypto'),{canonicalJson:canonical}=require('../../out/contentReferences.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
// Native archiveMigrationSource 2243B SHA256 358d5d8e6799a57c2028188fc41e469bf66a6885ebe8ec9e273fa7982573771c
function archiveMigrationSource(source, bytes, input) {
        if (!input.reason.trim() || source.hash !== digest(bytes))
            throw new Error('migration_archive_invalid');
        return this.transaction(() => {
            const captured = this.rows(`SELECT migration_items.source_content_id,migration_items.source_capture_revision,contents.sha256
        FROM migration_items JOIN contents ON contents.id=migration_items.source_content_id
        WHERE source_identity=? AND source_key=?`, [source.identity, source.key])[0];
            if (!captured || String(captured.sha256) !== source.hash)
                throw new Error('migration_archive_source_mismatch');
            this.assertContentIntegrity(String(captured.source_content_id));
            const reasonHash = digest(input.reason);
            const archiveSource = { identity: `migration-archive:${source.identity}`, key: `${source.key}#${reasonHash}`, hash: source.hash };
            const imported = this.importObjectInternal({ kind: 'evidence', action: 'create', scope: input.projectId || null,
                idempotencyKey: `archive-migration-source:${canonical(archiveSource)}`, data: {
                    type: `legacy_migration_source:${source.identity}/${source.key}#${input.reason}`,
                    source_actor_id: this.actorId,
                    observed_at: Number.isFinite(input.observedAt) ? Number(input.observedAt) : Date.now(),
                    source_revision: Number(captured.source_capture_revision)
                } }, archiveSource, { content: String(captured.source_content_id) });
            const binding = this.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [archiveSource.identity, archiveSource.key])[0];
            if (!binding)
                throw new Error('migration_archive_receipt_missing');
            this.markMigrationSourceImported(source.identity, source.key);
            const receipt = imported.receipt || { requestId: '', objectId: String(binding.object_id), revision: Number(binding.imported_revision), committedSequence: 0, status: 'committed', pendingEffects: [] };
            return { ...receipt, unchanged: imported.unchanged };
        });
    }
// Native archiveMigrationSourceGroup 2478B SHA256 cd7581f1fea15252a1ae2f146fe97809585a16e7d969a619aed9fb1139718a57
function archiveMigrationSourceGroup(identity, groupKey, keys, input) {
        if (!identity || !groupKey || !input.reason.trim() || !keys.length)
            throw new Error('migration_archive_invalid');
        return this.transaction(() => {
            const sources = [...new Set(keys)].sort().map(key => {
                const captured = this.readMigrationSource(identity, key);
                const archived = this.archiveMigrationSource({ identity, key, hash: captured.hash }, captured.bytes, {
                    reason: input.reason,
                    mimeType: this.migrationSourceKind(identity, key) === 'symlink' ? 'application/vnd.solomap.symlink' : 'application/octet-stream',
                    projectId: input.projectId,
                    observedAt: input.observedAt
                });
                return { key, hash: captured.hash, bytes: captured.bytes.length, sourceRevision: captured.sourceRevision, evidenceRef: `solomap://evidence/${archived.objectId}` };
            });
            const content = canonical({ schemaVersion: 1, sourceIdentity: identity, groupKey, reason: input.reason, sources });
            const archiveSource = { identity: `migration-archive-group:${identity}`, key: groupKey, hash: digest(content) };
            const imported = this.importObjectInternal({ kind: 'evidence', action: 'create', scope: input.projectId || null,
                idempotencyKey: `archive-migration-source-group:${canonical(archiveSource)}`, data: {
                    type: `legacy_migration_group:${identity}/${groupKey}`,
                    source_actor_id: this.actorId,
                    content,
                    observed_at: Number.isFinite(input.observedAt) ? Number(input.observedAt) : Date.now()
                } }, archiveSource);
            const binding = this.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [archiveSource.identity, archiveSource.key])[0];
            if (!binding)
                throw new Error('migration_archive_receipt_missing');
            for (const source of sources)
                this.markMigrationSourceImported(identity, source.key);
            const receipt = imported.receipt || { requestId: '', objectId: String(binding.object_id), revision: Number(binding.imported_revision), committedSequence: 0, status: 'committed', pendingEffects: [] };
            return { ...receipt, unchanged: imported.unchanged };
        });
    }
// Native importObjectInternal 1873B SHA256 c5dcdf0388599a9f2af39c897546b92e9533384a044f89e81a7d2eb83c329273
function importObjectInternal(input, source, contentBindings = {}) {
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
// Native markMigrationSourceImported 722B SHA256 2d87e0709fbf7aa09334c9f649bc637e51a4a60fc497691f2a60c1bc22f7af28
function markMigrationSourceImported(identity, key) {
        this.db.run("UPDATE migration_items SET stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [identity, key]);
        if (!/^(project-journal|project-growth):/.test(identity))
            return;
        const sources = this.equivalentMigrationSources(identity, key);
        const current = sources.find(source => source.identity === identity);
        for (const source of sources)
            if (source.identity !== identity && current && source.hash === current.hash) {
                this.db.run("UPDATE migration_items SET stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [source.identity, key]);
            }
    }
// Native readMigrationSource 547B SHA256 604f7b2c8c5cdf92c61866ec0aa909d20a924e220f3de06ccf02afa5a7c79735
function readMigrationSource(identity, key) {
        const item = this.rows('SELECT migration_items.*,contents.sha256 AS captured_hash FROM migration_items JOIN contents ON contents.id=migration_items.source_content_id WHERE source_identity=? AND source_key=?', [identity, key])[0];
        if (!item)
            throw new Error('migration_source_missing');
        return { bytes: this.content(String(item.source_content_id)), hash: String(item.captured_hash), sourceRevision: Number(item.source_capture_revision), stage: String(item.stage) };
    }
// Native migrationSourceKind 215B SHA256 914af0ba8ab39a02672fa4e8c58f1635ad70e40cc4d30d498294382bac49afef
function migrationSourceKind(identity, key) {
        return String(this.rows('SELECT source_kind FROM migration_items WHERE source_identity=? AND source_key=?', [identity, key])[0]?.source_kind || 'unclassified');
    }
function callNative(store,method,args){
  const methods={archiveMigrationSource,archiveMigrationSourceGroup,importObjectInternal,markMigrationSourceImported,readMigrationSource,migrationSourceKind},previous=new Map(Object.keys(methods).map(key=>[key,Object.getOwnPropertyDescriptor(store,key)]));
  for(const [key,value] of Object.entries(methods))Object.defineProperty(store,key,{value,writable:true,configurable:true});
  try{return methods[method].apply(store,args);}finally{for(const [key,descriptor] of previous)if(descriptor)Object.defineProperty(store,key,descriptor);else delete store[key];}
}
exports.archiveNative=(store,group,...args)=>callNative(store,group?'archiveMigrationSourceGroup':'archiveMigrationSource',args);

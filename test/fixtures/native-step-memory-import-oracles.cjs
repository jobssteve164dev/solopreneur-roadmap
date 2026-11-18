// Exact original Native import and save helper, for transaction/history oracles only.
// Method bodies and hashes: native-step-memory-import-oracles-v142.json in task evidence.
const crypto=require('node:crypto');
const stepMemorySource_js_1=require('../../out/stepMemorySource.js');
const {canonicalJson:canonical}=require('../../out/contentReferences.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

// Original method SHA256 ee640762f8e106d47ae3f18198af7de797bd7ab5b9d495bf9389cd612bb64a6b
function importStepMemorySource(projectId, input) {
        const { nodeId, source, bytes, format } = input;
        if (!nodeId || !source.key || !source.identity || source.hash !== digest(bytes) || !['json', 'md'].includes(format))
            throw new Error('step_memory_source_invalid');
        return this.transaction(() => {
            const existing = this.rows('SELECT * FROM step_memory_sources WHERE project_id=? AND node_key=? AND source_key=?', [projectId, nodeId, source.key])[0];
            if (existing?.source_hash === source.hash) {
                this.db.run("UPDATE migration_items SET source_hash=?,object_id=?,imported_revision=1,stage='imported',error=NULL WHERE source_identity=? AND source_key=? AND (stage<>'imported' OR source_hash<>?)", [source.hash, existing.object_id, source.identity, source.key, source.hash]);
                return { unchanged: true };
            }
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const parsed = (0, stepMemorySource_js_1.parseStepMemorySource)(text, format);
            const descriptor = { projectId, nodeId, source, format };
            const key = `step-memory-source:${canonical([projectId, nodeId, source.key, existing?.object_id || null, source.hash])}`;
            const sourceReceipt = this.recordMutation(descriptor, key, 'step_memory_source', () => {
                const id = crypto.randomUUID();
                const now = Date.now();
                this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [id, 'evidence', projectId, 1, now, now]);
                this.db.run('INSERT INTO evidence(id,project_id,type,source_actor_id,content_id,observed_at) VALUES(?,?,?,?,?,?)', [id, projectId, 'step_memory_source', this.actorId, this.putContent(bytes, format === 'json' ? 'application/json' : 'text/markdown', 'utf8'), now]);
                return this.current(id);
            });
            this.db.run('INSERT INTO step_memory_sources VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,node_key,source_key) DO UPDATE SET object_id=excluded.object_id,source_hash=excluded.source_hash,entry_count=excluded.entry_count,format=excluded.format', [projectId, nodeId, source.key, sourceReceipt.objectId, source.hash, parsed.entries.length, format]);
            const current = this.readStepMemory(projectId, nodeId, { includeEntries: false });
            const data = { ...current?.data };
            const owned = this.rows("SELECT field FROM step_memory_field_origins WHERE project_id=? AND node_key=? AND origin='import' AND source_key=?", [projectId, nodeId, source.key]);
            for (const previous of owned)
                if (!Object.prototype.hasOwnProperty.call(parsed.metadata, String(previous.field))) {
                    delete data[String(previous.field)];
                    this.db.run('DELETE FROM step_memory_field_origins WHERE project_id=? AND node_key=? AND field=?', [projectId, nodeId, previous.field]);
                }
            for (const [field, value] of Object.entries(parsed.metadata)) {
                const origin = this.rows('SELECT * FROM step_memory_field_origins WHERE project_id=? AND node_key=? AND field=?', [projectId, nodeId, field])[0];
                if (origin?.origin === 'user' || (origin?.origin === 'import' && origin.source_key !== source.key) || (!origin && Object.prototype.hasOwnProperty.call(data, field)))
                    continue;
                Object.defineProperty(data, field, { value, enumerable: true, writable: true, configurable: true });
                this.db.run("INSERT INTO step_memory_field_origins VALUES(?,?,?,'import',?,?) ON CONFLICT(project_id,node_key,field) DO UPDATE SET origin='import',source_key=excluded.source_key,source_hash=excluded.source_hash", [projectId, nodeId, field, source.key, source.hash]);
            }
            this.recordMutation(descriptor, `${key}:projection`, 'step_memory', () => this.saveStepMemoryRevision(projectId, nodeId, data));
            this.db.run("UPDATE migration_items SET source_hash=?,object_id=?,imported_revision=?,stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [source.hash, sourceReceipt.objectId, sourceReceipt.revision, source.identity, source.key]);
            return { unchanged: false };
        });
    }

// Original method SHA256 4beaa6305e0ed76ebe22acfb85158cac602d0f2aa2be0e5bb6b612207579218a
function saveStepMemoryRevision(projectId, nodeId, data, sourceObjectId) {
        const current = this.rows('SELECT r.* FROM project_step_memory c JOIN project_step_memory_revisions r USING(project_id,node_key,revision) WHERE c.project_id=? AND c.node_key=?', [projectId, nodeId])[0];
        const revision = Number(current?.revision || 0) + 1;
        const contentId = data === undefined && current ? String(current.content_id) : this.putStructuredContent(data || {});
        const cursor = this.stepHandoffSequence();
        const objectId = crypto.randomUUID();
        const now = Date.now();
        const sources = this.rows('SELECT * FROM step_memory_sources WHERE project_id=? AND node_key=? ORDER BY source_key', [projectId, nodeId]).map(row => ({ key: String(row.source_key), objectId: String(row.object_id), revision: 1, sha256: String(row.source_hash), entryCount: Number(row.entry_count), format: row.format }));
        const sameMetadata = current?.content_id === contentId;
        const metadataObjectId = sameMetadata ? String(current.metadata_object_id) : objectId;
        const snapshot = { nodeId, revision, ...(sameMetadata ? { dataRef: { objectId: metadataObjectId, revision: 1 } } : { data: data || {} }), handoffCursor: cursor, sources,
            ...(current ? { previousRef: { objectId: String(current.object_id), revision: 1 } } : {}),
            ...(sourceObjectId ? { latestHandoffRef: { objectId: sourceObjectId, revision: this.readMetadata(sourceObjectId).revision } } : {}) };
        this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [objectId, 'evidence', projectId, 1, now, now]);
        this.db.run('INSERT INTO evidence(id,project_id,type,source_actor_id,content_id,observed_at,source_revision) VALUES(?,?,?,?,?,?,?)', [objectId, projectId, 'step_memory', this.actorId, this.putStructuredContent(snapshot), now, revision]);
        const evidence = { objectId };
        this.db.run('INSERT INTO project_step_memory VALUES(?,?,?,?) ON CONFLICT(project_id,node_key) DO UPDATE SET content_id=excluded.content_id,revision=excluded.revision', [projectId, nodeId, contentId, revision]);
        if (!sameMetadata)
            this.db.run('INSERT INTO project_step_memory_state VALUES(?,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1', [projectId]);
        this.db.run('INSERT INTO project_step_memory_revisions VALUES(?,?,?,?,?,?,?,?)', [projectId, nodeId, revision, contentId, cursor, evidence.objectId, metadataObjectId, this.putStructuredContent(sources)]);
        if (sourceObjectId)
            this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [evidence.objectId, 'source', sourceObjectId]);
        if (current)
            this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [evidence.objectId, 'previous', current.object_id]);
        if (sameMetadata)
            this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [evidence.objectId, 'metadata', metadataObjectId]);
        for (const source of sources)
            this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [evidence.objectId, 'source', source.objectId]);
        return this.current(evidence.objectId);
    }

function withNativeStepMemoryHelpers(store,work){
  const original=Object.getOwnPropertyDescriptor(store,'saveStepMemoryRevision');
  Object.defineProperty(store,'saveStepMemoryRevision',{value:saveStepMemoryRevision,writable:true,configurable:true});
  try{return work();}
  finally{if(original)Object.defineProperty(store,'saveStepMemoryRevision',original);else delete store.saveStepMemoryRevision;}
}
exports.withNativeStepMemoryHelpers=withNativeStepMemoryHelpers;
exports.importStepMemorySourceNative=(store,projectId,input)=>withNativeStepMemoryHelpers(store,()=>importStepMemorySource.call(store,projectId,input));
exports.saveStepMemoryRevisionNative=(store,...args)=>saveStepMemoryRevision.call(store,...args);

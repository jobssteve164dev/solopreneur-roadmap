// Exact original Native methods retained only for historical transaction oracles.
// Method bodies and hashes: native-step-memory-oracles-v129.json in task evidence.
const crypto=require('node:crypto');
// Original method SHA256 e02fa939c82dd775f3de7ad4e9d205ad37983064a8f83b09d4e2182582d19d80
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

// Original method SHA256 783c64d6801b66679e41d443d5efc88d9802e535c7dbf725bda4e02230fc7860
function writeStepMemory(projectId, input) {
        if (!input.nodeId || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch))
            throw new Error('invalid_step_memory');
        if (Object.prototype.hasOwnProperty.call(input.patch, 'entries'))
            throw new Error('step_handoff_requires_settlement');
        if (Object.values(input.patch).some(value => value === undefined))
            throw new Error('invalid_step_memory');
        if (input.origin !== undefined && !['default', 'user'].includes(input.origin))
            throw new Error('invalid_step_memory_origin');
        const { expectedRevision: _expectedRevision, ...intent } = input;
        const receipt = this.recordMutation({ operation: 'write_step_memory', projectId, input: intent }, input.idempotencyKey, 'step_memory', () => {
            const current = this.readStepMemory(projectId, input.nodeId, { includeEntries: false });
            if ((current?.revision || 0) !== input.expectedRevision)
                throw new Error('revision_conflict');
            for (const field of Object.keys(input.patch))
                this.db.run("INSERT INTO step_memory_field_origins VALUES(?,?,?,?,NULL,NULL) ON CONFLICT(project_id,node_key,field) DO UPDATE SET origin=excluded.origin,source_key=NULL,source_hash=NULL", [projectId, input.nodeId, field, input.origin || 'user']);
            return this.saveStepMemoryRevision(projectId, input.nodeId, { ...current?.data, ...input.patch });
        });
        const snapshot = JSON.parse(String(this.read(receipt.objectId, receipt.revision).data.content));
        const saved = this.readStepMemory(projectId, input.nodeId, { revision: snapshot.revision, includeEntries: false });
        return { revision: saved.revision, objectId: receipt.objectId, data: saved.data, receipt };
    }

exports.writeStepMemoryNative=(store,projectId,input)=>{
  const original=Object.getOwnPropertyDescriptor(store,'saveStepMemoryRevision');
  Object.defineProperty(store,'saveStepMemoryRevision',{value:saveStepMemoryRevision,writable:true,configurable:true});
  try{return writeStepMemory.call(store,projectId,input);}
  finally{if(original)Object.defineProperty(store,'saveStepMemoryRevision',original);else delete store.saveStepMemoryRevision;}
};

const crypto=require('node:crypto'),{canonicalJson:canonical}=require('../../out/contentReferences.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function growthPayloadHash(data) {
    const { id: _id, createdAt: _createdAt, durationMs: _durationMs, scanReason: _scanReason, ...snapshot } = data.snapshot;
    const ordered = (items) => items.map(item => ({ item, key: canonical(item) }))
        .sort((left, right) => left.key.localeCompare(right.key)).map(entry => entry.item);
    const nodes = ordered(data.nodes.map(({ snapshotId: _snapshotId, ...node }) => node));
    const edges = ordered(data.edges.map(({ snapshotId: _snapshotId, ...edge }) => edge));
    const signals = ordered(data.signals.map(({ snapshotId: _snapshotId, createdAt: _signalCreatedAt, ...signal }) => signal));
    const labels = ordered(data.labels.map(({ snapshotId: _snapshotId, updatedAt: _updatedAt, ...label }) => label));
    return digest(canonical({ snapshot, nodes, edges, signals, labels }));
}
function growthSnapshotSummary(data) {
    return {
        files: data.nodes.filter(node => node.kind === 'file' && !node.excluded).length,
        modules: data.nodes.filter(node => node.kind === 'module').length,
        capabilities: data.nodes.filter(node => node.kind === 'capability').length,
        packages: data.nodes.filter(node => node.kind === 'package').length,
        loc: data.nodes.filter(node => node.kind === 'file' && !node.excluded).reduce((sum, node) => sum + node.loc, 0),
        signals: data.signals.length
    };
}
function growthCleanupSemanticHash(data) {
    const hash = crypto.createHash('sha256');
    hash.update('growth-snapshot-cleanup-semantic-v1\0');
    const header = canonical({ projectPath: data.snapshot.projectPath, gitHead: data.snapshot.gitHead || '', status: data.snapshot.status, error: data.snapshot.error || '' });
    hash.update(`snapshot\0${Buffer.byteLength(header, 'utf8')}:`);
    hash.update(header);
    const section = (name, items) => {
        hash.update(`${name}\0`);
        for (const item of items) {
            const value = canonical(item);
            hash.update(`${Buffer.byteLength(value, 'utf8')}:`);
            hash.update(value);
        }
        hash.update(`\0${items.length};`);
    };
    section('nodes', data.nodes.map(({ snapshotId: _snapshotId, ...node }) => node).sort((left, right) => sqliteBinaryTextCompare(left.nodeId, right.nodeId)));
    section('edges', data.edges.map(edge => ({ sourceId: edge.sourceId, targetId: edge.targetId, kind: edge.kind, weight: edge.weight, evidence: edge.evidence || '' }))
        .sort((left, right) => sqliteBinaryTextCompare(left.sourceId, right.sourceId) || sqliteBinaryTextCompare(left.targetId, right.targetId) || sqliteBinaryTextCompare(left.kind, right.kind)));
    section('signals', data.signals.map(signal => ({ nodeId: signal.nodeId, type: signal.type, level: signal.level, value: signal.value || '', source: signal.source, sourceRef: signal.sourceRef }))
        .sort((left, right) => sqliteBinaryTextCompare(left.nodeId, right.nodeId) || sqliteBinaryTextCompare(left.type, right.type) || sqliteBinaryTextCompare(left.level, right.level)
        || sqliteBinaryTextCompare(left.value, right.value) || sqliteBinaryTextCompare(left.source, right.source) || sqliteBinaryTextCompare(left.sourceRef, right.sourceRef)));
    section('labels', data.labels.map(label => ({ nodeId: label.nodeId, label: label.label, role: label.role, source: label.source, confidence: label.confidence }))
        .sort((left, right) => sqliteBinaryTextCompare(left.nodeId, right.nodeId)));
    return hash.digest('hex');
}
function sqliteBinaryTextCompare(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
const native={
    writeProjectGrowth(projectId, data, idempotencyKey) {
        if (!data?.snapshot?.id || data.snapshot.projectPath === '')
            throw new Error('invalid_growth_snapshot');
        const nodeIds = new Set(data.nodes.map(node => node.nodeId));
        for (const node of data.nodes)
            if (node.parentId && !nodeIds.has(node.parentId))
                throw new Error(`growth_parent_missing:${node.parentId}`);
        for (const edge of data.edges)
            if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId))
                throw new Error(`growth_edge_node_missing:${edge.sourceId}:${edge.targetId}`);
        for (const signal of data.signals)
            if (!nodeIds.has(signal.nodeId))
                throw new Error(`growth_signal_node_missing:${signal.nodeId}`);
        return this.transaction(() => {
            const snapshot = data.snapshot;
            const replay = this.rows('SELECT id FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, idempotencyKey]).length > 0;
            const receipt = this.write({
                kind: 'growth_snapshot', action: 'create', scope: projectId, idempotencyKey,
                data: { git_head: snapshot.gitHead || null, reason: snapshot.scanReason, status: snapshot.status, duration_ms: snapshot.durationMs, created_at: Date.parse(snapshot.createdAt), project_path: snapshot.projectPath, error: snapshot.error || '', payload_hash: growthPayloadHash(data), summary_json: growthSnapshotSummary(data), semantic_hash: growthCleanupSemanticHash(data) }
            });
            if (replay)
                return receipt;
            const storedSnapshotId = receipt.objectId;
            this.db.run('DELETE FROM growth_live_snapshots WHERE project_id=? AND slot=1', [projectId]);
            this.db.run('UPDATE growth_live_snapshots SET slot=1 WHERE project_id=? AND slot=0', [projectId]);
            this.db.run('INSERT INTO growth_live_snapshots(project_id,snapshot_id,slot) VALUES(?,?,0)', [projectId, storedSnapshotId]);
            try {
                const children = new Map();
                const ordered = data.nodes.filter(node => !node.parentId);
                for (const node of data.nodes) {
                    if (!node.parentId)
                        continue;
                    const siblings = children.get(node.parentId) || [];
                    siblings.push(node);
                    children.set(node.parentId, siblings);
                }
                for (let index = 0; index < ordered.length; index++) {
                    const node = ordered[index];
                    ordered.push(...(children.get(node.nodeId) || []));
                }
                if (ordered.length !== data.nodes.length)
                    throw new Error('growth_parent_cycle');
                for (const [ordinal, node] of ordered.entries()) {
                    this.db.run('INSERT INTO growth_live_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [projectId, storedSnapshotId, node.nodeId, node.parentId || null, node.kind, node.path, node.label, canonical({ ...node, snapshotId: storedSnapshotId }), node.fileCount - node.testFileCount, node.testFileCount, null, node.bytes, ordinal]);
                }
            }
            catch (error) {
                throw new Error(`growth_items_write:${String(error)}`);
            }
            try {
                for (const [ordinal, edge] of data.edges.entries())
                    this.db.run('INSERT INTO growth_live_edges VALUES(?,?,?,?,?,?,?,?)', [projectId, storedSnapshotId, edge.sourceId, edge.targetId, edge.kind, edge.weight, edge.evidence || '', ordinal]);
            }
            catch (error) {
                throw new Error(`growth_edges_write:${String(error)}`);
            }
            try {
                data.signals.forEach((signal, index) => this.db.run('INSERT INTO growth_live_signals VALUES(?,?,?,?,?,?,?,?,?,?,?)', [projectId, storedSnapshotId, `${signal.nodeId}:${signal.type}:${index}`, signal.nodeId, signal.type, signal.level, signal.value, signal.source, signal.sourceRef, Date.parse(signal.createdAt), index]));
            }
            catch (error) {
                throw new Error(`growth_signals_write:${String(error)}`);
            }
            try {
                for (const [ordinal, label] of data.labels.entries())
                    this.db.run('INSERT INTO growth_live_module_labels VALUES(?,?,?,?,?,?,?,?,?)', [projectId, storedSnapshotId, label.nodeId, label.label, label.role, label.source, label.confidence, Date.parse(label.updatedAt), ordinal]);
            }
            catch (error) {
                throw new Error(`growth_labels_write:${String(error)}`);
            }
            return receipt;
        });
    },
    commitProjectGrowthRefresh(projectId, input) {
        if (!String(input.requestId || '').trim() || !Number.isInteger(input.generation) || input.generation < 1 || !input.data)
            throw new Error('invalid_growth_refresh');
        return this.transaction(() => {
            const requestKey = `growth-refresh-result:${projectId}:${input.requestId}`;
            const inputHash = digest(canonical({ projectId, requestId: input.requestId, generation: input.generation }));
            const previous = this.rows('SELECT input_hash,result_content_id,status,result_inline_json FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, requestKey])[0];
            if (previous) {
                if (previous.input_hash !== inputHash)
                    throw new Error('idempotency_conflict');
                if (previous.status !== 'committed' || !previous.result_content_id)
                    throw new Error('growth_refresh_commit_pending');
                return JSON.parse(this.requestResult(previous).toString('utf8'));
            }
            this.db.run('INSERT INTO requests(actor_id,idempotency_key,id,input_hash,status) VALUES(?,?,?,?,?)', [this.actorId, requestKey, crypto.randomUUID(), inputHash, 'pending']);
            const finish = (result) => {
                const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0) AS value FROM events')[0].value);
                this.db.run("UPDATE requests SET status='committed',result_content_id=?,committed_sequence=? WHERE actor_id=? AND idempotency_key=?", [this.putStructuredContent(result), sequence, this.actorId, requestKey]);
                return result;
            };
            const reservation = this.readAnalysisState(projectId, 'growth-refresh', 'current');
            const reserved = reservation.value;
            const latest = this.rows('SELECT g.id,g.payload_hash FROM growth_snapshots g JOIN objects o ON o.id=g.id WHERE g.project_id=? ORDER BY COALESCE(g.snapshot_sequence,o.rowid) DESC LIMIT 1', [projectId])[0];
            if (reservation.revision !== input.generation || reserved?.requestId !== input.requestId) {
                return finish({ accepted: false, snapshotId: latest ? String(latest.id) : null, unchanged: false });
            }
            if (latest && String(latest.payload_hash || '') === growthPayloadHash(input.data)) {
                return finish({ accepted: true, snapshotId: String(latest.id), unchanged: true });
            }
            const receipt = this.writeProjectGrowth(projectId, input.data, `growth-refresh:${input.requestId}`);
            return finish({ accepted: true, snapshotId: receipt.objectId, unchanged: false });
        });
    }
};
exports.nativeDirectGrowth=function nativeDirectGrowth(store,mode,...args){
 const before=Object.getOwnPropertyDescriptor(store,'writeProjectGrowth');
 try{Object.defineProperty(store,'writeProjectGrowth',{configurable:true,writable:true,value:native.writeProjectGrowth});return native[mode==='write'?'writeProjectGrowth':'commitProjectGrowthRefresh'].apply(store,args);}
 finally{if(before)Object.defineProperty(store,'writeProjectGrowth',before);else delete store.writeProjectGrowth;}
};

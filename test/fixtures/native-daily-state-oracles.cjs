// Complete synchronous Native methods captured before daily-state migration.
const crypto=require('node:crypto'),{canonicalJson:canonical}=require('../../out/contentReferences.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
// Native writeAnalysisState 2134B SHA256 35c19a6eaa9599e3bbe675fb0dd1c4f8be67e417e212186df163f24e50262e53
function writeAnalysisState(projectId, input) {
        if (!String(input.namespace || '').trim() || !String(input.key || '').trim() || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.value === undefined || !String(input.idempotencyKey || '').trim())
            throw new Error('invalid_analysis_state');
        return this.transaction(() => {
            const current = this.readAnalysisState(projectId, input.namespace, input.key);
            const requestKey = `analysis-state:${projectId || 'global'}:${input.namespace}:${input.key}:${input.idempotencyKey}`;
            const retried = this.rows('SELECT 1 FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, requestKey]).length > 0;
            if (!retried && input.expectedSourceRevision !== undefined) {
                if (!projectId || input.namespace !== 'sidebar' || input.key !== 'conversation')
                    throw new Error('analysis_source_guard_invalid');
                if (input.expectedSourceRevision !== this.readProjectAnalysisSource(projectId).conversationRevision)
                    throw new Error('analysis_source_conflict');
            }
            if (input.expectedRevision === 0 && current.objectId && !retried)
                throw new Error('revision_conflict');
            if (input.expectedRevision > 0 && (!current.objectId || current.revision !== input.expectedRevision) && !retried)
                throw new Error('revision_conflict');
            const receipt = this.write({ kind: 'setting', action: input.expectedRevision === 0 ? 'create' : 'patch', scope: projectId,
                ...(input.expectedRevision === 0 ? {} : { objectId: current.objectId || undefined, expectedRevision: input.expectedRevision }), idempotencyKey: requestKey,
                data: { namespace: `analysis:${input.namespace}`, key: input.key, owner_scope: projectId || 'global', content: JSON.stringify(input.value) } });
            return { objectId: receipt.objectId, revision: receipt.revision, value: JSON.parse(String(this.read(receipt.objectId, receipt.revision).data.content)) };
        });
    }
// Native writeStrategyState 1637B SHA256 cf1535bd5dde212cc2f73bb77f9584b64b579c4364d57c0f6eb661c52a19becb
function writeStrategyState(projectId, input) {
        if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.value === undefined || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim())
            throw new Error('invalid_strategy_state');
        return this.transaction(() => {
            const current = this.readStrategyState(projectId);
            const key = `strategy-state:${projectId || 'global'}:${input.idempotencyKey}`;
            const retried = this.rows('SELECT 1 FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, key]).length > 0;
            if (!retried && input.expectedSourceRevision !== undefined && input.expectedSourceRevision !== this.readStrategySourceRevision(input.sourceProjectIds || []))
                throw new Error('strategy_source_conflict');
            if (input.expectedRevision === 0 && current.objectId && !retried)
                throw new Error('revision_conflict');
            const receipt = this.write({ kind: 'setting', action: input.expectedRevision === 0 ? 'create' : 'patch', scope: projectId,
                ...(input.expectedRevision === 0 ? {} : { objectId: current.objectId || undefined, expectedRevision: input.expectedRevision }), idempotencyKey: key,
                data: { namespace: 'strategy', key: projectId === null ? 'cache' : 'preferences', owner_scope: projectId || 'global', content: JSON.stringify(input.value) } });
            return { objectId: receipt.objectId, revision: receipt.revision, value: JSON.parse(String(this.read(receipt.objectId, receipt.revision).data.content)) };
        });
    }
// Native readProjectAnalysisSource 886B SHA256 8a60bb080b012d3219c107ba2da40a1ae9de38fc825e258c99dee057b8a1a15c
function readProjectAnalysisSource(projectId) {
        const row = this.rows('SELECT run_count,latest_run_at,recent_activity_at,conversation_revision FROM project_analysis_sources WHERE project_id=?', [projectId])[0];
        const runCount = Number(row?.run_count || 0);
        const timestamp = (value) => {
            const milliseconds = Number(value || 0);
            return Number.isFinite(milliseconds) && milliseconds !== 0 ? new Date(milliseconds).toISOString() : '';
        };
        const latestRunAt = timestamp(row?.latest_run_at);
        const recentActivityAt = timestamp(row?.recent_activity_at);
        const conversationRevision = Number(row?.conversation_revision || 0);
        return {
            runCount,
            latestRunAt,
            recentActivityAt,
            conversationRevision: digest(canonical([projectId, conversationRevision]))
        };
    }
// Native readStrategySourceRevision 677B SHA256 b8fbe248467ed676a837f6e3c99fceffea446893d7479432660b495695d42422
function readStrategySourceRevision(projectIds) {
        return digest(canonical(['learning-overview-v2', this.readLearningSourceRevision(), [...new Set(projectIds)].sort().map(id => {
                const row = this.rows("SELECT s.id,o.revision FROM settings s JOIN objects o ON o.id=s.id WHERE s.namespace='strategy' AND s.key='preferences' AND s.owner_scope=? AND o.project_id=? AND o.archived_at IS NULL", [id, id])[0];
                const source = this.rows('SELECT run_index_revision FROM project_analysis_sources WHERE project_id=?', [id])[0];
                return [id, row ? [row.id, row.revision] : null, Number(source?.run_index_revision || 0)];
            })]));
    }

// Native reserveExternalRefresh 534B SHA256 8f9c0fb9cc1d9fd2e1183d48ec8decdf7eda01244cf0a562b544c4846cc2c7e2
function reserveExternalRefresh(projectId, key, requestId) {
        if (!key.trim() || !requestId.trim())
            throw new Error('invalid_external_refresh');
        const current = this.readAnalysisState(projectId, 'external-refresh', key);
        const written = this.writeAnalysisState(projectId, {
            namespace: 'external-refresh', key, expectedRevision: current.revision,
            value: { requestId }, idempotencyKey: `reserve:${requestId}`
        });
        return { requestId, generation: written.revision };
    }
// Native commitExternalRefresh 1180B SHA256 df23b27e112eef000f1fedb6a3fd09c5f25df882ecd2ccdbb2b8d30ac43d4624
function commitExternalRefresh(projectId, input) {
        if (!String(input.key || '').trim() || !String(input.requestId || '').trim() || !Number.isInteger(input.generation) || input.generation < 1 || !Number.isFinite(input.requestedAt) || input.cache === undefined)
            throw new Error('invalid_external_refresh');
        return this.transaction(() => {
            const reservation = this.readAnalysisState(projectId, 'external-refresh', input.key);
            const reserved = reservation.value;
            const current = this.readAnalysisState(projectId, 'external', input.key);
            if (reservation.revision !== input.generation || reserved?.requestId !== input.requestId)
                return { accepted: false, state: current };
            const state = this.writeAnalysisState(projectId, {
                namespace: 'external', key: input.key, expectedRevision: current.revision,
                value: { generation: input.generation, requestedAt: input.requestedAt, requestId: input.requestId, cache: input.cache },
                idempotencyKey: `commit:${input.requestId}`
            });
            return { accepted: true, state };
        });
    }

// Complete original Native reserveProjectGrowthRefresh 1502B SHA256 11dbe5c9264072642d90e33f13b09f673a735ce9ae5f1ed2490e0e4fb5432799
function reserveProjectGrowthRefresh(projectId, requestId) {
        if (!requestId.trim())
            throw new Error('invalid_growth_refresh');
        const reservationKey = `analysis-state:${projectId}:growth-refresh:current:reserve:${requestId}`;
        const replay = this.rows('SELECT result_content_id,status,result_inline_json FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, reservationKey])[0];
        if (replay) {
            if (replay.status !== 'committed' || !replay.result_content_id)
                throw new Error('growth_refresh_reservation_pending');
            const receipt = JSON.parse(this.requestResult(replay).toString('utf8'));
            const state = this.read(receipt.objectId, receipt.revision);
            const value = JSON.parse(String(state.data.content));
            if (state.projectId !== projectId || state.data.namespace !== 'analysis:growth-refresh' || state.data.key !== 'current' || value.requestId !== requestId)
                throw new Error('idempotency_conflict');
            return { requestId, generation: receipt.revision };
        }
        const current = this.readAnalysisState(projectId, 'growth-refresh', 'current');
        const written = this.writeAnalysisState(projectId, {
            namespace: 'growth-refresh', key: 'current', expectedRevision: current.revision,
            value: { requestId }, idempotencyKey: `reserve:${requestId}`
        });
        return { requestId, generation: written.revision };
    }

// Complete original Native commitProjectGrowthRefreshStage 9713B SHA256 1c76857df681a5b143772bf3c058a459a991e365211b4ea1691ecc75139b6636
function commitProjectGrowthRefreshStage(projectId, stageId) {
        this.ensureProjectGrowthStageTables();
        const staged = this.rows('SELECT * FROM runtime_growth_refresh_stages WHERE stage_id=? AND project_id=?', [stageId, projectId])[0];
        if (!staged)
            throw new Error('growth_refresh_stage_missing');
        const manifest = JSON.parse(String(staged.manifest_json));
        if (manifest.stageId !== stageId || !/^[a-f0-9]{64}$/.test(manifest.payloadHash) || !/^[a-f0-9]{64}$/.test(manifest.semanticHash)
            || !/^[a-f0-9]{64}$/.test(manifest.sourceVersion.contentHash))
            throw new Error('growth_refresh_stage_invalid');
        for (const section of ['nodes', 'edges', 'signals', 'labels']) {
            const count = Number(this.rows('SELECT COUNT(*) AS count FROM runtime_growth_refresh_stage_items WHERE stage_id=? AND section=?', [stageId, section])[0].count);
            if (count !== manifest.counts[section])
                throw new Error(`growth_refresh_stage_incomplete:${section}`);
            if (count) {
                const range = this.rows('SELECT MIN(ordinal) AS minimum,MAX(ordinal) AS maximum FROM runtime_growth_refresh_stage_items WHERE stage_id=? AND section=?', [stageId, section])[0];
                if (Number(range.minimum) !== 0 || Number(range.maximum) !== count - 1)
                    throw new Error(`growth_refresh_stage_order_invalid:${section}`);
            }
        }
        const parentByNode = new Map();
        for (const row of this.rows(`SELECT json_extract(payload_json,'$.nodeId') AS node_id,
      COALESCE(json_extract(payload_json,'$.parentId'),'') AS parent_id
      FROM runtime_growth_refresh_stage_items WHERE stage_id=? AND section='nodes' ORDER BY ordinal`, [stageId])) {
            const nodeId = String(row.node_id ?? ''), parentId = String(row.parent_id ?? '');
            if (parentByNode.has(nodeId))
                throw new Error('growth_node_duplicate');
            parentByNode.set(nodeId, parentId);
        }
        for (const parentId of parentByNode.values()) {
            if (parentId && !parentByNode.has(parentId))
                throw new Error('growth_parent_missing');
        }
        const visitState = new Map();
        for (const nodeId of parentByNode.keys()) {
            if (visitState.get(nodeId) === 2)
                continue;
            const chain = [];
            let current = nodeId;
            while (current && visitState.get(current) !== 2) {
                if (visitState.get(current) === 1)
                    throw new Error('growth_parent_cycle');
                visitState.set(current, 1);
                chain.push(current);
                current = parentByNode.get(current) || '';
            }
            for (const visited of chain)
                visitState.set(visited, 2);
        }
        for (const section of ['edges', 'signals', 'labels']) {
            const sourceFields = section === 'edges' ? ['sourceId', 'targetId'] : [section === 'signals' ? 'nodeId' : 'nodeId'];
            for (const field of sourceFields) {
                if (this.rows(`SELECT 1 FROM runtime_growth_refresh_stage_items item LEFT JOIN runtime_growth_refresh_stage_items node
          ON node.stage_id=item.stage_id AND node.section='nodes' AND json_extract(node.payload_json,'$.nodeId')=json_extract(item.payload_json,?)
          WHERE item.stage_id=? AND item.section=? AND node.ordinal IS NULL LIMIT 1`, [`$.${field}`, stageId, section])[0])
                    throw new Error(`growth_${section}_node_missing`);
            }
        }
        return this.transaction(() => {
            const requestId = String(staged.request_id), generation = Number(staged.generation);
            const requestKey = `growth-refresh-result:${projectId}:${requestId}`;
            const inputHash = digest(canonical({ projectId, requestId, generation }));
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
            if (reservation.revision !== generation || reserved?.requestId !== requestId)
                return finish({ accepted: false, snapshotId: latest ? String(latest.id) : null, unchanged: false });
            if (latest && String(latest.payload_hash || '') === manifest.payloadHash)
                return finish({ accepted: true, snapshotId: String(latest.id), unchanged: true });
            const snapshot = manifest.snapshot;
            const receipt = this.write({ kind: 'growth_snapshot', action: 'create', scope: projectId, idempotencyKey: `growth-refresh:${requestId}`,
                data: { git_head: snapshot.gitHead || null, reason: snapshot.scanReason, status: snapshot.status, duration_ms: snapshot.durationMs,
                    created_at: Date.parse(snapshot.createdAt), project_path: snapshot.projectPath, error: snapshot.error || '', payload_hash: manifest.payloadHash,
                    summary_json: manifest.summary, semantic_hash: manifest.semanticHash } });
            const storedSnapshotId = receipt.objectId;
            this.db.run('DELETE FROM growth_live_snapshots WHERE project_id=? AND slot=1', [projectId]);
            this.db.run('UPDATE growth_live_snapshots SET slot=1 WHERE project_id=? AND slot=0', [projectId]);
            this.db.run('INSERT INTO growth_live_snapshots(project_id,snapshot_id,slot) VALUES(?,?,0)', [projectId, storedSnapshotId]);
            this.db.run(`INSERT INTO growth_live_items
        SELECT ?,?,json_extract(payload_json,'$.nodeId'),NULLIF(json_extract(payload_json,'$.parentId'),''),json_extract(payload_json,'$.kind'),
          json_extract(payload_json,'$.path'),json_extract(payload_json,'$.label'),json_set(payload_json,'$.snapshotId',?),
          COALESCE(json_extract(payload_json,'$.fileCount'),0)-COALESCE(json_extract(payload_json,'$.testFileCount'),0),
          COALESCE(json_extract(payload_json,'$.testFileCount'),0),NULL,COALESCE(json_extract(payload_json,'$.bytes'),0),ordinal
        FROM runtime_growth_refresh_stage_items WHERE stage_id=? AND section='nodes' ORDER BY ordinal`, [projectId, storedSnapshotId, storedSnapshotId, stageId]);
            this.db.run(`INSERT INTO growth_live_edges
        SELECT ?,?,json_extract(payload_json,'$.sourceId'),json_extract(payload_json,'$.targetId'),json_extract(payload_json,'$.kind'),
          COALESCE(json_extract(payload_json,'$.weight'),0),COALESCE(json_extract(payload_json,'$.evidence'),''),ordinal
        FROM runtime_growth_refresh_stage_items WHERE stage_id=? AND section='edges' ORDER BY ordinal`, [projectId, storedSnapshotId, stageId]);
            this.db.run(`INSERT INTO growth_live_signals
        SELECT ?,?,json_extract(payload_json,'$.nodeId')||':'||json_extract(payload_json,'$.type')||':'||ordinal,
          json_extract(payload_json,'$.nodeId'),json_extract(payload_json,'$.type'),json_extract(payload_json,'$.level'),
          COALESCE(json_extract(payload_json,'$.value'),''),COALESCE(json_extract(payload_json,'$.source'),''),
          COALESCE(json_extract(payload_json,'$.sourceRef'),''),COALESCE(unixepoch(json_extract(payload_json,'$.createdAt'))*1000,0),ordinal
        FROM runtime_growth_refresh_stage_items WHERE stage_id=? AND section='signals' ORDER BY ordinal`, [projectId, storedSnapshotId, stageId]);
            this.db.run(`INSERT INTO growth_live_module_labels
        SELECT ?,?,json_extract(payload_json,'$.nodeId'),json_extract(payload_json,'$.label'),json_extract(payload_json,'$.role'),
          json_extract(payload_json,'$.source'),COALESCE(json_extract(payload_json,'$.confidence'),0),COALESCE(unixepoch(json_extract(payload_json,'$.updatedAt'))*1000,0),ordinal
        FROM runtime_growth_refresh_stage_items WHERE stage_id=? AND section='labels' ORDER BY ordinal`, [projectId, storedSnapshotId, stageId]);
            const sourceState = this.readAnalysisState(projectId, 'growth-source', 'current');
            this.writeAnalysisState(projectId, { namespace: 'growth-source', key: 'current', expectedRevision: sourceState.revision,
                value: manifest.sourceVersion, idempotencyKey: `growth-source:${requestId}` });
            return finish({ accepted: true, snapshotId: storedSnapshotId, unchanged: false });
        });
    }

function callNative(store,method,args){
  const methods={writeAnalysisState,writeStrategyState,readProjectAnalysisSource,readStrategySourceRevision,reserveExternalRefresh,commitExternalRefresh,reserveProjectGrowthRefresh,commitProjectGrowthRefreshStage},previous=new Map(Object.keys(methods).map(key=>[key,Object.getOwnPropertyDescriptor(store,key)]));
  for(const [key,value] of Object.entries(methods))Object.defineProperty(store,key,{value,writable:true,configurable:true});
  try{return methods[method].apply(store,args);}
  finally{for(const [key,descriptor] of previous)if(descriptor)Object.defineProperty(store,key,descriptor);else delete store[key];}
}
exports.writeStateNative=(store,type,projectId,input)=>callNative(store,type==='analysis'?'writeAnalysisState':'writeStrategyState',[projectId,input]);
exports.externalRefreshNative=(store,method,...args)=>callNative(store,method==='reserve'?'reserveExternalRefresh':'commitExternalRefresh',args);

exports.growthRefreshNative=(store,method,...args)=>callNative(store,method==='reserve'?'reserveProjectGrowthRefresh':'commitProjectGrowthRefreshStage',args);

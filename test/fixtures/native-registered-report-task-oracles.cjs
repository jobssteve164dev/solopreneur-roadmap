// Exact compiled Native methods from the v202 source snapshot; do not rewrite.
const {canonicalJson:canonical}=require('../../out/contentReferences.js');
class NativeRegisteredReportTaskOracle {
    importRegisteredReportTask(projectId, source, bytes, task) {
        return this.transaction(() => {
            this.captureMigrationSource(source, bytes);
            const previous = this.rows('SELECT * FROM legacy_report_tasks WHERE project_id=? AND legacy_task_id=?', [projectId, task.taskId])[0];
            if (previous && (previous.source_identity !== source.identity || previous.source_key !== source.key))
                throw new Error('legacy_task_source_conflict');
            const conversationId = previous ? String(this.readMetadata(String(previous.task_id)).data.conversation_id)
                : this.write({ kind: 'conversation', action: 'create', scope: projectId, idempotencyKey: `legacy-report-conversation:${canonical(source)}`, data: { mode: 'legacy', status: 'historical', title: task.userMessage } }).objectId;
            const imported = this.importObjectInternal({ kind: 'task', action: 'create', scope: projectId, idempotencyKey: `legacy-report-task:${canonical(source)}`, data: { conversation_id: conversationId, original_request_content: task.userMessage, status: 'historical' } }, source);
            const taskId = imported.receipt?.objectId || String(previous.task_id);
            const executions = new Map((previous ? JSON.parse(String(previous.executions_json)) : []).map((run) => [run.id, run]));
            for (const run of task.executions) {
                if (executions.has(run.id) && executions.get(run.id).nodeId !== run.nodeId)
                    throw new Error('legacy_task_execution_conflict');
                executions.set(run.id, run);
            }
            const executionsJson = canonical([...executions.values()].sort((a, b) => a.id - b.id));
            const startedAt = Number.isFinite(Date.parse(task.startedAt)) ? task.startedAt : '';
            const titlePreview = task.userMessage.slice(0, 120);
            if (!previous || previous.started_at !== startedAt || previous.title_preview !== titlePreview || previous.executions_json !== executionsJson) {
                this.db.run('INSERT INTO legacy_report_tasks VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,legacy_task_id) DO UPDATE SET started_at=excluded.started_at,title_preview=excluded.title_preview,executions_json=excluded.executions_json', [projectId, task.taskId, taskId, source.identity, source.key, startedAt, titlePreview, executionsJson]);
                this.bumpReportSourceRevision(projectId);
            }
            return taskId;
        });
    }
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
}
function nativeRegisteredReportTask(store,...args){const descriptor=Object.getOwnPropertyDescriptor(store,'importObjectInternal');Object.defineProperty(store,'importObjectInternal',{value:NativeRegisteredReportTaskOracle.prototype.importObjectInternal,configurable:true,writable:true});try{return NativeRegisteredReportTaskOracle.prototype.importRegisteredReportTask.call(store,...args);}finally{if(descriptor)Object.defineProperty(store,'importObjectInternal',descriptor);else delete store.importObjectInternal;}}
module.exports={nativeRegisteredReportTask};

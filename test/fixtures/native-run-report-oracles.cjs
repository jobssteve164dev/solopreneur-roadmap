// Exact original Native report graph for synchronous transaction and race oracles only.
// Source and method hashes: native-run-report-oracles-v136.json in task evidence.
const crypto=require('node:crypto');

// Original method SHA256 c366f261b8cccc3f856b8cb548fc3ffa887c54087b6ca52259c8e2008968c159
function submitRunReport(projectId, input) {
        const row = this.runControl(projectId, input.executionLogId);
        if (row.generation !== input.generation)
            throw new Error('run_owner_conflict');
        if (!input.turnId)
            throw new Error('report_turn_required');
        if (!this.rows("SELECT 1 AS allowed FROM relations WHERE source_id=? AND relation='source' AND target_id=?", [row.run_id, input.turnId]).length || this.readMetadata(input.turnId).kind !== 'turn')
            throw new Error('report_turn_denied');
        return this.transaction(() => {
            const receipt = this.recordMutation({ operation: 'submit_run_report', projectId, executionLogId: input.executionLogId, generation: input.generation, turnId: input.turnId, report: input.report, availability: input.availability, validationError: input.validationError || '' }, input.idempotencyKey, 'submit', () => this.upsertRunReport(projectId, String(row.run_id), input.turnId, input));
            if (String(row.current_turn_id) === input.turnId) {
                this.bindRunReport(projectId, { executionLogId: input.executionLogId, generation: input.generation, turnId: input.turnId, reportObjectId: receipt.objectId, reportRevision: receipt.revision, availability: input.availability, validationError: input.validationError, idempotencyKey: `${input.idempotencyKey}:run` });
            }
            return { ...receipt, availability: String(this.current(receipt.objectId, false).data.availability) };
        });
    }

// Original method SHA256 b8222aa87d31da66db8bcc891093beedfa44d98fc9584174c3824cec29e74473
function upsertRunReport(projectId, runId, turnId, input) {
        const existing = this.runReportHead(projectId, runId, turnId);
        if (existing) {
            this.db.run('UPDATE reports SET content_id=?,availability=?,validation_error=? WHERE id=?', [this.putStructuredContent(input.report), input.availability, input.validationError || null, existing.objectId]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=? AND revision=?', [Date.now(), existing.objectId, existing.revision]);
            return this.current(existing.objectId);
        }
        const id = crypto.randomUUID();
        const now = Date.now();
        const sequence = this.allocateOrderedRecordSequence('objects', 'report_creation_sequence');
        this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [id, 'report', projectId, 1, now, now]);
        this.db.run('INSERT INTO reports(id,project_id,turn_id,run_id,schema_version,content_id,availability,validation_error,creation_sequence) VALUES(?,?,?,?,?,?,?,?,?)', [id, projectId, turnId, runId, 1, this.putStructuredContent(input.report), input.availability, input.validationError || null, sequence]);
        return this.current(id);
    }

// Original method SHA256 7e7fb2fcd884135ab0ab40bb74bc3b474479ede2e9166371c6c106be7471709a
function bindRunReport(projectId, input) {
        return this.recordMutation({ operation: 'bind_run_report', projectId, executionLogId: input.executionLogId, generation: input.generation, turnId: input.turnId, reportObjectId: input.reportObjectId, reportRevision: input.reportRevision }, input.idempotencyKey, 'report', () => {
            const current = this.runControl(projectId, input.executionLogId), metadata = JSON.parse(this.content(String(current.metadata_content_id)).toString('utf8'));
            Object.assign(metadata, { taskReportObjectId: input.reportObjectId, taskReportRevision: input.reportRevision, taskReportStatus: input.availability === 'available' ? 'recorded' : input.availability, taskReportError: input.validationError || '' });
            this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putStructuredContent(metadata), current.run_id]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), current.run_id]);
            this.saveRunControlRevision(String(current.run_id));
            return this.current(String(current.run_id), false);
        }, undefined, false);
    }

// Original method SHA256 301db1727f7ac777d44d67a542764bdc4eb0e5d301fe84e2ab71e5256612a656
function runReportHead(projectId, runId, turnId) {
        const row = this.rows('SELECT r.id FROM reports r JOIN objects o ON o.id=r.id WHERE r.project_id=? AND r.run_id=? AND r.turn_id=? ORDER BY o.updated_at DESC,o.id DESC LIMIT 1', [projectId, runId, turnId])[0];
        return row ? this.current(String(row.id)) : null;
    }

function withNativeRunReports(store,work){
  const originals=new Map(),helpers={upsertRunReport,bindRunReport,runReportHead};
  for(const [name,method] of Object.entries(helpers)){originals.set(name,Object.getOwnPropertyDescriptor(store,name));Object.defineProperty(store,name,{value:method,writable:true,configurable:true});}
  try{return work();}
  finally{for(const [name,descriptor] of originals){if(descriptor)Object.defineProperty(store,name,descriptor);else delete store[name];}}
}
exports.withNativeRunReports=withNativeRunReports;
exports.submitRunReportNative=(store,projectId,input)=>withNativeRunReports(store,()=>submitRunReport.call(store,projectId,input));

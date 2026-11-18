// Exact compiled Native methods from the v202 source snapshot; do not rewrite.
const crypto=require('node:crypto'),path=require('node:path');
const {canonicalJson:canonical}=require('../../out/contentReferences.js');
const sessionIdentity_1=require('../../out/sessionIdentity.js'),runWorkspace_1=require('../../out/runWorkspace.js'),runArtifactPolicy_js_1=require('../../out/runArtifactPolicy.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
class NativeHistoricalAdoptionOracle {
    importRegisteredReport(projectId, taskId, observation, source, bytes) {
        this.transaction(() => {
            this.captureMigrationSource(source, bytes);
            const registration = this.rows('SELECT executions_json FROM legacy_report_tasks WHERE project_id=? AND task_id=?', [projectId, taskId])[0];
            if (!registration || !JSON.parse(String(registration.executions_json)).some((run) => run.id === observation.executionLogId))
                throw new Error('legacy_report_execution_denied');
            let turnId = this.rows('SELECT turn_id FROM legacy_report_turns WHERE project_id=? AND task_id=? AND execution_log_id=? AND legacy_sequence=?', [projectId, taskId, observation.executionLogId, observation.sequence])[0]?.turn_id;
            if (!turnId) {
                const next = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM turns WHERE task_id=?', [taskId])[0].n);
                turnId = this.write({ kind: 'turn', action: 'create', scope: projectId, idempotencyKey: `legacy-report-turn:${canonical([projectId, taskId, observation.executionLogId, observation.sequence])}`, data: { task_id: taskId, sequence: next, request_content: null, started_at: null } }).objectId;
                this.db.run('INSERT INTO legacy_report_turns VALUES(?,?,?,?,?)', [projectId, taskId, observation.executionLogId, observation.sequence, turnId]);
            }
            const bound = this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
            if (bound?.object_id && this.readMetadata(String(bound.object_id)).data.turn_id !== turnId)
                throw new Error('legacy_report_source_conflict');
            const imported = this.importObjectInternal({ kind: 'report', action: 'create', scope: projectId, idempotencyKey: `legacy-report:${canonical(source)}`, data: { turn_id: String(turnId), run_id: null, schema_version: 1,
                    content: observation.envelope?.report ?? 'null', availability: observation.availability, validation_error: observation.availability === 'invalid' ? 'legacy_report_invalid' : null } }, source);
            if (imported.receipt) {
                const captured = this.rows('SELECT source_content_id,source_capture_revision FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
                const sourceTime = String(observation.envelope?.createdAt || '');
                this.db.run('INSERT INTO report_version_sources VALUES(?,?,?,?,?,?,?,?)', [imported.receipt.objectId, imported.receipt.revision, source.identity, source.key, source.hash, captured.source_content_id, captured.source_capture_revision, Number.isFinite(Date.parse(sourceTime)) ? sourceTime : '']);
            }
        });
    }
    adoptHistoricalRun(projectId, locationId, source, input) {
        return this.transaction(() => {
            const status = input.status, executionLogId = Number(status.rootExecutionLogId || status.executionLogId), nodeId = String(status.nodeId || '');
            const currentExecutionLogId = Number(status.executionLogId);
            const historicalExecutionLogIds = [...new Set(input.historicalExecutionLogIds || [executionLogId, currentExecutionLogId])].sort((a, b) => a - b);
            const captured = this.readMigrationSource(source.identity, source.key);
            if (captured.hash !== source.hash || canonical(JSON.parse(captured.bytes.toString('utf8'))) !== canonical(status))
                throw new Error('historical_run_source_changed');
            let registration = this.rows('SELECT * FROM legacy_report_tasks WHERE project_id=? AND legacy_task_id=?', [projectId, String(status.learningTaskId || input.unregisteredTaskAlias || input.registeredTaskAlias || '')])[0];
            if (input.unregisteredReports !== undefined) {
                const request = typeof status.userMessage === 'string' && status.userMessage.trim()
                    ? status.userMessage
                    : typeof input.unregisteredRequest === 'string' ? input.unregisteredRequest : '';
                if (!request.trim())
                    throw new Error('historical_run_task_source_missing');
                if (!registration && !status.learningTaskId)
                    registration = this.rows('SELECT * FROM legacy_report_tasks WHERE project_id=? AND source_identity=? AND source_key=?', [projectId, source.identity, source.key])[0];
                if (!registration) {
                    const conversationId = this.write({ kind: 'conversation', action: 'create', scope: projectId, idempotencyKey: `historical-status-conversation:${canonical([projectId, source])}`, data: { mode: 'legacy', status: 'historical', title: request } }).objectId;
                    const taskId = this.write({ kind: 'task', action: 'create', scope: projectId, idempotencyKey: `historical-status-task:${canonical([projectId, source])}`, data: { conversation_id: conversationId, original_request_content: request, status: 'historical' } }).objectId;
                    const alias = String(status.learningTaskId || input.unregisteredTaskAlias || `task-${taskId}`);
                    if (!/^task-[a-zA-Z0-9-]+$/.test(alias))
                        throw new Error('historical_run_task_mismatch');
                    this.db.run('INSERT INTO legacy_report_tasks VALUES(?,?,?,?,?,?,?,?)', [projectId, alias, taskId, source.identity, source.key, String(status.startedAt || ''), request.slice(0, 120), canonical(historicalExecutionLogIds.map(id => ({ id, nodeId })))]);
                    this.bumpReportSourceRevision(projectId);
                    registration = this.rows('SELECT * FROM legacy_report_tasks WHERE project_id=? AND legacy_task_id=?', [projectId, alias])[0];
                }
                else {
                    const executions = JSON.parse(String(registration.executions_json));
                    let changed = false;
                    for (const id of historicalExecutionLogIds)
                        if (!executions.some(run => run.id === id)) {
                            executions.push({ id, nodeId });
                            changed = true;
                        }
                    if (changed) {
                        executions.sort((a, b) => a.id - b.id);
                        this.db.run('UPDATE legacy_report_tasks SET executions_json=? WHERE project_id=? AND legacy_task_id=?', [canonical(executions), projectId, registration.legacy_task_id]);
                        this.bumpReportSourceRevision(projectId);
                        registration = { ...registration, executions_json: canonical(executions) };
                    }
                }
                for (const report of input.unregisteredReports)
                    this.importRegisteredReport(projectId, String(registration.task_id), report.observation, report.source, report.bytes);
            }
            if (!registration || !JSON.parse(String(registration.executions_json)).some((run) => run.id === executionLogId && run.nodeId === nodeId))
                throw new Error('historical_run_task_mismatch');
            if (!Number.isSafeInteger(executionLogId) || executionLogId < 1 || !Number.isSafeInteger(currentExecutionLogId) || currentExecutionLogId < executionLogId || !nodeId || !status.runKind)
                throw new Error('historical_run_identity_invalid');
            if (!historicalExecutionLogIds.includes(executionLogId) || !historicalExecutionLogIds.includes(currentExecutionLogId))
                throw new Error('historical_run_identity_invalid');
            for (const id of historicalExecutionLogIds) {
                if (!Number.isSafeInteger(id) || id < executionLogId || id > currentExecutionLogId || !JSON.parse(String(registration.executions_json)).some((run) => run.id === id && run.nodeId === nodeId))
                    throw new Error('historical_run_identity_invalid');
                if (id !== executionLogId) {
                    const journal = this.rows('SELECT node_id FROM project_journal_entries WHERE project_id=? AND execution_log_id=?', [projectId, id])[0];
                    if (!journal || journal.node_id !== nodeId)
                        throw new Error('historical_run_identity_invalid');
                }
            }
            if (currentExecutionLogId !== executionLogId) {
                const registeredCurrent = JSON.parse(String(registration.executions_json)).some((run) => run.id === currentExecutionLogId && run.nodeId === nodeId);
                const journal = this.rows('SELECT node_id FROM project_journal_entries WHERE project_id=? AND execution_log_id=?', [projectId, currentExecutionLogId])[0];
                if (!registeredCurrent || !journal || journal.node_id !== nodeId || status.interactiveSession !== true)
                    throw new Error('historical_run_identity_invalid');
            }
            const taskId = String(registration.task_id), conversationId = String(this.readMetadata(taskId).data.conversation_id);
            const location = this.rows('SELECT root_path FROM project_locations WHERE id=? AND project_id=?', [locationId, projectId])[0];
            const binding = input.binding && (0, sessionIdentity_1.assertVersion2Binding)(input.binding, source.key);
            const declaredWorkspace = input.unregisteredWorkspaceRelocated ? input.unregisteredWorkspaceRoot : status.workspaceRoot || binding?.workspaceRoot || (input.unregisteredReports !== undefined ? input.unregisteredWorkspaceRoot : undefined);
            if (!location || !declaredWorkspace || path.resolve(String(declaredWorkspace)) !== path.resolve(String(location.root_path)))
                throw new Error('historical_run_workspace_mismatch');
            if (binding) {
                if (binding.runId !== String(executionLogId) || path.resolve(binding.workspaceRoot) !== path.resolve(String(location.root_path)) || status.bindingNonce && binding.bindingNonce !== status.bindingNonce || status.sessionProvider && binding.provider !== status.sessionProvider)
                    throw new Error('historical_run_binding_mismatch');
                const head = binding.revisions[binding.headRevision - 1];
                const observedRevision = Number(status.sessionBindingHeadRevision || binding.headRevision);
                const observed = binding.revisions[observedRevision - 1];
                if (!Number.isSafeInteger(observedRevision) || !observed || status.nativeSessionIdIsCurrent === true && (observedRevision !== binding.headRevision || head.state !== 'confirmed' || head.sessionId !== status.nativeSessionId || binding.resumableRevision !== binding.headRevision))
                    throw new Error('historical_run_session_mismatch');
            }
            else if (status.nativeSessionIdIsCurrent === true)
                throw new Error('historical_run_binding_missing');
            if (input.outputSource) {
                const outputCapture = this.readMigrationSource(input.outputSource.identity, input.outputSource.key), journal = JSON.parse(outputCapture.bytes.toString('utf8'));
                if (outputCapture.hash !== input.outputSource.hash || journal.id !== currentExecutionLogId || journal.nodeId !== nodeId || !Buffer.from(String(journal.output || '')).equals(input.output))
                    throw new Error('historical_run_output_source_mismatch');
            }
            if (input.nativeTranscript) {
                const nativeCapture = this.readMigrationSource(input.nativeTranscript.source.identity, input.nativeTranscript.source.key);
                if (nativeCapture.hash !== input.nativeTranscript.source.hash || !nativeCapture.bytes.equals(input.nativeTranscript.bytes))
                    throw new Error('historical_run_native_source_mismatch');
            }
            let legacyDecision = {};
            if (input.legacyCompletion) {
                const completionCapture = this.readMigrationSource(input.legacyCompletion.source.identity, input.legacyCompletion.source.key);
                if (completionCapture.hash !== input.legacyCompletion.source.hash || !completionCapture.bytes.equals(input.legacyCompletion.bytes))
                    throw new Error('historical_run_completion_source_changed');
                if (status.status === 'In Progress' && status.interactiveSession !== true && !status.checkpointOutcome) {
                    try {
                        const decision = JSON.parse(input.legacyCompletion.bytes.toString('utf8'));
                        if (!decision || typeof decision !== 'object' || Array.isArray(decision) || typeof decision.markCompleted !== 'boolean' || decision.reason !== undefined && typeof decision.reason !== 'string')
                            throw new Error('invalid_completion_decision');
                        if (decision.markCompleted)
                            legacyDecision = { checkpointOutcome: 'candidate_complete', checkpointSummary: decision.reason || '' };
                    }
                    catch {
                        legacyDecision = { status: 'Failed', checkpointOutcome: 'failed', failureCode: 'completion_state_invalid', failureReason: 'Agent completion decision file could not be parsed.' };
                    }
                }
            }
            const sourceIdentity = { source, status, binding, prompt: digest(input.prompt), command: digest(input.command), output: digest(input.output), ...(input.outputSource ? { outputSource: input.outputSource } : {}), ...(input.nativeTranscript ? { nativeSource: input.nativeTranscript.source } : {}), workspaceBefore: input.workspaceBefore ? digest(input.workspaceBefore) : null, changes: input.changes ? digest(input.changes) : null, roadmapBackup: input.roadmapBackup ? digest(input.roadmapBackup) : null };
            const sourceHash = digest(canonical({ ...sourceIdentity, ...(input.legacyCompletion ? { completionSource: input.legacyCompletion.source } : {}) }));
            let appendedOutput;
            if (input.appendedOutputSource) {
                if ((0, runArtifactPolicy_js_1.runArtifactKind)(input.appendedOutputSource.key) !== 'output')
                    throw new Error('historical_run_output_source_mismatch');
                const archivedExecutionLogId = input.appendedOutputArtifactExecutionLogId ?? executionLogId;
                if (!Number.isSafeInteger(archivedExecutionLogId) || archivedExecutionLogId < 0)
                    throw new Error('historical_run_output_source_mismatch');
                const archived = this.readRunArtifactBytes(projectId, archivedExecutionLogId, input.appendedOutputSource.key);
                const capturedOutput = this.readMigrationSource(input.appendedOutputSource.identity, input.appendedOutputSource.key);
                if (!archived || capturedOutput.hash !== input.appendedOutputSource.hash || capturedOutput.hash !== digest(input.output) || !capturedOutput.bytes.equals(input.output)
                    || input.output.length <= archived.bytes.length || !input.output.subarray(0, archived.bytes.length).equals(archived.bytes))
                    throw new Error('historical_run_output_source_mismatch');
                appendedOutput = { source: input.appendedOutputSource, archived, captured: capturedOutput };
            }
            const refreshedArtifacts = (input.refreshedArtifacts || []).map(item => {
                if (!appendedOutput || item.kind !== 'change_evidence' || (0, runArtifactPolicy_js_1.runArtifactKind)(item.source.key) !== item.kind || !['changes.txt', 'touched-files.txt'].includes(path.basename(item.source.key))
                    || !Number.isSafeInteger(item.artifactExecutionLogId) || item.artifactExecutionLogId < 0)
                    throw new Error('historical_run_artifact_source_mismatch');
                const archived = this.readRunArtifactBytes(projectId, item.artifactExecutionLogId, item.source.key);
                const captured = this.readMigrationSource(item.source.identity, item.source.key);
                if (!archived || captured.hash !== item.source.hash || captured.hash === archived.hash)
                    throw new Error('historical_run_artifact_source_mismatch');
                return { ...item, archived, captured };
            });
            if (new Set(refreshedArtifacts.map(item => item.source.key)).size !== refreshedArtifacts.length
                || refreshedArtifacts.filter(item => item.documentPurpose === 'changes').length > 1)
                throw new Error('historical_run_artifact_source_mismatch');
            const consumerStatus = String(legacyDecision.status || status.status);
            const needsConsumer = ['In Progress', 'Failed'].includes(consumerStatus);
            const restoreCurrentTurnTimes = (turnId) => {
                const turn = this.readMetadata(turnId), start = Date.parse(String(status.turnStartedAt || '')), finish = Date.parse(String(status.finishedAt || status.checkpointAt || ''));
                const data = {};
                if (Number.isFinite(start))
                    data.started_at = start;
                if (['Waiting', 'Processed', 'Completed', 'Failed', 'Stopped'].includes(String(status.status)) && Number.isFinite(finish))
                    data.finished_at = finish;
                for (const key of Object.keys(data)) {
                    if (turn.data[key] === data[key])
                        delete data[key];
                    else if (turn.data[key] !== null)
                        throw new Error('historical_run_turn_source_conflict');
                }
                if (Object.keys(data).length)
                    this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: turnId, expectedRevision: turn.revision, idempotencyKey: `historical-turn-times:${canonical([projectId, source, turnId, data])}`, data });
            };
            const existing = this.rows('SELECT run_id FROM run_control WHERE project_id=? AND execution_log_id=?', [projectId, executionLogId])[0];
            if (existing) {
                const state = this.readRunState(projectId, executionLogId);
                if (state.taskId !== taskId)
                    throw new Error('historical_run_target_conflict');
                if (state.status.historicalSourceHash !== sourceHash) {
                    if (appendedOutput) {
                        const { source: outputSource, archived, captured: capturedOutput } = appendedOutput;
                        const previousChanges = refreshedArtifacts.find(item => item.documentPurpose === 'changes');
                        const previousSourceIdentity = { ...sourceIdentity, output: archived.hash, ...(previousChanges ? { changes: previousChanges.archived.hash } : {}) };
                        const previousSourceHash = digest(canonical({ ...previousSourceIdentity, ...(input.legacyCompletion ? { completionSource: input.legacyCompletion.source } : {}) }));
                        const outputChunks = this.rows('SELECT sequence,byte_offset,content_id,byte_length FROM log_chunks JOIN contents ON contents.id=log_chunks.content_id WHERE run_id=? AND stream=\'output\' ORDER BY sequence', [state.runId]);
                        let archivedOffset = 0;
                        const exactFormalOutput = outputChunks.every((chunk, index) => {
                            const bytes = this.content(String(chunk.content_id));
                            const exact = Number(chunk.sequence) === index && Number(chunk.byte_offset) === archivedOffset && Number(chunk.byte_length) === bytes.length
                                && bytes.equals(archived.bytes.subarray(archivedOffset, archivedOffset + bytes.length));
                            archivedOffset += bytes.length;
                            return exact;
                        }) && archivedOffset === archived.bytes.length;
                        const changesPurpose = previousChanges ? (0, runWorkspace_1.workspaceDocumentPurpose)(state.turnId, 'changes') : '';
                        const currentChanges = previousChanges ? this.readRunDocument(projectId, executionLogId, changesPurpose) : null;
                        const exactFormalArtifacts = refreshedArtifacts.every(item => item.documentPurpose !== 'changes' || currentChanges?.hash === item.archived.hash);
                        if (exactFormalOutput && exactFormalArtifacts && state.status.historicalSourceHash === previousSourceHash) {
                            this.recordMutation({ projectId, source, previousOutputHash: archived.hash }, `adopt-appended-historical-output:${canonical([projectId, sourceHash])}`, 'historical_adoption', () => {
                                this.writeHistoricalRunArtifact(projectId, { executionLogId, relativePath: outputSource.key, bytes: input.output, hash: capturedOutput.hash, mimeType: archived.mimeType }, 'output');
                                const control = this.runControl(projectId, executionLogId);
                                const metadata = { ...JSON.parse(this.content(String(control.metadata_content_id)).toString('utf8')), historicalSourceHash: sourceHash };
                                const previousEndOffsets = metadata.turnLogEndOffsets && typeof metadata.turnLogEndOffsets === 'object' && !Array.isArray(metadata.turnLogEndOffsets) ? metadata.turnLogEndOffsets : {};
                                metadata.turnLogEndOffsets = { ...previousEndOffsets, output: input.output.length };
                                for (const item of refreshedArtifacts) {
                                    this.writeHistoricalRunArtifact(projectId, { executionLogId, relativePath: item.source.key, bytes: item.captured.bytes, hash: item.captured.hash, mimeType: item.archived.mimeType }, item.kind);
                                    if (item.documentPurpose === 'changes') {
                                        const saved = this.writeRunDocumentContent(projectId, { executionLogId, generation: Number(control.generation), turnId: state.turnId, purpose: changesPurpose, bytes: item.captured.bytes.toString('base64'), mimeType: 'text/plain', expectedRevision: currentChanges.revision, idempotencyKey: `historical-run-refresh:${canonical([projectId, sourceHash, item.source.key])}` });
                                        const changeCount = item.captured.bytes.toString('utf8').split(/\r?\n/).filter(line => line.length > 0).length;
                                        Object.assign(metadata, { workspaceChangesObjectId: saved.objectId, workspaceChangesRevision: saved.revision, workspaceChangeCount: changeCount });
                                    }
                                }
                                const appended = input.output.subarray(archived.bytes.length);
                                this.db.run('INSERT INTO log_chunks VALUES(?,?,?,?,?,?)', [state.runId, 'output', outputChunks.length, this.putContent(appended, 'application/octet-stream', 'binary'), Date.now(), archived.bytes.length]);
                                this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putStructuredContent(metadata), state.runId]);
                                this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), state.runId]);
                                this.saveRunControlRevision(state.runId);
                                return this.current(state.runId);
                            });
                            this.markMigrationSourceImported(outputSource.identity, outputSource.key);
                            for (const item of refreshedArtifacts)
                                this.markMigrationSourceImported(item.source.identity, item.source.key);
                            this.markMigrationSourceImported(source.identity, source.key);
                            return { unchanged: false, state: this.readRunState(projectId, executionLogId) };
                        }
                    }
                    if (input.legacyCompletion && !state.status.historicalCompletionSource && state.status.historicalSourceHash === digest(canonical(sourceIdentity))) {
                        const completion = input.legacyCompletion;
                        const mayNormalize = state.revision === 1 && state.status.status === status.status;
                        const receipt = this.recordMutation({ projectId, source, completionSource: completion.source }, `adopt-historical-completion:${canonical([projectId, sourceHash])}`, 'historical_adoption', () => {
                            const control = this.runControl(projectId, executionLogId);
                            const metadata = { ...JSON.parse(this.content(String(control.metadata_content_id)).toString('utf8')), ...(mayNormalize ? legacyDecision : {}), historicalCompletionSource: completion.source, historicalSourceHash: sourceHash };
                            if (mayNormalize && legacyDecision.status)
                                this.db.run('UPDATE runs SET status=? WHERE id=?', [String(legacyDecision.status), state.runId]);
                            this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putStructuredContent(metadata), state.runId]);
                            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), state.runId]);
                            this.saveRunControlRevision(state.runId);
                            if (mayNormalize && Object.keys(legacyDecision).length)
                                this.insertRunConsumerSource(state.runId, projectId, state.turnId, Number(control.checkpoint_sequence), state.revision + 1, true);
                            return this.current(state.runId);
                        });
                        this.db.run("UPDATE migration_items SET object_id=?,imported_revision=?,stage='imported',error=NULL WHERE source_identity=? AND source_key=? AND source_hash=?", [receipt.objectId, receipt.revision, completion.source.identity, completion.source.key, completion.source.hash]);
                        this.markMigrationSourceImported(source.identity, source.key);
                        return { unchanged: false, state: this.readRunState(projectId, executionLogId) };
                    }
                    const historicalStatusSource = state.status.historicalStatusSource, historicalOutputSource = state.status.historicalOutputSource;
                    if (state.status.historicalAdopted === true && historicalStatusSource && canonical(historicalStatusSource) === canonical(source)
                        && input.outputSource && historicalOutputSource && typeof historicalOutputSource === 'object'
                        && String(historicalOutputSource.identity || '') === input.outputSource.identity
                        && String(historicalOutputSource.key || '') === input.outputSource.key
                        && String(historicalOutputSource.hash || '') !== input.outputSource.hash) {
                        const formalOutput = Buffer.concat(this.rows("SELECT content_id FROM log_chunks WHERE run_id=? AND stream='output' ORDER BY sequence", [state.runId]).map(chunk => this.content(String(chunk.content_id))));
                        const previousSourceIdentity = { ...sourceIdentity, output: digest(formalOutput), outputSource: historicalOutputSource };
                        const previousSourceHash = digest(canonical({ ...previousSourceIdentity, ...(state.status.historicalCompletionSource ? { completionSource: state.status.historicalCompletionSource } : {}) }));
                        if (previousSourceHash === state.status.historicalSourceHash) {
                            this.markMigrationSourceImported(source.identity, source.key);
                            return { unchanged: true, state };
                        }
                    }
                    throw new Error('historical_run_target_conflict');
                }
                const legacyTurn = this.rows('SELECT turn_id FROM legacy_report_turns WHERE project_id=? AND task_id=? AND execution_log_id=? AND legacy_sequence=?', [projectId, taskId, executionLogId, Number(status.checkpointSequence || 0)])[0];
                if (legacyTurn?.turn_id === state.turnId && Number(state.status.checkpointSequence) === Number(status.checkpointSequence || 0))
                    restoreCurrentTurnTimes(state.turnId);
                if (needsConsumer && state.revision === 1 && state.status.status === consumerStatus && !this.rows('SELECT 1 FROM run_consumer_sources WHERE run_id=? AND source_revision=?', [state.runId, state.revision]).length) {
                    // Repair only the queue; the accepted historical run revision stays immutable.
                    this.insertRunConsumerSource(state.runId, projectId, state.turnId, Number(state.status.checkpointSequence || 0), state.revision);
                    this.markMigrationSourceImported(source.identity, source.key);
                    return { unchanged: false, state };
                }
                this.markMigrationSourceImported(source.identity, source.key);
                return { unchanged: true, state };
            }
            if (this.historicalRunOwnerAlive(status))
                throw new Error('historical_run_owner_alive');
            const startedAt = Date.parse(String(status.startedAt || '')), finishedAt = Date.parse(String(status.finishedAt || ''));
            const checkpointSequence = Number(status.checkpointSequence || 0);
            if (!Number.isFinite(startedAt) || !Number.isSafeInteger(checkpointSequence) || checkpointSequence < 0 || !status.status)
                throw new Error('historical_run_state_incomplete');
            const idempotencyKey = `adopt-historical-run:${canonical([projectId, source, sourceHash])}`;
            const receipt = this.recordMutation({ projectId, locationId, source, sourceHash }, idempotencyKey, 'historical_adoption', () => {
                const previousTurns = this.rows('SELECT execution_log_id,legacy_sequence,turn_id FROM legacy_report_turns WHERE project_id=? AND task_id=? AND execution_log_id IN (SELECT value FROM json_each(?)) ORDER BY legacy_sequence', [projectId, taskId, canonical(historicalExecutionLogIds)]);
                let turnId = previousTurns.find(turn => Number(turn.execution_log_id) === currentExecutionLogId && Number(turn.legacy_sequence) === checkpointSequence)?.turn_id;
                if (!turnId) {
                    const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM turns WHERE task_id=?', [taskId])[0].next);
                    turnId = this.write({ kind: 'turn', action: 'create', scope: projectId, idempotencyKey: `${idempotencyKey}:turn`, data: { task_id: taskId, sequence, request_content: typeof status.checkpointMessage === 'string' ? status.checkpointMessage : null, started_at: Number.isFinite(Date.parse(String(status.turnStartedAt))) ? Date.parse(String(status.turnStartedAt)) : null } }).objectId;
                    this.db.run('INSERT INTO legacy_report_turns VALUES(?,?,?,?,?)', [projectId, taskId, currentExecutionLogId, checkpointSequence, turnId]);
                }
                restoreCurrentTurnTimes(String(turnId));
                const runId = crypto.randomUUID(), now = Date.now();
                this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [runId, 'run', projectId, 1, now, now]);
                this.db.run('INSERT INTO runs(id,project_id,task_id,turn_id,conversation_id,location_id,run_kind,actor_id,command_content_id,prompt_content_id,status,started_at,finished_at,exit_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [runId, projectId, taskId, turnId, conversationId, locationId, String(status.runKind), this.actorId, this.putContent(input.command), this.putContent(input.prompt), String(legacyDecision.status || status.status), startedAt, Number.isFinite(finishedAt) ? finishedAt : null, Number.isInteger(status.exitCode) ? Number(status.exitCode) : null]);
                const metadata = { ...status, ...legacyDecision, workspaceRoot: String(location.root_path), historicalSourceHash: sourceHash, historicalStatusSource: source, historicalAdopted: true };
                const previousEndOffsets = metadata.turnLogEndOffsets && typeof metadata.turnLogEndOffsets === 'object' && !Array.isArray(metadata.turnLogEndOffsets) ? metadata.turnLogEndOffsets : {};
                metadata.turnLogEndOffsets = { ...previousEndOffsets, output: input.output.length };
                if (input.changes !== undefined)
                    metadata.workspaceChangeCount = input.changes.toString('utf8').split(/\r?\n/).filter(line => line.length > 0).length;
                if (input.legacyCompletion)
                    metadata.historicalCompletionSource = input.legacyCompletion.source;
                if (input.outputSource)
                    metadata.historicalOutputSource = input.outputSource;
                if (binding?.revisions[binding.headRevision - 1]?.evidence?.source === 'legacy_session_file' && binding.revisions[binding.headRevision - 1].state === 'confirmed')
                    Object.assign(metadata, { bindingNonce: binding.bindingNonce, sessionProvider: binding.provider, sessionBindingHeadRevision: binding.headRevision, nativeSessionId: binding.revisions[binding.headRevision - 1].sessionId, nativeSessionIdIsCurrent: true });
                if (input.nativeTranscript)
                    Object.assign(metadata, { codexNativeCursor: input.nativeTranscript.bytes.lastIndexOf(10) + 1, historicalNativeSource: input.nativeTranscript.source });
                delete metadata.checkpointToken;
                this.db.run('INSERT INTO run_control(run_id,project_id,execution_log_id,node_key,checkpoint_sequence,current_turn_id,metadata_content_id,binding_content_id,recovery_needed,run_sequence) VALUES(?,?,?,?,?,?,?,?,?,?)', [runId, projectId, executionLogId, nodeId, checkpointSequence, turnId, this.putStructuredContent(metadata), binding ? this.putStructuredContent(binding) : null, ['Running', 'Preparing', 'Turn Started'].includes(String(status.status)) ? 1 : 0, this.allocateOrderedRecordSequence('run_control', 'run_sequence')]);
                const turnIds = new Set([...previousTurns.map(turn => String(turn.turn_id)), String(turnId)]);
                for (const oldTurn of turnIds)
                    this.db.run('INSERT INTO relations VALUES(?,?,?)', [runId, 'source', oldTurn]);
                this.bindRunTurnJournal(projectId, runId, String(turnId), nodeId, metadata, currentExecutionLogId);
                for (const id of historicalExecutionLogIds.filter(id => id !== currentExecutionLogId)) {
                    const priorTurns = previousTurns.filter(turn => Number(turn.execution_log_id) === id);
                    let priorTurnId = priorTurns[priorTurns.length - 1]?.turn_id;
                    if (!priorTurnId) {
                        const journal = this.readProjectJournal(projectId, { executionLogId: id, limit: 1 }).logs[0];
                        if (!journal || journal.nodeId !== nodeId)
                            throw new Error('historical_run_identity_invalid');
                        const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM turns WHERE task_id=?', [taskId])[0].next);
                        priorTurnId = this.write({ kind: 'turn', action: 'create', scope: projectId, idempotencyKey: `${idempotencyKey}:journal-turn:${id}`, data: { task_id: taskId, sequence, request_content: null, started_at: Number.isFinite(Date.parse(journal.timestamp)) ? Date.parse(journal.timestamp) : null } }).objectId;
                        this.db.run('INSERT INTO relations VALUES(?,?,?)', [runId, 'source', priorTurnId]);
                    }
                    this.bindRunTurnJournal(projectId, runId, String(priorTurnId), nodeId, metadata, id);
                }
                if (input.output.length)
                    this.db.run('INSERT INTO log_chunks VALUES(?,?,?,?,?,?)', [runId, 'output', 0, this.putContent(input.output, 'application/octet-stream', 'binary'), now, 0]);
                if (input.nativeTranscript?.bytes.length)
                    this.db.run('INSERT INTO log_chunks VALUES(?,?,?,?,?,?)', [runId, 'native:codex', 0, this.putContent(input.nativeTranscript.bytes, 'application/x-ndjson', 'binary'), now, 0]);
                if (binding)
                    for (const revision of binding.revisions) {
                        const prefix = { ...binding, headRevision: revision.revision, revisions: binding.revisions.slice(0, revision.revision) };
                        if (revision.state === 'confirmed' && revision.sessionId)
                            prefix.resumableRevision = revision.revision;
                        else
                            delete prefix.resumableRevision;
                        const evidenceId = this.write({ kind: 'evidence', action: 'create', scope: projectId, idempotencyKey: `${idempotencyKey}:binding:${revision.revision}`, data: { run_id: runId, type: 'session_binding', source_actor_id: this.actorId, observed_at: now, source_revision: revision.revision, content: prefix } }).objectId;
                        const ordinal = Number(this.rows('SELECT COALESCE(MAX(binding_revision),0)+1 AS next FROM session_bindings WHERE conversation_id=?', [conversationId])[0].next);
                        this.db.run('INSERT INTO session_bindings VALUES(?,?,?,?,?,?,?,?)', [conversationId, ordinal, binding.provider, revision.sessionId || null, revision.state, revision.contract, evidenceId, revision.providerContext ? this.putStructuredContent(revision.providerContext) : null]);
                    }
                for (const [field, purpose, mimeType, objectKey, revisionKey] of [
                    ['workspaceBefore', (0, runWorkspace_1.workspaceDocumentPurpose)(String(turnId), 'before'), 'application/json', 'workspaceSnapshotObjectId', 'workspaceSnapshotRevision'],
                    ['changes', (0, runWorkspace_1.workspaceDocumentPurpose)(String(turnId), 'changes'), 'text/plain', 'workspaceChangesObjectId', 'workspaceChangesRevision'],
                    ['roadmapBackup', 'roadmap_backup', 'text/csv', 'roadmapBackupObjectId', 'roadmapBackupRevision']
                ]) {
                    const bytes = input[field];
                    if (!bytes)
                        continue;
                    const saved = this.writeRunDocumentContent(projectId, { executionLogId, generation: 1, turnId: String(turnId), purpose, bytes: bytes.toString('base64'), mimeType, expectedRevision: 0, idempotencyKey: `${idempotencyKey}:document:${purpose}` });
                    Object.assign(metadata, { [objectKey]: saved.objectId, [revisionKey]: saved.revision });
                }
                for (const report of this.rows('SELECT id,turn_id FROM reports WHERE project_id=? AND turn_id IN (SELECT turn_id FROM legacy_report_turns WHERE project_id=? AND task_id=? AND execution_log_id IN (SELECT value FROM json_each(?)))', [projectId, projectId, taskId, canonical(historicalExecutionLogIds)])) {
                    const old = this.readMetadata(String(report.id));
                    if (old.data.run_id && old.data.run_id !== runId)
                        throw new Error('historical_run_report_mismatch');
                    const associated = this.write({ kind: 'report', action: 'patch', scope: projectId, objectId: old.objectId, expectedRevision: old.revision, idempotencyKey: `${idempotencyKey}:report:${old.objectId}`, data: { run_id: runId } });
                    this.db.run('INSERT INTO report_version_sources SELECT object_id,?,source_identity,source_key,source_hash,source_content_id,source_capture_revision,source_created_at FROM report_version_sources WHERE object_id=? AND revision=?', [associated.revision, old.objectId, old.revision]);
                    if (report.turn_id === turnId)
                        Object.assign(metadata, { taskReportObjectId: associated.objectId, taskReportRevision: associated.revision, taskReportStatus: String(old.data.availability) });
                }
                this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putStructuredContent(metadata), runId]);
                if (appendedOutput)
                    this.writeHistoricalRunArtifact(projectId, { executionLogId, relativePath: appendedOutput.source.key, bytes: input.output, hash: appendedOutput.captured.hash, mimeType: appendedOutput.archived.mimeType }, 'output');
                for (const item of refreshedArtifacts)
                    this.writeHistoricalRunArtifact(projectId, { executionLogId, relativePath: item.source.key, bytes: item.captured.bytes, hash: item.captured.hash, mimeType: item.archived.mimeType }, item.kind);
                this.saveRunControlRevision(runId);
                if (needsConsumer)
                    this.insertRunConsumerSource(runId, projectId, String(turnId), checkpointSequence, 1);
                return this.current(runId);
            });
            this.db.run("UPDATE migration_items SET source_hash=?,object_id=?,imported_revision=?,stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [source.hash, receipt.objectId, receipt.revision, source.identity, source.key]);
            if (input.legacyCompletion)
                this.db.run("UPDATE migration_items SET object_id=?,imported_revision=?,stage='imported',error=NULL WHERE source_identity=? AND source_key=? AND source_hash=?", [receipt.objectId, receipt.revision, input.legacyCompletion.source.identity, input.legacyCompletion.source.key, input.legacyCompletion.source.hash]);
            return { unchanged: false, state: this.readRunState(projectId, executionLogId) };
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
    historicalRunOwnerAlive(status) {
        return this.hasLiveRunProcess({ process_pid: Number(status.agentPid || 0), process_birth: String(status.processBirth || ''), child_pid: Number(status.agentChildPid || 0), child_birth: String(status.processChildBirth || '') });
    }
    bindRunTurnJournal(projectId, runId, turnId, nodeId, metadata, requestedExecutionLogId = 0) {
        if (requestedExecutionLogId && this.rows('SELECT turn_id FROM run_turn_journals WHERE project_id=? AND execution_log_id=?', [projectId, requestedExecutionLogId]).length)
            throw new Error('execution_identity_conflict');
        const current = requestedExecutionLogId ? this.rows('SELECT node_id FROM project_journal_entries WHERE project_id=? AND execution_log_id=?', [projectId, requestedExecutionLogId])[0] : undefined;
        if (current && current.node_id !== nodeId)
            throw new Error('execution_identity_conflict');
        const timestamp = String(metadata.turnStartedAt || metadata.startedAt || new Date().toISOString());
        const result = current ? { executionLogId: requestedExecutionLogId } : this.appendProjectJournal(projectId, `run:${runId}:turn:${turnId}`, {
            nodeId, timestamp, agentCli: String(metadata.agentCli || ''), command: String(metadata.commandPreview || ''),
            output: [String(metadata.checkpointMessage || metadata.userMessage || ''), `Run started at: ${timestamp}`].filter(Boolean).join('\n\n'), status: 'Running'
        }, requestedExecutionLogId);
        this.db.run('INSERT INTO run_turn_journals VALUES(?,?,?,?)', [projectId, runId, turnId, result.executionLogId]);
    }
    saveRunControlRevision(runId) {
        this.db.run('INSERT INTO run_control_revisions SELECT run_id,objects.revision,generation,checkpoint_sequence,current_turn_id,metadata_content_id,binding_content_id,process_pid,process_birth,child_pid,child_birth,recovery_needed,delivery_pending,delivery_owner_id,delivery_pid,delivery_birth FROM run_control JOIN objects ON objects.id=run_id WHERE run_id=?', [runId]);
    }
    insertRunConsumerSource(runId, projectId, turnId, checkpoint, revision, updateQueued = false) {
        this.transaction(() => {
            const sequence = this.allocateOrderedRecordSequence('run_consumer_sources', 'run_consumer_sequence');
            this.db.run(`INSERT INTO run_consumer_sources(run_id,project_id,turn_id,checkpoint_sequence,source_revision,state,source_sequence) VALUES(?,?,?,?,?,'queued',?)${updateQueued ? " ON CONFLICT(run_id,turn_id,checkpoint_sequence) DO UPDATE SET source_revision=excluded.source_revision WHERE run_consumer_sources.state='queued'" : ''}`, [runId, projectId, turnId, checkpoint, revision, sequence]);
        });
    }
}
function invokeNative(store,name,args){const originals=new Map();for(const method of Object.getOwnPropertyNames(NativeHistoricalAdoptionOracle.prototype)){if(method==='constructor')continue;originals.set(method,Object.getOwnPropertyDescriptor(store,method));Object.defineProperty(store,method,{value:NativeHistoricalAdoptionOracle.prototype[method],configurable:true,writable:true});}try{return NativeHistoricalAdoptionOracle.prototype[name].call(store,...args);}finally{for(const [method,descriptor] of originals){if(descriptor)Object.defineProperty(store,method,descriptor);else delete store[method];}}}
module.exports={nativeRegisteredReport:(store,...args)=>invokeNative(store,'importRegisteredReport',args),nativeHistoricalAdoption:(store,...args)=>invokeNative(store,'adoptHistoricalRun',args)};

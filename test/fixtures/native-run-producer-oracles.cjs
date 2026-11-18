// Frozen actual Native run producers, for historical transaction and synchronous race oracles only.
// Source and exact method hashes: native-run-producer-oracles-v125.json in the task evidence.
const crypto=require('node:crypto'),path=require('node:path');
const {canonicalJson:canonical}=require('../../out/contentReferences.js');
const runWorkspace_1=require('../../out/runWorkspace.js');
const runLifecycleTypes_1=require('../../out/runLifecycleTypes.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

// Original method SHA256 bba3cd4d1f4a98ba9a9d0d74dcef346c90b6085953481f2aece4df15f59b55d7
function checkpointRun(projectId, input) {
        this.verifyRunProof(projectId, input.executionLogId, input.generation, input.proof);
        const receipt = this.recordMutation(this.checkpointIntent(projectId, input), input.idempotencyKey, 'checkpoint', () => {
            const row = this.runControl(projectId, input.executionLogId);
            if (row.revision !== input.expectedRevision)
                throw new Error('revision_conflict');
            if (input.expectedTurnId && input.expectedTurnId !== row.current_turn_id)
                throw new Error('checkpoint_turn_conflict');
            const nativeTimestamp = input.action === 'start' ? input.nativeStartedAt : input.action === 'complete' ? input.nativeCompletedAt : undefined;
            const now = input.workspaceEvidenceSource === 'native' && Number.isFinite(nativeTimestamp) ? nativeTimestamp : Date.now();
            const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
            if (input.action === 'session-close' && metadata.interactiveSession && ['claude', 'codex'].includes(String(metadata.sessionProvider))
                && Number(row.child_pid) > 0 && this.hasLiveRunProcess({ ...row, process_pid: 0 }))
                throw new Error('native_session_still_running');
            let status;
            let turnId = String(row.current_turn_id);
            let finishedAt = null;
            let exitCode = input.exitCode;
            let unreportedClose = false;
            const sealingNativeOnClose = input.action === 'session-close' && metadata.nativeOutputPending === true;
            const unusedSessionReentry = input.action === 'session-close' && row.status === 'Waiting'
                && metadata.agentInputMode === 'session_reentry' && metadata.nativeSessionReentryAwaitingRequest === true
                && !String(this.current(String(row.current_turn_id), false).data.request_content || '').trim();
            const finalizingNative = input.action === 'complete' && input.workspaceEvidenceSource === 'native' && metadata.nativeOutputPending === true && this.readMetadata(turnId).data.finished_at !== null;
            const acknowledgingInitialStart = input.action === 'start' && Number(row.checkpoint_sequence) === 0 && ['Preparing', 'Running'].includes(String(row.status)) && this.readMetadata(turnId).data.finished_at === null;
            const logOffsets = Object.fromEntries(['output', 'stdout', 'stderr'].map(stream => [stream, this.readRunLogHead(projectId, input.executionLogId, stream).totalBytes]));
            if (input.action === 'start') {
                if (metadata.hostOutputPending === true || metadata.nativeOutputPending === true)
                    throw new Error('run_output_pending');
                if (metadata.interactiveSessionClosed === true)
                    throw new Error('session_already_closed');
                const historicalNativeStart = input.workspaceEvidenceSource === 'native'
                    && input.nativeLogRange?.stream === metadata.stopNativeStream
                    && Number.isSafeInteger(input.nativeLogRange?.end)
                    && Number.isSafeInteger(metadata.stopNativeLogBoundary)
                    && input.nativeLogRange.end <= Number(metadata.stopNativeLogBoundary);
                if (metadata.stopRequested === true && !historicalNativeStart)
                    throw new Error('run_stop_requested');
                if (input.exitCode !== undefined)
                    throw new Error('invalid_checkpoint_exit_code');
                status = 'Running';
                this.db.run('UPDATE run_control SET recovery_needed=1 WHERE run_id=?', [row.run_id]);
                this.db.run('UPDATE runs SET exit_code=NULL WHERE id=?', [row.run_id]);
                const message = String(input.message || metadata.userMessage || '');
                Object.assign(metadata, { userMessage: message, checkpointMessage: message, checkpointOutcome: '', checkpointSummary: '', checkpointNext: '', checkpointImplicitTurn: false, checkpointStartSourceTurnId: String(row.current_turn_id), turnStartedAt: new Date(now).toISOString() });
                if (!acknowledgingInitialStart) {
                    if (['Running', 'Turn Started'].includes(String(row.status)))
                        throw new Error('turn_already_running');
                    if (!String(input.message || '').trim())
                        throw new Error('checkpoint_message_required');
                    const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM turns WHERE task_id=?', [row.task_id])[0].next);
                    turnId = this.write({ kind: 'turn', action: 'create', scope: projectId, idempotencyKey: `${input.idempotencyKey}:turn`, data: { task_id: String(row.task_id), sequence, request_content: input.message, started_at: now } }).objectId;
                    this.db.run('INSERT INTO relations VALUES(?,?,?)', [row.run_id, 'source', turnId]);
                    this.bindRunTurnJournal(projectId, String(row.run_id), turnId, String(row.node_key), metadata);
                }
                // Replaying a machine event cannot prove delivery of a subsequently saved policy.
                if (input.workspaceEvidenceSource !== 'native') {
                    const globalPolicy = this.globalPromptPolicyReference();
                    metadata.globalPromptPolicyRef = globalPolicy ? { objectId: globalPolicy.objectId, revision: globalPolicy.revision } : null;
                }
                metadata.turnLogStartOffsets = logOffsets;
                if (input.preserveRoadmapState !== undefined)
                    metadata.checkpointPreserveRoadmapState = input.preserveRoadmapState;
                delete metadata.turnLogEndOffsets;
                delete metadata.codexNativeAwaitingRequest;
                delete metadata.claudeNativeAwaitingRequest;
                delete metadata.failureCode;
                delete metadata.failureReason;
                delete metadata.taskReportObjectId;
                delete metadata.taskReportRevision;
                delete metadata.taskReportStatus;
                delete metadata.taskReportError;
            }
            else if (input.action === 'complete') {
                if (finalizingNative) {
                    const turn = this.readMetadata(turnId);
                    const aborted = input.outcome === 'failed';
                    this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: turnId, expectedRevision: turn.revision, data: { finished_at: now, ...(Number.isFinite(input.nativeStartedAt) ? { started_at: input.nativeStartedAt } : {}), ...(aborted ? { outcome: 'failed', summary_content: input.summary } : {}) }, idempotencyKey: `${input.idempotencyKey}:native-finished` });
                    if (aborted)
                        Object.assign(metadata, { checkpointOutcome: 'failed', checkpointSummary: input.summary });
                    metadata.nativeOutputPending = false;
                    status = aborted ? 'Failed' : String(row.status);
                    finishedAt = now;
                }
                else {
                    if (metadata.interactiveSessionClosed === true)
                        throw new Error('session_already_closed');
                    if (!['Preparing', 'Running', 'Waiting', 'Processed', 'Turn Started'].includes(String(row.status)))
                        throw new Error('turn_already_settled');
                    if (!['partial', 'candidate_complete', 'blocked_user', 'blocked_external', 'failed'].includes(String(input.outcome)))
                        throw new Error('invalid_checkpoint_outcome');
                    if (!String(input.summary || '').trim())
                        throw new Error('checkpoint_summary_required');
                    let outcome = input.outcome;
                    let summary = input.summary;
                    if (input.requireDeliverable && !metadata.interactiveSession && !['solo', 'solo_background', 'solo_continue', 'step_continue'].includes(String(row.run_kind)) && exitCode === 0 && outcome === 'partial') {
                        const baseline = this.readRunDocument(projectId, input.executionLogId, (0, runWorkspace_1.workspaceDocumentPurpose)(turnId, 'before'));
                        if (!baseline || !input.workspaceSnapshot)
                            throw new Error('workspace_baseline_required');
                        const before = JSON.parse(Buffer.from(baseline.bytes, 'base64').toString('utf8'));
                        if ((0, runWorkspace_1.workspaceChanges)(before, input.workspaceSnapshot).length === 0 && !(row.run_kind === 'learning_review' && this.hasLearningReviewDeliverable(projectId, metadata))) {
                            outcome = 'failed';
                            exitCode = 125;
                            summary = '本轮未产生项目变更，也未提交完成候选，请继续执行。';
                            Object.assign(metadata, { failureCode: 'no_deliverable_changes', failureReason: summary });
                        }
                    }
                    if (this.current(turnId, false).data.finished_at !== null) {
                        const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM turns WHERE task_id=?', [row.task_id])[0].next);
                        turnId = this.write({ kind: 'turn', action: 'create', scope: projectId, idempotencyKey: `${input.idempotencyKey}:implicit-turn`, data: { task_id: String(row.task_id), sequence, request_content: input.message || String(metadata.userMessage || ''), started_at: now } }).objectId;
                        this.db.run('INSERT INTO relations VALUES(?,?,?)', [row.run_id, 'source', turnId]);
                        Object.assign(metadata, { checkpointImplicitTurn: true, turnStartedAt: new Date(now).toISOString() });
                        this.bindRunTurnJournal(projectId, String(row.run_id), turnId, String(row.node_key), metadata);
                    }
                    const turn = this.current(turnId, false);
                    this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: turnId, expectedRevision: turn.revision, idempotencyKey: `${input.idempotencyKey}:turn`, data: { outcome, summary_content: summary, finished_at: now, ...(input.workspaceEvidenceSource === 'native' && Number.isFinite(input.nativeStartedAt) ? { started_at: input.nativeStartedAt } : {}) } });
                    status = outcome === 'failed' ? 'Failed' : 'In Progress';
                    finishedAt = now;
                    Object.assign(metadata, { checkpointMessage: input.message || metadata.userMessage || '', checkpointOutcome: outcome, checkpointSummary: summary, checkpointNext: input.next || '', checkpointAt: new Date(now).toISOString() });
                    let reportInput = { report: input.report ?? null, availability: input.reportAvailability || 'missing', validationError: input.reportValidationError || '' };
                    const existingReport = this.runReportHead(projectId, String(row.run_id), turnId);
                    const reportReceipt = input.report === undefined && existingReport
                        ? { objectId: existingReport.objectId, revision: existingReport.revision }
                        : this.recordMutation({ operation: 'checkpoint_report', projectId, runId: row.run_id, turnId, ...reportInput }, `${input.idempotencyKey}:report`, 'report', () => this.upsertRunReport(projectId, String(row.run_id), turnId, reportInput));
                    if (input.report === undefined && existingReport)
                        reportInput = { report: existingReport.data.content, availability: String(existingReport.data.availability), validationError: String(existingReport.data.validation_error || '') };
                    Object.assign(metadata, { taskReportObjectId: reportReceipt.objectId, taskReportRevision: reportReceipt.revision, taskReportStatus: reportInput.availability === 'available' ? 'recorded' : reportInput.availability, taskReportError: reportInput.validationError });
                }
            }
            else if (input.action === 'session-close') {
                const preserveInProgress = row.status === 'In Progress' && metadata.interactiveSession === true;
                status = preserveInProgress || ['Failed', 'Completed', 'Stopped'].includes(String(row.status)) ? String(row.status) : 'Session Closed';
                finishedAt = now;
                const turn = this.current(turnId, false);
                if (turn.data.finished_at === null) {
                    if (unusedSessionReentry) {
                        this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: turnId, expectedRevision: turn.revision,
                            idempotencyKey: `${input.idempotencyKey}:turn`, data: { outcome: 'partial', summary_content: '', finished_at: now } });
                        Object.assign(metadata, { nativeSessionReentryAwaitingRequest: false, sessionReentryClosedWithoutInput: true });
                    }
                    else {
                        unreportedClose = true;
                        if (['Preparing', 'Running', 'Turn Started'].includes(String(row.status)))
                            status = 'Failed';
                        const summary = '会话已关闭，本轮尚未提交结果；已保留执行记录，可继续处理。';
                        this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: turnId, expectedRevision: turn.revision, idempotencyKey: `${input.idempotencyKey}:turn`, data: { outcome: 'failed', summary_content: summary, finished_at: now } });
                        const reportInput = { report: null, availability: 'missing', validationError: '' };
                        const existingReport = this.runReportHead(projectId, String(row.run_id), turnId);
                        const reportReceipt = existingReport
                            ? { objectId: existingReport.objectId, revision: existingReport.revision }
                            : this.recordMutation({ operation: 'checkpoint_report', projectId, runId: row.run_id, turnId, ...reportInput }, `${input.idempotencyKey}:report`, 'report', () => this.upsertRunReport(projectId, String(row.run_id), turnId, reportInput));
                        Object.assign(metadata, { failureCode: 'checkpoint_missing', failureReason: summary, checkpointOutcome: 'failed', checkpointSummary: summary, checkpointAt: new Date(now).toISOString(), taskReportObjectId: reportReceipt.objectId, taskReportRevision: reportReceipt.revision, taskReportStatus: 'missing', taskReportError: '' });
                    }
                }
                metadata.nativeOutputPending = false;
                Object.assign(metadata, { interactiveSessionClosed: true, sessionExitCode: input.exitCode ?? 0, sessionClosePreviousStatus: row.status });
            }
            else
                throw new Error('invalid_checkpoint_action');
            if (input.action === 'start') {
                for (const key of ['nativeTokenUsage', 'nativeReplyObjectId', 'nativeReplyRevision', 'nativeWorkspaceObservationObjectId', 'nativeWorkspaceObservationRevision', 'workspaceEvidenceBoundary', 'workspaceSnapshotObjectId', 'workspaceSnapshotRevision', 'workspaceChangesObjectId', 'workspaceChangesRevision', 'workspaceAfterObjectId', 'workspaceAfterRevision', 'workspaceChangeCount'])
                    delete metadata[key];
                metadata.baseGitHash = input.gitBaseline || '';
                delete metadata.gitEvidenceObjectId;
                delete metadata.gitEvidenceRevision;
            }
            else if (input.gitEvidence && (input.action !== 'session-close' || unreportedClose || sealingNativeOnClose)) {
                this.saveRunGitEvidence(projectId, input.executionLogId, input.generation, turnId, input.gitEvidence, metadata, input.idempotencyKey);
            }
            if (input.gitAfterHash !== undefined)
                metadata.workspaceAfterGitHash = input.gitAfterHash;
            if (input.workspaceEvidenceSource === 'native' && input.nativeWorkspaceObservation) {
                const observed = this.writeRunDocumentContent(projectId, { executionLogId: input.executionLogId, generation: input.generation, turnId, purpose: `native_workspace_observation_${turnId.replace(/-/g, '')}`, bytes: Buffer.from(JSON.stringify(input.nativeWorkspaceObservation)).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: `${input.idempotencyKey}:native-workspace-observation` });
                Object.assign(metadata, { workspaceEvidenceBoundary: finalizingNative && metadata.workspaceEvidenceSource === 'checkpoint' ? 'recorded_at_business_completion' : 'unavailable', nativeWorkspaceObservationObjectId: observed.objectId, nativeWorkspaceObservationRevision: observed.revision });
                if (!finalizingNative)
                    for (const key of ['gitEvidenceObjectId', 'gitEvidenceRevision', 'workspaceChangesObjectId', 'workspaceChangesRevision', 'workspaceAfterObjectId', 'workspaceAfterRevision', 'workspaceChangeCount'])
                        delete metadata[key];
            }
            else if (input.workspaceEvidenceSource === 'native' && input.workspaceSnapshot)
                metadata.workspaceEvidenceBoundary = 'recorded';
            if (input.action === 'complete' && input.workspaceEvidenceSource === 'native' && input.nativeReply !== undefined) {
                const reply = this.writeRunDocumentContent(projectId, { executionLogId: input.executionLogId, generation: input.generation, turnId, purpose: `native_reply_${turnId.replace(/-/g, '')}`, bytes: Buffer.from(input.nativeReply).toString('base64'), mimeType: 'text/plain', expectedRevision: 0, idempotencyKey: `${input.idempotencyKey}:native-reply` });
                Object.assign(metadata, { nativeReplyObjectId: reply.objectId, nativeReplyRevision: reply.revision });
            }
            if (input.workspaceEvidenceSource === 'native' && input.nativeTokenUsage) {
                const usage = input.nativeTokenUsage;
                if (Object.values(usage).some(value => !Number.isInteger(value) || value < 0))
                    throw new Error('invalid_run_usage');
                metadata.nativeTokenUsage = usage;
                this.db.run('UPDATE runs SET input_tokens=?,cached_input_tokens=?,output_tokens=?,reasoning_output_tokens=?,total_tokens=? WHERE id=?', [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.reasoningOutputTokens, usage.totalTokens, row.run_id]);
            }
            if (input.workspaceSnapshot && (input.action !== 'session-close' || unreportedClose || sealingNativeOnClose)) {
                metadata.workspaceObservedAt = new Date().toISOString();
                metadata.workspaceEvidenceSource = input.workspaceEvidenceSource || 'checkpoint';
                const save = (phase, value) => {
                    const purpose = (0, runWorkspace_1.workspaceDocumentPurpose)(turnId, phase);
                    const previous = this.readRunDocument(projectId, input.executionLogId, purpose);
                    const saved = this.writeRunDocumentContent(projectId, { executionLogId: input.executionLogId, generation: input.generation, turnId, purpose, bytes: Buffer.from(value).toString('base64'), mimeType: phase === 'changes' ? 'text/plain' : 'application/json', expectedRevision: previous?.revision || 0, idempotencyKey: `${input.idempotencyKey}:workspace:${phase}` });
                    metadata[phase === 'before' ? 'workspaceSnapshotRevision' : phase === 'after' ? 'workspaceAfterRevision' : 'workspaceChangesRevision'] = saved.revision;
                    return saved.objectId;
                };
                if (input.action === 'start') {
                    metadata.workspaceSnapshotObjectId = save('before', JSON.stringify(input.workspaceSnapshot));
                    delete metadata.workspaceChangesObjectId;
                    delete metadata.workspaceChangesRevision;
                    delete metadata.workspaceAfterObjectId;
                    delete metadata.workspaceAfterRevision;
                    delete metadata.workspaceChangeCount;
                }
                else {
                    const implicit = turnId !== row.current_turn_id;
                    const baseline = this.readRunDocument(projectId, input.executionLogId, (0, runWorkspace_1.workspaceDocumentPurpose)(String(row.current_turn_id), implicit ? 'after' : 'before'));
                    const before = baseline ? JSON.parse(Buffer.from(baseline.bytes, 'base64').toString('utf8')) : {};
                    if (implicit)
                        metadata.workspaceSnapshotObjectId = save('before', JSON.stringify(before));
                    else if (baseline) {
                        metadata.workspaceSnapshotObjectId = baseline.objectId;
                        metadata.workspaceSnapshotRevision = baseline.revision;
                    }
                    const changes = (0, runWorkspace_1.workspaceChanges)(before, input.workspaceSnapshot);
                    metadata.workspaceChangesObjectId = save('changes', changes.join('\n'));
                    metadata.workspaceAfterObjectId = save('after', JSON.stringify(input.workspaceSnapshot));
                    metadata.workspaceChangeCount = changes.length;
                }
            }
            if (input.action === 'complete' && !metadata.interactiveSession && this.hasLiveRunProcess(row))
                metadata.hostOutputPending = true;
            if (input.action === 'complete' && metadata.interactiveSession && ['codex', 'claude'].includes(String(metadata.sessionProvider)) && input.workspaceEvidenceSource !== 'native'
                && (input.exitCode === undefined || Number(row.child_pid) > 0 && this.hasLiveRunProcess({ ...row, process_pid: 0 }))
                && (metadata[`${String(metadata.sessionProvider)}NativeBoundTurnId`] === turnId || this.readRunBinding(projectId, input.executionLogId)))
                metadata.nativeOutputPending = true;
            if (input.action !== 'start')
                metadata.turnLogEndOffsets = logOffsets;
            if (input.workspaceEvidenceSource === 'native' && input.nativeLogRange) {
                const { start, end } = input.nativeLogRange;
                const stream = input.nativeLogRange.stream || 'native:codex';
                if (!['native:codex', 'native:claude'].includes(stream) || stream !== `native:${String(metadata.sessionProvider)}`)
                    throw new Error('native_source_range_invalid');
                const head = this.readRunLogHead(projectId, input.executionLogId, stream);
                if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > head.totalBytes)
                    throw new Error('native_source_range_invalid');
                metadata.turnLogStartOffsets = { ...(metadata.turnLogStartOffsets || {}), [stream]: start };
                metadata.turnLogEndOffsets = { ...(metadata.turnLogEndOffsets || {}), [stream]: end };
            }
            if (input.nativeSessionObservation && input.action !== 'session-close') {
                const observation = input.nativeSessionObservation;
                if (observation.provider !== 'claude' || observation.source !== 'CLAUDE_CODE_SESSION_ID' || typeof observation.sessionId !== 'string')
                    throw new Error('invalid_native_session_observation');
                const binding = this.readRunBinding(projectId, input.executionLogId);
                const head = binding?.revisions[binding.headRevision - 1];
                if (binding?.provider === observation.provider && path.resolve(binding.workspaceRoot) === path.resolve(String(metadata.workspaceRoot))
                    && (head?.state === 'planned' || head?.state === 'confirmed' && observation.sessionId !== head.sessionId) && head.sessionId === metadata.plannedNativeSessionId) {
                    const evidence = { source: observation.source, turnId, generation: input.generation };
                    const confirmed = this.writeRunBinding(projectId, {
                        executionLogId: input.executionLogId, generation: input.generation, expectedHeadRevision: binding.headRevision,
                        ...(observation.sessionId === head.sessionId ? { confirmSessionId: head.sessionId, evidence } : { revision: {
                                ...(observation.sessionId ? { sessionId: observation.sessionId } : {}), supersedesRevision: binding.headRevision,
                                method: head.method, contract: head.contract, state: 'conflict', errorCode: 'identity_provider_mismatch', ...(head.providerContext ? { providerContext: head.providerContext } : {}), evidence
                            } }), idempotencyKey: `${input.idempotencyKey}:provider-observation`
                    });
                    const resumable = confirmed.resumableRevision === confirmed.headRevision && confirmed.revisions[confirmed.headRevision - 1].state === 'confirmed';
                    Object.assign(metadata, { sessionProvider: confirmed.provider, sessionBindingHeadRevision: confirmed.headRevision, nativeSessionId: resumable ? observation.sessionId : '', nativeSessionIdIsCurrent: resumable });
                }
            }
            const unverifiedProviderCompletion = input.action === 'complete' && metadata.interactiveSession && ['opencode', 'antigravity'].includes(String(metadata.sessionProvider));
            const unobservedSessionClose = input.action === 'session-close' && metadata.interactiveSession;
            if (unverifiedProviderCompletion || unobservedSessionClose) {
                const binding = this.readRunBinding(projectId, input.executionLogId);
                const head = binding?.revisions[binding.headRevision - 1];
                if (binding && head && (head.state === 'preparing' || unobservedSessionClose && head.state === 'planned')) {
                    const unavailable = this.writeRunBinding(projectId, {
                        executionLogId: input.executionLogId, generation: input.generation, expectedHeadRevision: binding.headRevision,
                        revision: { supersedesRevision: binding.headRevision, method: head.method, contract: head.contract,
                            state: 'unavailable', errorCode: unverifiedProviderCompletion ? 'identity_capability_unverified' : 'identity_not_observed',
                            ...(head.providerContext ? { providerContext: head.providerContext } : {}), evidence: { ...(head.evidence || {}), source: 'business_checkpoint', turnId } },
                        idempotencyKey: `${input.idempotencyKey}:unobserved-identity`
                    });
                    Object.assign(metadata, { sessionBindingHeadRevision: unavailable.headRevision, nativeSessionId: '', nativeSessionIdIsCurrent: false });
                }
            }
            metadata.checkpointEventId = `${Number(row.checkpoint_sequence) + 1}:${input.action}`;
            this.db.run('UPDATE run_control SET checkpoint_sequence=checkpoint_sequence+1,current_turn_id=?,metadata_content_id=? WHERE run_id=?', [turnId, this.putStructuredContent(metadata), row.run_id]);
            this.db.run('UPDATE runs SET turn_id=?,status=?,finished_at=? WHERE id=?', [turnId, status, finishedAt, row.run_id]);
            if (exitCode !== undefined) {
                if (!Number.isInteger(exitCode) || exitCode < 0)
                    throw new Error('invalid_run_exit_code');
                this.db.run('UPDATE runs SET exit_code=? WHERE id=?', [exitCode, row.run_id]);
            }
            if (metadata.hostOutputPending)
                this.db.run('UPDATE run_control SET recovery_needed=1 WHERE run_id=?', [row.run_id]);
            else if (input.action === 'session-close' || (exitCode !== undefined && !metadata.interactiveSession))
                this.db.run('UPDATE run_control SET recovery_needed=0 WHERE run_id=?', [row.run_id]);
            else if (metadata.interactiveSession)
                this.db.run('UPDATE run_control SET recovery_needed=1 WHERE run_id=?', [row.run_id]);
            if (input.action === 'start' && acknowledgingInitialStart) {
                const journal = this.readRunTurnJournal(projectId, input.executionLogId, turnId);
                this.updateProjectJournal(projectId, journal.executionLogId, { ...journal.entry, status: 'Running' });
            }
            else if (input.action !== 'start') {
                const journal = this.readRunTurnJournal(projectId, input.executionLogId, turnId);
                const evidence = input.action === 'complete' || unreportedClose ? [
                    `Completion decision:\n${String(metadata.checkpointSummary || '')}`,
                    `Checkpoint outcome: ${String(metadata.checkpointOutcome || '')}`,
                    ...(metadata.workspaceChangesObjectId ? [`Workspace changes:\n${Buffer.from(this.readRunDocument(projectId, input.executionLogId, (0, runWorkspace_1.workspaceDocumentPurpose)(turnId, 'changes')).bytes, 'base64').toString('utf8')}`] : []),
                ] : ['Interactive session state: Closed'];
                this.updateProjectJournal(projectId, journal.executionLogId, { ...journal.entry, status, output: [journal.entry.output, ...evidence].filter(Boolean).join('\n\n') });
            }
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [now, row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            const current = this.current(String(row.run_id), false);
            if (input.action !== 'start' && !unusedSessionReentry && !metadata.hostOutputPending && !metadata.nativeOutputPending)
                this.insertRunConsumerSource(String(row.run_id), projectId, turnId, Number(row.checkpoint_sequence) + 1, current.revision);
            return current;
        }, undefined, false);
        return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
    }

// Original method SHA256 a4198d9afd46061b37e1ecd9eebf1f1702ba8a96f6eeeadd919373ed80e4d212
function finalizeRunOutput(projectId, input) {
        this.verifyRunProof(projectId, input.executionLogId, input.generation, input.proof);
        if (!Number.isInteger(input.exitCode) || input.exitCode < 0 || !['host', 'recovery'].includes(input.source))
            throw new Error('invalid_run_finalization');
        const receipt = this.recordMutation(this.runOutputFinalizationIntent(projectId, input), input.idempotencyKey, 'output_finalized', () => {
            const row = this.runControl(projectId, input.executionLogId);
            if (row.revision !== input.expectedRevision)
                throw new Error('revision_conflict');
            if (row.current_turn_id !== input.expectedTurnId)
                throw new Error('checkpoint_turn_conflict');
            const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
            if (!metadata.hostOutputPending || metadata.interactiveSession || this.readMetadata(input.expectedTurnId).data.finished_at === null)
                throw new Error('run_output_not_pending');
            if (input.source === 'recovery' && this.hasLiveRunProcess(row))
                throw new Error('run_owner_alive');
            if (!input.workspaceSnapshot)
                throw new Error('workspace_snapshot_required');
            const now = Date.now();
            const baseline = this.readRunDocument(projectId, input.executionLogId, (0, runWorkspace_1.workspaceDocumentPurpose)(input.expectedTurnId, 'before'));
            if (input.gitEvidence)
                this.saveRunGitEvidence(projectId, input.executionLogId, input.generation, input.expectedTurnId, input.gitEvidence, metadata, input.idempotencyKey);
            const before = baseline ? JSON.parse(Buffer.from(baseline.bytes, 'base64').toString('utf8')) : {};
            const changes = (0, runWorkspace_1.workspaceChanges)(before, input.workspaceSnapshot);
            for (const [phase, bytes] of [['after', JSON.stringify(input.workspaceSnapshot)], ['changes', changes.join('\n')]]) {
                const purpose = (0, runWorkspace_1.workspaceDocumentPurpose)(input.expectedTurnId, phase);
                const previous = this.readRunDocument(projectId, input.executionLogId, purpose);
                const document = this.writeRunDocumentContent(projectId, { executionLogId: input.executionLogId, generation: input.generation, turnId: input.expectedTurnId, purpose, bytes: Buffer.from(bytes).toString('base64'), mimeType: phase === 'after' ? 'application/json' : 'text/plain', expectedRevision: previous?.revision || 0, idempotencyKey: `${input.idempotencyKey}:${phase}` });
                metadata[phase === 'after' ? 'workspaceAfterObjectId' : 'workspaceChangesObjectId'] = document.objectId;
                metadata[phase === 'after' ? 'workspaceAfterRevision' : 'workspaceChangesRevision'] = document.revision;
            }
            metadata.workspaceChangeCount = changes.length;
            metadata.workspaceObservedAt = new Date(now).toISOString();
            metadata.workspaceEvidenceSource = input.source;
            metadata.turnLogEndOffsets = Object.fromEntries(['output', 'stdout', 'stderr'].map(stream => [stream, this.readRunLogHead(projectId, input.executionLogId, stream).totalBytes]));
            metadata.hostOutputPending = false;
            metadata.hostOutputFinalizedAt = new Date(now).toISOString();
            metadata.hostOutputSource = input.source;
            let exitCode = row.status === 'Failed' && Number(row.exit_code) !== 0 ? Number(row.exit_code) : input.exitCode;
            const maintenanceResult = runLifecycleTypes_1.maintenanceResultRunKinds.includes(String(row.run_kind)) && this.readRunDocument(projectId, input.executionLogId, `maintenance_result_${input.generation}`);
            const noDeliverable = exitCode === 0 && metadata.checkpointOutcome === 'partial' && !maintenanceResult && !runLifecycleTypes_1.maintenanceResultRunKinds.includes(String(row.run_kind)) && !runLifecycleTypes_1.migrationRunKinds.includes(String(row.run_kind)) && !(row.run_kind === 'agent_review' && metadata.agentLaunch?.readOnly) && !['solo', 'solo_background', 'solo_continue', 'step_continue', 'flow_planner', 'flow_verifier'].includes(String(row.run_kind)) && changes.length === 0 && !(row.run_kind === 'learning_review' && this.hasLearningReviewDeliverable(projectId, metadata));
            if (noDeliverable)
                exitCode = 125;
            const status = exitCode === 0 ? String(row.status) : 'Failed';
            if ((input.exitCode !== 0 || noDeliverable) && metadata.checkpointOutcome !== 'failed') {
                const turn = this.readMetadata(input.expectedTurnId);
                const summary = noDeliverable ? '本轮未产生项目变更，也未提交完成候选，请继续执行。' : input.source === 'recovery' ? '执行在宿主收口前中断，完整已提交记录已保留。' : `执行最终退出码为 ${input.exitCode}，完整输出已保存。`;
                this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: turn.objectId, expectedRevision: turn.revision, data: { outcome: 'failed', summary_content: summary }, idempotencyKey: `${input.idempotencyKey}:turn` });
                Object.assign(metadata, { checkpointOutcome: 'failed', checkpointSummary: summary, failureCode: noDeliverable ? 'no_deliverable_changes' : input.source === 'recovery' ? 'host_interrupted' : 'agent_exit_nonzero', failureReason: summary });
            }
            this.db.run('UPDATE run_control SET metadata_content_id=?,recovery_needed=0 WHERE run_id=?', [this.putStructuredContent(metadata), row.run_id]);
            this.db.run('UPDATE runs SET status=?,exit_code=?,finished_at=? WHERE id=?', [status, exitCode, now, row.run_id]);
            const journal = this.readRunTurnJournal(projectId, input.executionLogId, input.expectedTurnId);
            this.updateProjectJournal(projectId, journal.executionLogId, { ...journal.entry, status });
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [now, row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            this.insertRunConsumerSource(String(row.run_id), projectId, input.expectedTurnId, Number(row.checkpoint_sequence), Number(row.revision) + 1);
            return this.current(String(row.run_id), false);
        }, undefined, false);
        return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
    }

// Original method SHA256 49ceb9acf87e37d681fc6bfa15806f5788093a8baa991073eeab460ae0f8a3f7
function commitRunSettlement(projectId, input) {
        if (!input.journal || ['agentCli', 'command', 'output', 'status'].some(key => typeof input.journal[key] !== 'string') || !input.digest || typeof input.digest !== 'object')
            throw new Error('invalid_run_settlement');
        const receipt = this.recordMutation({ operation: 'commit_run_settlement', projectId, input }, input.idempotencyKey, 'settle', () => {
            const row = this.runControl(projectId, input.executionLogId);
            const lease = this.rows('SELECT * FROM run_consumer_leases WHERE run_id=?', [row.run_id])[0];
            if (!lease || lease.state !== 'claimed' || lease.token !== input.token)
                throw new Error('run_consumer_lease_lost');
            if (lease.head_revision !== row.revision || row.generation !== input.generation)
                throw new Error('run_consumer_source_changed');
            const source = this.rows('SELECT * FROM run_consumer_sources WHERE run_id=? AND source_revision=?', [row.run_id, input.expectedRevision])[0];
            if (!source || source.state !== 'queued' || source.turn_id !== input.expectedTurnId || lease.source_revision !== input.expectedRevision || lease.turn_id !== input.expectedTurnId || lease.checkpoint_sequence !== source.checkpoint_sequence)
                throw new Error('run_consumer_source_changed');
            const journal = this.readRunTurnJournal(projectId, input.executionLogId, input.expectedTurnId);
            if (input.digest.nodeId !== row.node_key || input.digest.executionLogId !== journal.executionLogId)
                throw new Error('run_settlement_identity_mismatch');
            const original = this.readRunState(projectId, input.executionLogId, input.expectedRevision);
            const metadata = original.status;
            const previousTurn = this.rows('SELECT learning_event_id FROM run_settlements WHERE run_id=? AND turn_id=? ORDER BY checkpoint_sequence LIMIT 1', [row.run_id, input.expectedTurnId])[0];
            let settledFlow;
            if (input.flowUpdate && !previousTurn) {
                if (!String(row.node_key).startsWith(`__flow__::${input.flowUpdate.flow.flowId}::`))
                    throw new Error('flow_role_identity_mismatch');
                settledFlow = this.writeFlowTrace(projectId, { ...input.flowUpdate, idempotencyKey: `${input.idempotencyKey}:flow` });
            }
            const payload = { journal: input.journal, digest: input.digest, ...(settledFlow ? { flowObjectId: settledFlow.objectId, flowRevision: settledFlow.revision } : {}), ...(input.documentationAudit ? { documentationAudit: input.documentationAudit } : {}), ...(input.handoff ? { handoff: input.handoff } : {}), ...(input.learning ? { learning: input.learning } : {}), ...(input.index ? { index: input.index } : {}), reportObjectId: String(metadata.taskReportObjectId || ''), reportRevision: Number(metadata.taskReportRevision || 0), sourceRevision: input.expectedRevision };
            const payloadId = this.putStructuredContent(payload);
            const digestId = this.putStructuredContent(input.digest);
            const handoffId = input.handoff ? this.putStructuredContent(input.handoff) : null;
            const now = Date.now();
            const sourceKey = `${input.expectedTurnId.replace(/-/g, '')}_${Number(source.checkpoint_sequence)}`;
            const document = this.writeRunDocumentContent(projectId, { executionLogId: input.executionLogId, generation: input.generation, turnId: input.expectedTurnId, purpose: `settlement_${sourceKey}`, bytes: this.content(payloadId).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: `${input.idempotencyKey}:evidence` });
            this.saveRunDigestSource(projectId, `native:${row.run_id}:${input.expectedTurnId}:${source.checkpoint_sequence}`, Buffer.from(canonical(input.digest)), document.objectId);
            if (input.documentationAudit && !previousTurn)
                this.writeDocumentationManifest(projectId, input.documentationAudit.manifest, String(row.run_id), input.expectedRevision, `${input.idempotencyKey}:documentation`);
            let learningEventId = null;
            let settlementVerification = null;
            if (input.verification) {
                if (!Number.isInteger(input.verification.revision) || input.verification.revision < 1)
                    throw new Error('run_verification_reference_invalid');
                const verification = this.readMetadata(input.verification.objectId, input.verification.revision);
                const runTask = this.rows('SELECT task_id FROM runs WHERE id=? AND project_id=?', [row.run_id, projectId])[0];
                const evidence = verification.kind === 'verification' && verification.data.evidence_id ? this.readMetadata(String(verification.data.evidence_id)) : null;
                if (verification.kind !== 'verification' || verification.projectId !== projectId || verification.data.run_id !== row.run_id || verification.data.task_id !== runTask?.task_id || !['pass', 'fail'].includes(String(verification.data.result)) || evidence?.kind !== 'evidence' || evidence.projectId !== projectId || evidence.data.run_id !== row.run_id || evidence.data.type !== 'host_verification')
                    throw new Error('run_verification_reference_invalid');
                settlementVerification = verification;
            }
            if (input.learning) {
                if (!input.learning.eventType || typeof input.learning.summary !== 'string' || !input.learning.metadata)
                    throw new Error('invalid_settlement_learning');
                const learningMetadata = input.learning.metadata;
                const flowScoring = learningMetadata.scoring && typeof learningMetadata.scoring === 'object' ? learningMetadata.scoring : null;
                const formalFlowVerification = input.learning.eventType === 'verified' && learningMetadata.sourceType === 'flow_loop' && learningMetadata.recommendedStatus === 'closed' && flowScoring?.recommendedStatus === 'closed';
                const eventType = settlementVerification?.data.result === 'pass' || formalFlowVerification ? 'verified' : settlementVerification?.data.result === 'fail' ? 'verified_failed' : input.learning.eventType === 'verified' ? 'completed' : input.learning.eventType;
                const verificationSignal = settlementVerification?.data.result === 'pass' || formalFlowVerification;
                learningEventId = previousTurn?.learning_event_id ? String(previousTurn.learning_event_id) : this.write({ kind: 'learning_event', action: 'create', scope: projectId, data: { source_object_id: input.expectedTurnId, event_type: eventType, summary: input.learning.summary, occurred_at: now, source_revision: this.readMetadata(input.expectedTurnId).revision, source_type: String(learningMetadata.sourceType || ''), verification_signal: verificationSignal }, idempotencyKey: `${input.idempotencyKey}:learning` }).objectId;
                this.db.run('INSERT INTO relations VALUES(?,?,?)', [learningEventId, 'source', document.objectId]);
                if (metadata.taskReportObjectId)
                    this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [learningEventId, 'source', String(metadata.taskReportObjectId)]);
            }
            try {
                this.transaction(() => this.recordRsiAdoptions(projectId, String(row.run_id), input.expectedTurnId, metadata, learningEventId, settlementVerification));
            }
            catch (error) {
                const code = error instanceof Error ? error.message : String(error);
                if (!/^(?:rsi_|object_missing|revision_missing)/.test(code))
                    throw error;
                this.write({ kind: 'evidence', action: 'create', scope: projectId, idempotencyKey: `${input.idempotencyKey}:learning-rejected`, data: {
                        run_id: row.run_id, type: 'learning_adoption_rejected', source_actor_id: this.actorId, observed_at: now, content: canonical({ turnId: input.expectedTurnId, code })
                    } });
            }
            if (input.handoff && !previousTurn) {
                this.insertStepHandoff(projectId, String(row.node_key), String(row.run_id), input.expectedTurnId, Number(source.checkpoint_sequence), String(handoffId));
                this.recordMutation({ operation: 'settlement_step_memory', projectId, nodeId: row.node_key, sourceObjectId: document.objectId }, `${input.idempotencyKey}:step-memory`, 'step_memory', () => this.saveStepMemoryRevision(projectId, String(row.node_key), undefined, document.objectId));
            }
            this.updateProjectJournal(projectId, journal.executionLogId, input.journal);
            if (metadata.interactiveSessionClosed === true) {
                const closedJournals = this.rows("SELECT j.execution_log_id FROM relations r JOIN run_turn_journals j ON j.project_id=? AND j.turn_id=r.target_id WHERE r.source_id=? AND r.relation='source' AND j.run_id=?", [projectId, row.run_id, row.run_id]);
                for (const mapping of closedJournals) {
                    const old = this.readProjectJournal(projectId, { executionLogId: Number(mapping.execution_log_id) }).logs[0];
                    const output = old.output.replace(/Interactive session state:\s*(?:Open|Waiting|Running)/gi, 'Interactive session state: Closed');
                    if (output !== old.output)
                        this.updateProjectJournal(projectId, old.id, { ...old, output });
                }
            }
            if (input.index) {
                if (input.index.record.executionLogId !== journal.executionLogId || input.index.record.nodeId !== row.node_key)
                    throw new Error('run_settlement_identity_mismatch');
                this.upsertProjectRunIndex(projectId, input.index.record, input.index.files, input.index.signals);
            }
            this.db.run('INSERT INTO run_settlements VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [row.run_id, input.expectedTurnId, source.checkpoint_sequence, projectId, journal.executionLogId, input.expectedRevision, payloadId, digestId, handoffId, learningEventId, now, this.allocateOrderedRecordSequence('run_settlements', 'run_settlement_sequence')]);
            const effectKinds = new Set();
            const tracked = this.rows("SELECT 1 FROM mcp_conversation_launches l JOIN run_launch_intents i ON i.project_id=l.project_id AND i.launch_intent_id=l.launch_intent_id WHERE i.run_id=? AND l.source='telegram'", [row.run_id]).length > 0;
            for (const effect of input.effects || []) {
                if (!effect || !['roadmap', 'review', 'revision', 'refresh', 'telegram', 'automation', 'flow', 'documentation'].includes(effect.kind) || !effect.payload || typeof effect.payload !== 'object' || Array.isArray(effect.payload) || effectKinds.has(effect.kind))
                    throw new Error('invalid_run_effect');
                effectKinds.add(effect.kind);
                if (tracked && effect.kind === 'telegram')
                    continue;
                if (previousTurn && effect.kind !== 'refresh')
                    continue;
                this.db.run("INSERT INTO run_effects(id,project_id,run_id,turn_id,checkpoint_sequence,execution_log_id,source_revision,kind,payload_content_id,effect_sequence,state) VALUES(?,?,?,?,?,?,?,?,?,?,'queued')", [crypto.randomUUID(), projectId, row.run_id, input.expectedTurnId, source.checkpoint_sequence, journal.executionLogId, input.expectedRevision, effect.kind, this.putStructuredContent(effect.payload), this.allocateOrderedRecordSequence('run_effects', 'run_effect_sequence')]);
            }
            this.db.run('INSERT INTO run_summaries VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET summary_content_id=excluded.summary_content_id,handoff_content_id=excluded.handoff_content_id,source_revision=excluded.source_revision WHERE run_summaries.source_revision<=excluded.source_revision', [row.run_id, digestId, handoffId, input.expectedRevision]);
            if (row.current_turn_id === input.expectedTurnId && row.checkpoint_sequence === source.checkpoint_sequence) {
                const currentMetadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
                const keepOpen = currentMetadata.interactiveSession === true && currentMetadata.interactiveSessionClosed !== true;
                Object.assign(currentMetadata, { checkpointSettledStatus: input.journal.status, processedAt: new Date(now).toISOString(), processedCheckpointSequence: Number(source.checkpoint_sequence), ...(keepOpen ? { waitingSince: new Date(now).toISOString() } : {}) });
                this.db.run('UPDATE runs SET status=? WHERE id=?', [keepOpen ? 'Waiting' : 'Processed', row.run_id]);
                this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putStructuredContent(currentMetadata), row.run_id]);
            }
            this.db.run("UPDATE run_consumer_sources SET state='committed' WHERE run_id=? AND source_revision=?", [row.run_id, input.expectedRevision]);
            this.db.run("UPDATE run_consumer_leases SET state='committed' WHERE run_id=? AND token=?", [row.run_id, input.token]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [now, row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            this.conversationTracking().notifyRun(projectId, String(row.run_id), input.expectedTurnId, input.expectedRevision);
            return this.current(String(row.run_id), false);
        }, undefined, false);
        return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
    }

// Original method SHA256 71a88fd214956b80d67d6a5de9707ec197f8d1e00483ae724463bbde0911a4b1
function saveRunGitEvidence(projectId, executionLogId, generation, turnId, evidence, metadata, key) {
        const purpose = (0, runWorkspace_1.gitEvidenceDocumentPurpose)(turnId);
        const previous = this.readRunDocument(projectId, executionLogId, purpose);
        const saved = this.writeRunDocumentContent(projectId, { executionLogId, generation, turnId, purpose, bytes: Buffer.from(JSON.stringify(evidence)).toString('base64'), mimeType: 'application/json', expectedRevision: previous?.revision || 0, idempotencyKey: `${key}:git-evidence` });
        Object.assign(metadata, { gitEvidenceObjectId: saved.objectId, gitEvidenceRevision: saved.revision });
    }

// Original method SHA256 2447c28c0dc329ff8671a22439d3bc59ed7a74d28e987695b98f7fc88dc91cc6
function recordRsiAdoptions(projectId, runId, turnId, metadata, learningEventId, verification) {
        if (metadata.taskReportStatus !== 'recorded' || !metadata.taskReportObjectId || !Number.isInteger(Number(metadata.taskReportRevision)) || Number(metadata.taskReportRevision) < 1)
            return;
        const report = this.read(String(metadata.taskReportObjectId), Number(metadata.taskReportRevision));
        if (report.kind !== 'report' || report.projectId !== projectId || report.data.turn_id !== turnId || report.data.run_id !== runId)
            throw new Error('rsi_report_identity_mismatch');
        const body = JSON.parse(String(report.data.content || 'null'));
        const usages = Array.isArray(body?.experienceUsage) ? body.experienceUsage : [];
        if (!usages.length)
            return;
        if (!learningEventId)
            throw new Error('rsi_evaluation_source_required');
        const policyRef = metadata.globalPromptPolicyRef;
        if (policyRef && (typeof policyRef.objectId !== 'string' || !Number.isInteger(policyRef.revision) || Number(policyRef.revision) < 1))
            throw new Error('rsi_policy_reference_invalid');
        let policy = policyRef ? this.readMetadata(policyRef.objectId, Number(policyRef.revision)) : null;
        if (policy && policy.kind !== 'policy')
            throw new Error('rsi_policy_reference_invalid');
        usages.forEach((usage, index) => {
            if (this.rows("SELECT 1 FROM requests WHERE actor_id=? AND idempotency_key IN (?,?) AND status='committed' LIMIT 1", [
                this.actorId, `rsi:${report.objectId}:${report.revision}:${index}:evaluation`, `rsi:${report.objectId}:${report.revision}:${index}:rejected`
            ]).length)
                return;
            try {
                const lessonId = String(usage.experienceId || '');
                const lessonRevision = Number(usage.experienceRevision);
                const lesson = this.readMetadata(lessonId, lessonRevision);
                if (lesson.kind !== 'lesson' || ![null, projectId].includes(lesson.projectId))
                    throw new Error('rsi_lesson_reference_invalid');
                if (lesson.data.status !== 'approved')
                    throw new Error('rsi_lesson_not_approved');
                const currentLesson = this.readMetadata(lessonId);
                if (currentLesson.data.status !== 'approved' || currentLesson.revision !== lessonRevision || currentLesson.archivedAt !== null)
                    throw new Error('rsi_lesson_not_approved');
                if (!this.hasLearningDelivery(runId, turnId, lessonId, lessonRevision))
                    throw new Error('rsi_experience_not_delivered');
                const evidence = Array.isArray(usage.evidence) ? usage.evidence.map(String) : [];
                const reportedVerdict = String(usage.verdict || 'unassessed');
                let assessment;
                if (verification?.data.evidence_id) {
                    try {
                        const verified = JSON.parse(String(this.read(String(verification.data.evidence_id)).data.content));
                        if (verified.turnId === turnId && Array.isArray(verified.experienceAssessments))
                            assessment = verified.experienceAssessments.find((item) => item.lessonId === lessonId && item.lessonRevision === lessonRevision && item.action === usage.action && typeof item.evidence === 'string' && item.evidence.trim());
                    }
                    catch { /* A general task check is not a scoped experience assessment. */ }
                }
                const verdict = assessment?.result === 'fail' ? 'ineffective'
                    : assessment?.result === 'pass' && evidence.length > 0 ? verification?.data.result === 'pass' ? 'effective' : 'degraded' : 'unassessed';
                if (!policy) {
                    const baseline = this.write({ kind: 'policy', action: 'create', scope: null, idempotencyKey: 'rsi:absent-global-prompt', data: { kind: 'execution_baseline', status: 'historical', content: canonical({ globalPrompt: null }) } });
                    policy = this.readMetadata(baseline.objectId, baseline.revision);
                }
                const use = this.write({ kind: 'policy_use', action: 'create', scope: projectId, idempotencyKey: `rsi:${report.objectId}:${report.revision}:${index}:use`, data: {
                        policy_id: policy.objectId, policy_revision: policy.revision, lesson_id: lesson.objectId, lesson_revision: lesson.revision, run_id: runId, purpose: String(usage.action || '')
                    } });
                const feedbackId = verification && verdict !== 'unassessed' ? this.experienceFeedback(projectId, use.objectId, verification.objectId, verdict, String(usage.action || ''), learningEventId) : learningEventId;
                this.write({ kind: 'evaluation', action: 'create', scope: projectId, idempotencyKey: `rsi:${report.objectId}:${report.revision}:${index}:evaluation`, data: {
                        policy_use_id: use.objectId, feedback_event_id: feedbackId, verification_id: verification?.objectId || null, metric: 'task_outcome',
                        value: verdict === 'effective' ? 1 : verdict === 'degraded' ? 0.5 : verdict === 'ineffective' ? 0 : null,
                        unit: 'ratio', baseline_ref: canonical({ turnId, lessonId, lessonRevision, action: String(usage.action || ''), result: String(usage.result || ''), evidence, reportedVerdict }), verdict
                    } });
            }
            catch (error) {
                const code = error instanceof Error ? error.message : String(error);
                if (!/^(?:rsi_|object_missing|revision_missing)/.test(code))
                    throw error;
                const rejectionKey = `rsi:${report.objectId}:${report.revision}:${index}:rejected`;
                this.write({ kind: 'evidence', action: 'create', scope: projectId, idempotencyKey: rejectionKey, data: {
                        run_id: runId, type: 'learning_adoption_rejected', source_actor_id: this.actorId, observed_at: Date.now(),
                        content: canonical({ turnId, reportId: report.objectId, reportRevision: report.revision, index, code })
                    } });
            }
        });
    }

// Original method SHA256 956194c15ba87ef037572ce8bf18036d04b8c5b6d24542cc921c48428c553525
function experienceFeedback(projectId, useId, verificationId, verdict, action, originalEventId) {
        const use = this.readMetadata(useId);
        const receipt = this.write({ kind: 'learning_event', action: 'create', scope: projectId, idempotencyKey: `experience-feedback:${verificationId}:${useId}`, data: {
                source_object_id: useId, source_revision: use.revision, event_type: verdict === 'effective' ? 'verified' : verdict === 'ineffective' ? 'verified_failed' : 'partial',
                source_type: 'experience_evaluation', summary: action, occurred_at: Date.now(), verification_signal: verdict === 'effective'
            } });
        this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [receipt.objectId, 'source', verificationId]);
        this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [receipt.objectId, 'source', originalEventId]);
        return receipt.objectId;
    }

function withNativeRunHelpers(store,work){
  return require('./native-step-memory-import-oracles.cjs').withNativeStepMemoryHelpers(store,()=>{
  return require('./native-run-report-oracles.cjs').withNativeRunReports(store,()=>{
  return require('./native-run-control-oracles.cjs').withNativeRunControls(store,()=>{
  const originals=new Map(),helpers={saveRunGitEvidence,recordRsiAdoptions,experienceFeedback};
  for(const [name,method] of Object.entries(helpers)){originals.set(name,Object.getOwnPropertyDescriptor(store,name));Object.defineProperty(store,name,{value:method,writable:true,configurable:true});}
  try{return work();}
  finally{for(const [name,descriptor] of originals){if(descriptor)Object.defineProperty(store,name,descriptor);else delete store[name];}}
  });
  });
  });
}
exports.withNativeRunHelpers=withNativeRunHelpers;
exports.checkpointRunNative=(store,projectId,input)=>withNativeRunHelpers(store,()=>checkpointRun.call(store,projectId,input));
exports.finalizeRunOutputNative=(store,projectId,input)=>withNativeRunHelpers(store,()=>finalizeRunOutput.call(store,projectId,input));
exports.commitRunSettlementNative=(store,projectId,input)=>withNativeRunHelpers(store,()=>commitRunSettlement.call(store,projectId,input));

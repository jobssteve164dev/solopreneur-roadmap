// Exact original Native controls for synchronous transaction and behavior oracles only.
// Original compiled bodies and hashes: native-run-control-oracles-v133.json in task evidence.
const path=require('node:path'),sessionIdentity_1=require('../../out/sessionIdentity.js');

// Original method SHA256 f08c16ed5ce9466852341c54e056e4be31003bd6fd45523f2b2e05290a4d22aa
function patchRunState(projectId, input) {
        const initial = this.runControl(projectId, input.executionLogId);
        if (initial.generation !== input.generation)
            throw new Error('run_owner_conflict');
        this.validateRunStatePatch(input.patch);
        const receipt = this.recordMutation({ operation: 'patch_run_state', projectId, input }, input.idempotencyKey, 'state', () => {
            const row = this.runControl(projectId, input.executionLogId);
            if (row.revision !== input.expectedRevision)
                throw new Error('revision_conflict');
            const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
            const patch = { ...input.patch };
            if (metadata.interactiveSessionClosed === true && (['Preparing', 'Running', 'Waiting', 'Turn Started'].includes(String(patch.status || ''))
                || (Object.prototype.hasOwnProperty.call(patch, 'interactiveSessionClosed') && patch.interactiveSessionClosed !== true)
                || (Object.prototype.hasOwnProperty.call(patch, 'finishedAt') && (patch.finishedAt === '' || patch.finishedAt === null))))
                throw new Error('session_already_closed');
            for (const [key, column] of [['agentPid', 'process_pid'], ['processBirth', 'process_birth'], ['agentChildPid', 'child_pid'], ['processChildBirth', 'child_birth']]) {
                if (!Object.prototype.hasOwnProperty.call(patch, key))
                    continue;
                const isPid = key === 'agentPid' || key === 'agentChildPid';
                const value = isPid ? Number(patch[key] || 0) : String(patch[key] || '');
                if (isPid && (!Number.isInteger(value) || Number(value) < 0))
                    throw new Error('invalid_run_pid');
                this.db.run(`UPDATE run_control SET ${column}=? WHERE run_id=?`, [value, row.run_id]);
                delete patch[key];
            }
            for (const [key, column] of [['status', 'status'], ['startedAt', 'started_at'], ['finishedAt', 'finished_at']]) {
                if (!Object.prototype.hasOwnProperty.call(patch, key))
                    continue;
                const value = key === 'status' ? String(patch[key]) : patch[key] === '' || patch[key] === null ? null : Date.parse(String(patch[key]));
                if (value !== null && typeof value === 'number' && !Number.isFinite(value))
                    throw new Error('invalid_run_time');
                this.db.run(`UPDATE runs SET ${column}=? WHERE id=?`, [value, row.run_id]);
                delete patch[key];
            }
            if (Object.prototype.hasOwnProperty.call(patch, 'exitCode')) {
                if (patch.exitCode !== null && (!Number.isInteger(patch.exitCode) || Number(patch.exitCode) < 0))
                    throw new Error('invalid_run_exit_code');
                this.db.run('UPDATE runs SET exit_code=? WHERE id=?', [patch.exitCode, row.run_id]);
                delete patch.exitCode;
            }
            this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putStructuredContent({ ...metadata, ...patch }), row.run_id]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            return this.current(String(row.run_id), false);
        }, undefined, false);
        return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
    }

// Original method SHA256 b5f501f7529c93065cc68e867133164c38a2d6ae54e38c8a1e043bf23c1bb928
function requestRunStop(projectId, input, trustedBoundary) {
        this.validateRunStop(input, trustedBoundary);
        const initial = this.runControl(projectId, input.executionLogId);
        if (initial.generation !== input.generation)
            throw new Error('run_owner_conflict');
        const intent = this.runStopIntent(input);
        const receipt = this.recordMutation({ operation: 'request_run_stop', projectId, input: intent, ...(trustedBoundary ? { trustedBoundary } : {}) }, input.idempotencyKey, 'stop', () => {
            const row = this.runControl(projectId, input.executionLogId);
            if (row.revision !== input.expectedRevision)
                throw new Error('revision_conflict');
            if (row.current_turn_id !== input.expectedTurnId)
                throw new Error('checkpoint_turn_conflict');
            const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
            this.db.run('UPDATE run_control SET metadata_content_id=?,delivery_pending=0,recovery_needed=1 WHERE run_id=?', [this.putStructuredContent({ ...metadata, stopRequested: true, stopReason: input.reason, stopRequestKey: input.idempotencyKey, stopRequestedAt: new Date().toISOString(), stopRequestIntent: intent, ...(trustedBoundary ? { stopNativeStream: trustedBoundary.nativeStopStream, stopNativeLogBoundary: trustedBoundary.nativeStopLogBoundary } : {}), ...(input.requireVerifiedIdentity ? { stopRequireVerifiedIdentity: true } : {}) }), row.run_id]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            return this.current(String(row.run_id), false);
        }, undefined, false);
        return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
    }

// Original method SHA256 c25e0d093f653e88c236b22668526bd1bd934dd970c782d4fcbc5c8a0a10c3b9
function writeRunBinding(projectId, input) {
        const initial = this.runControl(projectId, input.executionLogId);
        if (initial.generation !== input.generation)
            throw new Error('run_owner_conflict');
        const receipt = this.recordMutation({ operation: 'write_run_binding', projectId, input }, input.idempotencyKey, 'binding', () => {
            const row = this.runControl(projectId, input.executionLogId);
            const previous = this.readRunBinding(projectId, input.executionLogId);
            if ((previous?.headRevision || 0) !== input.expectedHeadRevision)
                throw new Error('identity_index_conflict');
            const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
            let next;
            try {
                if (!previous) {
                    if (!input.seed || Number(input.seed.runId) !== input.executionLogId)
                        throw new Error('identity_binding_invalid');
                    if (path.resolve(input.seed.workspaceRoot) !== path.resolve(String(metadata.workspaceRoot)))
                        throw new Error('identity_workspace_mismatch');
                    next = (0, sessionIdentity_1.createSessionBindingValue)(input.seed);
                }
                else if (input.confirmSessionId)
                    next = (0, sessionIdentity_1.confirmSessionBindingValue)(previous, input.expectedHeadRevision, input.confirmSessionId, new Date().toISOString(), input.evidence);
                else {
                    if (!input.revision)
                        throw new Error('identity_binding_invalid');
                    next = (0, sessionIdentity_1.appendSessionBindingValue)(previous, input.expectedHeadRevision, input.revision);
                }
            }
            catch (error) {
                const coded = error;
                if (coded.code)
                    throw Object.assign(new Error(`${coded.code}: ${coded.message}`), { code: coded.code });
                throw error;
            }
            const head = next.revisions[next.headRevision - 1];
            const bindingRevision = Number(this.rows('SELECT COALESCE(MAX(binding_revision),0)+1 AS next FROM session_bindings WHERE conversation_id=?', [row.conversation_id])[0].next);
            const evidenceId = this.write({ kind: 'evidence', action: 'create', scope: projectId, idempotencyKey: `${input.idempotencyKey}:evidence`, data: { run_id: String(row.run_id), type: 'session_binding', source_actor_id: this.actorId, content: next, observed_at: Date.now(), source_revision: next.headRevision } }).objectId;
            this.db.run('INSERT INTO session_bindings VALUES(?,?,?,?,?,?,?,?)', [row.conversation_id, bindingRevision, next.provider, head.sessionId || null, head.state, head.contract, evidenceId, head.providerContext ? this.putStructuredContent(head.providerContext) : null]);
            const resumable = head.state === 'confirmed' && next.resumableRevision === next.headRevision && Boolean(head.sessionId);
            Object.assign(metadata, { sessionProvider: next.provider, sessionBindingHeadRevision: next.headRevision, nativeSessionId: resumable ? String(head.sessionId) : '', nativeSessionIdIsCurrent: resumable });
            this.db.run('UPDATE run_control SET binding_content_id=?,metadata_content_id=? WHERE run_id=?', [this.putStructuredContent(next), this.putStructuredContent(metadata), row.run_id]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            this.touchProjectConversationSource(projectId);
            return this.current(String(row.run_id), false);
        }, undefined, false);
        const history = this.rows('SELECT binding_content_id FROM run_control_revisions WHERE run_id=? AND revision=?', [receipt.objectId, receipt.revision])[0];
        return JSON.parse(this.content(String(history.binding_content_id)).toString('utf8'));
    }

// Original method SHA256 27a22980c564cf4a333bf1562e02796fcb6e8512521ccaddd874ada8471c5eec
function claimRunDelivery(projectId, input) {
        if (!input.owner?.id || !Number.isInteger(input.owner.pid) || input.owner.pid < 1 || typeof input.owner.birth !== 'string')
            throw new Error('invalid_run_delivery_owner');
        const initial = this.runControl(projectId, input.executionLogId);
        if (initial.generation !== input.generation)
            throw new Error('run_owner_conflict');
        const receipt = this.recordMutation({ operation: 'claim_run_delivery', projectId, input }, input.idempotencyKey, 'delivery', () => {
            const row = this.runControl(projectId, input.executionLogId);
            if (row.revision !== input.expectedRevision)
                throw new Error('revision_conflict');
            if (!this.runFlowLaunchAllowed(projectId, String(row.run_id)))
                throw new Error('flow_not_running');
            if (JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8')).stopRequested)
                throw new Error('run_stop_requested');
            if (!row.delivery_pending || row.finished_at !== null || this.hasLiveRunProcess(row))
                throw new Error('run_already_delivered');
            if (row.delivery_owner_id !== input.owner.id && this.runDeliveryOwnerAlive(projectId, input.executionLogId))
                throw new Error('run_delivery_owner_alive');
            this.db.run('UPDATE run_control SET delivery_owner_id=?,delivery_pid=?,delivery_birth=? WHERE run_id=?', [input.owner.id, input.owner.pid, input.owner.birth, row.run_id]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            return this.current(String(row.run_id), false);
        }, undefined, false);
        return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
    }

// Original method SHA256 cd818ccc10e07774e8b0229502e7c79f12971588b403e40be58d353c77311551
function releaseRunDelivery(projectId, input) {
        const initial = this.runControl(projectId, input.executionLogId);
        if (initial.generation !== input.generation)
            throw new Error('run_owner_conflict');
        const receipt = this.recordMutation({ operation: 'release_run_delivery', projectId, input }, input.idempotencyKey, 'delivery_release', () => {
            const row = this.runControl(projectId, input.executionLogId);
            if (!row.delivery_pending || row.finished_at !== null || this.hasLiveRunProcess(row))
                throw new Error('run_already_delivered');
            if (!input.owner || row.delivery_owner_id !== input.owner.id || row.delivery_pid !== input.owner.pid || row.delivery_birth !== input.owner.birth)
                throw new Error('run_delivery_lease_lost');
            const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
            metadata.deliveryLastError = String(input.error || '');
            this.db.run("UPDATE run_control SET delivery_owner_id='',delivery_pid=0,delivery_birth='',metadata_content_id=? WHERE run_id=?", [this.putStructuredContent(metadata), row.run_id]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            return this.current(String(row.run_id), false);
        }, undefined, false);
        return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
    }

// Original method SHA256 d8a4dfebefe6b127cf5cabaf9f125adca13da631402b19783984f1f323ddcc37
function claimRun(projectId, input) {
        if (input.agentPid !== undefined && (!Number.isInteger(input.agentPid) || input.agentPid < 1))
            throw new Error('invalid_run_pid');
        const receipt = this.recordMutation({ operation: 'claim_run', projectId, input }, input.idempotencyKey, 'claim', () => {
            const row = this.runControl(projectId, input.executionLogId);
            if (!this.runFlowLaunchAllowed(projectId, String(row.run_id)))
                throw new Error('flow_not_running');
            if (row.revision !== input.expectedRevision)
                throw new Error('revision_conflict');
            const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
            if (metadata.stopRequested)
                throw new Error('run_stop_requested');
            if (input.terminalDeliveryId && input.terminalDeliveryId !== metadata.terminalDeliveryId)
                throw new Error('run_delivery_identity_changed');
            if (row.finished_at !== null)
                throw new Error('run_already_finished');
            if (this.hasLiveRunProcess(row))
                throw new Error('run_owner_alive');
            this.db.run('UPDATE run_control SET generation=generation+1,recovery_needed=1,delivery_pending=0 WHERE run_id=?', [row.run_id]);
            this.db.run('UPDATE run_control SET child_pid=NULL,child_birth=NULL WHERE run_id=?', [row.run_id]);
            metadata.terminalClaimDeliveryId = input.terminalDeliveryId || '';
            if (input.terminalDeliveryId) {
                metadata.terminalCommandSubmittedAt || (metadata.terminalCommandSubmittedAt = new Date().toISOString());
                metadata.foregroundRunnerSpawnedAt || (metadata.foregroundRunnerSpawnedAt = metadata.terminalCommandSubmittedAt);
                metadata.foregroundRunnerPid = input.agentPid || 0;
            }
            this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putStructuredContent(metadata), row.run_id]);
            if (input.agentPid !== undefined)
                this.db.run('UPDATE run_control SET process_pid=?,process_birth=? WHERE run_id=?', [input.agentPid, input.processBirth || '', row.run_id]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            return this.current(String(row.run_id), false);
        }, undefined, false);
        const state = this.readRunState(projectId, input.executionLogId, receipt.revision);
        return { ...state, receipt, proof: this.runProof(state.runId, state.generation) };
    }

// Original method SHA256 90d40fa75274e0788aabf810aedd31242ad14cf91d505e7bd8404e7f82ac55f8
function claimRunTerminalOwner(projectId, input) {
        if (!input.owner?.id || !Number.isInteger(input.owner.pid) || input.owner.pid < 1 || typeof input.owner.birth !== 'string')
            throw new Error('invalid_run_delivery_owner');
        if (!input.terminalName || !input.terminalDeliveryId)
            throw new Error('run_terminal_identity_required');
        const initial = this.runControl(projectId, input.executionLogId);
        if (initial.generation !== input.generation)
            throw new Error('run_owner_conflict');
        const receipt = this.recordMutation({ operation: 'claim_run_terminal_owner', projectId, input }, input.idempotencyKey, 'terminal_owner', () => {
            const row = this.runControl(projectId, input.executionLogId);
            if (row.revision !== input.expectedRevision)
                throw new Error('revision_conflict');
            const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
            if (metadata.interactiveSession !== true || metadata.interactiveSessionClosed === true || metadata.stopRequested === true || row.delivery_pending)
                throw new Error('run_terminal_not_recoverable');
            if (String(metadata.terminalName || '') !== input.terminalName || String(metadata.terminalDeliveryId || '') !== input.terminalDeliveryId)
                throw new Error('run_delivery_identity_changed');
            if (!this.hasLiveRunProcess(row))
                throw new Error('run_owner_missing');
            if (row.delivery_owner_id !== input.owner.id && this.runDeliveryOwnerAlive(projectId, input.executionLogId))
                throw new Error('run_delivery_owner_alive');
            this.db.run('UPDATE run_control SET delivery_owner_id=?,delivery_pid=?,delivery_birth=? WHERE run_id=?', [input.owner.id, input.owner.pid, input.owner.birth, row.run_id]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            return this.current(String(row.run_id), false);
        }, undefined, false);
        return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
    }

// Original method SHA256 62a259395228d32a1eb52096dc904df00d71281295fbe8a03f3dcb1b38922041
function beginRunDelivery(projectId, input) {
        this.validateRunDeliveryStart(input);
        return this.transaction(() => {
            const claimed = this.claimRunDelivery(projectId, {
                executionLogId: input.executionLogId, generation: input.generation, expectedRevision: input.expectedRevision,
                owner: input.owner, idempotencyKey: `${input.idempotencyKey}:lease`
            });
            return this.patchRunState(projectId, {
                executionLogId: input.executionLogId, generation: input.generation, expectedRevision: claimed.revision,
                patch: {
                    terminalName: input.terminalName, terminalDeliveryId: input.terminalDeliveryId,
                    terminalDeliveryTraceId: input.terminalDeliveryTraceId,
                    terminalDeliveryStartedAt: input.terminalDeliveryStartedAt,
                    terminalDeliveryAttempt: input.terminalDeliveryAttempt
                },
                idempotencyKey: `${input.idempotencyKey}:terminal`
            });
        });
    }


function withNativeRunControls(store,work){
  const originals=new Map(),methods={patchRunState,requestRunStop,writeRunBinding,claimRunDelivery,releaseRunDelivery,claimRun,claimRunTerminalOwner,beginRunDelivery};
  for(const [name,method] of Object.entries(methods)){originals.set(name,Object.getOwnPropertyDescriptor(store,name));Object.defineProperty(store,name,{value:method,writable:true,configurable:true});}
  try{return work();}
  finally{for(const [name,descriptor] of originals){if(descriptor)Object.defineProperty(store,name,descriptor);else delete store[name];}}
}
exports.withNativeRunControls=withNativeRunControls;

exports.patchRunStateNative=(store,...args)=>withNativeRunControls(store,()=>patchRunState.call(store,...args));

exports.requestRunStopNative=(store,...args)=>withNativeRunControls(store,()=>requestRunStop.call(store,...args));

exports.writeRunBindingNative=(store,...args)=>withNativeRunControls(store,()=>writeRunBinding.call(store,...args));

exports.claimRunDeliveryNative=(store,...args)=>withNativeRunControls(store,()=>claimRunDelivery.call(store,...args));

exports.releaseRunDeliveryNative=(store,...args)=>withNativeRunControls(store,()=>releaseRunDelivery.call(store,...args));

exports.claimRunNative=(store,...args)=>withNativeRunControls(store,()=>claimRun.call(store,...args));

exports.claimRunTerminalOwnerNative=(store,...args)=>withNativeRunControls(store,()=>claimRunTerminalOwner.call(store,...args));

exports.beginRunDeliveryNative=(store,...args)=>withNativeRunControls(store,()=>beginRunDelivery.call(store,...args));

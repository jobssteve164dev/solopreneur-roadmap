// Exact original Native turn request for semantic comparisons only.
// SHA256 2b809e0a75eb2e676c2c83df169f16e8f841ddf6da3bac79e9a8515aa0167d5d; native-turn-request-oracle-v132.json in task evidence.
function patchRunTurnRequest(projectId, input) {
        const initial = this.runControl(projectId, input.executionLogId);
        if (initial.generation !== input.generation)
            throw new Error('run_owner_conflict');
        if (typeof input.message !== 'string' || !input.message.trim())
            throw new Error('checkpoint_message_required');
        const { expectedRevision: _expectedRevision, ...intent } = input;
        const receipt = this.recordMutation({ operation: 'patch_run_turn_request', projectId, input: intent }, input.idempotencyKey, 'request', () => {
            const row = this.runControl(projectId, input.executionLogId);
            if (row.revision !== input.expectedRevision)
                throw new Error('revision_conflict');
            if (row.current_turn_id !== input.turnId)
                throw new Error('checkpoint_turn_conflict');
            const turn = this.current(input.turnId, false);
            if (turn.data.finished_at !== null)
                throw new Error('turn_already_settled');
            this.write({ kind: 'turn', action: 'patch', scope: projectId, objectId: input.turnId, expectedRevision: turn.revision, data: { request_content: input.message }, idempotencyKey: `${input.idempotencyKey}:turn` });
            const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
            Object.assign(metadata, { userMessage: input.message, checkpointMessage: input.message });
            const journal = this.readRunTurnJournal(projectId, input.executionLogId, input.turnId);
            this.updateProjectJournal(projectId, journal.executionLogId, { ...journal.entry, output: [journal.entry.output, `User message:\n${input.message}`].filter(Boolean).join('\n\n') });
            this.db.run('UPDATE run_control SET metadata_content_id=? WHERE run_id=?', [this.putStructuredContent(metadata), row.run_id]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            return this.current(String(row.run_id), false);
        }, undefined, false);
        return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
    }

exports.patchRunTurnRequestNative=(store,projectId,input)=>patchRunTurnRequest.call(store,projectId,input);

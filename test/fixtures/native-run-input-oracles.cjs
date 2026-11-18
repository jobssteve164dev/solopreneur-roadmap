// Exact original Native run inputs and prompt-delivery helper for transaction oracles only.
// Bodies/hashes: native-run-input-oracles-v135.json in task evidence.

// Original method SHA256 817a0da967c9ebcddd0f4a25ebd9a77b55425ef8374ad8af365c3296f1e5b969
function patchRunInputs(projectId, input) {
        const initial = this.runControl(projectId, input.executionLogId);
        if (initial.generation !== input.generation)
            throw new Error('run_owner_conflict');
        if (['prompt', 'command', 'status'].some(key => Object.prototype.hasOwnProperty.call(input, key) && typeof input[key] !== 'string'))
            throw new Error('invalid_run_inputs');
        const receipt = this.recordMutation({ operation: 'patch_run_inputs', projectId, input }, input.idempotencyKey, 'inputs', () => {
            const row = this.runControl(projectId, input.executionLogId);
            if (row.revision !== input.expectedRevision)
                throw new Error('revision_conflict');
            if (input.status !== undefined) {
                const metadata = JSON.parse(this.content(String(row.metadata_content_id)).toString('utf8'));
                if (metadata.interactiveSessionClosed === true && ['Preparing', 'Running', 'Waiting', 'Turn Started'].includes(input.status))
                    throw new Error('session_already_closed');
            }
            for (const [key, column] of [['prompt', 'prompt_content_id'], ['command', 'command_content_id']]) {
                if (input[key] !== undefined)
                    this.db.run(`UPDATE runs SET ${column}=? WHERE id=?`, [this.putTextContent(input[key]), row.run_id]);
            }
            if (input.status !== undefined)
                this.db.run('UPDATE runs SET status=? WHERE id=?', [input.status, row.run_id]);
            this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), row.run_id]);
            this.saveRunControlRevision(String(row.run_id));
            if (input.prompt !== undefined && /solomap:\/\/objects\//.test(input.prompt))
                this.recordPromptLearningDelivery({ projectId, runId: String(row.run_id), turnId: String(row.current_turn_id) }, input.prompt);
            return this.current(String(row.run_id));
        });
        return { ...this.readRunState(projectId, input.executionLogId, receipt.revision), receipt };
    }

// Original method SHA256 a85b0b39465062e98af2e1e85020b314e34e4e01e9541a39e1779f5a58df5c85
function recordPromptLearningDelivery(state, prompt) {
        const turn = this.readMetadata(state.turnId);
        if (turn.data.finished_at)
            return;
        const lessons = [];
        for (const match of prompt.matchAll(/solomap:\/\/objects\/([a-zA-Z0-9-]+)\s*·\s*revision=(\d+)(?!\d)/g)) {
            try {
                const lesson = this.readMetadata(match[1]);
                if (lesson.kind === 'lesson' && [null, state.projectId].includes(lesson.projectId) && lesson.archivedAt === null
                    && lesson.revision === Number(match[2]) && lesson.data.status === 'approved'
                    && [lesson.data.summary, lesson.data.do_this].every(value => typeof value === 'string' && value.trim() && prompt.includes(value))) {
                    lessons.push({ objectId: lesson.objectId, revision: lesson.revision });
                }
            }
            catch (error) {
                if (!(error instanceof Error) || error.message !== 'object_missing')
                    throw error;
            }
        }
        if (lessons.length)
            this.recordLearningDelivery(state, lessons);
    }


exports.patchRunInputsNative=(store,projectId,input)=>{
  const original=Object.getOwnPropertyDescriptor(store,'recordPromptLearningDelivery');
  Object.defineProperty(store,'recordPromptLearningDelivery',{value:recordPromptLearningDelivery,writable:true,configurable:true});
  try{return patchRunInputs.call(store,projectId,input);}
  finally{if(original)Object.defineProperty(store,'recordPromptLearningDelivery',original);else delete store.recordPromptLearningDelivery;}
};

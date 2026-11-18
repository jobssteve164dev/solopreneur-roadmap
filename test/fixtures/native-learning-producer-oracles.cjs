// Frozen original Native producers: preserve the historical transaction/error oracles after public entry retirement.
// Source and method hashes: output/database-lifecycle-implementation-20261113-56df40/remaining-entry-completion-20261114/native-producer-oracles-v118.json
const crypto=require('node:crypto');
const {canonicalJson:canonical}=require('../../out/contentReferences.js');
const learningReviewApply_js_1=require('../../out/learningReviewApply.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

// Original method SHA256 8f4803ed6ca474392570882ab164ad39cccb1900dfeaa78368fbad3bf970f5cb
function applyLearningReview(input) {
        const batch = this.read(input.batchId);
        const control = this.rows('SELECT input_content_id FROM learning_review_controls WHERE batch_id=?', [input.batchId])[0];
        if (batch.kind !== 'review_batch' || !control)
            throw new Error('learning_review_batch_required');
        const saved = JSON.parse(this.content(String(control.input_content_id)).toString('utf8')), manifest = this.learningReviewManifest(saved);
        const previous = saved.previousContentId ? JSON.parse(this.content(String(saved.previousContentId)).toString('utf8')) : saved.previous, pendingInputs = this.learningReviewPending(saved);
        if (input.manifestHash !== batch.data.input_hash || digest(JSON.stringify(manifest)) !== input.manifestHash)
            throw new Error('learning_review_manifest_mismatch');
        (0, learningReviewApply_js_1.validateDirectGlobalPromptReview)(manifest, input.result);
        if (!Array.isArray(input.result.recovery) || input.result.recovery.length !== pendingInputs.length)
            throw new Error('learning_review_recovery_missing');
        const recoveries = new Set();
        for (const disposition of input.result.recovery) {
            const pending = pendingInputs.find((item) => item.objectId === disposition.applicationId && item.revision === disposition.revision);
            if (!pending || recoveries.has(pending.objectId) || !(pending.targetKind && pending.targetKind !== 'policy' ? ['resumed', 'deferred'] : ['resumed', 'superseded']).includes(disposition.decision) || !String(disposition.reason || '').trim())
                throw new Error('learning_review_recovery_invalid');
            if ((!pending.targetKind || pending.targetKind === 'policy') && disposition.decision === 'resumed' && pending.targetPrompt !== input.result.globalPrompt)
                throw new Error('learning_review_recovery_prompt_mismatch');
            if ((!pending.targetKind || pending.targetKind === 'policy') && disposition.decision === 'superseded' && pending.targetPrompt !== manifest.globalPrompt)
                throw new Error('learning_review_unapplied_result');
            recoveries.add(pending.objectId);
        }
        return this.transaction(() => {
            if (!this.learningReviewScopeCurrent(batch))
                throw new Error('learning_review_source_scope_changed');
            // write() replays an identical accepted intent before checking its old revision.
            const application = this.write({ kind: 'application', action: 'create', scope: batch.projectId, idempotencyKey: input.idempotencyKey, data: { review_id: batch.objectId, target_object_id: saved.policy.objectId, expected_revision: saved.policy.revision, before_content: this.read(saved.policy.objectId, saved.policy.revision).data.content, after_content: input.result.globalPrompt, status: 'applying' } });
            const currentBatch = this.read(batch.objectId);
            if (currentBatch.data.status !== 'draft') {
                const accepted = JSON.parse(String(currentBatch.data.review_content));
                if (accepted.acceptedIntent !== input.idempotencyKey)
                    throw new Error('learning_review_already_accepted');
                if (currentBatch.data.proposal_content !== JSON.stringify(input.result))
                    throw new Error('idempotency_conflict');
                const policyReceipt = this.write({ kind: 'policy', action: 'patch', scope: null, objectId: saved.policy.objectId, expectedRevision: saved.policy.revision, idempotencyKey: `${input.idempotencyKey}:policy`, data: { content: input.result.globalPrompt } });
                return { application, policy: policyReceipt, lessons: this.applyDirectReviewLessons(batch.objectId, saved, manifest, input.result, input.idempotencyKey) };
            }
            if (currentBatch.revision !== input.expectedRevision)
                throw new Error('revision_conflict');
            const policy = this.write({ kind: 'policy', action: 'patch', scope: null, objectId: saved.policy.objectId, expectedRevision: saved.policy.revision, idempotencyKey: `${input.idempotencyKey}:policy`, data: { content: input.result.globalPrompt } });
            const lessons = this.applyDirectReviewLessons(batch.objectId, saved, manifest, input.result, input.idempotencyKey);
            const sources = { ...previous.sources }, deferred = new Set(input.result.deferredSourceIds || []);
            for (const source of manifest.sources) {
                if (deferred.has(source.id))
                    delete sources[source.id];
                else
                    sources[source.id] = { id: source.id, kind: source.kind, hash: source.hash, ...(source.ref ? { ref: source.ref } : {}), ...(source.file ? { file: source.file } : {}) };
            }
            const presented = new Set(manifest.sources.map(source => source.id));
            const deferredSources = [...(previous.deferredSources || []).filter((source) => !presented.has(source.id)), ...manifest.sources.filter(source => deferred.has(source.id))];
            this.write({ kind: 'setting', action: saved.cursor ? 'patch' : 'create', scope: null, ...(saved.cursor ? { objectId: saved.cursor.objectId, expectedRevision: saved.cursor.revision } : {}), idempotencyKey: `${input.idempotencyKey}:cursor`, data: { namespace: 'learning_review', key: 'cursor', owner_scope: 'global', content: JSON.stringify({ sources, deferredSources, unresolved: input.result.unresolved || [], legacyCursorRevisions: previous.legacyCursorRevisions || {}, lastAppliedBatchId: batch.objectId }) } });
            const recoveries = [...input.result.recovery].sort((a, b) => Number(pendingInputs.find((item) => item.objectId === a.applicationId)?.targetKind === 'lesson') - Number(pendingInputs.find((item) => item.objectId === b.applicationId)?.targetKind === 'lesson'));
            for (const disposition of recoveries) {
                if (disposition.decision === 'deferred')
                    continue;
                const pending = pendingInputs.find((item) => item.objectId === disposition.applicationId);
                const target = pending.targetKind && pending.targetKind !== 'policy' ? this.resumeLegacyReviewTarget(pending, `${input.idempotencyKey}:target:${disposition.applicationId}`) : null;
                this.write({ kind: 'application', action: 'patch', scope: this.read(disposition.applicationId).projectId, objectId: disposition.applicationId, expectedRevision: disposition.revision, idempotencyKey: `${input.idempotencyKey}:recovery:${disposition.applicationId}`, data: { status: disposition.decision, ...(target ? { target_object_id: target.objectId, applied_revision: target.revision } : {}) } });
            }
            this.write({ kind: 'review_batch', action: 'patch', scope: batch.projectId, objectId: batch.objectId, expectedRevision: input.expectedRevision, idempotencyKey: `${input.idempotencyKey}:batch`, data: { status: 'applying', proposal_content: JSON.stringify(input.result), review_content: JSON.stringify({ ...saved, acceptedIntent: input.idempotencyKey }) } });
            return { application, policy, lessons };
        });
    }

// Original method SHA256 e3f1c0925f2bed3db99e0f065d52e98f7e606d97d7548f1a4a466b400a67d0f7
function applyDirectReviewLessons(batchId, saved, manifest, result, idempotencyKey) {
        const projectIds = new Map(manifest.projects.map((root, index) => [root, String(saved.projectIds[index])]));
        return result.lessons.map((lesson, index) => {
            const projectId = projectIds.get(lesson.projectPath);
            if (!projectId || this.readMetadata(projectId).kind !== 'project')
                throw new Error('learning_review_lesson_scope_invalid');
            const sources = lesson.evidence.map((id) => manifest.sources.find(source => source.id === id));
            const eventRefs = sources.filter((source) => source.kind === 'learning_event').map((source) => {
                if (!source.ref)
                    throw new Error('learning_review_lesson_event_missing');
                const event = this.readMetadata(source.ref.objectId, source.ref.revision);
                if (event.kind !== 'learning_event' || event.projectId !== projectId)
                    throw new Error('learning_review_lesson_event_scope_mismatch');
                return { sourceId: source.ref.objectId, objectId: source.ref.objectId, revision: source.ref.revision };
            });
            const receipt = this.write({ kind: 'lesson', action: 'create', scope: projectId, idempotencyKey: `${idempotencyKey}:lesson:${index}`, data: {
                    status: 'approved', summary: lesson.summary, applies_when: lesson.appliesWhen, does_not_apply_when: lesson.doesNotApplyWhen,
                    do_this: lesson.doThis, avoid_this: lesson.avoidThis, verification: lesson.verification, confidence: 1,
                    source_type: 'review', lesson_type: lesson.lessonType,
                    evidence_refs_json: sources.map((source) => ({ type: 'trace', ref: source.ref ? `solomap://objects/${source.ref.objectId} · revision=${source.ref.revision}` : String(source.file || source.id), summary: lesson.reason })),
                    source_event_ids_json: eventRefs.map((ref) => ref.sourceId), event_refs: eventRefs
                } });
            const primary = eventRefs[0];
            this.write({ kind: 'lesson_decision', action: 'create', scope: projectId, idempotencyKey: `${idempotencyKey}:lesson:${index}:decision`, data: {
                    event_id: primary.objectId, event_revision: primary.revision, lesson_id: receipt.objectId, lesson_revision: receipt.revision,
                    decision: 'approved', reason: lesson.reason, actor_id: this.actorId, candidate_refs: [{ objectId: receipt.objectId, revision: receipt.revision }]
                } });
            this.write({ kind: 'application', action: 'create', scope: projectId, idempotencyKey: `${idempotencyKey}:lesson:${index}:application`, data: {
                    review_id: batchId, lesson_id: receipt.objectId, target_object_id: receipt.objectId, expected_revision: 0,
                    before_content: null, after_content: canonical(lesson), status: 'applied', applied_revision: receipt.revision
                } });
            return receipt;
        });
    }

// Original method SHA256 1e8ed1607326f001dd43165a606ed579a4e7160edbc0001ec6fa76ae0da9968b
function resumeLegacyReviewTarget(pending, idempotencyKey) {
        const source = this.read(pending.legacyTarget.batchId, pending.legacyTarget.revision);
        const saved = JSON.parse(String(source.data.review_content));
        const target = (saved.legacyTargets || []).find((target) => target.key === pending.legacyTarget.key);
        if (!target || !target.binding || target.kind === 'policy')
            throw new Error('legacy_review_target_missing');
        const current = this.canonicalLegacyReviewTarget(target);
        if ((current?.objectId || null) !== (pending.targetRef?.objectId || null) || (current?.revision || null) !== (pending.targetRef?.revision || null))
            throw new Error('learning_review_target_revision_conflict');
        if (current && current.archivedAt !== null)
            throw new Error('learning_review_target_archived');
        if (target.kind === 'memory') {
            if (!current)
                throw new Error('learning_review_target_import_required');
            if (current.data.content === target.after)
                return { objectId: current.objectId, revision: current.revision };
            if (current.data.content !== target.before)
                throw new Error('learning_review_target_changed');
            return this.write({ kind: 'memory', action: 'patch', scope: target.scope, objectId: current.objectId, expectedRevision: current.revision, idempotencyKey, data: { content: target.after } });
        }
        if (!target.legacyId || !target.scope)
            throw new Error('legacy_review_target_missing');
        if (target.afterError || target.after === 'null')
            throw new Error('legacy_review_lesson_after_missing');
        const lesson = JSON.parse(target.after);
        const sourceRef = { objectId: source.objectId, revision: source.revision, scope: source.projectId };
        const data = { status: lesson.status, summary: lesson.summary, applies_when: lesson.appliesWhen, does_not_apply_when: lesson.doesNotApplyWhen, do_this: lesson.doThis, avoid_this: lesson.avoidThis, verification: lesson.verification,
            legacy_lesson_id: target.legacyId, semantic_review_json: { schemaVersion: 2, runId: saved.runId, proposalHash: saved.legacyApplication.proposalHash, evidence: lesson.evidence, target: lesson.target || '', reason: lesson.reason, sourceRef } };
        if (current) {
            const same = Object.entries(data).filter(([key]) => key !== 'semantic_review_json').every(([key, value]) => current.data[key] === value);
            const prior = typeof current.data.semantic_review_json === 'string' ? JSON.parse(current.data.semantic_review_json) : current.data.semantic_review_json;
            if (same && prior?.proposalHash === saved.legacyApplication.proposalHash)
                return { objectId: current.objectId, revision: current.revision };
            if (!target.beforeData || !Object.entries(target.beforeData).every(([key, value]) => {
                const currentValue = key.endsWith('_json') && typeof current.data[key] === 'string' ? JSON.parse(current.data[key]) : current.data[key];
                return currentValue !== undefined && canonical(currentValue) === canonical(value);
            }))
                throw new Error('learning_review_target_changed');
        }
        else if (target.before !== null)
            throw new Error('learning_review_target_import_required');
        if (lesson.status === 'promoted') {
            const memory = (saved.legacyTargets || []).find((entry) => entry.kind === 'memory' && entry.path === lesson.target);
            const canonical = memory ? this.canonicalLegacyReviewTarget(memory) : null;
            if (!canonical || canonical.archivedAt !== null || canonical.data.content !== memory.after)
                throw new Error('learning_review_promotion_target_unapplied');
        }
        const receipt = this.write({ kind: 'lesson', action: current ? 'patch' : 'create', scope: target.scope, ...(current ? { objectId: current.objectId, expectedRevision: current.revision } : {}), idempotencyKey,
            data: { ...data, ...(current ? {} : { confidence: 0, source_type: 'review', lesson_type: 'implementation_pattern', evidence_refs_json: [{ type: 'trace', ref: `solomap://objects/${source.objectId}`, revision: source.revision, summary: lesson.reason }], source_event_ids_json: [] }) } });
        if (!current)
            this.db.run('INSERT INTO legacy_lesson_sources VALUES(?,?,?,?,?,?,?)', [target.binding.identity, target.scope, target.legacyId, receipt.objectId, 0, 0, target.binding.key]);
        return receipt;
    }

// Original method SHA256 01381365c3b20a8e79aa94c5638b73fd519b7a95cd8423e48f56acd334dd6a60
function canonicalLegacyReviewTarget(target) {
        if (!target.binding)
            return null;
        if (target.kind === 'lesson' && (!target.legacyId || !target.scope))
            throw new Error('legacy_review_target_missing');
        const row = target.kind === 'lesson'
            ? this.rows('SELECT object_id FROM legacy_lesson_sources WHERE source_identity=? AND project_id=? AND legacy_lesson_id=?', [target.binding.identity, target.scope, target.legacyId])[0]
            : this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [target.binding.identity, target.binding.key])[0];
        if (!row?.object_id)
            return null;
        const object = this.read(String(row.object_id));
        if (object.kind !== target.kind || object.projectId !== target.scope)
            throw new Error('legacy_review_target_scope_mismatch');
        return object;
    }

// Original method SHA256 b5407bb5a48df87c57e421c104c1923f943632e62a4882675b6b95e852328987
function recordRunVerification(projectId, input) {
        if (!input.claim.trim() || !input.evidence.trim() || !['pass', 'fail'].includes(input.result))
            throw new Error('run_verification_invalid');
        const row = this.runControl(projectId, input.executionLogId);
        const run = this.rows('SELECT task_id FROM runs WHERE id=? AND project_id=?', [row.run_id, projectId])[0];
        if (!run)
            throw new Error('run_missing');
        if (input.experienceAssessments !== undefined && (!Array.isArray(input.experienceAssessments) || input.experienceAssessments.some(item => !item || typeof item.lessonId !== 'string' || !Number.isSafeInteger(item.lessonRevision) || item.lessonRevision < 1 || !item.action?.trim() || !['pass', 'fail'].includes(item.result) || !item.evidence?.trim())))
            throw new Error('experience_assessment_invalid');
        if (input.experienceAssessments?.length && (!input.turnId || !this.rows("SELECT 1 FROM relations WHERE source_id=? AND relation='source' AND target_id=?", [row.run_id, input.turnId]).length))
            throw new Error('experience_assessment_turn_mismatch');
        const intent = { projectId, executionLogId: input.executionLogId, claim: input.claim, result: input.result, evidence: input.evidence,
            ...(input.turnId ? { turnId: input.turnId } : {}), ...(input.experienceAssessments ? { experienceAssessments: input.experienceAssessments } : {}) };
        const inputHash = digest(canonical(intent));
        return this.transaction(() => {
            const previous = this.rows('SELECT input_hash,result_content_id,result_inline_json FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, input.idempotencyKey])[0];
            if (previous) {
                if (previous.input_hash !== inputHash)
                    throw new Error('idempotency_conflict');
                return JSON.parse(this.requestResult(previous).toString('utf8'));
            }
            const requestId = crypto.randomUUID();
            this.db.run('INSERT INTO requests(actor_id,idempotency_key,id,input_hash,status) VALUES(?,?,?,?,?)', [this.actorId, input.idempotencyKey, requestId, inputHash, 'pending']);
            const verifiedAt = Date.now();
            const evidence = this.write({ kind: 'evidence', action: 'create', scope: projectId, idempotencyKey: `${input.idempotencyKey}:evidence`, data: {
                    run_id: row.run_id, type: 'host_verification', source_actor_id: this.actorId,
                    content: input.experienceAssessments ? canonical({ turnId: input.turnId, experienceAssessments: input.experienceAssessments, evidence: input.evidence }) : input.evidence, observed_at: verifiedAt
                } });
            const verification = this.write({ kind: 'verification', action: 'create', scope: projectId, idempotencyKey: `${input.idempotencyKey}:verification`, data: {
                    task_id: run.task_id, run_id: row.run_id, verifier_actor_id: this.actorId, claim: input.claim,
                    result: input.result, evidence_id: evidence.objectId, verified_at: verifiedAt
                } });
            const evaluations = this.rows('SELECT e.id,e.policy_use_id,e.baseline_ref,o.revision,e.feedback_event_id FROM evaluations e JOIN policy_uses p ON p.id=e.policy_use_id JOIN objects o ON o.id=e.id WHERE p.project_id=? AND p.run_id=? AND o.archived_at IS NULL', [projectId, row.run_id]);
            for (const evaluation of evaluations) {
                let baseline = {};
                try {
                    baseline = JSON.parse(String(evaluation.baseline_ref || '{}'));
                }
                catch { /* Historical malformed claims stay unassessed. */ }
                const evidenceRefs = Array.isArray(baseline.evidence) ? baseline.evidence : [];
                if (!input.turnId || baseline.turnId !== input.turnId)
                    continue;
                const assessment = input.experienceAssessments?.find(item => item.lessonId === baseline.lessonId && item.lessonRevision === baseline.lessonRevision && item.action === baseline.action && item.evidence?.trim());
                if (!assessment || (evidenceRefs.length === 0 && assessment.result !== 'fail'))
                    continue;
                const verdict = assessment.result === 'fail' ? 'ineffective' : input.result === 'pass' ? 'effective' : 'degraded';
                const feedbackId = this.experienceFeedback(projectId, String(evaluation.policy_use_id), verification.objectId, verdict, String(baseline.action), String(evaluation.feedback_event_id));
                this.write({ kind: 'evaluation', action: 'patch', scope: projectId, objectId: String(evaluation.id), expectedRevision: Number(evaluation.revision), idempotencyKey: `${input.idempotencyKey}:evaluation:${evaluation.id}`, data: { verification_id: verification.objectId, feedback_event_id: feedbackId, verdict, value: verdict === 'effective' ? 1 : verdict === 'degraded' ? 0.5 : 0 } });
            }
            const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0) AS value FROM events')[0].value);
            this.db.run("UPDATE requests SET status='committed',result_content_id=?,committed_sequence=? WHERE id=?", [this.putStructuredContent(verification), sequence, requestId]);
            return verification;
        });
    }


exports.applyLearningReviewNative=(store,input)=>{
  const originals=new Map(),helpers={applyDirectReviewLessons,resumeLegacyReviewTarget,canonicalLegacyReviewTarget};
  for(const [name,method] of Object.entries(helpers)){originals.set(name,Object.getOwnPropertyDescriptor(store,name));Object.defineProperty(store,name,{value:method,writable:true,configurable:true});}
  try{return applyLearningReview.call(store,input);}
  finally{for(const [name,descriptor] of originals){if(descriptor)Object.defineProperty(store,name,descriptor);else delete store[name];}}
};
exports.recordRunVerificationNative=(store,projectId,input)=>require('./native-run-producer-oracles.cjs').withNativeRunHelpers(store,()=>recordRunVerification.call(store,projectId,input));

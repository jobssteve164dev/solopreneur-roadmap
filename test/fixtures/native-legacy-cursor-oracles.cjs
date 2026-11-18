const {createHash}=require('node:crypto'),{canonicalJson:canonical}=require('../../out/contentReferences.js'),learningReview_js_1=require('../../out/learningReview.js');
const digest=value=>createHash('sha256').update(value).digest('hex');
const native={
    importLegacyLearningReviewCursor(identity, bytes, hash, projects = []) {
        return this.transaction(() => {
            const source = { identity, key: 'review-state.json', hash };
            const state = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
            const input = (state.deferredSources || []).some((source) => source.content === undefined && source.value === undefined) ? this.legacyLearningReviewCursorInput(identity, state, hash) : null;
            const validate = (source) => {
                (0, learningReview_js_1.legacyReviewSourceBody)(source);
                if (source.projectPath && !projects.includes(source.projectPath))
                    throw new Error('legacy_review_source_invalid');
                for (const version of source.previousVersions || [])
                    validate(version);
            };
            for (const source of this.resolveLegacyLearningReviewCursorSources(identity, state, hash))
                validate(source);
            const imported = this.importObjectInternal({ kind: 'setting', action: 'create', scope: null, idempotencyKey: `legacy-review-cursor:${canonical(source)}`, data: { namespace: 'learning_review_legacy', key: identity, owner_scope: 'global', content: bytes.toString('utf8') } }, source);
            if (input) {
                const cursorId = imported.receipt?.objectId || String(this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [identity, source.key])[0].object_id);
                this.db.run('INSERT OR IGNORE INTO legacy_learning_review_cursor_inputs VALUES(?,?,?,?,?,?)', [identity, hash, input.runKey, cursorId, this.readMetadata(cursorId).revision, input.inputContentId]);
            }
            this.markMigrationSourceImported(identity, source.key);
            return { unchanged: imported.unchanged };
        });
    },
    legacyLearningReviewCursorInput(identity, state, hash) {
        if (typeof state.lastAppliedRunId !== 'string' || !state.lastAppliedRunId || /[\\/]/.test(state.lastAppliedRunId))
            throw new Error('legacy_review_cursor_source_missing');
        const runKey = `runs/${state.lastAppliedRunId}`;
        const pinned = this.rows('SELECT run_key,input_content_id FROM legacy_learning_review_cursor_inputs WHERE source_identity=? AND cursor_hash=?', [identity, hash])[0];
        if (pinned && pinned.run_key !== runKey)
            throw new Error('legacy_review_cursor_source_mismatch');
        const row = pinned || this.rows('SELECT input_content_id FROM legacy_learning_review_controls WHERE source_identity=? AND source_key=?', [identity, runKey])[0];
        if (!row)
            throw new Error('legacy_review_cursor_source_missing');
        return { runKey, inputContentId: String(row.input_content_id) };
    },
    resolveLegacyLearningReviewCursorSources(identity, state, hash) {
        const sources = state.deferredSources || [];
        const minimal = sources.some((source) => source.content === undefined && source.value === undefined);
        const input = minimal ? this.legacyLearningReviewCursorInput(identity, state, hash) : null;
        const manifest = input ? this.learningReviewManifest(JSON.parse(this.content(input.inputContentId).toString('utf8'))) : null;
        const original = (source) => {
            const { content, ...metadata } = source;
            const restored = source.kind === 'deleted_source' && source.value?.contentUnavailable === true ? metadata : source;
            return { ...restored, ...(source.previousVersions ? { previousVersions: source.previousVersions.map(original) } : {}) };
        };
        return sources.map((source) => {
            if (source.content !== undefined || source.value !== undefined)
                return source;
            if (Object.keys(source).some(key => !['id', 'hash', 'projectPath'].includes(key)))
                throw new Error('legacy_review_cursor_source_mismatch');
            const matches = manifest.sources.filter(original => original.id === source.id && original.hash === source.hash);
            if (matches.length !== 1 || (source.projectPath && source.projectPath !== matches[0].projectPath))
                throw new Error('legacy_review_cursor_source_mismatch');
            return original(matches[0]);
        });
    },
    learningReviewManifest(saved) {
        const restore = (source) => ({ ...this.learningReviewSourceValue(saved, source), content: this.content(String(saved.sourceContents[`${source.id}:${source.hash}:${source.contentHash}`] || saved.sourceContents[`${source.id}:${source.hash}`])).toString('utf8'), ...(source.previousVersions ? { previousVersions: source.previousVersions.map(restore) } : {}) });
        return { ...saved.manifest, sources: saved.manifest.sources.map(restore) };
    },
    learningReviewSourceValue(saved, source) {
        const id = saved.sourceContents?.[`@value:${source.id}:${source.hash}:${source.contentHash}`] || saved.sourceContents?.[`@value:${source.id}:${source.hash}`];
        return id ? { ...source, value: JSON.parse(this.content(String(id)).toString('utf8')) } : source;
    },
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
};
function nativeLegacyCursor(store,...args){const saved=new Map();for(const [name,method] of Object.entries(native)){if(name==='importLegacyLearningReviewCursor')continue;saved.set(name,Object.getOwnPropertyDescriptor(store,name));Object.defineProperty(store,name,{value:method,writable:true,configurable:true});}try{return native.importLegacyLearningReviewCursor.apply(store,args);}finally{for(const [name,descriptor]of saved){if(descriptor)Object.defineProperty(store,name,descriptor);else delete store[name];}}}
module.exports={native,nativeLegacyCursor};

// Exact complete synchronous Native state imports captured from v151 before migration.
const {canonicalJson:canonical}=require('../../out/contentReferences.js');
// Frozen compiled method SHA256 11e4b1bc50233308439934f49115aa164f1ebbb1f1e6bd530c72beaca9b373f6
function importObjectInternal(input, source, contentBindings = {}) {
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

// Frozen compiled method SHA256 dd5aa1d71c87fb77753785aef6026a324b1440618a71bdb08beb889d49463ff1
function importAnalysisState(projectId, namespace, key, value, source) {
        if (!namespace.trim() || !key.trim() || value === undefined)
            throw new Error('invalid_analysis_state');
        return this.transaction(() => {
            const current = this.readAnalysisState(projectId, namespace, key);
            const binding = this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
            if (current.objectId && binding?.object_id !== current.objectId)
                throw new Error('migration_conflict: existing_database_choice');
            return this.importObjectInternal({ kind: 'setting', action: 'create', scope: projectId, idempotencyKey: `import-analysis:${canonical(source)}`,
                data: { namespace: `analysis:${namespace}`, key, owner_scope: projectId || 'global', content: JSON.stringify(value) } }, source);
        });
    }

// Frozen compiled method SHA256 734321b51bdfe954532981ea0c8f92b8f4419a0df43d31a0fe70ef6de2cfdd0c
function importStrategyState(projectId, value, source) {
        return this.transaction(() => {
            const current = this.readStrategyState(projectId);
            const binding = this.rows('SELECT object_id FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
            if (current.objectId && binding?.object_id !== current.objectId)
                throw new Error('migration_conflict: existing_database_choice');
            return this.importObjectInternal({ kind: 'setting', action: 'create', scope: projectId, idempotencyKey: `import-strategy:${canonical(source)}`,
                data: { namespace: 'strategy', key: projectId === null ? 'cache' : 'preferences', owner_scope: projectId || 'global', content: JSON.stringify(value) } }, source);
        });
    }

exports.importStateNative=(store,type,args)=>{const saved=Object.getOwnPropertyDescriptor(store,'importObjectInternal');Object.defineProperty(store,'importObjectInternal',{value:importObjectInternal,writable:true,configurable:true});try{return(type==='analysis'?importAnalysisState:importStrategyState).apply(store,args);}finally{if(saved)Object.defineProperty(store,'importObjectInternal',saved);else delete store.importObjectInternal;}};

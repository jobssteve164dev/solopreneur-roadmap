// Frozen actual Native import entry and binding kernel from v145, for characterization only.
// Original compiled method SHA256 0e7daf6459f3051014cfe7f32917a6f411407ee9e57209e8b5671ccb744fb577
function importObject(input, source) {
        return this.importObjectInternal(input, source);
    }

// Original compiled method SHA256 4de5be7620811a00efacd9a9c9a8b5e557f6ca5480fab77f9c00467c586f3a47
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

exports.importObjectNative=(store,input,source)=>{
  const previous=Object.getOwnPropertyDescriptor(store,'importObjectInternal');
  Object.defineProperty(store,'importObjectInternal',{value:importObjectInternal,writable:true,configurable:true});
  try{return importObject.call(store,input,source);}
  finally{if(previous)Object.defineProperty(store,'importObjectInternal',previous);else delete store.importObjectInternal;}
};

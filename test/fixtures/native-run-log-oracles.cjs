// Exact original Native log graph for synchronous historical fixtures and transaction oracles only.
// Original methods/hashes: native-run-log-oracles-v138.json in task evidence.
const crypto=require('node:crypto');
const {canonicalJson:canonical}=require('../../out/contentReferences.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

// Original method SHA256 fd99df7ed5be3555393f34d48575ec0752d009842f8d3293fa0b0a41a1fa38ad
function appendRunLog(projectId, input) {
        return this.appendRunLogContent(projectId, input);
    }

// Original method SHA256 fef761a0bb3980543a5faebe1be4550d1bfcb334bf02dda80d35718f0a432881
function appendRunLogContent(projectId, input, binding) {
        const run = this.runControl(projectId, input.executionLogId);
        if (run.generation !== input.generation)
            throw new Error('run_owner_conflict');
        if (input.stream === 'output')
            throw new Error('reserved_log_stream');
        if (!input.stream || !Number.isInteger(input.sequence) || input.sequence < 0 || !Number.isInteger(input.offset) || input.offset < 0 || !input.idempotencyKey)
            throw new Error('invalid_log_chunk');
        const bytes = binding ? undefined : Buffer.from(input.bytes, 'base64');
        const byteLength = binding ? binding.byteLength : bytes.length;
        if (!byteLength || bytes && bytes.toString('base64') !== input.bytes)
            throw new Error('invalid_log_bytes');
        const hash = binding ? binding.sha256 : digest(bytes);
        const inputHash = binding ? binding.intentHash : digest(canonical({ operation: 'append_run_log', projectId, input }));
        return this.transaction(() => {
            const previous = this.rows('SELECT input_hash,result_content_id,result_inline_json FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, input.idempotencyKey])[0];
            if (previous) {
                if (previous.input_hash !== inputHash)
                    throw new Error('idempotency_conflict');
                return JSON.parse(this.requestResult(previous).toString('utf8'));
            }
            const last = this.rows('SELECT sequence,byte_offset,byte_length FROM log_chunks JOIN contents ON contents.id=log_chunks.content_id WHERE run_id=? AND stream=? ORDER BY sequence DESC LIMIT 1', [run.run_id, input.stream])[0];
            const sequence = last ? Number(last.sequence) + 1 : 0;
            const offset = last ? Number(last.byte_offset) + Number(last.byte_length) : 0;
            if (input.sequence !== sequence || input.offset !== offset)
                throw new Error('log_sequence_conflict');
            const requestId = crypto.randomUUID();
            const now = Date.now();
            this.db.run('INSERT INTO requests(actor_id,idempotency_key,id,input_hash,status) VALUES(?,?,?,?,?)', [this.actorId, input.idempotencyKey, requestId, inputHash, 'pending']);
            const contentId = binding?.contentId || this.putContent(bytes, 'application/octet-stream', 'binary');
            this.db.run('INSERT INTO log_chunks VALUES(?,?,?,?,?,?)', [run.run_id, input.stream, sequence, contentId, now, offset]);
            if (input.stream === 'stdout' || input.stream === 'stderr') {
                const output = this.readRunLogHead(projectId, input.executionLogId, 'output');
                this.db.run('INSERT INTO log_chunks VALUES(?,?,?,?,?,?)', [run.run_id, 'output', output.nextSequence, contentId, now, output.totalBytes]);
            }
            const committedSequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM events')[0].next);
            const descriptor = this.putStructuredContent({ stream: input.stream, sequence, offset, byteLength, sha256: hash });
            this.db.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', [crypto.randomUUID(), committedSequence, run.run_id, this.actorId, 'run.log_appended', descriptor, now, requestId]);
            const result = { requestId, committedSequence, nextSequence: sequence + 1, totalBytes: offset + byteLength };
            this.db.run("UPDATE requests SET status='committed',committed_sequence=?,result_inline_json=? WHERE id=?", [committedSequence, canonical(result), requestId]);
            return result;
        });
    }

exports.appendRunLogNative=(store,projectId,input)=>{
  const original=Object.getOwnPropertyDescriptor(store,'appendRunLogContent');
  Object.defineProperty(store,'appendRunLogContent',{value:appendRunLogContent,writable:true,configurable:true});
  try{return appendRunLog.call(store,projectId,input);}
  finally{if(original)Object.defineProperty(store,'appendRunLogContent',original);else delete store.appendRunLogContent;}
};

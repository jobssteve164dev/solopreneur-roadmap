#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const outputPath = String(process.env.SOLOMAP_HOOK_PROBE_OUTPUT || '').trim();
const includeTranscriptPath = process.env.SOLOMAP_HOOK_PROBE_INCLUDE_TRANSCRIPT_PATH === '1';
const invokedAs = String(process.argv[2] || '').trim();

if (!outputPath) {
  process.stderr.write('SOLOMAP_HOOK_PROBE_OUTPUT is required.\n');
  process.exit(2);
}

let payload = {};
try {
  const input = fs.readFileSync(0, 'utf8').trim();
  payload = input ? JSON.parse(input) : {};
} catch (error) {
  process.stderr.write(`Invalid hook payload: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const record = {
  invokedAs,
  hookEventName: String(payload.hook_event_name || payload.hookEventName || ''),
  sessionId: String(payload.session_id || payload.sessionId || ''),
  turnId: String(payload.turn_id || payload.turnId || ''),
  cwd: String(payload.cwd || ''),
  reason: String(payload.reason || ''),
  stopHookActive: Boolean(payload.stop_hook_active || payload.stopHookActive),
  payloadKeys: Object.keys(payload).sort(),
  recordedAt: new Date().toISOString()
};

if (includeTranscriptPath) {
  record.transcriptPath = String(payload.transcript_path || payload.transcriptPath || '');
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
process.stdout.write('{}\n');

import type { DataObject, DataWrite } from './db/unifiedDataStore';

const reviewedKinds = ['memory', 'lesson', 'review_batch'];
const candidateStates = ['captured', 'candidate', 'pending', 'draft', 'rejected'];
const hostKinds = ['project', 'roadmap_node', 'grant', 'runtime_instance', 'setting', 'integration', 'package_version', 'policy', 'policy_use', 'application', 'verification', 'evaluation', 'lesson_decision'];
const externalMemoryFields = ['external_source', 'external_revision', 'canonical_hash', 'external_entry_revision', 'external_scope', 'legacy_entry_id'];

export function agentReadableObject(object: DataObject): DataObject {
  if (object.kind !== 'review_batch' || object.projection?.hostReview !== true) return object;
  const data = { ...object.data };
  delete data.review_content; delete data.review_content_id;
  return { ...object, data };
}

export function canAgentRead(object: DataObject, scope: string, reviewBatchId: string | undefined, reviewScopeCurrent: boolean): boolean {
  if (object.kind === 'review_batch' && object.projection?.hostReview === true && (object.objectId !== reviewBatchId || !reviewScopeCurrent)) return false;
  if (object.kind === 'memory' && ['revoked', 'disabled', 'invalidated', 'expired'].includes(String(object.data.status))) return false;
  return object.projectId === scope || object.objectId === scope || (object.projectId === null && ['memory', 'lesson', 'policy'].includes(object.kind) && ['verified', 'approved', 'active'].includes(String(object.data.status)));
}

/** Discovery surfaces expose only currently usable external memory. Exact fixed-version reads remain available for audit/history. */
export function canAgentDiscover(object: DataObject, now = Date.now()): boolean {
  if (object.kind !== 'memory' || !object.data.external_source) return true;
  return object.data.status === 'active' && object.data.layer !== 'candidate' &&
    (object.data.valid_from == null || Number(object.data.valid_from) <= now) &&
    (object.data.valid_until == null || Number(object.data.valid_until) > now);
}

export function validateAgentLink(source: DataObject, relation: string): void {
  validateAgentWrite({ kind: source.kind, action: 'patch', scope: source.projectId, objectId: source.objectId, expectedRevision: source.revision, idempotencyKey: 'authorization', data: {} }, source);
  if (relation === 'adopts' || relation === 'feedback') throw new Error('host_observation_requires_authorization');
}

/** Claims remain writable; observations and reviewed decisions use the host's existing actions. */
export function validateAgentWrite(input: DataWrite, existing?: DataObject): void {
  if (hostKinds.includes(input.kind)) throw new Error('action_requires_existing_authorization');
  if (!input.data || Object.keys(input.data).some(key => key.endsWith('_content_id') || key === 'content_id' || key === 'secret_ref')) throw new Error('raw_content_reference_denied');
  if (input.kind === 'lesson' && Object.prototype.hasOwnProperty.call(input.data, 'semantic_review_json')) throw new Error('action_requires_existing_authorization');
  if (input.kind === 'review_batch' && existing?.projection?.hostReview === true && (input.action !== 'patch' || Object.keys(input.data).some(key => key !== 'proposal_content'))) throw new Error('review_input_requires_host');
  if (input.kind === 'memory' && (existing?.data.external_source || externalMemoryFields.some(key => Object.prototype.hasOwnProperty.call(input.data, key)))) throw new Error('host_observation_requires_authorization');
  if (input.kind === 'learning_event' && existing && (
    existing.data.source_type && existing.data.source_type !== 'agent_claim' ||
    Boolean(existing.data.verification_signal) ||
    ['verified', 'verified_failed'].includes(String(existing.data.event_type || ''))
  )) throw new Error('host_observation_requires_authorization');
  if (input.kind === 'learning_event' && (
    Object.prototype.hasOwnProperty.call(input.data, 'verification_signal') ||
    ['verified', 'verified_failed'].includes(String(input.data.event_type || '')) ||
    (Object.prototype.hasOwnProperty.call(input.data, 'source_type') && input.data.source_type !== 'agent_claim')
  )) throw new Error('host_observation_requires_authorization');
  if (reviewedKinds.includes(input.kind) && ((input.data.status && !candidateStates.includes(String(input.data.status))) || (existing && !candidateStates.includes(String(existing.data.status))))) throw new Error('promotion_requires_existing_review');
  if (Object.keys(input.data).some(key => key.endsWith('actor_id') || ['exit_code', 'finished_at', 'duration_ms', 'observed_at', 'availability', 'validation_error', 'completed_at', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens', 'usage_json'].includes(key))) throw new Error('host_observation_requires_authorization');
  const claimedKinds = ['task', 'turn', 'run', 'evidence', 'report', 'workflow_loop'];
  if (claimedKinds.includes(input.kind)) {
    if (input.action !== 'create' || (input.data.status && !['draft', 'proposed', 'claimed'].includes(String(input.data.status))) || (input.data.outcome && input.data.outcome !== 'claimed') || (input.kind === 'evidence' && input.data.type !== 'agent_claim')) throw new Error('host_observation_requires_authorization');
  }
}

export interface ClaudeNativeEvent {
  schemaVersion: 1;
  phase?: 'start' | 'complete';
  sequence: number;
  sessionId: string;
  providerTurnId: string;
  userUuid: string;
  assistantUuids: string[];
  startedAt: string;
  completedAt: string;
  reason: 'answer' | 'aborted' | 'refusal' | 'error';
}

export function validateClaudeNativeEvent(value: unknown): ClaudeNativeEvent {
  const event = value as ClaudeNativeEvent;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!event || event.schemaVersion !== 1 || !Number.isSafeInteger(event.sequence) || event.sequence < 1
    || !uuid.test(event.sessionId) || !uuid.test(event.providerTurnId) || typeof event.userUuid !== 'string' || !event.userUuid
    || !Array.isArray(event.assistantUuids) || event.assistantUuids.some(id => typeof id !== 'string' || !id)
    || new Set(event.assistantUuids).size !== event.assistantUuids.length
    || !['answer', 'aborted', 'refusal', 'error'].includes(event.reason)
    || event.phase !== undefined && !['start', 'complete'].includes(event.phase)
    || !Number.isFinite(Date.parse(event.startedAt)) || !Number.isFinite(Date.parse(event.completedAt))
    || Date.parse(event.completedAt) < Date.parse(event.startedAt)
    || event.phase !== 'start' && event.reason === 'answer' && !event.assistantUuids.length
    || event.phase === 'start' && event.assistantUuids.length !== 0) throw new Error('invalid_claude_native_event');
  return { schemaVersion: 1, phase: event.phase || 'complete', sequence: event.sequence, sessionId: event.sessionId, providerTurnId: event.providerTurnId,
    userUuid: event.userUuid, assistantUuids: [...event.assistantUuids], startedAt: event.startedAt, completedAt: event.completedAt, reason: event.reason };
}

export function claudeNativeEventPurpose(generation: number, sequence: number): string {
  return `claude_event_${generation}_${sequence}`;
}

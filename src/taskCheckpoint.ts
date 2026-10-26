export type TaskCheckpointOutcome = 'partial' | 'candidate_complete' | 'blocked_user' | 'blocked_external' | 'failed';
export type AgentInputMode = 'prompt_turn' | 'session_reentry' | 'closed';

export function isInteractiveConversationRunKind(runKind: string): boolean {
  return ['solo', 'step', 'solo_continue', 'step_continue'].includes(String(runKind || ''));
}

export function resolveAgentInputMode(runKind: string, sessionReentry = false): AgentInputMode {
  if (!isInteractiveConversationRunKind(runKind)) return 'closed';
  return sessionReentry ? 'session_reentry' : 'prompt_turn';
}

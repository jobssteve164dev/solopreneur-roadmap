export type TaskCheckpointOutcome = 'partial' | 'candidate_complete' | 'blocked_user' | 'blocked_external' | 'failed';

export function isInteractiveConversationRunKind(runKind: string): boolean {
  return ['solo', 'step', 'solo_continue', 'step_continue'].includes(String(runKind || ''));
}

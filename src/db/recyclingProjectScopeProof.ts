import type { ProjectRetirementCandidate } from './projectRetirement.js';

/** Internal control flow; it must never be turned into a changed-file receipt. */
export class RecyclingProjectScopePending extends Error {
  constructor(public readonly candidate: ProjectRetirementCandidate) { super('recycling_project_scope_pending'); }
}
export function rethrowRecyclingProjectScopePending(error: unknown): void {
  if (error instanceof RecyclingProjectScopePending) throw error;
}
export const recyclingProjectScopeOperations = new Set([
  'prepare_recycling', 'read_recycling_plan', 'confirm_recycling', 'hold_recycling_file',
  'finish_recycling_file', 'retire_recycling_file', 'restore_recycling_file', 'execute_recycling_plan'
]);

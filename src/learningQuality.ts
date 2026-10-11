export function isTrashOrLocalPrivate(candidate: {
  summary: string; appliesWhen: string; doThis: string; avoidThis: string;
  evidenceRefs?: Array<{ type: string; ref: string; summary?: string }>; promotionTarget?: string;
}): boolean {
  const textToCheck = `${candidate.summary}\n${candidate.appliesWhen}\n${candidate.doThis}\n${candidate.avoidThis}\n${(candidate.evidenceRefs || []).map((ref) => `${ref.type}:${ref.ref} ${ref.summary || ''}`).join('\n')}`.toLowerCase();
  if (textToCheck.includes('run completed without explicit verification signal in captured tail')) return true;
  if (isLowValueLearningText(textToCheck)) return true;
  if (candidate.promotionTarget === 'pattern' || candidate.promotionTarget === 'operating_rule' || candidate.promotionTarget === 'decision' || candidate.promotionTarget === 'domain' || !candidate.promotionTarget) {
    if (textToCheck.includes('/home/') || textToCheck.includes('/users/') || textToCheck.includes('/tmp/') || textToCheck.includes('__solo__') || textToCheck.includes('/agent-runs/')) return true;
  }
  return false;
}

export function isLowValueLearningText(value: string): boolean {
  const text = String(value || '').toLowerCase();
  if (!text) return true;
  return (
    text.includes('run completed without explicit verification signal')
    || text.includes('/prompt.txt')
    || text.includes('.solopreneur/agent-runs/')
    || text.includes('agent-runs/<rungroup>')
    || text.includes('agent-runs/<runGroup>'.toLowerCase())
    || text.includes('__solo__')
    || text.includes('__solo__/<runid>')
    || text.includes('dangerously-bypass-approvals')
    || text.includes('--skip-git-repo-check')
    || text.includes(' codex exec ')
    || text.includes("cat '<home>")
    || text.includes('cat <home>')
    || text.includes("cat '<projectroot>")
    || text.includes('cat <projectroot>')
  );
}

export function isUsefulVerificationSignal(value: unknown): boolean {
  const line = String(value || '').replace(/\s+/g, ' ').trim();
  const text = line.length > 360 ? `${line.slice(0, 359)}…` : line;
  if (!text || isLowValueLearningText(text)) return false;
  return /\b(test|tests|passed|passing|validated|validation|verify|verified|tsc|vitest|jest|playwright|pytest|npm run|npm test|node --test)\b/i.test(text);
}

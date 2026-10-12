import * as fs from 'fs';
import * as path from 'path';
import { ReviewManifest, reviewHash } from './learningReview.js';
import { sanitizeAttachmentScope } from './attachments.js';

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function scopedPath(root: string, relative: string, inspectFilesystem = true): string {
  requireValue(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.split('/').some(part => part === '..' || part === '.' || !part), 'Invalid review target path');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (inspectFilesystem) requireValue(!fs.existsSync(current) || !fs.lstatSync(current).isSymbolicLink(), 'Review target cannot follow symlinks');
  }
  return current;
}

function memoryTarget(manifest: ReviewManifest, relative: string, evidence: string[], inspectFilesystem = true): string {
  requireValue(/^(?:profile\.md|operating-rules\.md|(?:projects|patterns|decisions|domains|inbox|active)\/[A-Za-z0-9_.\-/\u4e00-\u9fff]+\.md)$/.test(relative), 'Memory target is outside review scope');
  if (relative.startsWith('projects/')) {
    const projects = manifest.projects.filter(project => `projects/${sanitizeAttachmentScope(path.basename(project).toLowerCase()) || 'project'}.md` === relative);
    requireValue(projects.length === 1 && evidence.some(id => manifest.sources.some(source => source.id === id && source.projectPath === projects[0])), 'Project memory requires unambiguous evidence from that project');
  }
  return scopedPath(path.join(manifest.globalRoot, 'memory'), relative, inspectFilesystem);
}

function evidenceValid(manifest: ReviewManifest, value: any): void {
  requireValue(Array.isArray(value) && value.length > 0 && value.every(id => typeof id === 'string' && manifest.sources.some(source => source.id === id)), 'Review evidence must reference manifest sources');
}

const meaningfulPromptLines = (value: string): string[] => value ? value.replace(/\r\n/g, '\n').split('\n') : [];

export function validateDirectGlobalPromptReview(manifest: ReviewManifest, result: any): void {
  const prompt = typeof result?.globalPrompt === 'string' ? result.globalPrompt : '';
  requireValue(prompt.trim().length > 0, '复盘 Agent 未生成有效的全局默认提示词。');
  requireValue(prompt.length <= 100_000, '复盘 Agent 生成的全局默认提示词过长。');
  requireValue(Array.isArray(result.changes), '复盘 Agent 未生成全局提示词变更记录。');
  requireValue(result.unresolved === undefined || (Array.isArray(result.unresolved) && result.unresolved.every((item: any) => typeof item === 'string')), '复盘未决项格式无效。');
  requireValue(result.deferredSourceIds === undefined || (Array.isArray(result.deferredSourceIds) && result.deferredSourceIds.every((id: any) => typeof id === 'string' && manifest.sources.some(source => source.id === id))), '复盘延期来源无效。');
  const sourceIds = new Set(manifest.sources.map(source => source.id));
  requireValue(Array.isArray(result.processedSourceIds) && result.processedSourceIds.every((id: any) => typeof id === 'string' && sourceIds.has(id)), '复盘已处理来源格式无效。');
  const processed = new Set(result.processedSourceIds);
  const deferred = new Set(result.deferredSourceIds || []);
  const semanticEvidence = new Set(manifest.sources.filter(source => !['global_prompt_mirror', 'project_document_index', 'deleted_source', 'review_proposal'].includes(source.kind) && !source.kind.startsWith('legacy_')).map(source => source.id));
  requireValue(processed.size === result.processedSourceIds.length && deferred.size === (result.deferredSourceIds || []).length
    && [...processed].every(id => !deferred.has(id))
    && [...sourceIds].every(id => processed.has(id) || deferred.has(id)), '每个增量来源必须明确标记为已处理或延期。');
  requireValue(Array.isArray(result.lessons), '复盘 Agent 未提交经验审核结果。');
  const lessonFingerprints = new Set<string>();
  for (const [index, lesson] of result.lessons.entries()) {
    requireValue(lesson && manifest.projects.includes(lesson.projectPath), `经验 ${index} 的项目范围无效。`);
    for (const key of ['summary', 'appliesWhen', 'doesNotApplyWhen', 'doThis', 'avoidThis', 'verification', 'reason']) {
      requireValue(typeof lesson[key] === 'string' && lesson[key].trim(), `经验 ${index} 缺少 ${key}。`);
    }
    requireValue(['verification_pattern', 'boundary_rule', 'planning_rule', 'risk_pattern', 'implementation_pattern', 'strategy_signal', 'user_preference'].includes(lesson.lessonType), `经验 ${index} 的类型无效。`);
    requireValue(Array.isArray(lesson.evidence) && lesson.evidence.length > 0 && lesson.evidence.every((id: any) => typeof id === 'string' && processed.has(id)), `经验 ${index} 必须引用本轮已处理来源。`);
    requireValue(new Set(lesson.evidence).size === lesson.evidence.length, `经验 ${index} 包含重复证据。`);
    const evidence: ReviewManifest['sources'] = lesson.evidence.map((id: string) => manifest.sources.find(source => source.id === id)!);
    requireValue(evidence.some((source: ReviewManifest['sources'][number]) => source.kind === 'learning_event' && source.ref && source.projectPath === lesson.projectPath), `经验 ${index} 必须引用同项目的真实学习事件。`);
    requireValue(evidence.every((source: ReviewManifest['sources'][number]) => !source.projectPath || source.projectPath === lesson.projectPath), `经验 ${index} 引用了其他项目的私有来源。`);
    const fingerprint = JSON.stringify([lesson.projectPath, lesson.summary.trim().toLowerCase(), lesson.appliesWhen.trim().toLowerCase()]);
    requireValue(!lessonFingerprints.has(fingerprint), `经验 ${index} 与本轮其他经验重复。`);
    lessonFingerprints.add(fingerprint);
  }
  const beforeFragments: string[] = [];
  const afterFragments: string[] = [];
  for (const [index, change] of result.changes.entries()) {
    requireValue(change && ['add', 'merge', 'revise', 'remove'].includes(change.type), `全局提示词变更 ${index} 类型无效。`);
    requireValue(Array.isArray(change.before) && change.before.every((item: any) => typeof item === 'string' && item.trim()), `全局提示词变更 ${index} 缺少有效旧约束。`);
    requireValue(typeof change.after === 'string', `全局提示词变更 ${index} 缺少新约束字段。`);
    requireValue(typeof change.reason === 'string' && change.reason.trim(), `全局提示词变更 ${index} 缺少理由。`);
    requireValue(Array.isArray(change.evidence) && change.evidence.length > 0
      && change.evidence.every((id: any) => id === 'current-global-prompt' || sourceIds.has(id)), `全局提示词变更 ${index} 缺少可定位证据。`);
    if (change.type === 'add' || change.type === 'revise' || change.type === 'merge') {
      const emptyBootstrap = change.type === 'add' && !manifest.globalPrompt.trim() && sourceIds.size === 0 && change.evidence.includes('current-global-prompt');
      const label = change.type === 'add' ? '新增' : change.type === 'merge' ? '合并' : '修订';
      requireValue(emptyBootstrap || change.evidence.some((id: any) => semanticEvidence.has(id) && processed.has(id)), `全局提示词${label} ${index} 必须引用本轮已处理的正式正文证据，不能只由旧提示词、索引或候选自证。`);
    }
    if (change.type === 'add') requireValue(change.before.length === 0 && change.after.trim(), `新增记录 ${index} 的前后内容无效。`);
    if (change.type === 'merge') requireValue(change.before.length >= 2 && change.after.trim(), `合并记录 ${index} 必须包含至少两条旧约束和替代文本。`);
    if (change.type === 'revise') {
      requireValue(change.before.length >= 1 && change.after.trim(), `修订记录 ${index} 必须包含旧约束和替代文本。`);
      requireValue(!(change.before.length === 1 && change.before[0].trim() === change.after.trim()), `修订记录 ${index} 不得用相同文本伪造变化。`);
    }
    if (change.type === 'remove') {
      requireValue(change.before.length >= 1 && !change.after.trim(), `删除记录 ${index} 不能包含替代文本。`);
      requireValue(['superseded_by_user', 'covered', 'duplicate', 'misplaced_specific', 'disproven'].includes(change.reasonCode), `删除记录 ${index} 必须标明可核验的删除依据类型。`);
      const genericReason = change.reason.trim().toLowerCase().replace(/[\s，。,.!！:：;；_-]+/g, '');
      requireValue(!['精简', '为了精简', '优化', '优化表达', '降低长度', '降低提示词长度', '缩短', 'shorten', 'cleanup', 'simplify'].includes(genericReason), `删除记录 ${index} 的理由不能只是精简或优化。`);
      requireValue(change.evidence.some((id: any) => semanticEvidence.has(id) && processed.has(id)), `删除记录 ${index} 必须引用本轮已处理的正式正文证据，不能由旧提示词自证。`);
      if (change.reasonCode === 'covered') requireValue(Array.isArray(change.coveredBy) && change.coveredBy.length > 0 && change.coveredBy.every((text: any) => typeof text === 'string' && text.trim() && prompt.includes(text) && !change.before.includes(text)), `删除记录 ${index} 必须定位最终版本中仍成立的覆盖文本。`);
      if (change.reasonCode === 'duplicate') requireValue(typeof change.duplicateOf === 'string' && change.duplicateOf.trim() && prompt.includes(change.duplicateOf) && !change.before.includes(change.duplicateOf), `删除记录 ${index} 必须定位最终版本中保留的同义约束。`);
    }
    for (const fragment of change.before) {
      requireValue(manifest.globalPrompt.includes(fragment), `全局提示词变更 ${index} 的旧约束无法在当前版本中定位。`);
      beforeFragments.push(fragment);
      if (change.type === 'remove') requireValue(!prompt.includes(fragment), `删除记录 ${index} 的旧约束仍存在于新版本。`);
    }
    if (change.after.trim()) {
      requireValue(prompt.includes(change.after), `全局提示词变更 ${index} 的新约束无法在最终版本中定位。`);
      afterFragments.push(change.after);
    }
  }
  const removedLines = meaningfulPromptLines(manifest.globalPrompt).filter(line => !meaningfulPromptLines(prompt).includes(line));
  requireValue(removedLines.every(line => beforeFragments.some(fragment => meaningfulPromptLines(fragment).includes(line))), `全局提示词存在删除但缺少变更记录：${removedLines.find(line => !beforeFragments.some(fragment => meaningfulPromptLines(fragment).includes(line))) || ''}`);
  const addedLines = meaningfulPromptLines(prompt).filter(line => !meaningfulPromptLines(manifest.globalPrompt).includes(line));
  requireValue(addedLines.every(line => afterFragments.some(fragment => meaningfulPromptLines(fragment).includes(line))), `全局提示词存在新增或改写但缺少证据理由：${addedLines.find(line => !afterFragments.some(fragment => meaningfulPromptLines(fragment).includes(line))) || ''}`);
  const oldUnchanged = meaningfulPromptLines(manifest.globalPrompt).filter(line => !beforeFragments.some(fragment => meaningfulPromptLines(fragment).includes(line)));
  const newUnchanged = meaningfulPromptLines(prompt).filter(line => !afterFragments.some(fragment => meaningfulPromptLines(fragment).includes(line)));
  requireValue(JSON.stringify(oldUnchanged) === JSON.stringify(newUnchanged), '全局提示词存在未记录的重排或结构变化。');
}

export function validateLearningReview(manifest: ReviewManifest, proposal: any, review: any, options: { historical?: boolean } = {}): void {
  const manifestHash = reviewHash(JSON.stringify(manifest));
  requireValue(proposal?.schemaVersion === 2 && proposal.runId === manifest.runId && proposal.manifestHash === manifestHash, 'Proposal does not match review input');
  requireValue(review?.schemaVersion === 1 && review.runId === manifest.runId && review.manifestHash === manifestHash && review.proposalHash === reviewHash(JSON.stringify(proposal)) && review.verdict === 'pass', 'Independent review has not passed for this proposal');
  requireValue(Array.isArray(proposal.memoryChanges) && Array.isArray(proposal.lessons) && Array.isArray(proposal.processedSources) && Array.isArray(proposal.unresolved) && Array.isArray(review.checks), 'Invalid review arrays');
  const checked = (target: string) => requireValue(review.checks.some((check: any) => check.target === target && check.safe === true && typeof check.reason === 'string' && check.reason.trim()), `Independent review missing ${target}`);
  const targets = new Set<string>();
  proposal.memoryChanges.forEach((change: any, index: number) => {
    evidenceValid(manifest, change.evidence); memoryTarget(manifest, change.path, change.evidence, !options.historical);
    requireValue(!targets.has(change.path), 'Combine patches to one change per memory file'); targets.add(change.path);
    requireValue(typeof change.baseHash === 'string' && typeof change.before === 'string' && typeof change.after === 'string' && change.after.trim() && typeof change.reason === 'string' && change.reason.trim(), 'Memory patch requires before, after, baseHash and reason');
    const original = manifest.memory.find(item => item.relativePath === change.path);
    requireValue(change.baseHash === (original?.hash || reviewHash('')), 'Memory patch base must match input');
    if (original) requireValue(change.before && original.content.split(change.before).length === 2, 'Memory patch before must match exactly once');
    else requireValue(change.before === '', 'New memory file must have an empty before');
    checked(`memory:${index}`);
  });
  if (proposal.globalPrompt !== null) {
    const prompt = proposal.globalPrompt;
    requireValue(prompt && typeof prompt.value === 'string' && prompt.value.length <= 100_000 && typeof prompt.reason === 'string' && prompt.reason.trim(), 'Invalid global prompt proposal');
    requireValue(!manifest.globalPrompt.trim() || prompt.value.trim(), 'Review cannot clear existing user instructions');
    requireValue(Array.isArray(prompt.evidence), 'Global prompt evidence must be an array');
    if (prompt.value !== manifest.globalPrompt) evidenceValid(manifest, prompt.evidence);
    if (prompt.constraints !== undefined) requireValue(Array.isArray(prompt.constraints), 'Global prompt constraint disposition must be an array');
    checked('globalPrompt');
  }
  proposal.lessons.forEach((lesson: any, index: number) => {
    evidenceValid(manifest, lesson.evidence);
    requireValue(manifest.projects.includes(lesson.projectPath), 'Lesson project is outside review scope');
    for (const key of ['summary', 'appliesWhen', 'doesNotApplyWhen', 'doThis', 'avoidThis', 'verification', 'reason']) requireValue(typeof lesson[key] === 'string' && lesson[key].trim(), `Lesson requires ${key}`);
    requireValue(['candidate', 'promoted', 'rejected'].includes(lesson.status), 'Invalid semantic lesson status');
    if (lesson.id) requireValue(/^lesson-[a-f0-9-]+$/.test(lesson.id), 'Invalid lesson identity');
    if (lesson.status === 'promoted') {
      memoryTarget(manifest, lesson.target, lesson.evidence, !options.historical);
      requireValue(proposal.memoryChanges.some((change: any) => change.path === lesson.target), 'Promotion requires a corresponding memory change');
    }
    checked(`lesson:${index}`);
  });
  const processed = new Set<string>();
  for (const item of proposal.processedSources) {
    requireValue(!processed.has(item.id), 'Duplicate source disposition'); processed.add(item.id);
    const source = manifest.sources.find(candidate => candidate.id === item.id && candidate.hash === item.hash);
    requireValue(source && ['created', 'skipped', 'deferred'].includes(item.decision) && typeof item.reason === 'string' && item.reason.trim(), 'Invalid source disposition');
    if (item.decision === 'created') {
      const promotedConstraintToPrompt = ['global_constraint', 'project_constraint'].includes(source?.kind || '')
        && proposal.globalPrompt?.value !== manifest.globalPrompt && proposal.globalPrompt?.evidence?.includes(item.id);
      requireValue(promotedConstraintToPrompt || proposal.lessons.some((lesson: any) => lesson.evidence.includes(item.id)), 'Created disposition requires a lesson or constraint promotion');
    }
  }
  for (const source of manifest.sources.filter(item => ['global_constraint', 'project_constraint'].includes(item.kind))) {
    const label = source.kind === 'global_constraint' ? 'Global constraint' : 'Project constraint';
    requireValue(processed.has(source.id), `${label} ${source.id} has no disposition`);
    const disposition = proposal.processedSources.find((item: any) => item.id === source.id);
    if (disposition.decision === 'created') {
      const promotedToPrompt = proposal.globalPrompt?.value !== manifest.globalPrompt && proposal.globalPrompt?.evidence?.includes(source.id);
      const promotedToMemory = proposal.lessons.some((lesson: any) => lesson.status === 'promoted' && lesson.evidence.includes(source.id) && /^(?:profile\.md|operating-rules\.md|(?:patterns|decisions|domains)\/.+\.md)$/.test(lesson.target));
      requireValue(promotedToPrompt || promotedToMemory, `${label} ${source.id} requires a global promotion`);
    }
    requireValue(review.checks.some((check: any) => check.target === `source:${source.id}` && check.safe === true && typeof check.reason === 'string' && check.reason.trim() && Array.isArray(check.evidence) && check.evidence.includes(source.id)), `Independent review missing source:${source.id}`);
  }
  checked('overall');
}

import * as fs from 'fs';
import * as path from 'path';
import { normalizeGlobalDataPath, ProjectPortfolioSummary, slugifyProjectId } from './projectPortfolio';

export interface GlobalEngineeringSnapshot {
  dataPath: string;
  portfolio: Array<{
    id: string;
    name: string;
    path: string;
    type: string;
    status: string;
    priority: string;
    blocker: string;
    nextAction: string;
    updatedAt: string;
  }>;
  dependencies: Array<{
    fromProject: string;
    toProject: string;
    capability: string;
    status: string;
    priorityImpact: string;
    reason: string;
    updatedAt: string;
  }>;
  learningCandidateCount: number;
}


function csvEscape(value: string | number): string {
  const raw = String(value ?? '');
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}


function writeFileIfMissing(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function writeSolomapMemoryExamples(memoryRoot: string, learningCandidatesDir: string): void {
  const examples: Array<{ filePath: string; content: string }> = [
    {
      filePath: path.join(memoryRoot, 'projects', '_example.md'),
      content: [
        '# Project Memory Example',
        '',
        'Create real project files as `projects/<project-slug>.md`. Keep only stable facts that help future work on that project.',
        '',
        '## Stable Facts',
        '- YYYY-MM-DD: Fact confirmed by current files, tests, logs, or user decision.',
        '',
        '## Decisions',
        '- YYYY-MM-DD: Decision, reason, and impact.',
        '',
        '## Current Handoff',
        '- Goal:',
        '- Confirmed state:',
        '- Next useful action:',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'patterns', '_example.md'),
      content: [
        '# Pattern Example',
        '',
        'Use one file per reusable delivery, implementation, debugging, or verification pattern.',
        '',
        '## Applies When',
        '- Situation where this pattern is useful.',
        '',
        '## Steps',
        '1. Action that reliably helps.',
        '2. Action that verifies the result.',
        '',
        '## Evidence',
        '- Where this pattern was validated.',
        '',
        '## Risks',
        '- When not to apply it.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'decisions', '_example.md'),
      content: [
        '# Decision Example',
        '',
        'Use one file per stable cross-project decision.',
        '',
        '## Status',
        '- proposed | accepted | superseded',
        '',
        '## Context',
        '- Why this decision exists.',
        '',
        '## Decision',
        '- What should happen from now on.',
        '',
        '## Impact',
        '- Projects, workflows, or user experience affected.',
        '',
        '## Review Trigger',
        '- When this decision should be revisited.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'domains', '_example.md'),
      content: [
        '# Domain Memory Example',
        '',
        'Use one file per domain that can help multiple projects.',
        '',
        '## Scope',
        '- What this domain memory covers.',
        '',
        '## Stable Knowledge',
        '- Verified domain fact or constraint.',
        '',
        '## Reuse Notes',
        '- How future projects should apply it.',
        '',
        '## Sources',
        '- File, user decision, command output, or trusted source that supports it.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'inbox', '_example.md'),
      content: [
        '# Inbox Example',
        '',
        'Use inbox for observations that may become memory but are not verified enough yet.',
        '',
        '## Observation',
        '- What was noticed.',
        '',
        '## Evidence',
        '- Where it came from.',
        '',
        '## Confidence',
        '- low | medium | high',
        '',
        '## Promotion Target',
        '- projects | patterns | decisions | domains | operating-rules | profile',
        '',
        '## Next Check',
        '- What must be verified before promotion.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'active', '_example.md'),
      content: [
        '# Active Session Example',
        '',
        'Use active memory for temporary handoff only. Promote stable information elsewhere before it becomes long-lived.',
        '',
        '## Current Goal',
        '- What is being handled now.',
        '',
        '## Confirmed Facts',
        '- Current facts verified in this session.',
        '',
        '## Next Action',
        '- The next concrete action if work resumes.',
        '',
        '## Open Risks',
        '- Known unresolved risks.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(learningCandidatesDir, '_example.md'),
      content: [
        '# Learning Candidate Example',
        '',
        'Use this area for reusable lessons before they are promoted into long-term memory.',
        '',
        '## Candidate Lesson',
        '- What future agents may reuse.',
        '',
        '## Source Task',
        '- Project, date, and task where it was observed.',
        '',
        '## Evidence',
        '- File, test, log, command output, or user decision that supports it.',
        '',
        '## Applies When',
        '- Conditions where this lesson is useful.',
        '',
        '## Promotion Target',
        '- memory/projects | memory/patterns | memory/decisions | memory/domains | memory/inbox',
        ''
      ].join('\n')
    }
  ];
  examples.forEach((example) => {
    fs.mkdirSync(path.dirname(example.filePath), { recursive: true });
    writeFileIfMissing(example.filePath, example.content);
  });
}

export function createGlobalEngineeringSnapshotPlaceholder(dataPath: string, portfolio: ProjectPortfolioSummary[]): GlobalEngineeringSnapshot {
  const normalizedPath = normalizeGlobalDataPath(dataPath);
  return {
    dataPath: normalizedPath,
    portfolio: portfolio.map((project) => ({
      id: slugifyProjectId(project.name || path.basename(project.path)),
      name: project.name,
      path: project.path,
      type: project.projectType || 'core_product',
      status: project.overallStatus || 'Pending',
      priority: project.globalPriority || 'P2',
      blocker: project.blocker || '',
      nextAction: project.globalNextAction || project.recommendedNodeTitle || '',
      updatedAt: project.recentActivityAt || ''
    })),
    dependencies: portfolio
      .filter((project) => project.blocker)
      .map((project) => ({
        fromProject: slugifyProjectId(project.name || path.basename(project.path)),
        toProject: '',
        capability: project.blocker,
        status: 'blocked',
        priorityImpact: 'raise_to_P0',
        reason: project.blocker,
        updatedAt: project.recentActivityAt || ''
      })),
    learningCandidateCount: 0
  };
}

export function ensureGlobalEngineeringStore(dataPath: string, portfolio: ProjectPortfolioSummary[]): GlobalEngineeringSnapshot {
  const normalizedPath = normalizeGlobalDataPath(dataPath);
  const learningDir = path.join(normalizedPath, 'learning', 'candidates');
  const learningApprovedDir = path.join(normalizedPath, 'learning', 'approved');
  const learningRejectedDir = path.join(normalizedPath, 'learning', 'rejected');
  const metricsDir = path.join(normalizedPath, 'metrics');
  const memoryRoot = path.join(normalizedPath, 'memory');
  fs.mkdirSync(learningDir, { recursive: true });
  fs.mkdirSync(learningApprovedDir, { recursive: true });
  fs.mkdirSync(learningRejectedDir, { recursive: true });
  fs.mkdirSync(metricsDir, { recursive: true });
  ['projects', 'patterns', 'decisions', 'domains', 'inbox', 'active'].forEach((dir) => {
    fs.mkdirSync(path.join(memoryRoot, dir), { recursive: true });
  });

  const now = new Date().toISOString();
  const records = portfolio.map((project) => ({
    id: slugifyProjectId(project.name || path.basename(project.path)),
    name: project.name,
    path: project.path,
    type: project.projectType || 'core_product',
    status: project.overallStatus || 'Pending',
    priority: project.globalPriority || 'P2',
    blocker: project.blocker || '',
    nextAction: project.globalNextAction || project.recommendedNodeTitle || '',
    updatedAt: now
  }));
  const dependencies = portfolio
    .filter((project) => project.blocker)
    .map((project) => ({
      fromProject: slugifyProjectId(project.name || path.basename(project.path)),
      toProject: '',
      capability: project.blocker,
      status: 'blocked',
      priorityImpact: 'raise_to_P0',
      reason: project.blocker,
      updatedAt: now
    }));

  const portfolioCsv = [
    'id,name,path,type,status,priority,blocker,next_action,updated_at',
    ...records.map((record) => [
      record.id,
      record.name,
      record.path,
      record.type,
      record.status,
      record.priority,
      record.blocker,
      record.nextAction,
      record.updatedAt
    ].map(csvEscape).join(','))
  ].join('\n') + '\n';
  const dependenciesCsv = [
    'from_project,to_project,capability,status,priority_impact,reason,updated_at',
    ...dependencies.map((record) => [
      record.fromProject,
      record.toProject,
      record.capability,
      record.status,
      record.priorityImpact,
      record.reason,
      record.updatedAt
    ].map(csvEscape).join(','))
  ].join('\n') + '\n';
  const capabilityCsvPath = path.join(normalizedPath, 'capability-registry.csv');
  const decisionsCsvPath = path.join(normalizedPath, 'decision-conflicts.csv');
  const readmePath = path.join(normalizedPath, 'README.md');
  const memoryReadmePath = path.join(memoryRoot, 'README.md');
  const profilePath = path.join(memoryRoot, 'profile.md');
  const operatingRulesPath = path.join(memoryRoot, 'operating-rules.md');
  const executionSpeedPath = path.join(metricsDir, 'execution-speed.csv');
  const reuseRatePath = path.join(metricsDir, 'reuse-rate.csv');
  const priorityAccuracyPath = path.join(metricsDir, 'priority-accuracy.csv');
  const monthlySummaryPath = path.join(metricsDir, 'monthly-summary.md');
  fs.writeFileSync(path.join(normalizedPath, 'portfolio.csv'), portfolioCsv, 'utf8');
  fs.writeFileSync(path.join(normalizedPath, 'dependencies.csv'), dependenciesCsv, 'utf8');
  if (!fs.existsSync(capabilityCsvPath)) {
    fs.writeFileSync(capabilityCsvPath, 'capability,first_project,reused_by,status,reuse_success_rate,last_improvement\n', 'utf8');
  }
  if (!fs.existsSync(decisionsCsvPath)) {
    fs.writeFileSync(decisionsCsvPath, 'topic,projects,conflict,resolution,status,owner,updated_at\n', 'utf8');
  }
  if (!fs.existsSync(executionSpeedPath)) {
    fs.writeFileSync(executionSpeedPath, 'project,node_id,stage,status,duration_ms,completed_at\n', 'utf8');
  }
  if (!fs.existsSync(reuseRatePath)) {
    fs.writeFileSync(reuseRatePath, 'project,node_id,reusable_signals,learning_candidates,recorded_at\n', 'utf8');
  }
  if (!fs.existsSync(priorityAccuracyPath)) {
    fs.writeFileSync(priorityAccuracyPath, 'project,priority,next_action,outcome,recorded_at\n', 'utf8');
  }
  if (!fs.existsSync(monthlySummaryPath)) {
    fs.writeFileSync(monthlySummaryPath, '# Monthly Learning Summary\n\nSoloMap uses this file to collect low-frequency cross-project learning signals.\n', 'utf8');
  }
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, [
      '# SoloMap Global Data',
      '',
      'This directory stores cross-project SoloMap coordination data.',
      '',
      '- `portfolio.csv`: project portfolio, priority, blocker, and next action.',
      '- `dependencies.csv`: cross-project blockers that affect priority.',
      '- `capability-registry.csv`: reusable capabilities confirmed or under review.',
      '- `decision-conflicts.csv`: cross-project decision conflicts.',
      '- `learning/candidates/`: learning candidates before they are promoted to long-term memory.',
      '- `learning/approved/`: candidates approved for promotion.',
      '- `learning/rejected/`: candidates that should stay out of long-term memory.',
      '- `metrics/`: low-frequency portfolio review metrics.',
      '- `memory/`: cross-project experience memory used by SoloMap agents.',
      '',
      'Do not delete this directory unless you intentionally want to remove SoloMap global coordination state.',
      ''
    ].join('\n'), 'utf8');
  }
  if (!fs.existsSync(memoryReadmePath)) {
    fs.writeFileSync(memoryReadmePath, [
      '# SoloMap Memory',
      '',
      'This directory stores reusable SoloMap experience across projects.',
      '',
      '- `profile.md`: stable user preferences and collaboration style.',
      '- `operating-rules.md`: reusable execution rules that apply across projects.',
      '- `projects/`: one memory file per project.',
      '- `patterns/`: reusable implementation, debugging, and delivery patterns.',
      '- `decisions/`: confirmed cross-project decisions and their rationale.',
      '- `domains/`: domain knowledge that can help future projects.',
      '- `inbox/`: unverified observations and learning candidates before promotion.',
      '- `active/`: current session handoff and temporary working context.',
      '',
      'Agents should treat memory as context, not as stronger evidence than current files, tests, logs, or the user request.',
      ''
    ].join('\n'), 'utf8');
  }
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, '# Profile\n\nStable user preferences and collaboration style promoted by SoloMap.\n', 'utf8');
  }
  if (!fs.existsSync(operatingRulesPath)) {
    fs.writeFileSync(operatingRulesPath, '# Operating Rules\n\nReusable execution rules promoted by SoloMap.\n', 'utf8');
  }
  writeSolomapMemoryExamples(memoryRoot, learningDir);
  const learningCandidateCount = (() => {
    try {
      return fs.readdirSync(learningDir).filter((name) => name.endsWith('.md') && name !== '_example.md').length;
    } catch {
      return 0;
    }
  })();
  return { dataPath: normalizedPath, portfolio: records, dependencies, learningCandidateCount };
}


import * as fs from 'fs';
import * as path from 'path';

export type ProjectFoundationItemKey = 'readme' | 'agents' | 'memory' | 'ci' | 'security';

export interface ProjectFoundationItem {
  key: ProjectFoundationItemKey;
  label: string;
  relativePath: string;
  present: boolean;
}

export interface ProjectFoundationAssessment {
  complete: boolean;
  missingCount: number;
  missing: ProjectFoundationItem[];
  items: ProjectFoundationItem[];
  message: string;
}

const FOUNDATION_ITEMS: Array<Omit<ProjectFoundationItem, 'present'>> = [
  { key: 'readme', label: 'README', relativePath: 'README.md' },
  { key: 'agents', label: 'Agent rules', relativePath: 'AGENTS.md' },
  { key: 'memory', label: 'Project memory', relativePath: 'PROJECT_MEMORY.md' },
  { key: 'ci', label: 'CI', relativePath: '.github/workflows/ci.yml' },
  { key: 'security', label: 'Security checks', relativePath: '.github/workflows/security.yml' }
];

function safeProjectName(projectRoot: string): string {
  return path.basename(projectRoot).replace(/[-_]+/g, ' ').trim() || 'Project';
}

function projectTypeLabel(projectType: string): string {
  if (projectType === 'infra') return 'Infrastructure / tooling foundation';
  if (projectType === 'content') return 'Content product';
  if (projectType === 'experiment') return 'Research / experiment';
  if (projectType === 'tool') return 'Tooling / scaffold';
  if (projectType === 'daily_work') return 'Operational workspace';
  if (projectType === 'archive') return 'Maintenance / archive';
  return 'Core product';
}

function packageManagerCommand(projectRoot: string): string {
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(projectRoot, 'bun.lockb')) || fs.existsSync(path.join(projectRoot, 'bun.lock'))) return 'bun';
  if (fs.existsSync(path.join(projectRoot, 'package.json'))) return 'npm';
  return '';
}

function nodeCiSteps(projectRoot: string): string[] {
  const manager = packageManagerCommand(projectRoot);
  if (!manager) {
    return [
      '      - uses: actions/checkout@v5',
      '      - name: Project health check',
      '        run: |',
      '          test -f README.md',
      '          test -f AGENTS.md',
      '          test -f PROJECT_MEMORY.md'
    ];
  }
  const install = manager === 'pnpm'
    ? 'pnpm install --frozen-lockfile'
    : manager === 'yarn'
      ? 'yarn install --frozen-lockfile'
      : manager === 'bun'
        ? 'bun install --frozen-lockfile'
        : 'npm ci';
  const run = manager === 'npm' ? 'npm run' : `${manager} run`;
  const setup = manager === 'pnpm'
    ? ['      - uses: pnpm/action-setup@v4', '        with:', '          version: latest']
    : manager === 'bun'
      ? ['      - uses: oven-sh/setup-bun@v2']
      : [];
  return [
    '      - uses: actions/checkout@v5',
    ...setup,
    '      - uses: actions/setup-node@v5',
    '        with:',
    '          node-version: 22',
    '      - name: Install',
    `        run: ${install}`,
    '      - name: Lint',
    `        run: ${run} lint --if-present`,
    '      - name: Type check',
    `        run: ${run} typecheck --if-present`,
    '      - name: Test',
    `        run: ${run} test --if-present`,
    '      - name: Build',
    `        run: ${run} build --if-present`
  ];
}

function securitySteps(projectRoot: string, projectType: string): string[] {
  const manager = packageManagerCommand(projectRoot);
  const steps = ['      - uses: actions/checkout@v5'];
  if (manager) {
    const install = manager === 'pnpm'
      ? 'pnpm install --frozen-lockfile'
      : manager === 'yarn'
        ? 'yarn install --frozen-lockfile'
        : manager === 'bun'
          ? 'bun install --frozen-lockfile'
          : 'npm ci';
    const audit = manager === 'pnpm'
      ? 'pnpm audit --audit-level high'
      : manager === 'yarn'
        ? 'yarn npm audit --severity high'
        : manager === 'bun'
          ? 'bun audit'
          : 'npm audit --audit-level=high';
    steps.push(
      ...(manager === 'pnpm' ? ['      - uses: pnpm/action-setup@v4', '        with:', '          version: latest'] : []),
      ...(manager === 'bun' ? ['      - uses: oven-sh/setup-bun@v2'] : []),
      '      - uses: actions/setup-node@v5',
      '        with:',
      '          node-version: 22',
      '      - name: Install',
      `        run: ${install}`,
      '      - name: Dependency audit',
      `        run: ${audit}`
    );
  } else {
    steps.push(
      '      - name: Foundation security check',
      '        run: |',
      '          test -f AGENTS.md',
      '          test -f PROJECT_MEMORY.md'
    );
  }
  if (!['content', 'experiment', 'archive', 'daily_work'].includes(projectType)) {
    steps.push(
      '  codeql:',
      '    name: CodeQL',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      security-events: write',
      '      packages: read',
      '      actions: read',
      '      contents: read',
      '    steps:',
      '      - uses: actions/checkout@v5',
      '      - uses: github/codeql-action/init@v4',
      '      - uses: github/codeql-action/analyze@v4'
    );
  }
  return steps;
}

function buildReadme(projectRoot: string, projectType: string): string {
  const name = safeProjectName(projectRoot);
  return [
    `# ${name}`,
    '',
    `Type: ${projectTypeLabel(projectType)}`,
    '',
    '## Purpose',
    '',
    'Describe what this project helps its users accomplish.',
    '',
    '## Current Status',
    '',
    'Early project foundation is ready. Keep this section short and update it when the project reaches a new usable state.',
    '',
    '## Run',
    '',
    'Add the main local run command here.',
    '',
    '## Verify',
    '',
    'Use the project CI and security workflow as the default verification baseline.',
    '',
    '## Ship',
    '',
    'Record the release or delivery path when this project has one.',
    ''
  ].join('\n');
}

function buildAgents(projectType: string): string {
  return [
    '# AGENTS.md',
    '',
    '## Project Goal',
    '',
    `This repository is a ${projectTypeLabel(projectType)}. Keep changes focused on the user-facing project goal, not on internal process decoration.`,
    '',
    '## Before Changing Files',
    '',
    '- Read `README.md` and `PROJECT_MEMORY.md` first.',
    '- Inspect the smallest relevant code or content path before proposing broad changes.',
    '- Preserve existing architecture, routes, and user workflows unless the task explicitly changes them.',
    '',
    '## Verification',
    '',
    '- Prefer the narrowest command that proves the changed behavior.',
    '- Run the CI/security commands when the change affects runtime, packaging, release, dependencies, or security.',
    '- Verify generated files directly when users will rely on generated output.',
    '',
    '## Safety',
    '',
    '- Do not expose secrets, tokens, local paths, prompts, or execution logs in user-facing output.',
    '- Do not delete or rewrite unrelated project files.',
    '- Treat high and critical security findings as action-changing risks.',
    ''
  ].join('\n');
}

function buildProjectMemory(projectRoot: string, projectType: string): string {
  return [
    '# PROJECT_MEMORY.md',
    '',
    'This file stores stable project facts future agents should reuse. Do not paste run logs, prompts, terminal output, or one-off debugging notes here.',
    '',
    '## Project Identity',
    '',
    `- Name: ${safeProjectName(projectRoot)}`,
    `- Type: ${projectTypeLabel(projectType)}`,
    '- Users:',
    '- Current stage:',
    '',
    '## Stable Decisions',
    '',
    '-',
    '',
    '## Architecture Boundaries',
    '',
    '-',
    '',
    '## Verification',
    '',
    '- Default CI: `.github/workflows/ci.yml`',
    '- Default security checks: `.github/workflows/security.yml`',
    '',
    '## Handoff Notes',
    '',
    '-',
    ''
  ].join('\n');
}

function buildCiWorkflow(projectRoot: string): string {
  return [
    'name: CI',
    '',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main, master]',
    '',
    'jobs:',
    '  verify:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    ...nodeCiSteps(projectRoot)
  ].join('\n') + '\n';
}

function buildSecurityWorkflow(projectRoot: string, projectType: string): string {
  return [
    'name: Security',
    '',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main, master]',
    '  schedule:',
    "    - cron: '17 4 * * 1'",
    '',
    'jobs:',
    '  audit:',
    '    name: Dependency audit',
    '    runs-on: ubuntu-latest',
    '    steps:',
    ...securitySteps(projectRoot, projectType)
  ].join('\n') + '\n';
}

export function assessProjectFoundation(projectRoot: string): ProjectFoundationAssessment {
  const items = FOUNDATION_ITEMS.map((item) => ({
    ...item,
    present: fs.existsSync(path.join(projectRoot, item.relativePath))
  }));
  const missing = items.filter((item) => !item.present);
  return {
    complete: missing.length === 0,
    missingCount: missing.length,
    missing,
    items,
    message: missing.length ? `Project foundation missing ${missing.length}` : 'Project foundation ready'
  };
}

export function ensureProjectFoundation(projectRoot: string, projectType = 'core_product'): ProjectFoundationAssessment {
  const files: Record<ProjectFoundationItemKey, string> = {
    readme: buildReadme(projectRoot, projectType),
    agents: buildAgents(projectType),
    memory: buildProjectMemory(projectRoot, projectType),
    ci: buildCiWorkflow(projectRoot),
    security: buildSecurityWorkflow(projectRoot, projectType)
  };
  for (const item of FOUNDATION_ITEMS) {
    const target = path.join(projectRoot, item.relativePath);
    if (fs.existsSync(target)) {
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files[item.key], 'utf8');
  }
  return assessProjectFoundation(projectRoot);
}


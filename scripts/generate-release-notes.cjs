#!/usr/bin/env node

const fs = require('fs');
const childProcess = require('child_process');

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function run(command, args) {
  return childProcess.execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function humanizeCommit(subject) {
  return String(subject || '')
    .replace(/^\w+(?:\([^)]+\))?!?:\s*/, '')
    .replace(/\s+\[skip ci\]$/i, '')
    .trim();
}

function categoryFor(subject) {
  const raw = String(subject || '').toLowerCase();
  if (/^feat(?:\(|:|!)/.test(raw)) return 'Added';
  if (/^fix(?:\(|:|!)/.test(raw)) return 'Fixed';
  if (/^docs(?:\(|:|!)/.test(raw)) return 'Docs';
  if (/^test(?:\(|:|!)/.test(raw)) return 'Tests';
  if (/^chore\(release\)/.test(raw)) return '';
  return 'Changed';
}

function parseCommits(from, to) {
  const range = from ? `${from}..${to}` : to;
  const output = run('git', ['log', '--pretty=format:%H%x1f%s', range]);
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => {
      const [hash, subject] = line.split('\x1f');
      return { hash, subject };
    })
    .filter((commit) => commit.hash && categoryFor(commit.subject));
}

function renderNotes(version, date, commits) {
  const groups = new Map();
  for (const commit of commits) {
    const category = categoryFor(commit.subject);
    if (!category) continue;
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(`- ${humanizeCommit(commit.subject)} (${commit.hash.slice(0, 7)})`);
  }
  const order = ['Added', 'Changed', 'Fixed', 'Docs', 'Tests'];
  const body = order
    .filter((category) => groups.has(category))
    .map((category) => [`### ${category}`, ...groups.get(category)].join('\n'))
    .join('\n\n');
  return [
    `## ${version} - ${date}`,
    '',
    body || '- Maintenance release.',
    '',
    '### Release Checks',
    '- Built from repository commits and packaged by the release workflow.',
    '- Marketplace and Open VSX publishing are handled by CI; Open VSX visibility may lag after publish succeeds.',
    ''
  ].join('\n');
}

function updateChangelog(changelogPath, section) {
  const title = '# Changelog\n\n';
  const current = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
  const withoutTitle = current.startsWith(title) ? current.slice(title.length) : current.replace(/^# Changelog\s*\n*/i, '');
  fs.writeFileSync(changelogPath, `${title}${section}\n${withoutTitle}`.trimEnd() + '\n', 'utf8');
}

const version = argValue('--version');
const from = argValue('--from');
const to = argValue('--to', 'HEAD');
const notesPath = argValue('--notes', '');
const changelogPath = argValue('--changelog', 'CHANGELOG.md');
const date = argValue('--date', new Date().toISOString().slice(0, 10));

if (!version) {
  console.error('Missing required --version argument.');
  process.exit(1);
}

const section = renderNotes(version, date, parseCommits(from, to));
if (notesPath) {
  fs.writeFileSync(notesPath, section, 'utf8');
}
updateChangelog(changelogPath, section);
console.log(`Generated release notes for ${version}`);

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { DiskDatabase } from './db/diskDatabase';

export interface DatabaseGenerationCutover {
  schemaVersion: 1;
  state: 'ready' | 'publishing-files' | 'files-published' | 'old-moved' | 'activated' | 'complete';
  generationId: string;
  candidateDir: string;
  databaseId: string;
  result: { projectId: string; locationId: string; identityPath: string; roadmapPath: string };
  hiddenIdentityPath: string;
  hiddenRoadmapPath: string;
  createdAt: number;
  publication?: { identityPreexisting: boolean; roadmapPreexisting: boolean };
  candidateProof?: DatabaseGenerationProof;
}

export interface DatabaseGenerationProof {
  device: string;
  inode: string;
  size: string;
  modifiedNs: string;
}

const journalName = 'database-generation-cutover.json';
const completedJournalName = 'cutover-complete.json';

export interface DatabaseGenerationReclaimEntry {
  generationId: string;
  directory: string;
  state: 'active' | 'complete' | 'orphaned';
  reclaimCandidate: boolean;
  safeInventory: boolean;
  directories: Array<{ path: string; device: string; inode: string; modifiedNs: string }>;
  files: Array<{ path: string; device: string; inode: string; size: string; modifiedNs: string }>;
}

export function readDatabaseGenerationReclaimManifest(rootInput: string): { activeGenerationId: string | null; entries: DatabaseGenerationReclaimEntry[] } {
  const root = path.resolve(rootInput), generationsRoot = path.join(root, 'database-generations');
  let activeGenerationId: string | null = null;
  try {
    const active = validate(root, JSON.parse(fs.readFileSync(path.join(root, journalName), 'utf8')) as DatabaseGenerationCutover);
    activeGenerationId = active.generationId;
  } catch { /* An absent or invalid journal cannot authorize reclaiming any referenced directory. */ }
  let names: string[] = [];
  try { names = fs.readdirSync(generationsRoot).filter(name => /^[a-f0-9-]{36}$/.test(name)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const entries = names.map(generationId => {
    const directory = path.join(generationsRoot, generationId);
    const directories: DatabaseGenerationReclaimEntry['directories'] = [];
    const files: DatabaseGenerationReclaimEntry['files'] = [];
    let safeInventory = true;
    const visit = (current: string): void => {
      for (const name of fs.readdirSync(current).sort()) {
        const target = path.join(current, name), stat = fs.lstatSync(target, { bigint: true });
        if (stat.isSymbolicLink()) { safeInventory = false; continue; }
        if (stat.isDirectory()) {
          directories.push({ path: target, device: String(stat.dev), inode: String(stat.ino), modifiedNs: String(stat.mtimeNs) });
          visit(target);
        }
        else if (stat.isFile()) files.push({ path: target, device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), modifiedNs: String(stat.mtimeNs) });
        else safeInventory = false;
      }
    };
    const rootStat = fs.lstatSync(directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) safeInventory = false;
    else visit(directory);
    let state: DatabaseGenerationReclaimEntry['state'] = generationId === activeGenerationId ? 'active' : 'orphaned';
    if (state !== 'active') {
      try {
        const completed = validate(root, JSON.parse(fs.readFileSync(path.join(directory, completedJournalName), 'utf8')) as DatabaseGenerationCutover);
        if (completed.generationId === generationId && completed.state === 'complete') state = 'complete';
      } catch { /* Orphaned generations remain visible but are never silently trusted as complete. */ }
    }
    return { generationId, directory, state, reclaimCandidate: state !== 'active' && safeInventory, safeInventory, directories, files };
  });
  return { activeGenerationId, entries };
}

export function reclaimDatabaseGeneration(rootInput: string, generationId: string): { generationId: string; files: number; bytes: number } {
  const root = path.resolve(rootInput);
  const manifest = readDatabaseGenerationReclaimManifest(root);
  const entry = manifest.entries.find(candidate => candidate.generationId === generationId);
  if (!entry || !entry.reclaimCandidate || !entry.safeInventory || manifest.activeGenerationId === generationId) {
    throw new Error('database_generation_reclaim_not_safe');
  }
  const directory = path.resolve(entry.directory);
  const generationsRoot = path.resolve(root, 'database-generations');
  if (path.dirname(directory) !== generationsRoot || path.basename(directory) !== generationId) {
    throw new Error('database_generation_reclaim_not_safe');
  }
  let bytes = 0;
  const directories = new Set<string>([directory]);
  for (const inventory of entry.directories) {
    const target = path.resolve(inventory.path);
    const relative = path.relative(directory, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('database_generation_reclaim_not_safe');
    const stat = fs.lstatSync(target, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || String(stat.dev) !== inventory.device || String(stat.ino) !== inventory.inode
      || String(stat.mtimeNs) !== inventory.modifiedNs) {
      throw new Error('database_generation_reclaim_changed');
    }
    directories.add(target);
  }
  for (const file of entry.files) {
    const target = path.resolve(file.path);
    const relative = path.relative(directory, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('database_generation_reclaim_not_safe');
    const stat = fs.lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()
      || String(stat.dev) !== file.device || String(stat.ino) !== file.inode
      || String(stat.size) !== file.size || String(stat.mtimeNs) !== file.modifiedNs) {
      throw new Error('database_generation_reclaim_changed');
    }
    bytes += Number(stat.size);
  }
  for (const file of entry.files) fs.unlinkSync(file.path);
  for (const target of [...directories].sort((a, b) => b.length - a.length)) {
    if (fs.readdirSync(target).length) throw new Error('database_generation_reclaim_changed');
    fs.rmdirSync(target);
  }
  syncDirectory(generationsRoot);
  return { generationId, files: entry.files.length, bytes };
}

export function reclaimOrphanedDatabaseGenerations(rootInput: string): Array<{ generationId: string; files: number; bytes: number }> {
  const root = path.resolve(rootInput);
  const generationIds = readDatabaseGenerationReclaimManifest(root).entries
    .filter(entry => entry.reclaimCandidate)
    .map(entry => entry.generationId);
  const reclaimed: Array<{ generationId: string; files: number; bytes: number }> = [];
  for (const generationId of generationIds) reclaimed.push(reclaimDatabaseGeneration(root, generationId));
  return reclaimed;
}

function digestFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeJournal(root: string, value: DatabaseGenerationCutover): void {
  const journal = path.join(root, journalName), temporary = `${journal}.next`;
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, journal);
  const parent = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

function archiveCompletedJournal(root: string, value: DatabaseGenerationCutover): void {
  const journal = path.join(root, journalName), archived = path.join(value.candidateDir, completedJournalName);
  if (!fs.existsSync(journal) || fs.existsSync(archived)) throw new Error('database_generation_archive_conflict');
  fs.renameSync(journal, archived);
  syncDirectory(root);
  syncDirectory(value.candidateDir);
}

function validate(root: string, value: DatabaseGenerationCutover): DatabaseGenerationCutover {
  const generations = path.resolve(root, 'database-generations'), candidateDir = path.resolve(String(value.candidateDir || ''));
  const relative = path.relative(generations, candidateDir);
  if (value.schemaVersion !== 1 || !['ready', 'publishing-files', 'files-published', 'old-moved', 'activated', 'complete'].includes(value.state)
    || !/^[a-f0-9-]{36}$/.test(value.generationId) || relative !== value.generationId
    || !value.databaseId || !value.result?.projectId
    || path.resolve(value.hiddenIdentityPath) !== path.join(candidateDir, 'project-files', '.solopreneur', 'project.json')
    || path.resolve(value.hiddenRoadmapPath) !== path.join(candidateDir, 'project-files', '.solopreneur', 'roadmap.csv')) throw new Error('database_generation_journal_invalid');
  return { ...value, candidateDir };
}

export function persistDatabaseGenerationCutover(root: string, value: DatabaseGenerationCutover): void {
  writeJournal(path.resolve(root), validate(path.resolve(root), value));
}

function verifyDatabase(file: string, expectedDatabaseId: string): void {
  const database = new DiskDatabase(file, { readOnly: true });
  try {
    const integrity = database.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0];
    const id = database.exec("SELECT value FROM database_meta WHERE key='database_id'")[0]?.values?.[0]?.[0];
    if (integrity !== 'ok' || id !== expectedDatabaseId || database.exec('PRAGMA foreign_key_check').some(result => result.values.length)) throw new Error('database_generation_invalid');
  } finally { database.close(); }
}

export function captureDatabaseGenerationProof(fileInput: string): DatabaseGenerationProof {
  const file = path.resolve(fileInput);
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('database_generation_invalid');
  return { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), modifiedNs: String(stat.mtimeNs) };
}

function verifyDatabaseGenerationProof(file: string, proof: DatabaseGenerationProof | undefined): void {
  if (!proof || JSON.stringify(captureDatabaseGenerationProof(file)) !== JSON.stringify(proof)) throw new Error('database_generation_proof_invalid');
}

export async function createDatabaseGenerationBaseline(sourceInput: string, destinationInput: string, expectedDatabaseId: string): Promise<void> {
  const source = path.resolve(sourceInput), destination = path.resolve(destinationInput);
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || fs.existsSync(destination)) throw new Error('database_generation_baseline_invalid');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const database = new DiskDatabase(source, { readOnly: true });
  try { await database.backup(destination); }
  finally { database.close(); }
  fs.chmodSync(destination, 0o600);
  verifyDatabase(destination, expectedDatabaseId);
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function resumeArtifactMove(source: string, destination: string, required: boolean): void {
  const sourceExists = fs.existsSync(source), destinationExists = fs.existsSync(destination);
  if (sourceExists && destinationExists) throw new Error('database_generation_artifact_conflict');
  if (sourceExists) fs.renameSync(source, destination);
  else if (required && !destinationExists) throw new Error('database_generation_artifact_missing');
}

function resumeDatabaseMove(source: string, destination: string): void {
  resumeArtifactMove(source, destination, true);
  for (const suffix of ['-wal', '-shm']) resumeArtifactMove(`${source}${suffix}`, `${destination}${suffix}`, false);
  syncDirectory(path.dirname(source));
  if (path.dirname(destination) !== path.dirname(source)) syncDirectory(path.dirname(destination));
}

function publishExact(source: string, destination: string): void {
  const targetRoot = path.dirname(path.dirname(destination));
  if (path.basename(path.dirname(destination)) !== '.solopreneur') throw new Error('database_generation_target_invalid');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(targetRoot), controlStat = fs.lstatSync(path.dirname(destination));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !controlStat.isDirectory() || controlStat.isSymbolicLink()
    || fs.realpathSync(targetRoot) !== targetRoot || fs.realpathSync(path.dirname(destination)) !== path.dirname(destination)) throw new Error('database_generation_target_invalid');
  try { fs.linkSync(source, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    else if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const target = fs.lstatSync(destination);
  if (!target.isFile() || target.isSymbolicLink() || digestFile(source) !== digestFile(destination)) throw new Error('database_generation_target_changed');
  const descriptor = fs.openSync(destination, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  syncDirectory(path.dirname(destination));
}

function preflightExact(source: string, destination: string): boolean {
  if (!fs.existsSync(destination)) return false;
  const target = fs.lstatSync(destination);
  if (!target.isFile() || target.isSymbolicLink() || digestFile(source) !== digestFile(destination)) throw new Error('database_generation_target_changed');
  return true;
}

function rollbackPublishedExact(source: string, destination: string, preexisting: boolean): void {
  if (preexisting || !fs.existsSync(destination)) return;
  const sourceStat = fs.lstatSync(source), target = fs.lstatSync(destination);
  if (!target.isFile() || target.isSymbolicLink() || digestFile(source) !== digestFile(destination)) return;
  if (sourceStat.dev === target.dev && sourceStat.ino === target.ino || digestFile(source) === digestFile(destination)) fs.unlinkSync(destination);
}

function publishProjectFiles(root: string, value: DatabaseGenerationCutover): DatabaseGenerationCutover {
  let current = value;
  if (current.state === 'ready') {
    const publication = {
      identityPreexisting: preflightExact(current.hiddenIdentityPath, current.result.identityPath),
      roadmapPreexisting: preflightExact(current.hiddenRoadmapPath, current.result.roadmapPath)
    };
    current = { ...current, state: 'publishing-files', publication };
    writeJournal(root, current);
  }
  const publication = current.publication;
  if (!publication) throw new Error('database_generation_journal_invalid');
  try {
    publishExact(current.hiddenIdentityPath, current.result.identityPath);
    publishExact(current.hiddenRoadmapPath, current.result.roadmapPath);
  } catch (error) {
    rollbackPublishedExact(current.hiddenRoadmapPath, current.result.roadmapPath, publication.roadmapPreexisting);
    rollbackPublishedExact(current.hiddenIdentityPath, current.result.identityPath, publication.identityPreexisting);
    current = { ...current, state: 'ready', publication: undefined };
    writeJournal(root, current);
    throw error;
  }
  current = { ...current, state: 'files-published' };
  writeJournal(root, current);
  return current;
}

export function recoverPendingDatabaseGenerationCutover(rootInput: string): DatabaseGenerationCutover | null {
  const root = path.resolve(rootInput), journal = path.join(root, journalName);
  if (!fs.existsSync(journal)) return null;
  let value = validate(root, JSON.parse(fs.readFileSync(journal, 'utf8')) as DatabaseGenerationCutover);
  if (value.state === 'complete') {
    if (value.candidateProof) verifyDatabaseGenerationProof(path.join(root, 'solomap.db'), value.candidateProof);
    else verifyDatabase(path.join(root, 'solomap.db'), value.databaseId);
    preflightExact(value.hiddenIdentityPath, value.result.identityPath);
    preflightExact(value.hiddenRoadmapPath, value.result.roadmapPath);
    archiveCompletedJournal(root, value);
    reclaimDatabaseGeneration(root, value.generationId);
    return value;
  }
  const active = path.join(root, 'solomap.db'), candidate = path.join(value.candidateDir, 'solomap.db'), previous = path.join(value.candidateDir, 'previous-solomap.db');
  if (value.state === 'ready') {
    if (value.candidateProof) verifyDatabaseGenerationProof(candidate, value.candidateProof);
    else verifyDatabase(candidate, value.databaseId);
    value = publishProjectFiles(root, value);
  }
  if (value.state === 'publishing-files') {
    value = publishProjectFiles(root, value);
  }
  if (value.state === 'files-published') {
    resumeDatabaseMove(active, previous);
    value = { ...value, state: 'old-moved' };
    writeJournal(root, value);
  }
  if (value.state === 'old-moved') {
    try {
      preflightExact(value.hiddenIdentityPath, value.result.identityPath);
      preflightExact(value.hiddenRoadmapPath, value.result.roadmapPath);
      publishExact(value.hiddenIdentityPath, value.result.identityPath);
      publishExact(value.hiddenRoadmapPath, value.result.roadmapPath);
    } catch (error) {
      if (fs.existsSync(previous)) {
        if (fs.existsSync(active) && !fs.existsSync(candidate)) resumeDatabaseMove(active, candidate);
        if (!fs.existsSync(active)) resumeDatabaseMove(previous, active);
        value = { ...value, state: 'ready' };
        writeJournal(root, value);
      }
      throw error;
    }
    resumeDatabaseMove(candidate, active);
    value = { ...value, state: 'activated' };
    writeJournal(root, value);
  }
  if (value.state === 'activated') {
    if (value.candidateProof) verifyDatabaseGenerationProof(active, value.candidateProof);
    else verifyDatabase(active, value.databaseId);
    value = { ...value, state: 'complete' };
    writeJournal(root, value);
    archiveCompletedJournal(root, value);
    reclaimDatabaseGeneration(root, value.generationId);
  }
  return value;
}

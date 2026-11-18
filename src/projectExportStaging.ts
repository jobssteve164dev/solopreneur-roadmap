import * as fs from 'fs';
import * as path from 'path';

interface OwnedStageFile { file: string; device: bigint; inode: bigint; size: bigint; modified: bigint; changed: bigint }

export function syncProjectExportStageDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function projectExportStageOwnerBytes(databaseId: string, ownerId: string): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, databaseId, ownerId }));
}

/** Retire only reserved files of a durably registered preparation, in bounded batches. */
export function cleanupProjectExportStageBatch(root: string, databaseId: string, stageDirectory: string, limit = 128): { pending: boolean; deletedFiles: number } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('database_maintenance_limit_invalid');
  const stagingRoot = path.resolve(root, '.solomap-maintenance-staging'), directory = path.resolve(stageDirectory);
  if (path.dirname(directory) !== stagingRoot || !/^project-export-[a-f0-9-]{36}$/.test(path.basename(directory))) throw new Error('project_export_staging_invalid');
  const inspectDirectory = (file: string): fs.BigIntStats | null => {
    let stat: fs.BigIntStats;
    try { stat = fs.lstatSync(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('project_export_staging_invalid');
    return stat;
  };
  if (!inspectDirectory(stagingRoot)) { syncProjectExportStageDirectory(fs.realpathSync(root)); return { pending: false, deletedFiles: 0 }; }
  const directoryProof = inspectDirectory(directory);
  if (!directoryProof) { syncProjectExportStageDirectory(stagingRoot); return { pending: false, deletedFiles: 0 }; }
  const capture = (file: string): OwnedStageFile => {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('project_export_staging_unknown_file');
    return { file, device: stat.dev, inode: stat.ino, size: stat.size, modified: stat.mtimeNs, changed: stat.ctimeNs };
  };
  let archive: OwnedStageFile | undefined, ownerMarker: OwnedStageFile | undefined, hasChunks = false;
  const top = fs.opendirSync(directory);
  try {
    for (let entry = top.readSync(); entry; entry = top.readSync()) {
      if (entry.name === 'owner.json') ownerMarker = capture(path.join(directory, entry.name));
      else if (entry.name === 'archive.stage') archive = capture(path.join(directory, entry.name));
      else if (entry.name === 'chunks') { inspectDirectory(path.join(directory, entry.name)); hasChunks = true; }
      else throw new Error('project_export_staging_unknown_file');
    }
  } finally { top.closeSync(); }
  const remove = (file: OwnedStageFile): void => {
    const parent = inspectDirectory(directory);
    if (!parent || parent.dev !== directoryProof.dev || parent.ino !== directoryProof.ino) throw new Error('project_export_staging_changed');
    const current = capture(file.file);
    if (current.device !== file.device || current.inode !== file.inode || current.size !== file.size || current.modified !== file.modified || current.changed !== file.changed) throw new Error('project_export_staging_changed');
    fs.unlinkSync(file.file);
  };
  const ownerId = path.basename(directory).slice('project-export-'.length);
  if (!ownerMarker) {
    if (archive || hasChunks) throw new Error('project_export_staging_owner_missing');
    fs.rmdirSync(directory); syncProjectExportStageDirectory(stagingRoot); return { pending: false, deletedFiles: 0 };
  }
  if (ownerMarker.size > 1024n) throw new Error('project_export_staging_owner_mismatch');
  const marker = fs.readFileSync(ownerMarker.file), expected = projectExportStageOwnerBytes(databaseId, ownerId);
  if (!marker.equals(expected)) {
    if (!archive && !hasChunks && marker.length < expected.length && marker.equals(expected.subarray(0, marker.length))) {
      remove(ownerMarker); fs.rmdirSync(directory); syncProjectExportStageDirectory(stagingRoot); return { pending: false, deletedFiles: 1 };
    }
    throw new Error('project_export_staging_owner_mismatch');
  }
  let deletedFiles = 0;
  if (hasChunks) {
    const chunks = path.join(directory, 'chunks'), selected: OwnedStageFile[] = [];
    let manifest: OwnedStageFile | undefined, complete = false;
    const handle = fs.opendirSync(chunks);
    try {
      while (selected.length < limit) {
        const entry = handle.readSync();
        if (!entry) { complete = true; break; }
        if (entry.name === 'manifest.json') manifest = capture(path.join(chunks, entry.name));
        else if (/^\d{8}\.chunk$/.test(entry.name)) selected.push(capture(path.join(chunks, entry.name)));
        else throw new Error('project_export_staging_unknown_file');
      }
    } finally { handle.closeSync(); }
    for (const file of selected) { remove(file); deletedFiles++; }
    if (!complete || manifest && deletedFiles === limit) { syncProjectExportStageDirectory(chunks); return { pending: true, deletedFiles }; }
    if (manifest) { remove(manifest); deletedFiles++; }
    fs.rmdirSync(chunks);
    syncProjectExportStageDirectory(directory);
  }
  if (archive) {
    if (deletedFiles === limit) { syncProjectExportStageDirectory(directory); return { pending: true, deletedFiles }; }
    remove(archive); deletedFiles++;
  }
  if (deletedFiles === limit) { syncProjectExportStageDirectory(directory); return { pending: true, deletedFiles }; }
  remove(ownerMarker); deletedFiles++;
  fs.rmdirSync(directory);
  syncProjectExportStageDirectory(stagingRoot);
  return { pending: false, deletedFiles };
}

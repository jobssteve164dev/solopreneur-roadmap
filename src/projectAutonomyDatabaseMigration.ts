import * as fs from 'fs';
import * as path from 'path';

import { UnifiedDataStore } from './db/unifiedDataStore';
import type { MemoryImportOptions, MemoryImportResult } from './memoryDatabaseMigration';

import { isMaintenanceComputeExit,ProjectMigrationInspectionUnavailable,type ProjectMigrationInspectionResult } from './projectMigrationInspection.js';

type Candidate=ProjectMigrationInspectionResult<'autonomyFile'>['candidates'][number] & {sourceKey:string;sourceHash:string};

/** Historical authorization files are consumed only by the explicit Runtime migration queue. */
export async function importProjectAutonomyAuthorizations(
  store: UnifiedDataStore,
  sourceRoot: string,
  options: MemoryImportOptions = {}
): Promise<MemoryImportResult> {
  if (path.resolve(sourceRoot) !== path.resolve(store.root)) throw new Error('project_autonomy_migration_scope_invalid');
  const identity = options.sourceIdentity || `project-autonomy:${store.root}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, retainedFiles: [], conflicts: [] };
  const candidates = new Map<string, Candidate>();
  const sourceConflicts = new Set<string>();
  const conflict = (key: string, error: unknown) => {
    if(error instanceof ProjectMigrationInspectionUnavailable || isMaintenanceComputeExit(error))throw error;
    const message = error instanceof Error ? error.message : String(error);
    sourceConflicts.add(key);
    result.conflicts.push({ source: key, error: message });
    store.markMigrationSourceConflict(identity, key, message);
  };

  const capture=async(file:string,key:string,projectId?:string)=>{
    const captured=await store.inspectProjectMigration({kind:'autonomyFile',file,key,projectId});
    await store.publishMigrationSource({identity,key,hash:captured.hash},captured.bytes,{mimeType:'application/json',encoding:'utf8',pending:true});
    result.originalBytes+=captured.bytes.byteLength;
    result.retainedFiles.push(key);
    for(const value of captured.candidates)candidates.set(value.projectId,{...value,sourceKey:key,sourceHash:captured.hash});
    for(const failure of captured.conflicts){conflict(failure.key,failure.error);sourceConflicts.add(key);}
  };

  const combinedKey='runtime/project-autonomy-authorizations.json';
  try{await capture(path.join(sourceRoot,combinedKey),combinedKey);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')conflict(combinedKey,error);}

  const recordsRoot = path.join(sourceRoot, 'runtime', 'project-autonomy-authorizations');
  try {
    for (const entry of (await fs.promises.readdir(recordsRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
      const key = `runtime/project-autonomy-authorizations/${entry.name}`;
      try{await capture(path.join(recordsRoot,entry.name),key,entry.name.slice(0,-'.json'.length));}
      catch(error){conflict(key,error);}
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') conflict('runtime/project-autonomy-authorizations/', error);
  }

  for (const candidate of candidates.values()) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    try {
      const {sourceKey:_sourceKey,sourceHash,...value}=candidate;
      if(await store.publishLegacyProjectAutonomySetting(candidate.projectId,value,sourceHash))result.imported++;
      else result.unchanged++;
      options.onProgress?.(result);
    } catch (error) { conflict(`${candidate.sourceKey}#${candidate.projectId}`, error); sourceConflicts.add(candidate.sourceKey); }
  }
  for (const key of new Set(result.retainedFiles)) {
    if (sourceConflicts.has(key)) store.markMigrationSourceConflict(identity, key, 'project_autonomy_entry_conflict');
    else store.markMigrationSourceImported(identity, key);
  }
  return result;
}

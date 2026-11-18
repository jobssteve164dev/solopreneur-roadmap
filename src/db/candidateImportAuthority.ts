import * as fs from 'fs';
import * as path from 'path';

const candidateImport: unique symbol = Symbol('candidate_import_authority');
export interface CandidateImportAuthority { readonly [candidateImport]: true }
interface BoundCandidate {
  sourceRoot: string; candidateRoot: string; databaseId: string;
  directoryDevice: string; directoryInode: string; fileDevice: string; fileInode: string;
}
const issued = new WeakMap<CandidateImportAuthority, BoundCandidate>();

export function bindCandidateImportAuthority(input: {
  sourceRoot: string; candidateRoot: string; databaseId: string; directoryDevice: string; directoryInode: string;
}): CandidateImportAuthority {
  const sourceRoot=path.resolve(input.sourceRoot),candidateRoot=path.resolve(input.candidateRoot);
  const relative=path.relative(path.join(sourceRoot,'database-generations'),candidateRoot);
  if(!/^[a-f0-9-]{36}$/.test(relative) || candidateRoot===sourceRoot)throw new Error('project_import_candidate_required');
  const directory=fs.lstatSync(candidateRoot,{bigint:true}),file=fs.lstatSync(path.join(candidateRoot,'solomap.db'),{bigint:true});
  if(!directory.isDirectory() || directory.isSymbolicLink() || String(directory.dev)!==input.directoryDevice || String(directory.ino)!==input.directoryInode
    || !file.isFile() || file.isSymbolicLink() || file.nlink>1n)throw new Error('project_import_candidate_changed');
  const sourceFile=fs.statSync(path.join(sourceRoot,'solomap.db'),{bigint:true});
  if(file.ino!==0n && file.dev===sourceFile.dev && file.ino===sourceFile.ino)throw new Error('project_import_candidate_required');
  const token: CandidateImportAuthority=Object.freeze({[candidateImport]:true as const});
  issued.set(token,{sourceRoot,candidateRoot,databaseId:input.databaseId,directoryDevice:input.directoryDevice,directoryInode:input.directoryInode,fileDevice:String(file.dev),fileInode:String(file.ino)});
  return token;
}

export function assertCandidateImportAuthority(token: CandidateImportAuthority, candidateRoot: string, databaseId: string, sourceRoot?: string): void {
  const bound=issued.get(token);
  if(!bound || path.resolve(candidateRoot)!==bound.candidateRoot || databaseId!==bound.databaseId || sourceRoot!==undefined && path.resolve(sourceRoot)!==bound.sourceRoot)throw new Error('project_import_candidate_required');
  const directory=fs.lstatSync(bound.candidateRoot,{bigint:true}),file=fs.lstatSync(path.join(bound.candidateRoot,'solomap.db'),{bigint:true});
  if(!directory.isDirectory() || directory.isSymbolicLink() || String(directory.dev)!==bound.directoryDevice || String(directory.ino)!==bound.directoryInode
    || !file.isFile() || file.isSymbolicLink() || file.nlink>1n || String(file.dev)!==bound.fileDevice || String(file.ino)!==bound.fileInode)throw new Error('project_import_candidate_changed');
}

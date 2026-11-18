import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { prepareContentPublication, type PreparedContentPublication, type UnifiedDataStore } from './db/unifiedDataStore.js';

export interface RunInputIdentity { projectId: string; executionLogId: number; generation: number }
export interface RunInputFileEntry {
  path: string; sha256: string; size: number; written: boolean; runId: string; contentId: string; exitProof: string | null; state: 'active' | 'released';
}
export interface RunInputFileProof {
  device: string; inode: string; size: number; mtimeNs: string; ctimeNs: string; sha256: string;
}
export interface RunInputFileRequest {
  identity: RunInputIdentity; entry: RunInputFileEntry;
  action: 'materialize' | 'inspect' | 'remove' | 'prepare_observed'; proof?: RunInputFileProof;
}
export interface RunInputFileResult {
  absent?: boolean; partial?: boolean; proof?: RunInputFileProof; publication?: PreparedContentPublication;
  directorySyncSupported?: boolean;
}

function sameFile(stat: fs.BigIntStats, proof: Omit<RunInputFileProof,'sha256'>, renamed=false): boolean {
  return String(stat.dev)===proof.device && String(stat.ino)===proof.inode && Number(stat.size)===proof.size
    && String(stat.mtimeNs)===proof.mtimeNs && (renamed || String(stat.ctimeNs)===proof.ctimeNs);
}
function exists(file: string): boolean {
  try{fs.lstatSync(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
function openDirectory(directory: string, unsupported: ()=>void): {path: string; stat: fs.BigIntStats; assert: ()=>void; sync: ()=>void; close: ()=>void} {
  const before=fs.lstatSync(directory,{bigint:true});
  if(!before.isDirectory() || before.isSymbolicLink())throw new Error('run_input_file_conflict');
  let descriptor: number | undefined;
  try{descriptor=fs.openSync(directory,fs.constants.O_RDONLY|(fs.constants.O_DIRECTORY || 0)|(fs.constants.O_NOFOLLOW || 0));}
  catch(error){if(process.platform!=='win32' || !['EPERM','EISDIR','EACCES'].includes(String((error as NodeJS.ErrnoException).code)))throw error;unsupported();}
  const assert=():void=>{
    const current=fs.lstatSync(directory,{bigint:true});
    if(!current.isDirectory() || current.isSymbolicLink() || current.dev!==before.dev || current.ino!==before.ino)throw new Error('run_input_file_conflict');
  };
  try{assert();if(descriptor!==undefined){const opened=fs.fstatSync(descriptor,{bigint:true});if(opened.dev!==before.dev || opened.ino!==before.ino)throw new Error('run_input_file_conflict');}}
  catch(error){if(descriptor!==undefined)fs.closeSync(descriptor);throw error;}
  return {path:descriptor!==undefined && process.platform==='linux'?`/proc/self/fd/${descriptor}`:descriptor!==undefined && process.platform==='darwin'?`/dev/fd/${descriptor}`:directory,
    stat:before,assert,sync:()=>{
      if(descriptor===undefined){unsupported();return;}
      try{fs.fsyncSync(descriptor);}catch(error){if(process.platform!=='win32' || !['EPERM','EISDIR','EACCES','EINVAL','EBADF','ENOTSUP'].includes(String((error as NodeJS.ErrnoException).code)))throw error;unsupported();}
    },close:()=>{if(descriptor!==undefined){fs.closeSync(descriptor);descriptor=undefined;}}};
}
function writeAll(fd: number, bytes: Buffer): void {
  let offset=0;
  while(offset<bytes.length){const count=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(!count)throw new Error('run_input_file_write_failed');offset+=count;}
}

/** Only called in the existing Maintenance Compute worker. */
export function computeRunInputFile(store: UnifiedDataStore, request: RunInputFileRequest): RunInputFileResult {
  const current=store.readRunInputFileEntry(request.identity),entry=request.entry;
  if(!current || (Object.keys(entry) as Array<keyof RunInputFileEntry>).some(key=>entry[key]!==current[key])) throw new Error('run_input_changed');
  if(entry.state==='released' && (!entry.exitProof || !['inspect','remove'].includes(request.action)))throw new Error('run_input_released');
  let directorySyncSupported=true;
  const unsupported=():void=>{directorySyncSupported=false;};
  const reply=(result: RunInputFileResult):RunInputFileResult=>({...result,directorySyncSupported});
  const temporaryRoot=path.join(store.root,'tmp');
  const prefix=`run-input-${entry.runId}-${request.identity.generation}-`;
  if(path.dirname(entry.path)!==temporaryRoot || !path.basename(entry.path).startsWith(prefix)
    || !/^[a-f0-9-]{36}\.txt$/.test(path.basename(entry.path).slice(prefix.length))) throw new Error('run_input_file_conflict');
  if(request.action==='materialize') fs.mkdirSync(temporaryRoot,{recursive:true,mode:0o700});
  let parent: ReturnType<typeof openDirectory>;
  try {
    if(fs.realpathSync(temporaryRoot)!==path.join(fs.realpathSync(store.root),'tmp'))throw new Error('run_input_file_conflict');
    parent=openDirectory(temporaryRoot,unsupported);
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT' && request.action!=='materialize'){
      const authority=openDirectory(store.root,unsupported);try{authority.sync();}finally{authority.close();}
      return reply({absent:true});
    }
    throw error;
  }
  let exit: ReturnType<typeof openDirectory> | undefined;
  const source=path.join(parent.path,path.basename(entry.path)),exitPath=source+'.exit';
  try {
    const saved=entry.exitProof?JSON.parse(entry.exitProof) as RunInputFileProof:undefined;
    if(request.action==='materialize' && (saved || exists(exitPath)))throw new Error('run_input_releasing');
    if(exists(exitPath)){
      if(!saved)throw new Error('run_input_file_conflict');
      exit=openDirectory(exitPath,unsupported);
      if(fs.readdirSync(exit.path).some(name=>name!=='input'))throw new Error('run_input_file_conflict');
    }
    const finishDirectory=():void=>{
      if(exit){exit.assert();if(fs.readdirSync(exit.path).length)throw new Error('run_input_file_conflict');exit.close();exit=undefined;fs.rmdirSync(exitPath);}
      parent.assert();parent.sync();
    };
    const held=exit?path.join(exit.path,'input'):undefined;
    if(exists(source) && held && exists(held))throw new Error('run_input_file_conflict');
    const isHeld=Boolean(held && exists(held));
    let file=isHeld?held!:source;
  if(request.action==='materialize'){
    let fd: number | undefined;
    try {
      fd=fs.openSync(source,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      store.streamContentForMaintenance(entry.contentId,bytes=>writeAll(fd!,bytes),entry.sha256,entry.size);
      fs.fsyncSync(fd);
      parent.assert();parent.sync();
    } catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; }
    finally { if(fd!==undefined)fs.closeSync(fd); }
  }
  let fd: number | undefined;
  try { fd=fs.openSync(file,(request.action==='materialize' && process.platform==='win32'?fs.constants.O_RDWR:fs.constants.O_RDONLY)|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK); }
  catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT' && request.action!=='materialize'){finishDirectory();return reply({absent:true});}
    if((error as NodeJS.ErrnoException).code==='ELOOP')throw new Error('run_input_file_conflict');
    throw error;
  }
  try {
    const stat=fs.fstatSync(fd,{bigint:true}),size=Number(stat.size);
    if(!stat.isFile() || !Number.isSafeInteger(size) || size<0 || size>entry.size
      || (entry.written || request.action==='materialize') && size!==entry.size) throw new Error('run_input_file_conflict');
    const identity={device:String(stat.dev),inode:String(stat.ino),size,mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)};
    if(request.proof && !sameFile(stat,request.proof))throw new Error('run_input_file_conflict');
    if(saved && !sameFile(stat,saved,isHeld))throw new Error('run_input_file_conflict');
    const hash=crypto.createHash('sha256');
    const buffer=Buffer.allocUnsafe(65536);let observedOffset=0;
    const parts: Buffer[] | undefined=request.action==='prepare_observed'?[]:undefined;
    const observe=(length: number,intended?: Buffer):void=>{
      if(length<=0)return;
      let read=0;
      while(read<length){const count=fs.readSync(fd!,buffer,read,length-read,observedOffset+read);if(!count)throw new Error('run_input_file_conflict');read+=count;}
      const observed=buffer.subarray(0,length);
      if(intended && !observed.equals(intended.subarray(0,length)))throw new Error('run_input_file_conflict');
      hash.update(observed);parts?.push(Buffer.from(observed));observedOffset+=length;
    };
    if(size<entry.size && !request.proof && !saved){
      store.streamContentForMaintenance(entry.contentId,intended=>observe(Math.min(intended.length,size-observedOffset),intended),entry.sha256,entry.size);
    }else while(observedOffset<size)observe(Math.min(buffer.length,size-observedOffset));
    const proof={...identity,sha256:hash.digest('hex')};
    if(observedOffset!==size || request.proof && proof.sha256!==request.proof.sha256 || saved && proof.sha256!==saved.sha256
      || !sameFile(fs.fstatSync(fd,{bigint:true}),proof) || !sameFile(fs.lstatSync(file,{bigint:true}),proof))throw new Error('run_input_file_conflict');
    parent.assert();exit?.assert();
    if(size===entry.size && proof.sha256!==entry.sha256)throw new Error('run_input_file_conflict');
    if(request.action==='remove'){
      if(!request.proof || !saved)throw new Error('run_input_file_proof_required');
      if(!isHeld){
        if(!exit){fs.mkdirSync(exitPath,{mode:0o700});exit=openDirectory(exitPath,unsupported);parent.sync();}
        const destination=path.join(exit.path,'input');
        if(exists(destination))throw new Error('run_input_file_conflict');
        fs.renameSync(source,destination);
        const moved=fs.lstatSync(destination,{bigint:true});
        if(!sameFile(moved,proof,true)){
          // A raced-in file is never deleted. Restore without overwriting a new source.
          try{fs.linkSync(destination,source);fs.unlinkSync(destination);exit.sync();parent.sync();}catch{}
          throw new Error('run_input_file_conflict');
        }
        exit.sync();parent.assert();parent.sync();file=destination;
      }
      if(!sameFile(fs.lstatSync(file,{bigint:true}),proof,true) || !sameFile(fs.fstatSync(fd,{bigint:true}),proof,true))throw new Error('run_input_file_conflict');
      const sealed=fs.fstatSync(fd,{bigint:true}),sealedHash=crypto.createHash('sha256');
      let offset=0;
      while(offset<size){const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,size-offset),offset);if(!count)throw new Error('run_input_file_conflict');sealedHash.update(buffer.subarray(0,count));offset+=count;}
      const sealedProof={...proof,ctimeNs:String(sealed.ctimeNs)};
      if(sealedHash.digest('hex')!==proof.sha256 || !sameFile(fs.fstatSync(fd,{bigint:true}),sealedProof) || !sameFile(fs.lstatSync(file,{bigint:true}),sealedProof))throw new Error('run_input_file_conflict');
      fs.closeSync(fd);fd=undefined;
      fs.unlinkSync(file);exit!.sync();
      if(exists(source))throw new Error('run_input_file_conflict');
      finishDirectory();
      return reply({proof});
    }
    if(request.action==='prepare_observed'){
      if(!request.proof || size>=entry.size || entry.written)throw new Error('run_input_file_conflict');
      return reply({proof,partial:true,publication:prepareContentPublication({bytes:Buffer.concat(parts!),mimeType:'application/octet-stream',encoding:'binary',expectedSha256:proof.sha256})});
    }
    if(request.action==='materialize'){
      fs.fsyncSync(fd);parent.assert();parent.sync();
      const authority=openDirectory(store.root,unsupported);try{authority.sync();}finally{authority.close();}
    }
    return reply({proof,partial:size<entry.size});
  } finally { if(fd!==undefined)fs.closeSync(fd); }
  } finally {exit?.close();parent.close();}
}

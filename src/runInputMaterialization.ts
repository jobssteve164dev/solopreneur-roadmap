import { UnifiedDataStore } from './db/unifiedDataStore.js';
import type { RunInputIdentity } from './runInputFile.js';

type Identity = RunInputIdentity;

export class RunInputMaterialization {
  constructor(private readonly store: UnifiedDataStore) {}
  public async materialize(identity: Identity): Promise<{ path: string; sha256: string; size: number }> {
    return this.store.withRunInputFileLock(identity,async()=>{
      this.store.localizeRunInputFileRegistration(identity);
      const entry = this.store.reserveRunInputMaterialization(identity.projectId, identity.executionLogId, identity.generation);
      await this.store.computeRunInputFile(identity,'materialize');
      this.store.markRunInputWritten(identity.projectId, identity.executionLogId, identity.generation);
      return entry;
    });
  }
  public async release(identity: Identity): Promise<void> {
    return this.releaseRegistered(identity);
  }
  private releaseRegistered(identity: Identity, receipt=false): Promise<void> {
    return this.store.withRunInputFileLock(identity,async()=>{
      const entry = this.store.localizeRunInputFileRegistration(identity);
      if (!entry || entry.state==='released' && (!receipt || !entry.exitProof)) return;
      const observed=await this.store.computeRunInputFile(identity,'inspect');
      let directorySyncSupported=observed.directorySyncSupported===true;
      if(!observed.absent){
        if(!observed.proof)throw new Error('run_input_file_proof_required');
        if(observed.partial && !entry.exitProof && entry.state==='active')await this.store.publishObservedRunInput(identity,observed.proof);
        this.store.beginRunInputFileCleanup(identity,observed.proof);
        const removed=await this.store.computeRunInputFile(identity,'remove',observed.proof);
        directorySyncSupported=removed.directorySyncSupported===true;
      }
      this.store.releaseRunInputMaterialization(identity.projectId, identity.executionLogId, identity.generation,!directorySyncSupported);
    });
  }
  public async recover(): Promise<void> {
    const errors: unknown[] = [];
    let receipts: ReturnType<UnifiedDataStore['prepareRunInputReceiptRecoveryBatch']>=[];
    try{receipts=this.store.prepareRunInputReceiptRecoveryBatch();}catch(error){errors.push(error);}
    let cursor: number | null = 0;
    do {
      const page = this.store.listRunInputMaterializations(cursor);
      for (const entry of page.items) {
        try {
          if (this.store.runInputMaterializationNeedsRecovery(entry)) await this.release(entry);
        } catch (error) { errors.push(error); }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    for(const receipt of receipts)if(receipt.exitProof){
      try{await this.releaseRegistered(receipt,true);}catch(error){
        if(!['run_input_file_conflict','run_input_changed','run_input_missing','run_missing','run_input_released','run_input_releasing'].includes((error as Error).message)){
          try{this.store.deferRunInputReceiptRecovery(receipt);}catch(deferError){errors.push(deferError);}
        }
        errors.push(error);
      }
    }
    if (errors.length) throw Object.assign(new Error(errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')), { errors });
  }
}

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type PiEntryType = 'message' | 'compaction' | 'branch_summary' | 'custom';
export interface PiEntry {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
  type: PiEntryType;
  customType?: string;
  [key: string]: any;
}
export interface PiValue<T> { kind: 'value'; namespace: string; key: string }
export interface PiValueList<T> { kind: 'list'; namespace: string; key: string }
export interface PiStoredValue<T> { address: PiValue<T>; value: T; seq: number }
export interface PiListElement<T> { seq: number; value: T }
export interface PiListReadOptions { cursor?: { seq: number }; order?: 'asc' | 'desc'; limit?: number }
export interface PiUsageRow { id: string; seq: number; usage: PiUsage; entryId?: string; adjustment: boolean; details?: unknown }
export interface PiSessionStats { messageCount: number; usage: PiUsage }
export interface PiEntryScan { type?: PiEntryType; customType?: string; fromSeq?: number; toSeq?: number; order?: 'asc' | 'desc'; limit?: number }
export interface PiUsageScan { fromSeq?: number; toSeq?: number; order?: 'asc' | 'desc'; limit?: number }
export interface PiBranchScan {
  start: string; stopAtType?: PiEntryType; stopAtId?: string; type?: PiEntryType; customType?: string;
  order?: 'newestFirst' | 'oldestFirst'; limit?: number; cursor?: { seq: number };
}
export interface PiEntryStructure { id: string; parentId: string | null; seq: number; timestamp: number; type: PiEntryType; customType?: string }
export type PiWrite =
  | { kind: 'entry'; entry: Omit<PiEntry, 'seq' | 'timestamp'> }
  | { kind: 'usage'; row: Omit<PiUsageRow, 'seq'> }
  | { kind: 'value'; op: 'set'; namespace: string; key: string; value: unknown }
  | { kind: 'value'; op: 'delete'; namespace: string; key: string }
  | { kind: 'list'; op: 'append'; namespace: string; key: string; value: unknown }
  | { kind: 'list'; op: 'delete'; namespace: string; key: string };
export interface PiCommitResult { firstSeq: number; seqs: number[]; timestamp: number; stats: PiSessionStats }

export interface PiSessionStorage {
  readonly metadata?: { id: string; createdAt: number; storageVersion: number; cwd?: string; parentSessionId?: string; legacyParentSessionPath?: string };
  commit(writes: PiWrite[], context?: unknown): Promise<PiCommitResult>;
  getEntries(ids: string[], context?: unknown): Promise<Map<string, PiEntry>>;
  getValue<T>(address: PiValue<T>, context?: unknown): Promise<PiStoredValue<T> | undefined>;
  scanValues<T>(prefix: PiValue<T>, context?: unknown): Promise<PiStoredValue<T>[]>;
  readList<T>(address: PiValueList<T>, options?: PiListReadOptions, context?: unknown): Promise<PiListElement<T>[]>;
  scanBranch(query: PiBranchScan, context?: unknown): Promise<PiEntry[]>;
  scanBranchStructure(query: PiBranchScan, context?: unknown): Promise<PiEntryStructure[]>;
  scanEntries(query: PiEntryScan, context?: unknown): Promise<PiEntry[]>;
  scanUsage(query: PiUsageScan, context?: unknown): Promise<PiUsageRow[]>;
  getStats(context?: unknown): Promise<PiSessionStats>;
  close(context?: unknown): Promise<void>;
}

import type { DataWriteDatabaseIdentity, PreparedMutationReplay } from './dataWritePublication.js';
import type { SqlValue } from './diskDatabase.js';
import type { DataObject, DataWrite } from './unifiedDataStore.js';

export interface HostSettingsPatch {
  namespace: string;
  ownerScope: string;
  patches: Array<{ key: string; expectedRevision: number; value?: unknown; secretRef?: string }>;
  secretState?: { secretRef: string; fingerprint: string; expectedRevision: number };
  todaySourceGuard?: import('../todayDecisionInputs.js').TodaySourceGuard;
  todayFeedback?: Record<string, unknown>;
  idempotencyKey: string;
}

export interface HostSettingsQuery {
  namespace: string;
  ownerScope: string;
  secretStateRef?: string;
  keys?: string[];
}

export interface HostSettingsResult {
  items: Array<{ key: string; objectId: string; revision: number; value?: unknown; secretRef?: string }>;
  secretState?: { fingerprint: string; revision: number };
}

type Failure = { name: string; message: string; code?: string };
export interface TodayProjectReadFact {
  root: string;
  physicalRoot?: string;
  pathFailure?: Failure;
  projectId?: string | null;
  roadmapRevision?: string;
}
export interface PreparedTodaySourceGuard {
  failure?: Failure;
  roots: TodayProjectReadFact[];
  learning: Array<{ scope: string; revision: number | null }>;
}
export interface HostSettingWritePreparation {
  input: DataWrite;
  inputHash: string;
  objectId: string;
  oldContent?: string;
  revision?: number;
  projectId?: string | null;
}
export interface PreparedTodayFeedback {
  roots: TodayProjectReadFact[];
  failure?: Failure;
  eventFailure?: Failure;
  event?: HostSettingWritePreparation;
  project?: { id: string; revision: number };
}
export interface PreparedHostSettings {
  inputHash: string;
  replay?: PreparedMutationReplay;
  replayFailure?: Failure;
  todayGuard?: PreparedTodaySourceGuard;
  todayFeedback?: PreparedTodayFeedback;
  children: Array<HostSettingWritePreparation & { key: string }>;
}

export type HostSettingsPreparation = DataWriteDatabaseIdentity & { actorId: string; input: HostSettingsPatch; telegramPrevious?:DataObject[] };
export type HostSettingsProjection = DataWriteDatabaseIdentity & { rows: Array<Record<string, SqlValue>>; secretStateJson?: string };
export interface ProjectedHostSettings {
  result: HostSettingsResult;
  serialized: string;
}

export interface HostSecretStateMigration {
  namespace: string;
  ownerScope: string;
  legacyKey: string;
  expectedRevision: number;
  secretRef: string;
  fingerprint: string;
  idempotencyKey: string;
}

export type HostSecretMigrationPreparation = DataWriteDatabaseIdentity & { actorId: string; input: HostSecretStateMigration };
export interface PreparedHostSecretMigration extends Pick<PreparedHostSettings, 'inputHash' | 'replay' | 'replayFailure'> {
  metaKey: string;
  metaValue: string;
  archive?: DataWrite;
  legacyFailure?: Failure;
}

export interface LegacyTelegramRuntimeState {
  config?: {identity:string;key:string;hash:string;value:Record<string,unknown> & {botTokenSecretRef?:string;botTokenFingerprint?:string};pending:boolean};
  state?: {identity:string;key:string;hash:string;value:Record<string,unknown>};
}
export type LegacyTelegramStartupPreparation=DataWriteDatabaseIdentity & {input:LegacyTelegramRuntimeState} & (
  {phase:'config'} | {phase:'state';compatible:boolean;previous:DataObject[]}
);
export interface PreparedLegacyTelegramStartup {
  empty?:boolean;
  compatible?:boolean;
  conflict?:boolean;
  patch?:HostSettingsPatch;
  failure?:Failure;
}

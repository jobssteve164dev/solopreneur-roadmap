import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { persistTelegramRuntimeSecret, telegramBotTokenSecretRef } from './telegramRuntimeConfig';

import { UnifiedDataStore } from './db/unifiedDataStore';
import { isMaintenanceComputeExit, ProjectMigrationInspectionUnavailable, retryMaintenanceComputeExit } from './projectMigrationInspection.js';

type JsonRecord = Record<string, unknown>;

type LegacyRuntimeSource = {identity:string;key:string;hash:string;value:JsonRecord;token?:string;unchanged:boolean};

async function capture(store:UnifiedDataStore,root:string,file:string,mode:'json'|'telegram-config'|'telegram-state'):Promise<LegacyRuntimeSource|null> {
  const captured=await store.inspectProjectMigration({kind:'runtimeStateFile',file,mode,secretRef:telegramBotTokenSecretRef});
  if(!captured)return null;
  const identity=`runtime-state:${root}`,key=path.relative(root,file).split(path.sep).join('/');
  const source={identity,key,hash:captured.hash};
  const existing=store.migrationSourceState(identity,key);
  if(captured.error!==undefined){
    if(existing?.hash!==captured.hash || existing.stage!=='conflict'){
      await store.captureLegacyConfigurationSource(source,captured.bytes,{pending:true});
      store.markMigrationSourceConflict(identity,key,captured.error);
    }
    return null;
  }
  const unchanged=existing?.hash===captured.hash && existing.stage==='imported';
  if(!unchanged)await store.captureLegacyConfigurationSource(source,captured.bytes,{pending:true});
  return {...source,value:captured.value!,token:captured.token,unchanged};
}

function recordUnavailableSource(store: UnifiedDataStore, root: string, file: string, error: unknown): void {
  const key = path.relative(root, file).split(path.sep).join('/');
  const message = error instanceof Error ? error.message : String(error);
  try {
    store.appendDiagnosticEvent({
      kind: 'error', occurredAt: new Date().toISOString(), scope: 'runtime.migration',
      payload: { source: key, error: message },
      idempotencyKey: `runtime-migration-source-unavailable:${key}:${crypto.createHash('sha256').update(message).digest('hex')}`
    });
  } catch {
    // A legacy source must never prevent the current database from starting.
  }
}

async function captureAvailable(store:UnifiedDataStore,root:string,file:string,mode:'json'|'telegram-config'|'telegram-state'='json'):Promise<LegacyRuntimeSource|null> {
  try{return await capture(store,root,file,mode);}
  catch(error){
    if(error instanceof ProjectMigrationInspectionUnavailable || isMaintenanceComputeExit(error))throw error;
    recordUnavailableSource(store,root,file,error);return null;
  }
}

async function importSettings(store:UnifiedDataStore,source:LegacyRuntimeSource,namespace:string,values:JsonRecord):Promise<void> {
  if(!source.unchanged)await store.publishLegacyHostSettings({source,namespace,values});
}

async function importLegacyScheduleFile(store: UnifiedDataStore, root: string, file: string): Promise<void> {
  const scheduled = await captureAvailable(store, root, file);
  if (!scheduled || scheduled.unchanged) return;
  const tasks = Array.isArray(scheduled.value.tasks) ? scheduled.value.tasks as JsonRecord[] : [];
  const failures = Array.isArray(scheduled.value.failures) ? scheduled.value.failures as JsonRecord[] : [];
  const records = [...tasks.map(value => ({ value, state: 'pending' as const })), ...failures.map(value => ({ value, state: 'failed' as const }))]
    .filter(item => item.value.task && typeof item.value.task === 'object' && item.value.occurrenceId && item.value.taskId && Number.isFinite(Date.parse(String(item.value.dueAt || ''))));
  await store.publishLegacyScheduleImport({ source: scheduled,
    schedules: records.map(({ value }) => ({ id: String(value.taskId), timezone: 'UTC', trigger: { kind: (value.task as JsonRecord).scheduleKind === 'once' ? 'once' : 'daily', timeOfDay: String((value.task as JsonRecord).timeOfDay || ''), scheduledAt: String((value.task as JsonRecord).scheduledAt || '') }, enabled: (value.task as JsonRecord).enabled !== false, nextDueAt: Date.parse(String(value.dueAt)), task: value.task as JsonRecord })),
    records: records.map(({ value, state }) => ({ scheduleId: String(value.taskId), occurrenceKey: `${String(value.taskId)}@${Date.parse(String(value.dueAt))}`, dueAt: Date.parse(String(value.retryAt || value.dueAt)), attempts: Math.max(0, Number(value.attempts || 0)), state, task: value.task as JsonRecord })) });
}

async function importLegacyTelegramSources(store:UnifiedDataStore,root:string,runtime:string):Promise<void> {
  for(;;){
    const telegram=await captureAvailable(store,root,path.join(runtime,'telegram-config.json'),'telegram-config');
    const telegramState=await captureAvailable(store,root,path.join(runtime,'telegram-state.json'),'telegram-state');
    const state=telegramState?.value || {};
    const legacyTelegramToken=telegram?.token || '';
    const telegramValues = telegram ? {
      enabled: telegram.value.enabled === true,
      ...(legacyTelegramToken ? { botTokenSecretRef: telegramBotTokenSecretRef } : {}),
      ...(legacyTelegramToken ? { botTokenFingerprint: String(telegram.value.botTokenFingerprint || '') } : {}),
      chatId: String(telegram.value.chatId || ''),
      selectedProjectPath: String(telegram.value.selectedProjectPath || ''),
      language: telegram.value.language === 'en' ? 'en' : 'zh',
      bindingGeneration: Number(telegram.value.bindingGeneration || state.bindingGeneration || 0),
      replyGeneration: Number(telegram.value.replyGeneration ?? telegram.value.bindingGeneration ?? state.bindingGeneration ?? 0),
      conversationIds: telegram.value.conversationIds && typeof telegram.value.conversationIds === 'object' ? telegram.value.conversationIds : state.conversationIds && typeof state.conversationIds === 'object' ? state.conversationIds : {},
      offset: Number(state.offset || 0)
    } : {};
    try{
      await store.publishLegacyTelegramRuntimeState({
        ...(telegram ? { config: { identity: telegram.identity, key: telegram.key, hash: telegram.hash, value: telegramValues, pending: !telegram.unchanged } } : {}),
        ...(telegramState && !telegramState.unchanged ? { state: { identity: telegramState.identity, key: telegramState.key, hash: telegramState.hash, value: telegramState.value } } : {})
      },legacyTelegramToken?()=>persistTelegramRuntimeSecret(root,telegramBotTokenSecretRef,legacyTelegramToken):undefined);
      return;
    }catch(error){if(!(error instanceof ProjectMigrationInspectionUnavailable) || error.message!=='legacy_telegram_source_changed')throw error;}
  }
}

export function importLegacyRuntimeState(store: UnifiedDataStore, globalDataPath: string): Promise<void> {
  return retryMaintenanceComputeExit(()=>importLegacyRuntimeSources(store,globalDataPath));
}

async function importLegacyRuntimeSources(store:UnifiedDataStore,globalDataPath:string):Promise<void> {
  const root = path.resolve(globalDataPath);
  const runtime = path.join(root, 'runtime');
  const cognitive = await captureAvailable(store, root, path.join(runtime, 'cognitive-config.json'));
  if (cognitive) await importSettings(store, cognitive, 'cognitive', {
    mode: cognitive.value.mode === 'agent_cli' ? 'agent_cli' : 'local_only',
    agentCli: String(cognitive.value.agentCli || ''),
    model: String(cognitive.value.model || 'auto')
  });
  await importLegacyTelegramSources(store,root,runtime);

  const runtimeSchedule = path.join(runtime, 'scheduled-tasks', 'scheduled-tasks.json');
  const oldestSchedule = path.join(root, 'scheduled-tasks', 'scheduled-tasks.json');
  let runtimeScheduleExists = false;
  try { fs.lstatSync(runtimeSchedule); runtimeScheduleExists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') runtimeScheduleExists = true; }
  await importLegacyScheduleFile(store, root, runtimeScheduleExists ? runtimeSchedule : oldestSchedule);
  if (runtimeScheduleExists) {
    const superseded = await captureAvailable(store, root, oldestSchedule);
    if (superseded && !superseded.unchanged) store.markMigrationSourceConflict(superseded.identity, superseded.key, 'superseded_runtime_source');
  }

  for (const [name, key] of [['today-shadow.json', 'decision'], ['shadow-evaluation.json', 'evaluation']] as const) {
    const source = await captureAvailable(store, root, path.join(runtime, name));
    if (source) await importSettings(store, source, 'runtime_shadow', { [key]: source.value });
  }
  const feedbackFile = path.join(runtime, 'shadow-feedback.jsonl');
  try {
    const captured=await store.inspectProjectMigration({kind:'runtimeStateFile',file:feedbackFile,mode:'jsonl'});
    if(captured){
      const source={identity:`runtime-state:${root}`,key:'runtime/shadow-feedback.jsonl',hash:captured.hash};
      const existing=store.migrationSourceState(source.identity,source.key);
      if(!(existing?.hash===source.hash && existing.stage==='imported')){
        await store.captureLegacyConfigurationSource(source,captured.bytes,{mimeType:'application/x-ndjson',pending:true});
        try{
          if(captured.error!==undefined)throw new Error(captured.error);
          await store.publishLegacyHostSettings({source,namespace:'runtime_shadow',values:{feedback:captured.feedback}});
        }catch(error){
          if(error instanceof ProjectMigrationInspectionUnavailable || isMaintenanceComputeExit(error))throw error;
          store.markMigrationSourceConflict(source.identity,source.key,error instanceof Error?error.message:String(error));
        }
      }
    }
  } catch (error) {
    if(error instanceof ProjectMigrationInspectionUnavailable || isMaintenanceComputeExit(error))throw error;
    if((error as NodeJS.ErrnoException).code!=='ENOENT')recordUnavailableSource(store,root,feedbackFile,error);
  }

  const oldRuntime = await captureAvailable(store, root, path.join(runtime, 'state.json'));
  if (oldRuntime && !oldRuntime.unchanged) store.markMigrationSourceImported(oldRuntime.identity, oldRuntime.key);
}

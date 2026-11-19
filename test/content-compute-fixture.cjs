const {legacyReviewRequestForTransfer,restoreLegacyReviewResult}=require('../out/db/legacyReviewBatchPublication.js');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const connections = new Set();
require('node:test').after(async () => { for (const close of connections) await close(); });

async function connectContentCompute(store, createWorker = (filename, options) => new Worker(filename, options)) {
  const worker = createWorker(path.resolve(__dirname, '../out/maintenanceComputeWorker.js'), { workerData: { root: store.root, databaseId: store.databaseId } });
  const pending = new Map(); let sequence = 0;
  const ready = once(worker, 'message');
  worker.on('message', message => {
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(Object.assign(new Error(message.error), message.errorCode ? { code: message.errorCode } : {}));
    else entry.resolve(message.result);
  });
  worker.on('error', error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); });
  try { await ready; } catch (error) { await worker.terminate(); throw error; }
  const rpc = (operation, input) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); worker.postMessage({ id, operation, ...input });
  });
  let closing;
  const close = () => {
    closing ||= worker.terminate().finally(() => connections.delete(close));
    return closing;
  };
  connections.add(close);
  const connection = { prepareAgentLaunchArtifacts:value=>rpc('prepare_agent_launch_artifacts',{value}),selectAgentLaunch:value=>rpc('select_agent_launch',{value}),prepareAgentLaunchStep:value=>rpc('prepare_agent_launch_step',{value}),prepareRunControl:value=>rpc('prepare_run_control',{value}),prepareRunDeliveryStart:value=>rpc('prepare_run_delivery_start',{value}),prepareRunDocument:value=>rpc('prepare_run_document',{value}),planRunDocument:value=>rpc('plan_run_document',{value}),prepareRunReport:value=>rpc('prepare_run_report',{value}),prepareRunLog:value=>rpc('prepare_run_log',{value}),projectRunReportResult:value=>rpc('project_run_report_result',{value}), selectFlowRole:value=>rpc('select_flow_role',{value}), selectRunAllocation:value=>rpc('select_run_allocation',{value}), prepare: input => rpc('prepare_content_publication', { input }), verify: value => rpc('verify_content_publication',{value}), prepareWrite: value=>rpc('prepare_data_write',{value}), searchWrite: value=>rpc('prepare_data_write_search',{value}), writeReferences: value=>rpc('prepare_data_write_references',{value}), runInputFile: value => rpc('run_input_file',{value}), prepareRunInputs:value=>rpc('prepare_run_inputs',{value}), planRunInputs:value=>rpc('plan_run_inputs',{value}), resultRunInputs:value=>rpc('project_run_inputs_result',{value}), prepareRunCreation:value=>rpc('prepare_run_creation',{value}), planRunCreation:value=>rpc('plan_run_creation',{value}), storageReference:limit=>rpc('prepare_storage_reference_batch',{limit}), storageCold:limit=>rpc('prepare_storage_cold_batch',{limit}), storageGc:limit=>rpc('prepare_storage_gc_batch',{limit}), storageOutputs:limit=>rpc('prepare_storage_run_output_batch',{limit}), storageRepair:searchObjectIds=>rpc('prepare_storage_repair_batch',{searchObjectIds}), retirementPage:value=>rpc('prepare_project_retirement_page',{value}), retirementQualify:value=>rpc('qualify_project_retirement',{value}), close };
  Object.assign(connection,{inspectRunCheckpoint:value=>rpc('inspect_run_checkpoint',{value}),prepareRunCheckpoint:value=>rpc('prepare_run_checkpoint',{value}),planRunCheckpoint:value=>rpc('plan_run_checkpoint',{value})});
  Object.assign(connection,{prepareRunContext:value=>rpc('prepare_run_context',{value}),prepareCurrentRunCheckpoint:value=>rpc('prepare_current_run_checkpoint',{value}),prepareRunTaskIngress:value=>rpc('prepare_run_task_ingress',{value})});
  Object.assign(connection,{prepareRunNativeRows:value=>rpc('prepare_run_native_rows',{value}),releaseRunNativeRows:value=>rpc('release_run_native_rows',{value}),prepareRunObserverDocument:value=>rpc('prepare_run_observer_document',{value}),prepareRunDocumentValue:value=>rpc('prepare_run_document_value',{value})});
  Object.assign(connection,{prepareLink:value=>rpc('prepare_link',{value})});
  Object.assign(connection,{prepareMcpMutationAuthorization:value=>rpc('prepare_mcp_mutation_authorization',{value})});
  Object.assign(connection,{prepareRunNative:value=>rpc('prepare_run_native',{value})});
  Object.assign(connection,{prepareRunTurnRequest:value=>rpc('prepare_run_turn_request',{value}),qualifyRunTurnRequest:value=>rpc('qualify_run_turn_request',{value})});
  Object.assign(connection,{inspectRunOutput:value=>rpc('inspect_run_output',{value}),prepareRunOutput:value=>rpc('prepare_run_output',{value}),planRunOutput:value=>rpc('plan_run_output',{value})});
  Object.assign(connection,{prepareRunConsumerClaim:value=>rpc('prepare_run_consumer_claim',{value})});
  Object.assign(connection,{prepareRunVerification:value=>rpc('prepare_run_verification',{value})});
  Object.assign(connection,{rpcReviewPreparationResult:value=>rpc('project_learning_review_preparation_result',{value}),prepareReviewEntry:value=>rpc('prepare_learning_review_entry',{value}),beginReviewPreparation:value=>rpc('begin_learning_review_preparation',{value}),advanceReviewPreparation:value=>rpc('advance_learning_review_preparation',{value}),releaseReviewPreparation:value=>rpc('release_learning_review_preparation',{value})});
  Object.assign(connection,{beginReviewSource:value=>rpc('begin_learning_review_source_capture',{value}),pageReviewSource:value=>rpc('capture_learning_review_source_page',{value}),peekReviewSource:value=>rpc('peek_learning_review_source_capture',{value}),consumeReviewSource:value=>rpc('consume_learning_review_source_capture',{value}),releaseReviewSource:value=>rpc('release_learning_review_source_capture',{value})});
  Object.assign(connection,{prepareGlobalPromptSave:value=>rpc('prepare_global_prompt_save',{value}),prepareGlobalPromptOverrides:value=>rpc('prepare_global_prompt_overrides',{value}),prepareGlobalPromptSupersede:value=>rpc('prepare_global_prompt_supersede',{value})});
  Object.assign(connection,{prepareExternalMemoryMutation:value=>rpc('prepare_external_memory_mutation',{value})});
  Object.assign(connection,{prepareLearningCycle:value=>rpc('prepare_learning_cycle',{value})});
  Object.assign(connection,{prepareLearningReviewFinish:value=>rpc('prepare_learning_review_finish',{value})});
  Object.assign(connection,{prepareLearningReviewInterrupt:value=>rpc('prepare_learning_review_interrupt',{value})});
  Object.assign(connection,{prepareLearningReviewApply:value=>rpc('prepare_learning_review_apply',{value}),qualifyLearningReviewApply:value=>rpc('qualify_learning_review_apply',{value}),prepareLearningReviewApplyRecovery:value=>rpc('prepare_learning_review_apply_recovery',{value}),projectLearningReviewApplyResult:value=>rpc('project_learning_review_apply_result',{value})});
  Object.assign(connection,{prepareDiagnosticEvent:value=>rpc('prepare_diagnostic_event',{value})});
  Object.assign(connection,{prepareImportObject:value=>rpc('prepare_import_object',{value})});
  Object.assign(connection,{prepareArchiveSource:value=>rpc('prepare_archive_source',{value})});
  Object.assign(connection,{prepareDirectGrowth:value=>rpc('prepare_direct_growth',{value})});
  Object.assign(connection,{prepareLegacyReviewBatch:value=>rpc('prepare_legacy_review_batch',{value:legacyReviewRequestForTransfer(value)}).then(restoreLegacyReviewResult)});
  Object.assign(connection,{prepareLessonSource:value=>rpc('prepare_lesson_source',{value})});
  Object.assign(connection,{prepareRegisteredReportTask:value=>rpc('prepare_registered_report_task',{value})});
  Object.assign(connection,{prepareRegisteredReport:value=>rpc('prepare_registered_report',{value})});
  Object.assign(connection,{prepareHistoricalRunAdoptionInput:value=>rpc('prepare_historical_run_adoption_input',{value})});
  Object.assign(connection,{prepareHistoricalRunIdentity:value=>rpc('prepare_historical_run_identity',{value})});
  Object.assign(connection,{prepareHistoricalRunTask:value=>rpc('prepare_historical_run_task',{value})});
  Object.assign(connection,{prepareHistoricalRunSources:value=>rpc('prepare_historical_run_sources',{value})});
  Object.assign(connection,{prepareHistoricalRunExisting:value=>rpc('prepare_historical_run_existing',{value})});
  Object.assign(connection,{inspectProjectMigration:value=>rpc('inspect_project_migration_source',{value})});
  Object.assign(connection,{prepareHostSettings:value=>rpc('prepare_host_settings',{value}),projectHostSettings:value=>rpc('project_host_settings',{value})});
  Object.assign(connection,{prepareScheduleSync:value=>rpc('prepare_schedule_sync',{value})});
  Object.assign(connection,{prepareHistoricalRunRootSelection:value=>rpc('prepare_historical_run_root_selection',{value})});
  Object.assign(connection,{prepareHistoricalRunRootTurn:value=>rpc('prepare_historical_run_root_turn',{value})});
  Object.assign(connection,{prepareHistoricalRunRootMetadata:value=>rpc('prepare_historical_run_root_metadata',{value}),planHistoricalRunRootBody:value=>rpc('plan_historical_run_root_body',{value})});
  Object.assign(connection,{prepareHistoricalRunRootNode:value=>rpc('prepare_historical_run_root_node',{value})});
  Object.assign(connection,{prepareHistoricalRunRootDocument:value=>rpc('prepare_historical_run_root_document',{value}),prepareHistoricalRunRootFinalMetadata:value=>rpc('prepare_historical_run_root_final_metadata',{value}),projectHistoricalRunRoot:value=>rpc('project_historical_run_root',{value})});
  Object.assign(connection,{prepareLearningDecisionSource:value=>rpc('prepare_learning_decision_source',{value})});
  Object.assign(connection,{prepareLearningEventSource:value=>rpc('prepare_learning_event_source',{value})});
  Object.assign(connection,{prepareLegacyReviewCursor:value=>rpc('prepare_legacy_review_cursor',{value})});
  Object.assign(connection,{prepareStateWrite:value=>rpc('prepare_state_write',{value})});
  Object.assign(connection,{captureGrowthStage:value=>rpc('capture_growth_stage',{value})});
  Object.assign(connection,{prepareStepMemoryImport:value=>rpc('prepare_step_memory_import',{value}),planStepMemoryImportSource:value=>rpc('plan_step_memory_import_source',{value})});
  Object.assign(connection,{prepareStepMemory:value=>rpc('prepare_step_memory',{value}),prepareStepMemoryBody:value=>rpc('prepare_step_memory_body',{value}),planStepMemory:value=>rpc('plan_step_memory',{value}),projectStepMemoryResult:value=>rpc('project_step_memory_result',{value})});
  Object.assign(connection,{prepareRunSettlement:value=>rpc('prepare_run_settlement',{value}),prepareRunSettlementPayload:value=>rpc('prepare_run_settlement_payload',{value}),prepareRunSettlementDigest:value=>rpc('prepare_run_settlement_digest',{value}),prepareRunSettlementDocumentation:value=>rpc('prepare_run_settlement_documentation',{value}),prepareRunSettlementLearning:value=>rpc('prepare_run_settlement_learning',{value}),prepareRunSettlementStep:value=>rpc('prepare_run_settlement_step',{value}),planRunSettlementStep:value=>rpc('plan_run_settlement_step',{value}),prepareRunSettlementJournals:value=>rpc('prepare_run_settlement_journals',{value}),prepareRunSettlementTail:value=>rpc('prepare_run_settlement_tail',{value}),prepareRunSettlementNotification:value=>rpc('prepare_run_settlement_notification',{value})});
  return {...connection,prepareFlowTrace:value=>rpc('prepare_flow_trace_publication',{value}),planFlowTrace:value=>rpc('plan_flow_trace_publication',{value})};
}
exports.attachContentCompute = async function attachContentCompute(store) {
  const connection = await connectContentCompute(store);
  store.setContentPreparationCompute(connection.prepare);
  store.setContentVerificationCompute(connection.verify);
  store.setDataWriteCompute({prepare:connection.prepareWrite,search:connection.searchWrite,references:connection.writeReferences});
  store.setLinkCompute(connection.prepareLink);
  store.setMcpMutationAuthorizationCompute(connection.prepareMcpMutationAuthorization);
  store.setRunNativeCompute(connection.prepareRunNative);
  store.setRunTurnRequestCompute({prepare:connection.prepareRunTurnRequest,qualify:connection.qualifyRunTurnRequest});
  store.setRunInputFileCompute(connection.runInputFile);
  store.setRunInputsCompute({prepare:connection.prepareRunInputs,plan:connection.planRunInputs,result:connection.resultRunInputs});
  store.setRunCreationCompute({prepare:connection.prepareRunCreation,plan:connection.planRunCreation});
  store.setImportObjectCompute(connection.prepareImportObject);
  store.setArchiveSourceCompute(connection.prepareArchiveSource);
  store.setDirectGrowthCompute(connection.prepareDirectGrowth);
  store.setLegacyReviewBatchCompute(connection.prepareLegacyReviewBatch);
  store.setLessonSourceCompute(connection.prepareLessonSource);
  store.setRegisteredReportTaskCompute(connection.prepareRegisteredReportTask);
  store.setRegisteredReportCompute(connection.prepareRegisteredReport);
  store.setHistoricalRunAdoptionInputCompute(connection.prepareHistoricalRunAdoptionInput);
  store.setHistoricalRunIdentityCompute(connection.prepareHistoricalRunIdentity);
  store.setHistoricalRunTaskCompute(connection.prepareHistoricalRunTask);
  store.setHistoricalRunSourcesCompute(connection.prepareHistoricalRunSources);
  store.setHistoricalRunExistingCompute(connection.prepareHistoricalRunExisting);
  store.setProjectMigrationInspectionCompute(connection.inspectProjectMigration);
  store.setScheduleSyncCompute(connection.prepareScheduleSync);
  store.setHostSettingsCompute({prepare:connection.prepareHostSettings,project:connection.projectHostSettings});
  store.setHistoricalRunRootSelectionCompute(connection.prepareHistoricalRunRootSelection);
  store.setHistoricalRunRootTurnCompute(connection.prepareHistoricalRunRootTurn);
  store.setHistoricalRunRootMetadataCompute(connection.prepareHistoricalRunRootMetadata);
  store.setHistoricalRunRootBodyCompute(connection.planHistoricalRunRootBody);
  store.setHistoricalRunRootNodeCompute(connection.prepareHistoricalRunRootNode);
  store.setHistoricalRunRootDocumentCompute(connection.prepareHistoricalRunRootDocument);
  store.setHistoricalRunRootFinalMetadataCompute(connection.prepareHistoricalRunRootFinalMetadata);
  store.setHistoricalRunRootProjectionCompute(connection.projectHistoricalRunRoot);
  store.setLearningDecisionSourceCompute(connection.prepareLearningDecisionSource);
  store.setLearningEventSourceCompute(connection.prepareLearningEventSource);
  store.setLegacyReviewCursorCompute(connection.prepareLegacyReviewCursor);
  store.setStateWriteCompute(connection.prepareStateWrite);
  store.setGrowthStageCapture(connection.captureGrowthStage);
  store.setStepMemoryImportCompute({prepare:connection.prepareStepMemoryImport,source:connection.planStepMemoryImportSource});
  store.setStepMemoryCompute({prepareStepMemory:connection.prepareStepMemory,prepareStepMemoryBody:connection.prepareStepMemoryBody,planStepMemory:connection.planStepMemory,projectStepMemoryResult:connection.projectStepMemoryResult});
  store.setRunAllocationCompute(connection.selectRunAllocation);
  store.setFlowRoleCompute(connection.selectFlowRole);
  store.setRunControlCompute(connection.prepareRunControl);
  store.setRunDeliveryStartCompute(connection.prepareRunDeliveryStart);
  store.setRunDocumentCompute({prepare:connection.prepareRunDocument,plan:connection.planRunDocument});
  store.setRunCheckpointCompute({inspect:connection.inspectRunCheckpoint,prepare:connection.prepareRunCheckpoint,plan:connection.planRunCheckpoint});
  store.setRunOutputCompute({inspect:connection.inspectRunOutput,prepare:connection.prepareRunOutput,plan:connection.planRunOutput});
  store.setRunConsumerClaimCompute(connection.prepareRunConsumerClaim);
  store.setRunVerificationCompute(connection.prepareRunVerification);
  store.setLearningReviewPrepareCompute({entry:connection.prepareReviewEntry,begin:connection.beginReviewPreparation,advance:connection.advanceReviewPreparation,release:connection.releaseReviewPreparation,result:value=>connection.rpcReviewPreparationResult(value)});
  store.setLearningReviewSourceCompute({begin:connection.beginReviewSource,page:connection.pageReviewSource,peek:connection.peekReviewSource,consume:connection.consumeReviewSource,release:connection.releaseReviewSource});
  store.setGlobalPromptCompute({prepare:connection.prepareGlobalPromptSave,overrides:connection.prepareGlobalPromptOverrides,supersede:connection.prepareGlobalPromptSupersede});
  store.setExternalMemoryCompute(connection.prepareExternalMemoryMutation);
  store.setLearningCycleCompute(connection.prepareLearningCycle);
  store.setLearningReviewFinishCompute(connection.prepareLearningReviewFinish);
  store.setLearningReviewInterruptCompute(connection.prepareLearningReviewInterrupt);
  store.setLearningReviewApplyCompute({prepare:connection.prepareLearningReviewApply,qualify:connection.qualifyLearningReviewApply,recovery:connection.prepareLearningReviewApplyRecovery,result:connection.projectLearningReviewApplyResult});
  store.setDiagnosticCompute(connection.prepareDiagnosticEvent);
  store.setRunSettlementCompute({prepare:connection.prepareRunSettlement,payload:connection.prepareRunSettlementPayload,digest:connection.prepareRunSettlementDigest,documentation:connection.prepareRunSettlementDocumentation,learning:connection.prepareRunSettlementLearning,step:connection.prepareRunSettlementStep,stepPlan:connection.planRunSettlementStep,journals:connection.prepareRunSettlementJournals,tail:connection.prepareRunSettlementTail,notification:connection.prepareRunSettlementNotification});
  store.setRunContextCompute({context:connection.prepareRunContext,checkpoint:connection.prepareCurrentRunCheckpoint,ingress:connection.prepareRunTaskIngress});
  store.setRunObserverCompute({rows:connection.prepareRunNativeRows,release:connection.releaseRunNativeRows,document:connection.prepareRunObserverDocument,value:connection.prepareRunDocumentValue});
  store.setRunReportCompute(connection.prepareRunReport);
  store.setRunLogCompute(connection.prepareRunLog);
  store.setRunReportResultCompute(connection.projectRunReportResult);
  store.setAgentLaunchCompute({select:connection.selectAgentLaunch,step:connection.prepareAgentLaunchStep,artifacts:connection.prepareAgentLaunchArtifacts});
  store.setFlowTraceCompute({prepare:connection.prepareFlowTrace,plan:connection.planFlowTrace});
  store.setStorageLifecycleCompute({prepareStorageReferenceBatch:connection.storageReference,prepareStorageColdBatch:connection.storageCold,prepareStorageGcBatch:connection.storageGc,prepareStorageRunOutputBatch:connection.storageOutputs,prepareStorageRepairBatch:connection.storageRepair,prepareProjectRetirementPage:connection.retirementPage,qualifyProjectRetirement:connection.retirementQualify});
  return connection.close;
};
exports.attachLazyContentCompute = function attachLazyContentCompute(store, createWorker) {
  const openContentCompute = source => connectContentCompute(source, createWorker);
  let connection;
  store.setContentPreparationCompute(input => {
    connection ||= openContentCompute(store);
    return connection.then(compute => compute.prepare(input));
  });
  store.setRunInputFileCompute(input=>{
    connection ||= openContentCompute(store);
    return connection.then(compute=>compute.runInputFile(input));
  });
  store.setContentVerificationCompute(input=>{
    connection ||= openContentCompute(store);
    return connection.then(compute=>compute.verify(input));
  });
  store.setDataWriteCompute({prepare:input=>{
    connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareWrite(input));
  },search:input=>{
    connection ||= openContentCompute(store);return connection.then(compute=>compute.searchWrite(input));
  },references:input=>{
    connection ||= openContentCompute(store);return connection.then(compute=>compute.writeReferences(input));
  }});
  store.setLinkCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareLink(input));});
  store.setMcpMutationAuthorizationCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareMcpMutationAuthorization(input));});
  store.setRunNativeCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunNative(input));});
  store.setRunTurnRequestCompute({prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunTurnRequest(input));},qualify:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.qualifyRunTurnRequest(input));}});
  store.setRunInputsCompute({prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunInputs(input));},
    plan:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.planRunInputs(input));},
    result:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.resultRunInputs(input));}});
  store.setImportObjectCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareImportObject(input));});
  store.setArchiveSourceCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareArchiveSource(input));});
  store.setDirectGrowthCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareDirectGrowth(input));});
  store.setLegacyReviewBatchCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareLegacyReviewBatch(input));});
  store.setLessonSourceCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareLessonSource(input));});
  store.setRegisteredReportTaskCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRegisteredReportTask(input));});
  store.setRegisteredReportCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRegisteredReport(input));});
  store.setHistoricalRunAdoptionInputCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHistoricalRunAdoptionInput(input));});
  store.setHistoricalRunIdentityCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHistoricalRunIdentity(input));});
  store.setHistoricalRunTaskCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHistoricalRunTask(input));});
  store.setHistoricalRunSourcesCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHistoricalRunSources(input));});
  store.setHistoricalRunExistingCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHistoricalRunExisting(input));});
  store.setProjectMigrationInspectionCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.inspectProjectMigration(input));});
  store.setScheduleSyncCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareScheduleSync(input));});
  store.setHostSettingsCompute({
    prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHostSettings(input));},
    project:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.projectHostSettings(input));}
  });
  store.setHistoricalRunRootSelectionCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHistoricalRunRootSelection(input));});
  store.setHistoricalRunRootTurnCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHistoricalRunRootTurn(input));});
  store.setHistoricalRunRootMetadataCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHistoricalRunRootMetadata(input));});
  store.setHistoricalRunRootBodyCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.planHistoricalRunRootBody(input));});
  store.setHistoricalRunRootNodeCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHistoricalRunRootNode(input));});
  store.setHistoricalRunRootDocumentCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHistoricalRunRootDocument(input));});
  store.setHistoricalRunRootFinalMetadataCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareHistoricalRunRootFinalMetadata(input));});
  store.setHistoricalRunRootProjectionCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.projectHistoricalRunRoot(input));});
  store.setLearningDecisionSourceCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareLearningDecisionSource(input));});
  store.setLearningEventSourceCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareLearningEventSource(input));});
  store.setLegacyReviewCursorCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareLegacyReviewCursor(input));});
  store.setStateWriteCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareStateWrite(input));});
  store.setGrowthStageCapture(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.captureGrowthStage(input));});
  store.setStepMemoryImportCompute({prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareStepMemoryImport(input));},source:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.planStepMemoryImportSource(input));}});
  store.setStepMemoryCompute({prepareStepMemory:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareStepMemory(input));},prepareStepMemoryBody:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareStepMemoryBody(input));},planStepMemory:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.planStepMemory(input));},projectStepMemoryResult:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.projectStepMemoryResult(input));}});
  store.setRunCreationCompute({prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunCreation(input));},
    plan:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.planRunCreation(input));}});
  store.setAgentLaunchCompute({artifacts:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareAgentLaunchArtifacts(input));},select:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.selectAgentLaunch(input));},step:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareAgentLaunchStep(input));}});
  store.setRunControlCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunControl(input));});
  store.setRunDeliveryStartCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunDeliveryStart(input));});
  store.setRunDocumentCompute({prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunDocument(input));},plan:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.planRunDocument(input));}});
  store.setRunCheckpointCompute({inspect:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.inspectRunCheckpoint(input));},prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunCheckpoint(input));},plan:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.planRunCheckpoint(input));}});
  store.setRunOutputCompute({inspect:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.inspectRunOutput(input));},prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunOutput(input));},plan:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.planRunOutput(input));}});
  store.setRunConsumerClaimCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunConsumerClaim(input));});
  store.setRunVerificationCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunVerification(input));});
  store.setLearningReviewPrepareCompute(Object.fromEntries([['entry','prepareReviewEntry'],['begin','beginReviewPreparation'],['advance','advanceReviewPreparation'],['release','releaseReviewPreparation'],['result','rpcReviewPreparationResult']].map(([key,method])=>[key,input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute[method](input));}])));
  store.setLearningReviewSourceCompute(Object.fromEntries([['begin','beginReviewSource'],['page','pageReviewSource'],['peek','peekReviewSource'],['consume','consumeReviewSource'],['release','releaseReviewSource']].map(([key,method])=>[key,input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute[method](input));}])));
  store.setGlobalPromptCompute({prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareGlobalPromptSave(input));},overrides:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareGlobalPromptOverrides(input));},supersede:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareGlobalPromptSupersede(input));}});
  store.setExternalMemoryCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareExternalMemoryMutation(input));});
  store.setLearningCycleCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareLearningCycle(input));});
  store.setLearningReviewFinishCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareLearningReviewFinish(input));});
  store.setLearningReviewInterruptCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareLearningReviewInterrupt(input));});
  store.setLearningReviewApplyCompute({prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareLearningReviewApply(input));},qualify:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.qualifyLearningReviewApply(input));},recovery:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareLearningReviewApplyRecovery(input));},result:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.projectLearningReviewApplyResult(input));}});
  store.setDiagnosticCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareDiagnosticEvent(input));});
  store.setRunSettlementCompute({prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunSettlement(input));},payload:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunSettlementPayload(input));},digest:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunSettlementDigest(input));},documentation:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunSettlementDocumentation(input));},learning:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunSettlementLearning(input));},step:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunSettlementStep(input));},stepPlan:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.planRunSettlementStep(input));},journals:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunSettlementJournals(input));},tail:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunSettlementTail(input));},notification:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunSettlementNotification(input));}});
  store.setRunContextCompute({context:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunContext(input));},checkpoint:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareCurrentRunCheckpoint(input));},ingress:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunTaskIngress(input));}});
  store.setRunObserverCompute({rows:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunNativeRows(input));},release:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.releaseRunNativeRows(input));},document:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunObserverDocument(input));},value:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunDocumentValue(input));}});
  store.setRunReportCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunReport(input));});
  store.setRunLogCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareRunLog(input));});
  store.setRunReportResultCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.projectRunReportResult(input));});
  store.setFlowRoleCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.selectFlowRole(input));});
  store.setRunAllocationCompute(input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.selectRunAllocation(input));});
  store.setFlowTraceCompute({prepare:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.prepareFlowTrace(input));},
    plan:input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute.planFlowTrace(input));}});
  const storage=method=>input=>{connection ||= openContentCompute(store);return connection.then(compute=>compute[method](input));};
  store.setStorageLifecycleCompute({prepareStorageReferenceBatch:storage('storageReference'),prepareStorageColdBatch:storage('storageCold'),prepareStorageGcBatch:storage('storageGc'),prepareStorageRunOutputBatch:storage('storageOutputs'),prepareStorageRepairBatch:storage('storageRepair'),prepareProjectRetirementPage:storage('retirementPage'),qualifyProjectRetirement:storage('retirementQualify')});
  return async () => { if (connection) await (await connection).close(); };
};

exports.ContentComputeDataStore = class ContentComputeDataStore extends require('../out/db/unifiedDataStore.js').UnifiedDataStore {
  constructor(...args) {
    super(...args);
    const closeCompute = exports.attachLazyContentCompute(this), close = this.close.bind(this);
    this.close = () => { close(); void closeCompute(); };
  }
};

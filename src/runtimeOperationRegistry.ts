export type RuntimeExecutionDomain =
  | 'foreground-command'
  | 'interactive-query'
  | 'background-query'
  | 'external-job'
  | 'maintenance';

export type RuntimeExecutorAffinity =
  | 'writer-actor'
  | 'supervisor'
  | 'interactive-reader'
  | 'background-reader'
  | 'external-worker'
  | 'maintenance-worker';

export type RuntimeOperationKind = 'command' | 'query' | 'job';
export type RuntimeReplayPolicy = 'safe' | 'idempotency-key' | 'open-request-id' | 'never';
export type RuntimeAuthority = 'stateless' | 'writer-session' | 'runtime-memory';

export interface RuntimeOperationDefinition {
  readonly operation: string;
  readonly domain: RuntimeExecutionDomain;
  readonly kind: RuntimeOperationKind;
  readonly executor: RuntimeExecutorAffinity;
  readonly replay: RuntimeReplayPolicy;
  readonly authority: RuntimeAuthority;
}

const foregroundCommands = [
  'accept_inbox_message', 'accept_roadmap_csv', 'acknowledge_inbox_message',
  'append_automation_event', 'append_diagnostic_event', 'append_project_journal', 'append_run_log',
  'apply_learning_review', 'attach_capability_operation', 'begin_automation_delivery',
  'begin_capability_operation', 'begin_inbox_action', 'begin_legacy_intelligence_operation',
  'begin_notification_delivery', 'cancel_intelligence_operation', 'cancel_native_projection',
  'checkpoint_current_run', 'checkpoint_run', 'claim_automation_delivery', 'claim_due_schedules', 'claim_inbox_messages',
  'claim_run', 'claim_run_consumer', 'claim_run_delivery', 'claim_run_effect',
  'claim_run_terminal_owner', 'close_mcp_session', 'commit_external_refresh',
  'commit_project_growth_refresh', 'commit_run_settlement', 'commit_sidebar_core_refresh',
  'complete_capability_operation', 'consume_native_projection', 'enqueue_notification',
  'fail_capability_operation', 'fail_legacy_intelligence_operation', 'finalize_run_output',
  'finish_learning_review', 'finish_run_effect', 'heartbeat_runtime_instance',
  'initialize_project_journal', 'initialize_project_registry', 'install_runtime_secret',
  'interrupt_learning_review', 'link', 'link_project_journal', 'mark_legacy_intelligence_operation',
  'mark_legacy_intelligence_side_effect', 'materialize_run_prompt', 'migrate_host_secret_state',
  'observe_run_task_ingress', 'open_mcp_session', 'patch_capability_registry', 'patch_host_settings',
  'patch_project_autonomy_authorization', 'patch_project_registry', 'patch_run_inputs',
  'patch_run_state', 'patch_ui_state', 'prepare_agent_database', 'prepare_automation_deliveries',
  'prepare_automation_delivery', 'prepare_flow_role', 'prepare_learning_review', 'prepare_run',
  'prepare_run_intent', 'prepare_run_slot', 'record_claude_native_append',
  'record_claude_native_event', 'record_claude_native_ready', 'record_learning_cycle',
  'record_native_projection', 'record_run_verification', 'recover_run_executions',
  'recover_run_inputs', 'register_automation_ui_owner', 'register_project', 'register_runtime_instance',
  'register_telegram_editor_endpoint', 'release_inbox_message', 'release_run_consumer',
  'read_registered_report_sources',
  'release_run_delivery', 'release_run_prompt', 'reserve_external_refresh',
  'reserve_project_growth_refresh', 'reserve_sidebar_core_refresh', 'resolve_roadmap_conflict',
  'restore_legacy_scheduled_occurrences', 'revoke_external_memory_target',
  'revoke_project_autonomy_authorizations', 'save_global_prompt', 'set_intelligence_time_schedule',
  'settle_automation_delivery', 'settle_inbox_action', 'settle_notification_delivery',
  'settle_schedule_occurrence', 'start_conversation', 'stop_run', 'submit_run_report',
  'supersede_native_projections', 'sync_documentation_manifest', 'sync_schedules',
  'update_project_journal', 'update_roadmap', 'upsert_project_run_index', 'write',
  'write_analysis_state', 'write_flow_trace', 'write_github_facts', 'write_growth_report_projection',
  'write_intelligence_conversation', 'write_internal_attachment',
  'write_legacy_intelligence_conversation', 'write_project_growth', 'write_run_artifact',
  'write_run_binding', 'write_run_document', 'write_step_memory', 'write_strategy_state'
] as const;

const interactiveQueries = [
  'context', 'get_conversation', 'is_recent_native_projection', 'project_cognitive_runtime_config',
  'read', 'read_capability_operation_result', 'read_capability_operation_run_state',
  'read_capability_registry', 'read_flow_trace', 'read_global_prompt_policy', 'read_host_settings',
  'read_intelligence_conversation', 'read_intelligence_execution_mode', 'read_internal_attachment',
  'read_notification', 'read_project_autonomy_authorization', 'read_project_growth',
  'read_project_journal', 'read_project_registry', 'read_recent_run_session', 'read_roadmap',
  'read_run_artifact', 'read_run_binding', 'read_run_checkpoint_state', 'read_run_document',
  'read_run_execution_plan', 'read_run_intent', 'read_run_launch_permission', 'read_run_log',
  'read_run_log_head', 'read_run_slot', 'read_run_state', 'read_run_turn_journal',
  'read_step_memory', 'read_step_memory_state', 'read_strategy_state', 'read_today_roadmaps',
  'read_ui_state', 'resolve_project_signals_scope', 'resolve_run_conversation',
  'resolve_run_conversation_turn', 'search'
] as const;

const backgroundQueries = [
  'list_automation_deliveries', 'list_conversation_run_states', 'list_flow_traces',
  'list_intelligence_conversations', 'list_notification_deliveries', 'list_recoverable_run_states',
  'list_run_deliveries', 'list_run_effects', 'list_run_states', 'query_run_digests',
  'read_analysis_state', 'read_capability_evidence', 'read_capability_operations',
  'read_database_overview', 'read_database_storage', 'read_diagnostic_events',
  'read_documentation_manifest', 'read_external_memory_targets', 'read_github_facts',
  'read_growth_report_projection', 'read_growth_snapshot_cleanup_manifest_page',
  'read_growth_snapshot_cleanup_plan', 'read_learning_overview', 'read_learning_source_revision',
  'read_legacy_intelligence_operation', 'read_project_analysis_source', 'read_project_impact_runs',
  'read_project_investment_runs', 'read_project_reusable_source_count', 'read_project_run_indexes',
  'read_report_source_revision', 'read_report_versions',
  'read_rsi_cycles', 'read_run_digests', 'read_run_index_health', 'read_run_settlements',
  'read_schedule_ledger', 'read_schedule_sync_state', 'read_strategy_source_revision'
] as const;

const externalJobs = [
  'project_signals', 'reconcile_external_memory_target', 'reconcile_unknown_inbox_actions',
  'send_intelligence_message', 'sync_external_memory'
] as const;

const maintenanceOperations = [
  'apply_growth_snapshot_cleanup', 'apply_growth_snapshot_detail_cleanup', 'backfill_run_indexes',
  'backup', 'compact_database_storage', 'confirm_recycling', 'discard_recycling_plan',
  'discover_migrations', 'execute_recycling_plan', 'export', 'export_project',
  'finish_recycling_file', 'hold_recycling_file', 'import_intelligence',
  'import_legacy_telegram_conversations', 'import_memory', 'import_project', 'import_project_data',
  'maintain_database_storage', 'migration_overview', 'migration_status', 'prepare_recycling',
  'preview_growth_snapshot_cleanup', 'preview_growth_snapshot_detail_cleanup',
  'read_recycling_plan', 'restore_backup', 'restore_recycling_file', 'retire_recycling_file',
  'retry_migration'
] as const;

const registry = new Map<string, RuntimeOperationDefinition>();

function register(
  definition: Omit<RuntimeOperationDefinition, 'operation'>,
  operations: readonly string[],
  overrides: Readonly<Record<string, Partial<Omit<RuntimeOperationDefinition, 'operation'>>>> = {}
): void {
  for (const operation of operations) {
    if (registry.has(operation)) throw new Error(`runtime_operation_duplicate:${operation}`);
    registry.set(operation, Object.freeze({ operation, ...definition, ...(overrides[operation] || {}) }));
  }
}

register({ domain: 'foreground-command', kind: 'command', executor: 'writer-actor', replay: 'idempotency-key', authority: 'stateless' }, foregroundCommands, {
  open_mcp_session: { replay: 'open-request-id', authority: 'writer-session' },
  close_mcp_session: { authority: 'writer-session' }
});
register({ domain: 'interactive-query', kind: 'query', executor: 'interactive-reader', replay: 'safe', authority: 'stateless' }, interactiveQueries, {
  read_intelligence_execution_mode: { executor: 'supervisor', authority: 'runtime-memory' }
});
register({ domain: 'background-query', kind: 'query', executor: 'background-reader', replay: 'safe', authority: 'stateless' }, backgroundQueries);
register({ domain: 'external-job', kind: 'job', executor: 'supervisor', replay: 'never', authority: 'runtime-memory' }, externalJobs, {
  project_signals: { executor: 'external-worker', replay: 'safe', authority: 'stateless' },
  reconcile_external_memory_target: { authority: 'writer-session', replay: 'idempotency-key' },
  reconcile_unknown_inbox_actions: { authority: 'writer-session', replay: 'idempotency-key' },
  sync_external_memory: { authority: 'writer-session', replay: 'idempotency-key' }
});
register({ domain: 'maintenance', kind: 'job', executor: 'maintenance-worker', replay: 'idempotency-key', authority: 'stateless' }, maintenanceOperations);

export function runtimeOperationDefinition(operation: string): RuntimeOperationDefinition {
  const definition = registry.get(operation);
  if (!definition) throw new Error(`runtime_operation_unregistered:${operation}`);
  return definition;
}

export function registeredRuntimeOperations(): readonly RuntimeOperationDefinition[] {
  return Object.freeze([...registry.values()]);
}

export function assertRuntimeOperationRegistryComplete(implementedOperations: Iterable<string>): void {
  const implemented = new Set(implementedOperations);
  const missing = [...implemented].filter(operation => !registry.has(operation)).sort();
  const stale = [...registry.keys()].filter(operation => !implemented.has(operation)).sort();
  if (missing.length || stale.length) {
    throw new Error(`runtime_operation_registry_incomplete:missing=${missing.join(',')};stale=${stale.join(',')}`);
  }
}

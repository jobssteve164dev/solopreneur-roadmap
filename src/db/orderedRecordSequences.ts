/** Persistent business order; physical SQLite rowids are not carried by Session. */
export const orderedRecordSequences: ReadonlyArray<{ table: string; column: string; key: string; base?: string; global?: boolean }> = [
  { table: 'step_handoffs', column: 'handoff_sequence', key: 'step_handoff_sequence' },
  { table: 'pi_conversation_ingress', column: 'admission_sequence', key: 'pi_ingress_sequence' },
  { table: 'growth_snapshots', base: 'objects', column: 'snapshot_sequence', key: 'growth_snapshot_sequence' },
  { table: 'run_digests', column: 'digest_sequence', key: 'run_digest_sequence' },
  { table: 'migration_jobs', column: 'job_sequence', key: 'migration_reconciliation_sequence' },
  { table: 'run_control', column: 'run_sequence', key: 'run_sequence', global: true },
  { table: 'run_consumer_sources', column: 'source_sequence', key: 'run_consumer_sequence', global: true },
  { table: 'run_settlements', column: 'settlement_sequence', key: 'run_settlement_sequence' },
  { table: 'run_effects', column: 'effect_sequence', key: 'run_effect_sequence', global: true },
  { table: 'flow_control', column: 'flow_sequence', key: 'flow_sequence' },
  { table: 'run_input_materializations', column: 'materialization_sequence', key: 'run_input_materialization_sequence', global: true },
  { table: 'reports', base: 'objects', column: 'creation_sequence', key: 'report_creation_sequence' },
  { table: 'mcp_conversation_launches', column: 'launch_sequence', key: 'mcp_conversation_launch_sequence' }
];

export function effectiveRecordSequence(table: string, column: string): string {
  if (![table,column].every(value => /^[a-z_]+$/.test(value))) throw new Error('record_order_identifier_invalid');
  return `(COALESCE(${table}.${column},${table}.rowid)+COALESCE((SELECT offset FROM database_record_order_namespaces WHERE id=${table}.sequence_namespace),0))`;
}

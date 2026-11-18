import { canonicalJson } from '../contentReferences.js';

export interface DiagnosticEventInput {
  kind: 'error' | 'operation'; occurredAt: string; scope: string;
  payload: Record<string, unknown>; idempotencyKey: string;
}
export interface PreparedDiagnosticEvent { payloadJson: string; serialized: string; comparableHeaders: boolean }

export function validateDiagnosticEvent(input: DiagnosticEventInput): void {
  if (!['error', 'operation'].includes(input.kind) || !input.occurredAt || !input.scope || !input.payload || typeof input.payload !== 'object' || !input.idempotencyKey) throw new Error('invalid_diagnostic_event');
}

export function diagnosticEventResult(input: DiagnosticEventInput): Record<string, unknown> {
  return { kind: input.kind, occurredAt: input.occurredAt, scope: input.scope, payload: input.payload, idempotencyKey: input.idempotencyKey };
}

export function prepareDiagnosticEvent(input: DiagnosticEventInput): PreparedDiagnosticEvent {
  validateDiagnosticEvent(input);
  const comparableHeaders = [input.occurredAt, input.scope].every(value => typeof value === 'string' && Buffer.from(value).toString('utf8') === value);
  return { payloadJson: canonicalJson(input.payload), serialized: JSON.stringify(diagnosticEventResult(input)), comparableHeaders };
}

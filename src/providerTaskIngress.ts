import { advanceInteractionBudget, InteractionBudget, readInteractionClock } from './interactionBudget';

export interface ProviderTaskIngressEvidence {
  provider: string;
  kind: string;
  nativeTurnId: string;
  sessionId: string;
  providerStartedAt: string;
  observedAt?: string;
  authority?: 'provider_native' | 'agent_acknowledged';
}

interface ExistingTaskIngressReceipt {
  interactionId?: string;
  authority?: 'provider_native' | 'agent_acknowledged';
}

interface TaskIngressReceipt extends ExistingTaskIngressReceipt {
  observedAt?: string;
  elapsedMs?: number;
  verdict?: string;
  observerDelayMs?: number;
  reconciledObservationTimeout?: boolean;
}

export function taskIngressDiagnosticEvent(
  status: Record<string, unknown>,
  fields: Record<string, unknown>,
  idempotencyKey: string
): { kind: 'operation'; occurredAt: string; scope: string; payload: Record<string, unknown>; idempotencyKey: string } | undefined {
  const receipt = (fields.taskIngressReceipt || status.taskIngressReceipt) as TaskIngressReceipt | undefined;
  const traceId = String(status.terminalDeliveryTraceId || '');
  if (!receipt?.interactionId || !/^[a-f0-9]{16}$/i.test(traceId)) return undefined;
  const elapsedMs = Math.max(0, Number(receipt.elapsedMs || 0));
  return {
    kind: 'operation',
    occurredAt: String(receipt.observedAt || new Date().toISOString()),
    scope: 'terminal.delivery.task.ingress',
    payload: {
      traceId,
      interactionId: receipt.interactionId,
      status: 'ok',
      durationMs: 0,
      elapsedMs,
      budgetExceeded: elapsedMs >= 10_000,
      authority: receipt.authority || 'provider_native',
      verdict: String(receipt.verdict || ''),
      ...(Number.isFinite(receipt.observerDelayMs) ? { observerDelayMs: receipt.observerDelayMs } : {}),
      ...(receipt.reconciledObservationTimeout === true
        || ['agent_task_ingress_timeout', 'agent_task_ingress_clock_untrusted'].includes(String(status.deliveryLastError || ''))
        ? { reconciledObservationTimeout: true } : {})
    },
    idempotencyKey
  };
}

function ingressAuthority(evidence: ProviderTaskIngressEvidence): 'provider_native' | 'agent_acknowledged' {
  return evidence.authority || (evidence.kind === 'mcp_task_start' ? 'agent_acknowledged' : 'provider_native');
}

export function taskIngressReceiptFields(
  status: Record<string, unknown>,
  evidence: ProviderTaskIngressEvidence
): Record<string, unknown> {
  const budget = status.interactionBudget as InteractionBudget | undefined;
  if (!budget || budget.schemaVersion !== 1 || !budget.interactionId) return {};
  const authority = ingressAuthority(evidence);
  const existing = status.taskIngressReceipt as ExistingTaskIngressReceipt | undefined;
  if (existing?.interactionId === budget.interactionId
    && (existing.authority === 'provider_native' || authority !== 'provider_native')) return {};
  const clock = readInteractionClock();
  const advanced = advanceInteractionBudget(budget, clock);
  const observedAt = evidence.observedAt || new Date().toISOString();
  const providerStartedWallMs = Date.parse(evidence.providerStartedAt);
  const observedWallMs = Date.parse(observedAt);
  const wallElapsedAtObservation = clock.wallMs - budget.acceptedWallMs;
  const uptimeElapsedAtObservation = clock.uptimeMs - budget.acceptedUptimeMs;
  const providerClockTrusted = advanced.clockTrusted
    && clock.bootId === budget.acceptedBootId
    && Math.abs(wallElapsedAtObservation - uptimeElapsedAtObservation) <= 2_000
    && Number.isFinite(providerStartedWallMs)
    && Number.isFinite(observedWallMs)
    && providerStartedWallMs >= budget.acceptedWallMs - 1_000
    && providerStartedWallMs <= observedWallMs + 1_000
    && observedWallMs <= clock.wallMs + 1_000;
  const taskElapsedMs = providerClockTrusted
    ? Math.max(0, providerStartedWallMs - budget.acceptedWallMs)
    : advanced.elapsedMs;
  const verdict = !providerClockTrusted && !advanced.clockTrusted ? 'clock_untrusted'
    : taskElapsedMs >= 10_000 ? 'deadline_exceeded'
      : taskElapsedMs > 5_000 ? 'degraded' : 'normal';
  const observerDelayMs = providerClockTrusted ? Math.max(0, observedWallMs - providerStartedWallMs) : undefined;
  const clearsObservationTimeout = ['normal', 'degraded'].includes(verdict)
    && ['agent_task_ingress_timeout', 'agent_task_ingress_clock_untrusted'].includes(String(status.deliveryLastError || ''));
  return {
    interactionBudget: {
      schemaVersion: budget.schemaVersion,
      interactionId: budget.interactionId,
      acceptedWallMs: budget.acceptedWallMs,
      acceptedBootId: budget.acceptedBootId,
      acceptedUptimeMs: budget.acceptedUptimeMs,
      elapsedFloorMs: advanced.elapsedFloorMs
    },
    taskIngressReceipt: {
      schemaVersion: 1,
      interactionId: budget.interactionId,
      provider: evidence.provider,
      kind: evidence.kind,
      authority,
      nativeTurnId: evidence.nativeTurnId,
      sessionId: evidence.sessionId,
      providerStartedAt: evidence.providerStartedAt,
      observedAt,
      elapsedMs: taskElapsedMs,
      verdict,
      clockTrusted: providerClockTrusted || advanced.clockTrusted,
      ...(clearsObservationTimeout ? { reconciledObservationTimeout: true } : {}),
      ...(observerDelayMs === undefined ? {} : { observerDelayMs })
    },
    taskIngressElapsedMs: taskElapsedMs,
    taskIngressVerdict: verdict,
    taskIngressObservedAt: observedAt,
    ...(clearsObservationTimeout ? { deliveryLastError: '', taskIngressDeadlineExceededAt: '' } : {})
  };
}

export function taskIngressDeadlineFields(
  status: Record<string, unknown>,
  sample = readInteractionClock()
): Record<string, unknown> {
  const budget = status.interactionBudget as InteractionBudget | undefined;
  if (!budget || budget.schemaVersion !== 1 || !budget.interactionId) return {};
  const existing = status.taskIngressReceipt as ExistingTaskIngressReceipt | undefined;
  if (existing?.interactionId === budget.interactionId) return {};
  const advanced = advanceInteractionBudget(budget, sample);
  if (advanced.elapsedMs < 10_000) return {};
  const observedAt = new Date(sample.wallMs).toISOString();
  return {
    interactionBudget: {
      schemaVersion: budget.schemaVersion,
      interactionId: budget.interactionId,
      acceptedWallMs: budget.acceptedWallMs,
      acceptedBootId: budget.acceptedBootId,
      acceptedUptimeMs: budget.acceptedUptimeMs,
      elapsedFloorMs: advanced.elapsedFloorMs
    },
    taskIngressElapsedMs: advanced.elapsedMs,
    taskIngressVerdict: advanced.clockTrusted ? 'deadline_exceeded' : 'clock_untrusted',
    taskIngressObservedAt: observedAt,
    taskIngressDeadlineExceededAt: observedAt,
    deliveryLastError: advanced.clockTrusted ? 'agent_task_ingress_timeout' : 'agent_task_ingress_clock_untrusted'
  };
}

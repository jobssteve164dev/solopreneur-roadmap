import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { AsyncLocalStorage } from 'async_hooks';

export interface InteractionClockSample {
  wallMs: number;
  bootId: string;
  uptimeMs: number;
}

export interface InteractionBudget {
  schemaVersion: 1;
  interactionId: string;
  acceptedWallMs: number;
  acceptedBootId: string;
  acceptedUptimeMs: number;
  elapsedFloorMs: number;
}

export interface InteractionBudgetResult extends InteractionBudget {
  elapsedMs: number;
  verdict: 'normal' | 'degraded' | 'deadline_exceeded' | 'clock_untrusted';
  clockTrusted: boolean;
}

let cachedBootId = '';
const activeBudget = new AsyncLocalStorage<InteractionBudget>();

export function readInteractionClock(): InteractionClockSample {
  if (!cachedBootId) {
    try { cachedBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
    // os.uptime() is system-wide. Keep the fallback stable across the
    // Extension Host and Runtime instead of baking either process PID into
    // the identity and making every cross-process sample look like a reboot.
    catch { cachedBootId = 'system-uptime'; }
  }
  return { wallMs: Date.now(), bootId: cachedBootId, uptimeMs: Math.round(os.uptime() * 1000) };
}

export function createInteractionBudget(sample: InteractionClockSample & { interactionId?: string } = readInteractionClock()): InteractionBudget {
  if (!Number.isFinite(sample.wallMs) || !Number.isFinite(sample.uptimeMs) || !sample.bootId) throw new Error('interaction_clock_untrusted');
  return {
    schemaVersion: 1,
    interactionId: sample.interactionId || crypto.randomUUID(),
    acceptedWallMs: sample.wallMs,
    acceptedBootId: sample.bootId,
    acceptedUptimeMs: sample.uptimeMs,
    elapsedFloorMs: 0
  };
}

export function createInteractionBudgetAt(acceptedWallMs: number, interactionId: string): InteractionBudget {
  const sample = readInteractionClock();
  const wallElapsed = sample.wallMs - acceptedWallMs;
  if (!Number.isFinite(acceptedWallMs) || acceptedWallMs < 0 || !interactionId) throw new Error('interaction_clock_untrusted');
  if (wallElapsed >= 0 && wallElapsed <= sample.uptimeMs) {
    return createInteractionBudget({ wallMs: acceptedWallMs, bootId: sample.bootId,
      uptimeMs: sample.uptimeMs - wallElapsed, interactionId });
  }
  return { schemaVersion: 1, interactionId, acceptedWallMs, acceptedBootId: `wall:${interactionId}`,
    acceptedUptimeMs: 0, elapsedFloorMs: Math.max(0, wallElapsed) };
}

export function advanceInteractionBudget(budget: InteractionBudget, sample: InteractionClockSample = readInteractionClock()): InteractionBudgetResult {
  const floor = Number.isFinite(budget.elapsedFloorMs) ? Math.max(0, budget.elapsedFloorMs) : 0;
  let elapsed = floor;
  let trusted = true;
  if (sample.bootId === budget.acceptedBootId && sample.uptimeMs >= budget.acceptedUptimeMs) {
    elapsed = Math.max(floor, sample.uptimeMs - budget.acceptedUptimeMs);
  } else {
    const wallDelta = sample.wallMs - budget.acceptedWallMs;
    if (sample.bootId !== budget.acceptedBootId && Number.isFinite(wallDelta) && wallDelta >= floor && wallDelta >= 0) elapsed = wallDelta;
    else trusted = false;
  }
  const verdict: InteractionBudgetResult['verdict'] = !trusted ? 'clock_untrusted'
    : elapsed >= 10_000 ? 'deadline_exceeded'
      : elapsed > 5_000 ? 'degraded' : 'normal';
  return { ...budget, elapsedFloorMs: elapsed, elapsedMs: elapsed, verdict, clockTrusted: trusted };
}

export function currentInteractionBudget(): InteractionBudget | undefined {
  return activeBudget.getStore();
}

export function runWithInteractionBudget<T>(budget: InteractionBudget, action: () => T): T {
  return activeBudget.run(budget, action);
}

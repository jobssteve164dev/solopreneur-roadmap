import * as fs from 'fs';
import * as path from 'path';

export type SessionIdentityMethod =
  | 'caller_assigned'
  | 'provider_created'
  | 'provider_callback'
  | 'transcript_correlated_compat';

export type SessionIdentityContract = 'official_stable' | 'official_experimental' | 'compatibility';
export type SessionIdentityState = 'preparing' | 'planned' | 'confirmed' | 'conflict' | 'unavailable';

export interface SessionBindingRevision {
  revision: number;
  sessionId?: string;
  supersedesRevision?: number;
  method: SessionIdentityMethod;
  contract: SessionIdentityContract;
  state: SessionIdentityState;
  createdAt: string;
  confirmedAt?: string;
  providerContext?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  errorCode?: string;
}

export interface NativeSessionBinding {
  version: 2;
  runId: string;
  provider: string;
  workspaceRoot: string;
  cliPath: string;
  cliVersion?: string;
  bindingNonce: string;
  createdAt: string;
  headRevision: number;
  resumableRevision?: number;
  revisions: SessionBindingRevision[];
}

export interface SessionBindingSeed {
  runId: string;
  provider: string;
  workspaceRoot: string;
  cliPath: string;
  cliVersion?: string;
  bindingNonce: string;
  method: SessionIdentityMethod;
  contract: SessionIdentityContract;
  createdAt?: string;
  providerContext?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}

export interface SessionBindingRevisionInput {
  sessionId?: string;
  supersedesRevision?: number;
  method: SessionIdentityMethod;
  contract: SessionIdentityContract;
  state: SessionIdentityState;
  createdAt?: string;
  confirmedAt?: string;
  providerContext?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  errorCode?: string;
}

export interface ResumableSessionBinding {
  runId: string;
  revision: number;
  sessionId: string;
  provider: string;
  workspaceRoot: string;
  cliPath: string;
}

function sessionIdentityError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFilePath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempFilePath, filePath);
}

function withSessionBindingLease<T>(filePath: string, action: () => T): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const leaseFilePath = `${filePath}.lease`;
  let leaseFd: number;
  try {
    leaseFd = fs.openSync(leaseFilePath, 'wx');
  } catch {
    throw sessionIdentityError('identity_index_conflict', `Session binding is already being updated: ${filePath}`);
  }
  try {
    return action();
  } finally {
    fs.closeSync(leaseFd);
    try {
      fs.unlinkSync(leaseFilePath);
    } catch {
      // A missing lease after closing cannot change the already committed binding.
    }
  }
}

export function assertVersion2Binding(value: unknown, filePath: string): NativeSessionBinding {
  const binding = value as Partial<NativeSessionBinding> | null;
  if (!binding || binding.version !== 2 || !Array.isArray(binding.revisions)) {
    throw sessionIdentityError('identity_binding_invalid', `Session binding is not version 2: ${filePath}`);
  }
  if (!Number.isInteger(binding.headRevision) || binding.headRevision !== binding.revisions.length || binding.headRevision < 1) {
    throw sessionIdentityError('identity_binding_invalid', `Session binding revision chain is invalid: ${filePath}`);
  }
  if (binding.revisions.some((revision, index) => revision?.revision !== index + 1)) {
    throw sessionIdentityError('identity_binding_invalid', `Session binding revision sequence is invalid: ${filePath}`);
  }
  if (binding.resumableRevision !== undefined) {
    const resumable = binding.revisions[binding.resumableRevision - 1];
    if (
      !Number.isInteger(binding.resumableRevision)
      || binding.resumableRevision !== binding.headRevision
      || resumable?.state !== 'confirmed'
      || !resumable.sessionId
    ) {
      throw sessionIdentityError('identity_binding_invalid', `Session binding resumable revision is invalid: ${filePath}`);
    }
  }
  return binding as NativeSessionBinding;
}

export function readSessionBinding(filePath: string): NativeSessionBinding {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw sessionIdentityError('identity_binding_invalid', `Session binding cannot be read: ${filePath}`);
  }
  return assertVersion2Binding(value, filePath);
}

export function createSessionBindingValue(seed: SessionBindingSeed): NativeSessionBinding {
    const createdAt = seed.createdAt || new Date().toISOString();
    const firstRevision: SessionBindingRevision = {
      revision: 1,
      method: seed.method,
      contract: seed.contract,
      state: 'preparing',
      createdAt,
      ...(seed.providerContext ? { providerContext: seed.providerContext } : {}),
      ...(seed.evidence ? { evidence: seed.evidence } : {})
    };
    const binding: NativeSessionBinding = {
      version: 2,
      runId: seed.runId,
      provider: seed.provider,
      workspaceRoot: path.resolve(seed.workspaceRoot),
      cliPath: seed.cliPath,
      ...(seed.cliVersion ? { cliVersion: seed.cliVersion } : {}),
      bindingNonce: seed.bindingNonce,
      createdAt,
      headRevision: 1,
      revisions: [firstRevision]
    };
    return binding;
}

export function createSessionBinding(filePath: string, seed: SessionBindingSeed): NativeSessionBinding {
  return withSessionBindingLease(filePath, () => {
    if (fs.existsSync(filePath)) throw sessionIdentityError('identity_index_conflict', `Session binding already exists: ${filePath}`);
    const binding = createSessionBindingValue(seed);
    atomicWriteJson(filePath, binding);
    return binding;
  });
}

export function appendSessionBindingRevision(
  filePath: string,
  expectedHeadRevision: number,
  input: SessionBindingRevisionInput
): NativeSessionBinding {
  return withSessionBindingLease(filePath, () => {
    const binding = readSessionBinding(filePath);
    const next = appendSessionBindingValue(binding, expectedHeadRevision, input);
    atomicWriteJson(filePath, next);
    return next;
  });
}

export function appendSessionBindingValue(binding: NativeSessionBinding, expectedHeadRevision: number, input: SessionBindingRevisionInput): NativeSessionBinding {
    assertVersion2Binding(binding, binding.runId);
    if (binding.headRevision !== expectedHeadRevision) {
      throw sessionIdentityError(
        'identity_index_conflict',
        `Session binding changed from revision ${expectedHeadRevision} to ${binding.headRevision}: ${binding.runId}`
      );
    }
    const revision = expectedHeadRevision + 1;
    const nextRevision: SessionBindingRevision = {
      revision,
      method: input.method,
      contract: input.contract,
      state: input.state,
      createdAt: input.createdAt || new Date().toISOString(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.supersedesRevision ? { supersedesRevision: input.supersedesRevision } : {}),
      ...(input.confirmedAt ? { confirmedAt: input.confirmedAt } : {}),
      ...(input.providerContext ? { providerContext: input.providerContext } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {})
    };
    const next: NativeSessionBinding = {
      ...binding,
      headRevision: revision,
      revisions: [...binding.revisions, nextRevision]
    };
    if (nextRevision.state === 'confirmed' && nextRevision.sessionId) {
      next.resumableRevision = revision;
    } else {
      delete next.resumableRevision;
    }
    return next;
}

export function confirmSessionBindingValue(binding: NativeSessionBinding, expectedHeadRevision: number, expectedSessionId: string, confirmedAt = new Date().toISOString(), evidence?: Record<string, unknown>): NativeSessionBinding {
  assertVersion2Binding(binding, binding.runId);
  if (binding.headRevision !== expectedHeadRevision) throw sessionIdentityError('identity_index_conflict', `Session binding head does not match revision ${expectedHeadRevision}`);
  const head = binding.revisions[expectedHeadRevision - 1];
  if (head.state !== 'planned' || !head.sessionId || head.sessionId !== expectedSessionId) throw sessionIdentityError('identity_provider_mismatch', 'Planned session does not match the confirmed session');
  return appendSessionBindingValue(binding, expectedHeadRevision, { sessionId: head.sessionId, supersedesRevision: expectedHeadRevision, method: head.method, contract: head.contract, state: 'confirmed', confirmedAt, providerContext: head.providerContext, evidence });
}

export function confirmSessionBinding(
  filePath: string,
  expectedHeadRevision: number,
  expectedSessionId: string,
  confirmedAt = new Date().toISOString(),
  evidence?: Record<string, unknown>
): NativeSessionBinding {
  const binding = readSessionBinding(filePath);
  if (binding.headRevision !== expectedHeadRevision) {
    throw sessionIdentityError('identity_index_conflict', `Session binding head does not match revision ${expectedHeadRevision}: ${filePath}`);
  }
  const head = binding.revisions[expectedHeadRevision - 1];
  if (head.state !== 'planned' || !head.sessionId || head.sessionId !== expectedSessionId) {
    throw sessionIdentityError('identity_provider_mismatch', `Planned session does not match the confirmed session: ${filePath}`);
  }
  return appendSessionBindingRevision(filePath, expectedHeadRevision, {
    sessionId: head.sessionId,
    supersedesRevision: expectedHeadRevision,
    method: head.method,
    contract: head.contract,
    state: 'confirmed',
    confirmedAt,
    providerContext: head.providerContext,
    evidence
  });
}

export function getResumableSession(filePath: string): ResumableSessionBinding | null {
  try {
    return getResumableSessionValue(readSessionBinding(filePath));
  } catch {
    return null;
  }
}

export function getCodexSessionHome(binding: NativeSessionBinding | null): string {
  if (!binding || binding.provider !== 'codex') return '';
  const context = [...binding.revisions].reverse().find(revision => revision.providerContext?.codex)?.providerContext?.codex;
  const home = context && typeof context === 'object' ? String((context as Record<string, unknown>).codexHome || '').trim() : '';
  if (home && !path.isAbsolute(home)) throw sessionIdentityError('identity_provider_context_invalid', 'Codex session home must be an absolute path');
  return home;
}

export function getResumableSessionValue(binding: NativeSessionBinding | null): ResumableSessionBinding | null {
  if (!binding) return null;
  assertVersion2Binding(binding, binding.runId);
  if (!binding.resumableRevision || binding.resumableRevision !== binding.headRevision) {
    return null;
  }
  const revision = binding.revisions[binding.resumableRevision - 1];
  if (!revision || revision.state !== 'confirmed' || !revision.sessionId) {
    return null;
  }
  return {
    runId: binding.runId,
    revision: revision.revision,
    sessionId: revision.sessionId,
    provider: binding.provider,
    workspaceRoot: binding.workspaceRoot,
    cliPath: binding.cliPath
  };
}

export function readCompatibleSessionId(filePath: string): string {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (value.version === 2) {
      return getResumableSession(filePath)?.sessionId || '';
    }
    return String(value.sessionId || '').trim();
  } catch {
    return '';
  }
}

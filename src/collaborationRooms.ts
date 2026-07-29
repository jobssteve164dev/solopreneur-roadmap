import type * as vscode from 'vscode';

export const collaborationRoomsStateKey = 'solomap.collaborationRooms.v1';
export const collaborationRoomSecretsKey = 'solomap.collaborationRoomSecrets.v1';
export const collaborationDeviceCredentialSecretKey = 'solomap.collaborationDeviceCredential.v1';
export const collaborationSiteOrigin = 'https://solomap.app';

const roomIdPattern = /^[A-Za-z0-9_-]{20,64}$/;
const relayTokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const encryptionKeyPattern = /^[A-Za-z0-9_-]{43}$/;
const authorIdPattern = /^[A-Za-z0-9_-]{16,80}$/;
const maxSavedRooms = 12;
const deviceCredentialPattern = /^[A-Za-z0-9_-]{40,512}\.[A-Za-z0-9_-]{40,128}$/;

export type CollaborationCreatorTier = 'anonymous' | 'account' | 'pro';

export interface CollaborationQuotaSummary {
  tier: CollaborationCreatorTier;
  maxActiveRooms: number;
  maxDailyRooms: number;
  maxLifetimeMs: number;
  activeRooms?: number;
  remainingDailyRooms?: number;
}

export interface CollaborationRoomMetadata {
  roomId: string;
  title: string;
  projectPath: string;
  authorId: string;
  nickname: string;
  createdAt: number;
  expiresAt: number;
  lastActiveAt: number;
  creatorTier?: CollaborationCreatorTier;
  quota?: CollaborationQuotaSummary;
}

export interface CollaborationRoomCredentials {
  relayToken: string;
  encryptionKey: string;
}

export type CollaborationRoomRecord = CollaborationRoomMetadata & CollaborationRoomCredentials;

type CollaborationStorage = Pick<vscode.ExtensionContext, 'globalState' | 'secrets'>;

export interface CollaborationRoomCreateInput {
  roomId: string;
  relayToken: string;
  expiresAt: number;
}

export interface CollaborationRoomCreateResult {
  ok: boolean;
  error?: string;
  expiresAt?: number;
  tier?: CollaborationCreatorTier;
  quota?: CollaborationQuotaSummary;
}

export interface CollaborationLobbySession {
  ok: boolean;
  error?: string;
  ticket?: string;
  memberId?: string;
  sessionStartedAt?: number;
  sessionEndsAt?: number;
}

export type CollaborationDiagnosticStage =
  | 'account_create'
  | 'device_registration'
  | 'device_create'
  | 'device_refresh';

export interface CollaborationDiagnosticEvent {
  stage: CollaborationDiagnosticStage;
  outcome: 'fallback' | 'failure';
  durationMs: number;
  status?: number;
  error: string;
}

export type CollaborationDiagnosticSink = (event: CollaborationDiagnosticEvent) => void;

const collaborationInviteCodePrefix = 'SM1.';
const collaborationCreateDeadlineMs = 15_000;

function diagnosticErrorCode(error: unknown): string {
  if (error instanceof Error && error.message === 'collaboration_request_timeout') return error.message;
  return 'collaboration_network_error';
}

async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  deadlineAt: number
): Promise<{ response: Response; durationMs: number }> {
  const remainingMs = Math.max(1, deadlineAt - Date.now());
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    return { response, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('collaboration_request_timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function emitCollaborationDiagnostic(
  sink: CollaborationDiagnosticSink | undefined,
  event: CollaborationDiagnosticEvent
): void {
  try {
    sink?.(event);
  } catch {
    // Diagnostics must never change the room creation result.
  }
}

function normalizeMetadata(value: unknown): CollaborationRoomMetadata | null {
  const item = value as Partial<CollaborationRoomMetadata> | null;
  if (!item || !roomIdPattern.test(String(item.roomId || '')) || !authorIdPattern.test(String(item.authorId || ''))) return null;
  const expiresAt = Number(item.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  const creatorTier = ['anonymous', 'account', 'pro'].includes(String(item.creatorTier || ''))
    ? String(item.creatorTier) as CollaborationCreatorTier
    : undefined;
  const rawQuota = item.quota as Partial<CollaborationQuotaSummary> | undefined;
  const quota = rawQuota && creatorTier && Number(rawQuota.maxLifetimeMs || 0) > 0 ? {
    tier: creatorTier,
    maxActiveRooms: Math.max(1, Number(rawQuota.maxActiveRooms || 1)),
    maxDailyRooms: Math.max(1, Number(rawQuota.maxDailyRooms || 1)),
    maxLifetimeMs: Math.max(60 * 1000, Number(rawQuota.maxLifetimeMs || 0)),
    activeRooms: Math.max(0, Number(rawQuota.activeRooms || 0)),
    remainingDailyRooms: Math.max(0, Number(rawQuota.remainingDailyRooms || 0))
  } : undefined;
  return {
    roomId: String(item.roomId),
    title: String(item.title || '').trim().slice(0, 80) || '临时共创',
    projectPath: String(item.projectPath || ''),
    authorId: String(item.authorId || ''),
    nickname: String(item.nickname || '').trim().slice(0, 40),
    createdAt: Number(item.createdAt || Date.now()),
    expiresAt,
    lastActiveAt: Number(item.lastActiveAt || item.createdAt || Date.now()),
    ...(creatorTier ? { creatorTier } : {}),
    ...(quota ? { quota } : {})
  };
}

function normalizeCredentials(value: unknown): CollaborationRoomCredentials | null {
  const item = value as Partial<CollaborationRoomCredentials> | null;
  const relayToken = String(item?.relayToken || '');
  const encryptionKey = String(item?.encryptionKey || '');
  if (!relayTokenPattern.test(relayToken) || !encryptionKeyPattern.test(encryptionKey)) return null;
  return { relayToken, encryptionKey };
}

async function readSecrets(context: CollaborationStorage): Promise<Record<string, CollaborationRoomCredentials>> {
  try {
    const raw = await context.secrets.get(collaborationRoomSecretsKey);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .map(([roomId, credentials]) => [roomId, normalizeCredentials(credentials)] as const)
      .filter((entry): entry is [string, CollaborationRoomCredentials] => Boolean(entry[1])));
  } catch {
    return {};
  }
}

export async function readCollaborationRooms(context: CollaborationStorage): Promise<CollaborationRoomRecord[]> {
  const metadata = context.globalState.get<unknown[]>(collaborationRoomsStateKey) || [];
  const secrets = await readSecrets(context);
  return metadata
    .map(normalizeMetadata)
    .filter((item): item is CollaborationRoomMetadata => Boolean(item))
    .map((item) => ({ ...item, ...(secrets[item.roomId] || {}) }))
    .filter((item): item is CollaborationRoomRecord => Boolean(normalizeCredentials(item)))
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
    .slice(0, maxSavedRooms);
}

export async function saveCollaborationRoom(context: CollaborationStorage, input: CollaborationRoomRecord): Promise<CollaborationRoomRecord[]> {
  const metadata = normalizeMetadata(input);
  const credentials = normalizeCredentials(input);
  if (!metadata || !credentials) {
    throw new Error('The collaboration room credentials are invalid or expired.');
  }
  const current = await readCollaborationRooms(context);
  const rooms = [
    { ...metadata, ...credentials },
    ...current.filter((room) => room.roomId !== metadata.roomId)
  ].slice(0, maxSavedRooms);
  await context.globalState.update(collaborationRoomsStateKey, rooms.map((room) => ({
    roomId: room.roomId,
    title: room.title,
    projectPath: room.projectPath,
    authorId: room.authorId,
    nickname: room.nickname,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    lastActiveAt: room.lastActiveAt,
    ...(room.creatorTier ? { creatorTier: room.creatorTier } : {}),
    ...(room.quota ? { quota: room.quota } : {})
  })));
  await context.secrets.store(collaborationRoomSecretsKey, JSON.stringify(Object.fromEntries(
    rooms.map((room) => [room.roomId, { relayToken: room.relayToken, encryptionKey: room.encryptionKey }])
  )));
  return rooms;
}

async function requestCollaborationDeviceCredential(
  fetcher: typeof fetch,
  deadlineAt: number,
  stage: 'device_registration' | 'device_refresh',
  diagnosticSink?: CollaborationDiagnosticSink
): Promise<string> {
  let response: Response;
  let durationMs = 0;
  const startedAt = Date.now();
  try {
    const request = await fetchWithDeadline(`${collaborationSiteOrigin}/api/collaboration/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }, fetcher, deadlineAt);
    response = request.response;
    durationMs = request.durationMs;
  } catch (error) {
    emitCollaborationDiagnostic(diagnosticSink, {
      stage,
      outcome: 'failure',
      durationMs: Date.now() - startedAt,
      error: diagnosticErrorCode(error)
    });
    throw new Error(diagnosticErrorCode(error));
  }
  const result = await response.json().catch(() => ({})) as { deviceCredential?: string; error?: string };
  const credential = String(result.deviceCredential || '');
  if (!response.ok || !deviceCredentialPattern.test(credential)) {
    const error = String(result.error || `device_registration_http_${response.status}`);
    emitCollaborationDiagnostic(diagnosticSink, { stage, outcome: 'failure', durationMs, status: response.status, error });
    throw new Error(error);
  }
  return credential;
}

export async function readOrCreateCollaborationDeviceCredential(
  context: CollaborationStorage,
  fetcher: typeof fetch = fetch,
  deadlineAt = Date.now() + collaborationCreateDeadlineMs,
  diagnosticSink?: CollaborationDiagnosticSink
): Promise<string> {
  const existing = String(await context.secrets.get(collaborationDeviceCredentialSecretKey) || '');
  if (deviceCredentialPattern.test(existing)) return existing;
  const credential = await requestCollaborationDeviceCredential(fetcher, deadlineAt, 'device_registration', diagnosticSink);
  await context.secrets.store(collaborationDeviceCredentialSecretKey, credential);
  return credential;
}

async function refreshCollaborationDeviceCredential(
  context: CollaborationStorage,
  fetcher: typeof fetch,
  deadlineAt: number,
  diagnosticSink?: CollaborationDiagnosticSink
): Promise<string> {
  const credential = await requestCollaborationDeviceCredential(fetcher, deadlineAt, 'device_refresh', diagnosticSink);
  await context.secrets.store(collaborationDeviceCredentialSecretKey, credential);
  return credential;
}

async function sendRoomCreateRequest(
  input: CollaborationRoomCreateInput,
  authorization: string,
  fetcher: typeof fetch,
  deadlineAt: number
): Promise<{ status: number; result: CollaborationRoomCreateResult; durationMs: number }> {
  const request = await fetchWithDeadline(`${collaborationSiteOrigin}/api/collaboration/rooms`, {
    method: 'POST',
    headers: {
      'authorization': authorization,
      'content-type': 'application/json'
    },
    body: JSON.stringify(input)
  }, fetcher, deadlineAt);
  const response = request.response;
  const result = await response.json().catch(() => ({ ok: false, error: `room_create_http_${response.status}` })) as CollaborationRoomCreateResult;
  return { status: response.status, result, durationMs: request.durationMs };
}

export async function createCollaborationRoom(
  context: CollaborationStorage,
  input: CollaborationRoomCreateInput,
  passportGrant = '',
  fetcher: typeof fetch = fetch,
  diagnosticSink?: CollaborationDiagnosticSink,
  createDeadlineMs = collaborationCreateDeadlineMs
): Promise<CollaborationRoomCreateResult> {
  if (!roomIdPattern.test(String(input.roomId || '')) || !relayTokenPattern.test(String(input.relayToken || ''))) {
    return { ok: false, error: 'invalid_room_credentials' };
  }
  const normalizedDeadlineMs = Math.max(1, Number(createDeadlineMs) || collaborationCreateDeadlineMs);
  const deadlineAt = Date.now() + normalizedDeadlineMs;
  if (passportGrant) {
    const accountStartedAt = Date.now();
    try {
      const accountAttempt = await sendRoomCreateRequest(
        input,
        `Bearer ${passportGrant}`,
        fetcher,
        Math.min(deadlineAt, Date.now() + Math.min(4_000, Math.max(1, Math.floor(normalizedDeadlineMs / 3))))
      );
      if (accountAttempt.result.ok) return accountAttempt.result;
      if (![401, 403].includes(accountAttempt.status)) {
        emitCollaborationDiagnostic(diagnosticSink, {
          stage: 'account_create',
          outcome: 'failure',
          durationMs: accountAttempt.durationMs,
          status: accountAttempt.status,
          error: String(accountAttempt.result.error || `room_create_http_${accountAttempt.status}`)
        });
        return accountAttempt.result;
      }
      emitCollaborationDiagnostic(diagnosticSink, {
        stage: 'account_create',
        outcome: 'fallback',
        durationMs: accountAttempt.durationMs,
        status: accountAttempt.status,
        error: String(accountAttempt.result.error || 'account_grant_rejected')
      });
    } catch (error) {
      emitCollaborationDiagnostic(diagnosticSink, {
        stage: 'account_create',
        outcome: 'fallback',
        durationMs: Date.now() - accountStartedAt,
        error: diagnosticErrorCode(error)
      });
    }
  }
  let deviceCredential = await readOrCreateCollaborationDeviceCredential(context, fetcher, deadlineAt, diagnosticSink);
  let deviceAttempt: Awaited<ReturnType<typeof sendRoomCreateRequest>>;
  let deviceCreateStartedAt = Date.now();
  try {
    deviceAttempt = await sendRoomCreateRequest(input, `Device ${deviceCredential}`, fetcher, deadlineAt);
  } catch (error) {
    const code = diagnosticErrorCode(error);
    emitCollaborationDiagnostic(diagnosticSink, {
      stage: 'device_create',
      outcome: 'failure',
      durationMs: Date.now() - deviceCreateStartedAt,
      error: code
    });
    throw new Error(code);
  }
  if ([401, 403].includes(deviceAttempt.status)) {
    emitCollaborationDiagnostic(diagnosticSink, {
      stage: 'device_create',
      outcome: 'fallback',
      durationMs: deviceAttempt.durationMs,
      status: deviceAttempt.status,
      error: String(deviceAttempt.result.error || 'device_credential_rejected')
    });
    deviceCredential = await refreshCollaborationDeviceCredential(context, fetcher, deadlineAt, diagnosticSink);
    deviceCreateStartedAt = Date.now();
    try {
      deviceAttempt = await sendRoomCreateRequest(input, `Device ${deviceCredential}`, fetcher, deadlineAt);
    } catch (error) {
      const code = diagnosticErrorCode(error);
      emitCollaborationDiagnostic(diagnosticSink, {
        stage: 'device_create',
        outcome: 'failure',
        durationMs: Date.now() - deviceCreateStartedAt,
        error: code
      });
      throw new Error(code);
    }
  }
  if (!deviceAttempt.result.ok) {
    emitCollaborationDiagnostic(diagnosticSink, {
      stage: 'device_create',
      outcome: 'failure',
      durationMs: deviceAttempt.durationMs,
      status: deviceAttempt.status,
      error: String(deviceAttempt.result.error || `room_create_http_${deviceAttempt.status}`)
    });
  }
  return deviceAttempt.result;
}

export async function createCollaborationLobbySession(
  nickname: string,
  passportGrant: string,
  fetcher: typeof fetch = fetch
): Promise<CollaborationLobbySession> {
  const normalizedNickname = String(nickname || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!normalizedNickname) return { ok: false, error: 'nickname_required' };
  if (!passportGrant) return { ok: false, error: 'login_required' };
  const response = await fetcher(`${collaborationSiteOrigin}/api/collaboration/lobby/session`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${passportGrant}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ nickname: normalizedNickname })
  });
  const result = await response.json().catch(() => ({ ok: false, error: `lobby_session_http_${response.status}` })) as CollaborationLobbySession;
  if (!response.ok) return { ok: false, error: String(result.error || `lobby_session_http_${response.status}`) };
  return {
    ok: Boolean(result.ok),
    ticket: String(result.ticket || ''),
    memberId: String(result.memberId || ''),
    sessionStartedAt: Number(result.sessionStartedAt || 0),
    sessionEndsAt: Number(result.sessionEndsAt || 0)
  };
}

export function buildCollaborationInviteCode(room: Pick<CollaborationRoomRecord, 'roomId' | 'relayToken' | 'encryptionKey'>): string {
  const credentials = normalizeCredentials(room);
  if (!roomIdPattern.test(String(room.roomId || '')) || !credentials) {
    throw new Error('The collaboration room credentials are invalid.');
  }
  const segments = [String(room.roomId), credentials.relayToken, credentials.encryptionKey].map((value) => Buffer.from(value, 'ascii'));
  if (segments.some((segment) => segment.length > 255)) throw new Error('The collaboration room credentials are too long.');
  const payload = Buffer.concat([
    Buffer.from([1, segments[0].length, segments[1].length, segments[2].length]),
    ...segments
  ]);
  return `${collaborationInviteCodePrefix}${payload.toString('base64url')}`;
}

export function parseCollaborationInviteCode(value: string): CollaborationRoomCredentials & { roomId: string } {
  const code = String(value || '').trim();
  if (!code.startsWith(collaborationInviteCodePrefix)) throw new Error('invalid_invite_code');
  let payload: Buffer;
  try {
    payload = Buffer.from(code.slice(collaborationInviteCodePrefix.length), 'base64url');
  } catch {
    throw new Error('invalid_invite_code');
  }
  if (payload.length < 4 || payload[0] !== 1) throw new Error('invalid_invite_code');
  const lengths = [payload[1], payload[2], payload[3]];
  if (4 + lengths.reduce((sum, length) => sum + length, 0) !== payload.length) throw new Error('invalid_invite_code');
  let offset = 4;
  const segments = lengths.map((length) => {
    const segment = payload.subarray(offset, offset + length).toString('ascii');
    offset += length;
    return segment;
  });
  const [roomId, relayToken, encryptionKey] = segments;
  if (!roomIdPattern.test(roomId) || !relayTokenPattern.test(relayToken) || !encryptionKeyPattern.test(encryptionKey)) {
    throw new Error('invalid_invite_code');
  }
  return { roomId, relayToken, encryptionKey };
}

export function appendCollaborationIdea(existingNotes: string, input: { authorName: string; text: string; createdAt: number }): string {
  const text = String(input.text || '').trim();
  if (!text) return String(existingNotes || '');
  const author = String(input.authorName || '').trim().slice(0, 40) || '共创参与者';
  const timestamp = new Date(Number(input.createdAt || Date.now()));
  const date = Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : new Date().toISOString();
  const entry = `[临时共创想法 · ${date} · ${author}]\n${text.slice(0, 4000)}`;
  return [String(existingNotes || '').trim(), entry].filter(Boolean).join('\n\n');
}

import type * as vscode from 'vscode';

export const collaborationRoomsStateKey = 'solomap.collaborationRooms.v1';
export const collaborationRoomSecretsKey = 'solomap.collaborationRoomSecrets.v1';
export const collaborationSiteOrigin = 'https://solomap.app';

const roomIdPattern = /^[A-Za-z0-9_-]{20,64}$/;
const relayTokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const encryptionKeyPattern = /^[A-Za-z0-9_-]{43}$/;
const authorIdPattern = /^[A-Za-z0-9_-]{16,80}$/;
const maxSavedRooms = 12;

export interface CollaborationRoomMetadata {
  roomId: string;
  title: string;
  projectPath: string;
  authorId: string;
  nickname: string;
  createdAt: number;
  expiresAt: number;
  lastActiveAt: number;
}

export interface CollaborationRoomCredentials {
  relayToken: string;
  encryptionKey: string;
}

export type CollaborationRoomRecord = CollaborationRoomMetadata & CollaborationRoomCredentials;

type CollaborationStorage = Pick<vscode.ExtensionContext, 'globalState' | 'secrets'>;

function normalizeMetadata(value: unknown): CollaborationRoomMetadata | null {
  const item = value as Partial<CollaborationRoomMetadata> | null;
  if (!item || !roomIdPattern.test(String(item.roomId || '')) || !authorIdPattern.test(String(item.authorId || ''))) return null;
  const expiresAt = Number(item.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return {
    roomId: String(item.roomId),
    title: String(item.title || '').trim().slice(0, 80) || '临时共创',
    projectPath: String(item.projectPath || ''),
    authorId: String(item.authorId || ''),
    nickname: String(item.nickname || '').trim().slice(0, 40),
    createdAt: Number(item.createdAt || Date.now()),
    expiresAt,
    lastActiveAt: Number(item.lastActiveAt || item.createdAt || Date.now())
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
    lastActiveAt: room.lastActiveAt
  })));
  await context.secrets.store(collaborationRoomSecretsKey, JSON.stringify(Object.fromEntries(
    rooms.map((room) => [room.roomId, { relayToken: room.relayToken, encryptionKey: room.encryptionKey }])
  )));
  return rooms;
}

export function buildCollaborationInviteUrl(room: Pick<CollaborationRoomRecord, 'roomId' | 'relayToken' | 'encryptionKey'>, language: string): string {
  const localePath = language === 'en' ? '' : '/zh';
  return `${collaborationSiteOrigin}${localePath}/room/${encodeURIComponent(room.roomId)}?token=${encodeURIComponent(room.relayToken)}#${room.encryptionKey}`;
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

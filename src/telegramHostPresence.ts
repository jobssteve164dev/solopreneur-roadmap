import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isProcessOwnerAlive, readProcessBirthMarker } from './processIdentity';

export type TelegramHostPresence = { hostId: string; pid: number; birth: string; updatedAt: string };

function digest(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }

export function telegramHostPresenceRoot(): string {
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : digest(os.homedir()).slice(0, 16);
  return path.join(os.tmpdir(), `solomap-telegram-host-presence-${user}`);
}

function rootDirectory(globalDataPath: string, basePath: string): string {
  return path.join(basePath, digest(path.resolve(globalDataPath)));
}

function hostFile(root: string, hostId: string): string { return path.join(root, `${hostId}.json`); }

type CoordinationContender = { token: string; pid: number; birth: string; choosing: boolean; ticket: number };

function writeCoordinationContender(root: string, value: CoordinationContender): void {
  const target = path.join(root, `.coordination.${value.token}.json`);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

function readCoordinationContenders(root: string, ownToken: string): CoordinationContender[] {
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return []; }
  const values: CoordinationContender[] = [];
  for (const name of names) {
    const match = /^\.coordination\.([a-f0-9-]+)\.json$/i.exec(name);
    if (!match) continue;
    const file = path.join(root, name);
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CoordinationContender>;
      if (value.token !== match[1] || !Number.isInteger(value.pid) || Number(value.pid) < 1 || !Number.isInteger(value.ticket)) continue;
      if (value.token !== ownToken && !isProcessOwnerAlive(Number(value.pid), String(value.birth || ''))) {
        fs.unlinkSync(file);
        continue;
      }
      values.push(value as CoordinationContender);
    } catch { /* an atomic writer or another contender owns cleanup */ }
  }
  return values;
}

export async function withTelegramHostPresenceLock<T>(globalDataPath: string, action: () => Promise<T> | T, basePath = telegramHostPresenceRoot()): Promise<T> {
  const root = rootDirectory(globalDataPath, basePath);
  const token = crypto.randomUUID();
  const birth = readProcessBirthMarker(process.pid);
  const contenderFile = path.join(root, `.coordination.${token}.json`);
  fs.mkdirSync(root, { recursive: true });
  try {
    writeCoordinationContender(root, { token, pid: process.pid, birth, choosing: true, ticket: 0 });
    const ticket = Math.max(0, ...readCoordinationContenders(root, token).map(value => value.ticket)) + 1;
    writeCoordinationContender(root, { token, pid: process.pid, birth, choosing: false, ticket });
    for (;;) {
      const blocked = readCoordinationContenders(root, token).some(value => value.token !== token
        && (value.choosing || value.ticket < ticket || (value.ticket === ticket && value.token < token)));
      if (!blocked) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return await action();
  } finally {
    try { fs.unlinkSync(contenderFile); } catch { /* a crashed contender is reclaimed by the next waiter */ }
    try { if (fs.readdirSync(root).length === 0) fs.rmdirSync(root); } catch { /* another host registered */ }
    try { if (fs.readdirSync(basePath).length === 0) fs.rmdirSync(basePath); } catch { /* another root remains */ }
  }
}

function live(value: Partial<TelegramHostPresence>, modifiedAt: number, now: number): boolean {
  if (!value.hostId || !Number.isInteger(value.pid) || Number(value.pid) < 1) return false;
  return now - modifiedAt <= 90_000 && isProcessOwnerAlive(Number(value.pid), String(value.birth || ''));
}

function activeHosts(root: string, now: number): number {
  let names: string[];
  try { names = fs.readdirSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  let count = 0;
  for (const name of names) {
    const file = path.join(root, name);
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (!/^[a-f0-9-]+\.json$/i.test(name)) {
        if (name.endsWith('.tmp') && now - info.mtimeMs > 90_000) fs.unlinkSync(file);
        continue;
      }
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TelegramHostPresence>;
      if (live(value, info.mtimeMs, now)) count += 1;
      else fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try { if (now - fs.lstatSync(file).mtimeMs > 90_000) fs.unlinkSync(file); } catch { /* a concurrent host owns cleanup */ }
      }
    }
  }
  return count;
}

export function countTelegramHostPresence(globalDataPath: string, basePath = telegramHostPresenceRoot(), now = Date.now()): number {
  return activeHosts(rootDirectory(globalDataPath, basePath), now);
}

export function registerTelegramHostPresence(globalDataPath: string, presence: TelegramHostPresence, basePath = telegramHostPresenceRoot(), now = Date.now()): Promise<number> {
  return withTelegramHostPresenceLock(globalDataPath, () => {
    const root = rootDirectory(globalDataPath, basePath);
    const target = hostFile(root, presence.hostId);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ ...presence, updatedAt: new Date(now).toISOString() }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
    return activeHosts(root, now);
  }, basePath);
}

export function releaseTelegramHostPresence(globalDataPath: string, hostId: string, basePath = telegramHostPresenceRoot(), now = Date.now()): Promise<number> {
  return withTelegramHostPresenceLock(globalDataPath, () => {
    const root = rootDirectory(globalDataPath, basePath);
    try { fs.unlinkSync(hostFile(root, hostId)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return activeHosts(root, now);
  }, basePath);
}

export function releaseTelegramHostPresenceAndRunWhenEmpty(globalDataPath: string, hostId: string, action: () => Promise<void> | void, basePath = telegramHostPresenceRoot(), now = Date.now()): Promise<number> {
  return withTelegramHostPresenceLock(globalDataPath, async () => {
    const root = rootDirectory(globalDataPath, basePath);
    try { fs.unlinkSync(hostFile(root, hostId)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const count = activeHosts(root, now);
    if (count === 0) await action();
    return count;
  }, basePath);
}

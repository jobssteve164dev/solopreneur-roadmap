import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isProcessOwnerAlive, readProcessBirthMarker } from './processIdentity';

export type TelegramChannelLeaseOwner = { leaseId: string; pid: number; birth: string; dataRootHash: string; globalDataPath: string; acquiredAt: string };

export type TelegramChannelLease = {
  tokenHash: string;
  takeTakeoverRequest(): TelegramChannelLeaseOwner | null;
  release(): boolean;
};

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function telegramChannelLeaseRoot(): string {
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : digest(os.homedir()).slice(0, 16);
  return path.join(os.tmpdir(), `solomap-telegram-channel-leases-${user}`);
}

function readOwner(lockPath: string): TelegramChannelLeaseOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as Partial<TelegramChannelLeaseOwner>;
    if (!value.leaseId || !Number.isInteger(value.pid) || Number(value.pid) < 1 || !value.birth || !value.dataRootHash) return null;
    if (!value.globalDataPath) return null;
    return value as TelegramChannelLeaseOwner;
  } catch { return null; }
}

function reclaimable(lockPath: string, owner: TelegramChannelLeaseOwner | null, now: number): boolean {
  if (owner) return !isProcessOwnerAlive(owner.pid, owner.birth);
  try { return now - fs.statSync(lockPath).mtimeMs > 90_000; }
  catch { return false; }
}

function ownerlessIdentity(lockPath: string, now: number): string | null {
  try {
    const value = fs.statSync(lockPath);
    if (now - value.mtimeMs <= 90_000) return null;
    return digest(`${value.dev}:${value.ino}:${value.ctimeMs}:${value.mtimeMs}`);
  } catch { return null; }
}

function removeOwnedLeaseDirectory(lockPath: string): void {
  const takeoverFile = path.join(lockPath, 'takeover.json');
  try { fs.unlinkSync(takeoverFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const ownerFile = path.join(lockPath, 'owner.json');
  try { fs.unlinkSync(ownerFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  fs.rmdirSync(lockPath);
}

export function claimTelegramChannelLease(botToken: string, globalDataPath: string, basePath = telegramChannelLeaseRoot(), now = Date.now()): TelegramChannelLease | null {
  const tokenHash = digest(botToken);
  const lockPath = path.join(basePath, tokenHash);
  fs.mkdirSync(basePath, { recursive: true });
  const leaseId = crypto.randomUUID();
  const owner: TelegramChannelLeaseOwner = { leaseId, pid: process.pid, birth: readProcessBirthMarker(process.pid), dataRootHash: digest(path.resolve(globalDataPath)), globalDataPath: path.resolve(globalDataPath), acquiredAt: new Date(now).toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidatePath = `${lockPath}.candidate-${leaseId}`;
    try {
      fs.mkdirSync(candidatePath, { mode: 0o700 });
      fs.writeFileSync(path.join(candidatePath, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      try { fs.renameSync(candidatePath, lockPath); }
      catch (error) {
        try { removeOwnedLeaseDirectory(candidatePath); } catch { /* this process owns only this candidate */ }
        if (!fs.existsSync(lockPath)) throw error;
      }
      if (readOwner(lockPath)?.leaseId !== leaseId) throw Object.assign(new Error('telegram_channel_lease_exists'), { code: 'EEXIST' });
      let released = false;
      return {
        tokenHash,
        takeTakeoverRequest() {
          const current = readOwner(lockPath);
          if (current?.leaseId !== leaseId) return null;
          const takeoverFile = path.join(lockPath, 'takeover.json');
          try {
            const request = JSON.parse(fs.readFileSync(takeoverFile, 'utf8')) as TelegramChannelLeaseOwner;
            fs.unlinkSync(takeoverFile);
            const requesterIsLive = request.birth
              ? isProcessOwnerAlive(request.pid, request.birth)
              : Date.now() - Date.parse(request.acquiredAt) <= 90_000 && isProcessOwnerAlive(request.pid);
            return requesterIsLive && request.globalDataPath && digest(path.resolve(request.globalDataPath)) === request.dataRootHash ? request : null;
          } catch {
            try { fs.unlinkSync(takeoverFile); } catch { /* a later request replaced it */ }
            return null;
          }
        },
        release() {
          if (released) return true;
          const current = readOwner(lockPath);
          if (current?.leaseId !== leaseId) { released = true; return true; }
          const retiredPath = `${lockPath}.retired-${leaseId}`;
          try {
            fs.renameSync(lockPath, retiredPath);
            released = true;
            try { removeOwnedLeaseDirectory(retiredPath); } catch { /* the canonical lease is already released */ }
            try { fs.rmdirSync(basePath); } catch { /* another channel still owns a lease */ }
            return true;
          } catch {
            if (readOwner(lockPath)?.leaseId !== leaseId) { released = true; return true; }
            return false;
          }
        }
      };
    } catch (error) {
      try { if (fs.existsSync(candidatePath)) removeOwnedLeaseDirectory(candidatePath); } catch { /* this process owns only this candidate */ }
      if (!fs.existsSync(lockPath)) throw error;
      const current = readOwner(lockPath);
      if (!reclaimable(lockPath, current, now)) return null;
      const observedIdentity = current?.leaseId || ownerlessIdentity(lockPath, now);
      if (!observedIdentity) return null;
      const reclaimPath = `${lockPath}.reclaim-${observedIdentity}`;
      let ownsReclaim = false;
      try {
        fs.mkdirSync(reclaimPath, { mode: 0o700 });
        ownsReclaim = true;
        const verified = readOwner(lockPath);
        const verifiedIdentity = verified?.leaseId || ownerlessIdentity(lockPath, now);
        if (verifiedIdentity === observedIdentity && reclaimable(lockPath, verified, now)) {
          const stalePath = `${lockPath}.stale-${observedIdentity}`;
          fs.renameSync(lockPath, stalePath);
          try { removeOwnedLeaseDirectory(stalePath); } catch { /* renamed stale leases cannot own the channel */ }
        }
        fs.rmdirSync(reclaimPath);
      } catch {
        if (ownsReclaim) try { if (fs.existsSync(reclaimPath) && fs.readdirSync(reclaimPath).length === 0) fs.rmdirSync(reclaimPath); } catch { /* a failed reclaim remains retryable */ }
      }
    }
  }
  return null;
}

export function readTelegramChannelLeaseOwner(botToken: string, basePath = telegramChannelLeaseRoot()): TelegramChannelLeaseOwner | null {
  const owner = readOwner(path.join(basePath, digest(botToken)));
  return owner && digest(path.resolve(owner.globalDataPath)) === owner.dataRootHash ? owner : null;
}

export function requestTelegramChannelTakeover(botToken: string, globalDataPath: string, basePath = telegramChannelLeaseRoot()): boolean {
  const lockPath = path.join(basePath, digest(botToken));
  const owner = readTelegramChannelLeaseOwner(botToken, basePath);
  if (!owner || owner.dataRootHash === digest(path.resolve(globalDataPath))) return false;
  const request: TelegramChannelLeaseOwner = {
    leaseId: crypto.randomUUID(), pid: process.pid, birth: readProcessBirthMarker(process.pid),
    dataRootHash: digest(path.resolve(globalDataPath)), globalDataPath: path.resolve(globalDataPath), acquiredAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(path.join(lockPath, 'takeover.json'), JSON.stringify(request), { mode: 0o600 });
    return true;
  } catch { return false; }
}

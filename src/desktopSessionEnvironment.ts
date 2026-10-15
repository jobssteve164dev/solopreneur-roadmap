import * as fs from 'fs';
import * as path from 'path';

function liveKeyringControlRoot(runtimeRoot: string): string {
  if (!runtimeRoot) return '';
  const keyringRoot = path.join(runtimeRoot, 'keyring');
  try {
    return fs.statSync(path.join(keyringRoot, 'control')).isSocket() ? keyringRoot : '';
  } catch {
    return '';
  }
}

export function desktopSessionEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  if (environment.DBUS_SESSION_BUS_ADDRESS) {
    result.DBUS_SESSION_BUS_ADDRESS = environment.DBUS_SESSION_BUS_ADDRESS;
  }
  if (environment.GNOME_KEYRING_CONTROL) {
    result.GNOME_KEYRING_CONTROL = environment.GNOME_KEYRING_CONTROL;
    return result;
  }
  const runtimeRoots = [String(environment.XDG_RUNTIME_DIR || '')];
  if (typeof process.getuid === 'function') runtimeRoots.push(`/run/user/${process.getuid()}`);
  for (const runtimeRoot of new Set(runtimeRoots)) {
    const keyringRoot = liveKeyringControlRoot(runtimeRoot);
    if (keyringRoot) {
      result.GNOME_KEYRING_CONTROL = keyringRoot;
      break;
    }
  }
  return result;
}

export function withDesktopSessionEnvironment(environment?: Record<string, string>): Record<string, string> {
  return { ...desktopSessionEnvironment(), ...(environment || {}) };
}

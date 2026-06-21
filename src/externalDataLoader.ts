export interface ExternalDataLoadOptions {
  force?: boolean;
  minIntervalMs?: number;
}

interface ExternalDataEntry<T> {
  inFlight?: Promise<T>;
  value?: T;
  hasValue: boolean;
  completedAt: number;
}

export class ExternalDataLoadCoordinator {
  private readonly entries = new Map<string, ExternalDataEntry<unknown>>();
  private readonly defaultMinIntervalMs: number;

  constructor(options: { defaultMinIntervalMs?: number } = {}) {
    this.defaultMinIntervalMs = Math.max(0, Number(options.defaultMinIntervalMs || 60_000));
  }

  load<T>(key: string, load: () => Promise<T>, options: ExternalDataLoadOptions = {}): Promise<T> {
    const normalizedKey = String(key || '').trim();
    const entry = this.getEntry<T>(normalizedKey);
    if (entry.inFlight) {
      return entry.inFlight as Promise<T>;
    }

    const minIntervalMs = Math.max(0, Number(options.minIntervalMs ?? this.defaultMinIntervalMs));
    const freshEnough = entry.hasValue && Date.now() - entry.completedAt < minIntervalMs;
    if (!options.force && freshEnough) {
      return Promise.resolve(entry.value as T);
    }

    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        entry.value = value;
        entry.hasValue = true;
        entry.completedAt = Date.now();
        return value;
      })
      .finally(() => {
        entry.inFlight = undefined;
      });
    entry.inFlight = promise;
    return promise;
  }

  invalidate(key: string): void {
    this.entries.delete(String(key || '').trim());
  }

  invalidatePrefix(prefix: string): void {
    const normalizedPrefix = String(prefix || '').trim();
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(normalizedPrefix)) {
        this.entries.delete(key);
      }
    }
  }

  private getEntry<T>(key: string): ExternalDataEntry<T> {
    const existing = this.entries.get(key) as ExternalDataEntry<T> | undefined;
    if (existing) {
      return existing;
    }
    const entry: ExternalDataEntry<T> = {
      hasValue: false,
      completedAt: 0
    };
    this.entries.set(key, entry as ExternalDataEntry<unknown>);
    return entry;
  }
}

export function buildExternalDataKey(scope: string, projectPath = ''): string {
  return `${String(scope || '').trim()}::${String(projectPath || '').trim()}`;
}

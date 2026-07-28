export interface WorkSession {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface WorkHabitStats {
  schemaVersion: number;
  observedSessionCount: number;
  excludedSessionCount: number;
  activeDayCount: number;
  currentStreakDays: number;
  longestStreakDays: number;
  averageSessionDurationMs: number;
  medianSessionDurationMs: number;
  averageDailyDurationMs: number;
  longestSessionDurationMs: number;
  preferredStartHour: number | null;
  preferredWeekday: number | null;
  sessionsByStartHour: number[];
  sessionsByWeekday: number[];
}

// A single unattended terminal is not evidence of continuous work. Longer records
// remain in the run ledger, but are excluded from effort and habit calculations.
export const MAX_TRUSTED_WORK_SESSION_MS = 12 * 60 * 60 * 1000;

export function getTrustedWorkDurationMs(session: WorkSession): number | null {
  const durationMs = Number(session.durationMs);
  const startedAtMs = Date.parse(String(session.startedAt || ''));
  const finishedAtMs = Date.parse(String(session.finishedAt || ''));
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_TRUSTED_WORK_SESSION_MS) {
    return null;
  }
  if (Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)) {
    if (finishedAtMs < startedAtMs || durationMs > finishedAtMs - startedAtMs + 5 * 60 * 1000) {
      return null;
    }
  }
  return durationMs;
}

function dayKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function localDayNumber(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / (24 * 60 * 60 * 1000));
}

function streakLengths(sortedDayKeys: string[], todayKey: string): { current: number; longest: number } {
  if (sortedDayKeys.length === 0) return { current: 0, longest: 0 };
  let longest = 1;
  let running = 1;
  for (let index = 1; index < sortedDayKeys.length; index += 1) {
    const previous = localDayNumber(sortedDayKeys[index - 1]);
    const current = localDayNumber(sortedDayKeys[index]);
    running = current - previous === 1 ? running + 1 : 1;
    longest = Math.max(longest, running);
  }
  const latest = sortedDayKeys[sortedDayKeys.length - 1];
  const current = localDayNumber(todayKey) - localDayNumber(latest) <= 1 ? running : 0;
  return { current, longest };
}

export function buildWorkHabitStats(sessions: WorkSession[], now = new Date()): WorkHabitStats {
  const durations: number[] = [];
  const durationByDay = new Map<string, number>();
  const sessionsByStartHour = Array.from({ length: 24 }, () => 0);
  const sessionsByWeekday = Array.from({ length: 7 }, () => 0);
  let excludedSessionCount = 0;

  for (const session of sessions) {
    const durationMs = getTrustedWorkDurationMs(session);
    const startedAtMs = Date.parse(String(session.startedAt || ''));
    if (durationMs === null || !Number.isFinite(startedAtMs)) {
      excludedSessionCount += 1;
      continue;
    }
    const start = new Date(startedAtMs);
    durations.push(durationMs);
    const key = dayKey(startedAtMs);
    durationByDay.set(key, (durationByDay.get(key) || 0) + durationMs);
    sessionsByStartHour[start.getHours()] += 1;
    sessionsByWeekday[start.getDay()] += 1;
  }

  const sortedDurations = durations.slice().sort((a, b) => a - b);
  const middle = Math.floor(sortedDurations.length / 2);
  const medianSessionDurationMs = sortedDurations.length === 0
    ? 0
    : sortedDurations.length % 2 === 1
      ? sortedDurations[middle]
      : Math.round((sortedDurations[middle - 1] + sortedDurations[middle]) / 2);
  const totalDurationMs = durations.reduce((sum, durationMs) => sum + durationMs, 0);
  const activeDays = [...durationByDay.keys()].sort();
  const streaks = streakLengths(activeDays, dayKey(now.getTime()));
  const maxIndex = (values: number[]): number | null => {
    const max = Math.max(...values);
    return max > 0 ? values.indexOf(max) : null;
  };

  return {
    schemaVersion: 1,
    observedSessionCount: durations.length,
    excludedSessionCount,
    activeDayCount: activeDays.length,
    currentStreakDays: streaks.current,
    longestStreakDays: streaks.longest,
    averageSessionDurationMs: durations.length > 0 ? Math.round(totalDurationMs / durations.length) : 0,
    medianSessionDurationMs,
    averageDailyDurationMs: activeDays.length > 0 ? Math.round(totalDurationMs / activeDays.length) : 0,
    longestSessionDurationMs: sortedDurations.length > 0 ? sortedDurations[sortedDurations.length - 1] : 0,
    preferredStartHour: maxIndex(sessionsByStartHour),
    preferredWeekday: maxIndex(sessionsByWeekday),
    sessionsByStartHour,
    sessionsByWeekday
  };
}

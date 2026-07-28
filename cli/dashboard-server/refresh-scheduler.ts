/**
 * Fires the keyword refresh once a day at a wall-clock time in a chosen
 * timezone.
 *
 * The server previously had no scheduler at all: it refreshed once at startup
 * (if configured to) and otherwise only when something called
 * POST /api/aso/refresh/start. That put the clock outside the application, so
 * the database was only as fresh as whatever remembered to poke it.
 *
 * Deliberately dependency-free. One daily timer does not justify a cron
 * library, and `Intl` already knows every timezone rule including DST.
 */

export type RefreshSchedulerState = {
  enabled: boolean;
  dailyAt: string | null;
  timeZone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

type RefreshSchedulerDeps = {
  /** "HH:MM" in 24-hour form. Null or empty disables the scheduler. */
  dailyAt: string | null;
  /** IANA timezone, e.g. "Europe/Prague". */
  timeZone: string;
  /** Starts a refresh. Must be safe to call when one is already running. */
  run: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  onError?: (error: unknown, metadata: Record<string, unknown>) => void;
};

export type RefreshScheduler = {
  start: () => void;
  stop: () => void;
  getState: () => RefreshSchedulerState;
};

/** setTimeout overflows past ~24.8 days and fires immediately. */
const MAX_TIMER_MS = 2_147_483_647;

export function parseDailyTime(
  value: string | null | undefined
): { hours: number; minutes: number } | null {
  if (!value) return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getZonedParts(timestamp: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp));

  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type)?.value ?? "0";
    // Intl renders midnight as hour 24 in some locales/versions.
    return Number(found) % (type === "hour" ? 24 : Number.MAX_SAFE_INTEGER);
  };

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Offset of `timeZone` from UTC at a given instant, in milliseconds. */
function getZoneOffsetMs(timestamp: number, timeZone: string): number {
  const parts = getZonedParts(timestamp, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - timestamp;
}

/**
 * The UTC instant at which the given local wall-clock time occurs.
 *
 * Iterates because the offset depends on the instant we are trying to find:
 * a first guess can land on the wrong side of a DST transition, and applying
 * the offset found there corrects it.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  timeZone: string
): number {
  const naive = Date.UTC(year, month - 1, day, hours, minutes, 0);
  let timestamp = naive;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = getZoneOffsetMs(timestamp, timeZone);
    const corrected = naive - offset;
    if (corrected === timestamp) break;
    timestamp = corrected;
  }
  return timestamp;
}

/**
 * Next occurrence of `dailyAt` strictly after `from`.
 *
 * Checks today and the following two days rather than assuming +24h: on a DST
 * transition a day is 23 or 25 hours long, and a wall-clock time that does not
 * exist that day resolves to the next valid instant.
 */
export function getNextRunTimestamp(
  from: number,
  dailyAt: { hours: number; minutes: number },
  timeZone: string
): number {
  const today = getZonedParts(from, timeZone);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const candidateDay = new Date(
      Date.UTC(today.year, today.month - 1, today.day + dayOffset)
    );
    const candidate = zonedTimeToUtc(
      candidateDay.getUTCFullYear(),
      candidateDay.getUTCMonth() + 1,
      candidateDay.getUTCDate(),
      dailyAt.hours,
      dailyAt.minutes,
      timeZone
    );
    if (candidate > from) return candidate;
  }
  // Unreachable in practice; keeps the return type honest.
  return from + 24 * 60 * 60 * 1000;
}

export function createRefreshScheduler(
  deps: RefreshSchedulerDeps
): RefreshScheduler {
  const now = () => deps.now?.() ?? Date.now();
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    deps.clearTimer ?? ((timer: NodeJS.Timeout) => clearTimeout(timer));

  const dailyAt = parseDailyTime(deps.dailyAt);
  const timeZone = deps.timeZone;

  let timer: NodeJS.Timeout | null = null;
  let nextRunAt: number | null = null;
  let lastRunAt: number | null = null;
  let stopped = false;

  const scheduleNext = (): void => {
    if (stopped || !dailyAt) return;
    const target = getNextRunTimestamp(now(), dailyAt, timeZone);
    nextRunAt = target;
    const delay = Math.max(0, target - now());
    // Long delays are chunked so a >24 day wait cannot overflow the timer.
    const chunk = Math.min(delay, MAX_TIMER_MS);
    timer = setTimer(() => {
      if (stopped) return;
      if (now() < target) {
        scheduleNext();
        return;
      }
      lastRunAt = now();
      try {
        deps.run();
      } catch (error) {
        deps.onError?.(error, { phase: "scheduled-refresh" });
      }
      scheduleNext();
    }, chunk);
    timer.unref?.();
  };

  return {
    start: () => {
      if (!dailyAt) return;
      stopped = false;
      if (timer) return;
      scheduleNext();
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      nextRunAt = null;
    },
    getState: () => ({
      enabled: dailyAt != null,
      dailyAt: deps.dailyAt?.trim() || null,
      timeZone,
      nextRunAt: nextRunAt == null ? null : new Date(nextRunAt).toISOString(),
      lastRunAt: lastRunAt == null ? null : new Date(lastRunAt).toISOString(),
    }),
  };
}

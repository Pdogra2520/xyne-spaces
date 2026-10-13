// Working-hours notification schedule ("Availability").
//
// A user can set the days and hours they want to be notified. Outside those
// hours, channel notifications are muted until the next window starts; 1:1 DMs,
// group DMs and incoming calls are NOT gated by this schedule (the caller
// decides which paths to apply it to — see notificationFilterService).
//
// Shared between the client and server Zero mutators (validation) and the
// backend notification filter (evaluation), so all sides agree on the rules.
//
// All wall-clock math is done in the user's own saved IANA time zone via
// Intl.DateTimeFormat. Nothing here assumes a fixed zone, and daylight-saving
// changes are handled because we always compare local wall-clock time.

export const NOTIFICATION_SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MAX_NOTIFICATION_SCHEDULE_TIMEZONE_LENGTH = 100;

/** One working window. `day` is 0 = Sunday … 6 = Saturday, in the user's zone. */
export interface NotificationScheduleDay {
  day: number;
  /** "HH:mm", 24-hour, inclusive. */
  start: string;
  /** "HH:mm", 24-hour, exclusive. If end < start the window runs overnight into the next day. */
  end: string;
}

export interface NotificationSchedule {
  enabled: boolean;
  days: NotificationScheduleDay[];
  /** IANA time zone the user configured, e.g. "America/New_York". */
  timeZone: string;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
  if (timeZone.length > MAX_NOTIFICATION_SCHEDULE_TIMEZONE_LENGTH) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Validate and normalise a schedule. Throws a descriptive Error on invalid
 * input — the mutators rely on this to reject bad writes on both client and
 * server. Days are de-duplicated (one window per day) and sorted.
 */
export function normalizeNotificationSchedule(raw: NotificationSchedule): NotificationSchedule {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid notification schedule');
  if (typeof raw.enabled !== 'boolean') throw new Error('Notification schedule "enabled" must be a boolean');
  if (!isValidTimeZone(raw.timeZone)) throw new Error(`Invalid time zone: ${String(raw.timeZone)}`);
  if (!Array.isArray(raw.days)) throw new Error('Notification schedule "days" must be an array');

  const seen = new Set<number>();
  const days: NotificationScheduleDay[] = [];
  for (const entry of raw.days) {
    const { day, start, end } = entry ?? ({} as NotificationScheduleDay);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error(`Invalid day: ${String(day)}`);
    if (typeof start !== 'string' || !NOTIFICATION_SCHEDULE_TIME_PATTERN.test(start)) {
      throw new Error(`Invalid start time: ${String(start)}`);
    }
    if (typeof end !== 'string' || !NOTIFICATION_SCHEDULE_TIME_PATTERN.test(end)) {
      throw new Error(`Invalid end time: ${String(end)}`);
    }
    if (start === end) throw new Error('Start and end time must differ');
    if (seen.has(day)) throw new Error(`Duplicate day: ${day}`);
    seen.add(day);
    days.push({ day, start, end });
  }
  if (raw.enabled && days.length === 0) {
    throw new Error('An enabled notification schedule needs at least one day');
  }
  days.sort((a, b) => a.day - b.day);
  return { enabled: raw.enabled, days, timeZone: raw.timeZone };
}

/**
 * Parse the stored stringified-JSON schedule. Returns null for empty,
 * malformed or invalid values — callers treat null as "always notify", so a
 * corrupt row can never silently mute someone.
 */
export function parseNotificationSchedule(
  value: string | null | undefined,
): NotificationSchedule | null {
  if (!value) return null;
  try {
    return normalizeNotificationSchedule(JSON.parse(value));
  } catch {
    return null;
  }
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Day of week (0–6) and minute of day (0–1439) for `now` in `timeZone`. */
export function getZonedDayAndMinute(now: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const day = WEEKDAY_INDEX[get('weekday')];
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return { day, minute: hour * 60 + minute };
}

/**
 * True when `now` falls outside every working window of an ACTIVE schedule.
 * A missing, disabled or empty schedule always returns false (= notify).
 * Windows where end < start run overnight: e.g. Mon 22:00–06:00 covers
 * Monday from 22:00 and Tuesday until 06:00.
 */
export function isOutsideWorkingHours(
  schedule: NotificationSchedule | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!schedule || !schedule.enabled || schedule.days.length === 0) return false;
  if (!isValidTimeZone(schedule.timeZone)) return false;

  const { day, minute } = getZonedDayAndMinute(now, schedule.timeZone);
  const previousDay = (day + 6) % 7;

  for (const window of schedule.days) {
    const start = toMinutes(window.start);
    const end = toMinutes(window.end);
    if (start < end) {
      if (window.day === day && minute >= start && minute < end) return false;
    } else {
      // Overnight window.
      if (window.day === day && minute >= start) return false;
      if (window.day === previousDay && minute < end) return false;
    }
  }
  return true;
}

/**
 * The next working-window start after `now`, in the user's zone — used by the
 * UI for "Channel notifications muted until 09:00". Returns null when the
 * schedule is inactive.
 */
export function getNextWorkingHoursStart(
  schedule: NotificationSchedule | null | undefined,
  now: Date = new Date(),
): { day: number; start: string } | null {
  if (!schedule || !schedule.enabled || schedule.days.length === 0) return null;
  if (!isValidTimeZone(schedule.timeZone)) return null;

  const { day, minute } = getZonedDayAndMinute(now, schedule.timeZone);
  for (let offset = 0; offset <= 7; offset++) {
    const candidateDay = (day + offset) % 7;
    const window = schedule.days.find(d => d.day === candidateDay);
    if (!window) continue;
    if (offset === 0 && toMinutes(window.start) <= minute) continue;
    return { day: candidateDay, start: window.start };
  }
  return null;
}

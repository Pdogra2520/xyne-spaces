import test from 'node:test';
import assert from 'node:assert/strict';

// Imports the BUILT output, like the other tests in this folder.
// Run via `pnpm --filter @xyne/shared test` (builds first).
import {
  isOutsideWorkingHours,
  getNextWorkingHoursStart,
  normalizeNotificationSchedule,
  parseNotificationSchedule,
} from '../dist/utils/notificationSchedule.js';

const weekdays = (start, end, timeZone) => ({
  enabled: true,
  timeZone,
  days: [1, 2, 3, 4, 5].map(day => ({ day, start, end })),
});

// 2026-10-13 is a Tuesday.
const at = iso => new Date(iso);

test('inside and outside weekday hours in the configured zone (IST)', () => {
  const s = weekdays('09:00', '18:00', 'Asia/Kolkata');
  // 10:00 IST Tue = 04:30Z
  assert.equal(isOutsideWorkingHours(s, at('2026-10-13T04:30:00Z')), false);
  // 08:59 IST Tue = 03:29Z
  assert.equal(isOutsideWorkingHours(s, at('2026-10-13T03:29:00Z')), true);
  // 18:00 IST is exclusive end = 12:30Z
  assert.equal(isOutsideWorkingHours(s, at('2026-10-13T12:30:00Z')), true);
  // Saturday 10:00 IST
  assert.equal(isOutsideWorkingHours(s, at('2026-10-17T04:30:00Z')), true);
});

test('uses the saved zone, not a hard-coded one (US zone)', () => {
  const s = weekdays('09:00', '17:00', 'America/New_York');
  // 10:00 EDT Tue = 14:00Z — inside for New York, but would be 19:30 IST
  assert.equal(isOutsideWorkingHours(s, at('2026-10-13T14:00:00Z')), false);
  // 04:30Z Tue = 00:30 EDT Tue — outside for New York, but 10:00 IST
  assert.equal(isOutsideWorkingHours(s, at('2026-10-13T04:30:00Z')), true);
});

test('daylight-saving changeover keeps local wall-clock hours', () => {
  const s = weekdays('09:00', '17:00', 'America/New_York');
  // Fri 30 Oct 2026, EDT (UTC-4): 09:30 local = 13:30Z
  assert.equal(isOutsideWorkingHours(s, at('2026-10-30T13:30:00Z')), false);
  // Mon 2 Nov 2026, EST (UTC-5) after DST ends 1 Nov: 13:30Z = 08:30 local → outside
  assert.equal(isOutsideWorkingHours(s, at('2026-11-02T13:30:00Z')), true);
  // 14:30Z = 09:30 EST → inside
  assert.equal(isOutsideWorkingHours(s, at('2026-11-02T14:30:00Z')), false);
});

test('overnight windows span into the next day', () => {
  const s = { enabled: true, timeZone: 'UTC', days: [{ day: 1, start: '22:00', end: '06:00' }] };
  assert.equal(isOutsideWorkingHours(s, at('2026-10-12T23:00:00Z')), false); // Mon 23:00
  assert.equal(isOutsideWorkingHours(s, at('2026-10-13T05:59:00Z')), false); // Tue 05:59
  assert.equal(isOutsideWorkingHours(s, at('2026-10-13T06:00:00Z')), true);  // Tue 06:00
  assert.equal(isOutsideWorkingHours(s, at('2026-10-12T21:00:00Z')), true);  // Mon 21:00
});

test('missing, disabled or invalid schedules always notify', () => {
  assert.equal(isOutsideWorkingHours(null), false);
  assert.equal(isOutsideWorkingHours({ ...weekdays('09:00', '18:00', 'UTC'), enabled: false }), false);
  assert.equal(parseNotificationSchedule('not json'), null);
  assert.equal(parseNotificationSchedule(JSON.stringify({ enabled: true, timeZone: 'Mars/Base', days: [] })), null);
  assert.equal(parseNotificationSchedule(null), null);
});

test('normalize validates input', () => {
  assert.throws(() => normalizeNotificationSchedule({ enabled: true, timeZone: 'UTC', days: [{ day: 7, start: '09:00', end: '10:00' }] }));
  assert.throws(() => normalizeNotificationSchedule({ enabled: true, timeZone: 'UTC', days: [{ day: 1, start: '9:00', end: '10:00' }] }));
  assert.throws(() => normalizeNotificationSchedule({ enabled: true, timeZone: 'UTC', days: [{ day: 1, start: '09:00', end: '09:00' }] }));
  assert.throws(() => normalizeNotificationSchedule({ enabled: true, timeZone: 'UTC', days: [{ day: 1, start: '09:00', end: '10:00' }, { day: 1, start: '11:00', end: '12:00' }] }));
  assert.throws(() => normalizeNotificationSchedule({ enabled: true, timeZone: 'Nope/Zone', days: [{ day: 1, start: '09:00', end: '10:00' }] }));
  assert.throws(() => normalizeNotificationSchedule({ enabled: true, timeZone: 'UTC', days: [] }));
  const ok = normalizeNotificationSchedule({ enabled: true, timeZone: 'Europe/London', days: [{ day: 3, start: '09:00', end: '17:00' }, { day: 1, start: '09:00', end: '17:00' }] });
  assert.deepEqual(ok.days.map(d => d.day), [1, 3]);
});

test('next working-hours start', () => {
  const s = weekdays('09:00', '18:00', 'Asia/Kolkata');
  // Tue 20:00 IST → Wed 09:00
  assert.deepEqual(getNextWorkingHoursStart(s, at('2026-10-13T14:30:00Z')), { day: 3, start: '09:00' });
  // Tue 07:00 IST → Tue 09:00
  assert.deepEqual(getNextWorkingHoursStart(s, at('2026-10-13T01:30:00Z')), { day: 2, start: '09:00' });
  // Fri 20:00 IST → Mon 09:00
  assert.deepEqual(getNextWorkingHoursStart(s, at('2026-10-16T14:30:00Z')), { day: 1, start: '09:00' });
});

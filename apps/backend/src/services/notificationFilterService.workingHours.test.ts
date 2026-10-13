// Working-hours gate in the notification filter (XYNE-66376).
//
// @xyne/shared ships ESM in dist/, which this CJS jest setup cannot load, so the
// root entry point is mocked with the real schedule/keyword helpers from source
// plus the two enums the filter uses.
jest.mock('@xyne/shared', () => ({
  ...jest.requireActual('../../../../packages/shared/src/utils/notificationSchedule'),
  ...jest.requireActual('../../../../packages/shared/src/utils/notificationKeywords'),
  NotificationLevel: { ALL: 'ALL', MENTIONS_ONLY: 'MENTIONS_ONLY', THREADS_ONLY: 'THREADS_ONLY', NONE: 'NONE' },
  NotificationType: { MENTION: 'MENTION', THREAD_REPLY: 'THREAD_REPLY', TICKET_ASSIGNMENT: 'TICKET_ASSIGNMENT' },
}));

const mockChannelUserStatusFindMany = jest.fn();
const mockUserPresenceFindMany = jest.fn();
const mockUserPreferenceFindMany = jest.fn();

jest.mock('@/database/client', () => ({
  DatabaseClient: {
    getInstance: () => ({
      channelUserStatus: { findMany: (...a: unknown[]) => mockChannelUserStatusFindMany(...a) },
      userPresence: { findMany: (...a: unknown[]) => mockUserPresenceFindMany(...a) },
      userPreference: { findMany: (...a: unknown[]) => mockUserPreferenceFindMany(...a) },
    }),
  },
}));
jest.mock('@/database/tenant/context', () => ({
  withWorkspaceScope: <T>(fn: () => T) => fn(),
}));

import { filterUsers, filterGlobalUsers, prefetchFilterData } from './notificationFilterService';

const USER = 'user-1';
// Mon–Fri 09:00–18:00 in the user's own zone.
const schedule = (timeZone: string) =>
  JSON.stringify({
    enabled: true,
    timeZone,
    days: [1, 2, 3, 4, 5].map(day => ({ day, start: '09:00', end: '18:00' })),
  });

function givenUser({
  notificationSchedule = null as string | null,
  pausedUntil = null as Date | null,
} = {}) {
  mockChannelUserStatusFindMany.mockResolvedValue([]);
  mockUserPresenceFindMany.mockResolvedValue([{ userId: USER, notificationsPausedUntil: pausedUntil }]);
  mockUserPreferenceFindMany.mockResolvedValue([
    {
      userId: USER,
      globalDesktopNotificationLevel: 'ALL',
      globalMobileNotificationLevel: 'ALL',
      threadReplyNotificationsEnabled: true,
      channelWideMentionsEnabled: true,
      notificationKeywords: null,
      notificationSchedule,
    },
  ]);
}

const delivered = (r: { desktopUsers: string[]; mobileUsers: string[] }) =>
  r.desktopUsers.includes(USER) && r.mobileUsers.includes(USER);
const muted = (r: { desktopUsers: string[]; mobileUsers: string[] }) =>
  r.desktopUsers.length === 0 && r.mobileUsers.length === 0;

// Tue 13 Oct 2026, 20:00 IST (= 14:30Z) — outside IST working hours.
const TUE_EVENING_IST = new Date('2026-10-13T14:30:00Z');
// Tue 13 Oct 2026, 10:00 IST (= 04:30Z) — inside IST working hours.
const TUE_MORNING_IST = new Date('2026-10-13T04:30:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

describe('working hours — channel notifications', () => {
  it('mutes channel notifications outside working hours', async () => {
    jest.setSystemTime(TUE_EVENING_IST);
    givenUser({ notificationSchedule: schedule('Asia/Kolkata') });
    expect(muted(await filterUsers([USER], 'ch-1', false, 'mention'))).toBe(true);
  });

  it('delivers channel notifications inside working hours', async () => {
    jest.setSystemTime(TUE_MORNING_IST);
    givenUser({ notificationSchedule: schedule('Asia/Kolkata') });
    expect(delivered(await filterUsers([USER], 'ch-1', false, 'mention'))).toBe(true);
  });

  it("evaluates hours in the user's saved zone, not a fixed one", async () => {
    // 14:30Z is 10:30 in New York — inside that user's hours.
    jest.setSystemTime(TUE_EVENING_IST);
    givenUser({ notificationSchedule: schedule('America/New_York') });
    expect(delivered(await filterUsers([USER], 'ch-1', false, 'mention'))).toBe(true);
  });

  it('delivers when no schedule is set or the stored value is corrupt', async () => {
    jest.setSystemTime(TUE_EVENING_IST);
    givenUser({ notificationSchedule: null });
    expect(delivered(await filterUsers([USER], 'ch-1', false, 'mention'))).toBe(true);
    givenUser({ notificationSchedule: '{not json' });
    expect(delivered(await filterUsers([USER], 'ch-1', false, 'mention'))).toBe(true);
  });

  it('applies through the prefetched path too', async () => {
    jest.setSystemTime(TUE_EVENING_IST);
    givenUser({ notificationSchedule: schedule('Asia/Kolkata') });
    const pre = await prefetchFilterData([USER], 'ch-1');
    expect(muted(await filterUsers([USER], 'ch-1', false, 'mention', {}, pre))).toBe(true);
  });
});

describe('working hours — DMs still come through', () => {
  it('delivers 1:1 DMs outside working hours', async () => {
    jest.setSystemTime(TUE_EVENING_IST);
    givenUser({ notificationSchedule: schedule('Asia/Kolkata') });
    expect(delivered(await filterUsers([USER], 'dm-1', true, 'mention'))).toBe(true);
  });

  it('delivers group DMs outside working hours', async () => {
    jest.setSystemTime(TUE_EVENING_IST);
    givenUser({ notificationSchedule: schedule('Asia/Kolkata') });
    // Group DMs arrive as isDMChannel=false, isGroupDM=true.
    expect(delivered(await filterUsers([USER], 'gdm-1', false, 'channel_message', {}, undefined, true))).toBe(true);
  });

  it('manual pause still mutes DMs', async () => {
    jest.setSystemTime(TUE_MORNING_IST);
    givenUser({
      notificationSchedule: schedule('Asia/Kolkata'),
      pausedUntil: new Date(TUE_MORNING_IST.getTime() + 60 * 60 * 1000),
    });
    expect(muted(await filterUsers([USER], 'dm-1', true, 'mention'))).toBe(true);
  });
});

describe('working hours — global (non-channel) notifications', () => {
  it('mutes outside working hours and delivers inside', async () => {
    givenUser({ notificationSchedule: schedule('Asia/Kolkata') });
    jest.setSystemTime(TUE_EVENING_IST);
    expect(muted(await filterGlobalUsers([USER], 'TICKET_ASSIGNMENT' as never, 'mention'))).toBe(true);
    jest.setSystemTime(TUE_MORNING_IST);
    expect(delivered(await filterGlobalUsers([USER], 'TICKET_ASSIGNMENT' as never, 'mention'))).toBe(true);
  });
});

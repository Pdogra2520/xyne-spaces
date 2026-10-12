import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityClassification } from '@xyne/shared';
import type { ActivityVisibilityFields } from '../utils/activityVisibility';
import { useElectronBadge } from './useElectronBadge';
import { useUnreadActivitiesCount } from './useUnreadActivitiesCount';

// The dashboard's unit tests run in a plain node environment, so run the hooks
// directly: effects fire synchronously and the state machine selector reads
// from a fixture instead of the real actor.
const store = vi.hoisted(() => ({ unreadActivities: [] as ActivityVisibilityFields[] }));

vi.mock('react', () => ({
  useMemo: <T>(factory: () => T): T => factory(),
  useEffect: (effect: () => void): void => effect(),
}));
vi.mock('@xstate/react', () => ({
  useSelector: <T>(_actor: unknown, selector: (state: unknown) => T): T =>
    selector({ context: { unreadActivities: store.unreadActivities } }),
}));
vi.mock('../machines/stateMachine', () => ({ stateMachineActor: {} }));

const fixture: ActivityVisibilityFields[] = [
  { actorAction: 'replied_v2', actionSource: 'message' }, // thread reply
  { actorAction: 'added_v2', actionSource: 'message' }, // reaction
  { actorAction: 'mentioned_user', actionSource: 'message' },
  {
    actorAction: 'direct_message',
    actionSource: 'message',
    classification: ActivityClassification.PENDING,
  },
  {
    actorAction: 'direct_message',
    actionSource: 'message',
    classification: ActivityClassification.ACTIONABLE,
  },
  {
    actorAction: 'mentioned_user',
    actionSource: 'message',
    classification: ActivityClassification.SKIP,
  },
  { actorAction: 'missed_call', actionSource: 'call' },
];

describe('useElectronBadge', () => {
  const setBadgeCount = vi.fn<(count: number) => void>();

  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: { setBadgeCount } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setBadgeCount.mockReset();
    store.unreadActivities = [];
  });

  it('sets the dock badge to the Activity bell count', () => {
    store.unreadActivities = fixture;

    useElectronBadge();

    // thread reply, reaction, mention and the ACTIONABLE DM
    expect(useUnreadActivitiesCount()).toBe(4);
    expect(setBadgeCount).toHaveBeenLastCalledWith(useUnreadActivitiesCount());
  });

  it('drops with the bell when a visible activity is read', () => {
    store.unreadActivities = fixture.slice(1);

    useElectronBadge();

    expect(setBadgeCount).toHaveBeenLastCalledWith(3);
    expect(setBadgeCount).toHaveBeenLastCalledWith(useUnreadActivitiesCount());
  });

  it('clears the badge when nothing visible is unread', () => {
    store.unreadActivities = fixture.filter(
      activity =>
        activity.classification === ActivityClassification.PENDING ||
        activity.classification === ActivityClassification.SKIP ||
        activity.actorAction === 'missed_call',
    );

    useElectronBadge();

    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it('is a no-op outside the desktop app', () => {
    vi.stubGlobal('window', {});
    store.unreadActivities = fixture;

    expect(() => useElectronBadge()).not.toThrow();
    expect(setBadgeCount).not.toHaveBeenCalled();
  });
});

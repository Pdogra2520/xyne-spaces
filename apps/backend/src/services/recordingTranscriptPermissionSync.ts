import { CallType, EntityUserAccess, ShareableEntityType } from '@xyne/shared';
import { db } from '@/database/client';
import { withWorkspaceScope } from '@/database/tenant/context';
import { vespaQueue } from '@/queues/vespaQueue';
import { fileSchema, SubApp } from '@/vespa/src/types';
import { logger } from '@/utils/logger';

/**
 * A recording's ACL is denormalized into its Vespa transcript doc: `permissions` holds
 * everyone its live shares reach (see `computeRecordingPermissions`) and `isPrivate`
 * follows its link visibility. These helpers keep both fresh by enqueuing a
 * **field-scoped** update (no transcript re-embed) whenever shares, visibility, or the
 * membership of a shared group/channel change.
 */

// Same bound as canvasPermissionSync: a channel can be shared many recordings.
const ENQUEUE_CONCURRENCY = 25;

/** Enqueue an ACL-only refresh for one recording's transcript doc. */
export async function enqueueRecordingTranscriptPermissionRefresh(
  call: { id: string; transcript: string | null; workspaceId?: string | null },
): Promise<void> {
  // No transcript means no transcript doc: a partial update would only fail.
  if (!call.transcript) return;

  await vespaQueue.addJob({
    schema: fileSchema,
    jobType: 'update',
    docId: call.id,
    app: SubApp.TRANSCRIPT,
    fields: ['permissions', 'isPrivate'],
    ...(call.workspaceId ? { workspaceId: call.workspaceId } : {}),
  });
}

/**
 * Refresh after a share command. Sharing commands address a recording by its public
 * externalId; failures are logged, never thrown, so a share is not undone by indexing.
 */
export async function refreshRecordingTranscriptPermissions(externalId: string): Promise<void> {
  try {
    // Not scoped to the actor: after a self-revoke the calls ACL no longer lets them see
    // the recording, and the refresh that drops them from `permissions` must still run.
    const call = await withWorkspaceScope(() =>
      db.call.findUnique({
        where: { externalId },
        select: { id: true, transcript: true, workspaceId: true, callType: true },
      }),
    );
    if (!call || call.callType !== CallType.HEADLESS) return;
    await enqueueRecordingTranscriptPermissionRefresh(call);
  } catch (err) {
    logger.error(`[recordingTranscriptPermissionSync] failed to enqueue refresh for recording ${externalId}: ${err}`);
  }
}

async function refreshForShares(
  where: { channelId: string } | { userGroupId: string },
  label: string,
): Promise<void> {
  // Runs after the membership row is gone, so it must not be scoped to the actor.
  const recordings = await withWorkspaceScope(async () => {
    const shares = await db.entityAccess.findMany({
      where: {
        ...where,
        shareableEntityType: ShareableEntityType.NOTE_TAKER,
        entityUserAccess: { not: EntityUserAccess.REVOKED },
      },
      select: { entityId: true },
    });
    const callIds = Array.from(new Set(shares.map(s => s.entityId)));
    if (callIds.length === 0) return [];
    return db.call.findMany({
      where: { id: { in: callIds }, callType: CallType.HEADLESS, transcript: { not: null } },
      select: { id: true, transcript: true, workspaceId: true },
    });
  });
  if (recordings.length === 0) return;

  logger.info(`[recordingTranscriptPermissionSync] refreshing ${recordings.length} recording ACL(s) for ${label}`);
  for (let i = 0; i < recordings.length; i += ENQUEUE_CONCURRENCY) {
    const chunk = recordings.slice(i, i + ENQUEUE_CONCURRENCY);
    await Promise.all(
      chunk.map(call =>
        enqueueRecordingTranscriptPermissionRefresh(call).catch(err =>
          logger.warn(`[recordingTranscriptPermissionSync] failed to enqueue refresh for recording ${call.id}: ${err}`),
        ),
      ),
    );
  }
}

/** Refresh every recording shared to a channel, after a member joins or leaves it. */
export function refreshRecordingTranscriptPermissionsForChannel(channelId: string): Promise<void> {
  return refreshForShares({ channelId }, `channel ${channelId}`);
}

/** Refresh every recording shared to a user group, after a member joins or leaves it. */
export function refreshRecordingTranscriptPermissionsForGroup(userGroupId: string): Promise<void> {
  return refreshForShares({ userGroupId }, `group ${userGroupId}`);
}

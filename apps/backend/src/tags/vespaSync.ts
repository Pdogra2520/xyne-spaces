import { CallType } from '@xyne/shared';
import { vespaQueue } from '@/queues/vespaQueue';
import { mailSchema, ticketSchema } from '@/vespa/src/types';
import { db } from '@/database/client';
import { withWorkspaceScope } from '@/database/tenant/context';
import { queueTranscriptFieldsUpdate } from '@/services/callVespaQueue';
import { logger } from '@/utils/logger';
import { DESK_EMAIL_SOURCE_TYPE } from './deskEmail';

// Recording labels are Tag rows with this sourceType (see callLabelService).
const CALL_SOURCE_TYPE = 'CALL';

/**
 * Re-feed an email + its ticket to Vespa so `generatedTags` reflects the Tag table.
 * Fire-and-forget: callers use `void enqueueTagVespaRefeed(...)`.
 */
export async function enqueueTagVespaRefeed(sourceType: string, sourceId: string): Promise<void> {
  if (sourceType === CALL_SOURCE_TYPE) {
    await refreshRecordingLabels(sourceId);
    return;
  }
  if (sourceType !== DESK_EMAIL_SOURCE_TYPE) return;

  try {
    await vespaQueue.addJob({ schema: mailSchema, jobType: 'feed', docId: sourceId });

    const email = await db.email.findUnique({
      where: { id: sourceId },
      select: { conversationId: true },
    });
    if (!email) return;

    const ticket = await db.ticket.findFirst({
      where: { conversationId: email.conversationId },
      select: { id: true },
    });
    if (ticket) {
      await vespaQueue.addJob({ schema: ticketSchema, jobType: 'feed', docId: ticket.id });
    }
  } catch (error) {
    logger.error('[TAG][VESPA] Failed to enqueue re-feed:', error);
  }
}

/**
 * A recording's transcript doc carries its confirmed label slugs, so confirming, renaming or
 * deleting one of its Tags must refresh them. sourceId is the Call id (the doc id).
 */
async function refreshRecordingLabels(callId: string): Promise<void> {
  try {
    // Workspace scope: the tag's editor may not be able to read the recording itself.
    const call = await withWorkspaceScope(() =>
      db.call.findUnique({
        where: { id: callId },
        select: { id: true, transcript: true, workspaceId: true, callType: true },
      }),
    );
    if (!call || call.callType !== CallType.HEADLESS) return;
    queueTranscriptFieldsUpdate(call, ['labels']);
  } catch (error) {
    logger.error('[TAG][VESPA] Failed to enqueue recording label refresh:', error);
  }
}

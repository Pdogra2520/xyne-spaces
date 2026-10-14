import { vespaQueue } from '@/queues/vespaQueue';
import { logger } from '@/utils/logger';
import { callSchema, fileSchema, SubApp } from '@/vespa/src/types';

export enum CallVespaFeedSource {
  CallControllerCancelOtherActiveJoinRequests = 'CallController.cancelOtherActiveJoinRequests',
  CallControllerInitiateCallRemovedUserExistingRoom = 'CallController.initiateCall.removedUserExistingRoom',
  CallControllerInitiateCallClearRemovedByHostExistingRoom = 'CallController.initiateCall.clearRemovedByHostExistingRoom',
  CallControllerJoinCallRemovedUserReknock = 'CallController.joinCall.removedUserReknock',
  CallControllerJoinCallClearRemovedByHost = 'CallController.joinCall.clearRemovedByHost',
  CallControllerInviteParticipantsReinvite = 'CallController.inviteParticipants.reinvite',
  CallControllerDeclineCallInvitation = 'CallController.declineCallInvitation',
  RecurringCallServiceCreateInstance = 'RecurringCallService.createInstance',
  RecurringCallServiceRegenerateFutureInstancesCancelledInstance = 'RecurringCallService.regenerateFutureInstances.cancelledInstance',
  ScheduleCallControllerCreateScheduledCall = 'ScheduleCallController.createScheduledCall',
  ScheduleCallControllerUpdateRecurringSeriesTimeChanged = 'ScheduleCallController.updateRecurringSeries.timeChanged',
  ScheduleCallControllerUpdateRecurringSeriesCascade = 'ScheduleCallController.updateRecurringSeries.cascade',
  CallRepositorySetRecordingUrl = 'CallRepository.setRecordingUrl',
  CallRepositoryUpdate = 'CallRepository.update',
  CallRepositoryCreateParticipant = 'CallRepository.createParticipant',
  CallRepositoryUpdateParticipantMeetingStatus = 'CallRepository.updateParticipantMeetingStatus',
  CallRepositoryUpdateRecurringSeriesMeetingStatus = 'CallRepository.updateRecurringSeriesMeetingStatus',
  CallRepositoryMarkAllParticipantsAsLeft = 'CallRepository.markAllParticipantsAsLeft',
  CallRepositoryUpdateParticipantResponse = 'CallRepository.updateParticipantResponse',
  CallRepositoryMarkParticipantAsLeft = 'CallRepository.markParticipantAsLeft',
  CallRepositoryEndCall = 'CallRepository.endCall',
  CallRepositoryHandleParticipantLeaving = 'CallRepository.handleParticipantLeaving',
  CallRepositoryHandleRoomFinished = 'CallRepository.handleRoomFinished',
  CallRepositoryActivateScheduledCall = 'CallRepository.activateScheduledCall',
  CallRepositoryCreateCallWithParticipantsAndMessage = 'CallRepository.createCallWithParticipantsAndMessage',
  CallRepositoryUpdateScheduledCall = 'CallRepository.updateScheduledCall',
  CallRepositoryCreateLobbyRequest = 'CallRepository.createLobbyRequest',
  CallRepositoryMarkExternalParticipantRequested = 'CallRepository.markExternalParticipantRequested',
  CallRepositoryAcceptExternalParticipantSession = 'CallRepository.acceptExternalParticipantSession',
  CallRepositoryExternalJoin = 'CallRepository.externalJoin',
  CallRepositoryUpdateParticipantMetadata = 'CallRepository.updateParticipantMetadata',
  CallRepositoryMarkParticipantRemovedByHost = 'CallRepository.markParticipantRemovedByHost',
  CallRepositoryRestoreParticipantState = 'CallRepository.restoreParticipantState',
  CallRepositoryRejoinLobby = 'CallRepository.rejoinLobby',
  CallRepositoryCancelByIds = 'CallRepository.cancelByIds',
  CallRepositoryUpsertExternalCalendarCallCreate = 'CallRepository.upsertExternalCalendarCall.create',
  CallRepositoryUpsertExternalCalendarCallUpdate = 'CallRepository.upsertExternalCalendarCall.update',
  CallRepositoryCancelByExternalId = 'CallRepository.cancelByExternalId',
  ScheduledCallRepositoryCancelCall = 'ScheduledCallRepository.cancelCall',
  RecurringCallServiceCancelSeries = 'RecurringCallService.cancelSeries',
  RecurringCallServiceDeleteSeries = 'RecurringCallService.deleteSeries',
  CallAdminPanel = 'CallAdminPanel',
}

export const queueCallVespaFeed = (
  callId?: string | null,
  context?: (Record<string, unknown> & { source?: CallVespaFeedSource }),
): void => {
  if (!callId) return;

  vespaQueue.addJob({
    schema: callSchema,
    jobType: 'feed',
    docId: callId,
  }).catch((error) => {
    logger.error('[CallVespaQueue] Failed to queue call Vespa feed:', {
      callId,
      context,
      errorMessage: error,
    });
  });
};

export const queueCallVespaDelete = (
  callId?: string | null,
  context?: Record<string, unknown>,
): void => {
  if (!callId) return;

  vespaQueue.addJob({
    schema: callSchema,
    jobType: 'delete',
    docId: callId,
  }).catch((error) => {
    logger.error('[CallVespaQueue] Failed to queue call Vespa delete:', {
      callId,
      context,
      errorMessage: error,
    });
  });
};

/**
 * A recording's transcript is a separate Vespa file doc (docId = call.id) whose
 * `fileName` is the recording title and `labels` its confirmed label slugs. Editing either
 * only re-feeds the call doc, so push the change to the transcript doc too — field-scoped,
 * so the transcript isn't re-embedded.
 */
export const queueTranscriptFieldsUpdate = (
  call: { id: string; transcript?: string | null; workspaceId?: string | null },
  fields: Array<'fileName' | 'labels'>,
): void => {
  // No transcript means no transcript doc to update.
  if (!call.transcript || fields.length === 0) return;

  vespaQueue.addJob({
    schema: fileSchema,
    jobType: 'update',
    docId: call.id,
    app: SubApp.TRANSCRIPT,
    fields,
    ...(call.workspaceId ? { workspaceId: call.workspaceId } : {}),
  }).catch((error) => {
    logger.error('[CallVespaQueue] Failed to queue transcript fields update:', {
      callId: call.id,
      fields,
      errorMessage: error,
    });
  });
};

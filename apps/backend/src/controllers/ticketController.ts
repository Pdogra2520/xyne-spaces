import { NextFunction, Request, Response } from 'express';
import type { DraftMessage, Ticket } from '@prisma/client';
import type { AuthenticatedUser } from '../types/express';
import { TicketCreationError, bulkRowErrorOf, ticketCreationConflictOf } from '@/utils/ticketCreationError';
import { currentWorkspaceId, withWorkspaceScope } from '@/database/tenant/context';
import { TicketRepository, emitTicketCreated } from '../database/repositories/ticketRepository';
import { ConversationRepository } from '../database/repositories/conversationRepository';
import { BoardRepository } from '../database/repositories/boardRepository';
import { ResourceRepository } from '../database/repositories/resources';
import { ResourceAccessRepository } from '../database/repositories/resourceAccess';
import { ChannelRepository } from '../database/repositories/channelRepository';
import { ChannelParticipantRepository } from '../database/repositories/channelParticipantRepository';
import { MessageRepository } from '../database/repositories/messageRepository';
import { MessageAttachmentRepository } from '../database/repositories/messageAttachmentRepository';
import { EmailRepository } from '../database/repositories/emailRepository';
import { telephonyEmailService } from '@/services/ozonetel/telephonyEmailService';
import { findCallTranscriptAttachment } from '@/services/ozonetel/callTranscript';
import { callTranscriptionService } from '@/services/ozonetel/callTranscriptionService';
import { callTranscriptionQueue } from '@/queues/callTranscriptionQueue';
import { ReleaseRepository } from '../database/repositories/releaseRepository';
import { getGroupedTagsWithConfig, DESK_EMAIL_SOURCE_TYPE, deskEmailConfigKey } from '@/tags';
import {
  CreateTicketCoreInput,
  GetTicketDetailsResponse,
  TicketDuplicateCheckRequest,
  TicketDuplicateCheckResponse,
  TicketBoardSuggestionRequest,
  TicketBoardCandidate,
  TicketBoardAnalysis,
  TicketBoardSuggestionResponse,
} from '../types/ticket';
import { evaluateAssignmentRule } from '../utils/assignmentEngine';
import { syncUserWorkload } from '../utils/workloadUtils';
import { ticketAssignmentService, primaryUserIdOf, secondaryAssignmentsOf } from '../services/ticketAssignmentService';
import {
  buildCustomFieldWritePayload,
  buildPartialCustomFieldWritePayload,
  syncCustomFieldValues,
  type CustomFieldWritePayload,
} from '../services/ticketCustomFieldService';
import { buildCreationFormFieldChanges } from '../services/ticketCustomFieldService';
import {
  resolveFormFieldDefinitionsForForm,
  type ResolvedFormFieldDefinition,
} from '@/utils/fieldDefinition';
import type { FormFieldChanges } from '@/automations/triggers/ticket-updated.trigger';
import type { BoardMetadata } from '@xyne/shared';
import { syncConversationTicketMdFromPrismaTicket } from '../utils/ticketMd';
import { TicketAssignmentsSideEffectHandler } from '@/zero/side-effects/tables/ticket-assignments-handler';
import { TicketsSideEffectHandler } from '@/zero/side-effects/tables/tickets-handler';
import { uploadFiles, UploadedFileResult } from '../services/fileUploadService';
import { config } from '../config/env';
import { superpositionClient } from '@/services/superpositionClient';
import { validateChannelAccess } from '@/utils/channelAccess';
import {
  createTicketDraft,
  findTicketDraft,
  parseTicketDraftRows,
  setTicketDraftRows,
} from '@/services/tickets/ticketDraftService';
import { resolveInheritedOwner } from '@/sdlc/entityLinkService';
import { createSubTicket } from '@/services/subTicketService';
import {
  MAX_BULK_TICKETS,
  type BulkTicketRowError,
  type BulkTicketRowResult,
  type CreateBulkTicketRequest,
  type CreateBulkTicketResponse,
  type TicketDraftRow,
} from '@xyne/shared';
import { randomUUID } from 'crypto';
import { activityService } from '@/services/activity/activityService';
import { entityLinkOwnerSchema, type EntityLinkOwner } from '@xyne/shared';
import { vespaQueue } from '@/queues/vespaQueue';
import { ticketSchema, fileSchema, SubApp } from '@/vespa/src/types';
import { isSupportedMimeType } from '@/services/fileProcessor';
import { logger } from '@/utils/logger';
import { resolveChannelDefaultBoard } from '@/utils/channelDefaultBoard';
import { maybeCreateEntryApprovalRequest } from '@/services/stageTransition/stageEntryApproval';
import { db } from '@/database/client';
import { NAMESPACE } from '@/vespa/vespaConfig';
import { DatabaseClient } from '@/database/client';
import { ticketDuplicateService, type DuplicateScopeFieldValue } from '@/services/ticketDuplicateService';
import { ticketBoardService } from '@/services/ticketBoardService';
import { versionReleaseMappingService } from '@/services/release/versionReleaseMappingService';
import { BaseTicketType,
  FormContextType,
  FormEntityType,
  ReleaseTrackingMode,
  TicketStatusV2,
  TicketPriority,
  AttachmentEntityType,
  ChannelType,
  TicketReferenceRelation,
  BoardType,
  WorkspaceRole,
  OrgRole,
  AccessType,
  UserType,
} from '@xyne/shared';
import { CommitAnalysisController } from './commitAnalysisController';
import { isReleaseTicket } from '@xyne/shared';
import { backlogFlowGroup } from '@/services/flowCascadeService';
import { AppError } from '@/middleware/errorHandler';

import { z } from 'zod';

const AddAttachmentsFromConversationBodySchema = z.object({
  sourceConversationId: z.string().min(1, 'sourceConversationId is required'),
  sourceMessageId: z.string().min(1).optional(),
});
import { userActivityTrackingService } from '@/services/userActivityTrackingService';
import { unifiedBotUserService } from '@/bots/unified';
import { workflowManager } from '@/workflows/services/workflowManager';
import { WorkflowType } from '@/workflows/types/workflow-enums';
import { ticketService } from '@/services/ticketService';
import { dualWriteTicketTags } from '@/services/ticketTagDualWriteService';
import { createTicketWithConversationTx } from '@/bypassAcl/transactions/controllersTicketController';
import { createTicketTx } from '@/bypassAcl/transactions/controllersTicketController';
import { mergeTicketTx } from '@/bypassAcl/transactions/controllersTicketController';
import { unmergeTicketTx } from '@/bypassAcl/transactions/controllersTicketController';
import { acquireLock, releaseLock } from '@/utils/distributedLock';


export const prisma = DatabaseClient.getInstance();

const RECHECK_DUPLICATES_LOCK_TTL_SECONDS = 120;

type MyTicketBoardOption = {
  id: string;
  name: string;
  projectId?: string;
};

const MAX_DUPLICATE_DECISIONS = 20;

const duplicateDecisionsOf = (raw: unknown): { sameAs: string | null; notSame: string[] } => {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { sameAs: null, notSame: [] };
    }
  }
  if (!value || typeof value !== 'object') return { sameAs: null, notSame: [] };
  const { sameAs, notSame } = value as { sameAs?: unknown; notSame?: unknown };
  return {
    sameAs: typeof sameAs === 'string' && sameAs.length > 0 ? sameAs : null,
    notSame: (Array.isArray(notSame) ? notSame : [])
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, MAX_DUPLICATE_DECISIONS),
  };
};
/** A ticket a bulk row hangs under. */
interface BulkParent {
  id: string;
  xyneId: string;
}

export class TicketController {
  ticketRepository: TicketRepository;
  conversationRepository: ConversationRepository;
  private boardRepository: BoardRepository;
  channelRepository: ChannelRepository;
  private channelParticipantRepository: ChannelParticipantRepository;
  messageRepository: MessageRepository;
  messageAttachmentRepository: MessageAttachmentRepository;
  private commitAnalysisController: CommitAnalysisController | null = null;

  constructor() {
    this.ticketRepository = new TicketRepository();
    this.conversationRepository = new ConversationRepository();
    this.boardRepository = new BoardRepository();
    this.channelRepository = new ChannelRepository();
    this.channelParticipantRepository = new ChannelParticipantRepository();
    this.messageRepository = new MessageRepository();
    this.messageAttachmentRepository = new MessageAttachmentRepository();

    const bitbucketConfig = config.bitbucket;
    const hasToken = Boolean(bitbucketConfig.apiToken);
    const hasBasicAuth = Boolean(bitbucketConfig.apiUsername) && Boolean(bitbucketConfig.password);
    if (hasToken || hasBasicAuth) {
      this.commitAnalysisController = new CommitAnalysisController();
    }
  }

  async pushVespaJobForAttachments(
    attachments: Array<{ id: string; mimetype: string }>,
    userId: string,
    workspaceId?: string
  ): Promise<void> {
    if (attachments.length === 0) return;

    // Filter only supported MIME types (PDF, DOCX, TXT, MD, etc.)
    const supportedAttachments = attachments.filter(att => isSupportedMimeType(att.mimetype));

    for (const attachment of supportedAttachments) {
      vespaQueue.addJob({
        schema: fileSchema,
        jobType: "feed",
        docId: attachment.id,
        app: SubApp.TICKET_ATTACHMENT,
        ...(workspaceId ? { workspaceId } : {}),
      }).catch(async (error) => {
        logger.error(`[TicketController] Error queuing Vespa job for attachment ${attachment.id}:`, error);
        // Log failed insertion to Postgres
        try {
          const logWorkspaceId = workspaceId ?? currentWorkspaceId();
          if (!logWorkspaceId) throw new Error('workspaceId required: no tenant context');
          if (db.vespaInsertionLogs) {
            await db.vespaInsertionLogs.create({
              data: {
                status: "FAILED",
                type: "INSERT",
                entityId: attachment.id,
                entityType: fileSchema,
                namespace: NAMESPACE,
                errorMessage: `Failed to enqueue Vespa job: ${error instanceof Error ? error.message : String(error)}`,
                errorDetails: JSON.stringify(error),
                userId: userId,
                workspaceId: logWorkspaceId,
                createdAt: new Date(),
              },
            });
          }
        } catch (dbError) {
          logger.error('Failed to log Vespa insertion error to database:', dbError);
        }
      });
    }
  }

  private async pushVespaJobForTicket(
    ticketId: string,
    userId: string,
    workspaceId?: string
  ): Promise<void> {
    vespaQueue.addJob({
      schema: ticketSchema,
      jobType: "feed",
      docId: ticketId,
      userId,
      ...(workspaceId ? { workspaceId } : {}),
    }).catch(async (error) => {
      logger.error(`[TicketController] Error queuing Vespa job for ticket ${ticketId}:`, error);
      try {
        const logWorkspaceId = workspaceId ?? currentWorkspaceId();
        if (!logWorkspaceId) throw new Error('workspaceId required: no tenant context');
        const vespaLogs = db.vespaInsertionLogs;
        if (vespaLogs) {
          await vespaLogs.create({
            data: {
              status: "FAILED",
              type: "INSERT",
              entityId: ticketId,
              entityType: ticketSchema,
              namespace: NAMESPACE,
              errorMessage: `Failed to enqueue Vespa job: ${error instanceof Error ? error.message : String(error)}`,
              errorDetails: JSON.stringify(error),
              userId,
              workspaceId: logWorkspaceId,
              createdAt: new Date(),
            },
          });
        }
      } catch (dbError) {
        logger.error('Failed to log Vespa insertion error to database:', dbError);
      }
    });
  }

  /**
   * Shared method to create a ticket with conversation context
   * Used by both HTTP API and transcription agent tool
   */
  async createTicketWithConversation(params: {
    title: string;
    description: string;
    createdBy: string;
    updatedBy: string;
    conversationId: string;
    projectId: string;
    boardId: string;
    assignedTo?: string;
    priority?: string;
    statusV2?: string;
    metadata?: Record<string, any>;
    messageContent?: string;
    messageSubtype?: string;
    entityLinkContext?: EntityLinkOwner;
  }): Promise<Ticket> {
    const {
      title,
      description,
      createdBy,
      updatedBy,
      conversationId,
      projectId,
      boardId,
      assignedTo,
      priority = 'MEDIUM',
      statusV2 = 'TODO',
      metadata = {},
      messageContent,
      messageSubtype = 'ai_ticket',
      entityLinkContext,
    } = params;

    const ticket = await createTicketWithConversationTx(this, conversationId, projectId, title, description, createdBy, updatedBy, assignedTo, boardId, statusV2, priority, messageContent, messageSubtype, metadata, entityLinkContext);

    // Ticket committed on its initial stage — auto-create the on-entry approval
    // request if that stage's single outgoing transition is configured for it.
    // Post-commit + fire-and-forget so it can't delay or fail ticket creation.
    if (ticket.stageName) {
      void maybeCreateEntryApprovalRequest(ticket.id, createdBy, ticket.stageName);
    }

    // Automations re-read the ticket on their own connection, so the event must
    // not be published before the transaction above commits.
    void emitTicketCreated(ticket, undefined, createdBy);

    ticketDuplicateService.persistDuplicateReferences({
      ticketId: ticket.id,
      ticketCreatedBy: ticket.createdBy,
      title,
      description,
      projectId,
      userId: createdBy,
      channelId: ticket.channelId,
    }).catch((error: Error) => {
      logger.error('Failed to persist duplicate references for ticket', {
        ticketId: ticket.id,
        error,
      });
    });

    return ticket;
  }

  /**
   * POST /api/tickets/bulk-from-message
   *
   * Create many tickets in one request. Identity is taken from the session
   * (never the body). Rows are created one after another, each through the same
   * path as single-ticket creation, so a row that fails neither stops nor undoes
   * the others: the response carries one result per row.
   *
   * A row can be a sub-ticket of an earlier row (`parentClientRowId`) or of an
   * existing ticket (`parentTicketId`). It is created after its parent and then
   * linked under it; when its parent failed, it fails too without being tried.
   *
   * With `draftTarget`, failed rows are saved as a ticket draft in that composer.
   * With `draftId`, the request retries rows of that draft: they are replaced by
   * whichever of them fail again, and the draft is deleted once it is empty.
   *
   * Submitting the same rows twice creates them twice, exactly as single-ticket
   * creation does — there is no idempotency key.
   */
  createBulkTicket = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user;
      const userId = user?.id;
      const workspaceId = user?.workspaceId;
      if (!user || !userId || !workspaceId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const caller = await db.user.findUnique({ where: { id: userId }, select: { userType: true } });
      if (caller?.userType !== UserType.USER) {
        res.status(403).json({
          error: 'Bulk ticket creation is only available to users',
          code: 'BULK_NOT_ALLOWED_FOR_NON_USER',
        });
        return;
      }

      const body = req.body as CreateBulkTicketRequest;
      const rows = body.tickets ?? [];
      if (rows.length === 0) {
        res.status(400).json({ error: 'At least one ticket is required in "tickets"' });
        return;
      }
      if (rows.length > MAX_BULK_TICKETS) {
        res.status(400).json({ error: `Cannot create more than ${MAX_BULK_TICKETS} tickets in one request` });
        return;
      }

      const retriedDraft = body.draftId ? await findTicketDraft(body.draftId, userId) : null;
      if (body.draftId && !retriedDraft) {
        res.status(404).json({ error: 'Ticket draft not found', code: 'TICKET_DRAFT_NOT_FOUND' });
        return;
      }

      // sourceConversationId decides which SDLC owner every ticket inherits, so
      // it gets the same existence + private-channel check as single creation.
      let entityLinkOwner: EntityLinkOwner | undefined;
      if (body.sourceConversationId) {
        const sourceConversation = await this.conversationRepository.findById(body.sourceConversationId);
        if (!sourceConversation) {
          res.status(400).json({ error: 'Source conversation not found' });
          return;
        }
        const sourceChannel = await this.channelRepository.findById(sourceConversation.channelId);
        if (sourceChannel && sourceChannel.visibility === 'PRIVATE') {
          const isParticipant = await this.channelParticipantRepository.isParticipant(
            sourceConversation.channelId,
            userId
          );
          if (!isParticipant) {
            res.status(403).json({
              error: 'Access denied - you do not have permission to access this conversation',
              code: 'NOT_CONVERSATION_PARTICIPANT',
            });
            return;
          }
        }
        entityLinkOwner = (await resolveInheritedOwner(db, body.sourceConversationId)) ?? undefined;
      }

      // The board decides the project, exactly as in single-ticket creation.
      // Fetching by workspace also leaves foreign boards unresolved.
      const boards = await prisma.board.findMany({
        where: { id: { in: Array.from(new Set(rows.map((r) => r.boardId))) }, workspaceId },
        select: { id: true, projectId: true },
      });
      const projectByBoardId = new Map(boards.map((b) => [b.id, b.projectId]));

      // Created one at a time, in request order, so ticket numbers and thread
      // order follow the rows.
      const results: BulkTicketRowResult[] = [];
      const failedRows: TicketDraftRow[] = [];
      const followUps: Array<() => Promise<void>> = [];
      // Tickets created by this request, by row, so later rows can hang under them.
      const createdByRowId = new Map<string, BulkParent>();
      const existingParents = new Map<string, Promise<BulkParent>>();
      for (const row of rows) {
        const clientRowId = row.clientRowId || randomUUID();
        let parent: BulkParent | undefined = row.parentClientRowId
          ? createdByRowId.get(row.parentClientRowId)
          : undefined;
        try {
          if (!parent && row.parentTicketId) {
            const pending =
              existingParents.get(row.parentTicketId) ??
              this.resolveBulkParent(row.parentTicketId, userId, workspaceId);
            existingParents.set(row.parentTicketId, pending);
            parent = await pending;
          }
          // A parent row that failed (or never came first) takes its subtree with it.
          if (row.parentClientRowId && !parent) {
            throw new TicketCreationError(409, {
              error: "Its parent ticket wasn't created",
              code: 'PARENT_NOT_CREATED',
            });
          }

          const access = await validateChannelAccess(row.channelId, userId, workspaceId);
          if (!access.hasAccess) {
            throw new TicketCreationError(403, {
              error: access.reason ?? 'You do not have access to this channel',
              code: 'CHANNEL_ACCESS_DENIED',
            });
          }
          const projectId = projectByBoardId.get(row.boardId);
          if (!projectId) {
            throw new TicketCreationError(404, { error: 'Board not found in your workspace', code: 'BOARD_NOT_FOUND' });
          }
          // Single creation checks the board's required form fields in the
          // browser; bulk rows can come from an API call or a stale draft, so
          // they are checked here too.
          try {
            await buildCustomFieldWritePayload(row.boardId, workspaceId, row.dynamicFields ?? {}, {
              requireAllRequiredFields: true,
            });
          } catch (fieldError) {
            throw new TicketCreationError(400, {
              error: fieldError instanceof Error ? fieldError.message : 'Invalid form fields',
              code: 'INVALID_FORM_FIELDS',
            });
          }

          const { ticket, afterResponse } = await this.createTicketCore(
            {
              title: row.title,
              description: row.description ?? '',
              channelId: row.channelId,
              boardId: row.boardId,
              projectId,
              ...(row.assignedTo ? { assignedTo: row.assignedTo } : {}),
              ...(row.userGroupId ? { userGroupId: row.userGroupId } : {}),
              ...(row.priority ? { priority: row.priority as TicketPriority } : {}),
              ...(row.statusV2 ? { statusV2: row.statusV2 as TicketStatusV2 } : {}),
              ...(row.eta ? { eta: new Date(row.eta) } : {}),
              ...(row.ticketType ? { ticketType: row.ticketType } : {}),
              fromTicketsTab: body.fromTicketsTab === true,
              files: [],
              entityLinkOwner,
              dynamicFields: row.dynamicFields ?? {},
              ...(parent ? { parentTicketId: parent.id } : {}),
            },
            user
          );
          followUps.push(afterResponse);
          createdByRowId.set(clientRowId, { id: ticket.id, xyneId: ticket.xyneId });

          // The ticket exists now, so a failed link is a warning, not a failed
          // row: retrying the row would create the ticket a second time.
          let warning: BulkTicketRowError | undefined;
          if (parent) {
            try {
              await createSubTicket({
                parentTicketId: parent.id,
                title: ticket.title,
                description: ticket.description,
                createdBy: userId,
                assignedTo: ticket.assignedTo,
                mappedTicketId: ticket.id,
                subTicketXyneId: ticket.xyneId,
              });
            } catch (linkError) {
              logger.error('[Bulk Ticket] Linking sub-ticket failed:', linkError);
              warning = {
                code: 'SUB_TICKET_LINK_FAILED',
                message: `Created, but not linked under ${parent.xyneId}`,
              };
            }
          }
          results.push({
            clientRowId,
            status: 'created',
            ticket: {
              id: ticket.id,
              xyneId: ticket.xyneId,
              title: ticket.title,
              conversationId: ticket.conversationId,
            },
            ...(warning ? { warning } : {}),
          });
        } catch (error) {
          const rowError = bulkRowErrorOf(error);
          results.push({ clientRowId, status: 'failed', error: rowError });
          // A parent that does exist is kept by id, so retrying links under it.
          failedRows.push({
            ...row,
            clientRowId,
            error: rowError,
            ...(parent ? { parentTicketId: parent.id, parentTicketXyneId: parent.xyneId } : {}),
          });
        }
      }

      const draftId = await this.saveFailedRowsAsDraft(body, retriedDraft, failedRows, user);

      const response: CreateBulkTicketResponse = {
        results,
        createdCount: results.length - failedRows.length,
        failedCount: failedRows.length,
        ...(draftId ? { draftId } : {}),
      };
      res.status(200).json(response);

      for (const followUp of followUps) {
        await followUp().catch((error: unknown) => {
          logger.error('[Bulk Ticket] Follow-up after creation failed:', error);
        });
      }
    } catch (error) {
      logger.error('[Bulk Ticket] createBulkTicket failed:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create tickets', code: 'BULK_CREATE_FAILED' });
      }
    }
  };

  /**
   * Keep the rows that failed: in the draft being retried (alongside its rows
   * this request did not retry, unless `replaceDraft`), or in a new draft at
   * `draftTarget` when at least one row was created — if none were, the caller
   * still has every row in front of it. Returns the draft id while one holds
   * rows. Saving is best effort: the tickets that were created stand, and the
   * response still reports every failed row.
   */
  private saveFailedRowsAsDraft = async (
    body: CreateBulkTicketRequest,
    retriedDraft: DraftMessage | null,
    failedRows: TicketDraftRow[],
    user: AuthenticatedUser
  ): Promise<string | null> => {
    try {
      if (retriedDraft) {
        const retriedIds = new Set(body.tickets.map((r) => r.clientRowId).filter(Boolean));
        const untouched = body.replaceDraft
          ? []
          : parseTicketDraftRows(retriedDraft.metadata).filter((r) => !retriedIds.has(r.clientRowId));
        return await setTicketDraftRows(retriedDraft, [...untouched, ...failedRows]);
      }
      const noneCreated = failedRows.length === body.tickets.length;
      if (failedRows.length === 0 || noneCreated || !body.draftTarget) return null;
      const access = await validateChannelAccess(body.draftTarget.channelId, user.id, user.workspaceId);
      if (!access.hasAccess) return null;
      return await createTicketDraft({
        workspaceId: user.workspaceId,
        userId: user.id,
        channelId: body.draftTarget.channelId,
        conversationId: body.draftTarget.conversationId ?? null,
        rows: failedRows,
      });
    } catch (error) {
      logger.error('[Bulk Ticket] Saving failed rows as a ticket draft failed:', error);
      return null;
    }
  };

  /**
   * An existing ticket a bulk row should hang under: in the caller's workspace
   * and in a channel they can reach, or the row fails.
   */
  private resolveBulkParent = async (
    ticketId: string,
    userId: string,
    workspaceId: string
  ): Promise<BulkParent> => {
    const parent = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, xyneId: true, workspaceId: true, channelId: true },
    });
    if (!parent || parent.workspaceId !== workspaceId) {
      throw new TicketCreationError(404, { error: 'Parent ticket not found', code: 'PARENT_NOT_FOUND' });
    }
    const access = await validateChannelAccess(parent.channelId, userId, workspaceId);
    if (!access.hasAccess) {
      throw new TicketCreationError(403, {
        error: "You don't have access to the parent ticket's channel",
        code: 'PARENT_ACCESS_DENIED',
      });
    }
    return { id: parent.id, xyneId: parent.xyneId };
  };

  /** DELETE /api/tickets/drafts/:draftId — discard a ticket draft. */
  deleteTicketDraft = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }
      const draft = await findTicketDraft(String(req.params['draftId']), userId);
      if (!draft) {
        res.status(404).json({ error: 'Ticket draft not found', code: 'TICKET_DRAFT_NOT_FOUND' });
        return;
      }
      await setTicketDraftRows(draft, []);
      res.status(204).end();
    } catch (error) {
      logger.error('[Ticket Draft] deleteTicketDraft failed:', error);
      res.status(500).json({ error: 'Failed to discard ticket draft' });
    }
  };

  /** DELETE /api/tickets/drafts/:draftId/rows/:clientRowId — discard one row. */
  deleteTicketDraftRow = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }
      const draft = await findTicketDraft(String(req.params['draftId']), userId);
      if (!draft) {
        res.status(404).json({ error: 'Ticket draft not found', code: 'TICKET_DRAFT_NOT_FOUND' });
        return;
      }
      const clientRowId = String(req.params['clientRowId']);
      const rows = parseTicketDraftRows(draft.metadata).filter((r) => r.clientRowId !== clientRowId);
      const draftId = await setTicketDraftRows(draft, rows);
      res.status(200).json({ draftId });
    } catch (error) {
      logger.error('[Ticket Draft] deleteTicketDraftRow failed:', error);
      res.status(500).json({ error: 'Failed to discard ticket draft row' });
    }
  };

  getMyTicketBoardIds = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      const workspaceId = req.user?.workspaceId;
      if (!userId || !workspaceId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const boardRows = await prisma.ticket.findMany({
        where: {
          workspaceId,
          isArchived: false,
          AND: [
            {
              OR: [
                { assignedTo: { in: [`user:${userId}`, userId] } },
                { createdBy: { in: [`user:${userId}`, userId] } },
              ],
            },
            {
              OR: [
                { ticketType: null },
                { ticketType: { not: BaseTicketType.Support } },
              ],
            },
          ],
        },
        select: {
          boardId: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        distinct: ['boardId'],
      });
      const boardIds = boardRows
      .map(row => row.boardId)
      .filter((boardId): boardId is string => Boolean(boardId));

    const boards = await prisma.board.findMany({
      where: {
        id: { in: boardIds },
        workspaceId,
      },
      select: {
        id: true,
        name: true,
        projectId: true,
      },
    });

    const boardById = new Map(boards.map(board => [board.id, board]));
    const boardDetails: MyTicketBoardOption[] = boardIds.map(boardId => {
      const board = boardById.get(boardId);
      return {
        id: boardId,
        name: board?.name ?? boardId,
        ...(board?.projectId ? { projectId: board.projectId } : {}),
      };
    });

      res.json({
        boardIds,
        boards: boardDetails,
      });
    } catch (error) {
      logger.error('[TicketController] Failed to fetch my ticket board ids', error);
      res.status(500).json({ error: 'Failed to fetch board ids' });
    }
  };

  createTicket = async (req: Request, res: Response): Promise<void> => {
    try {
      // If this is a support/error-report ticket, resolve channel+board from CAC
      if (req.headers['x-support-ticket'] === 'true') {
        const cacConfig = await superpositionClient.getObjectValue(
          'error_report_channel_config',
          null,
          {},
        ) as { channelId: string; boardId?: string } | null;

        if (!cacConfig?.channelId) {
          res.status(503).json({ error: 'Error reporting is not configured.' });
          return;
        }

        const channel = await this.channelRepository.findById(cacConfig.channelId);
        if (!channel) {
          res.status(503).json({ error: 'Support channel not found.' });
          return;
        }

        const SUPPORT_TAG = 'Support Ticket';
        const existingTags: string[] = Array.isArray(req.body.tags) ? req.body.tags : [];
        req.body.channelId = cacConfig.channelId;
        if (cacConfig.boardId) {
          req.body.boardId = cacConfig.boardId;
          const board = await this.boardRepository.findBoardById(cacConfig.boardId);
          if (!board?.projectId) {
            res.status(503).json({ error: 'Support board has no project mapping.' });
            return;
          }
          req.body.projectId = board.projectId;
        } else {
          // No explicit board configured — resolve the channel's default board
          // (ChannelBoardMapping first, legacy channel.projectId as fallback) and
          // derive projectId from that board, never from channel.projectId directly.
          const resolved = await resolveChannelDefaultBoard(db, channel.id);
          if (!resolved?.projectId) {
            res.status(503).json({ error: 'Support channel not found or has no project mapping.' });
            return;
          }
          req.body.projectId = resolved.projectId;
        }
        req.body.tags = [
          SUPPORT_TAG,
          ...existingTags.filter(t => t.toLowerCase() !== SUPPORT_TAG.toLowerCase()),
        ];
      }

      const { excludedChatAttachmentIds, draftAttachmentIds } = req.body as CreateTicketCoreInput;

      // Validate excludedChatAttachmentIds if provided
      if (excludedChatAttachmentIds && !Array.isArray(excludedChatAttachmentIds)) {
        res.status(400).json({ error: 'Invalid format for excludedChatAttachmentIds. Must be an array of strings.' });
        return;
      }

      // Validate draftAttachmentIds if provided
      if (draftAttachmentIds && !Array.isArray(draftAttachmentIds)) {
        res.status(400).json({ error: 'Invalid format for draftAttachmentIds. Must be an array of strings.' });
        return;
      }

      // Extract files from multer if present
      // uploadMultiple uses fields() so files are stored as { files: [...], thumbnails: [...] }
      const reqFiles = (req as Express.Request & { files?: { [fieldname: string]: Express.Multer.File[] } }).files || {};
      const files = reqFiles['files'] || [];

      // Parse file metadata if present (contains dimensions for images/videos)
      let fileMetadata: Array<{ fileIndex: number; hasThumbnail: boolean; thumbnailIndex?: number; width?: number; height?: number }> | undefined;
      if (req.body.fileMetadata) {
        try {
          fileMetadata = JSON.parse(req.body.fileMetadata);
        } catch {
          logger.warn('[Ticket Creation] Failed to parse fileMetadata');
        }
      }

      // Extract the entity-link owner stamp if present (multipart sends a JSON string).
      let entityLinkOwner: EntityLinkOwner | undefined;
      if (req.body.entityLinkContext) {
        try {
          const rawStamp =
            typeof req.body.entityLinkContext === 'string'
              ? JSON.parse(req.body.entityLinkContext)
              : req.body.entityLinkContext;
          entityLinkOwner = entityLinkOwnerSchema.parse(rawStamp);
        } catch {
          res.status(400).json({ error: 'Invalid entityLinkContext' });
          return;
        }
      }

      // Extract dynamic fields — multipart sends a JSON string, JSON sends an object.
      let dynamicFields: Record<string, string | string[]> = {};
      if (typeof req.body.dynamicFields === 'string') {
        try {
          dynamicFields =
            (JSON.parse(req.body.dynamicFields) as Record<string, string | string[]>) || {};
        } catch {
          res.status(400).json({ error: 'dynamicFields is not valid JSON' });
          return;
        }
      } else if (req.body.dynamicFields && typeof req.body.dynamicFields === 'object') {
        dynamicFields = req.body.dynamicFields as Record<string, string | string[]>;
      }

      const { ticket, afterResponse } = await this.createTicketCore(
        {
          ...(req.body as CreateTicketCoreInput),
          fromTicketsTab: req.body.fromTicketsTab === true || req.body.fromTicketsTab === 'true',
          files,
          fileMetadata,
          entityLinkOwner,
          dynamicFields,
        },
        req.user,
      );

      const response: GetTicketDetailsResponse = {
        id: ticket.id,
        title: ticket.title,
        description: ticket.description,
        status: ticket.statusV2 as TicketStatusV2,
        createdBy: ticket.createdBy,
        updatedBy: ticket.updatedBy,
        assignedTo: ticket.assignedTo,
        conversationId: ticket.conversationId,
        eta: ticket.eta,
        priority: ticket.priority as TicketPriority,
        metadata: ticket.metadata as Record<string, any> | null,
        closedAt: ticket.closedAt,
        closedBy: ticket.closedBy,
        xyneId: ticket.xyneId,
        projectId: ticket.projectId,
        boardId: ticket.boardId,
        stageName: ticket.stageName,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
      };

      res.status(201).json(response);

      await afterResponse();
    } catch (error) {
      if (res.headersSent) {
        logger.error('Error after creating ticket:', error);
        return;
      }
      if (error instanceof TicketCreationError) {
        res.status(error.status).json(error.body);
        return;
      }
      logger.error('Error creating ticket:', error);
      const conflict = ticketCreationConflictOf(error);
      if (conflict) {
        res.status(409).json(conflict);
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  /**
   * Creates one ticket for `actor`: validation, the creating transaction and the
   * side effects that land before the caller responds. Shared by createTicket and
   * createBulkTicket. An expected failure throws TicketCreationError with the
   * HTTP status and body to return. `afterResponse` holds the slow follow-ups
   * (support workflow, release commit analysis) the caller runs once it has
   * responded.
   */
  createTicketCore = async (
    input: CreateTicketCoreInput,
    actor: AuthenticatedUser | undefined,
  ): Promise<{ ticket: Ticket; afterResponse: () => Promise<void> }> => {
    const {
      id: requestedTicketId,
      title,
      description,
      assignedTo,
      projectId: clientProjectId,
      userGroupId,
      statusV2,
      priority,
      eta,
      metadata,
      closedAt,
      closedBy,
      sourceConversationId,
      sourceMessageId,
      channelId,
      excludedChatAttachmentIds,
      draftAttachmentIds,
      tags,
      merchantId,
      parentTicketId,
      ticketType,
      stageName,
      fromTicketsTab,
      files,
      fileMetadata,
      entityLinkOwner,
      dynamicFields,
    } = input;

    let projectId = clientProjectId;

    const requiredFields = { title, description, projectId };
    for (const [field, value] of Object.entries(requiredFields)) {
      if (!value) {
        throw new TicketCreationError(400, { error: `${field.charAt(0).toUpperCase() + field.slice(1)} is required` });
      }
    }

    if (!channelId && !sourceConversationId) {
      throw new TicketCreationError(400, { error: 'Either channelId or sourceConversationId is required' });
    }

    // Validate multi-repo release config before the ticket exists (and the 201
    // is sent) — an incomplete repo would otherwise be silently dropped when
    // persisting releaseRepos, quietly covering fewer repos than configured.
    const rawReleaseRepos = dynamicFields?.['releaseRepos'];
    if (rawReleaseRepos !== undefined) {
      if (!actor) {
        throw new TicketCreationError(401, { error: 'Authentication required' });
      }
      const privileged =
        actor.role === WorkspaceRole.ADMIN ||
        actor.role === WorkspaceRole.OWNER ||
        actor.orgRole === OrgRole.ADMIN ||
        actor.orgRole === OrgRole.OWNER;
      if (!privileged) {
        const releaseResource = await new ResourceRepository().findByName('RELEASE-MANAGER');
        const allowed = releaseResource
          ? await new ResourceAccessRepository().hasAccess(actor.id, releaseResource.id, AccessType.WRITE)
          : false;
        if (!allowed) {
          throw new TicketCreationError(403, { error: 'Release Manager write access is required to create a release.' });
        }
      }
      let parsedReleaseRepos: unknown;
      try {
        parsedReleaseRepos =
          typeof rawReleaseRepos === 'string' ? JSON.parse(rawReleaseRepos) : rawReleaseRepos;
      } catch {
        throw new TicketCreationError(400, { error: 'releaseRepos is not valid JSON' });
      }
      if (Array.isArray(parsedReleaseRepos)) {
        const incomplete = parsedReleaseRepos.filter((r: any) => {
          const has = (key: string): boolean => Boolean(String(r?.[key] ?? '').trim());
          return !(has('mainReleaseBoardId') && has('branch') && has('deployedCommit') && has('newCommit'));
        });
        if (incomplete.length > 0) {
          throw new TicketCreationError(400, {
            error: `Each release repo needs mainReleaseBoardId, branch, deployedCommit and newCommit; ${incomplete.length} repo(s) are incomplete.`,
          });
        }
        const isSha = (s: string): boolean => /^[0-9a-f]{7,40}$/i.test(s);
        const invalid = parsedReleaseRepos.filter((r: any) => {
          const deployed = String(r?.deployedCommit ?? '').trim();
          const newCommit = String(r?.newCommit ?? '').trim();
          return !isSha(deployed) || !isSha(newCommit) || deployed === newCommit;
        });
        if (invalid.length > 0) {
          throw new TicketCreationError(400, {
            error: `Each release repo needs a distinct valid deployed and new commit hash; ${invalid.length} repo(s) are invalid.`,
          });
        }
        const actorWorkspaceId = actor.workspaceId;
        const boardIds = [
          ...new Set(
            parsedReleaseRepos.map((r: any) => String(r?.mainReleaseBoardId ?? '').trim()).filter(Boolean),
          ),
        ];
        const repoBoards = await db.board.findMany({
          where: { id: { in: boardIds } },
          select: { id: true, workspaceId: true, projectId: true, boardType: true },
        });
        const owned =
          repoBoards.length === boardIds.length &&
          repoBoards.every(
            b => b.workspaceId === actorWorkspaceId && b.boardType === BoardType.RELEASE,
          ) &&
          new Set(repoBoards.map(b => b.projectId)).size <= 1;
        if (!owned) {
          throw new TicketCreationError(403, {
            error: 'Release repositories must be release boards in your workspace and belong to one project.',
          });
        }
      }
    }

    // Determine the actual channel to check its type
    let actualChannelId = channelId;
    if (!actualChannelId && sourceConversationId) {
      const sourceConv = await this.conversationRepository.findById(sourceConversationId);
      if (sourceConv) {
        actualChannelId = sourceConv.channelId;
      }
    }

    // Validate boardId based on channel type
    let boardId = input.boardId as string | undefined;
    if (!boardId) {
      let isSupportChannel = false;
      if (actualChannelId) {
        const channel = await this.channelRepository.findById(actualChannelId);
        isSupportChannel = channel?.type === ChannelType.SUPPORT;
      }

      if (isSupportChannel) {
        // Support channels can use default board
        boardId = await this.boardRepository.findDefaultBoardIdForProject(projectId);
      } else {
        // Non-support channels must provide boardId
        throw new TicketCreationError(400, { error: 'boardId is required' });
      }
    }

    // Validate enum fields if provided
    if (statusV2 && !Object.values(TicketStatusV2).includes(statusV2 as TicketStatusV2)) {
      throw new TicketCreationError(400, {
        error: `Invalid statusV2 provided. Must be one of: ${Object.values(TicketStatusV2).join(', ')}`
      });
    }

    if (priority && !Object.values(TicketPriority).includes(priority as TicketPriority)) {
      throw new TicketCreationError(400, {
        error: `Invalid priority provided. Must be one of: ${Object.values(TicketPriority).join(', ')}`
      });
    }

    const userId = actor?.id;
    if (!userId || !actor) {
      throw new TicketCreationError(401, { error: 'User not authenticated' });
    }

    if (input.createdBy && input.createdBy !== userId) {
      throw new TicketCreationError(400, { error: 'createdBy must match the authenticated user' });
    }
    if (input.updatedBy && input.updatedBy !== userId) {
      throw new TicketCreationError(400, { error: 'updatedBy must match the authenticated user' });
    }
    if (input.closedBy && input.closedBy !== userId) {
      throw new TicketCreationError(400, { error: 'closedBy must match the authenticated user' });
    }

    const queryContext = {
      userID: userId,
      workspaceId: actor.workspaceId,
      role: actor.role,
      orgRole: actor.orgRole,
      memberId: actor.memberId,
    };

    const initialMessageId = randomUUID();

    const board = await this.boardRepository.findBoardById(boardId);
    if (board?.projectId) {
      projectId = board.projectId;
    }
    const effectiveStatusV2 =
      board?.boardType === BoardType.FLOW ? TicketStatusV2.TODO : (statusV2 as TicketStatusV2);
    const effectiveStageName = board?.boardType === BoardType.FLOW ? 'TODO' : stageName;
    const effectiveTicketType =
      board?.boardType === BoardType.FLOW && !parentTicketId
        ? BaseTicketType.Epic
        : ticketType;

    // Process file uploads BEFORE transaction (external I/O operation)
    let uploadedFiles: UploadedFileResult[] = [];
    if (files.length > 0 && (!draftAttachmentIds || draftAttachmentIds.length === 0)) {
      // Fail entire ticket creation if file upload fails
      // Pass fileMetadata to include dimensions for images/videos
      uploadedFiles = await uploadFiles(files, undefined, fileMetadata);
    }

    // Validate conversation access before transaction
    let validatedConversation: any = null;
    if (sourceConversationId) {
      validatedConversation = await this.conversationRepository.findById(sourceConversationId);

      if (!validatedConversation) {
        throw new TicketCreationError(400, { error: 'Source conversation not found' });
      }

      // 🔒 SECURITY FIX: ENFORCE CONVERSATION ACCESS CONTROL
      // Check if user has access to the conversation via channel participation
      const channel = await this.channelRepository.findById(validatedConversation.channelId);

      if (channel && channel.visibility === 'PRIVATE') {
        const isParticipant = await this.channelParticipantRepository.isParticipant(
          validatedConversation.channelId,
          userId
        );
        if (!isParticipant) {
          throw new TicketCreationError(403, {
            error: 'Access denied - you do not have permission to access this conversation',
            code: 'NOT_CONVERSATION_PARTICIPANT',
          });
        }
      }
    }

    if (sourceMessageId) {
      const sourceMessage = await this.messageRepository.findById(sourceMessageId);
      if (!sourceMessage || sourceMessage.workspaceId !== actor.workspaceId) {
        throw new TicketCreationError(400, { error: 'Source message not found' });
      }
      const existingFromMessage = await prisma.ticket.findUnique({
        where: { messageId: sourceMessageId },
        select: { xyneId: true },
      });
      if (existingFromMessage) {
        throw new TicketCreationError(409, {
          error: `A ticket (${existingFromMessage.xyneId}) was already created from this message`,
        });
      }
    }

    // Auto-assign ticket if userGroupId is provided but assignedTo is not
    let finalAssignedTo = assignedTo;
    let pendingFullRoleAssignment = false;

    if (userGroupId && !assignedTo) {
      try {
        const boardMetaRow = await prisma.board.findUnique({ where: { id: boardId }, select: { metadata: true } });
        const boardMeta = boardMetaRow?.metadata as BoardMetadata | undefined;

        if (
          (Array.isArray(boardMeta?.assignmentRoles) && boardMeta!.assignmentRoles!.length > 0)
          || boardMeta?.fullRoleAssignment === true
        ) {
          // Full role assignment will be done after ticket creation
          pendingFullRoleAssignment = true;
        } else {
          // The ticket lands in the source conversation's channel when one is given, else in channelId.
          const ticketChannelId: string | null = (sourceConversationId ? validatedConversation?.channelId : channelId) ?? null;
          const assignmentResult = await evaluateAssignmentRule(userGroupId, boardId, undefined, undefined, projectId, ticketChannelId);
          if (assignmentResult.assignedUserId) {
            finalAssignedTo = assignmentResult.assignedUserId;
          }
        }
      } catch (error) {
        logger.error('[Ticket Creation] Error during auto-assignment:', error);
        // Continue with ticket creation even if assignment fails
      }
    }

    let formMapping: Awaited<ReturnType<typeof prisma.formContextMapping.findFirst>> | null = null;
    let formFields: ResolvedFormFieldDefinition[] = [];
    if (Object.keys(dynamicFields as Record<string, string>).length > 0) {
      try {
        formMapping = await prisma.formContextMapping.findFirst({
          where: { contextId: boardId, contextType: FormContextType.BOARD, entityType: FormEntityType.TICKET },
        });
        if (formMapping) {
          formFields = await resolveFormFieldDefinitionsForForm(prisma, formMapping.formId);
        }
      } catch (err) {
        logger.error('[Ticket Creation] Error resolving form mapping/fields:', err);
      }
    }

    let formFieldChangesForEmit: FormFieldChanges | undefined;
    let duplicateScopeValues: DuplicateScopeFieldValue[] | undefined;
    if (formFields.length > 0) {
      const fieldsWithValues = formFields
        .filter((f: any) => dynamicFields[f.fieldName] !== undefined)
        .map((f: any) => ({
          fieldId: f.id,
          fieldName: f.fieldName,
          actualFieldValue: dynamicFields[f.fieldName],
        }));
      if (fieldsWithValues.length > 0) {
        formFieldChangesForEmit = buildCreationFormFieldChanges(fieldsWithValues);
        duplicateScopeValues = fieldsWithValues.map(fv => ({ fieldId: fv.fieldId, value: fv.actualFieldValue }));
      }
    }

    // Wrap all database operations in a transaction for data integrity
    const { ticket } = await createTicketTx(projectId, sourceConversationId, validatedConversation, this, requestedTicketId, title, description, userId, finalAssignedTo, userGroupId, boardId, effectiveStatusV2, priority, eta, metadata, closedAt, closedBy, merchantId, sourceMessageId, effectiveTicketType, effectiveStageName, dynamicFields, formFieldChangesForEmit, channelId, excludedChatAttachmentIds, entityLinkOwner, fromTicketsTab, initialMessageId, board, uploadedFiles, draftAttachmentIds);

    // Ticket committed on its initial stage — auto-create the on-entry approval
    // request if that stage's single outgoing transition is configured for it.
    // Post-commit + fire-and-forget so it can't delay or fail ticket creation.
    if (ticket.stageName) {
      void maybeCreateEntryApprovalRequest(ticket.id, ticket.createdBy, ticket.stageName);
    }

    // Automations re-read the ticket on their own connection, so the event must
    // not be published before the transaction above commits.
    void emitTicketCreated(ticket, formFieldChangesForEmit, ticket.createdBy);

    if (sourceConversationId) {
      void activityService.fillSdlcOwner(sourceConversationId, validatedConversation.channelId);
    }

    const ticketChannelId = sourceConversationId ? validatedConversation.channelId : channelId;
    if (ticketChannelId) {
      try {
        await this.channelRepository.updateLastActivity(ticketChannelId);
      } catch (err) {
        logger.warn(
          `[createTicket] Skipped last-activity update for channel ${String(ticketChannelId).replace(/[\r\n]/g, '')}: ${(err instanceof Error ? err.message : String(err)).replace(/[\r\n]/g, '')}`,
        );
      }
    }

    // Create TicketTag records for each tag
    if (tags && tags.length > 0) {
      try {
        await prisma.ticketTag.createMany({
          data: tags.map(tagName => ({
            name: tagName.trim(),
            ticketId: ticket.id,
            workspaceId: ticket.workspaceId,
          })),
        });
        await dualWriteTicketTags(ticket.id, tags.map(t => t.trim()), prisma);
        logger.info(`[Ticket Creation] Created ${tags.length} tags for ticket ${ticket.id}`);
      } catch (error) {
        logger.error('[Ticket Creation] Error creating ticket tags:', error);
        // Don't fail ticket creation if tag creation fails
      }
    }


    // Create FormEntityValues records for dynamic fields
    if (Object.keys(dynamicFields).length > 0 && formMapping && formFields.length > 0) {
      try {
        // Create FormEntityValues for each dynamic field
        const formEntityValuesData = formFields
          .filter((field: any) => dynamicFields[field.fieldName] !== undefined)
          .map((field: any) => {
            const value = dynamicFields[field.fieldName];
            // Provide both fields for backward compatibility
            return {
              formId: formMapping.formId,
              entityId: ticket.id,
              entityType: FormEntityType.TICKET,
              fieldId: field.id,
              contextId: boardId,
              workspaceId: ticket.workspaceId,
              fieldValue: '', // Empty string for backward compatibility (not used anymore)
              actualFieldValue: value, // Actual value stored in JSON field
            };
          });

        if (formEntityValuesData.length > 0) {
          await prisma.formEntityValues.createMany({
            data: formEntityValuesData,
          });
          logger.info(`[Ticket Creation] Created ${formEntityValuesData.length} form entity values for ticket ${ticket.id}`);
          if (Object.prototype.hasOwnProperty.call(dynamicFields, 'releaseVersion')) {
              versionReleaseMappingService.syncTicketById(ticket.id).catch(error => {
                logger.error(`[Ticket Creation] Version release mapping failed for ticket ${ticket.xyneId}:`, error);
              });
            }
        }
      } catch (error) {
        logger.error('[Ticket Creation] Error creating form entity values:', error);
        // Don't fail ticket creation if form entity values creation fails
      }
    }

    // Queue Vespa job after the ticket and any form fields are fully ingested.
    await this.pushVespaJobForTicket(ticket.id, userId, actor?.workspaceId);

    void userActivityTrackingService.trackTicketCreated(userId, {
      ticketId: ticket.id,
      title: ticket.title,
      boardId: ticket.boardId,
    });

    // Full role assignment when toggle is ON (runs after ticket is committed)
    let fraAssignedUserId: string | null = null;
    if (pendingFullRoleAssignment && userGroupId) {
      try {
        const fullRoles = await ticketAssignmentService.assignFullRolesToTicket({
          ticketId: ticket.id,
          userGroupId,
          boardId,
          createdBy: userId,
          projectId: ticket.projectId,
          channelId: ticket.channelId,
        });
        const primaryUserId = primaryUserIdOf(fullRoles);
        if (primaryUserId) {
          const prevAssignedTo = ticket.assignedTo;
          const updatedTicket = await prisma.ticket.update({
            where: { id: ticket.id },
            data: { assignedTo: primaryUserId },
          });
          await syncConversationTicketMdFromPrismaTicket(prisma, updatedTicket);
          fraAssignedUserId = primaryUserId;

          const ticketsHandler = new TicketsSideEffectHandler(queryContext);
          ticketsHandler.onUpdate({
            entityId: ticket.id,
            entityType: 'tickets',
            operation: 'update',
            args: { assignedTo: primaryUserId },
            previousValue: {
              assignedTo: prevAssignedTo,
              stageName: ticket.stageName,
              statusV2: ticket.statusV2,
              eta: ticket.eta ? ticket.eta.getTime() : null,
              boardId: ticket.boardId,
              createdBy: ticket.createdBy,
              channelId: ticket.channelId,
            },
          }).catch(err => logger.error('[Ticket Creation] TicketsSideEffectHandler error:', err));
        }

        const assignmentsHandler = new TicketAssignmentsSideEffectHandler(queryContext);
        const fraAssignments = secondaryAssignmentsOf(fullRoles);
        for (const assignment of fraAssignments) {
          assignmentsHandler.onInsert({
            entityId: assignment.assignmentId,
            entityType: 'ticket_assignments',
            operation: 'insert',
          }).catch(err => logger.error(`[Ticket Creation] TicketAssignmentsSideEffectHandler error for assignment ${assignment.assignmentId}:`, err));
        }

        logger.info(`[Ticket Creation] Full role assignment complete for ticket ${ticket.id}`);
      } catch (error) {
        logger.error('[Ticket Creation] Error during full role assignment:', error);
      }
    }

    // Sync workload mapping if ticket was assigned to a user
    const finalAssignedUserId = fraAssignedUserId || ticket.assignedTo;
    if (finalAssignedUserId && userGroupId) {
      try {
        await syncUserWorkload(finalAssignedUserId, userGroupId, boardId, userId);
        logger.info(`[Ticket Creation] Synced workload for user ${finalAssignedUserId}`);
      } catch (error) {
        logger.error('[Ticket Creation] Error syncing workload:', error);
      }
    }

    // Send notification for regular auto-assignment (non-FRA)
    // FRA notifications are handled by side-effect handlers above
    if (!pendingFullRoleAssignment && ticket.assignedTo && ticket.assignedTo !== userId) {
      const ticketsHandler = new TicketsSideEffectHandler(queryContext);
      ticketsHandler.onUpdate({
        entityId: ticket.id,
        entityType: 'tickets',
        operation: 'update',
        args: { assignedTo: ticket.assignedTo },
        previousValue: {
          assignedTo: null,
          stageName: ticket.stageName,
          statusV2: ticket.statusV2,
          eta: ticket.eta ? ticket.eta.getTime() : null,
          boardId: ticket.boardId,
          createdBy: ticket.createdBy,
          channelId: ticket.channelId,
        },
      }).catch(err => logger.error('[Ticket Creation] Non-FRA TicketsSideEffectHandler error:', err));
    }

    logger.info('analytics_event', {
      event: 'ticket_created',
      timestamp: new Date().toISOString(),
      userId: ticket.createdBy,
      userName: actor?.name ?? null,
    });

    const duplicateDecisions = duplicateDecisionsOf(input.duplicateDecisions);
    if (!duplicateDecisions.sameAs) {
      ticketDuplicateService.persistDuplicateReferences({
        ticketId: ticket.id,
        ticketCreatedBy: ticket.createdBy,
        title,
        description,
        projectId,
        userId,
        parentTicketId,
        channelId: ticket.channelId,
        scopeFieldValues: duplicateScopeValues,
        excludeTicketIds: duplicateDecisions.notSame,
      }).catch(error => {
        logger.error('Failed to persist duplicate references for ticket', {
          ticketId: ticket.id,
          error,
        });
      });
    }

    const afterResponse = async (): Promise<void> => {
      // Check if this is a support channel by fetching the channel type
      const channel = await this.channelRepository.findById(ticket.channelId);
      if (channel && channel.type === ChannelType.SUPPORT) {
        // Trigger IT_SUPPORT_WORKFLOW for support channels
        await workflowManager.startWorkflow({
          ticketId: ticket.id,
          workflowType: WorkflowType.IT_SUPPORT_WORKFLOW,
          context: {
            title: ticket.title,
            description: ticket.description,
            ticketId: ticket.id,
            queryText: description,
            channelId: channel.id,
            userId,
            userName: actor?.name,
            conversationId: ticket.conversationId,
            xyneId: ticket.xyneId,
          },
          createdBy: userId,
        })
      }

      // Trigger commit analysis for commit-range release tickets only.
      const releaseTicket = isReleaseTicket(ticket.ticketType as BaseTicketType);
      const releaseBoardConfig = releaseTicket
        ? await prisma.board.findUnique({
          where: { id: boardId },
          select: { releaseTrackingMode: true },
        })
        : null;
      const releaseTrackingMode =
        releaseBoardConfig?.releaseTrackingMode ?? ReleaseTrackingMode.COMMIT_RANGE;

      if (releaseTicket && releaseTrackingMode === ReleaseTrackingMode.VERSION) {
        logger.info(`[ReleaseTrigger] skipped for ticket ${ticket.xyneId}: releaseTrackingMode=VERSION`);
      } else {
        // Trim — protects commit analysis from accidental whitespace in the form
        // (e.g. user pastes "main " with a trailing space, GitHub returns 404).
        const deployedCommitId = String(dynamicFields?.['deployedCommitId'] ?? '').trim();
        const newCommitId = String(dynamicFields?.['newCommitId'] ?? '').trim();
        const branch = String(dynamicFields?.['branch'] ?? '').trim();

        let completeRepoRows: Array<{
          workspaceId: string;
          releaseId: string;
          mainReleaseBoardId: string;
          branch: string;
          deployedCommit: string;
          newCommit: string;
        }> = [];
        try {
          const raw = dynamicFields?.['releaseRepos'];
          const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (Array.isArray(parsed)) {
            completeRepoRows = parsed
              .map((r: any) => ({
                workspaceId: ticket.workspaceId,
                releaseId: ticket.id,
                mainReleaseBoardId: String(r?.mainReleaseBoardId ?? '').trim(),
                branch: String(r?.branch ?? '').trim(),
                deployedCommit: String(r?.deployedCommit ?? '').trim(),
                newCommit: String(r?.newCommit ?? '').trim(),
              }))
              .filter((r) => r.mainReleaseBoardId && r.branch && r.deployedCommit && r.newCommit);
            await new ReleaseRepository().createReleaseRepositories(completeRepoRows);
          }
        } catch (e) {
          logger.error(`[ReleaseTrigger] failed to persist release repos for ticket ${ticket.xyneId}: ${e instanceof Error ? e.message : String(e)}`);
        }

        const hasRepoRows = completeRepoRows.length > 0;
        const hasScalarRange = Boolean(deployedCommitId && newCommitId && branch);

        // Make silent-skip visible — log which condition(s) failed so this can be
        // debugged without staring at code. WARN level so it shows up by default.
        if (!this.commitAnalysisController || !releaseTicket || (!hasRepoRows && !hasScalarRange)) {
          const missing: string[] = [];
          if (!this.commitAnalysisController) missing.push('commitAnalysisController(not initialized — check Bitbucket env vars)');
          if (!releaseTicket) missing.push(`ticketType(=${ticket.ticketType}, want Release/Hotfix)`);
          if (!hasRepoRows && !hasScalarRange) missing.push('no complete ReleaseRepository rows and no scalar deployedCommitId/newCommitId/branch');
          logger.warn(`[ReleaseTrigger] skipped for ticket ${ticket.xyneId}: missing=${missing.join(', ')}`);
        }

        if (this.commitAnalysisController && releaseTicket && (hasRepoRows || hasScalarRange)) {
          // workspace + repoSlug are now derived inside commitAnalysisController
          // from Application.repoUrl on the resolved project. We pass empty
          // placeholders to satisfy the existing param shape; the controller
          // ignores them when DB-derived values are available.
          const xyneReleaseBot = await unifiedBotUserService.getBotByBotId('xyne-release-bot', ticket.workspaceId);

          this.commitAnalysisController.analyzeCommits({
            conversationId: ticket.conversationId,
            userId: xyneReleaseBot?.id || userId,
            channelId: ticket.channelId || undefined,
            newCommitId,
            deployedCommitId,
            branch,
            parentTicketId,
            currentTicketId: ticket.id,
            userName: actor?.name,
            isHotFix: ticket.ticketType === BaseTicketType.Hotfix,
            workspaceId: xyneReleaseBot?.workspaceId || actor?.workspaceId,
          }).then((result) => {
            if (result.success) {
              logger.info(`[Ticket Creation] Commit analysis completed for ticket ${ticket.xyneId}`);
            } else {
              // Interpolate the error into the message — Winston treats the 2nd
              // positional arg as metadata and won't print plain strings/objects there.
              logger.error(`[Ticket Creation] Commit analysis failed for ticket ${ticket.xyneId}: ${result.error ?? '(no error message)'}`);
            }
          }).catch((error) => {
            const msg = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
            logger.error(`[Ticket Creation] Commit analysis error for ticket ${ticket.xyneId}: ${msg}`);
          });
        }
      }
    };

    return { ticket, afterResponse };
  };

  /**
   * Move every live descendant of a Flow run group to backlog.
   * POST /api/tickets/:ticketId/flow-groups/:groupId/backlog
   */
  backlogFlowGroup = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const userId = req.user?.id;
    const workspaceId = req.user?.workspaceId;
    if (!userId || !workspaceId) {
      next(new AppError('User not authenticated', 401));
      return;
    }

    const rootTicketId = req.params.ticketId;
    const groupId = req.params.groupId;
    if (!rootTicketId || !groupId) {
      next(new AppError('ticketId and groupId are required', 400));
      return;
    }

    try {
      const result = await backlogFlowGroup({
        rootTicketId,
        groupId,
        actorUserId: userId,
        workspaceId,
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

  /**
     * Update a ticket
     * PATCH /api/tickets/:ticketId
     *
     * Path params:
     * - ticketId: ID of the ticket to update
     * - workspaceID
     *
     * Body (at least one update field required):
     * - assigneeId: string - New assignee user ID
     * - stage: string - New stage name (must exist on ticket's board)
     * - groupId: string - User group ID to assign
     * - title: string - New title
     * - description: string - New description
     * - priority: string - LOW | MEDIUM | HIGH | CRITICAL
     * - status: string - TODO | STARTED | PAUSED | CANCELLED | COMPLETED
     * - eta: string - Due date as ISO 8601 string
     */
  updateTicket = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const ticketId = req.params.ticketId;
      if (!ticketId) {
        res.status(400).json({ error: 'ticketId is required (path param)' });
        return;
      }

      const { assigneeId, stage, groupId, title, description, priority, status, eta, tags } = req.body ?? {};
      // Custom form-field values, keyed by field name. Accept `formFields`
      // (preferred) or the legacy `dynamicFields` alias used by the apps API.
      const rawFormFields = (req.body?.formFields ?? req.body?.dynamicFields) as unknown;
      let formFields: Record<string, unknown> | undefined;
      if (rawFormFields !== undefined && rawFormFields !== null) {
        if (
          typeof rawFormFields !== 'object' ||
          Array.isArray(rawFormFields)
        ) {
          res.status(400).json({ error: 'formFields must be an object keyed by field name' });
          return;
        }
        formFields = rawFormFields as Record<string, unknown>;
      }
      const hasFormFields = !!formFields && Object.keys(formFields).length > 0;

      const hasScalarUpdate =
        !!assigneeId || !!stage || !!groupId || !!title || !!description ||
        !!priority || !!status || !!eta || tags !== undefined;

      if (!hasScalarUpdate && !hasFormFields) {
        res.status(400).json({
          error: 'At least one update field is required (assigneeId, stage, groupId, title, description, priority, status, eta, tags, or formFields)',
        });
        return;
      }

      if (tags !== undefined && (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string'))) {
        res.status(400).json({ error: 'tags must be an array of strings' });
        return;
      }

      // Resolve + validate custom form-field values BEFORE mutating scalar
      // fields so an invalid formFields payload fails the whole request
      // instead of leaving a half-applied update. Custom fields are persisted
      // through the shared ticketCustomFieldService — the same engine the apps
      // ticket API uses — keeping normalization, USER-reference validation,
      // versioning, and activity logging single-sourced.
      let customFieldValues: CustomFieldWritePayload | undefined;
      if (hasFormFields) {
        const ticket = await prisma.ticket.findUnique({
          where: { id: ticketId },
          select: { boardId: true, workspaceId: true },
        });
        if (!ticket) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }
        const fieldWorkspaceId = ticket.workspaceId ?? req.user?.workspaceId;
        if (!fieldWorkspaceId) {
          res.status(400).json({ error: 'Unable to resolve workspace for custom field validation' });
          return;
        }
        const partialResult = await buildPartialCustomFieldWritePayload(
          ticket.boardId,
          fieldWorkspaceId,
          formFields,
          { requireAllRequiredFields: false },
        );
        if (partialResult.validationErrors.length > 0) {
          res.status(400).json({
            error: 'Custom field validation error',
            code: 'VALIDATION_ERROR',
            details: partialResult.validationErrors,
          });
          return;
        }
        customFieldValues = partialResult.customFieldValues;
      }

      const updates = hasScalarUpdate
        ? await ticketService.updateTicket(ticketId, userId, {
            assigneeId, stage, groupId, title, description, priority, status, eta, tags,
          })
        : [];

      if (customFieldValues) {
        await syncCustomFieldValues(ticketId, customFieldValues, userId);
        updates.push('customFields');
      }

      res.status(200).json({ success: true, updated: updates });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[TicketController] Error updating ticket:', {
        error: errorMessage,
        ticketId: req.params.ticketId,
        userId: req.user?.id,
      });
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
        message: errorMessage,
      });
    }
  };




  checkDuplicateTickets = async (req: Request, res: Response): Promise<void> => {
    try {
      const { title, description, projectId, limit = 10 } = req.body as TicketDuplicateCheckRequest;

      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const { candidates, analysis } = await ticketDuplicateService.checkDuplicates({
        title,
        description,
        projectId,
        userId,
        limit,
        jevOnly: true,
      });

      const response: TicketDuplicateCheckResponse = {
        candidates,
        analysis,
      };

      res.json({ success: true, data: response });
    } catch (error) {
      logger.error('Error checking ticket duplicates:', error);
      res.status(500).json({ error: 'Failed to check ticket duplicates' });
    }
  };

  /**
   * POST /api/tickets/:ticketId/duplicates/recheck
   * Re-runs duplicate detection for an existing ticket on demand. Append-only: a newly
   * found possible duplicate is linked, existing links are left alone.
   */
  recheckTicketDuplicates = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = req.params;
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { channelId: true, workspaceId: true, isArchived: true },
      });
      if (!ticket || ticket.workspaceId !== req.user?.workspaceId) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      if (ticket.isArchived) {
        res.status(400).json({ error: 'Cannot check duplicates on an archived ticket' });
        return;
      }

      // ACL: Private channels require membership; public channels are open
      const channel = await this.channelRepository.findById(ticket.channelId);
      if (channel && channel.visibility === 'PRIVATE') {
        const isParticipant = await this.channelParticipantRepository.isParticipant(ticket.channelId, userId);
        if (!isParticipant) {
          res.status(403).json({ error: 'Access denied - you do not have permission to access this conversation' });
          return;
        }
      }

      // One check per ticket at a time: each runs a Vespa search plus a Jev/LLM call.
      // TTL covers a slow LLM fallback. Fails open when Redis is down, and release only
      // drops the lock this request still holds and never throws.
      const lock = await acquireLock(`ticket:duplicate-recheck:${ticketId}`, {
        ttlSeconds: RECHECK_DUPLICATES_LOCK_TTL_SECONDS,
      });
      if (!lock) {
        res.status(429).json({ error: 'A duplicate check is already running for this ticket.' });
        return;
      }

      let outcome;
      try {
        outcome = await ticketDuplicateService.recheckDuplicatesForTicket(ticketId);
      } finally {
        await releaseLock(lock);
      }
      // Covers a failed search and a failed analysis alike: neither is "no duplicates".
      if (!outcome || outcome.analysis.error) {
        res.status(502).json({ error: 'Duplicate check failed. Please try again.' });
        return;
      }

      res.json({
        success: true,
        data: {
          isDuplicate: outcome.linkedTicketId !== null,
          linkedTicketId: outcome.linkedTicketId,
          candidateCount: outcome.candidateCount,
          confidence: outcome.analysis.confidence ?? 0,
        },
      });
    } catch (error) {
      logger.error('[TicketController] recheckTicketDuplicates error:', error);
      res.status(500).json({ error: 'Failed to check ticket duplicates' });
    }
  };

  /**
   * GET /api/tickets/:ticketId/latest-email-tags
   * Returns the active tags on the ticket's most recent email that has tags assigned,
   * grouped by category with the channel's configured color (if any).
   */
  getLatestEmailTags = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = req.params;
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { conversationId: true, channelId: true, workspaceId: true },
      });
      if (!ticket || ticket.workspaceId !== req.user?.workspaceId) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }

      // ACL: Private channels require membership; public channels are open
      const channel = await this.channelRepository.findById(ticket.channelId);
      if (channel && channel.visibility === 'PRIVATE') {
        const isParticipant = await this.channelParticipantRepository.isParticipant(ticket.channelId, userId);
        if (!isParticipant) {
          res.status(403).json({ error: 'Access denied - you do not have permission to access this conversation' });
          return;
        }
      }

      const emailRepository = new EmailRepository();
      const emails = await emailRepository.findByConversationIdOrdered(ticket.conversationId);
      if (emails.length === 0) {
        res.json({ groups: [] });
        return;
      }

      // Find which emails have active tags
      const taggedEmailIds = await prisma.tag.findMany({
        where: {
          sourceType: DESK_EMAIL_SOURCE_TYPE,
          sourceId: { in: emails.map(e => e.id) },
          isDeleted: false,
        },
        select: { sourceId: true },
        distinct: ['sourceId'],
      });
      const taggedIdSet = new Set(taggedEmailIds.map(t => t.sourceId));

      // Pick the latest email (emails are ordered asc) that has tags
      const latestTaggedEmail = [...emails].reverse().find(e => taggedIdSet.has(e.id));
      if (!latestTaggedEmail) {
        res.json({ groups: [] });
        return;
      }

      const groups = await getGroupedTagsWithConfig(latestTaggedEmail.id, DESK_EMAIL_SOURCE_TYPE, deskEmailConfigKey(ticket.channelId));
      res.json({ groups });
    } catch (error) {
      logger.error('[TicketController] getLatestEmailTags failed:', error);
      res.status(500).json({ error: 'Failed to fetch email tags' });
    }
  };

  /**
   * POST /api/tickets/:ticketId/emails/:emailId/transcribe
   * Manual trigger: transcribe the Ozonetel recording attached to a call email in
   * this ticket's thread. Enqueues a `call-transcription` job (consumed in this API
   * process, see app.ts) and returns 202. Progress is written into the call email body (`transcription`)
   * and the finished transcript arrives as an EMAIL attachment; both sync via Zero.
   */
  transcribeCallRecording = async (req: Request, res: Response): Promise<void> => {
    const { ticketId, emailId } = req.params;
    const userId = req.user?.id;
    const workspaceId = req.user?.workspaceId;
    if (!userId || !workspaceId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { conversationId: true, channelId: true, workspaceId: true },
      });
      if (!ticket || ticket.workspaceId !== workspaceId) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }

      // ACL: Private channels require membership; public channels are open
      const channel = await this.channelRepository.findById(ticket.channelId);
      if (channel && channel.visibility === 'PRIVATE') {
        const isParticipant = await this.channelParticipantRepository.isParticipant(ticket.channelId, userId);
        if (!isParticipant) {
          res.status(403).json({ error: 'Access denied - you do not have permission to access this conversation' });
          return;
        }
      }

      const email = await telephonyEmailService.getCallEmailWithPayload(emailId, workspaceId);
      if (!email || email.conversationId !== ticket.conversationId) {
        res.status(404).json({ error: 'Call not found in this ticket' });
        return;
      }
      if (!email.payload.recording?.trim()) {
        res.status(400).json({ error: 'This call has no recording to transcribe' });
        return;
      }

      const attachments = await this.messageAttachmentRepository.findByEntityIdAndType(
        emailId,
        AttachmentEntityType.EMAIL,
      );
      const existing = findCallTranscriptAttachment(attachments);
      if (existing) {
        res.status(409).json({ error: 'This call already has a transcript', attachmentId: existing.id });
        return;
      }

      // Bull is the source of truth for "in progress"; the body status is only for the UI.
      if (await callTranscriptionQueue.isInProgress(emailId)) {
        res.status(409).json({ error: 'Transcription is already in progress' });
        return;
      }

      await telephonyEmailService.setTranscriptionState(emailId, workspaceId, { status: 'queued' });
      let enqueued: boolean;
      try {
        enqueued = await callTranscriptionQueue.enqueue({ emailId, workspaceId, userId });
      } catch (enqueueError) {
        // Enqueue failed (e.g. Redis down): don't leave the body stuck at "queued" with no job behind it.
        await telephonyEmailService.setTranscriptionState(emailId, workspaceId, { status: 'failed', error: 'Could not start transcription. Please try again.' });
        throw enqueueError;
      }
      if (!enqueued) {
        res.status(409).json({ error: 'Transcription is already in progress' });
        return;
      }

      logger.info(`[TicketController] call transcription queued | ticketId=${ticketId} | emailId=${emailId} | userId=${userId}`);
      res.status(202).json({ status: 'queued' });
    } catch (error) {
      logger.error('[TicketController] transcribeCallRecording failed:', error);
      res.status(500).json({ error: 'Failed to start transcription' });
    }
  };

  /**
   * POST /api/tickets/:ticketId/emails/:emailId/summarize
   * Manual trigger: generate the AI summary for a call that already has a
   * transcript (transcribed before summaries existed, or whose automatic summary
   * failed). Synchronous: one LLM round trip, the summary is written into the call
   * email body (`transcription.summary`) and returned.
   */
  summarizeCallTranscript = async (req: Request, res: Response): Promise<void> => {
    const { ticketId, emailId } = req.params;
    const userId = req.user?.id;
    const workspaceId = req.user?.workspaceId;
    if (!userId || !workspaceId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { conversationId: true, channelId: true, workspaceId: true },
      });
      if (!ticket || ticket.workspaceId !== workspaceId) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const channel = await this.channelRepository.findById(ticket.channelId);
      if (channel && channel.visibility === 'PRIVATE') {
        const isParticipant = await this.channelParticipantRepository.isParticipant(ticket.channelId, userId);
        if (!isParticipant) {
          res.status(403).json({ error: 'Access denied - you do not have permission to access this conversation' });
          return;
        }
      }
      const email = await telephonyEmailService.getCallEmailWithPayload(emailId, workspaceId);
      if (!email || email.conversationId !== ticket.conversationId) {
        res.status(404).json({ error: 'Call not found in this ticket' });
        return;
      }

      const outcome = await callTranscriptionService.summarizeExistingTranscript(emailId, workspaceId);
      if (!outcome.ok) {
        const responses: Record<typeof outcome.code, { status: number; error: string }> = {
          call_not_found: { status: 404, error: 'Call not found in this ticket' },
          no_transcript: { status: 409, error: 'Transcribe the call before summarizing it' },
          empty_transcript: { status: 409, error: 'The transcript is empty, nothing to summarize' },
          generation_failed: { status: 502, error: 'Summary could not be generated right now' },
        };
        const { status, error } = responses[outcome.code];
        res.status(status).json({ error });
        return;
      }

      logger.info(`[TicketController] call summary ${outcome.alreadyExisted ? 'reused' : 'generated'} | ticketId=${ticketId} | emailId=${emailId} | userId=${userId}`);
      res.status(200).json({ summary: outcome.summary });
    } catch (error) {
      logger.error('[TicketController] summarizeCallTranscript failed:', error);
      res.status(500).json({ error: 'Failed to generate summary' });
    }
  };

  getPendingHumanIntervention = async (req: Request, res: Response): Promise<void> => {
    try {
      const { ticketId } = req.params;

      if (!ticketId) {
        res.status(400).json({ error: 'ticketId is required' });
        return;
      }
      const pendingStep = await this.findPendingUserApprovalStep(ticketId);

      if (!pendingStep) {
        res.status(200).json({
          requiresIntervention: false,
          step: null
        });
        return;
      }

      let stepTitle = 'Human Intervention Required';
      let responseSchema = null;

      if (pendingStep.data) {
        try {
          const stepData = JSON.parse(pendingStep.data);
          stepTitle = stepData?.externalMetadata?.title || stepTitle;
          responseSchema = stepData?.externalMetadata?.response_schema || null;
        } catch (e) {
          // Ignore parse errors
        }
      }

      res.status(200).json({
        requiresIntervention: true,
        step: {
          id: pendingStep.id,
          stepName: pendingStep.stepName,
          title: stepTitle,
          responseSchema,
          workflowExecutionId: pendingStep.workflowExecutionId,
          createdAt: pendingStep.createdAt
        }
      });
    } catch (error) {
      logger.error('Error checking pending human intervention:', error);
      res.status(500).json({ error: 'Failed to check pending human intervention' });
    }
  };

  private async findPendingUserApprovalStep(ticketId: string) {
    const workflows = await prisma.workflow.findMany({
      where: { ticketId },
      select: { id: true }
    });

    if (workflows.length === 0) {
      return null;
    }

    const workflowIds = workflows.map(w => w.id);

    const executions = await prisma.workflowExecution.findMany({
      where: { workflowId: { in: workflowIds } },
      select: { id: true }
    });

    if (executions.length === 0) {
      return null;
    }

    const executionIds = executions.map(e => e.id);

    // Step 3: Find input steps with stepSubType 'user_approval'
    const inputSteps = await prisma.workflowStep.findMany({
      where: {
        workflowExecutionId: { in: executionIds },
        stepExecutorType: 'external',
        stepSubType: 'user_approval',
        type: 'input'
      },
      orderBy: { createdAt: 'desc' }
    });

    if (inputSteps.length === 0) {
      return null;
    }

    for (const inputStep of inputSteps) {
      // Any approver's response counts as answered, so it runs above the caller's own scope.
      const externalStepResponse = await withWorkspaceScope(() =>
        prisma.externalStepResponse.findUnique({
          where: {
            workflowStepId: inputStep.id
          }
        }),
      );

      if (!externalStepResponse) {
        return inputStep;
      }
    }

    return null;
  }

  suggestBoard = async (req: Request, res: Response): Promise<void> => {
    try {
      const { title, description, projectId } = req.body as TicketBoardSuggestionRequest;

      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const { candidates, analysis } = await this.analyzeBoardCandidates({
        title,
        description,
        projectId,
        userId,
      });

      const response: TicketBoardSuggestionResponse = {
        candidates,
        analysis,
      };

      res.json({ success: true, data: response });
    } catch (error) {
      logger.error('Error suggesting board:', error);
      res.status(500).json({ error: 'Failed to suggest board' });
    }
  };

  private async getBoardCandidates(projectId: string): Promise<TicketBoardCandidate[]> {
    const boards = await this.boardRepository.findBoardsByProject(projectId);

    return boards.map(board => ({
      id: board.id,
      name: board.name,
      description: undefined, // Board model doesn't have description field
      boardType: board.boardType || undefined,
      stageCount: undefined, // Can be populated if needed by fetching stages count
    }));
  }

  private async analyzeBoardCandidates(params: {
    title: string;
    description: string;
    projectId: string;
    userId: string;
  }): Promise<{ candidates: TicketBoardCandidate[]; analysis: TicketBoardAnalysis }> {
    const { title, description, projectId, userId } = params;
    const candidates = await this.getBoardCandidates(projectId);

    if (candidates.length === 0) {
      return {
        candidates,
        analysis: {
          suggestedBoardId: null,
          suggestedBoardName: null,
        },
      };
    }

    const analysis = await ticketBoardService.suggestBoard(
      { title, description },
      candidates,
      { userId, projectId },
    );

    return { candidates, analysis };
  }

  /**
   * POST /api/tickets/:ticketId/attachments/from-conversation
   * Transfer CHAT MessageAttachments from a Spaces conversation message to an
   * existing ticket. Used by the claw agent (spaces-add-ticket-attachments tool)
   * when a ticket was created without sourceConversationId.
   *
   * Body: { sourceConversationId: string, sourceMessageId?: string }
   * - If sourceMessageId is provided, transfers attachments from that specific message.
   * - Otherwise falls back to the conversation's initialMessageId.
   */
  addAttachmentsFromConversation = async (req: Request, res: Response): Promise<void> => {
    try {
      const { ticketId } = req.params;

      const bodyResult = AddAttachmentsFromConversationBodySchema.safeParse(req.body);
      if (!bodyResult.success) {
        res.status(400).json({ error: bodyResult.error.errors[0]?.message ?? 'Invalid request body' });
        return;
      }
      const { sourceConversationId, sourceMessageId } = bodyResult.data;

      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      // Validate ticket exists and enforce workspace-scoped ACL
      const ticket = await this.ticketRepository.getTicketById(ticketId);
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      if (ticket.workspaceId !== req.user!.workspaceId) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // Validate the source conversation exists AND belongs to the caller's workspace.
      const conversation = await this.conversationRepository.findByIdAndWorkspace(
        sourceConversationId,
        req.user!.workspaceId,
      );
      if (!conversation) {
        res.status(400).json({ error: 'Source conversation not found' });
        return;
      }

      // Enforce access to the source conversation's channel (PRIVATE = participant only).
      const sourceChannel = await this.channelRepository.findById(conversation.channelId);
      if (!sourceChannel || sourceChannel.workspaceId !== req.user!.workspaceId) {
        res.status(400).json({ error: 'Source conversation not found' });
        return;
      }
      if (sourceChannel.visibility === 'PRIVATE') {
        const isParticipant = await this.channelParticipantRepository.isParticipant(
          conversation.channelId,
          userId,
        );
        if (!isParticipant) {
          res.status(403).json({
            error: 'Access denied - you do not have permission to access this conversation',
            code: 'NOT_CONVERSATION_PARTICIPANT',
          });
          return;
        }
      }

      // Determine which message to pull attachments from:
      // - If caller specifies sourceMessageId (e.g. the exact triggering message), prefer that.
      // - Otherwise fall back to the conversation's initialMessageId.
      const messageId = sourceMessageId ?? conversation.initialMessageId;
      if (!messageId) {
        res.json({ count: 0 });
        return;
      }

      if (sourceMessageId) {
        const sourceMessage = await this.messageRepository.findById(sourceMessageId);
        if (!sourceMessage || sourceMessage.conversationId !== sourceConversationId) {
          res.status(403).json({ error: 'Access denied - message does not belong to the source conversation' });
          return;
        }
      }

      const attachments = await this.messageAttachmentRepository.findByMessageId(messageId);
      if (attachments.length === 0) {
        res.json({ count: 0 });
        return;
      }

      const attachmentIds = attachments.map((a) => a.id);
      await this.messageAttachmentRepository.updateManyEntityTypeAndId(
        attachmentIds,
        AttachmentEntityType.TICKET,
        ticketId,
      );

      // Re-index transferred attachments in Vespa
      this.pushVespaJobForAttachments(
        attachments.map((a) => ({ id: a.id, mimetype: a.mimetype })),
        userId,
        ticket.workspaceId,
      ).catch((err) => {
        logger.error(`[TicketController] Vespa re-index failed for attachments on ticket ${ticketId}:`, err);
      });

      logger.info(`[TicketController] Transferred ${attachments.length} attachment(s) from message ${messageId} to ticket ${ticketId}`);
      res.json({ count: attachments.length });
    } catch (err) {
      logger.error('[TicketController] addAttachmentsFromConversation error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
  mergeTicket = async (req: Request, res: Response): Promise<void> => {
    try {
      const { ticketId } = req.params;
      const { targetTicketId } = req.body;
      const userId = req.user?.id ?? '';

      if (!targetTicketId) { res.status(400).json({ error: 'targetTicketId is required' }); return; }
      if (ticketId === targetTicketId) { res.status(400).json({ error: 'Cannot merge a ticket into itself' }); return; }

      const [source, target] = await Promise.all([
        prisma.ticket.findUnique({ where: { id: ticketId } }),
        prisma.ticket.findUnique({ where: { id: targetTicketId } }),
      ]);
      if (!source) { res.status(404).json({ error: 'Source ticket not found' }); return; }
      if (!target) { res.status(404).json({ error: 'Target ticket not found' }); return; }
      if (source.workspaceId !== target.workspaceId) { res.status(403).json({ error: 'Cannot merge tickets across workspaces' }); return; }
      if (source.isArchived || target.isArchived) { res.status(400).json({ error: 'Cannot merge archived tickets' }); return; }

      const existingMapping = await prisma.ticketReferenceMapping.findFirst({
        where: { sourceTicketId: ticketId, relationType: TicketReferenceRelation.MERGED_INTO },
      });
      if (existingMapping) {
        res.status(400).json({ error: 'Ticket is already merged into another ticket' });
        return;
      }

      const mapping = await mergeTicketTx(ticketId, targetTicketId, userId, source, target);

      // Create Zero-side notification activities (fire-and-forget)
      TicketsSideEffectHandler.handleTicketMerged({
        sourceTicketId: ticketId,
        targetTicketId: target.id,
        sourceXyneId: source.xyneId,
        targetXyneId: target.xyneId,
        sourceTitle: source.title,
        targetTitle: target.title,
        actorId: userId,
        channelId: source.channelId,
      }).catch((err) => {
        logger.error('[TicketController] Failed to create merge notification activities:', err);
      });

      logger.info('[TicketController] Ticket merged', { sourceTicketId: ticketId, targetTicketId, mappingId: mapping.id });
      res.json({ success: true, mappingId: mapping.id, targetTicket: { id: target.id, title: target.title, xyneId: target.xyneId } });
    } catch (err) {
      logger.error('[TicketController] mergeTicket error:', err);
      res.status(500).json({ error: 'Failed to merge ticket' });
    }
  };

  unmergeTicket = async (req: Request, res: Response): Promise<void> => {
    try {
      const { ticketId } = req.params;
      const userId = req.user?.id ?? '';

      const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
      if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
      if (!ticket.isArchived) { res.status(400).json({ error: 'Ticket is not archived' }); return; }

      const mapping = await prisma.ticketReferenceMapping.findFirst({
        where: { sourceTicketId: ticketId, relationType: TicketReferenceRelation.MERGED_INTO },
        include: { targetTicket: true },
      });
      if (!mapping) { res.status(400).json({ error: 'Ticket is not merged into another ticket' }); return; }

      await unmergeTicketTx(mapping, ticketId, userId, ticket);

      // Create Zero-side notification activities (fire-and-forget)
      TicketsSideEffectHandler.handleTicketUnmerged({
        sourceTicketId: ticketId,
        targetTicketId: mapping.targetTicketId,
        sourceXyneId: ticket.xyneId,
        targetXyneId: mapping.targetTicket.xyneId,
        sourceTitle: ticket.title,
        targetTitle: mapping.targetTicket.title,
        actorId: userId,
        channelId: ticket.channelId,
      }).catch((err) => {
        logger.error('[TicketController] Failed to create unmerge notification activities:', err);
      });

      logger.info('[TicketController] Ticket unmerged', { ticketId, previousTargetId: mapping.targetTicketId });
      res.json({ success: true, restoredTicket: { id: ticket.id, title: ticket.title, xyneId: ticket.xyneId, isArchived: false } });
    } catch (err) {
      logger.error('[TicketController] unmergeTicket error:', err);
      res.status(500).json({ error: 'Failed to unmerge ticket' });
    }
  };

  /**
   * POST /api/tickets/bulk-tags
   * Add and/or remove tags across many tickets in ONE request using additive
   * semantics (other labels are preserved). Workspace scoping is enforced in
   * the service from the authenticated session — ticket ids in the body are
   * NEVER trusted for cross-workspace access.
   */
  bulkUpdateTags = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      const workspaceId = req.user?.workspaceId;
      if (!userId || !workspaceId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const { ticketIds, addTags, removeTags } = req.body ?? {};

      if (
        !Array.isArray(ticketIds) ||
        ticketIds.length === 0 ||
        ticketIds.some((id: unknown) => typeof id !== 'string')
      ) {
        res.status(400).json({ error: 'ticketIds must be a non-empty array of strings' });
        return;
      }

      const MAX_BULK = 1000;
      if (ticketIds.length > MAX_BULK) {
        res.status(400).json({ error: `ticketIds cannot exceed ${MAX_BULK} per request` });
        return;
      }

      const isStringArray = (v: unknown): boolean =>
        v === undefined || (Array.isArray(v) && v.every(t => typeof t === 'string'));
      if (!isStringArray(addTags) || !isStringArray(removeTags)) {
        res.status(400).json({ error: 'addTags and removeTags must be arrays of strings' });
        return;
      }

      const hasAdd = Array.isArray(addTags) && addTags.length > 0;
      const hasRemove = Array.isArray(removeTags) && removeTags.length > 0;
      if (!hasAdd && !hasRemove) {
        res.status(400).json({ error: 'At least one of addTags or removeTags is required' });
        return;
      }

      const result = await ticketService.bulkUpdateTicketTags(
        ticketIds as string[],
        { addTags: addTags as string[] | undefined, removeTags: removeTags as string[] | undefined },
        workspaceId,
        userId,
      );

      res.json({ success: true, ...result });
    } catch (err) {
      logger.error('[TicketController] bulkUpdateTags error:', err);
      res.status(500).json({ error: 'Failed to bulk update ticket tags' });
    }
  };

}





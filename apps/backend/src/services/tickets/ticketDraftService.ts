import type { DraftMessage } from '@prisma/client';
import {
  DraftOrigin,
  type TicketDraftMetadata,
  type TicketDraftRow,
} from '@xyne/shared';
import { DatabaseClient } from '@/database/client';
import { logger } from '@/utils/logger';

/**
 * Ticket drafts: bulk ticket rows that failed to create, kept in the composer
 * they came from so the user can fix and retry them. Stored as a DraftMessage
 * with origin `ticket`, as twin drafts use `twin`: every lookup for the user's
 * own composer draft only matches origin `user` or none, so these never mix in.
 * The rows are kept as metadata JSON.
 */

const prisma = DatabaseClient.getInstance();

const summaryOf = (rows: TicketDraftRow[]): string =>
  `${rows.length} ticket${rows.length === 1 ? '' : 's'} not created`;

export const parseTicketDraftRows = (metadata: string | null): TicketDraftRow[] => {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata) as Partial<TicketDraftMetadata>;
    return Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch {
    logger.warn('[TicketDraft] Unparseable ticket draft metadata');
    return [];
  }
};

/** The caller's ticket draft, or null when it does not exist or is not theirs. */
export const findTicketDraft = (
  draftId: string,
  userId: string,
): Promise<DraftMessage | null> =>
  prisma.draftMessage.findFirst({
    where: { id: draftId, userId, origin: DraftOrigin.ticket },
  });

export const createTicketDraft = async (params: {
  workspaceId: string;
  userId: string;
  channelId: string;
  conversationId: string | null;
  rows: TicketDraftRow[];
}): Promise<string> => {
  const now = new Date();
  const draft = await prisma.draftMessage.create({
    data: {
      workspaceId: params.workspaceId,
      channelId: params.channelId,
      conversationId: params.conversationId,
      userId: params.userId,
      content: summaryOf(params.rows),
      hasAttachment: false,
      origin: DraftOrigin.ticket,
      metadata: JSON.stringify({ rows: params.rows } satisfies TicketDraftMetadata),
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  });
  return draft.id;
};

/**
 * Replace the draft's rows, deleting the draft once none are left. Returns the
 * draft id while it still exists, else null.
 */
export const setTicketDraftRows = async (
  draft: DraftMessage,
  rows: TicketDraftRow[],
): Promise<string | null> => {
  if (rows.length === 0) {
    await prisma.draftMessage.delete({ where: { id: draft.id } });
    return null;
  }
  await prisma.draftMessage.update({
    where: { id: draft.id },
    data: {
      content: summaryOf(rows),
      metadata: JSON.stringify({ rows } satisfies TicketDraftMetadata),
      updatedAt: new Date(),
    },
  });
  return draft.id;
};

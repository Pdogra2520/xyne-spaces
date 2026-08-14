import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { logger } from '@/utils/logger';

/**
 * An expected ticket-creation failure: what the caller should answer with.
 * Thrown by TicketController.createTicketCore.
 */
export class TicketCreationError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error: string; code?: string },
  ) {
    super(body.error);
    this.name = 'TicketCreationError';
  }
}

/** The 409 body for a unique-constraint clash while creating a ticket, else null. */
export const ticketCreationConflictOf = (
  error: unknown,
): { error: string; code: string } | null => {
  if (!(error instanceof PrismaClientKnownRequestError) || error.code !== 'P2002') return null;
  const target = error.meta?.target as string[] | undefined;
  if (target && target.includes('messageId')) {
    return { error: 'A ticket was already created from this message', code: 'DUPLICATE_SOURCE_MESSAGE' };
  }
  if (target && target.includes('xyneId')) {
    return { error: 'Ticket ID conflict. Please try again.', code: 'DUPLICATE_ID' };
  }
  // Client-supplied `id` (requestedTicketId) collided with an existing
  // ticket. Signal 409 so the caller can retry with a new id.
  if (!target || target.includes('id') || target.includes('PRIMARY')) {
    return {
      error: 'A ticket with this id already exists. Retry with a new id.',
      code: 'DUPLICATE_TICKET_ID',
    };
  }
  return null;
};

/**
 * Why one bulk row failed, in words safe to show the user. Unexpected errors
 * are logged here and reported generically.
 */
export const bulkRowErrorOf = (error: unknown): { code: string; message: string } => {
  if (error instanceof TicketCreationError) {
    return { code: error.body.code ?? `HTTP_${error.status}`, message: error.body.error };
  }
  const conflict = ticketCreationConflictOf(error);
  if (conflict) return { code: conflict.code, message: conflict.error };
  logger.error('[Bulk Ticket] Row failed unexpectedly:', error);
  return { code: 'CREATE_FAILED', message: "Couldn't create this ticket" };
};

/**
 * Bulk ticket creation types shared between the backend and dashboard.
 *
 * A single request creates many independent tickets. Each row is created on
 * its own, one after another, through the same path as single-ticket creation:
 * a row that fails does not stop or undo the others. Rows that fail can be
 * saved as a ticket draft so the user can fix and retry them later.
 */

/** One ticket to create. Every row is access-checked against its own channel. */
export interface BulkTicketItemInput {
  title: string;
  description?: string;
  channelId: string;
  boardId: string;
  assignedTo?: string;
  userGroupId?: string;
  priority?: string;
  statusV2?: string;
  eta?: string | Date;
  ticketType?: string;
  /** Values for the board's form fields, keyed by field name. */
  dynamicFields?: Record<string, string | string[]>;
  /**
   * Make this ticket a sub-ticket of an earlier row in the same request (that
   * row's clientRowId). Rows must come after their parent.
   */
  parentClientRowId?: string;
  /** Make this ticket a sub-ticket of a ticket that already exists. */
  parentTicketId?: string;
  /** Echoed back on the row's result so callers can pair results to inputs. */
  clientRowId?: string;
}

/** Dashboard → backend payload for POST /api/tickets/bulk-from-message. */
export interface CreateBulkTicketRequest {
  tickets: BulkTicketItemInput[];
  /**
   * Composer the batch came from. When set, rows that fail are saved there as a
   * ticket draft. Omit it (e.g. from a board) to get the failures back only.
   */
  draftTarget?: { channelId: string; conversationId?: string | null };
  /**
   * The ticket draft this request retries. Its rows are replaced by the rows
   * that fail this time, and the draft is deleted once none are left.
   */
  draftId?: string;
  /**
   * With `draftId`: the request carries the whole draft, so its rows become
   * exactly this request's failures (rows the user removed are dropped).
   * Without it only the retried rows are replaced.
   */
  replaceDraft?: boolean;
  /** Conversation the batch was raised from; its SDLC owner is inherited. */
  sourceConversationId?: string;
  /**
   * Set by the tickets tab. Channels can be configured to keep tickets-tab
   * tickets out of chat, and only the caller knows where the batch came from.
   */
  fromTicketsTab?: boolean;
}

/**
 * Rows a single bulk-ticket request may carry. Rows are created one after
 * another inside the request, so this bounds how long the request runs.
 * Enforced by the controller and the Joi validator, and mirrored by the
 * dashboard so the UI blocks before submitting.
 */
export const MAX_BULK_TICKETS = 20;

export interface CreatedBulkTicket {
  id: string;
  xyneId: string;
  title: string;
  conversationId: string;
}

export interface BulkTicketRowError {
  /** Stable code for the failure, e.g. CHANNEL_ACCESS_DENIED. */
  code: string;
  /** Human-readable reason, safe to show to the user. */
  message: string;
}

export type BulkTicketRowResult =
  | {
      clientRowId?: string;
      status: 'created';
      ticket: CreatedBulkTicket;
      /** Set when the ticket was created but could not be linked under its parent. */
      warning?: BulkTicketRowError;
    }
  | { clientRowId?: string; status: 'failed'; error: BulkTicketRowError };

/** Backend → dashboard response. One result per request row, in request order. */
export interface CreateBulkTicketResponse {
  results: BulkTicketRowResult[];
  createdCount: number;
  failedCount: number;
  /** The ticket draft holding this request's failed rows, when one was saved. */
  draftId?: string;
}

/** A row that failed to become a ticket, as kept in a ticket draft. */
export interface TicketDraftRow extends BulkTicketItemInput {
  clientRowId: string;
  error: BulkTicketRowError;
  /** The parent's ticket number, when the parent was created and this row was not. */
  parentTicketXyneId?: string;
}

/** `DraftMessage.metadata` (as JSON) for a draft whose origin is ticket. */
export interface TicketDraftMetadata {
  rows: TicketDraftRow[];
}

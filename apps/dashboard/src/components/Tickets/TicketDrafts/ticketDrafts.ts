import { useMemo } from 'react';
import { useSelector } from '@xstate/react';
import type {
  CreateBulkTicketRequest,
  CreateBulkTicketResponse,
  TicketDraftMetadata,
  TicketDraftRow,
} from '@xyne/shared';
import { stateMachineActor } from '../../../machines/stateMachine';
import { apiInstance } from '../../../services/clients/apiClient';

/** A ticket draft: bulk ticket rows that failed to create, kept in a composer. */
export interface TicketDraft {
  id: string;
  rows: TicketDraftRow[];
  updatedAt: number;
}

export const parseTicketDraftRows = (metadata: string | null | undefined): TicketDraftRow[] => {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata) as Partial<TicketDraftMetadata>;
    return Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
};

/**
 * Ticket drafts kept in one composer: the channel composer when
 * `conversationId` is null, else that thread's. Newest first.
 */
export const useTicketDrafts = (
  channelId: string | undefined,
  conversationId: string | null,
): TicketDraft[] => {
  const all = useSelector(stateMachineActor, state => state.context.ticketDrafts);
  return useMemo(
    () =>
      all
        .filter(d => d.channelId === channelId && (d.conversationId ?? null) === conversationId)
        .map(d => ({ id: d.id, rows: parseTicketDraftRows(d.metadata), updatedAt: d.updatedAt }))
        .filter(d => d.rows.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [all, channelId, conversationId],
  );
};

export const createBulkTickets = async (
  body: CreateBulkTicketRequest,
): Promise<CreateBulkTicketResponse> => {
  const res = await apiInstance.post('/tickets/bulk-from-message', body);
  return res.data as CreateBulkTicketResponse;
};

export const discardTicketDraft = async (draftId: string): Promise<void> => {
  await apiInstance.delete(`/tickets/drafts/${encodeURIComponent(draftId)}`);
};

export const discardTicketDraftRow = async (
  draftId: string,
  clientRowId: string,
): Promise<void> => {
  await apiInstance.delete(
    `/tickets/drafts/${encodeURIComponent(draftId)}/rows/${encodeURIComponent(clientRowId)}`,
  );
};

/** A draft row as a bulk request row: the stored error is not sent back. */
export const draftRowToRequestRow = ({
  error: _error,
  ...row
}: TicketDraftRow): CreateBulkTicketRequest['tickets'][number] => row;

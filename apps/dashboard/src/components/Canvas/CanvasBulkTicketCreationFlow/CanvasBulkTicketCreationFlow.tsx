import { useMemo, type ReactElement } from 'react';

import { BulkCreateTicketsModal } from '../../Tickets/BulkCreateTicketsModal/BulkCreateTicketsModal';
import type { CanvasTableTicketDraft } from '../useCanvasTableFilters';

interface CanvasBulkTicketCreationFlowProps {
  draft: CanvasTableTicketDraft | null;
  channelId?: string | undefined;
  onClose: () => void;
}

/**
 * Bulk ticket creation from a canvas table: every table row becomes a ticket.
 * There is no composer here, so rows that fail stay in the modal to fix.
 */
export function CanvasBulkTicketCreationFlow({
  draft,
  channelId,
  onClose,
}: CanvasBulkTicketCreationFlowProps): ReactElement | null {
  const effectiveChannelId = channelId ?? '';
  const initialTickets = useMemo(
    () =>
      (draft?.titles ?? []).map((title, i) => ({
        title,
        description: draft?.descriptions[i] ?? '',
      })),
    [draft],
  );

  if (!draft) return null;

  return (
    <BulkCreateTicketsModal
      isOpen={true}
      onClose={onClose}
      channelId={effectiveChannelId}
      initialTickets={initialTickets}
    />
  );
}

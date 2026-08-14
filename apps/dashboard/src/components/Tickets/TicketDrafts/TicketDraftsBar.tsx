import React, { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, Pencil, RotateCw, X } from 'lucide-react';
import type { TicketDraftRow } from '@xyne/shared';
import { useChannel } from '../../../hooks/useChannels';
import { cn } from '../../../utils/classNames';
import { logger, Event } from '../../../utils/logger';
import {
  createBulkTickets,
  discardTicketDraft,
  discardTicketDraftRow,
  draftRowToRequestRow,
  useTicketDrafts,
  type TicketDraft,
} from './ticketDrafts';

interface TicketDraftsBarProps {
  channelId: string | undefined;
  /** null for the channel composer, else the thread's conversation. */
  conversationId: string | null;
  /** Open the bulk modal on a draft so its rows can be edited and resubmitted. */
  onEdit: (draft: TicketDraft) => void;
}

/**
 * The row plus any of its ancestors still in the draft, parents first: a
 * sub-ticket can only be created once its parent exists.
 */
const withDraftAncestors = (draft: TicketDraft, row: TicketDraftRow): TicketDraftRow[] => {
  const byId = new Map(draft.rows.map(r => [r.clientRowId, r]));
  const chain: TicketDraftRow[] = [row];
  let parentId = row.parentClientRowId;
  while (parentId && byId.has(parentId) && chain.length <= draft.rows.length) {
    const parent = byId.get(parentId)!;
    chain.unshift(parent);
    parentId = parent.parentClientRowId;
  }
  return chain;
};

/** What a sub-ticket hangs under: another row of the draft, or a ticket that exists. */
const parentNameOf = (draft: TicketDraft, row: TicketDraftRow): string | null => {
  const inDraft = row.parentClientRowId
    ? draft.rows.find(r => r.clientRowId === row.parentClientRowId)
    : undefined;
  return inDraft?.title ?? row.parentTicketXyneId ?? null;
};

const ChannelName: React.FC<{ channelId: string }> = ({ channelId }) => {
  const channel = useChannel(channelId);
  return <>#{channel?.name ?? 'channel'}</>;
};

/**
 * Bulk ticket rows that failed to create, shown above the composer they came
 * from: a one-line summary that expands into the rows, each with why it failed
 * and Edit / Retry / Discard.
 */
export const TicketDraftsBar: React.FC<TicketDraftsBarProps> = ({
  channelId,
  conversationId,
  onEdit,
}) => {
  const drafts = useTicketDrafts(channelId, conversationId);
  const [expanded, setExpanded] = useState(false);
  // Keys of rows (or `all`) with a request in flight.
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const rows = drafts.flatMap(draft => draft.rows.map(row => ({ draft, row })));
  if (rows.length === 0) return null;

  const rowKey = (draftId: string, row: TicketDraftRow): string => `${draftId}:${row.clientRowId}`;
  const withBusy = async (key: string, work: () => Promise<void>): Promise<void> => {
    setBusy(prev => new Set(prev).add(key));
    try {
      await work();
    } finally {
      setBusy(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const retry = async (draft: TicketDraft, retried: TicketDraftRow[]): Promise<void> => {
    try {
      const data = await createBulkTickets({
        tickets: retried.map(draftRowToRequestRow),
        draftId: draft.id,
      });
      const created = data.results.filter(r => r.status === 'created');
      if (data.failedCount === 0) {
        toast.success(
          created.length === 1 && created[0]?.status === 'created'
            ? `Created ${created[0].ticket.xyneId}`
            : `Created ${created.length} tickets`,
        );
      } else {
        const firstFailure = data.results.find(r => r.status === 'failed');
        toast.error(
          data.createdCount > 0
            ? `${data.createdCount} of ${data.results.length} tickets created`
            : retried.length === 1
              ? "The ticket still couldn't be created"
              : "The tickets still couldn't be created",
          firstFailure?.status === 'failed' ? { description: firstFailure.error.message } : {},
        );
      }
    } catch (error) {
      logger.error(Event.API_CALL_FAILED, { message: 'Retrying ticket draft failed', error });
      toast.error('Failed to retry', { description: 'Please try again.' });
    }
  };

  const discardRow = async (draft: TicketDraft, row: TicketDraftRow): Promise<void> => {
    try {
      await discardTicketDraftRow(draft.id, row.clientRowId);
    } catch (error) {
      logger.error(Event.API_CALL_FAILED, { message: 'Discarding ticket draft row failed', error });
      toast.error('Failed to discard the draft');
    }
  };

  const discardAll = async (): Promise<void> => {
    try {
      await Promise.all(drafts.map(d => discardTicketDraft(d.id)));
    } catch (error) {
      logger.error(Event.API_CALL_FAILED, { message: 'Discarding ticket drafts failed', error });
      toast.error('Failed to discard the drafts');
    }
  };

  const retryAll = async (): Promise<void> => {
    for (const draft of drafts) {
      await retry(draft, draft.rows);
    }
  };

  const isAllBusy = busy.has('all');
  const summary = `${rows.length} ticket${rows.length !== 1 ? 's' : ''} ${rows.length !== 1 ? "weren't" : "wasn't"} created`;

  return (
    <div
      className='mx-3 mb-2 overflow-hidden rounded-lg border border-amber-300/70 bg-amber-50/60 dark:border-amber-700/50 dark:bg-amber-950/20 animate-in slide-in-from-bottom-2 duration-200'
      data-testid='ticket-drafts-bar'
    >
      <div className='flex items-center gap-2 px-3 py-2'>
        <AlertTriangle className='size-4 shrink-0 text-amber-600 dark:text-amber-400' />
        <span className='min-w-0 truncate text-sm text-foreground'>
          {summary}
          <span className='text-muted-foreground'>
            {' '}
            · saved as draft{rows.length !== 1 ? 's' : ''}
          </span>
        </span>
        <div className='ml-auto flex shrink-0 items-center gap-1'>
          {expanded && (
            <button
              type='button'
              disabled={isAllBusy}
              onClick={() => void withBusy('all', retryAll)}
              className='flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50'
              data-track-category='Tickets'
              data-track-name='TicketDraftsRetryAll'
            >
              {isAllBusy ? (
                <Loader2 className='size-3 animate-spin' />
              ) : (
                <RotateCw className='size-3' />
              )}
              Retry all
            </button>
          )}
          <button
            type='button'
            onClick={() => setExpanded(e => !e)}
            className='flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-accent'
            aria-expanded={expanded}
            data-track-category='Tickets'
            data-track-name='TicketDraftsReview'
          >
            {expanded ? 'Hide' : 'Review'}
            {expanded ? <ChevronUp className='size-3' /> : <ChevronDown className='size-3' />}
          </button>
          {!expanded && (
            <button
              type='button'
              disabled={isAllBusy}
              onClick={() => void withBusy('all', discardAll)}
              className='rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50'
              data-track-category='Tickets'
              data-track-name='TicketDraftsDiscardAll'
            >
              Discard
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <ul className='max-h-64 divide-y divide-border/60 overflow-y-auto border-t border-amber-300/50 bg-background/70 dark:border-amber-700/40'>
          {rows.map(({ draft, row }) => {
            const key = rowKey(draft.id, row);
            const isBusy = busy.has(key) || isAllBusy;
            return (
              <li key={key} className='flex items-start gap-3 px-3 py-2'>
                <div className='min-w-0 flex-1'>
                  <div className='flex items-baseline gap-2'>
                    <span className='truncate text-sm font-medium text-foreground'>
                      {row.title}
                    </span>
                    <span className='shrink-0 text-xs text-muted-foreground'>
                      <ChannelName channelId={row.channelId} />
                      {parentNameOf(draft, row) && <> · under {parentNameOf(draft, row)}</>}
                    </span>
                  </div>
                  <p className='mt-0.5 truncate text-xs text-red-600 dark:text-red-400'>
                    {row.error.message}
                  </p>
                </div>
                <div className={cn('flex shrink-0 items-center gap-0.5', isBusy && 'opacity-60')}>
                  <button
                    type='button'
                    disabled={isBusy}
                    onClick={() => onEdit(draft)}
                    title='Edit'
                    className='flex items-center gap-1 rounded-md px-2 py-1 text-xs text-foreground hover:bg-accent'
                    data-track-category='Tickets'
                    data-track-name='TicketDraftEdit'
                  >
                    <Pencil className='size-3' />
                    Edit
                  </button>
                  <button
                    type='button'
                    disabled={isBusy}
                    onClick={() =>
                      void withBusy(key, () => retry(draft, withDraftAncestors(draft, row)))
                    }
                    title='Retry'
                    className='flex items-center gap-1 rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10'
                    data-track-category='Tickets'
                    data-track-name='TicketDraftRetry'
                  >
                    {busy.has(key) ? (
                      <Loader2 className='size-3 animate-spin' />
                    ) : (
                      <RotateCw className='size-3' />
                    )}
                    Retry
                  </button>
                  <button
                    type='button'
                    disabled={isBusy}
                    onClick={() => void withBusy(key, () => discardRow(draft, row))}
                    title='Discard'
                    aria-label={`Discard ${row.title}`}
                    className='rounded-md p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-500'
                    data-track-category='Tickets'
                    data-track-name='TicketDraftDiscard'
                  >
                    <X className='size-3.5' />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default TicketDraftsBar;

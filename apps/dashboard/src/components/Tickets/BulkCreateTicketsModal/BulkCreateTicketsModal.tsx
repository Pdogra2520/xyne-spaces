import React, { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { logger, Event } from '../../../utils/logger';
import {
  Trash2,
  ArrowDownToLine,
  Loader2,
  AlertCircle,
  Check,
  CornerDownRight,
} from 'lucide-react';
import {
  BaseTicketType,
  type CreateBulkTicketRequest,
  type CreateBulkTicketResponse,
  ChannelScopeType,
  LookupType,
  TicketPriority,
  TicketStatusV2,
  type TicketDraftRow,
  MAX_BULK_TICKETS,
} from '@xyne/shared';
import { useAllVisibleChannels } from '../../../hooks/useChannels';
import { useActiveUserSearch } from '../../../hooks/useUsers';
import { useUserGroups } from '../../../hooks/useUserGroup';
import { useAuth } from '../../../hooks/useAuth';
import { useCachedQuery } from '../../../hooks/useCachedQuery';
import { useChannelBoards } from '../../../hooks/useChannelBoards';
import { queries } from '../../../zero/queries';
import { getUserDisplayName } from '../../../utils/userDisplayName';
import { cn } from '../../../utils/classNames';
import { Dialog } from '../../ui/Dialog/Dialog';
import { EntitySelector } from '../../ui/EntitySelector/EntitySelector';
import type { SelectorOption } from '../../ui/EntitySelector/EntitySelector.types';
import Avatar from '../../ui/Avatar/Avatar';
import { DatePicker } from '../../ui/DatePicker/DatePicker';
import { getPriorityOptions } from '../CreateTicketModal/createTicket.utils';
import { createBulkTickets } from '../TicketDrafts/ticketDrafts';
import type { DynamicFieldValue } from '../CreateTicketModal/DynamicFieldInput';
import {
  BoardFormLoader,
  missingFormFields,
  requiredFormFieldCount,
  submittableValues,
  type BoardForm,
  type FieldValues,
} from './boardForms';
import { BulkFieldsPanel } from './BulkFieldsPanel';

export interface BulkTicketPrefill {
  title: string;
  description?: string;
  clientRowId?: string | undefined;
  /** Index of the prefill this one is a sub-ticket of. Parents come first. */
  parentIndex?: number | null;
}

export interface BulkCreateTicketsModalProps {
  isOpen: boolean;
  onClose: () => void;
  channelId?: string | undefined;
  boardId?: string | undefined;
  /** Set by the tickets tab so channels can keep those tickets out of chat. */
  fromTicketsTab?: boolean;
  /** Rows to start with, one per ticket. */
  initialTickets?: BulkTicketPrefill[] | undefined;
  /**
   * Edit a ticket draft: its rows open with their values and the reason each
   * failed, and submitting updates that draft.
   */
  draft?: { id: string; rows: TicketDraftRow[] } | undefined;
  /**
   * Composer the modal was opened from. When some tickets are created and some
   * fail, the failures are saved there as a ticket draft and the modal closes;
   * without it the failures stay in the modal to fix.
   */
  draftTarget?: { channelId: string; conversationId?: string | null } | undefined;
  /** Conversation the tickets come from; its SDLC owner is inherited. */
  sourceConversationId?: string | undefined;
  /** Called after any request that created at least one ticket. */
  onBulkCreated?: (result: CreateBulkTicketResponse) => void;
}

interface BulkRow {
  id: string;
  clientRowId: string | undefined;
  title: string;
  description: string;
  priority: TicketPriority;
  channelId: string;
  boardId: string;
  status: TicketStatusV2;
  assigneeId: string | null;
  ticketType: BaseTicketType;
  eta: Date | null;
  /** This ticket's own form-field values, over its board's shared ones. */
  fieldOverrides: FieldValues;
  /** The row this ticket is a sub-ticket of; it always sits above this row. */
  parentRowId: string | null;
  /** An existing ticket this one is a sub-ticket of (a draft whose parent was created). */
  parentTicket: { id: string; xyneId: string } | null;
  /** Why the last attempt to create this row failed; cleared once it is edited. */
  error: string | null;
}

const PRIORITY_OPTIONS: SelectorOption[] = getPriorityOptions().map(p => ({
  ...p,
  icon: p.icon ?? null,
}));

const GRID_COLS = '36px minmax(0,1.4fr) minmax(0,1.2fr) 100px 130px 130px 140px 100px 120px 32px';
// Sub-tickets nest at most this deep, like lists in the composer.
const MAX_TICKET_DEPTH = 5;

// With a Fields column, before the delete column.
const GRID_COLS_WITH_FIELDS =
  '36px minmax(0,1.4fr) minmax(0,1fr) 96px 120px 124px 136px 92px 112px 84px 32px';

let rowIdSeq = 0;
const newRowId = (): string => `bulk-row-${++rowIdSeq}`;

const newRow = (title: string, channelId: string, boardId: string): BulkRow => ({
  id: newRowId(),
  clientRowId: undefined,
  title,
  description: '',
  priority: TicketPriority.MEDIUM,
  channelId,
  boardId,
  status: TicketStatusV2.TODO,
  assigneeId: null,
  ticketType: BaseTicketType.Fix,
  eta: null,
  fieldOverrides: {},
  parentRowId: null,
  parentTicket: null,
  error: null,
});

const rowFromDraft = (r: TicketDraftRow): BulkRow => ({
  id: newRowId(),
  clientRowId: r.clientRowId,
  title: r.title,
  description: r.description ?? '',
  priority: (r.priority as TicketPriority | undefined) ?? TicketPriority.MEDIUM,
  channelId: r.channelId,
  boardId: r.boardId,
  status: (r.statusV2 as TicketStatusV2 | undefined) ?? TicketStatusV2.TODO,
  assigneeId: r.assignedTo ?? (r.userGroupId ? `group:${r.userGroupId}` : null),
  ticketType: (r.ticketType as BaseTicketType | undefined) ?? BaseTicketType.Fix,
  eta: r.eta ? new Date(r.eta) : null,
  fieldOverrides: r.dynamicFields ?? {},
  parentRowId: null,
  parentTicket: r.parentTicketId
    ? { id: r.parentTicketId, xyneId: r.parentTicketXyneId ?? 'parent' }
    : null,
  error: r.error.message,
});

/** A draft's rows, keeping parents that are rows of the same draft. */
const rowsFromDraft = (draftRows: TicketDraftRow[]): BulkRow[] => {
  const rows = draftRows.map(rowFromDraft);
  const idByClientRowId = new Map(rows.map(r => [r.clientRowId, r.id]));
  return rows.map((row, i) => {
    const parentRowId = draftRows[i]!.parentClientRowId
      ? idByClientRowId.get(draftRows[i]!.parentClientRowId)
      : undefined;
    return parentRowId ? { ...row, parentRowId, parentTicket: null } : row;
  });
};

/** How deep each row sits: 0 at the top, 1 under a top-level row, and so on. */
const depthsOf = (rows: BulkRow[]): Map<string, number> => {
  const depth = new Map<string, number>();
  for (const row of rows) {
    const parentDepth = row.parentRowId ? depth.get(row.parentRowId) : undefined;
    depth.set(row.id, parentDepth === undefined ? (row.parentTicket ? 1 : 0) : parentDepth + 1);
  }
  return depth;
};

const resolveAssignee = (
  assigneeId: string | null,
): { assignedTo?: string; userGroupId?: string } => {
  if (!assigneeId) return {};
  if (assigneeId.startsWith('group:')) return { userGroupId: assigneeId.slice(6) };
  return { assignedTo: assigneeId };
};

interface RowBoardSelectorProps {
  rowId: string;
  channelId: string;
  boardId: string;
  onChange: (rowId: string, patch: Partial<BulkRow>) => void;
}

/**
 * Board picker for one row. Options are the boards linked to that row's channel
 * (channel_board_mappings), never channel.projectId — rows can target different
 * channels, so each row reads its own. Once the mapping has synced, a board that
 * isn't linked to the channel is replaced by the channel's first linked board.
 */
const RowBoardSelector: React.FC<RowBoardSelectorProps> = ({
  rowId,
  channelId,
  boardId,
  onChange,
}) => {
  const { boards, isSynced } = useChannelBoards(channelId || undefined);

  React.useEffect(() => {
    if (!channelId || !isSynced || boards.some(b => b.id === boardId)) return;
    const fallback = boards[0]?.id ?? '';
    if (fallback !== boardId) onChange(rowId, { boardId: fallback });
  }, [channelId, isSynced, boards, boardId, rowId, onChange]);

  const options: SelectorOption[] = useMemo(
    () =>
      boards.map(b => ({
        label: b.name,
        value: b.id,
        icon: (
          <span className='bg-primary text-primary-foreground text-xs aspect-square size-4 rounded text-center'>
            {b.name.charAt(0)}
          </span>
        ),
      })),
    [boards],
  );

  return (
    <EntitySelector
      options={options}
      selectedValue={boardId}
      onSelect={v => onChange(rowId, { boardId: v ?? '' })}
      placeholder={channelId && isSynced && boards.length === 0 ? 'No boards' : 'Board'}
      searchPlaceholder='Search'
      noBorder
      width='100%'
      inputClassName='h-[34px] px-2 gap-1 text-[12.5px] bg-transparent dark:bg-transparent hover:bg-accent/40 justify-between [&>span:first-child]:truncate [&>span:first-child]:flex-1'
    />
  );
};

export const BulkCreateTicketsModal: React.FC<BulkCreateTicketsModalProps> = ({
  isOpen,
  onClose,
  channelId: propChannelId,
  boardId: propBoardId,
  fromTicketsTab = false,
  initialTickets,
  draft,
  draftTarget,
  sourceConversationId,
  onBulkCreated,
}) => {
  const { user } = useAuth();
  const channels = useAllVisibleChannels().filter(c => c.scopeType === ChannelScopeType.DEFAULT);
  const [assigneeSearch, setAssigneeSearch] = useState('');
  const assigneeResults = useActiveUserSearch(assigneeSearch, 50);
  const userGroups = useUserGroups();

  const [rows, setRows] = useState<BulkRow[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Board forms, as BoardFormLoader reports them, and each board's shared values.
  const [boardForms, setBoardForms] = useState<Record<string, BoardForm>>({});
  const [boardValues, setBoardValues] = useState<Record<string, FieldValues>>({});
  // The ticket whose board the fields panel shows, and whether its values fill
  // every ticket on that board or only this one.
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [scopeAll, setScopeAll] = useState(true);

  const onBoardFormLoad = useCallback((boardId: string, form: BoardForm): void => {
    setBoardForms(prev => ({ ...prev, [boardId]: form }));
  }, []);

  const [ticketTypeLookup] = useCachedQuery(
    queries.lookupValuesByType({ type: LookupType.TICKET_TYPE }),
  );

  const ticketTypeOptions: SelectorOption[] = useMemo(() => {
    const seen = new Map<string, SelectorOption>();
    for (const v of Object.values(BaseTicketType)) {
      if (v === BaseTicketType.Support) continue;
      seen.set(v, { label: v, value: v, icon: null });
    }
    for (const t of ticketTypeLookup ?? []) {
      if (t.value && !seen.has(t.value) && t.value !== String(BaseTicketType.Support)) {
        seen.set(t.value, { label: t.value, value: t.value, icon: null });
      }
    }
    return Array.from(seen.values());
  }, [ticketTypeLookup]);

  const channelOptions: SelectorOption[] = useMemo(
    () => channels.map(c => ({ label: c.name ?? c.id, value: c.id, icon: null })),
    [channels],
  );

  const assigneeOptions: SelectorOption[] = useMemo(() => {
    const userOpts: SelectorOption[] = assigneeResults.map(u => ({
      label: getUserDisplayName(u),
      value: u.id,
      icon: <Avatar userId={u.id} size='xs' className='mr-1' />,
    }));
    const groupOpts: SelectorOption[] = (userGroups ?? []).map(g => ({
      label: g.name ?? g.id,
      value: `group:${g.id}`,
      icon: null,
    }));
    return [...userOpts, ...groupOpts];
  }, [assigneeResults, userGroups]);

  // Rows without a board get their channel's first linked board from RowBoardSelector.
  const defaultBoardId = propBoardId ?? '';
  const initDoneRef = useRef(false);

  React.useEffect(() => {
    if (!isOpen) {
      initDoneRef.current = false;
      return;
    }
    if (initDoneRef.current) return;
    initDoneRef.current = true;
    const initChannelId = propChannelId ?? '';
    setBoardValues({});
    setSelectedRowId(null);
    setScopeAll(true);

    if (draft) {
      setRows([...rowsFromDraft(draft.rows), newRow('', initChannelId, defaultBoardId)]);
      return;
    }
    const prefilled = (initialTickets ?? []).map(t => ({
      ...newRow(t.title, initChannelId, defaultBoardId),
      description: t.description || t.title,
      clientRowId: t.clientRowId,
    }));
    (initialTickets ?? []).forEach((t, i) => {
      const parentIndex = t.parentIndex ?? -1;
      // Parents come first; anything else is ignored rather than nesting a row under one below it.
      if (parentIndex >= 0 && parentIndex < i)
        prefilled[i]!.parentRowId = prefilled[parentIndex]!.id;
    });
    const blanks = prefilled.length > 0 ? 1 : 2;
    setRows([
      ...prefilled,
      ...Array.from({ length: blanks }, () => newRow('', initChannelId, defaultBoardId)),
    ]);
  }, [isOpen, draft, initialTickets, propChannelId, defaultBoardId]);

  const ensureEmptyRows = (rows: BulkRow[], count: number): BulkRow[] => {
    const emptyCount = rows.filter(r => !r.title.trim()).length;
    if (emptyCount >= count) return rows;
    const ref = rows[rows.length - 1];
    const channelId = ref?.channelId ?? '';
    const boardId = ref?.boardId ?? '';
    const needed = count - emptyCount;
    return [...rows, ...Array.from({ length: needed }, () => newRow('', channelId, boardId))];
  };

  const updateRow = useCallback((id: string, patch: Partial<BulkRow>): void => {
    setRows(prev => {
      let updated = prev.map(r => {
        if (r.id !== id) return r;
        const next = { ...r, ...patch, error: null };
        // A ticket's own field values belong to its board's form.
        if (patch.boardId !== undefined && patch.boardId !== r.boardId) next.fieldOverrides = {};
        if (patch.title !== undefined && (!r.description.trim() || r.description === r.title)) {
          next.description = patch.title;
        }
        return next;
      });
      // When channel is selected in ANY row, auto-fill channel+board for all rows that don't have one
      if (patch.channelId !== undefined && patch.channelId) {
        const selectedBoardId = updated.find(r => r.id === id)?.boardId || '';
        updated = updated.map(r => ({
          ...r,
          channelId: r.channelId || patch.channelId!,
          boardId: r.boardId || selectedBoardId,
        }));
      }
      // When board is selected in ANY row, auto-fill for rows on the same channel that don't have one
      if (patch.boardId !== undefined && patch.boardId) {
        const selectedChannelId = updated.find(r => r.id === id)?.channelId;
        updated = updated.map(r => ({
          ...r,
          boardId: r.boardId || (r.channelId === selectedChannelId ? patch.boardId! : ''),
        }));
      }
      if (patch.title !== undefined && patch.title.trim()) {
        return ensureEmptyRows(updated, 2);
      }
      return updated;
    });
  }, []);

  const removeRow = (id: string): void => {
    setRows(prev => {
      const removed = prev.find(r => r.id === id);
      // Its sub-tickets move up to its own parent.
      const filtered = prev
        .filter(r => r.id !== id)
        .map(r =>
          r.parentRowId === id
            ? {
                ...r,
                parentRowId: removed?.parentRowId ?? null,
                parentTicket: removed?.parentTicket ?? null,
              }
            : r,
        );
      return ensureEmptyRows(filtered, 1);
    });
  };

  /**
   * Tab makes a row a sub-ticket of the row above it at its level; Shift+Tab
   * moves it out to its parent's level. Its own sub-tickets move with it.
   * Returns whether anything changed, so Tab can fall back to moving focus.
   */
  const changeLevel = (id: string, outdent: boolean): boolean => {
    const index = rows.findIndex(r => r.id === id);
    const row = rows[index];
    if (!row || !row.title.trim()) return false;
    const depths = depthsOf(rows);
    const depth = depths.get(id) ?? 0;
    let patch: Pick<BulkRow, 'parentRowId' | 'parentTicket'> | null = null;
    if (outdent) {
      if (row.parentTicket) patch = { parentRowId: null, parentTicket: null };
      else if (row.parentRowId) {
        const parent = rows.find(r => r.id === row.parentRowId);
        patch = {
          parentRowId: parent?.parentRowId ?? null,
          parentTicket: parent?.parentTicket ?? null,
        };
      }
    } else if (depth < MAX_TICKET_DEPTH) {
      for (let i = index - 1; i >= 0; i--) {
        const above = rows[i]!;
        const aboveDepth = depths.get(above.id) ?? 0;
        if (aboveDepth < depth) break;
        if (aboveDepth === depth && above.title.trim()) {
          patch = { parentRowId: above.id, parentTicket: null };
          break;
        }
      }
    }
    if (!patch) return false;
    const next = patch;
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...next, error: null } : r)));
    return true;
  };

  const applyToAll = (field: 'priority' | 'channelId' | 'boardId' | 'ticketType'): void => {
    if (rows.length === 0) return;
    const firstRow = rows[0];
    if (!firstRow) return;
    const value = firstRow[field];
    // Boards are linked per channel, so a board only carries over to rows on the
    // same channel, and a channel carries its board with it.
    if (field === 'boardId') {
      setRows(prev =>
        prev.map(r =>
          r.channelId === firstRow.channelId ? { ...r, boardId: firstRow.boardId } : r,
        ),
      );
      return;
    }
    if (field === 'channelId') {
      setRows(prev =>
        prev.map(r => ({ ...r, channelId: firstRow.channelId, boardId: firstRow.boardId })),
      );
      return;
    }
    setRows(prev => prev.map(r => ({ ...r, [field]: value })));
  };

  const filledRows = rows.filter(r => r.title.trim().length > 0);
  const rowDepths = useMemo(() => depthsOf(rows), [rows]);
  /**
   * Where a row hangs when submitted: its nearest ancestor that is being
   * submitted too (a parent left without a title is skipped), else an existing
   * ticket, else nowhere.
   */
  const submittedParentOf = (
    row: BulkRow,
  ): { parentClientRowId?: string; parentTicketId?: string } => {
    let parentId = row.parentRowId;
    let parentTicket = row.parentTicket;
    while (parentId) {
      const parent = rows.find(r => r.id === parentId);
      if (!parent) break;
      if (parent.title.trim()) return { parentClientRowId: parent.clientRowId ?? parent.id };
      parentId = parent.parentRowId;
      parentTicket = parent.parentTicket;
    }
    return parentTicket ? { parentTicketId: parentTicket.id } : {};
  };
  const validCount = filledRows.filter(r => r.description.trim().length > 0).length;

  // ── Board form fields ──────────────────────────────────────────────────
  const usedBoardIds = useMemo(
    () => Array.from(new Set(rows.map(r => r.boardId).filter(Boolean))),
    [rows],
  );
  const rowNumber = (row: BulkRow): number => rows.indexOf(row) + 1;
  const valuesFor = (row: BulkRow): FieldValues => ({
    ...(boardValues[row.boardId] ?? {}),
    ...row.fieldOverrides,
  });
  /** What the ticket still needs from its board, or null while that board's form loads. */
  const missingFor = (row: BulkRow): string[] | null => {
    const form = boardForms[row.boardId];
    if (!form) return null;
    const missing = missingFormFields(form, valuesFor(row));
    if (form.mandatory.userGroupOnly && !row.assigneeId?.startsWith('group:')) {
      missing.push('user group');
    } else if (form.mandatory.assignee && !row.assigneeId) {
      missing.push('assignee');
    }
    if (form.mandatory.dueDate && !row.eta) missing.push('due date');
    return missing;
  };
  const requiredCountFor = (row: BulkRow): number => {
    const form = boardForms[row.boardId];
    if (!form) return 0;
    return (
      requiredFormFieldCount(form, valuesFor(row)) +
      (form.mandatory.assignee || form.mandatory.userGroupOnly ? 1 : 0) +
      (form.mandatory.dueDate ? 1 : 0)
    );
  };
  const hasFields = (row: BulkRow): boolean => (boardForms[row.boardId]?.fields.length ?? 0) > 0;
  const showFields = filledRows.some(hasFields);
  const gridCols = showFields ? GRID_COLS_WITH_FIELDS : GRID_COLS;
  const rowsMissing = filledRows.filter(r => (missingFor(r)?.length ?? 0) > 0);
  const formsLoading = filledRows.some(r => r.boardId && !boardForms[r.boardId]);

  // The panel follows the selected ticket; without one, the first that needs something.
  const selectedRow =
    filledRows.find(r => r.id === selectedRowId && hasFields(r)) ??
    rowsMissing.find(hasFields) ??
    filledRows.find(hasFields);
  const selectedForm = selectedRow ? boardForms[selectedRow.boardId] : undefined;
  const rowsOnSelectedBoard = selectedRow
    ? filledRows.filter(r => r.boardId === selectedRow.boardId)
    : [];
  // One ticket on its board: shared and own values are the same thing.
  const panelScopeAll = scopeAll || rowsOnSelectedBoard.length <= 1;
  const panelValues: FieldValues = selectedRow
    ? panelScopeAll
      ? (boardValues[selectedRow.boardId] ?? {})
      : valuesFor(selectedRow)
    : {};
  const panelErrors: Record<string, string> = {};
  if (selectedForm && selectedRow) {
    for (const fieldName of missingFormFields(selectedForm, panelValues)) {
      if (!panelScopeAll) {
        panelErrors[fieldName] = 'Required';
        continue;
      }
      const needing = rowsOnSelectedBoard.filter(r => missingFor(r)?.includes(fieldName));
      if (needing.length === 0) continue;
      panelErrors[fieldName] =
        needing.length === rowsOnSelectedBoard.length
          ? rowsOnSelectedBoard.length > 1
            ? `Required for all ${rowsOnSelectedBoard.length} tickets`
            : 'Required'
          : `Ticket ${needing.map(rowNumber).join(', ')} still ${needing.length === 1 ? 'needs' : 'need'} it`;
    }
  }
  const keptByField: Record<string, number[]> = {};
  for (const r of rowsOnSelectedBoard) {
    for (const fieldName of Object.keys(r.fieldOverrides)) {
      (keptByField[fieldName] ??= []).push(rowNumber(r));
    }
  }

  const onPanelChange = (fieldName: string, value: DynamicFieldValue): void => {
    if (!selectedRow) return;
    if (panelScopeAll) {
      setBoardValues(prev => ({
        ...prev,
        [selectedRow.boardId]: { ...(prev[selectedRow.boardId] ?? {}), [fieldName]: value },
      }));
      return;
    }
    setRows(prev =>
      prev.map(r =>
        r.id === selectedRow.id
          ? { ...r, error: null, fieldOverrides: { ...r.fieldOverrides, [fieldName]: value } }
          : r,
      ),
    );
  };
  const resetToSharedValue = (fieldName: string): void => {
    if (!selectedRow) return;
    setRows(prev =>
      prev.map(r => {
        if (r.id !== selectedRow.id) return r;
        const { [fieldName]: _dropped, ...rest } = r.fieldOverrides;
        return { ...r, fieldOverrides: rest };
      }),
    );
  };
  const selectRow = (row: BulkRow, ownScope = false): void => {
    setSelectedRowId(row.id);
    if (ownScope) setScopeAll(false);
  };

  const blockingReason = ((): string | null => {
    if (filledRows.length === 0) return 'Add at least one ticket';
    if (filledRows.length > MAX_BULK_TICKETS) {
      return `Create at most ${MAX_BULK_TICKETS} tickets at a time`;
    }
    if (filledRows.some(r => !r.description.trim())) return 'Every ticket needs a description';
    if (filledRows.some(r => !r.channelId)) return 'Every ticket needs a channel';
    if (filledRows.some(r => !r.boardId)) return 'Every ticket needs a board';
    if (formsLoading) return 'Loading board fields…';
    const first = rowsMissing[0];
    if (first) {
      return rowsMissing.length === 1
        ? `Ticket ${rowNumber(first)} is missing ${(missingFor(first) ?? []).join(', ')}`
        : `${rowsMissing.length} tickets are missing required fields`;
    }
    return null;
  })();
  const allValid = blockingReason === null;
  // The missing-fields reason is the only one the panel can fix, so only it links there.
  const allBasicsValid = filledRows.every(r => r.description.trim() && r.channelId && r.boardId);
  const failedCount = rows.filter(r => r.error).length;

  const handleSubmit = async (): Promise<void> => {
    if (!allValid || !user || filledRows.length === 0) return;
    setIsSubmitting(true);
    try {
      // Every filled row needs an id the response can be matched back to.
      const submitted = filledRows.map(r => ({ ...r, clientRowId: r.clientRowId ?? r.id }));
      const body: CreateBulkTicketRequest = {
        tickets: submitted.map(r => ({
          title: r.title.trim(),
          description: r.description,
          priority: r.priority,
          statusV2: r.status,
          ...(r.eta ? { eta: r.eta } : {}),
          channelId: r.channelId,
          boardId: r.boardId,
          ...resolveAssignee(r.assigneeId),
          ticketType: r.ticketType,
          ...((): { dynamicFields?: FieldValues } => {
            const form = boardForms[r.boardId];
            const values = form ? submittableValues(form, valuesFor(r)) : {};
            return Object.keys(values).length > 0 ? { dynamicFields: values } : {};
          })(),
          ...submittedParentOf(r),
          clientRowId: r.clientRowId,
        })),
        ...(draftTarget ? { draftTarget } : {}),
        ...(draft ? { draftId: draft.id, replaceDraft: true } : {}),
        ...(sourceConversationId ? { sourceConversationId } : {}),
        ...(fromTicketsTab ? { fromTicketsTab: true } : {}),
      };
      const data = await createBulkTickets(body);
      const total = data.results.length;

      if (data.createdCount > 0) onBulkCreated?.(data);

      // Created, but not hung under their parent: say so rather than claim success.
      const unlinked = data.results.filter(r => r.status === 'created' && r.warning).length;
      if (unlinked > 0) {
        toast.warning(
          `${unlinked} sub-ticket${unlinked !== 1 ? 's were' : ' was'} created but not linked to ${unlinked !== 1 ? 'their parents' : 'its parent'}`,
          { description: 'Link them from the parent ticket.' },
        );
      }

      if (data.failedCount === 0) {
        toast.success(`Created ${total} ticket${total !== 1 ? 's' : ''}`);
        onClose();
        return;
      }

      if (data.createdCount > 0 && data.draftId) {
        toast.warning(
          `${data.createdCount} of ${total} tickets created · ${data.failedCount} saved as draft${data.failedCount !== 1 ? 's' : ''}`,
          { description: 'Find them above the message box to fix and retry.' },
        );
        onClose();
        return;
      }

      // Keep the failures here to fix: drop the rows that became tickets and
      // show each remaining row why it failed.
      const errorById = new Map<string, string>();
      const createdById = new Map<string, { id: string; xyneId: string }>();
      for (const result of data.results) {
        if (!result.clientRowId) continue;
        if (result.status === 'created') createdById.set(result.clientRowId, result.ticket);
        else errorById.set(result.clientRowId, result.error.message);
      }
      const byRowId = new Map(submitted.map(r => [r.id, r.clientRowId]));
      const createdFor = (rowId: string | null): { id: string; xyneId: string } | undefined =>
        rowId ? createdById.get(byRowId.get(rowId) ?? '') : undefined;
      setRows(prev =>
        ensureEmptyRows(
          prev
            .filter(r => !createdFor(r.id))
            .map(r => {
              const clientRowId = byRowId.get(r.id);
              const error = clientRowId ? errorById.get(clientRowId) : undefined;
              // A parent that now exists is held as that ticket, so retrying links under it.
              const createdParent = createdFor(r.parentRowId);
              const relinked = createdParent
                ? { ...r, parentRowId: null, parentTicket: createdParent }
                : r;
              return error ? { ...relinked, clientRowId, error } : relinked;
            }),
          1,
        ),
      );
      if (data.createdCount > 0) {
        toast.warning(`${data.createdCount} of ${total} tickets created`, {
          description: 'Fix the highlighted rows and try again.',
        });
      } else {
        toast.error(
          total === 1 ? "The ticket couldn't be created" : 'None of the tickets could be created',
          { description: 'Fix the highlighted rows and try again.' },
        );
      }
    } catch (error) {
      logger.error(Event.API_CALL_FAILED, {
        message: 'Bulk ticket creation failed',
        error,
      });
      toast.error('Failed to create tickets', {
        description: 'Please try again or contact support.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={open => {
        if (!open) onClose();
      }}
      title={draft ? 'Ticket drafts' : 'Create tickets'}
      className={cn('rounded-2xl overflow-hidden', showFields ? 'max-w-[1400px]' : 'max-w-6xl')}
      onOpenAutoFocus={e => e.preventDefault()}
    >
      <div className='flex flex-col' style={{ maxHeight: '88vh' }}>
        {/* Toolbar */}
        <div className='flex items-center gap-3 px-4 py-2.5 shrink-0 flex-wrap border-b border-border'>
          <span className='text-[12px] text-muted-foreground'>
            {failedCount > 0
              ? `${failedCount} ticket${failedCount !== 1 ? 's' : ''} couldn't be created — fix the highlighted rows and try again`
              : 'New rows appear automatically as you fill in titles'}
          </span>

          <span className='ml-auto text-[12px] text-muted-foreground font-medium'>
            {validCount} ready
          </span>
        </div>

        {usedBoardIds.map(boardId => (
          <BoardFormLoader key={boardId} boardId={boardId} onLoad={onBoardFormLoad} />
        ))}

        <div className='flex flex-1 min-h-0'>
          {/* Grid */}
          <div className='flex-1 min-w-0 min-h-0 p-4'>
            <div className='h-full rounded-xl border border-border overflow-hidden flex flex-col'>
              {/* Column headers */}
              <div
                className='grid sticky top-0 z-10 bg-muted/50 border-b border-border text-[10.5px] font-semibold text-muted-foreground uppercase tracking-wider shrink-0'
                style={{ gridTemplateColumns: gridCols }}
              >
                <div className='flex items-center justify-center h-9' />
                <ColumnHeader label='Title' />
                <ColumnHeader label='Description' />
                <ColumnHeader label='Priority' onApply={() => applyToAll('priority')} />
                <ColumnHeader label='Channel' onApply={() => applyToAll('channelId')} />
                <ColumnHeader label='Board' onApply={() => applyToAll('boardId')} />
                <ColumnHeader label='Assignee' />
                <ColumnHeader label='Type' onApply={() => applyToAll('ticketType')} />
                <div className='flex items-center px-2 h-9'>Due</div>
                {showFields && <div className='flex items-center px-2 h-9'>Fields</div>}
                <div className='flex items-center justify-center h-9' />
              </div>

              {/* Rows */}
              <div
                className='overflow-y-auto flex-1 min-h-0
              [&::-webkit-scrollbar]:w-2
              [&::-webkit-scrollbar-thumb]:rounded-full
              [&::-webkit-scrollbar-thumb]:bg-border
              [&::-webkit-scrollbar-track]:bg-transparent'
              >
                {rows.map((row, idx) => {
                  const hasTitle = row.title.trim().length > 0;
                  const invalid = hasTitle && !row.description.trim();
                  const isEmpty = !hasTitle;
                  const depth = rowDepths.get(row.id) ?? 0;
                  const parentIndex = row.parentRowId
                    ? rows.findIndex(r => r.id === row.parentRowId)
                    : -1;
                  const parentLabel =
                    parentIndex >= 0 ? `#${parentIndex + 1}` : (row.parentTicket?.xyneId ?? null);
                  const missing = hasTitle ? missingFor(row) : null;
                  const isSelected = selectedRow?.id === row.id;
                  const inScope =
                    !isSelected &&
                    panelScopeAll &&
                    hasTitle &&
                    row.boardId === selectedRow?.boardId;
                  const form = boardForms[row.boardId];
                  const assigneeRequired =
                    hasTitle && !!form && (form.mandatory.assignee || form.mandatory.userGroupOnly);
                  const dueRequired = hasTitle && !!form?.mandatory.dueDate;
                  return (
                    <div
                      key={row.id}
                      onFocusCapture={() => {
                        if (hasTitle && hasFields(row) && selectedRowId !== row.id)
                          setSelectedRowId(row.id);
                      }}
                      className={cn(
                        'border-b border-border/40 last:border-b-0 transition-colors',
                        (invalid || row.error || (missing?.length ?? 0) > 0) &&
                          'shadow-[inset_3px_0_0_0] shadow-red-500',
                        row.error && 'bg-red-500/[0.04]',
                        showFields && isSelected && 'bg-primary/[0.06]',
                        showFields && inScope && 'bg-primary/[0.025]',
                        isEmpty && 'opacity-50',
                      )}
                    >
                      <div
                        className='grid items-center'
                        style={{ gridTemplateColumns: gridCols, minHeight: '44px' }}
                      >
                        {/* Index */}
                        <div className='flex items-center justify-center'>
                          <span className='text-[10.5px] text-muted-foreground/50 font-mono'>
                            {idx + 1}
                          </span>
                        </div>

                        {/* Title, indented under its parent */}
                        <div
                          className='flex items-center gap-0.5 pr-2 min-w-0 overflow-hidden'
                          style={{ paddingLeft: 4 + Math.min(depth, MAX_TICKET_DEPTH) * 12 }}
                        >
                          {depth > 0 && (
                            <span
                              className='shrink-0 text-muted-foreground/70'
                              {...(parentLabel ? { title: `Sub-ticket of ${parentLabel}` } : {})}
                            >
                              <CornerDownRight className='size-3.5' aria-hidden='true' />
                            </span>
                          )}
                          <input
                            value={row.title}
                            onChange={e => updateRow(row.id, { title: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === 'Tab' && changeLevel(row.id, e.shiftKey))
                                e.preventDefault();
                            }}
                            aria-label={
                              parentLabel
                                ? `Ticket title, sub-ticket of ${parentLabel}`
                                : 'Ticket title'
                            }
                            placeholder='Ticket title'
                            data-track-category='Tickets'
                            data-track-name='BulkTicketTitle'
                            {...(parentLabel ? { title: `Sub-ticket of ${parentLabel}` } : {})}
                            className={cn(
                              'flex-1 min-w-0 h-[34px] bg-transparent border-none outline-none px-1.5 text-[13px] truncate',
                              'text-foreground placeholder:text-muted-foreground rounded-md',
                              'focus:bg-accent/40 focus:ring-1 focus:ring-primary/30',
                            )}
                          />
                        </div>

                        {/* Description — a textarea, not an input: an input strips
                          line breaks from its value, so a multi-line description
                          would both render as one run-on line and lose its
                          blank lines the moment the field was edited. */}
                        <div className='px-2 min-w-0 py-1'>
                          <textarea
                            value={row.description}
                            onChange={e => updateRow(row.id, { description: e.target.value })}
                            placeholder='Description'
                            rows={1}
                            data-track-category='Tickets'
                            data-track-name='BulkTicketDescription'
                            className={cn(
                              'w-full min-w-0 min-h-[34px] max-h-[140px] resize-y overflow-auto',
                              'bg-transparent border-none outline-none px-2 py-[7px] text-[12.5px] leading-[20px]',
                              'text-muted-foreground placeholder:text-muted-foreground/60 rounded-md',
                              'focus:bg-accent/40 focus:ring-1 focus:ring-primary/30',
                            )}
                          />
                        </div>

                        {/* Priority */}
                        <div className='px-1 overflow-hidden'>
                          <EntitySelector
                            options={PRIORITY_OPTIONS}
                            selectedValue={row.priority}
                            onSelect={v => updateRow(row.id, { priority: v as TicketPriority })}
                            placeholder='Priority'
                            searchPlaceholder='Search'
                            noBorder
                            width='100%'
                            inputClassName='h-[34px] px-2 gap-1 text-[12.5px] bg-transparent dark:bg-transparent hover:bg-accent/40 justify-between [&>span:first-child]:truncate [&>span:first-child]:flex-1'
                          />
                        </div>

                        {/* Channel */}
                        <div className='px-1 overflow-hidden'>
                          <EntitySelector
                            options={channelOptions}
                            selectedValue={row.channelId}
                            onSelect={v => updateRow(row.id, { channelId: v ?? '' })}
                            placeholder='Channel'
                            searchPlaceholder='Search'
                            noBorder
                            width='100%'
                            inputClassName='h-[34px] px-2 gap-1 text-[12.5px] bg-transparent dark:bg-transparent hover:bg-accent/40 justify-between [&>span:first-child]:truncate [&>span:first-child]:flex-1'
                          />
                        </div>

                        {/* Board */}
                        <div className='px-1 overflow-hidden'>
                          <RowBoardSelector
                            rowId={row.id}
                            channelId={row.channelId}
                            boardId={row.boardId}
                            onChange={updateRow}
                          />
                        </div>

                        {/* Assignee */}
                        <div className='px-1 overflow-hidden'>
                          <EntitySelector
                            options={assigneeOptions}
                            selectedValue={row.assigneeId ?? ''}
                            onSelect={v => updateRow(row.id, { assigneeId: v || null })}
                            placeholder={assigneeRequired ? 'Required' : 'Unassigned'}
                            searchPlaceholder='Search users'
                            onSearchChange={setAssigneeSearch}
                            disableClientFiltering
                            noBorder
                            width='100%'
                            inputClassName={cn(
                              'h-[34px] px-2 gap-1 text-[12.5px] bg-transparent dark:bg-transparent hover:bg-accent/40 justify-between [&>span:first-child]:truncate [&>span:first-child]:flex-1',
                              assigneeRequired && !row.assigneeId && 'text-destructive',
                            )}
                            showClearButton
                          />
                        </div>

                        {/* Type */}
                        <div className='px-1 overflow-hidden'>
                          <EntitySelector
                            options={ticketTypeOptions}
                            selectedValue={row.ticketType}
                            onSelect={v => updateRow(row.id, { ticketType: v as BaseTicketType })}
                            placeholder='Type'
                            searchPlaceholder='Search'
                            noBorder
                            width='100%'
                            inputClassName='h-[34px] px-2 gap-1 text-[12.5px] bg-transparent dark:bg-transparent hover:bg-accent/40 justify-between [&>span:first-child]:truncate [&>span:first-child]:flex-1'
                          />
                        </div>

                        {/* Due Date */}
                        <div className='px-1 overflow-hidden flex items-center'>
                          <DatePicker
                            selectedDate={row.eta}
                            onSelect={date => updateRow(row.id, { eta: date })}
                            placeholder={dueRequired ? 'Required' : 'No date'}
                            showClearButton
                            inputClassName={cn(
                              'h-[34px] text-[11px] border-0 shadow-none bg-transparent hover:bg-accent/40 w-full',
                              dueRequired && !row.eta && 'text-destructive',
                            )}
                          />
                        </div>

                        {/* Fields */}
                        {showFields && (
                          <div className='px-1'>
                            {hasTitle && hasFields(row) && missing && (
                              <button
                                type='button'
                                onClick={() => selectRow(row)}
                                aria-label={
                                  missing.length > 0
                                    ? `Ticket ${idx + 1} is missing ${missing.join(', ')}`
                                    : `Fields complete for ticket ${idx + 1}`
                                }
                                className={cn(
                                  'inline-flex h-[24px] items-center gap-1 rounded-full px-2 text-[11.5px] font-medium',
                                  missing.length > 0
                                    ? 'border border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300'
                                    : 'text-muted-foreground hover:bg-accent/40',
                                  isSelected && 'ring-2 ring-primary/40',
                                )}
                                data-track-category='Tickets'
                                data-track-name='BulkTicketFields'
                              >
                                {missing.length > 0 ? (
                                  `${missing.length} left`
                                ) : (
                                  <>
                                    <Check className='size-3' />
                                    {requiredCountFor(row) > 0
                                      ? `${requiredCountFor(row)}/${requiredCountFor(row)}`
                                      : 'Done'}
                                  </>
                                )}
                                {Object.keys(row.fieldOverrides).length > 0 && (
                                  <span
                                    className='size-1.5 rounded-full bg-primary'
                                    title='Has its own values'
                                  />
                                )}
                              </button>
                            )}
                          </div>
                        )}

                        {/* Delete */}
                        <div className='flex items-center justify-center'>
                          <button
                            type='button'
                            onClick={() => removeRow(row.id)}
                            className='size-6 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-500 flex items-center justify-center transition'
                            title='Remove row'
                            data-track-category='Tickets'
                            data-track-name='BulkTicketRemoveRow'
                          >
                            <Trash2 className='size-3.5' />
                          </button>
                        </div>
                      </div>

                      {row.error && (
                        <div className='flex items-center gap-1.5 pb-2 pl-[44px] pr-4 text-[11.5px] text-red-600 dark:text-red-400'>
                          <AlertCircle className='size-3.5 shrink-0' />
                          <span className='truncate'>{row.error}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {showFields && selectedRow && selectedForm && (
            <BulkFieldsPanel
              form={selectedForm}
              ticketNumber={rowNumber(selectedRow)}
              ticketTitle={selectedRow.title}
              ticketsOnBoard={rowsOnSelectedBoard.map(rowNumber)}
              scopeAll={panelScopeAll}
              onScopeChange={setScopeAll}
              values={panelValues}
              onChange={onPanelChange}
              errors={panelErrors}
              ownFields={new Set(Object.keys(selectedRow.fieldOverrides))}
              onUseShared={resetToSharedValue}
              keptByField={keptByField}
            />
          )}
        </div>

        {/* Footer */}
        <div className='flex items-center justify-between px-5 py-3 border-t border-border shrink-0'>
          {blockingReason && rowsMissing[0] && !formsLoading && allBasicsValid ? (
            <button
              type='button'
              onClick={() => selectRow(rowsMissing[0]!, true)}
              className='text-[12px] text-destructive truncate text-left hover:underline underline-offset-2'
              data-track-category='Tickets'
              data-track-name='BulkTicketJumpToMissing'
            >
              {blockingReason}
            </button>
          ) : blockingReason ? (
            <p className='text-[12px] text-destructive truncate'>{blockingReason}</p>
          ) : (
            <p className='text-[12px] text-muted-foreground truncate'>
              {validCount} ticket{validCount !== 1 ? 's' : ''} ready
            </p>
          )}
          <div className='flex items-center gap-2 shrink-0'>
            <button
              type='button'
              onClick={onClose}
              className='text-[13px] font-medium text-foreground px-3 py-1.5 rounded-lg hover:bg-accent transition'
              data-track-category='Tickets'
              data-track-name='BulkTicketCancel'
            >
              Cancel
            </button>
            <button
              type='button'
              onClick={() => {
                void handleSubmit();
              }}
              disabled={!allValid || isSubmitting}
              {...(blockingReason ? { title: blockingReason } : {})}
              className={cn(
                'text-[13px] font-medium text-primary-foreground bg-primary px-3 py-1.5 rounded-lg flex items-center gap-1 transition',
                (!allValid || isSubmitting) && 'opacity-50 cursor-not-allowed',
              )}
              data-track-category='Tickets'
              data-track-name='BulkTicketSubmit'
            >
              {isSubmitting ? <Loader2 className='size-3.5 animate-spin' /> : null}
              {isSubmitting
                ? `Creating ${filledRows.length} ticket${filledRows.length !== 1 ? 's' : ''}…`
                : failedCount > 0
                  ? 'Retry'
                  : 'Create tickets'}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
};

const ColumnHeader: React.FC<{ label: string; onApply?: () => void }> = ({ label, onApply }) => (
  <div className='flex items-center gap-1 px-2 h-9 group'>
    <span>{label}</span>
    {onApply && (
      <button
        type='button'
        onClick={onApply}
        title={`Apply row 1's ${label.toLowerCase()} to all`}
        className='text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition'
        data-track-category='Tickets'
        data-track-name={`BulkTicketApply${label}`}
      >
        <ArrowDownToLine className='size-3' />
      </button>
    )}
  </div>
);

export default BulkCreateTicketsModal;

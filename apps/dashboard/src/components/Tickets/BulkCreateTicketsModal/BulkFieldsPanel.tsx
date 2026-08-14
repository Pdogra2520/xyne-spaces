import React, { useCallback, useMemo, useState } from 'react';
import { useUsers } from '../../../hooks/useUsers';
import { cn } from '../../../utils/classNames';
import { DynamicFieldInput, type DynamicFieldValue } from '../CreateTicketModal/DynamicFieldInput';
import { activeFieldsOf, type BoardForm, type FieldValues } from './boardForms';

export interface BulkFieldsPanelProps {
  form: BoardForm;
  /** 1-based number of the selected ticket, and its title. */
  ticketNumber: number;
  ticketTitle: string;
  /** Tickets in the batch on this board, as 1-based numbers. */
  ticketsOnBoard: number[];
  /** true: values fill every ticket on the board; false: only the selected one. */
  scopeAll: boolean;
  onScopeChange: (all: boolean) => void;
  /** What the inputs show: the board's shared values, or the selected ticket's own. */
  values: FieldValues;
  onChange: (fieldName: string, value: DynamicFieldValue) => void;
  /** Required fields left empty for what the inputs show, by field name. */
  errors: Record<string, string>;
  /** Fields the selected ticket overrides (only used for its own scope). */
  ownFields: ReadonlySet<string>;
  onUseShared: (fieldName: string) => void;
  /** For the shared scope: ticket numbers that keep their own value, by field name. */
  keptByField: Record<string, number[]>;
  projectId?: string | undefined;
}

const listNumbers = (nums: number[]): string =>
  nums.length === 1 ? `Ticket ${nums[0]}` : `Tickets ${nums.join(', ')}`;

/**
 * The selected ticket's board fields, beside the bulk grid. Only that board is
 * shown — selecting another ticket moves the panel to its board — and the
 * values fill either every ticket on the board or just the selected one.
 */
export const BulkFieldsPanel: React.FC<BulkFieldsPanelProps> = ({
  form,
  ticketNumber,
  ticketTitle,
  ticketsOnBoard,
  scopeAll,
  onScopeChange,
  values,
  onChange,
  errors,
  ownFields,
  onUseShared,
  keptByField,
  projectId,
}) => {
  const allUsers = useUsers();
  const users = useMemo(() => allUsers ?? [], [allUsers]);
  const userMap = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);
  const [searchQueries, setSearchQueries] = useState<Record<string, string>>({});
  const [openStates, setOpenStates] = useState<Record<string, boolean>>({});
  const onSearchChange = useCallback(
    (fieldName: string, q: string) => setSearchQueries(prev => ({ ...prev, [fieldName]: q })),
    [],
  );
  const onOpenChange = useCallback(
    (fieldName: string, open: boolean) => setOpenStates(prev => ({ ...prev, [fieldName]: open })),
    [],
  );

  const fields = useMemo(() => activeFieldsOf(form, values), [form, values]);
  const many = ticketsOnBoard.length > 1;

  const segment = (label: string, active: boolean, onClick: () => void): React.ReactElement => (
    <button
      type='button'
      role='tab'
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'h-[28px] flex-1 truncate rounded-[7px] px-2 text-[12px] transition-colors',
        active
          ? 'bg-background font-semibold text-foreground shadow-[0_1px_2px_rgba(20,22,26,.10)]'
          : 'font-medium text-muted-foreground hover:text-foreground',
      )}
      data-track-category='Tickets'
      data-track-name='BulkFieldsScope'
      data-track-metadata={JSON.stringify({ scope: active ? label : undefined })}
    >
      {label}
    </button>
  );

  return (
    <aside
      aria-label={`${form.boardName} fields`}
      className='flex w-[320px] shrink-0 flex-col border-l border-border bg-muted/40 min-h-0'
    >
      <div className='flex shrink-0 flex-col gap-3 px-[18px] pb-3 pt-[14px]'>
        <div className='flex min-w-0 flex-col gap-0.5'>
          <span className='flex items-center gap-2 text-[13.5px] font-semibold text-foreground'>
            <span className='flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-primary text-[10.5px] text-primary-foreground'>
              {form.boardName.charAt(0)}
            </span>
            <span className='truncate'>{form.boardName} fields</span>
          </span>
          <span className='truncate text-[12px] text-muted-foreground'>
            Ticket {ticketNumber} · {ticketTitle || 'Untitled'}
          </span>
        </div>

        {many && (
          <div
            role='tablist'
            aria-label='Apply values to'
            className='flex gap-0.5 rounded-[9px] bg-muted p-[3px]'
          >
            {segment(`All ${ticketsOnBoard.length} on ${form.boardName}`, scopeAll, () =>
              onScopeChange(true),
            )}
            {segment(`Ticket ${ticketNumber} only`, !scopeAll, () => onScopeChange(false))}
          </div>
        )}
        {many && (
          <p className='m-0 text-[11.5px] leading-[1.45] text-muted-foreground'>
            {scopeAll
              ? `Values here fill every ticket on ${form.boardName}. Switch to ticket ${ticketNumber} only to give it its own value.`
              : `Values here apply to ticket ${ticketNumber} only. Other tickets on ${form.boardName} keep the shared values.`}
          </p>
        )}
      </div>

      <div className='no-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[18px] pb-[18px] pt-1'>
        {fields.map(field => {
          const kept = keptByField[field.fieldName] ?? [];
          return (
            <div key={field.id} className='flex flex-col gap-1'>
              <DynamicFieldInput
                field={field}
                value={values[field.fieldName] ?? ''}
                {...(errors[field.fieldName] !== undefined && { error: errors[field.fieldName] })}
                onChange={onChange}
                {...(projectId !== undefined && { projectId })}
                allUsers={users}
                userMap={userMap}
                searchQuery={searchQueries[field.fieldName] ?? ''}
                onSearchChange={onSearchChange}
                isOpen={openStates[field.fieldName] ?? false}
                onOpenChange={onOpenChange}
              />
              {!scopeAll && ownFields.has(field.fieldName) && many && (
                <span className='flex items-center gap-1.5 text-[11.5px] text-primary'>
                  Ticket {ticketNumber} has its own value.
                  <button
                    type='button'
                    onClick={() => onUseShared(field.fieldName)}
                    className='underline underline-offset-2 hover:no-underline'
                    data-track-category='Tickets'
                    data-track-name='BulkFieldsUseShared'
                  >
                    Use shared value
                  </button>
                </span>
              )}
              {scopeAll && kept.length > 0 && (
                <span className='text-[11.5px] text-muted-foreground'>
                  {listNumbers(kept)} {kept.length === 1 ? 'keeps its' : 'keep their'} own value.
                </span>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
};

export default BulkFieldsPanel;

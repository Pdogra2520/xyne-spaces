import React from 'react';
import {
  FormContextType,
  FormEntityType,
  FormFieldType,
  isFieldActive,
  orderFieldsWithBranchChildrenAfterParent,
  type BoardMetadata,
} from '@xyne/shared';
import { useCachedQuery } from '../../../hooks/useCachedQuery';
import { queries } from '../../../zero/queries';
import {
  resolveDisplayFormFields,
  type ResolvedDisplayFormField,
} from '../../../utils/board/resolveDisplayFormFields';
import { filterActiveDynamicFieldValues } from '../CreateTicketModal/createTicket.utils';
import type { DynamicFieldValue } from '../CreateTicketModal/DynamicFieldInput';

export type FieldValues = Record<string, DynamicFieldValue>;

/** What a board asks of each ticket created on it. */
export interface BoardForm {
  boardId: string;
  boardName: string;
  /** The board's form fields as single create shows them: visible ones, branches after their parent. */
  fields: ResolvedDisplayFormField[];
  /** Every field of the form, for resolving which branch fields apply. */
  allFields: ResolvedDisplayFormField[];
  /** Built-in fields the board makes mandatory, as single create enforces them. */
  mandatory: { assignee: boolean; userGroupOnly: boolean; dueDate: boolean };
}

const isEmpty = (value: DynamicFieldValue | undefined): boolean =>
  value === undefined || (Array.isArray(value) ? value.length === 0 : !value.trim());

const effectiveValueOf =
  (form: BoardForm, values: FieldValues) =>
  (fieldId: string): string | undefined => {
    const field = form.allFields.find(f => f.id === fieldId);
    const raw = field ? values[field.fieldName] : undefined;
    return typeof raw === 'string' ? raw : undefined;
  };

/** The board's fields that apply given these values (inactive branch fields drop out). */
export const activeFieldsOf = (form: BoardForm, values: FieldValues): ResolvedDisplayFormField[] =>
  form.fields.filter(field => isFieldActive(field, form.allFields, effectiveValueOf(form, values)));

/** Names of the required form fields left empty, in the order the panel shows them. */
export const missingFormFields = (form: BoardForm, values: FieldValues): string[] =>
  activeFieldsOf(form, values)
    .filter(f => f.isOptional !== true && f.fieldType !== FormFieldType.DOC)
    .filter(f => isEmpty(values[f.fieldName]))
    .map(f => f.fieldName);

export const requiredFormFieldCount = (form: BoardForm, values: FieldValues): number =>
  activeFieldsOf(form, values).filter(
    f => f.isOptional !== true && f.fieldType !== FormFieldType.DOC,
  ).length;

/** The values to send: filled, and only for fields that currently apply. */
export const submittableValues = (form: BoardForm, values: FieldValues): FieldValues => {
  const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => !isEmpty(v)));
  return filterActiveDynamicFieldValues(form.allFields, filled);
};

interface BoardFormLoaderProps {
  boardId: string;
  onLoad: (boardId: string, form: BoardForm) => void;
}

/**
 * Loads one board's form and reports it once synced. One is mounted per board
 * the batch uses, since a hook cannot be called once per board in a loop.
 */
export const BoardFormLoader: React.FC<BoardFormLoaderProps> = ({ boardId, onLoad }) => {
  const [board, boardDetails] = useCachedQuery(queries.getBoardById({ boardId }));
  const [mapping, mappingDetails] = useCachedQuery(
    queries.getFormMappingByContextId({
      contextId: boardId,
      contextType: FormContextType.BOARD,
      entityType: FormEntityType.TICKET,
    }),
  );
  const synced = boardDetails.type === 'complete' && mappingDetails.type === 'complete';

  React.useEffect(() => {
    if (!synced) return;
    const metadata = (board?.metadata ?? null) as BoardMetadata | null;
    const allFields = mapping?.formFields
      ? resolveDisplayFormFields(mapping.formId, [...mapping.formFields])
      : [];
    const visibility = metadata?.customFieldVisibility;
    const visible = visibility ? allFields.filter(f => visibility[f.id] !== false) : allFields;
    const config = metadata?.ticketFormConfig;
    onLoad(boardId, {
      boardId,
      boardName: board?.name ?? 'Board',
      fields: orderFieldsWithBranchChildrenAfterParent(
        [...visible].sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0)),
      ),
      allFields,
      mandatory: {
        assignee: (config?.assignedTo?.enabled ?? true) && (config?.assignedTo?.mandatory ?? false),
        userGroupOnly:
          (config?.userGroupsOnly?.enabled ?? false) &&
          (config?.userGroupsOnly?.mandatory ?? false),
        dueDate: (config?.dueDate?.enabled ?? true) && (config?.dueDate?.mandatory ?? false),
      },
    });
  }, [synced, board, mapping, boardId, onLoad]);

  return null;
};

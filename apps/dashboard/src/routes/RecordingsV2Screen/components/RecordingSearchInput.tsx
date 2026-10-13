import * as Popover from '@radix-ui/react-popover';
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import Avatar from '../../../components/ui/Avatar/Avatar';
import { LexicalSearchInput } from '../../../components/Chat/ChatDirectory/LexicalSearchInput';
import { ChipType } from '../../../components/Chat/ChatDirectory/ChannelCommandMenu.types';
import { useActiveUserSearch } from '../../../hooks/useUsers';
import { cn } from '../../../utils/classNames';
import { getUserDisplayName } from '../../../utils/userDisplayName';

const OWNER_SUGGESTION_LIMIT = 8;

type InsertMention = (item: { id: string; name: string; email?: string }) => void;

interface RecordingSearchInputProps {
  /** Free text (matched against title and transcript) and the `@owner` chips. */
  onChange: (text: string, ownerIds: string[]) => void;
  isMobile: boolean;
  currentUserId?: string;
}

/** Recordings search box: free text plus `@person` chips that filter by owner. */
export function RecordingSearchInput({
  onChange,
  isMobile,
  currentUserId,
}: RecordingSearchInputProps): ReactElement {
  const [ownerQuery, setOwnerQuery] = useState<string | null>(null);
  const [selectedOwnerIds, setSelectedOwnerIds] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hasNavigated, setHasNavigated] = useState(false);
  const insertMentionRef = useRef<InsertMention | null>(null);

  const userResults = useActiveUserSearch(ownerQuery ?? '', OWNER_SUGGESTION_LIMIT);
  const ownerSuggestions = useMemo(() => {
    if (ownerQuery === null) return [];
    const selected = new Set(selectedOwnerIds);
    return userResults
      .filter(candidate => !selected.has(candidate.id))
      .slice(0, OWNER_SUGGESTION_LIMIT);
  }, [ownerQuery, selectedOwnerIds, userResults]);

  const closeOwnerSearch = useCallback((): void => {
    setOwnerQuery(null);
    setSelectedIndex(0);
    setHasNavigated(false);
  }, []);

  const handleUserSearch = useCallback((query: string | null): void => {
    setOwnerQuery(query);
    setSelectedIndex(0);
    setHasNavigated(false);
  }, []);

  const handleChange = useCallback(
    (text: string, mentions: Array<{ id: string; type: ChipType }>): void => {
      const ownerIds = mentions
        .filter(mention => mention.type === ChipType.USER)
        .map(mention => mention.id);
      setSelectedOwnerIds(ownerIds);
      onChange(text, ownerIds);
    },
    [onChange],
  );

  return (
    <Popover.Root open={ownerQuery !== null} modal={false}>
      <Popover.Anchor asChild>
        <div className='relative w-full sm:w-72'>
          <LexicalSearchInput
            placeholder={selectedOwnerIds.length ? '' : 'Search title, transcript, @owner'}
            onChange={handleChange}
            onUserSearch={handleUserSearch}
            availableUsers={ownerSuggestions.map(candidate => ({
              id: candidate.id,
              name: getUserDisplayName(candidate),
              ...(candidate.email ? { email: candidate.email } : {}),
            }))}
            mentionSearchType={ownerQuery !== null ? ChipType.USER : null}
            selectedMentionIndex={selectedIndex}
            setSelectedMentionIndex={setSelectedIndex}
            onNavigate={() => setHasNavigated(true)}
            hasNavigated={hasNavigated}
            onInsertMentionReady={insertMention => {
              insertMentionRef.current = insertMention;
            }}
            onMentionInserted={closeOwnerSearch}
            open={true}
            disableAutoFocus
            {...(currentUserId ? { currentUserID: currentUserId } : {})}
            className='flex h-9 w-full items-center overflow-hidden rounded-xl border border-border bg-background pr-3 focus-within:ring-1 focus-within:ring-ring [&>div]:w-full'
          />
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side='bottom'
          align='start'
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={event => event.preventDefault()}
          onInteractOutside={closeOwnerSearch}
          onEscapeKeyDown={closeOwnerSearch}
          className='z-[9999] w-[var(--radix-popover-trigger-width)] min-w-64 overflow-hidden rounded-md border border-border bg-popover shadow-lg'
        >
          {ownerSuggestions.length > 0 ? (
            <ul className='max-h-64 overflow-y-auto py-1'>
              {ownerSuggestions.map((candidate, index) => (
                <li key={candidate.id}>
                  <button
                    type='button'
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-left text-sm',
                      !isMobile && 'hover:bg-accent hover:text-accent-foreground',
                      index === selectedIndex && hasNavigated && 'bg-accent text-accent-foreground',
                    )}
                    data-track-category='RecordingsV2'
                    data-track-name='recording_search_select_owner'
                    onMouseEnter={() => {
                      setSelectedIndex(index);
                      setHasNavigated(true);
                    }}
                    onClick={() => {
                      insertMentionRef.current?.({
                        id: candidate.id,
                        name: getUserDisplayName(candidate),
                        ...(candidate.email ? { email: candidate.email } : {}),
                      });
                    }}
                  >
                    <Avatar userId={candidate.id} size='sm' showActiveStatus={false} />
                    <span className='flex min-w-0 flex-col'>
                      <span className='truncate font-medium'>{getUserDisplayName(candidate)}</span>
                      <span className='truncate text-xs text-muted-foreground'>
                        {candidate.email}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className='px-3 py-3 text-sm text-muted-foreground'>No people found</div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { CallType } from '@xyne/shared';
import { searchService } from '../services/searchService';
import type { VespaSearchFilters } from '../types/search';
import { VespaApps } from '../components/Chat/ChatDirectory/ChannelCommandMenu.types';
import { queries } from '../zero/queries';
import { useCachedQuery } from './useCachedQuery';
import type { OatsRecordingEntry } from './usePaginatedOatsRecordings';

const SEARCH_DEBOUNCE_MS = 300;
// One page of hits; also the most ids oatsRecordingsByIds accepts.
const SEARCH_LIMIT = 100;
// `unified` scopes file docs to fileName only, which would skip the transcript itself.
const RECORDING_SEARCH_RANK_PROFILE = 'default_native';

interface UseRecordingSearchParams {
  text: string;
  ownerIds: string[];
}

interface UseRecordingSearchResult {
  /** True while a query or owner filter is set — the list should show `results`. */
  isActive: boolean;
  isSearching: boolean;
  error: string | null;
  /** Matching recordings, newest first. */
  results: OatsRecordingEntry[];
}

/**
 * Searches the recordings the viewer can open by title, transcript and owner. Vespa
 * ranks the transcript docs (docId = call id); the rows themselves come from Zero, so a
 * hit renders, updates and acts exactly like a row of the paginated list.
 */
export function useRecordingSearch({
  text,
  ownerIds,
}: UseRecordingSearchParams): UseRecordingSearchResult {
  const query = text.trim();
  const ownerKey = ownerIds.join(',');
  const isActive = query.length > 0 || ownerKey.length > 0;

  const [matchedIds, setMatchedIds] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isActive) {
      setMatchedIds([]);
      setIsSearching(false);
      setError(null);
      return;
    }

    setIsSearching(true);
    const abortController = new AbortController();
    const timer = setTimeout(() => {
      const filters: VespaSearchFilters = {
        query,
        // `type=transcript` (not a `subApp=transcript` param) maps to subApp TRANSCRIPT,
        // which is what applies the transcript access check on the backend.
        type: 'transcript',
        apps: VespaApps.FILE,
        callType: CallType.HEADLESS,
        rankProfile: RECORDING_SEARCH_RANK_PROFILE,
        limit: SEARCH_LIMIT,
        offset: 0,
        filterOnly: query.length === 0,
        ...(ownerKey ? { from: ownerKey } : {}),
      };

      searchService
        .vespaSearch(filters, abortController.signal)
        .then(response => {
          if (abortController.signal.aborted) return;
          setMatchedIds(response.results.map(result => result.id));
          setError(null);
        })
        .catch((err: unknown) => {
          if (abortController.signal.aborted) return;
          setMatchedIds([]);
          setError(err instanceof Error ? err.message : 'Search failed');
        })
        .finally(() => {
          if (!abortController.signal.aborted) setIsSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return (): void => {
      clearTimeout(timer);
      abortController.abort();
    };
  }, [isActive, query, ownerKey]);

  const [rows, details] = useCachedQuery(queries.oatsRecordingsByIds({ ids: matchedIds }), {
    enabled: matchedIds.length > 0,
  });

  const results = useMemo<OatsRecordingEntry[]>(() => {
    if (!isActive || matchedIds.length === 0 || !rows) return [];
    return [...(rows as readonly OatsRecordingEntry[])].sort(
      (left, right) => right.startedAt - left.startedAt || right.id.localeCompare(left.id),
    );
  }, [isActive, matchedIds.length, rows]);

  return {
    isActive,
    // Hits are known but their rows are still syncing from Zero.
    isSearching:
      isSearching || (matchedIds.length > 0 && details.type !== 'complete' && results.length === 0),
    error,
    results,
  };
}

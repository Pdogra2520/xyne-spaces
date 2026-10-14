import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { CallType } from '@xyne/shared';
import { db } from '@/database/client';
import { vespaQueue } from '@/queues/vespaQueue';
import { logger } from '@/utils/logger';
import { fileSchema, SubApp } from '@/vespa/src/types';
import {
  runRecordingSearchFieldsBackfill,
  getRecordingSearchFieldsBackfillStatus,
} from '@/bypassAcl/recordingBackfillServices';

/**
 * One-off backfill: refresh the search fields of every recording's Vespa transcript doc.
 *
 * Recordings search reads four fields off the transcript doc (file schema, subApp
 * TRANSCRIPT, docId = call id) that older docs carry stale or not at all:
 *   - `fileName`    — the title; a rename used to update only the call doc, so recordings
 *     renamed before the transcript doc followed renames still carry their old title.
 *   - `permissions` — was the call's participants; is now everyone the recording's live
 *     shares reach (mapper.computeRecordingPermissions), so recordings shared before the
 *     change are missing from the recipients' search.
 *   - `isPrivate`   — was always true; is now false for a PUBLIC recording.
 *   - `labels`      — new field; the recording's confirmed label slugs.
 * New and edited recordings already get all four (mapTranscript, the share/label syncs),
 * so this only catches up the docs nothing has touched since.
 *
 * It only enqueues: each job is a field-scoped `update` that vespaFileWorker's TRANSCRIPT
 * fast path recomputes from Postgres, so no transcript is downloaded or re-embedded. The
 * live vespaQueue is used, the same queue the share/label syncs put these jobs on; batches
 * and the delay between them keep the extra load small.
 *
 * Idempotent: every job recomputes from Postgres, so re-running only rewrites the same values.
 */

const TAG = '[RecordingSearchFieldsBackfill]';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_DELAY_MS = 5_000;
/** Keeps one request under proxy timeouts: 20 x (50 jobs + 5s) ~= 100s. */
const DEFAULT_MAX_BATCHES = 20;
const MAX_BATCH_SIZE = 500;
const SEARCH_FIELDS = ['fileName', 'permissions', 'isPrivate', 'labels'];

type BackfillOptions = {
  batchSize: number;
  delayMs: number;
  maxBatches: number;
  dryRun: boolean;
  cursor: string | null;
};

type CandidateCall = {
  id: string;
  workspaceId: string | null;
};

export class RecordingSearchFieldsBackfillController {
  static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private static buildOptions(body: unknown): BackfillOptions {
    const payload = (body ?? {}) as Partial<BackfillOptions>;
    const batchSize =
      typeof payload.batchSize === 'number' && payload.batchSize > 0
        ? Math.min(Math.floor(payload.batchSize), MAX_BATCH_SIZE)
        : DEFAULT_BATCH_SIZE;
    const delayMs =
      typeof payload.delayMs === 'number' && payload.delayMs >= 0
        ? Math.floor(payload.delayMs)
        : DEFAULT_DELAY_MS;
    const maxBatches =
      typeof payload.maxBatches === 'number' && payload.maxBatches > 0
        ? Math.floor(payload.maxBatches)
        : DEFAULT_MAX_BATCHES;

    return {
      batchSize,
      delayMs,
      maxBatches,
      dryRun: payload.dryRun === true,
      cursor: typeof payload.cursor === 'string' && payload.cursor.length > 0 ? payload.cursor : null,
    };
  }

  /** Recordings that have a transcript doc — no transcript means nothing in Vespa to update. */
  static candidateWhere(): Prisma.CallWhereInput {
    return {
      callType: CallType.HEADLESS,
      transcript: { not: null },
    };
  }

  /** The next `batchSize` recordings after `cursor`, in id order. */
  static async collectBatch(
    batchSize: number,
    cursor: string | null,
  ): Promise<{ calls: CandidateCall[]; nextCursor: string | null; exhausted: boolean }> {
    const calls = await db.call.findMany({
      where: {
        ...RecordingSearchFieldsBackfillController.candidateWhere(),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, workspaceId: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    const last = calls[calls.length - 1];
    return {
      calls,
      nextCursor: last ? last.id : cursor,
      exhausted: calls.length < batchSize,
    };
  }

  /** Enqueue the field-scoped refresh for one recording's transcript doc. */
  static async enqueueRefresh(call: CandidateCall): Promise<boolean> {
    try {
      await vespaQueue.addJob({
        schema: fileSchema,
        jobType: 'update',
        docId: call.id,
        app: SubApp.TRANSCRIPT,
        fields: SEARCH_FIELDS,
        ...(call.workspaceId ? { workspaceId: call.workspaceId } : {}),
      });
      return true;
    } catch (error) {
      logger.warn(`${TAG} failed to enqueue refresh for recording ${call.id}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Recordings left to enqueue after `cursor`. */
  static async countRemaining(cursor: string | null): Promise<number> {
    return db.call.count({
      where: {
        ...RecordingSearchFieldsBackfillController.candidateWhere(),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
    });
  }

  /**
   * POST /api/admin/recording-search-backfill/run
   * Body: { batchSize?: 50, delayMs?: 5000, maxBatches?: 20, dryRun?: false, cursor?: string }
   *
   * Pass the `nextCursor` from the previous response back in to continue where the
   * last request stopped; omit it to start from the beginning.
   */
  static run = async (req: Request, res: Response): Promise<void> => {
    const options = RecordingSearchFieldsBackfillController.buildOptions(req.body);
    const startedAt = Date.now();

    logger.info(`${TAG} started`, { ...options });

    try {
      const result = await runRecordingSearchFieldsBackfill(options, startedAt);
      res.json(result);
    } catch (error) {
      logger.error(`${TAG} failed`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({ success: false, error: 'Recording search fields backfill failed' });
    }
  };

  /**
   * GET /api/admin/recording-search-backfill/status
   * `recordings` is how many transcript docs a full run enqueues.
   */
  static status = async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await getRecordingSearchFieldsBackfillStatus();
      res.json(result);
    } catch (error) {
      logger.error(`${TAG} status failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Failed to read backfill status' });
    }
  };
}

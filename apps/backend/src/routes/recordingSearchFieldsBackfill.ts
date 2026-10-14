import { Router } from 'express';
import { AccessType } from '@xyne/shared';
import { RecordingSearchFieldsBackfillController } from '@/controllers/recordingSearchFieldsBackfillController';
import { authMiddleware } from '@/middleware/auth';
import { authorize } from '@/middleware/authorize';

const router = Router();
const adminAuth = authorize('TICKET-MIGRATION', AccessType.ADMIN);

/**
 * @route GET /api/admin/recording-search-backfill/status
 * @desc Read-only counts: `recordings` (every HEADLESS call — one job each in a full
 *       run) and `withoutTranscript` (those whose job is a full feed rather than an update).
 * @access TICKET-MIGRATION Admin only
 */
router.get(
  '/status',
  authMiddleware.authenticate,
  adminAuth,
  RecordingSearchFieldsBackfillController.status,
);

/**
 * @route POST /api/admin/recording-search-backfill/run
 * @desc Enqueue a field-scoped Vespa refresh (fileName, permissions, isPrivate, labels) of every
 *       recording's transcript doc — or, for a recording without a transcript, a full feed
 *       of one — in batches, pausing between them.
 *       Body: { batchSize?: 50, delayMs?: 5000, maxBatches?: 20, dryRun?: false,
 *               cursor?: string }
 *       Returns per-batch { batch, enqueued, failed, remaining }, the totals, `done`
 *       and `nextCursor`. Pass `nextCursor` back as `cursor` to continue where the
 *       previous request stopped. Idempotent — safe to re-run.
 *
 *       Needs the Vespa schema with the `labels` field deployed first, and a backend
 *       whose vespaFileWorker handles `fileName` and `labels` on the TRANSCRIPT fast path.
 * @access TICKET-MIGRATION Admin only
 */
router.post(
  '/run',
  authMiddleware.authenticate,
  adminAuth,
  RecordingSearchFieldsBackfillController.run,
);

export default router;

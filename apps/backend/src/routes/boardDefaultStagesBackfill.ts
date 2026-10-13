import { Router } from 'express';
import { AccessType } from '@xyne/shared';
import { BoardDefaultStagesBackfillController } from '@/controllers/boardDefaultStagesBackfillController';
import { authMiddleware } from '@/middleware/auth';
import { authorize } from '@/middleware/authorize';

const router = Router();

const adminAuth = authorize('TICKET-MIGRATION', AccessType.ADMIN);

/**
 * route POST /migrate/api/admin/board-default-stages-backfill
 * desc Seeds the default stages on DEFAULT / NON_LINEAR boards that have none. Dry run by
 *       default. Body: { dryRun?: boolean, boardIds?: string[], batchSize?: number, delayMs?: number }
 * access TICKET-MIGRATION Admin only
 *
 * Mounted from xyne-spaces-private's routes/privateBackfillRoutes.ts, like the other
 * one-off backfill routes.
 */
router.post(
  '/',
  authMiddleware.authenticate,
  adminAuth,
  BoardDefaultStagesBackfillController.triggerBackfill
);

export default router;

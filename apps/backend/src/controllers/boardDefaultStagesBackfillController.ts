import { Request, Response } from 'express';
import {
  runBoardDefaultStagesBackfillAsSystem,
  type BoardDefaultStagesBackfillOptions,
} from '@/bypassAcl/boardDefaultStagesBackfillServices';
import { logger } from '@/utils/logger';
import { ApiResponse } from '@/types/express';

export class BoardDefaultStagesBackfillController {
  private static buildOptions(body: unknown): BoardDefaultStagesBackfillOptions {
    const payload = (body ?? {}) as Partial<{
      batchSize: number;
      delayMs: number;
      dryRun: boolean;
      boardIds: unknown;
    }>;
    const batchSize = payload.batchSize && payload.batchSize > 0 ? payload.batchSize : 200;
    const delayMs = payload.delayMs && payload.delayMs >= 0 ? payload.delayMs : 500;
    // Default to a dry run: writing needs an explicit `dryRun: false`.
    const dryRun = payload.dryRun !== false;
    const boardIds = Array.isArray(payload.boardIds)
      ? payload.boardIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : undefined;
    return { batchSize, delayMs, dryRun, ...(boardIds?.length ? { boardIds } : {}) };
  }

  /**
   * route POST /migrate/api/admin/board-default-stages-backfill
   * desc One-time repair: seeds BACKLOG / IN PROGRESS / COMPLETED / NOT REQUIRED on every
   *       DEFAULT or NON_LINEAR board that has no stages (ticket creation fails on those).
   *       RELEASE and FLOW boards are reported but never touched.
   *       Body: { dryRun?: boolean (default true), boardIds?: string[], batchSize?: number,
   *       delayMs?: number }. Waits for the run and returns the per-board summary.
   * access TICKET-MIGRATION Admin only
   */
  static async triggerBackfill(req: Request, res: Response<ApiResponse>): Promise<Response> {
    const options = BoardDefaultStagesBackfillController.buildOptions(req.body);
    try {
      const summary = await runBoardDefaultStagesBackfillAsSystem(options);
      return res.status(200).json({
        success: true,
        message: options.dryRun
          ? 'Board default-stages backfill dry run complete (nothing written)'
          : 'Board default-stages backfill complete',
        data: { options, summary },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[BoardDefaultStagesBackfill] Run failed', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Board default-stages backfill failed',
        timestamp: new Date().toISOString(),
      });
    }
  }
}

import { repositories } from '@/database/repositories';
import { vespaQueue } from '@/queues/vespaQueue';
import { appSchema } from '@/vespa/src/types';
import { logger } from '@/utils/logger';
import type { CreateAppInput } from '@/database/repositories/appsRepository';

/**
 * Create an org app and queue its Vespa feed. Shared by AppController.createApp and
 * provisionOrgApp (S2S) so the two create paths stay in sync.
 */
export async function createOrgApp(data: CreateAppInput) {
  const app = await repositories.apps.createApp(data);
  vespaQueue
    .addJob({ schema: appSchema, jobType: 'feed', docId: app.id })
    .catch((err) => logger.error(`Failed to queue Vespa feed for app ${app.id}:`, err));
  return app;
}

/**
 * Set the app template's permissions and bump its version so existing installs surface the
 * Update prompt. Shared by permissionController.setPermissions and ensureOrgAppConfig (S2S).
 * Callers that want idempotent no-op behaviour should diff before calling (see ensureOrgAppConfig).
 */
export async function setAppTemplatePermissions(appId: string, scopes: string[]): Promise<void> {
  await repositories.appPermissions.setAppPermissions(appId, scopes);
  await repositories.apps.bumpVersion(appId);
}

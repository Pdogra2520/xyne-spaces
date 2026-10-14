import { transaction } from '../base';
import { db } from '@/database/client';
import { logger } from '@/utils/logger';
import { Prisma } from '@prisma/client';
import { retryOnWriteConflict } from './callMessageMetadataTx';

/**
 * Writes the AI-generated title onto the call message and keeps the original "call ended" text in
 * metadata. Runs as a SERIALIZABLE transaction retried on P2034 (same pattern as the sharing
 * services) so a concurrent Canvas-URL metadata merge cannot drop this write or vice versa.
 *
 * No raw SQL: `content` is read through Prisma so the field-encryption extension decrypts it.
 * The previous raw `SELECT "content" ... FOR UPDATE` returned ciphertext, which ended up in
 * `metadata.callEndedText` and rendered as garbage on the call bubble.
 */
export function processCallWithSummaryTx(messageId: string, title: string) {
  return retryOnWriteConflict(() =>
    transaction(['Message'], 'processCallWithSummary: call message title update must commit atomically; tx is not ACL-wrapped', db, async (tx) => {
      const message = await tx.message.findUnique({
        where: { messageId },
        select: { content: true, metadata: true },
      });
      if (!message) {
        logger.warn(`Call message ${messageId} not found for title update`);
        return;
      }
      await tx.message.update({
        where: { messageId },
        data: {
          content: title,
          metadata: {
            ...(message.metadata as any),
            callTitle: title,
            callEndedText: message.content,
          },
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
  );
}

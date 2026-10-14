/**
 * Runs a SERIALIZABLE transaction and retries it when Postgres aborts it with a write conflict
 * (Prisma error P2034). Used by the two writers that merge into a call message's `metadata`
 * JSON (title update and Canvas URL attachment) so neither can discard the other's keys without
 * a raw `FOR UPDATE` row lock. Mirrors the retry loop in summaryTemplateSharingService.
 */
export async function retryOnWriteConflict<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const isWriteConflict = (error as { code?: string } | null)?.code === 'P2034';
      if (!isWriteConflict || attempt === attempts) throw error;
    }
  }
  throw new Error('Call message metadata transaction retry limit exceeded');
}

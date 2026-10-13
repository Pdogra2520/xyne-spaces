import { transaction } from '../base';
import { db } from '@/database/client';

export interface ReplaceActiveAuthSessionInput {
  orgMemberId: string;
  orgId: string;
  deviceKey: string;
  tokenHash: string;
  status: string;
  revokedStatus: string;
  platform: string;
  absExpiry: Date;
  deviceInfo: string;
}

/** Revoke the device's active auth session and create its replacement atomically. */
export function replaceActiveAuthSessionTx(input: ReplaceActiveAuthSessionInput) {
  return transaction(
    ['AuthSession'],
    'login: revoking the device\'s previous active auth session and creating the new one must commit atomically; tx is not ACL-wrapped',
    db,
    async tx => {
      await tx.authSession.updateMany({
        where: { orgMemberId: input.orgMemberId, deviceKey: input.deviceKey, status: input.status },
        data: { status: input.revokedStatus, revokedAt: new Date() },
      });
      return tx.authSession.create({
        data: {
          orgMemberId: input.orgMemberId,
          orgId: input.orgId,
          tokenHash: input.tokenHash,
          deviceKey: input.deviceKey,
          status: input.status,
          platform: input.platform,
          absExpiry: input.absExpiry,
          deviceInfo: input.deviceInfo,
        },
      });
    },
  );
}

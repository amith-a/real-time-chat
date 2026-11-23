import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName } from './client';
import { presenceKey } from './keys';
import type { IsoTimestamp, PresenceItem } from './types';

export interface Presence {
  online: boolean;
  activeConnectionCount: number;
  lastSeenAt?: IsoTimestamp;
}

/** AP13: presence is derived from the counter. There is no stored status flag. */
export async function getPresence(userId: string, consistent = false): Promise<Presence> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: presenceKey(userId),
      ConsistentRead: consistent,
    }),
  );
  const item = out.Item as PresenceItem | undefined;
  const count = item?.activeConnectionCount ?? 0;
  return { online: count > 0, activeConnectionCount: count, lastSeenAt: item?.lastSeenAt };
}

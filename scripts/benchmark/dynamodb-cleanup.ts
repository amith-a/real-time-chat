import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  CONNECTION_PREFIX,
  getDocClient,
  getTableName,
  idempotencyKey,
  roomPartitionKey,
  userPartitionKey,
} from '../../src/repositories';
import { BENCHMARK_ROOM_PREFIX } from './config';

/**
 * Strongly consistent base-table verification that $disconnect removed all
 * DynamoDB connection records for benchmark users. Throws if connections remain after 6 attempts.
 */
export async function verifyDisconnectCleanup(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;

  const ddb = getDocClient();
  const tableName = getTableName();
  const maxAttempts = 6;
  const pollDelayMs = 500;
  let remainingUsers = [...userIds];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stillConnected: string[] = [];

    for (let i = 0; i < remainingUsers.length; i += 10) {
      const chunk = remainingUsers.slice(i, i + 10);
      const counts = await Promise.all(
        chunk.map(async (uid) => {
          const res = await ddb.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
              ExpressionAttributeValues: {
                ':pk': userPartitionKey(uid),
                ':prefix': CONNECTION_PREFIX,
              },
              ConsistentRead: true,
              Select: 'COUNT',
            }),
          );
          return { uid, count: res.Count ?? 0 };
        }),
      );
      for (const c of counts) {
        if (c.count > 0) {
          stillConnected.push(c.uid);
        }
      }
    }

    remainingUsers = stillConnected;
    if (remainingUsers.length === 0) {
      console.log(
        `[Cleanup] Verified $disconnect removed connection records for all ${userIds.length} users (strongly consistent).`,
      );
      return;
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, pollDelayMs));
    }
  }

  throw new Error(
    `Disconnect verification failed: ${remainingUsers.length}/${userIds.length} benchmark users still have active connection records after ${maxAttempts} attempts.`,
  );
}

/**
 * Retries DynamoDB BatchWriteCommand until all UnprocessedItems are cleared.
 * Throws if items remain unprocessed after max retries.
 */
async function batchDeleteWithRetry(keys: Array<{ PK: string; SK: string }>): Promise<number> {
  if (keys.length === 0) return 0;
  const ddb = getDocClient();
  const tableName = getTableName();
  let deleted = 0;

  for (let i = 0; i < keys.length; i += 25) {
    let requests = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    let attempt = 0;

    while (requests.length > 0 && attempt < 6) {
      const res = await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [tableName]: requests },
        }),
      );
      const unprocessed = res.UnprocessedItems?.[tableName] ?? [];
      deleted += requests.length - unprocessed.length;
      requests = unprocessed as typeof requests;
      if (requests.length > 0) {
        attempt++;
        await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }

    if (requests.length > 0) {
      throw new Error(
        `DynamoDB BatchWriteCommand left ${requests.length} UnprocessedItems after retries.`,
      );
    }
  }

  return deleted;
}

async function queryKeysByPk(pk: string): Promise<Array<{ PK: string; SK: string }>> {
  const ddb = getDocClient();
  const tableName = getTableName();
  const keys: Array<{ PK: string; SK: string }> = [];

  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: startKey,
      }),
    );
    if (res.Items) {
      for (const item of res.Items) {
        keys.push({ PK: item.PK as string, SK: item.SK as string });
      }
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);

  return keys;
}

/**
 * Ownership-safe, reliable cleanup of benchmark room data.
 * Refuses to operate on any roomId that does not carry the benchmark-room- prefix.
 */
export async function cleanupBenchmarkRoom(roomId: string, userIds: string[]): Promise<void> {
  if (!roomId.startsWith(BENCHMARK_ROOM_PREFIX)) {
    throw new Error(
      `Refusing cleanup: roomId '${roomId}' does not start with '${BENCHMARK_ROOM_PREFIX}'.`,
    );
  }

  const ddb = getDocClient();
  const tableName = getTableName();
  const roomPk = roomPartitionKey(roomId);
  const keysToDelete: Array<{ PK: string; SK: string }> = await queryKeysByPk(roomPk);

  let resolvedUserIds = userIds;
  if (resolvedUserIds.length === 0) {
    const memberKeys: string[] = [];
    let gsiStartKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
          ExpressionAttributeValues: { ':pk': roomPk, ':sk': 'MEMBER#' },
          ProjectionExpression: 'PK, SK, userId',
          ExclusiveStartKey: gsiStartKey,
        }),
      );
      if (res.Items) {
        for (const item of res.Items) {
          keysToDelete.push({ PK: item.PK as string, SK: item.SK as string });
          if (typeof item.userId === 'string') {
            memberKeys.push(item.userId);
          }
        }
      }
      gsiStartKey = res.LastEvaluatedKey;
    } while (gsiStartKey);
    resolvedUserIds = memberKeys;
  } else {
    for (const userId of resolvedUserIds) {
      keysToDelete.push({ PK: userPartitionKey(userId), SK: roomPk });
    }
  }

  // Clean up idempotency records created by the sender for this benchmark room
  if (resolvedUserIds.length > 0) {
    const idempPk = idempotencyKey(resolvedUserIds[0], roomId, 'probe').PK;
    const idempKeys = await queryKeysByPk(idempPk);
    keysToDelete.push(...idempKeys);
  }

  const deletedCount = await batchDeleteWithRetry(keysToDelete);
  console.log(`[Cleanup] Removed ${deletedCount} benchmark items for ${roomPk}.`);
}

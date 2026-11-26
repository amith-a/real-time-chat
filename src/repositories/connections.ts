import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ForbiddenError, InternalServerError } from '../shared/errors';
import { getDocClient, getTableName, queryAll, queryPage } from './client';
import {
  cancellationReasons,
  conditionFailedAt,
  isConditionalCheckFailed,
  isTransactionCanceled,
  sendWithRetry,
} from './dynamo-errors';
import {
  CONNECTION_PREFIX,
  connectionKey,
  connectionOwnerKey,
  presenceKey,
  userPartitionKey,
} from './keys';
import type { ConnectionItem, ConnectionOwnerItem, IsoTimestamp, Page } from './types';

export interface ConnectionOptions {
  /** Maintain the CONN#<id>/OWNER reverse item. Defaults to true to ensure $disconnect can resolve owners even if authorizer context is omitted by API Gateway. */
  withOwnerItem?: boolean;
}

/** AP2 (single): get one connection. */
export async function getConnection(
  userId: string,
  connectionId: string,
  consistent = false,
): Promise<ConnectionItem | undefined> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: connectionKey(userId, connectionId),
      ConsistentRead: consistent,
    }),
  );
  return out.Item as ConnectionItem | undefined;
}

/** AP2: all active connections for a user. */
export async function listUserConnections(userId: string): Promise<ConnectionItem[]> {
  return queryAll<ConnectionItem>({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': userPartitionKey(userId), ':prefix': CONNECTION_PREFIX },
  });
}

/** AP2 (paginated): active connections for a user, one page at a time. */
export async function listUserConnectionsPage(
  userId: string,
  options: { limit?: number; startKey?: Record<string, unknown> } = {},
): Promise<Page<ConnectionItem>> {
  return queryPage<ConnectionItem>(
    {
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': userPartitionKey(userId), ':prefix': CONNECTION_PREFIX },
      Limit: options.limit ?? 50,
    },
    options.startKey,
  );
}

/** Reverse lookup, used only when the owner cannot be read from the authorizer context. */
export async function getConnectionOwner(connectionId: string): Promise<string | undefined> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: connectionOwnerKey(connectionId),
      ConsistentRead: true,
    }),
  );
  return (out.Item as ConnectionOwnerItem | undefined)?.userId;
}

export interface RegisterResult {
  /** True if this call created the connection; false if it was already registered. */
  registered: boolean;
  /** True only for the single atomic 0 -> 1 transition that brings the user online. */
  becameOnline?: boolean;
}

/**
 * AP3: create the connection and increment the presence counter atomically.
 * Uses a conditional 0 -> 1 transition on PRESENCE so concurrent $connect invocations
 * race-safely elect exactly one caller with `becameOnline: true`.
 * A duplicate $connect (the Put condition fails) has no effect on the counter and is treated as
 * success only after a consistent read confirms the same user owns the connection.
 */
export async function registerConnection(
  input: { userId: string; connectionId: string; now?: IsoTimestamp },
  options: ConnectionOptions = {},
): Promise<RegisterResult> {
  const { userId, connectionId } = input;
  const now = input.now ?? new Date().toISOString();
  const table = getTableName();
  const withOwnerItem = options.withOwnerItem ?? true;

  const connection: ConnectionItem = {
    ...connectionKey(userId, connectionId),
    userId,
    connectionId,
    connectedAt: now,
    lastHeartbeat: now,
  };

  const buildItems = (expectOffline: boolean) => [
    {
      Put: { TableName: table, Item: connection, ConditionExpression: 'attribute_not_exists(PK)' },
    },
    {
      Update: {
        TableName: table,
        Key: presenceKey(userId),
        UpdateExpression: 'ADD activeConnectionCount :one',
        ConditionExpression: expectOffline
          ? 'attribute_not_exists(activeConnectionCount) OR activeConnectionCount = :zero'
          : 'activeConnectionCount > :zero',
        ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
      },
    },
    ...(withOwnerItem
      ? [
          {
            Put: {
              TableName: table,
              Item: { ...connectionOwnerKey(connectionId), userId, connectedAt: now },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ]
      : []),
  ];

  // Try 0 -> 1 first; if another concurrent $connect/$disconnect flips PRESENCE, flip expectOffline and retry.
  let expectOffline = true;
  const maxPresenceAttempts = 4;
  for (let attempt = 1; attempt <= maxPresenceAttempts; attempt++) {
    try {
      await sendWithRetry(() =>
        getDocClient().send(new TransactWriteCommand({ TransactItems: buildItems(expectOffline) })),
      );
      return { registered: true, becameOnline: expectOffline };
    } catch (error) {
      const reasons = cancellationReasons(error);
      const duplicate =
        isTransactionCanceled(error) &&
        (conditionFailedAt(reasons, 0) || conditionFailedAt(reasons, 2));

      if (duplicate) {
        const existing = await getConnection(userId, connectionId, true);
        if (withOwnerItem) {
          const owner = await getConnectionOwner(connectionId);
          if (owner !== undefined && owner !== userId) {
            throw new ForbiddenError('Connection is registered to a different user', {
              connectionId,
            });
          }
          if (owner !== userId) {
            throw new InternalServerError('Connection owner record is missing or inconsistent', {
              userId,
              connectionId,
            });
          }
        }
        if (!existing) {
          throw new InternalServerError('Owner item exists without a connection item', {
            userId,
            connectionId,
          });
        }
        return { registered: false, becameOnline: false };
      }

      // If PRESENCE precondition lost a concurrent race (0 <-> >0), flip expectation and retry.
      if (
        attempt < maxPresenceAttempts &&
        isTransactionCanceled(error) &&
        conditionFailedAt(reasons, 1)
      ) {
        expectOffline = !expectOffline;
        continue;
      }

      throw error;
    }
  }

  throw new InternalServerError('Failed to register connection after concurrent presence updates', {
    userId,
    connectionId,
  });
}

export type RemoveResult =
  | 'REMOVED'
  /** The connection was already gone, or (for stale cleanup) its heartbeat changed. Safe to ignore. */
  | 'NOT_FOUND_OR_CHANGED';

/**
 * AP4: delete the connection and decrement the presence counter atomically.
 * Used by $disconnect, GoneException cleanup and stale cleanup.
 * Pass `observedLastHeartbeat` only for stale cleanup, so a connection that has heartbeated
 * since discovery is not removed.
 *
 * A failing presence-counter condition is an invariant violation and throws; it never falls
 * back to a standalone delete.
 */
export async function removeConnection(
  input: {
    userId: string;
    connectionId: string;
    now?: IsoTimestamp;
    observedLastHeartbeat?: IsoTimestamp;
  },
  options: ConnectionOptions = {},
): Promise<RemoveResult> {
  const { userId, connectionId, observedLastHeartbeat } = input;
  const now = input.now ?? new Date().toISOString();
  const table = getTableName();
  const withOwnerItem = options.withOwnerItem ?? true;

  const items = [
    {
      Delete: {
        TableName: table,
        Key: connectionKey(userId, connectionId),
        ConditionExpression:
          observedLastHeartbeat === undefined
            ? 'attribute_exists(PK)'
            : 'attribute_exists(PK) AND lastHeartbeat = :observed',
        ...(observedLastHeartbeat !== undefined && {
          ExpressionAttributeValues: { ':observed': observedLastHeartbeat },
        }),
      },
    },
    {
      Update: {
        TableName: table,
        Key: presenceKey(userId),
        UpdateExpression: 'SET lastSeenAt = :now ADD activeConnectionCount :minusOne',
        ConditionExpression: 'activeConnectionCount > :zero',
        ExpressionAttributeValues: { ':now': now, ':minusOne': -1, ':zero': 0 },
      },
    },
    ...(withOwnerItem
      ? [
          {
            Delete: {
              TableName: table,
              Key: connectionOwnerKey(connectionId),
              ConditionExpression: 'attribute_exists(PK)',
            },
          },
        ]
      : []),
  ];

  try {
    await sendWithRetry(() =>
      getDocClient().send(new TransactWriteCommand({ TransactItems: items })),
    );
    return 'REMOVED';
  } catch (error) {
    if (!isTransactionCanceled(error)) {
      throw error;
    }
    const reasons = cancellationReasons(error);

    // If the connection was already removed or heartbeat changed, it's safe to ignore
    if (conditionFailedAt(reasons, 0)) {
      return 'NOT_FOUND_OR_CHANGED';
    }

    // A failed owner-item delete (index 2) or presence counter decrement (index 1) is an invariant error
    if (conditionFailedAt(reasons, 1) || conditionFailedAt(reasons, 2)) {
      throw new InternalServerError('Presence invariant violated during disconnect', {
        userId,
        connectionId,
        reasons,
      });
    }

    throw error;
  }
}

/**
 * AP13 (heartbeat): refresh lastHeartbeat. The condition stops a late heartbeat from recreating a
 * connection the sweeper already deleted. Returns false if the connection is no longer tracked,
 * in which case the caller must tell the client to reconnect.
 */
export async function updateHeartbeat(
  userId: string,
  connectionId: string,
  now?: IsoTimestamp,
): Promise<boolean> {
  const timestamp = now ?? new Date().toISOString();
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: getTableName(),
        Key: connectionKey(userId, connectionId),
        UpdateExpression: 'SET lastHeartbeat = :now',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':now': timestamp },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return false;
    }
    throw error;
  }
}

export interface StaleCandidate {
  userId: string;
  connectionId: string;
  lastHeartbeat: IsoTimestamp;
}

/**
 * AP17: paginated Scan for connections whose heartbeat is older than `cutoff`.
 * Yields one page of candidates at a time. The filter runs after items are read, so the cost
 * scales with the whole table (messages included). Measure it in Phase 14; if table growth
 * makes Scan RCUs significant, migrate to a sparse GSI2 (`GSI2PK = 'ACTIVE_CONN'`, `GSI2SK = lastHeartbeat`).
 */
export async function* scanStaleConnections(
  cutoff: IsoTimestamp,
  batchSize?: number,
  maxPages?: number,
): AsyncGenerator<StaleCandidate[]> {
  let startKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const out = await getDocClient().send(
      new ScanCommand({
        TableName: getTableName(),
        FilterExpression: 'begins_with(SK, :prefix) AND lastHeartbeat < :cutoff',
        ExpressionAttributeValues: { ':prefix': CONNECTION_PREFIX, ':cutoff': cutoff },
        ProjectionExpression: 'userId, connectionId, lastHeartbeat',
        ExclusiveStartKey: startKey,
        ...(batchSize && { Limit: batchSize }),
      }),
    );
    const items = (out.Items ?? []) as StaleCandidate[];
    if (items.length > 0) {
      yield items;
    }
    pages++;
    startKey = out.LastEvaluatedKey;
  } while (startKey && (maxPages === undefined || pages < maxPages));
}

/**
 * Sweeper step for one candidate: re-read consistently, confirm it is still stale, then remove it
 * conditioned on the heartbeat value just read.
 */
export async function removeStaleConnection(
  candidate: StaleCandidate,
  cutoff: IsoTimestamp,
  now?: IsoTimestamp,
  options: ConnectionOptions = {},
): Promise<RemoveResult> {
  const current = await getConnection(candidate.userId, candidate.connectionId, true);
  if (!current || current.lastHeartbeat >= cutoff) {
    return 'NOT_FOUND_OR_CHANGED';
  }
  return removeConnection(
    {
      userId: current.userId,
      connectionId: current.connectionId,
      now: now ?? new Date().toISOString(),
      observedLastHeartbeat: current.lastHeartbeat,
    },
    options,
  );
}

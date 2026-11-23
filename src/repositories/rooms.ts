import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { BadRequestError, InternalServerError } from '../shared/errors';
import { getDocClient, getTableName, queryAll, queryPage } from './client';
import {
  cancellationReasons,
  conditionFailedAt,
  isTransactionCanceled,
  sendWithRetry,
} from './dynamo-errors';
import {
  directRoomId,
  GSI1_NAME,
  MEMBER_PREFIX,
  membershipKeys,
  ROOM_PREFIX,
  roomCounterKey,
  roomMetaKey,
  roomPartitionKey,
  userPartitionKey,
} from './keys';
import type {
  CounterItem,
  IsoTimestamp,
  MemberRole,
  MembershipItem,
  Page,
  RoomItem,
} from './types';

function buildMembership(
  userId: string,
  roomId: string,
  role: MemberRole,
  joinedAt: IsoTimestamp,
): MembershipItem {
  return { ...membershipKeys(userId, roomId), userId, roomId, joinedAt, role };
}

/** AP5: get room metadata. */
export async function getRoom(roomId: string, consistent = false): Promise<RoomItem | undefined> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: roomMetaKey(roomId),
      ConsistentRead: consistent,
    }),
  );
  return out.Item as RoomItem | undefined;
}

/** AP6: rooms a user belongs to (membership items under the user's partition). */
export async function listRoomsForUser(userId: string): Promise<MembershipItem[]> {
  return queryAll<MembershipItem>({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': userPartitionKey(userId), ':prefix': ROOM_PREFIX },
  });
}

/** AP6 (paginated): rooms a user belongs to, one page at a time. */
export async function listRoomsForUserPage(
  userId: string,
  options: { limit?: number; startKey?: Record<string, unknown> } = {},
): Promise<Page<MembershipItem>> {
  return queryPage<MembershipItem>(
    {
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': userPartitionKey(userId), ':prefix': ROOM_PREFIX },
      Limit: options.limit ?? 50,
    },
    options.startKey,
  );
}

/** AP7: members of a room, via GSI1. Eventually consistent: a just-added member may be missing. */
export async function listRoomMembers(roomId: string): Promise<MembershipItem[]> {
  return queryAll<MembershipItem>({
    IndexName: GSI1_NAME,
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': roomPartitionKey(roomId), ':prefix': MEMBER_PREFIX },
  });
}

/** AP7 (paginated): members of a room via GSI1, one page at a time. */
export async function listRoomMembersPage(
  roomId: string,
  options: { limit?: number; startKey?: Record<string, unknown> } = {},
): Promise<Page<MembershipItem>> {
  return queryPage<MembershipItem>(
    {
      IndexName: GSI1_NAME,
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': roomPartitionKey(roomId), ':prefix': MEMBER_PREFIX },
      Limit: options.limit ?? 100,
    },
    options.startKey,
  );
}

/** AP8: authorization check. Always a consistent read: never authorize from stale data. */
export async function getMembership(
  userId: string,
  roomId: string,
): Promise<MembershipItem | undefined> {
  const { PK, SK } = membershipKeys(userId, roomId);
  const out = await getDocClient().send(
    new GetCommand({ TableName: getTableName(), Key: { PK, SK }, ConsistentRead: true }),
  );
  return out.Item as MembershipItem | undefined;
}

export async function isMember(userId: string, roomId: string): Promise<boolean> {
  return (await getMembership(userId, roomId)) !== undefined;
}

export interface CreateRoomResult {
  room: RoomItem;
  /** False when another request created the room first and it was verified complete. */
  created: boolean;
}

/**
 * Creates a direct room: META, both memberships and COUNTER (= 0) in one transaction.
 * If the room already exists (a race or a repeat request), verifies that all four items
 * are present and treats that as success. It never overwrites existing items.
 */
export async function createDirectRoom(input: {
  userA: string;
  userB: string;
  now?: IsoTimestamp;
}): Promise<CreateRoomResult> {
  const { userA, userB } = input;
  const now = input.now ?? new Date().toISOString();
  const roomId = directRoomId(userA, userB);
  const table = getTableName();

  const meta: RoomItem = {
    ...roomMetaKey(roomId),
    roomId,
    roomType: 'DIRECT',
    createdAt: now,
    createdBy: userA,
  };
  const counter: CounterItem = { ...roomCounterKey(roomId), sequenceNumber: 0, updatedAt: now };
  const memberA = buildMembership(userA, roomId, 'MEMBER', now);
  const memberB = buildMembership(userB, roomId, 'MEMBER', now);

  const notExists = 'attribute_not_exists(PK)';
  try {
    await sendWithRetry(() =>
      getDocClient().send(
        new TransactWriteCommand({
          TransactItems: [meta, memberA, memberB, counter].map((Item) => ({
            Put: { TableName: table, Item, ConditionExpression: notExists },
          })),
        }),
      ),
    );
    return { room: meta, created: true };
  } catch (error) {
    const reasons = cancellationReasons(error);
    const lostRace =
      isTransactionCanceled(error) && reasons.some((_, i) => conditionFailedAt(reasons, i));
    if (!lostRace) {
      throw error;
    }
  }

  // Lost the race (or this is a repeat): verify the room is complete instead of overwriting.
  const [existingRoom, existingA, existingB, existingCounter] = await Promise.all([
    getRoom(roomId, true),
    getMembership(userA, roomId),
    getMembership(userB, roomId),
    getDocClient().send(
      new GetCommand({ TableName: table, Key: roomCounterKey(roomId), ConsistentRead: true }),
    ),
  ]);

  if (!existingRoom || !existingA || !existingB || !existingCounter.Item) {
    throw new InternalServerError('Direct room exists but is incomplete', {
      roomId,
      hasMeta: Boolean(existingRoom),
      hasMemberA: Boolean(existingA),
      hasMemberB: Boolean(existingB),
      hasCounter: Boolean(existingCounter.Item),
    });
  }
  return { room: existingRoom, created: false };
}

/**
 * Creates a group room: META, membership items, and COUNTER (= 0) in one transaction.
 */
export async function createGroupRoom(input: {
  roomId: string;
  name?: string;
  createdBy: string;
  members: Array<{ userId: string; role: MemberRole }>;
  now?: IsoTimestamp;
}): Promise<CreateRoomResult> {
  const { roomId, name, createdBy, members } = input;
  const now = input.now ?? new Date().toISOString();
  const table = getTableName();

  // Validate that each user appears only once.
  const memberMap = new Map<string, MemberRole>();
  for (const m of members) {
    if (memberMap.has(m.userId)) {
      throw new BadRequestError(`Duplicate member ${m.userId} in group room creation`);
    }
    memberMap.set(m.userId, m.role);
  }

  if (memberMap.size === 0) {
    throw new BadRequestError('A group room must have at least one member');
  }

  // A transaction holds at most 100 items: 1 meta + 1 counter + at most 98 members
  if (memberMap.size > 98) {
    throw new BadRequestError('A group room creation transaction supports at most 98 members');
  }

  const meta: RoomItem = {
    ...roomMetaKey(roomId),
    roomId,
    roomType: 'GROUP',
    createdAt: now,
    createdBy,
    ...(name && { name }),
  };
  const counter: CounterItem = { ...roomCounterKey(roomId), sequenceNumber: 0, updatedAt: now };
  const memberItems = Array.from(memberMap.entries()).map(([userId, role]) =>
    buildMembership(userId, roomId, role, now),
  );

  const notExists = 'attribute_not_exists(PK)';
  const transactItems = [
    { Put: { TableName: table, Item: meta, ConditionExpression: notExists } },
    { Put: { TableName: table, Item: counter, ConditionExpression: notExists } },
    ...memberItems.map((item) => ({
      Put: { TableName: table, Item: item, ConditionExpression: notExists },
    })),
  ];

  try {
    await sendWithRetry(() =>
      getDocClient().send(new TransactWriteCommand({ TransactItems: transactItems })),
    );
    return { room: meta, created: true };
  } catch (error) {
    const reasons = cancellationReasons(error);
    const lostRace =
      isTransactionCanceled(error) && reasons.some((_, i) => conditionFailedAt(reasons, i));
    if (!lostRace) {
      throw error;
    }
  }

  // On creation race: verify the room, counter, and all memberships exist
  const [existingRoom, existingCounter, ...existingMembers] = await Promise.all([
    getRoom(roomId, true),
    getDocClient().send(
      new GetCommand({ TableName: table, Key: roomCounterKey(roomId), ConsistentRead: true }),
    ),
    ...memberItems.map((m) => getMembership(m.userId, roomId)),
  ]);

  const membersMatch = existingMembers.every((m, i) => m && m.role === memberItems[i].role);

  if (
    !existingRoom ||
    !existingCounter.Item ||
    !membersMatch ||
    existingRoom.roomType !== 'GROUP' ||
    existingRoom.createdBy !== createdBy ||
    (name !== undefined && existingRoom.name !== name)
  ) {
    throw new InternalServerError('Group room exists but is incomplete or mismatched', {
      roomId,
      hasMeta: Boolean(existingRoom),
      hasCounter: Boolean(existingCounter.Item),
      missingMembers: memberItems.filter((_, i) => !existingMembers[i]).map((m) => m.userId),
    });
  }
  return { room: existingRoom, created: false };
}

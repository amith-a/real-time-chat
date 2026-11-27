import { createHash } from 'node:crypto';
import {
  GetCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
} from '../shared/errors';
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
import { getUserProfile } from './users';

function buildMembership(
  userId: string,
  roomId: string,
  role: MemberRole,
  joinedAt: IsoTimestamp,
): MembershipItem {
  return { ...membershipKeys(userId, roomId), userId, roomId, joinedAt, role };
}

/** Deterministic hash of the membership set to avoid relying on eventually consistent GSI queries during creation race checks. */
export function hashMembership(members: Array<{ userId: string; role: MemberRole }>): string {
  const sorted = [...members].sort((a, b) =>
    a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
  );
  const payload = sorted.map(({ userId, role }) => [userId, role]);
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
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
export async function listRoomMembers(
  roomId: string,
  maxPages?: number,
): Promise<MembershipItem[]> {
  return queryAll<MembershipItem>(
    {
      IndexName: GSI1_NAME,
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': roomPartitionKey(roomId), ':prefix': MEMBER_PREFIX },
    },
    maxPages,
  );
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
    memberCount: 2,
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

  if (
    !existingRoom ||
    !existingA ||
    !existingB ||
    !existingCounter.Item ||
    existingRoom.roomType !== 'DIRECT' ||
    existingA.userId !== userA ||
    existingB.userId !== userB
  ) {
    throw new InternalServerError('Direct room exists but is incomplete or mismatched', {
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
  validateUsers?: boolean;
}): Promise<CreateRoomResult> {
  const { roomId, name, createdBy, members, validateUsers } = input;
  const now = input.now ?? new Date().toISOString();
  const table = getTableName();

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

  // Verify that every initial member (including creator) exists before creating the group room
  if (validateUsers) {
    const userIds = Array.from(new Set([...memberMap.keys(), createdBy]));
    const profiles = await Promise.all(userIds.map((uid) => getUserProfile(uid, true)));
    for (let i = 0; i < userIds.length; i++) {
      if (!profiles[i]) {
        throw new NotFoundError(`User ${userIds[i]} does not exist`);
      }
    }
  }

  const memberItems = Array.from(memberMap.entries()).map(([userId, role]) =>
    buildMembership(userId, roomId, role, now),
  );
  const membershipHash = hashMembership(
    Array.from(memberMap.entries()).map(([userId, role]) => ({ userId, role })),
  );

  const adminCount = Array.from(memberMap.values()).filter((r) => r === 'ADMIN').length;

  const meta: RoomItem = {
    ...roomMetaKey(roomId),
    roomId,
    roomType: 'GROUP',
    createdAt: now,
    createdBy,
    memberCount: memberMap.size,
    adminCount,
    membershipHash,
    ...(name && { name }),
  };
  const counter: CounterItem = { ...roomCounterKey(roomId), sequenceNumber: 0, updatedAt: now };

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

  // On creation race: verify the room and counter exist and immutable creation fields match.
  // Do not compare mutable membership/memberCount so retries after addMember/removeMember succeed.
  const [existingRoom, existingCounter] = await Promise.all([
    getRoom(roomId, true),
    getDocClient().send(
      new GetCommand({ TableName: table, Key: roomCounterKey(roomId), ConsistentRead: true }),
    ),
  ]);

  if (!existingRoom || !existingCounter.Item) {
    throw new InternalServerError('Group room exists but is incomplete', {
      roomId,
      hasMeta: Boolean(existingRoom),
      hasCounter: Boolean(existingCounter.Item),
    });
  }

  const normalizedName = name || undefined;
  if (
    existingRoom.roomType !== 'GROUP' ||
    existingRoom.createdBy !== createdBy ||
    (existingRoom.name ?? undefined) !== normalizedName ||
    existingRoom.membershipHash !== membershipHash
  ) {
    throw new ConflictError('Group room already exists with different creation parameters', {
      roomId,
    });
  }

  return { room: existingRoom, created: false };
}

export const MAX_GROUP_ROOM_MEMBERS = 100;

export interface AddMemberInput {
  roomId: string;
  userId: string;
  role?: MemberRole;
  addedBy: string;
  now?: IsoTimestamp;
}

export interface AddMemberResult {
  member: MembershipItem;
}

export async function addMember(input: AddMemberInput): Promise<AddMemberResult> {
  const { roomId, userId, addedBy } = input;
  const role = input.role ?? 'MEMBER';
  const now = input.now ?? new Date().toISOString();
  const table = getTableName();

  const room = await getRoom(roomId, true);
  if (!room) {
    throw new NotFoundError(`Room ${roomId} not found`);
  }
  if (room.roomType !== 'GROUP') {
    throw new BadRequestError('Cannot add members to a direct chat room');
  }

  const requesterMembership = await getMembership(addedBy, roomId);
  if (requesterMembership?.role !== 'ADMIN') {
    throw new ForbiddenError('Only room admins can add members');
  }

  const targetMembership = await getMembership(userId, roomId);
  if (targetMembership) {
    throw new ConflictError(`User ${userId} is already a member of this room`);
  }

  if ((room.memberCount ?? 0) >= MAX_GROUP_ROOM_MEMBERS) {
    throw new BadRequestError(`Group room cannot exceed ${MAX_GROUP_ROOM_MEMBERS} members`);
  }

  const targetProfile = await getUserProfile(userId, true);
  if (!targetProfile) {
    throw new NotFoundError(`User ${userId} does not exist`);
  }

  const newMembership = buildMembership(userId, roomId, role, now);
  const { PK: adminPK, SK: adminSK } = membershipKeys(addedBy, roomId);

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Put: {
        TableName: table,
        Item: newMembership,
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      Update: {
        TableName: table,
        Key: roomMetaKey(roomId),
        UpdateExpression:
          role === 'ADMIN'
            ? 'SET memberCount = if_not_exists(memberCount, :zero) + :inc, adminCount = if_not_exists(adminCount, :zero) + :inc'
            : 'SET memberCount = if_not_exists(memberCount, :zero) + :inc',
        ConditionExpression:
          'attribute_exists(PK) AND (attribute_not_exists(memberCount) OR memberCount < :maxMembers)',
        ExpressionAttributeValues: {
          ':zero': 0,
          ':inc': 1,
          ':maxMembers': MAX_GROUP_ROOM_MEMBERS,
        },
      },
    },
    {
      ConditionCheck: {
        TableName: table,
        Key: { PK: adminPK, SK: adminSK },
        ConditionExpression: 'attribute_exists(PK) AND #role = :adminRole',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':adminRole': 'ADMIN' },
      },
    },
  ];

  try {
    await sendWithRetry(() =>
      getDocClient().send(
        new TransactWriteCommand({
          TransactItems: transactItems,
        }),
      ),
    );
  } catch (error) {
    if (isTransactionCanceled(error)) {
      const reasons = cancellationReasons(error);
      if (conditionFailedAt(reasons, 0)) {
        throw new ConflictError(`User ${userId} is already a member of this room`);
      }
      if (conditionFailedAt(reasons, 1)) {
        const currentRoom = await getRoom(roomId, true);
        if (!currentRoom) {
          throw new NotFoundError(`Room ${roomId} not found`);
        }
        throw new BadRequestError(`Group room cannot exceed ${MAX_GROUP_ROOM_MEMBERS} members`);
      }
      if (reasons.length > 2 && conditionFailedAt(reasons, 2)) {
        throw new ForbiddenError('Only room admins can add members');
      }
    }
    throw error;
  }

  return { member: newMembership };
}

export interface RemoveMemberInput {
  roomId: string;
  userId: string;
  removedBy: string;
}

export async function removeMember(input: RemoveMemberInput): Promise<{ success: boolean }> {
  const { roomId, userId, removedBy } = input;
  const table = getTableName();

  const room = await getRoom(roomId, true);
  if (!room) {
    throw new NotFoundError(`Room ${roomId} not found`);
  }
  if (room.roomType !== 'GROUP') {
    throw new BadRequestError('Cannot remove members from a direct chat room');
  }

  const requesterMembership = await getMembership(removedBy, roomId);
  if (!requesterMembership) {
    throw new ForbiddenError('You are not a member of this room');
  }

  // Caller must be an ADMIN or removing themselves (self-leave)
  if (removedBy !== userId && requesterMembership.role !== 'ADMIN') {
    throw new ForbiddenError('Only room admins can remove other members');
  }

  const targetMembership = await getMembership(userId, roomId);
  if (!targetMembership) {
    throw new NotFoundError(`User ${userId} is not a member of this room`);
  }

  // Ensure room has more than 1 member before removing
  if (room.memberCount !== undefined && room.memberCount <= 1) {
    throw new BadRequestError('Cannot remove the last member of a group room');
  }

  const isRemovingAdmin = targetMembership.role === 'ADMIN';
  const enforceAtomicAdminCount = isRemovingAdmin && room.adminCount !== undefined;

  // Friendly pre-check (the transaction ConditionExpression below is the authoritative concurrency guard)
  if (isRemovingAdmin) {
    const members = await listRoomMembers(roomId);
    const adminCount = members.filter((m) => m.role === 'ADMIN').length;
    if (adminCount <= 1) {
      throw new BadRequestError('Cannot remove the last admin of a group room');
    }
  }

  const { PK, SK } = membershipKeys(userId, roomId);

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Delete: {
        TableName: table,
        Key: { PK, SK },
        ConditionExpression: 'attribute_exists(PK)',
      },
    },
    {
      Update: {
        TableName: table,
        Key: roomMetaKey(roomId),
        UpdateExpression: enforceAtomicAdminCount
          ? 'SET memberCount = memberCount - :dec, adminCount = adminCount - :dec'
          : 'SET memberCount = memberCount - :dec',
        ConditionExpression: enforceAtomicAdminCount
          ? 'attribute_exists(PK) AND memberCount > :minCount AND adminCount > :minAdmins'
          : 'attribute_exists(PK) AND memberCount > :minCount',
        ExpressionAttributeValues: enforceAtomicAdminCount
          ? { ':dec': 1, ':minCount': 1, ':minAdmins': 1 }
          : { ':dec': 1, ':minCount': 1 },
      },
    },
  ];

  if (removedBy !== userId) {
    const { PK: adminPK, SK: adminSK } = membershipKeys(removedBy, roomId);
    transactItems.push({
      ConditionCheck: {
        TableName: table,
        Key: { PK: adminPK, SK: adminSK },
        ConditionExpression: 'attribute_exists(PK) AND #role = :adminRole',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':adminRole': 'ADMIN' },
      },
    });
  }

  try {
    await sendWithRetry(() =>
      getDocClient().send(
        new TransactWriteCommand({
          TransactItems: transactItems,
        }),
      ),
    );
  } catch (error) {
    if (isTransactionCanceled(error)) {
      const reasons = cancellationReasons(error);
      if (conditionFailedAt(reasons, 0)) {
        throw new NotFoundError(`User ${userId} is not a member of this room`);
      }
      if (conditionFailedAt(reasons, 1)) {
        const currentRoom = await getRoom(roomId, true);
        if (!currentRoom) {
          throw new NotFoundError(`Room ${roomId} not found`);
        }
        if (currentRoom.memberCount !== undefined && currentRoom.memberCount <= 1) {
          throw new BadRequestError('Cannot remove the last member of a group room');
        }
        throw new BadRequestError('Cannot remove the last admin of a group room');
      }
      if (reasons.length > 2 && conditionFailedAt(reasons, 2)) {
        throw new ForbiddenError('Only room admins can remove other members');
      }
    }
    throw error;
  }

  return { success: true };
}

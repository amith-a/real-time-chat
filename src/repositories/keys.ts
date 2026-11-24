import { createHash } from 'node:crypto';

/**
 * Key builders for the single-table design.
 * Source of truth: docs/access-pattern.md. Do not change key shapes here
 * without updating that document first.
 */

export const GSI1_NAME = 'GSI1';

/** Message sort keys are fixed-width: MSG#0000000001 ... MSG#9999999999. */
export const SEQUENCE_WIDTH = 10;
export const MAX_SEQUENCE = 9_999_999_999;

export const MESSAGE_PREFIX = 'MSG#';
export const CONNECTION_PREFIX = 'CONNECTION#';
export const ROOM_PREFIX = 'ROOM#';
export const MEMBER_PREFIX = 'MEMBER#';

export interface PrimaryKey {
  PK: string;
  SK: string;
}

export interface MembershipKeys extends PrimaryKey {
  GSI1PK: string;
  GSI1SK: string;
}

/** IDs become part of keys, so they must be non-empty and must not contain '#'. */
function assertId(name: string, value: string, maxLength?: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.includes('#')) {
    throw new TypeError(`${name} must not contain '#'`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new RangeError(`${name} must not exceed ${maxLength} characters`);
  }
  return value;
}

export function padSequence(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) {
    throw new RangeError(`sequence must be an integer between 1 and ${MAX_SEQUENCE}`);
  }
  return String(sequence).padStart(SEQUENCE_WIDTH, '0');
}

const MESSAGE_KEY_REGEX = new RegExp(`^${MESSAGE_PREFIX}(\\d{${SEQUENCE_WIDTH}})$`);

export function parseMessageSequence(sortKey: string): number {
  const match = MESSAGE_KEY_REGEX.exec(sortKey);
  if (!match) {
    throw new Error(`Invalid message sort key: ${sortKey}`);
  }
  const sequence = Number.parseInt(match[1], 10);
  if (sequence < 1 || sequence > MAX_SEQUENCE) {
    throw new RangeError(`Sequence number out of range: ${sequence}`);
  }
  return sequence;
}

export function userKey(userId: string): PrimaryKey {
  return { PK: `USER#${assertId('userId', userId)}`, SK: 'PROFILE' };
}

export function userGsi1Keys(userId: string, email?: string): { GSI1PK: string; GSI1SK: string } {
  return {
    GSI1PK: 'USERS',
    GSI1SK: email ? `EMAIL#${email.trim().toLowerCase()}` : `USER#${assertId('userId', userId)}`,
  };
}

export function connectionKey(userId: string, connectionId: string): PrimaryKey {
  return {
    PK: `USER#${assertId('userId', userId)}`,
    SK: `${CONNECTION_PREFIX}${assertId('connectionId', connectionId)}`,
  };
}

export function userPartitionKey(userId: string): string {
  return `USER#${assertId('userId', userId)}`;
}

export function presenceKey(userId: string): PrimaryKey {
  return { PK: `USER#${assertId('userId', userId)}`, SK: 'PRESENCE' };
}

/** Optional reverse lookup: connectionId -> owner. Only used if authorizer context is unavailable. */
export function connectionOwnerKey(connectionId: string): PrimaryKey {
  return { PK: `CONN#${assertId('connectionId', connectionId)}`, SK: 'OWNER' };
}

export function roomMetaKey(roomId: string): PrimaryKey {
  return { PK: `ROOM#${assertId('roomId', roomId)}`, SK: 'META' };
}

export function roomCounterKey(roomId: string): PrimaryKey {
  return { PK: `ROOM#${assertId('roomId', roomId)}`, SK: 'COUNTER' };
}

export function roomPartitionKey(roomId: string): string {
  return `ROOM#${assertId('roomId', roomId)}`;
}

export function membershipKeys(userId: string, roomId: string): MembershipKeys {
  return {
    PK: `USER#${assertId('userId', userId)}`,
    SK: `${ROOM_PREFIX}${assertId('roomId', roomId)}`,
    GSI1PK: `ROOM#${roomId}`,
    GSI1SK: `${MEMBER_PREFIX}${userId}`,
  };
}

export function messageKey(roomId: string, sequence: number): PrimaryKey {
  return {
    PK: `ROOM#${assertId('roomId', roomId)}`,
    SK: `${MESSAGE_PREFIX}${padSequence(sequence)}`,
  };
}

/** Inclusive sort-key bounds for "messages after sequence N" (N >= 0). */
export function messagesAfterRange(afterSequence: number): {
  start: string;
  end: string;
} {
  if (
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0 ||
    afterSequence >= Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError('afterSequence must be a valid sequence');
  }
  return {
    start: `${MESSAGE_PREFIX}${padSequence(afterSequence + 1)}`,
    end: `${MESSAGE_PREFIX}${'9'.repeat(SEQUENCE_WIDTH)}`,
  };
}

export const MAX_CLIENT_MESSAGE_ID_LENGTH = 64;

export function idempotencyKey(
  userId: string,
  roomId: string,
  clientMessageId: string,
): PrimaryKey {
  return {
    PK: `IDEMPOTENCY#${assertId('userId', userId)}#ROOM#${assertId('roomId', roomId)}`,
    SK: `REQUEST#${assertId('clientMessageId', clientMessageId, MAX_CLIENT_MESSAGE_ID_LENGTH)}`,
  };
}

/** Deterministic direct-room ID: sha256 of the two sorted user IDs. Same for either order. */
export function directRoomId(userA: string, userB: string): string {
  assertId('userA', userA);
  assertId('userB', userB);
  if (userA === userB) {
    throw new TypeError('A direct room needs two different users');
  }
  const [first, second] = [userA, userB].sort();
  return createHash('sha256').update(`${first}#${second}`).digest('hex');
}

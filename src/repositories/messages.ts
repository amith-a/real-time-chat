import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { AppError, BadRequestError, ConflictError, InternalServerError } from '../shared/errors';
import { getDocClient, getTableName, queryPage } from './client';
import {
  cancellationReasons,
  conditionFailedAt,
  hasRetryableReason,
  isTransactionCanceled,
} from './dynamo-errors';
import {
  idempotencyKey,
  MAX_CLIENT_MESSAGE_ID_LENGTH,
  MAX_SEQUENCE,
  MESSAGE_PREFIX,
  messageKey,
  messagesAfterRange,
  roomCounterKey,
  roomPartitionKey,
} from './keys';
import type {
  CounterItem,
  IdempotencyItem,
  IsoTimestamp,
  MessageItem,
  MessageType,
  Page,
} from './types';

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** AP11: current room sequence. Consistent read to avoid avoidable counter-condition failures. */
export async function getRoomSequence(roomId: string): Promise<number> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: roomCounterKey(roomId),
      ConsistentRead: true,
    }),
  );
  const counter = out.Item as CounterItem | undefined;
  if (!counter) {
    throw new InternalServerError('Room counter not found', { roomId });
  }
  return counter.sequenceNumber;
}

/** AP9 (single): get a specific message by roomId and sequenceNumber. */
export async function getMessage(
  roomId: string,
  sequenceNumber: number,
  consistent = false,
): Promise<MessageItem | undefined> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: messageKey(roomId, sequenceNumber),
      ConsistentRead: consistent,
    }),
  );
  return out.Item as MessageItem | undefined;
}

/** AP9: latest messages, newest first. Only MSG# items are returned (never META or COUNTER). */
export function listLatestMessages(
  roomId: string,
  options: { limit?: number; startKey?: Record<string, unknown> } = {},
): Promise<Page<MessageItem>> {
  return queryPage<MessageItem>(
    {
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': roomPartitionKey(roomId), ':prefix': MESSAGE_PREFIX },
      ScanIndexForward: false,
      Limit: options.limit ?? 20,
    },
    options.startKey,
  );
}

/** AP10: messages with sequence > afterSequence, oldest first, using a bounded MSG# range. */
export function listMessagesAfter(
  roomId: string,
  afterSequence: number,
  options: { limit?: number; startKey?: Record<string, unknown> } = {},
): Promise<Page<MessageItem>> {
  const { start, end } = messagesAfterRange(afterSequence);
  return queryPage<MessageItem>(
    {
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
      ExpressionAttributeValues: { ':pk': roomPartitionKey(roomId), ':start': start, ':end': end },
      ScanIndexForward: true,
      Limit: options.limit ?? 100,
    },
    options.startKey,
  );
}

/** AP15 / AP16: look up the stored result for an idempotency key. */
export async function getIdempotencyRecord(
  userId: string,
  roomId: string,
  clientMessageId: string,
): Promise<IdempotencyItem | undefined> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: idempotencyKey(userId, roomId, clientMessageId),
      ConsistentRead: true,
    }),
  );
  return out.Item as IdempotencyItem | undefined;
}

export interface CreateMessageInput {
  roomId: string;
  senderId: string;
  /** Client-generated, stable across retries of the same logical send. */
  clientMessageId: string;
  content: string;
  messageType?: MessageType;
  now?: IsoTimestamp;
  maxAttempts?: number;
}

export interface CreateMessageResult {
  /** True if this was a retry and the original result is being replayed. */
  duplicate: boolean;
  messageId: string;
  sequenceNumber: number;
  createdAt: IsoTimestamp;
  message?: MessageItem;
}

export function hashRequest(input: {
  roomId: string;
  messageType: MessageType;
  content: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([input.roomId, input.messageType, input.content]))
    .digest('hex');
}

function replay(record: IdempotencyItem, requestHash: string): CreateMessageResult {
  if (record.requestHash !== requestHash) {
    throw new ConflictError('Idempotency key was reused with a different payload');
  }
  return {
    duplicate: true,
    messageId: record.messageId,
    sequenceNumber: record.sequenceNumber,
    createdAt: record.createdAt,
  };
}

const MAX_BACKOFF_MS = 200;

function backoff(attempt: number): Promise<void> {
  const delay = Math.min(Math.random() * 40 * attempt, MAX_BACKOFF_MS);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export const MAX_MESSAGE_CONTENT_LENGTH = 32_768; // 32 KB, well under 400 KB DynamoDB item limit

const VALID_MESSAGE_TYPES = new Set<string>(['TEXT', 'IMAGE', 'FILE']);

/**
 * Validates client-controlled message payload fields to prevent unbounded sort keys or item sizes.
 */
export function validateMessageInput(input: {
  clientMessageId: string;
  content: string;
  messageType?: MessageType;
}): void {
  if (
    typeof input.clientMessageId !== 'string' ||
    input.clientMessageId.length === 0 ||
    input.clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH
  ) {
    throw new BadRequestError(
      `clientMessageId must be a non-empty string of at most ${MAX_CLIENT_MESSAGE_ID_LENGTH} characters`,
    );
  }
  if (input.clientMessageId.includes('#')) {
    throw new BadRequestError("clientMessageId must not contain '#'");
  }
  if (
    typeof input.content !== 'string' ||
    input.content.length === 0 ||
    input.content.length > MAX_MESSAGE_CONTENT_LENGTH
  ) {
    throw new BadRequestError(
      `content must be a non-empty string of at most ${MAX_MESSAGE_CONTENT_LENGTH} characters`,
    );
  }
  if (input.messageType !== undefined && !VALID_MESSAGE_TYPES.has(input.messageType)) {
    throw new BadRequestError(
      `Invalid messageType '${String(input.messageType)}'. Must be one of: TEXT, IMAGE, FILE`,
    );
  }
}

/**
 * AP12: allocate the next room sequence and persist the message plus its idempotency record in one
 * transaction (optimistic concurrency on the room counter).
 *
 * Callers must verify room membership (AP8) first.
 */
export async function createMessage(input: CreateMessageInput): Promise<CreateMessageResult> {
  validateMessageInput(input);

  const maxAttempts = input.maxAttempts ?? 8;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new BadRequestError('maxAttempts must be an integer between 1 and 10');
  }

  const { roomId, senderId, clientMessageId, content } = input;
  const messageType = input.messageType ?? 'TEXT';
  const requestHash = hashRequest({ roomId, messageType, content });
  const table = getTableName();

  // Cheap path: a retry of an already-committed send never touches the counter.
  const existing = await getIdempotencyRecord(senderId, roomId, clientMessageId);
  if (existing) {
    return replay(existing, requestHash);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const now = input.now ?? new Date().toISOString();
    const ttl = Math.floor(new Date(now).getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS;
    const current = await getRoomSequence(roomId);
    if (!Number.isSafeInteger(current) || current < 0) {
      throw new InternalServerError('Invalid room counter value', { roomId, current });
    }
    if (current >= MAX_SEQUENCE) {
      throw new AppError('Room message sequence has reached maximum capacity', 507, {
        roomId,
        current,
        max: MAX_SEQUENCE,
      });
    }
    const next = current + 1;
    const messageId = randomUUID();

    const message: MessageItem = {
      ...messageKey(roomId, next),
      messageId,
      clientMessageId,
      roomId,
      senderId,
      content,
      sequenceNumber: next,
      createdAt: now,
      messageType,
    };
    const idempotency: IdempotencyItem = {
      ...idempotencyKey(senderId, roomId, clientMessageId),
      messageId,
      sequenceNumber: next,
      requestHash,
      createdAt: now,
      ttl,
    };

    try {
      await getDocClient().send(
        new TransactWriteCommand({
          TransactItems: [
            // 0: counter
            {
              Update: {
                TableName: table,
                Key: roomCounterKey(roomId),
                UpdateExpression: 'SET sequenceNumber = :next, updatedAt = :now',
                ConditionExpression: 'sequenceNumber = :current',
                ExpressionAttributeValues: { ':next': next, ':current': current, ':now': now },
              },
            },
            // 1: message
            {
              Put: {
                TableName: table,
                Item: message,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            // 2: idempotency record
            {
              Put: {
                TableName: table,
                Item: idempotency,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
      return { duplicate: false, messageId, sequenceNumber: next, createdAt: now, message };
    } catch (error) {
      if (!isTransactionCanceled(error)) {
        throw error;
      }
      const reasons = cancellationReasons(error);

      // A concurrent request with the same key won: return its stored result.
      if (conditionFailedAt(reasons, 2)) {
        const winner = await getIdempotencyRecord(senderId, roomId, clientMessageId);
        if (winner) {
          return replay(winner, requestHash);
        }
      }

      // Another writer took this sequence, or a transient conflict: retry with a fresh counter.
      if (conditionFailedAt(reasons, 0) || hasRetryableReason(reasons)) {
        await backoff(attempt);
        continue;
      }

      // The message key already existed although the counter matched: invariant violation.
      if (conditionFailedAt(reasons, 1)) {
        throw new InternalServerError('Message key already exists', {
          roomId,
          sequenceNumber: next,
        });
      }

      throw error;
    }
  }

  throw new AppError('Too much contention allocating a message sequence', 503, { roomId });
}

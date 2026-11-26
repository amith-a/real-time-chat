import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDirectRoom,
  createMessage,
  getDocClient,
  getRoomSequence,
  getTableName,
  listLatestMessages,
  listMessagesAfter,
} from '../../src/repositories';
import { ConflictError } from '../../src/shared/errors';
import { createTestTable, now, safeTeardown } from './helpers';

async function newRoom(a: string, b: string): Promise<string> {
  return (await createDirectRoom({ userA: a, userB: b, now: now() })).room.roomId;
}

describe('messages (DynamoDB Local)', () => {
  let table: string;
  beforeAll(async () => {
    table = await createTestTable();
  });
  afterAll(async () => {
    await safeTeardown(table);
  });

  it('assigns sequential sequence numbers', async () => {
    const roomId = await newRoom('u1', 'u2');
    const a = await createMessage({ roomId, senderId: 'u1', clientMessageId: 'a', content: 'one' });
    const b = await createMessage({ roomId, senderId: 'u2', clientMessageId: 'b', content: 'two' });
    expect([a.sequenceNumber, b.sequenceNumber]).toEqual([1, 2]);
    expect(await getRoomSequence(roomId)).toBe(2);
  });

  it('replays the original result for a retry and does not advance the counter', async () => {
    const roomId = await newRoom('u3', 'u4');
    const first = await createMessage({
      roomId,
      senderId: 'u3',
      clientMessageId: 'x',
      content: 'hi',
    });
    const retry = await createMessage({
      roomId,
      senderId: 'u3',
      clientMessageId: 'x',
      content: 'hi',
    });
    expect(retry.duplicate).toBe(true);
    expect(retry.messageId).toBe(first.messageId);
    expect(retry.sequenceNumber).toBe(first.sequenceNumber);
    expect(await getRoomSequence(roomId)).toBe(1);
  });

  it('rejects an idempotency key reused with a different payload', async () => {
    const roomId = await newRoom('u5', 'u6');
    await createMessage({ roomId, senderId: 'u5', clientMessageId: 'k', content: 'original' });
    await expect(
      createMessage({ roomId, senderId: 'u5', clientMessageId: 'k', content: 'different' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('concurrent sends get unique, gap-free sequences', async () => {
    const roomId = await newRoom('u7', 'u8');
    const total = 10;
    const results = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        createMessage({
          roomId,
          senderId: i % 2 === 0 ? 'u7' : 'u8',
          clientMessageId: `m${i}`,
          content: `msg ${i}`,
          maxAttempts: 10,
        }),
      ),
    );
    const sequences = results.map((r) => r.sequenceNumber).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(await getRoomSequence(roomId)).toBe(total);
  });

  it('concurrent duplicates of one request commit exactly once', async () => {
    const roomId = await newRoom('u9', 'u10');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createMessage({
          roomId,
          senderId: 'u9',
          clientMessageId: 'same',
          content: 'dup',
          maxAttempts: 10,
        }),
      ),
    );
    expect(new Set(results.map((r) => r.messageId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await getRoomSequence(roomId)).toBe(1);
  });

  it('history returns only messages, newest first, and "after N" is ascending', async () => {
    const roomId = await newRoom('u11', 'u12');
    for (let i = 1; i <= 5; i++) {
      await createMessage({ roomId, senderId: 'u11', clientMessageId: `h${i}`, content: `m${i}` });
    }
    const latest = await listLatestMessages(roomId, { limit: 10 });
    expect(latest.items.map((m) => m.sequenceNumber)).toEqual([5, 4, 3, 2, 1]);

    const after = await listMessagesAfter(roomId, 3);
    expect(after.items.map((m) => m.sequenceNumber)).toEqual([4, 5]);

    const empty = await listMessagesAfter(roomId, 5);
    expect(empty.items).toEqual([]);
  });

  it('paginates history', async () => {
    const roomId = await newRoom('u13', 'u14');
    for (let i = 1; i <= 5; i++) {
      await createMessage({ roomId, senderId: 'u13', clientMessageId: `p${i}`, content: `m${i}` });
    }
    const page1 = await listLatestMessages(roomId, { limit: 2 });
    expect(page1.items.map((m) => m.sequenceNumber)).toEqual([5, 4]);
    expect(page1.nextKey).toBeDefined();
    const page2 = await listLatestMessages(roomId, { limit: 2, startKey: page1.nextKey });
    expect(page2.items.map((m) => m.sequenceNumber)).toEqual([3, 2]);
  });

  it('strictly excludes META, COUNTER, and MEMBER# records even when present in the same partition', async () => {
    const roomId = await newRoom('u-ex-1', 'u-ex-2');

    // Add co-located member records in the same room partition
    await getDocClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          PK: `ROOM#${roomId}`,
          SK: 'MEMBER#u-ex-1',
          userId: 'u-ex-1',
          role: 'ADMIN',
        },
      }),
    );
    await getDocClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          PK: `ROOM#${roomId}`,
          SK: 'MEMBER#u-ex-2',
          userId: 'u-ex-2',
          role: 'MEMBER',
        },
      }),
    );

    // Write messages
    await createMessage({ roomId, senderId: 'u-ex-1', clientMessageId: 'ex-1', content: 'hello' });
    await createMessage({ roomId, senderId: 'u-ex-2', clientMessageId: 'ex-2', content: 'world' });

    // 1. listLatestMessages query must only return MSG# items
    const latest = await listLatestMessages(roomId);
    expect(latest.items).toHaveLength(2);
    expect(latest.items.map((m) => m.content)).toEqual(['world', 'hello']);
    for (const item of latest.items) {
      expect(item.SK.startsWith('MSG#')).toBe(true);
      expect((item as unknown as { role?: string }).role).toBeUndefined();
    }

    // 2. listMessagesAfter query must only return MSG# items
    const after = await listMessagesAfter(roomId, 0);
    expect(after.items).toHaveLength(2);
    expect(after.items.map((m) => m.content)).toEqual(['hello', 'world']);
    for (const item of after.items) {
      expect(item.SK.startsWith('MSG#')).toBe(true);
      expect((item as unknown as { role?: string }).role).toBeUndefined();
    }
  });

  it('listMessagesAfter paginates in ascending sequence order without skipping or duplicating', async () => {
    const roomId = `room-after-page-${Date.now()}`;
    await getDocClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: { PK: `ROOM#${roomId}`, SK: 'META', roomId, roomType: 'GROUP' },
      }),
    );
    await getDocClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: { PK: `ROOM#${roomId}`, SK: 'COUNTER', sequenceNumber: 0 },
      }),
    );

    for (let i = 1; i <= 5; i++) {
      await createMessage({
        roomId,
        senderId: 'u-page',
        clientMessageId: `msg-${i}`,
        content: `message-${i}`,
      });
    }

    const page1 = await listMessagesAfter(roomId, 1, { limit: 2 });
    expect(page1.items.map((m) => m.sequenceNumber)).toEqual([2, 3]);
    expect(page1.nextKey).toBeDefined();
    for (const item of page1.items) {
      expect(item.SK.startsWith('MSG#')).toBe(true);
    }

    const page2 = await listMessagesAfter(roomId, 1, { limit: 2, startKey: page1.nextKey });
    expect(page2.items.map((m) => m.sequenceNumber)).toEqual([4, 5]);
    for (const item of page2.items) {
      expect(item.SK.startsWith('MSG#')).toBe(true);
    }

    if (page2.nextKey) {
      const page3 = await listMessagesAfter(roomId, 1, { limit: 2, startKey: page2.nextKey });
      expect(page3.items).toEqual([]);
      expect(page3.nextKey).toBeUndefined();
    }
  });
});

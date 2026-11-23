import { describe, expect, it } from 'vitest';
import {
  connectionKey,
  connectionOwnerKey,
  directRoomId,
  idempotencyKey,
  membershipKeys,
  messageKey,
  messagesAfterRange,
  padSequence,
  parseMessageSequence,
  presenceKey,
  roomCounterKey,
  roomMetaKey,
  userKey,
} from '../src/repositories/keys';

describe('entity keys', () => {
  it('builds user, connection, presence and owner keys', () => {
    expect(userKey('u1')).toEqual({ PK: 'USER#u1', SK: 'PROFILE' });
    expect(connectionKey('u1', 'c1')).toEqual({ PK: 'USER#u1', SK: 'CONNECTION#c1' });
    expect(presenceKey('u1')).toEqual({ PK: 'USER#u1', SK: 'PRESENCE' });
    expect(connectionOwnerKey('c1')).toEqual({ PK: 'CONN#c1', SK: 'OWNER' });
  });

  it('builds room metadata and counter keys', () => {
    expect(roomMetaKey('r1')).toEqual({ PK: 'ROOM#r1', SK: 'META' });
    expect(roomCounterKey('r1')).toEqual({ PK: 'ROOM#r1', SK: 'COUNTER' });
  });

  it('builds membership keys including GSI1', () => {
    expect(membershipKeys('u1', 'r1')).toEqual({
      PK: 'USER#u1',
      SK: 'ROOM#r1',
      GSI1PK: 'ROOM#r1',
      GSI1SK: 'MEMBER#u1',
    });
  });

  it('builds idempotency keys', () => {
    expect(idempotencyKey('u1', 'r1', 'm1')).toEqual({
      PK: 'IDEMPOTENCY#u1#ROOM#r1',
      SK: 'REQUEST#m1',
    });
    expect(() => idempotencyKey('u1', 'r1', 'a'.repeat(65))).toThrow(RangeError);
    expect(() => idempotencyKey('u1', 'r1', 'm#1')).toThrow(TypeError);
  });

  it('accepts connection IDs containing = and rejects ids with # or empty', () => {
    expect(connectionKey('u1', 'ghc5Xi5eUC5gKEhhSA==').SK).toBe('CONNECTION#ghc5Xi5eUC5gKEhhSA==');
    expect(() => userKey('a#b')).toThrow();
    expect(() => userKey('')).toThrow();
  });
});

describe('message keys', () => {
  it('uses fixed-width zero-padded sequences', () => {
    expect(padSequence(1)).toBe('0000000001');
    expect(messageKey('r1', 10)).toEqual({ PK: 'ROOM#r1', SK: 'MSG#0000000010' });
  });

  it('sorts lexically in numeric order', () => {
    const keys = [100, 2, 10, 1].map((n) => messageKey('r1', n).SK).sort();
    expect(keys).toEqual(['MSG#0000000001', 'MSG#0000000002', 'MSG#0000000010', 'MSG#0000000100']);
  });

  it('rejects sequences outside 1..9,999,999,999', () => {
    expect(() => padSequence(0)).toThrow(RangeError);
    expect(() => padSequence(10_000_000_000)).toThrow(RangeError);
    expect(() => padSequence(1.5)).toThrow(RangeError);
  });

  it('builds a bounded MSG# range for messages after N', () => {
    expect(messagesAfterRange(184)).toEqual({ start: 'MSG#0000000185', end: 'MSG#9999999999' });
    expect(messagesAfterRange(0).start).toBe('MSG#0000000001');
  });

  it('keeps the range inside the MSG# namespace', () => {
    const { start, end } = messagesAfterRange(5);
    expect('META' < start || 'META' > end).toBe(true);
    expect('COUNTER' < start || 'COUNTER' > end).toBe(true);
    expect('MEMBER#u1' < start || 'MEMBER#u1' > end).toBe(true);
  });

  it('parses valid zero-padded sequence sort keys', () => {
    expect(parseMessageSequence('MSG#0000000001')).toBe(1);
    expect(parseMessageSequence('MSG#0000000185')).toBe(185);
    expect(parseMessageSequence('MSG#9999999999')).toBe(9_999_999_999);
  });

  it('rejects malformed message sort keys with a regex check', () => {
    expect(() => parseMessageSequence('MSG#abc')).toThrow(/Invalid message sort key/);
    expect(() => parseMessageSequence('MSG#000000001x')).toThrow(/Invalid message sort key/);
    expect(() => parseMessageSequence('MSG#')).toThrow(/Invalid message sort key/);
    expect(() => parseMessageSequence('MSG#1')).toThrow(/Invalid message sort key/);
    expect(() => parseMessageSequence('OTHER#0000000001')).toThrow(/Invalid message sort key/);
    expect(() => parseMessageSequence('MSG#0000000000')).toThrow(RangeError);
  });
});

describe('directRoomId', () => {
  it('is the same regardless of user order', () => {
    expect(directRoomId('user-100', 'user-200')).toBe(directRoomId('user-200', 'user-100'));
  });

  it('differs for different pairs and is a 64-char hex digest', () => {
    expect(directRoomId('a', 'b')).not.toBe(directRoomId('a', 'c'));
    expect(directRoomId('a', 'b')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a room with the same user twice', () => {
    expect(() => directRoomId('a', 'a')).toThrow();
  });
});

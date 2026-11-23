import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getConnection,
  getPresence,
  registerConnection,
  removeConnection,
  removeStaleConnection,
  type StaleCandidate,
  scanStaleConnections,
  updateHeartbeat,
} from '../../src/repositories';
import { ForbiddenError } from '../../src/shared/errors';
import { createTestTable, safeTeardown } from './helpers';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:05:00.000Z';
const T2 = '2026-01-01T00:10:00.000Z';

describe('connections and presence (DynamoDB Local)', () => {
  let table: string;
  beforeAll(async () => {
    table = await createTestTable();
  });
  afterAll(async () => {
    await safeTeardown(table);
  });

  it('register increments presence; a duplicate $connect does not', async () => {
    expect(
      (await registerConnection({ userId: 'a1', connectionId: 'c-a1-1', now: T0 })).registered,
    ).toBe(true);
    expect(
      (await registerConnection({ userId: 'a1', connectionId: 'c-a1-1', now: T0 })).registered,
    ).toBe(false);
    expect(await getPresence('a1')).toMatchObject({ online: true, activeConnectionCount: 1 });
  });

  it('supports multiple connections per user', async () => {
    await registerConnection({ userId: 'a2', connectionId: 'c-a2-1', now: T0 });
    await registerConnection({ userId: 'a2', connectionId: 'c-a2-2', now: T0 });
    expect((await getPresence('a2')).activeConnectionCount).toBe(2);
    await removeConnection({ userId: 'a2', connectionId: 'c-a2-1', now: T1 });
    expect(await getPresence('a2')).toMatchObject({ online: true, activeConnectionCount: 1 });
    await removeConnection({ userId: 'a2', connectionId: 'c-a2-2', now: T2 });
    expect(await getPresence('a2')).toMatchObject({
      online: false,
      activeConnectionCount: 0,
      lastSeenAt: T2,
    });
  });

  it('a repeated disconnect does not decrement twice', async () => {
    await registerConnection({ userId: 'a3', connectionId: 'c-a3-1', now: T0 });
    await registerConnection({ userId: 'a3', connectionId: 'c-a3-2', now: T0 });
    expect(await removeConnection({ userId: 'a3', connectionId: 'c-a3-1', now: T1 })).toBe(
      'REMOVED',
    );
    expect(await removeConnection({ userId: 'a3', connectionId: 'c-a3-1', now: T1 })).toBe(
      'NOT_FOUND_OR_CHANGED',
    );
    expect((await getPresence('a3')).activeConnectionCount).toBe(1);
  });

  it('concurrent registrations for one user all count', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        registerConnection({ userId: 'a4', connectionId: `c-a4-${i}`, now: T0 }),
      ),
    );
    expect((await getPresence('a4')).activeConnectionCount).toBe(5);
  });

  it('heartbeat updates an existing connection but never recreates a removed one', async () => {
    await registerConnection({ userId: 'a5', connectionId: 'c-a5-1', now: T0 });
    expect(await updateHeartbeat('a5', 'c-a5-1', T1)).toBe(true);
    expect((await getConnection('a5', 'c-a5-1', true))?.lastHeartbeat).toBe(T1);

    await removeConnection({ userId: 'a5', connectionId: 'c-a5-1', now: T2 });
    expect(await updateHeartbeat('a5', 'c-a5-1', T2)).toBe(false);
    expect(await getConnection('a5', 'c-a5-1', true)).toBeUndefined();
  });

  it('owner item: a connectionId owned by another user is rejected', async () => {
    const opts = { withOwnerItem: true };
    await registerConnection({ userId: 'a6', connectionId: 'shared', now: T0 }, opts);
    await expect(
      registerConnection({ userId: 'a7', connectionId: 'shared', now: T0 }, opts),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getPresence('a7')).activeConnectionCount).toBe(0);
  });

  it('sweeper finds stale connections and skips ones that heartbeated since discovery', async () => {
    await registerConnection({ userId: 'b1', connectionId: 'stale', now: T0 });
    await registerConnection({ userId: 'b2', connectionId: 'alive', now: T0 });

    const cutoff = T1;
    const found: StaleCandidate[] = [];
    for await (const page of scanStaleConnections(cutoff)) {
      found.push(...page);
    }
    const staleOnes = found.filter((c) => c.userId === 'b1' || c.userId === 'b2');
    expect(staleOnes.map((c) => c.userId).sort()).toEqual(['b1', 'b2']);

    // b2 heartbeats after discovery, before cleanup
    await updateHeartbeat('b2', 'alive', T2);

    for (const candidate of staleOnes) {
      await removeStaleConnection(candidate, cutoff, T2);
    }
    expect(await getConnection('b1', 'stale', true)).toBeUndefined();
    expect((await getPresence('b1')).activeConnectionCount).toBe(0);
    expect(await getConnection('b2', 'alive', true)).toBeDefined();
    expect((await getPresence('b2')).activeConnectionCount).toBe(1);
  });
});

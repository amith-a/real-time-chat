import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSweeper } from '../../../src/handlers/scheduled/sweeper';
import * as repositories from '../../../src/repositories';
import * as shared from '../../../src/shared';
import * as managementApi from '../../../src/shared/management-api';

describe('Scheduled stale connection & presence sweeper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.API_GATEWAY_MANAGEMENT_ENDPOINT =
      'https://test.execute-api.ap-south-1.amazonaws.com/dev';
    delete process.env.STALE_CONNECTION_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.API_GATEWAY_MANAGEMENT_ENDPOINT;
  });

  it('determines staleness from lastHeartbeat rather than TTL', () => {
    const nowMs = Date.parse('2026-11-26T12:00:00.000Z');
    // 2 minutes ago -> fresh (default timeout is 3 minutes)
    expect(shared.isConnectionStale('2026-11-26T11:58:00.000Z', nowMs)).toBe(false);
    // 3 minutes 1 second ago -> stale
    expect(shared.isConnectionStale('2026-11-26T11:56:59.000Z', nowMs)).toBe(true);
  });

  it('removes stale connections and broadcasts offline only when user has 0 remaining connections', async () => {
    const nowMs = Date.parse('2026-11-26T12:00:00.000Z');

    vi.spyOn(repositories, 'scanStaleConnections').mockImplementation(async function* () {
      yield [
        {
          userId: 'alice',
          connectionId: 'conn-alice-stale',
          lastHeartbeat: '2026-11-26T11:50:00.000Z',
        },
        {
          userId: 'bob',
          connectionId: 'conn-bob-stale',
          lastHeartbeat: '2026-11-26T11:51:00.000Z',
        },
      ];
    });

    vi.spyOn(repositories, 'removeStaleConnection').mockResolvedValue('REMOVED');

    // Alice still has 1 other active connection; Bob is now offline
    vi.spyOn(repositories, 'getPresence').mockImplementation(async (uid) => {
      if (uid === 'alice') {
        return { online: true, activeConnectionCount: 1 };
      }
      return {
        online: false,
        activeConnectionCount: 0,
        lastSeenAt: '2026-11-26T12:00:00.000Z',
      };
    });

    const broadcastSpy = vi
      .spyOn(shared, 'broadcastPresenceChange')
      .mockResolvedValue({ recipientCount: 2, deliveredCount: 2 });

    const result = await runSweeper(nowMs);

    expect(result.scannedCandidates).toBe(2);
    expect(result.removedCount).toBe(2);
    expect(result.offlineBroadcasts).toBe(1);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledWith({
      userId: 'bob',
      status: 'offline',
      lastSeenAt: '2026-11-26T12:00:00.000Z',
    });
  });

  it('broadcasts presence updates to deduplicated room peers', async () => {
    vi.spyOn(repositories, 'listRoomsForUser').mockResolvedValue([
      {
        PK: 'USER#alice',
        SK: 'ROOM#room-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'MEMBER#alice',
        userId: 'alice',
        roomId: 'room-1',
        role: 'MEMBER',
        joinedAt: '2026-11-26T00:00:00Z',
      },
    ]);
    vi.spyOn(repositories, 'listRoomMembers').mockResolvedValue([
      {
        PK: 'USER#alice',
        SK: 'ROOM#room-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'MEMBER#alice',
        userId: 'alice',
        roomId: 'room-1',
        role: 'MEMBER',
        joinedAt: '2026-11-26T00:00:00Z',
      },
      {
        PK: 'USER#bob',
        SK: 'ROOM#room-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'MEMBER#bob',
        userId: 'bob',
        roomId: 'room-1',
        role: 'MEMBER',
        joinedAt: '2026-11-26T00:00:00Z',
      },
    ]);
    vi.spyOn(repositories, 'listUserConnections').mockResolvedValue([
      {
        PK: 'USER#bob',
        SK: 'CONNECTION#conn-bob-1',
        userId: 'bob',
        connectionId: 'conn-bob-1',
        connectedAt: '2026-11-26T00:00:00Z',
        lastHeartbeat: '2026-11-26T00:00:00Z',
      },
    ]);
    const postSpy = vi.spyOn(managementApi, 'postToConnection').mockResolvedValue(true);

    const res = await shared.broadcastPresenceChange({
      userId: 'alice',
      status: 'online',
      lastSeenAt: '2026-11-26T12:00:00.000Z',
    });

    expect(res).toEqual({ recipientCount: 1, deliveredCount: 1 });
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-bob-1',
        userId: 'bob',
        payload: {
          action: 'presence',
          userId: 'alice',
          status: 'online',
          lastSeenAt: '2026-11-26T12:00:00.000Z',
        },
      }),
    );
  });

  describe('Sweeper Checkpoint & Pagination', () => {
    const originalTableName = process.env.TABLE_NAME;
    const originalMaxPages = process.env.SWEEPER_MAX_PAGES;

    beforeEach(() => {
      process.env.TABLE_NAME = 'test-sweeper-table';
      delete process.env.SWEEPER_MAX_PAGES;
    });

    afterEach(() => {
      if (originalTableName === undefined) {
        delete process.env.TABLE_NAME;
      } else {
        process.env.TABLE_NAME = originalTableName;
      }
      if (originalMaxPages === undefined) {
        delete process.env.SWEEPER_MAX_PAGES;
      } else {
        process.env.SWEEPER_MAX_PAGES = originalMaxPages;
      }
    });

    it('starts scanning from the beginning when no checkpoint exists', async () => {
      vi.spyOn(repositories, 'getSweeperCheckpoint').mockResolvedValue(undefined);
      const clearSpy = vi.spyOn(repositories, 'clearSweeperCheckpoint').mockResolvedValue();
      const saveSpy = vi.spyOn(repositories, 'saveSweeperCheckpoint').mockResolvedValue();

      const scanSpy = vi
        .spyOn(repositories, 'scanStaleConnections')
        .mockImplementation(async function* (_cutoff, _batch, _max, initialStartKey, onComplete) {
          expect(initialStartKey).toBeUndefined();
          yield [];
          await onComplete?.(undefined);
        });

      await runSweeper(Date.parse('2026-11-26T12:00:00.000Z'));

      expect(scanSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('resumes from saved LastEvaluatedKey checkpoint on next invocation', async () => {
      const savedKey = { PK: 'USER#alice', SK: 'CONN#conn-1' };
      vi.spyOn(repositories, 'getSweeperCheckpoint').mockResolvedValue(savedKey);
      const clearSpy = vi.spyOn(repositories, 'clearSweeperCheckpoint').mockResolvedValue();

      const scanSpy = vi
        .spyOn(repositories, 'scanStaleConnections')
        .mockImplementation(async function* (_cutoff, _batch, _max, initialStartKey, onComplete) {
          expect(initialStartKey).toEqual(savedKey);
          yield [
            {
              userId: 'bob',
              connectionId: 'conn-bob',
              lastHeartbeat: '2026-11-26T11:50:00.000Z',
            },
          ];
          await onComplete?.(undefined);
        });
      vi.spyOn(repositories, 'removeStaleConnection').mockResolvedValue('NOT_FOUND_OR_CHANGED');

      await runSweeper(Date.parse('2026-11-26T12:00:00.000Z'));

      expect(scanSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('advances checkpoint after each processed page across multiple pages and clears at the end', async () => {
      const keyPage1 = { PK: 'USER#u1', SK: 'CONN#c1' };
      const keyPage2 = { PK: 'USER#u2', SK: 'CONN#c2' };
      vi.spyOn(repositories, 'getSweeperCheckpoint').mockResolvedValue(undefined);
      const saveSpy = vi.spyOn(repositories, 'saveSweeperCheckpoint').mockResolvedValue();
      const clearSpy = vi.spyOn(repositories, 'clearSweeperCheckpoint').mockResolvedValue();
      vi.spyOn(repositories, 'removeStaleConnection').mockResolvedValue('NOT_FOUND_OR_CHANGED');

      vi.spyOn(repositories, 'scanStaleConnections').mockImplementation(
        async function* (_cutoff, _batch, _max, _startKey, onComplete) {
          yield [{ userId: 'u1', connectionId: 'c1', lastHeartbeat: '2026-11-26T11:50:00.000Z' }];
          await onComplete?.(keyPage1);

          yield [{ userId: 'u2', connectionId: 'c2', lastHeartbeat: '2026-11-26T11:50:00.000Z' }];
          await onComplete?.(keyPage2);

          yield [{ userId: 'u3', connectionId: 'c3', lastHeartbeat: '2026-11-26T11:50:00.000Z' }];
          await onComplete?.(undefined);
        },
      );

      const res = await runSweeper(Date.parse('2026-11-26T12:00:00.000Z'));

      expect(res.scannedPages).toBe(3);
      expect(saveSpy).toHaveBeenNthCalledWith(1, keyPage1);
      expect(saveSpy).toHaveBeenNthCalledWith(2, keyPage2);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('retains checkpoint when SWEEPER_MAX_PAGES limit is reached so next invocation can continue', async () => {
      process.env.SWEEPER_MAX_PAGES = '1';
      const nextKey = { PK: 'USER#u1', SK: 'CONN#c1' };
      vi.spyOn(repositories, 'getSweeperCheckpoint').mockResolvedValue(undefined);
      const saveSpy = vi.spyOn(repositories, 'saveSweeperCheckpoint').mockResolvedValue();
      const clearSpy = vi.spyOn(repositories, 'clearSweeperCheckpoint').mockResolvedValue();
      vi.spyOn(repositories, 'removeStaleConnection').mockResolvedValue('NOT_FOUND_OR_CHANGED');

      vi.spyOn(repositories, 'scanStaleConnections').mockImplementation(
        async function* (_cutoff, _batch, maxPages, _startKey, onComplete) {
          expect(maxPages).toBe(1);
          yield [{ userId: 'u1', connectionId: 'c1', lastHeartbeat: '2026-11-26T11:50:00.000Z' }];
          await onComplete?.(nextKey);
        },
      );

      const res = await runSweeper(Date.parse('2026-11-26T12:00:00.000Z'));

      expect(res.scannedPages).toBe(1);
      expect(saveSpy).toHaveBeenCalledWith(nextKey);
      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('does not advance checkpoint when page processing fails', async () => {
      const nextKey = { PK: 'USER#u1', SK: 'CONN#c1' };
      vi.spyOn(repositories, 'getSweeperCheckpoint').mockResolvedValue(undefined);
      const saveSpy = vi.spyOn(repositories, 'saveSweeperCheckpoint').mockResolvedValue();
      const clearSpy = vi.spyOn(repositories, 'clearSweeperCheckpoint').mockResolvedValue();
      vi.spyOn(repositories, 'removeStaleConnection').mockRejectedValue(
        new Error('DynamoDB write failed'),
      );

      vi.spyOn(repositories, 'scanStaleConnections').mockImplementation(
        async function* (_cutoff, _batch, _max, _startKey, onComplete) {
          yield [{ userId: 'u1', connectionId: 'c1', lastHeartbeat: '2026-11-26T11:50:00.000Z' }];
          await onComplete?.(nextKey);
        },
      );

      const res = await runSweeper(Date.parse('2026-11-26T12:00:00.000Z'));

      expect(res.scannedPages).toBe(1);
      expect(res.removedCount).toBe(0);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(clearSpy).not.toHaveBeenCalled();
    });
  });
});

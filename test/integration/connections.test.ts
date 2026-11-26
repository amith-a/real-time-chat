import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handler as connectHandler } from '../../src/handlers/websocket/connect';
import { handler as disconnectHandler } from '../../src/handlers/websocket/disconnect';
import * as repos from '../../src/repositories';
import {
  getConnection,
  getPresence,
  getUserProfile,
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

const mockContext = {} as Context;
const mockCallback = () => {};

function makeWsEvent(options: {
  connectionId?: string;
  routeKey?: string;
  authorizer?: { userId?: string; email?: string };
}): APIGatewayProxyWebsocketEventV2 {
  return {
    isBase64Encoded: false,
    requestContext: {
      routeKey: options.routeKey || '$connect',
      messageId: 'msg-test',
      eventType: 'CONNECT',
      extendedRequestId: 'ext-test',
      requestTime: '2026-11-22T00:00:00Z',
      messageDirection: 'IN',
      stage: 'test',
      connectedAt: 1700000000,
      requestTimeEpoch: 1700000000,
      requestId: 'req-test',
      domainName: 'test.example.com',
      connectionId: options.connectionId || 'conn-test',
      apiId: 'test-api',
      authorizer: options.authorizer,
    } as unknown as APIGatewayProxyWebsocketEventV2['requestContext'],
  };
}

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

  describe('$connect and $disconnect Lambda handlers', () => {
    it('$connect registers connection and sets user online', async () => {
      const event = makeWsEvent({
        connectionId: 'c-hdl-1',
        routeKey: '$connect',
        authorizer: { userId: 'u-hdl-1', email: 'uhdl1@example.com' },
      });
      const response = await connectHandler(event, mockContext, mockCallback);
      expect(response).toEqual({ statusCode: 200, body: 'Connected' });

      const conn = await getConnection('u-hdl-1', 'c-hdl-1', true);
      expect(conn).toBeDefined();
      expect(conn?.connectionId).toBe('c-hdl-1');

      const presence = await getPresence('u-hdl-1');
      expect(presence).toMatchObject({ online: true, activeConnectionCount: 1 });

      const profile = await getUserProfile('u-hdl-1');
      expect(profile).toMatchObject({
        userId: 'u-hdl-1',
        email: 'uhdl1@example.com',
      });
    });

    it('$connect rejects unauthenticated connection with 401', async () => {
      const event = makeWsEvent({
        connectionId: 'c-hdl-2',
        routeKey: '$connect',
      });
      const response = await connectHandler(event, mockContext, mockCallback);
      expect(response).toMatchObject({
        statusCode: 401,
        body: JSON.stringify({ message: 'Missing authenticated userId' }),
      });
    });

    it('$connect rejects stolen connectionId with 403', async () => {
      // First user u-hdl-1 already owns c-hdl-1 from the first test
      const event = makeWsEvent({
        connectionId: 'c-hdl-1',
        routeKey: '$connect',
        authorizer: { userId: 'u-hdl-2', email: 'uhdl2@example.com' },
      });
      const response = await connectHandler(event, mockContext, mockCallback);
      expect(response).toMatchObject({
        statusCode: 403,
        body: JSON.stringify({ message: 'Connection is registered to a different user' }),
      });
    });

    it('$disconnect removes connection without authorizer by looking up connection owner', async () => {
      // c-hdl-1 is connected for u-hdl-1. API Gateway sends $disconnect WITHOUT authorizer
      const event = makeWsEvent({
        connectionId: 'c-hdl-1',
        routeKey: '$disconnect',
      });
      const response = await disconnectHandler(event, mockContext, mockCallback);
      expect(response).toEqual({ statusCode: 200, body: 'Disconnected' });

      const conn = await getConnection('u-hdl-1', 'c-hdl-1', true);
      expect(conn).toBeUndefined();

      const presence = await getPresence('u-hdl-1');
      expect(presence).toMatchObject({ online: false, activeConnectionCount: 0 });
    });

    it('$disconnect handles unknown connection gracefully with 200', async () => {
      const event = makeWsEvent({
        connectionId: 'c-hdl-ghost',
        routeKey: '$disconnect',
      });
      const response = await disconnectHandler(event, mockContext, mockCallback);
      expect(response).toEqual({ statusCode: 200, body: 'Disconnected' });
    });

    it('$connect duplicate connection from the same user returns 200 without incrementing presence twice', async () => {
      const event = makeWsEvent({
        connectionId: 'c-dup-1',
        routeKey: '$connect',
        authorizer: { userId: 'u-dup-1', email: 'dup@example.com' },
      });

      const res1 = await connectHandler(event, mockContext, mockCallback);
      expect(res1).toEqual({ statusCode: 200, body: 'Connected' });
      expect(await getPresence('u-dup-1')).toMatchObject({
        online: true,
        activeConnectionCount: 1,
      });

      // Second connect with identical connectionId and userId
      const res2 = await connectHandler(event, mockContext, mockCallback);
      expect(res2).toEqual({ statusCode: 200, body: 'Connected' });
      expect(await getPresence('u-dup-1')).toMatchObject({
        online: true,
        activeConnectionCount: 1,
      });
    });

    it('$disconnect repeated invocation does not decrement presence twice', async () => {
      // Connect two connections for the same user
      const event1 = makeWsEvent({
        connectionId: 'c-rep-1',
        routeKey: '$connect',
        authorizer: { userId: 'u-rep-1', email: 'rep@example.com' },
      });
      const event2 = makeWsEvent({
        connectionId: 'c-rep-2',
        routeKey: '$connect',
        authorizer: { userId: 'u-rep-1', email: 'rep@example.com' },
      });

      await connectHandler(event1, mockContext, mockCallback);
      await connectHandler(event2, mockContext, mockCallback);
      expect(await getPresence('u-rep-1')).toMatchObject({
        online: true,
        activeConnectionCount: 2,
      });

      // First disconnect for c-rep-1
      const dis1 = await disconnectHandler(
        makeWsEvent({ connectionId: 'c-rep-1', routeKey: '$disconnect' }),
        mockContext,
        mockCallback,
      );
      expect(dis1).toEqual({ statusCode: 200, body: 'Disconnected' });
      expect(await getPresence('u-rep-1')).toMatchObject({
        online: true,
        activeConnectionCount: 1,
      });

      // Repeated disconnect for c-rep-1
      const disRepeated = await disconnectHandler(
        makeWsEvent({ connectionId: 'c-rep-1', routeKey: '$disconnect' }),
        mockContext,
        mockCallback,
      );
      expect(disRepeated).toEqual({ statusCode: 200, body: 'Disconnected' });
      expect(await getPresence('u-rep-1')).toMatchObject({
        online: true,
        activeConnectionCount: 1,
      });

      // Disconnect c-rep-2
      const dis2 = await disconnectHandler(
        makeWsEvent({ connectionId: 'c-rep-2', routeKey: '$disconnect' }),
        mockContext,
        mockCallback,
      );
      expect(dis2).toEqual({ statusCode: 200, body: 'Disconnected' });
      expect(await getPresence('u-rep-1')).toMatchObject({
        online: false,
        activeConnectionCount: 0,
      });

      // Repeated disconnect for c-rep-2 should not decrement below 0
      const dis2Repeated = await disconnectHandler(
        makeWsEvent({ connectionId: 'c-rep-2', routeKey: '$disconnect' }),
        mockContext,
        mockCallback,
      );
      expect(dis2Repeated).toEqual({ statusCode: 200, body: 'Disconnected' });
      expect(await getPresence('u-rep-1')).toMatchObject({
        online: false,
        activeConnectionCount: 0,
      });
    });

    it('$disconnect resolves real owner via getConnectionOwner regardless of authorizer context', async () => {
      // Legitimate user u-legit owns c-legit-1
      await connectHandler(
        makeWsEvent({
          connectionId: 'c-legit-1',
          routeKey: '$connect',
          authorizer: { userId: 'u-legit', email: 'legit@example.com' },
        }),
        mockContext,
        mockCallback,
      );
      expect(await getPresence('u-legit')).toMatchObject({
        online: true,
        activeConnectionCount: 1,
      });

      // $disconnect resolves the authoritative owner from CONN#<id>/OWNER even if authorizer differs
      const response = await disconnectHandler(
        makeWsEvent({
          connectionId: 'c-legit-1',
          routeKey: '$disconnect',
          authorizer: { userId: 'u-imposter', email: 'imposter@example.com' },
        }),
        mockContext,
        mockCallback,
      );
      expect(response).toEqual({ statusCode: 200, body: 'Disconnected' });

      // u-legit's connection is removed and presence decremented to 0
      expect(await getConnection('u-legit', 'c-legit-1', true)).toBeUndefined();
      expect(await getPresence('u-legit', true)).toMatchObject({
        online: false,
        activeConnectionCount: 0,
      });

      // u-imposter's presence was never touched
      expect((await getPresence('u-imposter')).activeConnectionCount).toBe(0);
    });

    it('$disconnect returns 200 even when database cleanup fails', async () => {
      vi.spyOn(repos, 'getConnectionOwner').mockResolvedValueOnce('u-cleanup-fail');
      const spy = vi
        .spyOn(repos, 'removeConnection')
        .mockRejectedValueOnce(new Error('Simulated DynamoDB outage'));

      const response = await disconnectHandler(
        makeWsEvent({
          connectionId: 'c-cleanup-fail',
          routeKey: '$disconnect',
        }),
        mockContext,
        mockCallback,
      );

      expect(response).toEqual({ statusCode: 200, body: 'Disconnected' });
      expect(spy).toHaveBeenCalledWith({
        userId: 'u-cleanup-fail',
        connectionId: 'c-cleanup-fail',
      });
    });
  });
});

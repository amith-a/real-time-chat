import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSweeper } from '../../src/handlers/scheduled/sweeper';
import { handler as connectHandler } from '../../src/handlers/websocket/connect';
import { handler as disconnectHandler } from '../../src/handlers/websocket/disconnect';
import { handler as heartbeatHandler } from '../../src/handlers/websocket/heartbeat';
import { handler as typingHandler } from '../../src/handlers/websocket/typing';
import {
  createGroupRoom,
  ensureUserProfile,
  getConnection,
  getConnectionOwner,
  getPresence,
  getRoomSequence,
  updateHeartbeat,
} from '../../src/repositories';
import * as shared from '../../src/shared';
import * as managementApi from '../../src/shared/management-api';
import { createTestTable, safeTeardown } from './helpers';

const mockContext = {} as Context;
const mockCallback = () => {};

function makeWsEvent(options: {
  connectionId: string;
  routeKey: string;
  authorizer?: { userId: string; email?: string; username?: string };
  body?: string;
}): APIGatewayProxyWebsocketEventV2 {
  return {
    isBase64Encoded: false,
    requestContext: {
      routeKey: options.routeKey,
      messageId: 'msg-presence-test',
      eventType: 'MESSAGE',
      extendedRequestId: 'ext-1',
      requestTime: '2026-11-26T12:00:00Z',
      messageDirection: 'IN',
      stage: 'dev',
      connectedAt: Date.now(),
      requestTimeEpoch: Date.now(),
      requestId: 'req-presence-1',
      domainName: 'test.execute-api.ap-south-1.amazonaws.com',
      connectionId: options.connectionId,
      apiId: 'test-api',
      ...(options.authorizer ? { authorizer: options.authorizer } : {}),
    } as unknown as APIGatewayProxyWebsocketEventV2['requestContext'],
    body: options.body,
  };
}

describe('Phase 10 Presence, Heartbeat, Typing & Sweeper Integration (DynamoDB Local)', () => {
  let table: string;

  beforeAll(async () => {
    table = await createTestTable();
    process.env.TABLE_NAME = table;
    process.env.API_GATEWAY_MANAGEMENT_ENDPOINT =
      'https://test.execute-api.ap-south-1.amazonaws.com/dev';
  });

  afterAll(async () => {
    delete process.env.API_GATEWAY_MANAGEMENT_ENDPOINT;
    await safeTeardown(table);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs full lifecycle: connect -> online broadcast -> heartbeat -> typing -> sweeper offline -> reconnect', async () => {
    const roomId = 'presence-integration-room';
    const alice = 'user-alice-p10';
    const bob = 'user-bob-p10';

    const sentFrames: Array<{ connectionId: string; payload: unknown }> = [];
    vi.spyOn(managementApi, 'postToConnection').mockImplementation(async (input) => {
      sentFrames.push({ connectionId: input.connectionId, payload: input.payload });
      return true;
    });
    vi.spyOn(shared, 'postToConnection').mockImplementation(async (input) => {
      sentFrames.push({ connectionId: input.connectionId, payload: input.payload });
      return true;
    });

    // 1. Seed user profiles and shared room
    await ensureUserProfile({ userId: alice, email: 'alice@example.com', username: 'alice' });
    await ensureUserProfile({ userId: bob, email: 'bob@example.com', username: 'bob' });
    await createGroupRoom({
      roomId,
      name: 'Presence Test Room',
      createdBy: alice,
      members: [
        { userId: alice, role: 'ADMIN' },
        { userId: bob, role: 'MEMBER' },
      ],
      validateUsers: false,
    });

    // 2. Connect Alice (0 -> 1): becomes online
    const connA1Res = (await connectHandler(
      makeWsEvent({
        connectionId: 'conn-alice-1',
        routeKey: '$connect',
        authorizer: { userId: alice, email: 'alice@example.com' },
      }),
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;
    expect(connA1Res.statusCode).toBe(200);
    expect(await getPresence(alice, true)).toMatchObject({
      online: true,
      activeConnectionCount: 1,
    });

    // 3. Connect Bob (0 -> 1): Alice receives online presence broadcast
    sentFrames.length = 0;
    await connectHandler(
      makeWsEvent({
        connectionId: 'conn-bob-1',
        routeKey: '$connect',
        authorizer: { userId: bob, email: 'bob@example.com' },
      }),
      mockContext,
      mockCallback,
    );
    expect(await getPresence(bob, true)).toMatchObject({
      online: true,
      activeConnectionCount: 1,
    });
    expect(sentFrames).toContainEqual({
      connectionId: 'conn-alice-1',
      payload: expect.objectContaining({
        action: 'presence',
        userId: bob,
        status: 'online',
      }),
    });

    // 4. Connect Alice's second tab (1 -> 2): Bob must NOT receive a duplicate online broadcast
    sentFrames.length = 0;
    await connectHandler(
      makeWsEvent({
        connectionId: 'conn-alice-2',
        routeKey: '$connect',
        authorizer: { userId: alice, email: 'alice@example.com' },
      }),
      mockContext,
      mockCallback,
    );
    expect(await getPresence(alice, true)).toMatchObject({
      online: true,
      activeConnectionCount: 2,
    });
    expect(
      sentFrames.filter((f) => (f.payload as { action?: string }).action === 'presence'),
    ).toEqual([]);

    // 5. Heartbeat from conn-alice-1 succeeds
    const hbRes = (await heartbeatHandler(
      makeWsEvent({
        connectionId: 'conn-alice-1',
        routeKey: 'heartbeat',
        body: JSON.stringify({ action: 'heartbeat' }),
      }),
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;
    expect(hbRes.statusCode).toBe(200);
    expect(JSON.parse(hbRes.body)).toMatchObject({
      action: 'heartbeatAck',
      status: 'ok',
      nextHeartbeatMs: shared.HEARTBEAT_INTERVAL_MS,
    });

    // 6. Ephemeral typing indicator (isTyping: true -> false), never persisted
    sentFrames.length = 0;
    const typRes = (await typingHandler(
      makeWsEvent({
        connectionId: 'conn-alice-1',
        routeKey: 'typing',
        body: JSON.stringify({ action: 'typing', roomId, isTyping: true }),
      }),
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;
    expect(typRes.statusCode).toBe(200);
    expect(JSON.parse(typRes.body)).toEqual({
      action: 'typingAck',
      roomId,
      isTyping: true,
    });
    expect(sentFrames.map((f) => f.connectionId).sort()).toEqual(['conn-alice-2', 'conn-bob-1']);
    expect(await getRoomSequence(roomId)).toBe(0);

    // 7. Advance time by 4 minutes (> 3m stale timeout, while TTL is untouched).
    // Refresh conn-alice-1 heartbeat to 30s before futureNow so only conn-alice-2 and conn-bob-1 are stale.
    const futureNowMs = Date.now() + 4 * 60_000;
    await updateHeartbeat(alice, 'conn-alice-1', new Date(futureNowMs - 30_000).toISOString());

    sentFrames.length = 0;
    const sweepResult = await runSweeper(futureNowMs);

    expect(sweepResult.removedCount).toBe(2);
    expect(sweepResult.offlineBroadcasts).toBe(1);

    // conn-alice-1 survived; conn-alice-2 and conn-bob-1 were swept
    expect(await getConnection(alice, 'conn-alice-1', true)).toBeDefined();
    expect(await getConnection(alice, 'conn-alice-2', true)).toBeUndefined();
    expect(await getConnection(bob, 'conn-bob-1', true)).toBeUndefined();
    expect(await getConnectionOwner('conn-bob-1')).toBeUndefined();

    // Alice still online (1 connection); Bob offline (0 connections)
    expect(await getPresence(alice, true)).toMatchObject({
      online: true,
      activeConnectionCount: 1,
    });
    expect(await getPresence(bob, true)).toMatchObject({
      online: false,
      activeConnectionCount: 0,
    });

    // Offline presence broadcast sent only for Bob to Alice's surviving socket
    expect(sentFrames).toEqual([
      {
        connectionId: 'conn-alice-1',
        payload: expect.objectContaining({
          action: 'presence',
          userId: bob,
          status: 'offline',
        }),
      },
    ]);

    // 8. Late heartbeat from swept conn-bob-1 returns status=reconnect and does not resurrect
    const lateHbRes = (await heartbeatHandler(
      makeWsEvent({
        connectionId: 'conn-bob-1',
        routeKey: 'heartbeat',
        body: JSON.stringify({ action: 'heartbeat' }),
      }),
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;
    expect(lateHbRes.statusCode).toBe(200);
    expect(JSON.parse(lateHbRes.body).status).toBe('reconnect');
    expect(await getConnection(bob, 'conn-bob-1', true)).toBeUndefined();

    // 9. Clean disconnect of Alice's last socket transitions Alice offline
    await disconnectHandler(
      makeWsEvent({
        connectionId: 'conn-alice-1',
        routeKey: '$disconnect',
      }),
      mockContext,
      mockCallback,
    );
    expect(await getPresence(alice, true)).toMatchObject({
      online: false,
      activeConnectionCount: 0,
    });
  }, 30_000);
});

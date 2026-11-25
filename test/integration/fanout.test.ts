import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as connectHandler } from '../../src/handlers/websocket/connect';
import { handler as sendMessageHandler } from '../../src/handlers/websocket/sendMessage';
import {
  createGroupRoom,
  ensureUserProfile,
  getConnection,
  getDocClient,
  getMessage,
  getRoomSequence,
  removeConnection,
} from '../../src/repositories';
import * as shared from '../../src/shared';
import { createTestTable, safeTeardown } from './helpers';

function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, index)] * 100) / 100;
}

const mockContext = {} as Context;
const mockCallback = () => {};

function makeWsEvent(options: {
  connectionId: string;
  routeKey?: string;
  authorizer: { userId: string; email?: string; username?: string };
  body?: string;
}): APIGatewayProxyWebsocketEventV2 {
  return {
    isBase64Encoded: false,
    requestContext: {
      routeKey: options.routeKey || 'sendMessage',
      messageId: 'msg-ws-req',
      eventType: 'MESSAGE',
      extendedRequestId: 'ext-req-1',
      requestTime: '2026-11-25T10:00:00Z',
      messageDirection: 'IN',
      stage: 'dev',
      connectedAt: 1700000000,
      requestTimeEpoch: 1700000000,
      requestId: 'req-1',
      domainName: 'test.execute-api.ap-south-1.amazonaws.com',
      connectionId: options.connectionId,
      apiId: 'test-api',
      authorizer: options.authorizer,
    } as unknown as APIGatewayProxyWebsocketEventV2['requestContext'],
    body: options.body,
  };
}

describe('Room Fan-Out Integration (50+ members on DynamoDB Local)', () => {
  let table: string;

  beforeAll(async () => {
    table = await createTestTable();
    process.env.TABLE_NAME = table;
    process.env.API_GATEWAY_MANAGEMENT_ENDPOINT =
      'https://test.execute-api.ap-south-1.amazonaws.com/dev';
  });

  afterAll(async () => {
    await safeTeardown(table);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully fans out across 50 members and 75 connections with bounded concurrency and stale pruning', async () => {
    const memberCount = 50;
    const senderId = 'user-00';
    const roomId = 'group-fanout-benchmark-50';

    // 1. Create 50 distinct user profiles and connect them
    const memberList: Array<{ userId: string; role: 'ADMIN' | 'MEMBER' }> = [];
    const allConnectionIds: string[] = [];
    const staleConnectionIds = new Set([
      'conn-user-05-tab1',
      'conn-user-12-tab1',
      'conn-user-30-tab1',
    ]);

    for (let i = 0; i < memberCount; i++) {
      const pad = String(i).padStart(2, '0');
      const userId = `user-${pad}`;
      memberList.push({ userId, role: i === 0 ? 'ADMIN' : 'MEMBER' });

      await ensureUserProfile({
        userId,
        email: `${userId}@example.com`,
        username: userId,
      });

      // Connect primary connection
      const conn1 = `conn-${userId}-tab1`;
      allConnectionIds.push(conn1);
      await connectHandler(
        makeWsEvent({
          connectionId: conn1,
          routeKey: '$connect',
          authorizer: { userId, email: `${userId}@example.com` },
        }),
        mockContext,
        mockCallback,
      );

      // Give half the members a second active device/tab (total 75 connections)
      if (i % 2 === 0) {
        const conn2 = `conn-${userId}-tab2`;
        allConnectionIds.push(conn2);
        await connectHandler(
          makeWsEvent({
            connectionId: conn2,
            routeKey: '$connect',
            authorizer: { userId, email: `${userId}@example.com` },
          }),
          mockContext,
          mockCallback,
        );
      }
    }

    // 2. Create group room containing all 50 members
    const roomResult = await createGroupRoom({
      roomId,
      name: 'Fan-Out Test Room 50',
      createdBy: senderId,
      members: memberList,
      validateUsers: false,
    });
    expect(roomResult.created).toBe(true);

    // 3. Instrument DynamoDB QueryCommands and spy on postToConnection
    const docClient = getDocClient();
    const originalDdbSend = docClient.send.bind(docClient);
    let queryCount = 0;
    vi.spyOn(docClient, 'send').mockImplementation((...args: Parameters<typeof docClient.send>) => {
      if (args[0] instanceof QueryCommand) {
        queryCount++;
      }
      return originalDdbSend(...args);
    });

    let deliveredConnections: string[] = [];
    let active = 0;
    let maxActive = 0;

    const postSpy = vi.spyOn(shared, 'postToConnection').mockImplementation(async (input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        // Small delay to simulate network time and test concurrent in-flight limit
        await new Promise((resolve) => setTimeout(resolve, 5));

        // If marked stale, simulate 410 GoneException (and trigger autoPrune)
        if (staleConnectionIds.has(input.connectionId)) {
          await removeConnection({
            userId: input.userId || 'unknown',
            connectionId: input.connectionId,
          });
          return false;
        }

        deliveredConnections.push(input.connectionId);
        return true;
      } finally {
        active--;
      }
    });

    // 4. Send 20 group messages from user-00's primary connection to measure p50/p95 & query count
    const rounds = 20;
    const latenciesMs: number[] = [];
    const queriesPerRound: number[] = [];

    for (let round = 1; round <= rounds; round++) {
      queryCount = 0;
      deliveredConnections = [];
      postSpy.mockClear();

      const sendStart = performance.now();
      const sendEvent = makeWsEvent({
        connectionId: 'conn-user-00-tab1',
        routeKey: 'sendMessage',
        authorizer: { userId: senderId, email: 'user-00@example.com' },
        body: JSON.stringify({
          action: 'sendMessage',
          roomId,
          messageId: `fanout-msg-benchmark-${round}`,
          body: `Benchmark high-concurrency fan-out #${round}`,
        }),
      });

      const res = (await sendMessageHandler(
        sendEvent,
        mockContext,
        mockCallback,
      )) as shared.WebSocketResponse;
      const elapsedMs = performance.now() - sendStart;

      latenciesMs.push(elapsedMs);
      queriesPerRound.push(queryCount);

      // Verify response
      expect(res).toBeDefined();
      expect(res.statusCode).toBe(200);
      const ack = JSON.parse(res.body || '{}');
      expect(ack.action).toBe('ack');
      expect(ack.roomId).toBe(roomId);
      expect(ack.sequenceNumber).toBe(round);
      expect(ack.isDuplicate).toBe(false);

      // Verify exact delivery count & destinations
      // Round 1 attempts 74 (71 active + 3 stale) and prunes the 3 stale connections.
      // Rounds 2..20 attempt 71 (only active connections remain).
      const expectedAttempts = round === 1 ? 74 : 71;
      expect(postSpy).toHaveBeenCalledTimes(expectedAttempts);
      expect(deliveredConnections).toHaveLength(71);

      // Verify sender's current connection was excluded
      expect(deliveredConnections).not.toContain('conn-user-00-tab1');

      // Verify no duplicate delivery attempts
      const calledConnectionIds = postSpy.mock.calls.map((call) => call[0].connectionId);
      expect(new Set(calledConnectionIds).size).toBe(expectedAttempts);

      if (round === 1) {
        for (const connId of allConnectionIds) {
          if (connId !== 'conn-user-00-tab1' && !staleConnectionIds.has(connId)) {
            expect(deliveredConnections).toContain(connId);
          }
        }
      }
    }

    // 5. Verify sequence counter and persisted messages in DynamoDB
    const seq = await getRoomSequence(roomId);
    expect(seq).toBe(rounds);

    const persisted = await getMessage(roomId, 1);
    expect(persisted).toBeDefined();
    expect(persisted?.content).toBe('Benchmark high-concurrency fan-out #1');
    expect(persisted?.senderId).toBe(senderId);

    // 6. Verify actual concurrency limit & measured query count (1 room members + 50 user connections = 51)
    expect(maxActive).toBeLessThanOrEqual(shared.DEFAULT_GATEWAY_CONCURRENCY);
    for (const qCount of queriesPerRound) {
      expect(qCount).toBe(51);
    }

    // 7. Verify 3 stale connections were pruned
    expect(await getConnection('user-05', 'conn-user-05-tab1')).toBeUndefined();
    expect(await getConnection('user-12', 'conn-user-12-tab1')).toBeUndefined();
    expect(await getConnection('user-30', 'conn-user-30-tab1')).toBeUndefined();

    // 8. Compute and log measured percentiles and counts
    const p50 = calculatePercentile(latenciesMs, 50);
    const p95 = calculatePercentile(latenciesMs, 95);
    expect(latenciesMs).toHaveLength(rounds);
    expect(p95).toBeGreaterThanOrEqual(p50);

    console.info(
      `Fan-out benchmark (50 members, 71 active, 3 stale pruned, 51 DDB queries/msg, maxActive=${maxActive}/${shared.DEFAULT_GATEWAY_CONCURRENCY}): p50=${p50}ms, p95=${p95}ms across ${rounds} rounds`,
    );
  }, 60_000);
});

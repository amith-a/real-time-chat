import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createGroupRoom } from '../../src/repositories';
import { cleanupCognitoBenchUsers, resolveDistinctUsers } from './cognito-users';
import {
  type AuthenticatedUser,
  BENCHMARK_ROOM_PREFIX,
  REGION,
  TEST_ROUNDS,
  WARMUP_ROUNDS,
  WS_URL,
} from './config';
import { cleanupBenchmarkRoom, verifyDisconnectCleanup } from './dynamodb-cleanup';
import {
  closeSocketsSafely,
  connectRecipientsInBatches,
  connectSocket,
  sendAndVerifyFanout,
} from './ws-client';

function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, index)]);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--cleanup') {
    const targetRoomId = args[1];
    if (!targetRoomId) {
      console.error('Usage: npm run benchmark:fanout -- --cleanup <benchmark-room-id>');
      process.exit(1);
    }
    await cleanupBenchmarkRoom(targetRoomId, []);
    return;
  }

  if (args[0] === '--cleanup-users') {
    const targetRunId = args[1];
    if (!targetRunId) {
      console.error('Usage: npm run benchmark:fanout -- --cleanup-users <runId>');
      process.exit(1);
    }
    await cleanupCognitoBenchUsers(targetRunId);
    return;
  }

  if (!WS_URL || !process.env.TABLE_NAME) {
    console.error('Missing required environment variables: WS_URL and TABLE_NAME must be set.');
    console.error(
      'Also set USER_POOL_ID + USER_POOL_CLIENT_ID (or AUTH_TOKENS) to authenticate 50 distinct members.',
    );
    process.exit(1);
  }

  if (!WS_URL.startsWith('wss://') && !WS_URL.startsWith('ws://')) {
    console.error(`Invalid WS_URL '${WS_URL}': must start with wss:// or ws://`);
    process.exit(1);
  }

  const runId = randomUUID().slice(0, 8);
  const ownedUsernames = new Set<string>();
  const roomId = `${BENCHMARK_ROOM_PREFIX}${runId}`;
  const allSockets: WebSocket[] = [];
  let users: AuthenticatedUser[] = [];
  let roomCreated = false;
  let cleanupStarted = false;

  const runTeardown = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    let teardownFailed = false;

    if (allSockets.length > 0) {
      console.log(
        `\nClosing ${allSockets.length} WebSocket connections (triggering $disconnect)...`,
      );
      try {
        await closeSocketsSafely(allSockets);
      } catch (err) {
        teardownFailed = true;
        console.error('Error closing WebSocket connections:', err);
      }

      try {
        await verifyDisconnectCleanup(users.map((u) => u.userId));
      } catch (err) {
        teardownFailed = true;
        console.error('Disconnect verification failed:', err);
      }
    }

    if (roomCreated) {
      try {
        await cleanupBenchmarkRoom(
          roomId,
          users.map((u) => u.userId),
        );
      } catch (err) {
        teardownFailed = true;
        console.error(`Room cleanup failed for ${roomId}. Recover manually with:`, err);
        console.error(`  npm run benchmark:fanout -- --cleanup ${roomId}`);
      }
    }

    if (ownedUsernames.size > 0) {
      try {
        await cleanupCognitoBenchUsers(runId, ownedUsernames);
      } catch (err) {
        teardownFailed = true;
        console.error(
          `Cognito user cleanup failed for runId=${runId}. Recover manually with:`,
          err,
        );
        console.error(`  npm run benchmark:fanout -- --cleanup-users ${runId}`);
      }
    }

    if (teardownFailed) {
      process.exitCode = 1;
    }
  };

  const onSignal = (signal: string) => {
    console.warn(`\nReceived ${signal}; running safe cleanup before exit...`);
    void runTeardown().finally(() => process.exit(1));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    users = await resolveDistinctUsers(runId, ownedUsernames);
    const senderUser = users[0];
    const recipientUsers = users.slice(1);

    console.log('='.repeat(64));
    console.log('Phase 9 Real-World 50-Member WebSocket Fan-Out Benchmark');
    console.log(`Run ID:              ${runId}`);
    console.log(`Table:               ${process.env.TABLE_NAME}`);
    console.log(`Benchmark Room:      ${roomId}`);
    console.log(
      `Distinct Members:    ${users.length} (1 sender + ${recipientUsers.length} recipients)`,
    );
    console.log(`Warm-up / Measured:  ${WARMUP_ROUNDS} warm-up / ${TEST_ROUNDS} measured rounds`);
    console.log('='.repeat(64));

    // 1. Create 50-member benchmark room via application repository
    console.log(`\n[1/4] Creating ${users.length}-member room via createGroupRoom()...`);
    roomCreated = true;
    await createGroupRoom({
      roomId,
      name: `Live Fan-Out Benchmark (${users.length} members)`,
      createdBy: senderUser.userId,
      members: users.map((u, idx) => ({
        userId: u.userId,
        role: idx === 0 ? 'ADMIN' : 'MEMBER',
      })),
      validateUsers: false,
    });

    // 2. Connect 1 real WebSocket client per distinct user (failure-safe batched)
    console.log(`\n[2/4] Opening ${users.length} live WebSocket connections...`);
    const senderWs = await connectSocket(`${WS_URL}?token=${senderUser.idToken}`, senderUser.email);
    allSockets.push(senderWs);

    const recipientSockets = await connectRecipientsInBatches(recipientUsers, WS_URL, allSockets);
    console.log(`\n  Connected ${allSockets.length} live WebSocket sockets via $connect.`);

    // 3. Warm-up phase (excludes Lambda cold starts from percentiles)
    console.log(`\n[3/4] Running ${WARMUP_ROUNDS} warm-up messages...`);
    for (let w = 1; w <= WARMUP_ROUNDS; w++) {
      const msgId = `warmup-${w}-${randomUUID().slice(0, 6)}`;
      await sendAndVerifyFanout(senderWs, recipientSockets, roomId, msgId, `Warm-up #${w}`);
      process.stdout.write(`  Warm-up ${w}/${WARMUP_ROUNDS} complete\r`);
    }
    console.log(`\n  Warm-up complete.`);

    // 4. Measured rounds
    console.log(`\n[4/4] Running ${TEST_ROUNDS} measured rounds...`);
    const ackLatencies: number[] = [];
    const deliveryLatencies: number[] = [];
    let totalFramesExpected = 0;
    let totalFramesReceived = 0;
    let totalDuplicates = 0;
    let totalSelfBroadcasts = 0;

    for (let r = 1; r <= TEST_ROUNDS; r++) {
      const msgId = `bench-${r}-${randomUUID().slice(0, 6)}`;
      const res = await sendAndVerifyFanout(
        senderWs,
        recipientSockets,
        roomId,
        msgId,
        `Benchmark payload #${r}`,
      );
      ackLatencies.push(res.ackLatencyMs);
      deliveryLatencies.push(res.fanoutDeliveryLatencyMs);
      totalFramesExpected += recipientSockets.length;
      totalFramesReceived += res.receivedCount;
      totalDuplicates += res.duplicateFrames;
      totalSelfBroadcasts += res.senderSelfBroadcasts;

      process.stdout.write(
        `  Round ${r}/${TEST_ROUNDS} - ACK: ${Math.round(res.ackLatencyMs)}ms | All ${recipientSockets.length} Recipients: ${Math.round(res.fanoutDeliveryLatencyMs)}ms\r`,
      );
    }

    // 5. Report results
    console.log('\n\n================ LIVE BENCHMARK RESULTS ================');
    console.log(`Run ID:               ${runId}`);
    console.log(`Room ID:              ${roomId}`);
    console.log(`Distinct Members:     ${users.length}`);
    console.log(
      `Live Connections:     ${allSockets.length} (1 sender + ${recipientSockets.length} recipients)`,
    );
    console.log(
      `Measured Rounds:      ${TEST_ROUNDS} messages (${WARMUP_ROUNDS} warm-up excluded)`,
    );
    console.log(
      `Recipient Delivery:   ${totalFramesReceived}/${totalFramesExpected} frames received (${((totalFramesReceived / totalFramesExpected) * 100).toFixed(2)}%)`,
    );
    console.log(`Duplicate Frames:     ${totalDuplicates}`);
    console.log(`Sender Self-Sends:    ${totalSelfBroadcasts}`);
    console.log('--------------------------------------------------------');
    console.log(
      `Sender ACK Latency:   p50=${calculatePercentile(ackLatencies, 50)}ms | p90=${calculatePercentile(ackLatencies, 90)}ms | p95=${calculatePercentile(ackLatencies, 95)}ms`,
    );
    console.log(
      `All-Recipient E2E:    p50=${calculatePercentile(deliveryLatencies, 50)}ms | p90=${calculatePercentile(deliveryLatencies, 90)}ms | p95=${calculatePercentile(deliveryLatencies, 95)}ms`,
    );
    console.log('Note: Inspect CloudWatch Logs for sendMessage Lambda to view internal');
    console.log('      DynamoDB query counts and backend deliveryDurationMs.');

    const outputFlagIndex = args.indexOf('--output');
    const outputArg =
      outputFlagIndex !== -1 && args[outputFlagIndex + 1] ? args[outputFlagIndex + 1] : undefined;
    const outputPath =
      outputArg || process.env.OUTPUT_JSON || `.local/benchmarks/fanout-${runId}.json`;

    const report = {
      timestamp: new Date().toISOString(),
      runId,
      roomId,
      tableName: process.env.TABLE_NAME,
      region: REGION,
      distinctMembers: users.length,
      liveConnections: allSockets.length,
      warmupRounds: WARMUP_ROUNDS,
      measuredRounds: TEST_ROUNDS,
      delivery: {
        expectedFrames: totalFramesExpected,
        receivedFrames: totalFramesReceived,
        deliveryRatePercent:
          totalFramesExpected > 0
            ? Number(((totalFramesReceived / totalFramesExpected) * 100).toFixed(2))
            : 0,
        duplicateFrames: totalDuplicates,
        senderSelfBroadcasts: totalSelfBroadcasts,
      },
      latencyMs: {
        senderAck: {
          min: Math.round(Math.min(...ackLatencies)),
          avg: Math.round(ackLatencies.reduce((a, b) => a + b, 0) / ackLatencies.length),
          p50: calculatePercentile(ackLatencies, 50),
          p90: calculatePercentile(ackLatencies, 90),
          p95: calculatePercentile(ackLatencies, 95),
          max: Math.round(Math.max(...ackLatencies)),
        },
        allRecipientE2E: {
          min: Math.round(Math.min(...deliveryLatencies)),
          avg: Math.round(deliveryLatencies.reduce((a, b) => a + b, 0) / deliveryLatencies.length),
          p50: calculatePercentile(deliveryLatencies, 50),
          p90: calculatePercentile(deliveryLatencies, 90),
          p95: calculatePercentile(deliveryLatencies, 95),
          max: Math.round(Math.max(...deliveryLatencies)),
        },
      },
      samples: {
        ackLatenciesMs: ackLatencies.map((v) => Math.round(v * 100) / 100),
        deliveryLatenciesMs: deliveryLatencies.map((v) => Math.round(v * 100) / 100),
      },
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Saved JSON report:    ${outputPath}`);
    console.log('========================================================\n');
  } finally {
    await runTeardown();
  }
}

main().catch((err) => {
  console.error('\nBenchmark failed:', err);
  process.exit(1);
});

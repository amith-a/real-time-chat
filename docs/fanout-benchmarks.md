# Room Fan-Out Architecture & Benchmarks

Group message delivery uses a **members → connections → parallel WebSocket sends** strategy designed for bounded resource usage and resilience under AWS limits:

1. **Bounded DynamoDB Lookups (`pMap`, limit = 10):** Queries room members via `GSI1` (`ROOM#<roomId>`), then resolves active connections per member in bounded parallel batches ([sendMessage.ts](../src/handlers/websocket/sendMessage.ts)).
2. **Bounded WebSocket Delivery (`pMapSettled`, limit = 25):** Broadcasts frames via API Gateway Management API in bounded parallel batches, excluding the sender's originating connection and deduplicating connection IDs ([concurrency.ts](../src/shared/concurrency.ts)).
3. **Resilience & Stale Pruning ([management-api.ts](../src/shared/management-api.ts)):**
   - **429 Throttling:** `postToConnection()` retries `TooManyRequestsException` / `LimitExceededException` with exponential backoff and full jitter (`maxRetries = 3`, `25ms`–`300ms`).
   - **410 Gone:** Automatically removes dead connections via `removeConnection()`, atomically deleting the connection, reverse-owner record, and decrementing the user's presence counter.
4. **Structured Telemetry:** `sendMessage` emits granular timing metrics (`membershipLookupDurationMs`, `connectionResolutionDurationMs`, `messagePersistDurationMs`, `deliveryDurationMs`, `totalDurationMs`) to CloudWatch Logs.

---

## Running the Benchmarks

### Local Integration Benchmark (`test/integration/fanout.test.ts`)

Exercises `$connect`, `createGroupRoom()`, and `sendMessage` against DynamoDB Local across **50 distinct members and 75 active connections**:

```powershell
docker compose up -d dynamodb-local
$env:DYNAMODB_ENDPOINT="http://localhost:8000"
npm run test:integration test/integration/fanout.test.ts
```

### Live AWS Multi-Client Benchmark (`scripts/benchmark/fanout-benchmark.ts`)

Provisions 50 distinct Cognito test users, connects 50 real WebSocket clients through API Gateway (`$connect`), creates a 50-member room via `createGroupRoom()`, runs 5 warm-up rounds followed by 100 measured rounds verifying delivery on every recipient socket, and cleans up via `$disconnect`, DynamoDB teardown, and Cognito user deletion:

```bash
WS_URL=wss://<api-id>.execute-api.<region>.amazonaws.com/dev \
TABLE_NAME=dev-chat-table \
USER_POOL_ID=<user-pool-id> \
USER_POOL_CLIENT_ID=<client-id> \
npm run benchmark:fanout
```

Optional overrides: `MEMBER_COUNT` (min `2`), `WARMUP_ROUNDS`, `TEST_ROUNDS`, `OUTPUT_JSON` (or `--output <path>`).

If a run is interrupted, clean up leftover room items or Cognito benchmark users using:

```bash
TABLE_NAME=dev-chat-table npm run benchmark:fanout -- --cleanup <benchmark-room-id>
USER_POOL_ID=<user-pool-id> npm run benchmark:fanout -- --cleanup-users <runId>
```

---

## Observed Benchmark Results

| Metric | DynamoDB Local (`fanout.test.ts`, 20 rounds) | Live AWS (`ap-south-1`, `runId: 5c95ddca`, 100 rounds) |
| :--- | :--- | :--- |
| **Room Size** | 50 distinct members (75 connections) | 50 distinct Cognito members (50 live sockets) |
| **Delivery Rate** | 71/71 active delivered (3 stale pruned) | **4,900 / 4,900 frames (100%)** |
| **Duplicates / Self-Broadcasts** | 0 / 0 | **0 / 0** |
| **DynamoDB Queries / Msg** | 51 measured (`1` GSI1 + `50` user connections) | `1 + 50` pattern (`pMap` bounded at `10`) |
| **p50 Latency** | **139.13 ms** (handler execution) | **2,016 ms** (All-Recipient E2E) / **2,114 ms** (Sender ACK) |
| **p95 Latency** | **217.05 ms** (handler execution) | **2,914 ms** (All-Recipient E2E) / **3,186 ms** (Sender ACK) |
| **Min / Max Latency** | — | **1,352 ms** / **6,312 ms** (All-Recipient E2E) |

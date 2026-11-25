import 'dotenv/config';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  InitiateAuthCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  CONNECTION_PREFIX,
  createGroupRoom,
  getDocClient,
  getTableName,
  idempotencyKey,
  roomPartitionKey,
  userPartitionKey,
} from '../../src/repositories';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const REGION = process.env.AWS_REGION || 'ap-south-1';
const WS_URL = process.env.WS_URL; // e.g. wss://xxxx.execute-api.ap-south-1.amazonaws.com/dev
const AUTH_TOKENS_RAW = process.env.AUTH_TOKENS; // Optional comma-separated Cognito ID tokens
const USER_POOL_ID = process.env.USER_POOL_ID;
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID;
const BENCH_PASSWORD = process.env.BENCH_PASSWORD || 'Bench_Pass@2026!';

const BENCHMARK_ROOM_PREFIX = 'benchmark-room-';
const BENCHMARK_USER_PREFIX = 'bench-user-';
const BENCHMARK_USER_DOMAIN = 'example.com';
const BENCHMARK_MARKER_PREFIX = 'fanout-benchmark-';

const MEMBER_COUNT = Number(process.env.MEMBER_COUNT || 50);
const WARMUP_ROUNDS = Number(process.env.WARMUP_ROUNDS || 5);
const TEST_ROUNDS = Number(process.env.TEST_ROUNDS || 100);
const CONNECT_BATCH_SIZE = 5;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const FRAME_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 3_000;

interface AuthenticatedUser {
  userId: string;
  email: string;
  idToken: string;
}

interface JwtClaims {
  sub?: string;
  exp?: number;
  token_use?: string;
  aud?: string;
}

/**
 * Decodes JWT payload claims without verifying cryptographic signatures.
 * Signature verification is performed by the AWS Cognito Lambda authorizer.
 */
function decodeJwtClaims(token?: string): JwtClaims | undefined {
  if (!token) return undefined;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payloadJson) as JwtClaims;
  } catch {
    return undefined;
  }
}

function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, index)]);
}

async function withCognitoRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error: unknown) {
      const err = error as { name?: string };
      const retryable =
        err.name === 'TooManyRequestsException' || err.name === 'LimitExceededException';
      if (!retryable || attempt >= 5) {
        throw error;
      }
      attempt++;
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
  }
}

function benchUserEmail(runId: string, index: number): string {
  return `${BENCHMARK_USER_PREFIX}${runId}-${String(index + 1).padStart(2, '0')}@${BENCHMARK_USER_DOMAIN}`;
}

function ownershipMarkerForRun(runId: string): string {
  return `${BENCHMARK_MARKER_PREFIX}${runId}`;
}

function computeSecretHash(username: string, clientId: string, clientSecret: string): string {
  return createHmac('sha256', clientSecret).update(`${username}${clientId}`).digest('base64');
}

/**
 * Fix 1: Verify Cognito authentication configuration upfront and return
 * ClientSecret if the App Client is configured with one.
 */
async function verifyCognitoConfig(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  clientId: string,
): Promise<{ clientSecret?: string }> {
  const poolRegion = userPoolId.split('_')[0];
  if (poolRegion && poolRegion !== REGION) {
    throw new Error(
      `Cognito region mismatch: USER_POOL_ID (${userPoolId}) is in '${poolRegion}', but AWS_REGION is '${REGION}'.`,
    );
  }

  const res = await cognito.send(
    new DescribeUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
    }),
  );

  const client = res.UserPoolClient;
  if (!client) {
    throw new Error(`Cognito App Client '${clientId}' not found in User Pool '${userPoolId}'.`);
  }

  const flows = client.ExplicitAuthFlows ?? [];
  if (!flows.includes('ALLOW_USER_PASSWORD_AUTH')) {
    throw new Error(
      `Cognito App Client '${clientId}' does not have ALLOW_USER_PASSWORD_AUTH enabled (found: [${flows.join(', ')}]).`,
    );
  }

  return { clientSecret: client.ClientSecret };
}

/**
 * Fix 2: Validate that all JWTs are non-expired ID tokens with unique `sub` claims
 * and (for provisioned users) matching `aud === USER_POOL_CLIENT_ID`.
 * Note: Decoding claims is a pre-flight check only; Cognito authorizer verifies signatures.
 */
function validateDistinctUsers(
  users: AuthenticatedUser[],
  expectedCount: number,
  expectedClientId?: string,
): void {
  if (users.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} authenticated users, but resolved ${users.length}.`);
  }

  const seenSubs = new Set<string>();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const user of users) {
    const claims = decodeJwtClaims(user.idToken);
    if (!claims?.sub) {
      throw new Error(`Token for ${user.email} is missing a valid 'sub' claim.`);
    }
    if (claims.token_use !== 'id') {
      throw new Error(
        `Token for ${user.email} has token_use='${claims.token_use ?? 'missing'}'; WebSocket authorizer requires token_use='id'.`,
      );
    }
    if (typeof claims.exp !== 'number' || claims.exp <= nowSec) {
      throw new Error(`ID token for ${user.email} (${claims.sub}) is missing or expired.`);
    }
    if (expectedClientId && claims.aud !== expectedClientId) {
      throw new Error(
        `ID token for ${user.email} has aud='${claims.aud ?? 'missing'}', expected '${expectedClientId}'.`,
      );
    }
    if (seenSubs.has(claims.sub)) {
      throw new Error(
        `Duplicate user identity detected: sub='${claims.sub}' (${user.email}). All ${expectedCount} room members must be distinct users.`,
      );
    }
    seenSubs.add(claims.sub);
  }
}

/**
 * Fix 1 & Fix 5: Provision and authenticate MEMBER_COUNT distinct Cognito users
 * tagged with a unique per-run ownership marker, tracking owned usernames explicitly.
 */
async function resolveDistinctUsers(
  runId: string,
  ownedUsernames: Set<string>,
): Promise<AuthenticatedUser[]> {
  if (AUTH_TOKENS_RAW) {
    const tokens = AUTH_TOKENS_RAW.split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const users = tokens.map((idToken, idx) => {
      const claims = decodeJwtClaims(idToken);
      if (!claims?.sub) {
        throw new Error(`Invalid JWT in AUTH_TOKENS at index ${idx}`);
      }
      return { userId: claims.sub, email: `token-user-${idx + 1}`, idToken };
    });
    validateDistinctUsers(users, MEMBER_COUNT, USER_POOL_CLIENT_ID);
    return users;
  }

  if (!USER_POOL_ID || !USER_POOL_CLIENT_ID) {
    throw new Error(
      'Provide either AUTH_TOKENS (comma-separated JWTs) or both USER_POOL_ID and USER_POOL_CLIENT_ID to provision/auth 50 distinct test users.',
    );
  }

  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  console.log('\n[0/4] Verifying Cognito User Pool & App Client configuration...');
  const { clientSecret } = await verifyCognitoConfig(cognito, USER_POOL_ID, USER_POOL_CLIENT_ID);

  const marker = ownershipMarkerForRun(runId);
  const users: AuthenticatedUser[] = [];
  console.log(
    `      Provisioning & authenticating ${MEMBER_COUNT} distinct Cognito test users (runId=${runId})...`,
  );

  for (let i = 0; i < MEMBER_COUNT; i += CONNECT_BATCH_SIZE) {
    const batchIndices = Array.from(
      { length: Math.min(CONNECT_BATCH_SIZE, MEMBER_COUNT - i) },
      (_, offset) => i + offset,
    );

    const settled = await Promise.allSettled(
      batchIndices.map(async (idx) => {
        const email = benchUserEmail(runId, idx);

        try {
          await withCognitoRetry(() =>
            cognito.send(
              new AdminCreateUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: email,
                MessageAction: 'SUPPRESS',
                UserAttributes: [
                  { Name: 'email', Value: email },
                  { Name: 'email_verified', Value: 'true' },
                  { Name: 'name', Value: marker },
                ],
              }),
            ),
          );
          ownedUsernames.add(email);
        } catch (error: unknown) {
          const err = error as { name?: string };
          if (err.name !== 'UsernameExistsException') {
            throw error;
          }

          const existing = await withCognitoRetry(() =>
            cognito.send(
              new AdminGetUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: email,
              }),
            ),
          );
          const nameAttr = existing.UserAttributes?.find((a) => a.Name === 'name')?.Value;
          if (nameAttr !== marker) {
            throw new Error(
              `Ownership conflict: existing Cognito user '${email}' does not match this run's marker '${marker}'.`,
            );
          }
          ownedUsernames.add(email);
        }

        await withCognitoRetry(() =>
          cognito.send(
            new AdminSetUserPasswordCommand({
              UserPoolId: USER_POOL_ID,
              Username: email,
              Password: BENCH_PASSWORD,
              Permanent: true,
            }),
          ),
        );

        const authParameters: Record<string, string> = {
          USERNAME: email,
          PASSWORD: BENCH_PASSWORD,
        };
        if (clientSecret) {
          authParameters.SECRET_HASH = computeSecretHash(email, USER_POOL_CLIENT_ID, clientSecret);
        }

        const authRes = await withCognitoRetry(() =>
          cognito.send(
            new InitiateAuthCommand({
              AuthFlow: 'USER_PASSWORD_AUTH',
              ClientId: USER_POOL_CLIENT_ID,
              AuthParameters: authParameters,
            }),
          ),
        );

        const idToken = authRes.AuthenticationResult?.IdToken;
        const claims = decodeJwtClaims(idToken);
        if (!idToken || !claims?.sub) {
          throw new Error(`Failed to obtain IdToken/sub for ${email}`);
        }
        return { userId: claims.sub, email, idToken };
      }),
    );

    const batchResults: AuthenticatedUser[] = [];
    const failures: string[] = [];

    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j];
      const email = benchUserEmail(runId, batchIndices[j]);
      if (outcome.status === 'fulfilled') {
        batchResults.push(outcome.value);
      } else {
        const reason =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        failures.push(`${email}: ${reason}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Failed to provision/authenticate ${failures.length}/${batchIndices.length} Cognito users in batch:\n  - ${failures.join('\n  - ')}`,
      );
    }

    users.push(...batchResults);
    process.stdout.write(`  Authenticated ${users.length}/${MEMBER_COUNT} users\r`);
  }

  console.log(`\n  Authenticated ${users.length} distinct Cognito users.`);
  validateDistinctUsers(users, MEMBER_COUNT, USER_POOL_CLIENT_ID);
  return users;
}

/**
 * Fix 5: Ownership-safe deletion of Cognito benchmark users.
 * Deletes ONLY the exact usernames tracked in `ownedUsernames` (or, for `--cleanup-users <runId>`,
 * only users whose `name` attribute matches that exact runId's marker).
 */
async function cleanupCognitoBenchUsers(
  runId: string,
  ownedUsernames?: Set<string>,
): Promise<void> {
  if (!USER_POOL_ID) {
    console.error('USER_POOL_ID must be set to clean up Cognito benchmark users.');
    process.exit(1);
  }

  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const marker = ownershipMarkerForRun(runId);
  const toDelete: string[] = [];

  if (ownedUsernames && ownedUsernames.size > 0) {
    for (const username of ownedUsernames) {
      const existing = await withCognitoRetry(() =>
        cognito.send(
          new AdminGetUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: username,
          }),
        ),
      );
      const nameAttr = existing.UserAttributes?.find((a) => a.Name === 'name')?.Value;
      if (nameAttr === marker) {
        toDelete.push(username);
      }
    }
  } else {
    const emailPrefix = `${BENCHMARK_USER_PREFIX}${runId}-`;
    let paginationToken: string | undefined;
    do {
      const res = await withCognitoRetry(() =>
        cognito.send(
          new ListUsersCommand({
            UserPoolId: USER_POOL_ID,
            Filter: `email ^= "${emailPrefix}"`,
            PaginationToken: paginationToken,
          }),
        ),
      );

      for (const user of res.Users ?? []) {
        const email = user.Attributes?.find((a) => a.Name === 'email')?.Value;
        const name = user.Attributes?.find((a) => a.Name === 'name')?.Value;
        if (user.Username && email?.startsWith(emailPrefix) && name === marker) {
          toDelete.push(user.Username);
        }
      }
      paginationToken = res.PaginationToken;
    } while (paginationToken);
  }

  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += CONNECT_BATCH_SIZE) {
    const batch = toDelete.slice(i, i + CONNECT_BATCH_SIZE);
    await Promise.all(
      batch.map(async (username) => {
        try {
          await withCognitoRetry(() =>
            cognito.send(
              new AdminDeleteUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: username,
              }),
            ),
          );
          deleted++;
        } catch (error: unknown) {
          const err = error as { name?: string };
          if (err.name !== 'UserNotFoundException') {
            throw error;
          }
        }
      }),
    );
  }
  console.log(`[Cleanup] Deleted ${deleted} Cognito benchmark users for runId=${runId}.`);
}

/**
 * Failure-safe WebSocket connection handshake.
 * Cleans up listeners and closes dangling sockets on timeout, error, or premature close.
 */
async function connectSocket(url: string, label: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      } catch {
        // ignore close errors during failed handshake
      }
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error(`WebSocket handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms (${label})`));
    }, HANDSHAKE_TIMEOUT_MS);

    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onError = () => {
      fail(new Error(`WebSocket handshake error for ${label}`));
    };

    const onClose = (event: CloseEvent) => {
      fail(
        new Error(
          `WebSocket closed before open for ${label} (code=${event.code}, reason=${event.reason || 'none'})`,
        ),
      );
    };

    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
  return ws;
}

/**
 * Failure-safe batch connection handling.
 * Uses Promise.allSettled so any sockets that DID open in a partially failed batch
 * are still tracked in `allSockets` and cleaned up properly on teardown.
 */
async function connectRecipientsInBatches(
  recipientUsers: AuthenticatedUser[],
  wsUrl: string,
  allSockets: WebSocket[],
): Promise<WebSocket[]> {
  const recipientSockets: WebSocket[] = [];

  for (let i = 0; i < recipientUsers.length; i += CONNECT_BATCH_SIZE) {
    const batch = recipientUsers.slice(i, i + CONNECT_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((u) => connectSocket(`${wsUrl}?token=${u.idToken}`, u.email)),
    );

    const errors: string[] = [];
    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j];
      if (outcome.status === 'fulfilled') {
        recipientSockets.push(outcome.value);
        allSockets.push(outcome.value);
      } else {
        const reason =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        errors.push(`${batch[j].email}: ${reason}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Failed to connect ${errors.length}/${batch.length} recipient sockets in batch:\n  - ${errors.join('\n  - ')}`,
      );
    }

    process.stdout.write(`  Connected ${allSockets.length}/${recipientUsers.length + 1} sockets\r`);
  }

  return recipientSockets;
}

/**
 * Gracefully closes all WebSocket connections and waits (bounded by CLOSE_TIMEOUT_MS)
 * for their close events so API Gateway invokes $disconnect before verification.
 */
async function closeSocketsSafely(sockets: WebSocket[]): Promise<void> {
  if (sockets.length === 0) return;

  await Promise.allSettled(
    sockets.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }

          const timer = setTimeout(() => {
            ws.removeEventListener('close', onClose);
            resolve();
          }, CLOSE_TIMEOUT_MS);

          const onClose = () => {
            clearTimeout(timer);
            ws.removeEventListener('close', onClose);
            resolve();
          };

          ws.addEventListener('close', onClose);
          try {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close(1000, 'benchmark complete');
            }
          } catch {
            clearTimeout(timer);
            ws.removeEventListener('close', onClose);
            resolve();
          }
        }),
    ),
  );
}

/**
 * Fix 3: Strongly consistent base-table verification that $disconnect removed all
 * DynamoDB connection records for benchmark users. Throws if connections remain after 6 attempts.
 */
async function verifyDisconnectCleanup(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;

  const ddb = getDocClient();
  const tableName = getTableName();
  const maxAttempts = 6;
  const pollDelayMs = 500;
  let remainingUsers = [...userIds];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stillConnected: string[] = [];

    for (let i = 0; i < remainingUsers.length; i += 10) {
      const chunk = remainingUsers.slice(i, i + 10);
      const counts = await Promise.all(
        chunk.map(async (uid) => {
          const res = await ddb.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
              ExpressionAttributeValues: {
                ':pk': userPartitionKey(uid),
                ':prefix': CONNECTION_PREFIX,
              },
              ConsistentRead: true,
              Select: 'COUNT',
            }),
          );
          return { uid, count: res.Count ?? 0 };
        }),
      );
      for (const c of counts) {
        if (c.count > 0) {
          stillConnected.push(c.uid);
        }
      }
    }

    remainingUsers = stillConnected;
    if (remainingUsers.length === 0) {
      console.log(
        `[Cleanup] Verified $disconnect removed connection records for all ${userIds.length} users (strongly consistent).`,
      );
      return;
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, pollDelayMs));
    }
  }

  throw new Error(
    `Disconnect verification failed: ${remainingUsers.length}/${userIds.length} benchmark users still have active connection records after ${maxAttempts} attempts.`,
  );
}

/**
 * Retries DynamoDB BatchWriteCommand until all UnprocessedItems are cleared.
 * Throws if items remain unprocessed after max retries.
 */
async function batchDeleteWithRetry(keys: Array<{ PK: string; SK: string }>): Promise<number> {
  if (keys.length === 0) return 0;
  const ddb = getDocClient();
  const tableName = getTableName();
  let deleted = 0;

  for (let i = 0; i < keys.length; i += 25) {
    let requests = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    let attempt = 0;

    while (requests.length > 0 && attempt < 6) {
      const res = await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [tableName]: requests },
        }),
      );
      const unprocessed = res.UnprocessedItems?.[tableName] ?? [];
      deleted += requests.length - unprocessed.length;
      requests = unprocessed as typeof requests;
      if (requests.length > 0) {
        attempt++;
        await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }

    if (requests.length > 0) {
      throw new Error(
        `DynamoDB BatchWriteCommand left ${requests.length} UnprocessedItems after retries.`,
      );
    }
  }

  return deleted;
}

async function queryKeysByPk(pk: string): Promise<Array<{ PK: string; SK: string }>> {
  const ddb = getDocClient();
  const tableName = getTableName();
  const keys: Array<{ PK: string; SK: string }> = [];

  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: startKey,
      }),
    );
    if (res.Items) {
      for (const item of res.Items) {
        keys.push({ PK: item.PK as string, SK: item.SK as string });
      }
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);

  return keys;
}

/**
 * Ownership-safe, reliable cleanup of benchmark room data.
 * Refuses to operate on any roomId that does not carry the benchmark-room- prefix.
 */
async function cleanupBenchmarkRoom(roomId: string, userIds: string[]): Promise<void> {
  if (!roomId.startsWith(BENCHMARK_ROOM_PREFIX)) {
    throw new Error(
      `Refusing cleanup: roomId '${roomId}' does not start with '${BENCHMARK_ROOM_PREFIX}'.`,
    );
  }

  const ddb = getDocClient();
  const tableName = getTableName();
  const roomPk = roomPartitionKey(roomId);
  const keysToDelete: Array<{ PK: string; SK: string }> = await queryKeysByPk(roomPk);

  let resolvedUserIds = userIds;
  if (resolvedUserIds.length === 0) {
    const memberKeys: string[] = [];
    let gsiStartKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
          ExpressionAttributeValues: { ':pk': roomPk, ':sk': 'MEMBER#' },
          ProjectionExpression: 'PK, SK, userId',
          ExclusiveStartKey: gsiStartKey,
        }),
      );
      if (res.Items) {
        for (const item of res.Items) {
          keysToDelete.push({ PK: item.PK as string, SK: item.SK as string });
          if (typeof item.userId === 'string') {
            memberKeys.push(item.userId);
          }
        }
      }
      gsiStartKey = res.LastEvaluatedKey;
    } while (gsiStartKey);
    resolvedUserIds = memberKeys;
  } else {
    for (const userId of resolvedUserIds) {
      keysToDelete.push({ PK: userPartitionKey(userId), SK: roomPk });
    }
  }

  // Clean up idempotency records created by the sender for this benchmark room
  if (resolvedUserIds.length > 0) {
    const idempPk = idempotencyKey(resolvedUserIds[0], roomId, 'probe').PK;
    const idempKeys = await queryKeysByPk(idempPk);
    keysToDelete.push(...idempKeys);
  }

  const deletedCount = await batchDeleteWithRetry(keysToDelete);
  console.log(`[Cleanup] Removed ${deletedCount} benchmark items for ${roomPk}.`);
}

/**
 * Sends one message and awaits both:
 * 1. The sender's ACK frame.
 * 2. The broadcast 'message' frame on every open recipient WebSocket.
 *
 * Detects duplicate frames, unexpected self-broadcasts, and synchronous send errors (Fix 4).
 */
async function sendAndVerifyFanout(
  senderWs: WebSocket,
  recipientSockets: WebSocket[],
  roomId: string,
  messageId: string,
  body: string,
): Promise<{
  ackLatencyMs: number;
  fanoutDeliveryLatencyMs: number;
  receivedCount: number;
  duplicateFrames: number;
  senderSelfBroadcasts: number;
}> {
  if (senderWs.readyState !== WebSocket.OPEN) {
    throw new Error(`Sender WebSocket is not open (state=${senderWs.readyState})`);
  }
  for (let i = 0; i < recipientSockets.length; i++) {
    if (recipientSockets[i].readyState !== WebSocket.OPEN) {
      throw new Error(
        `Recipient WebSocket #${i + 1} is not open (state=${recipientSockets[i].readyState})`,
      );
    }
  }

  const payload = JSON.stringify({
    action: 'sendMessage',
    roomId,
    messageId,
    body,
  });

  const start = performance.now();
  let ackLatencyMs = 0;
  let lastDeliveryMs = 0;
  let receivedCount = 0;
  let duplicateFrames = 0;
  let senderSelfBroadcasts = 0;

  await new Promise<void>((resolve, reject) => {
    let ackCount = 0;
    let settled = false;
    const cleanups: Array<() => void> = [];

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const fn of cleanups) fn();
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const finishIfDone = () => {
      if (ackCount >= 1 && receivedCount === recipientSockets.length) {
        setTimeout(() => {
          if (duplicateFrames > 0) {
            finish(
              new Error(`Detected ${duplicateFrames} duplicate delivery frame(s) for ${messageId}`),
            );
          } else if (senderSelfBroadcasts > 0) {
            finish(
              new Error(`Sender socket unexpectedly received its own broadcast for ${messageId}`),
            );
          } else {
            finish();
          }
        }, 25);
      }
    };

    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Timeout for ${messageId}: acks=${ackCount}, recipients=${receivedCount}/${recipientSockets.length}, duplicates=${duplicateFrames}`,
        ),
      );
    }, FRAME_TIMEOUT_MS);

    const attachDropGuard = (ws: WebSocket, label: string) => {
      const onDrop = () => {
        finish(new Error(`${label} dropped connection during ${messageId}`));
      };
      ws.addEventListener('close', onDrop);
      ws.addEventListener('error', onDrop);
      cleanups.push(() => {
        ws.removeEventListener('close', onDrop);
        ws.removeEventListener('error', onDrop);
      });
    };

    attachDropGuard(senderWs, 'Sender socket');

    // 1. Register sender ACK & self-broadcast detector BEFORE sending
    const onSenderMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(
          typeof event.data === 'string' ? event.data : event.data.toString(),
        );
        if (data.action === 'ack' && data.messageId === messageId) {
          ackCount++;
          if (ackCount === 1) {
            ackLatencyMs = performance.now() - start;
            finishIfDone();
          } else {
            duplicateFrames++;
          }
        } else if (data.action === 'message' && data.messageId === messageId) {
          senderSelfBroadcasts++;
        }
      } catch {
        // ignore non-json frames
      }
    };
    senderWs.addEventListener('message', onSenderMessage);
    cleanups.push(() => senderWs.removeEventListener('message', onSenderMessage));

    // 2. Register recipient delivery & duplicate frame listeners BEFORE sending
    recipientSockets.forEach((rWs, idx) => {
      attachDropGuard(rWs, `Recipient socket #${idx + 1}`);
      let socketDeliveryCount = 0;
      const onRecipientMessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(
            typeof event.data === 'string' ? event.data : event.data.toString(),
          );
          if (data.action === 'message' && data.messageId === messageId) {
            socketDeliveryCount++;
            if (socketDeliveryCount === 1) {
              receivedCount++;
              lastDeliveryMs = Math.max(lastDeliveryMs, performance.now() - start);
              finishIfDone();
            } else {
              duplicateFrames++;
            }
          }
        } catch {
          // ignore non-json frames
        }
      };
      rWs.addEventListener('message', onRecipientMessage);
      cleanups.push(() => rWs.removeEventListener('message', onRecipientMessage));
    });

    // 3. Fix 4: Guard synchronous WebSocket send errors so listeners/timers are always cleaned up
    try {
      senderWs.send(payload);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    ackLatencyMs,
    fanoutDeliveryLatencyMs: lastDeliveryMs,
    receivedCount,
    duplicateFrames,
    senderSelfBroadcasts,
  };
}

// ---------------------------------------------------------------------------
// Main Runner
// ---------------------------------------------------------------------------
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

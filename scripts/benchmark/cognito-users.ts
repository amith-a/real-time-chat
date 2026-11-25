import { createHmac } from 'node:crypto';
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
import {
  AUTH_TOKENS_RAW,
  type AuthenticatedUser,
  BENCH_PASSWORD,
  BENCHMARK_MARKER_PREFIX,
  BENCHMARK_USER_DOMAIN,
  BENCHMARK_USER_PREFIX,
  CONNECT_BATCH_SIZE,
  type JwtClaims,
  MEMBER_COUNT,
  REGION,
  USER_POOL_CLIENT_ID,
  USER_POOL_ID,
} from './config';

/**
 * Decodes JWT payload claims without verifying cryptographic signatures.
 * Signature verification is performed by the AWS Cognito Lambda authorizer.
 */
export function decodeJwtClaims(token?: string): JwtClaims | undefined {
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
 * Verify Cognito authentication configuration upfront and return
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
 * Validate that all JWTs are non-expired ID tokens with unique `sub` claims
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
 * Provision and authenticate MEMBER_COUNT distinct Cognito users
 * tagged with a unique per-run ownership marker, tracking owned usernames explicitly.
 */
export async function resolveDistinctUsers(
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

  const userPoolId = USER_POOL_ID;
  const clientId = USER_POOL_CLIENT_ID;
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  console.log('\n[0/4] Verifying Cognito User Pool & App Client configuration...');
  const { clientSecret } = await verifyCognitoConfig(cognito, userPoolId, clientId);

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
                UserPoolId: userPoolId,
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
                UserPoolId: userPoolId,
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
              UserPoolId: userPoolId,
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
          authParameters.SECRET_HASH = computeSecretHash(email, clientId, clientSecret);
        }

        const authRes = await withCognitoRetry(() =>
          cognito.send(
            new InitiateAuthCommand({
              AuthFlow: 'USER_PASSWORD_AUTH',
              ClientId: clientId,
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
 * Ownership-safe deletion of Cognito benchmark users.
 * Deletes ONLY the exact usernames tracked in `ownedUsernames` (or, for `--cleanup-users <runId>`,
 * only users whose `name` attribute matches that exact runId's marker).
 */
export async function cleanupCognitoBenchUsers(
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

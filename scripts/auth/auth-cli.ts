import {
  AdminConfirmSignUpCommand,
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * CLI helper for Cognito authentication in development.
 *
 * ID Token vs Access Token:
 * - ID Token: Contains user profile and identity claims (sub, email, cognito:username).
 *   Used by our WebSocket Lambda authorizer to authenticate the user and establish their identity.
 * - Access Token: Contains authorization scopes and user groups.
 *   Used for authorizing calls to downstream APIs or AWS resources (not for identity proof).
 */

const region = process.env.AWS_REGION || 'ap-south-1';
const client = new CognitoIdentityProviderClient({ region });

async function signUp(clientId: string, email: string, password: string): Promise<void> {
  console.log(`[Cognito] Signing up user: ${email}...`);
  const command = new SignUpCommand({
    ClientId: clientId,
    Username: email,
    Password: password,
    UserAttributes: [{ Name: 'email', Value: email }],
  });

  const response = await client.send(command);
  console.log(`[Cognito] User created successfully. Confirmed: ${response.UserConfirmed}`);
  if (!response.UserConfirmed) {
    console.log(
      '[Cognito] Please check your email for the verification code or use admin-confirm.',
    );
  }
}

async function confirmSignUp(clientId: string, email: string, code: string): Promise<void> {
  console.log(`[Cognito] Confirming user: ${email}...`);
  const command = new ConfirmSignUpCommand({
    ClientId: clientId,
    Username: email,
    ConfirmationCode: code,
  });

  await client.send(command);
  console.log('[Cognito] User confirmed successfully. You can now log in.');
}

async function adminConfirm(userPoolId: string, email: string): Promise<void> {
  console.log(`[Cognito] Admin confirming user: ${email}...`);
  const command = new AdminConfirmSignUpCommand({
    UserPoolId: userPoolId,
    Username: email,
  });

  await client.send(command);
  console.log('[Cognito] User confirmed via admin command.');
}

async function login(clientId: string, email: string, password: string): Promise<void> {
  console.log(`[Cognito] Authenticating user: ${email}...`);
  const command = new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
    },
  });

  const response = await client.send(command);
  const authResult = response.AuthenticationResult;

  if (!authResult) {
    console.error('[Cognito] Authentication failed: No result returned.');
    return;
  }

  console.log('\n=== Authentication Successful ===');
  console.log('ID Token (Use this for WebSocket $connect):');
  console.log('\nresult:',authResult);
  console.log(authResult.IdToken);
  console.log('\nExpires In (seconds):', authResult.ExpiresIn);
  console.log('Token Type:', authResult.TokenType);
  console.log('\nWebSocket Handshake URL Example:');
  console.log(
    `wss://<api-id>.execute-api.${region}.amazonaws.com/dev?token=${authResult.IdToken?.slice(0, 20)}...[REDACTED]`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const clientId = process.env.USER_POOL_CLIENT_ID || args[1];
  const userPoolId = process.env.USER_POOL_ID || args[2];

  if (!command) {
    console.log(`
Usage:
  npx tsx scripts/auth/auth-cli.ts <command> [options]

Commands:
  signup <clientId> <email> <password>
  confirm <clientId> <email> <code>
  admin-confirm <userPoolId> <email>
  login <clientId> <email> <password>

Or set environment variables:
  USER_POOL_CLIENT_ID=...
  USER_POOL_ID=...
    `);
    process.exit(1);
  }

  switch (command) {
    case 'signup': {
      const email = args[2] || process.env.AUTH_EMAIL;
      const password = args[3] || process.env.AUTH_PASSWORD;
      if (!clientId || !email || !password) {
        console.error('Usage: signup <clientId> <email> <password>');
        process.exit(1);
      }
      await signUp(clientId, email, password);
      break;
    }
    case 'confirm': {
      const email = args[2];
      const code = args[3];
      if (!clientId || !email || !code) {
        console.error('Usage: confirm <clientId> <email> <code>');
        process.exit(1);
      }
      await confirmSignUp(clientId, email, code);
      break;
    }
    case 'admin-confirm': {
      const poolId = args[1] || userPoolId;
      const email = args[2];
      if (!poolId || !email) {
        console.error('Usage: admin-confirm <userPoolId> <email>');
        process.exit(1);
      }
      await adminConfirm(poolId, email);
      break;
    }
    case 'login': {
      const email = args[2] || process.env.AUTH_EMAIL;
      const password = args[3] || process.env.AUTH_PASSWORD;
      if (!clientId || !email || !password) {
        console.error('Usage: login <clientId> <email> <password>');
        process.exit(1);
      }
      await login(clientId, email, password);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error('Error:', err.message);
  process.exit(1);
});

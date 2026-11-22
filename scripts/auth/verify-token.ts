import { CognitoJwtVerifier } from 'aws-jwt-verify';
import 'dotenv/config';

const userPoolId = process.env.USER_POOL_ID || '';
const clientId = process.env.USER_POOL_CLIENT_ID || '';

const verifier = CognitoJwtVerifier.create({
  userPoolId,
  clientId,
  tokenUse: 'id',
});

async function main() {
  const token = process.env.COGNITO_ID_TOKEN;

  if (!token) {
    throw new Error('Missing COGNITO_ID_TOKEN environment variable');
  }

  try {
    const payload = await verifier.verify(token);

    console.log('Token verification successful');
    console.log('User ID:', payload.sub);
    console.log('Email:', payload.email);
    console.log('Token use:', payload.token_use);
  } catch {
    console.error('Token verification failed');
    process.exitCode = 1;
  }
}

main();

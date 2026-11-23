# Deployment & Auth Helper Commands

This document contains commands for bootstrapping the deployment bucket, deploying the chat application stack, managing Cognito user authentication, and testing deployed endpoints.

---

## 1. Bootstrap Artifact Bucket

Deploy the dedicated S3 bucket used for storing Lambda deployment artifacts:

```bash
aws cloudformation deploy \
  --template-file infra/artifacts.yaml \
  --stack-name realtime-chat-artifacts \
  --region ap-south-1
```

Retrieve the created S3 bucket name:

```bash
aws cloudformation describe-stacks \
  --stack-name realtime-chat-artifacts \
  --region ap-south-1 \
  --query "Stacks[0].Outputs[?OutputKey=='DeploymentBucketName'].OutputValue" \
  --output text
```

---

## 2. Automated Full Deployment

The deployment script builds the Lambda functions, packages each handler with content-based SHA-256 hashes, uploads the ZIP archives to S3, and deploys the CloudFormation stack:

```bash
# Deploy to 'dev' environment
./scripts/deploy/deploy.sh dev

# Deploy to 'prod' environment
./scripts/deploy/deploy.sh prod
```

*(Note: On Windows without bash, you can run this via Git Bash or WSL).*

---

## 3. Retrieve Application Stack Outputs

Query all output values (Cognito User Pool ID, App Client ID, WebSocket endpoint, DynamoDB table):

```bash
aws cloudformation describe-stacks \
  --stack-name realtime-chat-dev \
  --region ap-south-1 \
  --query "Stacks[0].Outputs" \
  --output table
```

### Export Stack Outputs to Shell Variables

#### Bash / Git Bash / macOS:
```bash
export USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name realtime-chat-dev --region ap-south-1 --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
export USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name realtime-chat-dev --region ap-south-1 --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text)
export WS_ENDPOINT=$(aws cloudformation describe-stacks --stack-name realtime-chat-dev --region ap-south-1 --query "Stacks[0].Outputs[?OutputKey=='WebSocketEndpoint'].OutputValue" --output text)
```

#### PowerShell:
```powershell
$env:USER_POOL_ID = aws cloudformation describe-stacks --stack-name realtime-chat-dev --region ap-south-1 --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text
$env:USER_POOL_CLIENT_ID = aws cloudformation describe-stacks --stack-name realtime-chat-dev --region ap-south-1 --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text
$env:WS_ENDPOINT = aws cloudformation describe-stacks --stack-name realtime-chat-dev --region ap-south-1 --query "Stacks[0].Outputs[?OutputKey=='WebSocketEndpoint'].OutputValue" --output text
```

---

## 4. Authentication CLI Helpers (`scripts/auth/auth-cli.ts`)

The project provides a TypeScript CLI script to test Cognito sign-up, confirmation, and login flows.

### Sign Up a New User
```bash
npx tsx scripts/auth/auth-cli.ts signup <clientId> <email> <password>

# Example:
npx tsx scripts/auth/auth-cli.ts signup $USER_POOL_CLIENT_ID user@example.com MyStrongP@ssw0rd!
```

### Admin Confirm User (Bypass Email Verification Code)
In development, use admin-confirm to verify the user without requiring an email verification code:

```bash
npx tsx scripts/auth/auth-cli.ts admin-confirm <userPoolId> <email>

# Example:
npx tsx scripts/auth/auth-cli.ts admin-confirm $USER_POOL_ID user@example.com
```

### Confirm Sign-Up with Verification Code (Standard Flow)
```bash
npx tsx scripts/auth/auth-cli.ts confirm <clientId> <email> <code>

# Example:
npx tsx scripts/auth/auth-cli.ts confirm $USER_POOL_CLIENT_ID user@example.com 123456
```

### Login & Generate ID Token
Authenticates using `USER_PASSWORD_AUTH` flow and outputs the **Cognito ID Token** needed for WebSocket `$connect`:

```bash
npx tsx scripts/auth/auth-cli.ts login <clientId> <email> <password>

# Example:
npx tsx scripts/auth/auth-cli.ts login $USER_POOL_CLIENT_ID user@example.com MyStrongP@ssw0rd!
```

*The command prints the full ID Token and an example WebSocket handshake URL with the token attached.*

---

## 5. Token Verification Script (`scripts/auth/verify-token.ts`)

Verifies a Cognito ID Token locally against the Cognito JWKS public key:

```bash
# Bash:
COGNITO_ID_TOKEN="<id_token>" USER_POOL_ID=$USER_POOL_ID USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID npx tsx scripts/auth/verify-token.ts

# PowerShell:
$env:COGNITO_ID_TOKEN = "<id_token>"
npx tsx scripts/auth/verify-token.ts
```

Output confirms the token validity, Cognito User ID (`sub`), email, and token expiration.

---

## 6. Testing Lambda Authorizer & WebSocket Handshake

### Invoke the Lambda Authorizer Directly via AWS CLI
You can test the authorizer function with a test payload:

```bash
aws lambda invoke \
  --function-name realtime-chat-dev-authorizer \
  --payload fileb://event/authorizer-event.json \
  --cli-binary-format raw-in-base64-out \
  --region ap-south-1 \
  response.json

cat response.json
```

### Connect to WebSocket API via `wscat`
Connect using the Cognito ID Token retrieved from the login command:

```bash
# Install wscat if not already available
npm install -g wscat

# Connect with token query parameter:
wscat -c "$WS_ENDPOINT?token=<COGNITO_ID_TOKEN>"

# Or connect with Authorization header:
wscat -c "$WS_ENDPOINT" -H "Authorization: Bearer <COGNITO_ID_TOKEN>"
```

---

## 7. Teardown & Resource Cleanup

To delete the deployed stacks and clean up AWS resources:

```bash
# 1. Delete Application Stack
aws cloudformation delete-stack \
  --stack-name realtime-chat-dev \
  --region ap-south-1

# Wait for deletion to complete:
aws cloudformation wait stack-delete-complete \
  --stack-name realtime-chat-dev \
  --region ap-south-1

# 2. Empty and Delete Artifacts S3 Bucket Stack (empty bucket first)
BUCKET_NAME=$(aws cloudformation describe-stacks --stack-name realtime-chat-artifacts --region ap-south-1 --query "Stacks[0].Outputs[?OutputKey=='DeploymentBucketName'].OutputValue" --output text)
aws s3 rm s3://$BUCKET_NAME --recursive

aws cloudformation delete-stack \
  --stack-name realtime-chat-artifacts \
  --region ap-south-1
```

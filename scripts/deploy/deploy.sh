#!/usr/bin/env bash
set -euo pipefail

# Usage: ./deploy.sh dev|prod

ENV=${1:?Usage: ./deploy.sh dev|prod}

if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "Environment must be dev or prod"
  exit 1
fi

REGION=${AWS_REGION:-ap-south-1}

# CloudFormation stack names
ARTIFACT_STACK="realtime-chat-artifacts"
APP_STACK="realtime-chat-${ENV}"

# Template paths
ARTIFACT_TEMPLATE="infra/artifacts.yaml"
APP_TEMPLATE="infra/template.yaml"

# 1. Deploy the shared artifact bucket stack
echo "Deploying artifact bucket stack..."

aws cloudformation deploy \
  --template-file "$ARTIFACT_TEMPLATE" \
  --stack-name "$ARTIFACT_STACK" \
  --region "$REGION" \
  --no-fail-on-empty-changeset

# 2. Retrieve the bucket name from CloudFormation output
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$ARTIFACT_STACK" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DeploymentBucketName'].OutputValue | [0]" \
  --output text)

if [[ -z "$BUCKET" || "$BUCKET" == "None" ]]; then
  echo "Could not retrieve deployment artifact bucket name"
  exit 1
fi

echo "Artifact bucket: $BUCKET"

# 3. Type-check the application
echo "Running type-check..."
npm run typecheck

# 4. Build the Lambda bundle using esbuild
echo "Building Lambda..."
npm run build

# 5. Package the Lambda bundle (checking OS for Windows zip compatibility)
if [[ ! -f "dist/authorizer.js" ]]; then
  echo "Build output dist/authorizer.js not found"
  exit 1
fi

echo "Packaging Lambda bundle into dist/authorizer.zip..."

# Detect if running on Windows (Git Bash, MSYS, Cygwin, or native Windows)
IS_WINDOWS=false
case "$(uname -s 2>/dev/null || echo unknown)" in
  CYGWIN*|MINGW*|MSYS*|Windows_NT*)
    IS_WINDOWS=true
    ;;
esac
if [[ "${OS:-}" == "Windows_NT" ]]; then
  IS_WINDOWS=true
fi

# Create Lambda ZIP package
(
  cd dist
  rm -f authorizer.zip

  if command -v zip >/dev/null 2>&1; then
    zip -j -X authorizer.zip authorizer.js

  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command \
      'Compress-Archive -Path authorizer.js -DestinationPath authorizer.zip -Force'

  else
    echo "Error: Install zip or ensure powershell.exe is available."
    exit 1
  fi
)

# 6. Generate a content-based artifact key
if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(sha256sum dist/authorizer.zip | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  HASH=$(shasum -a 256 dist/authorizer.zip | awk '{print $1}')
elif command -v powershell.exe >/dev/null 2>&1; then
  HASH=$(powershell.exe -NoProfile -Command "(Get-FileHash -Algorithm SHA256 dist/authorizer.zip).Hash.ToLower()" | tr -d '\r')
else
  echo "Error: No tool found to calculate sha256 hash"
  exit 1
fi

ARTIFACT_KEY="authorizer/${HASH}.zip"
echo "Artifact key: $ARTIFACT_KEY"

# 7. Upload the Lambda ZIP to S3
echo "Uploading Lambda artifact..."

aws s3 cp \
  dist/authorizer.zip \
  "s3://${BUCKET}/${ARTIFACT_KEY}" \
  --region "$REGION" \
  --sse AES256

# 8. Deploy the application stack
echo "Deploying application stack..."

aws cloudformation deploy \
  --template-file "$APP_TEMPLATE" \
  --stack-name "$APP_STACK" \
  --parameter-overrides \
    Environment="$ENV" \
    ArtifactBucketName="$BUCKET" \
    AuthorizerArtifactKey="$ARTIFACT_KEY" \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "$REGION" \
  --no-fail-on-empty-changeset

echo "Deployment completed successfully."

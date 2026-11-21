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

# 4. Build all Lambda bundles using esbuild
echo "Building Lambda functions..."
npm run build

# 5. Package and upload a Lambda bundle, returning its S3 artifact key.
# Logs go to stderr so command substitution captures only the artifact key.
package_and_upload() {
  local HANDLER="$1"
  local SOURCE_PATH="$2"
  local JS_FILE="dist/${SOURCE_PATH}.js"
  local ZIP_FILE="dist/${HANDLER}.zip"
  local HASH
  local ARTIFACT_KEY

  if [[ ! -f "$JS_FILE" ]]; then
    echo "Build output $JS_FILE not found" >&2
    return 1
  fi

  echo "Packaging ${HANDLER} Lambda from ${JS_FILE}..." >&2

  (
    cd dist
    rm -f "${HANDLER}.zip"

    if command -v zip >/dev/null 2>&1; then
      # Place the handler JavaScript at the ZIP root to match
      # the CloudFormation Handler value (for example authorizer.handler).
      zip -j -X "${HANDLER}.zip" "${SOURCE_PATH}.js" >/dev/null
    elif command -v powershell.exe >/dev/null 2>&1; then
      powershell.exe -NoProfile -Command \
        "Compress-Archive -Path '${SOURCE_PATH}.js' -DestinationPath '${HANDLER}.zip' -Force"
    else
      echo "Error: Install zip or ensure powershell.exe is available." >&2
      exit 1
    fi
  )

  if command -v sha256sum >/dev/null 2>&1; then
    HASH=$(sha256sum "$ZIP_FILE" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    HASH=$(shasum -a 256 "$ZIP_FILE" | awk '{print $1}')
  elif command -v powershell.exe >/dev/null 2>&1; then
    HASH=$(powershell.exe -NoProfile -Command \
      "(Get-FileHash -Algorithm SHA256 '$ZIP_FILE').Hash.ToLower()" | tr -d '\r')
  else
    echo "Error: No tool found to calculate SHA-256 hash." >&2
    return 1
  fi

  ARTIFACT_KEY="${HANDLER}/${HASH}.zip"
  echo "Uploading ${HANDLER} artifact: ${ARTIFACT_KEY}" >&2

  aws s3 cp \
    "$ZIP_FILE" \
    "s3://${BUCKET}/${ARTIFACT_KEY}" \
    --region "$REGION" \
    --sse AES256 >/dev/null

  printf '%s\n' "$ARTIFACT_KEY"
}

# Capture each function's content-based S3 key.
AUTHORIZER_ARTIFACT_KEY=$(package_and_upload authorizer authorizer)
CONNECT_ARTIFACT_KEY=$(package_and_upload connect connect)
DISCONNECT_ARTIFACT_KEY=$(package_and_upload disconnect disconnect)
DEFAULT_ARTIFACT_KEY=$(package_and_upload default default)

# 6. Deploy the application stack
echo "Deploying application stack..."

aws cloudformation deploy \
  --template-file "$APP_TEMPLATE" \
  --stack-name "$APP_STACK" \
  --parameter-overrides \
    Environment="$ENV" \
    ArtifactBucketName="$BUCKET" \
    AuthorizerArtifactKey="$AUTHORIZER_ARTIFACT_KEY" \
    ConnectArtifactKey="$CONNECT_ARTIFACT_KEY" \
    DisconnectArtifactKey="$DISCONNECT_ARTIFACT_KEY" \
    DefaultArtifactKey="$DEFAULT_ARTIFACT_KEY" \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "$REGION" \
  --no-fail-on-empty-changeset

echo "Deployment completed successfully."

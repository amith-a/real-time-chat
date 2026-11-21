```
aws cloudformation deploy \
  --template-file infra/artifacts.yaml \
  --stack-name realtime-chat-artifacts \
  --region ap-south-1

```

```
aws cloudformation describe-stacks \
  --stack-name realtime-chat-artifacts \
  --region ap-south-1 \
  --query "Stacks[0].Outputs"
```

```
aws lambda invoke \
  --function-name dev-chat-authorizer   \
  --payload fileb://event/authorizer-event.json \
  --cli-binary-format raw-in-base64-out \
  --region ap-south-1 \
  response.json
```
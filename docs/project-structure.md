# Project Structure

```text
.
├── client/
│   └── room-sync.ts                    # Client-side ordering, gap detection & persistence
├── docs/                               # Architecture, data model & benchmark docs
│   ├── access-pattern.md               # Single-table access patterns
│   ├── dynamodb-implementation-guidelines.md
│   ├── dynamodb-keys.md                # Single-table primary & GSI1 key reference
│   ├── fanout-benchmarks.md            # Fan-out architecture & latency benchmarks
│   ├── project-structure.md            # Repository directory layout
│   └── websocket-auth.md               # Cognito WebSocket authorizer flow
├── infra/
│   ├── bootstrap/
│   │   └── artifacts.yaml              # Shared S3 deployment artifact bucket
│   ├── nested/                         # Nested CloudFormation stacks (HTTP, WebSocket)
│   ├── core.yaml                       # Stateful Cognito User Pool & DynamoDB table
│   └── template.yaml                   # Root CloudFormation application stack
├── scripts/
│   ├── auth/
│   │   ├── auth-cli.ts                 # Cognito signup/login CLI helper
│   │   └── verify-token.ts             # JWT verification helper
│   ├── benchmark/
│   │   ├── cognito-users.ts            # Ephemeral Cognito user provisioning & cleanup
│   │   ├── config.ts                   # Benchmark env config & shared types
│   │   ├── dynamodb-cleanup.ts         # Disconnect verification & room teardown
│   │   ├── fanout-benchmark.ts         # Live 50-member AWS WebSocket benchmark runner
│   │   └── ws-client.ts                # Failure-safe WebSocket client & frame verifier
│   └── deploy/
│       └── deploy.sh                   # Build, package & CloudFormation deploy script
├── src/
│   ├── handlers/
│   │   ├── auth/
│   │   │   └── authorizer.ts           # Cognito JWT WebSocket authorizer
│   │   ├── http/
│   │   │   ├── messages.ts             # GET /rooms/{roomId}/messages
│   │   │   ├── rooms.ts                # Group room & membership HTTP endpoints
│   │   │   └── users.ts                # User profile HTTP endpoints
│   │   └── websocket/
│   │       ├── connect.ts              # $connect handler
│   │       ├── default.ts              # $default fallback handler
│   │       ├── disconnect.ts           # $disconnect handler
│   │       └── sendMessage.ts          # sendMessage route & bounded fan-out
│   ├── repositories/                   # DynamoDB single-table data access layer
│   │   ├── client.ts                   # DocumentClient singleton & query helpers
│   │   ├── connections.ts              # Connection & presence transactions
│   │   ├── dynamo-errors.ts            # Error classification & retry helpers
│   │   ├── index.ts
│   │   ├── keys.ts                     # Primary & GSI1 key builders
│   │   ├── messages.ts                 # Message creation, sequencing & idempotency
│   │   ├── presence.ts                 # Presence status retrieval
│   │   ├── rooms.ts                    # Direct & group room creation and membership
│   │   ├── types.ts                    # Repository data contracts
│   │   └── users.ts                    # User profile persistence
│   └── shared/                         # Shared auth, concurrency, errors, logger, WS utils
│       ├── auth.ts
│       ├── concurrency.ts              # pMap, pMapSettled, withRetry, 429 detection
│       ├── error-handler.ts
│       ├── errors.ts
│       ├── index.ts
│       ├── logger.ts
│       ├── management-api.ts           # API Gateway Management API + 429/410 handling
│       ├── schemas.ts
│       └── websocket.ts
├── test/                               # Unit & integration tests (Vitest)
│   ├── handlers/                       # Handler unit tests mirroring src/handlers
│   ├── integration/                    # DynamoDB Local integration tests
│   │   ├── connections.test.ts
│   │   ├── fanout.test.ts              # 50-member / 75-connection fan-out benchmark
│   │   ├── helpers.ts
│   │   ├── messages.test.ts
│   │   ├── rooms.test.ts
│   │   └── users.test.ts
│   ├── concurrency.test.ts
│   ├── error-handler.test.ts
│   ├── keys.test.ts
│   ├── logger.test.ts
│   ├── management-api.test.ts
│   ├── repositories.test.ts
│   └── shared.test.ts
├── .env.example                        # Sample environment variables
├── docker-compose.yml                  # DynamoDB Local container setup
├── esbuild.config.mjs                  # Lambda bundling configuration
├── package.json
└── tsconfig.json
```

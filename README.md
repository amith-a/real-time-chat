# Real-Time Chat with Presence

A real-time chat backend built with AWS serverless architecture, featuring single-table DynamoDB design, WebSocket connection lifecycle management, presence tracking, direct and group chat rooms, and guaranteed message sequencing with idempotency.

---

## Architecture Overview

```
                                      +-------------------------+
                                      |   Cognito User Pool     |
                                      +------------+------------+
                                                   |
                                                   v  (JWT Validation)
+----------------+  WSS   +------------------------+------------------------+
| WebSocket      +------->|           API Gateway WebSocket API            |
| Client         |        +----+-------------------+-------------------+----+
+----------------+             |                   |                   |
                               v                   v                   v
                        +--------------+   +---------------+   +---------------+
                        | $connect     |   | $disconnect   |   | $default      |
                        | Lambda       |   | Lambda        |   | Lambda        |
                        +-------+------+   +-------+-------+   +-------+-------+
                                |                  |                   |
                                +------------------+-------------------+
                                                   |
                                                   v
                               +---------------------------------------+
                               |     DynamoDB Single-Table Design      |
                               | (Users, Connections, Presence, Rooms, |
                               |      Messages, Idempotency)           |
                               +---------------------------------------+
```

### Key Capabilities

1. **Authentication**: Cognito JWT validation via Lambda Request Authorizer (`auth_token` query parameter or `Authorization` header).
2. **Connection & Presence**:
   - Atomic `$connect` registration with presence increment.
   - Dual-record reverse lookup (`CONN#<connectionId>` owner item) for O(1) authorizer-less disconnect resolution.
   - Heartbeat tracking with conditional updates to prevent resurrection of deleted connections.
   - Periodic sweeper scanning for stale connections.
3. **Room Management**:
   - **Direct Rooms**: Deterministic ID calculation (`min(userA, userB)#max(userA, userB)`) with idempotent creation.
   - **Group Rooms**: Atomic creation with metadata, sequence counter, and initial memberships (up to 98 members per batch). Validated using member count and deterministic membership hashing to reject inconsistent creation attempts.
4. **Message Delivery & Idempotency**:
   - Monotonic per-room sequence numbers with optimistic concurrency control and jittered backoff.
   - Client-side idempotency keys with configurable TTL to replay results on retries and detect payload conflicts (`ConflictError`).
5. **Infrastructure as Code**:
   - Complete AWS CloudFormation template defining API Gateway, Lambda functions, Cognito User Pool, DynamoDB table, IAM execution roles, and least-privilege policies.

---

## Single-Table Data Model

The database uses a single Amazon DynamoDB table (`PK`, `SK`, `GSI1PK`, `GSI1SK`):

| Entity | Partition Key (PK) | Sort Key (SK) | GSI1PK | GSI1SK | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **User Profile** | `USER#<userId>` | `PROFILE` | — | — | User metadata and attributes |
| **Presence** | `USER#<userId>` | `PRESENCE` | — | — | Active connection counter and last seen timestamp |
| **Connection** | `USER#<userId>` | `CONN#<connectionId>` | — | — | User active connection item with heartbeat |
| **Connection Owner** | `CONN#<connectionId>` | `A` | — | — | Reverse lookup to resolve user from connectionId on disconnect |
| **Room Meta** | `ROOM#<roomId>` | `META` | — | — | Room attributes, creator, member count, membership hash |
| **Room Counter** | `ROOM#<roomId>` | `COUNTER` | — | — | Monotonic sequence number counter for messages |
| **Membership** | `USER#<userId>` | `ROOM#<roomId>` | `ROOM#<roomId>` | `USER#<userId>` | User membership record and role in room |
| **Message** | `ROOM#<roomId>` | `MSG#<sequenceNumber>` | — | — | Zero-padded 20-digit sequence number message item |
| **Idempotency** | `IDEMP#<senderId>#<roomId>` | `KEY#<clientMessageId>` | — | — | Deduplication item with request hash and TTL |

For in-depth access patterns and query patterns, see:
- [docs/access-pattern.md](docs/access-pattern.md)
- [docs/dynamodb-implementation-guidelines.md](docs/dynamodb-implementation-guidelines.md)
- [docs/websocket-auth.md](docs/websocket-auth.md)

---

## Project Structure

```
.
├── infra/
│   └── template.yaml             # CloudFormation template
├── src/
│   ├── handlers/
│   │   ├── auth/                 # Lambda authorizer
│   │   └── websocket/            # $connect, $disconnect, $default handlers
│   ├── repositories/             # DynamoDB single-table data access layer
│   │   ├── client.ts             # DocumentClient singleton and table queries
│   │   ├── connections.ts        # Connection & presence transactions
│   │   ├── dynamo-errors.ts      # Error classification & retry helpers
│   │   ├── keys.ts               # Primary and secondary key generators
│   │   ├── messages.ts           # Message creation, sequencing & idempotency
│   │   ├── presence.ts           # Presence status retrieval
│   │   ├── rooms.ts              # Direct & group room creation and membership
│   │   ├── types.ts              # Data contracts and TypeScript interfaces
│   │   └── users.ts              # User profile persistence
│   └── shared/                   # Shared error types, logger, and websocket context
├── test/                         # Unit tests (Vitest)
│   ├── authorizer.test.ts
│   ├── error-handler.test.ts
│   ├── keys.test.ts
│   ├── logger.test.ts
│   ├── repositories.test.ts      # Repository unit tests (mocked DynamoDB)
│   ├── shared.test.ts
│   ├── websocket-handlers.test.ts
│   └── integration/              # Live DynamoDB Local integration tests
│       ├── connections.test.ts   # Connection lifecycle & presence tests
│       ├── helpers.ts            # Test table creation, polling & safe teardown
│       ├── messages.test.ts      # Concurrent message sequencing tests
│       ├── rooms.test.ts         # Direct & group room idempotency tests
│       └── users.test.ts         # User profile persistence tests
├── docker-compose.yml            # Local DynamoDB container setup
├── package.json
└── tsconfig.json
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v22 or higher
- [Docker](https://www.docker.com/) (required to run DynamoDB Local for integration tests)

### Installation

```bash
npm install
```

---

## Available Commands

| Command | Description |
| :--- | :--- |
| `npm run build` | Bundles Lambda handler entries using esbuild into `dist/` |
| `npm run typecheck` | Validates TypeScript types across the project (`tsc --noEmit`) |
| `npm test` | Runs the full test suite with Vitest |
| `npm run test:integration` | Runs integration tests against DynamoDB Local |
| `npm run lint` | Checks code formatting and linter rules with Biome |
| `npm run lint:fix` | Automatically fixes linter warnings and organizes imports |
| `npm run format` | Formats all files according to Biome configuration |

---

## Running Integration Tests

Integration tests run against a live DynamoDB instance and verify real table operations, transactions, concurrent conflict resolutions, and eventual consistency.

### 1. Start DynamoDB Local

Start the DynamoDB Local container:

```bash
docker compose up -d
```

Verify it is reachable:
```bash
curl http://localhost:8000
```

### 2. Run the Tests

Set `DYNAMODB_ENDPOINT` to point to the local instance:

#### PowerShell:
```powershell
$env:DYNAMODB_ENDPOINT="http://localhost:8000"
npm run test:integration
```

#### Bash / macOS / Linux:
```bash
DYNAMODB_ENDPOINT=http://localhost:8000 npm run test:integration
```

#### Command Prompt (`cmd.exe`):
```cmd
set DYNAMODB_ENDPOINT=http://localhost:8000
npm run test:integration
```

> **Note**: If `DYNAMODB_ENDPOINT` is omitted when running `test:integration`, the suite fails immediately with an informative error rather than silently skipping.

### 3. Stop DynamoDB Local

```bash
docker compose down
```

---

## Deployment

For comprehensive step-by-step deployment instructions, automated packaging scripts, Cognito auth CLI helpers, and live WebSocket connection verification commands, see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

Quick deployment using AWS CloudFormation:

```bash
aws cloudformation deploy \
  --template-file infra/template.yaml \
  --stack-name dev-real-time-chat \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      Environment=dev \
      ArtifactBucketName=<your-s3-artifacts-bucket> \
      AuthorizerArtifactKey=authorizer.zip \
      ConnectArtifactKey=connect.zip \
      DisconnectArtifactKey=disconnect.zip \
      DefaultArtifactKey=default.zip
```

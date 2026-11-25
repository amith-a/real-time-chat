# Real-Time Chat with Presence

A serverless real-time chat backend on AWS using DynamoDB single-table design, WebSocket API Gateway, Cognito JWT authentication, idempotent message sequencing, and bounded-concurrency room fan-out.

---

## Architecture Overview

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'fontFamily': 'Inter, system-ui, sans-serif', 'fontSize': '14px' }}}%%
flowchart LR
    classDef clientBox fill:#1e293b,stroke:#334155,stroke-width:2px,color:#f8fafc
    classDef authBox fill:#fef2f2,stroke:#ef4444,stroke-width:2px,color:#7f1d1d
    classDef edgeBox fill:#eff6ff,stroke:#3b82f6,stroke-width:2px,color:#1e3a8a
    classDef computeBox fill:#fff7ed,stroke:#f97316,stroke-width:2px,color:#7c2d12
    classDef dbBox fill:#f0fdf4,stroke:#22c55e,stroke-width:2px,color:#14532d

    Clients(["<b>Browser / WS Clients</b><br/>Native WebSocket + REST"]):::clientBox

    subgraph EdgeLayer["1. Edge & Authentication"]
        direction TB
        Cognito["<b>Amazon Cognito</b><br/>User Pool & JWT Issuer"]:::authBox
        WS["<b>API Gateway WebSocket</b><br/>WSS + Mgmt API Fan-Out (25x)"]:::edgeBox
        HTTP["<b>API Gateway HTTP API</b><br/>/users • /rooms • /messages"]:::edgeBox
    end

    subgraph ComputeLayer["2. Serverless Compute (Lambda)"]
        direction TB
        WSLambda["<b>WebSocket Handlers</b><br/>\$connect • $disconnect • $default • sendMessage"]:::computeBox
        HTTPLambda["<b>REST Handlers</b><br/>Users • Rooms & Membership • History API"]:::computeBox
    end

    subgraph DataLayer["3. Single-Table Persistence"]
        DDB[("<b>Amazon DynamoDB</b><br/>Single-Table + GSI1<br/><i>Optimistic Sequences & Idempotency</i>")]:::dbBox
    end

    Clients <== "WSS / Fan-Out Push" ==> WS
    Clients == "HTTPS" ==> HTTP
    Cognito -. "JWT Verify" .-> WS & HTTP

    WS --> WSLambda
    HTTP --> HTTPLambda

    WSLambda <--> DDB
    HTTPLambda <--> DDB
```

### Key Capabilities

- **Authentication:** Cognito JWT validation via Lambda Request Authorizer (`token` query parameter or `Authorization` header).
- **Connection & Presence:** Atomic `$connect` registration with presence counter, `CONN#<id>/OWNER` reverse lookup for `$disconnect`, and heartbeat tracking.
- **Rooms & Messaging:** Direct and group rooms with monotonic per-room sequence numbers, client idempotency keys, and paginated message history (`GET /rooms/{roomId}/messages`).
- **Bounded Fan-Out:** Parallel DynamoDB lookups (`pMap`, 10) and WebSocket deliveries (`pMapSettled`, 25) with 429 jittered retry and 410 stale pruning.
- **Infrastructure as Code:** CloudFormation templates (`infra/`) for Cognito, DynamoDB, API Gateway (HTTP + WebSocket), and Lambdas.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [Docker](https://www.docker.com/) (for DynamoDB Local integration tests)

### Install & Common Commands

```bash
npm install
```

| Command | Description |
| :--- | :--- |
| `npm run build` | Bundles Lambda handlers into `dist/` |
| `npm run typecheck` | Runs `tsc --noEmit` |
| `npm run test:unit` | Runs unit tests with Vitest |
| `npm run test:integration` | Runs integration tests against DynamoDB Local (`DYNAMODB_ENDPOINT=http://localhost:8000`) |
| `npm run lint` | Checks formatting and lint rules with Biome |
| `npm run format` | Formats files with Biome |
| `npm run benchmark:fanout` | Runs the live AWS multi-client fan-out benchmark |

### Running Local Integration Tests

```powershell
docker compose up -d dynamodb-local
$env:DYNAMODB_ENDPOINT="http://localhost:8000"
npm run test:integration
```

### Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) or run:

```bash
bash scripts/deploy/deploy.sh dev
```

---

## Documentation

- [Project Structure](docs/project-structure.md)
- [Single-Table DynamoDB Key Schema](docs/dynamodb-keys.md)
- [Room Fan-Out Architecture & Benchmarks](docs/fanout-benchmarks.md) (`50`-member AWS `p50`/`p95` results)
- [DynamoDB Access Patterns](docs/access-pattern.md)
- [DynamoDB Implementation Guidelines](docs/dynamodb-implementation-guidelines.md)
- [WebSocket Authentication](docs/websocket-auth.md)

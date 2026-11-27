# DynamoDB Data Model and Access Patterns

> **Design reference for developers**
>
> This document explains how application data is represented in DynamoDB, why the keys and index are shaped this way, and how the main application workflows read and write that data. It is the source of truth for the DynamoDB data model and access patterns.

## 1. Purpose and scope

The application uses a single DynamoDB table designed around the operations the chat system must perform.

This document covers:

- Entity key design and important attributes.
- The purpose of the single GSI.
- User, connection, presence, room, membership, and message workflows.
- Message ordering, history, recovery, and idempotency.
- Atomic sequence allocation.
- Race-safe room creation.
- Stale connection discovery and cleanup.
- Room-to-member-to-connection fan-out.
- Access patterns AP1–AP17 from the original project plan.

Repository code, tests, query implementation rules, and agent-specific implementation instructions are maintained separately. See [DynamoDB implementation guidelines](./dynamodb-implementation-guidelines.md).

## 2. Table design

| Setting | Value |
| --- | --- |
| Table | `ChatTable` |
| Design | Single-table |
| Partition key | `PK` (String) |
| Sort key | `SK` (String) |
| Secondary indexes | One GSI, `GSI1` |

GSI1 key attributes:

| Attribute | Role |
| --- | --- |
| `GSI1PK` | GSI partition key |
| `GSI1SK` | GSI sort key |

The required access pattern for GSI1 is **Room → Members**. The initial stale-connection sweeper uses a paginated Scan, as described in Section 10. A sparse connection-only GSI may be evaluated later if measurements show that Scan is too expensive.

GSI reads are eventually consistent. Do not assume a newly created membership is immediately visible through GSI1.

## 3. Conversation model

A direct (1:1) conversation is represented as a room with exactly two members. There is no separate direct-message entity model.

Both direct and group conversations use the same:

- Room metadata.
- Membership records.
- Message partition.
- Sequence counter.
- Message history and recovery queries.
- Authorization checks.

For correctness-sensitive base-table reads:

- **AP8 membership authorization check:** use `GetItem` with `ConsistentRead = true`. A recently removed member must not be authorized to send based on a stale eventually consistent read.
- **AP11 room COUNTER read:** use `GetItem` with `ConsistentRead = true`. The value is used to prepare the conditional sequence-allocation transaction; a stale value would cause avoidable transaction cancellations and retries.

### 3.1 Deterministic direct-room ID

The room ID is derived from the two user IDs after sorting them into a canonical order:

```text
roomId = hash(min(userA, userB) + "#" + max(userA, userB))
```

For example, both `user-100 → user-200` and `user-200 → user-100` produce the same room ID.

The client supplies the recipient user ID for a first direct message; the server derives the room ID. The client must not choose an arbitrary direct-room ID.

## 4. Entity key design

The examples below use symbolic IDs. The actual item also contains its primary key attributes.

### 4.1 User profile

| Attribute | Value |
| --- | --- |
| `PK` | `USER#<userId>` |
| `SK` | `PROFILE` |
| `GSI1PK` | `USERS` |
| `GSI1SK` | `EMAIL#<email>` (or `USER#<userId>`) |

Stores the user's profile data. Supports:

- **AP1 (Get user profile by ID)**: Direct `GetItem` on `PK = USER#<userId>, SK = PROFILE`.
- **Get user by email**: `Query` on GSI1 with `GSI1PK = USERS AND GSI1SK = EMAIL#<email>`.
- **List all users**: `Query` on GSI1 with `GSI1PK = USERS`.
- Idempotently created or refreshed during `$connect` via `ensureUserProfile`.

### 4.2 Connection

| Attribute | Value |
| --- | --- |
| `PK` | `USER#<userId>` |
| `SK` | `CONNECTION#<connectionId>` |

Suggested attributes:

- `userId`
- `connectionId`
- `connectedAt`
- `lastHeartbeat`

A user can have multiple simultaneous connections, for example multiple browser tabs or devices. Do not store a single connection ID on the user profile.

### 4.3 Reverse connection-owner item

The API Gateway WebSocket `$disconnect` event does not reliably contain the authorizer context needed to identify the owner of a connection. Therefore, the application maintains this reverse lookup item **by default** (`withOwnerItem = true`):

| Attribute | Value |
| --- | --- |
| `PK` | `CONN#<connectionId>` |
| `SK` | `OWNER` |

Attributes:

- `userId`
- `connectedAt`

Create this item in the same transaction as the connection item. Delete it in the same transaction as the connection item. Do not let it become independently stale or expire through TTL. This ensures `$disconnect` and `GoneException` handlers can always resolve `connectionId → userId` to decrement presence without relying on authorizer context.

### 4.4 Presence

| Attribute | Value |
| --- | --- |
| `PK` | `USER#<userId>` |
| `SK` | `PRESENCE` |

Attributes:

- `activeConnectionCount`
- `lastSeenAt`

Do not store a separate `status` field. Presence is derived:

- `activeConnectionCount > 0` means online.
- `activeConnectionCount = 0` means offline.

`lastSeenAt` is updated when a connection is removed. It is an approximate connection-removal timestamp, not necessarily the exact moment the user transitioned offline.

### 4.5 Room metadata

| Attribute | Value |
| --- | --- |
| `PK` | `ROOM#<roomId>` |
| `SK` | `META` |

Attributes:

- `roomId`
- `roomType` (`DIRECT` or `GROUP`)
- `createdAt`
- `createdBy`

Do not add `lastMessageAt` or `lastMessageSequence` to META initially. Updating META for every message would create an additional write and a contention point. Add these fields only when a defined product requirement and measured access pattern justify them.

### 4.6 Membership

| Attribute | Value |
| --- | --- |
| `PK` | `USER#<userId>` |
| `SK` | `ROOM#<roomId>` |
| `GSI1PK` | `ROOM#<roomId>` |
| `GSI1SK` | `MEMBER#<userId>` |

Attributes:

- `userId`
- `roomId`
- `joinedAt`
- `role` (`ADMIN` or `MEMBER`)

One membership item supports both directions:

- User → Rooms: base-table Query on `USER#<userId>` with the `ROOM#` sort-key prefix.
- Room → Members: GSI1 Query on `ROOM#<roomId>` with the `MEMBER#` sort-key prefix.

Membership writes use `attribute_not_exists(PK)` so a retry or competing room-creation request cannot silently overwrite an existing membership's `joinedAt` or `role`.

### 4.7 Message

| Attribute | Value |
| --- | --- |
| `PK` | `ROOM#<roomId>` |
| `SK` | `MSG#<zero-padded-sequence>` |

Attributes:

- `messageId`
- `senderId`
- `content` (or the validated message body representation)
- `sequenceNumber`
- `createdAt`
- `messageType`

A message is stored once in its room. Recipients are resolved through room membership and each member's active connections; do not duplicate the message once per recipient.

### 4.8 Room sequence counter

| Attribute | Value |
| --- | --- |
| `PK` | `ROOM#<roomId>` |
| `SK` | `COUNTER` |

Attributes:

- `sequenceNumber`
- `updatedAt`

Initialize `sequenceNumber` to `0` when the room is created. The first committed message receives sequence `1`.

### 4.9 Idempotency record

| Attribute | Value |
| --- | --- |
| `PK` | `IDEMPOTENCY#<userId>#ROOM#<roomId>` |
| `SK` | `REQUEST#<clientMessageId>` |

Attributes:

- `messageId` / client-generated idempotency key
- `sequenceNumber`
- `requestHash`
- `createdAt`
- `ttl`
- Stored response/result fields required to replay the original acknowledgement

The request hash binds the idempotency key to the original payload. Reuse of the same key with a different payload must be rejected. TTL may eventually remove old idempotency records; TTL is not used as an immediate correctness mechanism.

## 5. Message key ordering and retrieval

Room partitions contain more than messages (for example `META` and `COUNTER`). Every history/recovery query must explicitly target the `MSG#` namespace.

### 5.1 Fixed-width sequence keys

Use a fixed-width, zero-padded sequence:

```text
MSG#0000000001
MSG#0000000002
MSG#0000000010
MSG#0000000100
```

Do not use unpadded keys such as `MSG#1`, `MSG#2`, `MSG#10`. DynamoDB string sort order is lexical; fixed-width values make lexical order match numeric order.

### 5.2 Latest message history

For the latest page of messages:

```text
PK = ROOM#<roomId>
begins_with(SK, "MSG#")
ScanIndexForward = false
Limit = <page-size>
```

The application can reverse the returned page for chronological display if needed.

### 5.3 Messages after sequence N

If the client has processed sequence `184`, the next query starts at `185`:

```text
PK = ROOM#<roomId>
SK BETWEEN "MSG#0000000185" AND "MSG#9999999999"
ScanIndexForward = true
```

Do not use only `SK > "MSG#0000000184"`; the bounded `MSG#` range keeps the query inside the message namespace and excludes META/COUNTER items.

### 5.4 Recovery and client behavior

The client tracks the highest contiguous sequence it has processed. On reconnect or gap detection, it requests messages after that sequence. The server returns the ordered message range. The client discards duplicate sequence/message IDs and detects gaps when a later sequence arrives before an expected one.

Network arrival order is not guaranteed to match sequence order. The sequence is the authoritative per-room ordering value.

## 6. Access pattern catalogue

The following catalogue preserves the AP1–AP17 identifiers from the original project plan. An operation may use a transaction containing multiple item actions; the operation column identifies the DynamoDB API operation or transaction.

| ID | Access pattern | DynamoDB operation | Key / condition |
| --- | --- | --- | --- |
| AP1 | Get a user profile | `GetItem` | `USER#<userId>` / `PROFILE` |
| AP2 | Get active connections for a user | `Query` | `PK = USER#<userId>`, `begins_with(SK, CONNECTION#)` |
| AP3 | Register a connection | `TransactWriteItems` | Conditional connection Put + presence counter increment; include reverse-owner Put if required |
| AP4 | Delete a connection | `TransactWriteItems` | Conditional connection Delete + presence counter decrement; include reverse-owner Delete if required. Used by `$disconnect`, stale cleanup, and `GoneException` cleanup; only stale cleanup adds the observed-heartbeat condition |
| AP5 | Get room metadata | `GetItem` | `ROOM#<roomId>` / `META` |
| AP6 | Get rooms for a user | `Query` | `PK = USER#<userId>`, `begins_with(SK, ROOM#)` |
| AP7 | Get members of a room | `Query` on GSI1 | `GSI1PK = ROOM#<roomId>`, `begins_with(GSI1SK, MEMBER#)` |
| AP8 | Check whether a user belongs to a room | `GetItem` (`ConsistentRead = true`) | `USER#<userId>` / `ROOM#<roomId>` |
| AP9 | Get messages in a room | `Query` | `PK = ROOM#<roomId>`, `begins_with(SK, MSG#)` |
| AP10 | Get messages after sequence N | `Query` | `PK = ROOM#<roomId>`, bounded `MSG#` sort-key range |
| AP11 | Read current room sequence | `GetItem` (`ConsistentRead = true`) | `ROOM#<roomId>` / `COUNTER` |
| AP12 | Atomically allocate next sequence and persist message | `TransactWriteItems` | Conditional counter update + message Put + idempotency Put |
| AP13 | Get presence for a user | `GetItem` | `USER#<userId>` / `PRESENCE` |
| AP14 | Determine whether a user's presence is stale | Read presence/connections as needed | Derive online from `activeConnectionCount`; stale connection status is based on `lastHeartbeat`, not a stored status flag |
| AP15 | Check message idempotency | `GetItem` | Idempotency PK and `REQUEST#<clientMessageId>` SK |
| AP16 | Get stored result for a duplicate message ID | `GetItem` | Same idempotency key; return stored original result |
| AP17 | Find stale connections across all users | Paginated `Scan` | Discover candidate connection items whose heartbeat is older than the stale threshold |

**Additional workflow:** Room creation uses one `TransactWriteItems` call to put room META, both membership items, and the COUNTER initialized to zero. It is described in Section 7. It is not silently substituted for one of the original AP identifiers.

**Optional lookup:** If authorizer context does not expose the owner on the required WebSocket event, `GetItem` on `CONN#<connectionId>` / `OWNER` resolves the user. This is conditional on the event inspection described in Section 4.3.

## 7. Room creation workflow

### 7.1 First direct message

When a user sends the first message to another user:

1. Validate the payload.
2. Verify the recipient exists.
3. Derive the deterministic direct-room ID on the server from the sorted user IDs.
4. Attempt room creation if necessary.
5. Create the two membership records.
6. Verify sender membership before accepting messages.
7. Allocate a sequence and persist the message atomically.
8. Deliver the message to room connections.
9. Acknowledge the message to the sender.

The room ID is derived by the server; the client does not choose an arbitrary direct room.

### 7.2 Room creation transaction

Create these four items in one transaction:

1. Room META.
2. Membership for User A.
3. Membership for User B.
4. COUNTER with `sequenceNumber = 0`.

Use `attribute_not_exists(PK)` on each Put. Membership items must not overwrite an existing `joinedAt` or `role`.

### 7.3 Concurrent room creation

If two requests attempt to create the same deterministic direct room, only one conditional transaction should win. The losing request must:

- Read the existing room.
- Verify both expected membership records exist.
- Continue using the existing room if the records are correct.
- Repair missing membership only through an explicit, conditional operation if the design permits it.

Do not blindly repeat unconditional Puts or overwrite membership metadata. Treat a room-already-exists race as an idempotent outcome only after verifying the room and memberships.

### 7.4 Group room creation

Group room creation creates the room and its initial members in one transaction:

1. Room META (`PK = ROOM#<roomId>`, `SK = META`).
2. COUNTER with `sequenceNumber = 0`.
3. Membership items for each unique member (`PK = USER#<userId>`, `SK = ROOM#<roomId>`).

Rules and constraints:

- **Transaction item limit**: DynamoDB transactions support at most 100 items. With Room META (1) and COUNTER (1), a single group room creation transaction supports at most **98 initial members**.
- **Member deduplication**: Member entries must be deduplicated by `userId`. Duplicate target keys in the same `TransactWriteItems` call cause a DynamoDB validation failure.
- **Race recovery**: If two requests race to create the same group room, the losing request must read the existing room META, COUNTER, and every expected member item with `ConsistentRead = true`. To avoid relying on the eventually consistent GSI1 during race checks, room META stores `memberCount` and a deterministic `membershipHash` (`SHA-256` of sorted `userId:role` pairs). The race recovery strongly validates that `existingRoom.memberCount` and `existingRoom.membershipHash` match the creation request. Only if the room and all memberships are verified complete and matching may it treat the race as an idempotent success. If any item is missing or mismatched, treat it as an invariant error and report which items are missing. Do not repair it by overwriting existing items or repeating unconditional Puts.
- **Conditional writes**: Each Put uses `attribute_not_exists(PK)`. Without it, a repeat request would overwrite existing items instead of failing and triggering race recovery.
- **Membership keys**: Each membership item carries its GSI1 keys (`GSI1PK = ROOM#<roomId>`, `GSI1SK = MEMBER#<userId>`) as defined in Section 4.6, so AP7 works for group rooms.
- **Room ID**: Group room IDs are generated by the caller once, before the first attempt, and reused on retries. Unlike direct rooms, the ID is not derived from the members, so a retry with a new ID would create a second room.
- **Retries**: Retry the transaction only for transient cancellations (`TransactionConflict`, throttling), never for a failed condition. A failed condition triggers race recovery instead.

## 8. Message persistence and atomic sequence allocation

DynamoDB `TransactWriteItems` cannot take the result of an `ADD` on one item and use that result to construct another item's key in the same transaction. Use optimistic concurrency with a read followed by a conditional transaction.

### 8.1 Message creation flow

1. Read the idempotency record first.
2. If it exists, compare the request hash. If it matches, return the stored result; if it differs, reject the request.
3. Read the room COUNTER (`sequenceNumber = N`).
4. Calculate `next = N + 1`.
5. Execute one transaction:

```text
Update COUNTER
  SET sequenceNumber = :next
  condition: sequenceNumber = :current

Put MESSAGE
  PK = ROOM#<roomId>
  SK = MSG#<zero-padded-next>
  condition: attribute_not_exists(PK)

Put IDEMPOTENCY
  condition: attribute_not_exists(PK)
```

All three actions commit or none do. A cancelled transaction therefore does not increment the counter or leave a message without its idempotency record.

### 8.2 Transaction cancellation handling

On `TransactionCanceledException`, inspect `CancellationReasons` when exposed by the AWS SDK:

- Idempotency condition failed: fetch the winning idempotency item, compare request hash, and return its stored result or reject a payload mismatch.
- Counter condition failed: another writer won; re-read the counter and retry with a bounded retry count/backoff.
- Message Put condition failed: treat as an invariant violation and investigate.
- Transaction conflict/throttling: bounded retry with backoff.
- Unknown/other failure: propagate; do not retry indefinitely.

Do not reserve a sequence in a separate write before the message transaction. That can create sequence gaps when the subsequent message write fails.

### 8.3 Contention trade-off

The counter is a per-room coordination point. Concurrent sends in a busy room may contend and retry. This is accepted initially to guarantee strictly increasing per-room sequence numbers. Measure contention before considering a different sequencing architecture.

## 9. Connection lifecycle and presence

### 9.1 Resolve connection owner

Inspect `$disconnect` and `$default` event authorizer context independently. In API Gateway WebSocket APIs, authorizer context is typically absent on `$disconnect`. Therefore, the system maintains the reverse owner item (`CONN#<connectionId>` / `OWNER`) **by default** (`withOwnerItem = true`), allowing `$disconnect` and `GoneException` handlers to reliably resolve `connectionId → userId` without authorizer context.

### 9.2 Connect transaction

Create the connection and increment the presence counter atomically:

```text
TransactWriteItems:

Put CONNECTION
  PK = USER#<userId>
  SK = CONNECTION#<connectionId>
  condition: attribute_not_exists(PK)

Update PRESENCE
  PK = USER#<userId>
  SK = PRESENCE
  ADD activeConnectionCount :one
```

By default (`withOwnerItem = true`), include the reverse mapping in the same transaction:

```text
Put CONNECTION OWNER
  PK = CONN#<connectionId>
  SK = OWNER
  userId = <userId>
  connectedAt = :now
  condition: attribute_not_exists(PK)
```

DynamoDB `ADD` initializes a missing numeric attribute from zero. Ensure the Presence item exists or allow the Update to create it with the key attributes.

**Duplicate `$connect` handling:** If the connection Put fails its `attribute_not_exists(PK)` condition, the transaction is cancelled as a whole, so the presence counter is not incremented again. Treat this as an already-registered connection rather than a new connection failure. Read the existing connection (and reverse-owner item if used) consistently and verify that it belongs to the expected user before returning an idempotent success. If the stored owner does not match, treat it as an invariant/security error and alert; do not increment the counter.

### 9.3 Disconnect and stale cleanup transaction

Remove a connection and decrement the count atomically:

```text
TransactWriteItems:

Delete CONNECTION
  condition: attribute_exists(PK)

Update PRESENCE
  SET lastSeenAt = :now
  ADD activeConnectionCount :minusOne
  condition: activeConnectionCount > :zero
```

If reverse mapping is used, include a conditional Delete of the `CONN#<connectionId>` / `OWNER` item in the same transaction.

The conditional connection Delete is the protection against double-decrement: a repeated disconnect or a second sweeper attempt cannot delete the same connection again. The transaction fails as a whole, so the counter is not decremented twice.

**Counter-condition failure:** If `activeConnectionCount > :zero` fails, the entire disconnect transaction is cancelled and the connection Delete does not happen. Log this as a presence invariant violation and emit an alert; include the user ID, connection ID, and observed counter value. Do not silently delete the connection or decrement the counter through a fallback path. The initial decision is that the sweeper must not independently delete this connection: it must use the same atomic disconnect transaction. Leave the item for investigation/reconciliation rather than making the counter drift worse. A separate repair procedure can be designed if this invariant violation is observed.

For stale cleanup, the connection Delete must additionally require that `lastHeartbeat` still equals the timestamp observed during discovery:

```text
attribute_exists(PK) AND lastHeartbeat = :observedLastHeartbeat
```

This prevents the sweeper from deleting a connection that sent a newer heartbeat after it was discovered.

Do not independently TTL-delete connection or reverse-owner items. TTL deletion bypasses the transaction and can make the counter incorrect.

### 9.4 Heartbeat and stale threshold

The initial configuration is:

- Heartbeat interval: 60 seconds.
- Stale threshold: 120 seconds.

Treat these as configurable starting values. A heartbeat updates `lastHeartbeat`; it does not change `activeConnectionCount`. The heartbeat `UpdateItem` **must** include this condition:

```text
attribute_exists(PK)
```

`UpdateItem` otherwise creates a missing item. The condition prevents a late heartbeat from recreating a connection item after the sweeper has deleted it. If the condition fails, the connection is no longer tracked; the server must tell the client to reconnect. Never retry the heartbeat as an unconditional update and never recreate the connection item from the heartbeat handler.

### 9.5 Presence semantics

A user remains online while at least one connection remains. Removing one of several connections must not mark the user offline. The counter is the source of truth; no separate stored `status` is maintained.

## 10. Stale connection discovery

API Gateway `$disconnect` delivery is best-effort, so a periodic sweeper is needed to clean up orphaned connection records.

The initial implementation uses a paginated DynamoDB Scan to discover candidate connection items. The Scan is reserved for this global stale-connection discovery; ordinary user, room, membership, and message reads use their defined GetItem/Query access patterns.

Sweeper workflow:

1. Scan the table and follow `LastEvaluatedKey` until all pages are processed.
2. Identify connection items with `lastHeartbeat` older than the stale threshold.
3. Re-read each candidate from the base table with `ConsistentRead = true`.
4. Confirm it is still stale.
5. Run the conditional disconnect transaction from Section 9.3, checking the observed heartbeat value.
6. If the condition fails, skip the candidate; it has changed or was already removed and can be evaluated in a later sweep.

Do not use TTL as the presence or connection-state mechanism.

**Cost trade-off:** Scan cost scales with the entire table, including message items. During load testing, record table item count, scan duration, items evaluated, stale connections found, and consumed read capacity where available. Switch to a sparse GSI containing connection items only if those measurements show that Scan cost or duration is unacceptable.

## 11. Message fan-out

Do not store a `roomId` on each connection item. A user can have multiple connections and belong to multiple rooms; duplicating per-room connection records is not part of the initial model.

Initial fan-out path:

```text
Room
  ↓ GSI1 Query
Room members
  ↓ base-table Query for each member
Each member's active connections
  ↓ bounded parallel PostToConnection calls
Connected clients
```

Steps:

1. Query GSI1 for all room members, handling pagination.
2. For each member, query their connections using AP2, handling pagination.
3. Send the message to each connection using the API Gateway Management API.
4. If `PostToConnection` returns `GoneException`, treat that as confirmation that the specific connection is no longer reachable. Remove it using the same atomic disconnect transaction defined in Section 9.3 / AP4:
   - Conditional Delete of the connection item.
   - Presence counter decrement with the `activeConnectionCount > :zero` condition.
   - Conditional Delete of the reverse-owner item in the same transaction, if reverse-owner mapping is enabled.
   - Never issue a standalone `DeleteItem` for the connection or reverse-owner item.
5. For this `GoneException` cleanup, omit the stale-sweeper `lastHeartbeat = :observedLastHeartbeat` condition. That condition is only for stale-candidate cleanup; `GoneException` already confirms the connection is gone. If the connection Delete condition fails because the connection item is already absent, treat cleanup as already completed and ignore that outcome.
6. Inspect transaction cancellation reasons so an already-absent connection is not confused with a failed presence-counter condition. If `activeConnectionCount > :zero` fails, log and alert on the invariant violation as described in Section 9.3; do not bypass the transaction with a standalone delete.
7. Treat other delivery failures as individual delivery failures; do not stop attempts to other recipients.
8. Bound concurrency; do not launch an unbounded number of simultaneous sends.

GSI1 is eventually consistent. A newly added member may not immediately appear in the fan-out query. This is a known consistency characteristic to account for in the workflow.

Benchmarks should measure query count, latency (including p50/p95), member count, active connection count, stale connections, and delivery errors. Consider per-room connection records only if measurements justify the extra write/storage complexity.

## 12. Message delivery and recovery context

DynamoDB sequence numbers establish authoritative per-room order, but they do not guarantee network arrival order or exactly-once delivery.

The intended client/server behavior is:

- Client generates a stable message ID for each logical send.
- Server uses the idempotency record to return the original result on retries.
- Server assigns a per-room sequence in the same transaction that persists the message.
- Client tracks the highest contiguous sequence it has processed.
- Client detects gaps when a later sequence arrives before the expected one.
- Client requests messages after its last contiguous sequence on reconnect or gap detection.
- Client discards duplicate messages by message ID/sequence.
- Delivery can be retried; persistence and idempotency prevent a retry from creating a second logical message.

SQS retry/DLQ/replay behavior is covered by the later failure-handling phase and is not a DynamoDB key design.

## 13. Related documentation

- [DynamoDB implementation guidelines](./dynamodb-implementation-guidelines.md) — query rules, implementation constraints, and instructions for coding agents.

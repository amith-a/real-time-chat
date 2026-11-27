# DynamoDB Implementation Guidelines

> **For developers and coding agents implementing the DynamoDB layer**
>
> Read [DynamoDB Data Model and Access Patterns](./access-pattern.md) first. This file gives implementation constraints and operational rules; it does not redefine the data model.

## 1. Source of truth and scope

- `access-patterns.md` is the source of truth for entities, key shapes, access patterns, and application workflows.
- Keep repository implementation and tests in their own source/test files; do not add test cases to the access-pattern document.
- Do not silently change key formats, AP identifiers, transaction boundaries, or index design. If a change is needed, update the design document and explain the migration/impact first.
- Use the AWS SDK directly for DynamoDB. Do not introduce ElectroDB or another ORM unless explicitly approved.
- Keep the initial implementation simple; measure before adding indexes, denormalized records, or other complexity.

## 2. DynamoDB operation selection

- Use `GetItem` when the full partition and sort key are known.
- Use `Query` when retrieving items from one partition.
- Use GSI Query only for access patterns explicitly assigned to GSI1.
- Use `TransactWriteItems` when related writes must commit atomically.
- Scan is reserved for AP17 stale-connection discovery in the initial design. Do not use Scan for normal user, room, membership, or message retrieval.
- Every Query and Scan must handle pagination through `LastEvaluatedKey` / `ExclusiveStartKey`.

## 3. Query construction rules

- Every Query must specify partition-key equality.
- Narrow results with sort-key conditions (`begins_with`, `BETWEEN`, or equality) whenever possible.
- Message history must use `begins_with(SK, "MSG#")`.
- Messages-after-N must use a bounded `MSG#` sort-key range; do not use an unbounded `SK > ...` condition.
- These key conditions must exclude META and COUNTER from message history.
- Avoid FilterExpression when the same restriction can be expressed in the key condition. FilterExpression is applied after items are read and does not reduce read capacity for items evaluated.
- GSI1 reads are eventually consistent; GSI reads cannot be strongly consistent.
- AP8 membership authorization `GetItem` must set `ConsistentRead = true`; do not authorize a send using a potentially stale membership record.
- AP11 room COUNTER `GetItem` must set `ConsistentRead = true` before preparing the optimistic-concurrency transaction, reducing avoidable counter-condition failures and retries.
- Use strongly consistent base-table reads where the workflow requires revalidation, such as re-reading a stale connection candidate.

## 4. Transaction and concurrency rules

- DynamoDB transactions are all-or-nothing; do not assume one action can consume the result of another action in the same transaction.
- Sequence allocation, message Put, and idempotency Put must be one transaction using optimistic concurrency as documented.
- Do not reserve sequence numbers in a separate write.
- Enforce a bounded retry policy for counter conflicts, transaction conflicts, and throttling.
- Inspect transaction cancellation reasons when available from the SDK. Classify idempotency conflict separately from counter conflict; do not treat every cancellation as a counter race.
- A message-key conditional failure is an invariant violation to investigate.
- Room creation uses four conditional puts: META, both memberships, and COUNTER initialized to zero.
- Membership Put uses `attribute_not_exists(PK)`.
- On a room-creation race, read and verify the existing room and both memberships. Do not overwrite membership metadata to make the retry pass.
- Group room creation uses conditional Puts for META, COUNTER and one per member (maximum 98 members, unique user IDs). On a race, verify the room, the counter and every membership; do not overwrite.

## 5. Connection and presence invariants

- A user may have multiple connection items.
- Presence is derived from `activeConnectionCount`; do not add a separate stored online/offline flag.
- Connection creation and counter increment must be atomic.
- If a duplicate `$connect` causes the connection Put condition to fail, the whole transaction has no effect. Treat it as already registered only after a consistent read confirms the existing connection belongs to the expected user; do not increment presence again. A mismatched owner is an invariant/security error.
- Connection deletion and counter decrement must be atomic.
- A conditional connection Delete must prevent a repeated disconnect or sweeper run from decrementing twice.
- If the presence decrement condition `activeConnectionCount > :zero` fails, the transaction also leaves the connection item untouched. Log and alert on this invariant violation. The initial design does not allow the sweeper to bypass the transaction and delete the connection independently; investigate/reconcile the counter before cleanup.
- If reverse owner mapping is needed, its Put/Delete belongs in the same transaction as the corresponding connection Put/Delete.
- Do not apply TTL to connection or reverse-owner records: TTL deletion would bypass the presence transaction.
- Heartbeats update `lastHeartbeat`, not the presence counter. The heartbeat `UpdateItem` must include `attribute_exists(PK)` so it cannot recreate a connection item deleted by the sweeper. If the condition fails, tell the client to reconnect; never issue an unconditional update.
- Sweeper cleanup must condition its transactional Delete on the heartbeat value observed, so a connection that has since heartbeated is not removed.
- Verify authorizer context independently for `$disconnect` and `$default`; do not assume it is available on both events.

## 6. Scan policy and measurement

The initial stale-connection sweeper uses a paginated Scan. This is a deliberate initial trade-off, not a general retrieval strategy.

During load testing, record:

- Total table item count.
- Scan duration.
- Items evaluated.
- Stale connections found.
- Consumed read capacity, where available.

Scan reads the whole table, including message items; a filter does not make the scan proportional only to connection items. Consider a sparse connection-only GSI only if measurements show the current approach is too costly or slow.

## 7. Fan-out implementation

- Resolve room members through GSI1.
- Resolve each member's connections through the base-table connection Query.
- Handle pagination at both levels.
- Use bounded concurrency for `PostToConnection`.
- A gone connection must not abort delivery attempts to other recipients.
- When `PostToConnection` returns `GoneException`, remove that connection with the same atomic disconnect transaction as AP4: conditional connection Delete + presence decrement, plus conditional reverse-owner Delete in that transaction if reverse-owner mapping is enabled.
- Never issue a standalone `DeleteItem` for a connection or reverse-owner item in response to `GoneException`.
- Do not add the stale-sweeper `lastHeartbeat = :observedLastHeartbeat` condition to `GoneException` cleanup; that condition is only for stale-candidate cleanup because `GoneException` already confirms the connection is gone.
- If the connection Delete condition fails because the connection item is already absent, treat it as already removed and ignore that outcome. Inspect transaction cancellation reasons: do not mistake a failed presence-counter condition (`activeConnectionCount > :zero`) for an already-removed connection; log and alert on that invariant violation and do not bypass the transaction.
- Account for GSI1 eventual consistency when a membership was just created.
- Do not add per-room connection records unless performance measurements justify the added complexity.

## 8. TTL policy

DynamoDB TTL is asynchronous garbage collection. It is not a scheduler, not an immediate deletion mechanism, and not a source of truth for connection state or presence.

TTL may be used for expiring idempotency records. Do not use TTL on connection or reverse-owner items while their deletion must remain coordinated with the presence counter.

## 9. Agent workflow requirements

When asked to implement a repository operation:

1. Find its AP identifier in `access-patterns.md`.
2. Confirm the exact PK/SK or GSI key condition and expected item shape.
3. Use the DynamoDB operation assigned to that access pattern.
4. Preserve the documented transaction boundary and conditional expressions.
5. Handle pagination and consistency requirements.
6. Add or update tests in the test suite (tests are maintained separately).
7. Do not broaden the task by introducing a new index or Scan.
8. If the requested behavior cannot be implemented with the documented model, stop and explain the missing access pattern/design decision rather than inventing a key or query.

When proposing a schema or access-pattern change:

- Explain which user-visible workflow requires it.
- Explain its read/write/storage cost and consistency implications.
- Update `access-patterns.md` first.
- Update this guideline file only if implementation rules change.
- Keep AP identifiers stable unless there is a clear reason to revise them.

## 10. Out of scope

This file does not define:

- Unit/integration test cases or fixtures.
- Lambda handler and API Gateway route implementation.
- Infrastructure deployment configuration.
- Load-test benchmark results.
- SQS retry, DLQ, and replay implementation details.

Those belong to their respective project phases and documents.

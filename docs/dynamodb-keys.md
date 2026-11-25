# Single-Table DynamoDB Key Schema

The database uses a single Amazon DynamoDB table (`PK`, `SK`, `GSI1PK`, `GSI1SK`) defined in [src/repositories/keys.ts](../src/repositories/keys.ts):

| Entity | Partition Key (`PK`) | Sort Key (`SK`) | `GSI1PK` | `GSI1SK` | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **User Profile** | `USER#<userId>` | `PROFILE` | `USERS` | `EMAIL#<email>` or `USER#<userId>` | User metadata and email lookup |
| **Presence** | `USER#<userId>` | `PRESENCE` | — | — | Active connection counter and `lastSeenAt` |
| **Connection** | `USER#<userId>` | `CONNECTION#<connectionId>` | — | — | Active WebSocket connection with heartbeat |
| **Connection Owner** | `CONN#<connectionId>` | `OWNER` | — | — | Reverse lookup to resolve owner on disconnect |
| **Room Meta** | `ROOM#<roomId>` | `META` | — | — | Room attributes, creator, member count, membership hash |
| **Room Counter** | `ROOM#<roomId>` | `COUNTER` | — | — | Monotonic `sequenceNumber` counter for messages |
| **Membership** | `USER#<userId>` | `ROOM#<roomId>` | `ROOM#<roomId>` | `MEMBER#<userId>` | User membership record and role in room |
| **Message** | `ROOM#<roomId>` | `MSG#<sequenceNumber>` | — | — | Zero-padded 20-digit sequence number message item |
| **Idempotency** | `IDEMPOTENCY#<userId>#ROOM#<roomId>` | `REQUEST#<clientMessageId>` | — | — | Deduplication item with request hash and TTL |

## Related Documentation

- [Access Patterns](access-pattern.md)
- [DynamoDB Implementation Guidelines](dynamodb-implementation-guidelines.md)
- [WebSocket Authentication](websocket-auth.md)

# WebSocket Authentication & Browser Constraints

## Overview

In Amazon API Gateway WebSocket APIs, authentication is typically performed during the connection handshake via the `$connect` route using a Lambda REQUEST authorizer.

## Browser WebSocket API Limitations

Standard browser clients instantiate WebSockets using the W3C `WebSocket` interface:

```javascript
const ws = new WebSocket(url, protocols);
```

The browser `WebSocket` constructor does **not** allow setting custom HTTP request headers such as:

```http
Authorization: Bearer <jwt-token>
```

### Alternatives Considered

1. **Query String Parameter (`?token=<jwt>`)**:
   - **Approach**: The client includes the token in the URL query string when connecting:

     ```javascript
     const ws = new WebSocket(`wss://${apiEndpoint}/${stage}?token=${idToken}`);
     ```

   - **Tradeoff**: Query parameters may be recorded in access logs, proxy logs, and browser history.
   - **Mitigation**:
     - Redact/filter `token` parameters from API Gateway access logs.
     - Never log full URLs containing tokens in CloudWatch Lambda logs.
     - Enforce short expiration times on ID tokens (e.g. 1 hour).

### Decision

Use **Query String Parameter (`?token=<id_token>`)** for the initial connection handshake.

## ID Token vs Access Token

- **Cognito ID Token**: Contains user identity claims (`sub`, `email`, `cognito:username`, custom attributes). The authorizer validates this token to extract the principal ID and attach context (`userId`, `email`).
- **Cognito Access Token**: Contains authorization scopes and groups. Used when granting access to specific AWS or REST APIs.
- For user identity verification in the WebSocket chat system, **ID Token** is used.

## Log Sanitization Rules

1. Never log raw JWTs or full WebSocket connection URLs containing the `token` parameter.
2. Lambda authorizers must catch verification errors without outputting token contents into stdout.
3. Configure API Gateway access log format to omit or mask query parameters.

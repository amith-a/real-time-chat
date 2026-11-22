/**
 * Standard WebSocket response helpers.
 */

export interface WebSocketResponse {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}

/**
 * Formats a standard API Gateway WebSocket Lambda proxy response.
 */
export function formatResponse(statusCode = 200, body: unknown = ''): WebSocketResponse {
  const formattedBody = typeof body === 'string' ? body : JSON.stringify(body);

  return {
    statusCode,
    body: formattedBody,
  };
}

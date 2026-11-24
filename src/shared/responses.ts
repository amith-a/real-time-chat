/**
 * Standard WebSocket response helpers.
 */

export interface WebSocketResponse {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
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

/**
 * Formats a standard API Gateway HTTP API (Payload v2) Lambda proxy response with CORS.
 */
export function formatHttpResponse(
  statusCode = 200,
  body: unknown = '',
  customHeaders: Record<string, string> = {},
): HttpResponse {
  const formattedBody = typeof body === 'string' ? body : JSON.stringify(body);

  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      ...customHeaders,
    },
    body: formattedBody,
  };
}

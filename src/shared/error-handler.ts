import { AppError } from './errors';
import type { Logger } from './logger';
import { formatResponse, type WebSocketResponse } from './responses';

export function handleError(error: unknown, log: Logger): WebSocketResponse {
  const normalizedError =
    error instanceof Error ? error : new Error('An unexpected error occurred');

  log.error('Request failed', normalizedError);

  if (error instanceof AppError && error.isOperational && error.statusCode < 500) {
    return formatResponse(error.statusCode, {
      message: error.message,
    });
  }

  return formatResponse(500, {
    message: 'Internal server error',
  });
}

import { AppError } from './errors';
import type { Logger } from './logger';
import type { WebSocketResponse } from './responses';

export function handleError(error: unknown, log: Logger): WebSocketResponse {
  const normalizedError =
    error instanceof Error ? error : new Error('An unexpected error occurred');

  log.error('Request failed', normalizedError);

  if (error instanceof AppError && error.isOperational && error.statusCode < 500) {
    return {
      statusCode: error.statusCode,
      body: JSON.stringify({
        message: error.message,
      }),
    };
  }

  return {
    statusCode: 500,
    body: JSON.stringify({
      message: 'Internal server error',
    }),
  };
}

import { AppError } from './errors';
import type { Logger } from './logger';
import {
  formatHttpResponse,
  formatResponse,
  type HttpResponse,
  type WebSocketResponse,
} from './responses';

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

export function handleHttpError(error: unknown, log: Logger): HttpResponse {
  const normalizedError =
    error instanceof Error ? error : new Error('An unexpected error occurred');

  log.error('HTTP Request failed', normalizedError);

  if (error instanceof AppError && error.isOperational && error.statusCode < 500) {
    return formatHttpResponse(error.statusCode, {
      message: error.message,
    });
  }

  return formatHttpResponse(500, {
    message: 'Internal server error',
  });
}

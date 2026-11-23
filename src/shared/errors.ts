/**
 * Common application errors for Lambda handlers and services.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN_ACTION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: Record<string, unknown>;
  public readonly code: ErrorCode;

  constructor(
    message: string,
    statusCode = 500,
    details?: Record<string, unknown>,
    isOperational = true,
    code: ErrorCode = 'INTERNAL_ERROR',
  ) {
    super(message);

    Object.setPrototypeOf(this, new.target.prototype);

    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;
    this.code = code;

    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad Request', details?: Record<string, unknown>) {
    super(message, 400, details, true, 'BAD_REQUEST');
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: Record<string, unknown>) {
    super(message, 400, details, true, 'VALIDATION_ERROR');
  }
}

export class UnknownActionError extends AppError {
  constructor(message = 'Unknown action', details?: Record<string, unknown>) {
    super(message, 400, details, true, 'UNKNOWN_ACTION');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', details?: Record<string, unknown>) {
    super(message, 401, details, true, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details?: Record<string, unknown>) {
    super(message, 403, details, true, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not Found', details?: Record<string, unknown>) {
    super(message, 404, details, true, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: Record<string, unknown>) {
    super(message, 409, details, true, 'CONFLICT');
  }
}

export class InternalServerError extends AppError {
  constructor(message = 'Internal Server Error', details?: Record<string, unknown>) {
    super(message, 500, details, false, 'INTERNAL_ERROR');
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

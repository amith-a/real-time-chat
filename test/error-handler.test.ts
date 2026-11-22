import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  handleError,
  InternalServerError,
  Logger,
  UnauthorizedError,
} from '../src/shared';

describe('handleError', () => {
  it('returns the correct response for an operational AppError', () => {
    const logger = new Logger();
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    const error = new UnauthorizedError('Invalid credentials');

    const result = handleError(error, logger);

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body as string)).toEqual({
      message: 'Invalid credentials',
    });
  });

  it('returns a generic 500 response for unexpected errors', () => {
    const logger = new Logger();
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    const error = new Error('Database connection failed');

    const result = handleError(error, logger);

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body as string)).toEqual({
      message: 'Internal server error',
    });
  });

  it('does not expose details from application errors', () => {
    const logger = new Logger();
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    const error = new AppError('Something failed', 400, {
      password: 'secret123',
    });

    const result = handleError(error, logger);

    expect(result.statusCode).toBe(400);
    expect(result.body).not.toContain('secret123');
  });

  it('returns 500 for non-operational application errors', () => {
    const logger = new Logger();
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    const error = new InternalServerError('Internal failure');

    const result = handleError(error, logger);

    expect(result.statusCode).toBe(500);
    expect(result.body).toContain('Internal server error');
  });

  it('logs the error', () => {
    const logger = new Logger();
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const error = new Error('Unexpected failure');

    handleError(error, logger);

    expect(logSpy).toHaveBeenCalledWith('Request failed', error);
  });
});

import { describe, expect, it } from 'vitest';
import { sanitize } from '../src/shared';

describe('sanitize', () => {
  it('redacts sensitive object keys', () => {
    const result = sanitize({
      accessToken: 'jwt-secret',
      refresh_token: 'refresh-secret',
      password: 'mypassword',
      clientSecret: 'secret-value',
      connectionId: 'connection-123',
    });

    expect(result).toEqual({
      accessToken: '[REDACTED]',
      refresh_token: '[REDACTED]',
      password: '[REDACTED]',
      clientSecret: '[REDACTED]',
      connectionId: 'connection-123',
    });
  });

  it('redacts tokens in URL query parameters', () => {
    const result = sanitize('wss://example.com/dev?token=abc123&other=value');

    expect(result).toBe('wss://example.com/dev?token=[REDACTED]&other=value');
  });

  it('handles circular references', () => {
    const data: Record<string, unknown> = {
      connectionId: 'abc123',
    };

    data.self = data;

    const result = sanitize(data) as Record<string, unknown>;

    expect(result.connectionId).toBe('abc123');
    expect(result.self).toBe('[Circular]');
  });

  it('handles repeated references without marking them circular', () => {
    const shared = { connectionId: 'abc123' };

    const result = sanitize({
      first: shared,
      second: shared,
    }) as Record<string, unknown>;

    expect(result.first).toEqual({ connectionId: 'abc123' });
    expect(result.second).toEqual({ connectionId: 'abc123' });
  });

  it('converts BigInt to string', () => {
    expect(sanitize(12345678901234567890n)).toBe('12345678901234567890');
  });

  it('converts Date to ISO string', () => {
    const date = new Date('2026-11-22T10:00:00.000Z');

    expect(sanitize(date)).toBe('2026-11-22T10:00:00.000Z');
  });

  it('sanitizes Error objects and their causes', () => {
    const cause = new Error('Underlying failure');
    const error = new Error('Request failed', { cause });

    const result = sanitize(error) as {
      name: string;
      message: string;
      cause: { message: string };
    };

    expect(result.name).toBe('Error');
    expect(result.message).toBe('Request failed');
    expect(result.cause.message).toBe('Underlying failure');
  });

  it('redacts Authorization query parameters in URLs', () => {
    expect(sanitize('wss://example.com/dev?Authorization=BearerSecret123&room=1')).toBe(
      'wss://example.com/dev?Authorization=[REDACTED]&room=1',
    );
    expect(sanitize('wss://example.com/dev?authorization=Secret456')).toBe(
      'wss://example.com/dev?authorization=[REDACTED]',
    );
  });
});

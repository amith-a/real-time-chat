/**
 * Structured JSON Logger for AWS Lambda and CloudWatch Logs.
 * Automatically redacts tokens, secrets, and authorization parameters.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const SENSITIVE_KEY_REGEX = /token|secret|password|authorization|api[-_]?key|cookie|credential/i;

const TOKEN_URL_REGEX =
  /([?&](?:id_?token|access_?token|refresh_?token|token|authorization)=)[^&\s"]+/gi;

/**
 * Recursively sanitizes data before logging.
 *
 * - Redacts sensitive object keys.
 * - Redacts tokens in URL query parameters.
 * - Handles circular references.
 * - Converts BigInt and Date values.
 * - Handles Error objects and their causes.
 */
export function sanitize(data: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof data === 'string') {
    return data.replace(TOKEN_URL_REGEX, '$1[REDACTED]');
  }

  if (typeof data === 'bigint') {
    return data.toString();
  }

  if (data === null || typeof data !== 'object') {
    return data;
  }

  if (seen.has(data)) {
    return '[Circular]';
  }

  seen.add(data);

  try {
    if (data instanceof Date) {
      return data.toISOString();
    }

    if (data instanceof Error) {
      return {
        name: sanitize(data.name, seen),
        message: sanitize(data.message, seen),
        stack: sanitize(data.stack, seen),
        ...(data.cause !== undefined && {
          cause: sanitize(data.cause, seen),
        }),
      };
    }

    if (Array.isArray(data)) {
      return data.map((item) => sanitize(item, seen));
    }

    const out: Record<string, unknown> = Object.create(null);

    for (const [key, value] of Object.entries(data)) {
      out[key] = SENSITIVE_KEY_REGEX.test(key) ? '[REDACTED]' : sanitize(value, seen);
    }

    return out;
  } finally {
    seen.delete(data);
  }
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
  };
}

export class Logger {
  private boundContext: Record<string, unknown>;

  constructor(boundContext: Record<string, unknown> = {}) {
    this.boundContext = boundContext;
  }

  /**
   * Creates a child logger with bound context.
   * Example: connectionId, routeKey.
   */
  public withContext(context: Record<string, unknown>): Logger {
    return new Logger({
      ...this.boundContext,
      ...context,
    });
  }

  private write(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    err?: Error,
  ): void {
    const mergedContext = {
      ...this.boundContext,
      ...(context || {}),
    };

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: sanitize(message) as string,
    };

    if (Object.keys(mergedContext).length > 0) {
      entry.context = sanitize(mergedContext) as Record<string, unknown>;
    }

    if (err instanceof Error) {
      entry.error = sanitize(err) as LogEntry['error'];
    }

    const output = JSON.stringify(entry);

    if (level === 'ERROR') {
      process.stderr.write(`${output}\n`);
    } else {
      process.stdout.write(`${output}\n`);
    }
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    if (process.env.LOG_LEVEL === 'DEBUG') {
      this.write('DEBUG', message, context);
    }
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.write('INFO', message, context);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.write('WARN', message, context);
  }

  public error(message: string, err?: Error, context?: Record<string, unknown>): void {
    this.write('ERROR', message, context, err);
  }
}

export const logger = new Logger();

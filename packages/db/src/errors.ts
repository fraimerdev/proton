import { DrizzleQueryError } from 'drizzle-orm/errors';

export function isQueryError(error: unknown): error is DrizzleQueryError {
  return error instanceof DrizzleQueryError;
}

export function describeError(error: unknown): string {
  if (isQueryError(error)) {
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return `database query failed (${typeof code === 'string' ? code : 'no code'})`;
  }
  return error instanceof Error ? error.message : String(error);
}

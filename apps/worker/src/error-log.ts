import type { ProtonEvent } from '@proton/core';
import { describeError, isQueryError } from '@proton/db';

export function loggableError(error: unknown): { message: string; stack?: string } {
  const message = describeError(error);
  // A failed query's stack repeats its message, and that message carries the bound parameters.
  if (isQueryError(error) || !(error instanceof Error) || !error.stack) return { message };
  return { message, stack: error.stack };
}

export function logHandlerError(
  log: (message: string, meta: Record<string, unknown>) => void,
): (event: ProtonEvent, error: unknown, group: string) => void {
  return (event, error, group) => {
    const { message, stack } = loggableError(error);
    log(`${group} failed to handle ${event.type}, so it will be redelivered: ${message}`, {
      group,
      eventId: event.id,
      guildId: event.guildId,
      ...(stack ? { stack } : {}),
    });
  };
}

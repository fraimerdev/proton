import { Redis } from 'ioredis';
import type { Logger } from './modules/manifest.ts';

export interface RedisLoggingOptions {
  label: string;
  url: string;
  logger?: Logger;
}

export function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.password) return url;

    parsed.password = '***';
    return parsed.toString();
  } catch {
    return url;
  }
}

export function describeRedisError(error: unknown): string {
  // Node's connect-multiple wrapper carries an empty message; the real ECONNREFUSED is in .errors.
  const nested = (error as { errors?: unknown } | null | undefined)?.errors;
  if (Array.isArray(nested) && nested.length > 0) {
    const parts = [...new Set(nested.map(describeRedisError))].filter(Boolean);
    if (parts.length > 0) return parts.join('; ');
  }

  if (error instanceof Error) return error.message || error.name;

  return String(error);
}

export function attachRedisLogging(client: Redis, options: RedisLoggingOptions): Redis {
  const { label, logger = console } = options;
  const where = `${label} at ${redactRedisUrl(options.url)}`;

  let down = false;
  let attempts = 0;

  client.on('error', (error: unknown) => {
    attempts += 1;
    if (down) return;

    down = true;
    logger.error(`redis ${where} is unreachable: ${describeRedisError(error)}. Retrying.`);
  });

  client.on('ready', () => {
    if (down) logger.info(`redis ${where} recovered after ${attempts} failed attempt(s).`);

    down = false;
    attempts = 0;
  });

  return client;
}

export function createRedisClient(
  url: string,
  options: { db: number; label: string; logger?: Logger },
): Redis {
  const { db, label, logger } = options;

  return attachRedisLogging(new Redis(url, { db }), {
    label,
    url,
    ...(logger ? { logger } : {}),
  });
}

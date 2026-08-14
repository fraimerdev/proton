import { REST } from '@discordjs/rest';

export interface CreateRestOptions {
  token: string;
  api?: string;
  /** Discord's global ceiling. Exposed so tests can drive it deterministically. */
  globalRequestsPerSecond?: number;
}

/**
 * The single Discord REST client for the entire deployment (PLAN.md I2).
 *
 * Rate limit buckets are per-client state. Two worker processes each holding
 * their own client would each believe they had a full bucket, so together they
 * would exceed it and take 429s that neither could predict. Funnelling every
 * process through this one instance is what makes the bucket accounting true.
 */
export function createRest(options: CreateRestOptions): REST {
  const rest = new REST({
    version: '10',
    api: options.api ?? 'https://discord.com/api',
    ...(options.globalRequestsPerSecond !== undefined
      ? { globalRequestsPerSecond: options.globalRequestsPerSecond }
      : {}),
  });

  rest.setToken(options.token);
  return rest;
}

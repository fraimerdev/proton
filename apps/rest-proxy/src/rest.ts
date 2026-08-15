import { REST } from '@discordjs/rest';

export interface CreateRestOptions {
  token: string;
  api?: string;

  globalRequestsPerSecond?: number;
}

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

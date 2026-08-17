import type { RestProxyClient } from '@proton/core';

export class AutomodRulesUnreadable extends Error {
  readonly status: number;

  constructor(guildId: string, status: number) {
    super(
      `the REST proxy answered ${status} for guild ${guildId}. Proton needs the Manage Server ` +
        'permission to read this server’s Discord AutoMod rules; without it the native half of ' +
        'automod does nothing.',
    );
    this.name = 'AutomodRulesUnreadable';
    this.status = status;
  }
}

// Throws rather than returning null on failure: a reconcile that read an empty list would take the
// guild's rules down, and "could not read" must never be mistaken for "there are none".
export async function readNativeAutomodRules(
  rest: RestProxyClient,
  guildId: string,
): Promise<unknown> {
  const response = await rest.request({
    method: 'GET',
    path: `/guilds/${guildId}/auto-moderation/rules`,
  });

  if (response.status >= 400) throw new AutomodRulesUnreadable(guildId, response.status);

  return response.body;
}

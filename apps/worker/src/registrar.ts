import type { ModuleRegistry, RestProxyClient } from '@proton/core';

export interface RegistrarOptions {
  applicationId: string;
  scope: 'guild' | 'global';
  testGuildId?: string | undefined;
}

/**
 * Register every module's slash commands.
 *
 * Guild-scoped in development because guild commands propagate instantly while
 * global ones take up to an hour (PLAN.md §2). Guild scope also enforces the
 * agent safety rail: commands only ever appear in the designated test guild.
 */
export async function registerCommands(
  rest: RestProxyClient,
  registry: ModuleRegistry,
  options: RegistrarOptions,
): Promise<{ path: string; count: number }> {
  const commands = registry.all().flatMap((m) => m.commands?.map((c) => c.data) ?? []);

  if (options.scope === 'guild') {
    if (!options.testGuildId) {
      throw new Error(
        'COMMAND_REGISTRATION_SCOPE=guild requires DISCORD_TEST_GUILD_ID. Refusing to fall back ' +
          'to global registration, which would publish commands to every guild the bot is in.',
      );
    }

    const path = `/applications/${options.applicationId}/guilds/${options.testGuildId}/commands`;
    return put(rest, path, commands);
  }

  const path = `/applications/${options.applicationId}/commands`;
  return put(rest, path, commands);
}

/**
 * Send the bulk overwrite, and believe Discord rather than ourselves.
 *
 * `RestProxyClient.request` returns a status; it does not throw on a non-2xx. So
 * discarding the result meant the worker logged "registered 11 command(s)"
 * whatever came back — including the 400 Discord returns when one command in the
 * set is malformed, which rejects *the whole PUT* and leaves the previous set in
 * place. The commands silently stay as they were and the log says they changed,
 * which is the worst possible pairing when a command has just been renamed.
 */
async function put(
  rest: RestProxyClient,
  path: string,
  commands: readonly unknown[],
): Promise<{ path: string; count: number }> {
  const response = await rest.request({ method: 'PUT', path, body: commands });

  if (response.status >= 400) {
    throw new Error(
      `Discord rejected the command registration with ${response.status}: ${
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
      }. The previously registered commands are still in place, so any command added or ` +
        'renamed in this build is NOT available.',
    );
  }

  return { path, count: commands.length };
}

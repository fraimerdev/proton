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
    await rest.request({ method: 'PUT', path, body: commands });
    return { path, count: commands.length };
  }

  const path = `/applications/${options.applicationId}/commands`;
  await rest.request({ method: 'PUT', path, body: commands });
  return { path, count: commands.length };
}

import type { ModuleRegistry, RestProxyClient } from '@proton/core';

export interface RegistrarOptions {
  applicationId: string;
  scope: 'guild' | 'global';
  testGuildId?: string | undefined;
}

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

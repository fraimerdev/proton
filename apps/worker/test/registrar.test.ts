import { describe, expect, test } from 'bun:test';
import {
  ModuleRegistry,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
} from '@proton/core';
import { pingModule } from '@proton/module-ping';
import { registerCommands } from '../src/registrar.ts';

const APPLICATION_ID = '1200000000000000001';
const TEST_GUILD = '900000000000000001';

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  response: RestResponse = { status: 200, body: {} };

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return this.response;
  }
}

function registry(): ModuleRegistry {
  const built = new ModuleRegistry();
  built.register(pingModule);
  return built;
}

describe('registerCommands', () => {
  test('bulk-overwrites guild commands in development', async () => {
    const rest = new FakeRest();

    const result = await registerCommands(rest, registry(), {
      applicationId: APPLICATION_ID,
      scope: 'guild',
      testGuildId: TEST_GUILD,
    });

    expect(rest.calls[0]?.method).toBe('PUT');
    expect(result.path).toBe(`/applications/${APPLICATION_ID}/guilds/${TEST_GUILD}/commands`);
    expect(result.count).toBeGreaterThan(0);
  });

  test('refuses guild scope with no test guild rather than falling back to global', async () => {
    await expect(
      registerCommands(new FakeRest(), registry(), {
        applicationId: APPLICATION_ID,
        scope: 'guild',
      }),
    ).rejects.toThrow('DISCORD_TEST_GUILD_ID');
  });

  test('a non-2xx is a failure, not a success with a cheerful log line', async () => {
    const rest = new FakeRest();
    rest.response = { status: 400, body: { message: 'Invalid Form Body' } };

    await expect(
      registerCommands(rest, registry(), {
        applicationId: APPLICATION_ID,
        scope: 'guild',
        testGuildId: TEST_GUILD,
      }),
    ).rejects.toThrow('400');
  });

  test('the failure says the old commands are still live, because they are', async () => {
    const rest = new FakeRest();
    rest.response = { status: 403, body: { message: 'Missing Access' } };

    await expect(
      registerCommands(rest, registry(), { applicationId: APPLICATION_ID, scope: 'global' }),
    ).rejects.toThrow(/still in place/);
  });

  test('global scope needs no test guild', async () => {
    const rest = new FakeRest();

    const result = await registerCommands(rest, registry(), {
      applicationId: APPLICATION_ID,
      scope: 'global',
    });

    expect(result.path).toBe(`/applications/${APPLICATION_ID}/commands`);
  });

  test('a module with no commands still registers an empty set, clearing stale ones', async () => {
    const rest = new FakeRest();
    const empty = new ModuleRegistry();

    const result = await registerCommands(rest, empty, {
      applicationId: APPLICATION_ID,
      scope: 'guild',
      testGuildId: TEST_GUILD,
    });

    expect(result.count).toBe(0);
    expect(rest.calls[0]?.body).toEqual([]);
  });
});

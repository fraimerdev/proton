import { describe, expect, test } from 'bun:test';
import type { ModuleRegistry } from '@proton/core';
import { Permissions } from '@proton/core';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';

const SECRET = 'shared-secret-for-tests';

function appWith(permissions: bigint) {
  const registry = { invitePermissions: () => permissions } as unknown as ModuleRegistry;

  return createApiApp({ registry, sharedSecret: SECRET } as unknown as ApiDeps);
}

function get(app: ReturnType<typeof createApiApp>, secret?: string) {
  return app.request('/invite', {
    headers: secret === undefined ? {} : { 'x-proton-secret': secret },
  });
}

describe('GET /invite', () => {
  test('answers with the permission set every loaded module needs', async () => {
    const wanted = Permissions.BanMembers | Permissions.ManageChannels;
    const response = await get(appWith(wanted), SECRET);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ permissions: wanted.toString() });
  });

  // Discord's permission set runs past 2^53, and JSON has no bigint. Sent as a number, Manage
  // Events and everything above it round away and the invite silently asks for less than Proton
  // needs — which surfaces later as a module that cannot run for no visible reason.
  test('sends the mask as a decimal string, so the high bits survive JSON', async () => {
    const high = 1n << 60n;
    const body = (await (await get(appWith(high), SECRET)).json()) as { permissions: string };

    expect(body.permissions).toBe('1152921504606846976');
    expect(BigInt(body.permissions)).toBe(high);
  });

  test('it sits behind the shared secret like every other route', async () => {
    expect((await get(appWith(8n))).status).toBe(401);
    expect((await get(appWith(8n), 'wrong')).status).toBe(401);
  });
});

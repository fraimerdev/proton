import { describe, expect, test } from 'bun:test';
import type { EventBus, ProtonEvent } from '@proton/core';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import { VerificationService } from '../src/verification/service.ts';

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';
const MEMBER = '400000000000000001';

const NOW = 1_700_000_000_000;

function collecting(): { bus: EventBus; published: ProtonEvent[] } {
  const published: ProtonEvent[] = [];

  const bus = {
    publish: async (event: ProtonEvent) => {
      published.push(event);
    },
    subscribe: () => {
      throw new Error('the api never subscribes');
    },
  } as unknown as EventBus;

  return { bus, published };
}

// Present, because this route is a guild-scoped write and now sits behind the presence gate. What
// it answers for a server Proton has left is guild-write-presence.test.ts's subject.
const HERE = {
  presence: (ids: readonly string[]) => Promise.resolve({ present: [...ids], known: true }),
};

function appWith(bus?: EventBus) {
  const verification = new VerificationService({ ...(bus ? { bus } : {}), now: () => NOW });

  return createApiApp({
    verification,
    guilds: HERE,
    sharedSecret: SECRET,
  } as unknown as ApiDeps);
}

const NO_SECRET = Symbol('no secret');

function post(
  app: ReturnType<typeof createApiApp>,
  path: string,
  body: unknown,
  secret: string | typeof NO_SECRET = SECRET,
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === NO_SECRET ? {} : { 'x-proton-secret': secret }),
    },
    body: JSON.stringify(body),
  });
}

const PASSED = `/guilds/${GUILD}/verification/passed`;

describe('POST /guilds/:guildId/verification/passed', () => {
  test('publishes the pass with the moment it was recorded', async () => {
    const { bus, published } = collecting();
    const response = await post(appWith(bus), PASSED, { userId: MEMBER, jti: 'abc123' });

    expect(response.status).toBe(200);
    expect(published[0]).toMatchObject({
      type: 'verification.web_passed',
      guildId: GUILD,
      payload: { guildId: GUILD, userId: MEMBER, jti: 'abc123', verifiedAt: NOW },
    });
  });

  test('answers with the request id it published under', async () => {
    const { bus, published } = collecting();
    const body = (await (
      await post(appWith(bus), PASSED, { userId: MEMBER, jti: 'abc123' })
    ).json()) as { requestId: string };

    expect(body.requestId).toBeTruthy();
    expect(published[0]?.id).toContain(body.requestId);
  });

  // A 200 here would tell the website the member was verified when the worker was never told.
  test('refuses with a reason naming the fix when the bus is unreachable', async () => {
    const response = await post(appWith(), PASSED, { userId: MEMBER, jti: 'abc123' });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'bus_unavailable',
      message: expect.stringContaining('REDIS_URL'),
    });
  });

  test('refuses a body carrying no user', async () => {
    const { bus, published } = collecting();

    expect((await post(appWith(bus), PASSED, { jti: 'abc123' })).status).toBe(400);
    expect(published).toHaveLength(0);
  });

  test('is behind the shared secret', async () => {
    const { bus } = collecting();

    expect(
      (await post(appWith(bus), PASSED, { userId: MEMBER, jti: 'abc' }, NO_SECRET)).status,
    ).toBe(401);
  });
});

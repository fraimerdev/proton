import { describe, expect, test } from 'bun:test';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';

const SECRET = 'shared-secret-for-tests';
const JOINED = '900000000000000001';
const LEFT = '900000000000000002';
const MEMBER = '400000000000000001';

interface Harness {
  app: ReturnType<typeof createApiApp>;
  asked: string[][];
  wrote: string[];
  warnings: string[];
}

function harness(options: { present?: readonly string[]; known?: boolean } = {}): Harness {
  const present = options.present ?? [JOINED];
  const known = options.known ?? true;

  const asked: string[][] = [];
  const wrote: string[] = [];
  const warnings: string[] = [];

  const deps = {
    guilds: {
      presence: (ids: readonly string[]) => {
        asked.push([...ids]);

        return Promise.resolve(
          known
            ? { present: ids.filter((id) => present.includes(id)), known: true }
            : { present: [], known: false },
        );
      },
      ensureGuild: () => {
        wrote.push('ensureGuild');
        return Promise.resolve();
      },
      markLeft: () => {
        wrote.push('markLeft');
        return Promise.resolve();
      },
    },
    modules: {
      enabledMap: () => Promise.resolve({}),
      update: () => {
        wrote.push('modules.update');
        return Promise.resolve({ moduleId: 'automod', before: null, after: null });
      },
    },
    verification: {
      recordWebPass: () => {
        wrote.push('verification.recordWebPass');
        return Promise.resolve({ requestId: 'req_1' });
      },
    },
    branding: {
      upload: () => {
        wrote.push('branding.upload');
        return Promise.resolve({ ok: true });
      },
      clear: () => {
        wrote.push('branding.clear');
        return Promise.resolve();
      },
    },
    registry: { all: () => [] },
    logger: {
      warn: (...parts: unknown[]) => {
        warnings.push(parts.map(String).join(' '));
      },
    },
    sharedSecret: SECRET,
  } as unknown as ApiDeps;

  return { app: createApiApp(deps), asked, wrote, warnings };
}

function send({ app }: Harness, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-proton-secret': SECRET,
      'x-proton-actor': MEMBER,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const saveConfig = (h: Harness, guildId: string) =>
  send(h, 'POST', `/guilds/${guildId}/modules/automod`, { actorId: MEMBER, enabled: true });

describe('the presence gate on guild writes', () => {
  test('refuses a config write for a server Discord says Proton is not in', async () => {
    const h = harness({ present: [JOINED] });
    const response = await saveConfig(h, LEFT);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'bot_absent' });
    expect(h.wrote).toEqual([]);
  });

  // The refusal and the outage are different states with different fixes, and an admin who cannot
  // tell them apart will keep pressing save. This copy has to name Discord as having answered.
  test('the refusal says Discord was asked, not that Proton could not check', async () => {
    const body = (await (await saveConfig(harness(), LEFT)).json()) as { message: string };

    expect(body.message).toContain('Discord says Proton is not in this server');
    expect(body.message).toContain('Invite Proton back');
    expect(body.message).not.toMatch(/could not (check|reach|ask)/i);
  });

  // The dashboard turns an api message into "Could not save: …" unless it reads as an access
  // error, in which case it substitutes "your sign-in has expired" and loses the real reason.
  test('the refusal does not read as a revoked sign-in', async () => {
    const body = (await (await saveConfig(harness(), LEFT)).json()) as { message: string };

    expect(body.message).not.toMatch(
      /forbidden|not signed in|do not administer|lack the required permission/i,
    );
  });

  test('a write for a server Discord confirms goes through', async () => {
    const h = harness({ present: [JOINED] });

    expect((await saveConfig(h, JOINED)).status).toBe(200);
    expect(h.wrote).toEqual(['modules.update']);
  });

  test('it asks about the guild in the path and no other', async () => {
    const h = harness();
    await saveConfig(h, JOINED);

    expect(h.asked).toEqual([[JOINED]]);
  });

  test('every guild-scoped write is behind it, not only module config', async () => {
    const h = harness({ present: [JOINED] });

    const verification = await send(h, 'POST', `/guilds/${LEFT}/verification/passed`, {
      userId: MEMBER,
      jti: 'abc123',
    });
    const upload = await send(h, 'PUT', `/guilds/${LEFT}/branding/banner`, { bytes: 'x' });
    const clear = await send(h, 'DELETE', `/guilds/${LEFT}/branding/banner`);

    expect([verification.status, upload.status, clear.status]).toEqual([409, 409, 409]);
    expect(h.wrote).toEqual([]);
  });
});

describe('what the gate deliberately lets past', () => {
  // The whole point of the read path: the page for a server Proton has left has to load far enough
  // to say so. Gating reads here would answer that page with a 409 it has nothing to render.
  test('reads are never gated, not even for an absent server', async () => {
    const h = harness({ present: [] });
    const response = await send(h, 'GET', `/guilds/${LEFT}/modules`);

    expect(response.status).toBe(200);
    expect(h.asked).toEqual([]);
  });

  test('the presence question itself is not gated', async () => {
    const h = harness({ present: [] });
    const response = await send(h, 'POST', '/guilds/presence', { ids: [LEFT] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ present: [], known: true });
  });

  // Recording a leave is the one write that is correct precisely because Proton is not in the
  // guild. Gating it would leave the row that started this whole problem uncorrectable.
  test('the gateway can still record joining and leaving a server Proton is not in', async () => {
    const h = harness({ present: [] });

    const joined = await send(h, 'PUT', `/guilds/${LEFT}`, { name: 'Somewhere' });
    const left = await send(h, 'DELETE', `/guilds/${LEFT}`);

    expect([joined.status, left.status]).toEqual([200, 200]);
    expect(h.wrote).toEqual(['ensureGuild', 'markLeft']);
  });
});

describe('when Discord could not be asked', () => {
  // Refusing here would make every server on the deployment read-only for the length of a Discord
  // outage, to prevent a config row that is inert until the bot is back. The route loader already
  // made this call for the page; the write path makes the same one.
  test('the write is allowed through rather than refused', async () => {
    const h = harness({ known: false });
    const response = await saveConfig(h, JOINED);

    expect(response.status).toBe(200);
    expect(h.wrote).toEqual(['modules.update']);
  });

  test('an unknown answer is not read as absence, even for a server Proton has left', async () => {
    const h = harness({ present: [], known: false });

    expect((await saveConfig(h, LEFT)).status).toBe(200);
  });

  test('it says in the log which guild went unverified and what was let through', async () => {
    const h = harness({ known: false });
    await saveConfig(h, JOINED);

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain(JOINED);
    expect(h.warnings[0]).toContain('POST');
    expect(h.warnings[0]).toContain('unverified');
  });

  test('a confirmed presence is not logged as an unverified write', async () => {
    const h = harness({ present: [JOINED] });
    await saveConfig(h, JOINED);

    expect(h.warnings).toEqual([]);
  });
});

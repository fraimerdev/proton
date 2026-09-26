import { describe, expect, test } from 'bun:test';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';

const SECRET = 'shared-secret-for-tests';
const JOINED = '900000000000000001';
const LEFT = '900000000000000002';
const MEMBER = '400000000000000001';

interface Options {
  present?: readonly string[];
  known?: boolean;
  recorded?: readonly string[];
}

function harness(options: Options = {}) {
  const present = options.present ?? [JOINED];
  const known = options.known ?? true;
  const recorded = options.recorded ?? [JOINED];

  const reached: string[] = [];
  const warnings: string[] = [];

  const deps = {
    guilds: {
      presence: (ids: readonly string[]) =>
        Promise.resolve(
          known
            ? { present: ids.filter((id) => present.includes(id)), known: true }
            : { present: [], known: false },
        ),
      recordedPresent: (guildId: string) => Promise.resolve(recorded.includes(guildId)),
    },
    modules: {
      update: () => {
        reached.push('modules.update');
        return Promise.resolve({ moduleId: 'automod', before: null, after: null });
      },
    },
    verification: {
      recordWebPass: () => {
        reached.push('verification.recordWebPass');
        return Promise.resolve({ requestId: 'req_1' });
      },
    },
    appeals: {
      form: () => {
        reached.push('appeals.form');
        return Promise.resolve({ guildId: JOINED, view: { state: 'closed', humanReason: 'x' } });
      },
      submit: () => {
        reached.push('appeals.submit');
        return Promise.resolve({ number: 1, requestId: 'req_2' });
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

  return { app: createApiApp(deps), reached, warnings };
}

type Harness = ReturnType<typeof harness>;

function post({ app }: Harness, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-proton-secret': SECRET },
    body: JSON.stringify(body),
  });
}

const claims = (guildId: string) => ({
  purpose: 'appeal',
  guildId,
  userId: MEMBER,
  panelId: 'default',
  origin: 'ban',
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_702_592_000_000,
  jti: 'abc123',
});

const verify = (h: Harness, guildId: string) =>
  post(h, `/guilds/${guildId}/verification/passed`, { userId: MEMBER, jti: 'abc123' });

const openAppeal = (h: Harness, guildId: string) =>
  post(h, `/guilds/${guildId}/appeals/form`, { claims: claims(guildId) });

const submitAppeal = (h: Harness, guildId: string) =>
  post(h, `/guilds/${guildId}/appeals/submit`, { claims: claims(guildId), answers: {} });

const saveConfig = (h: Harness, guildId: string) =>
  post(h, `/guilds/${guildId}/modules/automod`, { actorId: MEMBER, enabled: true });

describe('web links for a server Proton has left', () => {
  test('a verify link is refused before anything is published', async () => {
    const h = harness({ present: [JOINED] });
    const response = await verify(h, LEFT);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'guild_left' });
    expect(h.reached).toEqual([]);
  });

  test('an appeal link is refused both when opened and when sent', async () => {
    const h = harness({ present: [JOINED] });

    const opened = await openAppeal(h, LEFT);
    const sent = await submitAppeal(h, LEFT);

    expect([opened.status, sent.status]).toEqual([409, 409]);
    expect(h.reached).toEqual([]);
  });

  // A link holder is a member who cannot invite Proton back and never saw a settings form.
  test('the refusal speaks to the member holding the link, not to an admin', async () => {
    const body = (await (await verify(harness(), LEFT)).json()) as { message: string };

    expect(body.message).toContain('Proton is no longer in this server');
    expect(body.message).toContain('Nothing was sent');
    expect(body.message).not.toContain('Invite Proton back');
  });

  test('a settings write is still refused with the admin wording', async () => {
    const response = await saveConfig(harness(), LEFT);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'bot_absent' });
  });

  test('links for a server Proton is in go through', async () => {
    const h = harness({ present: [JOINED] });

    const statuses = [
      (await verify(h, JOINED)).status,
      (await openAppeal(h, JOINED)).status,
      (await submitAppeal(h, JOINED)).status,
    ];

    expect(statuses).toEqual([200, 200, 200]);
    expect(h.reached).toEqual(['verification.recordWebPass', 'appeals.form', 'appeals.submit']);
  });
});

describe('when Discord could not be asked', () => {
  test('a link for a server recorded as left is refused on that record', async () => {
    const h = harness({ known: false, recorded: [JOINED] });

    const responses = [await verify(h, LEFT), await openAppeal(h, LEFT)];

    expect(responses.map((r) => r.status)).toEqual([409, 409]);
    expect(h.reached).toEqual([]);
  });

  test('a link for a server still recorded as joined goes through, with a warning', async () => {
    const h = harness({ known: false, recorded: [JOINED] });

    expect((await verify(h, JOINED)).status).toBe(200);
    expect(h.reached).toEqual(['verification.recordWebPass']);
    expect(h.warnings).toHaveLength(1);
  });

  test('a link for a server with no record at all is refused', async () => {
    const h = harness({ known: false, recorded: [] });

    expect((await openAppeal(h, JOINED)).status).toBe(409);
  });

  test('settings writes keep the old rule and are not refused on the record', async () => {
    const h = harness({ known: false, recorded: [] });

    expect((await saveConfig(h, LEFT)).status).toBe(200);
    expect(h.reached).toEqual(['modules.update']);
  });
});

test('a server Discord confirms is not refused because the record says it left', async () => {
  const h = harness({ present: [JOINED], recorded: [] });

  expect((await verify(h, JOINED)).status).toBe(200);
});

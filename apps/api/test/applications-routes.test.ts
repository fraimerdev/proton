import { describe, expect, test } from 'bun:test';
import {
  applicationDetailSchema,
  myApplicationsSchema,
  portalApplicationSchema,
  queueResultSchema,
  staffActionResultSchema,
} from '@proton/module-applications/view';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import { PortalService } from '../src/applications/portal.ts';
import { ApplicationsService } from '../src/applications/service.ts';
import {
  ACCESS_WORDS,
  ADMIN,
  APPLICANT,
  auditLookupOf,
  EXPORT_ROLE,
  GUILD,
  type Harness,
  harnessParts,
  NOW,
  OTHER_GUILD,
  REVIEW_CHANNEL,
  REVIEWER,
  REVIEWER_ROLE,
  SECRET,
  seedSubmitted,
} from './application-fixtures.ts';

const NOTE_TEXT = 'Private: I know them from another server, they were great there.';

const HERE = {
  presence: (ids: readonly string[]) => Promise.resolve({ present: [...ids], known: true }),
};

const GONE = {
  presence: () => Promise.resolve({ present: [], known: true }),
};

const NO_SECRET = Symbol('no secret');

function build(h: Harness, guilds: unknown = HERE) {
  const logger = { error: () => undefined, warn: () => undefined };

  const applications = new ApplicationsService({
    store: h.store,
    modules: h.modules,
    members: h.members,
    providers: h.providers,
    audit: async (entry) => {
      h.audits.push(JSON.parse(JSON.stringify(entry)));
    },
    audits: auditLookupOf(h.store),
    bus: h.bus,
    logger,
    now: () => NOW,
  });

  const applicationPortal = new PortalService({
    store: h.store,
    modules: h.modules,
    members: h.members,
    providers: h.providers,
    bus: h.bus,
    logger,
    now: () => NOW,
  });

  return createApiApp({
    guilds,
    applications,
    applicationPortal,
    sharedSecret: SECRET,
    logger,
  } as unknown as ApiDeps);
}

function send(
  app: ReturnType<typeof createApiApp>,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; secret?: string | typeof NO_SECRET } = {},
) {
  const secret = options.secret ?? SECRET;

  return app.request(path, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(secret === NO_SECRET ? {} : { 'x-proton-secret': secret }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const STAFF = `/guilds/${GUILD}/applications`;
const PORTAL = `/guilds/${GUILD}/application-portal`;

function actionBody(action: Record<string, unknown>, actorId = REVIEWER) {
  return { source: 'dashboard', actorId, ...action };
}

const ROUTES: Array<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'GET', path: `${STAFF}/forms` },
  { method: 'POST', path: `${STAFF}/forms/mods/publish` },
  { method: 'GET', path: `${STAFF}/forms/mods/versions` },
  { method: 'GET', path: `${STAFF}/forms/mods/versions/version-01-mods-1` },
  { method: 'GET', path: `${STAFF}/forms/mods/eligibility?userId=${APPLICANT}` },
  { method: 'GET', path: `${STAFF}/audience/${REVIEW_CHANNEL}` },
  { method: 'GET', path: `${STAFF}/queue?viewerId=${REVIEWER}` },
  { method: 'GET', path: `${STAFF}/summary?viewerId=${REVIEWER}` },
  { method: 'GET', path: `${STAFF}/export?viewerId=${REVIEWER}` },
  { method: 'GET', path: `${STAFF}/members?viewerId=${REVIEWER}&ids=${APPLICANT}` },
  { method: 'POST', path: `${STAFF}/applicants/${APPLICANT}/delete` },
  { method: 'GET', path: `${STAFF}/app-1?viewerId=${REVIEWER}` },
  { method: 'POST', path: `${STAFF}/app-1/actions` },
  { method: 'GET', path: `${PORTAL}/forms?userId=${APPLICANT}` },
  { method: 'GET', path: `${PORTAL}/forms/mods?userId=${APPLICANT}` },
  { method: 'POST', path: `${PORTAL}/forms/mods/draft` },
  { method: 'POST', path: `${PORTAL}/forms/mods/submit` },
  { method: 'POST', path: `${PORTAL}/forms/mods/discard` },
  { method: 'GET', path: `${PORTAL}/applications/app-1?userId=${APPLICANT}` },
  { method: 'POST', path: `${PORTAL}/applications/app-1/withdraw` },
  { method: 'POST', path: `${PORTAL}/applications/app-1/respond` },
  { method: 'GET', path: `/applicants/${APPLICANT}/applications` },
];

describe('the shared secret', () => {
  test('every Applications route answers 401 without it, before anything is read', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const app = build(h);

    for (const route of ROUTES) {
      for (const secret of [NO_SECRET, 'wrong-secret-value'] as const) {
        const response = await send(app, route.path, {
          method: route.method,
          body: route.method === 'POST' ? {} : undefined,
          secret,
        });
        expect({ route: route.path, status: response.status }).toEqual({
          route: route.path,
          status: 401,
        });
      }
    }

    expect(h.members.reads).toEqual([]);
    expect(h.modules.reads).toEqual([]);
  });

  test('the cross-server list answers with the secret and checks the user id', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    seedSubmitted(h.store, { id: 'there', guildId: OTHER_GUILD });
    const app = build(h);

    const response = await send(app, `/applicants/${APPLICANT}/applications`);
    expect(response.status).toBe(200);
    expect(myApplicationsSchema.parse(await response.json()).items).toHaveLength(2);

    expect((await send(app, '/applicants/not-a-user/applications')).status).toBe(400);
  });
});

describe('staff routes', () => {
  test('the queue parses with the shared schema and needs a viewer', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const app = build(h);

    const response = await send(app, `${STAFF}/queue?viewerId=${REVIEWER}&view=all`);
    expect(response.status).toBe(200);
    expect(queueResultSchema.parse(await response.json()).items).toHaveLength(1);

    const missing = await send(app, `${STAFF}/queue`);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe('invalid_query');
  });

  test('another server’s application is a 404, and so is your own', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    seedSubmitted(h.store, { id: 'own', number: 2, applicantId: REVIEWER });
    const app = build(h);

    const elsewhere = await send(
      app,
      `/guilds/${OTHER_GUILD}/applications/app-1?viewerId=${REVIEWER}`,
    );
    expect(elsewhere.status).toBe(404);

    const own = await send(app, `${STAFF}/own?viewerId=${REVIEWER}`);
    expect(own.status).toBe(404);

    const act = await send(app, `${STAFF}/own/actions`, {
      method: 'POST',
      body: actionBody({ action: 'claim', requestId: 'req_claim_0001' }),
    });
    expect(act.status).toBe(404);
  });

  test('detail parses with the shared schema', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const app = build(h);

    const response = await send(app, `${STAFF}/app-1?viewerId=${REVIEWER}`);
    expect(response.status).toBe(200);
    expect(applicationDetailSchema.parse(await response.json()).application.id).toBe('app-1');
  });

  test('a malformed action is a 400 before anything is read', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const app = build(h);

    for (const body of [
      actionBody({ action: 'claim' }),
      actionBody({ action: 'note', body: '', requestId: 'req_note_00001' }),
      actionBody({ action: 'delete', requestId: 'req_delete_001' }),
      { action: 'claim', requestId: 'req_claim_0001', actorId: REVIEWER, source: 'command' },
    ]) {
      const response = await send(app, `${STAFF}/app-1/actions`, { method: 'POST', body });
      expect(response.status).toBe(400);
    }
    expect(h.members.reads).toEqual([]);
  });

  test('a removed reviewer is refused on the next action', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const app = build(h);

    const first = await send(app, `${STAFF}/app-1/actions`, {
      method: 'POST',
      body: actionBody({ action: 'claim', requestId: 'req_claim_0001' }),
    });
    expect(staffActionResultSchema.parse(await first.json()).ok).toBe(true);

    h.members.roleIds.set(REVIEWER, []);
    const next = await send(app, `${STAFF}/app-1/actions`, {
      method: 'POST',
      body: actionBody({ action: 'unclaim', requestId: 'req_unclaim_01' }),
    });
    expect(next.status).toBe(400);
    const refusal = (await next.json()) as { error: string; message: string };
    expect(refusal.error).toBe('not_allowed');
    expect(refusal.message).not.toMatch(ACCESS_WORDS);
  });

  test('module off: actions are refused with 409, reads still answer', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    h.modules.enabled = false;
    const app = build(h);

    const act = await send(app, `${STAFF}/app-1/actions`, {
      method: 'POST',
      body: actionBody({ action: 'claim', requestId: 'req_claim_0001' }),
    });
    expect(act.status).toBe(409);
    expect(await act.json()).toEqual({
      error: 'module_disabled',
      message:
        'Applications is off in this server, so nothing was changed. Turn it on to review again.',
    });

    expect((await send(app, `${STAFF}/queue?viewerId=${REVIEWER}`)).status).toBe(200);
    expect((await send(app, `${STAFF}/app-1?viewerId=${REVIEWER}`)).status).toBe(200);
  });

  test('audit rows keep the note’s length and never its text', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const app = build(h);

    await send(app, `${STAFF}/app-1/actions`, {
      method: 'POST',
      body: actionBody({ action: 'note', body: NOTE_TEXT, requestId: 'req_note_00001' }),
    });

    const audit = h.store.auditRows.get(`applications.note:${GUILD}:req_note_00001`);
    expect(audit?.after).toEqual({
      action: 'note',
      requestId: 'req_note_00001',
      length: NOTE_TEXT.length,
    });
    expect(JSON.stringify([...h.store.auditRows.values()])).not.toContain(NOTE_TEXT);
    expect(JSON.stringify(h.store.eventsOf('app-1'))).not.toContain(NOTE_TEXT);
    expect(JSON.stringify(h.bus.events)).not.toContain(NOTE_TEXT);
  });

  test('when Proton has left the server, actions say nothing was done', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const app = build(h, GONE);

    const response = await send(app, `${STAFF}/app-1/actions`, {
      method: 'POST',
      body: actionBody({ action: 'claim', requestId: 'req_claim_0001' }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toContain(
      'so nothing was done',
    );

    const portal = await send(app, `${PORTAL}/applications/app-1/withdraw`, {
      method: 'POST',
      body: { userId: APPLICANT, requestId: 'req_withdraw_1' },
    });
    expect(portal.status).toBe(409);
    expect(((await portal.json()) as { error: string }).error).toBe('guild_left');
  });

  test('the export is a download that says how many rows it holds', async () => {
    const h = harnessParts();
    seedSubmitted(h.store, { applicantName: '@everyone +1' });
    h.members.roleIds.set(REVIEWER, [REVIEWER_ROLE, EXPORT_ROLE]);
    const app = build(h);

    const response = await send(app, `${STAFF}/export?viewerId=${REVIEWER}&format=csv&formId=mods`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="applications-900000000000000001-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(response.headers.get('x-proton-export-rows')).toBe('1');
    expect(response.headers.get('x-proton-export-truncated')).toBe('0');
    expect(await response.text()).toContain(",'@everyone +1,");

    const refused = await send(app, `${STAFF}/export?viewerId=${ADMIN}&formId=nope`);
    expect(refused.status).toBe(404);
  });
});

describe('portal routes', () => {
  test('the applicant view never carries notes', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const app = build(h);

    await send(app, `${STAFF}/app-1/actions`, {
      method: 'POST',
      body: actionBody({ action: 'note', body: NOTE_TEXT, requestId: 'req_note_00001' }),
    });

    const response = await send(app, `${PORTAL}/applications/app-1?userId=${APPLICANT}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(portalApplicationSchema.parse(JSON.parse(text)).id).toBe('app-1');
    expect(text).not.toContain(NOTE_TEXT);
    expect(text).not.toContain(REVIEWER);
  });

  test('a draft save round-trips through the route', async () => {
    const h = harnessParts();
    const app = build(h);

    const response = await send(app, `${PORTAL}/forms/mods/draft`, {
      method: 'POST',
      body: {
        userId: APPLICANT,
        answers: { why: 'Because' },
        expectedRevision: null,
        requestId: 'req_save_0001',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'saved', revision: 1, savedAt: NOW });
  });

  test('someone else’s application is a 404', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const app = build(h);

    expect((await send(app, `${PORTAL}/applications/app-1?userId=${REVIEWER}`)).status).toBe(404);
  });
});

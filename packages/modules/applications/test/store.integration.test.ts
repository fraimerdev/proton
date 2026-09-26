import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type ApplicationLifecycleEvent,
  type ApplicationStatus,
  moduleScheduleKey,
} from '@proton/core';
import {
  auditTrail,
  createDb,
  type DbHandle,
  guilds,
  runMigrations,
  scheduledActions,
} from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { applicationsConfigSchema } from '../src/config.ts';
import { planEffects } from '../src/effects.ts';
import { DrizzleApplicationStore, pgErrorCode } from '../src/postgres-store.ts';
import type {
  ApplicationRecord,
  AuditInput,
  EffectRecord,
  ListQuery,
  SubmitInput,
  SubmitLimits,
  TransitionInput,
} from '../src/store.ts';
import { wakeSlot } from '../src/store.ts';
import { applicationEffects, applicationEvents, applications } from '../src/table.ts';
import { snapshotOf } from '../src/version.ts';
import { queueQuerySchema } from '../src/view.ts';
import { describeStoreBookkeeping } from './store-contract.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleApplicationStore;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const CHANNEL = '300000000000000001';
const ROLE = '200000000000000001';
const REVIEWER = '100000000000000001';
const OTHER_REVIEWER = '100000000000000002';
const APPLICANT = '400000000000000001';
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0, 123);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LEASE = MINUTE;
const PENDING: ApplicationStatus[] = ['submitted', 'in_review', 'needs_info', 'waitlisted'];

const LOOSE: SubmitLimits = { cooldownDays: 0, maxActive: 5 };

const config = applicationsConfigSchema.parse({
  reviewChannelId: CHANNEL,
  forms: [
    {
      id: 'mods',
      name: 'Moderator Application',
      sections: [
        {
          id: 'about',
          questions: [{ id: 'why', type: 'paragraph', label: 'Why do you want to help?' }],
        },
      ],
      actions: { onSubmit: { addRoleIds: [ROLE] } },
    },
  ],
});

const form = (() => {
  const first = config.forms[0];
  if (first === undefined) throw new Error('the test form did not parse');
  return first;
})();

const ANSWERS = [
  {
    questionId: 'why',
    sectionId: 'about',
    label: 'Why do you want to help?',
    type: 'paragraph' as const,
    value: 'I like helping people',
    display: 'I like helping people',
  },
];

let sequence = 0;

function applicantId(index: number): string {
  return `4000000000000001${String(index).padStart(2, '0')}`;
}

function audit(action: string, guildId = GUILD): AuditInput {
  sequence += 1;
  return {
    actorId: REVIEWER,
    source: 'dashboard',
    action: `module.applications.${action}`,
    id: `applications.${action}:${guildId}:request-${sequence}`,
  };
}

async function publish(guildId = GUILD) {
  return store.publish({
    guildId,
    formId: form.id,
    snapshot: snapshotOf(form),
    draftPolicy: 'keep',
    publishedBy: REVIEWER,
    audit: audit('publish', guildId),
    now: NOW,
  });
}

async function draft(applicant = APPLICANT, guildId = GUILD, at = NOW): Promise<ApplicationRecord> {
  const published = await store.latestVersions(guildId);
  const version = published.get(form.id) ?? (await publish(guildId)).version;

  const started = await store.startDraft({
    guildId,
    formId: form.id,
    versionId: version.id,
    applicantId: applicant,
    applicantName: `name ${applicant.slice(-2)}`,
    expiresAt: at + 30 * DAY,
    source: 'discord',
    now: at,
  });
  return started.application;
}

function submitInput(
  application: ApplicationRecord,
  overrides: Partial<SubmitInput> = {},
): SubmitInput {
  return {
    guildId: application.guildId,
    applicationId: application.id,
    applicantId: application.applicantId,
    expectedRevision: application.revision,
    answers: ANSWERS,
    source: 'discord',
    applicantName: application.applicantName,
    limits: LOOSE,
    reviewDueAt: null,
    plan: (next, revision) =>
      planEffects('applications.submitted', {
        config,
        form,
        application: next,
        revision,
        now: NOW,
      }),
    lifecycle: {
      guildId: application.guildId,
      applicationId: application.id,
      formId: form.id,
      formName: form.name,
      versionId: application.versionId,
      applicantId: application.applicantId,
      actorId: application.applicantId,
    },
    now: NOW,
    ...overrides,
  };
}

async function submitted(
  applicant = APPLICANT,
  guildId = GUILD,
  overrides: Partial<SubmitInput> = {},
): Promise<ApplicationRecord> {
  const started = await draft(applicant, guildId, overrides.now ?? NOW);
  const result = await store.submit(submitInput(started, overrides));
  if (result.status !== 'submitted') throw new Error(`expected submitted, got ${result.code}`);
  return result.application;
}

function decision(
  application: ApplicationRecord,
  choice: 'accept' | 'reject',
  reviewer: string,
  at = NOW + MINUTE,
): TransitionInput {
  const status = choice === 'accept' ? 'accepted' : 'rejected';
  const lifecycle: ApplicationLifecycleEvent =
    choice === 'accept' ? 'applications.accepted' : 'applications.rejected';

  return {
    guildId: application.guildId,
    applicationId: application.id,
    action: choice,
    actor: { id: reviewer, source: 'discord' },
    expect: { statuses: PENDING },
    patch: {
      status,
      decidedAt: at,
      decidedBy: reviewer,
      decisionReason: 'Thanks for applying',
      contentPurgeAt: at + 30 * DAY,
    },
    thread: { kind: 'decision', body: 'Thanks for applying' },
    event: { kind: status, lifecycle },
    plan: (next, revision) =>
      planEffects(lifecycle, {
        config,
        form,
        application: next,
        revision,
        now: at,
        actorId: reviewer,
      }),
    now: at,
  };
}

function claim(application: ApplicationRecord, reviewer: string): TransitionInput {
  return {
    guildId: application.guildId,
    applicationId: application.id,
    action: 'claim',
    actor: { id: reviewer, source: 'dashboard' },
    expect: { statuses: ['submitted'], assigneeId: null },
    patch: { status: 'in_review', assigneeId: reviewer, assignedAt: NOW, reviewStartedAt: NOW },
    event: { kind: 'claimed', lifecycle: 'applications.review_started' },
    plan: (next, revision) =>
      planEffects('applications.review_started', {
        config,
        form,
        application: next,
        revision,
        now: NOW,
        actorId: reviewer,
      }),
    now: NOW,
  };
}

function note(application: ApplicationRecord, body: string, requestAudit?: AuditInput, at = NOW) {
  return store.transition({
    guildId: application.guildId,
    applicationId: application.id,
    action: 'note',
    actor: { id: REVIEWER, source: 'dashboard' },
    expect: {},
    patch: {},
    note: { body },
    event: { kind: 'note', data: { length: body.length } },
    bumpRevision: false,
    ...(requestAudit === undefined ? {} : { audit: requestAudit }),
    now: at,
  });
}

function listQuery(overrides: Record<string, unknown> = {}, viewerId = REVIEWER): ListQuery {
  return { ...queueQuerySchema.parse(overrides), formIds: [form.id], viewerId };
}

async function effectsOf(applicationId: string): Promise<EffectRecord[]> {
  const detail = await store.detail(GUILD, applicationId);
  return detail?.effects ?? [];
}

async function effect(applicationId: string, key: string): Promise<EffectRecord> {
  const found = (await effectsOf(applicationId)).find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no effect ${key}`);
  return found;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleApplicationStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);
});

describe('versions', () => {
  test('publishing numbers versions per form, and an unchanged form publishes nothing', async () => {
    const first = await publish();
    expect(first).toMatchObject({ status: 'published', draftsExpired: 0 });
    expect(first.version).toMatchObject({ version: 1, formId: 'mods', publishedAt: NOW });
    expect(first.version.snapshot).toEqual(snapshotOf(form));

    const again = await publish();
    expect(again.status).toBe('unchanged');
    expect(again.version.id).toBe(first.version.id);

    const changed = await store.publish({
      guildId: GUILD,
      formId: form.id,
      snapshot: { ...snapshotOf(form), intro: 'New intro' },
      draftPolicy: 'keep',
      publishedBy: REVIEWER,
      audit: audit('publish'),
      now: NOW + MINUTE,
    });
    expect(changed).toMatchObject({ status: 'published', version: { version: 2 } });

    expect((await store.versions(GUILD, form.id)).map((version) => version.version)).toEqual([
      2, 1,
    ]);
    expect((await store.latestVersions(GUILD)).get(form.id)?.id).toBe(changed.version.id);
    expect(await store.version(GUILD, first.version.id)).toMatchObject({ version: 1 });
    expect(await store.version(OTHER_GUILD, first.version.id)).toBeNull();

    const audits = await handle.db.select().from(auditTrail).where(eq(auditTrail.guildId, GUILD));
    expect(audits).toHaveLength(2);
  });

  test('restart expires drafts pinned to older versions, keep leaves them', async () => {
    const kept = await draft(applicantId(1));
    const restarted = await draft(applicantId(2));

    const second = await store.publish({
      guildId: GUILD,
      formId: form.id,
      snapshot: { ...snapshotOf(form), intro: 'Second' },
      draftPolicy: 'keep',
      publishedBy: REVIEWER,
      audit: audit('publish'),
      now: NOW,
    });
    expect(second.draftsExpired).toBe(0);
    expect(await store.draftCount(GUILD, form.id)).toBe(2);
    expect(await store.draftCount(GUILD, form.id, second.version.id)).toBe(2);

    const third = await store.publish({
      guildId: GUILD,
      formId: form.id,
      snapshot: { ...snapshotOf(form), intro: 'Third' },
      draftPolicy: 'restart',
      publishedBy: REVIEWER,
      audit: audit('publish'),
      now: NOW,
    });
    expect(third).toMatchObject({ status: 'published', draftsExpired: 2 });

    for (const old of [kept, restarted]) {
      const row = await store.get(GUILD, old.id);
      expect(row).toMatchObject({
        status: 'expired',
        draft: {},
        number: null,
        applicantName: null,
        contentPurgedAt: NOW,
      });
    }
    expect(await store.draftFor(GUILD, form.id, applicantId(1))).toBeNull();

    const fresh = await draft(applicantId(1));
    expect(fresh.versionId).toBe(third.version.id);

    expect(await store.submit(submitInput(kept))).toMatchObject({
      status: 'refused',
      code: 'not_draft',
    });
  });
});

describe('drafts', () => {
  test('two starts at once make one draft', async () => {
    await publish();
    const [a, b] = await Promise.all([draft(), draft()]);

    expect(a.id).toBe(b.id);
    const rows = await handle.db
      .select()
      .from(applications)
      .where(and(eq(applications.guildId, GUILD), eq(applications.applicantId, APPLICANT)));
    expect(rows).toHaveLength(1);
  });

  test('a draft starts on the newest version whichever one the caller read', async () => {
    const first = await publish();
    const second = await store.publish({
      guildId: GUILD,
      formId: form.id,
      snapshot: { ...snapshotOf(form), intro: 'Newer' },
      draftPolicy: 'keep',
      publishedBy: REVIEWER,
      audit: audit('publish'),
      now: NOW,
    });

    const started = await store.startDraft({
      guildId: GUILD,
      formId: form.id,
      versionId: first.version.id,
      applicantId: APPLICANT,
      applicantName: null,
      expiresAt: NOW + DAY,
      source: 'web',
      now: NOW,
    });
    expect(started).toMatchObject({
      status: 'started',
      application: { versionId: second.version.id, status: 'draft', revision: 0, source: 'web' },
    });
  });

  test('the partial unique index refuses a second draft even around the store', async () => {
    const existing = await draft();

    const error = await handle.db
      .insert(applications)
      .values({
        id: 'duplicate-draft',
        guildId: GUILD,
        formId: form.id,
        versionId: existing.versionId,
        applicantId: APPLICANT,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(pgErrorCode(error)).toBe('23505');
  });

  test('saving checks the revision, merges or replaces, and refuses what is not a draft', async () => {
    const started = await draft();

    const saved = await store.saveDraft({
      guildId: GUILD,
      applicationId: started.id,
      applicantId: APPLICANT,
      expectedRevision: 0,
      answers: { why: 'first' },
      mode: 'merge',
      step: 1,
      expiresAt: NOW + 30 * DAY,
      now: NOW + SECOND,
    });
    expect(saved).toMatchObject({
      status: 'saved',
      application: { revision: 1, step: 1, draft: { why: 'first' }, updatedAt: NOW + SECOND },
    });

    const stale = await store.saveDraft({
      guildId: GUILD,
      applicationId: started.id,
      applicantId: APPLICANT,
      expectedRevision: 0,
      answers: { why: 'from another device' },
      mode: 'replace',
      expiresAt: NOW + 30 * DAY,
    });
    expect(stale).toMatchObject({
      status: 'conflict',
      application: { revision: 1, draft: { why: 'first' } },
    });

    const merged = await store.saveDraft({
      guildId: GUILD,
      applicationId: started.id,
      applicantId: APPLICANT,
      expectedRevision: null,
      answers: { extra: ['a', 'b'], agree: true },
      mode: 'merge',
      expiresAt: NOW + 30 * DAY,
    });
    expect(merged).toMatchObject({
      status: 'saved',
      application: {
        revision: 2,
        step: 1,
        draft: { why: 'first', extra: ['a', 'b'], agree: true },
      },
    });

    const replaced = await store.saveDraft({
      guildId: GUILD,
      applicationId: started.id,
      applicantId: APPLICANT,
      expectedRevision: 2,
      answers: { why: 'only this' },
      mode: 'replace',
      expiresAt: NOW + 30 * DAY,
    });
    expect(replaced.status === 'saved' && replaced.application.draft).toEqual({ why: 'only this' });

    const someoneElse = await store.saveDraft({
      guildId: GUILD,
      applicationId: started.id,
      applicantId: applicantId(9),
      expectedRevision: null,
      answers: {},
      mode: 'merge',
      expiresAt: NOW,
    });
    expect(someoneElse).toEqual({ status: 'gone' });
  });

  test('discarding deletes only the applicant’s own draft', async () => {
    const started = await draft();

    expect(await store.discardDraft(GUILD, started.id, applicantId(9))).toBe(false);
    expect(await store.discardDraft(GUILD, started.id, APPLICANT)).toBe(true);
    expect(await store.get(GUILD, started.id)).toBeNull();
  });

  test('idle drafts past their expiry are deleted and nothing else is', async () => {
    await publish();
    const idle = await draft(applicantId(1));
    const fresh = await store.startDraft({
      guildId: GUILD,
      formId: form.id,
      versionId: idle.versionId,
      applicantId: applicantId(2),
      applicantName: null,
      expiresAt: NOW + 60 * DAY,
      source: 'discord',
      now: NOW,
    });
    const sent = await submitted(applicantId(3));

    expect(await store.expireIdleDrafts(NOW + 31 * DAY, 100)).toBe(1);
    expect(await store.get(GUILD, idle.id)).toBeNull();
    expect(await store.get(GUILD, fresh.application.id)).not.toBeNull();
    expect(await store.get(GUILD, sent.id)).not.toBeNull();
  });
});

describe('submit', () => {
  test('numbers per server, freezes the answers and writes events, effects and a wake', async () => {
    const first = await submitted(applicantId(1));
    const second = await submitted(applicantId(2));
    const elsewhere = await submitted(applicantId(1), OTHER_GUILD);

    expect([first.number, second.number, elsewhere.number]).toEqual([1, 2, 1]);
    expect(first).toMatchObject({
      status: 'submitted',
      revision: 1,
      submittedAt: NOW,
      answers: ANSWERS,
      draft: {},
      expiresAt: null,
      source: 'discord',
    });

    const effects = await effectsOf(first.id);
    expect(effects.map((row) => row.key).sort()).toEqual(
      ['card', 'event:submitted:1', 'submitted:1:dm', `submitted:1:add_role:${ROLE}`].sort(),
    );
    expect(effects.every((row) => row.status === 'pending' && row.attempts === 0)).toBe(true);

    const event = effects.find((row) => row.kind === 'event');
    expect(event?.params).toEqual({
      type: 'applications.submitted',
      payload: {
        guildId: GUILD,
        applicationId: first.id,
        number: 1,
        formId: 'mods',
        formName: 'Moderator Application',
        versionId: first.versionId,
        applicantId: applicantId(1),
        actorId: applicantId(1),
        revision: 1,
        status: 'submitted',
        occurredAt: NOW,
      },
    });

    const detail = await store.detail(GUILD, first.id);
    expect(detail?.events.map((row) => [row.id, row.kind, row.fromStatus, row.toStatus])).toEqual([
      [`${first.id}:submitted:1`, 'submitted', 'draft', 'submitted'],
    ]);
    expect(detail?.events[0]?.data).toEqual({ answers: 1 });

    const slot = wakeSlot(NOW);
    const wakes = await handle.db
      .select()
      .from(scheduledActions)
      .where(eq(scheduledActions.guildId, GUILD));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      kind: 'module_job',
      runAt: new Date(slot),
      idempotencyKey: moduleScheduleKey('applications', 'sweep', GUILD, `wake:${slot}`),
      payload: {
        kind: 'module',
        moduleId: 'applications',
        jobId: 'sweep',
        guildId: GUILD,
        data: {},
      },
    });
  });

  test('a stale revision conflicts, and a second send finds the first', async () => {
    const started = await draft();

    expect(await store.submit(submitInput(started, { expectedRevision: 7 }))).toMatchObject({
      status: 'refused',
      code: 'conflict',
    });

    const sent = await store.submit(submitInput(started));
    expect(sent.status).toBe('submitted');

    expect(await store.submit(submitInput(started))).toMatchObject({
      status: 'refused',
      code: 'not_draft',
      existingId: started.id,
    });
  });

  test('the same draft sent twice at once is submitted once', async () => {
    const started = await draft();
    const results = await Promise.all([
      store.submit(submitInput(started)),
      store.submit(submitInput(started)),
    ]);

    expect(results.filter((result) => result.status === 'submitted')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'refused')).toEqual([
      expect.objectContaining({ code: 'not_draft', existingId: started.id }),
    ]);

    const rows = await handle.db
      .select()
      .from(applicationEffects)
      .where(eq(applicationEffects.applicationId, started.id));
    expect(rows).toHaveLength(4);
  });

  test('simultaneous submissions cannot pass the cap', async () => {
    await publish();
    const drafts = await Promise.all(
      Array.from({ length: 6 }, (_, index) => draft(applicantId(index))),
    );

    const results = await Promise.all(
      drafts.map((started) => store.submit(submitInput(started, { limits: { ...LOOSE, cap: 3 } }))),
    );

    expect(results.filter((result) => result.status === 'submitted')).toHaveLength(3);
    expect(results.filter((result) => result.status === 'refused')).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({ code: 'cap' })),
    );

    const rows = await handle.db
      .select({ number: applications.number })
      .from(applications)
      .where(eq(applications.guildId, GUILD));
    const numbers = rows
      .map((row) => row.number)
      .filter((number): number is number => number !== null)
      .sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3]);
  });

  test('one active application per form unless the form allows more', async () => {
    const first = await submitted();
    const next = await draft();

    expect(
      await store.submit(submitInput(next, { limits: { ...LOOSE, maxActive: 1 } })),
    ).toMatchObject({
      status: 'refused',
      code: 'active',
      existingId: first.id,
    });
    expect(
      (await store.submit(submitInput(next, { limits: { ...LOOSE, maxActive: 2 } }))).status,
    ).toBe('submitted');
  });

  test('the cooldown also spaces out applications that are still open', async () => {
    const first = await submitted();
    const next = await draft();
    const limits = { ...LOOSE, maxActive: 2, cooldownDays: 7 };

    expect(await store.submit(submitInput(next, { limits, now: NOW + DAY }))).toMatchObject({
      status: 'refused',
      code: 'cooldown',
      retryAt: (first.submittedAt ?? 0) + 7 * DAY,
    });
    expect((await store.submit(submitInput(next, { limits, now: NOW + 7 * DAY }))).status).toBe(
      'submitted',
    );
  });

  test('the cooldown runs from the last decision and withdrawals count', async () => {
    const first = await submitted();
    const decided = await store.transition(decision(first, 'reject', REVIEWER, NOW + HOUR));
    expect(decided.status).toBe('done');

    const next = await draft();
    expect(
      await store.submit(
        submitInput(next, { limits: { ...LOOSE, cooldownDays: 7 }, now: NOW + DAY }),
      ),
    ).toMatchObject({ status: 'refused', code: 'cooldown', retryAt: NOW + HOUR + 7 * DAY });

    const later = await store.submit(
      submitInput(next, { limits: { ...LOOSE, cooldownDays: 7 }, now: NOW + 8 * DAY }),
    );
    expect(later.status).toBe('submitted');
    if (later.status !== 'submitted') return;

    await store.transition({
      guildId: GUILD,
      applicationId: later.application.id,
      action: 'withdraw',
      actor: { id: APPLICANT, source: 'web' },
      expect: { statuses: PENDING },
      patch: { status: 'withdrawn', withdrawnAt: NOW + 9 * DAY },
      event: { kind: 'withdrawn', lifecycle: 'applications.withdrawn' },
      now: NOW + 9 * DAY,
    });

    const third = await draft();
    expect(
      await store.submit(
        submitInput(third, { limits: { ...LOOSE, cooldownDays: 7 }, now: NOW + 10 * DAY }),
      ),
    ).toMatchObject({ code: 'cooldown', retryAt: NOW + 16 * DAY });
  });
});

describe('transitions', () => {
  test('accept and reject at once: one wins and only its effects exist', async () => {
    const application = await submitted();

    const [accepted, rejected] = await Promise.all([
      store.transition(decision(application, 'accept', REVIEWER)),
      store.transition(decision(application, 'reject', OTHER_REVIEWER)),
    ]);

    const results = [accepted, rejected];
    const done = results.filter((result) => result.status === 'done');
    const stale = results.filter((result) => result.status === 'stale');
    expect(done).toHaveLength(1);
    expect(stale).toHaveLength(1);

    const winner = done[0]?.application.status;
    expect(stale[0]?.application?.status).toBe(winner);
    const loser = winner === 'accepted' ? 'rejected' : 'accepted';

    const keys = (await effectsOf(application.id)).map((row) => row.key);
    expect(keys.some((key) => key.startsWith(`${winner}:`))).toBe(true);
    expect(keys.some((key) => key.includes(loser))).toBe(false);

    const detail = await store.detail(GUILD, application.id);
    expect(
      detail?.events.filter((row) => row.kind === 'accepted' || row.kind === 'rejected'),
    ).toHaveLength(1);
    expect(detail?.thread).toHaveLength(1);
  });

  test('two claims at once: one reviewer gets it, the other sees who did', async () => {
    const application = await submitted();

    const results = await Promise.all([
      store.transition(claim(application, REVIEWER)),
      store.transition(claim(application, OTHER_REVIEWER)),
    ]);

    const done = results.filter((result) => result.status === 'done');
    expect(done).toHaveLength(1);
    const winner = done[0]?.application.assigneeId;
    expect(results.find((result) => result.status === 'stale')?.application?.assigneeId).toBe(
      winner,
    );
  });

  test('an expected revision that moved on is stale and changes nothing', async () => {
    const application = await submitted();

    const result = await store.transition({
      ...claim(application, REVIEWER),
      expect: { statuses: ['submitted'], revision: application.revision + 1 },
    });
    expect(result).toMatchObject({ status: 'stale', application: { status: 'submitted' } });
    expect((await store.get(GUILD, application.id))?.revision).toBe(application.revision);
  });

  test('a replayed request changes nothing the second time', async () => {
    const application = await submitted();
    const request = audit('note');

    const first = await note(application, 'first note', request);
    const again = await note(application, 'first note', request);
    expect(first.status).toBe('done');
    expect(again).toMatchObject({ status: 'done', effects: [] });

    const detail = await store.detail(GUILD, application.id);
    expect(detail?.notes.map((row) => row.body)).toEqual(['first note']);

    const byEvent: TransitionInput = {
      ...claim(application, REVIEWER),
      event: { kind: 'claimed', id: `claim:${application.id}:interaction-1` },
    };
    expect((await store.transition(byEvent)).status).toBe('done');
    const replay = await store.transition({ ...byEvent, expect: { statuses: ['submitted'] } });
    expect(replay).toMatchObject({
      status: 'done',
      effects: [],
      application: { status: 'in_review' },
    });
  });

  test('notes keep the revision, votes replace the reviewer’s earlier vote', async () => {
    const application = await submitted();

    await note(application, 'one');
    await note(application, 'two', undefined, NOW + SECOND);
    expect((await store.get(GUILD, application.id))?.revision).toBe(application.revision);

    const vote = (choice: 'accept' | 'reject', score: number | null) =>
      store.transition({
        guildId: GUILD,
        applicationId: application.id,
        action: 'vote',
        actor: { id: REVIEWER, source: 'discord' },
        expect: { statuses: PENDING },
        patch: {},
        vote: { vote: choice, score },
        event: { kind: 'voted', data: { vote: choice } },
        now: NOW,
      });

    await vote('accept', 4);
    await vote('reject', null);

    expect(await store.votes(GUILD, application.id)).toEqual([
      { reviewerId: REVIEWER, vote: 'reject', score: null, updatedAt: NOW },
    ]);

    const detail = await store.detail(GUILD, application.id);
    expect(detail?.notes.map((row) => row.body)).toEqual(['one', 'two']);
    expect((await store.get(GUILD, application.id))?.revision).toBe(application.revision + 2);
  });

  test('a new revision re-queues a leased card without letting the old holder finish it', async () => {
    const application = await submitted();
    const card = await effect(application.id, 'card');

    const claimed = await store.claimEffect(GUILD, card.id, NOW, LEASE);
    expect(claimed?.token).toBe(1);

    await store.transition(claim(application, REVIEWER));
    const requeued = await effect(application.id, 'card');
    expect(requeued).toMatchObject({
      status: 'pending',
      attempts: 0,
      claimSeq: 1,
      leaseUntil: NOW + LEASE,
      trigger: 'review_started',
      revision: application.revision + 1,
    });

    expect(await store.finishEffect(GUILD, card.id, 1, { status: 'succeeded' })).toBe(false);
    expect(await store.claimEffect(GUILD, card.id, NOW + SECOND, LEASE)).toBeNull();

    const next = await store.claimEffect(GUILD, card.id, NOW + LEASE + SECOND, LEASE);
    expect(next).toMatchObject({ token: 2, effect: { attempts: 1 } });
    expect(await store.finishEffect(GUILD, card.id, 2, { status: 'succeeded' })).toBe(true);

    await store.transition(
      decision({ ...application, revision: application.revision + 1 }, 'accept', REVIEWER),
    );
    expect(await effect(application.id, 'card')).toMatchObject({
      status: 'pending',
      attempts: 0,
      claimSeq: 2,
      leaseUntil: null,
    });
  });
});

describe('effects', () => {
  test('claims are fenced by the claim token and leases expire', async () => {
    const application = await submitted();
    const dm = await effect(application.id, 'submitted:1:dm');

    const first = await store.claimEffect(GUILD, dm.id, NOW, LEASE);
    expect(first).toMatchObject({
      token: 1,
      effect: { status: 'running', leaseUntil: NOW + LEASE },
    });
    expect(await store.claimEffect(GUILD, dm.id, NOW + SECOND, LEASE)).toBeNull();

    const takeover = await store.claimEffect(GUILD, dm.id, NOW + LEASE + SECOND, LEASE);
    expect(takeover?.token).toBe(2);

    expect(await store.finishEffect(GUILD, dm.id, 1, { status: 'succeeded' })).toBe(false);
    expect(
      await store.finishEffect(GUILD, dm.id, 2, {
        status: 'succeeded',
        result: { channelId: '1' },
      }),
    ).toBe(true);
    expect(await store.finishEffect(GUILD, dm.id, 2, { status: 'failed' })).toBe(false);

    expect(await effect(application.id, 'submitted:1:dm')).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      claimSeq: 2,
      leaseUntil: null,
      result: { channelId: '1' },
    });
  });

  test('a transient failure waits for its next attempt', async () => {
    const application = await submitted();
    const dm = await effect(application.id, 'submitted:1:dm');

    const claimed = await store.claimEffect(GUILD, dm.id, NOW, LEASE);
    expect(
      await store.finishEffect(GUILD, dm.id, claimed?.token ?? 0, {
        status: 'pending',
        errorCode: 'transport_failure',
        error: 'Couldn’t reach Discord.',
        nextAttemptAt: NOW + 2 * MINUTE,
      }),
    ).toBe(true);

    const early = await store.dueWork(GUILD, NOW + MINUTE, 50);
    expect(early.effects.map((row) => row.id)).not.toContain(dm.id);
    expect(await store.claimEffect(GUILD, dm.id, NOW + MINUTE, LEASE)).toBeNull();

    const due = await store.dueWork(GUILD, NOW + 2 * MINUTE, 50);
    expect(due.effects.map((row) => row.id)).toContain(dm.id);
    expect((await store.claimEffect(GUILD, dm.id, NOW + 2 * MINUTE, LEASE))?.token).toBe(2);
  });

  test('a requested effect is re-asked after its wait and settled by the answer', async () => {
    const application = await submitted();
    const dm = await effect(application.id, 'submitted:1:dm');

    const claimed = await store.claimEffect(GUILD, dm.id, NOW, LEASE);
    await store.finishEffect(GUILD, dm.id, claimed?.token ?? 0, {
      status: 'requested',
      nextAttemptAt: NOW + 2 * MINUTE,
    });
    expect(await effect(application.id, 'submitted:1:dm')).toMatchObject({
      status: 'requested',
      leaseUntil: NOW + 2 * MINUTE,
    });

    expect(await store.claimEffect(GUILD, dm.id, NOW + MINUTE, LEASE)).toBeNull();
    const reask = await store.claimEffect(GUILD, dm.id, NOW + 3 * MINUTE, LEASE);
    expect(reask?.token).toBe(2);

    const failed = await store.answerRequested(
      GUILD,
      { applicationId: application.id, effectId: dm.id },
      { status: 'failed', errorCode: 'refused', error: 'Refused.' },
    );
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'refused' });
    expect(await store.finishEffect(GUILD, dm.id, 2, { status: 'succeeded' })).toBe(false);

    const late = await store.answerRequested(
      GUILD,
      { applicationId: application.id, effectKey: 'submitted:1:dm' },
      { status: 'succeeded', result: { granted: true } },
    );
    expect(late).toMatchObject({ status: 'succeeded', errorCode: null, result: { granted: true } });

    expect(
      await store.answerRequested(
        OTHER_GUILD,
        { applicationId: application.id, effectId: dm.id },
        { status: 'failed' },
      ),
    ).toBeNull();
  });

  test('only a failed effect is retried, from zero attempts and a fresh token, with a record of who asked', async () => {
    const application = await submitted();
    const dm = await effect(application.id, 'submitted:1:dm');
    const actor = { id: REVIEWER, source: 'dashboard' as const };

    expect(await store.retryEffect(GUILD, application.id, dm.id, actor)).toBeNull();

    const claimed = await store.claimEffect(GUILD, dm.id, NOW, LEASE);
    await store.finishEffect(GUILD, dm.id, claimed?.token ?? 0, {
      status: 'failed',
      errorCode: 'dms_closed',
      error: 'Couldn’t DM the applicant: their DMs are closed to Proton.',
    });

    const listed = await store.list(GUILD, listQuery());
    expect(listed.problems.get(application.id)?.map((row) => row.key)).toEqual(['submitted:1:dm']);
    expect((await store.summary(GUILD, [form.id], REVIEWER)).problems).toBe(1);

    const request = audit('retry_effect');
    const retried = await store.retryEffect(GUILD, application.id, dm.id, actor, request);
    expect(retried).toMatchObject({
      status: 'pending',
      attempts: 0,
      claimSeq: 1,
      errorCode: null,
      error: null,
    });

    const detail = await store.detail(GUILD, application.id);
    expect(detail?.events.map((row) => row.kind)).toContain('effect_retried');
    const audits = await handle.db.select().from(auditTrail).where(eq(auditTrail.id, request.id));
    expect(audits).toHaveLength(1);

    const clock = await store.now();
    expect(await store.claimEffect(GUILD, dm.id, clock + SECOND, LEASE)).toMatchObject({
      token: 2,
      effect: { attempts: 1 },
    });

    const cancelled = await store.cancelEffect(GUILD, application.id, dm.id, actor);
    expect(cancelled?.status).toBe('cancelled');
    expect(await store.cancelEffect(GUILD, application.id, dm.id, actor)).toBeNull();
  });

  test('due work covers effects, overdue reviews and lapsed information requests', async () => {
    const application = await submitted(APPLICANT, GUILD, { reviewDueAt: NOW + HOUR });

    const first = await store.dueWork(GUILD, NOW, 50);
    expect(first.effects).toHaveLength(4);
    expect(first.reminders).toEqual([]);
    expect(first.nextDueAt).toBe(NOW);

    for (const row of first.effects) {
      const claimed = await store.claimEffect(GUILD, row.id, NOW, LEASE);
      await store.finishEffect(GUILD, row.id, claimed?.token ?? 0, { status: 'succeeded' });
    }

    const idle = await store.dueWork(GUILD, NOW, 50);
    expect(idle).toEqual({ effects: [], reminders: [], infoExpiries: [], nextDueAt: NOW + HOUR });

    const overdue = await store.dueWork(GUILD, NOW + 2 * HOUR, 50);
    expect(overdue.reminders.map((row) => row.id)).toEqual([application.id]);

    await store.transition({
      guildId: GUILD,
      applicationId: application.id,
      action: 'request_info',
      actor: { id: REVIEWER, source: 'dashboard' },
      expect: { statuses: ['submitted', 'in_review', 'waitlisted'] },
      patch: { status: 'needs_info', infoRequestedAt: NOW, infoDueAt: NOW + DAY },
      thread: { kind: 'info_request', body: 'Which timezone are you in?' },
      event: { kind: 'information_requested', lifecycle: 'applications.information_requested' },
      now: NOW,
    });

    const lapsed = await store.dueWork(GUILD, NOW + 2 * DAY, 50);
    expect(lapsed.reminders).toEqual([]);
    expect(lapsed.infoExpiries.map((row) => row.id)).toEqual([application.id]);
    expect((await store.dueWork(GUILD, NOW, 50)).nextDueAt).toBe(NOW + DAY);
    expect((await store.dueWork(OTHER_GUILD, NOW + 2 * DAY, 50)).infoExpiries).toEqual([]);
  });

  test('role grants are tracked per application and only unremoved ones are listed', async () => {
    const application = await submitted();

    await store.recordRoleGrant(GUILD, application.id, APPLICANT, ROLE);
    await store.recordRoleGrant(GUILD, application.id, APPLICANT, '200000000000000002');
    await store.recordRoleGrant(OTHER_GUILD, application.id, APPLICANT, '200000000000000003');
    expect((await store.grantedRoles(GUILD, application.id)).sort()).toEqual(
      [ROLE, '200000000000000002'].sort(),
    );

    await store.markRoleRemoved(GUILD, application.id, ROLE);
    expect(await store.grantedRoles(GUILD, application.id)).toEqual(['200000000000000002']);

    await store.recordRoleGrant(GUILD, application.id, APPLICANT, ROLE);
    expect((await store.grantedRoles(GUILD, application.id)).sort()).toEqual(
      [ROLE, '200000000000000002'].sort(),
    );
  });
});

describe('retention and deletion', () => {
  test('purging scrubs content, keeps the tombstone and re-renders the card', async () => {
    const application = await submitted();
    await note(application, 'private note');
    const decided = await store.transition(decision({ ...application }, 'accept', REVIEWER));
    if (decided.status !== 'done') throw new Error('the decision did not apply');
    await store.rememberCard(GUILD, application.id, CHANNEL, '500000000000000001', 3);

    expect(await store.purgeContent(NOW + MINUTE, 100)).toBe(0);
    expect(await store.purgeContent(NOW + 31 * DAY, 100)).toBe(1);

    const detail = await store.detail(GUILD, application.id);
    expect(detail?.application).toMatchObject({
      status: 'accepted',
      number: 1,
      decidedBy: REVIEWER,
      answers: null,
      applicantName: null,
      decisionReason: null,
      contentPurgedAt: NOW + 31 * DAY,
      deletedAt: null,
    });
    expect(detail?.thread.map((row) => row.body)).toEqual([null]);
    expect(detail?.notes.map((row) => row.body)).toEqual([null]);
    expect(detail?.events.map((row) => row.kind)).toContain('content_purged');
    expect(detail?.effects.find((row) => row.key === 'card')).toMatchObject({
      status: 'pending',
      trigger: 'purge',
    });

    expect(await store.purgeContent(NOW + 40 * DAY, 100)).toBe(0);
  });

  test('deleting scrubs now, cancels unfinished effects and queues the card’s removal', async () => {
    const application = await submitted();
    await store.rememberCard(GUILD, application.id, CHANNEL, '500000000000000001', 1);
    const request = audit('delete');

    const deleted = await store.deleteApplication({
      guildId: GUILD,
      applicationId: application.id,
      actor: { id: REVIEWER, source: 'dashboard' },
      audit: request,
      now: NOW + MINUTE,
    });
    expect(deleted).toMatchObject({
      status: 'deleted',
      application: { deletedAt: NOW + MINUTE, answers: null, applicantName: null, number: 1 },
    });

    const effects = await effectsOf(application.id);
    expect(effects.find((row) => row.key === 'delete_card')).toMatchObject({
      status: 'pending',
      kind: 'delete_card',
      params: { channelId: CHANNEL, messageId: '500000000000000001' },
    });
    expect(
      effects.filter((row) => row.key !== 'delete_card').every((row) => row.status === 'cancelled'),
    ).toBe(true);

    expect((await store.list(GUILD, listQuery({ view: 'all' }))).total).toBe(0);
    expect(await store.mine(GUILD, APPLICANT)).toEqual([]);
    expect(await store.transition(claim(application, REVIEWER))).toMatchObject({ status: 'stale' });

    const again = await store.deleteApplication({
      guildId: GUILD,
      applicationId: application.id,
      actor: { id: REVIEWER, source: 'dashboard' },
      audit: request,
    });
    expect(again).toMatchObject({ status: 'deleted', application: { deletedAt: NOW + MINUTE } });

    const drafted = await draft(applicantId(5));
    await store.deleteApplication({
      guildId: GUILD,
      applicationId: drafted.id,
      actor: { id: REVIEWER, source: 'dashboard' },
      audit: audit('delete'),
    });
    expect(await store.get(GUILD, drafted.id)).toBeNull();
    expect(
      await store.deleteApplication({
        guildId: GUILD,
        applicationId: drafted.id,
        actor: { id: REVIEWER, source: 'dashboard' },
        audit: audit('delete'),
      }),
    ).toEqual({ status: 'missing' });
  });

  test('deleting an applicant covers every application of theirs in that server only', async () => {
    const sent = await submitted();
    const drafted = await draft();
    const other = await submitted(applicantId(7));
    const elsewhere = await submitted(APPLICANT, OTHER_GUILD);

    expect(
      await store.deleteApplicant({
        guildId: GUILD,
        applicantId: APPLICANT,
        actor: { id: REVIEWER, source: 'dashboard' },
        audit: audit('delete_applicant'),
        now: NOW + MINUTE,
      }),
    ).toEqual({ deleted: 2 });

    expect(await store.get(GUILD, drafted.id)).toBeNull();
    expect((await store.get(GUILD, sent.id))?.deletedAt).toBe(NOW + MINUTE);
    expect((await store.get(GUILD, other.id))?.deletedAt).toBeNull();
    expect((await store.get(OTHER_GUILD, elsewhere.id))?.deletedAt).toBeNull();
  });
});

describeStoreBookkeeping(async () => ({
  store,
  wakes: async (guildId) => {
    const rows = await handle.db
      .select({ id: scheduledActions.id })
      .from(scheduledActions)
      .where(eq(scheduledActions.guildId, guildId));
    return rows.length;
  },
  clearWakes: async (guildId) => {
    await handle.db.delete(scheduledActions).where(eq(scheduledActions.guildId, guildId));
  },
}));

describe('isolation', () => {
  test('another server’s id reaches nothing', async () => {
    const application = await submitted();
    const card = await effect(application.id, 'card');
    const actor = { id: REVIEWER, source: 'dashboard' as const };

    expect(await store.get(OTHER_GUILD, application.id)).toBeNull();
    expect(await store.detail(OTHER_GUILD, application.id)).toBeNull();
    expect(await store.byNumber(OTHER_GUILD, 1)).toBeNull();
    expect(
      await store.transition({ ...claim(application, REVIEWER), guildId: OTHER_GUILD }),
    ).toEqual({ status: 'stale', application: null });
    expect(await store.claimEffect(OTHER_GUILD, card.id, NOW, LEASE)).toBeNull();
    expect(await store.retryEffect(OTHER_GUILD, application.id, card.id, actor)).toBeNull();
    expect(await store.cancelEffect(OTHER_GUILD, application.id, card.id, actor)).toBeNull();
    expect((await store.list(OTHER_GUILD, listQuery({ view: 'all' }))).items).toEqual([]);
    expect(await store.votes(OTHER_GUILD, application.id)).toEqual([]);
    expect(
      await store.deleteApplication({
        guildId: OTHER_GUILD,
        applicationId: application.id,
        actor,
        audit: audit('delete', OTHER_GUILD),
      }),
    ).toEqual({ status: 'missing' });
    expect(
      await store.saveDraft({
        guildId: OTHER_GUILD,
        applicationId: application.id,
        applicantId: APPLICANT,
        expectedRevision: null,
        answers: {},
        mode: 'merge',
        expiresAt: NOW,
      }),
    ).toEqual({ status: 'gone' });
    const foreign = await store.submit({ ...submitInput(application), guildId: OTHER_GUILD });
    expect(foreign).toMatchObject({ status: 'refused', code: 'not_draft' });

    expect(
      await store.rememberCard(OTHER_GUILD, application.id, CHANNEL, '500000000000000009', 9),
    ).toBe(false);
    expect((await store.get(GUILD, application.id))?.cardMessageId).toBeNull();
    await store.queueCardRemoval(OTHER_GUILD, application.id, CHANNEL, '500000000000000009');
    expect((await effectsOf(application.id)).some((row) => row.kind === 'delete_card')).toBe(false);

    const events = await handle.db
      .select()
      .from(applicationEvents)
      .where(eq(applicationEvents.guildId, OTHER_GUILD));
    expect(events).toEqual([]);
  });

  test('mine reads across servers only when asked to', async () => {
    const here = await submitted();
    const there = await submitted(APPLICANT, OTHER_GUILD, { now: NOW + MINUTE });

    expect((await store.mine(null, APPLICANT)).map((row) => row.id)).toEqual([there.id, here.id]);
    expect((await store.mine(GUILD, APPLICANT)).map((row) => row.id)).toEqual([here.id]);
    expect(await store.mine(null, applicantId(42))).toEqual([]);
  });
});

describe('queue', () => {
  async function seedQueue() {
    const waiting = await submitted(applicantId(1), GUILD, { now: NOW });
    const claimed = await submitted(applicantId(2), GUILD, { now: NOW + MINUTE });
    await store.transition(claim(claimed, REVIEWER));

    const archived = await submitted(applicantId(3), GUILD, { now: NOW + 2 * MINUTE });
    await store.transition(decision(archived, 'accept', REVIEWER));
    await store.transition({
      guildId: GUILD,
      applicationId: archived.id,
      action: 'archive',
      actor: { id: REVIEWER, source: 'dashboard' },
      expect: { statuses: ['accepted', 'rejected', 'withdrawn', 'expired'] },
      patch: { archivedAt: NOW + HOUR },
      event: { kind: 'archived' },
      now: NOW + HOUR,
    });

    const asked = await submitted(applicantId(4), GUILD, { now: NOW + 3 * MINUTE });
    await store.transition({
      guildId: GUILD,
      applicationId: asked.id,
      action: 'request_info',
      actor: { id: REVIEWER, source: 'dashboard' },
      expect: { statuses: ['submitted', 'in_review', 'waitlisted'] },
      patch: { status: 'needs_info', infoRequestedAt: NOW, infoDueAt: NOW + DAY },
      event: { kind: 'information_requested' },
      now: NOW + 4 * MINUTE,
    });

    await draft(applicantId(5));
    return { waiting, claimed, archived, asked };
  }

  test('views, filters, search, sorting and paging', async () => {
    const { waiting, claimed, archived, asked } = await seedQueue();
    const ids = async (overrides: Record<string, unknown>, viewer = REVIEWER) =>
      (await store.list(GUILD, listQuery(overrides, viewer))).items.map((row) => row.id);

    expect(await ids({})).toEqual([claimed.id, waiting.id]);
    expect(await ids({ dir: 'asc' })).toEqual([waiting.id, claimed.id]);
    expect(await ids({ assignee: 'me' })).toEqual([claimed.id]);
    expect(await ids({ assignee: 'me' }, OTHER_REVIEWER)).toEqual([]);
    expect(await ids({ assignee: 'none' })).toEqual([waiting.id]);
    expect(await ids({ assignee: REVIEWER })).toEqual([claimed.id]);
    expect(await ids({ view: 'needs_info' })).toEqual([asked.id]);
    expect(await ids({ view: 'accepted' })).toEqual([]);
    expect(await ids({ view: 'archived' })).toEqual([archived.id]);
    expect(await ids({ view: 'all', sort: 'number', dir: 'asc' })).toEqual([
      waiting.id,
      claimed.id,
      asked.id,
    ]);
    expect(await ids({ view: 'all', q: '#2' })).toEqual([claimed.id]);
    expect(await ids({ view: 'all', q: 'NAME 04' })).toEqual([asked.id]);
    expect(await ids({ view: 'all', q: applicantId(1) })).toEqual([waiting.id]);
    expect(await ids({ view: 'all', q: '%' })).toEqual([]);

    const paged = await store.list(
      GUILD,
      listQuery({ view: 'all', pageSize: 1, page: 2, sort: 'number', dir: 'asc' }),
    );
    expect(paged.total).toBe(3);
    expect(paged.items.map((row) => row.id)).toEqual([claimed.id]);

    expect((await store.list(GUILD, { ...listQuery(), formIds: [] })).total).toBe(0);
    expect((await store.list(GUILD, listQuery({ formId: 'other' }))).total).toBe(0);
  });

  test('counts, summary and export agree with the queue', async () => {
    const { waiting, archived } = await seedQueue();

    expect((await store.counts(GUILD)).get(form.id)).toEqual({
      awaiting: 2,
      needsInfo: 1,
      drafts: 1,
      total: 4,
      submittedForCap: 4,
    });

    expect(await store.summary(GUILD, [form.id], REVIEWER)).toEqual({
      awaiting: 2,
      unassigned: 1,
      needsInfo: 1,
      waitlisted: 0,
      problems: 0,
      oldestAwaitingAt: waiting.submittedAt,
    });
    expect(await store.summary(GUILD, [], REVIEWER)).toMatchObject({
      awaiting: 0,
      oldestAwaitingAt: null,
    });

    const all = await store.exportRows(
      GUILD,
      { formIds: [form.id], view: 'all', viewerId: REVIEWER },
      10,
    );
    expect(all.truncated).toBe(false);
    expect(all.rows.map((row) => row.number)).toEqual([1, 2, 3, 4]);
    expect(all.rows.map((row) => row.id)).toContain(archived.id);

    const clipped = await store.exportRows(
      GUILD,
      { formIds: [form.id], view: 'all', viewerId: REVIEWER, from: NOW + MINUTE },
      2,
    );
    expect(clipped).toMatchObject({ truncated: true });
    expect(clipped.rows.map((row) => row.number)).toEqual([2, 3]);
  });
});

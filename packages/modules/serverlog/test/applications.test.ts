import { describe, expect, test } from 'bun:test';
import type { ProtonEvent } from '@proton/core';
import { specByKey } from '../src/catalogue.ts';
import { ServerLogColors } from '../src/colours.ts';
import { serverlogDefaultConfig } from '../src/config.ts';
import {
  createServerlogListener,
  SERVERLOG_EVENT_TYPES,
  type ServerlogDeps,
} from '../src/listeners.ts';
import {
  BOT_USER,
  config,
  context,
  EMOJIS,
  GUILD,
  LOG_CHANNEL,
  RecordingExecutor,
  resolver,
} from './harness.ts';

const APPLICANT = '200000000000000021';
const REVIEWER = '200000000000000022';
const PROTON_CHANNEL = '500000000000000041';
const APPLICATION_ID = '01J9ZK4N7Q2X5V8B3C6D9F0G1H';

const SECRETS = [
  'I have moderated three servers before',
  'reviewer-note-text',
  'Too many warnings last month',
  'my timezone is UTC+2',
];

const lifecycle = {
  guildId: GUILD,
  applicationId: APPLICATION_ID,
  number: 12,
  formId: 'moderator',
  formName: 'Moderator Application',
  versionId: '01J9ZK4N7Q2X5V8B3C6D9F0G1J',
  applicantId: APPLICANT,
  actorId: APPLICANT,
  revision: 1,
  status: 'submitted' as const,
  occurredAt: 1_700_000_000_000,
};

const failed = {
  guildId: GUILD,
  applicationId: APPLICATION_ID,
  number: 12,
  formId: 'moderator',
  formName: 'Moderator Application',
  effectId: '01J9ZK4N7Q2X5V8B3C6D9F0G1K',
  kind: 'dm',
  errorCode: 'dms_closed',
  revision: 3,
  occurredAt: 1_700_000_600_000,
};

function applicationEvent(type: ProtonEvent['type'], payload: unknown): ProtonEvent {
  return {
    id: `${type}:${GUILD}:${APPLICATION_ID}:${(payload as { revision?: number }).revision ?? 0}`,
    type,
    guildId: GUILD,
    occurredAt: 1_700_000_000_000,
    payload,
  };
}

async function render(event: ProtonEvent, cfg = config(), extra: Partial<ServerlogDeps> = {}) {
  const executor = new RecordingExecutor();
  const listener = createServerlogListener({
    emojis: EMOJIS,
    users: resolver,
    botUserId: BOT_USER,
    ...extra,
  });

  await listener.handler(event, context(executor, cfg));
  return executor;
}

function body(executor: RecordingExecutor): string {
  return String(executor.embeds()[0]?.description);
}

describe('the listener hears application events', () => {
  test('every application event it logs is subscribed, straight from the catalogue', () => {
    for (const type of [
      'applications.submitted',
      'applications.accepted',
      'applications.rejected',
      'applications.waitlisted',
      'applications.reopened',
      'applications.action_failed',
    ] as const) {
      expect(SERVERLOG_EVENT_TYPES).toContain(type);
    }
  });

  test('each is an immediate Proton log', () => {
    for (const key of [
      'proton.application_submitted',
      'proton.application_decided',
      'proton.application_reopened',
      'proton.application_action_failed',
    ]) {
      expect(specByKey(key)?.category).toBe('proton');
      expect(specByKey(key)?.primary).toBe('immediate');
    }
  });

  test('drafts, reviews starting, withdrawals and expiries are not logged', () => {
    for (const type of [
      'applications.review_started',
      'applications.information_requested',
      'applications.information_provided',
      'applications.withdrawn',
      'applications.expired',
      'applications.work_requested',
    ] as const) {
      expect(SERVERLOG_EVENT_TYPES).not.toContain(type);
    }
  });
});

describe('application submitted', () => {
  test('names the reference, the form, the applicant and the status', async () => {
    const executor = await render(applicationEvent('applications.submitted', lifecycle));

    expect(executor.titles()).toEqual(['Application #12 submitted']);
    expect(executor.channels()).toEqual([LOG_CHANNEL]);
    expect(executor.embeds()[0]?.color).toBe(ServerLogColors.Add);

    const text = body(executor);
    expect(text).toContain('**Application:** `#12`');
    expect(text).toContain('**Form:** `Moderator Application`');
    expect(text).toContain(`**Application ID:** \`${APPLICATION_ID}\``);
    expect(text).toContain(`**Applicant:** <@${APPLICANT}>`);
    expect(text).toContain('**Status:** `Submitted`');
    expect(text).not.toContain('Review');
  });

  test('a payload that fails the core schema posts nothing', async () => {
    const executor = await render(
      applicationEvent('applications.submitted', { ...lifecycle, status: 'pending' }),
    );

    expect(executor.requests).toEqual([]);
  });
});

describe('application decided', () => {
  test.each([
    ['applications.accepted', 'accepted', 'Accepted', ServerLogColors.Add],
    ['applications.rejected', 'rejected', 'Rejected', ServerLogColors.Remove],
    ['applications.waitlisted', 'waitlisted', 'Waitlisted', ServerLogColors.Modify],
  ] as const)(
    '%s is titled by its outcome and names who decided',
    async (type, status, label, colour) => {
      const executor = await render(
        applicationEvent(type, { ...lifecycle, status, actorId: REVIEWER, revision: 4 }),
      );

      expect(executor.titles()).toEqual([`Application #12 ${status}`]);
      expect(executor.embeds()[0]?.color).toBe(colour);

      const text = body(executor);
      expect(text).toContain(`**Status:** \`${label}\``);
      expect(text).toContain(`**Decided by:** <@${REVIEWER}>`);
      expect(text).toContain(`**Applicant:** <@${APPLICANT}>`);
    },
  );

  test('a decision Proton made itself names Proton’s module rather than a broken mention', async () => {
    const executor = await render(
      applicationEvent('applications.accepted', {
        ...lifecycle,
        status: 'accepted',
        actorId: 'proton:applications',
      }),
    );

    const text = body(executor);
    expect(text).toContain('**Decided by:** `applications`');
    expect(text).not.toContain('<@proton:');
  });

  test('a status that is not a decision is not logged as one', async () => {
    const executor = await render(
      applicationEvent('applications.accepted', { ...lifecycle, status: 'withdrawn' }),
    );

    expect(executor.requests).toEqual([]);
  });
});

describe('application reopened', () => {
  test('names who reopened it and where it stands now', async () => {
    const executor = await render(
      applicationEvent('applications.reopened', {
        ...lifecycle,
        status: 'in_review',
        actorId: REVIEWER,
        revision: 5,
      }),
    );

    expect(executor.titles()).toEqual(['Application #12 reopened']);

    const text = body(executor);
    expect(text).toContain('**Status:** `In review`');
    expect(text).toContain(`**Reopened by:** <@${REVIEWER}>`);
  });
});

describe('application action failed', () => {
  test('names the action and the error code, and nothing the error said', async () => {
    const executor = await render(applicationEvent('applications.action_failed', failed));

    expect(executor.titles()).toEqual(['Application #12 action failed']);
    expect(executor.embeds()[0]?.color).toBe(ServerLogColors.Remove);

    const text = body(executor);
    expect(text).toContain('**Action:** `DM to the applicant`');
    expect(text).toContain('**Error:** `dms_closed`');
    expect(text).toContain('**Form:** `Moderator Application`');
  });

  test('an action kind it does not know is still named readably', async () => {
    const executor = await render(
      applicationEvent('applications.action_failed', { ...failed, kind: 'new_kind' }),
    );

    expect(body(executor)).toContain('**Action:** `new kind`');
  });
});

describe('what an application log never shows', () => {
  test('answers, notes and reasons never reach the log', async () => {
    const executor = await render(
      applicationEvent('applications.rejected', {
        ...lifecycle,
        status: 'rejected',
        actorId: REVIEWER,
        answers: { experience: SECRETS[0], timezone: SECRETS[3] },
        note: SECRETS[1],
        reason: SECRETS[2],
      }),
    );

    const posted = JSON.stringify(executor.requests);
    expect(executor.requests).toHaveLength(1);
    for (const secret of SECRETS) expect(posted).not.toContain(secret);
  });

  test('mentions in the log never ping', async () => {
    const executor = await render(applicationEvent('applications.submitted', lifecycle));

    expect(executor.payloads()[0]?.allowedMentions).toEqual({ parse: [] });
  });
});

describe('the review link', () => {
  test('links to the application’s review page when the dashboard address is known', async () => {
    const executor = await render(applicationEvent('applications.submitted', lifecycle), config(), {
      dashboardUrl: 'https://prtn.xyz/',
    });

    expect(body(executor)).toContain(
      `**Review:** [\`Open in Proton\`](https://prtn.xyz/review/${GUILD}/${APPLICATION_ID})`,
    );
  });

  test('a failed action links to the same page', async () => {
    const executor = await render(
      applicationEvent('applications.action_failed', failed),
      config(),
      {
        dashboardUrl: 'https://prtn.xyz',
      },
    );

    expect(body(executor)).toContain(`https://prtn.xyz/review/${GUILD}/${APPLICATION_ID}`);
  });
});

describe('routing', () => {
  test('the Proton category channel takes the application logs', async () => {
    const executor = await render(
      applicationEvent('applications.submitted', lifecycle),
      config({
        categoryChannels: { ...serverlogDefaultConfig.categoryChannels, proton: PROTON_CHANNEL },
      }),
    );

    expect(executor.channels()).toEqual([PROTON_CHANNEL]);
  });

  test('the Proton category off silences them, and a per-event override turns one back on', async () => {
    const off = config({ categories: { ...serverlogDefaultConfig.categories, proton: false } });

    const silent = await render(applicationEvent('applications.submitted', lifecycle), off);
    expect(silent.requests).toEqual([]);

    const on = await render(
      applicationEvent('applications.accepted', { ...lifecycle, status: 'accepted' }),
      config({
        categories: { ...serverlogDefaultConfig.categories, proton: false },
        events: { 'proton.application_decided': { enabled: true } },
      }),
    );
    expect(on.titles()).toEqual(['Application #12 accepted']);
  });
});

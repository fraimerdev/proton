import { describe, expect, test } from 'bun:test';
import type { ActionRequest, ActionResult } from '@proton/core';
import { formSchema } from '../src/config.ts';
import {
  applicantDmFacts,
  DM_EMPTY,
  type DmBody,
  deliverApplicantDm,
  dmKeysOf,
  renderApplicantDm,
} from '../src/notify.ts';
import type { ApplicationRecord } from '../src/store.ts';
import { APP_ID, APPLICANT, DECIDER, DM_CHANNEL, failure, GUILD, NOW } from './effects-harness.ts';
import { applicationRecord } from './memory-store.ts';

const form = formSchema.parse({ id: 'mods', name: 'Moderator Application' });

function application(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return applicationRecord({
    id: APP_ID,
    guildId: GUILD,
    number: 12,
    applicantId: APPLICANT,
    status: 'accepted',
    decidedAt: NOW,
    decidedBy: DECIDER,
    decisionReason: 'Great answers.',
    submittedAt: NOW - 1000,
    ...overrides,
  });
}

const facts = {
  user: { id: APPLICANT, username: 'applicant', globalName: 'Applicant', avatarHash: null },
  server: { id: GUILD, name: 'Proton Test' },
  moderator: { id: DECIDER, username: 'decider', globalName: 'Decider', avatarHash: null },
};

function render(message: Parameters<typeof renderApplicantDm>[0]['message'], app = application()) {
  return renderApplicantDm(
    { message, form, application: app, formName: form.name, thread: [], url: null, now: NOW },
    facts,
  );
}

describe('rendering the applicant’s DM', () => {
  test('the default decision names the form, the server and the reason', () => {
    const rendered = render('accepted');
    if (!rendered.ok) throw new Error(rendered.humanReason);

    const text = JSON.stringify(rendered.body);
    expect(text).toContain('Moderator Application');
    expect(text).toContain('Proton Test');
    expect(text).toContain('Great answers.');
    expect(text).toContain('#12');
    expect(text).not.toContain('—');
    expect(rendered.body.components).toBeUndefined();
  });

  test('the information request quotes the latest question', () => {
    const rendered = renderApplicantDm(
      {
        message: 'infoRequest',
        form,
        application: application({ status: 'needs_info' }),
        formName: form.name,
        thread: [
          { kind: 'info_request', body: 'First question?' },
          { kind: 'info_response', body: 'An answer.' },
          { kind: 'info_request', body: 'Second question?' },
        ],
        url: 'https://prtn.xyz/applications/1/2',
        now: NOW,
      },
      facts,
    );
    if (!rendered.ok) throw new Error(rendered.humanReason);

    expect(JSON.stringify(rendered.body)).toContain('Second question?');
    expect(JSON.stringify(rendered.body)).not.toContain('First question?');
  });

  test('an expired application gets fixed copy with no em dash', () => {
    const rendered = render('expired', application({ status: 'expired' }));
    if (!rendered.ok) throw new Error(rendered.humanReason);

    expect(rendered.body.content).toBe(
      'Your application #12 for **Moderator Application** in **Proton Test** has expired because ' +
        'the question from staff wasn’t answered in time.',
    );
  });

  test('a message with nothing left in it is refused rather than sent blank', () => {
    const empty = formSchema.parse({
      id: 'mods',
      name: 'Moderator Application',
      messages: { receipt: { content: '{application.reason}' } },
    });
    const rendered = renderApplicantDm(
      {
        message: 'receipt',
        form: empty,
        application: application({ status: 'submitted' }),
        formName: empty.name,
        thread: [],
        url: null,
        now: NOW,
      },
      facts,
    );

    expect(rendered.ok ? 'sent' : rendered.humanReason).toBe(DM_EMPTY);
  });

  test('only the facts a message uses are fetched', async () => {
    const asked: string[] = [];
    const deps = {
      guildState: null,
      placeholders: {
        applicationId: '1',
        bot: async () => ({ id: '1', supportUrl: 'https://prtn.xyz' }),
        server: async (id: string) => {
          asked.push(`server:${id}`);
          return { id, name: 'Proton Test' };
        },
        user: async (id: string) => {
          asked.push(`user:${id}`);
          return { id, username: 'u', globalName: null, avatarHash: null };
        },
        now: () => NOW,
      },
    };

    const plainForm = formSchema.parse({
      id: 'mods',
      name: 'Moderator Application',
      messages: { receipt: { content: 'Thanks {user.mention}, you are {application.id}.' } },
    });
    expect([...dmKeysOf(plainForm, 'receipt')].sort()).toEqual(['application.id', 'user.mention']);

    const got = await applicantDmFacts({ guildId: GUILD }, deps, {
      message: 'receipt',
      form: plainForm,
      application: application({ status: 'submitted' }),
    });
    expect(asked).toEqual([]);
    expect(got.user?.id).toBe(APPLICANT);
    expect(got.moderator).toBeNull();

    await applicantDmFacts({ guildId: GUILD }, deps, {
      message: 'accepted',
      form,
      application: application(),
    });
    expect(asked).toContain(`server:${GUILD}`);
  });
});

function executor(answers: Partial<Record<string, ActionResult>> = {}) {
  const calls: ActionRequest[] = [];
  return {
    calls,
    execute: async (request: ActionRequest): Promise<ActionResult> => {
      calls.push(request);
      return (
        answers[request.kind] ??
        (request.kind === 'create_dm'
          ? { status: 'executed', body: { id: DM_CHANNEL } }
          : { status: 'executed', body: { id: '1400000000000000001' } })
      );
    },
  };
}

function store(stored: string | null = null) {
  const remembered: string[] = [];
  return {
    remembered,
    get: async () => application({ dmChannelId: stored }),
    rememberDm: async (_guildId: string, _id: string, channelId: string) => {
      remembered.push(channelId);
    },
  };
}

const body: DmBody = { content: 'Hello' };
const keys = { openKey: 'applications:a:dm-open:1', sendKey: 'applications:a:submitted:2:dm:send' };

describe('delivering it', () => {
  test('opens the DM, writes the channel down, then sends with directMessage', async () => {
    const run = executor();
    const kept = store();

    const outcome = await deliverApplicantDm({ guildId: GUILD, executor: run }, kept, {
      application: application(),
      body,
      ...keys,
    });

    expect(outcome).toEqual({ outcome: 'sent', channelId: DM_CHANNEL });
    expect(kept.remembered).toEqual([DM_CHANNEL]);
    expect(run.calls.map((call) => [call.kind, call.idempotencyKey, call.record])).toEqual([
      ['create_dm', keys.openKey, false],
      ['send', keys.sendKey, false],
    ]);
    expect(run.calls[1]?.payload).toEqual({
      channelId: DM_CHANNEL,
      content: 'Hello',
      allowedMentions: { parse: [] },
      directMessage: true,
    });
  });

  test('a remembered channel skips opening one', async () => {
    const run = executor();
    await deliverApplicantDm({ guildId: GUILD, executor: run }, store(), {
      application: application({ dmChannelId: DM_CHANNEL }),
      body,
      ...keys,
    });

    expect(run.calls.map((call) => call.kind)).toEqual(['send']);
  });

  test('a duplicate open reads the channel the first run wrote down', async () => {
    const run = executor({ create_dm: { status: 'skipped_duplicate' } });
    const outcome = await deliverApplicantDm({ guildId: GUILD, executor: run }, store(DM_CHANNEL), {
      application: application(),
      body,
      ...keys,
    });

    expect(outcome).toEqual({ outcome: 'sent', channelId: DM_CHANNEL });
  });

  test('a duplicate open with nothing written down waits for another try', async () => {
    const run = executor({ create_dm: { status: 'skipped_duplicate' } });
    const outcome = await deliverApplicantDm({ guildId: GUILD, executor: run }, store(), {
      application: application(),
      body,
      ...keys,
    });

    expect(outcome.outcome).toBe('retry');
    expect(run.calls.map((call) => call.kind)).toEqual(['create_dm']);
  });

  test('a duplicate send counts as sent', async () => {
    const run = executor({ send: { status: 'skipped_duplicate' } });
    const outcome = await deliverApplicantDm({ guildId: GUILD, executor: run }, store(), {
      application: application({ dmChannelId: DM_CHANNEL }),
      body,
      ...keys,
    });

    expect(outcome.outcome).toBe('sent');
  });

  test.each([
    ['closed DMs', failure('discord_403', 'Cannot send', 50007), 'closed'],
    ['a bare 403', failure('discord_403', 'Forbidden'), 'closed'],
    ['no shared server', failure('discord_400', 'No mutual guilds', 50278), 'no_mutual_server'],
    ['a transport failure', failure('transport_failure', 'Couldn’t reach Discord'), 'retry'],
    ['a 502', failure('discord_502', 'Bad gateway'), 'retry'],
    ['a missing permission', failure('missing_permission', 'Proton lacks Send Messages'), 'failed'],
  ] as const)('%s reads as %s', async (_label, refusal, expected) => {
    const run = executor({ send: refusal });
    const outcome = await deliverApplicantDm({ guildId: GUILD, executor: run }, store(), {
      application: application({ dmChannelId: DM_CHANNEL }),
      body,
      ...keys,
    });

    expect(outcome.outcome).toBe(expected);
  });
});

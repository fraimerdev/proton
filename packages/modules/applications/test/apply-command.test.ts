import { describe, expect, test } from 'bun:test';
import { OptionType, validateCommand } from '@proton/core';
import { InteractionContextType } from 'discord-api-types/v10';
import { APPLICANT_ACTION, customId } from '../src/interface.ts';
import type { FormVersionRecord } from '../src/store.ts';
import {
  applyCommand,
  DAY,
  GOOD_ANSWERS,
  GUILD,
  type Harness,
  harness,
  MEMBER,
  MEMBER_ROLE,
  moderatorForm,
  ready,
  STRANGER,
} from './applicant-harness.ts';
import { applicationRecord, MemoryApplicationStore } from './memory-store.ts';

const form = (value: string) => ({ name: 'form', type: OptionType.String, value });
const application = (value: string) => ({ name: 'application', type: OptionType.String, value });

async function draftFor(h: Harness, formId = 'mods'): Promise<void> {
  await h.press(customId(APPLICANT_ACTION.start, formId));
  await h.submitModal(GOOD_ANSWERS);
}

function seedSent(
  h: Harness,
  versionId: string,
  overrides: Parameters<typeof applicationRecord>[0] = {},
) {
  return h.store.seedApplication(
    applicationRecord({
      id: 'sent-1',
      guildId: GUILD,
      formId: 'mods',
      versionId,
      applicantId: MEMBER,
      number: 12,
      status: 'submitted',
      submittedAt: h.now() - DAY,
      createdAt: h.now() - DAY,
      updatedAt: h.now() - DAY,
      ...overrides,
    }),
  );
}

async function versionId(h: Harness): Promise<string> {
  const latest = (await h.store.latestVersions(GUILD)).get('mods') as FormVersionRecord;
  return latest.id;
}

describe('/apply definition', () => {
  test('is a server-only command Discord accepts, with four subcommands', () => {
    const { data, name } = applyCommand({});
    expect(name).toBe('apply');
    expect(validateCommand(data)).toEqual([]);
    expect(data.contexts).toEqual([InteractionContextType.Guild]);
    expect(data.default_member_permissions).toBeUndefined();
    expect((data.options ?? []).map((option) => option.name)).toEqual([
      'start',
      'status',
      'resume',
      'withdraw',
    ]);
  });
});

describe('/apply start', () => {
  test('defers privately, then shows the overview with Start', async () => {
    const h = await ready();
    const id = await h.command('start', [form('mods')]);

    expect(h.callbackTypesFor(id)).toEqual([5]);
    const edit = h.callsFor(id).at(-1);
    expect(edit?.method).toBe('PATCH');
    expect(edit?.path).toContain('/messages/@original');
    expect(h.text()).toContain('## Moderator Application');
    expect(h.button('Start').customId).toBe(customId(APPLICANT_ACTION.start, 'mods'));
  });

  test('accepts the form’s name as well as its ID', async () => {
    const h = await ready();
    await h.command('start', [form('moderator application')]);
    expect(h.text()).toContain('## Moderator Application');
  });

  test('an unknown form is named in the refusal', async () => {
    const h = await ready();
    await h.command('start', [form('nothing')]);
    expect(h.lastStatus()).toContain('There’s no form called **nothing** in this server.');
  });

  test('role requirements are checked against the invoker’s roles', async () => {
    const h = await ready({ forms: [moderatorForm({ requirements: { roleIds: [MEMBER_ROLE] } })] });

    await h.command('start', [form('mods')], { roleIds: [] });
    expect(h.text()).toContain('✗ ');
    expect(h.buttons().map((button) => button.label)).not.toContain('Start');

    await h.command('start', [form('mods')], { roleIds: [MEMBER_ROLE] });
    expect(h.text()).toContain('✓ ');
    expect(h.buttons().map((button) => button.label)).toContain('Start');
  });

  test('time in the server is read from when the invoker joined', async () => {
    const h = await ready({ forms: [moderatorForm({ requirements: { memberAgeDays: 30 } })] });

    await h.command('start', [form('mods')], {
      joinedAt: new Date(h.now() - 5 * DAY).toISOString(),
    });
    expect(h.buttons().map((button) => button.label)).not.toContain('Start');

    await h.command('start', [form('mods')], {
      joinedAt: new Date(h.now() - 60 * DAY).toISOString(),
    });
    expect(h.buttons().map((button) => button.label)).toContain('Start');
  });
});

describe('/apply status and resume', () => {
  test('status lists every application with its status', async () => {
    const h = await ready();
    seedSent(h, await versionId(h));

    await h.command('status');
    expect(h.text()).toContain('## Your applications');
    expect(h.text()).toContain('**Moderator Application** #12\nSubmitted');
    expect(h.buttons().map((button) => button.label)).toEqual(['View', 'All your applications']);
    expect(h.buttons().at(-1)?.url).toBe(`https://prtn.xyz/apply/${GUILD}`);
  });

  test('status with nothing sent says how to start', async () => {
    const h = await ready();
    await h.command('status');
    expect(h.text()).toContain('You haven’t applied to anything in this server yet.');
    expect(h.text()).toContain('`/apply start`');
  });

  test('resume lists only saved drafts, each with Continue', async () => {
    const h = await ready({
      forms: [moderatorForm(), moderatorForm({ id: 'events', name: 'Event Team' })],
    });
    seedSent(h, await versionId(h));
    await draftFor(h, 'events');

    await h.command('resume');
    expect(h.text()).toContain('## Your saved applications');
    expect(h.text()).toContain('**Event Team**');
    expect(h.text()).not.toContain('#12');
    expect(h.button('Continue').customId).toBe(customId(APPLICANT_ACTION.start, 'events'));
  });
});

describe('/apply withdraw', () => {
  test('asks to confirm, by reference or by ID', async () => {
    const h = await ready();
    seedSent(h, await versionId(h));

    await h.command('withdraw', [application('#12')]);
    expect(h.text()).toContain('## Withdraw your application?');
    expect(h.button('Withdraw').customId).toBe(
      customId(APPLICANT_ACTION.withdrawConfirm, 'sent-1'),
    );

    await h.command('withdraw', [application('sent-1')]);
    expect(h.text()).toContain('## Withdraw your application?');
  });

  test('someone else’s application is not found', async () => {
    const h = await ready();
    seedSent(h, await versionId(h), { applicantId: STRANGER });

    await h.command('withdraw', [application('#12')]);
    expect(h.lastStatus()).toContain('I can’t find an application of yours called **#12**');
  });

  test('a decided application cannot be withdrawn', async () => {
    const h = await ready();
    seedSent(h, await versionId(h), { status: 'accepted', decidedAt: h.now() });

    await h.command('withdraw', [application('#12')]);
    expect(h.lastStatus()).toContain('This application is accepted, so it can’t be withdrawn.');
  });
});

describe('/apply refusals', () => {
  test('with Applications off it answers once, naming the command and where to turn it on', async () => {
    const h = await ready({ config: { enabled: false } });
    const id = await h.command('status');

    expect(h.callbackTypesFor(id)).toEqual([4]);
    expect(h.lastStatus()).toEndWith(
      `**Applications** is off in this server, so \`/apply\` can’t run. A server admin can turn it on at <https://prtn.xyz/dashboard/${GUILD}/applications> using the switch at the top of the page.`,
    );
  });

  test('without a store it says the fault is Proton’s and logs what to wire', async () => {
    const h = await ready({ withoutStore: true });
    const id = await h.command('status');

    expect(h.callbackTypesFor(id)).toEqual([4]);
    expect(h.lastStatus()).toContain('This is a fault on my side');
    expect(h.logs.some((log) => log.level === 'error' && log.message.includes('store'))).toBe(true);
  });
});

class CountingStore extends MemoryApplicationStore {
  reads = 0;

  override async latestVersions(guildId: string) {
    this.reads += 1;
    return super.latestVersions(guildId);
  }

  override async mine(guildId: string | null, applicantId: string) {
    this.reads += 1;
    return super.mine(guildId, applicantId);
  }
}

describe('/apply autocomplete', () => {
  test('offers published forms that are open and whose roles the member holds, with one read', async () => {
    const store = new CountingStore();
    const h = harness({
      store,
      forms: [
        moderatorForm(),
        moderatorForm({ id: 'events', name: 'Event Team' }),
        moderatorForm({
          id: 'vip',
          name: 'VIP Team',
          requirements: { roleIds: ['410000000000000077'] },
        }),
        moderatorForm({ id: 'shut', name: 'Shut Form', intake: { open: false } }),
        moderatorForm({ id: 'draft', name: 'Unpublished Form' }),
      ],
    });
    await h.publishForms(h.config.forms.filter((candidate) => candidate.id !== 'draft'));
    store.reads = 0;

    const all = await h.autocomplete('start', { name: 'form', value: '' });
    expect(all).toEqual([
      { name: 'Moderator Application', value: 'mods' },
      { name: 'Event Team', value: 'events' },
    ]);
    expect(store.reads).toBe(1);

    expect(await h.autocomplete('start', { name: 'form', value: 'even' })).toEqual([
      { name: 'Event Team', value: 'events' },
    ]);
  });

  test('offers the member’s own applications that can still be withdrawn', async () => {
    const h = await ready();
    const version = await versionId(h);
    seedSent(h, version);
    seedSent(h, version, { id: 'done', number: 13, status: 'rejected', decidedAt: h.now() });
    seedSent(h, version, { id: 'theirs', number: 14, applicantId: STRANGER });

    expect(await h.autocomplete('withdraw', { name: 'application', value: '' })).toEqual([
      { name: '#12 · Moderator Application · Submitted', value: 'sent-1' },
    ]);
    expect(await h.autocomplete('withdraw', { name: 'application', value: '13' })).toEqual([]);
  });

  test('answers an empty list while Applications is off', async () => {
    const h = await ready({ config: { enabled: false } });
    expect(await h.autocomplete('start', { name: 'form', value: '' })).toEqual([]);
    expect(h.facing()).toHaveLength(1);
  });
});

describe('/apply and the buttons it shows', () => {
  test('the overview it shows starts the same application the panel would', async () => {
    const h = await ready();
    await h.command('start', [form('mods')]);
    const start = await h.pressButton('Start');

    expect(h.callbackTypesFor(start.interactionId)).toEqual([9]);
    expect(h.draft().applicantId).toBe(MEMBER);
    expect(h.draft().source).toBe('discord');
  });
});

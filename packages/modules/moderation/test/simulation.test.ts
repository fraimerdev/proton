import { describe, expect, test } from 'bun:test';
import {
  asTestDelivery,
  type GuildState,
  type MessageButton,
  type ModuleManifest,
  ModuleRegistry,
  type ProtonMessage,
  personFor,
  type SimulationAdapter,
  type SimulationBuild,
  type SimulationScene,
  simulationDescriptorSchema,
} from '@proton/core';
import {
  type PathDiagnostic,
  SAMPLE_BOT,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_REPORTER,
  SAMPLE_SERVER,
} from '@proton/core/placeholders';
import type { z } from 'zod';
import {
  type ModerationConfig,
  moderationConfigSchema,
  moderationDefaultConfig,
  moderationFormSchema,
} from '../src/config.ts';
import {
  moderationTemplates,
  PUNISHED_SURFACE,
  REPORT_MEMBER_NOTICE_SURFACE,
  UNPUNISHED_SURFACE,
} from '../src/placeholders.ts';
import { REPORT_CARD_ACTIONS } from '../src/reports/card.ts';
import type { automationActionSchema } from '../src/reports/config.ts';
import { moderationSimulations } from '../src/simulation.ts';

type ActionInput = z.input<typeof automationActionSchema>;
type Inputs = SimulationScene['inputs'];

const REPORT_CHANNEL = '100000000000000070';
const OLDEST_TEXT = '100000000000000071';
const NEWER_TEXT = '100000000000000072';
const VOICE = '100000000000000069';
const ALERT_CHANNEL = '100000000000000073';
const NOTIFY_ROLE = '100000000000000074';
const PING_ROLE = '100000000000000075';

const subject = personFor(SAMPLE_MEMBER.user, SAMPLE_MEMBER.member);
const reporter = personFor(SAMPLE_REPORTER.user, SAMPLE_REPORTER.member);

function channel(id: string, type: number) {
  return { id, type, parentId: null, name: `c${id.slice(-2)}`, overwrites: [] };
}

const guildState: GuildState = {
  guildId: SAMPLE_SERVER.id,
  ownerId: '100000000000000002',
  everyoneRoleId: SAMPLE_SERVER.id,
  roles: new Map(),
  botRoleIds: [],
  channels: new Map([
    [NEWER_TEXT, channel(NEWER_TEXT, 0)],
    [REPORT_CHANNEL, channel(REPORT_CHANNEL, 0)],
    [VOICE, channel(VOICE, 2)],
    [OLDEST_TEXT, channel(OLDEST_TEXT, 0)],
  ]),
  name: SAMPLE_SERVER.name ?? 'Proton HQ',
  updatedAt: SAMPLE_NOW,
};

function scene(inputs: Inputs = {}, overrides: Partial<SimulationScene> = {}): SimulationScene {
  return {
    guildId: SAMPLE_SERVER.id,
    server: SAMPLE_SERVER,
    guildState,
    subject,
    actor: reporter,
    destinationChannel: null,
    originChannel: null,
    bot: SAMPLE_BOT,
    eventId: `proton.simulation_requested:${SAMPLE_SERVER.id}:req-0001`,
    now: SAMPLE_NOW,
    tier: 'free',
    inputs,
    ...overrides,
  };
}

function configWith(input: z.input<typeof moderationConfigSchema>): ModerationConfig {
  return moderationConfigSchema.parse(input);
}

function withActions(actions: ActionInput[]) {
  return configWith({
    reports: {
      channelId: REPORT_CHANNEL,
      automation: [
        { id: 'r', name: 'Crowd rule', conditions: { reports: 4, reporters: 2 }, actions },
      ],
    },
  });
}

function adapter(id: string): SimulationAdapter<ModerationConfig> {
  const found = moderationSimulations.find(({ descriptor }) => descriptor.id === id);
  if (found === undefined) throw new Error(`no simulation ${id}`);
  return found;
}

function messageOf(built: SimulationBuild): ProtonMessage {
  if (!built.ok) throw new Error(built.humanReason);
  if (built.output.kind !== 'message') throw new Error('expected a message');
  return built.output.message;
}

function run(id: string, config: ModerationConfig, inputs: Inputs = {}, at = scene(inputs)) {
  return messageOf(adapter(id).build(config, at));
}

function buttonsOf(message: ProtonMessage): MessageButton[] {
  return message.components.flatMap((row) => (row.kind === 'buttons' ? row.buttons : []));
}

function fieldsOf(message: ProtonMessage): Record<string, string> {
  return Object.fromEntries(
    (message.embeds[0]?.fields ?? []).map(({ name, value }) => [name, value]),
  );
}

function everything(message: ProtonMessage): string {
  return JSON.stringify(message);
}

const MEMBER_FACING = ['moderation.punished', 'moderation.unpunished'] as const;

describe('the catalogue', () => {
  test('rehearses every moderation message, report card first', () => {
    expect(moderationSimulations.map(({ descriptor }) => descriptor.id)).toEqual([
      'moderation.report_card',
      'moderation.report_submitted',
      'moderation.report_accepted',
      'moderation.report_dismissed',
      'moderation.report_alert',
      'moderation.report_member_notice',
      'moderation.punished',
      'moderation.unpunished',
    ]);
  });

  test('every descriptor is valid and passes the registry’s boot checks', () => {
    for (const { descriptor } of moderationSimulations) {
      expect(simulationDescriptorSchema.parse(descriptor)).toEqual(descriptor);
      if (descriptor.surfaceId !== undefined) {
        expect(Object.hasOwn(moderationTemplates.surfaces, descriptor.surfaceId)).toBe(true);
      }
    }

    const registry = new ModuleRegistry();
    registry.register({
      id: 'moderation',
      name: 'Moderation',
      configSchema: moderationConfigSchema,
      formSchema: moderationFormSchema,
      defaultConfig: moderationDefaultConfig,
      schemaVersion: 3,
      requiredIntents: [],
      requiredPermissions: [],
      templates: moderationTemplates,
      simulations: moderationSimulations,
    } as unknown as ModuleManifest);

    expect(registry.simulations('moderation')).toHaveLength(moderationSimulations.length);
  });

  test('the card is Proton’s own copy; every other message renders through its surface', () => {
    expect(adapter('moderation.report_card').descriptor.surfaceId).toBeUndefined();
    expect(adapter('moderation.punished').descriptor.surfaceId).toBe(PUNISHED_SURFACE.id);
    expect(adapter('moderation.unpunished').descriptor.surfaceId).toBe(UNPUNISHED_SURFACE.id);
  });
});

describe('from the default settings', () => {
  const needsDmAction = 'moderation.report_member_notice';

  test('every adapter builds a message, the rule DM once the rule has one', () => {
    for (const { descriptor, build } of moderationSimulations) {
      if (descriptor.id === needsDmAction) continue;
      const built = build(moderationDefaultConfig, scene());
      expect(built.ok ? built.output.kind : built.humanReason).toBe('message');
    }

    const refused = adapter(needsDmAction).build(moderationDefaultConfig, scene());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.humanReason).toContain('no message for the reported member');

    const config = withActions([{ kind: 'dm', message: { content: 'Hello {user.mention}' } }]);
    expect(run(needsDmAction, config).content).toBe(`Hello <@${subject.user.id}>`);
  });

  test('builds are pure: the same scene gives the same message and the config is untouched', () => {
    const config = configWith({ reports: { channelId: REPORT_CHANNEL } });
    const before = structuredClone(config);

    for (const { build } of moderationSimulations) {
      expect(build(config, scene())).toEqual(build(config, scene()));
    }

    expect(config).toEqual(before);
  });

  test('ids are synthesized from the event, never minted at random', () => {
    const config = configWith({});
    const first = run('moderation.report_card', config);
    const again = run('moderation.report_card', config);
    const other = run('moderation.report_card', config, {}, { ...scene(), eventId: 'other' });

    expect(first.embeds[0]?.title).toBe(again.embeds[0]?.title);
    expect(first.embeds[0]?.title).not.toBe(other.embeds[0]?.title);
    expect(first.embeds[0]?.title).toMatch(/^Report `[A-Za-z0-9]{7}` · #\d+$/);
  });
});

describe('the report card', () => {
  const config = configWith({
    reports: { channelId: REPORT_CHANNEL, notifyRoleIds: [NOTIFY_ROLE] },
  });
  const card = adapter('moderation.report_card');

  test('goes to the report channel', () => {
    expect(card.descriptor.delivery).toBe('channel');
    expect(card.descriptor.channelPath).toBe('reports.channelId');
    expect(card.destination?.(config, {})).toBe(REPORT_CHANNEL);
    expect(card.destination?.(moderationDefaultConfig, {})).toBeNull();
  });

  test('its buttons are keyed, so a test delivery disables every one', () => {
    const message = run('moderation.report_card', config);
    const buttons = buttonsOf(message);

    expect(buttons.map(({ key }) => key)).toEqual([
      REPORT_CARD_ACTIONS.claim,
      REPORT_CARD_ACTIONS.accept,
      REPORT_CARD_ACTIONS.dismiss,
      REPORT_CARD_ACTIONS.member,
      REPORT_CARD_ACTIONS.evidence,
    ]);
    for (const button of buttons) {
      expect(button.action).toBeUndefined();
      expect(button.url).toBeUndefined();
    }

    const test = asTestDelivery(message, reporter.user.id).message;
    expect(buttonsOf(test).every(({ disabled }) => disabled === true)).toBe(true);
    expect(test.mentions).toEqual({ everyone: false, roles: false, users: false });
  });

  test('shows the example member as reported and you as the reporter', () => {
    const fields = fieldsOf(run('moderation.report_card', config));

    expect(fields['Reported member']).toContain(`<@${subject.user.id}>`);
    expect(fields['Reported by']).toBe(`<@${reporter.user.id}>`);
    expect(fields.Status).toBe('Open · Waiting for staff');
  });

  test('an open report pings the notify roles as the first post would', () => {
    expect(run('moderation.report_card', config).content).toBe(`<@&${NOTIFY_ROLE}>`);
    expect(run('moderation.report_card', config, { status: 'dismissed' }).content).toBeUndefined();
  });

  test('status picks the buttons and the status line', () => {
    const claimed = run('moderation.report_card', config, { status: 'in_review' });
    expect(fieldsOf(claimed).Status).toBe(`In review · Claimed by <@${reporter.user.id}>`);
    expect(buttonsOf(claimed)[0]?.key).toBe(REPORT_CARD_ACTIONS.unclaim);

    const accepted = run('moderation.report_card', config, { status: 'accepted' });
    expect(fieldsOf(accepted).Status).toMatch(
      new RegExp(`^Accepted by <@${reporter.user.id}> · Warning · Case \`[A-Za-z0-9]{7}\`$`),
    );
    expect(buttonsOf(accepted).map(({ key }) => key)).toEqual([
      REPORT_CARD_ACTIONS.member,
      REPORT_CARD_ACTIONS.evidence,
    ]);
  });

  test('a message report quotes the sample message from the oldest text channel', () => {
    const message = run('moderation.report_card', config, { withMessage: true });
    const fields = fieldsOf(message);

    expect(fields.Source).toContain(`<#${OLDEST_TEXT}>`);
    expect(fields.Source).toContain(`https://discord.com/channels/${SAMPLE_SERVER.id}/`);
    expect(fields.Message).toContain('Sample message');
    expect(message.embeds[0]?.footer?.text).toBe('Submitted via Report message');
  });

  test('a member report has no source and no message', () => {
    const message = run('moderation.report_card', config, { withMessage: false });
    const fields = fieldsOf(message);

    expect(fields.Source).toBeUndefined();
    expect(fields.Message).toBeUndefined();
    expect(message.embeds[0]?.footer?.text).toBe('Submitted via Report user');
  });

  test('reasonIndex picks the server’s own reason, and past the end none', () => {
    expect(fieldsOf(run('moderation.report_card', config, { reasonIndex: 1 })).Reason).toBe(
      'Harassment or hate',
    );
    expect(fieldsOf(run('moderation.report_card', config, { reasonIndex: 24 })).Reason).toBe(
      'No reason picked',
    );
  });
});

describe('the reporter’s direct messages', () => {
  const config = configWith({ reports: { channelId: REPORT_CHANNEL } });

  test('each renders its own configured message, sent to you', () => {
    for (const kind of ['submitted', 'accepted', 'dismissed'] as const) {
      const sim = adapter(`moderation.report_${kind}`);
      expect(sim.descriptor.delivery).toBe('dm');
      expect(sim.descriptor.configPath).toBe(`reports.notifications.${kind}.message`);
      expect(sim.destination).toBeUndefined();

      const message = run(sim.descriptor.id, config);
      const text = message.embeds[0]?.description ?? '';
      expect(text).toContain(`**${SAMPLE_SERVER.name}**`);
      expect(text).toContain(subject.user.username ?? '');
      expect(message.mentions).toEqual({ everyone: false, roles: false, users: false });
    }
  });

  function notice(kind: string, content: string, inputs: Inputs = {}) {
    const edited = configWith({
      reports: {
        channelId: REPORT_CHANNEL,
        notifications: { [kind]: { enabled: true, message: { content } } },
      },
    });
    return adapter(`moderation.report_${kind}`).build(edited, scene(inputs));
  }

  test('the accepted message names the action picked and adds the note from staff', () => {
    const ban = messageOf(notice('accepted', '{report.action}')).content ?? '';
    expect(ban.split('\n')[0]).toBe('Ban');
    expect(ban).toContain('**Note from staff:** Sample note');

    const none = messageOf(notice('accepted', '{report.action}', { action: 'none' })).content;
    expect(none?.split('\n')[0]).toBe('No punishment');
  });

  test('the dismissed message carries the sample note once, where the message puts it', () => {
    for (const kind of ['accepted', 'dismissed'] as const) {
      const content = messageOf(notice(kind, 'Staff said: {report.explanation}')).content ?? '';
      expect(content).toContain('Staff said: Sample note');
      expect(content).not.toContain('Note from staff');
    }
  });

  test('the received message never carries a note', () => {
    expect(messageOf(notice('submitted', 'Filed {report.id}')).content).not.toContain(
      'Note from staff',
    );
  });

  test('the reported message link follows withMessage', () => {
    expect(messageOf(notice('submitted', '{report.message_url}')).content).toContain(
      `https://discord.com/channels/${SAMPLE_SERVER.id}/${OLDEST_TEXT}/`,
    );

    const built = notice('submitted', 'x {report.message_url}', { withMessage: false });
    expect(built.diagnostics.map(({ code }) => code)).toContain('not_set');
  });

  test('staff-only keys come back as diagnostics, not values', () => {
    const built = notice('submitted', 'Note: {report.internal_note}');
    expect(built.diagnostics.map(({ code }) => code)).toContain('restricted');
  });
});

describe('punishment messages', () => {
  test('the punished message follows the kind picked', () => {
    const config = configWith({});
    const timeout = run('moderation.punished', config, { kind: 'timeout' });
    expect(timeout.embeds[0]?.title).toBe(`You were timed out in ${SAMPLE_SERVER.name}`);
    expect(fieldsOf(timeout).Until).toMatch(/^<t:\d+:F>$/);

    const ban = run('moderation.punished', config, { kind: 'ban' });
    expect(ban.embeds[0]?.title).toBe(`You were banned from ${SAMPLE_SERVER.name}`);
    expect(fieldsOf(ban).Duration).toBe('Permanent');
  });

  test('the reason is the type’s default, then the first predefined reason', () => {
    const typed = configWith({ punish: { types: { warn: { defaultReason: 'Be kind' } } } });
    expect(run('moderation.punished', typed, { kind: 'warn' }).embeds[0]?.description).toBe(
      'Be kind',
    );

    const listed = configWith({ punish: { reasons: [{ id: 'ads', reason: 'Advertising' }] } });
    expect(run('moderation.punished', listed, { kind: 'kick' }).embeds[0]?.description).toBe(
      'Advertising',
    );
  });

  test('a lifted punishment that ran out has Proton as the moderator', () => {
    const config = configWith({
      punish: {
        notifications: {
          messages: { untimeout: { content: '{moderator.display_name}: {punishment.reason}' } },
        },
      },
    });

    expect(run('moderation.unpunished', config, { kind: 'untimeout', expired: true }).content).toBe(
      'Proton: Timeout expired.',
    );
    expect(run('moderation.unpunished', config, { kind: 'untimeout' }).content).toStartWith(
      `${reporter.user.globalName}:`,
    );
  });

  test('a warning never runs out', () => {
    const config = configWith({
      punish: { notifications: { messages: { unwarn: { content: '{punishment.expired}' } } } },
    });
    expect(run('moderation.unpunished', config, { kind: 'unwarn', expired: true }).content).toBe(
      'No',
    );
  });
});

describe('automation messages', () => {
  const alert = (extra: Partial<Extract<ActionInput, { kind: 'alert' }>> = {}): ActionInput => ({
    kind: 'alert',
    roleIds: [],
    message: {
      content: '{report.total_reports} reports from {report.reporter_count} about {target.id}',
    },
    ...extra,
  });

  test('the alert counts as few reports as the rule’s conditions allow', () => {
    const message = run('moderation.report_alert', withActions([alert()]));
    expect(message.content).toBe(`4 reports from 2 about ${subject.user.id}`);
  });

  test('the default alert renders from the default rule', () => {
    const message = run('moderation.report_alert', moderationDefaultConfig);
    expect(message.embeds[0]?.title).toBe(`Several members reported ${subject.user.username}`);
    expect(message.embeds[0]?.description).toContain('3 different members have filed 3 reports');
  });

  test('it posts in the action’s channel, else the report channel', () => {
    const sim = adapter('moderation.report_alert');
    expect(sim.destination?.(withActions([alert()]), {})).toBe(REPORT_CHANNEL);
    expect(sim.destination?.(withActions([alert({ channelId: ALERT_CHANNEL })]), {})).toBe(
      ALERT_CHANNEL,
    );
  });

  test('an index that is not an alert falls back to the rule’s first alert', () => {
    const config = withActions([
      { kind: 'dm', message: { content: 'dm' } },
      alert({ channelId: ALERT_CHANNEL }),
    ]);

    expect(adapter('moderation.report_alert').destination?.(config, { actionIndex: 0 })).toBe(
      ALERT_CHANNEL,
    );
    expect(run('moderation.report_alert', config, { actionIndex: 0 }).content).toStartWith('4');
  });

  test('a rule without an alert refuses and says why', () => {
    const built = adapter('moderation.report_alert').build(
      withActions([{ kind: 'dm', message: { content: 'dm' } }]),
      scene(),
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.humanReason).toContain('no staff alert');
  });

  test('role pings lead the alert as they would, and the test delivery pings nobody', () => {
    const config = withActions([
      alert({
        roleIds: [PING_ROLE],
        message: { content: 'Look', mentions: { everyone: false, roles: true, users: false } },
      }),
    ]);
    const message = run('moderation.report_alert', config);

    expect(message.content).toBe(`<@&${PING_ROLE}>\nLook`);
    expect(asTestDelivery(message, reporter.user.id).message.mentions.roles).toBe(false);

    const quiet = withActions([
      alert({
        roleIds: [PING_ROLE],
        message: { content: 'Look', mentions: { everyone: false, roles: false, users: false } },
      }),
    ]);
    expect(run('moderation.report_alert', quiet).content).toBe('Look');
  });
});

describe('member-facing messages cannot carry reporter data', () => {
  const reportId = () => {
    const title = run('moderation.report_card', configWith({})).embeds[0]?.title ?? '';
    return /`([A-Za-z0-9]{7})`/.exec(title)?.[1] ?? 'missing';
  };

  const hidden = REPORT_MEMBER_NOTICE_SURFACE.definitions
    .map(({ key }) => key)
    .filter((key) => key.startsWith('report.') || key.startsWith('target.'));

  function leaks(message: ProtonMessage): string[] {
    const text = everything(message);
    return [
      reporter.user.id,
      reporter.user.username ?? '',
      reporter.user.globalName ?? '',
      reportId(),
      'Sample details',
    ].filter((secret) => secret !== '' && text.includes(secret));
  }

  test('the rule’s DM to the reported member resolves no report or target key', () => {
    const template = hidden.map((key) => `{${key}}`).join(' ');
    const config = withActions([{ kind: 'dm', message: { content: `${template} {user.id}` } }]);
    const built = adapter('moderation.report_member_notice').build(config, scene());

    const restricted = built.diagnostics.filter(({ code }) => code === 'restricted');
    expect(restricted).toHaveLength(hidden.length);
    expect(hidden.length).toBeGreaterThan(10);

    if (built.ok && built.output.kind === 'message') {
      expect(leaks(built.output.message)).toEqual([]);
      expect(built.output.message.content).toContain(subject.user.id);
    }
  });

  test('punishment messages know nothing about any report', () => {
    const template = hidden.map((key) => `{${key}}`).join(' ');

    for (const id of MEMBER_FACING) {
      const direction = id === 'moderation.punished' ? 'warn' : 'unwarn';
      const config = configWith({
        punish: { notifications: { messages: { [direction]: { content: template } } } },
      });
      const built = adapter(id).build(config, scene({ kind: direction }));
      const codes = new Set(built.diagnostics.map(({ code }: PathDiagnostic) => code));

      expect(codes.has('restricted') || codes.has('unknown_placeholder')).toBe(true);
      if (built.ok && built.output.kind === 'message') {
        expect(leaks(built.output.message)).toEqual([]);
      }
    }
  });
});

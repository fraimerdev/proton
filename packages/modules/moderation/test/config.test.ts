import { describe, expect, test } from 'bun:test';
import { UnsupportedSchemaError, zodToDescriptors } from '@proton/core';
import {
  DM_DEFAULTS,
  dmMessageSchema,
  escalationLadderSchema,
  escalationRungSchema,
  liftStoredConfig,
  type ModerationConfig,
  moderationConfigSchema,
  moderationDefaultConfig,
  moderationFormSchema,
  PUNISH_DEFAULTS,
  PUNISH_DIRECTIONS,
  type PunishTypes,
  REPORTS_DEFAULTS,
  refineModerationWrite,
  staffMessageSchema,
} from '../src/config.ts';

const REPORT_CHANNEL = '500000000000000001';
const ARCHIVE_CHANNEL = '500000000000000002';
const ROLE = '410000000000000002';

const LADDER = [{ atWarnings: 2, action: 'kick' as const }];

function forcing(types: PunishTypes): PunishTypes {
  return {
    ban: { ...types.ban, forceReason: true },
    unban: { ...types.unban, forceReason: true },
    kick: { ...types.kick, forceReason: true },
    timeout: { ...types.timeout, forceReason: true },
    untimeout: { ...types.untimeout, forceReason: true },
    warn: { ...types.warn, forceReason: true },
    unwarn: { ...types.unwarn, forceReason: true },
  };
}

describe('moderation config', () => {
  test('the default config satisfies its own schema', () => {
    expect(moderationConfigSchema.safeParse(moderationDefaultConfig).success).toBe(true);
  });

  test('an empty object fills in every default, nested ones included', () => {
    expect(moderationConfigSchema.parse({})).toStrictEqual(moderationDefaultConfig);
  });

  test('a partial section keeps its siblings’ defaults', () => {
    const parsed = moderationConfigSchema.parse({
      punish: { types: { ban: { forceReason: true } } },
      reports: { limits: { cooldown: '5m' } },
    });

    expect(parsed.punish.types.ban).toStrictEqual({
      ...PUNISH_DEFAULTS.types.ban,
      forceReason: true,
    });
    expect(parsed.punish.types.kick).toStrictEqual(PUNISH_DEFAULTS.types.kick);
    expect(parsed.punish.notifications).toStrictEqual(PUNISH_DEFAULTS.notifications);
    expect(parsed.reports.limits).toStrictEqual({ ...REPORTS_DEFAULTS.limits, cooldown: '5m' });
    expect(parsed.reports.closing).toStrictEqual(REPORTS_DEFAULTS.closing);
  });

  test('the whole default round-trips through JSON unchanged', () => {
    const restored = moderationConfigSchema.parse(
      JSON.parse(JSON.stringify(moderationDefaultConfig)),
    );

    expect(restored).toStrictEqual(moderationDefaultConfig);
  });

  test('the default ladder escalates without kicking or banning', () => {
    for (const rung of moderationDefaultConfig.escalationLadder) {
      expect(rung.action).toBe('timeout');
    }
  });

  test('punishment DMs are off until a server turns them on', () => {
    const { notifications } = moderationDefaultConfig.punish;

    expect(notifications.onPunish).toBe(false);
    expect(notifications.onUnpunish).toBe(false);
    expect(notifications.onPunishByOthers).toBe(false);
    expect(notifications.onUnpunishByOthers).toBe(false);
  });

  test.each([...PUNISH_DIRECTIONS])('the default %s DM is a valid DM that pings nobody', (kind) => {
    const message = DM_DEFAULTS[kind];

    expect(dmMessageSchema.safeParse(message).success).toBe(true);
    expect(message.mentions).toEqual({ everyone: false, roles: false, users: false });
    expect(message.embeds[0]?.title).toContain('{server.name}');
  });

  test('user reports start switched off, with five reasons and one staff alert rule', () => {
    const { reports } = moderationDefaultConfig;

    expect(reports.enabled).toBe(false);
    expect(reports.reasons.map((reason) => reason.id)).toEqual([
      'spam',
      'harassment',
      'nsfw',
      'scam',
      'impersonation',
    ]);
    expect(reports.automation).toHaveLength(1);
    expect(reports.automation[0]).toMatchObject({
      id: 'several',
      enabled: true,
      conditions: { reporters: 3, reports: null, unreviewedFor: null },
      actions: [{ kind: 'alert', roleIds: [] }],
    });
    expect(reports.notifications.submitted.enabled).toBe(false);
    expect(reports.notifications.accepted.enabled).toBe(true);
    expect(reports.notifications.dismissed.enabled).toBe(true);
  });

  test('a DM or a staff alert can carry link buttons but nothing that needs an answer', () => {
    const withButton = (style: 'link' | 'primary') => ({
      content: 'hello',
      components: [
        {
          kind: 'buttons',
          buttons: [
            style === 'link'
              ? { key: 'rules', style, label: 'Rules', url: 'https://example.com/rules' }
              : {
                  key: 'thanks',
                  style,
                  label: 'Thanks',
                  action: { kind: 'reply', content: 'Thanks' },
                },
          ],
        },
      ],
    });

    expect(dmMessageSchema.safeParse(withButton('link')).success).toBe(true);
    expect(dmMessageSchema.safeParse(withButton('primary')).success).toBe(false);
    expect(staffMessageSchema.safeParse(withButton('link')).success).toBe(true);
    expect(staffMessageSchema.safeParse(withButton('primary')).success).toBe(false);
  });
});

describe('a v2 row', () => {
  const v2 = {
    enabled: true,
    requireReason: true,
    publicReplies: false,
    defaultTimeoutDuration: '2h',
    defaultBanDeleteDays: 3,
    escalationWindow: '7d',
    escalationLadder: LADDER,
  };

  const forced = forcing(PUNISH_DEFAULTS.types);

  const v3: ModerationConfig = {
    enabled: true,
    publicReplies: false,
    escalationWindow: '7d',
    escalationLadder: LADDER,
    punish: {
      ...PUNISH_DEFAULTS,
      types: {
        ...forced,
        timeout: { ...forced.timeout, defaultDuration: '2h' },
        ban: { ...forced.ban, deleteMessageDays: 3 },
      },
    },
    reports: REPORTS_DEFAULTS,
  };

  test('reads as the equivalent v3 config', () => {
    expect(moderationConfigSchema.parse(liftStoredConfig(v2))).toStrictEqual(v3);
  });

  test('survives a re-parse, and a lifted config is not lifted again', () => {
    const stored = JSON.parse(JSON.stringify(moderationConfigSchema.parse(liftStoredConfig(v2))));

    expect(liftStoredConfig(stored)).toBe(stored);
    expect(moderationConfigSchema.parse(liftStoredConfig(stored))).toStrictEqual(v3);
  });

  test('a row stored before moderation owned the ladder gets the default one', () => {
    const older = {
      enabled: true,
      requireReason: true,
      publicReplies: false,
      defaultTimeoutDuration: '2h',
      defaultBanDeleteDays: 3,
    };

    expect(moderationConfigSchema.parse(liftStoredConfig(older))).toStrictEqual({
      ...v3,
      escalationWindow: '30d',
      escalationLadder: moderationDefaultConfig.escalationLadder,
    });
  });

  test('a first write lifts the legacy keys a raw v2 current still holds', () => {
    const lifted = moderationConfigSchema.parse(liftStoredConfig({ enabled: false }, v2));

    expect(lifted).toStrictEqual({ ...v3, enabled: false });
  });
});

describe('a save that omits punish and reports', () => {
  const current = moderationConfigSchema.parse({
    escalationWindow: '7d',
    escalationLadder: LADDER,
    punish: {
      types: { ban: { forceReason: true }, timeout: { defaultDuration: '45m' } },
      extendTimeouts: true,
    },
    reports: { enabled: true, channelId: REPORT_CHANNEL, requireComment: true },
  });

  const staleTab = {
    enabled: true,
    requireReason: false,
    publicReplies: true,
    defaultTimeoutDuration: '5m',
    defaultBanDeleteDays: 7,
    escalationWindow: '7d',
    escalationLadder: LADDER,
  };

  test('a stale v2 tab changes what it shows and carries everything else', () => {
    const saved = moderationConfigSchema.parse(liftStoredConfig(staleTab, current));

    expect(saved).toStrictEqual({ ...current, publicReplies: true });
  });

  test('a stale v2 tab does not change a per-type forced reason', () => {
    const saved = moderationConfigSchema.parse(liftStoredConfig(staleTab, current));

    expect(saved.punish.types.ban.forceReason).toBe(true);
    expect(saved.punish.types.kick.forceReason).toBe(false);
    expect(saved.punish.types.ban.deleteMessageDays).toBe(0);
    expect(saved.punish.types.timeout.defaultDuration).toBe('45m');
  });

  test('an enabled-only toggle keeps every section', () => {
    expect(
      moderationConfigSchema.parse(liftStoredConfig({ enabled: false }, current)),
    ).toStrictEqual({ ...current, enabled: false });

    const echoed = { ...current, enabled: false };
    expect(liftStoredConfig(echoed, current)).toBe(echoed);
  });

  test('a page that sends the ladder is taken at its word, even an emptied one', () => {
    const emptied = { ...current, escalationLadder: [] };

    expect(liftStoredConfig(emptied, current)).toBe(emptied);
  });

  test('a v3 config with nothing to carry is read as it is', () => {
    const stored = { ...current };

    expect(liftStoredConfig(stored)).toBe(stored);
  });

  test('anything that is not a config object passes through', () => {
    expect(liftStoredConfig(null, current)).toBeNull();
    expect(liftStoredConfig('nonsense', current)).toBe('nonsense');
    expect(liftStoredConfig([1, 2], current)).toEqual([1, 2]);
  });
});

describe('escalation ladder validation', () => {
  test('accepts a rung the rule engine can actually build', () => {
    expect(
      escalationRungSchema.safeParse({ atWarnings: 3, action: 'timeout', duration: '1h' }).success,
    ).toBe(true);
  });

  test('refuses a rung at one warning, which no rate window can express', () => {
    expect(escalationRungSchema.safeParse({ atWarnings: 1, action: 'kick' }).success).toBe(false);
  });

  test('refuses a timeout with no duration', () => {
    const result = moderationConfigSchema.safeParse({
      escalationLadder: [{ atWarnings: 3, action: 'timeout' }],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('timeout');
  });

  test('allows a ban with no duration — that is a permanent ban', () => {
    const result = moderationConfigSchema.safeParse({
      escalationLadder: [{ atWarnings: 3, action: 'ban' }],
    });

    expect(result.success).toBe(true);
  });

  test('refuses two rungs at the same warning count', () => {
    const result = moderationConfigSchema.safeParse({
      escalationLadder: [
        { atWarnings: 3, action: 'kick' },
        { atWarnings: 3, action: 'ban' },
      ],
    });

    expect(result.success).toBe(false);
  });

  test('refuses a ladder that is not ordered by warning count', () => {
    const result = moderationConfigSchema.safeParse({
      escalationLadder: [
        { atWarnings: 5, action: 'ban' },
        { atWarnings: 3, action: 'kick' },
      ],
    });

    expect(result.success).toBe(false);
  });

  test('the refusals are worded exactly as the dashboard repeats them', () => {
    const unordered = escalationLadderSchema.safeParse([
      { atWarnings: 5, action: 'ban' },
      { atWarnings: 3, action: 'kick' },
    ]);
    const bare = escalationLadderSchema.safeParse([{ atWarnings: 3, action: 'timeout' }]);

    expect(unordered.error?.issues.map((i) => i.message)).toEqual([
      'Each step needs a higher warning count than the one before it. Two steps at the same ' +
        'count would both run.',
    ]);
    expect(bare.error?.issues.map((i) => i.message)).toEqual([
      'A timeout step needs a duration, like 1h.',
    ]);
  });
});

describe('form generation (PLAN.md §9)', () => {
  test('the full config schema is refused, naming the ladder', () => {
    expect(() => zodToDescriptors(moderationConfigSchema)).toThrow(UnsupportedSchemaError);
    expect(() => zodToDescriptors(moderationConfigSchema)).toThrow(/escalationLadder/);
    expect(() => zodToDescriptors(moderationConfigSchema)).toThrow(/arrays must be flat/);
  });

  test('the form schema generates exactly the fields the dashboard can render', () => {
    const descriptors = zodToDescriptors(moderationFormSchema);

    expect(descriptors.map((d) => [d.path, d.kind])).toEqual([
      ['enabled', 'boolean'],
      ['publicReplies', 'boolean'],
      ['escalationWindow', 'duration'],
    ]);
  });

  test('the form schema is the config schema minus the ladder, punish and reports', () => {
    expect(Object.keys(moderationFormSchema.shape)).toEqual(
      Object.keys(moderationConfigSchema.shape).filter(
        (key) => !['escalationLadder', 'punish', 'reports'].includes(key),
      ),
    );
  });
});

function issuesFor(input: Record<string, unknown>) {
  return refineModerationWrite(moderationConfigSchema.parse(input), moderationDefaultConfig);
}

function pathsFor(input: Record<string, unknown>): string[] {
  return issuesFor(input).map((issue) => issue.path);
}

function sapphire(variable: string): string {
  return `\${${variable}}`;
}

describe('write refinements', () => {
  test('the default config saves cleanly', () => {
    expect(refineModerationWrite(moderationDefaultConfig, moderationDefaultConfig)).toEqual([]);
  });

  test('refuses a reason policy nobody could satisfy', () => {
    expect(
      issuesFor({ reports: { requireReason: true, reasons: [], allowCustomReason: false } }),
    ).toEqual([
      {
        path: 'reports.requireReason',
        message: 'Add a reason or let members write their own. Otherwise nobody can file a report.',
      },
    ]);

    expect(
      pathsFor({ reports: { requireReason: false, reasons: [], allowCustomReason: false } }),
    ).toEqual([]);
  });

  test('switched-on reports need a channel and at least one method', () => {
    expect(pathsFor({ reports: { enabled: true } })).toEqual(['reports.channelId']);

    expect(
      pathsFor({
        reports: {
          enabled: true,
          channelId: REPORT_CHANNEL,
          methods: { command: false, userMenu: false, messageMenu: false, reaction: false },
        },
      }),
    ).toEqual(['reports.methods']);

    expect(pathsFor({ reports: { enabled: true, channelId: REPORT_CHANNEL } })).toEqual([]);
  });

  test('the reaction reason must be one of the reasons', () => {
    expect(pathsFor({ reports: { reaction: { reasonId: 'spam' } } })).toEqual([]);
    expect(pathsFor({ reports: { reaction: { reasonId: 'gone' } } })).toEqual([
      'reports.reaction.reasonId',
    ]);
  });

  test('report reasons need distinct ids and labels', () => {
    expect(
      pathsFor({
        reports: {
          reasons: [
            { id: 'spam', label: 'Spam' },
            { id: 'SPAM', label: 'Flooding' },
            { id: 'other', label: ' spam ' },
          ],
        },
      }),
    ).toEqual(['reports.reasons.1.id', 'reports.reasons.2.label']);
  });

  test('moving closed reports needs a channel that is not the report channel', () => {
    const move = (channelId?: string) => ({
      reports: {
        channelId: REPORT_CHANNEL,
        closing: { accepted: { mode: 'move', ...(channelId ? { channelId } : {}) } },
      },
    });

    expect(pathsFor(move())).toEqual(['reports.closing.accepted.channelId']);
    expect(pathsFor(move(REPORT_CHANNEL))).toEqual(['reports.closing.accepted.channelId']);
    expect(pathsFor(move(ARCHIVE_CHANNEL))).toEqual([]);
  });

  test('a rule that punishes needs the risk acknowledged', () => {
    const rule = (acknowledgedRisk: boolean) => ({
      reports: {
        automation: [
          {
            id: 'auto',
            name: 'Auto timeout',
            conditions: { reports: 5 },
            actions: [
              { kind: 'punish', punishment: 'timeout', duration: '1h', reason: 'Reported a lot' },
            ],
            acknowledgedRisk,
          },
        ],
      },
    });

    expect(pathsFor(rule(false))).toEqual(['reports.automation.0.acknowledgedRisk']);
    expect(pathsFor(rule(true))).toEqual([]);
  });

  test('a rule needs a condition, an action and its own id', () => {
    expect(
      pathsFor({
        reports: {
          automation: [
            { id: 'empty', name: 'Empty' },
            {
              id: 'EMPTY',
              name: 'Again',
              conditions: { reporters: 2 },
              actions: [{ kind: 'add_role', roleId: ROLE }],
            },
          ],
        },
      }),
    ).toEqual([
      'reports.automation.0.conditions',
      'reports.automation.0.actions',
      'reports.automation.1.id',
    ]);
  });

  test('open-report limits and comment lengths must agree', () => {
    expect(pathsFor({ reports: { limits: { maxOpenPerServer: 5, maxOpenPerMember: 6 } } })).toEqual(
      ['reports.limits.maxOpenPerMember'],
    );
    expect(pathsFor({ reports: { limits: { commentMin: 400, commentMax: 300 } } })).toEqual([
      'reports.limits.commentMin',
    ]);
    expect(pathsFor({ reports: { requireComment: true } })).toEqual([]);
    expect(pathsFor({ reports: { requireComment: true, limits: { commentMin: 1 } } })).toEqual([]);
  });

  test('predefined reason aliases are unique and never another reason’s id', () => {
    expect(
      pathsFor({
        punish: {
          reasons: [
            { id: 'spam', reason: 'Spamming', aliases: ['spam', 's'] },
            { id: 'ads', reason: 'Advertising', aliases: ['s', 'spam', 'ad', 'ad'] },
            { id: 'Spam', reason: 'Spam again' },
          ],
        },
      }),
    ).toEqual([
      'punish.reasons.2.id',
      'punish.reasons.1.aliases.0',
      'punish.reasons.1.aliases.1',
      'punish.reasons.1.aliases.3',
    ]);
  });

  test('a Sapphire variable in an audit reason is refused with the Proton equivalent', () => {
    const issues = issuesFor({
      punish: {
        types: { ban: { auditReason: `${sapphire('authortag')}: ${sapphire('reason')}` } },
      },
    });

    expect(issues.map((issue) => issue.path)).toEqual(['punish.types.ban.auditReason']);
    expect(issues[0]?.message).toContain(`{moderator.username} for ${sapphire('authortag')}`);
    expect(issues[0]?.message).toContain(`{punishment.reason} for ${sapphire('reason')}`);
  });

  test('a default timeout past 28 days needs Extend timeouts, and nothing passes 365 days', () => {
    const timeout = (defaultDuration: string, extendTimeouts = false) => ({
      punish: { types: { timeout: { defaultDuration } }, extendTimeouts },
    });

    expect(pathsFor(timeout('28d'))).toEqual([]);
    expect(pathsFor(timeout('29d'))).toEqual(['punish.types.timeout.defaultDuration']);
    expect(pathsFor(timeout('29d', true))).toEqual([]);
    expect(pathsFor(timeout('366d', true))).toEqual(['punish.types.timeout.defaultDuration']);
    expect(pathsFor(timeout('0m'))).toEqual(['punish.types.timeout.defaultDuration']);
    expect(pathsFor({ punish: { types: { ban: { defaultDuration: '400d' } } } })).toEqual([
      'punish.types.ban.defaultDuration',
    ]);
  });

  test('a role cannot be both added and removed on the same punishment', () => {
    expect(
      pathsFor({
        punish: { types: { warn: { actions: { addRoleIds: [ROLE], removeRoleIds: [ROLE] } } } },
      }),
    ).toEqual(['punish.types.warn.actions.removeRoleIds']);
  });

  test('an issue the stored config already has does not block saving the rest', () => {
    const lifted = moderationConfigSchema.parse(
      liftStoredConfig({ enabled: true, defaultTimeoutDuration: '30d' }),
    );

    expect(refineModerationWrite({ ...lifted, enabled: false }, lifted)).toEqual([]);

    const withSapphire = {
      ...lifted,
      punish: {
        ...lifted.punish,
        types: {
          ...lifted.punish.types,
          ban: { ...lifted.punish.types.ban, auditReason: sapphire('reason') },
        },
      },
    };
    expect(refineModerationWrite(withSapphire, lifted).map((issue) => issue.path)).toEqual([
      'punish.types.ban.auditReason',
    ]);
  });
});

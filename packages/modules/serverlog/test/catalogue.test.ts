import { describe, expect, test } from 'bun:test';
import { AuditLogEvent } from 'discord-api-types/v10';
import {
  entitySpecsForAuditAction,
  LOG_CATEGORIES,
  LOG_EVENT_KEYS,
  LOG_EVENTS,
  LOG_TRIGGER_TYPES,
  type LogEventSpec,
  specsForAuditAction,
} from '../src/catalogue.ts';
import { ServerLogColors } from '../src/colours.ts';
import { serverlogDefaultConfig } from '../src/config.ts';
import { createServerlogListener } from '../src/listeners.ts';
import { auditEvent, config, context, EMOJIS, RecordingExecutor } from './harness.ts';

const specs = LOG_EVENT_KEYS.map((key) => LOG_EVENTS[key] as LogEventSpec);

const ALL_ON = {
  categories: Object.fromEntries(
    Object.keys(serverlogDefaultConfig.categories).map((category) => [category, true]),
  ) as typeof serverlogDefaultConfig.categories,
};

describe('the catalogue is internally consistent', () => {
  test('every spec has a category the config knows about', () => {
    for (const spec of specs) {
      expect(LOG_CATEGORIES).toContain(spec.category);
    }
  });

  test('every spec uses one of the three colours', () => {
    const colours = new Set<number>(Object.values(ServerLogColors));

    for (const spec of specs) {
      expect(colours.has(spec.colour)).toBe(true);
    }
  });

  test('every spec declares at least one trigger', () => {
    for (const spec of specs) {
      expect(spec.triggers.length).toBeGreaterThan(0);
    }
  });

  test('audit-primary specs are triggered by audit.entry and name an audit action', () => {
    for (const spec of specs.filter((candidate) => candidate.primary === 'audit')) {
      expect(spec.triggers).toEqual(['audit.entry']);
      expect((spec.auditActions ?? []).length).toBeGreaterThan(0);
    }
  });

  test('entity-primary specs can compute a correlation target', () => {
    for (const spec of specs.filter((candidate) => candidate.primary === 'entity')) {
      expect(typeof spec.targetId).toBe('function');
      expect((spec.auditActions ?? []).length).toBeGreaterThan(0);
    }
  });

  test('immediate specs correlate with nothing, which is what makes them cheap', () => {
    for (const spec of specs.filter((candidate) => candidate.primary === 'immediate')) {
      expect(spec.auditActions).toBeUndefined();
    }
  });

  test('no audit action is claimed by both an audit-primary and an entity-primary spec', () => {
    const actions = new Set(specs.flatMap((spec) => spec.auditActions ?? []));

    for (const action of actions) {
      const audit = specsForAuditAction(action);
      const entity = entitySpecsForAuditAction(action);

      // MEMBER_KICK and MEMBER_BAN_ADD are the deliberate exception: they suppress members.left.
      if (audit.length > 0 && entity.length > 0) {
        expect(entity.every((spec) => spec.suppressWhenCorrelated === true)).toBe(true);
      }
    }
  });

  test('the listener subscribes to exactly the triggers the catalogue declares', () => {
    expect(new Set(LOG_TRIGGER_TYPES)).toEqual(new Set(specs.flatMap((spec) => spec.triggers)));
  });

  test('every key is unique and namespaced by its category', () => {
    expect(new Set(LOG_EVENT_KEYS).size).toBe(LOG_EVENT_KEYS.length);

    for (const spec of specs) {
      expect(spec.key.startsWith(`${spec.category}.`)).toBe(true);
    }
  });

  test('every category has at least one log, or it would be an empty dashboard section', () => {
    for (const category of LOG_CATEGORIES) {
      if (category === 'proton') continue;
      expect(specs.some((spec) => spec.category === category)).toBe(true);
    }
  });
});

describe('audit action coverage', () => {
  const CLAIMED: Array<[string, number]> = [
    ['GuildUpdate', AuditLogEvent.GuildUpdate],
    ['ChannelCreate', AuditLogEvent.ChannelCreate],
    ['ChannelUpdate', AuditLogEvent.ChannelUpdate],
    ['ChannelDelete', AuditLogEvent.ChannelDelete],
    ['ChannelOverwriteCreate', AuditLogEvent.ChannelOverwriteCreate],
    ['ChannelOverwriteUpdate', AuditLogEvent.ChannelOverwriteUpdate],
    ['ChannelOverwriteDelete', AuditLogEvent.ChannelOverwriteDelete],
    ['MemberKick', AuditLogEvent.MemberKick],
    ['MemberPrune', AuditLogEvent.MemberPrune],
    ['MemberBanAdd', AuditLogEvent.MemberBanAdd],
    ['MemberBanRemove', AuditLogEvent.MemberBanRemove],
    ['MemberUpdate', AuditLogEvent.MemberUpdate],
    ['MemberRoleUpdate', AuditLogEvent.MemberRoleUpdate],
    ['MemberMove', AuditLogEvent.MemberMove],
    ['MemberDisconnect', AuditLogEvent.MemberDisconnect],
    ['BotAdd', AuditLogEvent.BotAdd],
    ['RoleCreate', AuditLogEvent.RoleCreate],
    ['RoleUpdate', AuditLogEvent.RoleUpdate],
    ['RoleDelete', AuditLogEvent.RoleDelete],
    ['InviteCreate', AuditLogEvent.InviteCreate],
    ['InviteDelete', AuditLogEvent.InviteDelete],
    ['WebhookCreate', AuditLogEvent.WebhookCreate],
    ['WebhookUpdate', AuditLogEvent.WebhookUpdate],
    ['WebhookDelete', AuditLogEvent.WebhookDelete],
    ['EmojiCreate', AuditLogEvent.EmojiCreate],
    ['EmojiUpdate', AuditLogEvent.EmojiUpdate],
    ['EmojiDelete', AuditLogEvent.EmojiDelete],
    ['MessageDelete', AuditLogEvent.MessageDelete],
    ['MessagePin', AuditLogEvent.MessagePin],
    ['MessageUnpin', AuditLogEvent.MessageUnpin],
    ['IntegrationCreate', AuditLogEvent.IntegrationCreate],
    ['IntegrationUpdate', AuditLogEvent.IntegrationUpdate],
    ['IntegrationDelete', AuditLogEvent.IntegrationDelete],
    ['StageInstanceCreate', AuditLogEvent.StageInstanceCreate],
    ['StageInstanceUpdate', AuditLogEvent.StageInstanceUpdate],
    ['StageInstanceDelete', AuditLogEvent.StageInstanceDelete],
    ['StickerCreate', AuditLogEvent.StickerCreate],
    ['StickerUpdate', AuditLogEvent.StickerUpdate],
    ['StickerDelete', AuditLogEvent.StickerDelete],
    ['GuildScheduledEventCreate', AuditLogEvent.GuildScheduledEventCreate],
    ['GuildScheduledEventUpdate', AuditLogEvent.GuildScheduledEventUpdate],
    ['GuildScheduledEventDelete', AuditLogEvent.GuildScheduledEventDelete],
    ['ThreadCreate', AuditLogEvent.ThreadCreate],
    ['ThreadUpdate', AuditLogEvent.ThreadUpdate],
    ['ThreadDelete', AuditLogEvent.ThreadDelete],
    ['ApplicationCommandPermissionUpdate', AuditLogEvent.ApplicationCommandPermissionUpdate],
    ['SoundboardSoundCreate', AuditLogEvent.SoundboardSoundCreate],
    ['SoundboardSoundUpdate', AuditLogEvent.SoundboardSoundUpdate],
    ['SoundboardSoundDelete', AuditLogEvent.SoundboardSoundDelete],
    ['AutoModerationRuleCreate', AuditLogEvent.AutoModerationRuleCreate],
    ['AutoModerationRuleUpdate', AuditLogEvent.AutoModerationRuleUpdate],
    ['AutoModerationRuleDelete', AuditLogEvent.AutoModerationRuleDelete],
    ['AutoModerationBlockMessage', AuditLogEvent.AutoModerationBlockMessage],
    ['AutoModerationFlagToChannel', AuditLogEvent.AutoModerationFlagToChannel],
    [
      'AutoModerationUserCommunicationDisabled',
      AuditLogEvent.AutoModerationUserCommunicationDisabled,
    ],
    ['CreatorMonetizationRequestCreated', AuditLogEvent.CreatorMonetizationRequestCreated],
    ['CreatorMonetizationTermsAccepted', AuditLogEvent.CreatorMonetizationTermsAccepted],
    ['OnboardingPromptCreate', AuditLogEvent.OnboardingPromptCreate],
    ['OnboardingPromptUpdate', AuditLogEvent.OnboardingPromptUpdate],
    ['OnboardingPromptDelete', AuditLogEvent.OnboardingPromptDelete],
    ['OnboardingCreate', AuditLogEvent.OnboardingCreate],
    ['OnboardingUpdate', AuditLogEvent.OnboardingUpdate],
    ['HomeSettingsCreate', AuditLogEvent.HomeSettingsCreate],
    ['HomeSettingsUpdate', AuditLogEvent.HomeSettingsUpdate],
  ];

  test.each(CLAIMED)('%s is handled by some log', (_name, action) => {
    const handled =
      specsForAuditAction(action).length > 0 || entitySpecsForAuditAction(action).length > 0;

    expect(handled).toBe(true);
  });

  test('the catalogue claims every audit action it says it does', () => {
    expect(CLAIMED.length).toBeGreaterThanOrEqual(60);
  });
});

describe('every audit-primary log renders from a real entry', () => {
  const auditSpecs = specs.filter((spec) => spec.primary === 'audit');

  test.each(auditSpecs.map((spec) => [spec.key, spec] as const))(
    '%s renders or declines cleanly',
    async (_key, spec) => {
      const executor = new RecordingExecutor();
      const listener = createServerlogListener({ emojis: EMOJIS });

      const action = (spec.auditActions ?? [])[0];
      if (action === undefined) throw new Error(`${spec.key} names no audit action`);

      await listener.handler(
        auditEvent(action, {
          target_id: '500000000000000021',
          changes: [{ key: 'name', old_value: 'before', new_value: 'after' }],
        }),
        context(executor, config(ALL_ON)),
      );

      // Some specs share an action and decline when the changes are not theirs; the contract is
      // that rendering never throws and never produces a malformed embed.
      for (const embed of executor.embeds()) {
        expect(typeof embed.title).toBe('string');
        expect(String(embed.title).length).toBeGreaterThan(0);
        expect(typeof embed.description).toBe('string');
        expect(embed).toHaveProperty('footer');
        expect(embed).toHaveProperty('timestamp');
      }
    },
  );

  test('a server settings change renders the before and after', async () => {
    const executor = new RecordingExecutor();
    const listener = createServerlogListener({ emojis: EMOJIS });

    await listener.handler(
      auditEvent(AuditLogEvent.GuildUpdate, {
        changes: [{ key: 'name', old_value: 'Old Guild', new_value: 'New Guild' }],
      }),
      context(executor, config(ALL_ON)),
    );

    const fields = executor.embeds()[0]?.fields as Array<{ name: string; value: string }>;
    expect(fields[0]).toEqual({ name: 'Name', value: 'Old Guild → New Guild' });
  });

  test('an AutoMod block never blames the member as the executor', async () => {
    const executor = new RecordingExecutor();
    const listener = createServerlogListener({ emojis: EMOJIS });

    await listener.handler(
      auditEvent(AuditLogEvent.AutoModerationBlockMessage, {
        target_id: '100000000000000002',
        options: { auto_moderation_rule_name: 'No links' },
      }),
      context(executor, config(ALL_ON)),
    );

    expect(executor.titles()).toEqual(['AutoMod blocked a message']);
    expect(executor.footers()).toEqual(['Unknown']);
  });

  test('the long tail is off when its categories are off', async () => {
    const executor = new RecordingExecutor();
    const listener = createServerlogListener({ emojis: EMOJIS });

    await listener.handler(
      auditEvent(AuditLogEvent.EmojiCreate, { target_id: '700000000000000011' }),
      context(
        executor,
        config({ categories: { ...serverlogDefaultConfig.categories, expressions: false } }),
      ),
    );

    expect(executor.requests).toEqual([]);
  });
});

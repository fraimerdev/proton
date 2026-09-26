import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TIER_COLOURS } from '@proton/cards/design';
import {
  type ModuleManifest,
  ModuleRegistry,
  Permissions,
  personFor,
  type SimulationBuild,
  type SimulationScene,
  simulationDescriptorSchema,
} from '@proton/core';
import { type ChannelFacts, SAMPLE_NOW } from '@proton/core/placeholders';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  type AchievementInput,
  type AchievementsConfig,
  type AchievementsConfigInput,
  achievementsConfigSchema,
  achievementsDefaultConfig,
} from '../src/config.ts';
import { achievementsTemplates } from '../src/placeholders.ts';
import {
  ACHIEVEMENTS_ALMOST_THERE_DM_SIMULATION,
  ACHIEVEMENTS_ALMOST_THERE_SIMULATION,
  ACHIEVEMENTS_UNLOCKED_DM_SIMULATION,
  ACHIEVEMENTS_UNLOCKED_SIMULATION,
  achievementsSimulations,
} from '../src/simulation.ts';

const GUILD = '100000000000000001';
const CHANNEL = '800000000000000001';
const OTHER_CHANNEL = '800000000000000002';
const ROLE_A = '800000000000000021';
const USER = '900000000000000002';
const ADMIN = '900000000000000003';

const SUBJECT = personFor(
  { id: USER, username: 'member', globalName: 'Member', avatarHash: null },
  { nick: null, roleIds: [] },
);

const ACTOR = personFor(
  { id: ADMIN, username: 'admin', globalName: 'Admin', avatarHash: null },
  'unavailable',
);

const PICKED: ChannelFacts = { id: CHANNEL, name: 'achievements', parentId: null };

function scene(
  inputs: Record<string, string | number | boolean> = {},
  channel: ChannelFacts | null = PICKED,
): SimulationScene {
  return {
    guildId: GUILD,
    server: { id: GUILD, name: 'Test server' },
    guildState: null,
    subject: SUBJECT,
    actor: ACTOR,
    destinationChannel: channel,
    originChannel: channel,
    bot: null,
    eventId: 'event-1',
    now: SAMPLE_NOW,
    tier: 'free',
    inputs,
  };
}

function config(input: AchievementsConfigInput = {}): AchievementsConfig {
  return achievementsConfigSchema.parse(input);
}

function achievement(overrides: Partial<AchievementInput> = {}): AchievementInput {
  return {
    id: 'chatterbox',
    name: 'Chatterbox',
    status: 'active',
    kind: 'tiered',
    requirements: [{ id: 'msgs', trigger: 'messages.sent' }],
    tiers: [
      { id: 'bronze', targets: { msgs: 10 }, rewards: [{ kind: 'add_role', roleId: ROLE_A }] },
      { id: 'silver', targets: { msgs: 100 }, rewards: [{ kind: 'xp', amount: 50 }] },
      { id: 'gold', targets: { msgs: 1000 } },
    ],
    almostThere: { enabled: true },
    ...overrides,
  };
}

function built(result: SimulationBuild) {
  if (!result.ok) throw new Error(result.humanReason);
  if (result.output.kind !== 'message') throw new Error('expected a message');
  return { ...result.output, caption: result.caption, diagnostics: result.diagnostics };
}

function refusal(result: SimulationBuild): string {
  if (result.ok) throw new Error('expected a refusal');
  return result.humanReason;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

describe('descriptors', () => {
  test('every descriptor is valid and renders through its own surface', () => {
    const ids = achievementsSimulations.map(({ descriptor }) => descriptor.id);

    expect(ids).toEqual([
      'achievements.unlocked',
      'achievements.unlocked_dm',
      'achievements.almost_there',
      'achievements.almost_there_dm',
    ]);

    for (const { descriptor } of achievementsSimulations) {
      expect(simulationDescriptorSchema.parse(descriptor)).toEqual(descriptor);
      expect(descriptor.surfaceId).toBe(descriptor.id);
      expect(Object.hasOwn(achievementsTemplates.surfaces, descriptor.id)).toBe(true);
      expect(descriptor.subject).toBe(true);
      expect(descriptor.output).toBe('message');
      expect(descriptor.note).toBe(
        'Nothing is earned or saved and no role or XP is given. Progress and rewards are sample values.',
      );
    }
  });

  test('inputs follow the design', () => {
    const keys = (adapter: typeof ACHIEVEMENTS_UNLOCKED_SIMULATION) =>
      adapter.descriptor.inputs.map(({ key, kind }) => `${key}:${kind}`);

    expect(keys(ACHIEVEMENTS_UNLOCKED_SIMULATION)).toEqual([
      'achievement:text',
      'tier:choice',
      'rewards:choice',
    ]);
    expect(keys(ACHIEVEMENTS_ALMOST_THERE_DM_SIMULATION)).toEqual([
      'achievement:text',
      'tier:choice',
      'percent:integer',
    ]);
    expect(ACHIEVEMENTS_UNLOCKED_SIMULATION.descriptor.inputs[0]?.fixed).toBe(true);
    expect(ACHIEVEMENTS_ALMOST_THERE_SIMULATION.descriptor.inputs[2]).toMatchObject({
      min: 50,
      max: 99,
    });
    expect(ACHIEVEMENTS_UNLOCKED_SIMULATION.descriptor.channelPath).toBe('announcement.channelId');
    expect(ACHIEVEMENTS_ALMOST_THERE_SIMULATION.descriptor.channelPath).toBe(
      'almostThere.channelId',
    );
    expect(ACHIEVEMENTS_UNLOCKED_DM_SIMULATION.descriptor.delivery).toBe('dm');
    expect(ACHIEVEMENTS_ALMOST_THERE_DM_SIMULATION.descriptor.delivery).toBe('dm');
  });

  test('the registry accepts them at boot', () => {
    const manifest = {
      id: 'achievements',
      name: 'Achievements',
      category: 'engagement',
      configSchema: achievementsConfigSchema.pick({ enabled: true }),
      defaultConfig: { enabled: false },
      schemaVersion: 1,
      requiredIntents: [GatewayIntentBits.Guilds],
      requiredPermissions: [Permissions.ViewChannel],
      templates: achievementsTemplates,
      simulations: achievementsSimulations,
    } as unknown as ModuleManifest;

    const registry = new ModuleRegistry();
    registry.register(manifest);

    expect(registry.simulations('achievements')).toHaveLength(4);
  });
});

describe('build', () => {
  test('every adapter builds the sample when no achievement is named', () => {
    const unlocked = built(
      ACHIEVEMENTS_UNLOCKED_SIMULATION.build(achievementsDefaultConfig, scene()),
    );
    expect(unlocked.caption).toBe('Member earning Chatterbox (Gold)');
    expect(unlocked.message.content).toBe(`<@${USER}> earned **Chatterbox** (Gold)`);

    const dm = built(
      ACHIEVEMENTS_UNLOCKED_DM_SIMULATION.build(achievementsDefaultConfig, scene({}, null)),
    );
    expect(dm.message.content).toBe(`<@${USER}> earned **Chatterbox** (Gold)`);

    const almost = built(
      ACHIEVEMENTS_ALMOST_THERE_SIMULATION.build(achievementsDefaultConfig, scene()),
    );
    expect(almost.caption).toBe('Member close to Chatterbox (Diamond)');
    expect(almost.message.content).toBe(
      'You’re close to **Chatterbox** (Diamond)\n4,000 / 5,000 messages',
    );

    const almostDm = built(
      ACHIEVEMENTS_ALMOST_THERE_DM_SIMULATION.build(
        achievementsDefaultConfig,
        scene({ percent: 90, tier: 'silver' }, null),
      ),
    );
    expect(almostDm.message.content).toBe(
      'You’re close to **Chatterbox** (Silver)\n225 / 250 messages',
    );
  });

  test('a named achievement renders its own custom message, tier and rewards', () => {
    const custom = config({
      achievements: [
        achievement({
          announcement: {
            mode: 'custom',
            destination: 'channel',
            channelId: OTHER_CHANNEL,
            message: {
              content: '{achievement.tier}: {rewards.summary} in {destination_channel.mention}',
            },
          },
        }),
      ],
    });

    const result = built(
      ACHIEVEMENTS_UNLOCKED_SIMULATION.build(
        custom,
        scene({ achievement: 'chatterbox', tier: 'silver', rewards: 'pending' }),
      ),
    );

    expect(result.caption).toBe('Member earning Chatterbox (Silver)');
    expect(result.message.content).toBe(`Silver: 50 XP still on its way in <#${CHANNEL}>`);
  });

  test('a tier the achievement lacks falls back to the highest one below it', () => {
    const three = config({ achievements: [achievement()] });
    const result = built(
      ACHIEVEMENTS_UNLOCKED_SIMULATION.build(
        three,
        scene({ achievement: 'chatterbox', tier: 'diamond' }),
      ),
    );

    expect(result.caption).toBe('Member earning Chatterbox (Gold)');
  });

  test('an achievement without tiers ignores the tier', () => {
    const single = config({
      achievements: [
        achievement({
          id: 'hello',
          name: 'Hello',
          kind: 'single',
          tiers: [{ id: 'single', targets: { msgs: 1 } }],
        }),
      ],
    });

    const result = built(
      ACHIEVEMENTS_UNLOCKED_SIMULATION.build(single, scene({ achievement: 'hello', tier: 'gold' })),
    );

    expect(result.caption).toBe('Member earning Hello');
    expect(result.message.content).toBe(`<@${USER}> earned **Hello** `);
  });

  test('an unknown achievement is gone', () => {
    for (const adapter of achievementsSimulations) {
      expect(
        refusal(adapter.build(achievementsDefaultConfig, scene({ achievement: 'deleted-one' }))),
      ).toBe(
        'that achievement is no longer in this server’s settings. Reload the page and try again.',
      );
    }
  });

  test('an achievement that never announces is refused', () => {
    const quiet = config({ achievements: [achievement({ announcement: { mode: 'off' } })] });

    expect(
      refusal(ACHIEVEMENTS_UNLOCKED_SIMULATION.build(quiet, scene({ achievement: 'chatterbox' }))),
    ).toContain('Chatterbox is set not to announce');
  });

  test('almost there reminders that are off are refused', () => {
    const off = config({ achievements: [achievement({ almostThere: { enabled: false } })] });

    expect(
      refusal(
        ACHIEVEMENTS_ALMOST_THERE_SIMULATION.build(off, scene({ achievement: 'chatterbox' })),
      ),
    ).toContain('almost there reminders are off for Chatterbox');
  });

  test('an empty message posts nothing, so it is refused', () => {
    const silent = config({
      announcement: { message: { content: '' } },
      almostThere: { message: { content: ' ' } },
    });

    expect(refusal(ACHIEVEMENTS_UNLOCKED_SIMULATION.build(silent, scene()))).toContain(
      'the unlock announcement is empty',
    );
    expect(refusal(ACHIEVEMENTS_ALMOST_THERE_DM_SIMULATION.build(silent, scene()))).toContain(
      'the almost there message is empty',
    );
  });

  test('a message Discord would refuse once filled in is refused', () => {
    const broken = config({
      announcement: { message: { embeds: [{ title: '{channel.name}' }] } },
    });

    expect(refusal(ACHIEVEMENTS_UNLOCKED_DM_SIMULATION.build(broken, scene({}, null)))).toContain(
      'cannot be sent once its placeholders are filled in',
    );
  });

  test('a DM rehearsal has no destination channel', () => {
    const dm = config({
      announcement: { destination: 'dm', message: { content: '[{destination_channel.id}]' } },
    });
    const result = built(ACHIEVEMENTS_UNLOCKED_DM_SIMULATION.build(dm, scene({}, null)));

    expect(result.message.content).toBe('[]');
    expect(result.diagnostics.map(({ code }) => code)).toEqual(['unavailable']);
  });
});

describe('badge attachment', () => {
  test('the unlock announcement attaches the tier-coloured badge and uses it as the thumbnail', () => {
    const embedded = config({
      announcement: { message: { embeds: [{ description: '{achievement.name}' }] } },
    });
    const result = built(
      ACHIEVEMENTS_UNLOCKED_SIMULATION.build(embedded, scene({ tier: 'silver' })),
    );

    expect(result.attachments).toEqual([
      {
        filename: 'badge.png',
        card: { kind: 'badge', shape: 'circle', colour: TIER_COLOURS.silver, icon: 'chat' },
      },
    ]);
    expect(result.message.embeds[0]?.thumbnailUrl).toBe('attachment://badge.png');
  });

  test('a fixed colour and an uploaded image pass through', () => {
    const own = config({
      achievements: [
        achievement({
          badge: { shape: 'shield', icon: 'star', colour: 0x123456, assetId: 'abcdef0123' },
        }),
      ],
    });
    const result = built(
      ACHIEVEMENTS_UNLOCKED_DM_SIMULATION.build(own, scene({ achievement: 'chatterbox' }, null)),
    );

    expect(result.attachments).toEqual([
      {
        filename: 'badge.png',
        card: {
          kind: 'badge',
          shape: 'shield',
          colour: 0x123456,
          icon: 'star',
          assetId: 'abcdef0123',
        },
      },
    ]);
  });

  test('no badge when it is switched off, for almost there, or on a layout message', () => {
    const off = config({ announcement: { attachBadge: false } });
    expect(built(ACHIEVEMENTS_UNLOCKED_SIMULATION.build(off, scene())).attachments).toEqual([]);

    expect(
      built(ACHIEVEMENTS_ALMOST_THERE_SIMULATION.build(achievementsDefaultConfig, scene()))
        .attachments,
    ).toEqual([]);

    const layout = config({
      announcement: { message: { v2: [{ kind: 'text', content: '{achievement.name}' }] } },
    });
    expect(built(ACHIEVEMENTS_UNLOCKED_SIMULATION.build(layout, scene())).attachments).toEqual([]);
  });
});

describe('destination', () => {
  test('the unlock announcement goes where the achievement or the module sends it', () => {
    const routed = config({
      announcement: { destination: 'channel', channelId: CHANNEL },
      achievements: [
        achievement(),
        achievement({
          id: 'elsewhere',
          announcement: {
            mode: 'custom',
            destination: 'channel',
            channelId: OTHER_CHANNEL,
            message: { content: 'hi' },
          },
        }),
        achievement({
          id: 'here',
          announcement: { mode: 'custom', destination: 'current', message: { content: 'hi' } },
        }),
      ],
    });
    const destination = (inputs: Record<string, string>) =>
      ACHIEVEMENTS_UNLOCKED_SIMULATION.destination?.(routed, inputs);

    expect(destination({})).toBe(CHANNEL);
    expect(destination({ achievement: 'chatterbox' })).toBe(CHANNEL);
    expect(destination({ achievement: 'elsewhere' })).toBe(OTHER_CHANNEL);
    expect(destination({ achievement: 'here' })).toBeNull();
    expect(destination({ achievement: 'gone-now' })).toBeNull();
    expect(
      ACHIEVEMENTS_UNLOCKED_SIMULATION.destination?.(achievementsDefaultConfig, {}),
    ).toBeNull();
  });

  test('almost there goes to its own channel', () => {
    const channel = config({ almostThere: { destination: 'channel', channelId: OTHER_CHANNEL } });

    expect(ACHIEVEMENTS_ALMOST_THERE_SIMULATION.destination?.(channel, {})).toBe(OTHER_CHANNEL);
    expect(
      ACHIEVEMENTS_ALMOST_THERE_SIMULATION.destination?.(achievementsDefaultConfig, {}),
    ).toBeNull();
    expect(ACHIEVEMENTS_UNLOCKED_DM_SIMULATION.destination).toBeUndefined();
  });
});

describe('purity', () => {
  test('build never changes the config it is given', () => {
    const frozen = deepFreeze(
      config({
        announcement: { message: { embeds: [{ description: '{rewards.summary}' }] } },
        achievements: [achievement()],
      }),
    );
    const before = structuredClone(frozen);

    for (const adapter of achievementsSimulations) {
      for (const inputs of [{}, { achievement: 'chatterbox' }, { achievement: 'nope' }]) {
        adapter.build(frozen, scene(inputs));
      }
    }

    expect(frozen).toEqual(before);
  });

  test('the simulation reaches no store, table or network client', () => {
    const source = readFileSync(new URL('../src/simulation.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(([, from]) => from);

    expect(imports.sort()).toEqual([
      './config.ts',
      './placeholders.ts',
      '@proton/cards/design',
      '@proton/core',
      '@proton/core',
    ]);
  });
});

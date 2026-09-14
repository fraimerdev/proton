import { describe, expect, test } from 'bun:test';
import { type ModuleManifest, ModuleRegistry, Permissions, zodToDescriptors } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  AFK_EXPIRE_JOB,
  AFK_TIDY_JOB,
  afkConfigSchema,
  afkDefaultConfig,
  REASON_MAX,
} from '../src/config.ts';
import { afkModule, createAfkModule } from '../src/index.ts';
import { APPLICATION_ID, MemoryAfkStore } from './harness.ts';

const INTENTS =
  GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.GuildMembers;

function registry(): ModuleRegistry {
  const built = new ModuleRegistry();
  built.register(afkModule as ModuleManifest);
  return built;
}

interface OptionJson {
  name: string;
  type: number;
  max_length?: number;
  options?: OptionJson[];
}

describe('the afk manifest', () => {
  test('registers, which proves its schedules and handlers line up', () => {
    const built = registry();

    expect(built.maySchedule('afk', AFK_EXPIRE_JOB)).toBe(true);
    expect(built.maySchedule('afk', AFK_TIDY_JOB)).toBe(true);

    for (const kind of [
      'interaction_reply',
      'interaction_followup',
      'send',
      'delete_message',
      'create_dm',
      'set_member_nickname',
    ] as const) {
      expect(built.mayExecute('afk', kind)).toBe(true);
    }
  });

  test('every dashboard section names a real config key, and every key has a section', () => {
    const keys = Object.keys(afkConfigSchema.shape).sort();
    const placed = (afkModule.dashboard?.sections ?? []).flatMap((section) => section.fields);

    expect([...placed].sort()).toEqual(keys);
    expect(afkModule.dashboard?.icon).toBe('moon');
  });

  test('the default config satisfies its own schema', () => {
    expect(afkConfigSchema.safeParse(afkDefaultConfig).success).toBe(true);
  });

  test('listens for messages, departures and its own config changes', () => {
    expect(afkModule.listeners?.[0]?.types).toEqual([
      'message.created',
      'member.left',
      'proton.config_changed',
    ]);
  });

  test('ships one guild-only /afk command with set and clear', () => {
    const [command, ...rest] = afkModule.commands ?? [];

    expect(rest).toEqual([]);
    expect(command?.name).toBe('afk');
    expect(command?.data.name).toBe('afk');
    expect(command?.data.contexts).toEqual([0]);

    const subcommands = (command?.data.options ?? []) as OptionJson[];
    expect(subcommands.map((sub) => sub.name)).toEqual(['set', 'clear']);

    const reason = subcommands[0]?.options?.[0];
    expect(reason?.name).toBe('reason');
    expect(reason?.max_length).toBe(REASON_MAX);

    expect(subcommands[1]?.options?.[0]?.name).toBe('member');
  });

  test('the dashboard reads the delay as a duration and the channels as channel ids', () => {
    const byPath = new Map(zodToDescriptors(afkConfigSchema).map((field) => [field.path, field]));

    expect(byPath.get('tidyAfter')?.kind).toBe('duration');
    expect(byPath.get('ignoredChannelIds')?.kind).toBe('channel-id');
    expect(byPath.get('nicknameTag')?.kind).toBe('boolean');

    for (const field of byPath.values()) {
      expect(field.label).toBeTruthy();
      expect(field.description).toBeTruthy();
    }
  });

  test('binding deps does not change what the dashboard sees', () => {
    const bound = createAfkModule({ store: new MemoryAfkStore(), applicationId: APPLICATION_ID });

    expect(bound.id).toBe(afkModule.id);
    expect(bound.requiredIntents).toEqual(afkModule.requiredIntents);
    expect(bound.requiredPermissions).toEqual(afkModule.requiredPermissions);
  });

  test('runs with View Channel and Send Messages alone', () => {
    const status = registry().evaluate('afk', {
      grantedIntents: INTENTS,
      botPermissions: Permissions.ViewChannel | Permissions.SendMessages,
    });

    expect(status.enabled).toBe(true);
    expect(afkModule.requiredPermissions).toEqual([
      Permissions.ViewChannel,
      Permissions.SendMessages,
    ]);
  });

  test('asks the invite for what the tag, the tidy-up and replies need', () => {
    const invite = registry().invitePermissions();

    expect(invite & Permissions.ManageNicknames).toBe(Permissions.ManageNicknames);
    expect(invite & Permissions.ManageMessages).toBe(Permissions.ManageMessages);
    expect(invite & Permissions.ReadMessageHistory).toBe(Permissions.ReadMessageHistory);
  });
});

describe('afk failure paths', () => {
  test('disables itself and names the Server Members Intent when it is missing', () => {
    const status = registry().evaluate('afk', {
      grantedIntents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages,
      botPermissions: Permissions.ViewChannel | Permissions.SendMessages,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('Server Members Intent');
  });

  test('disables itself and names Send Messages when it is missing', () => {
    const status = registry().evaluate('afk', {
      grantedIntents: INTENTS,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('Send Messages');
  });
});

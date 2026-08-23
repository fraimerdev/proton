import { describe, expect, test } from 'bun:test';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { z } from 'zod';
import { THREAD_TYPE_PUBLIC } from '../../src/actions/payloads.ts';
import { protonFields } from '../../src/config/descriptor.ts';
import type { ModuleManifest } from '../../src/modules/manifest.ts';
import {
  ModuleRegistrationError,
  ModuleRegistry,
  type RegistryEnvironment,
  UndeclaredScheduleError,
} from '../../src/modules/registry.ts';
import { Permissions } from '../../src/permissions/bits.ts';

function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  const configSchema = z.object({
    enabled: z.boolean().default(true),
    response: z.string().min(1).max(200).default('Pong!'),
  });

  return {
    id: 'ping',
    name: 'Ping',
    category: 'utility',
    configSchema,
    defaultConfig: { enabled: true, response: 'Pong!' },
    schemaVersion: 1,
    requiredIntents: [GatewayIntentBits.Guilds],
    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
    migrations: [],
    ...overrides,
  } as ModuleManifest;
}

const env: RegistryEnvironment = {
  grantedIntents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
  botPermissions: Permissions.ViewChannel | Permissions.SendMessages,
};

describe('ModuleRegistry registration', () => {
  test('registers a valid manifest', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    expect(registry.get('ping')?.name).toBe('Ping');
    expect(registry.all()).toHaveLength(1);
  });

  test('refuses a duplicate module id', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    expect(() => registry.register(manifest())).toThrow(ModuleRegistrationError);
  });

  test('refuses a defaultConfig that does not satisfy its own schema', () => {
    const registry = new ModuleRegistry();
    const broken = manifest({
      configSchema: z.object({ enabled: z.boolean(), threshold: z.string() }),
      defaultConfig: { enabled: true },
    });

    expect(() => registry.register(broken)).toThrow(/defaultConfig/);
  });

  test('refuses a config schema the dashboard cannot render', () => {
    const registry = new ModuleRegistry();
    const broken = manifest({
      configSchema: z.object({ mode: z.union([z.string(), z.boolean()]) }),
      defaultConfig: { mode: 'a' },
    });

    expect(() => registry.register(broken)).toThrow();
  });

  test('exposes descriptors generated from the config schema', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        configSchema: z.object({
          enabled: z.boolean().default(true),
          channel: z.string().register(protonFields, { field: 'channel-id' }),
        }),
        defaultConfig: { enabled: true, channel: '1' },
      }),
    );

    expect(registry.descriptors('ping').map((d) => d.kind)).toEqual(['boolean', 'channel-id']);
  });

  test('generates the form from formSchema when the config schema is richer', () => {
    const registry = new ModuleRegistry();
    const configSchema = z.object({
      enabled: z.boolean().default(true),
      ladder: z.array(z.object({ at: z.number() })).default([]),
    });

    expect(() =>
      registry.register(manifest({ configSchema, defaultConfig: { enabled: true } })),
    ).toThrow(/ladder/);

    registry.register(
      manifest({
        configSchema,
        formSchema: configSchema.omit({ ladder: true }),
        defaultConfig: { enabled: true, ladder: [] },
      }),
    );

    expect(registry.descriptors('ping').map((d) => d.path)).toEqual(['enabled']);
  });

  test('refuses a formSchema field the config schema does not define', () => {
    const registry = new ModuleRegistry();
    const broken = manifest({
      formSchema: z.object({ enabled: z.boolean(), typo: z.string() }),
    });

    expect(() => registry.register(broken)).toThrow(ModuleRegistrationError);
    expect(() => registry.register(broken)).toThrow(/typo/);
  });

  test('keeps a manifest’s declared rules and jobs', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        rules: [
          {
            id: 'escalate-on-third-warn',
            trigger: { kind: 'event', event: 'moderation.warned' },
            conditions: [{ kind: 'rate-over-window', limit: 3, window: '24h' }],
            actions: [{ kind: 'timeout', duration: '1h', reason: 'Third warning' }],
            enabled: true,
            priority: 10,
          },
        ],
        jobs: [{ id: 'sweep-expired', cron: '*/5 * * * *' }],
      }),
    );

    const registered = registry.get('ping');
    expect(registered?.rules?.[0]?.actions[0]?.kind).toBe('timeout');
    expect(registered?.jobs?.[0]?.cron).toBe('*/5 * * * *');
  });
});

describe('ModuleRegistry gating', () => {
  test('enables a module whose requirements are met', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    expect(registry.evaluate('ping', env)).toEqual({ id: 'ping', enabled: true });
  });

  test('disables a module missing an intent and names which intent', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ requiredIntents: [GatewayIntentBits.MessageContent] }));

    const status = registry.evaluate('ping', env);

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('MessageContent');

    expect(status.disabledReason?.humanReason).toContain('developer portal');
  });

  test('disables a module missing a permission and names which one and where', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ requiredPermissions: [Permissions.ManageRoles] }));

    const status = registry.evaluate('ping', env);

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('ManageRoles');
    expect(status.disabledReason?.humanReason).toContain('Server Settings');
  });

  test('disables an audit-log consumer that lacks VIEW_AUDIT_LOG or GUILD_MODERATION', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        name: 'Anti-Nuke',
        requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration],
        requiredPermissions: [Permissions.ViewAuditLog],
      }),
    );

    const noIntent = registry.evaluate('ping', env);

    expect(noIntent.disabledReason?.code).toBe('missing_intent');
    expect(noIntent.disabledReason?.humanReason).toContain('GuildModeration');

    const withIntent = registry.evaluate('ping', {
      ...env,
      grantedIntents: env.grantedIntents | GatewayIntentBits.GuildModeration,
    });

    expect(withIntent.disabledReason?.code).toBe('missing_permission');
    expect(withIntent.disabledReason?.humanReason).toContain('ViewAuditLog');
    expect(withIntent.disabledReason?.humanReason).toContain('Server Settings');
  });

  test('disables a module whose dependency is not loaded', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ dependsOn: ['cases'] }));

    const status = registry.evaluate('ping', env);

    expect(status.disabledReason?.code).toBe('missing_dependency');
    expect(status.disabledReason?.humanReason).toContain('cases');
  });

  test('gates on entitlement tier without any per-module code', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ requiredEntitlement: 'pro' }));

    expect(registry.evaluate('ping', { ...env, tier: 'free' }).disabledReason?.code).toBe(
      'insufficient_entitlement',
    );
    expect(registry.evaluate('ping', { ...env, tier: 'pro' }).enabled).toBe(true);
  });

  test('reports an unknown module rather than throwing', () => {
    const registry = new ModuleRegistry();

    expect(registry.evaluate('nope', env).enabled).toBe(false);
  });
});

describe('aggregate requirements', () => {
  test('computes the invite permission integer from manifests, never by hand', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());
    registry.register(
      manifest({ id: 'second', name: 'Second', requiredPermissions: [Permissions.ManageMessages] }),
    );

    expect(registry.invitePermissions()).toBe(
      Permissions.ViewChannel | Permissions.SendMessages | Permissions.ManageMessages,
    );
  });

  test('the invite carries what a shipped rule rung needs, not only what the manifest declares', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        rules: [
          {
            id: 'escalate-on-third-warn',
            trigger: { kind: 'event', event: 'moderation.warned' },
            conditions: [],
            actions: [{ kind: 'ban', reason: 'Third warning' }],
            enabled: true,
            priority: 10,
          },
        ],
      }),
    );

    expect(registry.invitePermissions() & Permissions.BanMembers).toBe(Permissions.BanMembers);
  });

  test('a poll rung is invited for SendPolls even though a rung carries no channelId', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        rules: [
          {
            id: 'ask-the-server',
            trigger: { kind: 'event', event: 'moderation.warned' },
            conditions: [],
            actions: [
              {
                kind: 'send',
                payload: {
                  poll: {
                    question: { text: 'Should this stand?' },
                    answers: [{ poll_media: { text: 'Yes' } }],
                  },
                },
              },
            ],
            enabled: true,
            priority: 10,
          },
        ],
      }),
    );

    expect(registry.invitePermissions() & Permissions.SendPolls).toBe(Permissions.SendPolls);
  });

  test('a public-thread rung is invited for the thread bit its precheck will demand, and for both', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        rules: [
          {
            id: 'open-an-appeal-thread',
            trigger: { kind: 'event', event: 'moderation.warned' },
            conditions: [],
            actions: [
              { kind: 'create_thread', payload: { name: 'Appeal', type: THREAD_TYPE_PUBLIC } },
            ],
            enabled: true,
            priority: 10,
          },
        ],
      }),
    );

    const invited = registry.invitePermissions();

    expect(invited & Permissions.CreatePublicThreads).toBe(Permissions.CreatePublicThreads);
    expect(invited & Permissions.CreatePrivateThreads).toBe(Permissions.CreatePrivateThreads);
  });

  test('the invite carries what a declared action kind needs, not only what requiredPermissions lists', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ actionKinds: ['delete_message', 'add_reaction'] }));

    const invited = registry.invitePermissions();

    expect(invited & Permissions.ManageMessages).toBe(Permissions.ManageMessages);
    expect(invited & Permissions.AddReactions).toBe(Permissions.AddReactions);
  });

  test('a declared kind widens the invite without marking the module broken in a guild', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ actionKinds: ['ban'] }));

    expect(registry.invitePermissions() & Permissions.BanMembers).toBe(Permissions.BanMembers);
    expect(registry.evaluate('ping', env).enabled).toBe(true);
  });

  test('a declared send kind carries SendPolls, because whether a payload polls is not known here', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ actionKinds: ['send'] }));

    expect(registry.invitePermissions() & Permissions.SendPolls).toBe(Permissions.SendPolls);
  });

  test('a rung a guild never configures still does not mark the module broken', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        rules: [
          {
            id: 'escalate-on-third-warn',
            trigger: { kind: 'event', event: 'moderation.warned' },
            conditions: [],
            actions: [{ kind: 'ban', reason: 'Third warning' }],
            enabled: true,
            priority: 10,
          },
        ],
      }),
    );

    expect(registry.evaluate('ping', env).enabled).toBe(true);
  });

  test('a permission a module always needs belongs in requiredPermissions, where the gate sees it', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        requiredPermissions: [
          Permissions.ViewChannel,
          Permissions.SendMessages,
          Permissions.SendPolls,
        ],
      }),
    );

    expect(registry.invitePermissions() & Permissions.SendPolls).toBe(Permissions.SendPolls);
    expect(registry.evaluate('ping', env).disabledReason?.humanReason).toContain('SendPolls');
  });

  test('computes the gateway intent bitfield from manifests', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());
    registry.register(
      manifest({ id: 'second', name: 'Second', requiredIntents: [GatewayIntentBits.GuildMembers] }),
    );

    expect(registry.requiredIntents()).toBe(
      GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
    );
  });

  test('a second module needs no framework change — only a manifest', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());
    registry.register(manifest({ id: 'echo', name: 'Echo' }));

    expect(registry.all().map((m) => m.id)).toEqual(['ping', 'echo']);
    expect(registry.evaluate('echo', env).enabled).toBe(true);
  });
});

describe('emits allowlist', () => {
  test('a module may publish only what it declares', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ id: 'leveling', emits: ['xp.level_gained'] }));

    expect(registry.mayEmit('leveling', 'xp.level_gained')).toBe(true);
    expect(registry.mayEmit('leveling', 'moderation.warned')).toBe(false);
  });

  test('a module declaring nothing may publish nothing', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    expect(registry.mayEmit('ping', 'xp.level_gained')).toBe(false);
  });

  test('an unregistered module may publish nothing', () => {
    expect(new ModuleRegistry().mayEmit('ghost', 'xp.level_gained')).toBe(false);
  });

  test('collects every declared type across modules, without duplicates', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ id: 'leveling', emits: ['xp.level_gained'] }));
    registry.register(manifest({ id: 'cases', emits: ['moderation.warned', 'xp.level_gained'] }));

    expect(new Set(registry.emittedTypes())).toEqual(
      new Set(['xp.level_gained', 'moderation.warned']),
    );
    expect(registry.emittedTypes()).toHaveLength(2);
  });

  test('refuses a manifest that lists the same type twice', () => {
    const registry = new ModuleRegistry();

    expect(() =>
      registry.register(manifest({ emits: ['xp.level_gained', 'xp.level_gained'] })),
    ).toThrow(ModuleRegistrationError);
  });
});

describe('action kinds allowlist', () => {
  test('a module may execute only the kinds it declares', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ id: 'starboard', actionKinds: ['send', 'delete_message'] }));

    expect(registry.mayExecute('starboard', 'send')).toBe(true);
    expect(registry.mayExecute('starboard', 'delete_message')).toBe(true);
    expect(registry.mayExecute('starboard', 'ban')).toBe(false);
  });

  test('a module declaring nothing may execute nothing', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    expect(registry.mayExecute('ping', 'interaction_reply')).toBe(false);
  });

  test('an unregistered module may execute nothing', () => {
    expect(new ModuleRegistry().mayExecute('ghost', 'send')).toBe(false);
  });

  test('refuses a manifest that lists the same kind twice', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(manifest({ actionKinds: ['send', 'send'] }))).toThrow(
      ModuleRegistrationError,
    );
    expect(() => registry.register(manifest({ actionKinds: ['send', 'send'] }))).toThrow(/send/);
  });

  test('declaring a kind the module never executes is allowed, since the cost is a wider invite', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(manifest({ actionKinds: ['move_member'] }))).not.toThrow();
  });
});

describe('schedules allowlist', () => {
  const noop = async () => {};

  test('a module may schedule only the job ids it declares', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({ id: 'reminders', schedules: ['remind'], scheduledHandlers: { remind: noop } }),
    );

    expect(registry.maySchedule('reminders', 'remind')).toBe(true);
    expect(registry.maySchedule('reminders', 'end-giveaway')).toBe(false);
  });

  test('a module declaring nothing may schedule nothing', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    expect(registry.maySchedule('ping', 'remind')).toBe(false);
  });

  test('an unregistered module may schedule nothing', () => {
    expect(new ModuleRegistry().maySchedule('ghost', 'remind')).toBe(false);
  });

  test('refuses a handler for a job id the manifest does not declare', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(manifest({ scheduledHandlers: { remind: noop } }))).toThrow(
      UndeclaredScheduleError,
    );
    expect(() => registry.register(manifest({ scheduledHandlers: { remind: noop } }))).toThrow(
      /remind/,
    );
  });

  test('refuses a declared job id that has no handler, which would never run', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(manifest({ schedules: ['remind'] }))).toThrow(
      UndeclaredScheduleError,
    );
    expect(() => registry.register(manifest({ schedules: ['remind'] }))).toThrow(/no handler/);
  });

  test('refuses a job id inherited from Object.prototype rather than owned by scheduledHandlers', () => {
    for (const jobId of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      const registry = new ModuleRegistry();

      expect(() =>
        registry.register(manifest({ schedules: [jobId], scheduledHandlers: {} })),
      ).toThrow(UndeclaredScheduleError);
      expect(() =>
        registry.register(manifest({ schedules: [jobId], scheduledHandlers: {} })),
      ).toThrow(/no handler/);
    }
  });

  test('a module that genuinely owns a handler called constructor still registers', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({ schedules: ['constructor'], scheduledHandlers: { constructor: noop } }),
    );

    expect(registry.maySchedule('ping', 'constructor')).toBe(true);
  });

  test('refuses a manifest that lists the same job id twice', () => {
    const registry = new ModuleRegistry();

    expect(() =>
      registry.register(
        manifest({ schedules: ['remind', 'remind'], scheduledHandlers: { remind: noop } }),
      ),
    ).toThrow(ModuleRegistrationError);
  });

  test('leaves the static cron jobs mechanism alone', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        jobs: [{ id: 'sweep-expired', cron: '*/5 * * * *' }],
        schedules: ['remind'],
        scheduledHandlers: { remind: noop },
      }),
    );

    expect(registry.get('ping')?.jobs?.[0]?.id).toBe('sweep-expired');
    expect(registry.maySchedule('ping', 'sweep-expired')).toBe(false);
  });
});

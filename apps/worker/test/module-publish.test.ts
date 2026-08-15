import { describe, expect, test } from 'bun:test';
import type { EventBus, Logger, ModuleManifest, ProtonEvent, Subscription } from '@proton/core';
import { ModuleRegistry } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { z } from 'zod';
import {
  createModulePublisher,
  moduleEventId,
  UndeclaredEventError,
} from '../src/module-publish.ts';

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';

class RecordingBus implements EventBus {
  readonly published: ProtonEvent[] = [];

  async publish(event: ProtonEvent): Promise<void> {
    this.published.push(event);
  }

  subscribe(): Subscription {
    throw new Error('not used');
  }
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function manifest(id: string, emits?: ModuleManifest['emits']): ModuleManifest {
  return {
    id,
    name: id,
    category: 'utility',
    configSchema: z.object({ enabled: z.boolean().default(true) }),
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [GatewayIntentBits.Guilds],
    requiredPermissions: [],
    migrations: [],
    ...(emits ? { emits } : {}),
  } as ModuleManifest;
}

function setup(manifests: ModuleManifest[]) {
  const registry = new ModuleRegistry();
  for (const m of manifests) registry.register(m);

  const bus = new RecordingBus();
  const publisherFor = createModulePublisher({
    bus,
    registry,
    logger: silent,
    now: () => 1_700_000,
  });

  return { bus, publisherFor };
}

describe('module publish port', () => {
  test('publishes a declared type onto the bus', async () => {
    const { bus, publisherFor } = setup([manifest('leveling', ['xp.level_gained'])]);

    await publisherFor('leveling', GUILD)('xp.level_gained', 'member:5', { userId: '1' });

    expect(bus.published).toHaveLength(1);
    expect(bus.published[0]?.type).toBe('xp.level_gained');
    expect(bus.published[0]?.payload).toEqual({ userId: '1' });
  });

  /**
   * The reason the allowlist exists. A module that could publish another
   * module's event type could drive its rules — forging `moderation.warned`
   * would advance an escalation ladder into timing someone out, and nothing
   * downstream could tell the forged event from a real one.
   */
  test('refuses a type the module does not declare', async () => {
    const { bus, publisherFor } = setup([manifest('leveling', ['xp.level_gained'])]);

    await expect(publisherFor('leveling', GUILD)('moderation.warned', 'k', {})).rejects.toThrow(
      UndeclaredEventError,
    );
    expect(bus.published).toEqual([]);
  });

  test('a module declaring nothing can publish nothing', async () => {
    const { publisherFor } = setup([manifest('ping')]);

    await expect(publisherFor('ping', GUILD)('xp.level_gained', 'k', {})).rejects.toThrow(
      UndeclaredEventError,
    );
  });

  test('the refusal names the module and the type', async () => {
    const { publisherFor } = setup([manifest('leveling', ['xp.level_gained'])]);

    await expect(publisherFor('leveling', GUILD)('moderation.warned', 'k', {})).rejects.toThrow(
      /leveling.*moderation\.warned/s,
    );
  });

  /** The module supplies a natural key; the guild is not the module's to choose. */
  test('stamps the guild from the context', async () => {
    const { bus, publisherFor } = setup([manifest('leveling', ['xp.level_gained'])]);

    await publisherFor('leveling', GUILD)('xp.level_gained', 'k', {});

    expect(bus.published[0]?.guildId).toBe(GUILD);
  });

  /**
   * Gateway RESUME redelivers the cause, so the module republishes the effect
   * under the same natural key. A derived id means the executor discards the
   * second one (I4); a minted one would double every consequence.
   */
  test('the same natural key yields the same event id', async () => {
    const { bus, publisherFor } = setup([manifest('leveling', ['xp.level_gained'])]);
    const publish = publisherFor('leveling', GUILD);

    await publish('xp.level_gained', 'member:5', {});
    await publish('xp.level_gained', 'member:5', {});

    expect(bus.published[0]?.id).toBe(bus.published[1]?.id ?? '');
  });

  /**
   * Two guilds acting on the same user id in the same second must not collide,
   * or one guild's ladder silently swallows the other's warning.
   */
  test('the same natural key in two guilds yields different ids', async () => {
    const { bus, publisherFor } = setup([manifest('leveling', ['xp.level_gained'])]);

    await publisherFor('leveling', GUILD)('xp.level_gained', 'member:5', {});
    await publisherFor('leveling', OTHER_GUILD)('xp.level_gained', 'member:5', {});

    expect(bus.published[0]?.id).not.toBe(bus.published[1]?.id);
  });

  test('the id format matches the gateway’s, so nothing downstream can tell them apart', () => {
    expect(moduleEventId('xp.level_gained', GUILD, 'member:5')).toBe(
      `xp.level_gained:${GUILD}:member:5`,
    );
  });
});

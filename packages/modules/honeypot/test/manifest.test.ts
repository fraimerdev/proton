import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  HONEYPOT_PANEL_KEYS,
  honeypotConfigSchema,
  honeypotDefaultConfig,
  honeypotFormSchema,
} from '../src/config.ts';
import { honeypotModule } from '../src/index.ts';

const GRANTED_INTENTS =
  GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent;

function registry(): ModuleRegistry {
  const registered = new ModuleRegistry();
  registered.register(honeypotModule);
  return registered;
}

describe('the manifest', () => {
  test('registers, which means its settings render as a form (§9)', () => {
    const paths = registry()
      .descriptors('honeypot')
      .map((descriptor) => descriptor.path);

    expect(new Set(paths)).toEqual(new Set(Object.keys(honeypotFormSchema.shape)));
    expect(paths).toHaveLength(Object.keys(honeypotFormSchema.shape).length);
  });

  test('keeps the channel list out of the generated form, which cannot render it', () => {
    const paths = registry()
      .descriptors('honeypot')
      .map((descriptor) => descriptor.path);

    for (const key of HONEYPOT_PANEL_KEYS) {
      expect(paths).not.toContain(key);
      expect(Object.keys(honeypotConfigSchema.shape)).toContain(key);
    }
  });

  test('offers the incident log as a channel picker', () => {
    const descriptor = registry()
      .descriptors('honeypot')
      .find((candidate) => candidate.path === 'logChannelId');

    expect(descriptor?.kind).toBe('channel-id');
  });

  test('ships defaults its own schema accepts, and that trap nobody', () => {
    expect(honeypotConfigSchema.safeParse(honeypotDefaultConfig).success).toBe(true);
    expect(honeypotDefaultConfig.enabled).toBe(false);
    expect(honeypotDefaultConfig.channels).toEqual([]);
  });

  test('asks for Ban Members and nothing else', () => {
    expect(honeypotModule.requiredPermissions).toEqual([Permissions.BanMembers]);
  });

  // This used to assert the opposite. "Quote the message" retired that property deliberately:
  // reading the body without declaring the intent would make the manifest a promise Proton was
  // not keeping, so the declaration is the honest half of the trade.
  test('asks for Message Content, because it can be told to quote what was posted', () => {
    expect(honeypotModule.requiredIntents).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ]);
  });

  test('quoting is off until a server turns it on', () => {
    expect(honeypotDefaultConfig.quoteMessage).toBe(false);
  });

  // On by default: the whole point of the message is telling somebody whose account was taken over
  // that it was, and an admin who has not thought about it should not have that silently off.
  test('the direct message is sent by default', () => {
    expect(honeypotDefaultConfig.sendDirectMessage).toBe(true);
    expect(honeypotDefaultConfig.offerWayBackIn).toBe(false);
  });

  test('runs on the three intents it declares', () => {
    const status = registry().evaluate('honeypot', {
      grantedIntents: GRANTED_INTENTS,
      botPermissions: Permissions.BanMembers,
    });

    expect(status).toEqual({ id: 'honeypot', enabled: true });
  });

  test('is disabled with the permission named when it cannot ban', () => {
    const status = registry().evaluate('honeypot', {
      grantedIntents: GRANTED_INTENTS,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('Ban Members');
  });

  test('is disabled with the intent named when it cannot see messages', () => {
    const status = registry().evaluate('honeypot', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: Permissions.BanMembers,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('Guild Messages');
  });

  test('declares every kind a trap and its notice can execute', () => {
    // moduleExecutor throws UndeclaredActionError on anything absent here, and the throw escapes
    // the listener — so a kind left off does not degrade, it kills the whole handler mid-way.
    expect(new Set(honeypotModule.actionKinds)).toEqual(
      new Set([
        'ban',
        'unban',
        'kick',
        'timeout',
        'warn',
        'delete_message',
        'send',
        'edit_message',
        'edit_channel',
        'interaction_reply',
      ]),
    );
  });

  test('listens for everything it has to, and nothing it does not', () => {
    // The button one is load-bearing: without it the notice renders a button nothing in Proton is
    // listening for. The member.left pair is what stops a punishment booked behind a wait from
    // lifting a ban a moderator placed during it.
    expect(honeypotModule.listeners?.map((listener) => listener.types)).toEqual([
      ['message.created'],
      ['proton.config_changed'],
      ['interaction.component'],
      ['member.left', 'entity.ban_added'],
      ['guild.available', 'proton.config_changed'],
    ]);
  });

  test('declares both scheduled jobs, and a handler for each', () => {
    // Registration checks this in both directions, so a declared job with no handler and a
    // handler for no declared job both fail boot rather than dying in the field days later.
    expect(honeypotModule.schedules).toEqual(['punish', 'camouflage']);
    expect(Object.keys(honeypotModule.scheduledHandlers ?? {}).sort()).toEqual([
      'camouflage',
      'punish',
    ]);
  });

  test('the daily rename reaches the bot invite without gating the whole module on it', () => {
    expect(honeypotModule.requiredPermissions).not.toContain(Permissions.ManageChannels);
    expect(registry().invitePermissions() & Permissions.ManageChannels).toBe(
      Permissions.ManageChannels,
    );
  });

  test('is configured from the dashboard alone — no slash commands', () => {
    expect(honeypotModule.commands ?? []).toEqual([]);
  });

  test('caps the channel list at the tier limit, which only a save can enforce', () => {
    expect(honeypotModule.configLimits).toEqual([{ key: 'honeypotChannels', path: 'channels' }]);
  });

  test('every dashboard section names a real config key, and only the list is left out', () => {
    const keys = new Set(Object.keys(honeypotConfigSchema.shape));
    const claimed = honeypotModule.dashboard?.sections.flatMap((section) => section.fields) ?? [];

    expect(claimed.length).toBeGreaterThan(0);
    for (const field of claimed) expect(keys.has(field)).toBe(true);

    // Every key is either on the page or owned by a bespoke panel. Counting instead would keep
    // passing the day a fifth panel key nobody renders is added.
    expect(new Set([...claimed, ...HONEYPOT_PANEL_KEYS])).toEqual(keys);
  });
});

import { describe, expect, test } from 'bun:test';
import { ActivityType, GatewayIntentBits, PresenceUpdateStatus } from 'discord-api-types/v10';
import { DEFAULT_INTENTS, DEFAULT_PRESENCE, STATUS_TEXT } from '../src/env.ts';

describe('the default identify intents', () => {
  test('include GUILD_MESSAGE_POLLS, without which no poll vote is ever delivered', () => {
    expect(DEFAULT_INTENTS & GatewayIntentBits.GuildMessagePolls).toBe(
      GatewayIntentBits.GuildMessagePolls,
    );
    expect(GatewayIntentBits.GuildMessagePolls).toBe(1 << 24);
  });

  test('leave GUILD_PRESENCES off — PLAN.md declines it', () => {
    expect(DEFAULT_INTENTS & GatewayIntentBits.GuildPresences).toBe(0);
  });

  test('claim only the two privileged intents the project declared', () => {
    const privileged =
      GatewayIntentBits.GuildMembers |
      GatewayIntentBits.MessageContent |
      GatewayIntentBits.GuildPresences;

    expect(DEFAULT_INTENTS & privileged).toBe(
      GatewayIntentBits.GuildMembers | GatewayIntentBits.MessageContent,
    );
  });
});

describe('the identify presence', () => {
  test('carries the status text in state, which is the only field a Custom activity renders', () => {
    const [activity, ...rest] = DEFAULT_PRESENCE.activities;

    expect(rest).toHaveLength(0);
    expect(activity?.type).toBe(ActivityType.Custom);
    expect(activity?.state).toBe(STATUS_TEXT);
    expect(activity?.name).not.toBe(STATUS_TEXT);
  });

  test('identifies as online rather than idle or invisible', () => {
    expect(DEFAULT_PRESENCE.status).toBe(PresenceUpdateStatus.Online);
    expect(DEFAULT_PRESENCE.since).toBeNull();
    expect(DEFAULT_PRESENCE.afk).toBe(false);
  });
});

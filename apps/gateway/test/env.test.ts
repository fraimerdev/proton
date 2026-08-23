import { describe, expect, test } from 'bun:test';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { DEFAULT_INTENTS } from '../src/env.ts';

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

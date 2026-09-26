import { describe, expect, test } from 'bun:test';
import { messageUrl, parseMessageLink } from '../../src/messages/link.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000021';
const MESSAGE = '1418000000000000031';
const PATH = `channels/${GUILD}/${CHANNEL}/${MESSAGE}`;
const LINK = { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE };

describe('messageUrl', () => {
  test('builds the canonical discord.com link', () => {
    expect(messageUrl(GUILD, CHANNEL, MESSAGE)).toBe(`https://discord.com/${PATH}`);
  });

  test('round-trips through parseMessageLink', () => {
    expect(parseMessageLink(messageUrl(GUILD, CHANNEL, MESSAGE))).toEqual(LINK);
    expect(parseMessageLink(messageUrl('@me', CHANNEL, MESSAGE))).toEqual({
      ...LINK,
      guildId: '@me',
    });
  });
});

describe('parseMessageLink', () => {
  test('accepts every host Discord hands out', () => {
    for (const host of [
      'discord.com',
      'discordapp.com',
      'ptb.discord.com',
      'canary.discord.com',
      'ptb.discordapp.com',
      'canary.discordapp.com',
    ]) {
      expect(parseMessageLink(`https://${host}/${PATH}`)).toEqual(LINK);
    }
  });

  test('reads a direct-message link as the @me guild', () => {
    expect(parseMessageLink(`https://discord.com/channels/@me/${CHANNEL}/${MESSAGE}`)).toEqual({
      ...LINK,
      guildId: '@me',
    });
  });

  test('tolerates how links arrive when pasted', () => {
    for (const text of [
      `  https://discord.com/${PATH}\n`,
      `<https://discord.com/${PATH}>`,
      `https://discord.com/${PATH}/`,
      `https://discord.com/${PATH}?utm=share`,
      `http://discord.com/${PATH}`,
      `discord.com/${PATH}`,
      `HTTPS://Discord.com/${PATH}`,
    ]) {
      expect(parseMessageLink(text)).toEqual(LINK);
    }
  });

  test('refuses anything that is not exactly one message link', () => {
    for (const text of [
      '',
      'not a link',
      `https://discord.com/channels/${GUILD}/${CHANNEL}`,
      `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}/${MESSAGE}`,
      `https://discord.gg/${PATH}`,
      `https://evil.example/${PATH}`,
      `https://discord.com.evil.example/${PATH}`,
      `https://notdiscord.com/${PATH}`,
      `https://www.discord.com/${PATH}`,
      `https://beta.discord.com/${PATH}`,
      `https://discord.com/channels/12345/${CHANNEL}/${MESSAGE}`,
      `https://discord.com/channels/${GUILD}/${CHANNEL}/abc`,
      `https://discord.com/channels/@you/${CHANNEL}/${MESSAGE}`,
      `see https://discord.com/${PATH}`,
      `https://discord.com/${PATH} and https://discord.com/${PATH}`,
      `ftp://discord.com/${PATH}`,
    ]) {
      expect(parseMessageLink(text)).toBeNull();
    }
  });
});

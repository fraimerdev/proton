import { describe, expect, test } from 'bun:test';
import { MessageType } from 'discord-api-types/v10';
import {
  BOOST_MESSAGE_TYPES,
  isBoostMessageType,
  isHumanMessage,
} from '../../src/messages/message-type.ts';

describe('isBoostMessageType', () => {
  test.each([
    ['a boost', 8],
    ['a boost reaching tier 1', 9],
    ['a boost reaching tier 2', 10],
    ['a boost reaching tier 3', 11],
  ])('recognises %s', (_label, type) => {
    expect(isBoostMessageType(type)).toBe(true);
  });

  test('matches Discord’s own enum', () => {
    expect([...BOOST_MESSAGE_TYPES].sort((a, b) => a - b)).toEqual([
      MessageType.GuildBoost,
      MessageType.GuildBoostTier1,
      MessageType.GuildBoostTier2,
      MessageType.GuildBoostTier3,
    ]);
  });

  test.each([
    ['an ordinary message', 0],
    ['a reply', 19],
    ['a member join notice', 7],
    ['a pin notice', 6],
    ['a slash command reply', 20],
  ])('does not treat %s as a boost', (_label, type) => {
    expect(isBoostMessageType(type)).toBe(false);
  });

  test.each([
    ['text', '8'],
    ['nothing', undefined],
    ['null', null],
  ])('does not treat a type that is %s as a boost', (_label, type) => {
    expect(isBoostMessageType(type)).toBe(false);
  });

  test('no boost notice is a human message, and no human message is a boost', () => {
    for (const type of BOOST_MESSAGE_TYPES) expect(isHumanMessage(type)).toBe(false);
    expect(isBoostMessageType(0)).toBe(false);
    expect(isBoostMessageType(19)).toBe(false);
  });
});

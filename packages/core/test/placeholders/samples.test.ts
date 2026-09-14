import { describe, expect, test } from 'bun:test';
import {
  botDefinitions,
  buildBotValues,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  createPlaceholderRegistry,
  lookupFrom,
  PROTON_SUPPORT_URL,
  type ResolvedValue,
  renderTemplate,
  SAMPLE_BOT,
  SAMPLE_CONTEXT,
  SAMPLE_GIVEAWAY_WIN,
  SAMPLE_IDS,
  SAMPLE_LEVEL_UP,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_SERVER,
  SAMPLE_TEMPVC,
  SAMPLE_TICKET_CLOSED,
  SAMPLE_TICKET_OPEN,
  serverDefinitions,
  timeDefinitions,
  userDefinitions,
} from '../../src/placeholders/index.ts';

function absentKeys(values: Record<string, ResolvedValue>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) =>
      value.type === 'absent' ? [[key, value.state]] : [],
    ),
  );
}

describe('samples', () => {
  test('every sample id is distinct', () => {
    expect(new Set(SAMPLE_IDS).size).toBe(SAMPLE_IDS.length);
  });

  test('the Discord ids across the samples are real snowflakes and never collide', () => {
    const ids = [
      SAMPLE_SERVER.id,
      SAMPLE_SERVER.ownerId,
      SAMPLE_MEMBER.user.id,
      ...(SAMPLE_MEMBER.member.roleIds ?? []),
      SAMPLE_BOT.id,
      SAMPLE_TICKET_CLOSED.closedById,
    ];

    for (const id of ids) expect(id).toMatch(/^\d{17,20}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the samples tell one coherent story', () => {
    expect(Date.parse(SAMPLE_MEMBER.member.joinedAt ?? '')).toBe(SAMPLE_NOW);
    expect(SAMPLE_TICKET_OPEN.openedAt).toBeLessThan(SAMPLE_NOW);
    expect(SAMPLE_TICKET_CLOSED).toMatchObject(SAMPLE_TICKET_OPEN);
    expect(SAMPLE_TICKET_CLOSED.closedAt).toBe(SAMPLE_NOW);
    expect(SAMPLE_GIVEAWAY_WIN.messageUrl).toContain(SAMPLE_SERVER.id);
    expect(SAMPLE_GIVEAWAY_WIN.claimDeadline).toBeGreaterThan(SAMPLE_NOW);
    expect(SAMPLE_GIVEAWAY_WIN.winnerIndex).toBeLessThan(SAMPLE_GIVEAWAY_WIN.winnerCount);
    expect(SAMPLE_TEMPVC.owner).toBe(SAMPLE_MEMBER);
    expect(SAMPLE_BOT.supportUrl).toBe(PROTON_SUPPORT_URL);
    expect(SAMPLE_LEVEL_UP.level).toBe(SAMPLE_LEVEL_UP.previous + 1);
    expect(SAMPLE_LEVEL_UP.rank).toBeLessThanOrEqual(SAMPLE_LEVEL_UP.rankedMemberCount);
    expect(SAMPLE_CONTEXT).toEqual({
      now: SAMPLE_NOW,
      server: SAMPLE_SERVER,
      bot: SAMPLE_BOT,
      member: SAMPLE_MEMBER,
    });
  });

  test('samples are frozen, so one preview cannot change what the next one shows', () => {
    for (const sample of [
      SAMPLE_SERVER,
      SAMPLE_MEMBER.member,
      SAMPLE_MEMBER.member.roleIds,
      SAMPLE_TICKET_CLOSED.answers[0],
      SAMPLE_CONTEXT,
    ]) {
      expect(Object.isFrozen(sample)).toBe(true);
    }

    expect(() => {
      Object.assign(SAMPLE_SERVER, { name: 'Somewhere else' });
    }).toThrow(TypeError);
  });

  test('every shared value resolves from the samples, apart from what they set to none', () => {
    expect(
      absentKeys(buildUserValues('user', SAMPLE_MEMBER.user, SAMPLE_MEMBER.member, SAMPLE_NOW)),
    ).toEqual({ 'user.nickname': 'not_set', 'user.boosting_since': 'not_set' });
    expect(absentKeys(buildServerValues(SAMPLE_SERVER))).toEqual({
      'server.icon_url': 'not_set',
      'server.banner_url': 'not_set',
    });
    expect(absentKeys(buildBotValues(SAMPLE_BOT))).toEqual({});
  });

  test('a preview caption and values render from the samples', () => {
    const registry = createPlaceholderRegistry([
      ...userDefinitions('user', { member: true }),
      ...serverDefinitions(),
      ...botDefinitions(),
      ...timeDefinitions(),
    ]);
    const lookup = lookupFrom({
      ...buildUserValues('user', SAMPLE_MEMBER.user, SAMPLE_MEMBER.member, SAMPLE_NOW),
      ...buildServerValues(SAMPLE_SERVER),
      ...buildBotValues(SAMPLE_BOT),
      ...buildTimeValues(SAMPLE_NOW),
    });
    const plain = (template: string) =>
      renderTemplate(template, lookup, { registry, field: 'plain_text', now: SAMPLE_NOW }).output;

    expect(plain('Sample: {user.global_name} joining {server.name}')).toBe(
      'Sample: Fraimer joining Proton HQ',
    );
    expect(plain('{server.member_count:number} members, {bot.name} {now:date}')).toBe(
      '1,204 members, Proton Sep 14, 2026',
    );
  });
});

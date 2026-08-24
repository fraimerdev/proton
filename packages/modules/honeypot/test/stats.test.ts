import { describe, expect, test } from 'bun:test';
import {
  encodeCustomId,
  interactionReplyPayloadSchema,
  MESSAGE_FLAG_EPHEMERAL,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  Permissions,
} from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import type { Redis } from 'ioredis';
import { MODULE_ID } from '../src/config.ts';
import { STATS_ACTION } from '../src/notice.ts';
import { NOTICE_REFRESH_MS } from '../src/service.ts';
import { CAUGHT_RETENTION_MS, RECENT_SHOWN, RedisHoneypotStatsStore } from '../src/store.ts';
import {
  armed,
  BOT_PERMISSIONS,
  GUILD,
  harness,
  INTERACTION,
  INTERACTION_TOKEN,
  LOUNGE,
  MANAGER_PERMISSIONS,
  MEMBER,
  MESSAGE,
  MOD_PERMISSIONS,
  OTHER,
  PLAIN_PERMISSIONS,
  TRAP,
  trap,
} from './harness.ts';

const DAY = 24 * 60 * 60 * 1000;

type Node = Record<string, unknown>;

function children(node: Node | undefined): Node[] {
  return Array.isArray(node?.components) ? (node.components as Node[]) : [];
}

function texts(nodes: readonly Node[]): string[] {
  return nodes.flatMap((node) =>
    node.type === ComponentType.TextDisplay ? [String(node.content)] : texts(children(node)),
  );
}

function buttons(nodes: readonly Node[]): Node[] {
  return nodes.flatMap((node) =>
    node.type === ComponentType.Button ? [node] : buttons(children(node)),
  );
}

function statsId(channelId: string): string {
  const encoded = encodeCustomId(MODULE_ID, STATS_ACTION, channelId);
  if (!encoded.ok) throw new Error(encoded.humanReason);
  return encoded.customId;
}

function caught(at: number, action = 'softban', userId = MEMBER) {
  return { userId, action, at, messageId: `${userId}-${at}` };
}

describe('pressing the button on the notice', () => {
  test('answers ephemerally with Components V2 and never posts into the channel', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [caught(h.now())]);

    const outcome = await h.press(statsId(TRAP), { config: armed() });

    expect(outcome).toEqual({ action: 'answered', channelId: TRAP, privileged: false });
    expect(h.calls()).toEqual([`POST /interactions/${INTERACTION}/${INTERACTION_TOKEN}/callback`]);
    expect(h.sentIn(TRAP)).toEqual([]);
    expect(h.editedIn(TRAP)).toEqual([]);
  });

  test('sets both flags — ephemeral and V2 — and carries no content and no embeds', async () => {
    const h = harness();

    const answer = await h.press(statsId(TRAP), { config: armed() });

    expect(answer.action).toBe('answered');
    expect(h.replied()?.flags).toBe(MESSAGE_FLAG_EPHEMERAL | MESSAGE_FLAG_IS_COMPONENTS_V2);
    expect(h.replied()?.content).toBeUndefined();
    expect(h.replied()?.embeds).toBeUndefined();
    expect(h.repliedComponents()[0]?.type).toBe(ComponentType.Container);
  });

  test('the reply passes the schema that enforces V2 exclusivity', async () => {
    const h = harness();

    await h.press(statsId(TRAP), { config: armed() });

    const reply = h.requests().find((request) => request.kind === 'interaction_reply');
    const parsed = interactionReplyPayloadSchema.safeParse(reply?.payload);

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  test('reports the totals and both windows', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [
      caught(h.now() - 60_000),
      caught(h.now() - 2 * DAY),
      caught(h.now() - 20 * DAY),
    ]);

    await h.press(statsId(TRAP), { config: armed(), permissions: MOD_PERMISSIONS });

    const said = texts(h.repliedComponents()).join('\n');
    expect(said).toContain('**3** members caught');
    expect(said).toContain('**1** in the last 24 hours');
    expect(said).toContain('**2** in the last 7 days');
  });

  test('breaks the count down by what was actually done', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [
      caught(h.now(), 'softban'),
      caught(h.now(), 'softban'),
      caught(h.now(), 'kick'),
    ]);

    await h.press(statsId(TRAP), { config: armed(), permissions: MOD_PERMISSIONS });

    expect(texts(h.repliedComponents()).join('\n')).toContain('Softbans ×2 · Kicks ×1');
  });

  test('renders the empty state rather than counting nobody', async () => {
    const h = harness();

    await h.press(statsId(TRAP), { config: armed(), permissions: MOD_PERMISSIONS });

    const said = texts(h.repliedComponents()).join('\n');
    expect(said).toContain('Nothing has walked into this trap yet');
    expect(said).not.toContain('members caught');
    expect(said).not.toContain('**0**');
  });

  test('a press for a channel that is not a honeypot still answers', async () => {
    const h = harness();

    const outcome = await h.press(statsId(LOUNGE), { config: armed(), channelId: LOUNGE });

    expect(outcome).toEqual({ action: 'answered', channelId: LOUNGE, privileged: false });
    expect(texts(h.repliedComponents()).join('\n')).toContain(`<#${LOUNGE}>`);
  });

  test('a button belonging to another module is left alone', async () => {
    const h = harness();

    const outcome = await h.press('proton:verification:start', { config: armed() });

    expect(outcome).toEqual({
      action: 'ignored',
      reason: 'another module owns that component',
    });
    expect(h.calls()).toEqual([]);
  });

  test('a honeypot button for an action that does not exist is left alone', async () => {
    const h = harness();

    const outcome = await h.press(statsId(TRAP).replace(STATS_ACTION, 'arm'), {
      config: armed(),
    });

    expect(outcome).toEqual({
      action: 'ignored',
      reason: "no honeypot component called 'arm'",
    });
    expect(h.calls()).toEqual([]);
  });

  test('an unbound stats port answers the presser anyway, and names the port in the log', async () => {
    const h = harness({ stats: false });

    const outcome = await h.press(statsId(TRAP), { config: armed() });

    expect(outcome).toEqual({ action: 'refused', reason: 'the stats port is unbound' });
    expect(String(h.replied()?.content)).toContain('cannot read this trap');
    expect(h.replied()?.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(h.said('error').at(-1)).toContain('stats: new RedisHoneypotStatsStore(redis)');
  });

  test('a refusal from Discord is reported with the reason, not swallowed', async () => {
    const h = harness();
    h.rest.fail((call) => call.path.startsWith('/interactions/'), {
      status: 404,
      body: { message: 'Unknown interaction' },
    });

    const outcome = await h.press(statsId(TRAP), { config: armed() });

    expect(outcome.action).toBe('refused');
    expect(h.said('warn').at(-1)).toContain('honeypot could not answer a stats press');
  });
});

describe('who is allowed to see which accounts were caught', () => {
  test('Ban Members sees the recent list', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [caught(h.now())]);

    const outcome = await h.press(statsId(TRAP), {
      config: armed(),
      userId: OTHER,
      permissions: MOD_PERMISSIONS,
    });

    expect(outcome).toEqual({ action: 'answered', channelId: TRAP, privileged: true });
    expect(texts(h.repliedComponents()).join('\n')).toContain(`<@${MEMBER}>`);
  });

  test('Manage Server sees it too', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [caught(h.now())]);

    const outcome = await h.press(statsId(TRAP), {
      config: armed(),
      userId: OTHER,
      permissions: MANAGER_PERMISSIONS,
    });

    expect(outcome).toEqual({ action: 'answered', channelId: TRAP, privileged: true });
    expect(texts(h.repliedComponents()).join('\n')).toContain(`<@${MEMBER}>`);
  });

  test('an ordinary member gets the totals and no account, anywhere in the payload', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [caught(h.now()), caught(h.now(), 'softban', OTHER)]);

    const outcome = await h.press(statsId(TRAP), {
      config: armed(),
      userId: OTHER,
      permissions: PLAIN_PERMISSIONS,
    });

    expect(outcome).toEqual({ action: 'answered', channelId: TRAP, privileged: false });

    const said = texts(h.repliedComponents()).join('\n');
    expect(said).toContain('**2** members caught');
    expect(said).toContain('Only moderators can see which accounts were caught.');

    const wire = JSON.stringify(h.replies());
    expect(wire).not.toContain(MEMBER);
    expect(wire).not.toContain(OTHER);
    expect(wire).not.toContain('<@');
  });

  test('a member with no permission bits at all is not privileged', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [caught(h.now())]);

    const outcome = await h.press(statsId(TRAP), { config: armed(), permissions: '0' });

    expect(outcome).toEqual({ action: 'answered', channelId: TRAP, privileged: false });
    expect(JSON.stringify(h.replies())).not.toContain(MEMBER);
  });

  test('a bitfield Discord sent that is not a number is read as no permissions', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [caught(h.now())]);

    const outcome = await h.press(statsId(TRAP), { config: armed(), permissions: 'not a number' });

    expect(outcome).toEqual({ action: 'answered', channelId: TRAP, privileged: false });
  });

  test('a bit next to Ban Members does not stand in for it', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [caught(h.now())]);

    const outcome = await h.press(statsId(TRAP), {
      config: armed(),
      permissions: String(Permissions.KickMembers | Permissions.ModerateMembers),
    });

    expect(outcome).toEqual({ action: 'answered', channelId: TRAP, privileged: false });
  });
});

describe('the reply never pings the members it names', () => {
  test('carries allowedMentions off, because it is the one message that mentions anyone', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [caught(h.now())]);

    await h.press(statsId(TRAP), { config: armed(), permissions: MOD_PERMISSIONS });

    expect(texts(h.repliedComponents()).join('\n')).toContain(`<@${MEMBER}>`);
    expect(h.replied()?.allowed_mentions).toEqual({ parse: [] });
  });
});

describe('a notice Discord will not let go of', () => {
  test('is remembered and retried rather than reported as removed', async () => {
    const h = harness({ botPermissions: BOT_PERMISSIONS & ~Permissions.ManageMessages });

    await h.saved({ config: armed() });
    const outcome = await h.saved({ config: armed({ enabled: false }) });

    expect(outcome).toEqual({
      action: 'reconciled',
      changes: [{ channelId: TRAP, did: 'failed' }],
    });

    // Forgetting it would strand a message calling itself a trap on a channel that is not one.
    expect(Object.keys(h.remembered())).toEqual([TRAP]);
  });
});

describe('recording what a trap has caught', () => {
  test('a sprung trap records the member, the action and when', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed() });

    expect(outcome).toEqual({ action: 'sprung', kind: 'softban' });
    expect(h.stats.caught(GUILD, TRAP)).toEqual([
      { userId: MEMBER, action: 'softban', at: h.now(), messageId: MESSAGE },
    ]);
  });

  // RESUME redelivers a message.created long after the burst lock has let go, and the ban behind it
  // comes back skipped_duplicate, which reads as success. Without the message id on the record, the
  // same member is counted twice on a number members can see.
  test('counts a redelivered message once, not twice', async () => {
    const h = harness();

    await h.trip({ config: armed() });
    await h.trip({ config: armed() });

    expect(h.stats.caught(GUILD, TRAP)).toHaveLength(1);
  });

  test('records the action of the row that caught them, not the module default', async () => {
    const h = harness();

    await h.trip({ config: armed({ action: 'kick' }) });

    expect(h.stats.caught(GUILD, TRAP).map((entry) => entry.action)).toEqual(['kick']);
  });

  test('a refused ban caught nobody, so it records nobody', async () => {
    const h = harness({ botPermissions: BOT_PERMISSIONS & ~Permissions.BanMembers });

    const outcome = await h.trip({ config: armed() });

    expect(outcome.action).toBe('refused');
    expect(h.stats.caught(GUILD, TRAP)).toEqual([]);
  });

  test('a softban whose lift is stuck records nobody either', async () => {
    const h = harness();
    h.rest.fail(
      (call) => call.method === 'DELETE' && call.path === `/guilds/${GUILD}/bans/${MEMBER}`,
      { status: 500, body: { message: 'Internal Server Error' } },
    );

    const outcome = await h.trip({ config: armed() });

    expect(outcome).toEqual({ action: 'ban_stuck', userId: MEMBER });
    expect(h.stats.caught(GUILD, TRAP)).toEqual([]);
  });

  test('a message that never trips the trap records nothing', async () => {
    const h = harness();

    await h.trip({ config: armed(), channelId: LOUNGE });

    expect(h.stats.entries).toEqual([]);
  });
});

describe('moving the number on the button after a trip', () => {
  test('edits the notice with the new count', async () => {
    const h = harness();
    await h.saved({ config: armed() });

    await h.trip({ config: armed() });

    expect(h.editedIn(TRAP)).toHaveLength(1);
    expect(buttons(h.componentsIn(TRAP))[0]?.label).toBe('Softbans: 1');
  });

  test('two trips inside the window are one edit, and both are still recorded', async () => {
    const h = harness();
    await h.saved({ config: armed() });

    await h.trip({ config: armed(), messageId: '1400000000000000001' });
    h.advance(1_000);
    await h.trip({ config: armed(), authorId: OTHER, messageId: '1400000000000000002' });

    expect(h.editedIn(TRAP)).toHaveLength(1);
    expect(h.stats.caught(GUILD, TRAP)).toHaveLength(2);
    expect(h.stats.claims).toHaveLength(2);
  });

  test('a trip outside the window moves it again, to the number it has by then', async () => {
    const h = harness();
    await h.saved({ config: armed() });

    await h.trip({ config: armed(), messageId: '1400000000000000001' });
    h.advance(NOTICE_REFRESH_MS + 1);
    await h.trip({ config: armed(), authorId: OTHER, messageId: '1400000000000000002' });

    expect(h.editedIn(TRAP)).toHaveLength(2);
    expect(buttons(h.componentsIn(TRAP))[0]?.label).toBe('Softbans: 2');
  });

  test('a trip that loses the lease still records the member', async () => {
    const h = harness();
    await h.saved({ config: armed() });
    h.stats.refuse = true;

    const outcome = await h.trip({ config: armed() });

    expect(outcome).toEqual({ action: 'sprung', kind: 'softban' });
    expect(h.editedIn(TRAP)).toEqual([]);
    expect(h.stats.caught(GUILD, TRAP)).toHaveLength(1);
  });

  test('leases per channel, so a trip in one trap does not gag the other', async () => {
    const h = harness();
    const both = { enabled: true, channels: [trap(), trap({ channelId: LOUNGE })] };
    await h.saved({ config: both });

    await h.trip({ config: both, messageId: '1400000000000000001' });
    await h.trip({
      config: both,
      channelId: LOUNGE,
      authorId: OTHER,
      messageId: '1400000000000000002',
    });

    expect(h.editedIn(TRAP)).toHaveLength(1);
    expect(h.editedIn(LOUNGE)).toHaveLength(1);
  });

  test('a trap with no notice up yet is not edited into existence', async () => {
    const h = harness();

    await h.trip({ config: armed() });

    expect(h.editedIn(TRAP)).toEqual([]);
    expect(h.stats.claims).toEqual([]);
  });

  test('the edit that moves the number carries no flags either', async () => {
    const h = harness();
    await h.saved({ config: armed() });

    await h.trip({ config: armed() });

    expect(h.editedIn(TRAP).at(-1)).not.toHaveProperty('flags');
  });
});

class FakeRedis {
  readonly hashes = new Map<string, Map<string, number>>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly leases = new Set<string>();

  hash(key: string): Map<string, number> {
    const held = this.hashes.get(key) ?? new Map<string, number>();
    this.hashes.set(key, held);
    return held;
  }

  zset(key: string): Map<string, number> {
    const held = this.zsets.get(key) ?? new Map<string, number>();
    this.zsets.set(key, held);
    return held;
  }

  hincrbySync(key: string, field: string, by: number): number {
    const next = (this.hash(key).get(field) ?? 0) + by;
    this.hash(key).set(field, next);
    return next;
  }

  async zadd(key: string, mode: 'NX', score: number, member: string): Promise<number> {
    if (mode === 'NX' && this.zset(key).has(member)) return 0;

    this.zset(key).set(member, score);
    return 1;
  }

  zremrangebyscoreSync(key: string, min: string | number, max: string | number): number {
    let removed = 0;
    for (const [member, score] of [...this.zset(key)]) {
      if (score < bound(min) || score > bound(max)) continue;
      this.zset(key).delete(member);
      removed += 1;
    }
    return removed;
  }

  multi(): FakeMulti {
    return new FakeMulti(this);
  }

  async hget(key: string, field: string): Promise<string | null> {
    const held = this.hash(key).get(field);
    return held === undefined ? null : String(held);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries([...this.hash(key)].map(([field, value]) => [field, String(value)]));
  }

  async zcount(key: string, min: string | number, max: string | number): Promise<number> {
    return [...this.zset(key).values()].filter(
      (score) => score >= bound(min) && score <= bound(max),
    ).length;
  }

  async zrevrange(
    key: string,
    start: number,
    stop: number,
    _withScores: 'WITHSCORES',
  ): Promise<string[]> {
    const ordered = [...this.zset(key)].sort(([leftMember, left], [rightMember, right]) =>
      right === left ? rightMember.localeCompare(leftMember) : right - left,
    );

    return ordered
      .slice(start, stop < 0 ? undefined : stop + 1)
      .flatMap(([member, score]) => [member, String(score)]);
  }

  async set(key: string, _value: string, ..._rest: unknown[]): Promise<'OK' | null> {
    if (this.leases.has(key)) return null;
    this.leases.add(key);
    return 'OK';
  }
}

class FakeMulti {
  readonly #redis: FakeRedis;
  readonly #steps: Array<() => number> = [];

  constructor(redis: FakeRedis) {
    this.#redis = redis;
  }

  hincrby(key: string, field: string, by: number): this {
    this.#steps.push(() => this.#redis.hincrbySync(key, field, by));
    return this;
  }

  zremrangebyscore(key: string, min: string | number, max: string | number): this {
    this.#steps.push(() => this.#redis.zremrangebyscoreSync(key, min, max));
    return this;
  }

  async exec(): Promise<Array<[null, number]>> {
    return this.#steps.map((step) => [null, step()]);
  }
}

function bound(value: string | number): number {
  if (value === '+inf') return Number.POSITIVE_INFINITY;
  if (value === '-inf') return Number.NEGATIVE_INFINITY;
  return Number(value);
}

function store(): { redis: FakeRedis; stats: RedisHoneypotStatsStore } {
  const redis = new FakeRedis();
  return { redis, stats: new RedisHoneypotStatsStore(redis as unknown as Redis) };
}

const NOW = 1_800_000_000_000;

describe('the stats store', () => {
  test('record returns the lifetime total, which climbs with every catch', async () => {
    const { stats } = store();

    expect(await stats.record(GUILD, TRAP, caught(NOW))).toBe(1);
    expect(await stats.record(GUILD, TRAP, caught(NOW + 1))).toBe(2);
    expect(await stats.total(GUILD, TRAP)).toBe(2);
  });

  test('keeps a counter per action, so the breakdown is not derived from the trimmed set', async () => {
    const { stats } = store();

    await stats.record(GUILD, TRAP, caught(NOW, 'softban'));
    await stats.record(GUILD, TRAP, caught(NOW + 1, 'softban'));
    await stats.record(GUILD, TRAP, caught(NOW + 2, 'kick'));

    expect((await stats.read(GUILD, TRAP, NOW + 3)).byAction).toEqual({ softban: 2, kick: 1 });
  });

  test('counts per channel, not per guild', async () => {
    const { stats } = store();

    await stats.record(GUILD, TRAP, caught(NOW));

    expect(await stats.total(GUILD, TRAP)).toBe(1);
    expect(await stats.total(GUILD, LOUNGE)).toBe(0);
  });

  test('derives the 24h and 7d windows from the timestamps, not from the total', async () => {
    const { stats } = store();

    await stats.record(GUILD, TRAP, caught(NOW - 60_000));
    await stats.record(GUILD, TRAP, caught(NOW - 2 * DAY, 'softban', OTHER));
    await stats.record(GUILD, TRAP, caught(NOW - 20 * DAY, 'softban', '400000000000000004'));

    const read = await stats.read(GUILD, TRAP, NOW);

    expect(read.total).toBe(3);
    expect(read.lastDay).toBe(1);
    expect(read.lastWeek).toBe(2);
  });

  test('recent is newest first', async () => {
    const { stats } = store();

    await stats.record(GUILD, TRAP, caught(NOW - 2_000, 'softban', '400000000000000004'));
    await stats.record(GUILD, TRAP, caught(NOW - 1_000, 'kick', OTHER));
    await stats.record(GUILD, TRAP, caught(NOW, 'ban', MEMBER));

    expect((await stats.read(GUILD, TRAP, NOW)).recent).toEqual([
      { userId: MEMBER, action: 'ban', at: NOW },
      { userId: OTHER, action: 'kick', at: NOW - 1_000 },
      { userId: '400000000000000004', action: 'softban', at: NOW - 2_000 },
    ]);
  });

  test('recent is capped, however many the trap has taken', async () => {
    const { stats } = store();

    for (let index = 0; index < RECENT_SHOWN + 5; index += 1) {
      await stats.record(GUILD, TRAP, caught(NOW + index, 'softban', `4000000000000000${index}1`));
    }

    const read = await stats.read(GUILD, TRAP, NOW);

    expect(read.recent).toHaveLength(RECENT_SHOWN);
    expect(read.total).toBe(RECENT_SHOWN + 5);
    expect(read.recent[0]?.at).toBe(NOW + RECENT_SHOWN + 4);
  });

  test('trimming the month-old detail leaves the lifetime total alone', async () => {
    const { stats } = store();

    await stats.record(GUILD, TRAP, caught(NOW - CAUGHT_RETENTION_MS - 1_000));
    await stats.record(GUILD, TRAP, caught(NOW, 'softban', OTHER));

    const read = await stats.read(GUILD, TRAP, NOW);

    expect(read.total).toBe(2);
    expect(read.recent).toHaveLength(1);
    expect(read.recent[0]?.userId).toBe(OTHER);
  });

  test('an unarmed trap reads as empty rather than as an error', async () => {
    const { stats } = store();

    expect(await stats.read(GUILD, TRAP, NOW)).toEqual({
      total: 0,
      lastDay: 0,
      lastWeek: 0,
      byAction: {},
      recent: [],
    });
  });

  test('claimRefresh hands the lease to one caller and refuses the next', async () => {
    const { stats } = store();

    expect(await stats.claimRefresh(GUILD, TRAP, NOTICE_REFRESH_MS)).toBe(true);
    expect(await stats.claimRefresh(GUILD, TRAP, NOTICE_REFRESH_MS)).toBe(false);
    expect(await stats.claimRefresh(GUILD, LOUNGE, NOTICE_REFRESH_MS)).toBe(true);
  });
});

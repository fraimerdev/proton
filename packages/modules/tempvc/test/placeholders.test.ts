import { describe, expect, test } from 'bun:test';
import type { ChannelState, GuildRole, GuildState } from '@proton/core';
import { SAMPLE_NOW, validateConfigTemplates } from '@proton/core/placeholders';
import { DEFAULT_NAME_TEMPLATE, tempVcHubSchema } from '../src/config.ts';
import { createTempVcModule } from '../src/index.ts';
import {
  renderTempVcName,
  TEMPVC_NAME_SURFACE,
  TEMPVC_OWNER_KEYS,
  type TempVcNameFacts,
  type TempVcOwner,
  tempvcTemplates,
} from '../src/placeholders.ts';
import { TemporaryVoiceService } from '../src/service.ts';
import { readVoiceMember } from '../src/voice.ts';
import { ADA, BOT, CATEGORY, callsOf, type Fake, GUILD, HUB, harness } from './harness.ts';

const HUB_NAME = 'Create a room';

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';

function owner(displayName: string, username = 'ada', globalName?: string | null): TempVcOwner {
  return {
    userId: ADA,
    displayName,
    username,
    ...(globalName === undefined ? {} : { globalName }),
  };
}

function facts(who: TempVcOwner, extra: Partial<TempVcNameFacts> = {}): TempVcNameFacts {
  return { owner: who, hub: null, server: null, ...extra };
}

function named(template: string, who: TempVcOwner, extra?: Partial<TempVcNameFacts>): string {
  return renderTempVcName(template, facts(who, extra), SAMPLE_NOW).output;
}

function codes(template: string, who: TempVcOwner, extra?: Partial<TempVcNameFacts>): string[] {
  return renderTempVcName(template, facts(who, extra), SAMPLE_NOW).diagnostics.map(
    ({ code }) => code,
  );
}

function legacyName(template: string, who: TempVcOwner): string {
  const filled = template
    .split('{displayName}')
    .join(who.displayName)
    .split('{user}')
    .join(who.displayName)
    .split('{username}')
    .join(who.username)
    .split('{userId}')
    .join(who.userId)
    .trim();

  return (filled.length === 0 ? who.displayName : filled).slice(0, 100);
}

const LEGACY_TEMPLATES = [
  DEFAULT_NAME_TEMPLATE,
  '{user}’s room',
  '{displayName} {username} {userId}',
  '{user} and {user}',
  '{user}',
  '{username}',
  '  {user}  ',
  'Room of {user} ({userId})',
  '\u{1F50A} {user} · {username}',
  'hello {nobody} {user}',
  'a { lone } brace for {user} with {} and { server }',
];

const LEGACY_OWNERS: readonly TempVcOwner[] = [
  owner('Ada'),
  owner('x'.repeat(500)),
  owner('Ada', ''),
  owner('Ada Lovelace', 'ada.l_'),
  owner('abcdefghijklmnopqrstuvwxyz012345'),
  owner('**Ada** <@&123456789012345678> @everyone `x` #1'),
  owner(`${FAMILY} Ada`),
  owner('\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} Ada'),
  owner('❤️ Ada'),
  owner('Ada‌b'),
];

describe('names render byte-identically to the split-and-join renderer', () => {
  for (const [index, who] of LEGACY_OWNERS.entries()) {
    test(`through {user} {displayName} {username} {userId} (#${index + 1} ${who.displayName.slice(0, 12)})`, () => {
      for (const template of LEGACY_TEMPLATES) {
        expect(named(template, who)).toBe(legacyName(template, who));
      }
    });
  }

  test('a joined emoji keeps its joiners, variation selector and tag characters', () => {
    expect(named('{user}’s room', owner(`${FAMILY} Ada`))).toBe(`${FAMILY} Ada’s room`);
    expect(named('{user}', owner('❤️'))).toBe('❤️');
  });

  test('the service names the channel exactly as the legacy renderer did', async () => {
    const fake = harness({ hub: { nameTemplate: 'Room of {displayName} ({userId})' } });
    await fake.service.create(fake.ctx, fake.hub, {
      ...owner('Ada'),
      channelId: HUB,
      isBot: false,
    });

    expect(callsOf(fake, 'create_channel')[0]?.payload.name).toBe(
      legacyName('Room of {displayName} ({userId})', owner('Ada')),
    );
    expect(callsOf(fake, 'create_channel')[0]?.idempotencyKey).toBe('tempvc:row-1:create');
  });
});

describe('what the voice channel normaliser changes on purpose', () => {
  test('a display name is never expanded again, which the old renderer did', () => {
    const who = owner('{username} {user.id}', 'ada');

    expect(legacyName('{user}', who)).toBe(`ada {user.id}`);
    expect(named('{user}', who)).toBe('{username} {user.id}');
  });

  test('a tab, a line break or a no-break space becomes a space', () => {
    expect(legacyName('{user}\troom', owner('Ada'))).toBe('Ada\troom');
    expect(named('{user}\troom', owner('Ada'))).toBe('Ada room');
    expect(named('{user}', owner('Ada Lovelace\nthe first'))).toBe('Ada Lovelace the first');
  });

  test('a name cut at 100 on a space loses the space', () => {
    const who = owner(`${'a'.repeat(99)} b`);

    expect(legacyName('{user}', who)).toBe(`${'a'.repeat(99)} `);
    expect(named('{user}', who)).toBe('a'.repeat(99));
  });

  test('a cut never leaves half of an emoji behind', () => {
    const who = owner(`${'a'.repeat(99)}\u{1F600}`);

    expect(legacyName('{user}', who)).toBe(`${'a'.repeat(99)}\uD83D`);
    expect(named('{user}', who)).toBe('a'.repeat(99));
  });

  test('invisible characters other than emoji joiners are dropped', () => {
    const who = owner('Ada​‏');

    expect(legacyName('{user}’s room', who)).toBe('Ada​‏’s room');
    expect(named('{user}’s room', who)).toBe('Ada’s room');
  });
});

describe('a name that renders to nothing', () => {
  test('falls back to the display name', () => {
    expect(named('{username}', owner('Ada', ''))).toBe('Ada');
    expect(codes('{username}', owner('Ada', ''))).toContain('empty_channel_name');
  });

  test('falls back exactly as the legacy renderer did: raw, and cut at 100', () => {
    for (const who of [owner('x'.repeat(150), ''), owner('  Ada\t', '')]) {
      expect(named('{username}', who)).toBe(legacyName('{username}', who));
    }
    expect(named('{username}', owner('x'.repeat(150), ''))).toBe('x'.repeat(100));
  });

  test('falls back when its only placeholder is not available', () => {
    expect(named('{user.global_name}', owner('Ada'))).toBe('Ada');
  });
});

describe('the canonical placeholders', () => {
  test('fill in the same way as their older names', () => {
    for (const who of LEGACY_OWNERS) {
      expect(named('{user.display_name} {user.username} {user.id}', who)).toBe(
        named('{displayName} {username} {userId}', who),
      );
    }
  });

  test('{user.global_name} shows the account name even when a nickname is set', () => {
    expect(named('{user.global_name}’s room', owner('Nick', 'ada', 'Ada Lovelace'))).toBe(
      'Ada Lovelace’s room',
    );
    expect(named('{user.global_name}’s room', owner('Nick', 'ada', null))).toBe('ada’s room');
  });

  test('{user.global_name} is not available when it was not read', () => {
    expect(named('room {user.global_name}', owner('Nick'))).toBe('room');
    expect(codes('room {user.global_name}', owner('Nick'))).toEqual(['unavailable']);
  });

  test('the creator channel renders its name, and its mention does too', () => {
    const hub = { id: HUB, name: HUB_NAME, type: 2, parentId: CATEGORY };

    expect(named('{user} from {tempvc.hub_name}', owner('Ada'), { hub })).toBe(
      'Ada from Create a room',
    );
    expect(named('{tempvc.hub_mention} · {user}', owner('Ada'), { hub })).toBe(
      'Create a room · Ada',
    );
  });

  test('a creator channel Proton has not seen renders nothing and says why', () => {
    const hub = { id: HUB };

    expect(named('{user} {tempvc.hub_name}', owner('Ada'), { hub })).toBe('Ada');
    expect(codes('{user} {tempvc.hub_name}', owner('Ada'), { hub })).toEqual(['unavailable']);
    expect(named('{user} {tempvc.hub_mention}', owner('Ada'), { hub })).toBe('Ada');
    expect(codes('{user} {tempvc.hub_mention}', owner('Ada'), { hub })).toEqual([
      'mention_without_name',
    ]);
  });

  test('{server.name} renders the server, and nothing when it is unknown', () => {
    const server = { id: GUILD, name: 'Proton HQ' };

    expect(named('{user} @ {server.name}', owner('Ada'), { server })).toBe('Ada @ Proton HQ');
    expect(named('{user} @ {server.name}', owner('Ada'))).toBe('Ada @');
    expect(codes('{user} @ {server.name}', owner('Ada'))).toEqual(['unavailable']);
  });
});

describe('the name template refine', () => {
  const parse = (nameTemplate: string) =>
    tempVcHubSchema.safeParse({ channelId: HUB, nameTemplate });

  test('accepts a template that names the member only by a canonical placeholder', () => {
    for (const key of TEMPVC_OWNER_KEYS) {
      expect(parse(`{${key}}’s room`).success).toBe(true);
    }
    expect(parse('{user:upper}').success).toBe(true);
    expect(parse('{user.display_name:truncate(20)} room').success).toBe(true);
  });

  test('refuses a template that does not name the member, naming what would', () => {
    for (const template of ['{server.name}', '{tempvc.hub_name}', 'Voice {now}', '{{user.id}}']) {
      expect(parse(template).success).toBe(false);
    }

    const message = parse('{server.name}').error?.issues[0]?.message ?? '';
    expect(message).toContain('{user.display_name}');
    expect(message).toContain('{userId}');
  });

  test('still reads a stored {{user}}', () => {
    expect(parse('{{user}}').success).toBe(true);
  });
});

describe('the surface', () => {
  test('is a public voice channel name rendered when a channel is made', () => {
    expect(TEMPVC_NAME_SURFACE).toMatchObject({
      id: 'tempvc.channel_name',
      module: 'tempvc',
      event: 'tempvc.create',
      audience: 'public',
    });
    expect(TEMPVC_NAME_SURFACE.fieldAt('hubs.3.nameTemplate')).toMatchObject({
      kind: 'channel_name',
      channel: 'voice',
      label: 'Name template',
      limit: 100,
    });
    expect(TEMPVC_NAME_SURFACE.fieldAt('hubs.x.nameTemplate')).toBeUndefined();
  });

  test('offers exactly the member, creator channel and server name', () => {
    expect(
      TEMPVC_NAME_SURFACE.pickerFor('hubs.0.nameTemplate')
        .map(({ key }) => key)
        .sort(),
    ).toEqual([
      'server.name',
      'tempvc.hub_mention',
      'tempvc.hub_name',
      'user.display_name',
      'user.global_name',
      'user.id',
      'user.username',
    ]);
  });

  test('keeps the four older names, each on its own meaning', () => {
    const aliases = TEMPVC_NAME_SURFACE.definitions.flatMap(({ key, aliases }) =>
      aliases.map((alias) => `${alias}=${key}`),
    );

    expect(aliases.sort()).toEqual([
      'displayName=user.display_name',
      'user=user.display_name',
      'userId=user.id',
      'username=user.username',
    ]);
  });

  test('holds nothing private: every placeholder is public and the picker hides none', () => {
    expect(
      TEMPVC_NAME_SURFACE.definitions.every(({ sensitivity }) => sensitivity === 'public'),
    ).toBe(true);
    expect(TEMPVC_NAME_SURFACE.pickerFor('hubs.0.nameTemplate')).toHaveLength(
      TEMPVC_NAME_SURFACE.definitions.length,
    );
  });

  test('does not offer clocks, occupancy or member-only details, and posts them as written', () => {
    const template = '{user} {now} {year} {user.nickname} {user.mention} {tempvc.occupant_count}';

    expect(named(template, owner('Ada'))).toBe(
      'Ada {now} {year} {user.nickname} {user.mention} {tempvc.occupant_count}',
    );
    expect(new Set(codes(template, owner('Ada')))).toEqual(new Set(['unknown_placeholder']));
  });

  test('its sample renders every placeholder it offers', () => {
    const [sample] = TEMPVC_NAME_SURFACE.samples;
    if (!sample) throw new Error('the surface has a sample');

    expect(sample).toMatchObject({
      id: 'tempvc',
      label: 'Sample: Fraimer joining Create a room in Proton HQ',
    });

    const render = (template: string) => renderTempVcName(template, sample.facts, SAMPLE_NOW);

    expect(render(DEFAULT_NAME_TEMPLATE).output).toBe('Fraimer’s channel');
    for (const { key } of TEMPVC_NAME_SURFACE.definitions) {
      expect(render(`{user} {${key}}`).diagnostics).toEqual([]);
    }
    expect(render('{user.username} in {tempvc.hub_mention} on {server.name}').output).toBe(
      'fraimer in Create a room on Proton HQ',
    );
  });
});

describe('the module templates', () => {
  const config = (...templates: string[]) => ({
    enabled: true,
    hubs: templates.map((nameTemplate, index) => ({
      channelId: `50000000000000000${index}`,
      nameTemplate,
    })),
  });

  test('are declared on the manifest', () => {
    expect(createTempVcModule().templates).toBe(tempvcTemplates);
    expect(Object.keys(tempvcTemplates.surfaces)).toEqual(['tempvc.channel_name']);
  });

  test('collect every creator channel name template', () => {
    expect(
      tempvcTemplates
        .collect(config('{user}’s room', '{user.id}'))
        .map(({ path, surfaceId, text }) => ({
          path,
          surfaceId,
          text,
        })),
    ).toEqual([
      { path: 'hubs.0.nameTemplate', surfaceId: 'tempvc.channel_name', text: '{user}’s room' },
      { path: 'hubs.1.nameTemplate', surfaceId: 'tempvc.channel_name', text: '{user.id}' },
    ]);
  });

  test('collect never throws on a config of the wrong shape', () => {
    for (const garbage of [
      null,
      'x',
      5,
      [],
      { hubs: 'x' },
      { hubs: [null, { nameTemplate: 5 }] },
    ]) {
      expect(tempvcTemplates.collect(garbage)).toEqual([]);
    }
  });

  test('an unchanged broken template does not stop another change being saved', () => {
    const before = config('{user:shout}');
    const next = { ...config('{user:shout}'), enabled: false };

    expect(validateConfigTemplates(tempvcTemplates, next, before).blocking).toEqual([]);
  });

  test('a changed broken template is refused, naming where it is', () => {
    const report = validateConfigTemplates(
      tempvcTemplates,
      config('{user}', '{user:shout}'),
      config('{user}', '{user}'),
    );

    expect(
      report.blocking.map(({ path, label, diagnostic }) => [path, label, diagnostic.code]),
    ).toEqual([['hubs.1.nameTemplate', 'Name template', 'unknown_modifier']]);
  });

  test('warnings and notes never block', () => {
    const report = validateConfigTemplates(
      tempvcTemplates,
      config('{{user}} {nobody} {user}'),
      config('{user}'),
    );
    const found = (report.byPath.get('hubs.0.nameTemplate') ?? []).map(({ code }) => code);

    expect(report.blocking).toEqual([]);
    expect(found).toContain('unknown_placeholder');
    expect(found).toContain('doubled_brace_literal');
    expect(found).toContain('legacy_alias');
  });
});

describe('hostile input', () => {
  test('prototype names are posted as written and never block', () => {
    const template =
      '{user} {constructor} {__proto__} {toString} {prototype} {user.constructor} {user.__proto__}';

    expect(named(template, owner('Ada'))).toBe(
      'Ada {constructor} {__proto__} {toString} {prototype} {user.constructor} {user.__proto__}',
    );
    expect(
      validateConfigTemplates(tempvcTemplates, { hubs: [{ nameTemplate: template }] }).blocking,
    ).toEqual([]);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });

  test('a display name of placeholders and markup is posted as written', () => {
    const who = owner(
      '{user.id} {userId} <@&123456789012345678> **x** @everyone',
      'ada',
      '{username}',
    );

    expect(named('{user.display_name}’s room', who)).toBe(
      '{user.id} {userId} <@&123456789012345678> **x** @everyone’s room',
    );
    expect(named('{user.global_name}', who)).toBe('{username}');
  });

  test('a voice state keeps the account name apart from the nickname', () => {
    const payload = {
      user_id: ADA,
      channel_id: HUB,
      member: { nick: 'Nick', user: { username: 'ada', global_name: 'Ada Lovelace' } },
    };

    expect(readVoiceMember(payload)).toEqual({
      userId: ADA,
      channelId: HUB,
      displayName: 'Nick',
      username: 'ada',
      globalName: 'Ada Lovelace',
      isBot: false,
    });
    expect(
      readVoiceMember({ ...payload, member: { user: { username: 'ada', global_name: null } } })
        ?.globalName,
    ).toBeNull();
  });

  test('a voice state whose JSON carries __proto__ supplies no name and pollutes nothing', () => {
    const payload: unknown = JSON.parse(
      `{"user_id":"${ADA}","channel_id":"${HUB}","member":{"__proto__":{"nick":"Evil"},"user":{"username":"ada","__proto__":{"global_name":"Evil","bot":true}}}}`,
    );

    expect(readVoiceMember(payload)).toEqual({
      userId: ADA,
      channelId: HUB,
      displayName: 'ada',
      username: 'ada',
      globalName: null,
      isBot: false,
    });
    expect(({} as Record<string, unknown>).nick).toBeUndefined();
    expect(({} as Record<string, unknown>).global_name).toBeUndefined();
  });
});

describe('limits', () => {
  test('no rendered name is ever longer than Discord allows', () => {
    for (const who of LEGACY_OWNERS) {
      for (const template of LEGACY_TEMPLATES) {
        expect(named(template, who).length).toBeLessThanOrEqual(100);
      }
    }
  });

  test('the longest template the settings allow, full of the longest names, is cut to 100', () => {
    const who = owner('abcdefghijklmnopqrstuvwxyz012345');
    const template = '{user}'.repeat(16);

    expect(tempVcHubSchema.safeParse({ channelId: HUB, nameTemplate: template }).success).toBe(
      true,
    );
    expect(named(template, who)).toBe(who.displayName.repeat(4).slice(0, 100));
  });
});

function hubChannel(name?: string): ChannelState {
  return {
    id: HUB,
    parentId: CATEGORY,
    type: 2,
    overwrites: [],
    ...(name === undefined ? {} : { name }),
  };
}

function stateWith(channels: ChannelState[]): GuildState {
  return {
    guildId: GUILD,
    ownerId: BOT,
    everyoneRoleId: GUILD,
    roles: new Map<string, GuildRole>(),
    botRoleIds: [],
    channels: new Map(channels.map((channel) => [channel.id, channel])),
    name: 'Proton HQ',
    memberCount: 12,
    updatedAt: SAMPLE_NOW,
  };
}

function serviceReading(fake: Fake, get: () => Promise<GuildState | null>): TemporaryVoiceService {
  let made = 0;

  return new TemporaryVoiceService({
    repository: fake.repository,
    botUserId: BOT,
    guildState: { get },
    newId: () => `row-${++made}`,
  });
}

describe('creating a channel reads only what its name uses', () => {
  const ada = { ...owner('Ada'), channelId: HUB, isBot: false };

  test('a member-only template never reads the guild state', async () => {
    const fake = harness();
    let reads = 0;
    const service = serviceReading(fake, async () => {
      reads += 1;
      return stateWith([hubChannel(HUB_NAME)]);
    });

    await service.create(fake.ctx, fake.hub, ada);

    expect(reads).toBe(0);
    expect(callsOf(fake, 'create_channel')[0]?.payload.name).toBe('Ada’s room');
  });

  test('the creator channel and server names come from one guild state read', async () => {
    const fake = harness({ hub: { nameTemplate: '{user} · {tempvc.hub_name} · {server.name}' } });
    let reads = 0;
    const service = serviceReading(fake, async () => {
      reads += 1;
      return stateWith([hubChannel(HUB_NAME)]);
    });

    await service.create(fake.ctx, fake.hub, ada);

    expect(reads).toBe(1);
    expect(callsOf(fake, 'create_channel')[0]?.payload.name).toBe(
      'Ada · Create a room · Proton HQ',
    );
  });

  test('a creator channel missing from the guild state renders nothing', async () => {
    const fake = harness({ hub: { nameTemplate: '{user} {tempvc.hub_mention}' } });
    const service = serviceReading(fake, async () => stateWith([]));

    await service.create(fake.ctx, fake.hub, ada);

    expect(callsOf(fake, 'create_channel')[0]?.payload.name).toBe('Ada');
  });

  test('a guild state read that fails still makes the channel, and says what was left out', async () => {
    const fake = harness({ hub: { nameTemplate: '{user} {server.name}' } });
    const service = serviceReading(fake, async () => {
      throw new Error('redis is down');
    });

    const outcome = await service.create(fake.ctx, fake.hub, ada);

    expect('created' in outcome).toBe(true);
    expect(callsOf(fake, 'create_channel')[0]).toMatchObject({
      idempotencyKey: 'tempvc:row-1:create',
      payload: { name: 'Ada' },
    });
    expect(fake.logs).toContainEqual({
      level: 'warn',
      message: expect.stringContaining('could not read them: redis is down'),
    });
  });

  test('the account name from the voice state reaches {user.global_name}', async () => {
    const fake = harness({ hub: { nameTemplate: '{user.global_name} ({user})' } });
    const member = readVoiceMember({
      user_id: ADA,
      channel_id: HUB,
      member: { nick: 'Nick', user: { username: 'ada', global_name: 'Ada Lovelace' } },
    });
    if (!member) throw new Error('the payload names a member');

    await fake.service.create(fake.ctx, fake.hub, member);

    expect(callsOf(fake, 'create_channel')[0]?.payload.name).toBe('Ada Lovelace (Nick)');
  });
});

import { describe, expect, test } from 'bun:test';
import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  BotNameStyle,
  Logger,
  NameStyleState,
  ProtonEvent,
  RestResponse,
} from '@proton/core';
import { NEVER_RECORDED_KINDS } from '@proton/core';
import type { BrandingConfig } from '../src/config.ts';
import { type DisplayNameStyle, wireStyleFingerprint } from '../src/name-style.ts';
import { applyNameStyle, UNVERIFIED_RETRY_MS, verifyNameStyle } from '../src/name-style-apply.ts';
import {
  AVATAR_HASH,
  BANNER_HASH,
  BOT,
  configChanged,
  GUILD,
  guildAvailable,
  harness,
  MEMBER_PATH,
  MemoryNameStyleStore,
  PNG_DATA_URI,
  WITHOUT_NICKNAME,
  wire,
} from './harness.ts';

const GRADIENT: DisplayNameStyle = {
  font: 'modern',
  effect: 'gradient',
  colours: [0x5865f2, 0xeb459e],
};
const GRADIENT_WIRE: BotNameStyle = { fontId: 6, effectId: 2, colours: [0x5865f2, 0xeb459e] };

const NEON: DisplayNameStyle = { font: 'tempo', effect: 'neon', colours: [0xff0000] };
const NEON_WIRE: BotNameStyle = { fontId: 12, effectId: 3, colours: [0xff0000] };

const UNAVAILABLE: DisplayNameStyle = { font: 'monkey-bars', effect: 'solid', colours: [0x2a8af7] };

const STYLE_PATH = `/guilds/${GUILD}/members/@me`;

const FULL = {
  nickname: 'Dreamliner',
  avatarHash: AVATAR_HASH,
  bannerHash: BANNER_HASH,
  bio: 'The friendly one.',
};

const PROFILE_BODY = { avatar: PNG_DATA_URI, banner: PNG_DATA_URI, bio: 'The friendly one.' };

const BLANK = { nick: null, avatar: null, banner: null };

function styleOnly(auditId = 'audit-1'): ProtonEvent {
  return configChanged({ auditId, changedKeys: ['displayNameStyle'] });
}

function wireBody(style: BotNameStyle | null): Record<string, unknown> {
  return {
    display_name_font_id: style?.fontId ?? null,
    display_name_effect_id: style?.effectId ?? null,
    display_name_colors: style?.colours ?? null,
  };
}

function held(overrides: Partial<NameStyleState> = {}): NameStyleState {
  const at = Date.now() - 60_000;

  return {
    guildId: GUILD,
    requested: GRADIENT_WIRE,
    outcome: 'confirmed',
    reason: null,
    attemptedAt: at,
    confirmed: GRADIENT_WIRE,
    confirmedAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function proxied(message: string): RestResponse {
  return { status: 502, body: { error: 'rest_proxy_upstream_failure', message } };
}

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function answering(result: ActionResult): ActionExecutor & { requests: ActionRequest[] } {
  const requests: ActionRequest[] = [];

  return {
    requests,
    async execute(request: ActionRequest): Promise<ActionResult> {
      requests.push(request);
      return result;
    },
  };
}

describe('saving a display name style', () => {
  test('sends one PATCH with exactly the three fields, keyed on the audit id, and confirms it', async () => {
    const h = harness();

    await h.listen(styleOnly('audit-7'), { displayNameStyle: GRADIENT });

    expect(h.calls().map((call) => [call.method, call.path])).toEqual([['PATCH', STYLE_PATH]]);
    expect(h.styleBodies()).toEqual([wireBody(GRADIENT_WIRE)]);
    expect(Object.keys(h.styleBodies()[0] ?? {}).sort()).toEqual([
      'display_name_colors',
      'display_name_effect_id',
      'display_name_font_id',
    ]);
    expect(h.stylePatches()[0]?.headers?.['x-audit-log-reason']).toBeUndefined();
    expect(h.keys()).toEqual([`branding:${GUILD}:audit-7:name-style`]);

    expect(h.nameStyles.state).toMatchObject({
      requested: GRADIENT_WIRE,
      outcome: 'confirmed',
      reason: null,
      confirmed: GRADIENT_WIRE,
    });
    expect(h.nameStyles.state?.confirmedAt).not.toBeNull();
  });

  test('writes no case row, because the outcome has its own record', async () => {
    const h = harness();

    await h.listen(styleOnly(), { displayNameStyle: GRADIENT });

    expect(h.recorder.recorded).toEqual([]);
    expect(NEVER_RECORDED_KINDS.has('set_bot_name_style')).toBe(true);
  });

  test('runs no other leg on a save of only the style, even with images set', async () => {
    const h = harness();

    await h.listen(styleOnly(), { ...FULL, displayNameStyle: GRADIENT });

    expect(h.otherCalls()).toEqual([]);
    expect(h.assets.requested).toEqual([]);
    expect(h.stylePatches()).toHaveLength(1);
  });

  test('treats the stamp the API adds on a first save as part of the style', async () => {
    const h = harness();

    await h.listen(configChanged({ changedKeys: ['displayNameStyle', 'nameStyleNative'] }), {
      ...FULL,
      displayNameStyle: GRADIENT,
    });

    expect(h.otherCalls()).toEqual([]);
    expect(h.stylePatches()).toHaveLength(1);
  });

  test('runs after the profile and nickname when the same save changed the nickname', async () => {
    const h = harness();

    await h.listen(configChanged({ changedKeys: ['nickname', 'displayNameStyle'] }), {
      ...FULL,
      displayNameStyle: GRADIENT,
    });

    expect(h.bodies()).toEqual([PROFILE_BODY, { nick: 'Dreamliner' }, wireBody(GRADIENT_WIRE)]);
  });

  test('is not sent by a save that left the style alone', async () => {
    const h = harness();

    await h.listen(configChanged({ changedKeys: ['nickname'] }), {
      ...FULL,
      displayNameStyle: GRADIENT,
    });

    expect(h.bodies()).toEqual([PROFILE_BODY, { nick: 'Dreamliner' }]);
  });

  test('is sent when Branding is switched on, and when a save names no keys', async () => {
    for (const event of [
      configChanged({ enabledBefore: false, enabledAfter: true, changedKeys: ['enabled'] }),
      configChanged({ changedKeys: [] }),
    ]) {
      const h = harness();

      await h.listen(event, { ...FULL, displayNameStyle: GRADIENT });

      expect(h.bodies()).toEqual([PROFILE_BODY, { nick: 'Dreamliner' }, wireBody(GRADIENT_WIRE)]);
    }
  });

  test('sends nothing for no style when Proton never styled this server', async () => {
    const h = harness();

    await h.listen(styleOnly(), { displayNameStyle: null });

    expect(h.calls()).toEqual([]);
    expect(h.nameStyles.writes).toEqual([]);
  });

  test('sends three nulls when a style is removed, and confirms no style', async () => {
    const h = harness();
    h.nameStyles.state = held();

    await h.listen(styleOnly(), { displayNameStyle: null });

    expect(h.styleBodies()).toEqual([wireBody(null)]);
    expect(h.nameStyles.state).toMatchObject({
      requested: null,
      outcome: 'confirmed',
      confirmed: null,
    });
    expect(h.nameStyles.state?.confirmedAt).not.toBeNull();
  });

  test('never sends a stored style Discord does not offer for apps, and says which part', async () => {
    const h = harness();

    await h.listen(styleOnly(), { displayNameStyle: UNAVAILABLE });

    expect(h.calls()).toEqual([]);
    expect(h.nameStyles.writes).toEqual([]);
    expect(
      h.logs.some((line) => line.message.includes('Monkey Bars is not available for apps yet.')),
    ).toBe(true);
  });

  test('sends nothing without a name style store', async () => {
    const h = harness({ unbind: ['nameStyles'] });

    await h.listen(styleOnly(), { displayNameStyle: GRADIENT });

    expect(h.calls()).toEqual([]);
  });
});

describe('when Proton lacks Change Nickname', () => {
  test('nothing is sent, the refusal is recorded by name and the profile still lands', async () => {
    const h = harness({ botPermissions: WITHOUT_NICKNAME });

    await h.listen(configChanged({ changedKeys: ['nickname', 'displayNameStyle'] }), {
      ...FULL,
      displayNameStyle: GRADIENT,
    });

    expect(h.bodies()).toEqual([PROFILE_BODY]);
    expect(h.nameStyles.state).toMatchObject({
      requested: GRADIENT_WIRE,
      outcome: 'rejected',
      reason: 'missing_change_nickname',
      confirmedAt: null,
    });
    expect(
      h.logs.some(
        (line) =>
          line.message.includes('display name style') && line.message.includes('Change Nickname'),
      ),
    ).toBe(true);
  });
});

describe('reading back what Discord did', () => {
  test('a success that shows another style is ignored, and keeps the confirmed style', async () => {
    const h = harness();
    const before = held();
    h.nameStyles.state = before;
    h.rest.styleAnswer = { status: 200, body: { display_name_styles: wire(GRADIENT_WIRE) } };

    await h.listen(styleOnly(), { displayNameStyle: NEON });

    expect(h.nameStyles.state).toMatchObject({
      requested: NEON_WIRE,
      outcome: 'ignored',
      reason: 'discord_ignored',
      confirmed: GRADIENT_WIRE,
      confirmedAt: before.confirmedAt,
    });
  });

  test('sorts every refusal and failure, and none of them overwrites the confirmed style', async () => {
    const answers: Array<[string, RestResponse | Error, string, string]> = [
      [
        '403',
        { status: 403, body: { message: 'Missing Permissions', code: 50013 } },
        'rejected',
        'missing_change_nickname',
      ],
      [
        '400',
        { status: 400, body: { message: 'Invalid Form Body', code: 50035 } },
        'rejected',
        'discord_refused',
      ],
      [
        '404',
        { status: 404, body: { message: 'Unknown Member', code: 10007 } },
        'rejected',
        'discord_refused',
      ],
      ['proxied 403', proxied('Missing Permissions'), 'rejected', 'missing_change_nickname'],
      ['proxied 50001', proxied('Missing Access'), 'rejected', 'missing_change_nickname'],
      [
        'proxied 400',
        proxied('Invalid Form Body\ndisplay_name_colors[0][NUMBER_TYPE_MAX]: Too big'),
        'rejected',
        'discord_refused',
      ],
      [
        'proxied field error',
        proxied('display_name_font_id[BASE_TYPE_CHOICES]: Not a choice'),
        'rejected',
        'discord_refused',
      ],
      ['proxied 404', proxied('Unknown Member'), 'rejected', 'discord_refused'],
      ['proxied abort', proxied('This operation was aborted'), 'unverified', 'no_answer'],
      ['proxied 5xx', proxied('Internal Server Error'), 'unverified', 'no_answer'],
      ['bare 502', { status: 502, body: 'Bad Gateway' }, 'unverified', 'no_answer'],
      ['500', { status: 500, body: {} }, 'unverified', 'no_answer'],
      ['429', { status: 429, body: { retry_after: 5 } }, 'unverified', 'no_answer'],
      ['transport', new Error('connect ECONNREFUSED'), 'unverified', 'no_answer'],
    ];

    for (const [label, answer, outcome, reason] of answers) {
      const h = harness();
      const before = held();
      h.nameStyles.state = before;
      h.rest.styleAnswer = answer;

      await h.listen(styleOnly(), { displayNameStyle: NEON });

      expect({ label, state: h.nameStyles.state }).toMatchObject({
        label,
        state: {
          requested: NEON_WIRE,
          outcome,
          reason,
          confirmed: GRADIENT_WIRE,
          confirmedAt: before.confirmedAt,
        },
      });
    }
  });

  test('without the field in the answer, reads the member once and confirms from that', async () => {
    const h = harness();
    h.rest.styleAnswer = { status: 200, body: { user: { id: BOT } } };
    h.rest.memberAnswer = {
      status: 200,
      body: { user: { id: BOT }, display_name_styles: wire(GRADIENT_WIRE) },
    };

    await h.listen(styleOnly(), { displayNameStyle: GRADIENT });

    expect(h.memberReads()).toHaveLength(1);
    expect(h.nameStyles.state).toMatchObject({ outcome: 'confirmed', confirmed: GRADIENT_WIRE });
  });

  test('without the field in either answer, records unverified after exactly one read', async () => {
    for (const memberAnswer of [
      { status: 200, body: { user: { id: BOT } } },
      { status: 404, body: { message: 'Unknown Member' } },
      new Error('connect ECONNREFUSED'),
    ]) {
      const h = harness();
      h.rest.styleAnswer = { status: 200, body: {} };
      h.rest.memberAnswer = memberAnswer;

      await h.listen(styleOnly(), { displayNameStyle: GRADIENT });

      expect(h.memberReads()).toHaveLength(1);
      expect(h.nameStyles.state).toMatchObject({ outcome: 'unverified', reason: 'not_readable' });
    }
  });

  test('never takes the style from the member’s user object', async () => {
    const h = harness();
    const onUser = {
      status: 200,
      body: { user: { id: BOT, display_name_styles: wire(GRADIENT_WIRE) } },
    };
    h.rest.styleAnswer = onUser;
    h.rest.memberAnswer = onUser;

    await h.listen(styleOnly(), { displayNameStyle: GRADIENT });

    expect(h.nameStyles.state).toMatchObject({ outcome: 'unverified', reason: 'not_readable' });
  });

  test('without a REST client, records unverified and reads nothing', async () => {
    const h = harness({ unbind: ['rest'] });
    h.rest.styleAnswer = { status: 200, body: {} };

    await h.listen(styleOnly(), { displayNameStyle: GRADIENT });

    expect(h.memberReads()).toEqual([]);
    expect(h.nameStyles.state).toMatchObject({ outcome: 'unverified', reason: 'not_readable' });
  });

  test('a reset Discord answers with null is confirmed as no style', async () => {
    const h = harness();
    h.nameStyles.state = held();
    h.rest.styleAnswer = { status: 200, body: { display_name_styles: null } };

    await h.listen(styleOnly(), { displayNameStyle: null });

    expect(h.nameStyles.state).toMatchObject({
      requested: null,
      outcome: 'confirmed',
      confirmed: null,
    });
  });
});

describe('applying a style directly', () => {
  test('sends the kind with no reason, no case and the key it was given, at the given time', async () => {
    const store = new MemoryNameStyleStore();
    const executor = answering({
      status: 'executed',
      body: { display_name_styles: wire(GRADIENT_WIRE) },
    });

    const verdict = await applyNameStyle(
      { guildId: GUILD, executor, logger: quiet },
      { nameStyles: store },
      GRADIENT_WIRE,
      'the-key',
      () => 1_234,
    );

    expect(verdict).toEqual({ outcome: 'confirmed', reason: null, recorded: true });
    expect(executor.requests).toEqual([
      {
        guildId: GUILD,
        moduleId: 'branding',
        kind: 'set_bot_name_style',
        actorId: 'proton:branding',
        payload: { style: GRADIENT_WIRE },
        dryRun: false,
        record: false,
        idempotencyKey: 'the-key',
      },
    ]);
    expect(store.state).toMatchObject({ attemptedAt: 1_234, confirmedAt: 1_234 });
  });

  test('records nothing for a redelivered request', async () => {
    const store = new MemoryNameStyleStore();

    const verdict = await applyNameStyle(
      { guildId: GUILD, executor: answering({ status: 'skipped_duplicate' }), logger: quiet },
      { nameStyles: store },
      GRADIENT_WIRE,
      'the-key',
    );

    expect(verdict).toBeNull();
    expect(store.writes).toEqual([]);
  });

  test('records nothing when a precheck other than permissions stopped it, so it is retried', async () => {
    const store = new MemoryNameStyleStore();
    const executor = answering({
      status: 'failed_precheck',
      failure: { code: 'guild_state_missing', humanReason: 'Proton has not seen this server yet.' },
    });

    const verdict = await applyNameStyle(
      { guildId: GUILD, executor, logger: quiet },
      { nameStyles: store },
      GRADIENT_WIRE,
      'the-key',
    );

    expect(verdict).toEqual({ outcome: 'unverified', reason: 'no_answer', recorded: false });
    expect(store.writes).toEqual([]);
  });

  test('counts a null request answered with null as confirmed', async () => {
    const judged = await verifyNameStyle({
      guildId: GUILD,
      botUserId: BOT,
      requested: null,
      result: { status: 'executed', body: { display_name_styles: null } },
      rest: undefined,
    });

    expect(judged).toEqual({ outcome: 'confirmed', reason: null });
  });
});

describe('reconnecting', () => {
  const key = (attemptedAt: number | null) =>
    `branding:${GUILD}:name-style:${wireStyleFingerprint(GRADIENT_WIRE)}:${attemptedAt ?? 'never'}`;

  test('confirms a member already showing the request, without a PATCH', async () => {
    const h = harness();

    await h.listen(guildAvailable({ ...BLANK, display_name_styles: wire(GRADIENT_WIRE) }), {
      displayNameStyle: GRADIENT,
    });

    expect(h.calls()).toEqual([]);
    expect(h.nameStyles.writes).toEqual(['observed']);
    expect(h.nameStyles.state).toMatchObject({
      requested: GRADIENT_WIRE,
      outcome: 'confirmed',
      confirmed: GRADIENT_WIRE,
      attemptedAt: null,
    });
  });

  test('writes and sends nothing when the confirmed style is still what Discord shows', async () => {
    const h = harness();
    h.nameStyles.state = held();

    await h.listen(guildAvailable({ ...BLANK, display_name_styles: wire(GRADIENT_WIRE) }), {
      displayNameStyle: GRADIENT,
    });

    expect(h.calls()).toEqual([]);
    expect(h.nameStyles.writes).toEqual([]);
  });

  test('forgets a confirmed style Discord no longer shows and applies it again', async () => {
    const h = harness();
    const before = held();
    h.nameStyles.state = before;

    await h.listen(guildAvailable({ ...BLANK, display_name_styles: null }), {
      displayNameStyle: GRADIENT,
    });

    expect(h.nameStyles.writes).toEqual(['forget', 'attempt:confirmed']);
    expect(h.styleBodies()).toEqual([wireBody(GRADIENT_WIRE)]);
    expect(h.keys()).toEqual([key(before.attemptedAt)]);
  });

  test('never sends a style Discord ignored or refused again on reconnect', async () => {
    for (const [outcome, reason] of [
      ['ignored', 'discord_ignored'],
      ['rejected', 'missing_change_nickname'],
      ['rejected', 'discord_refused'],
    ] as const) {
      for (const member of [BLANK, { ...BLANK, display_name_styles: null }]) {
        const h = harness();
        h.nameStyles.state = held({ outcome, reason, confirmed: null, confirmedAt: null });

        await h.listen(guildAvailable(member), { displayNameStyle: GRADIENT });

        expect({ outcome, member, calls: h.calls() }).toEqual({ outcome, member, calls: [] });
        expect(h.nameStyles.writes).toEqual([]);
      }
    }
  });

  test('does not retry an unverified attempt within fifteen minutes', async () => {
    const h = harness();
    h.nameStyles.state = held({
      outcome: 'unverified',
      reason: 'no_answer',
      attemptedAt: Date.now() - 60_000,
      confirmed: null,
      confirmedAt: null,
    });

    await h.listen(guildAvailable(BLANK), { displayNameStyle: GRADIENT });

    expect(h.calls()).toEqual([]);
  });

  test('retries an older unverified attempt after one read, keyed on that attempt', async () => {
    const attemptedAt = Date.now() - UNVERIFIED_RETRY_MS - 1_000;
    const h = harness();
    h.nameStyles.state = held({
      outcome: 'unverified',
      reason: 'no_answer',
      attemptedAt,
      confirmed: null,
      confirmedAt: null,
    });

    await h.listen(guildAvailable(BLANK), { displayNameStyle: GRADIENT });

    expect(h.calls().map((call) => [call.method, call.path])).toEqual([
      ['GET', MEMBER_PATH],
      ['PATCH', STYLE_PATH],
    ]);
    expect(h.keys()).toEqual([key(attemptedAt)]);
  });

  test('reads the member exactly once for a request never attempted, then applies it', async () => {
    const h = harness();

    await h.listen(guildAvailable(BLANK), { displayNameStyle: GRADIENT });

    expect(h.memberReads()).toHaveLength(1);
    expect(h.styleBodies()).toEqual([wireBody(GRADIENT_WIRE)]);
    expect(h.keys()).toEqual([key(null)]);
    expect(h.nameStyles.state).toMatchObject({ outcome: 'confirmed', confirmed: GRADIENT_WIRE });
  });

  test('confirms without a PATCH when that one read shows the request applied', async () => {
    const h = harness();
    h.rest.memberAnswer = { status: 200, body: { display_name_styles: wire(GRADIENT_WIRE) } };

    await h.listen(guildAvailable(BLANK), { displayNameStyle: GRADIENT });

    expect(h.memberReads()).toHaveLength(1);
    expect(h.stylePatches()).toEqual([]);
    expect(h.nameStyles.writes).toEqual(['observed']);
  });

  test('still reads and applies when the payload carries no member for the bot', async () => {
    const h = harness();

    await h.listen(guildAvailable(null), { displayNameStyle: GRADIENT });

    expect(h.memberReads()).toHaveLength(1);
    expect(h.stylePatches()).toHaveLength(1);
  });

  test('applies a changed request even after Discord ignored the previous one', async () => {
    const h = harness();
    h.nameStyles.state = held({
      requested: NEON_WIRE,
      outcome: 'ignored',
      reason: 'discord_ignored',
      confirmed: null,
      confirmedAt: null,
    });

    await h.listen(guildAvailable({ ...BLANK, display_name_styles: null }), {
      displayNameStyle: GRADIENT,
    });

    expect(h.styleBodies()).toEqual([wireBody(GRADIENT_WIRE)]);
  });

  test('reads and sends nothing for no style when nothing was ever recorded', async () => {
    const h = harness();

    await h.listen(guildAvailable(BLANK), { displayNameStyle: null });

    expect(h.calls()).toEqual([]);
    expect(h.nameStyles.writes).toEqual([]);
  });

  test('reads and sends nothing for a stored style Discord does not offer', async () => {
    const h = harness();

    await h.listen(guildAvailable(BLANK), { displayNameStyle: UNAVAILABLE });

    expect(h.calls()).toEqual([]);
    expect(h.nameStyles.writes).toEqual([]);
  });

  test('does nothing while Branding is off', async () => {
    const h = harness();

    await h.listen(guildAvailable(BLANK), { enabled: false, displayNameStyle: GRADIENT });

    expect(h.calls()).toEqual([]);
  });
});

describe('switching Branding off', () => {
  const OFF = configChanged({ enabledBefore: true, enabledAfter: false, changedKeys: ['enabled'] });

  test('resets the style after clearing the rest, keyed on the audit id', async () => {
    const h = harness();
    h.nameStyles.state = held();

    await h.listen(OFF, { ...FULL, enabled: false, displayNameStyle: GRADIENT });

    expect(h.bodies()).toEqual([
      { avatar: null, banner: null, bio: null },
      { nick: null },
      wireBody(null),
    ]);
    expect(h.keys()).toEqual([
      `branding:${GUILD}:audit-1:profile`,
      `branding:${GUILD}:audit-1:nickname`,
      `branding:${GUILD}:audit-1:name-style`,
    ]);
    expect(h.nameStyles.state).toMatchObject({ requested: null, confirmed: null });
  });

  test('sends no reset when Proton never styled this server', async () => {
    const h = harness();

    await h.listen(OFF, { ...FULL, enabled: false, displayNameStyle: GRADIENT });

    expect(h.bodies()).toEqual([{ avatar: null, banner: null, bio: null }, { nick: null }]);
  });

  test('leaves the style in place when the server asked to keep its branding', async () => {
    const h = harness();
    h.nameStyles.state = held();

    await h.listen(OFF, {
      ...FULL,
      enabled: false,
      restoreOnDisable: false,
      displayNameStyle: GRADIENT,
    });

    expect(h.calls()).toEqual([]);
  });
});

describe('the rest of Branding', () => {
  test('sends exactly what it sent before, whatever style is set or recorded', async () => {
    const base: Partial<BrandingConfig> = { ...FULL };

    const scenarios: Array<[ProtonEvent, Partial<BrandingConfig>]> = [
      [configChanged({ changedKeys: ['nickname', 'displayNameStyle'] }), {}],
      [configChanged({ enabledBefore: false, enabledAfter: true, changedKeys: ['enabled'] }), {}],
      [configChanged({ changedKeys: [] }), {}],
      [
        configChanged({ enabledBefore: true, enabledAfter: false, changedKeys: ['enabled'] }),
        { enabled: false },
      ],
      [guildAvailable({ nick: 'Something else', avatar: null, banner: 'b1' }), {}],
    ];

    for (const [event, overrides] of scenarios) {
      const plain = harness();
      const styled = harness();
      styled.nameStyles.state = held();

      await plain.listen(event, { ...base, ...overrides });
      await styled.listen(event, { ...base, ...overrides, displayNameStyle: NEON });

      expect(plain.otherCalls().length).toBeGreaterThan(0);
      expect(styled.otherCalls()).toEqual(plain.otherCalls());
      expect(styled.keys().filter((k) => !k.includes(':name-style'))).toEqual(plain.keys());
      expect(plain.stylePatches()).toEqual([]);
    }
  });
});

describe('/branding', () => {
  test('applies the style after the nickname and reports it', async () => {
    const h = harness();

    await h.command({ ...FULL, displayNameStyle: GRADIENT });

    const [base = ''] = h.keys();
    expect(h.keys()).toEqual([
      base,
      `${base}:profile`,
      `${base}:nickname`,
      `${base}:name-style`,
      `${base}:report`,
    ]);
    expect(h.bodies()).toEqual([PROFILE_BODY, { nick: 'Dreamliner' }, wireBody(GRADIENT_WIRE)]);
    expect(h.report()).toStartWith('Re-applied.');
    expect(h.report()).toContain('Display name style: Modern · Gradient');
  });

  test('names a missing Change Nickname', async () => {
    const h = harness({ botPermissions: WITHOUT_NICKNAME });

    await h.command({ ...FULL, displayNameStyle: GRADIENT });

    expect(h.report()).toContain(
      '- Display name style: Proton needs Change Nickname in this server.',
    );
  });

  test('says Discord did not accept a style it ignored or refused', async () => {
    for (const answer of [
      { status: 200, body: { display_name_styles: wire(NEON_WIRE) } },
      { status: 400, body: { message: 'Invalid Form Body', code: 50035 } },
    ]) {
      const h = harness();
      h.rest.styleAnswer = answer;

      await h.command({ ...FULL, displayNameStyle: GRADIENT });

      expect(h.report()).toContain('- Display name style: Discord didn’t accept this style.');
    }
  });

  test('says it could not confirm when Discord did not answer', async () => {
    const h = harness();
    h.rest.styleAnswer = new Error('connect ECONNREFUSED');

    await h.command({ ...FULL, displayNameStyle: GRADIENT });

    expect(h.report()).toContain('- Display name style: Couldn’t confirm with Discord.');
  });

  test('names a style Discord does not offer and sends nothing for it', async () => {
    const h = harness();

    await h.command({ ...FULL, displayNameStyle: UNAVAILABLE });

    expect(h.stylePatches()).toEqual([]);
    expect(h.report()).toContain(
      '- Display name style: Monkey Bars is not available for apps yet.',
    );
  });

  test('says so when it cannot apply a style at all', async () => {
    const h = harness({ unbind: ['nameStyles'] });

    await h.command({ ...FULL, displayNameStyle: GRADIENT });

    expect(h.report()).toContain('- Display name style: Proton cannot apply it right now.');
  });

  test('skips no style when nothing was ever recorded, and reports no style', async () => {
    const h = harness();

    await h.command({ ...FULL, displayNameStyle: null });

    const [base = ''] = h.keys();
    expect(h.keys()).toEqual([base, `${base}:profile`, `${base}:nickname`, `${base}:report`]);
    expect(h.stylePatches()).toEqual([]);
    expect(h.report()).toContain('Display name style: No style');
  });
});

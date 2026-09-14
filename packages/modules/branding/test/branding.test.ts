import { describe, expect, test } from 'bun:test';
import { NEVER_RECORDED_KINDS, Permissions } from '@proton/core';
import { brandingConfigSchema, liftStoredConfig } from '../src/config.ts';
import { imageMime } from '../src/image.ts';
import { brandingModule } from '../src/index.ts';
import { impersonationReason, normaliseName } from '../src/names.ts';
import { diverges, fingerprint, observedProfile } from '../src/profile.ts';
import {
  AVATAR_HASH,
  BANNER_HASH,
  BOT,
  configChanged,
  GUILD,
  guildAvailable,
  harness,
  PNG_DATA_URI,
  WITHOUT_NICKNAME,
} from './harness.ts';

const FULL = {
  nickname: 'Dreamliner',
  avatarHash: AVATAR_HASH,
  bannerHash: BANNER_HASH,
  bio: 'The friendly one.',
};

describe('applying branding on save', () => {
  test('sends the profile and the nickname as two PATCHes to the bot’s own member', async () => {
    const h = harness();

    await h.listen(configChanged(), FULL);

    const patches = h.patches();
    expect(patches).toHaveLength(2);
    expect(patches.every((call) => call.path === '/guilds/900000000000000001/members/@me')).toBe(
      true,
    );

    expect(h.bodies()[0]).toEqual({
      avatar: PNG_DATA_URI,
      banner: PNG_DATA_URI,
      bio: 'The friendly one.',
    });
    expect(h.bodies()[1]).toEqual({ nick: 'Dreamliner' });
  });

  test('reads each image from the asset store exactly once', async () => {
    const h = harness();

    await h.listen(configChanged(), FULL);

    expect(h.assets.requested).toEqual(['avatar', 'banner']);
  });

  test('clears a field the admin emptied rather than leaving what Discord holds', async () => {
    const h = harness();

    await h.listen(configChanged(), {
      nickname: undefined,
      avatarHash: undefined,
      bannerHash: undefined,
      bio: 'Only a bio.',
    });

    expect(h.bodies()[0]).toEqual({ avatar: null, banner: null, bio: 'Only a bio.' });
    expect(h.bodies()[1]).toEqual({ nick: null });
  });

  test('writes no case row, so an image never lands in the ledger', async () => {
    const h = harness();

    await h.listen(configChanged(), FULL);

    expect(h.recorder.recorded).toEqual([]);
    expect(NEVER_RECORDED_KINDS.has('set_bot_nickname')).toBe(true);
    expect(NEVER_RECORDED_KINDS.has('set_bot_profile')).toBe(true);
  });

  test('does nothing on a config change that belongs to another module', async () => {
    const h = harness();
    const event = configChanged();
    (event.payload as { moduleId: string }).moduleId = 'welcome';

    await h.listen(event, FULL);

    expect(h.patches()).toHaveLength(0);
  });
});

describe('when a permission is missing', () => {
  test('the nickname is refused by name and the profile still lands', async () => {
    const h = harness({ botPermissions: WITHOUT_NICKNAME });

    await h.listen(configChanged(), FULL);

    expect(h.bodies()).toEqual([
      { avatar: PNG_DATA_URI, banner: PNG_DATA_URI, bio: 'The friendly one.' },
    ]);

    const warning = h.logs.find((line) => line.message.includes('nickname'));
    expect(warning?.message).toContain('Change Nickname');
    expect(warning?.message).toContain('this server');
  });

  test('the module needs only Change Nickname to run', () => {
    expect(brandingModule.requiredPermissions).toEqual([Permissions.ChangeNickname]);
  });
});

describe('when an image cannot be read', () => {
  test('the rest of the profile is still applied and the failure names the field', async () => {
    const h = harness();
    h.assets.missing.add('banner');

    await h.listen(configChanged(), FULL);

    expect(h.bodies()[0]).toEqual({
      avatar: PNG_DATA_URI,
      banner: null,
      bio: 'The friendly one.',
    });

    const warning = h.logs.find((line) => line.message.includes('banner'));
    expect(warning?.message).toContain('The rest of the branding was applied.');
  });
});

describe('taking the branding back off', () => {
  test('clears all four fields when the module is switched off', async () => {
    const h = harness();

    await h.listen(configChanged({ enabledBefore: true, enabledAfter: false }), {
      ...FULL,
      enabled: false,
    });

    expect(h.bodies()).toEqual([{ avatar: null, banner: null, bio: null }, { nick: null }]);
  });

  test('leaves the branding in place when the server asked it to', async () => {
    const h = harness();

    await h.listen(configChanged({ enabledBefore: true, enabledAfter: false }), {
      ...FULL,
      enabled: false,
      restoreOnDisable: false,
    });

    expect(h.patches()).toHaveLength(0);
  });

  test('does nothing when a save arrives for a module that was already off', async () => {
    const h = harness();

    await h.listen(configChanged({ enabledBefore: false, enabledAfter: false }), {
      ...FULL,
      enabled: false,
    });

    expect(h.patches()).toHaveLength(0);
  });
});

describe('reconciling against what Discord already holds', () => {
  test('issues nothing when the bot already looks the way it should', async () => {
    const h = harness();

    await h.listen(guildAvailable({ nick: 'Dreamliner', avatar: 'a1', banner: 'b1' }), FULL);

    expect(h.patches()).toHaveLength(0);
  });

  test('re-applies everything after a kick and re-invite leaves the member blank', async () => {
    const h = harness();

    await h.listen(guildAvailable({ nick: null, avatar: null, banner: null }), FULL);

    expect(h.bodies()).toEqual([
      { avatar: PNG_DATA_URI, banner: PNG_DATA_URI, bio: 'The friendly one.' },
      { nick: 'Dreamliner' },
    ]);
  });

  test('pushes only the nickname when only the nickname has drifted', async () => {
    const h = harness();

    await h.listen(guildAvailable({ nick: 'Something else', avatar: 'a1', banner: 'b1' }), FULL);

    expect(h.bodies()).toEqual([{ nick: 'Dreamliner' }]);
  });

  test('pushes only the profile when an image has been cleared by hand', async () => {
    const h = harness();

    await h.listen(guildAvailable({ nick: 'Dreamliner', avatar: null, banner: 'b1' }), FULL);

    expect(h.bodies()).toEqual([
      { avatar: PNG_DATA_URI, banner: PNG_DATA_URI, bio: 'The friendly one.' },
    ]);
  });

  test('issues nothing when the module is off', async () => {
    const h = harness();

    await h.listen(guildAvailable({ nick: null, avatar: null, banner: null }), {
      ...FULL,
      enabled: false,
    });

    expect(h.patches()).toHaveLength(0);
  });

  test('issues nothing when the payload carries no member for the bot', async () => {
    const h = harness();

    await h.listen(guildAvailable(null), FULL);

    expect(h.patches()).toHaveLength(0);
  });
});

describe('reading the bot’s own member off GUILD_CREATE', () => {
  test('finds the bot and ignores every other member', () => {
    const observed = observedProfile(
      guildAvailable({ nick: 'Dreamliner', avatar: 'a1', banner: null }).payload,
      BOT,
    );

    expect(observed).toEqual({ nickname: 'Dreamliner', hasAvatar: true, hasBanner: false });
  });

  test('compares images on presence, because a hash never maps back to its source URL', () => {
    const desired = {
      nickname: 'Dreamliner',
      avatarHash: AVATAR_HASH,
      bannerHash: null,
      bio: 'anything',
    };

    expect(
      diverges(desired, { nickname: 'Dreamliner', hasAvatar: true, hasBanner: false }),
    ).toEqual({ nickname: false, profile: false });

    expect(diverges(desired, { nickname: 'Dreamliner', hasAvatar: true, hasBanner: true })).toEqual(
      { nickname: false, profile: true },
    );
  });
});

describe('names that claim to be somebody else', () => {
  test('refuses a nickname reading as Discord and still applies the rest', async () => {
    const h = harness();

    await h.listen(configChanged(), { ...FULL, nickname: 'Discord Support' });

    expect(h.bodies()).toEqual([
      { avatar: PNG_DATA_URI, banner: PNG_DATA_URI, bio: 'The friendly one.' },
    ]);
    expect(h.logs.some((line) => line.message.includes('developer policy'))).toBe(true);
  });

  test('sees through spacing, punctuation and lookalike letters', () => {
    // Built from code points, never pasted: a literal zero-width space is invisible in a diff, and
    // any tool that rewrote this file would drop it and leave a test that passes for no reason.
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    const wordJoiner = String.fromCodePoint(0x2060);
    const fullwidth = String.fromCodePoint(0xff24, 0xff49, 0xff53, 0xff43, 0xff4f, 0xff52, 0xff44);

    expect(normaliseName(`D${zeroWidthSpace}i_s.c${wordJoiner}o r d`)).toBe('discord');
    expect(normaliseName(fullwidth)).toBe('discord');

    expect(impersonationReason(fullwidth)).not.toBeNull();
    expect(impersonationReason('Moderator')).not.toBeNull();
  });

  test('leaves an ordinary name alone', () => {
    expect(impersonationReason('Dreamliner')).toBeNull();
    expect(impersonationReason('Kestrel')).toBeNull();
  });
});

describe('image data', () => {
  test('names the type from the bytes rather than trusting the URL', () => {
    expect(imageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(imageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(imageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
    expect(imageMime(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });
});

const BOLD_DREAMLINER =
  '\u{1D403}\u{1D42B}\u{1D41E}\u{1D41A}\u{1D426}\u{1D425}\u{1D422}\u{1D427}\u{1D41E}\u{1D42B}';

const STYLED_ROW = { enabled: true, ...FULL, typeface: 'bold' };

describe('a server still wearing a nickname in the retired look-alike letters', () => {
  test('reconcile puts the plain nickname back over the styled one Discord holds', async () => {
    const h = harness();

    await h.listen(
      guildAvailable({ nick: BOLD_DREAMLINER, avatar: 'a1', banner: 'b1' }),
      brandingConfigSchema.parse(STYLED_ROW),
    );

    expect(h.bodies()).toEqual([{ nick: 'Dreamliner' }]);
  });

  test('the next save sends the plain nickname', async () => {
    const h = harness();

    await h.listen(configChanged(), brandingConfigSchema.parse(liftStoredConfig(STYLED_ROW)));

    expect(h.bodies()).toEqual([
      { avatar: PNG_DATA_URI, banner: PNG_DATA_URI, bio: 'The friendly one.' },
      { nick: 'Dreamliner' },
    ]);
  });

  test('a save of only the display name style still reaches Discord with nothing', async () => {
    const h = harness();

    await h.listen(
      configChanged({ changedKeys: ['displayNameStyle'] }),
      brandingConfigSchema.parse(STYLED_ROW),
    );

    expect(h.calls()).toHaveLength(0);
  });

  test('/branding sends the plain nickname', async () => {
    const h = harness();

    await h.command(brandingConfigSchema.parse(STYLED_ROW));

    expect(h.bodies()).toEqual([
      { avatar: PNG_DATA_URI, banner: PNG_DATA_URI, bio: 'The friendly one.' },
      { nick: 'Dreamliner' },
    ]);
  });

  test('the manifest no longer lays out a field for it', () => {
    const fields = brandingModule.dashboard?.sections.flatMap((section) => section.fields) ?? [];

    expect(fields).toContain('nickname');
    expect(fields).not.toContain('typeface');
  });
});

describe('the manifest', () => {
  test('declares the display name style kind and lays out its section', () => {
    expect(brandingModule.actionKinds).toContain('set_bot_name_style');
    expect(brandingModule.dashboard?.sections.find((section) => section.id === 'style')).toEqual({
      id: 'style',
      title: 'Display name style',
      fields: ['displayNameStyle'],
    });
  });

  test('refuses a changed style Discord does not offer, and lets an unchanged one through', () => {
    const before = brandingConfigSchema.parse({
      displayNameStyle: { font: 'monkey-bars', effect: 'solid', colours: [0] },
    });

    expect(brandingModule.refineWrite?.(before, before)).toEqual([]);
    expect(brandingModule.refineWrite?.({ ...before, nickname: 'Kestrel' }, before)).toEqual([]);
    expect(brandingModule.refineWrite?.({ ...before, displayNameStyle: null }, before)).toEqual([]);

    const journal = brandingConfigSchema.parse({
      displayNameStyle: { font: 'journal', effect: 'solid', colours: [0] },
    });
    expect(brandingModule.refineWrite?.(journal, before)).toEqual([
      { path: 'displayNameStyle.font', message: 'Journal is not available for apps yet.' },
    ]);

    const short = brandingConfigSchema.parse({
      displayNameStyle: { font: 'tempo', effect: 'gradient', colours: [0] },
    });
    expect(brandingModule.refineWrite?.(short, before)).toEqual([
      { path: 'displayNameStyle.colours', message: 'Gradient takes two colours, not 1.' },
    ]);
  });
});

describe('idempotency keys', () => {
  test('a save keys every leg on its audit id', async () => {
    const h = harness();

    await h.listen(configChanged({ auditId: 'audit-7' }), FULL);

    expect(h.keys()).toEqual([
      `branding:${GUILD}:audit-7:profile`,
      `branding:${GUILD}:audit-7:nickname`,
    ]);
  });

  test('reconcile keys on what is wanted and what Discord holds', async () => {
    const h = harness();

    await h.listen(guildAvailable({ nick: 'Something else', avatar: 'a1', banner: 'b1' }), FULL);

    const wanted = fingerprint({
      nickname: 'Dreamliner',
      avatarHash: AVATAR_HASH,
      bannerHash: BANNER_HASH,
      bio: 'The friendly one.',
    });
    const held = fingerprint({
      nickname: 'Something else',
      avatarHash: 'set',
      bannerHash: 'set',
      bio: null,
    });

    expect(h.keys()).toEqual([`branding:${GUILD}:${wanted}:${held}:nickname`]);
  });

  test('/branding derives each step from the interaction key', async () => {
    const h = harness();

    await h.command(FULL);

    const [base = ''] = h.keys();
    expect(h.keys()).toEqual([base, `${base}:profile`, `${base}:nickname`, `${base}:report`]);
  });
});

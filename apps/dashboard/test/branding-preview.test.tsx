import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brandingConfigSchema } from '@proton/module-branding/config';
import { renderToStaticMarkup } from 'react-dom/server';
import { type ProtonAccount, protonAccountSchema } from '../src/lib/discord.ts';
import {
  type AccountRead,
  accountReadOf,
  BrandingPreview,
  dominantOf,
  previewNotesFor,
} from '../src/pages/branding/discord-preview.tsx';
import {
  DEFAULT_COLOUR_NOTE,
  NAME_STYLE_HELP,
  ROLE_COLOUR_NOTE,
} from '../src/pages/branding/name-style/shape.ts';

const CSS = readFileSync(
  join(import.meta.dir, '..', 'src', 'styles', 'modules', 'branding.css'),
  'utf8',
);

const ACCOUNT: ProtonAccount = protonAccountSchema.parse({
  username: 'proton',
  discriminator: '4821',
  globalName: null,
  nickname: 'Kept',
  avatarUrl: 'https://cdn.discordapp.com/avatars/222/userhash.png',
});

const READY: AccountRead = { status: 'ready', account: ACCOUNT };
const PENDING: AccountRead = { status: 'pending' };
const FAILED: AccountRead = { status: 'failed' };

const AVATAR_NOTE = 'With no avatar uploaded, Discord shows Proton’s own avatar.';

interface DrawnName {
  classes: string;
  style: string;
  text: string;
}

function readyWith(changes: Partial<ProtonAccount>): AccountRead {
  return { status: 'ready', account: { ...ACCOUNT, ...changes } };
}

function config(input: object) {
  return brandingConfigSchema.parse(input);
}

function render(input: object, read: AccountRead = FAILED): string {
  return renderToStaticMarkup(<BrandingPreview guildId="1" config={config(input)} read={read} />);
}

function drawnNames(markup: string): DrawnName[] {
  return [
    ...markup.matchAll(
      /<span class="branding-name ?([^"]*)"(?: style="([^"]*)")?>([^<]*)<\/span>/g,
    ),
  ].map((match) => ({ classes: match[1] ?? '', style: match[2] ?? '', text: match[3] ?? '' }));
}

function names(markup: string): string[] {
  return drawnNames(markup).map((name) => name.text);
}

function thrice(text: string): string[] {
  return [text, text, text];
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('the Branding page’s Discord preview', () => {
  test('shows the nickname in Discord’s default name colour on the profile, a sample message and the member list', () => {
    const markup = render({ nickname: 'Sparky' }, READY);

    expect(drawnNames(markup)).toEqual([
      { classes: '', style: '', text: 'Sparky' },
      { classes: 'dc-author', style: '', text: 'Sparky' },
      { classes: 'branding-member-name', style: '', text: 'Sparky' },
    ]);
    expect(markup).toContain(
      '<p class="branding-popout-name"><span class="branding-name">Sparky</span></p>',
    );
    expect(occurrences(markup, '<span class="dc-bot-tag">App</span>')).toBe(3);
    expect(markup).toContain('>Sample message<');
    expect(markup).toContain('>Member list<');
  });

  test('no role is listed and nothing is painted in a role colour', () => {
    const markup = render({ nickname: 'Sparky', bio: 'Keeps the peace' }, READY);

    expect(markup).not.toContain('>Roles<');
    expect(markup).not.toContain('role-dot');
    expect(markup).not.toContain('data-paint');
    expect(markup).not.toContain('--role-');
    expect(markup).not.toMatch(/style="([^"]*;)?color:/);
  });

  test('a stored row still carrying the retired colour settings draws exactly as one without them', () => {
    const retired = {
      nickname: 'Sparky',
      nameEffect: 'gradient',
      primaryColor: 0x112233,
      secondaryColor: 0x445566,
    };

    expect(render(retired, READY)).toBe(render({ nickname: 'Sparky' }, READY));
    expect(render(retired, READY)).not.toContain('#112233');
  });

  test('the Branding styles keep no role colour paint, dot or sheen', () => {
    expect(CSS).not.toContain('--role-');
    expect(CSS).not.toContain('data-paint');
    expect(CSS).not.toContain('branding-role');
    expect(CSS).not.toContain('branding-popout-role');
    expect(CSS).not.toMatch(/holographic/i);
  });

  test('a refused nickname shows the one Discord keeps, because Proton never sends it', () => {
    const refused = { nickname: 'Discord Support' };
    const kept = render(refused, READY);

    expect(names(kept)).toEqual(thrice('Kept'));
    expect(kept).not.toContain('Discord Support');

    expect(
      names(render(refused, readyWith({ nickname: null, globalName: 'Proton Beta' }))),
    ).toEqual(thrice('Proton Beta'));
    expect(names(render(refused, readyWith({ nickname: null })))).toEqual(thrice('proton'));

    for (const read of [PENDING, FAILED]) {
      const markup = render(refused, read);
      expect(names(markup)).toEqual(thrice('Proton'));
      expect(markup).not.toContain('Discord Support');
    }
  });

  test('an empty nickname shows Proton’s own name, not the nickname a save would clear', () => {
    const own = render({}, READY);
    expect(names(own)).toEqual(thrice('proton'));
    expect(own).not.toContain('Kept');

    expect(names(render({}, readyWith({ globalName: 'Proton Beta' })))).toEqual(
      thrice('Proton Beta'),
    );
    expect(names(render({}, FAILED))).toEqual(thrice('Proton'));
  });

  test('with no avatar uploaded every part shows Proton’s own, a spinner while it is read, a blank if it cannot be', () => {
    const ready = render({}, READY);
    expect(occurrences(ready, `src="${ACCOUNT.avatarUrl}"`)).toBe(3);
    expect(ready).not.toContain('branding-avatar-pending');

    const pending = render({}, PENDING);
    expect(pending).not.toContain('<img');
    expect(occurrences(pending, 'branding-avatar-pending')).toBe(3);
    expect(occurrences(pending, 'Loading Proton’s avatar')).toBe(3);

    const failed = render({}, FAILED);
    expect(failed).not.toContain('<img');
    expect(failed).not.toContain('branding-avatar-pending');
    expect(failed).toContain('<span class="dc-avatar"></span>');

    const uploaded = render({ avatarHash: 'a1' }, READY);
    expect(occurrences(uploaded, 'src="/api/guilds/1/branding/avatar?v=a1"')).toBe(3);
    expect(uploaded).not.toContain(ACCOUNT.avatarUrl);
  });

  test('the profile’s username line is Proton’s own username, with its tag when it has one', () => {
    const line = (username: string) =>
      `<p class="branding-popout-username"><span>${username}</span><span class="dc-bot-tag">App</span></p>`;

    expect(render({}, READY)).toContain(line('proton#4821'));
    expect(render({}, readyWith({ discriminator: null }))).toContain(line('proton'));
    expect(render({}, FAILED)).toContain(line('Proton'));
  });

  test('shows the bio as Discord markdown under About me, and the uploaded avatar and banner', () => {
    const markup = render({ bio: '**Keeps** the peace', avatarHash: 'a1', bannerHash: 'b2' });

    expect(markup).toContain('>About me<');
    expect(markup).toContain('<strong>Keeps</strong> the peace');
    expect(occurrences(markup, 'src="/api/guilds/1/branding/avatar?v=a1"')).toBe(3);
    expect(occurrences(markup, 'src="/api/guilds/1/branding/banner?v=b2"')).toBe(1);
    expect(occurrences(markup, '<img')).toBe(occurrences(markup, 'alt=""'));

    const bare = render({});
    expect(bare).not.toContain('>About me<');
    expect(bare).not.toContain('<img');
    expect(bare).toContain('<div class="branding-popout-banner"></div>');
  });

  test('a display name style draws on the profile in its colours, and elsewhere as its font in Discord’s default name colour', () => {
    const markup = render({
      nickname: 'Sparky',
      displayNameStyle: { font: 'modern', effect: 'neon', colours: [0xff0000] },
    });
    const profile = markup.slice(markup.indexOf('>Profile<'), markup.indexOf('>Sample message<'));
    const elsewhere = markup.slice(markup.indexOf('>Sample message<'));

    expect(profile).toContain('<span class="name-specimen" data-effect="neon" data-font="modern"');
    expect(profile).toContain('--ns-1:#ff0000');
    expect(profile).toContain('>Sparky</span>');
    expect(names(profile)).toEqual([]);

    const drawn = drawnNames(elsewhere);
    expect(drawn.map((name) => `${name.classes}|${name.text}`)).toEqual([
      'dc-author|Sparky',
      'branding-member-name|Sparky',
    ]);
    for (const name of drawn) {
      expect(name.style).toStartWith('font-family:&quot;proton-name-modern&quot;');
      expect(name.style).toContain('font-synthesis:none');
      expect(name.style).not.toMatch(/(^|;)color:|--role-/);
    }
    expect(elsewhere).not.toContain('name-specimen');
    expect(elsewhere).not.toContain('#ff0000');
  });

  test('with no display name style nothing is drawn in a style font', () => {
    const markup = render({ nickname: 'Sparky' }, READY);

    expect(markup).not.toContain('name-specimen');
    expect(markup).not.toContain('proton-name-');
    expect(markup).not.toContain('Loading the font');
  });

  test('the preview stands still when motion is reduced', () => {
    expect(render({})).toContain('<div class="branding-preview" data-motion="still">');
  });
});

describe('the notes under the preview', () => {
  test('the avatar note appears only when Proton’s own avatar could not be read', () => {
    const blank = config({});

    expect(previewNotesFor(blank, FAILED, true)).toContain(AVATAR_NOTE);
    expect(previewNotesFor(blank, READY, true)).not.toContain(AVATAR_NOTE);
    expect(previewNotesFor(blank, PENDING, true)).not.toContain(AVATAR_NOTE);
    expect(previewNotesFor(config({ avatarHash: 'a1' }), FAILED, true)).not.toContain(AVATAR_NOTE);
  });

  test('they say when Branding is off and when a refused nickname leaves Discord’s one in place', () => {
    const blank = config({});
    const off =
      'Branding is switched off, so none of this reaches Discord until it is switched on.';
    const kept = 'Proton will not send this nickname, so Discord keeps the one it has now.';

    expect(previewNotesFor(blank, READY, false)).toContain(off);
    expect(previewNotesFor(blank, READY, true)).not.toContain(off);
    expect(previewNotesFor(config({ nickname: 'Discord Support' }), READY, true)).toContain(kept);
    expect(previewNotesFor(config({ nickname: 'Sparky' }), READY, true)).not.toContain(kept);
  });

  test('a display name style adds the short help and names a substituted font, and no style adds nothing', () => {
    const styled = previewNotesFor(
      config({ displayNameStyle: { font: 'gg-sans', effect: 'solid', colours: [0x2a8af8] } }),
      READY,
      true,
    );

    for (const line of NAME_STYLE_HELP) expect(styled).toContain(line);
    expect(styled.some((note) => note.includes('This preview uses Inter instead.'))).toBe(true);

    const plain = previewNotesFor(config({}), READY, true);
    for (const line of NAME_STYLE_HELP) expect(plain).not.toContain(line);
    expect(plain.some((note) => note.includes('Inter'))).toBe(false);
  });

  test('with or without a style, they say once where the name colour comes from in servers, and never that Proton sets one', () => {
    const plain = previewNotesFor(config({}), READY, true);
    const styled = previewNotesFor(
      config({ displayNameStyle: { font: 'modern', effect: 'solid', colours: [0xffffff] } }),
      READY,
      true,
    );

    expect(ROLE_COLOUR_NOTE).toBe(
      'In servers, the colour of Proton’s highest coloured role takes priority.',
    );
    expect(DEFAULT_COLOUR_NOTE).toBe(
      'In servers, Proton’s name shows in the colour of its highest coloured role, or Discord’s default.',
    );

    expect(occurrences(plain.join('\n'), DEFAULT_COLOUR_NOTE)).toBe(1);
    expect(occurrences(plain.join('\n'), ROLE_COLOUR_NOTE)).toBe(0);
    expect(occurrences(styled.join('\n'), ROLE_COLOUR_NOTE)).toBe(1);
    expect(occurrences(styled.join('\n'), DEFAULT_COLOUR_NOTE)).toBe(0);

    for (const notes of [plain, styled]) {
      expect(notes.join('\n')).not.toMatch(
        /role (Proton|it) (creates|made|makes)|name colour|Enhanced Role/i,
      );
    }
  });
});

describe('the account read behind the preview', () => {
  test('an answer outlives a later failed refetch, and no answer is pending until it fails', () => {
    expect(accountReadOf({ data: ACCOUNT, isError: true })).toEqual(READY);
    expect(accountReadOf({ data: undefined, isError: true })).toEqual(FAILED);
    expect(accountReadOf({ data: undefined, isError: false })).toEqual(PENDING);
  });

  test('the banner colour averages the most common colour, skipping transparent pixels', () => {
    const pixels = Uint8ClampedArray.from([
      255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 127, 16, 32, 48, 255, 30, 46, 62, 128, 200, 200, 200,
      255,
    ]);

    expect(dominantOf(pixels)).toBe('rgb(23 39 55)');
    expect(dominantOf(Uint8ClampedArray.from([9, 9, 9, 0, 9, 9, 9, 127]))).toBeNull();
    expect(dominantOf(new Uint8ClampedArray(0))).toBeNull();
  });
});

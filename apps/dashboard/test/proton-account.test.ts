import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { fetchProtonAccount } from '../src/lib/discord.ts';

const GUILD = '111111111111111111';
const PROTON = '222222222222222222';

function answer(status: number, body: unknown): string[] {
  const asked: string[] = [];

  const respond = async (input: RequestInfo | URL): Promise<Response> => {
    asked.push(String(input));
    return new Response(JSON.stringify(body), { status });
  };

  spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(respond, { preconnect: globalThis.fetch.preconnect }),
  );

  return asked;
}

describe('reading Proton’s own account for the Branding preview', () => {
  afterEach(() => {
    mock.restore();
  });

  test('asks the rest-proxy for its own member and keeps the global avatar, not the server one', async () => {
    const asked = answer(200, {
      nick: 'Sparky',
      avatar: 'guildhash',
      user: {
        id: PROTON,
        username: 'proton',
        discriminator: '4821',
        global_name: null,
        avatar: 'userhash',
      },
    });

    expect(await fetchProtonAccount('http://proxy/', GUILD, PROTON)).toEqual({
      username: 'proton',
      discriminator: '4821',
      globalName: null,
      nickname: 'Sparky',
      avatarUrl: `https://cdn.discordapp.com/avatars/${PROTON}/userhash.png`,
    });
    expect(asked).toEqual([`http://proxy/api/guilds/${GUILD}/members/${PROTON}`]);
  });

  test('with no avatar of its own a tagged account gets the default its tag picks', async () => {
    answer(200, { user: { id: PROTON, username: 'proton', discriminator: '4821', avatar: null } });

    const account = await fetchProtonAccount('http://proxy', GUILD, PROTON);

    expect(account.nickname).toBeNull();
    expect(account.avatarUrl).toBe('https://cdn.discordapp.com/embed/avatars/1.png');
  });

  test('a migrated account has no tag and gets the default its id picks', async () => {
    answer(200, {
      nick: null,
      user: { id: PROTON, username: 'proton', discriminator: '0', global_name: 'Proton' },
    });

    const account = await fetchProtonAccount('http://proxy', GUILD, PROTON);

    expect(account.discriminator).toBeNull();
    expect(account.globalName).toBe('Proton');
    expect(account.avatarUrl).toBe(
      `https://cdn.discordapp.com/embed/avatars/${(BigInt(PROTON) >> 22n) % 6n}.png`,
    );
  });

  test('a refusal is raised with Discord’s status rather than answered with a guess', async () => {
    answer(404, { message: 'Unknown Member', code: 10007 });

    await expect(fetchProtonAccount('http://proxy', GUILD, PROTON)).rejects.toThrow(
      'Discord answered 404',
    );
  });

  test('an answer with no user is raised rather than answered with a guess', async () => {
    answer(200, { nick: 'Sparky' });

    await expect(fetchProtonAccount('http://proxy', GUILD, PROTON)).rejects.toThrow(
      'answered with no user',
    );
  });
});

describe('the display name style Discord shows on Proton’s member', () => {
  afterEach(() => {
    mock.restore();
  });

  const USER = { id: PROTON, username: 'proton', discriminator: '0' };

  test('no top-level key claims nothing, even when the user object carries one', async () => {
    answer(200, {
      nick: 'Sparky',
      user: { ...USER, display_name_styles: { font_id: 6, effect_id: 2, colors: [1] } },
    });

    const account = await fetchProtonAccount('http://proxy', GUILD, PROTON);

    expect(account.displayNameStyle).toBeUndefined();
    expect(account.nickname).toBe('Sparky');
  });

  test('null is Discord saying Proton wears no style here', async () => {
    answer(200, { user: USER, display_name_styles: null });

    expect((await fetchProtonAccount('http://proxy', GUILD, PROTON)).displayNameStyle).toBeNull();
  });

  test('a style is read with its colours in Discord’s order', async () => {
    answer(200, {
      user: USER,
      display_name_styles: { font_id: 6, effect_id: 2, colors: [0x5865f2, 0xeb459e] },
    });

    expect((await fetchProtonAccount('http://proxy', GUILD, PROTON)).displayNameStyle).toEqual({
      fontId: 6,
      effectId: 2,
      colours: [0x5865f2, 0xeb459e],
    });
  });

  test('an empty colour list, which Discord stores as sent, is kept empty', async () => {
    answer(200, { user: USER, display_name_styles: { font_id: 11, effect_id: 1, colors: [] } });

    expect((await fetchProtonAccount('http://proxy', GUILD, PROTON)).displayNameStyle).toEqual({
      fontId: 11,
      effectId: 1,
      colours: [],
    });
  });

  test('a style in a shape Proton does not know still loads the account, claiming nothing', async () => {
    for (const styles of [
      { font_id: '6', effect_id: 2, colors: [0] },
      { font_id: 6, effect_id: 2, colors: ['#5865F2'] },
      { font_id: 6 },
      'modern',
    ]) {
      answer(200, { nick: 'Sparky', user: USER, display_name_styles: styles });

      const account = await fetchProtonAccount('http://proxy', GUILD, PROTON);

      expect(account.nickname).toBe('Sparky');
      expect(account.displayNameStyle).toBeUndefined();

      mock.restore();
    }
  });
});

import { describe, expect, test } from 'bun:test';
import type {
  RestProxyClient,
  RestRequestOptions,
  RestResponse,
} from '../../src/actions/rest-client.ts';
import {
  avatarUrl,
  toUserProfile,
  type UserProfile,
  type UserProfileCache,
} from '../../src/users/profile-cache.ts';
import { createUserResolver, isPseudoActor } from '../../src/users/resolver.ts';

const USER = '200000000000000009';

class MemoryCache implements UserProfileCache {
  readonly stored = new Map<string, UserProfile>();

  async get(userId: string): Promise<UserProfile | null> {
    return this.stored.get(userId) ?? null;
  }

  async put(profile: UserProfile): Promise<void> {
    this.stored.set(profile.id, profile);
  }
}

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  response: RestResponse = {
    status: 200,
    body: { id: USER, username: 'admin', global_name: 'Admin', avatar: 'abc123' },
  };

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return this.response;
  }
}

describe('avatarUrl', () => {
  test('builds a CDN url from the hash', () => {
    expect(avatarUrl(USER, 'abc123')).toBe(
      'https://cdn.discordapp.com/avatars/200000000000000009/abc123.png?size=64',
    );
  });

  test('an animated hash asks for a gif', () => {
    expect(avatarUrl(USER, 'a_abc123')).toContain('.gif');
  });

  test('no hash falls back to the default avatar for that id', () => {
    expect(avatarUrl(USER, null)).toBe('https://cdn.discordapp.com/embed/avatars/0.png');
  });

  test('an unparsable id yields no url rather than throwing', () => {
    expect(avatarUrl('proton:antinuke', null)).toBeNull();
  });
});

describe('toUserProfile', () => {
  test('reads the fields a footer needs', () => {
    expect(
      toUserProfile({ id: USER, username: 'admin', global_name: 'Admin', avatar: null }),
    ).toEqual({
      id: USER,
      username: 'admin',
      globalName: 'Admin',
      avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
      avatarHash: null,
    });
  });

  test('rejects a payload with no username', () => {
    expect(toUserProfile({ id: USER })).toBeNull();
    expect(toUserProfile(null)).toBeNull();
  });
});

describe('createUserResolver', () => {
  test('a miss reaches Discord through the rest proxy and caches the result', async () => {
    const cache = new MemoryCache();
    const rest = new FakeRest();
    const resolver = createUserResolver({ cache, rest });

    const profile = await resolver.resolve(USER);

    expect(profile?.username).toBe('admin');
    expect(rest.calls[0]).toEqual({ method: 'GET', path: `/users/${USER}` });
    expect(cache.stored.get(USER)?.username).toBe('admin');
  });

  test('a hit never reaches Discord', async () => {
    const cache = new MemoryCache();
    await cache.put({ id: USER, username: 'cached', globalName: null, avatarUrl: null, avatarHash: null });
    const rest = new FakeRest();

    const profile = await createUserResolver({ cache, rest }).resolve(USER);

    expect(profile?.username).toBe('cached');
    expect(rest.calls).toEqual([]);
  });

  test('a burst about one moderator makes one request, not many', async () => {
    const cache = new MemoryCache();
    const rest = new FakeRest();
    const resolver = createUserResolver({ cache, rest });

    await Promise.all(Array.from({ length: 5 }, () => resolver.resolve(USER)));

    expect(rest.calls).toHaveLength(1);
  });

  test('a module actor never hits Discord and still renders a name', async () => {
    const rest = new FakeRest();
    const resolver = createUserResolver({
      cache: new MemoryCache(),
      rest,
      pseudoActors: { 'proton:antinuke': { username: 'Proton Antinuke', avatarUrl: null } },
    });

    expect(await resolver.resolve('proton:antinuke')).toEqual({
      id: 'proton:antinuke',
      username: 'Proton Antinuke',
      globalName: null,
      avatarUrl: null,
      avatarHash: null,
    });
    expect(await resolver.resolve('proton:joinroles')).toMatchObject({ username: 'joinroles' });
    expect(rest.calls).toEqual([]);
  });

  test('an unavailable user degrades to null and reports the status', async () => {
    const rest = new FakeRest();
    rest.response = { status: 404, body: null };
    const seen: Array<{ userId: string; status: number }> = [];

    const profile = await createUserResolver({
      cache: new MemoryCache(),
      rest,
      onUnavailable: (userId, status) => seen.push({ userId, status }),
    }).resolve(USER);

    expect(profile).toBeNull();
    expect(seen).toEqual([{ userId: USER, status: 404 }]);
  });

  test('a failed lookup is not cached, so the next log can try again', async () => {
    const cache = new MemoryCache();
    const rest = new FakeRest();
    rest.response = { status: 500, body: null };
    const resolver = createUserResolver({ cache, rest });

    await resolver.resolve(USER);
    rest.response = {
      status: 200,
      body: { id: USER, username: 'admin', global_name: null, avatar: null },
    };

    expect((await resolver.resolve(USER))?.username).toBe('admin');
    expect(rest.calls).toHaveLength(2);
  });

  test('isPseudoActor only matches Proton actor ids', () => {
    expect(isPseudoActor('proton:serverlog')).toBe(true);
    expect(isPseudoActor(USER)).toBe(false);
  });
});

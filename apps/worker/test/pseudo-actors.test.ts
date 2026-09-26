import { describe, expect, test } from 'bun:test';
import { createUserResolver, type RestProxyClient, type UserProfileCache } from '@proton/core';
import { ACHIEVEMENTS_ACTOR } from '@proton/module-achievements';
import { APPLICATIONS_ACTOR } from '@proton/module-applications';
import { PUNISH_ACTOR, REPORTS_ACTOR } from '@proton/module-moderation';
import { SERVERLOG_ACTOR } from '@proton/module-serverlog';
import { PSEUDO_ACTORS } from '../src/pseudo-actors.ts';

function resolver() {
  const reads: string[] = [];
  const rest: RestProxyClient = {
    async request(options) {
      reads.push(options.path);
      return { status: 404, body: { code: 10013 } };
    },
  };
  const cache: UserProfileCache = {
    get: async () => null,
    put: async () => undefined,
  } as unknown as UserProfileCache;

  return { users: createUserResolver({ cache, rest, pseudoActors: PSEUDO_ACTORS }), reads };
}

describe('the worker’s own actors', () => {
  test.each([
    ['Moderation', PUNISH_ACTOR],
    ['User Reports', REPORTS_ACTOR],
    ['Server log', SERVERLOG_ACTOR],
    ['Applications', APPLICATIONS_ACTOR],
  ])('%s resolves to Proton without asking Discord', async (_label, actorId) => {
    const { users, reads } = resolver();

    expect(await users.resolve(actorId)).toEqual({
      id: actorId,
      username: 'Proton',
      globalName: null,
      avatarUrl: null,
      avatarHash: null,
    });
    expect(reads).toEqual([]);
  });

  test('Achievements resolves to its own name without asking Discord', async () => {
    const { users, reads } = resolver();

    expect(await users.resolve(ACHIEVEMENTS_ACTOR)).toEqual({
      id: 'proton:achievements',
      username: 'Achievements',
      globalName: null,
      avatarUrl: null,
      avatarHash: null,
    });
    expect(reads).toEqual([]);
  });

  test('the actor ids are the ones moderation acts under', () => {
    expect(PUNISH_ACTOR).toBe('proton:moderation');
    expect(REPORTS_ACTOR).toBe('proton:reports');
  });

  test('index.ts hands the resolver the table', async () => {
    const source = await Bun.file(`${import.meta.dir}/../src/index.ts`).text();

    expect(source).toContain('pseudoActors: PSEUDO_ACTORS');
  });
});

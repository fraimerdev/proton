import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveFailure } from '../src/lib/errors.ts';

const SERVER = readFileSync(join(import.meta.dir, '..', 'src', 'server', 'modules.ts'), 'utf8');

mock.module('../src/server/modules.ts', () =>
  Object.fromEntries(
    [...SERVER.matchAll(/^export (?:const|(?:async )?function) (\w+)/gm)].map(([, name]) => [
      name,
      async () => null,
    ]),
  ),
);

const { unfixedIssues } = await import('../src/components/module/form.ts');

const ATTEMPT = 'Couldn’t save your changes';

const DANGLING =
  'Those Achievements settings were not saved: achievements.1.requirements.0.achievementId That ' +
  'achievement doesn’t exist any more. Pick another one.';

describe('a write the api refused by naming its fields', () => {
  test('sends the admin to the marked settings rather than shrugging', () => {
    const banner = saveFailure(new Error(DANGLING), ATTEMPT);

    expect(banner).toContain('Fix the marked settings');
    expect(banner).not.toContain('Something went wrong');
  });

  test('is read as a refusal even when a field’s own wording looks like another failure', () => {
    const wording =
      'Those Tickets settings were not saved: types.0.name Discord refused that emoji';

    expect(saveFailure(new Error(wording), ATTEMPT)).toContain('Fix the marked settings');
  });

  test('every other failure still says what it knows', () => {
    expect(saveFailure(new Error('boom'), ATTEMPT)).toContain('Something went wrong');
    expect(saveFailure(new Error('fetch failed'), ATTEMPT)).toContain('didn’t respond');
    expect(
      saveFailure(
        new Error("Proton's API did not answer (HTTP 502). Nothing was changed."),
        ATTEMPT,
      ),
    ).toContain('didn’t respond');
    expect(saveFailure(new Error('Discord refused the request'), ATTEMPT)).toContain(
      'Discord refused',
    );
  });
});

function config(firstName: string, prerequisite: string): Record<string, unknown> {
  return {
    achievements: [
      { name: firstName, requirements: [] },
      { name: 'All-Rounder', requirements: [{ achievementId: prerequisite }] },
    ],
  };
}

function refused(): Map<string, string> {
  return new Map([
    ['achievements.0.name', 'Too short'],
    ['achievements.1.requirements.0.achievementId', 'That achievement doesn’t exist any more.'],
  ]);
}

describe('server issues a whole-config edit fixes', () => {
  test('an edit that changes none of their paths keeps them, and the map itself', () => {
    const issues = refused();

    expect(unfixedIssues(issues, config('Chatterbox', 'gone'), config('Chatterbox', 'gone'))).toBe(
      issues,
    );
    expect(
      unfixedIssues(new Map(), config('Chatterbox', 'gone'), config('Rambler', 'gone')).size,
    ).toBe(0);
  });

  test('a corrected field stops showing its stale red error', () => {
    const kept = unfixedIssues(
      refused(),
      config('Chatterbox', 'gone'),
      config('Chatterbox', 'rising-star'),
    );

    expect([...kept.keys()]).toEqual(['achievements.0.name']);
  });

  // Errors are keyed by array index, so a delete above moves them onto an innocent achievement.
  test('deleting a row above drops the issues its index carried', () => {
    const kept = unfixedIssues(refused(), config('Chatterbox', 'gone'), {
      achievements: [{ name: 'All-Rounder', requirements: [{ achievementId: 'gone' }] }],
    });

    expect(kept.size).toBe(0);
  });
});

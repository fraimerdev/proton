import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MESSAGE_LOG_RETENTION_DAYS } from '@proton/module-logging/config';
import { renderToStaticMarkup } from 'react-dom/server';
import { Terms } from '../src/components/legal/terms.tsx';
import { FAQ, featured, QuestionList } from '../src/components/site/faq.tsx';

const terms = renderToStaticMarkup(<Terms />);

describe('the terms say what the product actually does', () => {
  // PRODUCT.md keeps a list of things that are absent and not to be invented. A company name, an
  // address and a jurisdiction are on it, so the document defers to the operator for all three.
  test('names the operator as the party you are agreeing with, and invents nobody', () => {
    expect(terms).toContain('The operator');
    expect(terms).toContain('the operator’s own jurisdiction');
    expect(terms).toContain('alongside their contact details');
  });

  test('points at Discord’s own terms rather than restating them', () => {
    expect(terms).toContain('https://discord.com/terms');
    expect(terms).toContain('https://discord.com/guidelines');
  });

  test('says who may add the bot and configure it', () => {
    expect(terms).toContain('Manage Server');
  });

  test('puts the message-logging duty on the server admin who switched it on', () => {
    expect(terms).toContain('Tell your members what you switched on');
    expect(terms).toContain('controller');
  });

  // PLAN.md I12 was removed: Proton performs every action for real in every environment. Terms
  // that implied a safe mode would be describing a product that does not exist.
  test('is honest that there is no rehearsal mode, and names the one exception', () => {
    expect(terms).toContain('no rehearsal mode');
    expect(terms).toContain('/backup restore');
  });

  test('claims no uptime it cannot keep', () => {
    expect(terms).toContain('no uptime guarantee');
    expect(terms).toContain('as is');
  });

  test('states the retention window the logging module enforces, from the constant', () => {
    expect(terms).toContain(`${MESSAGE_LOG_RETENTION_DAYS} days`);
  });

  test('invents no price and no plan Proton does not have', () => {
    expect(terms).toContain('No prices are published on this site');
    expect(terms).not.toMatch(/\$\d|£\d|€\d/);
  });

  test('disclaims the Discord association every third-party bot has to', () => {
    expect(terms).toContain('not affiliated with');
  });
});

describe('the questions page', () => {
  const html = renderToStaticMarkup(<QuestionList questions={FAQ.flatMap((g) => g.questions)} />);

  test('every question has a unique id, because the footer links to them', () => {
    const ids = FAQ.flatMap((group) => group.questions.map((question) => question.id));

    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every group has a unique id, for the same reason', () => {
    const ids = FAQ.map((group) => group.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  test('carries the two anchors the footer points at', () => {
    const groups = new Set(FAQ.map((group) => group.id));
    const questions = new Set(FAQ.flatMap((g) => g.questions.map((q) => q.id)));

    expect(groups.has('data')).toBe(true);
    expect(questions.has('delete')).toBe(true);
  });

  test('renders as details elements, so it works before the JavaScript arrives', () => {
    expect(html).toContain('<details');
    expect(html.match(/<details/g)?.length).toBe(
      FAQ.reduce((total, group) => total + group.questions.length, 0),
    );
  });

  test('the landing page’s five featured questions all resolve', () => {
    expect(featured().length).toBe(5);
  });

  test('answers the message question with the reading-is-not-storing distinction', () => {
    expect(html).toContain('Reading is not storing');
    expect(html).toContain(`${MESSAGE_LOG_RETENTION_DAYS} days`);
  });

  test('names the three OAuth scopes rather than describing them vaguely', () => {
    for (const scope of ['identify', 'guilds', 'guilds.members.read']) {
      expect(html).toContain(scope);
    }
  });

  test('does not promise unqualified deletion of moderation cases', () => {
    expect(html).toContain('may be retained against a deletion request');
  });

  test('keeps the house voice: no exclamation marks anywhere in the answers', () => {
    expect(html.replace(/&[a-z]+;/g, '')).not.toContain('!');
  });
});

describe('the public pages are reachable from the chrome', () => {
  const chrome = readFileSync(
    join(import.meta.dir, '..', 'src', 'components', 'site', 'chrome.tsx'),
    'utf8',
  );

  test.each(['/commands', '/faq', '/privacy', '/terms', '/dashboard', '/invite'])(
    'the footer or header links to %s',
    (route) => {
      expect(`${route}: ${chrome.includes(`"${route}"`)}`).toBe(`${route}: true`);
    },
  );
});

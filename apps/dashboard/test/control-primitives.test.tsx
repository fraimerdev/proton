import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PatternList, patternSyntaxFor, regexFault } from '../src/components/form/pattern-list.tsx';
import { roleOptions } from '../src/components/form/picker.tsx';
import { UserChip } from '../src/components/shell/user-chip.tsx';
import { DataTable, dataColumnHelper } from '../src/components/table/data-table.tsx';
import { fetchGuildRoles } from '../src/lib/discord.ts';

function render(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

const PROXY = 'http://rest-proxy.test';
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('which string lists are patterns rather than chips', () => {
  // The comma commit is the bug: `a{2,5}` became `a{2` and `5}`, neither of them a pattern.
  test('automod’s three typed lists are the ones that leave the chip input', () => {
    expect(patternSyntaxFor('regexPatterns')).toBe('regex');
    expect(patternSyntaxFor('blockedWords')).toBe('phrase');
    expect(patternSyntaxFor('allowedWords')).toBe('phrase');
  });

  test('a domain list keeps the chips it had, so nothing else changes shape', () => {
    expect(patternSyntaxFor('linkBlockDomains')).toBeNull();
    expect(patternSyntaxFor('attachmentExtensions')).toBeNull();
  });
});

describe('what a regex field says about a pattern that will not compile', () => {
  // Why the comma commit was worse than a visible error: in JS an invalid quantifier is a literal,
  // so `a{2` compiles, saves, and then matches the text "a{2" and nothing a member would post.
  test('a quantifier is one pattern, and the half a comma left behind is not the same pattern', () => {
    expect(regexFault('a{2,5}')).toBeNull();
    expect(regexFault('a{2')).toBeNull();

    expect(/a{2,5}/.test('aaa')).toBe(true);
    expect(/a{2/.test('aaa')).toBe(false);
  });

  test('an unclosed group names the fault and where it starts', () => {
    expect(regexFault('(free nitro')).toEqual({
      message: 'a group that is never closed',
      at: 0,
    });
  });

  test('an unclosed character class names itself too', () => {
    expect(regexFault('join [a-z')).toEqual({
      message: 'a character class that is never closed',
      at: 5,
    });
  });

  test('a bracket inside a class is part of the class, not a fault', () => {
    expect(regexFault('[()]+')).toBeNull();
    expect(regexFault('\\(')).toBeNull();
  });

  test('a stray closing bracket is reported at the bracket', () => {
    expect(regexFault('nitro)')?.at).toBe(5);
  });
});

describe('the pattern list', () => {
  const props = {
    id: 'p',
    label: 'Regex patterns',
    onChange: () => undefined,
    syntax: 'regex' as const,
  };

  test('is one row per pattern, each editable where it sits', () => {
    const html = render(<PatternList {...props} values={['a{2,5}', 'free ?nitro']} />);

    expect(html.split('class="pattern-row"').length - 1).toBe(2);
    expect(html).toContain('value="a{2,5}"');
    expect(html).toContain('aria-label="Regex patterns 1"');
    expect(html).toContain('aria-label="Regex patterns 2"');
  });

  test('prints the parse failure on the row that caused it', () => {
    const html = render(<PatternList {...props} values={['(free nitro']} />);

    expect(html).toContain('a group that is never closed, at character 1');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('data-bad="true"');
  });

  test('a pattern that compiles draws no error at all', () => {
    expect(render(<PatternList {...props} values={['a{2,5}']} />)).not.toContain('pattern-error');
  });

  test('offers a test box for a regex list and none for a list of phrases', () => {
    expect(render(<PatternList {...props} values={['nitro']} />)).toContain(
      'Try it against a message',
    );
    expect(
      render(<PatternList {...props} syntax="phrase" values={['free nitro']} />),
    ).not.toContain('Try it against a message');
  });

  test('says so rather than showing a bare box when it is empty', () => {
    expect(render(<PatternList {...props} values={[]} />)).toContain('None yet.');
  });

  test('counts against the ceiling, and stops offering a row at it', () => {
    const html = render(<PatternList {...props} values={['a', 'b']} max={2} />);

    expect(html).toContain('2 of 2');
    expect(html).toContain('Limit of 2 reached');
    expect(html).toContain('disabled=""');
  });

  test('grows a filter only once the list is too long to read', () => {
    const few = Array.from({ length: 11 }, (_, i) => `w${i}`);

    expect(render(<PatternList {...props} syntax="phrase" values={few} />)).not.toContain(
      'Filter Regex patterns',
    );
    expect(render(<PatternList {...props} syntax="phrase" values={[...few, 'w11']} />)).toContain(
      'Filter Regex patterns',
    );
  });

  test('carries the per-entry length the schema declares', () => {
    expect(render(<PatternList {...props} values={['a']} maxLength={260} />)).toContain(
      'maxLength="260"',
    );
  });
});

describe('the roles a picker is allowed to offer', () => {
  test('a role managed by an integration is listed with the reason', () => {
    const [bot] = roleOptions([{ id: '1', name: 'Proton', position: 9, managed: true }]);

    expect(bot?.blocked).toEqual({ why: 'managed by an integration' });
  });

  test('the Booster role says what it is rather than that it is managed', () => {
    const [boost] = roleOptions([
      { id: '2', name: 'Server Booster', position: 8, managed: true, premiumSubscriber: true },
    ]);

    expect(boost?.blocked).toEqual({ why: 'the Booster role' });
  });

  test('a role above Proton’s own is named as such', () => {
    const [admin] = roleOptions([{ id: '3', name: 'Admin', position: 20, assignable: false }]);

    expect(admin?.blocked).toEqual({ why: 'above Proton’s own role' });
  });

  // Refusing a role on a guess is worse than offering one that may fail: a hand-built role, or a
  // guild whose member read was refused, carries none of these flags.
  test('a role carrying no flags is offered, because nothing is known against it', () => {
    const [plain] = roleOptions([{ id: '4', name: 'Member', position: 1 }]);

    expect(plain?.blocked).toBeUndefined();
  });
});

describe('the role list Proton builds from Discord’s own payload', () => {
  const ROLES = [
    { id: 'g', name: '@everyone', position: 0 },
    { id: 'admin', name: 'Admin', position: 20 },
    { id: 'proton', name: 'Proton', position: 10, managed: true, tags: { bot_id: 'bot' } },
    {
      id: 'boost',
      name: 'Booster',
      position: 9,
      managed: true,
      tags: { premium_subscriber: null },
    },
    { id: 'member', name: 'Member', position: 1 },
  ];

  function stubGuild(member: { roles: string[] } | null): void {
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        const body = url.includes('/members/') ? member : ROLES;

        return new Response(JSON.stringify(body), {
          status: body === null ? 403 : 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      { preconnect: realFetch.preconnect },
    );
  }

  test('carries managed through, and reads the Booster tag off a key whose value is null', async () => {
    stubGuild({ roles: ['proton'] });
    const byId = new Map((await fetchGuildRoles(PROXY, 'g', 'bot')).map((r) => [r.id, r]));

    expect(byId.get('proton')?.managed).toBe(true);
    expect(byId.get('boost')?.premiumSubscriber).toBe(true);
    expect(byId.get('member')?.premiumSubscriber).toBe(false);
  });

  test('a role above Proton’s own highest is not assignable, and one below it is', async () => {
    stubGuild({ roles: ['proton'] });
    const byId = new Map((await fetchGuildRoles(PROXY, 'g', 'bot')).map((r) => [r.id, r]));

    expect(byId.get('admin')?.assignable).toBe(false);
    expect(byId.get('member')?.assignable).toBe(true);
  });

  // A bot may only grant roles strictly below its own highest, so its own role is not assignable
  // by it either — which is what stops the picker offering Proton's role back to itself.
  test('Proton’s own role sits at the ceiling, not under it', async () => {
    stubGuild({ roles: ['proton'] });
    const byId = new Map((await fetchGuildRoles(PROXY, 'g', 'bot')).map((r) => [r.id, r]));

    expect(byId.get('proton')?.assignable).toBe(false);
  });

  test('an unreadable member claims nothing: every role stays assignable', async () => {
    stubGuild(null);
    const roles = await fetchGuildRoles(PROXY, 'g', 'bot');

    expect(roles.every((role) => role.assignable)).toBe(true);
  });

  test('and with no bot id to ask about, no ceiling is invented', async () => {
    stubGuild({ roles: ['proton'] });
    const roles = await fetchGuildRoles(PROXY, 'g');

    expect(roles.every((role) => role.assignable)).toBe(true);
    expect(roles.map((role) => role.id)).toEqual(['admin', 'proton', 'boost', 'member']);
  });
});

describe('a member on a moderation surface', () => {
  const ADA = {
    id: '451150213000000001',
    displayName: 'Ada',
    username: 'ada',
    avatarUrl: null,
  };

  test('reads as a name, with the handle beside it and the id still copyable', () => {
    const html = render(<UserChip id={ADA.id} member={ADA} as="moderator" />);

    expect(html).toContain('Ada');
    expect(html).toContain('@ada');
    expect(html).toContain(`title="${ADA.id}"`);
    expect(html).toContain(`Copy the moderator id ${ADA.id}`);
  });

  // Inventing a name for somebody who has left is worse than printing the number.
  test('an id the lookup could not resolve is the id, under the unknown treatment', () => {
    const html = render(<UserChip id={ADA.id} />);

    expect(html).toContain('data-unknown="true"');
    expect(html).toContain(ADA.id);
    expect(html).not.toContain('Ada');
  });

  test('a bot is distinguishable from a member without reading the id', () => {
    expect(render(<UserChip id={ADA.id} member={{ ...ADA, bot: true }} />)).toContain(
      'user-chip-bot',
    );
    expect(render(<UserChip id={ADA.id} member={ADA} />)).not.toContain('user-chip-bot');
  });
});

interface Row {
  name: string;
}

const column = dataColumnHelper<Row>();
const columns = column.columns([column.accessor('name', { id: 'name', header: 'Name' })]);

describe('what a data table shows before its rows arrive and when they refuse to', () => {
  test('loading is the shape of the table, not a spinner in the middle of it', () => {
    const html = render(
      <DataTable className="table" columns={columns} data={[]} loading empty={<p>none</p>} />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html.split('table-skeleton-row').length - 1).toBe(3);
    expect(html).toContain('scope="col"');
    expect(html).not.toContain('none');
  });

  test('the skeleton rows stand at the height the real ones will', () => {
    const html = render(
      <DataTable
        className="table"
        columns={columns}
        data={[]}
        loading
        virtual={{ rowHeight: 36 }}
      />,
    );

    expect(html).toContain('height:36px');
  });

  test('a failure names itself and offers the way back', () => {
    const html = render(
      <DataTable
        className="table"
        columns={columns}
        data={[]}
        error={{ message: 'Discord answered 503.', onRetry: () => undefined }}
        empty={<p>none</p>}
      />,
    );

    expect(html).toContain('Proton could not load these rows.');
    expect(html).toContain('Discord answered 503.');
    expect(html).toContain('Try again');
    expect(html).not.toContain('none');
  });

  test('a failure with nothing to retry still says what happened', () => {
    const html = render(
      <DataTable
        className="table"
        columns={columns}
        data={[]}
        error={{ message: 'Discord answered 503.' }}
      />,
    );

    expect(html).toContain('Discord answered 503.');
    expect(html).not.toContain('Try again');
  });

  test('rows still win when there are rows', () => {
    const html = render(
      <DataTable
        className="table"
        columns={columns}
        data={[{ name: 'Ada' }]}
        empty={<p>none</p>}
      />,
    );

    expect(html).toContain('Ada');
    expect(html).not.toContain('table-skeleton-row');
    expect(html).not.toContain('table-error');
  });
});

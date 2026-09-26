import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CommandCatalogueView,
  CommandSyncFailure,
  CommandSyncView,
  CommandView,
} from '@proton/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { viewOf } from './commands-views.ts';

const QUERIES = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'queries.ts'), 'utf8');

mock.module('../src/lib/queries.ts', () =>
  Object.fromEntries(
    [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
      name,
      () => ({ queryKey: ['stub', name], queryFn: async () => null, enabled: false }),
    ]),
  ),
);

const {
  CommandBanners,
  CommandGroupSection,
  CommandListRow,
  lacksAccess,
  SWITCH_CAVEAT,
  SWITCH_HELP,
  syncNote,
} = await import('../src/pages/commands/rows.tsx');

const INVITE = 'https://discord.com/oauth2/authorize?client_id=1&amp;guild_id=1';

const noop = (): void => undefined;

const SYNCED: CommandSyncView = {
  state: 'synced',
  checkedAt: '2026-09-22T10:00:00.000Z',
  syncedAt: '2026-09-22T10:00:00.000Z',
  failure: null,
};

const FAILURE: CommandSyncFailure = {
  code: null,
  status: null,
  message: '',
  detail: '',
  at: '2026-09-22T10:00:00.000Z',
  retryAt: null,
};

function catalogue(
  commands: CommandView[],
  patch: Partial<CommandCatalogueView> = {},
): CommandCatalogueView {
  return { commands, sync: SYNCED, lostPermissions: null, ...patch };
}

function row(command: CommandView, failure: string | null = null, busy = false): string {
  return renderToStaticMarkup(
    <CommandListRow
      command={command}
      busy={busy}
      failure={failure}
      onToggle={noop}
      onEdit={noop}
    />,
  );
}

function banners(view: CommandCatalogueView, ackFailure: string | null = null): string {
  return renderToStaticMarkup(
    <CommandBanners
      view={view}
      overview={<a href="/dashboard/1">Overview</a>}
      inviteHref="https://discord.com/oauth2/authorize?client_id=1&guild_id=1"
      acknowledging={false}
      ackFailure={ackFailure}
      onAcknowledge={noop}
    />,
  );
}

function decode(text: string): string {
  return text
    .replace(/&#x27;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

describe('a command row', () => {
  test('shows only the name members see, in mono, with an Edit button and no description', () => {
    const markup = decode(row(viewOf('ban', { settings: { name: 'bonk', description: 'Bonk' } })));

    expect(markup).toContain('<span class="commands-row-name mono">/bonk</span>');
    expect(markup).toContain('Renamed from /ban');
    expect(markup).not.toContain('Bonk');
    expect(markup).not.toContain(viewOf('ban').description);
    expect(markup).toMatch(/aria-label="Edit \/bonk"[^>]*>Edit<\/button>/);
  });

  test('carries a switch named for what it does', () => {
    const on = row(viewOf('ban'));
    const off = row(viewOf('ban', { settings: { enabled: false } }));

    expect(on).toMatch(/role="switch" aria-checked="true" aria-label="Show \/ban in this server"/);
    expect(off).toMatch(/role="switch" aria-checked="false"/);
    expect(off).toContain('class="commands-row off"');
  });

  test('an Apps menu command has the switch but nothing to edit', () => {
    const markup = row(viewOf('user:Report user'));

    expect(markup).toContain('<span class="commands-row-name">Report user</span>');
    expect(markup).not.toContain('>Edit</button>');
    expect(markup).toContain('aria-label="Show Report user in this server"');
  });

  test('a switch that failed says so in the row, and a busy switch is held', () => {
    expect(row(viewOf('ban'), 'Couldn’t turn /ban off. Try again.')).toContain(
      '<p class="field-error" role="alert">Couldn’t turn /ban off. Try again.</p>',
    );
    expect(row(viewOf('ban'), null, true)).toMatch(/role="switch"[^>]*disabled=""/);
  });

  test('a module that is off is named in the row', () => {
    expect(decode(row(viewOf('ban', { moduleOn: false })))).toContain(
      'Moderation is off, so members can’t see /ban.',
    );
  });

  test('a module group is a plain heading over its rows, with no count of what is on', () => {
    const markup = renderToStaticMarkup(
      <CommandGroupSection
        group={{
          id: 'moderation',
          label: 'Moderation',
          commands: [viewOf('ban'), viewOf('kick', { settings: { enabled: false } })],
        }}
      >
        <span>rows</span>
      </CommandGroupSection>,
    );

    expect(markup).toContain(
      '<section class="commands-group" aria-labelledby="commands-group-moderation">',
    );
    expect(markup).toContain(
      '<h2 id="commands-group-moderation" class="section-label">Moderation</h2>',
    );
    expect(markup).toContain('<div class="commands-rows"><span>rows</span></div>');
    expect(markup).not.toMatch(/\d+ of \d+/);
  });
});

describe('page banners', () => {
  test('nothing to say for a synced server', () => {
    expect(banners(catalogue([viewOf('ban')]))).toBe('');
  });

  test('lost permissions name every command and can be dismissed', () => {
    const markup = decode(
      banners(
        catalogue([viewOf('ban')], {
          lostPermissions: {
            commands: [
              { key: 'ban', name: 'ban' },
              { key: 'kick', name: 'kick' },
              { key: 'user:Report user', name: 'Report user' },
            ],
            at: '2026-09-22T10:00:00.000Z',
          },
        }),
        'Couldn’t dismiss this notice. Try again.',
      ),
    );

    expect(markup).toContain('Discord removed some command permissions');
    expect(markup).toContain('/ban, /kick and “Report user”');
    expect(markup).toContain('Server Settings → Integrations → Proton');
    expect(markup).toContain('>Dismiss</button>');
    expect(markup).toContain('role="alert">Couldn’t dismiss this notice. Try again.');
  });

  test('a failed sync leads with Proton’s own words and keeps Discord’s as detail', () => {
    const markup = decode(
      banners(
        catalogue([viewOf('ban')], {
          sync: {
            ...SYNCED,
            state: 'failed',
            failure: {
              code: '30034',
              status: 429,
              message: 'Discord’s daily limit of 200 command changes in this server was reached.',
              detail: 'Max number of daily application command creates has been reached (200)',
              at: '2026-09-22T10:00:00.000Z',
              retryAt: '2026-09-23T10:00:00.000Z',
            },
          },
        }),
      ),
    );

    expect(markup).toContain('banner banner-danger');
    expect(markup).toContain(
      'Discord’s daily limit of 200 command changes in this server was reached.',
    );
    expect(markup).toContain('Proton will try again automatically.');
    expect(markup).toContain(
      'Discord said: Max number of daily application command creates has been reached (200)',
    );
    expect(markup).not.toContain('Add Proton again');
  });

  test('a server Proton cannot manage commands in gets a way to add Proton again', () => {
    const failed = (status: number | null, code: string | null) =>
      catalogue([viewOf('ban')], {
        sync: {
          ...SYNCED,
          state: 'failed',
          failure: { ...FAILURE, code, status, message: 'Proton can’t manage commands here.' },
        },
      });

    expect(banners(failed(403, '50001'))).toContain(
      `<a href="${INVITE}" class="button button-secondary button-sm">Add Proton again</a>`,
    );
    expect(banners(failed(403, null))).toContain('>Add Proton again</a>');
    expect(banners(failed(400, '50035'))).not.toContain('Add Proton again');
    expect(lacksAccess({ ...FAILURE, status: 400, code: '50001' })).toBe(true);
    expect(lacksAccess({ ...FAILURE, status: 401, code: null })).toBe(false);
    expect(lacksAccess({ ...FAILURE, status: 429, code: '30034' })).toBe(false);
  });

  test('a server outside this Proton’s registration scope is told nothing is sent', () => {
    expect(
      banners(catalogue([viewOf('ban')], { sync: { ...SYNCED, state: 'not-this-environment' } })),
    ).toContain('changes here are saved but not sent to Discord');
  });

  test('no modules on is one neutral banner that points at the overview', () => {
    const off = [
      viewOf('ban', { moduleOn: false }),
      viewOf('help', { moduleOn: false, alwaysRegistered: true }),
    ];
    const markup = banners(catalogue(off));

    expect(markup.match(/class="banner"/g)).toHaveLength(1);
    expect(markup).toContain('No modules are on, so members only see /help in this server.');
    expect(markup).toContain('<a href="/dashboard/1">Overview</a>');

    const silent = banners(
      catalogue([
        off[0] as CommandView,
        viewOf('help', { moduleOn: false, settings: { enabled: false } }),
      ]),
    );
    expect(silent).toContain('members see no Proton commands in this server');
  });
});

describe('the sync note', () => {
  test('is quiet while pending and before the first sync, and absent otherwise', () => {
    const pending = catalogue([], { sync: { ...SYNCED, state: 'pending' } });
    const unsynced = catalogue([], { sync: { ...SYNCED, state: 'unsynced' } });

    expect(syncNote(pending)).toContain('Sending these changes to Discord');
    expect(syncNote(unsynced)).toContain('hasn’t sent this server’s commands');
    expect(syncNote(catalogue([]))).toBeNull();
  });

  test('the switch caveat names Integrations, and its help names Discord’s daily limit', () => {
    expect(SWITCH_CAVEAT).toContain('Server Settings → Integrations');
    expect(SWITCH_CAVEAT).toContain('doesn’t restore them');
    expect(SWITCH_HELP).toContain('200 new commands per server per day');
  });
});

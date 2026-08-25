import { createFileRoute, Link } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import type { ReactElement } from 'react';
import { useId } from 'react';
import { z } from 'zod';
import { Icon } from '../components/shell/icon.tsx';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../components/shell/module-meta.ts';
import { blurbFor, COMMAND_COUNT } from '../components/site/catalogue.ts';
import { SitePage } from '../components/site/chrome.tsx';
import { groupCommands } from '../components/site/commands.ts';
import { documentTitle } from '../lib/document-title.ts';

const commandSearchSchema = z.object({
  q: z.string().optional(),
  category: z.enum([...CATEGORY_ORDER, 'all']).optional(),
});

export const Route = createFileRoute('/commands')({
  validateSearch: zodValidator(commandSearchSchema),
  head: () => ({
    meta: [
      { title: documentTitle('Commands') },
      {
        name: 'description',
        content: `Every one of Proton's ${COMMAND_COUNT} slash commands, what each one does, the arguments it takes and the Discord permission it needs.`,
      },
    ],
  }),
  component: CommandsPage,
});

function CommandsPage(): ReactElement {
  const { q = '', category = 'all' } = Route.useSearch();
  const navigate = Route.useNavigate();
  const searchId = useId();

  const groups = groupCommands(q, category);
  const shown = groups.reduce((total, group) => total + group.commands.length, 0);

  // replace, not push: a back button that walks a search box back one character at a time is
  // worse than no history at all, and the URL still carries the filter so it can be sent.
  function setSearch(next: { q?: string; category?: typeof category }): void {
    void navigate({
      search: (prev) => ({ ...prev, ...next }),
      replace: true,
      resetScroll: false,
    });
  }

  return (
    <SitePage>
      <div className="doc-page doc-page-wide">
        <header className="doc-head">
          <span className="site-label">Commands</span>
          <h1 className="doc-title">Every command Proton registers.</h1>
          <p className="doc-lede">
            All {COMMAND_COUNT} of them, with the arguments each one takes and the Discord
            permission it asks for. Required arguments are written <code>&lt;like this&gt;</code>{' '}
            and optional ones <code>[like this]</code>, the way Discord shows them while you type.
          </p>
        </header>

        <div className="cmd-bar">
          <div className="cmd-search">
            <Icon name="magnifying-glass" />
            <input
              id={searchId}
              type="search"
              value={q}
              placeholder="Search commands"
              aria-label="Search commands"
              onChange={(event) => setSearch({ q: event.target.value })}
            />
          </div>

          {/* Links, not buttons: a filtered view of a reference page is a place, and this way it
              can be opened in a tab and sent to somebody. */}
          <nav className="cmd-filters" aria-label="Filter by category">
            <Link
              to="/commands"
              search={(prev) => ({ ...prev, category: 'all' as const })}
              replace
              resetScroll={false}
              className="cmd-filter"
              aria-current={category === 'all' ? 'true' : undefined}
            >
              All
            </Link>
            {CATEGORY_ORDER.map((key) => (
              <Link
                key={key}
                to="/commands"
                search={(prev) => ({ ...prev, category: key })}
                replace
                resetScroll={false}
                className="cmd-filter"
                aria-current={category === key ? 'true' : undefined}
              >
                {CATEGORY_LABELS[key]}
              </Link>
            ))}
          </nav>
        </div>

        <p className="cmd-count" role="status">
          {shown === COMMAND_COUNT
            ? `${COMMAND_COUNT} commands`
            : `${shown} of ${COMMAND_COUNT} commands`}
        </p>

        {groups.length === 0 ? (
          <div className="card empty-state">
            <span className="tile">
              <Icon name="magnifying-glass" />
            </span>
            <span className="empty-state-title">No command matches that.</span>
            <p className="status">
              Try the name of the thing you want to do — <code>ban</code>, <code>ticket</code>,{' '}
              <code>xp</code> — or clear the category filter.
            </p>
          </div>
        ) : (
          <div className="cmd-groups">
            {groups.map((group) => (
              <section className="cmd-group" id={group.module.id} key={group.module.id}>
                <div className="cmd-group-head">
                  <i>
                    <Icon name={group.module.icon} />
                  </i>
                  <div>
                    <h2 className="cmd-group-title">{group.module.name}</h2>
                    <p className="cmd-group-blurb">{blurbFor(group.module)}</p>
                  </div>
                  <span className="mono num cmd-group-count">{group.commands.length}</span>
                </div>

                <ul className="cmd-list">
                  {group.commands.map((command) => (
                    <li className="cmd-row" key={command.usage}>
                      <code className="cmd-usage">
                        <b>{command.usage}</b>
                        {command.args.map((arg) => (
                          <span
                            key={arg.name}
                            className={arg.required ? 'cmd-arg cmd-arg-req' : 'cmd-arg'}
                          >
                            {arg.required ? `<${arg.name}>` : `[${arg.name}]`}
                          </span>
                        ))}
                      </code>
                      <p className="cmd-desc">{command.description}</p>
                      {command.permission ? (
                        <span className="chip cmd-perm">
                          <Icon name="lock-key" />
                          {command.permission}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <p className="cmd-foot">
          A command a role may not run is refused with the reason, not ignored. Which roles may run
          what is set per server in the Permissions module, on top of the Discord permission listed
          here.
        </p>
      </div>
    </SitePage>
  );
}

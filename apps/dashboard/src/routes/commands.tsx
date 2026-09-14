import { createFileRoute } from '@tanstack/react-router';
import { type ReactElement, useMemo, useState } from 'react';
import { SitePage } from '../components/site/chrome.tsx';
import { COMMAND_SET } from '../components/site/command-set.gen.ts';
import { SearchField } from '../components/ui/controls.tsx';
import { EmptyState } from '../components/ui/feedback.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { documentTitle } from '../lib/document-title.ts';
import { MODULE_BY_ID } from '../lib/modules/catalogue.ts';

export const Route = createFileRoute('/commands')({
  head: () => ({ meta: [{ title: documentTitle('Commands') }] }),
  component: Commands,
});

function Commands(): ReactElement {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const matched = COMMAND_SET.filter(
      (command) =>
        needle === '' ||
        command.usage.toLowerCase().includes(needle) ||
        command.description.toLowerCase().includes(needle) ||
        (MODULE_BY_ID.get(command.module)?.label ?? command.module).toLowerCase().includes(needle),
    );

    const byModule = new Map<string, typeof matched>();
    for (const command of matched) {
      byModule.set(command.module, [...(byModule.get(command.module) ?? []), command]);
    }

    return [...byModule.entries()].sort((a, b) =>
      (MODULE_BY_ID.get(a[0])?.label ?? a[0]).localeCompare(MODULE_BY_ID.get(b[0])?.label ?? b[0]),
    );
  }, [needle]);

  return (
    <SitePage>
      <div className="site-section" style={{ paddingTop: 56, paddingBottom: 72 }}>
        <h1 className="site-heading">Commands</h1>
        <p className="site-lede">
          Every slash command Proton registers, generated from the modules themselves. A command
          only appears in your server once its module is switched on.
        </p>

        <div style={{ margin: '24px 0 20px', maxWidth: 360 }}>
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={`Search ${COMMAND_SET.length} commands…`}
          />
        </div>

        {groups.length === 0 ? (
          <EmptyState icon="magnifying-glass" title="No command matches that" inset />
        ) : null}

        {groups.map(([moduleId, commands]) => {
          const meta = MODULE_BY_ID.get(moduleId);

          return (
            <section key={moduleId} className="section">
              <h2 className="section-label">
                {meta ? <Icon name={meta.icon} size={13} /> : null}
                {meta?.label ?? moduleId}
              </h2>
              <div className="rows">
                {commands.map((command) => (
                  <div className="row" key={command.usage}>
                    <div className="row-main">
                      <div className="row-title mono">
                        {command.usage}
                        {command.args.map((arg) => (
                          <span key={arg.name} className="text-muted">
                            {arg.required ? ` <${arg.name}>` : ` [${arg.name}]`}
                          </span>
                        ))}
                      </div>
                      <p className="row-description">{command.description}</p>
                    </div>
                    {command.permission !== null ? (
                      <div className="row-control">
                        <span className="badge badge-neutral">{command.permission}</span>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </SitePage>
  );
}

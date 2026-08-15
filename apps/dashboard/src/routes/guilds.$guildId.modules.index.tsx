import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { listModules } from '../server/modules.ts';

export const Route = createFileRoute('/guilds/$guildId/modules/')({
  loader: ({ params }) => listModules({ data: { guildId: params.guildId } }),
  component: ModuleList,
});

/**
 * Every module Proton has loaded, for one server.
 *
 * The list comes from the registry rather than a hardcoded menu, so a module
 * that ships is a module an admin can find — the API and the worker share one
 * registry (`@proton/modules`), which is what stops the dashboard offering a
 * module nothing actually runs.
 */
function ModuleList(): ReactElement {
  const { guildId } = Route.useParams();
  const { modules } = Route.useLoaderData();

  return (
    <section className="panel">
      <h1>Modules</h1>
      <p>
        <Link to="/guilds/$guildId/cases" params={{ guildId }} search={{}}>
          Browse cases
        </Link>
      </p>

      <ul className="module-list">
        {modules.map((module) => (
          <li key={module.id}>
            <Link to="/guilds/$guildId/modules/$moduleId" params={{ guildId, moduleId: module.id }}>
              {module.name}
            </Link>
            <span className="field-description">
              {module.category}
              {module.commands.length > 0
                ? ` · ${module.commands.map((c) => `/${c}`).join(' ')}`
                : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

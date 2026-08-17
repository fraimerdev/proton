import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { listModules } from '../../../server/modules.ts';

export const Route = createFileRoute('/dashboard/$guildId/')({
  loader: ({ params }) => listModules({ data: { guildId: params.guildId } }),
  component: ModuleList,
});

function ModuleList(): ReactElement {
  const { guildId } = Route.useParams();
  const { modules } = Route.useLoaderData();

  return (
    <section className="panel">
      <h1>Modules</h1>
      <p>
        <Link to="/dashboard/$guildId/cases" params={{ guildId }} search={{}}>
          Browse cases
        </Link>
        {' · '}
        <Link to="/dashboard/$guildId/leaderboard" params={{ guildId }} search={{}}>
          Leaderboard
        </Link>
      </p>

      <ul className="module-list">
        {modules.map((module) => (
          <li key={module.id}>
            <Link to="/dashboard/$guildId/$moduleId" params={{ guildId, moduleId: module.id }}>
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

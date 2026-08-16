import { type LeaderboardRow, leaderboardQuerySchema } from '@proton/core';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { zodValidator } from '@tanstack/zod-adapter';
import type { ReactElement } from 'react';
import { searchLeaderboard } from '../../../server/modules.ts';

export const Route = createFileRoute('/dashboard/$guildId/leaderboard')({
  validateSearch: zodValidator(leaderboardQuerySchema),
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) => searchLeaderboard({ data: { guildId: params.guildId, ...deps } }),
  component: Leaderboard,
  errorComponent: LeaderboardError,
});

const features = tableFeatures({});
const column = createColumnHelper<typeof features, LeaderboardRow>();

const columns = column.columns([
  column.accessor('rank', { id: 'rank', header: '#', cell: (c) => `#${c.getValue()}` }),
  column.accessor('userId', { id: 'userId', header: 'Member' }),
  column.accessor('level', { id: 'level', header: 'Level' }),
  column.accessor('xp', { id: 'xp', header: 'XP', cell: (c) => c.getValue().toLocaleString() }),
]);

function Leaderboard(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();
  const result = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  const table = useTable({ features, columns, data: result.entries });
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));

  return (
    <section className="panel">
      <h1>Leaderboard</h1>
      <p>
        <Link to="/guilds/$guildId/modules" params={{ guildId }}>
          All modules
        </Link>
        {' · '}
        <Link to="/guilds/$guildId/$moduleId" params={{ guildId, moduleId: 'leveling' }}>
          Leveling settings
        </Link>
      </p>

      {result.total === 0 ? (
        <p className="field-empty">
          Nobody has earned XP yet. Members appear here once the Leveling module is enabled and
          somebody talks.
        </p>
      ) : (
        <table className="table">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th key={header.id}>{String(header.column.columnDef.header)}</th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getAllCells().map((cell) => (
                  <td key={cell.id}>{String(cell.renderValue() ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <nav className="pagination">
        <button
          type="button"
          className="button button-quiet"
          disabled={search.page <= 1}
          onClick={() => void navigate({ search: { ...search, page: search.page - 1 } })}
        >
          Previous
        </button>
        <span>
          Page {search.page} of {lastPage}
        </span>
        <button
          type="button"
          className="button button-quiet"
          disabled={search.page >= lastPage}
          onClick={() => void navigate({ search: { ...search, page: search.page + 1 } })}
        >
          Next
        </button>
      </nav>
    </section>
  );
}

function LeaderboardError({ error }: { error: Error }): ReactElement {
  return (
    <section className="panel">
      <h1>Leaderboard</h1>
      <p className="status" role="alert">
        {error.message}
      </p>
    </section>
  );
}

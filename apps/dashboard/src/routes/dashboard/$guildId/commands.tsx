import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { type ReactElement, useCallback } from 'react';
import { loadCommands } from '../../../lib/modules/preload.ts';
import CommandsPage, {
  CommandsPending,
  type CommandsSearch,
  commandsSearchSchema,
} from '../../../pages/commands.tsx';

export const Route = createFileRoute('/dashboard/$guildId/commands')({
  loader: ({ context, params, preload }) =>
    loadCommands(context.queryClient, params.guildId, preload),
  validateSearch: zodValidator(commandsSearchSchema),
  pendingMs: 0,
  pendingMinMs: 0,
  pendingComponent: CommandsPending,
  component: CommandsRoute,
});

function CommandsRoute(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const onSearch = useCallback(
    (patch: CommandsSearch) =>
      void navigate({
        search: (previous) => ({ ...previous, ...patch }),
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  );

  return <CommandsPage guildId={guildId} search={search} onSearch={onSearch} />;
}

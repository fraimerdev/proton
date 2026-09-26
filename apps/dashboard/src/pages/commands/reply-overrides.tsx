import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { guildCommandsQuery } from '../../lib/queries.ts';
import { replyOverrides } from './list.ts';

export function useReplyOverrideNote(guildId: string, moduleId: string): ReactElement | undefined {
  const commands = useQuery(guildCommandsQuery(guildId)).data?.commands;
  const overrides = replyOverrides(commands ?? [], moduleId);
  if (overrides.length === 0) return undefined;

  return (
    <>
      Set on the{' '}
      <Link to="/dashboard/$guildId/commands" params={{ guildId }} search={{}}>
        Commands
      </Link>{' '}
      page: {overrides.join(', ')}.
    </>
  );
}

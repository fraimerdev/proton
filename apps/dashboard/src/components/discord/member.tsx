import { useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { createContext, use, useMemo } from 'react';
import type { GuildMember } from '../../lib/discord.ts';
import { membersQuery } from '../../lib/queries.ts';
import { Spinner } from '../ui/feedback.tsx';

interface MemberIndex {
  byId: ReadonlyMap<string, GuildMember>;
  pending: boolean;
}

const Members = createContext<MemberIndex>({ byId: new Map(), pending: false });

export function MemberProvider({
  guildId,
  userIds,
  children,
}: {
  guildId: string;
  userIds: readonly string[];
  children: ReactNode;
}): ReactElement {
  const { data, isPending } = useQuery(membersQuery(guildId, userIds));

  // The query is disabled for an empty list, and a disabled query is pending forever.
  const pending = userIds.length > 0 && isPending;

  const index = useMemo(
    () => ({ byId: new Map((data ?? []).map((member) => [member.id, member])), pending }),
    [data, pending],
  );

  return <Members value={index}>{children}</Members>;
}

export function useMember(userId: string | null | undefined): GuildMember | undefined {
  const { byId } = use(Members);
  return userId ? byId.get(userId) : undefined;
}

export function MemberCell({
  userId,
  fallback = 'None',
}: {
  userId: string | null | undefined;
  fallback?: string | undefined;
}): ReactElement {
  const { pending } = use(Members);
  const member = useMember(userId);

  if (!userId) return <span className="text-muted">{fallback}</span>;

  if (!member) {
    if (pending) return <Spinner label="Loading member" />;

    return (
      <span className="user-cell">
        <span className="user-avatar avatar-fallback" aria-hidden />
        <span className="user-id" title="This account is no longer in the server">
          {userId}
        </span>
      </span>
    );
  }

  return (
    <span className="user-cell">
      {member.avatarUrl ? (
        <img className="user-avatar" src={member.avatarUrl} alt="" width={22} height={22} />
      ) : (
        <span className="user-avatar avatar-fallback" aria-hidden>
          {[...member.displayName].slice(0, 2).join('')}
        </span>
      )}
      <span className="user-name" title={`${member.username} · ${member.id}`}>
        {member.displayName}
      </span>
    </span>
  );
}

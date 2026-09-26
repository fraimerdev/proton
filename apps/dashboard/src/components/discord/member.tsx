import { type QueryKey, type UseQueryOptions, useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { createContext, use, useMemo } from 'react';
import type { GuildMember } from '../../lib/discord.ts';
import { membersQuery } from '../../lib/queries.ts';
import { Spinner } from '../ui/feedback.tsx';

interface MemberIndex {
  byId: ReadonlyMap<string, GuildMember>;
  pending: boolean;
}

export type MemberQuery = UseQueryOptions<
  readonly GuildMember[],
  Error,
  readonly GuildMember[],
  QueryKey
>;

export type MemberSource = (guildId: string, userIds: readonly string[]) => MemberQuery;

const Members = createContext<MemberIndex>({ byId: new Map(), pending: false });

export function MemberProvider({
  guildId,
  userIds,
  source,
  children,
}: {
  guildId: string;
  userIds: readonly string[];
  source?: MemberSource | undefined;
  children: ReactNode;
}): ReactElement {
  if (source !== undefined) {
    return <SourcedMembers query={source(guildId, userIds)}>{children}</SourcedMembers>;
  }

  return (
    <GuildMembers guildId={guildId} userIds={userIds}>
      {children}
    </GuildMembers>
  );
}

function GuildMembers({
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

  return (
    <IndexedMembers members={data} pending={pending}>
      {children}
    </IndexedMembers>
  );
}

function SourcedMembers({
  query,
  children,
}: {
  query: MemberQuery;
  children: ReactNode;
}): ReactElement {
  const { data, isPending } = useQuery(query);

  return (
    <IndexedMembers members={data} pending={query.enabled !== false && isPending}>
      {children}
    </IndexedMembers>
  );
}

function IndexedMembers({
  members,
  pending,
  children,
}: {
  members: readonly GuildMember[] | undefined;
  pending: boolean;
  children: ReactNode;
}): ReactElement {
  const index = useMemo(
    () => ({ byId: new Map((members ?? []).map((member) => [member.id, member])), pending }),
    [members, pending],
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
        <span className="user-id">{userId}</span>
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
      <span className="user-name">{member.displayName}</span>
    </span>
  );
}

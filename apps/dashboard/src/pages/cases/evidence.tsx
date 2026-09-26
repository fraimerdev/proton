import type { CaseMessageView } from '@proton/module-moderation/reports-view';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { MemberProvider, useMember } from '../../components/discord/member.tsx';
import { MemberMessage } from '../../components/discord/member-message.tsx';
import { LoadingArea, StatusBanner } from '../../components/ui/feedback.tsx';
import { readFailure } from '../../lib/errors.ts';
import { channelsQuery } from '../../lib/queries.ts';
import { AttachmentList } from '../moderation/reports/evidence.tsx';
import { caseEvidenceQuery } from '../moderation/reports/queries.ts';
import { useLocalTime } from '../moderation/reports/when.tsx';

const KEPT = 'Kept 30 days';
const KEPT_MS = 30 * 86_400_000;
const EXPIRED =
  'Proof and message history are kept 30 days after the case, so none is left for this one.';

function EvidenceMessage({
  message,
  now,
}: {
  message: CaseMessageView;
  now: number;
}): ReactElement {
  const author = useMember(message.authorId);
  const time = useLocalTime(message.createdAt);
  const stamp = [time, message.deletedAt === null ? undefined : 'Deleted']
    .filter((part) => part !== undefined)
    .join(' · ');

  return (
    <div className="stack stack-8">
      <MemberMessage
        author={author?.displayName ?? message.authorId}
        avatarUrl={author?.avatarUrl ?? null}
        timestamp={stamp === '' ? undefined : stamp}
        content={message.content}
        now={now}
        empty={message.attachments.length > 0 ? 'Attachments only.' : undefined}
      />
      {message.attachments.length > 0 ? (
        <AttachmentList attachments={message.attachments} now={now} />
      ) : null}
    </div>
  );
}

function Messages({
  guildId,
  messages,
  now,
}: {
  guildId: string;
  messages: readonly CaseMessageView[];
  now: number;
}): ReactElement {
  const channels = useQuery(channelsQuery(guildId));
  const names = new Map((channels.data ?? []).map((channel) => [channel.id, channel.name]));

  const groups = new Map<string, CaseMessageView[]>();
  for (const message of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
    groups.set(message.channelId, [...(groups.get(message.channelId) ?? []), message]);
  }

  return (
    <div className="stack stack-16">
      {[...groups].map(([channelId, group]) => (
        <div key={channelId} className="stack stack-8">
          <span className="text-sm text-secondary">
            {names.has(channelId) ? (
              `#${names.get(channelId)}`
            ) : (
              <span className="mono text-xs">{channelId}</span>
            )}
          </span>
          {group.map((message) => (
            <EvidenceMessage key={message.messageId} message={message} now={now} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CaseEvidence({
  guildId,
  caseId,
  createdAt,
  now,
}: {
  guildId: string;
  caseId: string;
  createdAt: string;
  now: number;
}): ReactElement {
  const evidence = useQuery(caseEvidenceQuery(guildId, caseId));

  if (evidence.isPending) return <LoadingArea label="Loading proof" minHeight={96} />;

  if (evidence.isError) {
    return (
      <StatusBanner tone="danger" live="polite">
        {readFailure(evidence.error, 'this case’s proof')}
      </StatusBanner>
    );
  }

  const { proof, history } = evidence.data;
  const authors = [
    ...new Set([...(proof === null ? [] : [proof]), ...history].map((m) => m.authorId)),
  ];
  const expired = proof === null && history.length === 0 && now - Date.parse(createdAt) >= KEPT_MS;

  return (
    <MemberProvider guildId={guildId} userIds={authors}>
      <div className="stack stack-20">
        <div>
          <p className="section-label">
            Proof
            {proof === null ? null : <span className="section-label-note">{KEPT}</span>}
          </p>
          {proof === null ? (
            <p className="text-sm text-muted">{expired ? EXPIRED : 'No proof was captured.'}</p>
          ) : (
            <Messages guildId={guildId} messages={[proof]} now={now} />
          )}
        </div>

        {history.length === 0 ? null : (
          <div>
            <p className="section-label">
              Message history
              <span className="section-label-note">{KEPT}</span>
            </p>
            <Messages guildId={guildId} messages={history} now={now} />
          </div>
        )}
      </div>
    </MemberProvider>
  );
}

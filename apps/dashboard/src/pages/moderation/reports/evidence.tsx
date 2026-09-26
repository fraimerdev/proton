import type { ReportDetail } from '@proton/module-moderation/reports-view';
import type { ReactElement, ReactNode } from 'react';
import type { MentionNames } from '../../../components/discord/markdown.tsx';
import { useMember } from '../../../components/discord/member.tsx';
import { MemberMessage } from '../../../components/discord/member-message.tsx';
import { CollectionStaticRow, MetaSeparator } from '../../../components/ui/collection.tsx';
import { StatusBanner } from '../../../components/ui/feedback.tsx';
import { Icon } from '../../../components/ui/icon.tsx';
import { Rows, Section } from '../../../components/ui/layout.tsx';
import {
  attachmentExpiry,
  fileSize,
  LINK_STATUS_COPY,
  type LinkEvidence,
  type MessageEvidence,
  type MessageSnapshot,
  purgeNotice,
  type ReportAttachment,
  readableOutcome,
  UNAVAILABLE_COPY,
} from './queue-labels.ts';
import { useLocalDate, useLocalTime } from './when.tsx';

export type EvidenceReport = Pick<
  ReportDetail,
  'evidence' | 'evidencePurgedAt' | 'evidenceExpiresAt' | 'createdAt' | 'resolvedAt'
>;

const NO_NAMES: MentionNames = new Map();

// Reporter-typed text: only a Discord message link becomes a link, never whatever else they pasted.
const DISCORD_MESSAGE_LINK =
  /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+$/;

function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function External({ href, children }: { href: string; children: ReactNode }): ReactElement {
  return (
    <a className="moderation-link" href={href} target="_blank" rel="noreferrer">
      {children}
      <Icon name="arrow-square-out" size={12} />
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

function Label({ children }: { children: ReactNode }): ReactElement {
  return <p className="moderation-report-label">{children}</p>;
}

function Place({
  channelId,
  channelName,
}: {
  channelId: string;
  channelName: ((id: string) => string | undefined) | undefined;
}): ReactElement {
  const name = channelName?.(channelId);

  return name === undefined ? (
    <span className="mono text-xs">{channelId}</span>
  ) : (
    <span>#{name}</span>
  );
}

export function AttachmentList({
  attachments,
  now,
}: {
  attachments: readonly ReportAttachment[];
  now: number;
}): ReactElement {
  return (
    <Rows className="moderation-report-files">
      {attachments.map((attachment) => {
        const expiry = attachmentExpiry(attachment.expiresAt, now);
        const removed = attachment.url === '';

        return (
          <CollectionStaticRow
            key={attachment.id}
            icon={attachment.contentType?.startsWith('image/') ? 'image' : 'clipboard-text'}
            title={attachment.filename}
            meta={
              <>
                <span>{fileSize(attachment.size)}</span>
                {attachment.contentType !== null ? (
                  <>
                    <MetaSeparator />
                    <span className="mono text-xs">{attachment.contentType}</span>
                  </>
                ) : null}
                <MetaSeparator />
                <span className={expiry.expired || removed ? 'text-muted' : undefined}>
                  {removed ? 'Link removed with the evidence' : expiry.label}
                </span>
              </>
            }
            aside={
              expiry.expired || removed ? undefined : (
                <External href={attachment.url}>Open</External>
              )
            }
          />
        );
      })}
    </Rows>
  );
}

function Snapshot({
  snapshot,
  now,
  mentionNames,
}: {
  snapshot: MessageSnapshot;
  now: number;
  mentionNames: MentionNames | undefined;
}): ReactElement {
  const member = useMember(snapshot.authorId);
  const timestamp = useLocalTime(snapshot.createdAt);

  return (
    <MemberMessage
      author={member?.displayName ?? snapshot.authorName ?? snapshot.authorId ?? 'Unknown member'}
      avatarUrl={member?.avatarUrl ?? null}
      bot={snapshot.authorBot}
      timestamp={timestamp}
      content={snapshot.content}
      edited={snapshot.editedAt !== null}
      embeds={snapshot.embeds}
      stickers={snapshot.stickers}
      forwarded={snapshot.forwarded}
      forwardedContent={snapshot.forwardedContent}
      mentionNames={mentionNames}
      now={now}
      empty={snapshot.attachments.length > 0 ? 'Attachments only.' : undefined}
    />
  );
}

function ReportedMessage({
  guildId,
  message,
  now,
  channelName,
  mentionNames,
}: {
  guildId: string;
  message: MessageEvidence;
  now: number;
  channelName: ((id: string) => string | undefined) | undefined;
  mentionNames: MentionNames | undefined;
}): ReactElement {
  if (message.status === 'unavailable') {
    return (
      <div className="stack stack-8">
        <Label>Reported message</Label>
        <Rows>
          <CollectionStaticRow
            icon="chat-centered-text"
            title="Message unavailable when reported"
            meta={<span>{UNAVAILABLE_COPY[message.reason]}</span>}
            aside={
              <External href={messageUrl(guildId, message.ids.channelId, message.ids.messageId)}>
                Jump to message
              </External>
            }
          />
        </Rows>
      </div>
    );
  }

  const { snapshot } = message;

  return (
    <div className="stack stack-8">
      <div className="moderation-report-evidence-head">
        <Label>Reported message</Label>
        <span className="text-sm text-secondary inline inline-6">
          <Place channelId={snapshot.channelId} channelName={channelName} />
          <MetaSeparator />
          <External href={snapshot.url}>Jump to message</External>
        </span>
      </div>
      <Snapshot snapshot={snapshot} now={now} mentionNames={mentionNames} />
      {snapshot.attachments.length > 0 ? (
        <AttachmentList attachments={snapshot.attachments} now={now} />
      ) : null}
    </div>
  );
}

function LinkedMessage({
  link,
  now,
  mentionNames,
}: {
  link: LinkEvidence;
  now: number;
  mentionNames: MentionNames | undefined;
}): ReactElement {
  return (
    <div className="stack stack-6">
      <span className="text-sm inline inline-6 moderation-report-link-line">
        <span className={link.status === 'captured' ? 'text-secondary' : 'text-warning'}>
          {LINK_STATUS_COPY[link.status]}
        </span>
        <MetaSeparator />
        {DISCORD_MESSAGE_LINK.test(link.url) ? (
          <External href={link.url}>Open message</External>
        ) : (
          <span className="mono text-xs moderation-report-url">{link.url}</span>
        )}
      </span>
      {link.status === 'captured' && link.snapshot !== undefined ? (
        <>
          <Snapshot snapshot={link.snapshot} now={now} mentionNames={mentionNames} />
          {link.snapshot.attachments.length > 0 ? (
            <AttachmentList attachments={link.snapshot.attachments} now={now} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ForwardedCopy({
  guildId,
  copy,
  now,
  channelName,
  mentionNames,
}: {
  guildId: string;
  copy: NonNullable<EvidenceReport['evidence']['copy']>;
  now: number;
  channelName: ((id: string) => string | undefined) | undefined;
  mentionNames: MentionNames | undefined;
}): ReactElement {
  if ('failed' in copy) {
    return (
      <p className="text-sm text-warning">
        Proton didn’t forward a copy: {readableOutcome(copy.failed, mentionNames ?? NO_NAMES, now)}
      </p>
    );
  }

  return (
    <p className="text-sm text-secondary inline inline-6">
      <span>
        Forwarded to <Place channelId={copy.channelId} channelName={channelName} />
      </span>
      <MetaSeparator />
      <External href={messageUrl(guildId, copy.channelId, copy.messageId)}>Open the copy</External>
    </p>
  );
}

export function EvidenceSection({
  guildId,
  report,
  now,
  channelName,
  mentionNames,
}: {
  guildId: string;
  report: EvidenceReport;
  now: number;
  channelName?: ((id: string) => string | undefined) | undefined;
  mentionNames?: MentionNames | undefined;
}): ReactElement {
  const { evidence } = report;
  const purged = purgeNotice(report);
  const keptUntil = useLocalDate(purged === null ? report.evidenceExpiresAt : null);

  const nothing =
    evidence.message === undefined &&
    evidence.links.length === 0 &&
    evidence.attachments.length === 0 &&
    evidence.copy === undefined;

  return (
    <Section
      label="Evidence"
      note={keptUntil !== undefined ? `Kept until ${keptUntil}` : undefined}
      className="moderation-report-evidence"
    >
      <div className="stack stack-20">
        {purged !== null ? <StatusBanner tone="neutral">{purged}</StatusBanner> : null}

        {nothing && purged === null ? (
          <p className="text-sm text-muted">No message, links or files came with this report.</p>
        ) : null}

        {evidence.message !== undefined ? (
          <ReportedMessage
            guildId={guildId}
            message={evidence.message}
            now={now}
            channelName={channelName}
            mentionNames={mentionNames}
          />
        ) : null}

        {evidence.links.length > 0 ? (
          <div className="stack stack-12">
            <Label>Linked messages</Label>
            {evidence.links.map((link, index) => (
              <LinkedMessage
                // biome-ignore lint/suspicious/noArrayIndexKey: the reporter may link one message twice
                key={`${index}:${link.url}`}
                link={link}
                now={now}
                mentionNames={mentionNames}
              />
            ))}
          </div>
        ) : null}

        {evidence.attachments.length > 0 ? (
          <div className="stack stack-8">
            <Label>Submitted files</Label>
            <AttachmentList attachments={evidence.attachments} now={now} />
          </div>
        ) : null}

        {evidence.copy !== undefined ? (
          <div className="stack stack-6">
            <Label>Forwarded copy</Label>
            <ForwardedCopy
              guildId={guildId}
              copy={evidence.copy}
              now={now}
              channelName={channelName}
              mentionNames={mentionNames}
            />
          </div>
        ) : null}
      </div>
    </Section>
  );
}

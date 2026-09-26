import type { ProtonMessage, ReportStatus } from '@proton/core';
import {
  type PlaceholderSurface,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_REPORTER,
  SAMPLE_SERVER,
} from '@proton/core/placeholders';
import type { DmMessage, ReportsConfig } from '@proton/module-moderation/config';
import {
  REPORT_ACCEPTED_SURFACE,
  REPORT_DISMISSED_SURFACE,
  REPORT_SUBMITTED_SURFACE,
} from '@proton/module-moderation/placeholders';
import {
  buildReportCard,
  type CardReport,
  STATS_WINDOW_DAYS,
} from '@proton/module-moderation/report-card';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { ChannelName } from '../../../components/discord/channel-picker.tsx';
import {
  EditorPreviewLayout,
  MessageEditor,
  placeholderSlot,
} from '../../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../../components/discord/message-preview.tsx';
import { TestMessage } from '../../../components/module/test-message.tsx';
import { Button, Switch } from '../../../components/ui/controls.tsx';
import { StatusBanner } from '../../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../../components/ui/layout.tsx';
import { SegmentedTabs } from '../../../components/ui/tabs.tsx';
import {
  type MessagePreview,
  previewMessage,
  SAMPLE_MENTION_NAMES,
} from '../../../lib/placeholder-preview.ts';
import { channelsQuery, rolesQuery } from '../../../lib/queries.ts';
import type { ModerationForm, Problems } from '../punish-shape.ts';
import { setReports, useReportNames } from './sections.tsx';
import { rolesText } from './shape.ts';

type Notice = 'submitted' | 'accepted' | 'dismissed';
type View = Notice | 'card';

const VIEWS = [
  { id: 'submitted', label: 'Received' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'dismissed', label: 'Dismissed' },
  { id: 'card', label: 'Staff card' },
] as const satisfies readonly { id: View; label: string }[];

const CARD_STATUSES = [
  { id: 'open', label: 'Open' },
  { id: 'in_review', label: 'In review' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'dismissed', label: 'Dismissed' },
] as const satisfies readonly { id: ReportStatus; label: string }[];

const STAFF_NOTE_HELP =
  'A note staff write for the reporter fills {report.explanation}, or is added as “Note from ' +
  'staff” if this message leaves it out. The internal note is never sent.';

const NOTICES: Readonly<
  Record<
    Notice,
    { title: string; description: string; help: string; surface: PlaceholderSurface<unknown> }
  >
> = {
  submitted: {
    title: 'When a report is received',
    description: 'Sent once the report is filed.',
    help:
      'Reports from /report and the Apps menu also get a private confirmation in Discord. ' +
      'Reaction reports always get a DM.',
    surface: REPORT_SUBMITTED_SURFACE as PlaceholderSurface<unknown>,
  },
  accepted: {
    title: 'When a report is accepted',
    description: 'Sent when staff accept the report.',
    help: STAFF_NOTE_HELP,
    surface: REPORT_ACCEPTED_SURFACE as PlaceholderSurface<unknown>,
  },
  dismissed: {
    title: 'When a report is dismissed',
    description: 'Sent when staff dismiss the report.',
    help: STAFF_NOTE_HELP,
    surface: REPORT_DISMISSED_SURFACE as PlaceholderSurface<unknown>,
  },
};

const CONTENT_DESCRIPTION = 'Supports Discord markdown and placeholders. Type { to add one.';

const PREVIEW_EMPTY = 'This message is empty, so nothing is sent.';

const PREVIEW_REFUSED =
  'With this sample filled in, the message couldn’t be sent, so the member would get nothing. ' +
  'The preview shows it as written.';

const LAYOUT_NOTE =
  'This message is a components layout, which this editor can’t change. Remove it to write text ' +
  'and an embed instead.';

const CARD_INTRO =
  'Proton posts this card in the report channel for every new report and updates it as staff ' +
  'work. Its format can’t be changed.';

const HOUR_MS = 3_600_000;
const SAMPLE_REPORT_ID = 'Rk3P9aQ';
const SAMPLE_NUMBER = 42;
const SAMPLE_SOURCE_CHANNEL = '100000000000000040';
const SAMPLE_SOURCE_MESSAGE = '100000000000000041';
const SAMPLE_COPY_MESSAGE = '100000000000000042';
const SAMPLE_MODERATOR = '100000000000000030';
const SAMPLE_CASE = 'Qm7Lx2A';

const SAMPLE_DETAILS = 'They keep posting invite links after being asked to stop.';
const SAMPLE_TEXT = 'join my server!! discord.gg/example free nitro for everyone';

const CARD_NAMES: ReadonlyMap<string, string> = new Map([
  ...SAMPLE_MENTION_NAMES,
  [SAMPLE_REPORTER.user.id, SAMPLE_REPORTER.user.globalName ?? SAMPLE_REPORTER.user.username ?? ''],
  [SAMPLE_MODERATOR, 'Kestrel'],
  [SAMPLE_SOURCE_CHANNEL, 'general'],
]);

function sampleCard(status: ReportStatus, reports: ReportsConfig): ProtonMessage {
  const active = status === 'open' || status === 'in_review';
  const filedAt = SAMPLE_NOW - HOUR_MS;
  const joined = SAMPLE_MEMBER.member.joinedAt;

  const report: CardReport = {
    id: SAMPLE_REPORT_ID,
    guildId: SAMPLE_SERVER.id,
    number: SAMPLE_NUMBER,
    status,
    method: 'message_menu',
    reporterId: SAMPLE_REPORTER.user.id,
    targetId: SAMPLE_MEMBER.user.id,
    reason: reports.reasons[0]?.label ?? null,
    customReason: null,
    comment: SAMPLE_DETAILS,
    sourceChannelId: SAMPLE_SOURCE_CHANNEL,
    sourceMessageId: SAMPLE_SOURCE_MESSAGE,
    evidence: {
      message: {
        status: 'captured',
        snapshot: {
          id: SAMPLE_SOURCE_MESSAGE,
          channelId: SAMPLE_SOURCE_CHANNEL,
          authorId: SAMPLE_MEMBER.user.id,
          authorName: SAMPLE_MEMBER.user.username,
          authorBot: false,
          url: `https://discord.com/channels/${SAMPLE_SERVER.id}/${SAMPLE_SOURCE_CHANNEL}/${SAMPLE_SOURCE_MESSAGE}`,
          createdAt: filedAt - 5 * 60_000,
          editedAt: null,
          content: SAMPLE_TEXT,
          attachments: [],
          embeds: [],
          stickers: [],
          forwarded: false,
          forwardedContent: null,
          capturedFrom: 'interaction',
        },
      },
      links: [],
      attachments: [],
      ...(reports.copyReportedMessage
        ? {
            copy: {
              channelId: reports.channelId ?? SAMPLE_SOURCE_CHANNEL,
              messageId: SAMPLE_COPY_MESSAGE,
            },
          }
        : {}),
    },
    evidencePurgedAt: null,
    assigneeId: status === 'in_review' ? SAMPLE_MODERATOR : null,
    resolvedBy: active ? null : SAMPLE_MODERATOR,
    actionKind: status === 'accepted' ? 'timeout' : null,
    caseIds: status === 'accepted' ? [SAMPLE_CASE] : [],
    createdAt: filedAt,
  };

  return buildReportCard({
    report,
    target: {
      username: SAMPLE_MEMBER.user.username,
      membership: 'member',
      joinedAt: joined ? Date.parse(joined) : null,
    },
    stats: { total: 3, distinctReporters: 2, open: active ? 2 : 1 },
    statsWindowDays: STATS_WINDOW_DAYS,
    notifyRoleIds: reports.notifyRoleIds,
    firstPost: status === 'open',
  });
}

export function ReportMessagesArea({
  guildId,
  form,
  problems,
}: {
  guildId: string;
  form: ModerationForm;
  problems: Problems;
}): ReactElement {
  const [view, setView] = useState<View>('submitted');

  return (
    <>
      <div className="moderation-report-views">
        <SegmentedTabs
          label="Message"
          className="moderation-report-scroll"
          items={VIEWS}
          value={view}
          onChange={setView}
        />
      </div>

      {view === 'card' ? (
        <StaffCard guildId={guildId} form={form} />
      ) : (
        <ReporterNotice key={view} guildId={guildId} form={form} problems={problems} kind={view} />
      )}
    </>
  );
}

function ReporterNotice({
  guildId,
  form,
  problems,
  kind,
}: {
  guildId: string;
  form: ModerationForm;
  problems: Problems;
  kind: Notice;
}): ReactElement {
  const notice = form.value.reports.notifications[kind];
  const { title, description, help, surface } = NOTICES[kind];
  const prefix = `reports.notifications.${kind}`;
  const messagePath = `${prefix}.message`;
  const message = notice.message;

  const setMessage = (next: DmMessage): void =>
    setReports(form, (current) => ({
      ...current,
      notifications: {
        ...current.notifications,
        [kind]: { ...current.notifications[kind], message: next },
      },
    }));

  const preview = useMemo<MessagePreview<DmMessage> | null>(() => {
    const sample = surface.samples[0];
    return sample === undefined ? null : previewMessage(surface, message, sample);
  }, [surface, message]);

  const messageError =
    problems.at(messagePath) ??
    problems.at(`${messagePath}.v2`) ??
    problems.at(`${messagePath}.components`);

  const editor = (
    <>
      <Section label="When to send">
        <Rows>
          <SettingRow
            title={title}
            description={description}
            help={help}
            note={notice.enabled ? undefined : 'Off: the reporter gets no DM.'}
            error={problems.at(`${prefix}.enabled`) ?? messageError}
          >
            <Switch
              label={`Send a message ${title.toLowerCase()}`}
              checked={notice.enabled}
              onChange={(next) => form.set(`${prefix}.enabled`, next)}
            />
          </SettingRow>
        </Rows>
      </Section>

      {message.v2.length > 0 ? (
        <Section label="Layout" intro={LAYOUT_NOTE}>
          <Rows>
            <SettingRow title="Components layout">
              <Button
                tone="danger-quiet"
                size="sm"
                icon="trash"
                onClick={() => setMessage({ ...message, v2: [] })}
              >
                Remove layout
              </Button>
            </SettingRow>
          </Rows>
        </Section>
      ) : (
        <MessageEditor
          guildId={guildId}
          value={message}
          allow={{ components: false, mentions: false }}
          placeholders={placeholderSlot(surface, form.templateDiagnosticsAt)}
          contentLabel="Message text"
          contentDescription={CONTENT_DESCRIPTION}
          errorAt={problems.at}
          pathPrefix={messagePath}
          onChange={(next) => setMessage({ ...message, ...next })}
        />
      )}
    </>
  );

  return (
    <EditorPreviewLayout
      editor={editor}
      previewTitle="What the reporter receives"
      previewActions={
        <TestMessage
          guildId={guildId}
          moduleId="moderation"
          simulations={form.view.simulations}
          simulationId={surface.id}
          draft={form.value as unknown as Record<string, unknown>}
          dirty={form.dirty}
          configuredChannelId={null}
        />
      }
      preview={
        <div className="stack stack-10">
          <DiscordPreview
            message={preview?.message ?? message}
            mentionNames={preview?.mentionNames}
            now={preview?.now}
            empty={PREVIEW_EMPTY}
          />
          {preview !== null ? <p className="text-xs text-muted">{preview.caption}</p> : null}
          {preview?.problem !== undefined ? (
            <p className="text-xs text-danger">{PREVIEW_REFUSED}</p>
          ) : null}
        </div>
      }
    />
  );
}

function StaffCard({ guildId, form }: { guildId: string; form: ModerationForm }): ReactElement {
  const [status, setStatus] = useState<ReportStatus>('open');
  const names = useReportNames(guildId);
  const roles = useQuery(rolesQuery(guildId));
  const channels = useQuery(channelsQuery(guildId));

  const reports = form.value.reports;
  const card = useMemo(() => sampleCard(status, reports), [status, reports]);

  const mentionNames = useMemo(() => {
    const all = new Map(CARD_NAMES);
    for (const role of roles.data ?? []) all.set(role.id, role.name);
    for (const channel of channels.data ?? []) all.set(channel.id, channel.name);
    return all;
  }, [roles.data, channels.data]);

  const channelName =
    reports.channelId === undefined ? undefined : (names.channel?.(reports.channelId) ?? undefined);

  const editor = (
    <>
      <Section label="Staff card" intro={CARD_INTRO}>
        <Rows>
          <SettingRow title="Posted in" description="The report channel, from Settings.">
            <span className="moderation-aside text-sm">
              {reports.channelId === undefined ? (
                <span className="text-danger">Not chosen</span>
              ) : (
                <ChannelName guildId={guildId} id={reports.channelId} />
              )}
            </span>
          </SettingRow>
          <SettingRow
            title="Mentions"
            description="On a new report only, never when the card is edited."
          >
            <span className="moderation-aside text-muted text-sm">
              {reports.notifyRoleIds.length === 0
                ? 'Nobody'
                : rolesText(reports.notifyRoleIds, names)}
            </span>
          </SettingRow>
        </Rows>
      </Section>

      {reports.channelId === undefined ? (
        <StatusBanner tone="warning">
          Choose a report channel in Settings, or reports have nowhere to go.
        </StatusBanner>
      ) : null}
    </>
  );

  return (
    <EditorPreviewLayout
      editor={editor}
      previewTitle="What staff see"
      previewActions={
        <TestMessage
          guildId={guildId}
          moduleId="moderation"
          simulations={form.view.simulations}
          simulationId="moderation.report_card"
          draft={form.value as unknown as Record<string, unknown>}
          dirty={form.dirty}
          configuredChannelId={reports.channelId ?? null}
        />
      }
      preview={
        <div className="stack stack-10">
          <SegmentedTabs
            label="Report status"
            className="moderation-report-scroll"
            items={CARD_STATUSES}
            value={status}
            onChange={setStatus}
          />
          <DiscordPreview
            message={card}
            mentionNames={mentionNames}
            now={SAMPLE_NOW}
            channelName={channelName}
          />
          <p className="text-xs text-muted">
            Sample: a message report about {SAMPLE_MEMBER.user.globalName}, filed by{' '}
            {SAMPLE_REPORTER.user.globalName}. Member-written text is shown in a code block, cut
            short where it’s long.
          </p>
        </div>
      }
    />
  );
}

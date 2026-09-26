import { type ReportAction, type ReportActionParams, tryParseDuration } from '@proton/core';
import {
  type ModerationConfig,
  moderationConfigSchema,
  PUNISH_DURATION_MAX_MS,
  TIMEOUT_CAP_MS,
} from '@proton/module-moderation/config';
import type { ReportActionResult, ReportDetail } from '@proton/module-moderation/reports-view';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChannelIndex } from '../../../components/discord/channel-picker.tsx';
import { DurationInput, humaniseDuration } from '../../../components/discord/inputs.tsx';
import { MemberCell, MemberProvider, useMember } from '../../../components/discord/member.tsx';
import { MemberPicker } from '../../../components/discord/member-picker.tsx';
import { ModuleLink, useModuleSearch } from '../../../components/module/route.tsx';
import { MetaSeparator } from '../../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  Checkbox,
  Field,
  SegmentedControl,
  Select,
  TextArea,
} from '../../../components/ui/controls.tsx';
import {
  AsyncOperationStatus,
  LoadingArea,
  StatusBanner,
} from '../../../components/ui/feedback.tsx';
import { Icon, type IconName } from '../../../components/ui/icon.tsx';
import { NavigationRow, Pair, Pairs, Rows, Section } from '../../../components/ui/layout.tsx';
import { Dialog } from '../../../components/ui/overlay.tsx';
import { membersQuery, moduleConfigQuery, rolesQuery, sessionQuery } from '../../../lib/queries.ts';
import { EvidenceSection } from './evidence.tsx';
import { actOnReportMutation, newRequestId, reportQuery } from './queries.ts';
import {
  type ActionFailure,
  acceptParams,
  actionFailure,
  allowedPunishments,
  cardProblem,
  deletesByDefault,
  filedByViewer,
  historyLine,
  isActive,
  isMemberId,
  METHOD_LABELS,
  PUNISHMENT_LABELS,
  type Punishment,
  readableOutcome,
  reportReadFailure,
  STATUS_LABELS,
  statusTone,
  type ViewerAccess,
} from './queue-labels.ts';
import { Actor, CaseLink, ReportTimeline } from './timeline.tsx';
import { useNow, When } from './when.tsx';

const NOTE_MAX = 1000;
const REASON_MAX = 512;

const ACCEPT_LABELS: Record<Punishment, string> = {
  none: 'Accept report',
  warn: 'Accept and warn',
  timeout: 'Accept and time out',
  kick: 'Accept and kick',
  ban: 'Accept and ban',
};

const WORKING_LABELS: Partial<Record<ReportAction, string>> = {
  claim: 'Claiming…',
  unclaim: 'Releasing the claim…',
  retry_delivery: 'Posting the report card…',
  repost: 'Posting the report card again…',
};

const WAITING = <AsyncOperationStatus phase="working" workingLabel="Waiting for Proton…" />;

const DECIDING =
  'A decision on this report is being carried out. This page updates when it finishes.';

const FILED_BY_YOU = 'You filed this report, so someone else on staff has to accept or dismiss it.';

type Answer = ActionFailure | { tone: 'success'; message: string; unsettled: false };

interface ActionHandlers {
  onAnswer: (outcome: ReportActionResult) => void;
  onFailure: (failure: ActionFailure) => void;
}

function useReportAction(guildId: string, reportId: string) {
  const queryClient = useQueryClient();
  const { mutate, isPending, variables } = useMutation(actOnReportMutation(queryClient, guildId));
  const retry = useRef<{ signature: string; requestId: string } | null>(null);

  const run = useCallback(
    (
      action: ReportAction,
      params: ReportActionParams,
      attempt: string,
      handlers: ActionHandlers,
    ) => {
      const signature = JSON.stringify([action, params]);
      // Reused only when no answer came back: an answered id is kept by the api and would replay that answer.
      const requestId =
        retry.current?.signature === signature ? retry.current.requestId : newRequestId();
      retry.current = { signature, requestId };

      mutate(
        { reportId, action, params, requestId },
        {
          onSuccess: (outcome) => {
            retry.current = null;
            handlers.onAnswer(outcome);
          },
          onError: (error) => handlers.onFailure(actionFailure(error, attempt)),
        },
      );
    },
    [mutate, reportId],
  );

  return { run, pending: isPending, action: isPending ? variables?.action : undefined };
}

function useShown(open: boolean): { readonly current: boolean } {
  const shown = useRef(open);

  useEffect(() => {
    shown.current = open;
  }, [open]);

  return shown;
}

function answerOf(outcome: ReportActionResult): Answer {
  return outcome.ok
    ? { tone: 'success', message: outcome.message, unsettled: false }
    : refusalOf(outcome);
}

function refusalOf(outcome: ReportActionResult): ActionFailure {
  return { tone: 'danger', message: outcome.message, unsettled: false };
}

function useViewerAccess(guildId: string): ViewerAccess | undefined {
  const queryClient = useQueryClient();
  // Read, not observed: the shell already holds this, and a stale observer here would refetch every guild.
  const session = queryClient.getQueryData(sessionQuery().queryKey);
  const guild = session?.guilds.find((candidate) => candidate.id === guildId);

  return guild === undefined
    ? undefined
    : { id: session?.user.discordId ?? null, owner: guild.owner, permissions: guild.permissions };
}

function useModerationConfig(guildId: string, moduleId: string): ModerationConfig | null {
  const view = useQuery(moduleConfigQuery(guildId, moduleId)).data;

  return useMemo(() => {
    if (view === undefined) return null;
    const parsed = moderationConfigSchema.safeParse(view.config);
    return parsed.success ? parsed.data : null;
  }, [view]);
}

function useNames(guildId: string, memberIds: readonly string[]): ReadonlyMap<string, string> {
  const members = useQuery(membersQuery(guildId, memberIds)).data;
  const channels = useChannelIndex(guildId).byId;
  const roles = useQuery(rolesQuery(guildId)).data;

  return useMemo(() => {
    const names = new Map<string, string>();
    for (const role of roles ?? []) names.set(role.id, role.name);
    for (const channel of channels.values()) names.set(channel.id, channel.name);
    for (const member of members ?? []) names.set(member.id, member.displayName);
    return names;
  }, [members, channels, roles]);
}

function reportMemberIds(report: ReportDetail): string[] {
  const ids = new Set<string>();
  const add = (id: string | null | undefined): void => {
    if (isMemberId(id)) ids.add(id);
  };

  add(report.targetId);
  add(report.reporterId);
  add(report.assigneeId);
  add(report.resolvedBy);
  for (const event of report.events) {
    add(event.actorId);
    const assignee = event.data.assigneeId;
    if (typeof assignee === 'string') add(assignee);
  }
  const message = report.evidence.message;
  if (message?.status === 'captured') add(message.snapshot.authorId);
  for (const link of report.evidence.links) add(link.snapshot?.authorId);
  for (const related of report.related) add(related.reporterId);

  return [...ids];
}

function BackLink({ guildId, moduleId }: { guildId: string; moduleId: string }): ReactElement {
  const search = useModuleSearch();

  return (
    <ModuleLink
      className="moderation-link text-sm moderation-report-back"
      guildId={guildId}
      moduleId={moduleId}
      search={{ ...search, id: undefined }}
    >
      <Icon name="caret-left" size={13} />
      Back to queue
    </ModuleLink>
  );
}

export function ReportDetailView({
  guildId,
  moduleId,
  reportId,
  onFilterMember,
}: {
  guildId: string;
  moduleId: string;
  reportId: string;
  onFilterMember: (targetId: string) => void;
}): ReactElement {
  const query = useQuery(reportQuery(guildId, reportId));
  const now = useNow(query.dataUpdatedAt);

  if (query.data === undefined) {
    return (
      <div className="stack stack-16">
        <BackLink guildId={guildId} moduleId={moduleId} />
        {query.isError ? (
          <StatusBanner tone="danger" live="polite">
            {reportReadFailure(query.error, `report ${reportId}`)}
          </StatusBanner>
        ) : (
          <LoadingArea label="Loading report" minHeight={240} />
        )}
      </div>
    );
  }

  return (
    <LoadedReport
      guildId={guildId}
      moduleId={moduleId}
      report={query.data}
      now={now}
      refreshing={query.isFetching}
      onRefresh={() => void query.refetch()}
      onFilterMember={onFilterMember}
    />
  );
}

function LoadedReport({
  guildId,
  moduleId,
  report,
  now,
  refreshing,
  onRefresh,
  onFilterMember,
}: {
  guildId: string;
  moduleId: string;
  report: ReportDetail;
  now: number;
  refreshing: boolean;
  onRefresh: () => void;
  onFilterMember: (targetId: string) => void;
}): ReactElement {
  const memberIds = useMemo(() => reportMemberIds(report), [report]);
  const names = useNames(guildId, memberIds);
  const channels = useChannelIndex(guildId).byId;
  const access = useViewerAccess(guildId);
  const config = useModerationConfig(guildId, moduleId);

  const [dialog, setDialog] = useState<'accept' | 'dismiss' | 'assign' | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const action = useReportAction(guildId, report.id);

  const active = isActive(report.status);
  const problem = cardProblem(report.card.state);
  const filedByYou = filedByViewer(report, access);

  const quick = (kind: ReportAction, attempt: string): void => {
    setAnswer(null);
    action.run(kind, {}, attempt, {
      onAnswer: (outcome) => setAnswer(answerOf(outcome)),
      onFailure: setAnswer,
    });
  };

  const channelName = useCallback((id: string) => channels.get(id)?.name, [channels]);

  return (
    <MemberProvider guildId={guildId} userIds={memberIds}>
      <div className="moderation-report-detail">
        <header className="moderation-report-head">
          <BackLink guildId={guildId} moduleId={moduleId} />
          <h2 className="moderation-report-title">
            <span>
              Report <span className="mono">{report.id}</span>
            </span>
            <span className="text-muted">#{report.number}</span>
            <Badge tone={statusTone(report.status)}>{STATUS_LABELS[report.status]}</Badge>
            {problem !== null ? <Badge tone="warning">{problem}</Badge> : null}
          </h2>
          <p className="moderation-report-sub">
            <When at={report.createdAt} now={now} prefix="Submitted " />
            <MetaSeparator />
            <span>via {METHOD_LABELS[report.method]}</span>
          </p>
        </header>

        {active ? (
          <div className="moderation-report-actions">
            {filedByYou ? null : (
              <>
                <Button tone="primary" icon="gavel" onClick={() => setDialog('accept')}>
                  Accept…
                </Button>
                <Button onClick={() => setDialog('dismiss')}>Dismiss…</Button>
              </>
            )}
            {report.status === 'open' ? (
              <Button
                busy={action.action === 'claim'}
                disabled={action.pending}
                onClick={() => quick('claim', 'Couldn’t claim the report')}
              >
                Claim
              </Button>
            ) : (
              <Button
                busy={action.action === 'unclaim'}
                disabled={action.pending}
                onClick={() => quick('unclaim', 'Couldn’t release the claim')}
              >
                Unclaim
              </Button>
            )}
            <Button tone="ghost" icon="user-plus" onClick={() => setDialog('assign')}>
              {report.assigneeId === null ? 'Assign…' : 'Reassign…'}
            </Button>
            <AsyncOperationStatus
              phase={action.pending ? 'working' : 'idle'}
              workingLabel={
                (action.action !== undefined ? WORKING_LABELS[action.action] : undefined) ??
                'Working on it…'
              }
            />
          </div>
        ) : null}

        <div className="stack stack-10 moderation-report-banners">
          {answer !== null ? (
            <StatusBanner
              tone={answer.tone}
              live={answer.tone === 'success' ? 'polite' : 'assertive'}
              onDismiss={() => setAnswer(null)}
              actions={
                answer.unsettled ? (
                  <Button size="sm" busy={refreshing} onClick={onRefresh}>
                    Check again
                  </Button>
                ) : undefined
              }
            >
              {readableOutcome(answer.message, names, now)}
            </StatusBanner>
          ) : null}

          {report.deciding ? (
            <StatusBanner tone="info" live="polite">
              {DECIDING}
            </StatusBanner>
          ) : null}

          {active && filedByYou ? <StatusBanner tone="neutral">{FILED_BY_YOU}</StatusBanner> : null}

          {report.card.state === 'failed' ? (
            <StatusBanner
              tone="warning"
              title="The report card was not posted"
              actions={
                <Button
                  size="sm"
                  busy={action.action === 'retry_delivery'}
                  disabled={action.pending}
                  onClick={() => quick('retry_delivery', 'Couldn’t post the report card')}
                >
                  Retry delivery
                </Button>
              }
            >
              {report.card.error !== null
                ? readableOutcome(report.card.error, names, now)
                : 'Discord refused it, and Proton didn’t record why.'}
            </StatusBanner>
          ) : null}

          {report.card.state === 'missing' ? (
            <StatusBanner
              tone="warning"
              title="The report card was deleted in Discord"
              actions={
                <Button
                  size="sm"
                  busy={action.action === 'repost'}
                  disabled={action.pending}
                  onClick={() => quick('repost', 'Couldn’t post the report card')}
                >
                  Repost
                </Button>
              }
            >
              Staff reviewing in Discord can’t see this report until the card is posted again.
            </StatusBanner>
          ) : null}

          {report.close.error !== null && report.close.closedAt === null ? (
            <StatusBanner tone="warning" title="Closing the report card failed">
              {readableOutcome(report.close.error, names, now)} Proton tries again on its own.
            </StatusBanner>
          ) : null}
        </div>

        <ReportFacts
          guildId={guildId}
          report={report}
          now={now}
          channelName={channelName}
          active={active}
        />

        <EvidenceSection
          guildId={guildId}
          report={report}
          now={now}
          channelName={channelName}
          mentionNames={names}
        />

        <RelatedReports
          guildId={guildId}
          moduleId={moduleId}
          report={report}
          now={now}
          onFilterMember={onFilterMember}
        />

        <ReportTimeline
          guildId={guildId}
          events={report.events}
          now={now}
          mentionNames={names}
          ruleName={(id) => config?.reports.automation.find((rule) => rule.id === id)?.name}
        />
      </div>

      {/* Mounted whatever the status: the refetch that resolves the report lands before the answer does. */}
      <AcceptDialog
        guildId={guildId}
        report={report}
        open={dialog === 'accept'}
        onClose={() => setDialog(null)}
        onDone={setAnswer}
        allowed={allowedPunishments(access)}
        viewer={access}
        config={config}
        names={names}
        now={now}
      />
      <DismissDialog
        guildId={guildId}
        report={report}
        open={dialog === 'dismiss'}
        onClose={() => setDialog(null)}
        onDone={setAnswer}
        config={config}
        names={names}
        now={now}
      />
      <AssignDialog
        guildId={guildId}
        report={report}
        open={dialog === 'assign'}
        onClose={() => setDialog(null)}
        onDone={setAnswer}
        names={names}
        now={now}
      />
    </MemberProvider>
  );
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

function ReportFacts({
  guildId,
  report,
  now,
  channelName,
  active,
}: {
  guildId: string;
  report: ReportDetail;
  now: number;
  channelName: (id: string) => string | undefined;
  active: boolean;
}): ReactElement {
  const casesById = new Map(report.cases.map((entry) => [entry.id, entry]));
  const source = report.sourceChannelId;

  return (
    <Section label="Report">
      <Rows className="moderation-report-facts">
        <Pairs>
          <Pair label="Reported member">
            <MemberCell userId={report.targetId} />
          </Pair>
          <Pair label="Reported by">
            <MemberCell userId={report.reporterId} />
          </Pair>
          <Pair label="Method">{METHOD_LABELS[report.method]}</Pair>
          <Pair label="Reason">
            {report.reason ?? <span className="text-muted">None chosen</span>}
          </Pair>
          {report.customReason !== null ? (
            <Pair label="Custom reason">
              <span className="moderation-wrap">{report.customReason}</span>
            </Pair>
          ) : null}
          {report.comment !== null ? (
            <Pair label="Details">
              <span className="moderation-wrap">{report.comment}</span>
            </Pair>
          ) : null}
          {source !== null ? (
            <Pair label="Source">
              <span className="inline inline-6 inline-wrap">
                <span>#{channelName(source) ?? source}</span>
                {report.sourceMessageId !== null ? (
                  <>
                    <MetaSeparator />
                    <External
                      href={`https://discord.com/channels/${guildId}/${source}/${report.sourceMessageId}`}
                    >
                      Jump to message
                    </External>
                  </>
                ) : null}
              </span>
            </Pair>
          ) : null}
          <Pair label="Assignee">
            {report.assigneeId === null ? (
              <span className="text-muted">Nobody</span>
            ) : (
              <span className="inline inline-6 inline-wrap">
                <MemberCell userId={report.assigneeId} />
                {report.assignedAt !== null ? (
                  <span className="text-muted text-xs">
                    <When at={report.assignedAt} now={now} prefix="since " />
                  </span>
                ) : null}
              </span>
            )}
          </Pair>
          {report.resolvedAt !== null ? (
            <Pair label={report.status === 'accepted' ? 'Accepted by' : 'Dismissed by'}>
              <span className="inline inline-6 inline-wrap">
                <Actor id={report.resolvedBy} />
                <MetaSeparator />
                <When at={report.resolvedAt} now={now} />
              </span>
            </Pair>
          ) : null}
          {report.status === 'accepted' ? (
            <Pair label="Action">
              {report.actionKind === null
                ? PUNISHMENT_LABELS.none
                : (PUNISHMENT_LABELS[report.actionKind as Punishment] ?? report.actionKind)}
            </Pair>
          ) : null}
          {report.caseIds.length > 0 ? (
            <Pair label={report.caseIds.length === 1 ? 'Case' : 'Cases'}>
              <span className="inline inline-8 inline-wrap">
                {report.caseIds.map((caseId) => {
                  const linked = casesById.get(caseId);

                  return (
                    <span className="inline inline-6" key={caseId}>
                      {linked !== undefined ? (
                        <span>{PUNISHMENT_LABELS[linked.type as Punishment] ?? linked.type}</span>
                      ) : null}
                      <CaseLink guildId={guildId} caseId={caseId} />
                    </span>
                  );
                })}
              </span>
            </Pair>
          ) : null}
          {report.resolutionNote !== null ? (
            <Pair label="Internal note">
              <span className="moderation-wrap">{report.resolutionNote}</span>
            </Pair>
          ) : null}
          {report.reporterNote !== null ? (
            <Pair label="Reporter note">
              <span className="moderation-wrap">{report.reporterNote}</span>
            </Pair>
          ) : null}
          <Pair label="History">{historyLine(report.stats, active)}</Pair>
        </Pairs>
      </Rows>
    </Section>
  );
}

function RelatedReports({
  guildId,
  moduleId,
  report,
  now,
  onFilterMember,
}: {
  guildId: string;
  moduleId: string;
  report: ReportDetail;
  now: number;
  onFilterMember: (targetId: string) => void;
}): ReactElement {
  const search = useModuleSearch();

  return (
    <Section label="Related reports" note="About the same member">
      {report.related.length === 0 ? (
        <p className="text-sm text-muted">No other reports about this member.</p>
      ) : (
        <Rows>
          {report.related.map((related) => (
            <NavigationRow
              key={related.id}
              guildId={guildId}
              moduleId={moduleId}
              search={{ ...search, id: related.id }}
              title={
                <span className="inline inline-8">
                  <span className="mono">{related.id}</span>
                  <span className="text-muted">#{related.number}</span>
                </span>
              }
              description={related.reason ?? related.customReason ?? 'No reason given'}
              aside={
                <span className="moderation-report-related-aside">
                  <Badge tone={statusTone(related.status)}>{STATUS_LABELS[related.status]}</Badge>
                  <span className="text-xs text-muted">
                    <When at={related.createdAt} now={now} />
                  </span>
                </span>
              }
            />
          ))}
        </Rows>
      )}
      <div className="moderation-report-more">
        <Button tone="ghost" size="sm" onClick={() => onFilterMember(report.targetId)}>
          Show all reports about this member
        </Button>
      </div>
    </Section>
  );
}

function reasonFor(
  report: ReportDetail,
  config: ModerationConfig | null,
  punishment: Punishment,
): string {
  if (punishment === 'none') return '';
  return report.reason ?? config?.punish.types[punishment].defaultReason ?? '';
}

function AcceptDialog({
  guildId,
  report,
  open,
  onClose,
  onDone,
  allowed,
  viewer,
  config,
  names,
  now,
}: {
  guildId: string;
  report: ReportDetail;
  open: boolean;
  onClose: () => void;
  onDone: (answer: Answer) => void;
  allowed: readonly Punishment[];
  viewer: ViewerAccess | undefined;
  config: ModerationConfig | null;
  names: ReadonlyMap<string, string>;
  now: number;
}): ReactElement {
  const target = useMember(report.targetId);
  const targetName = target?.displayName ?? report.targetId;
  const { run, pending } = useReportAction(guildId, report.id);
  const shown = useShown(open);

  const timeoutDefault = config?.punish.types.timeout.defaultDuration ?? '1h';
  const banDefault = config?.punish.types.ban.defaultDuration ?? null;

  const [punishment, setPunishment] = useState<Punishment>('none');
  const [reason, setReason] = useState<string | null>(null);
  const [timeoutChoice, setTimeoutFor] = useState<string | null>(null);
  const [banChoice, setBanFor] = useState<string | null | undefined>(undefined);
  const [deleteMessage, setDeleteMessage] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const [reporterNote, setReporterNote] = useState('');
  const [step, setStep] = useState<'form' | 'severe' | 'recent'>('form');
  const [recent, setRecent] = useState('');
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const timeoutFor = timeoutChoice ?? timeoutDefault;
  const banFor = banChoice === undefined ? banDefault : banChoice;

  const close = (): void => {
    setPunishment('none');
    setReason(null);
    setTimeoutFor(null);
    setBanFor(undefined);
    setDeleteMessage(null);
    setNote('');
    setReporterNote('');
    setStep('form');
    setRecent('');
    setFailure(null);
    setSubmitted(false);
    onClose();
  };

  const kind = punishment === 'none' ? null : punishment;
  const shownReason = reason ?? reasonFor(report, config, punishment);
  const trimmedReason = shownReason.trim();
  const forceReason = kind !== null && config?.punish.types[kind].forceReason === true;
  const canDelete = report.sourceMessageId !== null;
  const deleting =
    deleteMessage ??
    deletesByDefault(kind !== null && config?.punish.types[kind].deleteProof === true, viewer);
  const reporterNoteShown = config?.reports.notifications.accepted.enabled ?? true;
  const extend = config?.punish.extendTimeouts ?? false;

  const length = punishment === 'timeout' ? timeoutFor : punishment === 'ban' ? banFor : null;
  const lengthMs = length === null ? null : tryParseDuration(length);
  const lengthMax = punishment === 'timeout' && !extend ? TIMEOUT_CAP_MS : PUNISH_DURATION_MAX_MS;

  const reasonError =
    submitted && forceReason && trimmedReason === ''
      ? `This server requires a reason for every ${kind === 'warn' ? 'warning' : kind}.`
      : trimmedReason.length > REASON_MAX
        ? `A reason can be at most ${REASON_MAX} characters.`
        : undefined;

  const lengthError =
    length === null
      ? undefined
      : lengthMs === null || lengthMs <= 0
        ? 'Enter a length, like 1h or 7d.'
        : lengthMs > lengthMax
          ? punishment === 'timeout' && !extend
            ? 'Discord ends every timeout after 28 days. Turn on Extend timeouts in Punish settings for a longer one.'
            : 'A punishment can last at most 365 days.'
          : undefined;

  const invalid =
    (forceReason && trimmedReason === '') ||
    trimmedReason.length > REASON_MAX ||
    lengthError !== undefined;

  const params = (confirmRecentCase: boolean): ReportActionParams =>
    acceptParams({
      punishment,
      reason: shownReason,
      timeoutFor,
      banFor,
      deleteMessage: canDelete ? deleting : null,
      note,
      reporterNote: reporterNoteShown ? reporterNote : null,
      confirmRecentCase,
    });

  const send = (confirmRecentCase: boolean): void => {
    setFailure(null);
    run('accept', params(confirmRecentCase), 'Couldn’t accept the report', {
      onAnswer: (outcome) => {
        if (outcome.ok) {
          onDone(answerOf(outcome));
          if (shown.current) close();
        } else if (!shown.current) {
          onDone(refusalOf(outcome));
        } else if (outcome.needsConfirmation === 'recent_case') {
          setRecent(outcome.message);
          setStep('recent');
        } else {
          setFailure(refusalOf(outcome));
          setStep('form');
        }
      },
      onFailure: (next) => {
        if (!shown.current) {
          onDone(next);
          return;
        }
        setFailure(next);
        setStep('form');
      },
    });
  };

  const submit = (): void => {
    setSubmitted(true);
    if (invalid) return;
    if (punishment === 'ban' || punishment === 'kick') setStep('severe');
    else send(false);
  };

  const severe =
    punishment === 'ban'
      ? `Proton bans ${targetName} ${banFor === null ? 'permanently' : `for ${humaniseDuration(banFor)}`} and accepts report ${report.id}.`
      : `Proton removes ${targetName} from the server and accepts report ${report.id}. They can rejoin with an invite.`;

  return (
    <>
      <Dialog
        open={open && step === 'form'}
        onClose={close}
        dismissible={!pending}
        title="Accept report"
        size="medium"
        icon="gavel"
        description={`Report ${report.id} about ${targetName}.`}
        footerNote={pending ? WAITING : undefined}
        footer={
          <>
            <Button onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button tone="primary" busy={pending} onClick={submit}>
              {ACCEPT_LABELS[punishment]}
            </Button>
          </>
        }
      >
        {failure !== null ? (
          <StatusBanner tone={failure.tone} live="assertive">
            {readableOutcome(failure.message, names, now)}
          </StatusBanner>
        ) : null}

        <Field
          label="Punishment"
          hint={
            allowed.length < 5
              ? 'Only what your Discord permissions allow is listed.'
              : 'Carried out by Proton, recorded as a case.'
          }
        >
          {(props) => (
            <Select
              {...props}
              width="md"
              value={punishment}
              options={allowed.map((value) => ({ value, label: PUNISHMENT_LABELS[value] }))}
              onChange={(value) => {
                setPunishment(value as Punishment);
                setReason(null);
                setDeleteMessage(null);
                setFailure(null);
              }}
            />
          )}
        </Field>

        {punishment === 'timeout' ? (
          <div className="field">
            <span className="field-label">Length</span>
            <DurationInput
              label="Timeout length"
              value={timeoutFor}
              units={['m', 'h', 'd', 'w']}
              max={lengthMax}
              invalid={lengthError !== undefined}
              onChange={setTimeoutFor}
            />
            {lengthError !== undefined ? <span className="field-error">{lengthError}</span> : null}
          </div>
        ) : null}

        {punishment === 'ban' ? (
          <div className="field">
            <span className="field-label">Length</span>
            <SegmentedControl
              label="Ban length"
              value={banFor === null ? 'permanent' : 'temporary'}
              options={[
                { value: 'permanent', label: 'Permanent' },
                { value: 'temporary', label: 'Temporary' },
              ]}
              onChange={(value) => setBanFor(value === 'permanent' ? null : (banDefault ?? '7d'))}
            />
            {banFor !== null ? (
              <DurationInput
                label="Ban length"
                value={banFor}
                units={['h', 'd', 'w']}
                max={PUNISH_DURATION_MAX_MS}
                invalid={lengthError !== undefined}
                onChange={setBanFor}
              />
            ) : null}
            {lengthError !== undefined ? <span className="field-error">{lengthError}</span> : null}
          </div>
        ) : null}

        {kind !== null ? (
          <Field
            label="Reason"
            hint="Shown to the member and in Discord’s audit log."
            error={reasonError}
          >
            {(props) => (
              <TextArea
                {...props}
                rows={2}
                maxLength={REASON_MAX}
                value={shownReason}
                invalid={reasonError !== undefined}
                onChange={(event) => setReason(event.currentTarget.value)}
              />
            )}
          </Field>
        ) : null}

        {canDelete ? (
          <span className="inline inline-8 text-sm">
            <Checkbox
              checked={deleting}
              onChange={setDeleteMessage}
              label="Delete the reported message"
            />
            Delete the reported message
          </span>
        ) : null}

        <Field label="Internal note" hint="Only staff see this, on the report.">
          {(props) => (
            <TextArea
              {...props}
              rows={2}
              maxLength={NOTE_MAX}
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          )}
        </Field>

        {reporterNoteShown ? (
          <Field
            label="Reporter note"
            hint="Added to the DM that tells the reporter their report was accepted."
          >
            {(props) => (
              <TextArea
                {...props}
                rows={2}
                maxLength={NOTE_MAX}
                value={reporterNote}
                onChange={(event) => setReporterNote(event.currentTarget.value)}
              />
            )}
          </Field>
        ) : null}
      </Dialog>

      <StepConfirm
        open={open && step === 'severe'}
        onBack={() => setStep('form')}
        onConfirm={() => send(false)}
        title={punishment === 'ban' ? `Ban ${targetName}?` : `Kick ${targetName}?`}
        confirmLabel={punishment === 'ban' ? 'Ban member' : 'Kick member'}
        icon="gavel"
        danger
        pending={pending}
      >
        {severe}
      </StepConfirm>

      <StepConfirm
        open={open && step === 'recent'}
        onBack={() => setStep('form')}
        onConfirm={() => send(true)}
        title="Punish again?"
        confirmLabel={`${PUNISHMENT_LABELS[punishment]} anyway`}
        icon="warning"
        danger={punishment === 'ban' || punishment === 'kick'}
        pending={pending}
      >
        {readableOutcome(recent, names, now)}
      </StepConfirm>
    </>
  );
}

function StepConfirm({
  open,
  onBack,
  onConfirm,
  title,
  confirmLabel,
  icon,
  danger,
  pending,
  children,
}: {
  open: boolean;
  onBack: () => void;
  onConfirm: () => void;
  title: string;
  confirmLabel: string;
  icon: IconName;
  danger: boolean;
  pending: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onBack}
      dismissible={!pending}
      title={title}
      size="medium"
      icon={danger ? icon : undefined}
      tone={danger ? 'danger' : undefined}
      footerNote={pending ? WAITING : undefined}
      footer={
        <>
          <Button onClick={onBack} disabled={pending}>
            Back
          </Button>
          <Button tone={danger ? 'danger' : 'primary'} busy={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-secondary text-sm">{children}</p>
    </Dialog>
  );
}

function DismissDialog({
  guildId,
  report,
  open,
  onClose,
  onDone,
  config,
  names,
  now,
}: {
  guildId: string;
  report: ReportDetail;
  open: boolean;
  onClose: () => void;
  onDone: (answer: Answer) => void;
  config: ModerationConfig | null;
  names: ReadonlyMap<string, string>;
  now: number;
}): ReactElement {
  const { run, pending } = useReportAction(guildId, report.id);
  const shown = useShown(open);
  const [note, setNote] = useState('');
  const [reporterNote, setReporterNote] = useState('');
  const [failure, setFailure] = useState<ActionFailure | null>(null);

  const reporterNoteShown = config?.reports.notifications.dismissed.enabled ?? true;

  const close = (): void => {
    setNote('');
    setReporterNote('');
    setFailure(null);
    onClose();
  };

  const submit = (): void => {
    setFailure(null);
    run(
      'dismiss',
      {
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
        ...(reporterNoteShown && reporterNote.trim() !== ''
          ? { reporterNote: reporterNote.trim() }
          : {}),
      },
      'Couldn’t dismiss the report',
      {
        onAnswer: (outcome) => {
          if (outcome.ok) {
            onDone(answerOf(outcome));
            if (shown.current) close();
          } else if (!shown.current) {
            onDone(refusalOf(outcome));
          } else {
            setFailure(refusalOf(outcome));
          }
        },
        onFailure: (next) => (shown.current ? setFailure(next) : onDone(next)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!pending}
      title="Dismiss report"
      size="medium"
      description={`Nobody is punished. Report ${report.id} is closed as dismissed.`}
      footerNote={pending ? WAITING : undefined}
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button tone="primary" busy={pending} onClick={submit}>
            Dismiss report
          </Button>
        </>
      }
    >
      {failure !== null ? (
        <StatusBanner tone={failure.tone} live="assertive">
          {readableOutcome(failure.message, names, now)}
        </StatusBanner>
      ) : null}

      <Field label="Internal note" hint="Only staff see this, on the report.">
        {(props) => (
          <TextArea
            {...props}
            rows={2}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        )}
      </Field>

      {reporterNoteShown ? (
        <Field
          label="Reporter note"
          hint="Explains the decision in the DM that tells the reporter their report was dismissed."
        >
          {(props) => (
            <TextArea
              {...props}
              rows={3}
              maxLength={NOTE_MAX}
              value={reporterNote}
              onChange={(event) => setReporterNote(event.currentTarget.value)}
            />
          )}
        </Field>
      ) : null}
    </Dialog>
  );
}

function AssignDialog({
  guildId,
  report,
  open,
  onClose,
  onDone,
  names,
  now,
}: {
  guildId: string;
  report: ReportDetail;
  open: boolean;
  onClose: () => void;
  onDone: (answer: Answer) => void;
  names: ReadonlyMap<string, string>;
  now: number;
}): ReactElement {
  const { run, pending } = useReportAction(guildId, report.id);
  const shown = useShown(open);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ActionFailure | null>(null);

  const close = (): void => {
    setAssigneeId(null);
    setFailure(null);
    onClose();
  };

  const submit = (): void => {
    if (assigneeId === null) return;

    setFailure(null);
    run('assign', { assigneeId }, 'Couldn’t assign the report', {
      onAnswer: (outcome) => {
        if (outcome.ok) {
          onDone(answerOf(outcome));
          if (shown.current) close();
        } else if (!shown.current) {
          onDone(refusalOf(outcome));
        } else {
          setFailure(refusalOf(outcome));
        }
      },
      onFailure: (next) => (shown.current ? setFailure(next) : onDone(next)),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!pending}
      title={report.assigneeId === null ? 'Assign report' : 'Reassign report'}
      size="compact"
      icon="user-plus"
      description="The member you choose is shown as reviewing it, here and on the report card."
      footerNote={pending ? WAITING : undefined}
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button tone="primary" busy={pending} disabled={assigneeId === null} onClick={submit}>
            {report.assigneeId === null ? 'Assign report' : 'Reassign report'}
          </Button>
        </>
      }
    >
      {failure !== null ? (
        <StatusBanner tone={failure.tone} live="assertive">
          {readableOutcome(failure.message, names, now)}
        </StatusBanner>
      ) : null}

      <div className="field">
        <span className="field-label">Assign to</span>
        <MemberPicker
          guildId={guildId}
          value={assigneeId}
          onChange={(next) => {
            setAssigneeId(next);
            setFailure(null);
          }}
          label="Assign to"
          placeholder="Choose a member"
          width="100%"
        />
      </div>
    </Dialog>
  );
}

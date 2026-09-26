import { isActive } from '@proton/module-applications/status';
import type { ApplicationDetail } from '@proton/module-applications/view';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { MemberCell, MemberProvider, type MemberSource } from '../../components/discord/member.tsx';
import { MetaSeparator } from '../../components/ui/collection.tsx';
import { Badge, Button } from '../../components/ui/controls.tsx';
import {
  AsyncOperationStatus,
  EmptyState,
  LoadingArea,
  StatusBanner,
} from '../../components/ui/feedback.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Pair, Pairs, Rows, Section } from '../../components/ui/layout.tsx';
import { type MenuAction, MenuButton } from '../../components/ui/overlay.tsx';
import type { ApplicationActionRequest } from '../../server/applications.ts';
import { useNow, When } from '../moderation/reports/when.tsx';
import { AnswersSection, ConversationSection } from './answers.tsx';
import {
  AssignDialog,
  DecisionDialog,
  DeleteApplicantDialog,
  DeleteApplicationDialog,
  ExportDialog,
  NoteForm,
  type Outcome,
  outcomeOf,
  ReopenDialog,
  RequestInfoDialog,
  type Surface,
  useApplicationAction,
  VoteDialog,
  WaitlistDialog,
} from './dialogs.tsx';
import { ACTIONS_ANCHOR, EffectsSection } from './effects.tsx';
import {
  type ActionAvailability,
  accessRefusal,
  actionsFor,
  applicationsReadFailure,
  averageScore,
  detailMemberIds,
  isNotFound,
  isWorking,
  problemLabels,
  problemSummary,
  REVIEW_MEMBERS_MAX,
  statusLabel,
  statusTone,
  voteLine,
} from './labels.ts';
import { applicationQuery } from './queries.ts';
import { Actor, ApplicantCell, ApplicationHistory } from './timeline.tsx';

type DialogId =
  | 'accept'
  | 'reject'
  | 'info'
  | 'waitlist'
  | 'reopen'
  | 'assign'
  | 'vote'
  | 'delete'
  | 'purge'
  | 'export';

const WORKING_LABELS: Readonly<Record<string, string>> = {
  claim: 'Claiming…',
  unclaim: 'Releasing the claim…',
  vote: 'Recording your vote…',
  archive: 'Archiving…',
  unarchive: 'Taking it out of the archive…',
  open_ticket: 'Asking Tickets…',
  repost_card: 'Asking for a new review card…',
};

const MODULE_OFF =
  'Applications is off in this server, so you can read and export applications but not change ' +
  'them. Waiting actions carry on once it’s turned back on.';

const DELETED =
  'This application was deleted. Only a minimal record stays: its reference, form, status and ' +
  'dates.';

const WORKING =
  'Proton is carrying out the actions for this application. This page updates as they finish.';

const READ_ONLY =
  'You can read this application. Reviewing it needs one of the form’s review roles.';

const NOT_DECIDER = 'Only deciders on this form’s review team can accept or reject it.';

const MODERATION_HELP =
  'Shown to staff who can time out, kick or ban members. Accepting an application never lifts ' +
  'a punishment.';

function problemBody(status: ApplicationDetail['application']['status']): string {
  return status === 'accepted' || status === 'rejected'
    ? 'The decision is saved. Only what failed needs attention: retry it under Actions once the ' +
        'cause is fixed.'
    : 'Retry what failed under Actions once the cause is fixed.';
}

function BackButton({ onBack }: { onBack: () => void }): ReactElement {
  return (
    <button type="button" className="applications-review-back text-sm" onClick={onBack}>
      <Icon name="caret-left" size={13} />
      Back to submissions
    </button>
  );
}

function External({ href, children }: { href: string; children: ReactNode }): ReactElement {
  return (
    <a className="applications-review-link" href={href} target="_blank" rel="noreferrer">
      {children}
      <Icon name="arrow-square-out" size={12} />
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

export function ApplicationDetailView({
  guildId,
  surface,
  applicationId,
  source,
  moduleOn,
  roleName,
  onBack,
}: {
  guildId: string;
  surface: Surface;
  applicationId: string;
  source?: MemberSource | undefined;
  moduleOn: boolean | null;
  roleName?: ((id: string) => string | undefined) | undefined;
  onBack: () => void;
}): ReactElement {
  const query = useQuery(applicationQuery(guildId, applicationId));
  const now = useNow(query.dataUpdatedAt);

  if (query.data === undefined) {
    const refused = query.isError ? accessRefusal(query.error) : null;

    return (
      <div className="stack stack-16">
        <BackButton onBack={onBack} />
        {!query.isError ? (
          <LoadingArea label="Loading application" minHeight={240} />
        ) : refused !== null ? (
          <EmptyState icon="lock" title="You can’t open this application" inset>
            {refused}
          </EmptyState>
        ) : isNotFound(query.error) ? (
          <EmptyState icon="warning" title="Application not found" inset>
            It may have been deleted, or it belongs to another server.
          </EmptyState>
        ) : (
          <StatusBanner tone="danger" live="polite">
            {applicationsReadFailure(query.error, 'this application')}
          </StatusBanner>
        )}
      </div>
    );
  }

  return (
    <LoadedApplication
      guildId={guildId}
      surface={surface}
      detail={query.data}
      now={now}
      source={source}
      moduleOn={moduleOn}
      roleName={roleName}
      onBack={onBack}
    />
  );
}

function LoadedApplication({
  guildId,
  surface,
  detail,
  now,
  source,
  moduleOn,
  roleName,
  onBack,
}: {
  guildId: string;
  surface: Surface;
  detail: ApplicationDetail;
  now: number;
  source: MemberSource | undefined;
  moduleOn: boolean | null;
  roleName: ((id: string) => string | undefined) | undefined;
  onBack: () => void;
}): ReactElement {
  const { application } = detail;
  const memberIds = useMemo(() => detailMemberIds(detail).slice(0, REVIEW_MEMBERS_MAX), [detail]);
  const [dialog, setDialog] = useState<DialogId | null>(null);
  const [answer, setAnswer] = useState<Outcome | null>(null);
  const action = useApplicationAction(guildId, application.id);

  const can = actionsFor(detail, moduleOn !== false);
  const summary = problemSummary(application.status, application.problems);
  const live = application.deletedAt === null;
  const reviewing = detail.capabilities.includes('review');
  const active = isActive(application.status);

  const quick = (request: ApplicationActionRequest, attempt: string): void => {
    setAnswer(null);
    action.run(request, attempt, {
      onAnswer: (result) => setAnswer(outcomeOf(result)),
      onFailure: setAnswer,
    });
  };

  const close = (): void => setDialog(null);
  const done = (outcome: Outcome): void => setAnswer(outcome);
  const shared = { guildId, detail, onClose: close, onDone: done };

  return (
    <MemberProvider guildId={guildId} userIds={memberIds} source={source}>
      <div className="applications-review-detail">
        <header className="applications-review-head">
          <BackButton onBack={onBack} />
          <h2 className="applications-review-title">
            <span>{application.formName}</span>
            {application.number !== null ? (
              <span className="text-muted">#{application.number}</span>
            ) : null}
            <Badge tone={statusTone(application.status)}>{statusLabel(application.status)}</Badge>
            {application.archived ? <Badge>Archived</Badge> : null}
            {!live ? <Badge tone="danger">Deleted</Badge> : null}
            {problemLabels(application.problems).map((label) => (
              <Badge key={label} tone="warning">
                {label}
              </Badge>
            ))}
          </h2>
          <p className="applications-review-sub">
            <ApplicantCell id={application.applicantId} name={application.applicantName} />
            <MetaSeparator />
            <When at={application.submittedAt} now={now} prefix="Submitted " />
            {application.reopenedCount > 0 ? (
              <>
                <MetaSeparator />
                <span>
                  Reopened{' '}
                  {application.reopenedCount === 1 ? 'once' : `${application.reopenedCount} times`}
                </span>
              </>
            ) : null}
          </p>
        </header>

        <ActionBar
          detail={detail}
          can={can}
          pending={action.pending}
          working={action.action}
          onDialog={setDialog}
          onQuick={quick}
        />

        <div className="stack stack-10 applications-review-banners">
          {answer !== null ? (
            <StatusBanner
              tone={answer.tone}
              live={answer.tone === 'success' ? 'polite' : 'assertive'}
              onDismiss={() => setAnswer(null)}
            >
              {answer.message}
            </StatusBanner>
          ) : null}

          {!live ? <StatusBanner tone="neutral">{DELETED}</StatusBanner> : null}

          {live && moduleOn === false ? (
            <StatusBanner tone="info">{MODULE_OFF}</StatusBanner>
          ) : null}

          {summary !== null && live ? (
            <StatusBanner
              tone="warning"
              title={summary}
              actions={
                <Button
                  size="sm"
                  onClick={() =>
                    document
                      .getElementById(ACTIONS_ANCHOR)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                >
                  Show actions
                </Button>
              }
            >
              {problemBody(application.status)}
            </StatusBanner>
          ) : null}

          {live && moduleOn !== false && isWorking(detail.effects) ? (
            <StatusBanner tone="info" live="polite">
              {WORKING}
            </StatusBanner>
          ) : null}

          {live && !reviewing ? <StatusBanner tone="neutral">{READ_ONLY}</StatusBanner> : null}

          {live && reviewing && active && !detail.capabilities.includes('decide') ? (
            <StatusBanner tone="neutral">{NOT_DECIDER}</StatusBanner>
          ) : null}
        </div>

        <div className="applications-review-columns">
          <div className="applications-review-main">
            <AnswersSection detail={detail} now={now} />
            <ConversationSection thread={detail.thread} now={now} />
          </div>

          <div className="applications-review-side">
            <FactsSection guildId={guildId} detail={detail} now={now} />
            <VotesSection detail={detail} now={now} />
            <NotesSection
              guildId={guildId}
              detail={detail}
              now={now}
              canNote={can.note}
              onDone={done}
            />
            <ModerationSection detail={detail} now={now} />
          </div>
        </div>

        <EffectsSection
          guildId={guildId}
          detail={detail}
          now={now}
          moduleOn={moduleOn}
          manage={live && reviewing && moduleOn !== false}
          roleName={roleName}
          onDone={done}
        />

        <ApplicationHistory events={detail.history} now={now} />
      </div>

      <DecisionDialog {...shared} decision="accept" open={dialog === 'accept'} />
      <DecisionDialog {...shared} decision="reject" open={dialog === 'reject'} />
      <RequestInfoDialog {...shared} open={dialog === 'info'} />
      <WaitlistDialog {...shared} open={dialog === 'waitlist'} />
      <ReopenDialog {...shared} open={dialog === 'reopen'} />
      <AssignDialog {...shared} surface={surface} open={dialog === 'assign'} />
      <VoteDialog {...shared} open={dialog === 'vote'} />
      <DeleteApplicationDialog {...shared} open={dialog === 'delete'} />
      <DeleteApplicantDialog {...shared} open={dialog === 'purge'} />
      <ExportDialog
        guildId={guildId}
        choice={{ view: 'all', formId: application.formId, formName: application.formName }}
        open={dialog === 'export'}
        onClose={close}
        onDone={done}
      />
    </MemberProvider>
  );
}

function ActionBar({
  detail,
  can,
  pending,
  working,
  onDialog,
  onQuick,
}: {
  detail: ApplicationDetail;
  can: ActionAvailability;
  pending: boolean;
  working: string | undefined;
  onDialog: (dialog: DialogId) => void;
  onQuick: (request: ApplicationActionRequest, attempt: string) => void;
}): ReactElement | null {
  const { application } = detail;
  const ticketLabel =
    application.interview === null ? 'Open interview ticket' : 'Open interview ticket again';
  const workingLabel = (working !== undefined ? WORKING_LABELS[working] : undefined) ?? 'Working…';

  const menu: MenuAction[] = [];
  if (can.assign) {
    menu.push({
      id: 'assign',
      label: application.assigneeId === null ? 'Assign…' : 'Reassign…',
      icon: 'user-plus',
      onSelect: () => onDialog('assign'),
    });
  }
  if (can.waitlist) {
    menu.push({
      id: 'waitlist',
      label: 'Waitlist…',
      icon: 'list',
      onSelect: () => onDialog('waitlist'),
    });
  }
  if (can.vote && detail.scoring) {
    menu.push({ id: 'vote', label: 'Vote…', icon: 'scales', onSelect: () => onDialog('vote') });
  }
  if (can.vote && !detail.scoring) {
    menu.push(
      {
        id: 'vote-accept',
        label: 'Vote to accept',
        icon: 'check-circle',
        disabled: pending,
        onSelect: () => onQuick({ action: 'vote', vote: 'accept' }, 'Couldn’t record your vote'),
      },
      {
        id: 'vote-reject',
        label: 'Vote to reject',
        icon: 'prohibit',
        disabled: pending,
        onSelect: () => onQuick({ action: 'vote', vote: 'reject' }, 'Couldn’t record your vote'),
      },
    );
  }
  if (can.openTicket) {
    menu.push({
      id: 'ticket',
      label: ticketLabel,
      icon: 'ticket',
      disabled: pending,
      onSelect: () => onQuick({ action: 'open_ticket' }, 'Couldn’t ask for an interview ticket'),
    });
  }
  if (can.repost) {
    menu.push({
      id: 'repost',
      label: 'Post the review card again',
      icon: 'megaphone',
      disabled: pending,
      onSelect: () => onQuick({ action: 'repost_card' }, 'Couldn’t post the review card again'),
    });
  }
  if (can.archive) {
    menu.push({
      id: 'archive',
      label: 'Archive',
      icon: 'archive',
      disabled: pending,
      onSelect: () => onQuick({ action: 'archive' }, 'Couldn’t archive the application'),
    });
  }
  if (can.unarchive) {
    menu.push({
      id: 'unarchive',
      label: 'Take out of the archive',
      icon: 'archive',
      disabled: pending,
      onSelect: () => onQuick({ action: 'unarchive' }, 'Couldn’t take it out of the archive'),
    });
  }
  if (can.exportForm) {
    menu.push({
      id: 'export',
      label: `Export ${application.formName}…`,
      icon: 'clipboard-text',
      onSelect: () => onDialog('export'),
    });
  }
  if (can.remove) {
    menu.push(
      {
        id: 'delete',
        label: 'Delete application…',
        icon: 'trash',
        danger: true,
        onSelect: () => onDialog('delete'),
      },
      {
        id: 'purge',
        label: 'Delete everything from this applicant…',
        icon: 'trash',
        danger: true,
        onSelect: () => onDialog('purge'),
      },
    );
  }

  const buttons =
    can.decide || can.claim || can.unclaim || can.requestInfo || can.reopen || menu.length > 0;
  if (!buttons) return null;

  return (
    <div className="applications-review-actions">
      {can.decide ? (
        <>
          <Button tone="primary" icon="check-circle" onClick={() => onDialog('accept')}>
            Accept…
          </Button>
          <Button icon="prohibit" onClick={() => onDialog('reject')}>
            Reject…
          </Button>
        </>
      ) : null}
      {can.claim ? (
        <Button
          busy={working === 'claim'}
          disabled={pending}
          onClick={() => onQuick({ action: 'claim' }, 'Couldn’t claim the application')}
        >
          Claim
        </Button>
      ) : null}
      {can.unclaim ? (
        <Button
          busy={working === 'unclaim'}
          disabled={pending}
          onClick={() => onQuick({ action: 'unclaim' }, 'Couldn’t release the claim')}
        >
          Unclaim
        </Button>
      ) : null}
      {can.requestInfo ? (
        <Button tone="ghost" icon="chat-centered-text" onClick={() => onDialog('info')}>
          Request information…
        </Button>
      ) : null}
      {can.reopen ? (
        <Button icon="shield-warning" onClick={() => onDialog('reopen')}>
          Reopen…
        </Button>
      ) : null}
      {menu.length > 0 ? <MenuButton label="More actions" actions={menu} size="md" /> : null}
      <AsyncOperationStatus phase={pending ? 'working' : 'idle'} workingLabel={workingLabel} />
    </div>
  );
}

function FactsSection({
  guildId,
  detail,
  now,
}: {
  guildId: string;
  detail: ApplicationDetail;
  now: number;
}): ReactElement {
  const { application } = detail;
  const interview = application.interview;
  const ticketUrl =
    interview === null || interview.channelId === null
      ? null
      : `https://discord.com/channels/${guildId}/${interview.channelId}`;

  return (
    <Section label="Details">
      <Rows className="applications-review-facts">
        <Pairs>
          <Pair label="Applicant">
            <ApplicantCell id={application.applicantId} name={application.applicantName} />
          </Pair>
          <Pair label="Form">{application.formName}</Pair>
          <Pair label="Submitted">
            <When at={application.submittedAt} now={now} />
          </Pair>
          <Pair label="Assigned to">
            <MemberCell userId={application.assigneeId} fallback="Nobody" />
          </Pair>
          {application.decidedAt !== null ? (
            <Pair label="Decided by">
              <span className="inline inline-6 inline-wrap">
                {application.decidedBy !== null ? <Actor id={application.decidedBy} /> : null}
                <When at={application.decidedAt} now={now} />
              </span>
            </Pair>
          ) : null}
          {interview !== null ? (
            <Pair label="Interview">
              {ticketUrl !== null ? (
                <External href={ticketUrl}>Open ticket channel</External>
              ) : (
                <span className="text-muted">Asked for, not opened yet</span>
              )}
            </Pair>
          ) : null}
          {application.cardUrl !== null ? (
            <Pair label="Review card">
              <External href={application.cardUrl}>Open in Discord</External>
            </Pair>
          ) : null}
          <Pair label="Reference">
            <span className="mono text-xs">{application.id}</span>
          </Pair>
        </Pairs>
      </Rows>
    </Section>
  );
}

function VotesSection({
  detail,
  now,
}: {
  detail: ApplicationDetail;
  now: number;
}): ReactElement | null {
  const votes = detail.votes;
  if (votes === null) return null;
  if (votes.length === 0 && !detail.twoReviewers && !detail.scoring) return null;

  const tally = voteLine({
    accept: votes.filter((vote) => vote.vote === 'accept').length,
    reject: votes.filter((vote) => vote.vote === 'reject').length,
  });
  const average = detail.scoring ? averageScore(votes) : null;

  return (
    <Section label="Votes" note={tally ?? undefined}>
      {votes.length === 0 ? (
        <p className="text-sm text-muted">Nobody has voted yet.</p>
      ) : (
        <Rows className="applications-review-votes">
          {votes.map((vote) => (
            <div key={vote.reviewerId} className="applications-review-vote">
              <Actor id={vote.reviewerId} />
              <Badge tone={vote.vote === 'accept' ? 'success' : 'neutral'}>
                {vote.vote === 'accept' ? 'Accept' : 'Reject'}
              </Badge>
              {vote.score !== null ? (
                <span className="text-sm text-secondary">Score {vote.score} / 5</span>
              ) : null}
              <span className="applications-review-vote-when text-xs text-muted">
                <When at={vote.updatedAt} now={now} />
              </span>
            </div>
          ))}
        </Rows>
      )}
      {average !== null ? (
        <p className="text-sm text-secondary applications-review-average">
          Average score {average} / 5
        </p>
      ) : null}
    </Section>
  );
}

function NotesSection({
  guildId,
  detail,
  now,
  canNote,
  onDone,
}: {
  guildId: string;
  detail: ApplicationDetail;
  now: number;
  canNote: boolean;
  onDone: (outcome: Outcome) => void;
}): ReactElement | null {
  const notes = detail.notes;
  if (notes === null) return null;

  return (
    <Section label="Internal notes" note="Only staff see this">
      {notes.length === 0 ? (
        <p className="text-sm text-muted">No notes yet.</p>
      ) : (
        <ol className="rows applications-review-notes">
          {notes.map((note) => (
            <li key={note.id} className="applications-review-message">
              <p className="applications-review-message-head">
                <Actor id={note.authorId} />
                <MetaSeparator />
                <When at={note.createdAt} now={now} />
              </p>
              {note.body === null ? (
                <p className="applications-review-message-body text-muted">
                  This note was removed with the answers.
                </p>
              ) : (
                <p className="applications-review-message-body">{note.body}</p>
              )}
            </li>
          ))}
        </ol>
      )}
      {canNote ? (
        <NoteForm guildId={guildId} applicationId={detail.application.id} onDone={onDone} />
      ) : null}
    </Section>
  );
}

function caseLabel(type: string): string {
  const words = type.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ModerationSection({
  detail,
  now,
}: {
  detail: ApplicationDetail;
  now: number;
}): ReactElement | null {
  const moderation = detail.moderation;
  if (moderation === null) return null;

  return (
    <Section label="Moderation history" help={MODERATION_HELP}>
      <Rows className="applications-review-facts">
        <Pairs>
          <Pair label="Active cases">{moderation.activeCases}</Pair>
          <Pair label="Recent cases">
            {moderation.recent.length === 0 ? (
              <span className="text-muted">None in this server</span>
            ) : (
              <span className="stack stack-6">
                {moderation.recent.map((entry) => (
                  <span key={entry.caseNumber} className="applications-review-case">
                    <span>
                      #{entry.caseNumber} {caseLabel(entry.type)}
                    </span>
                    <MetaSeparator />
                    <When at={entry.createdAt} now={now} />
                    {entry.reason !== null ? (
                      <span className="applications-review-case-reason">{entry.reason}</span>
                    ) : null}
                  </span>
                ))}
              </span>
            )}
          </Pair>
        </Pairs>
      </Rows>
    </Section>
  );
}

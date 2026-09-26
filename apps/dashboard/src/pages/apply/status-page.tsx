import { INFO_RESPONSE_MAX } from '@proton/module-applications/constants';
import type { PortalApplication } from '@proton/module-applications/view';
import { referenceOf, statusSentence } from '@proton/module-applications/web';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { useId, useRef, useState } from 'react';
import { Button, TextArea } from '../../components/ui/controls.tsx';
import { LoadingArea, StatusBanner } from '../../components/ui/feedback.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Pair, Pairs } from '../../components/ui/layout.tsx';
import { ConfirmDialog } from '../../components/ui/overlay.tsx';
import { saveFailure } from '../../lib/errors.ts';
import {
  type ApplicationStatusView,
  type ApplyResult,
  respondToApplication,
  withdrawApplication,
} from '../../server/apply.ts';
import { newRequestId } from './autosave.ts';
import {
  ApplyFrame,
  ApplyHead,
  applicationStatusQuery,
  applyKeys,
  BackToMine,
  DateText,
  QueryFailure,
  RefusalNotice,
  StatusBadge,
} from './shared.tsx';

type ThreadEntry = PortalApplication['thread'][number];

interface Notice {
  tone: 'success' | 'danger';
  text: string;
}

const ENTRY_KINDS: Readonly<Record<ThreadEntry['kind'], string>> = {
  info_request: 'asked for more information',
  info_response: 'answered',
  decision: 'decision',
};

function titleOf(application: PortalApplication): string {
  const reference = referenceOf(application.number);
  return reference === '' ? application.formName : `${application.formName} ${reference}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function ApplicationStatusPage({
  guildId,
  applicationId,
}: {
  guildId: string;
  applicationId: string;
}): ReactElement {
  const query = useQuery(applicationStatusQuery(guildId, applicationId));

  if (query.data?.ok === true) {
    return (
      <StatusView key={`${guildId}:${applicationId}`} guildId={guildId} view={query.data.value} />
    );
  }

  let body: ReactNode;
  if (query.isError) {
    body = (
      <QueryFailure
        error={query.error}
        what="this application"
        onRetry={() => void query.refetch()}
      />
    );
  } else if (query.data?.ok === false) {
    body = <RefusalNotice refusal={query.data} onRetry={() => void query.refetch()} />;
  } else {
    body = <LoadingArea label="Loading your application" minHeight={320} />;
  }

  return (
    <ApplyFrame>
      <ApplyHead back={<BackToMine />} title="Your application" />
      {body}
    </ApplyFrame>
  );
}

function StatusView({
  guildId,
  view,
}: {
  guildId: string;
  view: ApplicationStatusView;
}): ReactElement {
  const queryClient = useQueryClient();
  const { application, server } = view;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [withdrawing, setWithdrawing] = useState<'closed' | 'asking' | 'working'>('closed');
  const withdrawId = useRef<string | null>(null);

  const purged = application.answers === null;
  const request = application.thread.findLast((entry) => entry.kind === 'info_request');

  const update = (next: PortalApplication): void => {
    const data: ApplyResult<ApplicationStatusView> = {
      ok: true,
      value: { application: next, server },
    };
    queryClient.setQueryData(applyKeys.application(guildId, application.id), data);
    void queryClient.invalidateQueries({ queryKey: applyKeys.mine() });
    void queryClient.invalidateQueries({ queryKey: applyKeys.server(guildId) });
  };

  const settle = (result: ApplyResult<PortalApplication>, success: string): void => {
    if (result.ok) {
      update(result.value);
      setNotice({ tone: 'success', text: success });
      return;
    }

    setNotice({ tone: 'danger', text: result.message });
    if (result.kind === 'changed') {
      void queryClient.invalidateQueries({
        queryKey: applyKeys.application(guildId, application.id),
      });
    }
  };

  const withdraw = async (): Promise<void> => {
    setWithdrawing('working');
    setNotice(null);
    withdrawId.current ??= newRequestId();

    let result: ApplyResult<PortalApplication>;
    try {
      result = await withdrawApplication({
        data: { guildId, applicationId: application.id, requestId: withdrawId.current },
      });
    } catch (error) {
      setWithdrawing('closed');
      setNotice({
        tone: 'danger',
        text: saveFailure(asError(error), 'Your application wasn’t withdrawn'),
      });
      return;
    }

    if (result.ok || result.kind !== 'unavailable') withdrawId.current = null;
    setWithdrawing('closed');
    settle(result, 'You withdrew this application. Staff won’t review it any more.');
  };

  return (
    <ApplyFrame>
      <ApplyHead
        back={<BackToMine />}
        server={server}
        title={titleOf(application)}
        badge={<StatusBadge status={application.status} />}
        lede={statusSentence(application.status)}
      />

      {notice !== null ? (
        <StatusBanner
          tone={notice.tone}
          live={notice.tone === 'danger' ? 'assertive' : 'polite'}
          onDismiss={() => setNotice(null)}
        >
          {notice.text}
        </StatusBanner>
      ) : null}

      {application.canRespond ? (
        <RespondForm
          guildId={guildId}
          application={application}
          request={request}
          onAnswered={(result) => settle(result, 'Your answer was sent. Staff can read it now.')}
        />
      ) : null}

      <section className="apply-block" aria-labelledby="apply-details-title">
        <h2 className="apply-block-title" id="apply-details-title">
          Details
        </h2>
        <div className="apply-details">
          <Pairs>
            <Pair label="Reference">{referenceOf(application.number) || 'None'}</Pair>
            <Pair label="Status">
              <StatusBadge status={application.status} />
            </Pair>
            <Pair label="Sent">
              {application.submittedAt !== null ? (
                <DateText at={application.submittedAt} time />
              ) : (
                'Not sent'
              )}
            </Pair>
            {application.decidedAt !== null ? (
              <Pair label="Decided">
                <DateText at={application.decidedAt} time />
              </Pair>
            ) : null}
            {application.decisionReason !== null && application.decisionReason !== '' ? (
              <Pair label="Reason">
                <span className="apply-plain">{application.decisionReason}</span>
              </Pair>
            ) : null}
          </Pairs>
        </div>
        <p className="apply-updates">
          <Icon name="chat-centered-text" size={16} className="apply-fact-icon" />
          <span>Check this page for updates. Proton also DMs you if your DMs are open.</span>
        </p>
      </section>

      {application.thread.length > 0 ? (
        <section className="apply-block" aria-labelledby="apply-thread-title">
          <h2 className="apply-block-title" id="apply-thread-title">
            Messages
          </h2>
          <ol className="apply-thread">
            {application.thread.map((entry) => {
              const yours = entry.kind === 'info_response';

              return (
                <li key={entry.id} className="apply-entry" data-from={yours ? 'you' : 'staff'}>
                  <p className="apply-entry-meta">
                    <strong>{yours ? 'You' : 'Staff'}</strong>
                    <span>{ENTRY_KINDS[entry.kind]}</span>
                    <DateText at={entry.createdAt} time />
                  </p>
                  {entry.body !== null && entry.body !== '' ? (
                    <p className="apply-plain">{entry.body}</p>
                  ) : (
                    <p className="text-muted">
                      {purged ? 'Deleted along with your answers.' : 'No message.'}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      <section className="apply-block" aria-labelledby="apply-answers-title">
        <h2 className="apply-block-title" id="apply-answers-title">
          Your answers
        </h2>
        {application.answers === null ? (
          <p className="apply-block-note">
            Your answers were deleted after this server’s keep-for period. The reference, status and
            dates stay.
          </p>
        ) : application.answers.length === 0 ? (
          <p className="apply-block-note">This application was sent without answers.</p>
        ) : (
          <dl className="apply-answers">
            {application.answers.map((answer) => (
              <div className="apply-answer" key={answer.questionId}>
                <dt>{answer.label}</dt>
                <dd className="apply-plain">{answer.display}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <div className="apply-footer-links">
        <Link to="/apply/$guildId" params={{ guildId }} className="apply-link">
          Forms in this server
        </Link>
        {application.canWithdraw ? (
          <Button tone="danger-quiet" onClick={() => setWithdrawing('asking')}>
            Withdraw application…
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={withdrawing !== 'closed'}
        onClose={() => setWithdrawing('closed')}
        onConfirm={() => void withdraw()}
        title="Withdraw your application?"
        confirmLabel="Withdraw application"
        danger
        busy={withdrawing === 'working'}
        dismissible={withdrawing !== 'working'}
      >
        Staff stop reviewing {titleOf(application)}, and you can’t undo this. You can apply again
        later if the form is open.
      </ConfirmDialog>
    </ApplyFrame>
  );
}

function RespondForm({
  guildId,
  application,
  request,
  onAnswered,
}: {
  guildId: string;
  application: PortalApplication;
  request: ThreadEntry | undefined;
  onAnswered: (result: ApplyResult<PortalApplication>) => void;
}): ReactElement {
  const id = useId();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);

  const send = async (): Promise<void> => {
    const message = text.trim();
    if (message === '') {
      setProblem('Write an answer before you send it.');
      return;
    }

    setSending(true);
    setProblem(null);
    requestId.current ??= newRequestId();

    let result: ApplyResult<PortalApplication>;
    try {
      result = await respondToApplication({
        data: {
          guildId,
          applicationId: application.id,
          message,
          requestId: requestId.current,
        },
      });
    } catch (error) {
      setSending(false);
      setProblem(saveFailure(asError(error), 'Your answer wasn’t sent'));
      return;
    }

    setSending(false);
    if (!result.ok && result.kind === 'unavailable') {
      setProblem(result.message);
      return;
    }

    requestId.current = null;
    if (result.ok) setText('');
    onAnswered(result);
  };

  return (
    <section className="apply-block apply-respond" aria-labelledby={`${id}-title`}>
      <h2 className="apply-block-title" id={`${id}-title`}>
        We need a little more information.
      </h2>

      {request !== undefined && request.body !== null && request.body !== '' ? (
        <blockquote className="apply-quote">
          <p className="apply-entry-meta">
            <strong>Staff</strong>
            <span>asked</span>
            <DateText at={request.createdAt} time />
          </p>
          <p className="apply-plain">{request.body}</p>
        </blockquote>
      ) : null}

      <form
        className="apply-respond-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="apply-question-label" htmlFor={`${id}-answer`}>
          Your answer
        </label>
        <TextArea
          id={`${id}-answer`}
          rows={6}
          maxLength={INFO_RESPONSE_MAX}
          value={text}
          invalid={problem !== null}
          aria-describedby={`${id}-hint${problem !== null ? ` ${id}-problem` : ''}`}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <p className="field-hint apply-question-count" id={`${id}-hint`}>
          <span>Staff read this with your application. You can’t edit it after you send it.</span>
          <span className="apply-counter">
            {text.length} / {INFO_RESPONSE_MAX}
          </span>
        </p>
        {problem !== null ? (
          <p className="field-error" id={`${id}-problem`} role="alert">
            {problem}
          </p>
        ) : null}
        <div>
          <Button tone="primary" size="lg" type="submit" busy={sending}>
            Send answer
          </Button>
        </div>
      </form>
    </section>
  );
}

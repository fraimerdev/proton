import type { FlatQuestion, Section } from '@proton/module-applications/config';
import {
  type AnswerProblem,
  answerOf,
  checkAnswer,
  checkAnswers,
  type DraftAnswers,
  pruneHidden,
  type RawAnswer,
  visibleQuestions,
} from '@proton/module-applications/questions';
import type { PortalForm } from '@proton/module-applications/view';
import { referenceOf, STATUS_LABELS } from '@proton/module-applications/web';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker } from '@tanstack/react-router';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/controls.tsx';
import { AsyncOperationStatus, LoadingArea, StatusBanner } from '../../components/ui/feedback.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { ConfirmDialog } from '../../components/ui/overlay.tsx';
import { saveFailure } from '../../lib/errors.ts';
import {
  type ApplyRefusal,
  discardApplyDraft,
  type SaveDraftOutcome,
  type SubmitOutcome,
  saveApplyDraft,
  submitApplyForm,
} from '../../server/apply.ts';
import {
  cleanAnswers,
  type DraftState,
  hasUnsaved,
  newRequestId,
  problemsOffPage,
  refreshesForm,
  type ServerDraft,
  saveIndicator,
  useDraftAutosave,
} from './autosave.ts';
import { QuestionInput, questionAnchor } from './question-input.tsx';
import {
  ApplyFrame,
  ApplyHead,
  applyFormQuery,
  applyKeys,
  BackToMine,
  BackToServer,
  DateText,
  ProseText,
  QueryFailure,
  RefusalNotice,
} from './shared.tsx';

type Step = 'form' | 'review';

interface Sent {
  applicationId: string;
  number: number;
}

interface Notice {
  tone: 'danger' | 'warning' | 'info';
  text: string;
}

const LOCKED_REASONS: ReadonlySet<string> = new Set(['module_off', 'archived', 'not_published']);

const UNSENT = 'Your latest answers couldn’t be saved, so nothing was sent. Try again in a moment.';

const CLEARED =
  'These answers were already sent or cleared, maybe on another device. Check your applications ' +
  'to see where things stand.';

const FORM_CHANGED =
  'This form was updated since you opened it, so some of its questions changed. Check your ' +
  'answers, then send it again.';

function draftOf(draft: PortalForm['draft']): ServerDraft | null {
  return draft === null
    ? null
    : { revision: draft.revision, answers: draft.answers, updatedAt: draft.updatedAt };
}

function problemFor(
  question: FlatQuestion,
  value: RawAnswer | undefined,
  strict: boolean,
): string | null {
  const result = checkAnswer(question, value);
  if (!result.ok) return result.message;
  if (strict && question.required && result.value === null) {
    return `“${question.label}” needs an answer.`;
  }
  return null;
}

function problemLine(problem: AnswerProblem): string {
  return problem.message.includes(`“${problem.label}”`)
    ? problem.message
    : `${problem.label}: ${problem.message}`;
}

function focusQuestion(questionId: string): void {
  const wrapper = document.getElementById(questionAnchor(questionId));
  if (wrapper === null) return;

  wrapper.scrollIntoView({ block: 'center' });
  wrapper
    .querySelector<HTMLElement>(
      'input:not(:disabled), textarea:not(:disabled), button:not(:disabled)',
    )
    ?.focus({ preventScroll: true });
}

export function ApplyFormPage({
  guildId,
  formId,
}: {
  guildId: string;
  formId: string;
}): ReactElement {
  const query = useQuery(applyFormQuery(guildId, formId));
  const held = useRef<PortalForm | null>(null);

  const fresh = query.data?.ok === true ? query.data.value : null;
  if (fresh !== null) held.current = fresh;
  const kept = held.current;
  const portal =
    fresh ?? (kept !== null && kept.guild.id === guildId && kept.form.id === formId ? kept : null);

  if (portal !== null) {
    return (
      <FormView
        key={`${guildId}:${formId}`}
        guildId={guildId}
        formId={formId}
        portal={portal}
        refusal={query.data?.ok === false ? query.data : null}
      />
    );
  }

  let body: ReactNode;
  if (query.isError) {
    body = (
      <QueryFailure error={query.error} what="this form" onRetry={() => void query.refetch()} />
    );
  } else if (query.data?.ok === false) {
    body = <RefusalNotice refusal={query.data} onRetry={() => void query.refetch()} />;
  } else {
    body = <LoadingArea label="Loading this form" minHeight={320} />;
  }

  return (
    <ApplyFrame>
      <ApplyHead back={<BackToMine />} title="Apply" />
      {body}
    </ApplyFrame>
  );
}

function FormView({
  guildId,
  formId,
  portal,
  refusal,
}: {
  guildId: string;
  formId: string;
  portal: PortalForm;
  refusal: ApplyRefusal | null;
}): ReactElement {
  const queryClient = useQueryClient();
  const { form, guild, intake, eligibility } = portal;
  const sections = form.sections;

  const outgoing = useCallback(
    (answers: DraftAnswers) => cleanAnswers(pruneHidden(sections, answers)),
    [sections],
  );

  const versionId = portal.versionId;
  const refetchForm = useCallback(
    () => queryClient.invalidateQueries({ queryKey: applyKeys.form(guildId, formId) }),
    [queryClient, guildId, formId],
  );

  const { state, actions } = useDraftAutosave({
    initial: draftOf(portal.draft),
    outgoing,
    save: async (request) => {
      const outcome = await saveApplyDraft({ data: { guildId, formId, versionId, ...request } });
      if (refreshesForm(outcome)) void refetchForm();
      return outcome;
    },
  });

  const [step, setStep] = useState<Step>('form');
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [summaryShown, setSummaryShown] = useState(false);
  const [summaryPing, setSummaryPing] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [another, setAnother] = useState(false);
  const [sending, setSending] = useState(false);
  const [restart, setRestart] = useState<'closed' | 'asking' | 'working'>('closed');
  const submitId = useRef<string | null>(null);
  const summary = useRef<HTMLDivElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const sentHeading = useRef<HTMLHeadingElement>(null);

  const serverDraft = portal.draft;
  useEffect(() => {
    actions.adopt(draftOf(serverDraft));
  }, [actions, serverDraft]);

  const answers = state.answers;
  const visible = useMemo(() => visibleQuestions(sections, answers), [sections, answers]);
  const visibleIds = useMemo(() => new Set(visible.map((question) => question.id)), [visible]);

  const locked = intake.state === 'closed' && LOCKED_REASONS.has(intake.reason);
  const hasDraft = state.revision !== null || portal.draft !== null;
  const canStart = intake.state === 'open' && eligibility.state === 'eligible';
  const alreadyApplied = portal.active.length > 0 && !hasDraft && !another;
  const editable = !locked && (hasDraft || (canStart && !alreadyApplied));
  const conflict = state.phase === 'conflict';

  const sendBlock =
    intake.state === 'closed'
      ? portal.intakeSentence
      : eligibility.state === 'ineligible'
        ? 'You don’t meet every requirement for this form yet, so you can’t send it.'
        : eligibility.state === 'blocked'
          ? 'Proton can’t check every requirement right now, so you can’t send this yet. Try again later.'
          : conflict
            ? 'Choose which answers to keep before you send them.'
            : null;

  const unsaved = sent === null && editable && hasUnsaved(state, outgoing(answers));

  const blocker = useBlocker({
    shouldBlockFn: () => {
      actions.commit();
      return true;
    },
    disabled: !unsaved,
    enableBeforeUnload: false,
    withResolver: true,
  });

  useEffect(() => {
    if (blocker.status === 'blocked' && !unsaved) blocker.proceed();
  }, [blocker, unsaved]);

  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  useEffect(() => {
    if (summaryPing === 0) return;
    summary.current?.focus({ preventScroll: true });
    summary.current?.scrollIntoView({ block: 'center' });
  }, [summaryPing]);

  useEffect(() => {
    if (step !== 'review') return;
    reviewHeading.current?.focus({ preventScroll: true });
    reviewHeading.current?.scrollIntoView({ block: 'start' });
  }, [step]);

  useEffect(() => {
    if (step !== 'form' || editing === null) return;
    const first = visible.find((question) => question.sectionId === editing);
    if (first !== undefined) focusQuestion(first.id);
    setEditing(null);
  }, [step, editing, visible]);

  useEffect(() => {
    if (sent === null) return;
    sentHeading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [sent]);

  const setProblem = (question: FlatQuestion, value: RawAnswer | undefined): void => {
    setErrors((current) => {
      const problem = problemFor(question, value, current.has(question.id));
      if (problem === null && !current.has(question.id)) return current;

      const next = new Map(current);
      if (problem === null) next.delete(question.id);
      else next.set(question.id, problem);
      return next;
    });
  };

  const change = (question: FlatQuestion, value: RawAnswer | undefined): void => {
    actions.setAnswers((current) => {
      const next = { ...current };
      if (value === undefined) delete next[question.id];
      else next[question.id] = value;
      return next;
    });

    const choice =
      question.type === 'single' || question.type === 'multiple' || question.type === 'confirm';
    if (choice || errors.has(question.id)) setProblem(question, value);
  };

  const blurred = (question: FlatQuestion): void => {
    actions.commit();
    setProblem(question, answerOf(state.answers, question.id));
  };

  const showProblems = (problems: readonly AnswerProblem[]): void => {
    setErrors(new Map(problems.map((problem) => [problem.questionId, problem.message])));
    setSummaryShown(true);
    setStep('form');
    setSummaryPing((ping) => ping + 1);
  };

  const review = (): void => {
    setNotice(null);
    const checked = checkAnswers(sections, answers, { partial: false });
    if (!checked.ok) {
      showProblems(checked.problems);
      return;
    }

    setErrors(new Map());
    setSummaryShown(false);
    actions.commit();
    setStep('review');
  };

  // Every question can be optional and left blank, and a form is only sent from a saved draft.
  const startEmptyDraft = (): Promise<SaveDraftOutcome> =>
    saveApplyDraft({
      data: {
        guildId,
        formId,
        versionId,
        answers: {},
        expectedRevision: null,
        requestId: newRequestId(),
      },
    }).catch((error: unknown) => ({
      status: 'failed' as const,
      message: error instanceof Error ? error.message : String(error),
    }));

  const send = async (): Promise<void> => {
    setSending(true);
    setNotice(null);

    const saved = await actions.flush();
    if (saved.phase === 'conflict' || saved.phase === 'refused') {
      setSending(false);
      return;
    }

    let revision = saved.phase === 'saved' ? saved.revision : null;
    if (saved.phase === 'saved' && revision === null) {
      const started = await startEmptyDraft();
      if (started.status === 'saved') {
        revision = started.revision;
        actions.adopt({ revision, answers: {}, updatedAt: started.savedAt });
      } else if (started.status === 'refused') {
        setSending(false);
        setNotice({ tone: 'danger', text: started.message });
        void refetchForm();
        return;
      }
    }

    if (revision === null) {
      setSending(false);
      setNotice({ tone: 'danger', text: UNSENT });
      return;
    }

    submitId.current ??= newRequestId();
    let outcome: SubmitOutcome;
    try {
      outcome = await submitApplyForm({
        data: { guildId, formId, expectedRevision: revision, requestId: submitId.current },
      });
    } catch (error) {
      setSending(false);
      setNotice({
        tone: 'danger',
        text: saveFailure(
          error instanceof Error ? error : new Error(String(error)),
          'Your application wasn’t sent',
        ),
      });
      return;
    }

    if (outcome.status !== 'failed') submitId.current = null;

    switch (outcome.status) {
      case 'submitted':
        setSent({ applicationId: outcome.applicationId, number: outcome.number });
        void queryClient.invalidateQueries({ queryKey: applyKeys.all() });
        break;

      case 'invalid':
        showProblems(outcome.problems);
        if (problemsOffPage(outcome.problems, visibleIds)) {
          setNotice({ tone: 'warning', text: FORM_CHANGED });
          void refetchForm();
        }
        break;

      case 'conflict': {
        const latest = await queryClient
          .fetchQuery({ ...applyFormQuery(guildId, formId), staleTime: 0 })
          .catch(() => null);
        const draft = latest?.ok === true ? draftOf(latest.value.draft) : null;

        if (draft === null) setNotice({ tone: 'warning', text: CLEARED });
        else actions.conflict(draft);
        break;
      }

      case 'refused':
        setNotice({ tone: 'danger', text: outcome.message });
        void refetchForm();
        break;

      case 'failed':
        setNotice({ tone: 'danger', text: outcome.message });
        break;
    }

    setSending(false);
  };

  const startAgain = async (): Promise<void> => {
    setRestart('working');

    const result = await discardApplyDraft({
      data: { guildId, formId, requestId: newRequestId() },
    }).catch((error: unknown) => ({
      ok: false as const,
      message: saveFailure(
        error instanceof Error ? error : new Error(String(error)),
        'Couldn’t start again',
      ),
    }));

    if (!result.ok) {
      setRestart('closed');
      setNotice({ tone: 'danger', text: result.message });
      return;
    }

    actions.reset(null);
    setErrors(new Map());
    setSummaryShown(false);
    setStep('form');
    await queryClient.invalidateQueries({ queryKey: applyKeys.form(guildId, formId) });
    setRestart('closed');
  };

  const shownProblems = [...errors]
    .filter(([id]) => visibleIds.has(id))
    .map(([questionId, message]) => ({
      questionId,
      message,
      label: visible.find((question) => question.id === questionId)?.label ?? '',
    }));

  const title = (
    <>
      {form.emoji?.name !== undefined && form.emoji.id === undefined ? (
        <span className="apply-emoji" aria-hidden>
          {form.emoji.name}
        </span>
      ) : null}
      {form.name}
    </>
  );

  return (
    <ApplyFrame>
      <ApplyHead
        back={<BackToServer guildId={guildId} name={guild.name} />}
        title={title}
        lede={sent === null ? form.description : undefined}
      />

      {sent !== null ? (
        <SentView
          guildId={guildId}
          sent={sent}
          confirmation={form.confirmation}
          heading={sentHeading}
        />
      ) : (
        <>
          <div className="apply-banners">
            {refusal !== null ? (
              <StatusBanner tone="warning" live="polite" title="Couldn’t refresh this form">
                {refusal.message}
              </StatusBanner>
            ) : null}

            {intake.state === 'closed' ? (
              <StatusBanner tone={locked ? 'neutral' : 'info'}>
                {portal.intakeSentence}
                {hasDraft
                  ? locked
                    ? ' Your saved answers are kept.'
                    : ' Your answers are saved, so you can send them once it opens again.'
                  : ''}
              </StatusBanner>
            ) : null}

            {alreadyApplied ? (
              <StatusBanner
                tone="info"
                title="You’ve already applied"
                actions={
                  canStart ? (
                    <Button size="sm" onClick={() => setAnother(true)}>
                      Start another application
                    </Button>
                  ) : undefined
                }
              >
                <ul className="apply-active">
                  {portal.active.map((application) => (
                    <li key={application.id}>
                      <Link
                        to="/applications/$guildId/$applicationId"
                        params={{ guildId, applicationId: application.id }}
                        className="apply-link"
                      >
                        {application.number !== null
                          ? `Application ${referenceOf(application.number)}`
                          : 'Your application'}
                      </Link>{' '}
                      · {STATUS_LABELS[application.status]}
                    </li>
                  ))}
                </ul>
              </StatusBanner>
            ) : null}

            {portal.draft?.stale === true && state.revision !== null ? (
              <StatusBanner
                tone="info"
                title="This form was updated after you started"
                actions={
                  <Button size="sm" onClick={() => setRestart('asking')}>
                    Start again…
                  </Button>
                }
              >
                You’re answering the version you started, and you can still send it. Start again to
                answer the new version instead.
              </StatusBanner>
            ) : null}

            {conflict && state.newer !== null ? (
              <StatusBanner
                tone="warning"
                live="assertive"
                title="These answers changed on another device."
                actions={
                  <>
                    <Button size="sm" tone="primary" onClick={actions.takeNewer}>
                      Use the newer answers
                    </Button>
                    <Button size="sm" onClick={actions.keepMine}>
                      Keep mine
                    </Button>
                  </>
                }
              >
                Different answers were saved <DateText at={state.newer.updatedAt} time />. Keep
                yours to replace them, or switch to the newer ones.
              </StatusBanner>
            ) : null}

            {state.phase === 'refused' && state.refusal !== null ? (
              <StatusBanner
                tone="danger"
                live="assertive"
                title={state.retryable ? undefined : 'Your latest answers weren’t saved'}
                actions={
                  state.retryable || state.revision === null ? (
                    <Button size="sm" onClick={actions.retry}>
                      Try again
                    </Button>
                  ) : (
                    <Button size="sm" onClick={actions.startOver}>
                      Save them as a new draft
                    </Button>
                  )
                }
              >
                {state.refusal}
              </StatusBanner>
            ) : null}

            {notice !== null ? (
              <StatusBanner
                tone={notice.tone}
                live="assertive"
                onDismiss={() => setNotice(null)}
                actions={
                  notice.text === CLEARED ? (
                    <Link to="/apply" className="button button-secondary button-sm">
                      Your applications
                    </Link>
                  ) : undefined
                }
              >
                {notice.text}
              </StatusBanner>
            ) : null}
          </div>

          {step === 'form' ? <Overview portal={portal} /> : null}

          {editable && step === 'form' ? (
            <form
              className="apply-form"
              noValidate
              aria-label={`Answers for ${form.name}`}
              onSubmit={(event) => event.preventDefault()}
            >
              <p className="apply-form-note">
                Questions marked <span aria-hidden="true">*</span>
                <span className="visually-hidden">with an asterisk</span> need an answer. Proton
                saves your answers as you go, so you can come back later.
              </p>

              {summaryShown && shownProblems.length > 0 ? (
                <div className="apply-problems" ref={summary} tabIndex={-1} role="alert">
                  <p className="apply-problems-title">
                    {shownProblems.length === 1
                      ? 'One answer needs fixing'
                      : `${shownProblems.length} answers need fixing`}
                  </p>
                  <ul>
                    {shownProblems.map((problem) => (
                      <li key={problem.questionId}>
                        <a
                          href={`#${questionAnchor(problem.questionId)}`}
                          className="apply-link"
                          onClick={(event) => {
                            event.preventDefault();
                            focusQuestion(problem.questionId);
                          }}
                        >
                          {problemLine(problem)}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {sections.map((section) => (
                <FormSection
                  key={section.id}
                  section={section}
                  visible={visible}
                  answers={answers}
                  errors={errors}
                  onChange={change}
                  onBlur={blurred}
                />
              ))}
            </form>
          ) : null}

          {editable && step === 'review' ? (
            <ReviewAnswers
              sections={sections}
              visible={visible}
              answers={answers}
              heading={reviewHeading}
              onEdit={(sectionId) => {
                setStep('form');
                setEditing(sectionId);
              }}
            />
          ) : null}

          {editable ? (
            <ActionBar
              step={step}
              state={state}
              sending={sending}
              sendBlock={sendBlock}
              onReview={review}
              onBack={() => {
                setStep('form');
                setEditing(visible[0]?.sectionId ?? null);
              }}
              onSend={() => void send()}
            />
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={restart !== 'closed'}
        onClose={() => setRestart('closed')}
        onConfirm={() => void startAgain()}
        title="Start again?"
        confirmLabel="Start again"
        danger
        busy={restart === 'working'}
        dismissible={restart !== 'working'}
      >
        Your saved answers for this form are deleted, and you answer the latest version from the
        start.
      </ConfirmDialog>

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
        title="Leave before your answers are saved?"
        confirmLabel="Leave anyway"
        danger
      >
        Proton hasn’t saved your latest answers yet. If you leave now, those changes are lost.
      </ConfirmDialog>
    </ApplyFrame>
  );
}

function Overview({ portal }: { portal: PortalForm }): ReactElement {
  const { form, intake, eligibility } = portal;
  const issues = eligibility.state === 'blocked' ? eligibility.issues : [];
  const reasons = [...new Set(issues.map((issue) => issue.humanReason))];

  return (
    <div className="apply-overview">
      <ProseText text={form.intro} className="apply-intro" />

      <ul className="apply-facts">
        {intake.state === 'open' && intake.closesAt !== undefined ? (
          <li>
            <Icon name="alarm" size={16} className="apply-fact-icon" />
            <span>
              Apply by <DateText at={intake.closesAt} time />
            </span>
          </li>
        ) : null}
        <li>
          <Icon name="lock" size={16} className="apply-fact-icon" />
          <span>{portal.whoCanRead}</span>
        </li>
      </ul>

      {eligibility.lines.length > 0 ? (
        <section className="apply-block" aria-labelledby="apply-who-title">
          <h2 className="apply-block-title" id="apply-who-title">
            Who can apply?
          </h2>
          <ul className="apply-requirements">
            {eligibility.lines.map((line) => (
              <li
                key={line.id}
                className="apply-requirement"
                data-passed={line.passed === null ? 'unknown' : String(line.passed)}
              >
                <Icon
                  name={
                    line.passed === true ? 'check-circle' : line.passed === false ? 'x' : 'question'
                  }
                  size={16}
                  weight="fill"
                  className="apply-requirement-icon"
                />
                <span className="apply-requirement-text">{line.text}</span>
                <span className="apply-requirement-state">
                  {line.passed === true ? 'Met' : line.passed === false ? 'Not met' : 'Not checked'}
                </span>
              </li>
            ))}
          </ul>

          {eligibility.state === 'ineligible' ? (
            <p className="apply-block-note">
              You don’t meet every requirement yet, so you can’t apply right now.
            </p>
          ) : null}

          {eligibility.state === 'blocked' ? (
            <StatusBanner tone="warning" title="Proton can’t check every requirement right now">
              {reasons.join(' ')} Try again later, or let the server’s staff know.
            </StatusBanner>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function FormSection({
  section,
  visible,
  answers,
  errors,
  onChange,
  onBlur,
}: {
  section: Section;
  visible: readonly FlatQuestion[];
  answers: DraftAnswers;
  errors: ReadonlyMap<string, string>;
  onChange: (question: FlatQuestion, value: RawAnswer | undefined) => void;
  onBlur: (question: FlatQuestion) => void;
}): ReactElement | null {
  const shown = visible.filter((question) => question.sectionId === section.id);
  if (shown.length === 0) return null;

  return (
    <section
      className="apply-section"
      aria-label={section.title === '' ? undefined : section.title}
    >
      {section.title !== '' ? <h2 className="apply-section-title">{section.title}</h2> : null}
      <ProseText text={section.description} className="apply-section-description" />
      <div className="apply-questions">
        {shown.map((question) => (
          <QuestionInput
            key={question.id}
            question={question}
            value={answerOf(answers, question.id)}
            error={errors.get(question.id)}
            onChange={(value) => onChange(question, value)}
            onBlur={() => onBlur(question)}
          />
        ))}
      </div>
    </section>
  );
}

function ReviewAnswers({
  sections,
  visible,
  answers,
  heading,
  onEdit,
}: {
  sections: readonly Section[];
  visible: readonly FlatQuestion[];
  answers: DraftAnswers;
  heading: RefObject<HTMLHeadingElement | null>;
  onEdit: (sectionId: string) => void;
}): ReactElement {
  const checked = checkAnswers(sections, answers, { partial: true }).answers;
  const byId = new Map(checked.map((answer) => [answer.questionId, answer]));

  const groups = sections
    .map((section) => ({
      section,
      questions: visible.filter((question) => question.sectionId === section.id),
    }))
    .filter((group) => group.questions.length > 0);

  return (
    <section className="apply-review" aria-labelledby="apply-review-title">
      <h2 className="apply-block-title" id="apply-review-title" ref={heading} tabIndex={-1}>
        Check your answers
      </h2>
      <p className="apply-block-note">
        This is what staff will read. You can’t change your answers after you send them.
      </p>

      {groups.map(({ section, questions }, index) => {
        const name =
          section.title !== ''
            ? section.title
            : groups.length > 1
              ? `Part ${index + 1}`
              : 'Your answers';

        return (
          <div className="apply-review-group" key={section.id}>
            <div className="apply-review-head">
              <h3 className="apply-review-title">{name}</h3>
              <Button
                tone="ghost"
                size="sm"
                aria-label={`Edit ${name}`}
                onClick={() => onEdit(section.id)}
              >
                Edit
              </Button>
            </div>
            <dl className="apply-answers">
              {questions.map((question) => {
                const answer = byId.get(question.id);

                return (
                  <div className="apply-answer" key={question.id}>
                    <dt>{question.label}</dt>
                    <dd className={answer === undefined ? 'text-muted' : undefined}>
                      {answer?.display ?? 'Not answered'}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        );
      })}
    </section>
  );
}

function ActionBar({
  step,
  state,
  sending,
  sendBlock,
  onReview,
  onBack,
  onSend,
}: {
  step: Step;
  state: DraftState;
  sending: boolean;
  sendBlock: string | null;
  onReview: () => void;
  onBack: () => void;
  onSend: () => void;
}): ReactElement {
  const indicator = saveIndicator(state);
  const label = indicator.phase === 'idle' ? undefined : indicator.label;

  return (
    <div className="apply-bar">
      <div className="apply-bar-inner">
        <span className="apply-bar-status">
          <AsyncOperationStatus
            phase={indicator.phase}
            workingLabel={label}
            completedLabel={label}
            failedLabel={label}
          />
        </span>
        <div className="apply-bar-actions">
          {step === 'form' ? (
            <Button tone="primary" size="lg" onClick={onReview}>
              Review answers
            </Button>
          ) : (
            <>
              <Button size="lg" disabled={sending} onClick={onBack}>
                Back
              </Button>
              <Button
                tone="primary"
                size="lg"
                busy={sending}
                disabled={sendBlock !== null}
                onClick={onSend}
              >
                Send application
              </Button>
            </>
          )}
        </div>
      </div>
      {step === 'review' && sendBlock !== null ? (
        <p className="apply-bar-note">{sendBlock}</p>
      ) : null}
    </div>
  );
}

function SentView({
  guildId,
  sent,
  confirmation,
  heading,
}: {
  guildId: string;
  sent: Sent;
  confirmation: string;
  heading: RefObject<HTMLHeadingElement | null>;
}): ReactElement {
  return (
    <section className="apply-sent" aria-labelledby="apply-sent-title">
      <Icon name="check-circle" size={30} weight="fill" className="text-success motion-pop" />
      <h2 className="apply-sent-title" id="apply-sent-title" ref={heading} tabIndex={-1}>
        Your application has been sent.
      </h2>
      <p className="apply-sent-reference">
        Your reference is <strong>{referenceOf(sent.number)}</strong>.
      </p>
      <ProseText text={confirmation} />
      <p className="apply-sent-updates">
        You can check its status here at any time. Proton also DMs you if your DMs are open.
      </p>
      <div className="apply-sent-actions">
        <Link
          to="/applications/$guildId/$applicationId"
          params={{ guildId, applicationId: sent.applicationId }}
          className="button button-primary"
        >
          View your application
        </Link>
        <Link to="/apply" className="button button-secondary">
          Your applications
        </Link>
      </div>
    </section>
  );
}

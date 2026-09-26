import { INFO_REQUEST_MAX, NOTE_MAX, REASON_MAX } from '@proton/module-applications/constants';
import type {
  ApplicationDetail,
  QueueView,
  StaffActionResult,
} from '@proton/module-applications/view';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MemberPicker } from '../../components/discord/member-picker.tsx';
import {
  Button,
  Checkbox,
  Field,
  SegmentedControl,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import { AsyncOperationStatus, StatusBanner } from '../../components/ui/feedback.tsx';
import type { IconName } from '../../components/ui/icon.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import type { ApplicationActionRequest } from '../../server/applications.ts';
import {
  type ActionFailure,
  actionFailure,
  exportedLine,
  exportScope,
  filenameOf,
  isMemberId,
  readableOutcome,
  titleOf,
} from './labels.ts';
import { actOnApplicationMutation, deleteApplicantMutation, newRequestId } from './queries.ts';

export type Surface = 'module' | 'review';

export interface Outcome {
  tone: 'success' | 'warning' | 'danger';
  message: string;
}

const WAITING = <AsyncOperationStatus phase="working" workingLabel="Waiting for Proton…" />;

const AFTER_ACCEPT =
  'Proton then carries out this form’s actions for an accepted application, such as roles and ' +
  'the decision DM.';

const AFTER_REJECT =
  'Proton then carries out this form’s actions for a rejected application, such as the ' +
  'decision DM.';

const TWO_REVIEWERS =
  'This form needs two reviewers to agree. Your decision counts as one, so another reviewer ' +
  'must already have voted the same way.';

export function outcomeOf(result: Pick<StaffActionResult, 'ok' | 'message'>): Outcome {
  return { tone: result.ok ? 'success' : 'danger', message: readableOutcome(result.message) };
}

interface Handlers {
  onAnswer: (result: StaffActionResult) => void;
  onFailure: (failure: ActionFailure) => void;
}

export function useApplicationAction(guildId: string, applicationId: string) {
  const queryClient = useQueryClient();
  const { mutate, isPending, variables } = useMutation(
    actOnApplicationMutation(queryClient, guildId),
  );
  const retry = useRef<{ signature: string; requestId: string } | null>(null);

  const run = useCallback(
    (request: ApplicationActionRequest, attempt: string, handlers: Handlers) => {
      const signature = JSON.stringify(request);
      // Reused only while unanswered: the api keeps an answered id and would replay its answer.
      const requestId =
        retry.current?.signature === signature ? retry.current.requestId : newRequestId();
      retry.current = { signature, requestId };

      mutate(
        { applicationId, requestId, request },
        {
          onSuccess: (result) => {
            retry.current = null;
            handlers.onAnswer(result);
          },
          onError: (error) => handlers.onFailure(actionFailure(error, attempt)),
        },
      );
    },
    [mutate, applicationId],
  );

  return {
    run,
    pending: isPending,
    action: isPending ? variables?.request.action : undefined,
    request: isPending ? variables?.request : undefined,
  };
}

function useShown(open: boolean): { readonly current: boolean } {
  const shown = useRef(open);

  useEffect(() => {
    shown.current = open;
  }, [open]);

  return shown;
}

function answered(
  shown: { readonly current: boolean },
  onDone: (outcome: Outcome) => void,
  setFailure: (outcome: Outcome) => void,
  close: () => void,
): Handlers {
  return {
    onAnswer: (result) => {
      if (result.ok) {
        onDone(outcomeOf(result));
        if (shown.current) close();
      } else if (shown.current) {
        setFailure(outcomeOf(result));
      } else {
        onDone(outcomeOf(result));
      }
    },
    onFailure: (failure) => (shown.current ? setFailure(failure) : onDone(failure)),
  };
}

function Failure({ failure }: { failure: Outcome | null }): ReactElement | null {
  if (failure === null) return null;

  return (
    <StatusBanner tone={failure.tone} live="assertive">
      {failure.message}
    </StatusBanner>
  );
}

function Counted({ value, max }: { value: string; max: number }): ReactElement {
  return (
    <span className="applications-review-count" aria-hidden>
      {value.length} / {max}
    </span>
  );
}

interface DialogBase {
  guildId: string;
  detail: ApplicationDetail;
  open: boolean;
  onClose: () => void;
  onDone: (outcome: Outcome) => void;
}

function applicantOf(detail: ApplicationDetail): string {
  return detail.application.applicantName ?? 'the applicant';
}

export function DecisionDialog({
  guildId,
  detail,
  decision,
  open,
  onClose,
  onDone,
}: DialogBase & { decision: 'accept' | 'reject' }): ReactElement {
  const { application } = detail;
  const { run, pending } = useApplicationAction(guildId, application.id);
  const shown = useShown(open);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(false);
  const [failure, setFailure] = useState<Outcome | null>(null);

  const accepting = decision === 'accept';
  const canOverride = detail.twoReviewers && detail.capabilities.includes('override');
  const action = accepting ? 'Accept application' : 'Reject application';

  const close = (): void => {
    setReason('');
    setNote('');
    setOverride(false);
    setFailure(null);
    onClose();
  };

  const submit = (): void => {
    setFailure(null);
    const trimmedReason = reason.trim();
    const trimmedNote = note.trim();

    run(
      {
        action: decision,
        ...(trimmedReason !== '' ? { reason: trimmedReason } : {}),
        ...(trimmedNote !== '' ? { note: trimmedNote } : {}),
        ...(canOverride && override ? { override: true } : {}),
      },
      accepting ? 'Couldn’t accept the application' : 'Couldn’t reject the application',
      answered(shown, onDone, setFailure, close),
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!pending}
      title={action}
      size="medium"
      icon={accepting ? 'check-circle' : 'prohibit'}
      description={`${titleOf(application)} from ${applicantOf(detail)}.`}
      footerNote={pending ? WAITING : undefined}
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button tone="primary" busy={pending} onClick={submit}>
            {action}
          </Button>
        </>
      }
    >
      <Failure failure={failure} />

      <p className="text-secondary text-sm">{accepting ? AFTER_ACCEPT : AFTER_REJECT}</p>

      <Field
        label="Reason for the applicant"
        hint={
          <>
            The applicant sees this. <Counted value={reason} max={REASON_MAX} />
          </>
        }
      >
        {(props) => (
          <TextArea
            {...props}
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        )}
      </Field>

      <Field label="Internal note" hint="Only staff see this.">
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

      {detail.twoReviewers ? <p className="text-sm text-secondary">{TWO_REVIEWERS}</p> : null}

      {canOverride ? (
        <span className="inline inline-8 text-sm">
          <Checkbox
            checked={override}
            onChange={setOverride}
            label="Decide without a second reviewer"
          />
          Decide without a second reviewer. This is recorded in the history.
        </span>
      ) : null}
    </Dialog>
  );
}

function TextActionDialog({
  guildId,
  detail,
  open,
  onClose,
  onDone,
  title,
  icon,
  description,
  label,
  hint,
  max,
  missingText,
  confirm,
  attempt,
  request,
}: DialogBase & {
  title: string;
  icon: IconName;
  description: ReactNode;
  label: string;
  hint: string;
  max: number;
  missingText: string | null;
  confirm: string;
  attempt: string;
  request: (text: string) => ApplicationActionRequest;
}): ReactElement {
  const { run, pending } = useApplicationAction(guildId, detail.application.id);
  const shown = useShown(open);
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<Outcome | null>(null);
  const [tried, setTried] = useState(false);

  const trimmed = text.trim();
  const missing = missingText !== null && trimmed === '';

  const close = (): void => {
    setText('');
    setFailure(null);
    setTried(false);
    onClose();
  };

  const submit = (): void => {
    setTried(true);
    if (missing) return;

    setFailure(null);
    run(request(trimmed), attempt, answered(shown, onDone, setFailure, close));
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!pending}
      title={title}
      size="medium"
      icon={icon}
      description={description}
      footerNote={pending ? WAITING : undefined}
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button tone="primary" busy={pending} onClick={submit}>
            {confirm}
          </Button>
        </>
      }
    >
      <Failure failure={failure} />

      <Field
        label={label}
        error={tried && missing && missingText !== null ? missingText : undefined}
        hint={
          <>
            {hint} <Counted value={text} max={max} />
          </>
        }
      >
        {(props) => (
          <TextArea
            {...props}
            rows={4}
            maxLength={max}
            value={text}
            invalid={tried && missing}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        )}
      </Field>
    </Dialog>
  );
}

const INFO_HINT =
  'The applicant sees this. Proton DMs it when DMs are on for this form, and it shows on ' +
  'their application page.';

export function RequestInfoDialog(props: DialogBase): ReactElement {
  return (
    <TextActionDialog
      {...props}
      title="Request information"
      icon="chat-centered-text"
      description="The application waits for the applicant’s answer, then comes back to review."
      label="Message"
      hint={INFO_HINT}
      max={INFO_REQUEST_MAX}
      missingText="Write the message first."
      confirm="Send request"
      attempt="Couldn’t ask the applicant for information"
      request={(message) => ({ action: 'request_info', message })}
    />
  );
}

export function WaitlistDialog(props: DialogBase): ReactElement {
  return (
    <TextActionDialog
      {...props}
      title="Waitlist application"
      icon="list"
      description={`${titleOf(props.detail.application)} is set aside without a decision.`}
      label="Reason"
      hint="Optional. The applicant sees this."
      max={REASON_MAX}
      missingText={null}
      confirm="Waitlist"
      attempt="Couldn’t waitlist the application"
      request={(reason) => ({ action: 'waitlist', ...(reason !== '' ? { reason } : {}) })}
    />
  );
}

export function ReopenDialog(props: DialogBase): ReactElement {
  return (
    <TextActionDialog
      {...props}
      title="Reopen application"
      icon="shield-warning"
      description={
        'The decision is cleared and the application goes back to review. Roles, DMs and ' +
        'rewards from the earlier decision aren’t undone or run again.'
      }
      label="Reason"
      hint="Only staff see this. It’s saved as an internal note."
      max={REASON_MAX}
      missingText="Write a reason first."
      confirm="Reopen"
      attempt="Couldn’t reopen the application"
      request={(reason) => ({ action: 'reopen', reason })}
    />
  );
}

export function NoteForm({
  guildId,
  applicationId,
  onDone,
}: {
  guildId: string;
  applicationId: string;
  onDone: (outcome: Outcome) => void;
}): ReactElement {
  const { run, pending } = useApplicationAction(guildId, applicationId);
  const [body, setBody] = useState('');
  const [failure, setFailure] = useState<Outcome | null>(null);
  const trimmed = body.trim();

  const submit = (): void => {
    if (trimmed === '') return;

    setFailure(null);
    run({ action: 'note', body: trimmed }, 'Couldn’t add the note', {
      onAnswer: (result) => {
        if (result.ok) {
          setBody('');
          onDone(outcomeOf(result));
        } else {
          setFailure(outcomeOf(result));
        }
      },
      onFailure: setFailure,
    });
  };

  return (
    <form
      className="stack stack-8 applications-review-note-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Failure failure={failure} />
      <Field
        label="Add a note"
        hint={
          <>
            Only staff see this. <Counted value={body} max={NOTE_MAX} />
          </>
        }
      >
        {(props) => (
          <TextArea
            {...props}
            rows={3}
            maxLength={NOTE_MAX}
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
          />
        )}
      </Field>
      <div className="inline inline-8">
        <Button type="submit" size="sm" busy={pending} disabled={trimmed === ''}>
          Add note
        </Button>
      </div>
    </form>
  );
}

const COPY_ID_HELP =
  'In Discord, turn on Developer Mode under Settings → Advanced, then right-click a member and ' +
  'choose Copy User ID.';

export function AssignDialog({
  guildId,
  surface,
  detail,
  open,
  onClose,
  onDone,
}: DialogBase & { surface: Surface }): ReactElement {
  const { application } = detail;
  const { run, pending, request } = useApplicationAction(guildId, application.id);
  const shown = useShown(open);
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [failure, setFailure] = useState<Outcome | null>(null);

  const chosen = surface === 'module' ? picked : typed.trim();
  const valid = isMemberId(chosen);
  const invalid = surface === 'review' && typed.trim() !== '' && !valid;
  const assigning = request?.action === 'assign' ? request.assigneeId : undefined;

  const close = (): void => {
    setPicked(null);
    setTyped('');
    setFailure(null);
    onClose();
  };

  const assign = (assigneeId: string | null): void => {
    setFailure(null);
    run(
      { action: 'assign', assigneeId },
      'Couldn’t assign the application',
      answered(shown, onDone, setFailure, close),
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!pending}
      title={application.assigneeId === null ? 'Assign application' : 'Reassign application'}
      size="compact"
      icon="user-plus"
      description="The member you choose is shown as reviewing it, here and on the review card."
      footerNote={pending ? WAITING : undefined}
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button
            tone="primary"
            busy={pending && assigning !== 'me' && assigning !== null}
            disabled={!valid || pending}
            onClick={() => {
              if (isMemberId(chosen)) assign(chosen);
            }}
          >
            Assign
          </Button>
        </>
      }
    >
      <Failure failure={failure} />

      <div className="inline inline-8 inline-wrap">
        <Button
          icon="user-plus"
          busy={pending && assigning === 'me'}
          disabled={pending}
          onClick={() => assign('me')}
        >
          Assign to me
        </Button>
        {application.assigneeId !== null ? (
          <Button
            tone="ghost"
            busy={pending && assigning === null}
            disabled={pending}
            onClick={() => assign(null)}
          >
            Unassign
          </Button>
        ) : null}
      </div>

      {surface === 'module' ? (
        <div className="field">
          <span className="field-label">Or choose a member</span>
          <MemberPicker
            guildId={guildId}
            value={picked}
            onChange={(next) => {
              setPicked(next);
              setFailure(null);
            }}
            label="Assign to"
            placeholder="Choose a member"
            width="100%"
          />
        </div>
      ) : (
        <Field
          label="Or paste a member ID"
          help={COPY_ID_HELP}
          error={invalid ? 'A member ID is 17 to 20 digits.' : undefined}
          hint="They must be on this form’s review team."
        >
          {(props) => (
            <TextInput
              {...props}
              className="mono"
              inputMode="numeric"
              autoComplete="off"
              invalid={invalid}
              value={typed}
              onChange={(event) => {
                setTyped(event.currentTarget.value);
                setFailure(null);
              }}
            />
          )}
        </Field>
      )}
    </Dialog>
  );
}

const SCORES: readonly string[] = ['1', '2', '3', '4', '5'];

export function VoteDialog({ guildId, detail, open, onClose, onDone }: DialogBase): ReactElement {
  const { run, pending } = useApplicationAction(guildId, detail.application.id);
  const shown = useShown(open);
  const [vote, setVote] = useState<'accept' | 'reject'>('accept');
  const [score, setScore] = useState<number | null>(null);
  const [tried, setTried] = useState(false);
  const [failure, setFailure] = useState<Outcome | null>(null);

  const missing = detail.scoring && score === null;
  const scored = detail.scoring && score !== null ? { score } : {};

  const close = (): void => {
    setVote('accept');
    setScore(null);
    setTried(false);
    setFailure(null);
    onClose();
  };

  const submit = (): void => {
    setTried(true);
    if (missing) return;

    setFailure(null);
    run(
      { action: 'vote', vote, ...scored },
      'Couldn’t record your vote',
      answered(shown, onDone, setFailure, close),
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!pending}
      title="Vote"
      size="compact"
      icon="scales"
      description="Votes inform the decision; they don’t make it."
      footerNote={pending ? WAITING : undefined}
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button tone="primary" busy={pending} onClick={submit}>
            Vote
          </Button>
        </>
      }
    >
      <Failure failure={failure} />

      <div className="field">
        <span className="field-label">Your vote</span>
        <SegmentedControl
          label="Your vote"
          value={vote}
          options={[
            { value: 'accept', label: 'Accept' },
            { value: 'reject', label: 'Reject' },
          ]}
          onChange={setVote}
        />
      </div>

      {detail.scoring ? (
        <div className="field">
          <span className="field-label">Score</span>
          <SegmentedControl<string>
            label="Score from 1 to 5"
            value={score === null ? '' : String(score)}
            options={SCORES.map((value) => ({ value, label: value }))}
            onChange={(value) => setScore(SCORES.includes(value) ? Number(value) : null)}
          />
          {tried && missing ? (
            <span className="field-error">Choose a score from 1 to 5.</span>
          ) : (
            <span className="field-hint">1 is weakest, 5 is strongest.</span>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

export function DeleteApplicationDialog({
  guildId,
  detail,
  open,
  onClose,
  onDone,
}: DialogBase): ReactElement {
  const { run, pending } = useApplicationAction(guildId, detail.application.id);
  const shown = useShown(open);
  const [failure, setFailure] = useState<Outcome | null>(null);

  const close = (): void => {
    setFailure(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!pending}
      title={`Delete ${titleOf(detail.application)}?`}
      size="compact"
      icon="trash"
      tone="danger"
      footerNote={pending ? WAITING : undefined}
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button
            tone="danger"
            busy={pending}
            onClick={() => {
              setFailure(null);
              run(
                { action: 'delete', confirm: true },
                'Couldn’t delete the application',
                answered(shown, onDone, setFailure, close),
              );
            }}
          >
            Delete application
          </Button>
        </>
      }
    >
      <Failure failure={failure} />
      <p className="text-secondary text-sm">
        Proton deletes its answers, notes and conversation, and removes the review card from
        Discord. A minimal record stays: its reference, form, status and dates.
      </p>
      <p className="text-secondary text-sm">
        Copies someone already downloaded, or read in Discord, can’t be recalled.
      </p>
    </Dialog>
  );
}

export function DeleteApplicantDialog({
  guildId,
  detail,
  open,
  onClose,
  onDone,
}: DialogBase): ReactElement {
  const queryClient = useQueryClient();
  const { mutate, isPending } = useMutation(deleteApplicantMutation(queryClient, guildId));
  const shown = useShown(open);
  const requestId = useRef<string | null>(null);
  const [failure, setFailure] = useState<Outcome | null>(null);
  const name = applicantOf(detail);

  const close = (): void => {
    setFailure(null);
    onClose();
  };

  const submit = (): void => {
    setFailure(null);
    // Kept until answered, so a retry after a lost answer is recognised as the same request.
    const id = requestId.current ?? newRequestId();
    requestId.current = id;

    mutate(
      { applicantId: detail.application.applicantId, requestId: id },
      {
        onSuccess: (result) => {
          requestId.current = null;
          const outcome: Outcome = {
            tone: 'success',
            message:
              result.deleted === 0
                ? 'There was nothing left to delete for this applicant.'
                : `Deleted the answers to ${result.deleted} ${
                    result.deleted === 1 ? 'application' : 'applications'
                  } from ${name}. Copies someone already downloaded can’t be recalled.`,
          };
          onDone(outcome);
          if (shown.current) close();
        },
        onError: (error) => {
          const next = actionFailure(error, 'Couldn’t delete the applicant’s data');
          if (shown.current) setFailure(next);
          else onDone(next);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!isPending}
      title="Delete everything from this applicant?"
      size="compact"
      icon="trash"
      tone="danger"
      footerNote={isPending ? WAITING : undefined}
      footer={
        <>
          <Button onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button tone="danger" busy={isPending} onClick={submit}>
            Delete their data
          </Button>
        </>
      }
    >
      <Failure failure={failure} />
      <p className="text-secondary text-sm">
        Proton deletes the answers, notes and conversation of every application {name} sent in this
        server, and removes their review cards from Discord. A minimal record of each stays: its
        reference, form, status and dates.
      </p>
      <p className="text-secondary text-sm">
        Copies someone already downloaded, or read in Discord, can’t be recalled.
      </p>
    </Dialog>
  );
}

export interface ExportChoice {
  view: QueueView;
  formId?: string | undefined;
  formName?: string | undefined;
}

type ExportFormat = 'csv' | 'json';

export async function downloadApplications(
  guildId: string,
  choice: ExportChoice,
  format: ExportFormat,
): Promise<Outcome> {
  const params = new URLSearchParams({ format, view: choice.view });
  if (choice.formId !== undefined) params.set('formId', choice.formId);

  let response: Response;
  try {
    response = await fetch(`/api/guilds/${guildId}/applications-export?${params}`, {
      credentials: 'same-origin',
    });
  } catch {
    return {
      tone: 'danger',
      message: 'Couldn’t download the applications. Proton didn’t respond. Try again in a moment.',
    };
  }

  if (!response.ok) {
    const text = (await response.text().catch(() => '')).trim();
    const reason =
      text !== '' && text.length <= 300 && !text.startsWith('<')
        ? text
        : 'Something went wrong. Try again in a moment.';
    return { tone: 'danger', message: `Couldn’t download the applications. ${reason}` };
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filenameOf(response.headers.get('content-disposition'), `applications.${format}`);
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);

  const rows = Number(response.headers.get('x-proton-export-rows') ?? '0');
  const truncated = response.headers.get('x-proton-export-truncated') === '1';

  return {
    tone: truncated ? 'warning' : 'success',
    message: exportedLine(Number.isFinite(rows) ? rows : 0, truncated),
  };
}

export function ExportDialog({
  guildId,
  choice,
  open,
  onClose,
  onDone,
}: {
  guildId: string;
  choice: ExportChoice;
  open: boolean;
  onClose: () => void;
  onDone: (outcome: Outcome) => void;
}): ReactElement {
  const shown = useShown(open);
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Outcome | null>(null);

  const close = (): void => {
    setFailure(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    const outcome = await downloadApplications(guildId, choice, format);
    setPending(false);

    if (outcome.tone === 'danger' && shown.current) {
      setFailure(outcome);
      return;
    }
    onDone(outcome);
    if (shown.current) close();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!pending}
      title="Export applications"
      size="compact"
      icon="clipboard-text"
      footerNote={
        pending ? (
          <AsyncOperationStatus phase="working" workingLabel="Preparing the file…" />
        ) : undefined
      }
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button tone="primary" busy={pending} onClick={() => void submit()}>
            Download
          </Button>
        </>
      }
    >
      <Failure failure={failure} />

      <div className="field">
        <span className="field-label">Format</span>
        <SegmentedControl
          label="File format"
          value={format}
          options={[
            { value: 'csv', label: 'CSV' },
            { value: 'json', label: 'JSON' },
          ]}
          onChange={setFormat}
        />
      </div>

      <p className="text-secondary text-sm">{exportScope(choice, format)}</p>
      <p className="text-secondary text-sm">
        The file holds applicants’ answers. Anyone you share it with can read them, and Proton can’t
        recall it.
      </p>
    </Dialog>
  );
}

import { type FormConfig, questionsOf } from '@proton/module-applications/config';
import { publishIssues, snapshotDiff, snapshotOf } from '@proton/module-applications/version';
import type { PublishResult } from '@proton/module-applications/view';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { Button } from '../../components/ui/controls.tsx';
import { AsyncOperationStatus, LoadingArea, StatusBanner } from '../../components/ui/feedback.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import { readFailure } from '../../lib/errors.ts';
import { publishApplicationForm } from '../../server/applications-admin.ts';
import { applicationsAdminKey, formVersionQuery } from './admin-queries.ts';
import {
  type FormEntry,
  failureText,
  formTitle,
  joinAnd,
  newRequestId,
  questionTitle,
} from './shape.ts';

type Policy = 'keep' | 'restart';

const POLICIES: readonly { value: Policy; title: string; body: string }[] = [
  {
    value: 'keep',
    title: 'Let people finish on the version they started',
    body: 'They answer the questions they already saw. New applicants get the new version.',
  },
  {
    value: 'restart',
    title: 'Ask them to start again',
    body: 'Their drafts are cleared and they start over on the new version. Nothing carries over.',
  },
];

const UNKNOWN_VERSION =
  'Proton couldn’t load the published version, so this can’t show what changes. Publishing ' +
  'still works, and drafts in progress finish on the version they started.';

const STILL_CLOSED =
  'The form stays closed after publishing until you turn on Accepting applications under Intake.';

function ChoiceRows({
  value,
  onChange,
  label,
  disabled,
}: {
  value: Policy;
  onChange: (next: Policy) => void;
  label: string;
  disabled: boolean;
}): ReactElement {
  return (
    <div role="radiogroup" aria-label={label} className="applications-choices">
      {POLICIES.map((option) => (
        // biome-ignore lint/a11y/useSemanticElements: the same button group SegmentedControl draws, and a native radio can't carry a title and an explanation
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          className="applications-choice"
          onClick={() => onChange(option.value)}
        >
          <span className="applications-choice-dot" aria-hidden />
          <span className="applications-choice-text">
            <span className="applications-choice-title">{option.title}</span>
            <span className="text-xs text-muted">{option.body}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function quoted(labels: readonly string[]): string {
  const shown = labels.slice(0, 4).map((label) => `“${label}”`);
  const more = labels.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : joinAnd(shown);
}

function Changes({
  guildId,
  current,
  entry,
  open,
}: {
  guildId: string;
  current: FormConfig;
  entry: FormEntry | undefined;
  open: boolean;
}): ReactElement {
  const published = entry?.published ?? null;
  const previous = useQuery({
    ...formVersionQuery(guildId, current.id, published?.versionId ?? null),
    enabled: open && published !== null,
  });

  const after = snapshotOf(current);
  const afterLabels = new Map(questionsOf(after).map((q) => [q.id, questionTitle(q)]));
  const total = afterLabels.size;

  if (published === null) {
    return (
      <p className="text-sm text-secondary">
        This is the first version. All {total} {total === 1 ? 'question goes' : 'questions go'} out
        as they are now.
      </p>
    );
  }

  if (previous.isPending) {
    return <LoadingArea label="Comparing versions" minHeight={64} size="sm" />;
  }

  if (previous.isError) {
    return (
      <p className="text-sm text-danger">
        {readFailure(previous.error, `version ${published.version} to compare against`)}
      </p>
    );
  }

  const diff = snapshotDiff(previous.data.snapshot, after);
  const beforeLabels = new Map(
    questionsOf(previous.data.snapshot).map((q) => [q.id, questionTitle(q)]),
  );
  const label = (labels: Map<string, string>) => (id: string) => labels.get(id) ?? id;

  const lines = [
    diff.added.length > 0 ? `Added ${quoted(diff.added.map(label(afterLabels)))}.` : null,
    diff.removed.length > 0 ? `Removed ${quoted(diff.removed.map(label(beforeLabels)))}.` : null,
    diff.changed.length > 0 ? `Changed ${quoted(diff.changed.map(label(afterLabels)))}.` : null,
    diff.requirementsChanged ? 'Who can apply changed.' : null,
    diff.textChanged ? 'The name, introduction, confirmation or section text changed.' : null,
  ].filter((line): line is string => line !== null);

  if (lines.length === 0) {
    return (
      <p className="text-sm text-secondary">
        Nothing has changed since version {published.version}, so publishing makes no new version.
      </p>
    );
  }

  return (
    <ul className="applications-diff">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

export function PublishDialog({
  open,
  guildId,
  current,
  entry,
  overviewPending,
  overviewFailed,
  onClose,
  onPublished,
}: {
  open: boolean;
  guildId: string;
  current: FormConfig;
  entry: FormEntry | undefined;
  overviewPending: boolean;
  overviewFailed: boolean;
  onClose: () => void;
  onPublished: (result: PublishResult, policy: Policy) => void;
}): ReactElement {
  const queryClient = useQueryClient();
  const [policy, setPolicy] = useState<Policy>('keep');
  const [attempt, setAttempt] = useState<{ policy: Policy; requestId: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPolicy('keep');
      setAttempt(null);
      setRefusal(null);
    }
  }

  const publish = useMutation({
    mutationFn: (request: { policy: Policy; requestId: string }) =>
      publishApplicationForm({
        data: {
          guildId,
          formId: current.id,
          requestId: request.requestId,
          draftPolicy: request.policy,
        },
      }),
    onSuccess: (outcome, request) => {
      setAttempt(null);
      if (outcome.ok) onPublished(outcome.result, request.policy);
      else setRefusal(outcome.message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: applicationsAdminKey(guildId) });
    },
  });

  const issues = publishIssues(current);
  const published = entry?.published ?? null;
  const drafts = entry?.counts.drafts ?? 0;
  const pending = publish.isPending;

  const go = (): void => {
    setRefusal(null);
    // An attempt that got no answer is sent again under its id, so a lost reply can't publish twice.
    const request =
      attempt !== null && attempt.policy === policy
        ? attempt
        : { policy, requestId: newRequestId() };
    setAttempt(request);
    publish.mutate(request);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Publish ${formTitle(current)}`}
      description={
        published === null || overviewFailed
          ? 'Members see the form once it’s published and accepting applications.'
          : `Version ${published.version} becomes version ${published.version + 1}. Applications already sent keep the questions they answered.`
      }
      size="medium"
      icon="identification-card"
      dismissible={!pending}
      footerNote={
        pending ? <AsyncOperationStatus phase="working" workingLabel="Publishing…" /> : undefined
      }
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            tone="primary"
            busy={pending}
            disabled={issues.length > 0 || overviewPending}
            onClick={go}
          >
            Publish
          </Button>
        </>
      }
    >
      <div className="stack stack-16">
        {overviewFailed ? (
          <StatusBanner tone="warning">{UNKNOWN_VERSION}</StatusBanner>
        ) : (
          <div className="stack stack-6">
            <p className="section-label">What changes</p>
            <Changes guildId={guildId} current={current} entry={entry} open={open} />
          </div>
        )}

        {issues.length > 0 ? (
          <StatusBanner tone="danger" title="Fix these first">
            <ul className="applications-diff">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </StatusBanner>
        ) : null}

        {published !== null && drafts > 0 ? (
          <div className="stack stack-8">
            <p className="section-label">Drafts in progress</p>
            <p className="text-sm text-secondary">
              {drafts} {drafts === 1 ? 'person has' : 'people have'} started this form and not sent
              it yet.
            </p>
            <ChoiceRows
              label="Drafts in progress"
              value={policy}
              disabled={pending}
              onChange={setPolicy}
            />
          </div>
        ) : null}

        {current.intake.open ? null : <p className="text-sm text-muted">{STILL_CLOSED}</p>}

        {refusal !== null ? (
          <StatusBanner tone="danger" live="assertive">
            {refusal}
          </StatusBanner>
        ) : null}

        {publish.isError ? (
          <StatusBanner tone="danger" live="assertive">
            {failureText(publish.error, 'Couldn’t publish')} Pressing Publish again is safe.
          </StatusBanner>
        ) : null}
      </div>
    </Dialog>
  );
}

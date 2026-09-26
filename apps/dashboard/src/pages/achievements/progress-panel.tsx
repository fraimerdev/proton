import { TIER_COLOURS, TIER_LABELS, toHexColour } from '@proton/cards/design';
import type { TierId } from '@proton/core';
import type { Achievement, AchievementsConfig } from '@proton/module-achievements/config';
import { tierRank } from '@proton/module-achievements/evaluate';
import type {
  AchievementsOverview,
  JobResult,
  JobView,
  OverviewAchievement,
} from '@proton/module-achievements/view';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';
import type { ModuleForm } from '../../components/module/form.ts';
import { ModuleLink } from '../../components/module/route.tsx';
import {
  Button,
  Checkbox,
  Chip,
  cx,
  Field,
  Switch,
  TextInput,
} from '../../components/ui/controls.tsx';
import {
  AsyncOperationStatus,
  type AsyncPhase,
  EmptyState,
  LoadingArea,
  StatusBanner,
} from '../../components/ui/feedback.tsx';
import { ActionRow, Pair, Pairs, Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import { failureKind, readFailure, saveFailure } from '../../lib/errors.ts';
import {
  achievementsOverviewQuery,
  jobInFlight,
  newRequestId,
  requestAchievementJobMutation,
  resetAchievementsMutation,
  waitingForStart,
} from './queries.ts';
import { savedAchievement, savedConfig } from './shape.ts';
import { useStatusContext } from './status.tsx';
import { formatZoned } from './time.ts';

const UNSAVED_NOTE = 'Save your changes first. This uses the saved version.';

const MODULE_OFF_NOTE = 'Re-checks and rebuilds run only while Achievements is on.';

const JOB_BUSY_NOTE = 'Proton is already working on this achievement. Wait for it to finish.';

const JOB_STRANDED =
  'Proton stopped before finishing, which happens when Achievements is turned off during a job. ' +
  'Start it again.';

const NOTHING_YET = 'Save this achievement and make it active to start counting.';

const RECHECK_HELP =
  'Checks members with progress against the saved targets. Earned tiers stay earned, and tiers ' +
  'earned this way aren’t announced.';

const REBUILD_HELP =
  'Counts progress again from activity Proton recorded, up to 365 days back. You see what would ' +
  'change before anything does.';

const RESET_HELP =
  'Clears every member’s progress and earned tiers for this achievement, so they can earn it ' +
  'again. Roles and XP already given stay given.';

const RESET_CONSEQUENCE =
  'Every member’s progress and earned tiers for this achievement are cleared, and they can earn ' +
  'it again from their next activity. Roles and XP already given stay given, and aren’t given ' +
  'again unless you allow it below.';

const REWARDS_AGAIN = 'Let members earn the rewards again';

const REWARDS_AGAIN_CONFIRM =
  'Members who earn it again are given its roles and XP again, even if they had them before.';

const REBUILD_DESCRIPTION =
  'Proton counts progress again from the activity it recorded, up to 365 days back.';

const SAVED_VERSION = 'Uses the saved version.';

const PREVIEW_WAITING = 'Working out what a rebuild would change…';

const PREVIEW_FAILED = 'Proton couldn’t work out what a rebuild would change.';

const ANNOUNCE_REBUILD = 'Announce unlocks from this rebuild';

const ANNOUNCE_REBUILD_HELP =
  'Off: members who earn a tier from the rebuild get it without an announcement.';

// requestedAt is the api's clock, and this browser's can run ahead of it.
const CLOCK_SLACK_MS = 2 * 60_000;

const COUNT = new Intl.NumberFormat('en-GB');

const JOB_NAMES: Record<JobView['kind'], string> = {
  recheck: 'Re-check',
  rebuild: 'Rebuild',
  rebuild_preview: 'Rebuild preview',
};

const JOB_WORKING: Record<JobView['kind'], string> = {
  recheck: 'Re-checking members…',
  rebuild: 'Rebuilding from recorded activity…',
  rebuild_preview: PREVIEW_WAITING,
};

const JOB_PHASE: Record<JobView['status'], AsyncPhase> = {
  queued: 'requested',
  running: 'working',
  done: 'completed',
  failed: 'failed',
};

type Form = ModuleForm<AchievementsConfig>;

export function overviewOf(
  overview: AchievementsOverview | undefined,
  id: string,
): OverviewAchievement | undefined {
  return overview?.achievements.find((entry) => entry.id === id);
}

export function earnedMembers(entry: OverviewAchievement): number {
  return Math.max(0, ...Object.values(entry.holders));
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

  return [...keys].every((key) => sameValue(left[key], right[key]));
}

export function membersLabel(count: number): string {
  return `${COUNT.format(count)} ${count === 1 ? 'member' : 'members'}`;
}

function refusal(error: Error, attempt: string): string {
  return failureKind(error) === 'unknown' && error.message !== ''
    ? error.message
    : saveFailure(error, attempt);
}

function tiersByRank(achievement: Achievement): TierId[] {
  return achievement.tiers.map((tier) => tier.id).sort((a, b) => tierRank(a) - tierRank(b));
}

function newlyEarnedText(achievement: Achievement, result: JobResult): string {
  if (achievement.kind === 'single') {
    const count = result.newlyEarned.single ?? 0;
    return count === 0 ? 'Nobody' : membersLabel(count);
  }

  const parts = tiersByRank(achievement)
    .map((tier) => ({ tier, count: result.newlyEarned[tier] ?? 0 }))
    .filter(({ count }) => count > 0)
    .map(({ tier, count }) => `${TIER_LABELS[tier]} ${COUNT.format(count)}`);

  return parts.length === 0 ? 'Nobody' : parts.join(', ');
}

function lossSentence(lost: number): string {
  return `Activity older than 365 days can’t be rebuilt, so ${membersLabel(lost)} would lose progress.`;
}

function jobFinished(job: JobView, zone: string): string {
  const when = job.finishedAt === null ? '' : ` on ${formatZoned(job.finishedAt, zone)}`;
  const result = job.result;

  if (result === null) return `${JOB_NAMES[job.kind]} finished${when}.`;

  if (job.kind === 'rebuild_preview') {
    return `Rebuild preview finished${when}: ${membersLabel(result.changed)} would change.`;
  }

  return (
    `${JOB_NAMES[job.kind]} finished${when}: ${membersLabel(result.members)} checked, ` +
    `${COUNT.format(result.changed)} changed.`
  );
}

function JobStatus({
  job,
  zone,
  waitingUntil,
}: {
  job: JobView;
  zone: string;
  waitingUntil: number | null;
}): ReactElement | null {
  const queued =
    waitingUntil === null
      ? `${JOB_NAMES[job.kind]} queued. This page updates when it’s done.`
      : `${JOB_NAMES[job.kind]} waits until this achievement starts on ${formatZoned(waitingUntil, zone)}, then runs on its own.`;

  return (
    <AsyncOperationStatus
      phase={JOB_PHASE[job.status]}
      requestedLabel={queued}
      workingLabel={JOB_WORKING[job.kind]}
      completedLabel={jobFinished(job, zone)}
      failedLabel={job.result?.reason ?? `${JOB_NAMES[job.kind]} failed. Try again in a moment.`}
    />
  );
}

function HolderRows({
  achievement,
  entry,
  guildId,
  moduleId,
}: {
  achievement: Achievement;
  entry: OverviewAchievement | undefined;
  guildId: string;
  moduleId: string;
}): ReactElement {
  const failed = entry?.rewards.failed ?? 0;

  return (
    <Rows>
      {tiersByRank(achievement).map((tier) => (
        <SettingRow
          key={tier}
          title={
            tier === 'single' ? (
              'Earned'
            ) : (
              <Chip colour={toHexColour(TIER_COLOURS[tier])}>{TIER_LABELS[tier]}</Chip>
            )
          }
        >
          <span className="achievements-editor-count">
            {membersLabel(entry?.holders[tier] ?? 0)}
          </span>
        </SettingRow>
      ))}

      <SettingRow title="In progress">
        <span className="achievements-editor-count">{membersLabel(entry?.inProgress ?? 0)}</span>
      </SettingRow>

      <SettingRow title="Rewards on their way">
        <span className="achievements-editor-count">
          {COUNT.format(entry?.rewards.pending ?? 0)}
        </span>
      </SettingRow>

      <SettingRow
        title="Rewards failed"
        description={
          failed > 0 ? (
            <ModuleLink guildId={guildId} moduleId={moduleId} search={{ area: 'members' }}>
              Retry them in Members
            </ModuleLink>
          ) : undefined
        }
      >
        <span className={cx('achievements-editor-count', failed > 0 && 'text-warning')}>
          {COUNT.format(failed)}
        </span>
      </SettingRow>
    </Rows>
  );
}

function RebuildDialog({
  open,
  achievement,
  job,
  sentAt,
  starting,
  failure,
  confirming,
  confirmFailure,
  onRetry,
  onConfirm,
  onClose,
}: {
  open: boolean;
  achievement: Achievement;
  job: JobView | null;
  sentAt: number | null;
  starting: boolean;
  failure: string | null;
  confirming: boolean;
  confirmFailure: string | null;
  onRetry: () => void;
  onConfirm: (announce: boolean, acceptLoss: boolean) => void;
  onClose: () => void;
}): ReactElement | null {
  const [announce, setAnnounce] = useState(false);
  const [acceptLoss, setAcceptLoss] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  const announceHint = useId();

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setAnnounce(false);
      setAcceptLoss(false);
    }
  }

  const matched =
    !starting &&
    sentAt !== null &&
    job?.kind === 'rebuild_preview' &&
    job.requestedAt !== null &&
    job.requestedAt >= sentAt - CLOCK_SLACK_MS
      ? job
      : null;

  const problem =
    failure ?? (matched?.status === 'failed' ? (matched.result?.reason ?? PREVIEW_FAILED) : null);
  const result = problem === null && matched?.status === 'done' ? matched.result : null;
  const lost = result?.lost ?? 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Rebuild ${achievement.name} from recorded activity?`}
      description={REBUILD_DESCRIPTION}
      size="medium"
      footerNote={SAVED_VERSION}
      footer={
        <>
          <Button onClick={onClose} disabled={confirming}>
            Cancel
          </Button>
          <Button
            tone="primary"
            busy={confirming}
            disabled={result === null || (lost > 0 && !acceptLoss)}
            onClick={() => onConfirm(announce, lost > 0)}
          >
            Rebuild progress
          </Button>
        </>
      }
    >
      {problem !== null ? (
        <StatusBanner
          tone="danger"
          live="assertive"
          actions={
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          }
        >
          {problem}
        </StatusBanner>
      ) : result === null ? (
        <AsyncOperationStatus phase="working" workingLabel={PREVIEW_WAITING} />
      ) : (
        <>
          <Pairs>
            <Pair label="Members checked">{membersLabel(result.members)}</Pair>
            <Pair label="Progress would change">{membersLabel(result.changed)}</Pair>
            <Pair label={achievement.kind === 'single' ? 'Would earn it' : 'Would earn a tier'}>
              {newlyEarnedText(achievement, result)}
            </Pair>
          </Pairs>

          {lost > 0 ? (
            <span className="achievements-editor-check">
              <Checkbox
                checked={acceptLoss}
                onChange={setAcceptLoss}
                label={`${lossSentence(lost)} Rebuild anyway.`}
              />
              <span aria-hidden="true">
                {lossSentence(lost)} <strong>Rebuild anyway.</strong>
              </span>
            </span>
          ) : null}

          <span className="achievements-editor-check">
            <Switch
              checked={announce}
              onChange={setAnnounce}
              label={ANNOUNCE_REBUILD}
              describedBy={announceHint}
            />
            <span className="stack stack-4">
              <span aria-hidden="true">{ANNOUNCE_REBUILD}</span>
              <span id={announceHint} className="text-xs text-muted">
                {ANNOUNCE_REBUILD_HELP}
              </span>
            </span>
          </span>

          {confirmFailure !== null ? (
            <StatusBanner tone="danger" live="assertive">
              {confirmFailure}
            </StatusBanner>
          ) : null}
        </>
      )}
    </Dialog>
  );
}

function ResetDialog({
  guildId,
  achievementId,
  name,
  open,
  onClose,
  onDone,
}: {
  guildId: string;
  achievementId: string;
  name: string;
  open: boolean;
  onClose: () => void;
  onDone: (members: number) => void;
}): ReactElement | null {
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState('');
  const [again, setAgain] = useState(false);
  const [againConfirmed, setAgainConfirmed] = useState(false);
  const [requestId, setRequestId] = useState(newRequestId);
  const [failure, setFailure] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTyped('');
      setAgain(false);
      setAgainConfirmed(false);
      setFailure(null);
      setRequestId(newRequestId());
    }
  }

  const reset = useMutation({
    ...resetAchievementsMutation(queryClient, guildId),
    onSuccess: (result) => onDone(result.members),
    onError: (error: Error) => setFailure(refusal(error, 'Couldn’t reset this achievement')),
  });

  const ready = typed.trim() === name && (!again || againConfirmed);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!reset.isPending}
      title={`Reset ${name} for everyone?`}
      size="compact"
      icon="warning"
      tone="danger"
      footer={
        <>
          <Button onClick={onClose} disabled={reset.isPending}>
            Cancel
          </Button>
          <Button
            tone="danger"
            busy={reset.isPending}
            disabled={!ready}
            onClick={() => {
              setFailure(null);
              reset.mutate({
                scope: 'achievement',
                requestId,
                achievementId,
                allowRewardsAgain: again,
                confirmation: typed.trim(),
              });
            }}
          >
            Reset for everyone
          </Button>
        </>
      }
    >
      <p className="text-sm text-secondary">{RESET_CONSEQUENCE}</p>

      {failure !== null ? (
        <StatusBanner tone="danger" live="assertive">
          {failure}
        </StatusBanner>
      ) : null}

      <Field
        label="Achievement name"
        hint={
          <>
            Type <strong>{name}</strong> to confirm.
          </>
        }
      >
        {(props) => (
          <TextInput
            {...props}
            width="full"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
          />
        )}
      </Field>

      <span className="achievements-editor-check">
        <Checkbox
          checked={again}
          label={REWARDS_AGAIN}
          onChange={(next) => {
            setAgain(next);
            if (!next) setAgainConfirmed(false);
          }}
        />
        <span aria-hidden="true">{REWARDS_AGAIN}</span>
      </span>

      {again ? (
        <span className="achievements-editor-check achievements-editor-check-follow">
          <Checkbox
            checked={againConfirmed}
            label={REWARDS_AGAIN_CONFIRM}
            onChange={setAgainConfirmed}
          />
          <span aria-hidden="true">{REWARDS_AGAIN_CONFIRM}</span>
        </span>
      ) : null}
    </Dialog>
  );
}

export function ProgressPanel({
  guildId,
  moduleId,
  form,
  achievement,
}: {
  guildId: string;
  moduleId: string;
  form: Form;
  achievement: Achievement;
}): ReactElement {
  const queryClient = useQueryClient();
  const overview = useQuery(achievementsOverviewQuery(guildId));
  const context = useStatusContext(guildId);
  const noteId = useId();

  const stored = form.view.config;
  const saved = useMemo(
    () => savedAchievement(savedConfig(stored), achievement.id),
    [stored, achievement.id],
  );

  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [rebuild, setRebuild] = useState<{ sentAt: number } | null>(null);
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);
  const [runFailure, setRunFailure] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const recheck = useMutation({
    ...requestAchievementJobMutation(queryClient, guildId),
    onSuccess: () => setFailure(null),
    onError: (error: Error) => setFailure(refusal(error, 'Couldn’t start the re-check')),
  });
  const preview = useMutation(requestAchievementJobMutation(queryClient, guildId));
  const run = useMutation(requestAchievementJobMutation(queryClient, guildId));

  const zone = form.value.timezone;
  const entry = overviewOf(overview.data, achievement.id);
  const job = entry?.job ?? null;

  const unsaved = saved === undefined || !sameValue(saved, achievement);
  const working = jobInFlight(entry);
  const waiting = waitingForStart(entry);
  const stranded =
    job !== null && !working && !waiting && (job.status === 'queued' || job.status === 'running');
  const jobNote = !context.moduleEnabled ? MODULE_OFF_NOTE : working ? JOB_BUSY_NOTE : null;
  const note = unsaved ? UNSAVED_NOTE : jobNote;
  const describedBy = note === null ? undefined : noteId;

  const startPreview = (): void => {
    setPreviewFailure(null);
    setRunFailure(null);
    setRebuild({ sentAt: Date.now() });
    preview.mutate(
      {
        requestId: newRequestId(),
        achievementId: achievement.id,
        job: 'rebuild_preview',
        announce: false,
        acceptLoss: false,
      },
      {
        onError: (error: Error) =>
          setPreviewFailure(refusal(error, 'Couldn’t start the rebuild preview')),
      },
    );
  };

  const confirmRebuild = (announce: boolean, acceptLoss: boolean): void => {
    setRunFailure(null);
    run.mutate(
      {
        requestId: newRequestId(),
        achievementId: achievement.id,
        job: 'rebuild',
        announce,
        acceptLoss,
      },
      {
        onSuccess: () => setRebuild(null),
        onError: (error: Error) => setRunFailure(refusal(error, 'Couldn’t start the rebuild')),
      },
    );
  };

  return (
    <>
      <Section label="Members">
        {saved === undefined ? (
          <EmptyState icon="users" title="No progress yet" inset>
            {NOTHING_YET}
          </EmptyState>
        ) : overview.isPending ? (
          <LoadingArea label="Loading progress" minHeight={160} />
        ) : overview.isError ? (
          <StatusBanner
            tone="danger"
            live="polite"
            actions={
              <Button size="sm" busy={overview.isFetching} onClick={() => void overview.refetch()}>
                Try again
              </Button>
            }
          >
            {readFailure(overview.error, 'this achievement’s progress')}
          </StatusBanner>
        ) : (
          <HolderRows
            achievement={achievement}
            entry={entry}
            guildId={guildId}
            moduleId={moduleId}
          />
        )}
      </Section>

      <Section label="Recount">
        {note !== null || failure !== null || done !== null ? (
          <div className="achievements-editor-lead">
            {note !== null ? <p id={noteId}>{note}</p> : null}

            {failure !== null ? (
              <StatusBanner tone="danger" live="assertive" onDismiss={() => setFailure(null)}>
                {failure}
              </StatusBanner>
            ) : null}

            {done !== null ? (
              <StatusBanner tone="success" live="polite" onDismiss={() => setDone(null)}>
                {done}
              </StatusBanner>
            ) : null}
          </div>
        ) : null}

        <Rows className="achievements-editor-recount">
          <ActionRow title="Apply new targets now" description={RECHECK_HELP}>
            <Button
              busy={recheck.isPending}
              disabled={note !== null}
              aria-describedby={describedBy}
              onClick={() =>
                recheck.mutate({
                  requestId: newRequestId(),
                  achievementId: achievement.id,
                  job: 'recheck',
                  announce: false,
                  acceptLoss: false,
                })
              }
            >
              Re-check members
            </Button>
          </ActionRow>

          <ActionRow title="Recorded activity" description={REBUILD_HELP}>
            <Button
              busy={preview.isPending}
              disabled={note !== null}
              aria-describedby={describedBy}
              onClick={startPreview}
            >
              Rebuild from recorded activity…
            </Button>
          </ActionRow>

          <ActionRow title="Start over" description={RESET_HELP}>
            <Button
              tone="danger-quiet"
              disabled={unsaved}
              aria-describedby={unsaved ? noteId : undefined}
              onClick={() => {
                setDone(null);
                setResetting(true);
              }}
            >
              Reset for everyone…
            </Button>
          </ActionRow>
        </Rows>

        {job !== null ? (
          <p className="achievements-editor-job">
            {stranded ? (
              JOB_STRANDED
            ) : (
              <JobStatus
                job={job}
                zone={zone}
                waitingUntil={waiting ? (entry?.startsAt ?? null) : null}
              />
            )}
          </p>
        ) : null}
      </Section>

      <RebuildDialog
        open={rebuild !== null}
        achievement={saved ?? achievement}
        job={job}
        sentAt={rebuild?.sentAt ?? null}
        starting={preview.isPending}
        failure={previewFailure}
        confirming={run.isPending}
        confirmFailure={runFailure}
        onRetry={startPreview}
        onConfirm={confirmRebuild}
        onClose={() => setRebuild(null)}
      />

      {saved !== undefined ? (
        <ResetDialog
          guildId={guildId}
          achievementId={saved.id}
          name={saved.name}
          open={resetting}
          onClose={() => setResetting(false)}
          onDone={(members) => {
            setResetting(false);
            setDone(`${saved.name} was reset for ${membersLabel(members)}.`);
          }}
        />
      ) : null}
    </>
  );
}

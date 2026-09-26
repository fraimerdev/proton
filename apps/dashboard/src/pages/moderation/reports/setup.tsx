import { parseComponentEmoji } from '@proton/core';
import { refineReportsWrite } from '@proton/module-moderation/config';
import { describeRule } from '@proton/module-moderation/rule-summary';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChannelName } from '../../../components/discord/channel-picker.tsx';
import { EmojiGlyph } from '../../../components/discord/emoji-picker.tsx';
import { Button } from '../../../components/ui/controls.tsx';
import { StatusBanner } from '../../../components/ui/feedback.tsx';
import { Icon } from '../../../components/ui/icon.tsx';
import { Rows, Section, SettingRow } from '../../../components/ui/layout.tsx';
import { type ModerationForm, type Problems, useSavedConfig } from '../punish-shape.ts';
import {
  ChannelSection,
  EvidenceSection,
  LimitsSection,
  MethodsSection,
  ReasonsSection,
  ReportersSection,
  useReportNames,
} from './sections.tsx';
import {
  evidenceSentence,
  firstProblemStep,
  immuneSentence,
  limitsSentence,
  methodsSentence,
  notificationsSentence,
  problemSteps,
  reactionSentence,
  reasonsSentence,
  reportersSentence,
  reviewersSentence,
  rolesText,
  SETUP_STEPS,
  type SetupStep,
  stepIndex,
  stepName,
  stepOfPath,
  stepState,
  tabOfPath,
} from './shape.ts';

const INTRO =
  'Members report someone with /report, from the Apps menu or with a reaction. Each report goes ' +
  'to a staff channel, where reviewers accept or dismiss it.';

const OUTSIDE_PROBLEM =
  'A setting outside User reports needs fixing first. The message at the top of the page says which.';

const LATER_TABS = {
  'reports-settings': 'Settings',
  'reports-automation': 'Automation',
  'reports-messages': 'Messages',
} as const;

function topbarClearance(): number {
  const topbar = getComputedStyle(document.documentElement).getPropertyValue('--topbar-height');
  return (Number.parseFloat(topbar) || 0) + 16;
}

interface SetupProps {
  guildId: string;
  form: ModerationForm;
  problems: Problems;
}

export function ReportsSetup({
  guildId,
  form,
  problems,
  started,
  onStart,
  onLeave,
  onFinish,
}: SetupProps & {
  started: boolean;
  onStart: () => void;
  onLeave: () => void;
  onFinish: () => void;
}): ReactElement {
  if (!started) return <Intro onStart={onStart} />;

  return (
    <Wizard
      guildId={guildId}
      form={form}
      problems={problems}
      onLeave={onLeave}
      onFinish={onFinish}
    />
  );
}

function Intro({ onStart }: { onStart: () => void }): ReactElement {
  return (
    <>
      <Section intro={INTRO}>
        <Rows>
          <SettingRow
            title="Staff"
            description="See each report in one channel, including who filed it."
          />
          <SettingRow
            title="Reporters"
            description="Get a private confirmation, and a DM when staff accept or dismiss their report."
            help="Both DMs can be turned off under Messages."
          />
          <SettingRow
            title="The reported member"
            description="Is never told who reported them. They only hear about a report if an automation rule messages them or staff punish them."
          />
        </Rows>
      </Section>

      <div className="moderation-report-start">
        <Button tone="primary" onClick={onStart}>
          Set up user reports
        </Button>
        <span className="text-muted text-sm">
          Five short steps. Nothing is turned on until the last one.
        </span>
      </div>
    </>
  );
}

function StepIndicator({
  current,
  visited,
  problems,
  form,
  onPick,
}: {
  current: SetupStep;
  visited: ReadonlySet<SetupStep>;
  problems: ReadonlySet<SetupStep>;
  form: ModerationForm;
  onPick: (step: SetupStep) => void;
}): ReactElement {
  const position = stepIndex(current) + 1;

  return (
    <nav className="moderation-report-steps" aria-label="Setup steps">
      <ol className="moderation-report-step-list">
        {SETUP_STEPS.map((step, index) => {
          const state = stepState(step.id, {
            current,
            visited,
            problems,
            reports: form.value.reports,
          });

          return (
            <li
              key={step.id}
              className={state === 'current' ? 'moderation-report-step-here' : undefined}
            >
              <button
                type="button"
                className="moderation-report-step"
                data-state={state}
                aria-current={state === 'current' ? 'step' : undefined}
                aria-label={stepName(step.label, state)}
                onClick={() => onPick(step.id)}
              >
                <span className="moderation-report-step-mark" aria-hidden>
                  {state === 'done' ? (
                    <Icon name="check" size={12} weight="fill" />
                  ) : state === 'problem' ? (
                    <Icon name="warning" size={12} weight="fill" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="moderation-report-step-label">{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="moderation-report-step-count" aria-hidden>
        Step {position} of {SETUP_STEPS.length}
      </p>
    </nav>
  );
}

function Wizard({
  guildId,
  form,
  problems,
  onLeave,
  onFinish,
}: SetupProps & { onLeave: () => void; onFinish: () => void }): ReactElement {
  const [step, setStep] = useState<SetupStep>('methods');
  const [visited, setVisited] = useState<ReadonlySet<SetupStep>>(
    () => new Set<SetupStep>(['methods']),
  );
  const [attempted, setAttempted] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [blocker, setBlocker] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);

  const saved = useSavedConfig(form);
  const reports = form.value.reports;

  const enableIssues = useMemo(() => refineReportsWrite({ ...reports, enabled: true }), [reports]);

  const checked = useMemo<Problems>(() => {
    if (!attempted) return problems;

    const extra = new Map<string, string>();
    for (const issue of enableIssues) {
      if (!extra.has(issue.path)) extra.set(issue.path, issue.message);
    }

    return {
      at: (path: string) => problems.at(path) ?? extra.get(path),
      paths: [...new Set([...problems.paths, ...extra.keys()])],
    };
  }, [attempted, problems, enableIssues]);

  const flagged = useMemo(() => problemSteps(checked.paths), [checked.paths]);

  const go = (next: SetupStep): void => {
    setStep(next);
    setVisited((current) => new Set(current).add(next));

    const head = top.current;
    if (head !== null && head.getBoundingClientRect().top < topbarClearance()) {
      head.scrollIntoView({ block: 'start' });
    }
  };

  const failures = form.failures;
  const seenFailures = useRef(failures);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new failed save should move the wizard
  useEffect(() => {
    if (failures === seenFailures.current) return;
    seenFailures.current = failures;

    const first = firstProblemStep(form.errors.keys()) ?? firstProblemStep(checked.paths);
    if (first !== null) go(first);
  }, [failures]);

  const enabled = form.value.reports.enabled;
  const { save } = form;

  useEffect(() => {
    if (!enabling || !enabled) return;
    setEnabling(false);
    save();
  }, [enabling, enabled, save]);

  const live = saved?.reports.enabled === true;

  useEffect(() => {
    if (live) onFinish();
  }, [live, onFinish]);

  const enable = (): void => {
    setAttempted(true);

    const issues = new Map<string, string>();
    for (const issue of enableIssues) issues.set(issue.path, issue.message);
    for (const path of problems.paths) issues.set(path, problems.at(path) ?? '');

    const first = firstProblemStep(issues.keys());

    if (first !== null && first !== 'review') {
      setBlocker(null);
      go(first);
      return;
    }

    const later = [...issues.keys()].find((path) => stepOfPath(path) === 'review');
    const tab = later === undefined ? null : tabOfPath(later);

    if (later !== undefined && tab !== null) {
      setBlocker(`Under ${LATER_TABS[tab]}: ${issues.get(later) ?? 'a setting needs fixing.'}`);
      return;
    }

    if (issues.size > 0) {
      setBlocker(OUTSIDE_PROBLEM);
      return;
    }

    setBlocker(null);
    form.set('reports.enabled', true);
    setEnabling(true);
  };

  const index = stepIndex(step);
  const previous = SETUP_STEPS[index - 1]?.id;
  const next = SETUP_STEPS[index + 1]?.id;

  const stepIssues = attempted
    ? enableIssues.filter((issue) => stepOfPath(issue.path) === step)
    : [];

  const props = { guildId, form, problems: checked };

  return (
    <div className="moderation-report-setup">
      <div ref={top} className="moderation-report-setup-head">
        <StepIndicator
          current={step}
          visited={visited}
          problems={flagged}
          form={form}
          onPick={go}
        />
      </div>

      {stepIssues.length > 0 && step !== 'review' ? (
        <div className="moderation-report-banner">
          <StatusBanner tone="danger" live="polite">
            {stepIssues[0]?.message}
          </StatusBanner>
        </div>
      ) : null}

      {step === 'methods' ? <MethodsSection {...props} /> : null}

      {step === 'channel' ? <ChannelSection {...props} /> : null}

      {step === 'reasons' ? (
        <>
          <ReasonsSection form={form} problems={checked} />
          <EvidenceSection form={form} problems={checked} />
        </>
      ) : null}

      {step === 'reporters' ? (
        <>
          <ReportersSection {...props} />
          <LimitsSection {...props} />
        </>
      ) : null}

      {step === 'review' ? (
        <Review
          guildId={guildId}
          form={form}
          problems={checked}
          flagged={flagged}
          blocker={blocker}
          onEdit={go}
        />
      ) : null}

      <div className="moderation-report-step-nav">
        <Button tone="ghost" onClick={onLeave}>
          Leave setup
        </Button>

        <span className="moderation-report-step-buttons">
          {previous !== undefined ? (
            <Button icon="caret-left" onClick={() => go(previous)}>
              Back
            </Button>
          ) : null}

          {next !== undefined ? (
            <Button tone="primary" trailingIcon="caret-right" onClick={() => go(next)}>
              Continue
            </Button>
          ) : (
            <Button tone="primary" busy={form.saving || enabling} onClick={enable}>
              Turn user reports on
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}

function SummaryRow({
  title,
  step,
  error,
  onEdit,
  children,
}: {
  title: string;
  step: SetupStep;
  error?: string | undefined;
  onEdit: (step: SetupStep) => void;
  children: ReactNode;
}): ReactElement {
  return (
    <SettingRow title={title} description={children} error={error}>
      <Button
        tone="ghost"
        size="sm"
        aria-label={`Edit ${title.toLowerCase()}`}
        onClick={() => onEdit(step)}
      >
        Edit
      </Button>
    </SettingRow>
  );
}

function Review({
  guildId,
  form,
  problems,
  flagged,
  blocker,
  onEdit,
}: SetupProps & {
  flagged: ReadonlySet<SetupStep>;
  blocker: string | null;
  onEdit: (step: SetupStep) => void;
}): ReactElement {
  const names = useReportNames(guildId);
  const config = form.value;
  const reports = config.reports;
  const pending = SETUP_STEPS.filter((step) => step.id !== 'review' && flagged.has(step.id));

  return (
    <>
      {pending.length > 0 ? (
        <div className="moderation-report-banner">
          <StatusBanner tone="danger" live="polite">
            {`Fix ${pending.map((step) => step.label.toLowerCase()).join(' and ')} before you turn user reports on.`}
          </StatusBanner>
        </div>
      ) : blocker !== null ? (
        <div className="moderation-report-banner">
          <StatusBanner tone="danger" live="polite">
            {blocker}
          </StatusBanner>
        </div>
      ) : null}

      <Section
        label="Your setup"
        intro="Check each part, then turn user reports on. You can change all of it later under Settings."
      >
        <Rows>
          <SummaryRow
            title="Reporting methods"
            step="methods"
            error={problems.at('reports.methods')}
            onEdit={onEdit}
          >
            {methodsSentence(reports)}
          </SummaryRow>

          {reports.methods.reaction ? (
            <SummaryRow title="Reactions" step="methods" onEdit={onEdit}>
              <span className="moderation-report-emoji">
                <EmojiGlyph emoji={parseComponentEmoji(reports.reaction.emoji)} size={16} />
                <span>{reactionSentence(reports, names)}</span>
              </span>
            </SummaryRow>
          ) : null}

          <SummaryRow
            title="Report channel"
            step="channel"
            error={problems.at('reports.channelId')}
            onEdit={onEdit}
          >
            {reports.channelId === undefined ? (
              'Not chosen yet'
            ) : (
              <ChannelName guildId={guildId} id={reports.channelId} />
            )}
          </SummaryRow>

          <SummaryRow title="Roles to notify" step="channel" onEdit={onEdit}>
            {reports.notifyRoleIds.length === 0
              ? 'Nobody is mentioned'
              : rolesText(reports.notifyRoleIds, names)}
          </SummaryRow>

          <SummaryRow
            title="Reasons"
            step="reasons"
            error={problems.at('reports.requireReason')}
            onEdit={onEdit}
          >
            {reasonsSentence(reports)}
          </SummaryRow>

          <SummaryRow title="Evidence" step="reasons" onEdit={onEdit}>
            {evidenceSentence(reports)}
          </SummaryRow>

          <SummaryRow title="Who can report" step="reporters" onEdit={onEdit}>
            {reportersSentence(reports, names)}
          </SummaryRow>

          <SummaryRow title="Immune roles" step="reporters" onEdit={onEdit}>
            {immuneSentence(reports, names)}
          </SummaryRow>

          <SummaryRow title="Reviewers" step="reporters" onEdit={onEdit}>
            {reviewersSentence(reports, names)}
          </SummaryRow>

          <SummaryRow
            title="Limits"
            step="reporters"
            error={problems.at('reports.limits.maxOpenPerMember')}
            onEdit={onEdit}
          >
            {limitsSentence(reports)}
          </SummaryRow>
        </Rows>
      </Section>

      <Section
        label="Automation"
        intro="What Proton does on its own. Change or add rules under Automation after setup."
      >
        <Rows>
          {reports.automation.length === 0 ? (
            <SettingRow
              title="No rules"
              description="Nothing happens automatically. Staff review every report."
            />
          ) : (
            reports.automation.map((rule) => (
              <SettingRow
                key={rule.id}
                title={rule.name}
                description={describeRule(rule, config, names)}
              />
            ))
          )}
        </Rows>
      </Section>

      <Section label="Messages">
        <Rows>
          <SettingRow
            title="Reporter messages"
            description="DMs to the reporter when their report is received, accepted or dismissed. Edit them under Messages after setup."
          >
            <span className="moderation-aside text-muted text-sm">
              {notificationsSentence(reports)}
            </span>
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}

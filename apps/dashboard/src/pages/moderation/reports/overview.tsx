import { useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { ChannelName } from '../../../components/discord/channel-picker.tsx';
import { ModuleLink } from '../../../components/module/route.tsx';
import { Spinner, StatusBanner } from '../../../components/ui/feedback.tsx';
import { NavigationRow, Rows, Section } from '../../../components/ui/layout.tsx';
import { readFailure } from '../../../lib/errors.ts';
import type { ModerationForm, Problems } from '../punish-shape.ts';
import { reportSummaryQuery } from './queries.ts';
import { useReportNames } from './sections.tsx';
import {
  closingSentence,
  enabledMethods,
  evidenceSentence,
  limitsSentence,
  methodsSentence,
  notificationsSentence,
  openLine,
  problemSteps,
  reportersSentence,
  reviewersSentence,
  tabOfPath,
} from './shape.ts';
import { useNow } from './when.tsx';

const OFF =
  'User reports are off. Members who try to report are told so. Open reports stay in the queue ' +
  'and staff can still review them.';

function Aside({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'danger' | 'warning';
  children: ReactNode;
}): ReactElement {
  return <span className={`moderation-aside text-sm text-${tone}`}>{children}</span>;
}

function Count({
  pending,
  value,
  alarm = false,
}: {
  pending: boolean;
  value: number | undefined;
  alarm?: boolean | undefined;
}): ReactElement | null {
  if (pending) return <Spinner label="Loading report counts" />;
  if (value === undefined) return null;
  if (value === 0) return <Aside>None</Aside>;

  return <Aside tone={alarm ? 'danger' : 'muted'}>{value.toLocaleString('en-US')}</Aside>;
}

export function ReportsOverview({
  guildId,
  moduleId,
  form,
  problems,
}: {
  guildId: string;
  moduleId: string;
  form: ModerationForm;
  problems: Problems;
}): ReactElement {
  const summary = useQuery(reportSummaryQuery(guildId));
  const names = useReportNames(guildId);
  const now = useNow(summary.dataUpdatedAt);

  const reports = form.value.reports;
  const counts = summary.data;
  const broken = new Set(problems.paths.map(tabOfPath));
  const steps = problemSteps(problems.paths);
  const closingBroken = problems.paths.some((path) => path.startsWith('reports.closing.'));

  const fix = <Aside tone="danger">Needs fixing</Aside>;

  const methodsOn = enabledMethods(reports).length;
  const rulesOn = reports.automation.filter((rule) => rule.enabled).length;
  const reasons = reports.reasons.length;

  const row = { guildId, moduleId };
  const settings = { area: 'reports-settings' };

  return (
    <>
      {!reports.enabled || summary.error !== null ? (
        <div className="moderation-report-banners">
          {!reports.enabled ? (
            <StatusBanner
              tone="neutral"
              actions={
                <ModuleLink
                  guildId={guildId}
                  moduleId={moduleId}
                  search={settings}
                  className="button button-secondary button-sm"
                >
                  Open settings
                </ModuleLink>
              }
            >
              {OFF}
            </StatusBanner>
          ) : null}

          {summary.error !== null ? (
            <StatusBanner tone="danger" live="polite">
              {readFailure(summary.error, 'the report counts')}
            </StatusBanner>
          ) : null}
        </div>
      ) : null}

      <Section label="Queue">
        <Rows>
          <NavigationRow
            {...row}
            search={{ area: 'reports-queue', status: 'open' }}
            icon="flag"
            title="Open"
            description="Waiting for someone on staff to claim them."
            aside={
              summary.isPending ? (
                <Spinner label="Loading open reports" />
              ) : counts ? (
                <Aside>{openLine(counts.counts.open, counts.oldestOpenAt, now)}</Aside>
              ) : null
            }
          />

          <NavigationRow
            {...row}
            search={{ area: 'reports-queue', status: 'in_review' }}
            icon="eye"
            title="In review"
            description="Claimed by someone on staff who hasn’t decided yet."
            aside={<Count pending={summary.isPending} value={counts?.counts.in_review} />}
          />

          <NavigationRow
            {...row}
            search={{ area: 'reports-queue', status: 'problem' }}
            icon="warning-circle"
            title="Delivery problems"
            description="Reports whose card didn’t reach the report channel, or was deleted there."
            aside={<Count pending={summary.isPending} value={counts?.deliveryProblems} alarm />}
          />

          <NavigationRow
            {...row}
            search={{ area: 'reports-automation', status: 'problem' }}
            icon="siren"
            title="Automation failures"
            description="Automation runs in the last 7 days where a step didn’t go through."
            aside={<Count pending={summary.isPending} value={counts?.automationFailures7d} alarm />}
          />

          {counts !== undefined && counts.closeProblems > 0 ? (
            <NavigationRow
              {...row}
              search={{ area: 'reports-queue', status: 'close-problem' }}
              icon="archive"
              title="Closing problems"
              description="Decided reports whose card Proton couldn’t move or delete."
              aside={<Count pending={false} value={counts.closeProblems} alarm />}
            />
          ) : null}
        </Rows>
      </Section>

      <Section label="Configuration">
        <Rows>
          <NavigationRow
            {...row}
            search={settings}
            icon="chat-centered-text"
            title="Reporting methods"
            description={methodsSentence(reports)}
            aside={steps.has('methods') ? fix : <Aside>{`${methodsOn} of 4 on`}</Aside>}
          />

          <NavigationRow
            {...row}
            search={settings}
            icon="hash"
            title="Report channel"
            description={
              reports.notifyRoleIds.length === 0
                ? 'Where new reports are posted. Nobody is mentioned.'
                : 'Where new reports are posted, mentioning the roles to notify.'
            }
            aside={
              steps.has('channel') ? (
                fix
              ) : reports.channelId === undefined ? (
                <Aside tone="danger">Not chosen</Aside>
              ) : (
                <Aside>
                  <ChannelName guildId={guildId} id={reports.channelId} />
                </Aside>
              )
            }
          />

          <NavigationRow
            {...row}
            search={settings}
            icon="list-checks"
            title="Reasons and evidence"
            description={evidenceSentence(reports)}
            aside={
              steps.has('reasons') ? (
                fix
              ) : (
                <Aside>{reasons === 0 ? 'No reasons' : `${reasons} reasons`}</Aside>
              )
            }
          />

          <NavigationRow
            {...row}
            search={settings}
            icon="users-three"
            title="Who can report"
            description={`Reviewers: ${reviewersSentence(reports, names)}.`}
            aside={
              steps.has('reporters') ? fix : <Aside>{reportersSentence(reports, names)}</Aside>
            }
          />

          <NavigationRow
            {...row}
            search={settings}
            icon="alarm"
            title="Limits"
            description={limitsSentence(reports)}
          />

          <NavigationRow
            {...row}
            search={settings}
            icon="archive"
            title="Closing"
            description={`Accepted: ${closingSentence(reports.closing.accepted, names)}. Dismissed: ${closingSentence(reports.closing.dismissed, names)}.`}
            aside={closingBroken ? fix : undefined}
          />

          <NavigationRow
            {...row}
            search={{ area: 'reports-automation' }}
            icon="pulse"
            title="Automation rules"
            description="What Proton does on its own when reports pile up."
            aside={
              broken.has('reports-automation') ? (
                fix
              ) : (
                <Aside>
                  {reports.automation.length === 0
                    ? 'No rules'
                    : `${rulesOn} of ${reports.automation.length} on`}
                </Aside>
              )
            }
          />

          <NavigationRow
            {...row}
            search={{ area: 'reports-messages' }}
            icon="chat-teardrop-text"
            title="Messages"
            description="DMs to reporters, and the card staff see."
            aside={
              broken.has('reports-messages') ? fix : <Aside>{notificationsSentence(reports)}</Aside>
            }
          />
        </Rows>
      </Section>
    </>
  );
}

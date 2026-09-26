import type { ModerationConfig } from '@proton/module-moderation/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useCallback, useState } from 'react';
import { ModuleLink } from '../../../components/module/route.tsx';
import { StatusBanner } from '../../../components/ui/feedback.tsx';
import { AreaTabs } from '../../../components/ui/tabs.tsx';
import type { AreaMeta, ModuleMeta } from '../../../lib/modules/catalogue.ts';
import { type ModerationForm, useProblems, useSavedConfig } from '../punish-shape.ts';
import { ReportAutomationArea } from './automation.tsx';
import { ReportMessagesArea } from './messages.tsx';
import { ReportsOverview } from './overview.tsx';
import { reportSummaryQuery } from './queries.ts';
import { ReportQueueArea } from './queue.tsx';
import { ReportSettingsArea } from './settings.tsx';
import { ReportsSetup } from './setup.tsx';
import { notSetUp, type ReportTab, tabOfPath } from './shape.ts';

const REPORT_AREAS: readonly AreaMeta[] = [
  { id: 'reports', label: 'Overview' },
  { id: 'reports-queue', label: 'Queue' },
  { id: 'reports-settings', label: 'Settings' },
  { id: 'reports-automation', label: 'Automation' },
  { id: 'reports-messages', label: 'Messages' },
];

const TAB_LABELS: Readonly<Record<ReportTab, string>> = {
  'reports-settings': 'Settings',
  'reports-automation': 'Automation',
  'reports-messages': 'Messages',
};

export function ReportsArea({
  guildId,
  moduleId,
  area,
  form,
}: {
  guildId: string;
  moduleId: string;
  meta: ModuleMeta;
  area: string;
  form: ModerationForm;
}): ReactElement {
  const saved = useSavedConfig(form);
  const problems = useProblems(form);
  const [setupActive, setSetupActive] = useState(false);
  const setup = setupActive || notSetUp(saved);

  const summary = useQuery({ ...reportSummaryQuery(guildId), enabled: !setup });

  const start = useCallback(() => setSetupActive(true), []);
  const finish = useCallback(() => setSetupActive(false), []);

  if (setup) {
    return (
      <ReportsSetup
        guildId={guildId}
        form={form}
        problems={problems}
        started={setupActive}
        onStart={start}
        onLeave={finish}
        onFinish={finish}
      />
    );
  }

  const counts = summary.data?.counts;
  const elsewhere = problems.paths
    .map(tabOfPath)
    .find((tab): tab is ReportTab => tab !== null && tab !== area);

  return (
    <>
      <AreaTabs
        guildId={guildId}
        moduleId={moduleId}
        areas={REPORT_AREAS}
        current={area}
        counts={{
          'reports-queue': counts === undefined ? undefined : counts.open + counts.in_review,
        }}
      />

      {elsewhere !== undefined && area !== 'reports' ? (
        <div className="moderation-report-banner">
          <StatusBanner
            tone="danger"
            actions={
              <ModuleLink
                guildId={guildId}
                moduleId={moduleId}
                search={{ area: elsewhere }}
                className="button button-secondary button-sm"
              >
                Open {TAB_LABELS[elsewhere]}
              </ModuleLink>
            }
          >
            {`A setting under ${TAB_LABELS[elsewhere]} needs fixing before you can save.`}
          </StatusBanner>
        </div>
      ) : null}

      {area === 'reports' ? (
        <ReportsOverview guildId={guildId} moduleId={moduleId} form={form} problems={problems} />
      ) : null}

      {area === 'reports-queue' ? <ReportQueueArea guildId={guildId} moduleId={moduleId} /> : null}

      {area === 'reports-settings' ? (
        <ReportSettingsArea guildId={guildId} form={form} problems={problems} />
      ) : null}

      {area === 'reports-automation' ? (
        <ReportAutomationArea
          guildId={guildId}
          moduleId={moduleId}
          form={form}
          problems={problems}
        />
      ) : null}

      {area === 'reports-messages' ? (
        <ReportMessagesArea guildId={guildId} form={form} problems={problems} />
      ) : null}
    </>
  );
}

export function ReportsAside({
  guildId,
  saved,
  broken,
}: {
  guildId: string;
  saved: ModerationConfig | null;
  broken: boolean;
}): ReactElement | null {
  const live = saved?.reports.enabled === true;
  const summary = useQuery({ ...reportSummaryQuery(guildId), enabled: live });

  if (broken) return <span className="moderation-aside text-danger text-sm">Needs fixing</span>;
  if (saved === null) return null;

  const counts = summary.data?.counts;
  const active = counts === undefined ? 0 : counts.open + counts.in_review;

  const text = live
    ? active > 0
      ? `${active.toLocaleString('en-US')} open`
      : 'On'
    : saved.reports.channelId === undefined
      ? 'Not set up'
      : 'Off';

  return <span className="moderation-aside text-muted text-sm">{text}</span>;
}

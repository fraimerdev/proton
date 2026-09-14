import type { ModuleSummary } from '@proton/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { areaMeta, MODULE_BY_ID, type ModuleMeta } from '../../lib/modules/catalogue.ts';
import { modulesQuery } from '../../lib/queries.ts';
import { Workspace } from '../shell/app-shell.tsx';
import { LoadingArea } from '../ui/feedback.tsx';
import { RoutePending } from '../ui/pending.tsx';
import { AreaTabs } from '../ui/tabs.tsx';
import { ModuleHeader, ModuleSwitch, moduleState } from './page.tsx';
import { useGuildId, useModuleSearch } from './route.tsx';

const INERT = (): void => undefined;

export function ModuleLoading({
  guildId,
  meta,
  summary,
  area,
  fallback = false,
}: {
  guildId: string;
  meta: ModuleMeta;
  summary: ModuleSummary | undefined;
  area: string;
  fallback?: boolean | undefined;
}): ReactElement {
  return (
    <>
      <ModuleHeader
        meta={meta}
        subtitle={meta.subtitle}
        actions={
          summary ? (
            <ModuleSwitch
              name={meta.label}
              enabled={summary.enabled}
              state={moduleState(summary)}
              onToggle={INERT}
              pending
            />
          ) : undefined
        }
      />

      {meta.areaStyle === 'tabs' && meta.areas ? (
        <AreaTabs guildId={guildId} moduleId={meta.id} areas={meta.areas} current={area} />
      ) : null}

      <LoadingArea
        label={`Loading ${meta.label}`}
        minHeight={280}
        size="lg"
        fill
        fallback={fallback}
      />
    </>
  );
}

export function ModulePending({ moduleId }: { moduleId: string }): ReactElement {
  const guildId = useGuildId();
  const { area } = useModuleSearch();
  const { data } = useQuery(modulesQuery(guildId));

  const meta = MODULE_BY_ID.get(moduleId);
  if (!meta) return <RoutePending />;

  return (
    <Workspace>
      <ModuleLoading
        guildId={guildId}
        meta={meta}
        summary={data?.modules.find((candidate) => candidate.id === moduleId)}
        area={areaMeta(meta, area)?.id ?? ''}
        fallback
      />
    </Workspace>
  );
}

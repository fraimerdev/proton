import { casesConfigSchema } from '@proton/module-cases/config';
import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleNavigate, useModuleSearch } from '../components/module/route.tsx';
import { useModuleToggle } from '../components/module/toggle.ts';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { RoutePending } from '../components/ui/pending.tsx';
import { CaseLogArea } from './cases/log.tsx';

const SWITCHED_OFF =
  'Cases is switched off. Proton still records every action in the case log. Its No active ' +
  'moderation and Clean recent record conditions are no longer offered, but requirements that ' +
  'already use them are still checked.';

export default function CasesPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: casesConfigSchema });
  const toggle = useModuleToggle(guildId, summary);
  const search = useModuleSearch();
  const toModeration = useModuleNavigate(guildId, 'moderation');

  // Not a Cases area any more: warn escalation moved to Moderation, and this would fall back to the log.
  const moved = search.area === 'escalation';

  useEffect(() => {
    if (!moved) return;

    toModeration(
      {
        area: 'escalation',
        id: undefined,
        q: undefined,
        page: undefined,
        status: undefined,
        sort: undefined,
        dir: undefined,
      },
      { replace: true },
    );
  }, [moved, toModeration]);

  const enabled = summary?.enabled ?? form.view.enabled;

  if (moved) return <RoutePending />;

  return (
    <>
      <ModuleHeader
        meta={meta}
        actions={
          <ModuleSwitch
            name={meta.label}
            enabled={enabled}
            state={summary ? moduleState(summary) : 'off'}
            busy={toggle.busy}
            onToggle={toggle.toggle}
          />
        }
      />

      <ModuleBanners
        guildId={guildId}
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {!enabled ? <StatusBanner tone="neutral">{SWITCHED_OFF}</StatusBanner> : null}
      </ModuleBanners>

      <CaseLogArea guildId={guildId} moduleId={meta.id} />
    </>
  );
}

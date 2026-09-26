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
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        offNote="Proton still records every action in the case log. Requirements that already use No active moderation or Clean recent record keep them, but new requirements can’t add them."
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <CaseLogArea guildId={guildId} moduleId={meta.id} />
    </>
  );
}

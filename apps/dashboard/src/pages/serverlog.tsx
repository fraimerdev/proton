import { isLogEventKey } from '@proton/module-serverlog/catalogue';
import { serverlogConfigSchema } from '@proton/module-serverlog/config';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { Button } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { AreaTabs } from '../components/ui/tabs.tsx';
import { Categories } from './serverlog/categories.tsx';
import { Events } from './serverlog/events.tsx';
import { Filters } from './serverlog/filters.tsx';

export default function ServerlogPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: serverlogConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;
  const events = form.value.events;

  const unknown = useMemo(() => Object.keys(events).filter((key) => !isLogEventKey(key)), [events]);

  const overrides = Object.keys(events).length;

  const forget = (key: string): void =>
    form.setValue((current) => {
      const next = { ...current.events };
      delete next[key];
      return { ...current, events: next };
    });

  const forgetAll = (): void =>
    form.setValue((current) => {
      const next = { ...current.events };
      for (const key of unknown) delete next[key];
      return { ...current, events: next };
    });

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

      <AreaTabs
        guildId={guildId}
        moduleId={meta.id}
        areas={meta.areas ?? []}
        current={area}
        counts={{ events: overrides > 0 ? overrides : undefined }}
      />

      <ModuleBanners
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

        {unknown.length > 0 ? (
          <StatusBanner
            tone="danger"
            live="polite"
            title="Some overrides are for events that no longer exist"
            actions={
              unknown.length > 1 ? (
                <Button tone="danger" size="sm" onClick={forgetAll}>
                  Remove all
                </Button>
              ) : undefined
            }
          >
            <ul className="serverlog-unknown">
              {unknown.map((key) => (
                <li key={key}>
                  <span className="mono">{key}</span>
                  <span className="text-muted">
                    {form.errorAt(`events.${key}`) ??
                      'Proton has no event by that name. Saving is refused until it is removed.'}
                  </span>
                  <Button tone="danger-quiet" size="sm" onClick={() => forget(key)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      {area === 'categories' ? <Categories guildId={guildId} form={form} /> : null}
      {area === 'events' ? <Events guildId={guildId} moduleId={meta.id} form={form} /> : null}
      {area === 'filters' ? <Filters guildId={guildId} form={form} /> : null}

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        failures={form.failures}
        onSave={form.save}
        onReset={form.reset}
      />
    </>
  );
}

import { countersConfigSchema } from '@proton/module-counters/config';
import { countersTemplates } from '@proton/module-counters/placeholders';
import type { ReactElement } from 'react';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { ModuleLink, useModuleNavigate, useModuleSearch } from '../components/module/route.tsx';
import { useModuleToggle } from '../components/module/toggle.ts';
import { Button } from '../components/ui/controls.tsx';
import { EmptyState, StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { CounterDetail } from './counters/detail.tsx';
import { CounterList } from './counters/list.tsx';
import { brokenCounters, TemplateName } from './counters/shape.tsx';

const GONE = 'It may have been removed.';

export default function CountersPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({
    guildId,
    moduleId: meta.id,
    schema: countersConfigSchema,
    templates: countersTemplates,
  });
  const toggle = useModuleToggle(guildId, summary);
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, meta.id);

  const counters = form.value.counters;
  const enabled = summary?.enabled ?? form.view.enabled;

  const index = counters.findIndex((candidate) => candidate.id === search.id);
  const counter = index >= 0 ? counters[index] : undefined;

  const broken = brokenCounters(counters);

  return (
    <>
      <ModuleHeader
        meta={meta}
        crumb={
          counter !== undefined ? (
            counter.template === '' ? (
              <span className="mono">{counter.id}</span>
            ) : (
              <TemplateName template={counter.template} />
            )
          ) : undefined
        }
        backTo={
          counter !== undefined ? (
            <ModuleLink guildId={guildId} moduleId={meta.id} search={{ ...search, id: undefined }}>
              Counter channels
            </ModuleLink>
          ) : undefined
        }
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

      {counter !== undefined ? (
        <CounterDetail
          form={form}
          guildId={guildId}
          index={index}
          counter={counter}
          onRemoved={() => go({ id: undefined })}
        />
      ) : search.id !== undefined ? (
        <EmptyState
          icon="warning"
          title="Counter not found"
          inset
          actions={
            <Button tone="primary" onClick={() => go({ id: undefined })}>
              Back to counter channels
            </Button>
          }
        >
          {GONE}
        </EmptyState>
      ) : (
        <CounterList
          form={form}
          guildId={guildId}
          broken={broken}
          query={search.q ?? ''}
          onQuery={(q) => go({ q: q === '' ? undefined : q })}
          onOpen={(id) => go({ id })}
        />
      )}

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        failures={form.failures}
        disabled={broken.size > 0}
        note={broken.size > 0 ? blockedNote(counters, broken, counter?.id) : undefined}
        onSave={form.save}
        onReset={form.reset}
      />
    </>
  );
}

function blockedNote(
  counters: readonly { id: string }[],
  broken: ReadonlySet<number>,
  openId: string | undefined,
): string {
  const names = counters.filter((_, index) => broken.has(index)).map((counter) => counter.id);

  if (names.length === 1 && names[0] === openId) {
    return 'Fix the marked settings before saving.';
  }
  if (names.length === 1) return `Fix ${names[0]} before saving.`;

  return `Fix ${names.length} counters before saving: ${names.join(', ')}.`;
}

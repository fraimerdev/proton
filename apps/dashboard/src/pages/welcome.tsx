import { welcomeConfigSchema } from '@proton/module-welcome/config';
import { welcomeTemplates } from '@proton/module-welcome/placeholders';
import type { ReactElement } from 'react';
import { configErrors } from '../components/discord/embed-editor.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { LoadingBoundary, StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { SegmentedTabLinks } from '../components/ui/tabs.tsx';
import { CardArea } from './welcome/card.tsx';
import { GreetingArea } from './welcome/greeting.tsx';
import type { GreetingKind } from './welcome/message.tsx';

const GREETING_AREAS: Readonly<Record<string, GreetingKind>> = {
  welcome: 'welcome',
  goodbye: 'goodbye',
  boost: 'boost',
};

const switchedOff = (name: string): string =>
  `${name} is not enabled. You can turn it on using the switch at the top of the page.`;

export default function WelcomePage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({
    guildId,
    moduleId: meta.id,
    schema: welcomeConfigSchema,
    templates: welcomeTemplates,
  });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;
  const errors = configErrors(form);

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
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {enabled ? null : <StatusBanner tone="neutral">{switchedOff(meta.label)}</StatusBanner>}
      </ModuleBanners>

      <div className="welcome-areas">
        <SegmentedTabLinks
          guildId={guildId}
          moduleId={meta.id}
          areas={meta.areas ?? []}
          current={area}
        />
      </div>

      <LoadingBoundary key={area} label={`Loading ${meta.label}`} minHeight={320}>
        {area === 'card' ? (
          <CardArea guildId={guildId} form={form} errors={errors} />
        ) : (
          <GreetingArea
            key={area}
            kind={GREETING_AREAS[area] ?? 'welcome'}
            guildId={guildId}
            form={form}
            errors={errors}
          />
        )}
      </LoadingBoundary>

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

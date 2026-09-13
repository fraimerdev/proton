import { welcomeConfigSchema } from '@proton/module-welcome/config';
import { useSuspenseQuery } from '@tanstack/react-query';
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
import { LoadingBoundary, StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { SegmentedTabLinks } from '../components/ui/tabs.tsx';
import { sessionQuery } from '../lib/queries.ts';
import { CardArea } from './welcome/card.tsx';
import type { ConfigErrors } from './welcome/errors.ts';
import { GreetingArea } from './welcome/greeting.tsx';

const MIGRATION_NOTE =
  'These settings were saved by an older version of Proton, and some may have changed. Check ' +
  'them, then save to store them in the current format.';

const switchedOff = (name: string): string =>
  `${name} is switched off. Settings are saved, but nothing runs until you switch it on.`;

export default function WelcomePage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: welcomeConfigSchema });
  const toggle = useModuleToggle(guildId, summary);
  const { guilds, user } = useSuspenseQuery(sessionQuery()).data;

  const enabled = summary?.enabled ?? form.view.enabled;
  const guildName = guilds.find((guild) => guild.id === guildId)?.name ?? 'this server';

  const config = form.value;

  // The module's own schema, re-run on the draft: it is what puts Discord's real refusal beside
  // the field that caused it instead of one sentence after a round trip.
  const live = useMemo(() => {
    const parsed = welcomeConfigSchema.safeParse(config);
    const issues = new Map<string, string>();
    if (parsed.success) return issues;

    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join('.');
      if (!issues.has(path)) issues.set(path, issue.message);
    }

    return issues;
  }, [config]);

  const errors: ConfigErrors = {
    at: (path) => form.errorAt(path) ?? live.get(path),
    under: (path) => {
      const exact = form.errorAt(path) ?? live.get(path);
      if (exact !== undefined) return exact;

      for (const [key, message] of live) if (key.startsWith(`${path}.`)) return message;
      return undefined;
    },
  };

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
        migrationNote={MIGRATION_NOTE}
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
            kind={area === 'goodbye' ? 'goodbye' : 'welcome'}
            guildId={guildId}
            form={form}
            errors={errors}
            guildName={guildName}
            viewerName={user.name}
          />
        )}
      </LoadingBoundary>

      <SaveBar dirty={form.dirty} saving={form.saving} onSave={form.save} onReset={form.reset} />
    </>
  );
}

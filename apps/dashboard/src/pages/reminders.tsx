import { limitFor, tryParseDuration } from '@proton/core';
import { remindersConfigSchema } from '@proton/module-reminders/config';
import type { ReactElement } from 'react';
import { DurationInput, humaniseDuration } from '../components/discord/inputs.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { cx } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { tierLabel } from '../lib/limits.ts';

export default function RemindersPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: remindersConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;

  const { minDuration, maxDuration } = form.value;
  const minMs = tryParseDuration(minDuration);
  const maxMs = tryParseDuration(maxDuration);
  const unreadable = minMs === null || maxMs === null;
  const inverted = minMs !== null && maxMs !== null && minMs > maxMs;

  const perMember = limitFor(form.view.tier, 'remindersPerUser');

  const rule = unreadable ? (
    <>
      One of these limits cannot be read, so <span className="mono">/remind</span> refuses every
      duration until both are fixed.
    </>
  ) : inverted ? (
    <>
      Soonest ({humaniseDuration(minDuration)}) is later than Furthest ahead (
      {humaniseDuration(maxDuration)}), so <span className="mono">/remind</span> refuses every
      duration.
    </>
  ) : (
    <>
      <span className="mono">/remind</span> accepts durations from {humaniseDuration(minDuration)}{' '}
      to {humaniseDuration(maxDuration)}.
    </>
  );

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
      </ModuleBanners>

      <Section label="Limits">
        <Rows>
          <SettingRow
            title="Allowed durations"
            description={
              <>
                Measured from when the member uses <span className="mono">/remind</span>. A duration
                outside this range is refused, and the reply names the limit it missed.
              </>
            }
            // The schema raises the cross-field issue on minDuration, so it speaks for the pair.
            error={form.errorAt('minDuration') ?? form.errorAt('maxDuration')}
            stacked
          >
            <div className="reminders-window">
              <span className="reminders-window-pair">
                <DurationInput
                  label="Soonest"
                  value={minDuration}
                  invalid={form.errorAt('minDuration') !== undefined}
                  onChange={(next) =>
                    form.setValue((current) => ({ ...current, minDuration: next }))
                  }
                />
                <span className="reminders-window-join">to</span>
                <DurationInput
                  label="Furthest ahead"
                  value={maxDuration}
                  invalid={form.errorAt('maxDuration') !== undefined}
                  onChange={(next) =>
                    form.setValue((current) => ({ ...current, maxDuration: next }))
                  }
                />
              </span>
              <p className={cx('reminders-rule', (unreadable || inverted) && 'text-warning')}>
                {rule}
              </p>
            </div>
          </SettingRow>

          <SettingRow
            title="Reminders per member"
            description={
              <>
                How many pending reminders one member can have. At the limit,{' '}
                <span className="mono">/remind</span> is refused until one of theirs fires or is
                cancelled with <span className="mono">/reminders cancel</span>.{' '}
                <span className="mono">/reminders list</span> shows theirs.
              </>
            }
          >
            <span className="inline inline-8">
              <span className="mono">{perMember}</span>
              <span className="text-muted">on {tierLabel(form.view.tier)}</span>
            </span>
          </SettingRow>
        </Rows>
      </Section>

      <SaveBar dirty={form.dirty} saving={form.saving} onSave={form.save} onReset={form.reset} />
    </>
  );
}

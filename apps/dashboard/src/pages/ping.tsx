import { pingConfigSchema } from '@proton/module-ping/config';
import type { ReactElement } from 'react';
import { CHANNEL_TYPE, ChannelPicker } from '../components/discord/channel-picker.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { TextInput } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';

const RESPONSE_MAX = 200;

/**
 * Deliberately small. Ping has two settings and this page shows two settings; the rest of the
 * canvas stays empty rather than being filled with anything.
 */
export default function PingPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: pingConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;

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

      <Section label="Response">
        <Rows>
          <SettingRow
            title="Reply text"
            description="Sent when a member uses /ping."
            error={form.errorAt('response')}
          >
            <TextInput
              width="lg"
              aria-label="Reply text"
              maxLength={RESPONSE_MAX}
              invalid={form.errorAt('response') !== undefined}
              value={form.value.response}
              onChange={(event) =>
                form.setValue((current) => ({ ...current, response: event.currentTarget.value }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Restrict to channel"
            description="In any other channel, /ping gets no reply."
            error={form.errorAt('restrictToChannel')}
          >
            <ChannelPicker
              guildId={guildId}
              label="Restrict to channel"
              noneLabel="Any channel"
              placeholder="Any channel"
              types={[CHANNEL_TYPE.text]}
              value={form.value.restrictToChannel}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, restrictToChannel: next }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <SaveBar dirty={form.dirty} saving={form.saving} onSave={form.save} onReset={form.reset} />
    </>
  );
}

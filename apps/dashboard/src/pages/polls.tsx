import { LIMIT_LABELS, limitFor, POLL_MAX_DURATION_HOURS } from '@proton/core';
import { POLL_MIN_DURATION_HOURS, pollsConfigSchema } from '@proton/module-polls/config';
import { useQuery } from '@tanstack/react-query';
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
import { NumberStepper, Switch } from '../components/ui/controls.tsx';
import { Spinner, StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { tierLabel } from '../lib/limits.ts';
import { channelsQuery } from '../lib/queries.ts';

function durationPhrase(hours: number): string {
  if (hours === 1) return '1 hour';
  if (hours >= 48 && hours % 24 === 0) return `${hours} hours (${hours / 24} days)`;
  return `${hours} hours`;
}

function Destination({
  channelId,
  name,
  pending,
}: {
  channelId: string | undefined;
  name: string | undefined;
  pending: boolean;
}): ReactElement {
  if (channelId === undefined) {
    return <b className="polls-rule-value">the poll’s channel</b>;
  }

  if (name === undefined && pending) return <Spinner label="Loading channel" />;

  // The raw id is deliberate: naming a channel we did not find would be inventing one.
  if (name === undefined) return <b className="polls-rule-value mono">{channelId}</b>;

  return <b className="polls-rule-value">#{name}</b>;
}

export default function PollsPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: pollsConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;
  const tier = form.view.tier;
  const config = form.value;

  const { data: channels, isPending: channelsPending } = useQuery({
    ...channelsQuery(guildId),
    enabled: config.announceResults && config.announceChannelId !== undefined,
  });

  const announceChannel = (channels ?? []).find(
    (channel) => channel.id === config.announceChannelId,
  );

  const runsFor = durationPhrase(config.defaultDurationHours);

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

      <p className="polls-rule">
        Polls run for <b className="polls-rule-value">{runsFor}</b> unless{' '}
        <code className="mono">/poll create</code> sets <code className="mono">duration_hours</code>
        . When a poll closes,{' '}
        {config.announceResults ? (
          <>
            Proton posts a link to it in{' '}
            <Destination
              channelId={config.announceChannelId}
              name={announceChannel?.name}
              pending={channelsPending}
            />
            .
          </>
        ) : (
          <>Proton posts nothing. The result stays on the poll.</>
        )}
      </p>

      <Section
        label="Running polls"
        note={`${tierLabel(tier)} allows ${limitFor(tier, 'activePolls')} ${
          LIMIT_LABELS.activePolls
        } at once`}
      >
        <Rows>
          <SettingRow
            title="Default duration"
            description={`Discord allows polls of up to ${POLL_MAX_DURATION_HOURS} hours (32 days).`}
            error={form.errorAt('defaultDurationHours')}
          >
            <NumberStepper
              label="Default duration"
              unit="hours"
              width={150}
              min={POLL_MIN_DURATION_HOURS}
              max={POLL_MAX_DURATION_HOURS}
              invalid={form.errorAt('defaultDurationHours') !== undefined}
              value={config.defaultDurationHours}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  defaultDurationHours: next ?? current.defaultDurationHours,
                }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Results">
        <Rows>
          <SettingRow
            title="Announce results"
            description="Post a link to the poll when it closes. Proton cannot read Discord’s final tally, so the counts stay on the poll."
          >
            <Switch
              label="Announce results"
              checked={config.announceResults}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, announceResults: next }))
              }
            />
          </SettingRow>

          {config.announceResults ? (
            <SettingRow
              title="Announcement channel"
              description="Where Proton announces closed polls."
              error={form.errorAt('announceChannelId')}
              note="Running polls still announce in the channel that was set when they started."
            >
              <ChannelPicker
                guildId={guildId}
                label="Announcement channel"
                noneLabel="Same channel as the poll"
                placeholder="Same channel as the poll"
                types={[
                  CHANNEL_TYPE.text,
                  CHANNEL_TYPE.announcement,
                  CHANNEL_TYPE.publicThread,
                  CHANNEL_TYPE.privateThread,
                ]}
                invalid={form.errorAt('announceChannelId') !== undefined}
                value={config.announceChannelId}
                onChange={(next) =>
                  form.setValue((current) => ({ ...current, announceChannelId: next ?? undefined }))
                }
              />
            </SettingRow>
          ) : null}
        </Rows>
      </Section>

      <SaveBar dirty={form.dirty} saving={form.saving} onSave={form.save} onReset={form.reset} />
    </>
  );
}

import type { ModuleSummary } from '@proton/core';
import type { AchievementsConfig } from '@proton/module-achievements/config';
import type { AchievementsOverview } from '@proton/module-achievements/view';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { CHANNEL_TYPE, ChannelMultiPicker } from '../../components/discord/channel-picker.tsx';
import { DurationInput } from '../../components/discord/inputs.tsx';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { LimitCounter } from '../../components/ui/collection.tsx';
import { Button } from '../../components/ui/controls.tsx';
import { Spinner, StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { readFailure } from '../../lib/errors.ts';
import type { ModuleMeta } from '../../lib/modules/catalogue.ts';
import { achievementsOverviewQuery } from './queries.ts';
import { formatZoned } from './time.ts';
import { TimeZonePicker, zoneName } from './timezone-picker.tsx';

type Form = ModuleForm<AchievementsConfig>;

type Interval = AchievementsOverview['periods']['module'][number];

const EXCLUSION_MAX = 50;

const COOLDOWN_MAX_MS = 60 * 60 * 1000;

const EXCLUDABLE_CHANNEL_TYPES = [
  CHANNEL_TYPE.category,
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.forum,
  CHANNEL_TYPE.media,
  CHANNEL_TYPE.voice,
  CHANNEL_TYPE.stage,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
  CHANNEL_TYPE.announcementThread,
] as const;

const PAUSES_SHOWN = 5;

const TIME_ZONE_DESCRIPTION =
  'Sets which calendar day activity falls on, and the time zone for start times and deadlines.';

const TIME_ZONE_HELP =
  'Changing it doesn’t move start times or deadlines. It changes which calendar day activity ' +
  'falls on from now on.';

const COOLDOWN_DESCRIPTION =
  'A member’s messages count at most once in this time. At 0 seconds every message counts.';

const CHANNELS_DESCRIPTION =
  'Messages, reactions and voice time in these channels don’t count towards any achievement.';

const CHANNELS_HELP = 'A category covers its channels and their threads.';

const ROLES_DESCRIPTION =
  'Members with any of these roles don’t earn achievements, and their activity doesn’t count.';

const RECORDING_DESCRIPTION =
  'Achievements that include recorded progress can count activity from this date.';

const RECORDING_HELP =
  'Proton records activity only while Achievements is on, and keeps hourly counts for 365 days.';

const NOT_RECORDING = 'Proton starts recording when Achievements is turned on.';

export interface Pause {
  start: number;
  end: number | null;
}

export function pausesOf(periods: readonly Interval[]): Pause[] {
  const sorted = [...periods].sort((a, b) => a.start - b.start);
  const pauses: Pause[] = [];

  sorted.forEach((period, index) => {
    if (period.end === null) return;

    const next = sorted[index + 1];
    if (next === undefined) pauses.push({ start: period.end, end: null });
    else if (next.start > period.end) pauses.push({ start: period.end, end: next.start });
  });

  return pauses;
}

export function pauseText(pause: Pause, zone: string): string {
  return pause.end === null
    ? `Since ${formatZoned(pause.start, zone)}`
    : `${formatZoned(pause.start, zone)} – ${formatZoned(pause.end, zone)}`;
}

function Recording({ guildId, zone }: { guildId: string; zone: string }): ReactElement {
  const overview = useQuery(achievementsOverviewQuery(guildId));

  const data = overview.data;
  const since = data?.recordingSince ?? null;
  const pauses = data === undefined ? [] : pausesOf(data.periods.module);
  const shown = pauses.slice(-PAUSES_SHOWN);
  const hidden = pauses.length - shown.length;

  return (
    <Section label="Recording" help={RECORDING_HELP} note={`Times in ${zoneName(zone)}`}>
      {overview.isError ? (
        <div className="achievements-settings-failure">
          <StatusBanner
            tone="danger"
            live="polite"
            actions={
              <Button size="sm" busy={overview.isFetching} onClick={() => void overview.refetch()}>
                Try again
              </Button>
            }
          >
            {readFailure(overview.error, 'the recording history')}
          </StatusBanner>
        </div>
      ) : null}

      <Rows>
        <SettingRow
          title="Recording since"
          description={since === null && data !== undefined ? NOT_RECORDING : RECORDING_DESCRIPTION}
        >
          {data === undefined ? (
            overview.isError ? null : (
              <Spinner label="Loading when recording started" />
            )
          ) : (
            <span className="achievements-settings-since">
              {since === null ? 'Not yet' : formatZoned(since, zone)}
            </span>
          )}
        </SettingRow>

        {shown.length > 0 ? (
          <SettingRow
            title="Paused"
            description={
              <span className="stack stack-4">
                {shown.map((pause) => (
                  <span key={pause.start}>{pauseText(pause, zone)}</span>
                ))}
                {hidden > 0 ? (
                  <span>
                    {hidden === 1 ? 'And 1 earlier pause' : `And ${hidden} earlier pauses`}
                  </span>
                ) : null}
              </span>
            }
          />
        ) : null}
      </Rows>
    </Section>
  );
}

export function SettingsArea({
  guildId,
  form,
}: {
  guildId: string;
  form: Form;
  meta: ModuleMeta;
  summary: ModuleSummary | undefined;
}): ReactElement {
  const config = form.value;
  const cooldownError = form.errorAt('messageCooldown');
  const zoneError = form.errorAt('timezone');

  return (
    <>
      <Section label="Counting">
        <Rows>
          <SettingRow
            title="Time zone"
            description={TIME_ZONE_DESCRIPTION}
            help={TIME_ZONE_HELP}
            error={zoneError}
          >
            <TimeZonePicker
              value={config.timezone}
              invalid={zoneError !== undefined}
              onChange={(timezone) => form.setValue((current) => ({ ...current, timezone }))}
            />
          </SettingRow>

          <SettingRow
            title="Message cooldown"
            description={COOLDOWN_DESCRIPTION}
            error={cooldownError}
          >
            <DurationInput
              label="Message cooldown"
              value={config.messageCooldown}
              min={0}
              max={COOLDOWN_MAX_MS}
              units={['s', 'm', 'h']}
              invalid={cooldownError !== undefined}
              onChange={(messageCooldown) =>
                form.setValue((current) => ({ ...current, messageCooldown }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Left out">
        <Rows>
          <SettingRow
            title="Excluded channels"
            description={CHANNELS_DESCRIPTION}
            help={CHANNELS_HELP}
            badge={
              <LimitCounter
                used={config.excludedChannelIds.length}
                ceiling={EXCLUSION_MAX}
                label="channels"
              />
            }
            error={form.errorAt('excludedChannelIds')}
            stacked
          >
            <ChannelMultiPicker
              guildId={guildId}
              label="Add excluded channel"
              types={EXCLUDABLE_CHANNEL_TYPES}
              max={EXCLUSION_MAX}
              invalid={form.errorAt('excludedChannelIds') !== undefined}
              value={config.excludedChannelIds}
              onChange={(excludedChannelIds) =>
                form.setValue((current) => ({ ...current, excludedChannelIds }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Excluded roles"
            description={ROLES_DESCRIPTION}
            badge={
              <LimitCounter
                used={config.excludedRoleIds.length}
                ceiling={EXCLUSION_MAX}
                label="roles"
              />
            }
            error={form.errorAt('excludedRoleIds')}
            stacked
          >
            <RoleMultiPicker
              guildId={guildId}
              label="Add excluded role"
              max={EXCLUSION_MAX}
              invalid={form.errorAt('excludedRoleIds') !== undefined}
              value={config.excludedRoleIds}
              onChange={(excludedRoleIds) =>
                form.setValue((current) => ({ ...current, excludedRoleIds }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Recording guildId={guildId} zone={config.timezone} />
    </>
  );
}

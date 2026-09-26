import type { Achievement } from '@proton/module-achievements/config';
import { triggerOf } from '@proton/module-achievements/triggers';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import { ModuleLink } from '../../components/module/route.tsx';
import { IconButton, NumberStepper, Switch, TextInput } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { useHydrated } from '../../components/ui/overlay.tsx';
import { achievementsOverviewQuery } from './queries.ts';
import {
  echoLine,
  formatDay,
  isoToZoned,
  viewerTimeZone,
  type ZonedParts,
  zonedParts,
  zonedToInstant,
  zoneOffsetLabel,
} from './time.ts';
import { zoneName } from './timezone-picker.tsx';

const START_HELP =
  'Activity before it doesn’t count. Leave it empty to count from when the achievement goes active.';

const DEADLINE_HELP =
  'Activity after it doesn’t count, and the achievement shows as expired. Members keep what they ' +
  'earned.';

const DEADLINE_PASSED = 'This deadline has already passed. Pick a later time, or clear it.';

const DEADLINE_BEFORE_START = 'The deadline has to be after the start.';

const ELIGIBLE_HELP =
  'Only members with one of these roles can earn it. Leave it empty to let everyone earn it.';

const EXCLUDED_HELP = 'Members with any of these roles can’t earn it, even with an eligible role.';

const EXCLUDED_MORE = 'Roles excluded in Settings can’t earn any achievement.';

const ALMOST_THERE_HELP =
  'Remind members once per tier when they’re close to it. The message and where it goes are ' +
  'set in';

const PERCENT_HELP = 'Sent when every requirement reaches this much of its target.';

const ROLE_LIST_MAX = 25;

const PERCENT_MIN = 50;
const PERCENT_MAX = 95;

const START_TIME = '00:00';
const DEADLINE_TIME = '23:59';

const EMPTY: ZonedParts = { date: '', time: '' };

type Update = (change: (current: Achievement) => Achievement) => void;

interface Held {
  iso: string | undefined;
  zone: string;
  parts: ZonedParts;
  note: string | null;
}

function instantOf(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function includeRecordedRule(since: string | null): string {
  const counted =
    'Also count activity Proton recorded before this achievement goes active, up to 365 days back.';

  return since === null ? counted : `${counted} Recording started on ${since}.`;
}

function DateTimeRow({
  title,
  description,
  verb,
  iso,
  zone,
  viewerZone,
  defaultTime,
  error,
  onChange,
}: {
  title: string;
  description: string;
  verb: string;
  iso: string | undefined;
  zone: string;
  viewerZone: string | undefined;
  defaultTime: string;
  error: string | undefined;
  onChange: (iso: string | undefined) => void;
}): ReactElement {
  const echoId = useId();
  const [held, setHeld] = useState<Held>(() => ({
    iso,
    zone,
    parts: isoToZoned(iso, zone) ?? EMPTY,
    note: null,
  }));

  let current = held;
  if (held.iso !== iso || held.zone !== zone) {
    current = { iso, zone, parts: isoToZoned(iso, zone) ?? EMPTY, note: null };
    setHeld(current);
  }

  const { parts } = current;

  const write = (date: string, time: string): void => {
    if (date === '') {
      setHeld({ iso: undefined, zone, parts: { date: '', time }, note: null });
      if (iso !== undefined) onChange(undefined);
      return;
    }

    const at = zonedToInstant(date, time === '' ? defaultTime : time, zone);
    if (at === null) {
      setHeld({ ...current, parts: { date, time } });
      return;
    }

    setHeld({ iso: at.iso, zone, parts: { date: at.date, time: at.time }, note: at.note });
    onChange(at.iso);
  };

  const instant = instantOf(iso);

  return (
    <SettingRow title={title} description={description} error={error} stacked>
      <span className="stack stack-6">
        <span className="inline inline-8 inline-wrap">
          <TextInput
            type="date"
            width="sm"
            aria-label={`${title} date`}
            aria-describedby={instant === null ? undefined : echoId}
            invalid={error !== undefined}
            value={parts.date}
            onChange={(event) => write(event.currentTarget.value, parts.time)}
          />
          <TextInput
            type="time"
            className="achievements-editor-time"
            aria-label={`${title} time`}
            aria-describedby={instant === null ? undefined : echoId}
            invalid={error !== undefined}
            value={parts.time}
            onChange={(event) => {
              const time = event.currentTarget.value;
              if (time === '' || parts.date === '')
                setHeld({ ...current, parts: { ...parts, time } });
              else write(parts.date, time);
            }}
          />
          {iso !== undefined ? (
            <IconButton
              icon="x"
              tone="ghost"
              size="sm"
              label={`Clear ${title.toLowerCase()}`}
              onClick={() => write('', '')}
            />
          ) : null}
        </span>

        {instant !== null ? (
          <span id={echoId} className="stack stack-4 text-sm text-muted">
            <span>{echoLine(verb, instant, zone, viewerZone)}</span>
            {current.note !== null ? <span>{current.note}</span> : null}
          </span>
        ) : null}
      </span>
    </SettingRow>
  );
}

export function ScheduleEditor({
  guildId,
  moduleId,
  achievement,
  saved,
  zone,
  path,
  errorAt,
  update,
}: {
  guildId: string;
  moduleId: string;
  achievement: Achievement;
  saved: Achievement | null;
  zone: string;
  path: string;
  errorAt: (path: string) => string | undefined;
  update: Update;
}): ReactElement {
  const overview = useQuery(achievementsOverviewQuery(guildId));
  const hydrated = useHydrated();
  const [now] = useState(() => Date.now());
  const ruleId = useId();

  const viewerZone = hydrated ? viewerTimeZone() : undefined;
  const offset = zoneOffsetLabel(zone, now);

  const startsAt = instantOf(achievement.startsAt);
  const endsAt = instantOf(achievement.endsAt);
  const deadlineMoved = instantOf(saved?.endsAt) !== endsAt;

  const deadlineError =
    errorAt(`${path}.endsAt`) ??
    (endsAt !== null && startsAt !== null && endsAt <= startsAt
      ? DEADLINE_BEFORE_START
      : deadlineMoved && endsAt !== null && endsAt < now
        ? DEADLINE_PASSED
        : undefined);

  const recordingSince = overview.data?.recordingSince ?? null;
  const since = recordingSince === null ? null : formatDay(zonedParts(recordingSince, zone).date);

  const recordedApplies = achievement.requirements.some(
    (requirement) => triggerOf(requirement.trigger).history === 'recorded',
  );

  return (
    <>
      <Section
        label="Dates"
        intro={
          <>
            Times are in {zoneName(zone)}
            {offset === null ? '' : ` (${offset})`}. Change the time zone in{' '}
            <ModuleLink guildId={guildId} moduleId={moduleId} search={{ area: 'settings' }}>
              Settings
            </ModuleLink>
            .
          </>
        }
      >
        <Rows>
          <DateTimeRow
            title="Start"
            description={START_HELP}
            verb="Starts"
            iso={achievement.startsAt}
            zone={zone}
            viewerZone={viewerZone}
            defaultTime={START_TIME}
            error={errorAt(`${path}.startsAt`)}
            onChange={(startsAt) =>
              update(({ startsAt: _previous, ...current }) =>
                startsAt === undefined ? current : { ...current, startsAt },
              )
            }
          />

          <DateTimeRow
            title="Deadline"
            description={DEADLINE_HELP}
            verb="Ends"
            iso={achievement.endsAt}
            zone={zone}
            viewerZone={viewerZone}
            defaultTime={DEADLINE_TIME}
            error={deadlineError}
            onChange={(endsAt) =>
              update(({ endsAt: _previous, ...current }) =>
                endsAt === undefined ? current : { ...current, endsAt },
              )
            }
          />
        </Rows>
      </Section>

      <Section label="Who can earn it">
        <Rows>
          <SettingRow
            title="Eligible roles"
            description={ELIGIBLE_HELP}
            error={errorAt(`${path}.roleIds`)}
            stacked
          >
            <RoleMultiPicker
              guildId={guildId}
              label="Eligible roles"
              max={ROLE_LIST_MAX}
              value={achievement.roleIds}
              invalid={errorAt(`${path}.roleIds`) !== undefined}
              onChange={(roleIds) => update((current) => ({ ...current, roleIds }))}
            />
          </SettingRow>

          <SettingRow
            title="Excluded roles"
            description={EXCLUDED_HELP}
            help={EXCLUDED_MORE}
            error={errorAt(`${path}.excludedRoleIds`)}
            stacked
          >
            <RoleMultiPicker
              guildId={guildId}
              label="Excluded roles"
              max={ROLE_LIST_MAX}
              value={achievement.excludedRoleIds}
              invalid={errorAt(`${path}.excludedRoleIds`) !== undefined}
              onChange={(excludedRoleIds) => update((current) => ({ ...current, excludedRoleIds }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Counting">
        <Rows>
          {recordedApplies ? (
            <SettingRow
              title="Include recorded progress"
              description={<span id={ruleId}>{includeRecordedRule(since)}</span>}
              error={errorAt(`${path}.includeRecorded`)}
            >
              <Switch
                label="Include recorded progress"
                describedBy={ruleId}
                checked={achievement.includeRecorded}
                onChange={(includeRecorded) =>
                  update((current) => ({ ...current, includeRecorded }))
                }
              />
            </SettingRow>
          ) : null}

          <SettingRow
            title="Almost there"
            description={
              <>
                {ALMOST_THERE_HELP}{' '}
                <ModuleLink
                  guildId={guildId}
                  moduleId={moduleId}
                  search={{ area: 'announcements' }}
                >
                  Announcements
                </ModuleLink>
                .
              </>
            }
          >
            <Switch
              label="Almost there"
              checked={achievement.almostThere.enabled}
              onChange={(enabled) =>
                update((current) => ({
                  ...current,
                  almostThere: { ...current.almostThere, enabled },
                }))
              }
            />
          </SettingRow>

          {achievement.almostThere.enabled ? (
            <SettingRow
              title="Remind at"
              description={PERCENT_HELP}
              error={errorAt(`${path}.almostThere.percent`)}
            >
              <NumberStepper
                label="Remind at"
                unit="%"
                min={PERCENT_MIN}
                max={PERCENT_MAX}
                invalid={errorAt(`${path}.almostThere.percent`) !== undefined}
                value={achievement.almostThere.percent}
                onChange={(percent) => {
                  if (percent === null) return;
                  update((current) => ({
                    ...current,
                    almostThere: { ...current.almostThere, percent },
                  }));
                }}
              />
            </SettingRow>
          ) : null}
        </Rows>
      </Section>
    </>
  );
}

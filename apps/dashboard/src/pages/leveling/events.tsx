import { tryParseDuration } from '@proton/core';
import {
  XP_EVENT_MAX_DURATION_MS,
  XP_EVENT_MAX_LEAD_MS,
  XP_EVENT_MAX_PENDING,
  XP_EVENT_MIN_DURATION_MS,
  XP_EVENT_MULTIPLIER_MAX,
  XP_EVENT_MULTIPLIER_MIN,
  type XpEventView,
  xpEventBoundsIssue,
  xpEventMultiplierSchema,
} from '@proton/module-leveling/config';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { DurationInput } from '../../components/discord/inputs.tsx';
import { MemberCell, MemberProvider } from '../../components/discord/member.tsx';
import {
  CollectionHeader,
  CollectionStaticRow,
  MetaSeparator,
  PresenceList,
} from '../../components/ui/collection.tsx';
import { Button, SegmentedControl, type SegmentedOption } from '../../components/ui/controls.tsx';
import { EmptyState, LoadingArea, StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { failureKind, readFailure, saveFailure } from '../../lib/errors.ts';
import { endXpEventMutation, startXpEventMutation, xpEventsQuery } from '../../lib/queries.ts';
import { eventAction, when } from './rows.ts';
import { MultiplierStepper } from './xp.tsx';

type StartMode = 'now' | 'later';

const MINUTE_MS = 60_000;
const TICK_MS = 15_000;
const DEFAULT_EVENT_MULTIPLIER = 2;
const DURATION_UNITS = ['m', 'h', 'd'] as const;

const NO_EVENTS = 'Start one now, or schedule one for later.';

const EVENTS_FULL =
  `This server has ${XP_EVENT_MAX_PENDING} XP events running or scheduled, the most it can ` +
  'have. End or cancel one to start another.';

const SWITCHED_OFF =
  'Leveling is switched off, so an XP event changes nothing until it is switched on.';

const MULTIPLIER_RANGE = `Enter a multiplier from ${XP_EVENT_MULTIPLIER_MIN} to ${XP_EVENT_MULTIPLIER_MAX}, in steps of 0.1.`;

const LEAD_UNREADABLE = 'Enter how long until the event starts.';

const LENGTH_UNREADABLE = 'Enter how long the event lasts.';

const START_OPTIONS: readonly SegmentedOption<StartMode>[] = [
  { value: 'now', label: 'Now' },
  { value: 'later', label: 'Later' },
];

interface EndFailure {
  eventId: string;
  message: string;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function spell(ms: number): string {
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 1) return 'less than a minute';

  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;

  if (days > 0) {
    return hours > 0 ? `${plural(days, 'day')} ${plural(hours, 'hour')}` : plural(days, 'day');
  }
  if (hours > 0) {
    return rest > 0 ? `${plural(hours, 'hour')} ${plural(rest, 'minute')}` : plural(hours, 'hour');
  }
  return plural(rest, 'minute');
}

function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

// Not saveFailure alone: the api's refusals name the limit or bound, and saveFailure would replace them.
function refusal(error: Error, attempt: string): string {
  return failureKind(error) === 'unknown' && error.message !== ''
    ? error.message
    : saveFailure(error, attempt);
}

function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  return now;
}

function EventRow({
  guildId,
  event,
  now,
  failure,
  onFailure,
}: {
  guildId: string;
  event: XpEventView;
  now: number;
  failure: string | undefined;
  onFailure: (message: string | null) => void;
}): ReactElement {
  const queryClient = useQueryClient();

  const startsAt = Date.parse(event.startsAt);
  const endsAt = Date.parse(event.endsAt);
  const running = startsAt <= now;
  const action = eventAction(event, running);

  const end = useMutation({
    ...endXpEventMutation(queryClient, guildId),
    onSuccess: () => onFailure(null),
    onError: (error: Error) =>
      onFailure(
        refusal(error, running ? 'The XP event was not ended' : 'The XP event was not cancelled'),
      ),
  });

  return (
    <div>
      <CollectionStaticRow
        icon={running ? 'trend-up' : 'alarm'}
        title={`×${event.multiplier} XP`}
        meta={
          running ? (
            <>
              <time dateTime={event.endsAt} title={when(endsAt)}>
                Ends in {spell(endsAt - now)}
              </time>
              <MetaSeparator />
              <span className="inline inline-6">
                Started by <MemberCell userId={event.createdBy} />
              </span>
            </>
          ) : (
            <>
              <time dateTime={event.startsAt}>Starts in {spell(startsAt - now)}</time>
              <MetaSeparator />
              <span>{when(startsAt)}</span>
              <MetaSeparator />
              <span>Lasts {spell(endsAt - startsAt)}</span>
              <MetaSeparator />
              <span className="inline inline-6">
                Scheduled by <MemberCell userId={event.createdBy} />
              </span>
            </>
          )
        }
        aside={
          <Button
            size="sm"
            busy={end.isPending}
            aria-label={action.label}
            onClick={() => {
              onFailure(null);
              end.mutate(event.id);
            }}
          >
            {action.text}
          </Button>
        }
      />

      {failure !== undefined ? (
        <p className="leveling-event-failure" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function EventGroup({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <p className="section-label">{label}</p>
      <Rows>
        <PresenceList>{children}</PresenceList>
      </Rows>
    </div>
  );
}

function Composer({
  guildId,
  enabled,
  skew,
  onClose,
}: {
  guildId: string;
  enabled: boolean;
  skew: number;
  onClose: () => void;
}): ReactElement {
  const queryClient = useQueryClient();

  const [multiplier, setMultiplier] = useState(DEFAULT_EVENT_MULTIPLIER);
  const [mode, setMode] = useState<StartMode>('now');
  const [startsIn, setStartsIn] = useState('1h');
  const [lasts, setLasts] = useState('2h');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const start = useMutation({
    ...startXpEventMutation(queryClient, guildId),
    onSuccess: () => onClose(),
    onError: (error: Error) =>
      setFailure(
        refusal(
          error,
          mode === 'now' ? 'The XP event was not started' : 'The XP event was not scheduled',
        ),
      ),
  });

  const edited = (): void => {
    setRequestId(null);
    setFailure(null);
  };

  const at = Date.now() + skew;
  const leadMs = mode === 'now' ? 0 : tryParseDuration(startsIn);
  const lengthMs = tryParseDuration(lasts);
  const span =
    leadMs === null || lengthMs === null
      ? null
      : { startsAt: at + leadMs, endsAt: at + leadMs + lengthMs };
  const issue = span === null ? null : xpEventBoundsIssue(span, at);

  const multiplierError = xpEventMultiplierSchema.safeParse(multiplier).success
    ? undefined
    : MULTIPLIER_RANGE;

  const startError =
    leadMs === null
      ? LEAD_UNREADABLE
      : issue?.path === 'startsAt'
        ? `The start ${issue.message}.`
        : undefined;

  const endError =
    lengthMs === null
      ? LENGTH_UNREADABLE
      : issue?.path === 'endsAt'
        ? `The end ${issue.message}.`
        : undefined;

  const invalid =
    multiplierError !== undefined || startError !== undefined || endError !== undefined;

  const summary =
    span === null || issue !== null
      ? undefined
      : mode === 'now'
        ? `Runs from now until ${when(span.endsAt)}.`
        : `Runs from ${when(span.startsAt)} until ${when(span.endsAt)}.`;

  const submit = (): void => {
    if (invalid || leadMs === null || lengthMs === null) return;

    const startsAt = Date.now() + skew + leadMs;
    // One id per submitted draft, reused on a retry, so a start that landed but lost its answer is not doubled.
    const id = requestId ?? newRequestId();
    setRequestId(id);
    setFailure(null);

    start.mutate({
      requestId: id,
      multiplier,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(startsAt + lengthMs).toISOString(),
    });
  };

  return (
    <Rows>
      <SettingRow
        title="Multiplier"
        description="Every member earns this many times their usual XP while the event runs."
        error={multiplierError}
      >
        <MultiplierStepper
          label="Event multiplier"
          value={multiplier}
          min={XP_EVENT_MULTIPLIER_MIN}
          max={XP_EVENT_MULTIPLIER_MAX}
          invalid={multiplierError !== undefined}
          onChange={(next) => {
            setMultiplier(next);
            edited();
          }}
        />
      </SettingRow>

      <SettingRow
        title="Starts"
        description={mode === 'later' ? 'Up to 30 days from now.' : undefined}
        error={startError}
      >
        <span className="inline inline-8 inline-wrap">
          <SegmentedControl<StartMode>
            label="Starts"
            options={START_OPTIONS}
            value={mode}
            onChange={(next) => {
              setMode(next);
              edited();
            }}
          />
          {mode === 'later' ? (
            <DurationInput
              label="Starts in"
              value={startsIn}
              min={MINUTE_MS}
              max={XP_EVENT_MAX_LEAD_MS}
              units={DURATION_UNITS}
              invalid={startError !== undefined}
              onChange={(next) => {
                setStartsIn(next);
                edited();
              }}
            />
          ) : null}
        </span>
      </SettingRow>

      <SettingRow title="Lasts" description="From 10 minutes to 14 days." error={endError}>
        <DurationInput
          label="Lasts"
          value={lasts}
          min={XP_EVENT_MIN_DURATION_MS}
          max={XP_EVENT_MAX_DURATION_MS}
          units={DURATION_UNITS}
          invalid={endError !== undefined}
          onChange={(next) => {
            setLasts(next);
            edited();
          }}
        />
      </SettingRow>

      <div className="row">
        <div className="row-main leveling-composer-status">
          {failure !== null ? (
            <p className="row-error" role="alert">
              {failure}
            </p>
          ) : summary !== undefined ? (
            <p className="row-description">{summary}</p>
          ) : null}
          {enabled ? null : <p className="row-note">{SWITCHED_OFF}</p>}
        </div>
        <div className="row-control">
          <Button tone="ghost" size="sm" disabled={start.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            tone="primary"
            size="sm"
            busy={start.isPending}
            disabled={invalid}
            onClick={submit}
          >
            {mode === 'now' ? 'Start event' : 'Schedule event'}
          </Button>
        </div>
      </div>
    </Rows>
  );
}

export function EventsArea({
  guildId,
  enabled,
}: {
  guildId: string;
  enabled: boolean;
}): ReactElement {
  const query = useQuery(xpEventsQuery(guildId));
  const [composing, setComposing] = useState(false);
  const [endFailure, setEndFailure] = useState<EndFailure | null>(null);

  const data = query.data;
  const skew = data === undefined ? 0 : data.now - query.dataUpdatedAt;
  const tick = useTick((data?.events.length ?? 0) > 0);
  const now = Math.max(tick, query.dataUpdatedAt) + skew;

  const live = (data?.events ?? []).filter((event) => Date.parse(event.endsAt) > now);
  const running = live.filter((event) => Date.parse(event.startsAt) <= now);
  const scheduled = live.filter((event) => Date.parse(event.startsAt) > now);
  const full = live.length >= XP_EVENT_MAX_PENDING;

  const orphan =
    endFailure !== null && !live.some((event) => event.id === endFailure.eventId)
      ? endFailure
      : null;

  const report =
    (eventId: string) =>
    (message: string | null): void =>
      setEndFailure((current) =>
        message !== null ? { eventId, message } : current?.eventId === eventId ? null : current,
      );

  const rows = (events: readonly XpEventView[]): ReactElement[] =>
    events.map((event) => (
      <EventRow
        key={event.id}
        guildId={guildId}
        event={event}
        now={now}
        failure={endFailure?.eventId === event.id ? endFailure.message : undefined}
        onFailure={report(event.id)}
      />
    ));

  const startButton = (
    <Button tone="primary" size="sm" icon="plus" onClick={() => setComposing(true)}>
      Start an XP event
    </Button>
  );

  return (
    <Section>
      <CollectionHeader
        title="XP events"
        used={data === undefined ? undefined : live.length}
        ceiling={data === undefined ? undefined : XP_EVENT_MAX_PENDING}
        limitLabel="XP events running or scheduled"
        actions={data !== undefined && live.length > 0 && !full && !composing ? startButton : null}
      />

      {orphan !== null ? (
        <StatusBanner tone="danger" live="assertive" onDismiss={() => setEndFailure(null)}>
          {orphan.message}
        </StatusBanner>
      ) : null}

      {query.isError ? (
        <StatusBanner tone="danger" live="polite">
          {readFailure(query.error, 'this server’s XP events')}
        </StatusBanner>
      ) : null}

      {data === undefined ? (
        query.isError ? null : (
          <LoadingArea label="Loading XP events" minHeight={120} size="sm" />
        )
      ) : (
        <MemberProvider guildId={guildId} userIds={[...new Set(live.map((e) => e.createdBy))]}>
          <div className="stack stack-20">
            {composing ? (
              <Composer
                guildId={guildId}
                enabled={enabled}
                skew={skew}
                onClose={() => setComposing(false)}
              />
            ) : live.length === 0 ? (
              <EmptyState inset icon="trend-up" title="No XP events" actions={startButton}>
                {NO_EVENTS}
              </EmptyState>
            ) : null}

            {running.length > 0 ? (
              <EventGroup label="Running now">{rows(running)}</EventGroup>
            ) : null}

            {scheduled.length > 0 ? (
              <EventGroup label="Scheduled">{rows(scheduled)}</EventGroup>
            ) : null}
          </div>
        </MemberProvider>
      )}

      {full ? <p className="leveling-note">{EVENTS_FULL}</p> : null}
    </Section>
  );
}

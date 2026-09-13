import {
  LOG_CATEGORIES,
  type LogCategory,
  type LogEventSpec,
} from '@proton/module-serverlog/catalogue';
import { LOG_TEXT_CHANNEL_TYPES, type ServerlogConfig } from '@proton/module-serverlog/config';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChannelPicker, useChannelIndex } from '../../components/discord/channel-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { useModuleNavigate, useModuleSearch } from '../../components/module/route.tsx';
import {
  Badge,
  Button,
  IconButton,
  SearchField,
  SegmentedControl,
  Select,
  type SelectOption,
} from '../../components/ui/controls.tsx';
import { EmptyState } from '../../components/ui/feedback.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Section, SettingRow } from '../../components/ui/layout.tsx';
import {
  ConfirmDialog,
  Dialog,
  type MenuAction,
  MenuButton,
} from '../../components/ui/overlay.tsx';
import {
  bulkFollow,
  bulkReset,
  bulkRoute,
  bulkUnroute,
  CATEGORY_LABEL,
  type ChannelIndex,
  ChannelRef,
  destinationOf,
  type EventState,
  keysOf,
  LOG_SPECS,
  stateOf,
  withChannel,
  withState,
} from './shared.tsx';

const STATE_FILTERS = ['on', 'off', 'changed', 'routed'] as const;
type StateFilter = (typeof STATE_FILTERS)[number] | '';

function isStateFilter(value: string | undefined): value is StateFilter {
  return value !== undefined && (STATE_FILTERS as readonly string[]).includes(value);
}

const STATE_OPTIONS: readonly SelectOption[] = [
  { value: '', label: 'Any state' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
  { value: 'changed', label: 'Set to On or Off' },
  { value: 'routed', label: 'Has its own channel' },
];

const CATEGORY_OPTIONS: readonly SelectOption[] = [
  { value: '', label: 'All categories' },
  ...LOG_CATEGORIES.map((category) => ({ value: category, label: CATEGORY_LABEL[category] })),
];

const ROW_STATES: readonly { value: EventState; label: string }[] = [
  { value: 'follow', label: 'Follow' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const CONFIRM_RESET_ABOVE = 5;

export function Events({
  guildId,
  moduleId,
  form,
}: {
  guildId: string;
  moduleId: string;
  form: ModuleForm<ServerlogConfig>;
}): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, moduleId);
  const channels = useChannelIndex(guildId);
  const config = form.value;
  const { setValue } = form;

  const term = search.q ?? '';
  const [draft, setDraft] = useState(term);
  useEffect(() => setDraft(term), [term]);

  useEffect(() => {
    const trimmed = draft.trim();
    const next = trimmed === '' ? undefined : trimmed;
    if ((next ?? '') === term) return;

    const timer = window.setTimeout(() => go({ q: next }), 220);
    return () => window.clearTimeout(timer);
  }, [draft, term, go]);

  const state: StateFilter = isStateFilter(search.status) ? search.status : '';
  const [category, setCategory] = useState<string>('');

  const filtering = draft.trim() !== '' || state !== '' || category !== '';

  const matches = useCallback(
    (spec: LogEventSpec): boolean => {
      if (category !== '' && spec.category !== category) return false;

      const needle = draft.trim().toLowerCase();
      if (
        needle !== '' &&
        !spec.label.toLowerCase().includes(needle) &&
        !spec.key.toLowerCase().includes(needle)
      ) {
        return false;
      }

      if (state === 'on') return destinationOf(config, spec.key, spec.category) !== null;
      if (state === 'off') return destinationOf(config, spec.key, spec.category) === null;
      if (state === 'changed') return config.events[spec.key]?.enabled !== undefined;
      if (state === 'routed') return Boolean(config.events[spec.key]?.channelId);
      return true;
    },
    [category, draft, state, config],
  );

  const visible = useMemo(() => LOG_SPECS.filter(matches), [matches]);
  const visibleKeys = useMemo(() => visible.map((spec) => spec.key), [visible]);

  const groups = useMemo(
    () =>
      LOG_CATEGORIES.map((cat) => ({
        category: cat,
        rows: visible.filter((spec) => spec.category === cat),
      })).filter((group) => group.rows.length > 0),
    [visible],
  );

  // Seeded once, not derived: a group that folded shut the moment its last override was cleared
  // would close under the cursor of the admin who cleared it.
  const [explicitOpen, setExplicitOpen] = useState<ReadonlyMap<LogCategory, boolean>>(() => {
    const initial = new Map<LogCategory, boolean>();

    for (const cat of LOG_CATEGORIES) {
      if (keysOf(cat).some((key) => config.events[key] !== undefined)) initial.set(cat, true);
    }

    return initial;
  });

  const isOpen = (cat: LogCategory): boolean => explicitOpen.get(cat) ?? filtering;

  const toggleGroup = (cat: LogCategory): void =>
    setExplicitOpen((current) => {
      const next = new Map(current);
      next.set(cat, !isOpen(cat));
      return next;
    });

  const setRowState = (key: string, next: EventState): void =>
    setValue((current) => ({ ...current, events: withState(current.events, key, next) }));

  const setRowChannel = (key: string, channelId: string | null): void =>
    setValue((current) => ({ ...current, events: withChannel(current.events, key, channelId) }));

  const changedCount = visibleKeys.filter(
    (key) => config.events[key]?.enabled !== undefined,
  ).length;
  const routedCount = visibleKeys.filter((key) => Boolean(config.events[key]?.channelId)).length;
  const storedCount = visibleKeys.filter((key) => config.events[key] !== undefined).length;

  const [routeAllOpen, setRouteAllOpen] = useState(false);
  const [routeAllChannel, setRouteAllChannel] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const resetVisible = (): void => {
    setValue((current) => ({ ...current, events: bulkReset(current.events, visibleKeys) }));
    setConfirmReset(false);
  };

  const actions: readonly MenuAction[] = [
    {
      id: 'follow',
      label: 'Set all to Follow',
      icon: 'minus',
      disabled: changedCount === 0,
      onSelect: () =>
        setValue((current) => ({ ...current, events: bulkFollow(current.events, visibleKeys) })),
    },
    {
      id: 'unroute',
      label: 'Clear all event channels',
      icon: 'hash',
      disabled: routedCount === 0,
      onSelect: () =>
        setValue((current) => ({ ...current, events: bulkUnroute(current.events, visibleKeys) })),
    },
    {
      id: 'reset',
      label: 'Reset all overrides',
      icon: 'trash',
      danger: true,
      disabled: storedCount === 0,
      onSelect: () => {
        if (storedCount > CONFIRM_RESET_ABOVE) setConfirmReset(true);
        else resetVisible();
      },
    },
  ];

  const clearFilters = (): void => {
    setDraft('');
    setCategory('');
    go({ q: undefined, status: undefined });
  };

  const openSpec = openRow === null ? undefined : LOG_SPECS.find((spec) => spec.key === openRow);

  return (
    <Section label="Overrides" note="On still applies when the category is switched off.">
      <div className="matrix-toolbar">
        <SearchField
          value={draft}
          onChange={setDraft}
          label="Search events"
          placeholder="Search events…"
        />
        <Select
          aria-label="Category"
          width="sm"
          options={CATEGORY_OPTIONS}
          value={category}
          onChange={(event) => setCategory(event.currentTarget.value)}
        />
        <Select
          aria-label="State"
          width="md"
          options={STATE_OPTIONS}
          value={state}
          onChange={(event) =>
            go({ status: event.currentTarget.value === '' ? undefined : event.currentTarget.value })
          }
        />
        <Button
          size="sm"
          className="push-right"
          disabled={visibleKeys.length === 0}
          onClick={() => {
            setRouteAllChannel(null);
            setRouteAllOpen(true);
          }}
        >
          Set channel for all
        </Button>
        <MenuButton label="Bulk actions" actions={actions} />
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon="magnifying-glass"
          title="No events match these filters"
          inset
          actions={
            <Button tone="secondary" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="matrix">
          {groups.map((group) => {
            const open = isOpen(group.category);
            const total = keysOf(group.category).length;
            const changed = keysOf(group.category).filter(
              (key) => config.events[key] !== undefined,
            ).length;

            return (
              <div className="matrix-group" key={group.category}>
                <button
                  type="button"
                  className="matrix-group-head"
                  aria-expanded={open}
                  onClick={() => toggleGroup(group.category)}
                >
                  <Icon
                    name="caret-down"
                    size={12}
                    weight="fill"
                    className={open ? 'serverlog-caret' : 'serverlog-caret closed'}
                  />
                  {CATEGORY_LABEL[group.category]}
                  <span className="matrix-group-count">
                    {filtering ? group.rows.length : total}
                  </span>
                  <span className="matrix-group-aside">
                    {changed > 0 ? <Badge tone="info">{changed} changed</Badge> : null}
                    {!config.categories[group.category] ? (
                      <span className="text-muted text-xs">Category off</span>
                    ) : null}
                  </span>
                </button>

                {open
                  ? group.rows.map((spec) => (
                      <EventRow
                        key={spec.key}
                        spec={spec}
                        config={config}
                        channels={channels}
                        onState={setRowState}
                        onOpenRoute={() => setOpenRow(spec.key)}
                      />
                    ))
                  : null}
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={routeAllOpen}
        onClose={() => setRouteAllOpen(false)}
        title="Set channel for all"
        description={`Applies to the ${visibleKeys.length} event${visibleKeys.length === 1 ? '' : 's'} matching the current filters.`}
        footer={
          <>
            <Button onClick={() => setRouteAllOpen(false)}>Cancel</Button>
            <Button
              tone="primary"
              onClick={() => {
                setValue((current) => ({
                  ...current,
                  events:
                    routeAllChannel === null
                      ? bulkUnroute(current.events, visibleKeys)
                      : bulkRoute(current.events, visibleKeys, routeAllChannel),
                }));
                setRouteAllOpen(false);
              }}
            >
              Apply
            </Button>
          </>
        }
      >
        <SettingRow
          stacked
          title="Channel"
          description="Post these events here instead of in their category or default channel."
        >
          <ChannelPicker
            guildId={guildId}
            label="Channel for these events"
            types={LOG_TEXT_CHANNEL_TYPES}
            allowNone
            noneLabel="Use category or default"
            placeholder="Use category or default"
            value={routeAllChannel}
            onChange={setRouteAllChannel}
          />
        </SettingRow>
      </Dialog>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={resetVisible}
        title="Reset these overrides?"
        confirmLabel="Reset"
        danger
      >
        {storedCount} events go back to Follow and lose their own channels. Category settings do not
        change.
      </ConfirmDialog>

      {openSpec ? (
        <RouteDialog
          guildId={guildId}
          spec={openSpec}
          config={config}
          channels={channels}
          onChange={setRowChannel}
          onClose={() => setOpenRow(null)}
        />
      ) : null}
    </Section>
  );
}

function EventRow({
  spec,
  config,
  channels,
  onState,
  onOpenRoute,
}: {
  spec: LogEventSpec;
  config: ServerlogConfig;
  channels: ChannelIndex;
  onState: (key: string, next: EventState) => void;
  onOpenRoute: () => void;
}): ReactElement {
  const override = config.events[spec.key];

  return (
    <div className="matrix-row serverlog-event-row">
      <div className="matrix-row-main">
        <span className="matrix-row-name">{spec.label}</span>
        <span className="matrix-row-hint">{eventHint(spec, config, channels)}</span>
      </div>

      <div className="matrix-row-control">
        <SegmentedControl
          options={ROW_STATES}
          value={stateOf(config, spec.key)}
          label={`${spec.label} state`}
          onChange={(next) => onState(spec.key, next)}
        />
        <IconButton
          icon="hash"
          size="sm"
          tone={override?.channelId ? 'secondary' : 'ghost'}
          label={`Channel for ${spec.label}`}
          onClick={onOpenRoute}
        />
      </div>
    </div>
  );
}

function eventHint(spec: LogEventSpec, config: ServerlogConfig, channels: ChannelIndex): ReactNode {
  const override = config.events[spec.key];
  if (override?.enabled === false) return 'Off';

  const destination = destinationOf(config, spec.key, spec.category);

  if (destination === null) {
    // Two different nulls: a category this log follows is off, or the channel chain is empty.
    return override?.enabled !== true && !config.categories[spec.category]
      ? 'Category off'
      : 'No channel set';
  }

  if (override?.channelId) {
    return (
      <>
        <ChannelRef id={destination} channels={channels} /> · own channel
      </>
    );
  }

  return <ChannelRef id={destination} channels={channels} />;
}

function RouteDialog({
  guildId,
  spec,
  config,
  channels,
  onChange,
  onClose,
}: {
  guildId: string;
  spec: LogEventSpec;
  config: ServerlogConfig;
  channels: ChannelIndex;
  onChange: (key: string, channelId: string | null) => void;
  onClose: () => void;
}): ReactElement {
  const override = config.events[spec.key];
  const category = spec.category;

  const noneLabel = config.categoryChannels[category]
    ? 'Use category channel'
    : config.defaultChannelId
      ? 'Use default channel'
      : 'Nothing is posted';

  return (
    <Dialog
      open
      onClose={onClose}
      title={spec.label}
      description={<span className="mono">{spec.key}</span>}
      footer={
        <Button tone="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <SettingRow
        stacked
        title="Channel"
        description="Post this event here instead of in its category or default channel."
        note={<CurrentChain spec={spec} config={config} channels={channels} />}
      >
        <ChannelPicker
          guildId={guildId}
          label={`Channel for ${spec.label}`}
          types={LOG_TEXT_CHANNEL_TYPES}
          allowNone
          noneLabel={noneLabel}
          placeholder={noneLabel}
          value={override?.channelId || null}
          onChange={(id) => onChange(spec.key, id)}
        />
      </SettingRow>
    </Dialog>
  );
}

function CurrentChain({
  spec,
  config,
  channels,
}: {
  spec: LogEventSpec;
  config: ServerlogConfig;
  channels: ChannelIndex;
}): ReactElement {
  const destination = destinationOf(config, spec.key, spec.category);
  if (destination === null) return <>Currently not posted.</>;

  const source = config.events[spec.key]?.channelId
    ? 'own channel'
    : config.categoryChannels[spec.category]
      ? `${CATEGORY_LABEL[spec.category]} channel`
      : 'default log channel';

  return (
    <>
      Currently posts to <ChannelRef id={destination} channels={channels} /> ({source}).
    </>
  );
}

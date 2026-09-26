import { TIER_LABELS } from '@proton/cards/design';
import type { ModuleIndex, XpSource } from '@proton/core';
import { XP_SOURCES } from '@proton/core';
import {
  type Achievement,
  type AchievementKind,
  type AchievementsConfig,
  MAX_REQUIREMENTS,
  type Requirement,
} from '@proton/module-achievements/config';
import { effectiveXpSources, newRequirementId } from '@proton/module-achievements/evaluate';
import {
  DEFAULT_XP_SOURCES,
  DEPENDENCY_LABELS,
  TRIGGER_IDS,
  TRIGGERS,
  type TriggerId,
  triggerOf,
} from '@proton/module-achievements/triggers';
import { validateConfig } from '@proton/module-achievements/validate';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CHANNEL_TYPE, ChannelMultiPicker } from '../../components/discord/channel-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { useRecent } from '../../components/ui/collection.tsx';
import {
  Button,
  Chip,
  IconButton,
  Select,
  type SelectOption,
} from '../../components/ui/controls.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { HelpTip, MENU_ITEM, menuItemFor, Popover } from '../../components/ui/overlay.tsx';
import { modulesQuery, rolesQuery } from '../../lib/queries.ts';
import { protonRolePowerQuery } from './queries.ts';
import { RewardNotes, ROLE_NOTE } from './rewards.tsx';
import {
  changedRoleRewards,
  configIssues,
  enabledModuleIds,
  issuesAt,
  rewardRoleIssues,
  savedConfig,
} from './shape.ts';
import {
  convertKind,
  KindRow,
  ladderTargets,
  setRewards,
  setTarget,
  TargetRow,
  TierLadder,
  TierRewards,
  withLadder,
} from './tiers.tsx';
import { TryIt } from './try-it.tsx';

const INTRO = 'Members need all of these.';

const ONLY_IN = 'Only in these channels';
const ONLY_IN_NOTE = 'Leave empty to count every channel. A category covers every channel in it.';

const NOT_IN = 'Not in these channels';

const XP_SOURCES_TITLE = 'XP sources';

const PREREQUISITE = 'Achievement';
const PREREQUISITE_PLACEHOLDER = 'Choose an achievement';

const MINIMUM_TIER = 'At least';

const CHANNEL_LIMIT = 25;

const ID_ATTEMPTS = 8;

const XP_SOURCE_LABELS: Record<XpSource, string> = {
  message: 'Messages',
  voice: 'Voice',
  admin: 'XP given by staff',
  reward: 'XP from rewards',
};

const NEW_REQUIREMENT_ORDER: readonly TriggerId[] = [
  'messages.sent',
  'voice.minutes',
  'leveling.level',
  ...TRIGGER_IDS,
];

// Voice, stage and media too: messages and reactions in their chats count, so they must be filterable.
const TEXT_FILTER_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.announcementThread,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
  CHANNEL_TYPE.forum,
  CHANNEL_TYPE.media,
  CHANNEL_TYPE.voice,
  CHANNEL_TYPE.stage,
  CHANNEL_TYPE.category,
] as const;

const VOICE_FILTER_TYPES = [CHANNEL_TYPE.voice, CHANNEL_TYPE.stage, CHANNEL_TYPE.category] as const;

const NO_ISSUES: ReadonlyMap<string, string> = new Map();

const dependencyOff = (label: string): string =>
  `${label} is off, so this requirement is paused until you turn it on.`;

type Update = (next: (current: Achievement) => Achievement) => void;

type ErrorAt = (path: string) => string | undefined;

function isVoice(trigger: TriggerId): boolean {
  return triggerOf(trigger).group === 'Voice';
}

export function channelTypesFor(trigger: TriggerId): readonly number[] {
  return isVoice(trigger) ? VOICE_FILTER_TYPES : TEXT_FILTER_TYPES;
}

export function triggerOptions(
  kind: AchievementKind,
  current: TriggerId,
  hasOthers: boolean,
): SelectOption[] {
  return TRIGGERS.filter(
    (trigger) =>
      trigger.id === current ||
      ((kind === 'single' || trigger.tiered) &&
        (trigger.id !== 'achievements.unlocked' || hasOthers)),
  ).map((trigger) => ({ value: trigger.id, label: trigger.label, group: trigger.group }));
}

export function withTrigger(
  achievement: Achievement,
  requirementId: string,
  trigger: TriggerId,
): Achievement {
  const before = achievement.requirements.find((item) => item.id === requirementId);
  if (before === undefined || before.trigger === trigger) return achievement;

  const from = triggerOf(before.trigger);
  const to = triggerOf(trigger);
  const keepChannels =
    from.filters.channels && to.filters.channels && isVoice(before.trigger) === isVoice(trigger);

  const requirement: Requirement = {
    id: before.id,
    version: before.version,
    trigger,
    channelIds: keepChannels ? before.channelIds : [],
    excludedChannelIds: keepChannels ? before.excludedChannelIds : [],
  };

  return {
    ...achievement,
    requirements: achievement.requirements.map((item) =>
      item.id === requirementId ? requirement : item,
    ),
    tiers: withLadder(
      achievement.tiers,
      requirementId,
      ladderTargets(trigger, achievement.tiers.length),
    ),
  };
}

export function uniqueRequirementId(
  achievement: Achievement,
  random: () => number = Math.random,
): string {
  const taken = new Set(achievement.requirements.map((item) => item.id));
  let id = newRequirementId(random);

  for (let attempt = 1; taken.has(id); attempt++) {
    id = attempt < ID_ATTEMPTS ? newRequirementId(random) : `${id.slice(0, 12)}-${attempt}`;
  }

  return id;
}

export function addRequirement(achievement: Achievement, id: string): Achievement {
  if (achievement.kind !== 'single' || achievement.requirements.length >= MAX_REQUIREMENTS) {
    return achievement;
  }

  const used = new Set(achievement.requirements.map((item) => item.trigger));
  const trigger =
    NEW_REQUIREMENT_ORDER.find(
      (candidate) => candidate !== 'achievements.unlocked' && !used.has(candidate),
    ) ?? 'messages.sent';

  return {
    ...achievement,
    requirements: [
      ...achievement.requirements,
      { id, version: 1, trigger, channelIds: [], excludedChannelIds: [] },
    ],
    tiers: withLadder(achievement.tiers, id, ladderTargets(trigger, achievement.tiers.length)),
  };
}

export function removeRequirement(achievement: Achievement, requirementId: string): Achievement {
  if (achievement.requirements.length <= 1) return achievement;

  return {
    ...achievement,
    requirements: achievement.requirements.filter((item) => item.id !== requirementId),
    tiers: achievement.tiers.map((tier) => ({
      ...tier,
      targets: Object.fromEntries(
        Object.entries(tier.targets).filter(([key]) => key !== requirementId),
      ),
    })),
  };
}

export function withXpSources(requirement: Requirement, sources: readonly XpSource[]): Requirement {
  const chosen = XP_SOURCES.filter((source) => sources.includes(source));
  const { xpSources: _dropped, ...rest } = requirement;
  const usual =
    chosen.length === DEFAULT_XP_SOURCES.length &&
    DEFAULT_XP_SOURCES.every((source) => chosen.includes(source));

  return usual || chosen.length === 0 ? rest : { ...rest, xpSources: chosen };
}

export function liveIssues(
  draft: AchievementsConfig,
  saved: AchievementsConfig | null,
  index: number,
): ReadonlyMap<string, string> {
  return issuesAt(
    saved === null ? validateConfig(draft, draft) : configIssues(saved, draft),
    index,
  );
}

function useRoleIssues(
  guildId: string,
  form: ModuleForm<AchievementsConfig>,
  achievementId: string,
): ReadonlyMap<string, string> {
  const stored = form.view.config;
  const draft = form.value;
  const saved = useMemo(() => savedConfig(stored), [stored]);

  const changed = useMemo(
    () =>
      saved === null
        ? 0
        : changedRoleRewards(saved, draft).filter((item) => item.achievement.id === achievementId)
            .length,
    [saved, draft, achievementId],
  );

  const roles = useQuery({ ...rolesQuery(guildId), enabled: changed > 0 });
  const power = useQuery({ ...protonRolePowerQuery(guildId), enabled: changed > 0 });

  return useMemo(() => {
    if (saved === null || changed === 0) return NO_ISSUES;

    const facts = { guildId, roles: roles.data, power: power.data };
    return new Map(
      rewardRoleIssues(saved, draft, facts)
        .filter((issue) => issue.achievementId === achievementId)
        .map((issue) => [issue.path, issue.message]),
    );
  }, [saved, draft, changed, guildId, achievementId, roles.data, power.data]);
}

function TriggerRow({
  requirement,
  position,
  count,
  kind,
  hasOthers,
  selectId,
  dependency,
  error,
  onChange,
  onRemove,
}: {
  requirement: Requirement;
  position: number;
  count: number;
  kind: AchievementKind;
  hasOthers: boolean;
  selectId: string;
  dependency: string | undefined;
  error: string | undefined;
  onChange: (trigger: TriggerId) => void;
  onRemove: (() => void) | undefined;
}): ReactElement {
  const trigger = triggerOf(requirement.trigger);
  const title = count > 1 ? `Requirement ${position + 1}` : 'What counts';

  const stateId = `${selectId}-state`;
  const dependencyId = `${selectId}-dependency`;
  const errorId = `${selectId}-error`;

  const describedBy = [
    trigger.stateNote !== undefined ? stateId : null,
    dependency !== undefined ? dependencyId : null,
    error !== undefined ? errorId : null,
  ]
    .filter((id) => id !== null)
    .join(' ');

  return (
    <div className="row">
      <div className="row-main">
        <div className="row-title">
          {title}
          <HelpTip label={trigger.label}>{trigger.rule}</HelpTip>
        </div>
        {trigger.stateNote !== undefined ? (
          <p className="row-description" id={stateId}>
            {trigger.stateNote}
          </p>
        ) : null}
        {dependency !== undefined ? (
          <p className="row-note achievements-req-warning" id={dependencyId}>
            <Icon name="warning" size={14} weight="fill" />
            {dependency}
          </p>
        ) : null}
        {error !== undefined ? (
          <p className="row-error" role="alert" id={errorId}>
            {error}
          </p>
        ) : null}
      </div>

      <div className="row-control">
        <Select
          id={selectId}
          width="lg"
          aria-label={`${title}: trigger`}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          invalid={error !== undefined}
          options={triggerOptions(kind, requirement.trigger, hasOthers)}
          value={requirement.trigger}
          onChange={(value) => {
            const next = TRIGGER_IDS.find((id) => id === value);
            if (next !== undefined) onChange(next);
          }}
        />
        {onRemove !== undefined ? (
          <IconButton
            icon="trash"
            tone="ghost"
            size="sm"
            label={`Remove requirement ${position + 1}`}
            onClick={onRemove}
          />
        ) : null}
      </div>
    </div>
  );
}

function XpSourcesRow({
  requirement,
  error,
  onChange,
}: {
  requirement: Requirement;
  error: string | undefined;
  onChange: (sources: XpSource[]) => void;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const recent = useRecent();

  const chosen = effectiveXpSources(requirement) ?? [...DEFAULT_XP_SOURCES];
  const remaining = XP_SOURCES.filter((source) => !chosen.includes(source));

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(MENU_ITEM)?.focus({ preventScroll: true });
  }, [open]);

  return (
    <SettingRow title={XP_SOURCES_TITLE} error={error} stacked>
      <div className="chip-list">
        {chosen.map((source) => (
          <Chip
            key={source}
            className={recent.enter(source, 'part')}
            removeLabel={`Stop counting ${XP_SOURCE_LABELS[source].toLowerCase()}`}
            onRemove={
              chosen.length > 1
                ? () => onChange(chosen.filter((held) => held !== source))
                : undefined
            }
          >
            {XP_SOURCE_LABELS[source]}
          </Chip>
        ))}

        {remaining.length > 0 ? (
          <button
            ref={anchor}
            type="button"
            className="chip-add"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-invalid={error !== undefined ? true : undefined}
            aria-label="Add an XP source"
            title="Add an XP source"
            onClick={() => setOpen((current) => !current)}
          >
            <Icon name="plus" size={14} />
          </button>
        ) : null}

        <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} minWidth={200}>
          <div
            ref={menu}
            role="menu"
            aria-label="Add an XP source"
            onKeyDown={(event) => {
              if (event.key === 'Tab') {
                event.preventDefault();
                setOpen(false);
                return;
              }

              const items = [...(menu.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? [])];
              const target = menuItemFor(items, event.key);
              if (!target) return;
              event.preventDefault();
              target.focus();
            }}
          >
            {remaining.map((source) => (
              <button
                key={source}
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  recent.mark(source);
                  onChange([...chosen, source]);
                  anchor.current?.focus();
                }}
              >
                {XP_SOURCE_LABELS[source]}
              </button>
            ))}
          </div>
        </Popover>
      </div>
    </SettingRow>
  );
}

function PrerequisiteRows({
  requirement,
  others,
  path,
  errorAt,
  onChange,
}: {
  requirement: Requirement;
  others: readonly Achievement[];
  path: string;
  errorAt: ErrorAt;
  onChange: (next: Requirement) => void;
}): ReactElement {
  const chosen = others.find((other) => other.id === requirement.achievementId);
  const options = others.map((other) => ({ value: other.id, label: other.name }));
  const achievementError = errorAt(`${path}.achievementId`);
  const tierError = errorAt(`${path}.tierId`);

  const choose = (id: string): void => {
    const other = others.find((candidate) => candidate.id === id);
    if (other === undefined) return;

    const { tierId: _dropped, ...rest } = requirement;
    const first = other.tiers[0]?.id;
    onChange(
      other.kind === 'tiered' && first !== undefined
        ? { ...rest, achievementId: other.id, tierId: first }
        : { ...rest, achievementId: other.id },
    );
  };

  // The tier select is hidden unless the chosen one is tiered, so its error has nowhere else to go.
  const chosenError = achievementError ?? (chosen?.kind === 'tiered' ? undefined : tierError);

  return (
    <>
      <SettingRow title={PREREQUISITE} error={chosenError}>
        <Select
          width="lg"
          aria-label={PREREQUISITE}
          placeholder={PREREQUISITE_PLACEHOLDER}
          invalid={chosenError !== undefined}
          options={options}
          value={requirement.achievementId}
          onChange={choose}
        />
      </SettingRow>

      {chosen?.kind === 'tiered' ? (
        <SettingRow title={MINIMUM_TIER} error={tierError}>
          <Select
            width="md"
            aria-label={`${MINIMUM_TIER} this tier of ${chosen.name}`}
            invalid={tierError !== undefined}
            options={chosen.tiers.map((tier) => ({ value: tier.id, label: TIER_LABELS[tier.id] }))}
            value={requirement.tierId}
            onChange={(value) => {
              const tier = chosen.tiers.find((candidate) => candidate.id === value);
              if (tier !== undefined) onChange({ ...requirement, tierId: tier.id });
            }}
          />
        </SettingRow>
      ) : null}
    </>
  );
}

function RequirementBlock({
  guildId,
  base,
  position,
  requirement,
  achievement,
  others,
  modules,
  selectId,
  className,
  errorAt,
  update,
  onRemove,
}: {
  guildId: string;
  base: string;
  position: number;
  requirement: Requirement;
  achievement: Achievement;
  others: readonly Achievement[];
  modules: ModuleIndex | undefined;
  selectId: string;
  className: string | undefined;
  errorAt: ErrorAt;
  update: Update;
  onRemove: (() => void) | undefined;
}): ReactElement {
  const trigger = triggerOf(requirement.trigger);
  const path = `${base}.requirements.${position}`;
  const singleIndex = achievement.tiers.findIndex((tier) => tier.id === 'single');
  const single = achievement.kind === 'single' ? achievement.tiers[singleIndex] : undefined;

  const dependency =
    trigger.dependsOn !== null &&
    modules !== undefined &&
    !enabledModuleIds(modules).has(trigger.dependsOn)
      ? dependencyOff(DEPENDENCY_LABELS[trigger.dependsOn])
      : undefined;

  const setRequirement = (patch: (current: Requirement) => Requirement): void =>
    update((current) => ({
      ...current,
      requirements: current.requirements.map((item) =>
        item.id === requirement.id ? patch(item) : item,
      ),
    }));

  const types = channelTypesFor(requirement.trigger);

  return (
    <div className={className}>
      <Rows>
        <TriggerRow
          requirement={requirement}
          position={position}
          count={achievement.requirements.length}
          kind={achievement.kind}
          hasOthers={others.length > 0}
          selectId={selectId}
          dependency={dependency}
          error={errorAt(`${path}.trigger`)}
          onChange={(next) => update((current) => withTrigger(current, requirement.id, next))}
          onRemove={onRemove}
        />

        {trigger.filters.channels ? (
          <>
            <SettingRow
              title={ONLY_IN}
              description={ONLY_IN_NOTE}
              error={errorAt(`${path}.channelIds`)}
              stacked
            >
              <ChannelMultiPicker
                guildId={guildId}
                label="Add a channel to count"
                types={types}
                max={CHANNEL_LIMIT}
                invalid={errorAt(`${path}.channelIds`) !== undefined}
                value={requirement.channelIds}
                onChange={(channelIds) => setRequirement((current) => ({ ...current, channelIds }))}
              />
            </SettingRow>

            <SettingRow title={NOT_IN} error={errorAt(`${path}.excludedChannelIds`)} stacked>
              <ChannelMultiPicker
                guildId={guildId}
                label="Add a channel to leave out"
                types={types}
                max={CHANNEL_LIMIT}
                invalid={errorAt(`${path}.excludedChannelIds`) !== undefined}
                value={requirement.excludedChannelIds}
                onChange={(excludedChannelIds) =>
                  setRequirement((current) => ({ ...current, excludedChannelIds }))
                }
              />
            </SettingRow>
          </>
        ) : null}

        {trigger.filters.xpSources ? (
          <XpSourcesRow
            requirement={requirement}
            error={errorAt(`${path}.xpSources`)}
            onChange={(sources) => setRequirement((current) => withXpSources(current, sources))}
          />
        ) : null}

        {trigger.filters.achievement ? (
          <PrerequisiteRows
            requirement={requirement}
            others={others}
            path={path}
            errorAt={errorAt}
            onChange={(next) => setRequirement(() => next)}
          />
        ) : null}

        {single !== undefined && trigger.target.max > trigger.target.min ? (
          <TargetRow
            requirement={requirement}
            value={single.targets[requirement.id]}
            error={errorAt(`${base}.tiers.${singleIndex}.targets.${requirement.id}`)}
            onChange={(value) =>
              update((current) => setTarget(current, 'single', requirement.id, value))
            }
          />
        ) : null}
      </Rows>
    </div>
  );
}

export function RequirementsTab({
  guildId,
  form,
  index,
  achievement,
  tryValues,
  setTryValues,
}: {
  guildId: string;
  form: ModuleForm<AchievementsConfig>;
  index: number;
  achievement: Achievement;
  saved: Achievement | null;
  tryValues: Record<string, number>;
  setTryValues: (next: Record<string, number>) => void;
}): ReactElement {
  const blockId = useId();
  const recent = useRecent();
  const [focusId, setFocusId] = useState<string | null>(null);

  const config = form.value;
  const base = `achievements.${index}`;

  const { data: modules } = useQuery(modulesQuery(guildId));

  const stored = form.view.config;
  const saved = useMemo(() => savedConfig(stored), [stored]);
  const live = useMemo(() => liveIssues(config, saved, index), [config, saved, index]);
  const issues = useRoleIssues(guildId, form, achievement.id);

  useEffect(() => {
    if (focusId === null) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);

  // Live first: a server error stays on its path until the next save, long after the field is fixed.
  const errorAt: ErrorAt = (path) => live.get(path) ?? form.errorAt(path);

  const update: Update = (next) =>
    form.setValue((current) => ({
      ...current,
      achievements: current.achievements.map((item, at) => (at === index ? next(item) : item)),
    }));

  const others = config.achievements.filter((other) => other.id !== achievement.id);
  const single = achievement.kind === 'single';
  const count = achievement.requirements.length;
  const selectIdOf = (requirementId: string): string => `${blockId}-${requirementId}`;

  const add = (): void => {
    const id = uniqueRequirementId(achievement);
    recent.mark(id);
    update((current) => addRequirement(current, id));
    setFocusId(selectIdOf(id));
  };

  const remove = (position: number, requirementId: string): void => {
    const neighbour = achievement.requirements[position === 0 ? 1 : position - 1];
    update((current) => removeRequirement(current, requirementId));
    if (neighbour !== undefined) setFocusId(selectIdOf(neighbour.id));
  };

  const singleIndex = achievement.tiers.findIndex((tier) => tier.id === 'single');
  const singleTier = achievement.tiers[singleIndex];

  return (
    <>
      <Section label="Kind">
        <Rows>
          <KindRow
            kind={achievement.kind}
            error={errorAt(`${base}.kind`)}
            onChange={(kind) => update((current) => convertKind(current, kind))}
          />
        </Rows>
      </Section>

      <Section
        label="Requirements"
        note={single ? `${count} / ${MAX_REQUIREMENTS}` : undefined}
        intro={single ? INTRO : undefined}
        actions={
          single && count < MAX_REQUIREMENTS ? (
            <Button size="sm" icon="plus" onClick={add}>
              Add requirement
            </Button>
          ) : undefined
        }
      >
        {errorAt(`${base}.requirements`) !== undefined ? (
          <p className="row-error" role="alert">
            {errorAt(`${base}.requirements`)}
          </p>
        ) : null}

        {achievement.requirements.map((requirement, position) => (
          <div key={requirement.id}>
            {position > 0 ? <div className="tree-logic">and</div> : null}
            <RequirementBlock
              guildId={guildId}
              base={base}
              position={position}
              requirement={requirement}
              achievement={achievement}
              others={others}
              modules={modules}
              selectId={selectIdOf(requirement.id)}
              className={recent.enter(requirement.id)}
              errorAt={errorAt}
              update={update}
              onRemove={single && count > 1 ? () => remove(position, requirement.id) : undefined}
            />
          </div>
        ))}
      </Section>

      {single ? (
        <Section label="Rewards" help={ROLE_NOTE}>
          <Rows>
            <SettingRow title="Rewards" stacked>
              {singleTier !== undefined ? (
                <TierRewards
                  guildId={guildId}
                  owner={achievement.name.trim() === '' ? 'this achievement' : achievement.name}
                  path={`${base}.tiers.${singleIndex}.rewards`}
                  rewards={singleTier.rewards}
                  errorAt={errorAt}
                  issues={issues}
                  onChange={(rewards) =>
                    update((current) => setRewards(current, 'single', rewards))
                  }
                />
              ) : null}
            </SettingRow>
          </Rows>

          <RewardNotes achievement={achievement} modules={modules} />
        </Section>
      ) : (
        <Section label="Tiers" help={ROLE_NOTE}>
          <TierLadder
            guildId={guildId}
            base={base}
            achievement={achievement}
            errorAt={errorAt}
            issues={issues}
            update={update}
          />

          <RewardNotes achievement={achievement} modules={modules} />
        </Section>
      )}

      <TryIt
        guildId={guildId}
        achievement={achievement}
        achievements={config.achievements}
        values={tryValues}
        onChange={setTryValues}
      />
    </>
  );
}

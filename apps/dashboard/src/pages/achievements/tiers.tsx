import { TIER_COLOURS, TIER_LABELS, toHexColour } from '@proton/cards/design';
import {
  type Achievement,
  type AchievementKind,
  MAX_TIERS,
  type Requirement,
  type Reward,
  TIERED_IDS,
  type Tier,
} from '@proton/module-achievements/config';
import { type TriggerId, triggerOf } from '@proton/module-achievements/triggers';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRecent } from '../../components/ui/collection.tsx';
import {
  Button,
  cx,
  IconButton,
  NumberStepper,
  SegmentedControl,
  type SegmentedOption,
} from '../../components/ui/controls.tsx';
import { SettingRow } from '../../components/ui/layout.tsx';
import { RewardList } from './rewards.tsx';

export const DEFAULT_TARGETS: Readonly<Record<TriggerId, number>> = {
  'messages.sent': 100,
  'activity.active_days': 7,
  'voice.minutes': 60,
  'voice.longest_stay': 60,
  'tempvc.minutes': 60,
  'reactions.given': 50,
  'reactions.received': 50,
  'starboard.messages': 1,
  'boosts.started': 1,
  'membership.days': 30,
  'leveling.level': 5,
  'leveling.activity_xp': 1000,
  'giveaways.entered': 5,
  'giveaways.won': 1,
  'applications.accepted': 1,
  'achievements.earned': 3,
  'achievements.unlocked': 1,
};

const TIER_STEPS = [1, 2, 5, 10] as const;

const NEXT_TIER_STEP = 2;

const TIERED_START = 3;

const KIND_OPTIONS: readonly SegmentedOption<AchievementKind>[] = [
  { value: 'single', label: 'Single' },
  { value: 'tiered', label: 'Tiered' },
];

const KIND_DESCRIPTION =
  'Single is earned once. Tiered goes from Bronze up to Diamond, each tier with its own target ' +
  'and rewards.';

const DAYS_PER_YEAR = 365.25;
const DAYS_PER_MONTH = 30.44;

const NUMBERS = new Intl.NumberFormat('en-GB');

type Bounds = { min: number; max: number };

type Update = (next: (current: Achievement) => Achievement) => void;

type ErrorAt = (path: string) => string | undefined;

function clamp(value: number, { min, max }: Bounds): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function fitAscending(values: readonly number[], bounds: Bounds): number[] {
  const last = values.length - 1;
  const capped = values.map((value, at) =>
    Math.max(bounds.min, Math.min(clamp(value, bounds), bounds.max - (last - at))),
  );

  const fitted: number[] = [];
  for (const value of capped) {
    const floor = fitted.length === 0 ? bounds.min : (fitted.at(-1) ?? 0) + 1;
    fitted.push(Math.min(bounds.max, Math.max(value, floor)));
  }
  return fitted;
}

export function ladderTargets(trigger: TriggerId, count: number, base?: number): number[] {
  const start = base ?? DEFAULT_TARGETS[trigger];
  const steps = TIER_STEPS.slice(0, count).map((step) => start * step);
  return fitAscending(steps, triggerOf(trigger).target);
}

export function withLadder(
  tiers: readonly Tier[],
  requirementId: string,
  values: number[],
): Tier[] {
  return tiers.map((tier, at) => ({
    ...tier,
    targets: { ...tier.targets, [requirementId]: values[at] ?? values.at(-1) ?? 1 },
  }));
}

function tieredRequirement(achievement: Achievement): { requirement: Requirement; kept: boolean } {
  const kept = achievement.requirements.find((item) => triggerOf(item.trigger).tiered);
  if (kept !== undefined) return { requirement: kept, kept: true };

  const [first] = achievement.requirements;
  return {
    requirement: {
      id: first?.id ?? 'messages',
      version: first?.version ?? 1,
      trigger: 'messages.sent',
      channelIds: [],
      excludedChannelIds: [],
    },
    kept: false,
  };
}

export function convertKind(achievement: Achievement, kind: AchievementKind): Achievement {
  if (achievement.kind === kind) return achievement;

  if (kind === 'single') {
    const bronze = achievement.tiers.find((tier) => tier.id === 'bronze') ?? achievement.tiers[0];
    const targets = Object.fromEntries(
      achievement.requirements.flatMap((requirement) => {
        const target = bronze?.targets[requirement.id];
        return target === undefined ? [] : [[requirement.id, target]];
      }),
    );

    return {
      ...achievement,
      kind,
      tiers: [{ id: 'single', targets, rewards: [...(bronze?.rewards ?? [])] }],
    };
  }

  const single = achievement.tiers[0];
  const { requirement, kept } = tieredRequirement(achievement);
  const base = kept ? single?.targets[requirement.id] : undefined;
  const values = ladderTargets(requirement.trigger, TIERED_START, base);

  return {
    ...achievement,
    kind,
    requirements: [requirement],
    tiers: TIERED_IDS.slice(0, TIERED_START).map((id, at) => ({
      id,
      targets: { [requirement.id]: values[at] ?? 1 },
      rewards: at === 0 ? [...(single?.rewards ?? [])] : [],
    })),
  };
}

export function addTier(achievement: Achievement): Achievement {
  const top = achievement.tiers.at(-1);
  const id = TIERED_IDS[achievement.tiers.length];
  if (achievement.kind !== 'tiered' || top === undefined || id === undefined) return achievement;

  const targets = Object.fromEntries(
    achievement.requirements.map((requirement) => {
      const bounds = triggerOf(requirement.trigger).target;
      const current = top.targets[requirement.id] ?? DEFAULT_TARGETS[requirement.trigger];
      return [requirement.id, clamp(current * NEXT_TIER_STEP, bounds)];
    }),
  );

  return { ...achievement, tiers: [...achievement.tiers, { id, targets, rewards: [] }] };
}

export function removeTopTier(achievement: Achievement): Achievement {
  if (achievement.kind !== 'tiered' || achievement.tiers.length <= 2) return achievement;
  return { ...achievement, tiers: achievement.tiers.slice(0, -1) };
}

export function setTarget(
  achievement: Achievement,
  tierId: Tier['id'],
  requirementId: string,
  value: number,
): Achievement {
  return {
    ...achievement,
    tiers: achievement.tiers.map((tier) =>
      tier.id === tierId ? { ...tier, targets: { ...tier.targets, [requirementId]: value } } : tier,
    ),
  };
}

export function setRewards(
  achievement: Achievement,
  tierId: Tier['id'],
  rewards: Reward[],
): Achievement {
  return {
    ...achievement,
    tiers: achievement.tiers.map((tier) => (tier.id === tierId ? { ...tier, rewards } : tier)),
  };
}

export function unitOf(trigger: TriggerId, value: number | undefined): string {
  const { unit } = triggerOf(trigger);
  return value === 1 ? unit.one : unit.many;
}

export function durationHint(trigger: TriggerId, days: number | undefined): string | undefined {
  if (trigger !== 'membership.days' || days === undefined) return undefined;

  if (days >= DAYS_PER_YEAR - 1) {
    const years = Math.round((days / DAYS_PER_YEAR) * 10) / 10;
    return `≈ ${NUMBERS.format(years)} ${years === 1 ? 'year' : 'years'}`;
  }

  const months = Math.round(days / DAYS_PER_MONTH);
  return months >= 1 ? `≈ ${months} ${months === 1 ? 'month' : 'months'}` : undefined;
}

export function tierColour(id: Tier['id']): string {
  return toHexColour(TIER_COLOURS[id]);
}

export function KindRow({
  kind,
  error,
  onChange,
}: {
  kind: AchievementKind;
  error: string | undefined;
  onChange: (next: AchievementKind) => void;
}): ReactElement {
  return (
    <SettingRow title="Single or tiered" description={KIND_DESCRIPTION} error={error}>
      <SegmentedControl<AchievementKind>
        label="Single or tiered"
        options={KIND_OPTIONS}
        value={kind}
        onChange={onChange}
      />
    </SettingRow>
  );
}

export function TargetRow({
  requirement,
  value,
  error,
  onChange,
}: {
  requirement: Requirement;
  value: number | undefined;
  error: string | undefined;
  onChange: (next: number) => void;
}): ReactElement {
  const trigger = triggerOf(requirement.trigger);

  return (
    <SettingRow title="Target" error={error} note={durationHint(requirement.trigger, value)}>
      <span className="inline inline-8">
        <NumberStepper
          label={`Target for ${trigger.label.toLowerCase()}`}
          value={value ?? null}
          min={trigger.target.min}
          max={trigger.target.max}
          width={132}
          invalid={error !== undefined}
          onChange={(next) => {
            if (next !== null) onChange(next);
          }}
        />
        <span className="text-sm text-muted">{unitOf(requirement.trigger, value)}</span>
      </span>
    </SettingRow>
  );
}

export function TierRewards({
  guildId,
  owner,
  path,
  rewards,
  errorAt,
  issues,
  onChange,
}: {
  guildId: string;
  owner: string;
  path: string;
  rewards: readonly Reward[];
  errorAt: ErrorAt;
  issues: ReadonlyMap<string, string>;
  onChange: (next: Reward[]) => void;
}): ReactElement {
  const byIndex = new Map(
    rewards.flatMap((_, at) => {
      const issue = issues.get(`${path}.${at}.roleId`);
      return issue === undefined ? [] : [[at, issue] as const];
    }),
  );

  return (
    <RewardList
      guildId={guildId}
      owner={owner}
      rewards={rewards}
      listError={errorAt(path)}
      issues={byIndex}
      errorAt={(at) =>
        errorAt(`${path}.${at}`) ??
        errorAt(`${path}.${at}.roleId`) ??
        errorAt(`${path}.${at}.amount`)
      }
      onChange={onChange}
    />
  );
}

function Rung({
  guildId,
  base,
  tier,
  tierIndex,
  requirement,
  top,
  removable,
  focus,
  className,
  errorAt,
  issues,
  update,
  onRemove,
}: {
  guildId: string;
  base: string;
  tier: Tier;
  tierIndex: number;
  requirement: Requirement;
  top: boolean;
  removable: boolean;
  focus: boolean;
  className: string | undefined;
  errorAt: ErrorAt;
  issues: ReadonlyMap<string, string>;
  update: Update;
  onRemove: () => void;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const trigger = triggerOf(requirement.trigger);
  const label = TIER_LABELS[tier.id];
  const value = tier.targets[requirement.id];
  const error = errorAt(`${base}.tiers.${tierIndex}.targets.${requirement.id}`);
  const hint = durationHint(requirement.trigger, value);

  useEffect(() => {
    if (focus) box.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [focus]);

  return (
    <div ref={box} className={className}>
      <div className={cx('rung achievements-req-rung', error !== undefined && 'invalid')}>
        <span className="rung-index" aria-hidden>
          <span className="chip-dot" style={{ background: tierColour(tier.id) }} />
        </span>

        <div className="achievements-req-rung-main">
          <div className="rung-body">
            <span className="achievements-req-tier">{label}</span>
            <span className="rung-connector">at</span>
            <NumberStepper
              label={`${label} target`}
              value={value ?? null}
              min={trigger.target.min}
              max={trigger.target.max}
              width={132}
              invalid={error !== undefined}
              onChange={(next) => {
                if (next !== null)
                  update((current) => setTarget(current, tier.id, requirement.id, next));
              }}
            />
            <span className="rung-connector">{unitOf(requirement.trigger, value)}</span>
            {hint !== undefined ? <span className="rung-connector">{hint}</span> : null}
          </div>

          <div className="achievements-req-rung-rewards">
            <span className="rung-connector">Rewards</span>
            <TierRewards
              guildId={guildId}
              owner={label}
              path={`${base}.tiers.${tierIndex}.rewards`}
              rewards={tier.rewards}
              errorAt={errorAt}
              issues={issues}
              onChange={(rewards) => update((current) => setRewards(current, tier.id, rewards))}
            />
          </div>
        </div>

        {top && removable ? (
          <span className="rung-aside">
            <IconButton
              icon="x"
              tone="ghost"
              size="sm"
              label={`Remove ${label}`}
              onClick={onRemove}
            />
          </span>
        ) : null}
      </div>

      {error !== undefined ? (
        <p className="rung-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TierLadder({
  guildId,
  base,
  achievement,
  errorAt,
  issues,
  update,
}: {
  guildId: string;
  base: string;
  achievement: Achievement;
  errorAt: ErrorAt;
  issues: ReadonlyMap<string, string>;
  update: Update;
}): ReactElement | null {
  const addButton = useRef<HTMLButtonElement>(null);
  const [focusTier, setFocusTier] = useState<Tier['id'] | null>(null);
  const [refocusAdd, setRefocusAdd] = useState(false);
  const recent = useRecent();

  useEffect(() => {
    if (!refocusAdd) return;
    addButton.current?.focus();
    setRefocusAdd(false);
  }, [refocusAdd]);

  const [requirement] = achievement.requirements;
  if (requirement === undefined) return null;

  const next = TIERED_IDS[achievement.tiers.length];
  const removable = achievement.tiers.length > 2;
  const listError = errorAt(`${base}.tiers`);

  return (
    <div className="stack stack-8">
      {listError !== undefined ? (
        <p className="row-error" role="alert">
          {listError}
        </p>
      ) : null}

      <div className="ladder">
        {achievement.tiers.map((tier, tierIndex) => (
          <Rung
            key={tier.id}
            guildId={guildId}
            base={base}
            tier={tier}
            tierIndex={tierIndex}
            requirement={requirement}
            top={tierIndex === achievement.tiers.length - 1}
            removable={removable}
            focus={focusTier === tier.id}
            className={recent.enter(tier.id)}
            errorAt={errorAt}
            issues={issues}
            update={update}
            onRemove={() => {
              update(removeTopTier);
              setFocusTier(null);
              setRefocusAdd(true);
            }}
          />
        ))}
      </div>

      {next !== undefined && achievement.tiers.length < MAX_TIERS ? (
        <Button
          ref={addButton}
          size="sm"
          icon="plus"
          className="ladder-add"
          onClick={() => {
            recent.mark(next);
            setFocusTier(next);
            update(addTier);
          }}
        >
          Add {TIER_LABELS[next]}
        </Button>
      ) : null}
    </div>
  );
}

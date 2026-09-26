import { TIER_LABELS } from '@proton/cards/design';
import type { Achievement, Requirement, Tier } from '@proton/module-achievements/config';
import {
  describeRequirement,
  earnedTierIds,
  formatProgress,
  joinAnd,
  nextTier,
  progressBar,
  tierRank,
} from '@proton/module-achievements/evaluate';
import { triggerOf } from '@proton/module-achievements/triggers';
import type { ReactElement } from 'react';
import { Badge, NumberStepper, Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { rewardLabel, useRoleIndex } from './rewards.tsx';
import { tierColour } from './tiers.tsx';

export const TRY_IT_NOTE = 'Nothing here changes real progress or gives anything.';

const TRY_IT_INTRO = 'If a member had…';

const NO_REWARDS = 'No rewards';

const ALL_EARNED = 'Every tier would be earned.';

type Values = Readonly<Record<string, number>>;

function byRank(tiers: readonly Tier[]): Tier[] {
  return [...tiers].sort((a, b) => tierRank(a.id) - tierRank(b.id));
}

function ValueRow({
  requirement,
  value,
  nameOf,
  onChange,
}: {
  requirement: Requirement;
  value: number;
  nameOf: (id: string) => string | undefined;
  onChange: (next: number) => void;
}): ReactElement {
  const trigger = triggerOf(requirement.trigger);

  if (trigger.filters.achievement) {
    const held = describeRequirement(requirement, 1, 'en-GB', nameOf);

    return (
      <SettingRow title={held}>
        <Switch
          label={`Try it: ${held}`}
          checked={value >= 1}
          onChange={(on) => onChange(on ? 1 : 0)}
        />
      </SettingRow>
    );
  }

  return (
    <SettingRow title={trigger.label}>
      <span className="inline inline-8">
        <NumberStepper
          label={`Try it: ${trigger.unit.many}`}
          value={value}
          min={0}
          max={trigger.target.max}
          width={132}
          onChange={(next) => onChange(next ?? 0)}
        />
        <span className="text-sm text-muted">
          {value === 1 ? trigger.unit.one : trigger.unit.many}
        </span>
      </span>
    </SettingRow>
  );
}

export function TryIt({
  guildId,
  achievement,
  achievements,
  values,
  onChange,
}: {
  guildId: string;
  achievement: Achievement;
  achievements: readonly Achievement[];
  values: Values;
  onChange: (next: Record<string, number>) => void;
}): ReactElement {
  const roleRewards = achievement.tiers.some((tier) =>
    tier.rewards.some((reward) => reward.kind !== 'xp'),
  );
  const { roles, pending } = useRoleIndex(guildId, roleRewards);

  const nameOf = (id: string): string | undefined =>
    achievements.find((candidate) => candidate.id === id)?.name;

  const earned = new Set(earnedTierIds(achievement, values));
  const next = nextTier(achievement, values, [...earned]);
  const single = achievement.kind === 'single';

  const rewardsOf = (tier: Tier): string =>
    tier.rewards.length === 0
      ? NO_REWARDS
      : joinAnd(
          tier.rewards.map((reward) =>
            reward.kind === 'xp'
              ? rewardLabel(reward)
              : rewardLabel(reward, roles.get(reward.roleId)?.name ?? (pending ? '…' : undefined)),
          ),
        );

  return (
    <Section label="Try it" intro={TRY_IT_INTRO}>
      <Rows>
        {achievement.requirements.map((requirement) => (
          <ValueRow
            key={requirement.id}
            requirement={requirement}
            value={values[requirement.id] ?? 0}
            nameOf={nameOf}
            onChange={(value) => onChange({ ...values, [requirement.id]: value })}
          />
        ))}
      </Rows>

      <Rows>
        {byRank(achievement.tiers).map((tier) => {
          const has = earned.has(tier.id);

          return (
            <SettingRow
              key={tier.id}
              title={
                single ? (
                  achievement.name.trim() || 'This achievement'
                ) : (
                  <span className="inline inline-6">
                    <span
                      className="chip-dot"
                      style={{ background: tierColour(tier.id) }}
                      aria-hidden
                    />
                    {TIER_LABELS[tier.id]}
                  </span>
                )
              }
              description={rewardsOf(tier)}
            >
              <Badge tone={has ? 'success' : 'neutral'}>
                {has ? 'Would be earned' : 'Not yet'}
              </Badge>
            </SettingRow>
          );
        })}

        {next !== null ? (
          <SettingRow
            title={single ? 'Progress' : `Towards ${TIER_LABELS[next.tier]}`}
            description={
              <span className="stack stack-4">
                {next.requirements.map((progress) => (
                  <span key={progress.id} className="achievements-req-progress">
                    <span>
                      {formatProgress(
                        progress.current,
                        progress.target,
                        triggerOf(progress.trigger).unit,
                      )}
                    </span>
                    <span className="achievements-req-bar" aria-hidden>
                      {progressBar(progress.ratio)}
                    </span>
                  </span>
                ))}
              </span>
            }
          />
        ) : single ? null : (
          <SettingRow title={ALL_EARNED} />
        )}
      </Rows>

      <p className="achievements-note">{TRY_IT_NOTE}</p>
    </Section>
  );
}

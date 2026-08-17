import { type RoleReward, roleRewardsSchema } from '@proton/module-leveling/config';
import { MAX_LEVEL } from '@proton/module-leveling/curve';
import type { ReactElement } from 'react';

export interface GuildRole {
  id: string;
  name: string;
}

export interface RoleRewardsEditorProps {
  rewards: readonly RoleReward[];
  roles: readonly GuildRole[];
  onChange: (rewards: RoleReward[]) => void;
}

const MAX_REWARDS = 50;

export function RoleRewardsEditor({
  rewards,
  roles,
  onChange,
}: RoleRewardsEditorProps): ReactElement {
  const parsed = roleRewardsSchema.safeParse(rewards);

  function update(index: number, patch: Partial<RoleReward>): void {
    onChange(rewards.map((reward, i) => (i === index ? { ...reward, ...patch } : reward)));
  }

  function add(): void {
    const highest = rewards.reduce((max, reward) => Math.max(max, reward.level), 0);
    onChange([
      ...rewards,

      { level: Math.min(MAX_LEVEL, highest + 5), roleId: '' },
    ]);
  }

  return (
    <div className="ladder" data-path="roleRewards">
      <p className="field-description">
        When a member reaches a level, Proton grants the matching role. In <em>replace</em> mode the
        previous reward roles are removed; in <em>stack</em> mode they are kept.
      </p>

      {rewards.map((reward, index) => (
        <div
          className="ladder-rung"
          // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own row
          key={`reward-${index}`}
        >
          <label className="filter">
            <span>At level</span>
            <input
              type="number"
              min={1}
              max={MAX_LEVEL}
              value={reward.level}
              onChange={(e) =>
                update(index, { level: e.target.value === '' ? 0 : e.target.valueAsNumber })
              }
            />
          </label>

          <label className="filter">
            <span>Grant role</span>
            <select
              value={reward.roleId}
              aria-invalid={reward.roleId === ''}
              onChange={(e) => update(index, { roleId: e.target.value })}
            >
              <option value="">Choose a role…</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="button button-quiet"
            aria-label={`Remove the reward at level ${reward.level}`}
            onClick={() => onChange(rewards.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}

      {rewards.length === 0 ? (
        <p className="field-empty">
          No role rewards. Members still gain XP and appear on the leaderboard; no roles are
          granted.
        </p>
      ) : null}

      <button
        type="button"
        className="button button-quiet"
        onClick={add}
        disabled={rewards.length >= MAX_REWARDS}
      >
        {rewards.length >= MAX_REWARDS ? `Limit of ${MAX_REWARDS} rewards reached` : 'Add reward'}
      </button>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {issue.path.length > 0 ? `Reward ${Number(issue.path[0]) + 1}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

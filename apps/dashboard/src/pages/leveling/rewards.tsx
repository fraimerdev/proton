import {
  type LevelingConfig,
  REWARD_MODES,
  type RewardMode,
  type RoleReward,
  roleRewardSchema,
} from '@proton/module-leveling/config';
import { MAX_LEVEL } from '@proton/module-leveling/curve';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { RolePicker } from '../../components/discord/role-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { CollectionHeader } from '../../components/ui/collection.tsx';
import {
  Button,
  cx,
  IconButton,
  NumberStepper,
  SegmentedControl,
} from '../../components/ui/controls.tsx';
import { EmptyState } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { humaniseOption } from '../../lib/enum-labels.ts';

const REWARDS_MAX = 50;
const MIN_LEVEL = 1;
const LEVEL_GAP = 5;

const MODE_DESCRIPTION =
  'Stack keeps every reward role earned. Replace keeps only the roles for the highest level ' +
  'reached and removes lower ones.';

const SHARED_LEVEL = 'More than one reward uses this level. All their roles are given.';

const LADDER_FULL = `You can add up to ${REWARDS_MAX} role rewards. Remove one to add another.`;

const NO_REWARDS = 'Add a reward for a level.';

const MANAGE_ROLES =
  'Giving reward roles needs Manage Roles, and Proton’s highest role must be above every reward ' +
  'role. Leveling does not check for Manage Roles in advance, so a missing permission only shows ' +
  'when a member levels up.';

const MODE_OPTIONS = REWARD_MODES.map((mode) => ({ value: mode, label: humaniseOption(mode) }));

interface Entry {
  reward: RoleReward;
  at: number;
}

function Rung({
  guildId,
  entry,
  sharedLevel,
  levelError,
  roleError,
  onChange,
  onRemove,
}: {
  guildId: string;
  entry: Entry;
  sharedLevel: boolean;
  levelError: string | undefined;
  roleError: string | undefined;
  onChange: (next: RoleReward) => void;
  onRemove: () => void;
}): ReactElement {
  const error = levelError ?? roleError;

  return (
    <div>
      <div className={cx('rung', error !== undefined && 'invalid')}>
        <span className="rung-index">{entry.reward.level}</span>
        <div className="rung-body">
          <span className="rung-connector">Level</span>
          <NumberStepper
            label={`Reward ${entry.at + 1} level`}
            value={entry.reward.level}
            min={MIN_LEVEL}
            max={MAX_LEVEL}
            width={96}
            invalid={levelError !== undefined}
            onChange={(next) => onChange({ ...entry.reward, level: next ?? entry.reward.level })}
          />
          <span className="rung-connector">gives</span>
          <RolePicker
            guildId={guildId}
            label={`Level ${entry.reward.level} reward role`}
            allowNone={false}
            requireAssignable
            width={236}
            invalid={roleError !== undefined}
            value={entry.reward.roleId}
            onChange={(roleId) => {
              if (roleId !== null) onChange({ ...entry.reward, roleId });
            }}
          />
        </div>
        <span className="rung-aside">
          <IconButton icon="x" tone="ghost" size="sm" label="Remove reward" onClick={onRemove} />
        </span>
      </div>

      {error !== undefined ? (
        <p className="rung-error" role="alert">
          {error}
        </p>
      ) : sharedLevel ? (
        <p className="leveling-rung-note">{SHARED_LEVEL}</p>
      ) : null}
    </div>
  );
}

function Composer({
  guildId,
  level,
  onCancel,
  onAdd,
}: {
  guildId: string;
  level: number;
  onCancel: () => void;
  onAdd: (reward: RoleReward) => void;
}): ReactElement {
  const [draftLevel, setDraftLevel] = useState(level);
  const [roleId, setRoleId] = useState<string | null>(null);

  const candidate = roleRewardSchema.safeParse({ level: draftLevel, roleId });

  return (
    <div className="rung">
      <span className="rung-index">+</span>
      <div className="rung-body">
        <span className="rung-connector">Level</span>
        <NumberStepper
          label="New reward level"
          value={draftLevel}
          min={MIN_LEVEL}
          max={MAX_LEVEL}
          width={96}
          onChange={(next) => setDraftLevel(next ?? draftLevel)}
        />
        <span className="rung-connector">gives</span>
        <RolePicker
          guildId={guildId}
          label="New reward role"
          placeholder="Choose a role"
          allowNone={false}
          requireAssignable
          width={236}
          value={roleId}
          onChange={setRoleId}
        />
      </div>
      <span className="rung-aside">
        <Button tone="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          tone="primary"
          size="sm"
          disabled={!candidate.success}
          onClick={() => {
            if (candidate.success) onAdd(candidate.data);
          }}
        >
          Add
        </Button>
      </span>
    </div>
  );
}

export function RewardsArea({
  guildId,
  form,
}: {
  guildId: string;
  form: ModuleForm<LevelingConfig>;
}): ReactElement {
  const rewards = form.value.roleRewards;
  const [composing, setComposing] = useState(false);

  const setRewards = (next: readonly RoleReward[]): void =>
    form.setValue((current) => ({ ...current, roleRewards: [...next] }));

  const entries: Entry[] = rewards
    .map((reward, at) => ({ reward, at }))
    .sort((a, b) => a.reward.level - b.reward.level || a.at - b.at);

  const perLevel = new Map<number, number>();
  for (const reward of rewards) perLevel.set(reward.level, (perLevel.get(reward.level) ?? 0) + 1);

  const highest = rewards.reduce((top, reward) => Math.max(top, reward.level), 0);
  const nextLevel = Math.min(MAX_LEVEL, highest === 0 ? LEVEL_GAP : highest + LEVEL_GAP);

  const full = rewards.length >= REWARDS_MAX;
  const listError = form.errorAt('roleRewards');

  const addButton = (
    <Button tone="primary" size="sm" icon="plus" onClick={() => setComposing(true)}>
      Add reward
    </Button>
  );

  return (
    <>
      <Section label="Earned roles">
        <Rows>
          <SettingRow
            title="Reward mode"
            description={MODE_DESCRIPTION}
            error={form.errorAt('rewardMode')}
          >
            <SegmentedControl<RewardMode>
              label="Reward mode"
              options={MODE_OPTIONS}
              value={form.value.rewardMode}
              onChange={(rewardMode) => form.setValue((current) => ({ ...current, rewardMode }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section>
        <CollectionHeader
          title="Role rewards"
          used={rewards.length}
          ceiling={REWARDS_MAX}
          limitLabel="role rewards"
          actions={rewards.length > 0 && !full && !composing ? addButton : null}
        />

        {listError !== undefined ? (
          <p className="row-error" role="alert">
            {listError}
          </p>
        ) : null}

        {rewards.length === 0 && !composing ? (
          <EmptyState inset icon="star" title="No role rewards" actions={addButton}>
            {NO_REWARDS}
          </EmptyState>
        ) : (
          <div className="ladder">
            {entries.map((entry) => (
              <Rung
                key={entry.at}
                guildId={guildId}
                entry={entry}
                sharedLevel={(perLevel.get(entry.reward.level) ?? 0) > 1}
                levelError={form.errorAt(`roleRewards.${entry.at}.level`)}
                roleError={form.errorAt(`roleRewards.${entry.at}.roleId`)}
                onChange={(next) =>
                  setRewards(rewards.map((reward, at) => (at === entry.at ? next : reward)))
                }
                onRemove={() => setRewards(rewards.filter((_, at) => at !== entry.at))}
              />
            ))}

            {composing ? (
              <Composer
                guildId={guildId}
                level={nextLevel}
                onCancel={() => setComposing(false)}
                onAdd={(reward) => {
                  setRewards([...rewards, reward]);
                  setComposing(false);
                }}
              />
            ) : null}
          </div>
        )}

        {full ? <p className="leveling-note">{LADDER_FULL}</p> : null}

        <p className="leveling-note">{MANAGE_ROLES}</p>
      </Section>
    </>
  );
}

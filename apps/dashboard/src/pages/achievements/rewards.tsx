import type { ModuleIndex } from '@proton/core';
import { XP_GRANT_MAX } from '@proton/core';
import {
  type Achievement,
  MAX_REWARDS_PER_TIER,
  type Reward,
} from '@proton/module-achievements/config';
import { rewardKeyOf } from '@proton/module-achievements/evaluate';
import { REWARD_KINDS, type RewardKind } from '@proton/module-achievements/triggers';
import { useQuery } from '@tanstack/react-query';
import type { KeyboardEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { RolePicker, roleColour } from '../../components/discord/role-picker.tsx';
import { useRecent } from '../../components/ui/collection.tsx';
import { Button, Chip, NumberStepper } from '../../components/ui/controls.tsx';
import { Icon, type IconName } from '../../components/ui/icon.tsx';
import { MENU_ITEM, menuItemFor, Popover } from '../../components/ui/overlay.tsx';
import type { GuildRole } from '../../lib/discord.ts';
import { rolesQuery } from '../../lib/queries.ts';
import { xpRewardNote } from './shape.ts';

export const ROLE_NOTE =
  'Role rewards need Manage Roles, and Proton’s highest role must be above every reward role. ' +
  'Proton can’t change the roles of the server owner or members ranked at or above it.';

const REWARDS_FULL = `A tier can give up to ${MAX_REWARDS_PER_TIER} rewards.`;

const ALREADY_THERE = 'That reward is already here.';

const CONTRADICTS: Record<Exclude<RewardKind, 'xp'>, string> = {
  add_role: 'This already removes that role, and a tier can’t give and remove the same role.',
  remove_role: 'This already gives that role, and a tier can’t give and remove the same role.',
};

const XP_DEFAULT = 100;

const KIND_ICONS: Record<RewardKind, IconName> = {
  add_role: 'user-plus',
  remove_role: 'prohibit',
  xp: 'star',
};

const COMPOSER_TITLES: Record<RewardKind, string> = {
  add_role: 'Role to give',
  remove_role: 'Role to remove',
  xp: 'XP to give',
};

const NUMBERS = new Intl.NumberFormat('en-GB');

type RoleIndex = ReadonlyMap<string, GuildRole>;

export function rewardLabel(reward: Reward, roleName?: string | undefined): string {
  if (reward.kind === 'xp') return `${NUMBERS.format(reward.amount)} XP`;

  const role = `@${roleName ?? reward.roleId}`;
  return reward.kind === 'add_role' ? `Give ${role}` : `Remove ${role}`;
}

export function rewardProblem(rewards: readonly Reward[], reward: Reward): string | null {
  const key = rewardKeyOf(reward);
  if (rewards.some((held) => rewardKeyOf(held) === key)) return ALREADY_THERE;
  if (reward.kind === 'xp') return null;

  const opposite = reward.kind === 'add_role' ? 'remove_role' : 'add_role';
  const clash = rewards.some((held) => held.kind === opposite && held.roleId === reward.roleId);
  return clash ? CONTRADICTS[reward.kind] : null;
}

export function useRoleIndex(
  guildId: string,
  enabled: boolean,
): {
  roles: RoleIndex;
  pending: boolean;
} {
  const { data, isPending } = useQuery({ ...rolesQuery(guildId), enabled });
  return {
    roles: new Map((data ?? []).map((role) => [role.id, role])),
    pending: enabled && isPending,
  };
}

function hasRoleRewards(rewards: readonly Reward[]): boolean {
  return rewards.some((reward) => reward.kind !== 'xp');
}

function RewardComposer({
  guildId,
  kind,
  onAdd,
  onCancel,
}: {
  guildId: string;
  kind: RewardKind;
  onAdd: (reward: Reward) => string | null;
  onCancel: () => void;
}): ReactElement {
  const box = useRef<HTMLFieldSetElement>(null);
  const [amount, setAmount] = useState<number | null>(XP_DEFAULT);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('input, .picker-trigger')?.focus();
  }, []);

  const submit = (reward: Reward): void => setProblem(onAdd(reward));

  const validAmount =
    amount !== null && Number.isInteger(amount) && amount >= 1 && amount <= XP_GRANT_MAX;

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>): void => {
    if (event.defaultPrevented) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && kind === 'xp' && validAmount) {
      event.preventDefault();
      submit({ kind: 'xp', amount });
    }
  };

  return (
    <fieldset
      ref={box}
      aria-label={COMPOSER_TITLES[kind]}
      className="achievements-req-composer"
      onKeyDown={onKeyDown}
    >
      <div className="inline inline-8 inline-wrap">
        {kind === 'xp' ? (
          <>
            <NumberStepper
              label={COMPOSER_TITLES.xp}
              value={amount}
              min={1}
              max={XP_GRANT_MAX}
              width={132}
              onChange={(next) => {
                setAmount(next);
                setProblem(null);
              }}
            />
            <span className="text-sm text-muted">XP</span>
            <Button
              tone="primary"
              size="sm"
              disabled={!validAmount}
              onClick={() => {
                if (validAmount) submit({ kind: 'xp', amount });
              }}
            >
              Add
            </Button>
          </>
        ) : (
          <RolePicker
            guildId={guildId}
            label={COMPOSER_TITLES[kind]}
            placeholder="Choose a role"
            allowNone={false}
            requireAssignable
            width={236}
            invalid={problem !== null}
            value={null}
            onChange={(roleId) => {
              if (roleId !== null) submit({ kind, roleId });
            }}
          />
        )}
        <Button tone="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {problem !== null ? (
        <p className="field-error" role="alert">
          {problem}
        </p>
      ) : null}
    </fieldset>
  );
}

export function RewardList({
  guildId,
  owner,
  rewards,
  onChange,
  errorAt,
  listError,
  issues,
}: {
  guildId: string;
  owner: string;
  rewards: readonly Reward[];
  onChange: (next: Reward[]) => void;
  errorAt: (rewardIndex: number) => string | undefined;
  listError?: string | undefined;
  issues: ReadonlyMap<number, string>;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<RewardKind | null>(null);
  const recent = useRecent();

  const { roles, pending } = useRoleIndex(guildId, hasRoleRewards(rewards));

  const full = rewards.length >= MAX_REWARDS_PER_TIER;
  const kinds = REWARD_KINDS.filter(
    (kind) => kind.kind !== 'xp' || !rewards.some((reward) => reward.kind === 'xp'),
  );
  const addLabel = `Add a reward to ${owner}`;

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(MENU_ITEM)?.focus({ preventScroll: true });
  }, [open]);

  const labelOf = (reward: Reward): string =>
    reward.kind === 'xp'
      ? rewardLabel(reward)
      : rewardLabel(reward, roles.get(reward.roleId)?.name ?? (pending ? '…' : undefined));

  const add = (reward: Reward): string | null => {
    const problem = rewardProblem(rewards, reward);
    if (problem !== null) return problem;

    recent.mark(rewardKeyOf(reward));
    onChange([...rewards, reward]);
    setAdding(null);
    anchor.current?.focus();
    return null;
  };

  const problems = rewards.flatMap((reward, at) => {
    const issue = issues.get(at);
    if (issue !== undefined) return [{ at, message: issue }];

    const error = errorAt(at);
    return error === undefined ? [] : [{ at, message: `${labelOf(reward)}: ${error}` }];
  });

  return (
    <div className="stack stack-8">
      <div className="chip-list">
        {rewards.map((reward, at) => {
          const label = labelOf(reward);
          const role = reward.kind === 'xp' ? undefined : roles.get(reward.roleId);

          return (
            <Chip
              // biome-ignore lint/suspicious/noArrayIndexKey: a repeated reward is refused on save, and its chip must still render
              key={`${at}:${rewardKeyOf(reward)}`}
              className={recent.enter(rewardKeyOf(reward), 'part')}
              colour={reward.kind === 'xp' ? undefined : roleColour(role)}
              removeLabel={`Remove “${label}” from ${owner}`}
              onRemove={() => onChange(rewards.filter((_, index) => index !== at))}
            >
              {label}
            </Chip>
          );
        })}

        {full ? null : (
          <button
            ref={anchor}
            type="button"
            className="chip-add"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={addLabel}
            title="Add a reward"
            onClick={() => {
              setAdding(null);
              setOpen((current) => !current);
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        )}

        <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} minWidth={200}>
          <div
            ref={menu}
            role="menu"
            aria-label={addLabel}
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
            {kinds.map((kind) => (
              <button
                key={kind.kind}
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  setAdding(kind.kind);
                }}
              >
                <Icon name={KIND_ICONS[kind.kind]} size={15} />
                {kind.label}
              </button>
            ))}
          </div>
        </Popover>
      </div>

      {adding !== null && !full ? (
        <RewardComposer
          guildId={guildId}
          kind={adding}
          onAdd={add}
          onCancel={() => {
            setAdding(null);
            anchor.current?.focus();
          }}
        />
      ) : null}

      {listError !== undefined ? (
        <p className="field-error" role="alert">
          {listError}
        </p>
      ) : null}

      {problems.map(({ at, message }) => (
        <p key={at} className="field-error" role="alert">
          {message}
        </p>
      ))}

      {full ? <p className="field-hint">{REWARDS_FULL}</p> : null}
    </div>
  );
}

export function RewardNotes({
  achievement,
  modules,
}: {
  achievement: Achievement;
  modules: ModuleIndex | undefined;
}): ReactElement | null {
  const xp = xpRewardNote(achievement, modules);
  if (xp === null) return null;

  return (
    <div className="achievements-req-notes">
      <p>{xp}</p>
    </div>
  );
}

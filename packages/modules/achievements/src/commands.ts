import {
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  type CommandDefinition,
  defer,
  deferEphemeral,
  errorStatus,
  followUp,
  hasWithAdmin,
  type InteractionMessage,
  labelOf,
  type ModuleContext,
  Permissions,
  type RespondTo,
  replyEphemeral,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { renderBadgePng } from './badge.ts';
import {
  ACHIEVEMENT_COMMAND,
  ACHIEVEMENT_OPTION,
  ACHIEVEMENTS_OFF,
  BADGE_BUDGET_MS,
  detailComponents,
  displayTier,
  earnedTiers,
  findAchievement,
  LIST_COMMAND,
  type ListEntry,
  listPage,
  NO_APPLICATION,
  needsManageServer,
  notFound,
  RESET_UNSTARTED,
  resetPrompt,
  retiredComponents,
  STORE_UNBOUND,
  statusMessage,
  UNKNOWN_SUBCOMMAND,
  v2Message,
} from './command-views.ts';
import {
  type Achievement,
  type AchievementsConfig,
  MODULE_ID,
  type Requirement,
} from './config.ts';
import { type AchievementsDeps, clockOf, describeUnbound } from './deps.ts';
import { draftIdOf, type ResetDraft } from './drafts.ts';
import { DAY_MS, routingOf } from './engine.ts';
import {
  currentTierIds,
  type DisplayStatus,
  dependenciesOf,
  displayStatus,
  nextTier,
  tierRank,
} from './evaluate.ts';
import { BADGE_FILENAME } from './placeholders.ts';
import {
  type AchievementStore,
  type MemberAchievementState,
  requirementValue,
  type UnlockRow,
} from './store.ts';
import {
  DEPENDENCY_MODULES,
  type DependencyModule,
  LEDGER_METRICS,
  triggerOf,
} from './triggers.ts';

type Command = CommandDefinition<AchievementsConfig>;
type Ctx = CommandContext<AchievementsConfig>;
type Answering = Pick<ModuleContext, 'guildId' | 'executor' | 'logger'>;
type Viewing = Pick<ModuleContext<AchievementsConfig>, 'guildId' | 'config' | 'logger'>;

export async function answer(ctx: Answering, request: ActionRequest): Promise<ActionResult> {
  const result = await ctx.executor.execute(request);

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `achievements could not answer an interaction: ${
        result.failure?.humanReason ?? 'Discord gave no reason.'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }

  return result;
}

export function acknowledged(result: ActionResult): boolean {
  return result.status !== 'failed_precheck' && result.status !== 'failed_api';
}

function commandTo(ctx: Ctx): RespondTo {
  return {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: { id: ctx.interaction.id, token: ctx.interaction.token },
    idempotencyKey: ctx.idempotencyKey,
  };
}

async function refuse(ctx: Ctx, text: string): Promise<void> {
  await answer(ctx, replyEphemeral(commandTo(ctx), statusMessage(errorStatus(text))));
}

interface Bound {
  store: AchievementStore;
  applicationId: string;
}

async function ready(ctx: Ctx, deps: AchievementsDeps, what: string): Promise<Bound | null> {
  if (!ctx.config.enabled) {
    await refuse(ctx, ACHIEVEMENTS_OFF);
    return null;
  }

  const applicationId = ctx.applicationId ?? deps.applicationId;
  if (deps.store && applicationId) return { store: deps.store, applicationId };

  const unbound = [...(deps.store ? [] : ['store']), ...(applicationId ? [] : ['applicationId'])];
  ctx.logger.error(describeUnbound(what, unbound), { guildId: ctx.guildId, moduleId: MODULE_ID });
  await refuse(ctx, deps.store ? NO_APPLICATION : STORE_UNBOUND);
  return null;
}

export async function enabledDependencies(
  deps: AchievementsDeps,
  guildId: string,
  achievements: readonly Achievement[],
): Promise<DependencyModule[]> {
  const availability = deps.availability;
  if (!availability) return [...DEPENDENCY_MODULES];

  const needed = DEPENDENCY_MODULES.filter((module) =>
    achievements.some((achievement) => dependenciesOf(achievement).includes(module)),
  );

  const on = await Promise.all(
    needed.map(async (module) => {
      try {
        return await availability.isEnabled(guildId, module);
      } catch {
        return true;
      }
    }),
  );

  return needed.filter((_, index) => on[index]);
}

const LEDGER: ReadonlySet<string> = new Set(LEDGER_METRICS);

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => {
    loaded ??= load();
    return loaded;
  };
}

export interface LiveState {
  level(): Promise<number>;
  membershipDays(): Promise<number>;
  earned(): number;
  holds(requirement: Requirement): boolean;
}

export function liveState(
  store: AchievementStore,
  deps: AchievementsDeps,
  ctx: Viewing,
  userId: string,
  unlocks: readonly UnlockRow[],
  now: number,
): LiveState {
  const guildId = ctx.guildId;
  const earned = new Set(unlocks.map((row) => row.achievementId));
  for (const collector of routingOf(ctx.config).collectors) earned.delete(collector);

  return {
    level: memo(async () => {
      if (!deps.levelOf) return 0;
      try {
        return (await deps.levelOf(guildId, userId)) ?? 0;
      } catch (error) {
        ctx.logger.warn(
          `achievements could not read ${userId}’s level for a progress view: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { guildId, moduleId: MODULE_ID },
        );
        return 0;
      }
    }),

    membershipDays: memo(async () => {
      const facts = await store.facts(guildId, userId);
      if (!facts || facts.joinedAt === null || facts.leftAt !== null) return 0;
      return Math.max(0, Math.floor((now - facts.joinedAt) / DAY_MS));
    }),

    earned: () => earned.size,

    holds: (requirement) => {
      const least = tierRank(requirement.tierId ?? 'single');
      return unlocks.some(
        (row) => row.achievementId === requirement.achievementId && tierRank(row.tierId) >= least,
      );
    },
  };
}

async function stateValue(requirement: Requirement, live: LiveState): Promise<number> {
  switch (triggerOf(requirement.trigger).metric) {
    case 'level':
      return live.level();
    case 'membership_days':
      return live.membershipDays();
    case 'achievements_earned':
      return live.earned();
    case 'achievement_tier':
      return live.holds(requirement) ? 1 : 0;
    default:
      return 0;
  }
}

export async function valuesOf(
  achievement: Achievement,
  state: MemberAchievementState | undefined,
  live: LiveState,
): Promise<Record<string, number>> {
  const values: Record<string, number> = {};

  for (const requirement of achievement.requirements) {
    // A stored state value is a display copy the engine only refreshes when it evaluates a member.
    if (!LEDGER.has(triggerOf(requirement.trigger).metric)) {
      values[requirement.id] = Math.max(0, Math.floor(await stateValue(requirement, live)));
      continue;
    }

    values[requirement.id] = state
      ? requirementValue(state, requirement.id, requirement.version)
      : 0;
  }

  return values;
}

const ENTRY_STATES: Readonly<Record<DisplayStatus, ListEntry['state'] | null>> = {
  draft: null,
  scheduled: null,
  active: 'active',
  paused: 'paused',
  expired: 'expired',
  archived: 'archived',
};

function counting(status: DisplayStatus): boolean {
  return status === 'active' || status === 'expired' || status === 'paused';
}

export async function loadEntries(
  store: AchievementStore,
  deps: AchievementsDeps,
  ctx: Viewing,
  userId: string,
  now: number,
): Promise<ListEntry[]> {
  const { config, guildId } = ctx;
  const listed = config.achievements.filter((achievement) => achievement.status !== 'draft');

  const [states, unlocks, enabledModules] = await Promise.all([
    store.memberStates(
      guildId,
      userId,
      listed.map((achievement) => achievement.id),
    ),
    store.unlocksOf(guildId, userId),
    enabledDependencies(deps, guildId, listed),
  ]);

  const live = liveState(store, deps, ctx, userId, unlocks, now);
  const byId = new Map(states.map((state) => [state.achievementId, state]));
  const entries: ListEntry[] = [];

  for (const achievement of listed) {
    const state = byId.get(achievement.id);
    const held = currentTierIds(achievement, state?.unlocked ?? []);
    const top = held.at(-1) ?? null;
    const shown = displayStatus(achievement, { now, moduleEnabled: true, enabledModules }).status;

    if (top === null && shown !== 'active' && shown !== 'expired') continue;

    const next = counting(shown)
      ? nextTier(achievement, await valuesOf(achievement, state, live), held)
      : null;

    entries.push({
      achievementId: achievement.id,
      name: achievement.name,
      kind: achievement.kind,
      state: ENTRY_STATES[shown] ?? 'active',
      held: top,
      earnedAt:
        top === null
          ? null
          : (unlocks.find((row) => row.achievementId === achievement.id && row.tierId === top)
              ?.unlockedAt ?? null),
      next: next && {
        tier: next.tier,
        parts: next.requirements.map((requirement) => ({
          trigger: requirement.trigger,
          current: requirement.current,
          target: requirement.target,
        })),
      },
    });
  }

  const configured = new Set(config.achievements.map((achievement) => achievement.id));
  const retired = new Map<string, UnlockRow>();

  for (const row of unlocks) {
    if (configured.has(row.achievementId)) continue;
    const best = retired.get(row.achievementId);
    if (!best || tierRank(row.tierId) > tierRank(best.tierId)) retired.set(row.achievementId, row);
  }

  for (const row of retired.values()) {
    entries.push({
      achievementId: row.achievementId,
      name: row.definition.name,
      kind: row.definition.kind,
      state: 'retired',
      held: row.tierId,
      earnedAt: row.unlockedAt,
      next: null,
    });
  }

  return entries;
}

function retiredRows(
  config: AchievementsConfig,
  unlocks: readonly UnlockRow[],
  raw: string,
): UnlockRow[] {
  const wanted = raw.trim();
  const lowered = wanted.toLowerCase();
  const configured = new Set(config.achievements.map((achievement) => achievement.id));
  const candidates = unlocks.filter((row) => !configured.has(row.achievementId));

  const match =
    candidates.find((row) => row.achievementId === wanted) ??
    candidates.find((row) => row.definition.name.toLowerCase() === lowered);

  return match ? candidates.filter((row) => row.achievementId === match.achievementId) : [];
}

export function achievementsListCommand(deps: AchievementsDeps): Command {
  return {
    name: LIST_COMMAND,
    description: 'Show a member’s achievement badges and their progress towards the rest.',

    data: new SlashCommandBuilder()
      .setName(LIST_COMMAND)
      .setDescription('Show a member’s achievement badges and their progress towards the rest.')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((option) =>
        option.setName('user').setDescription('Whose achievements to show. Defaults to you.'),
      )
      .toJSON(),

    reply: { default: 'public', toggleable: [''] },

    async handler(ctx) {
      const bound = await ready(ctx, deps, '/achievements');
      if (!bound) return;

      const ephemeral = ctx.privateReply ?? false;
      const subjectId = ctx.options.getUserId('user') ?? ctx.userId;
      const to = commandTo(ctx);
      if (!acknowledged(await answer(ctx, defer(to, { ephemeral })))) return;

      const entries = await loadEntries(bound.store, deps, ctx, subjectId, clockOf(deps)());
      const view = listPage({
        subjectId,
        invokerId: ctx.userId,
        entries,
        page: 1,
        timeZone: ctx.config.timezone,
      });

      await answer(
        ctx,
        followUp(
          { ...to, applicationId: bound.applicationId },
          { ...v2Message(view.components), ephemeral },
        ),
      );
    },
  };
}

async function viewAchievement(ctx: Ctx, deps: AchievementsDeps): Promise<void> {
  const bound = await ready(ctx, deps, '/achievement view');
  if (!bound) return;

  const raw = ctx.options.getString(ACHIEVEMENT_OPTION) ?? '';
  const subjectId = ctx.options.getUserId('user') ?? ctx.userId;
  const found = findAchievement(ctx.config, raw);
  if (found?.status === 'draft') return refuse(ctx, notFound(raw));

  // A followup inherits the visibility of the defer: deferring publicly would post the refusal.
  const ephemeral = !found || (ctx.privateReply ?? false);
  const to = commandTo(ctx);
  if (!acknowledged(await answer(ctx, defer(to, { ephemeral })))) return;

  const send = (message: InteractionMessage, privately: boolean) =>
    answer(
      ctx,
      followUp({ ...to, applicationId: bound.applicationId }, { ...message, ephemeral: privately }),
    );
  const { store } = bound;
  const timeZone = ctx.config.timezone;

  if (!found) {
    const rows = retiredRows(ctx.config, await store.unlocksOf(ctx.guildId, subjectId), raw);
    const first = rows[0];
    if (!first) {
      await send(statusMessage(errorStatus(notFound(raw))), true);
      return;
    }

    await send(
      v2Message(
        retiredComponents({
          name: first.definition.name,
          kind: first.definition.kind,
          subjectId,
          earned: earnedTiers(rows),
          timeZone,
        }),
      ),
      true,
    );
    return;
  }

  const now = clockOf(deps)();
  const [[state], unlocks, enabledModules] = await Promise.all([
    store.memberStates(ctx.guildId, subjectId, [found.id]),
    store.unlocksOf(ctx.guildId, subjectId),
    enabledDependencies(deps, ctx.guildId, [found]),
  ]);

  const live = liveState(store, deps, ctx, subjectId, unlocks, now);
  const earned = earnedTiers(
    unlocks.filter((row) => row.achievementId === found.id),
    found,
  );

  const png = await renderBadgePng(
    deps,
    ctx.guildId,
    found,
    displayTier(found, earned.keys()),
    BADGE_BUDGET_MS,
  );

  const components = detailComponents({
    achievement: found,
    subjectId,
    status: displayStatus(found, { now, moduleEnabled: true, enabledModules }),
    values: await valuesOf(found, state, live),
    earned,
    badge: png !== null,
    timeZone,
    nameOf: (id) => ctx.config.achievements.find((achievement) => achievement.id === id)?.name,
  });

  await send(
    v2Message(
      components,
      png
        ? [{ filename: BADGE_FILENAME, contentType: 'image/png', data: new Uint8Array(png) }]
        : [],
    ),
    ephemeral,
  );
}

async function resetAchievements(ctx: Ctx, deps: AchievementsDeps): Promise<void> {
  if (!hasWithAdmin(ctx.actorPermissions ?? 0n, Permissions.ManageGuild)) {
    return refuse(ctx, needsManageServer(labelOf(ctx, ACHIEVEMENT_COMMAND, 'view')));
  }

  const bound = await ready(ctx, deps, '/achievement reset');
  if (!bound) return;

  const memberId = ctx.options.getUserId('member');
  if (!memberId) return refuse(ctx, 'Choose the member whose achievements to reset.');

  const raw = ctx.options.getString(ACHIEVEMENT_OPTION)?.trim() ?? '';
  const achievement = raw === '' ? null : findAchievement(ctx.config, raw);
  if (raw !== '' && !achievement) {
    return refuse(
      ctx,
      `${notFound(raw)} To clear badges of an achievement that was deleted, leave the ` +
        'achievement option empty to reset all of them.',
    );
  }

  const draftId = draftIdOf(ctx.interaction.id);
  const draft: ResetDraft | null =
    draftId === null
      ? null
      : {
          draftId,
          memberId,
          achievementId: achievement?.id ?? null,
          rewardsAgain: ctx.options.getBoolean('rewards_again') ?? false,
        };
  const prompt = draft && resetPrompt(draft, 1, achievement?.name ?? null);
  if (!prompt) return refuse(ctx, RESET_UNSTARTED);

  const to = commandTo(ctx);
  if (!acknowledged(await answer(ctx, deferEphemeral(to)))) return;

  await answer(
    ctx,
    followUp({ ...to, applicationId: bound.applicationId }, { ...prompt, ephemeral: true }),
  );
}

export function achievementCommand(deps: AchievementsDeps): Command {
  return {
    name: ACHIEVEMENT_COMMAND,
    description: 'Look at one achievement, or reset a member’s achievements.',

    data: new SlashCommandBuilder()
      .setName(ACHIEVEMENT_COMMAND)
      .setDescription('Look at one achievement, or reset a member’s achievements.')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription(
            'Show what an achievement takes, its tiers and rewards, and a member’s progress.',
          )
          .addStringOption((option) =>
            option
              .setName(ACHIEVEMENT_OPTION)
              .setDescription('The achievement to show.')
              .setRequired(true)
              .setAutocomplete(true)
              .setMaxLength(100),
          )
          .addUserOption((option) =>
            option.setName('user').setDescription('Whose progress to show. Defaults to you.'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('reset')
          .setDescription('Reset a member’s progress and badges. Needs Manage Server.')
          .addUserOption((option) =>
            option.setName('member').setDescription('The member to reset.').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName(ACHIEVEMENT_OPTION)
              .setDescription('Which achievement. Leave empty to reset all of them.')
              .setAutocomplete(true)
              .setMaxLength(100),
          )
          .addBooleanOption((option) =>
            option
              .setName('rewards_again')
              .setDescription('Let them earn the rewards again. You’ll confirm this separately.'),
          ),
      )
      .toJSON(),

    reply: {
      default: (_config, path) => (path === 'view' ? 'public' : 'private'),
      toggleable: ['view'],
    },

    async handler(ctx) {
      switch (ctx.options.getSubcommand()) {
        case 'view':
          return viewAchievement(ctx, deps);
        case 'reset':
          return resetAchievements(ctx, deps);
        default:
          return refuse(ctx, UNKNOWN_SUBCOMMAND);
      }
    },
  };
}

export function achievementsCommands(deps: AchievementsDeps): Command[] {
  return [achievementsListCommand(deps), achievementCommand(deps)];
}

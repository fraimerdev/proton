import {
  type ComponentInteraction,
  type EventListener,
  type EventType,
  errorStatus,
  followUp,
  hasWithAdmin,
  type InteractionBase,
  interactionRef,
  labelOf,
  type ModuleContext,
  Permissions,
  type ProtonEvent,
  parseCustomId,
  type RespondTo,
  readAutocompleteInteraction,
  readComponentInteraction,
  readMemberPermissions,
  replyEphemeral,
  respondAutocomplete,
  successStatus,
  updateMessage,
} from '@proton/core';
import {
  ACHIEVEMENT_COMMAND,
  ACHIEVEMENT_OPTION,
  ACHIEVEMENTS_OFF,
  achievementChoices,
  LIST_COMMAND,
  listPage,
  NO_APPLICATION,
  needsManageServer,
  notYours,
  PAGE_ACTION,
  RESET_CANCELLED,
  RESET_SETTLED,
  resetDone,
  resetExpired,
  resetPrompt,
  STORE_UNBOUND,
  statusMessage,
  textMessage,
  UNKNOWN_CONTROL,
  v2Message,
  WORKING,
} from './command-views.ts';
import { acknowledged, answer, loadEntries } from './commands.ts';
import { type AchievementsConfig, MODULE_ID } from './config.ts';
import { type AchievementsDeps, clockOf, describeUnbound } from './deps.ts';
import {
  draftExpired,
  interactionIdOf,
  RESET_ACTION,
  RESET_CANCEL_ACTION,
  readCancelArgs,
  readResetArgs,
  releaseDraft,
  spendDraft,
} from './drafts.ts';
import type { UnlockRow } from './store.ts';

type Ctx = ModuleContext<AchievementsConfig>;

export const ACHIEVEMENTS_INTERACTION_TYPES: EventType[] = [
  'interaction.component',
  'interaction.autocomplete',
];

const SNOWFLAKE = /^\d{17,20}$/;
const PAGE_NUMBER = /^\d{1,6}$/;

interface Press {
  event: ProtonEvent;
  ctx: Ctx;
  deps: AchievementsDeps;
  facts: ComponentInteraction;
  args: readonly string[];
  to: RespondTo;
}

function respondTo(ctx: Ctx, facts: InteractionBase, event: ProtonEvent): RespondTo {
  return {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: facts.userId,
    interaction: interactionRef(facts),
    idempotencyKey: `${MODULE_ID}:${event.id}`,
  };
}

async function refuse(ctx: Ctx, to: RespondTo, text: string): Promise<void> {
  await answer(ctx, replyEphemeral(to, statusMessage(errorStatus(text))));
}

function unbound(ctx: Ctx, what: string, ports: string[]): void {
  ctx.logger.error(describeUnbound(what, ports), { guildId: ctx.guildId, moduleId: MODULE_ID });
}

async function turnPage({ ctx, deps, facts, args, to }: Press): Promise<void> {
  const [subjectId, rawPage, invokerId] = args;
  if (
    subjectId === undefined ||
    !SNOWFLAKE.test(subjectId) ||
    invokerId === undefined ||
    !SNOWFLAKE.test(invokerId) ||
    rawPage === undefined ||
    !PAGE_NUMBER.test(rawPage)
  ) {
    return refuse(ctx, to, UNKNOWN_CONTROL);
  }

  if (facts.userId !== invokerId) return refuse(ctx, to, notYours(labelOf(ctx, LIST_COMMAND)));

  const store = deps.store;
  if (!store) {
    unbound(ctx, 'turning /achievements pages', ['store']);
    return refuse(ctx, to, STORE_UNBOUND);
  }

  const entries = await loadEntries(store, deps, ctx, subjectId, clockOf(deps)());
  const view = listPage({
    subjectId,
    invokerId,
    entries,
    page: Number(rawPage),
    timeZone: ctx.config.timezone,
  });

  await answer(ctx, updateMessage(to, v2Message(view.components)));
}

function nameIn(config: AchievementsConfig, achievementId: string | null): string | null {
  if (achievementId === null) return null;
  return (
    config.achievements.find((achievement) => achievement.id === achievementId)?.name ??
    achievementId
  );
}

function everyAchievementId(config: AchievementsConfig, held: readonly UnlockRow[]): string[] {
  return [
    ...new Set([
      ...config.achievements.map((achievement) => achievement.id),
      ...held.map((row) => row.achievementId),
    ]),
  ];
}

async function confirmReset({ event, ctx, deps, facts, args, to }: Press): Promise<void> {
  const read = readResetArgs(args);
  if (!read) return refuse(ctx, to, UNKNOWN_CONTROL);

  if (!hasWithAdmin(readMemberPermissions(event), Permissions.ManageGuild)) {
    return refuse(ctx, to, needsManageServer(labelOf(ctx, ACHIEVEMENT_COMMAND, 'view')));
  }

  const { draft, step } = read;
  const now = clockOf(deps)();

  if (draftExpired(draft.draftId, now)) {
    const expired = resetExpired(labelOf(ctx, ACHIEVEMENT_COMMAND, 'reset'));
    await answer(ctx, updateMessage(to, statusMessage(errorStatus(expired))));
    return;
  }

  const store = deps.store;
  const applicationId = facts.applicationId ?? deps.applicationId;
  if (!store || !applicationId) {
    unbound(ctx, '/achievement reset', [
      ...(store ? [] : ['store']),
      ...(applicationId ? [] : ['applicationId']),
    ]);
    return refuse(ctx, to, store ? NO_APPLICATION : STORE_UNBOUND);
  }

  const limits = deps.limits;
  if (
    limits &&
    !(await spendDraft(limits, ctx.guildId, draft.draftId, step, facts.interactionId))
  ) {
    return refuse(ctx, to, RESET_SETTLED);
  }

  // Give the claim back when Discord never heard us, or every later press is refused as settled.
  const unspend = async (): Promise<void> => {
    if (limits) {
      await releaseDraft(limits, ctx.guildId, draft.draftId, step, facts.interactionId);
    }
  };

  const name = nameIn(ctx.config, draft.achievementId);

  if (step === 1 && draft.rewardsAgain) {
    const prompt = resetPrompt(draft, 2, name);
    if (!prompt) return refuse(ctx, to, UNKNOWN_CONTROL);

    if (!acknowledged(await answer(ctx, updateMessage(to, prompt)))) await unspend();
    return;
  }

  if (!acknowledged(await answer(ctx, updateMessage(to, textMessage(WORKING))))) {
    await unspend();
    return;
  }

  const achievementIds =
    draft.achievementId === null
      ? everyAchievementId(ctx.config, await store.unlocksOf(ctx.guildId, draft.memberId))
      : [draft.achievementId];

  await store.resetMember({
    guildId: ctx.guildId,
    achievementIds,
    userId: draft.memberId,
    allowRewardsAgain: draft.rewardsAgain,
    actorId: facts.userId,
    at: now,
    audit: {
      id: `achievements.reset:${ctx.guildId}:${interactionIdOf(draft.draftId) ?? draft.draftId}`,
      guildId: ctx.guildId,
      actorId: facts.userId,
      source: 'command',
      action: 'module.achievements.reset',
      before: null,
      after: {
        scope: draft.achievementId === null ? 'member_all' : 'member_achievement',
        userId: draft.memberId,
        achievementIds,
        allowRewardsAgain: draft.rewardsAgain,
      },
    },
  });

  ctx.logger.info(`/achievement reset for ${draft.memberId}`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: facts.userId,
    achievementIds,
    allowRewardsAgain: draft.rewardsAgain,
  });

  await answer(
    ctx,
    followUp(
      { ...to, applicationId },
      { ...statusMessage(successStatus(resetDone(draft, name))), ephemeral: true },
    ),
  );
}

async function cancelReset({ ctx, deps, facts, args, to }: Press): Promise<void> {
  const read = readCancelArgs(args);
  if (!read) return refuse(ctx, to, UNKNOWN_CONTROL);

  const limits = deps.limits;
  const spentBy = `cancel:${facts.interactionId}`;
  if (limits && !(await spendDraft(limits, ctx.guildId, read.draftId, read.step, spentBy))) {
    return refuse(ctx, to, RESET_SETTLED);
  }

  if (!acknowledged(await answer(ctx, updateMessage(to, textMessage(RESET_CANCELLED)))) && limits) {
    await releaseDraft(limits, ctx.guildId, read.draftId, read.step, spentBy);
  }
}

const ACTIONS: Readonly<Record<string, (press: Press) => Promise<void>>> = {
  [PAGE_ACTION]: turnPage,
  [RESET_ACTION]: confirmReset,
  [RESET_CANCEL_ACTION]: cancelReset,
};

export async function routeAchievementsComponent(
  event: ProtonEvent,
  ctx: Ctx,
  deps: AchievementsDeps,
): Promise<void> {
  const facts = readComponentInteraction(event);
  if (!facts) return;

  const parsed = parseCustomId(facts.customId);
  if (parsed?.moduleId !== MODULE_ID) return;

  const to = respondTo(ctx, facts, event);
  if (!ctx.config.enabled) return refuse(ctx, to, ACHIEVEMENTS_OFF);

  const handler = Object.hasOwn(ACTIONS, parsed.action) ? ACTIONS[parsed.action] : undefined;
  if (!handler) {
    ctx.logger.warn(`achievements has no handler for the control '${parsed.action}'`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return refuse(ctx, to, UNKNOWN_CONTROL);
  }

  await handler({ event, ctx, deps, facts, args: parsed.args, to });
}

function optionValue(
  options: ReadonlyArray<{ name: string; value?: string | number | boolean }>,
  name: string,
): string | null {
  const value = options.find((option) => option.name === name)?.value;
  return typeof value === 'string' && SNOWFLAKE.test(value) ? value : null;
}

export async function answerAchievementAutocomplete(
  event: ProtonEvent,
  ctx: Ctx,
  deps: AchievementsDeps,
): Promise<void> {
  const facts = readAutocompleteInteraction(event);
  if (!facts || facts.commandName !== ACHIEVEMENT_COMMAND) return;

  const focused = facts.focused;
  if (focused?.name !== ACHIEVEMENT_OPTION) return;

  const scope = facts.subcommand === 'reset' ? 'reset' : 'view';
  let held: UnlockRow[] = [];

  if (ctx.config.enabled && scope === 'view' && deps.store) {
    const subjectId = optionValue(facts.options, 'user') ?? facts.userId;
    try {
      held = await deps.store.unlocksOf(ctx.guildId, subjectId);
    } catch (error) {
      ctx.logger.warn(
        `achievements could not read earned badges for suggestions: ${String(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
    }
  }

  // Answered even when empty or off: without an answer the member watches a spinner until it expires.
  await answer(
    ctx,
    respondAutocomplete(
      respondTo(ctx, facts, event),
      ctx.config.enabled ? achievementChoices(ctx.config, held, focused.value, scope) : [],
    ),
  );
}

export function createAchievementsInteractionListener(
  deps: AchievementsDeps,
): EventListener<AchievementsConfig> {
  return {
    types: ACHIEVEMENTS_INTERACTION_TYPES,
    handler: (event, ctx) =>
      event.type === 'interaction.autocomplete'
        ? answerAchievementAutocomplete(event, ctx, deps)
        : routeAchievementsComponent(event, ctx, deps),
  };
}

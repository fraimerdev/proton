import {
  type AvailableProvider,
  encodeCustomId,
  type ModuleAvailability,
  newId,
  type ProviderRegistry,
  parseCustomId,
} from '@proton/core';
import {
  MODULE_ID,
  MULTIPLIERS_MAX,
  parseGiveawayDuration,
  plural,
  REQUIREMENTS_MAX,
  WINNER_COUNT_MAX,
} from '../config.ts';
import { renderCard } from '../embed.ts';
import { viewOf } from '../message.ts';
import { type Ctx, postGiveaway, sentMessageId, succeeded } from '../perform.ts';
import { END_JOB_ID, START_JOB_ID } from '../schedule.ts';
import type { GiveawayStore } from '../store.ts';
import { descriptorsToModal, readDescriptorValues } from './modal.ts';
import {
  BASICS_MODAL,
  BUILDER_ADD_MULTIPLIER,
  BUILDER_ADD_REQUIREMENT,
  BUILDER_BASICS,
  BUILDER_CANCEL,
  BUILDER_LOGIC,
  BUILDER_PREVIEW,
  BUILDER_REMOVE,
  BUILDER_START,
  DESCRIPTION_FIELD,
  DURATION_FIELD,
  ITEM_MODAL,
  TITLE_FIELD,
  WINNERS_FIELD,
} from './screens.ts';
import {
  BUILDER_STEPS,
  type BuilderStep,
  type DraftStore,
  draftKey,
  type GiveawayDraft,
} from './state.ts';
import { applyStepModal, STEP_MODAL, stepModal } from './step-modals.ts';
import {
  BUILDER_CATEGORY,
  BUILDER_EDIT_STEP,
  BUILDER_ITEM_EDIT,
  BUILDER_ITEM_REMOVE,
  BUILDER_MODE,
  BUILDER_NAV,
  BUILDER_PICK,
  stepScreen,
} from './steps.ts';

export const BUILDER_ACTIONS = [
  BUILDER_BASICS,
  BUILDER_ADD_REQUIREMENT,
  BUILDER_ADD_MULTIPLIER,
  BUILDER_REMOVE,
  BUILDER_LOGIC,
  BUILDER_PREVIEW,
  BUILDER_START,
  BUILDER_CANCEL,
  BUILDER_NAV,
  BUILDER_EDIT_STEP,
  BUILDER_PICK,
  BUILDER_ITEM_EDIT,
  BUILDER_ITEM_REMOVE,
  BUILDER_MODE,
  BUILDER_CATEGORY,
] as const;

export const BUILDER_MODAL_ACTIONS = [BASICS_MODAL, ITEM_MODAL, STEP_MODAL] as const;

export function isBuilderAction(action: string): boolean {
  return (
    (BUILDER_ACTIONS as readonly string[]).includes(action) ||
    (BUILDER_MODAL_ACTIONS as readonly string[]).includes(action)
  );
}

export interface BuilderRoute {
  action: string;
  args: string[];
}

// The action segment carries its own colon ('b:item'), which encodeCustomId escapes and
// parseCustomId gives back intact — so the kind and provider id stay separate args.
export function builderRouteOf(customId: string): BuilderRoute | null {
  const parsed = parseCustomId(customId);
  if (!parsed || parsed.moduleId !== MODULE_ID || !isBuilderAction(parsed.action)) return null;

  return { action: parsed.action, args: parsed.args };
}

export interface BuilderDeps {
  store: GiveawayStore;
  providers: ProviderRegistry;
  drafts: DraftStore;
  availability: ModuleAvailability;
  now?: () => number;
}

export type BuilderReply =
  | { kind: 'update'; content: string; components: Record<string, unknown>[] }
  | { kind: 'modal'; modal: import('@proton/core').Modal }
  | { kind: 'message'; content: string }
  | { kind: 'preview'; components: Record<string, unknown>[] }
  | { kind: 'ignored' };

async function screenFor(
  deps: BuilderDeps,
  draft: GiveawayDraft,
  category: string | null = null,
): Promise<BuilderReply> {
  const available = await deps.providers.listAvailable(draft.guildId, deps.availability);
  const screen = stepScreen(draft, deps.providers, available, category);

  return screen.ok
    ? { kind: 'update', content: screen.content, components: screen.components }
    : { kind: 'message', content: screen.humanReason };
}

function readItemArgs(args: readonly string[]): { kind: 'r' | 'm'; providerId: string } | null {
  const kind = args[0];
  const providerId = args[1];

  if ((kind !== 'r' && kind !== 'm') || providerId === undefined || providerId.length === 0) {
    return null;
  }

  return { kind, providerId };
}

function pickerFor(
  available: readonly AvailableProvider[],
  providerId: string,
): AvailableProvider | undefined {
  return available.find((provider) => provider.id === providerId);
}

export interface ComponentInput {
  action: string;

  /** Segments after the action in the custom id — the kind a picker or item select belongs to. */
  args: string[];

  guildId: string;
  channelId: string;
  userId: string;
  values: string[];
}

export async function handleBuilderComponent(
  deps: BuilderDeps,
  input: ComponentInput,
): Promise<BuilderReply> {
  const key = draftKey(input.guildId, input.userId);
  const draft = await deps.drafts.get(key);

  if (!draft) {
    return {
      kind: 'message',
      content:
        'That builder has expired or belongs to somebody else. Start a new one with ' +
        '`/giveaway create`.',
    };
  }

  switch (input.action) {
    case BUILDER_NAV: {
      const step = input.values[0];
      if (!isStep(step)) return { kind: 'ignored' };

      draft.step = step;
      draft.updatedAt = deps.now?.() ?? Date.now();
      await deps.drafts.put(key, draft);

      return screenFor(deps, draft);
    }

    // The category select narrows the picker without touching the draft, so it is not persisted —
    // a category is a view of the list, not a decision about the giveaway.
    case BUILDER_CATEGORY:
      return screenFor(deps, draft, input.values[0] ?? null);

    case BUILDER_EDIT_STEP: {
      const step = input.args[0] ?? draft.step;
      if (!isStep(step)) return { kind: 'ignored' };

      const built = stepModal(step, draft);
      return built.ok
        ? { kind: 'modal', modal: built.modal }
        : { kind: 'message', content: built.humanReason };
    }

    case BUILDER_PICK:
      return pickProvider(deps, key, draft, input.args[0] === 'm' ? 'm' : 'r', input.values[0]);

    case BUILDER_ITEM_EDIT:
      return editItem(deps, draft, input.args[0] === 'm' ? 'm' : 'r', input.values[0]);

    case BUILDER_ITEM_REMOVE: {
      const kind = input.args[0] === 'm' ? 'm' : 'r';
      const index = Number(input.values[0]);
      if (!Number.isInteger(index)) return { kind: 'ignored' };

      if (kind === 'r') draft.requirements.splice(index, 1);
      else draft.multipliers.splice(index, 1);

      draft.updatedAt = deps.now?.() ?? Date.now();
      await deps.drafts.put(key, draft);

      return screenFor(deps, draft);
    }

    case BUILDER_MODE: {
      const [rawIndex, mode] = (input.values[0] ?? '').split(':');
      const index = Number(rawIndex);
      const item = draft.multipliers[index];

      if (!item || (mode !== 'add' && mode !== 'multiply' && mode !== 'max')) {
        return { kind: 'ignored' };
      }

      item.mode = mode;
      draft.updatedAt = deps.now?.() ?? Date.now();
      await deps.drafts.put(key, draft);

      return screenFor(deps, draft);
    }

    case BUILDER_BASICS: {
      const built = stepModal('basics', draft);
      return built.ok
        ? { kind: 'modal', modal: built.modal }
        : { kind: 'message', content: built.humanReason };
    }

    case BUILDER_LOGIC: {
      draft.requirementLogic = draft.requirementLogic === 'all' ? 'any' : 'all';
      draft.updatedAt = deps.now?.() ?? Date.now();
      await deps.drafts.put(key, draft);

      return screenFor(deps, draft);
    }

    case BUILDER_ADD_REQUIREMENT:
    case BUILDER_ADD_MULTIPLIER: {
      const providerId = input.values[0];
      if (providerId === undefined) return { kind: 'ignored' };

      const available = await deps.providers.listAvailable(draft.guildId, deps.availability);
      const provider = pickerFor(available, providerId);

      if (!provider) {
        return {
          kind: 'message',
          content: `That option is no longer available — the module that provides it was switched off.`,
        };
      }

      const kind = input.action === BUILDER_ADD_REQUIREMENT ? 'r' : 'm';

      // A provider with no settings is fully configured by picking it, and Discord refuses a modal
      // with no components — so it is added straight away instead.
      if (provider.builder.length === 0) {
        return addItem(deps, key, draft, kind, provider.id, {});
      }

      const encoded = encodeCustomId(MODULE_ID, ITEM_MODAL, kind, provider.id);
      if (!encoded.ok) return { kind: 'message', content: encoded.humanReason };

      const built = descriptorsToModal(encoded.customId, provider.label, provider.builder);

      return built.ok
        ? { kind: 'modal', modal: built.modal }
        : { kind: 'message', content: built.humanReason };
    }

    case BUILDER_REMOVE: {
      const chosen = input.values[0];
      const [kind, rawIndex] = (chosen ?? '').split(':');
      const index = Number(rawIndex);

      if ((kind !== 'r' && kind !== 'm') || !Number.isInteger(index)) return { kind: 'ignored' };

      if (kind === 'r') draft.requirements.splice(index, 1);
      else draft.multipliers.splice(index, 1);

      draft.updatedAt = deps.now?.() ?? Date.now();
      await deps.drafts.put(key, draft);

      return screenFor(deps, draft);
    }

    case BUILDER_PREVIEW: {
      const preview = previewComponents(deps, draft);
      return preview.ok
        ? { kind: 'preview', components: preview.components }
        : { kind: 'message', content: preview.humanReason };
    }

    case BUILDER_CANCEL: {
      await deps.drafts.delete(key);
      return { kind: 'message', content: 'Builder closed. Nothing was posted.' };
    }

    default:
      return { kind: 'ignored' };
  }
}

function previewComponents(
  deps: BuilderDeps,
  draft: GiveawayDraft,
): { ok: true; components: Record<string, unknown>[] } | { ok: false; humanReason: string } {
  const now = deps.now?.() ?? Date.now();

  const rendered = renderCard(draft.startsInMs === null ? 'active' : 'scheduled', {
    view: viewOf({
      id: 'preview',
      guildId: draft.guildId,
      channelId: draft.channelId,
      messageId: null,
      hostId: draft.hostId,
      title: draft.title.length > 0 ? draft.title : 'Untitled giveaway',
      description: draft.description,
      bannerUrl: draft.bannerUrl,
      color: draft.color,
      emoji: draft.emoji,
      buttonStyle: draft.buttonStyle,
      winnerCount: draft.winnerCount,
      requirementLogic: draft.requirementLogic,
      requirementTree: null,
      prizes: null,
      rewardRoleId: draft.rewardRoleId,
      recurrenceConfig: null,
      recurrenceLeft: null,
      maxEntriesPerUser: draft.maxEntriesPerUser,
      verifyOn: draft.verifyOn,
      shortCode: null,
      entryMethod: 'button',
      pausedAt: null,
      pausedBy: null,
      pauseReason: null,
      pausedMs: 0,
      startsAt: draft.startsInMs === null ? null : new Date(now + draft.startsInMs),
      endsAt: new Date(now + (draft.startsInMs ?? 0) + draft.durationMs),
      endedAt: null,
      status: draft.startsInMs === null ? 'running' : 'scheduled',
      drawingStartedAt: null,
      claimWindowSeconds: draft.claimWindowSeconds,
      dmWinners: draft.dmWinners,
      winMessage: draft.winMessage,
      templateId: null,
      recurrence: null,
      createdBy: draft.hostId,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    }),
    entrantCount: 0,
    requirements: describeDraftRequirements(deps, draft),
    multipliers: describeDraftMultipliers(deps, draft),
    accentColor: 0x5865f2,
  });

  return rendered.ok
    ? { ok: true, components: rendered.components }
    : { ok: false, humanReason: rendered.humanReason };
}

function describeDraftRequirements(deps: BuilderDeps, draft: GiveawayDraft): string[] {
  const lines: string[] = [];

  for (const item of draft.requirements) {
    const provider = deps.providers.condition(item.providerId);
    if (provider) lines.push(provider.describe(item.config, 'en'));
  }

  return lines;
}

function describeDraftMultipliers(deps: BuilderDeps, draft: GiveawayDraft): string[] {
  const lines: string[] = [];

  for (const item of draft.multipliers) {
    const provider = deps.providers.multiplier(item.providerId);
    if (provider) lines.push(provider.describe(item.config, 'en'));
  }

  return lines;
}

function isStep(value: string | undefined): value is BuilderStep {
  return value !== undefined && (BUILDER_STEPS as readonly string[]).includes(value);
}

/** Opens the provider's own modal, or adds it straight away when it has nothing to configure. */
async function pickProvider(
  deps: BuilderDeps,
  key: string,
  draft: GiveawayDraft,
  kind: 'r' | 'm',
  providerId: string | undefined,
): Promise<BuilderReply> {
  if (providerId === undefined || providerId === 'none') return { kind: 'ignored' };

  const cap = kind === 'r' ? REQUIREMENTS_MAX : MULTIPLIERS_MAX;
  const held = kind === 'r' ? draft.requirements.length : draft.multipliers.length;

  // Enforced here, not only in the template schema: without it a host can add rules past the cap
  // in the builder and only discover the limit when saving the giveaway as a template.
  if (held >= cap) {
    return {
      kind: 'message',
      content:
        `A giveaway can hold ${cap} ${kind === 'r' ? 'requirements' : 'bonus-entry rules'}, and ` +
        'this one is full. Remove one before adding another.',
    };
  }

  const available = await deps.providers.listAvailable(draft.guildId, deps.availability);
  const provider = pickerFor(available, providerId);

  if (!provider) {
    return {
      kind: 'message',
      content: 'That option is no longer available — the module that provides it was switched off.',
    };
  }

  // A provider with no settings is fully configured by picking it, and Discord refuses a modal
  // with no components — so it is added straight away instead.
  if (provider.builder.length === 0) {
    return addItem(deps, key, draft, kind, provider.id, {});
  }

  const encoded = encodeCustomId(MODULE_ID, ITEM_MODAL, kind, provider.id);
  if (!encoded.ok) return { kind: 'message', content: encoded.humanReason };

  const built = descriptorsToModal(encoded.customId, provider.label, provider.builder);

  return built.ok
    ? { kind: 'modal', modal: built.modal }
    : { kind: 'message', content: built.humanReason };
}

/**
 * Re-opens a configured rule's own modal, prefilled with what it currently holds. The `current`
 * argument to descriptorsToModal has always existed and was never passed, which is why editing a
 * rule meant deleting it and building it again from scratch.
 */
async function editItem(
  deps: BuilderDeps,
  draft: GiveawayDraft,
  kind: 'r' | 'm',
  rawIndex: string | undefined,
): Promise<BuilderReply> {
  const index = Number(rawIndex);
  const item = kind === 'r' ? draft.requirements[index] : draft.multipliers[index];

  if (!Number.isInteger(index) || !item) return { kind: 'ignored' };

  const provider = deps.providers.get(item.providerId);
  if (!provider) {
    return {
      kind: 'message',
      content: 'That rule is no longer available — the module that provides it was switched off.',
    };
  }

  if (provider.builder.length === 0) {
    return {
      kind: 'message',
      content: `“${provider.label}” has nothing to configure. Remove it if you no longer want it.`,
    };
  }

  const encoded = encodeCustomId(MODULE_ID, ITEM_MODAL, kind, provider.id, String(index));
  if (!encoded.ok) return { kind: 'message', content: encoded.humanReason };

  const built = descriptorsToModal(encoded.customId, provider.label, provider.builder, item.config);

  return built.ok
    ? { kind: 'modal', modal: built.modal }
    : { kind: 'message', content: built.humanReason };
}

async function addItem(
  deps: BuilderDeps,
  key: string,
  draft: GiveawayDraft,
  kind: 'r' | 'm',
  providerId: string,
  config: Record<string, unknown>,
  replaceIndex?: number,
): Promise<BuilderReply> {
  const parsed = deps.providers.parseConfig(providerId, config);
  if (!parsed.ok) return { kind: 'message', content: parsed.humanReason };

  if (kind === 'r') {
    const entry = { providerId, config: parsed.config };
    if (replaceIndex !== undefined && draft.requirements[replaceIndex]) {
      draft.requirements[replaceIndex] = entry;
    } else {
      draft.requirements.push(entry);
    }
  } else {
    // Additive by default. The mode select on the bonus step is where a multiply or a max ladder
    // is chosen, and an edit keeps whatever was already picked.
    const existing = replaceIndex === undefined ? undefined : draft.multipliers[replaceIndex];
    const entry = { providerId, config: parsed.config, mode: existing?.mode ?? 'add' } as const;

    if (existing) draft.multipliers[replaceIndex as number] = entry;
    else draft.multipliers.push(entry);
  }

  draft.updatedAt = deps.now?.() ?? Date.now();
  await deps.drafts.put(key, draft);

  return screenFor(deps, draft);
}

export interface ModalInput {
  action: string;
  args: string[];
  guildId: string;
  userId: string;
  fields: Record<string, string>;
  values: Record<string, string[]>;
}

export async function handleBuilderModal(
  deps: BuilderDeps,
  input: ModalInput,
): Promise<BuilderReply> {
  const key = draftKey(input.guildId, input.userId);
  const draft = await deps.drafts.get(key);

  if (!draft) {
    return {
      kind: 'message',
      content: 'That builder has expired. Start a new one with `/giveaway create`.',
    };
  }

  if (input.action === STEP_MODAL) {
    const step = input.args[0];
    if (!isStep(step)) return { kind: 'ignored' };

    const applied = applyStepModal(step, draft, input.fields);
    if (!applied.ok) return { kind: 'message', content: applied.humanReason };

    draft.updatedAt = deps.now?.() ?? Date.now();
    await deps.drafts.put(key, draft);

    return screenFor(deps, draft);
  }

  if (input.action === BASICS_MODAL) {
    const title = (input.fields[TITLE_FIELD] ?? '').trim();
    if (title.length === 0) {
      return {
        kind: 'message',
        content: 'A giveaway needs a prize. Say what is being given away.',
      };
    }

    const duration = parseGiveawayDuration((input.fields[DURATION_FIELD] ?? '').trim());
    if (!duration.ok) return { kind: 'message', content: duration.humanReason };

    const winners = Number((input.fields[WINNERS_FIELD] ?? '').trim());
    if (!Number.isInteger(winners) || winners < 1 || winners > WINNER_COUNT_MAX) {
      return {
        kind: 'message',
        content:
          `“${input.fields[WINNERS_FIELD]}” is not a number of winners I can use. Give a whole ` +
          `number between 1 and ${WINNER_COUNT_MAX}.`,
      };
    }

    const description = (input.fields[DESCRIPTION_FIELD] ?? '').trim();

    draft.title = title;
    draft.description = description.length > 0 ? description : null;
    draft.durationMs = duration.ms;
    draft.winnerCount = winners;
    draft.updatedAt = deps.now?.() ?? Date.now();

    await deps.drafts.put(key, draft);
    return screenFor(deps, draft);
  }

  if (input.action !== ITEM_MODAL) return { kind: 'ignored' };

  const item = readItemArgs(input.args);
  if (!item) return { kind: 'ignored' };

  const provider = deps.providers.get(item.providerId);
  if (!provider) {
    return {
      kind: 'message',
      content: 'That option is no longer available — the module that provides it was switched off.',
    };
  }

  const read = readDescriptorValues(provider.builder, input.fields, input.values);
  if (!read.ok) return { kind: 'message', content: read.humanReason };

  // A third arg means the modal was opened to edit rule N rather than to add a new one.
  const at = input.args[2] === undefined ? undefined : Number(input.args[2]);

  return addItem(
    deps,
    key,
    draft,
    item.kind,
    provider.id,
    read.config,
    Number.isInteger(at) ? at : undefined,
  );
}

export interface StartResult {
  ok: boolean;
  content: string;
  giveawayId?: string;
  endsAt?: Date;
}

export async function startFromDraft(
  ctx: Ctx,
  deps: BuilderDeps,
  draft: GiveawayDraft,
  idempotencyRoot: string,
): Promise<StartResult> {
  const now = deps.now?.() ?? Date.now();
  const id = newId();

  // A scheduled start shifts both ends: the duration a host chose is how long it runs once it
  // opens, not how long from now until it closes.
  const startsAt = draft.startsInMs === null ? null : new Date(now + draft.startsInMs);
  const endsAt = new Date((startsAt?.getTime() ?? now) + draft.durationMs);

  const giveaway = await deps.store.create({
    id,
    guildId: draft.guildId,
    channelId: draft.channelId,
    messageId: null,
    hostId: draft.hostId,
    title: draft.title,
    description: draft.description,
    bannerUrl: draft.bannerUrl,
    color: draft.color,
    emoji: draft.emoji,
    buttonStyle: draft.buttonStyle,
    winnerCount: draft.winnerCount,
    requirementLogic: draft.requirementLogic,
    verifyOn: draft.verifyOn,
    maxEntriesPerUser: draft.maxEntriesPerUser,
    claimWindowSeconds: draft.claimWindowSeconds,
    winMessage: draft.winMessage,
    rewardRoleId: draft.rewardRoleId,
    startsAt,
    status: startsAt === null ? 'running' : 'scheduled',
    endsAt,
    dmWinners: draft.dmWinners || ctx.config.dmWinners,
    createdBy: draft.hostId,
    requirements: draft.requirements.map((item, index) => ({
      providerId: item.providerId,
      config: item.config,
      position: index,
    })),
    multipliers: draft.multipliers.map((item, index) => ({
      providerId: item.providerId,
      config: item.config,
      mode: item.mode,
      position: index,
    })),
  });

  const rendered = renderCard(startsAt === null ? 'active' : 'scheduled', {
    view: viewOf(giveaway),
    entrantCount: 0,
    requirements: describeDraftRequirements(deps, draft),
    multipliers: describeDraftMultipliers(deps, draft),
    accentColor: ctx.config.embedColor,
  });

  if (!rendered.ok) {
    return {
      ok: false,
      content: `I could not build the giveaway message: ${rendered.humanReason}`,
    };
  }

  const posted = await postGiveaway(ctx, {
    channelId: draft.channelId,
    actorId: draft.hostId,
    components: rendered.components,
    idempotencyKey: `${idempotencyRoot}:post`,
  });

  if (!succeeded(posted)) {
    return {
      ok: false,
      content: `The giveaway was created but I could not post it: ${
        posted.failure?.humanReason ?? 'Discord refused the message.'
      }`,
    };
  }

  const messageId = sentMessageId(posted);
  if (messageId) await deps.store.setMessageId(id, messageId);

  // Scheduled here rather than in the caller: this is the second start path, and the first one
  // scheduling its own end job is why a giveaway built in the builder never ended. A scheduled
  // giveaway arms its start instead — the start handler arms the end once it opens.
  if (startsAt === null) {
    await ctx.schedule?.(END_JOB_ID, endsAt, `${MODULE_ID}:${id}`, { giveawayId: id });
  } else {
    await ctx.schedule?.(START_JOB_ID, startsAt, `${MODULE_ID}:${id}:start`, { giveawayId: id });
  }

  return {
    ok: true,
    giveawayId: id,
    endsAt,
    content:
      `**${draft.title}** is live — ${plural(draft.winnerCount, 'winner')}, drawn ` +
      `<t:${Math.floor(endsAt.getTime() / 1000)}:R>.`,
  };
}

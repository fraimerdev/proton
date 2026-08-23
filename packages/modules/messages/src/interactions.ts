import {
  type EventListener,
  type EventType,
  interactionRef,
  MAX_AUTOCOMPLETE_CHOICES,
  type ModuleContext,
  type ProtonEvent,
  parseCustomId,
  readAutocompleteInteraction,
  readModalInteraction,
  respondAutocomplete,
} from '@proton/core';
import { readComposedEmbed, SEND_ACTION } from './compose.ts';
import { type MessagesConfig, MODULE_ID, suggestTemplateNames } from './config.ts';
import { bindFollowUp, describeUnbound, type MessagesDeps } from './deps.ts';
import { buildEmbed } from './embed.ts';
import {
  deferEphemeral,
  followUp,
  postEmbed,
  replyEphemeral,
  respondTo,
  succeeded,
} from './perform.ts';

export const MESSAGES_MODAL_EVENT_TYPES: EventType[] = ['interaction.modal'];
export const MESSAGES_AUTOCOMPLETE_EVENT_TYPES: EventType[] = ['interaction.autocomplete'];

const AUTOCOMPLETED_COMMAND = 'embed';
const AUTOCOMPLETED_SUBCOMMAND = 'post';
const FOCUSED_OPTION = 'name';

const SWITCHED_OFF =
  'The embed builder is switched off in this server, so nothing was posted. An admin can turn ' +
  'it back on from the Proton dashboard.';

const NOT_WIRED =
  "I can't finish that: this Proton deployment isn't fully set up, so I have no way to tell you " +
  'whether your embed went out. Nothing was posted. A server admin should check the Proton ' +
  'logs — the exact missing piece is named there.';

export type ModalOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'posted'; channelId: string };

export async function handleModalSubmit(
  event: ProtonEvent,
  ctx: ModuleContext<MessagesConfig>,
  deps: MessagesDeps,
): Promise<ModalOutcome> {
  const facts = readModalInteraction(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable interaction payload' };

  const parsed = parseCustomId(facts.customId);
  if (!parsed || parsed.moduleId !== MODULE_ID) {
    return { action: 'ignored', reason: 'another module owns that modal' };
  }
  if (parsed.action !== SEND_ACTION) {
    return { action: 'ignored', reason: `no embeds modal called '${parsed.action}'` };
  }

  const to = respondTo(ctx, interactionRef(facts), facts.userId, event.id);

  if (!ctx.config.enabled) {
    await replyEphemeral(ctx, to, SWITCHED_OFF);
    return { action: 'refused', reason: 'embeds is switched off in this server' };
  }

  const channelId = facts.channelId;
  if (!channelId) {
    await replyEphemeral(
      ctx,
      to,
      'Discord did not tell me which channel you composed that in, so I have nowhere to post ' +
        'it. Run `/message send` again from the channel you want it in.',
    );
    return { action: 'refused', reason: 'the modal submission carried no channel' };
  }

  const composed = readComposedEmbed(facts.fields);
  if (!composed.ok) {
    await replyEphemeral(ctx, to, `${composed.humanReason} Nothing was posted.`);
    return { action: 'refused', reason: composed.humanReason };
  }

  const built = buildEmbed(composed.content);
  if (!built.ok) {
    await replyEphemeral(ctx, to, `${built.humanReason} Nothing was posted.`);
    return { action: 'refused', reason: built.humanReason };
  }

  const bound = bindFollowUp(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('a composed embed was not posted', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await replyEphemeral(ctx, to, NOT_WIRED);
    return { action: 'refused', reason: 'the follow-up port is unbound' };
  }

  await deferEphemeral(ctx, to);

  const result = await postEmbed(ctx, {
    channelId,
    embed: built.embed,
    actorId: facts.userId,
    idempotencyRoot: event.id,
  });

  if (!succeeded(result)) {
    const humanReason = result.failure?.humanReason ?? 'Discord refused it and gave no reason.';
    await followUp(
      ctx,
      to,
      bound.deps.applicationId,
      `I could not post your embed in <#${channelId}>. ${humanReason}`,
    );
    return { action: 'refused', reason: humanReason };
  }

  await followUp(ctx, to, bound.deps.applicationId, `Posted your embed in <#${channelId}>.`);
  return { action: 'posted', channelId };
}

export type AutocompleteOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'answered'; count: number };

export async function handleAutocomplete(
  event: ProtonEvent,
  ctx: ModuleContext<MessagesConfig>,
): Promise<AutocompleteOutcome> {
  const facts = readAutocompleteInteraction(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable interaction payload' };

  if (facts.commandName !== AUTOCOMPLETED_COMMAND) {
    return { action: 'ignored', reason: 'another module owns that command' };
  }

  if (facts.subcommand !== AUTOCOMPLETED_SUBCOMMAND) {
    return { action: 'ignored', reason: 'only /message post suggests saved names' };
  }

  if (facts.focused === null || facts.focused.name !== FOCUSED_OPTION) {
    return { action: 'ignored', reason: 'the focused option is not a saved embed name' };
  }

  if (!ctx.config.enabled) {
    return { action: 'ignored', reason: 'embeds is switched off in this server' };
  }

  const names = suggestTemplateNames(
    ctx.config.templates,
    facts.focused.value,
    MAX_AUTOCOMPLETE_CHOICES,
  );

  // Answered even when empty: Discord shows "no options match" for an empty choice list, and
  // saying nothing at all leaves the member watching a spinner until the interaction expires.
  await ctx.executor.execute(
    respondAutocomplete(
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        actorId: facts.userId,
        interaction: interactionRef(facts),
        idempotencyKey: `${MODULE_ID}:${event.id}`,
      },
      names.map((name) => ({ name, value: name })),
    ),
  );

  return { action: 'answered', count: names.length };
}

export function createMessagesModalListener(deps: MessagesDeps): EventListener<MessagesConfig> {
  return {
    types: MESSAGES_MODAL_EVENT_TYPES,
    handler: async (event, ctx) => {
      await handleModalSubmit(event, ctx, deps);
    },
  };
}

export function createMessagesAutocompleteListener(): EventListener<MessagesConfig> {
  return {
    types: MESSAGES_AUTOCOMPLETE_EVENT_TYPES,
    handler: async (event, ctx) => {
      await handleAutocomplete(event, ctx);
    },
  };
}

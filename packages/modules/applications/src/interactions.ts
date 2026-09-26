import {
  type ActionResult,
  type EventListener,
  type EventType,
  errorStatus,
  followUp,
  type InteractionBase,
  interactionRef,
  type ModuleContext,
  type ProtonEvent,
  type RespondTo,
  readComponentInteraction,
  readModalInteraction,
  replyEphemeral,
} from '@proton/core';
import type { ApplicationsConfig } from './config.ts';
import { MODULE_ID } from './constants.ts';
import { type ApplicationsDeps, bindApplicationsDeps, describeUnbound } from './deps.ts';
import { errorSummary, handleApplicantInteraction, offSentence } from './flow.ts';
import { isApplicantAction, isStaffAction, readCustomId } from './interface.ts';
import { handleStaffInteraction } from './staff.ts';

export { createApplicationsAutocompleteListener } from './autocomplete.ts';

export const INTERACTION_EVENT_TYPES: EventType[] = ['interaction.component', 'interaction.modal'];

const NOT_WIRED =
  'I can’t reach this server’s applications right now, so nothing was changed. This is a fault ' +
  'on my side, not a setting in this server.';
const OUTDATED = 'This button is out of date. Open the application panel again.';
const THREW =
  'Something went wrong on my side with this button, so it may not have finished. Try again in ' +
  'a moment.';

type PressFacts = InteractionBase & { customId: string };

function failed(result: ActionResult): boolean {
  return result.status === 'failed_precheck' || result.status === 'failed_api';
}

// Its own key root: the handler may already have answered, and then only a followup gets through.
async function apologise(
  event: ProtonEvent,
  ctx: ModuleContext<ApplicationsConfig>,
  facts: PressFacts,
  applicationId: string,
): Promise<void> {
  const to: RespondTo = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: facts.userId,
    interaction: interactionRef(facts),
    idempotencyKey: `${MODULE_ID}:${event.id}:threw`,
  };
  const body = { ...errorStatus(THREW), allowedMentions: { parse: [] } };

  const replied = await ctx.executor.execute(replyEphemeral(to, body));
  if (!failed(replied)) return;
  await ctx.executor.execute(followUp({ ...to, applicationId }, body));
}

function pressOf(event: ProtonEvent): PressFacts | null {
  if (event.type === 'interaction.modal') return readModalInteraction(event);
  if (event.type === 'interaction.component') return readComponentInteraction(event);
  return null;
}

async function tell(
  event: ProtonEvent,
  ctx: ModuleContext<ApplicationsConfig>,
  facts: PressFacts,
  sentence: string,
): Promise<void> {
  const result = await ctx.executor.execute(
    replyEphemeral(
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        actorId: facts.userId,
        interaction: interactionRef(facts),
        idempotencyKey: `${MODULE_ID}:${event.id}`,
      },
      { ...errorStatus(sentence), allowedMentions: { parse: [] } },
    ),
  );

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `applications could not answer a press: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

export async function routeInteraction(
  event: ProtonEvent,
  ctx: ModuleContext<ApplicationsConfig>,
  deps: ApplicationsDeps,
): Promise<void> {
  const facts = pressOf(event);
  const parsed = facts === null ? null : readCustomId(facts.customId);
  if (facts === null || parsed === null) return;

  if (!ctx.config.enabled) {
    await tell(event, ctx, facts, offSentence(ctx.guildId, deps.dashboardUrl));
    return;
  }

  const bound = bindApplicationsDeps(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('Applications buttons are NOT running', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await tell(event, ctx, facts, NOT_WIRED);
    return;
  }

  try {
    if (isApplicantAction(parsed.action)) {
      await handleApplicantInteraction(event, ctx, bound.deps, parsed);
      return;
    }
    if (isStaffAction(parsed.action)) {
      await handleStaffInteraction(event, ctx, bound.deps, parsed);
      return;
    }
  } catch (error) {
    ctx.logger.error(
      `applications could not finish a '${parsed.action}' press, so the bus will retry it: ${errorSummary(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    await apologise(event, ctx, facts, bound.deps.applicationId).catch(() => undefined);
    throw error;
  }

  await tell(event, ctx, facts, OUTDATED);
}

export function createApplicationsInteractionListener(
  deps: ApplicationsDeps,
): EventListener<ApplicationsConfig> {
  return {
    types: INTERACTION_EVENT_TYPES,
    async handler(event, ctx) {
      await routeInteraction(event, ctx, deps);
    },
  };
}

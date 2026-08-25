import {
  interactionRef,
  type ProtonEvent,
  readComponentInteraction,
  readModalInteraction,
} from '@proton/core';
import { MODULE_ID } from '../config.ts';
import { V2_FLAGS } from '../message.ts';
import {
  acknowledge,
  type Ctx,
  NOT_WIRED,
  refuseNow,
  showModal,
  tellEntrant,
  updateInPlace,
} from '../perform.ts';
import {
  type BuilderDeps,
  type BuilderReply,
  builderRouteOf,
  handleBuilderComponent,
  handleBuilderModal,
  startFromDraft,
} from './handler.ts';
import { BUILDER_START } from './screens.ts';
import { draftKey } from './state.ts';

export type BuilderOutcome = 'not-ours' | 'handled' | 'ignored' | 'unbound';

interface Target {
  applicationId: string;
  ref: ReturnType<typeof interactionRef>;
  userId: string;
  root: string;
}

async function deliver(ctx: Ctx, target: Target, reply: BuilderReply): Promise<BuilderOutcome> {
  switch (reply.kind) {
    // A modal is a top-level response and cannot follow a defer, so nothing above this line may
    // have acknowledged the interaction.
    case 'modal':
      await showModal(ctx, target.ref, target.userId, target.root, reply.modal);
      return 'handled';

    case 'update':
      await updateInPlace(
        ctx,
        target.ref,
        target.userId,
        target.root,
        [...reply.components] as Record<string, unknown>[],
        reply.content,
      );
      return 'handled';

    case 'message':
      await refuseNow(ctx, target.ref, target.userId, target.root, reply.content);
      return 'handled';

    // The preview is the real Components V2 message, so it cannot be a callback — it is deferred
    // and then sent as a followup, which is the documented path for a V2 interaction response.
    case 'preview': {
      await acknowledge(ctx, target.ref, target.userId, target.root);
      await tellEntrant(
        ctx,
        { applicationId: target.applicationId, interaction: target.ref },
        target.userId,
        target.root,
        { components: [...reply.components] as Record<string, unknown>[], flags: V2_FLAGS },
      );
      return 'handled';
    }

    case 'ignored':
      return 'ignored';
  }
}

export async function handleBuilderPress(
  event: ProtonEvent,
  ctx: Ctx,
  deps: BuilderDeps & { applicationId?: string },
): Promise<BuilderOutcome> {
  if (!ctx.config.enabled) return 'ignored';

  const interaction = readComponentInteraction(event);
  if (!interaction || interaction.guildId === null) return 'not-ours';

  const route = builderRouteOf(interaction.customId);
  if (!route) return 'not-ours';

  const applicationId = deps.applicationId ?? interaction.applicationId;
  if (applicationId === null) return 'unbound';

  const ref = interactionRef(interaction);
  const target: Target = {
    applicationId,
    ref,
    userId: interaction.userId,
    root: `${interaction.interactionId}:builder`,
  };

  // Start posts a message and writes rows, so it needs the module context the pure handler has
  // no business holding.
  if (route.action === BUILDER_START) {
    const key = draftKey(interaction.guildId, interaction.userId);
    const draft = await deps.drafts.get(key);

    if (!draft) {
      await refuseNow(
        ctx,
        ref,
        interaction.userId,
        target.root,
        'That builder has expired. Start a new one with `/giveaway create`.',
      );
      return 'handled';
    }

    await acknowledge(ctx, ref, interaction.userId, target.root);

    const started = await startFromDraft(ctx, deps, draft, `${MODULE_ID}:${target.root}`);
    if (started.ok) await deps.drafts.delete(key);

    await tellEntrant(
      ctx,
      { applicationId, interaction: ref },
      interaction.userId,
      target.root,
      started.content,
    );

    return 'handled';
  }

  const reply = await handleBuilderComponent(deps, {
    action: route.action,
    args: route.args,
    guildId: interaction.guildId,
    channelId: interaction.channelId ?? '',
    userId: interaction.userId,
    values: interaction.values,
  });

  return deliver(ctx, target, reply);
}

export async function handleBuilderSubmit(
  event: ProtonEvent,
  ctx: Ctx,
  deps: BuilderDeps & { applicationId?: string },
): Promise<BuilderOutcome> {
  if (!ctx.config.enabled) return 'ignored';

  const interaction = readModalInteraction(event);
  if (!interaction || interaction.guildId === null) return 'not-ours';

  const route = builderRouteOf(interaction.customId);
  if (!route) return 'not-ours';

  const applicationId = deps.applicationId ?? interaction.applicationId;
  if (applicationId === null) {
    ctx.logger.error(`Giveaways cannot answer a builder modal: no application id.`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return 'unbound';
  }

  const ref = interactionRef(interaction);
  const target: Target = {
    applicationId,
    ref,
    userId: interaction.userId,
    root: `${interaction.interactionId}:builder`,
  };

  const reply = await handleBuilderModal(deps, {
    action: route.action,
    args: route.args,
    guildId: interaction.guildId,
    userId: interaction.userId,
    fields: interaction.fields,
    values: interaction.values,
  });

  // Discord refuses a modal opened from a modal submission, so a validation failure comes back as
  // an ephemeral message naming the field rather than the form again.
  if (reply.kind === 'modal') {
    await refuseNow(ctx, ref, interaction.userId, target.root, NOT_WIRED);
    return 'handled';
  }

  return deliver(ctx, target, reply);
}

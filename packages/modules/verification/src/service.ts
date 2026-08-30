import {
  type ActionResult,
  type ModuleContext,
  type ProtonEvent,
  verificationWebPassedSchema,
} from '@proton/core';
import type { VerificationConfig } from './config.ts';
import { bindGateDeps, bindPanelDeps, describeUnbound, type VerificationDeps } from './deps.ts';
import { planVerification, runVerification } from './gate.ts';
import { buildPanelMessage } from './panel.ts';
import { MODULE_ID, run, succeeded } from './perform.ts';

export type PanelOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'posted'; messageId: string }
  | { action: 'edited'; messageId: string }
  | { action: 'removed' };

function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

function sentMessageId(result: ActionResult): string | null {
  const id = (result.body as { id?: unknown } | undefined)?.id;

  return typeof id === 'string' ? id : null;
}

export async function reconcilePanel(
  event: ProtonEvent,
  ctx: ModuleContext<VerificationConfig>,
  deps: VerificationDeps,
): Promise<PanelOutcome> {
  if (field(event.payload, 'moduleId') !== MODULE_ID) {
    return { action: 'ignored', reason: 'another module was saved' };
  }

  const bound = bindPanelDeps(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('the verification panel was not reconciled', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { action: 'refused', reason: 'the panel port is unbound' };
  }

  // The module-level switch is not in the config schema, so a module that was just turned off can
  // only learn it from the event that announced the change.
  const live = field(event.payload, 'enabledAfter') !== false && ctx.config.enabled;
  const wanted = live ? ctx.config.panelChannelId : undefined;

  const existing = await bound.deps.panel.get(ctx.guildId);

  if (!wanted) {
    if (!existing) return { action: 'ignored', reason: 'there is no panel and none is wanted' };

    await takeDown(ctx, event, existing.channelId, existing.messageId);
    await bound.deps.panel.clear(ctx.guildId);

    return { action: 'removed' };
  }

  const built = buildPanelMessage(ctx.config);
  if (!built.ok) {
    ctx.logger.error(`verification could not build its panel: ${built.humanReason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { action: 'refused', reason: built.humanReason };
  }

  const message = { content: built.content, components: built.components };

  if (existing && existing.channelId === wanted) {
    const edited = await run(
      ctx,
      panelRequest(ctx, event, 'edit_message', 'panel-edit', {
        channelId: wanted,
        messageId: existing.messageId,
        ...message,
      }),
      `refresh the panel in ${wanted}`,
    );

    if (succeeded(edited)) return { action: 'edited', messageId: existing.messageId };

    // Somebody deleted it. Remembering a dead id would make every later save fail the same way.
    if (edited.failure?.code !== 'discord_404') {
      return { action: 'refused', reason: edited.failure?.humanReason ?? 'Discord refused it.' };
    }
  }

  // The panel moved channel, so the one it left behind is an orphan nobody will ever take down.
  if (existing && existing.channelId !== wanted) {
    await takeDown(ctx, event, existing.channelId, existing.messageId);
  }

  const posted = await run(
    ctx,
    panelRequest(ctx, event, 'send', 'panel-post', {
      channelId: wanted,
      ...message,
      allowedMentions: { parse: [] },
    }),
    `post the panel in ${wanted}`,
  );

  if (!succeeded(posted)) {
    return {
      action: 'refused',
      reason: posted.failure?.humanReason ?? 'Discord refused the panel and gave no reason.',
    };
  }

  const messageId = sentMessageId(posted);
  if (!messageId) {
    ctx.logger.error(
      `verification posted its panel in ${wanted} but Discord returned no message id, so the next ` +
        'save cannot refresh it and will post a second one. Delete the old one by hand.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return { action: 'refused', reason: 'the posted panel has no id to remember' };
  }

  await bound.deps.panel.put({
    guildId: ctx.guildId,
    channelId: wanted,
    messageId,
    postedAt: event.occurredAt,
  });

  return { action: 'posted', messageId };
}

function panelRequest(
  ctx: ModuleContext<VerificationConfig>,
  event: ProtonEvent,
  kind: 'send' | 'edit_message' | 'delete_message',
  suffix: string,
  payload: Record<string, unknown>,
) {
  return {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind,
    actorId: MODULE_ID,
    dryRun: false,
    record: false,
    idempotencyKey: `${MODULE_ID}:${event.id}:${suffix}`,
    payload,
  } as const;
}

async function takeDown(
  ctx: ModuleContext<VerificationConfig>,
  event: ProtonEvent,
  channelId: string,
  messageId: string,
): Promise<void> {
  await run(
    ctx,
    panelRequest(ctx, event, 'delete_message', 'panel-remove', { channelId, messageId }),
    `take down the panel in ${channelId}`,
  );
}

export type WebOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'verified'; userId: string };

export async function handleWebPassed(
  event: ProtonEvent,
  ctx: ModuleContext<VerificationConfig>,
  deps: VerificationDeps,
): Promise<WebOutcome> {
  const passed = verificationWebPassedSchema.safeParse(event.payload);
  if (!passed.success) {
    ctx.logger.error(
      'verification received a website result it could not read, so whoever finished on the ' +
        'website was not given their role. This is an api/module mismatch.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return { action: 'ignored', reason: 'unreadable website result' };
  }

  if (ctx.config.mode !== 'website') {
    return { action: 'ignored', reason: 'this server no longer verifies on the website' };
  }

  const { userId, jti } = passed.data;

  const bound = bindGateDeps(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound(`${userId} finished on the website`, bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { action: 'refused', reason: 'the gate port is unbound' };
  }

  const plan = planVerification(ctx.config, await bound.deps.guildState.get(ctx.guildId));
  if ('refusal' in plan) {
    ctx.logger.error(
      `${userId} passed verification on the website and was NOT given their role: ${plan.refusal}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, jti },
    );
    return { action: 'refused', reason: plan.refusal };
  }

  // Nobody to reply to — the member is on the website, not in Discord — so a failure here is only
  // ever visible in the log, which is why it is logged at error rather than warn.
  const result = await runVerification(ctx, plan, userId, event.id, deps);

  if (!result.verified) {
    const line = `${userId} passed verification on the website and was NOT given their role: ${result.message}`;
    const where = { guildId: ctx.guildId, moduleId: MODULE_ID, jti };

    // A blocked member is the gate working, not the gate broken, so it does not page anyone.
    if (result.blocked) ctx.logger.warn(line, where);
    else ctx.logger.error(line, where);

    return { action: 'refused', reason: result.message };
  }

  ctx.logger.info(`${userId} verified on the website.`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    jti,
  });

  return { action: 'verified', userId };
}

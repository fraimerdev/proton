import {
  type CommandContext,
  type CommandDefinition,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  Permissions,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { BRANDING_ACTOR, type BrandingConfig, isBlank, MODULE_ID } from './config.ts';
import type { BrandingDeps } from './deps.ts';
import { impersonationReason } from './names.ts';
import { desiredProfile, readImage } from './profile.ts';

const DESCRIPTION = 'Re-apply how Proton looks in this server, and report what Discord said.';

function summarise(config: BrandingConfig): string {
  return [
    `Nickname: ${config.nickname ?? 'not set'}`,
    `Avatar: ${config.avatarHash ? 'set' : 'not set'}`,
    `Banner: ${config.bannerHash ? 'set' : 'not set'}`,
    `Bio: ${config.bio ? 'set' : 'not set'}`,
  ].join('\n');
}

function replyNow(ctx: CommandContext<BrandingConfig>, content: string): Promise<unknown> {
  return ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: ctx.idempotencyKey,
    dryRun: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      content,
      ephemeral: true,
    },
  });
}

export function createBrandingCommand(deps: BrandingDeps = {}): CommandDefinition<BrandingConfig> {
  return {
    name: 'branding',
    description: DESCRIPTION,

    data: new SlashCommandBuilder()
      .setName('branding')
      .setDescription(DESCRIPTION)
      .setDefaultMemberPermissions(Permissions.ManageGuild)
      .toJSON(),

    async handler(ctx) {
      if (!ctx.config.enabled) {
        await replyNow(
          ctx,
          'Branding is switched off in this server, so Proton is using its own name.',
        );
        return;
      }

      if (isBlank(ctx.config)) {
        await replyNow(
          ctx,
          'Branding is on but nothing is set yet. Add a nickname, avatar, banner or bio in the ' +
            'Proton dashboard.',
        );
        return;
      }

      if (!deps.applicationId) {
        await replyNow(
          ctx,
          `${summarise(ctx.config)}\n\nProton cannot re-apply this from a command right now: its ` +
            'application id is not bound, which is a deployment fault rather than a setting.',
        );
        return;
      }

      // Fetching two images and issuing two PATCHes will not finish inside Discord's three-second
      // window, so the reply is deferred before any of it starts.
      await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'interaction_reply',
        actorId: ctx.userId,
        idempotencyKey: ctx.idempotencyKey,
        dryRun: false,
        payload: {
          interactionId: ctx.interaction.id,
          interactionToken: ctx.interaction.token,
          ephemeral: true,
          callbackType: INTERACTION_CALLBACK_DEFERRED_MESSAGE,
        },
      });

      const desired = desiredProfile(ctx.config);
      const problems: string[] = [];

      const refusal = desired.nickname === null ? null : impersonationReason(desired.nickname);
      if (refusal) problems.push(`The nickname was refused: ${refusal}.`);

      const payload: { avatar: string | null; banner: string | null; bio: string | null } = {
        avatar: null,
        banner: null,
        bio: desired.bio,
      };

      for (const [field, hash] of [
        ['avatar', desired.avatarHash],
        ['banner', desired.bannerHash],
      ] as const) {
        if (hash === null) continue;

        if (!deps.assets) {
          problems.push(`The ${field} could not be read: Proton has no asset store bound.`);
          continue;
        }

        const image = await readImage(ctx.guildId, field, deps.assets);
        if (image.dataUri === undefined) {
          problems.push(`The ${field} could not be read: ${image.failure}.`);
          continue;
        }

        payload[field] = image.dataUri;
      }

      const profile = await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'set_bot_profile',
        actorId: BRANDING_ACTOR,
        reason: `Re-applied by ${ctx.userId} with /branding`,
        payload,
        dryRun: false,
        record: false,
        // Not ctx.idempotencyKey on its own — the deferral already used it, and the executor would
        // dedupe this away as the same action.
        idempotencyKey: `${ctx.idempotencyKey}:profile`,
      });

      if (profile.failure) problems.push(`Avatar, banner and bio: ${profile.failure.humanReason}`);

      if (!refusal) {
        const nickname = await ctx.executor.execute({
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
          kind: 'set_bot_nickname',
          actorId: BRANDING_ACTOR,
          reason: `Re-applied by ${ctx.userId} with /branding`,
          payload: { nickname: desired.nickname },
          dryRun: false,
          record: false,
          idempotencyKey: `${ctx.idempotencyKey}:nickname`,
        });

        if (nickname.failure) problems.push(`Nickname: ${nickname.failure.humanReason}`);
      }

      const head = summarise(ctx.config);

      await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'interaction_followup',
        actorId: ctx.userId,
        idempotencyKey: `${ctx.idempotencyKey}:report`,
        dryRun: false,
        payload: {
          applicationId: deps.applicationId,
          interactionToken: ctx.interaction.token,
          ephemeral: true,
          content:
            problems.length === 0
              ? `Re-applied.\n${head}`
              : `${head}\n\nSome of it did not go through:\n${problems
                  .map((p) => `- ${p}`)
                  .join('\n')}`,
        },
      });
    },
  };
}

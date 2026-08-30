import {
  type EventListener,
  type EventType,
  type ModuleContext,
  type ProtonEvent,
  protonConfigChangedSchema,
} from '@proton/core';
import { colourFingerprint, coloursFor, describeColourFailure, ROLE_NAME } from './colour.ts';
import { BRANDING_ACTOR, type BrandingConfig, MODULE_ID } from './config.ts';
import { type BrandingDeps, describeUnbound } from './deps.ts';
import { impersonationReason } from './names.ts';
import {
  CLEARED,
  type DesiredProfile,
  desiredProfile,
  diverges,
  fingerprint,
  observedProfile,
  readImage,
} from './profile.ts';
import { applyTypeface, fitsNickname, nicknameBudget } from './typeface.ts';

export const BRANDING_EVENT_TYPES: EventType[] = ['proton.config_changed', 'guild.available'];

const REASON = 'Server branding, set in the Proton dashboard';

interface Legs {
  nickname: boolean;
  profile: boolean;
  colour: boolean;
}

const ALL: Legs = { nickname: true, profile: true, colour: true };

async function pushNickname(
  ctx: ModuleContext<BrandingConfig>,
  desired: DesiredProfile,
  key: string,
): Promise<void> {
  // Styled here rather than at save time: the typeface is a presentation of the stored name, so
  // the admin's own words stay in config and a face swap never rewrites them.
  const styled =
    desired.nickname === null ? null : applyTypeface(desired.nickname, ctx.config.typeface);

  if (styled !== null && !fitsNickname(styled)) {
    ctx.logger.warn(
      `Proton did not take the nickname '${desired.nickname}' in this server: in the ` +
        `${ctx.config.typeface} typeface it is past Discord's 32-character limit, which allows ` +
        `${nicknameBudget(ctx.config.typeface)} characters in this face. Shorten it or pick Default.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  if (desired.nickname !== null) {
    const refusal = impersonationReason(desired.nickname);
    if (refusal) {
      ctx.logger.warn(
        `Proton did not take the nickname '${desired.nickname}' in this server because ${refusal}. ` +
          'Change it in the Branding module and it will be applied.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'set_bot_nickname',
    actorId: BRANDING_ACTOR,
    reason: REASON,
    payload: { nickname: styled },
    dryRun: false,
    record: false,
    idempotencyKey: `${key}:nickname`,
  });

  if (result.failure) {
    ctx.logger.warn(
      `Proton could not set its nickname in this server: ${result.failure.humanReason}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

async function pushProfile(
  ctx: ModuleContext<BrandingConfig>,
  desired: DesiredProfile,
  deps: BrandingDeps,
  key: string,
): Promise<void> {
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
      ctx.logger.error(
        `Proton could not set its ${field} in this server: no asset store is bound to the ` +
          'branding module, which is a deployment fault rather than a setting.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }

    const image = await readImage(ctx.guildId, field, deps.assets);
    if (image.dataUri === undefined) {
      // Returning would also drop the bio and the other image, so the guild would sit with a
      // half-applied face and no way to tell which half.
      ctx.logger.warn(
        `Proton could not set its ${field} in this server: ${image.failure}. The rest of the ` +
          'branding was applied.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      continue;
    }

    payload[field] = image.dataUri;
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'set_bot_profile',
    actorId: BRANDING_ACTOR,
    reason: REASON,
    payload,
    dryRun: false,
    record: false,
    idempotencyKey: `${key}:profile`,
  });

  if (result.failure) {
    ctx.logger.warn(
      `Proton could not set its avatar, banner or bio in this server: ${result.failure.humanReason}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

async function pushColour(
  ctx: ModuleContext<BrandingConfig>,
  deps: BrandingDeps,
  key: string,
): Promise<void> {
  if (!deps.roles || !deps.botUserId) return;

  const colours = coloursFor(ctx.config);
  const held = await deps.roles.get(ctx.guildId);

  if (colours === null) {
    // The role is left in place rather than deleted: an admin may have given it to somebody else,
    // and deleting a role takes its colour off every one of them.
    if (held) {
      await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'remove_bot_role',
        actorId: BRANDING_ACTOR,
        reason: REASON,
        payload: { userId: deps.botUserId, roleId: held },
        dryRun: false,
        record: false,
        idempotencyKey: `${key}:colour:off`,
      });
    }
    return;
  }

  const print = colourFingerprint(colours);

  let roleId = held;

  if (roleId === null) {
    const created = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_role',
      actorId: BRANDING_ACTOR,
      reason: REASON,
      payload: { name: ROLE_NAME, colors: colours },
      dryRun: false,
      record: false,
      idempotencyKey: `${key}:colour:create`,
    });

    if (created.failure) {
      ctx.logger.warn(
        `Proton could not make the role that carries its name colour in this server: ${describeColourFailure(ctx.config.nameEffect, created.failure.humanReason)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }

    const id = (created.body as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string') {
      ctx.logger.error(
        'Discord accepted the colour role but returned no id, so Proton cannot find it again.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }

    roleId = id;
    await deps.roles.put(ctx.guildId, roleId);
  } else {
    const edited = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'edit_role',
      actorId: BRANDING_ACTOR,
      reason: REASON,
      payload: { roleId, colors: colours },
      dryRun: false,
      record: false,
      idempotencyKey: `${key}:colour:${print}`,
    });

    if (edited.failure) {
      ctx.logger.warn(
        `Proton could not recolour its name in this server: ${describeColourFailure(ctx.config.nameEffect, edited.failure.humanReason)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }
  }

  // Always, not only on create: an admin who took the role off the bot gets it back on the next
  // reconcile, and Discord treats the PUT as idempotent.
  const worn = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'add_bot_role',
    actorId: BRANDING_ACTOR,
    reason: REASON,
    payload: { userId: deps.botUserId, roleId },
    dryRun: false,
    record: false,
    idempotencyKey: `${key}:colour:wear:${print}`,
  });

  if (worn.failure) {
    ctx.logger.warn(
      `Proton coloured its role but could not put it on itself in this server: ${worn.failure.humanReason}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

async function apply(
  ctx: ModuleContext<BrandingConfig>,
  desired: DesiredProfile,
  deps: BrandingDeps,
  key: string,
  legs: Legs,
): Promise<void> {
  // Profile first. A guild that has stripped Change Nickname fails the nickname leg at its
  // precheck, and doing that leg second means the images and bio have already landed.
  if (legs.profile) await pushProfile(ctx, desired, deps, key);
  if (legs.nickname) await pushNickname(ctx, desired, key);
  if (legs.colour) await pushColour(ctx, deps, key);
}

export function createBrandingListener(deps: BrandingDeps = {}): EventListener<BrandingConfig> {
  return {
    types: BRANDING_EVENT_TYPES,

    async handler(event: ProtonEvent, ctx: ModuleContext<BrandingConfig>): Promise<void> {
      const unbound = describeUnbound(deps);
      if (unbound.length > 0) {
        ctx.logger.warn(`the branding module is not fully bound: ${unbound.join('; ')}`, {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
      }

      if (event.type === 'proton.config_changed') {
        const parsed = protonConfigChangedSchema.safeParse(event.payload);
        if (!parsed.success || parsed.data.moduleId !== MODULE_ID) return;

        // The listener runtime delivers config_changed to a module that has just been switched
        // off, which is the only moment branding can take its own face back off again.
        if (!ctx.config.enabled) {
          if (!parsed.data.enabledBefore || !ctx.config.restoreOnDisable) return;

          await apply(ctx, CLEARED, deps, `branding:${ctx.guildId}:${parsed.data.auditId}`, ALL);
          return;
        }

        // The audit id is unique per save, so a redelivered save dedupes and a new save never
        // collides with the executor's 24-hour window.
        await apply(
          ctx,
          desiredProfile(ctx.config),
          deps,
          `branding:${ctx.guildId}:${parsed.data.auditId}`,
          ALL,
        );
        return;
      }

      if (!ctx.config.enabled || !deps.botUserId) return;

      const observed = observedProfile(event.payload, deps.botUserId);
      if (!observed) return;

      const desired = desiredProfile(ctx.config);
      const legs = { ...diverges(desired, observed), colour: true };
      if (!legs.nickname && !legs.profile && ctx.config.nameEffect === 'none') return;

      // guild.available's event id is the bare guild id and never changes, so it cannot seed the
      // key. What Discord currently holds can, and it is exactly what makes a re-invite push again.
      const key = `branding:${ctx.guildId}:${fingerprint(desired)}:${fingerprint({
        nickname: observed.nickname,
        avatarHash: observed.hasAvatar ? 'set' : null,
        bannerHash: observed.hasBanner ? 'set' : null,
        bio: null,
      })}`;

      await apply(ctx, desired, deps, key, legs);
    },
  };
}

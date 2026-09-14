import {
  type BotNameStyle,
  type EventListener,
  type EventType,
  type ModuleContext,
  type NameStyleState,
  type ProtonEvent,
  protonConfigChangedSchema,
} from '@proton/core';
import { BRANDING_ACTOR, type BrandingConfig, MODULE_ID } from './config.ts';
import { type BrandingDeps, describeUnbound } from './deps.ts';
import {
  nameStyleWriteIssues,
  sameWireStyle,
  toWireStyle,
  wireStyleFingerprint,
} from './name-style.ts';
import { applyNameStyle, fetchBotNameStyle, UNVERIFIED_RETRY_MS } from './name-style-apply.ts';
import { impersonationReason } from './names.ts';
import {
  CLEARED,
  type DesiredProfile,
  type Divergence,
  desiredProfile,
  diverges,
  fingerprint,
  type ObservedProfile,
  observedProfile,
  readImage,
} from './profile.ts';

export const BRANDING_EVENT_TYPES: EventType[] = ['proton.config_changed', 'guild.available'];

const REASON = 'Server branding, set in the Proton dashboard';

const STYLE_KEYS: ReadonlySet<string> = new Set<keyof BrandingConfig>([
  'displayNameStyle',
  'nameStyleNative',
]);

const ALL: Divergence = { nickname: true, profile: true };

async function pushNickname(
  ctx: ModuleContext<BrandingConfig>,
  desired: DesiredProfile,
  key: string,
): Promise<void> {
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
    payload: { nickname: desired.nickname },
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

async function deleteColourRole(
  ctx: ModuleContext<BrandingConfig>,
  deps: BrandingDeps,
): Promise<void> {
  const roles = deps.roles;
  if (!roles) return;

  const roleId = await roles.get(ctx.guildId);
  if (roleId === null) return;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_role',
    actorId: BRANDING_ACTOR,
    reason: 'Proton no longer colours its name with a role',
    payload: { roleId },
    dryRun: false,
    record: false,
    // The role id, never the event or audit id: a reconnect and a save must dedupe as one deletion.
    idempotencyKey: `branding:${ctx.guildId}:colour-role:${roleId}`,
  });

  if (result.status === 'skipped_duplicate') return;

  if (result.status === 'executed' || result.failure?.code === 'discord_404') {
    await roles.forget(ctx.guildId);
    return;
  }

  ctx.logger.warn(
    'Proton could not delete the role it made for its name colour in this server: ' +
      `${result.failure?.humanReason ?? `it ${result.status}.`} It will try again the next time ` +
      'it reconnects here or Branding is saved.',
    { guildId: ctx.guildId, moduleId: MODULE_ID, roleId },
  );
}

async function apply(
  ctx: ModuleContext<BrandingConfig>,
  desired: DesiredProfile,
  deps: BrandingDeps,
  key: string,
  legs: Divergence,
): Promise<void> {
  // Profile first. A guild that has stripped Change Nickname fails the nickname leg at its
  // precheck, and doing that leg second means the images and bio have already landed.
  if (legs.profile) await pushProfile(ctx, desired, deps, key);
  if (legs.nickname) await pushNickname(ctx, desired, key);
}

async function pushNameStyle(
  ctx: ModuleContext<BrandingConfig>,
  deps: BrandingDeps,
  key: string,
): Promise<void> {
  const store = deps.nameStyles;
  if (!store) return;

  const issues = nameStyleWriteIssues(ctx.config.displayNameStyle);
  if (issues.length > 0) {
    ctx.logger.warn(
      `Proton did not send its display name style in this server: ${issues.map((issue) => issue.message).join(' ')} Choose another in the Branding module.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  const requested = toWireStyle(ctx.config.displayNameStyle);
  if (requested === null && (await store.get(ctx.guildId)) === null) return;

  await applyNameStyle(ctx, { ...deps, nameStyles: store }, requested, key);
}

async function resetNameStyle(
  ctx: ModuleContext<BrandingConfig>,
  deps: BrandingDeps,
  key: string,
): Promise<void> {
  const store = deps.nameStyles;
  if (!store || (await store.get(ctx.guildId)) === null) return;

  await applyNameStyle(ctx, { ...deps, nameStyles: store }, null, key);
}

function retryDue(held: NameStyleState, now: number): boolean {
  return (
    held.outcome === 'unverified' &&
    (held.attemptedAt === null || now - held.attemptedAt >= UNVERIFIED_RETRY_MS)
  );
}

function shouldApply(
  held: NameStyleState | null,
  requested: BotNameStyle | null,
  now: number,
): boolean {
  if (held === null || !sameWireStyle(held.requested, requested)) return true;
  // Confirmed yet not what Discord shows: a kick and re-invite reset the member under the record.
  if (held.outcome === 'confirmed') return true;
  return retryDue(held, now);
}

function alreadyConfirmed(held: NameStyleState | null, style: BotNameStyle | null): boolean {
  return (
    held !== null &&
    held.outcome === 'confirmed' &&
    held.confirmedAt !== null &&
    sameWireStyle(held.confirmed, style) &&
    sameWireStyle(held.requested, style)
  );
}

async function reconcileNameStyle(
  ctx: ModuleContext<BrandingConfig>,
  deps: BrandingDeps,
  botUserId: string,
  observed: BotNameStyle | null | undefined,
): Promise<void> {
  const store = deps.nameStyles;
  if (!store || nameStyleWriteIssues(ctx.config.displayNameStyle).length > 0) return;

  const requested = toWireStyle(ctx.config.displayNameStyle);
  const held = await store.get(ctx.guildId);
  if (requested === null && held === null) return;

  const now = Date.now();
  let seen = observed;

  if (seen === undefined) {
    if (held && sameWireStyle(held.requested, requested) && !retryDue(held, now)) return;
    if (deps.rest) seen = await fetchBotNameStyle(deps.rest, ctx.guildId, botUserId);
  }

  if (seen !== undefined) {
    if (held && held.confirmedAt !== null && !sameWireStyle(held.confirmed, seen)) {
      await store.forgetConfirmed(ctx.guildId, now);
    }

    if (sameWireStyle(seen, requested)) {
      if (!alreadyConfirmed(held, requested)) {
        await store.confirmObserved(ctx.guildId, requested, now);
      }
      return;
    }
  }

  if (!shouldApply(held, requested, now)) return;

  const key = `branding:${ctx.guildId}:name-style:${wireStyleFingerprint(requested)}:${held?.attemptedAt ?? 'never'}`;
  await applyNameStyle(ctx, { ...deps, nameStyles: store }, requested, key);
}

async function reconcileProfile(
  ctx: ModuleContext<BrandingConfig>,
  deps: BrandingDeps,
  observed: ObservedProfile,
): Promise<void> {
  const desired = desiredProfile(ctx.config);
  const legs = diverges(desired, observed);
  if (!legs.nickname && !legs.profile) return;

  // guild.available's event id is the bare guild id and never changes, so it cannot seed the
  // key. What Discord currently holds can, and it is exactly what makes a re-invite push again.
  const key = `branding:${ctx.guildId}:${fingerprint(desired)}:${fingerprint({
    nickname: observed.nickname,
    avatarHash: observed.hasAvatar ? 'set' : null,
    bannerHash: observed.hasBanner ? 'set' : null,
    bio: null,
  })}`;

  await apply(ctx, desired, deps, key, legs);
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

        const { auditId, changedKeys, enabledBefore, enabledAfter } = parsed.data;
        const key = `branding:${ctx.guildId}:${auditId}`;

        // The listener runtime delivers config_changed to a module that has just been switched
        // off, which is the only moment branding can take its own face back off again.
        if (!ctx.config.enabled) {
          if (!enabledBefore || !ctx.config.restoreOnDisable) return;

          await apply(ctx, CLEARED, deps, key, ALL);
          await resetNameStyle(ctx, deps, `${key}:name-style`);
          return;
        }

        const switched = enabledBefore !== enabledAfter;
        const styleOnly =
          !switched && changedKeys.length > 0 && changedKeys.every((k) => STYLE_KEYS.has(k));

        // The audit id is unique per save, so a redelivered save dedupes and a new save never
        // collides with the executor's 24-hour window.
        if (!styleOnly) await apply(ctx, desiredProfile(ctx.config), deps, key, ALL);

        if (switched || changedKeys.length === 0 || changedKeys.includes('displayNameStyle')) {
          await pushNameStyle(ctx, deps, `${key}:name-style`);
        }

        await deleteColourRole(ctx, deps);
        return;
      }

      if (!ctx.config.enabled || !deps.botUserId) return;

      const observed = observedProfile(event.payload, deps.botUserId);
      if (observed) await reconcileProfile(ctx, deps, observed);

      await reconcileNameStyle(ctx, deps, deps.botUserId, observed?.displayNameStyle);
      await deleteColourRole(ctx, deps);
    },
  };
}

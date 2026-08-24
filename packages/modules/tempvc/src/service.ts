import type { ModuleContext, PermissionOverwriteSpec } from '@proton/core';
import { SWEEP_JOB_ID } from './cleanup.ts';
import {
  allows,
  cooldownMsOf,
  delayMsOf,
  hubFor,
  MODULE_ID,
  type OwnerControl,
  type PrivacyMode,
  renderChannelName,
  type TempVcConfig,
  type TempVcHub,
  VOICE_CHANNEL_TYPE,
} from './config.ts';
import { panelMessage } from './interface.ts';
import { planOverwrites } from './permissions.ts';
import type { TempVoiceRepository } from './repository.ts';
import type { AccessKind, TempVoiceChannelRow } from './table.ts';
import type { VoiceMember } from './voice.ts';

export interface Occupancy {
  /** Members currently in the channel, from the guild-state cache rather than from Discord. */
  count(guildId: string, channelId: string): Promise<number>;
}

export interface ServiceDeps {
  repository: TempVoiceRepository;

  occupancy?: Occupancy | undefined;

  /** Overwrites to copy when permissionSync asks for them. */
  overwritesOf?(guildId: string, channelId: string): Promise<PermissionOverwriteSpec[] | null>;

  botUserId: string;

  now?(): Date;
  newId?(): string;
}

export type CreateOutcome =
  | { created: TempVoiceChannelRow }
  | {
      refused: 'at_limit' | 'cooldown' | 'no_hub' | 'create_failed' | 'moved_existing';
      detail: string;
    };

const COOLDOWN_PREFIX = 'tempvc:cooldown';

/** Recent creations, so a member cannot spam a hub into a hundred channels. */
export interface CooldownGate {
  hit(key: string, windowMs: number): Promise<boolean>;
}

export class TemporaryVoiceService {
  readonly #deps: ServiceDeps;
  readonly #cooldown: CooldownGate | undefined;

  constructor(deps: ServiceDeps, cooldown?: CooldownGate) {
    this.#deps = deps;
    this.#cooldown = cooldown;
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  #id(): string {
    return this.#deps.newId?.() ?? crypto.randomUUID();
  }

  /**
   * Reserve, then create, then attach. The reservation is a real row written before Discord is
   * touched, which is what makes a redelivered join idempotent and what leaves evidence behind if
   * the process dies mid-flight — the old order created the channel first and recorded it after,
   * so any failure in between leaked a channel nothing could find.
   */
  async create(
    ctx: ModuleContext<TempVcConfig>,
    hub: TempVcHub,
    member: VoiceMember,
  ): Promise<CreateOutcome> {
    const repo = this.#deps.repository;

    const cooldownMs = cooldownMsOf(hub);
    if (cooldownMs > 0 && this.#cooldown) {
      const key = `${COOLDOWN_PREFIX}:${ctx.guildId}:${member.userId}`;
      if (await this.#cooldown.hit(key, cooldownMs)) {
        return {
          refused: 'cooldown',
          detail: `wait ${Math.ceil(cooldownMs / 1000)}s before making another channel`,
        };
      }
    }

    const reservation = await repo.reserve({
      id: this.#id(),
      guildId: ctx.guildId,
      hubChannelId: hub.channelId,
      ownerId: member.userId,
      maxChannelsPerUser: hub.maxChannelsPerUser,
    });

    if ('refused' in reservation) {
      // Already at the cap. Send them to the one they have rather than leaving them in the hub.
      const [existing] = await repo.ownedBy(ctx.guildId, member.userId);
      if (existing?.channelId) {
        await this.move(ctx, member.userId, existing.channelId);
        return { refused: 'moved_existing', detail: `sent to their existing channel` };
      }

      return { refused: 'at_limit', detail: `already has ${reservation.live} channel(s)` };
    }

    const row = reservation.reserved;

    const inherited =
      hub.permissionSync === 'off'
        ? undefined
        : ((await this.#deps.overwritesOf?.(
            ctx.guildId,
            hub.permissionSync === 'creator' ? hub.channelId : (hub.categoryId ?? hub.channelId),
          )) ?? undefined);

    const created = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_channel',
      actorId: member.userId,
      reason: `temporary voice channel for ${member.displayName}`,
      idempotencyKey: `${MODULE_ID}:${row.id}:create`,
      dryRun: false,
      record: false,
      payload: {
        name: renderChannelName(hub.nameTemplate, {
          displayName: member.displayName,
          username: member.username,
          userId: member.userId,
        }),
        type: VOICE_CHANNEL_TYPE,
        ...(hub.categoryId ? { parentId: hub.categoryId } : {}),
        ...(hub.userLimit > 0 ? { userLimit: hub.userLimit } : {}),
        ...(hub.bitrate === undefined ? {} : { bitrate: hub.bitrate }),
        permissionOverwrites: planOverwrites({
          guildId: ctx.guildId,
          botUserId: this.#deps.botUserId,
          ownerId: member.userId,
          privacy: hub.privacy,
          access: [],
          inherited,
        }),
      },
    });

    const channelId =
      created.status === 'executed'
        ? ((created.body as { id?: unknown } | undefined)?.id ?? null)
        : null;

    if (typeof channelId !== 'string') {
      // The reservation is the only thing that exists, so dropping it costs nothing and leaves no
      // row the reconciler would later chase a channel for.
      await repo.abandon(row.id);

      return {
        refused: 'create_failed',
        detail: created.failure?.humanReason ?? `the action ended as ${created.status}`,
      };
    }

    await repo.attach(row.id, channelId);
    await this.move(ctx, member.userId, channelId);
    await this.grantRole(ctx, hub, row.id, member.userId, true);

    if (hub.interfaceEnabled && ctx.config.ownerCommands) {
      await this.postPanel(ctx, hub, { ...row, channelId, status: 'live' });
    }

    return { created: { ...row, channelId, status: 'live' } };
  }

  async move(
    ctx: ModuleContext<TempVcConfig>,
    userId: string,
    channelId: string,
  ): Promise<boolean> {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'move_member',
      actorId: MODULE_ID,
      targetId: userId,
      reason: 'moving a member into their temporary voice channel',
      idempotencyKey: `${MODULE_ID}:${channelId}:move:${userId}`,
      dryRun: false,
      record: false,
      payload: { userId, channelId },
    });

    if (result.status === 'executed' || result.status === 'skipped_duplicate') return true;

    ctx.logger.error(
      `a member could not be moved into their temporary voice channel, so they are still sitting ` +
        `in the hub: ${result.failure?.humanReason ?? `the action ended as ${result.status}`}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId, channelId, code: result.failure?.code },
    );

    return false;
  }

  /** The channel's text chat is the panel's home, which is why no separate channel is needed. */
  async postPanel(
    ctx: ModuleContext<TempVcConfig>,
    hub: TempVcHub,
    row: TempVoiceChannelRow,
  ): Promise<void> {
    if (!row.channelId) return;

    const message = panelMessage({
      hub,
      tempChannelId: row.id,
      ownerCommands: ctx.config.ownerCommands,
      ownerId: row.ownerId,
    });

    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'send',
      actorId: MODULE_ID,
      reason: 'temporary voice channel control panel',
      idempotencyKey: `${MODULE_ID}:${row.id}:panel`,
      dryRun: false,
      record: false,
      payload: {
        channelId: row.channelId,
        content: message.content,
        ...(message.components.length > 0 ? { components: message.components } : {}),
      },
    });

    if (result.status === 'failed_precheck' || result.status === 'failed_api') {
      // Not fatal: /voice still works, so the channel is usable without its panel.
      ctx.logger.warn(
        `the temporary voice channel was made but its control panel could not be posted: ${
          result.failure?.humanReason ?? 'unknown reason'
        }`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, channelId: row.channelId },
      );
    }
  }

  /** Rewrites the channel's whole overwrite set from the database, never patches it. */
  async applyAccess(
    ctx: ModuleContext<TempVcConfig>,
    row: TempVoiceChannelRow,
    privacy: PrivacyMode,
  ): Promise<boolean> {
    if (!row.channelId) return false;

    const access = await this.#deps.repository.access(row.id);

    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'edit_channel',
      actorId: row.ownerId ?? MODULE_ID,
      reason: 'temporary voice channel access changed',
      idempotencyKey: `${MODULE_ID}:${row.id}:access:${this.#now().getTime()}`,
      dryRun: false,
      record: false,
      payload: {
        channelId: row.channelId,
        permissionOverwrites: planOverwrites({
          guildId: ctx.guildId,
          botUserId: this.#deps.botUserId,
          ownerId: row.ownerId,
          privacy,
          access,
        }),
      },
    });

    return result.status === 'executed' || result.status === 'skipped_duplicate';
  }

  async setAccess(
    ctx: ModuleContext<TempVcConfig>,
    row: TempVoiceChannelRow,
    userId: string,
    kind: AccessKind | null,
    privacy: PrivacyMode,
  ): Promise<boolean> {
    if (kind === null) await this.#deps.repository.clearAccess(row.id, userId);
    else await this.#deps.repository.setAccess(row.id, userId, kind);

    const applied = await this.applyAccess(ctx, row, privacy);

    // Blocking somebody sitting in the channel has to remove them too, or the overwrite only stops
    // them coming back.
    if (applied && kind === 'block' && row.channelId) await this.disconnect(ctx, row, userId);

    return applied;
  }

  async disconnect(
    ctx: ModuleContext<TempVcConfig>,
    row: TempVoiceChannelRow,
    userId: string,
  ): Promise<boolean> {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'move_member',
      actorId: row.ownerId ?? MODULE_ID,
      targetId: userId,
      reason: 'removed from a temporary voice channel by its owner',
      idempotencyKey: `${MODULE_ID}:${row.id}:kick:${userId}:${this.#now().getTime()}`,
      dryRun: false,
      record: false,
      // A null channel is Discord's own way of saying "disconnect".
      payload: { userId, channelId: null },
    });

    return result.status === 'executed';
  }

  async rename(
    ctx: ModuleContext<TempVcConfig>,
    row: TempVoiceChannelRow,
    name: string,
  ): Promise<boolean> {
    return this.#edit(ctx, row, { name }, 'rename');
  }

  async setLimit(
    ctx: ModuleContext<TempVcConfig>,
    row: TempVoiceChannelRow,
    userLimit: number,
  ): Promise<boolean> {
    return this.#edit(ctx, row, { userLimit }, 'limit');
  }

  async setRegion(
    ctx: ModuleContext<TempVcConfig>,
    row: TempVoiceChannelRow,
    rtcRegion: string | null,
  ): Promise<boolean> {
    return this.#edit(ctx, row, { rtcRegion }, 'region');
  }

  async #edit(
    ctx: ModuleContext<TempVcConfig>,
    row: TempVoiceChannelRow,
    payload: Record<string, unknown>,
    what: string,
  ): Promise<boolean> {
    if (!row.channelId) return false;

    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'edit_channel',
      actorId: row.ownerId ?? MODULE_ID,
      reason: `temporary voice channel ${what}`,
      idempotencyKey: `${MODULE_ID}:${row.id}:${what}:${this.#now().getTime()}`,
      dryRun: false,
      record: false,
      payload: { channelId: row.channelId, ...payload },
    });

    if (result.status !== 'executed' && result.status !== 'skipped_duplicate') {
      ctx.logger.warn(`temporary voice ${what} refused: ${result.failure?.humanReason ?? '?'}`, {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        channelId: row.channelId,
      });
      return false;
    }

    await this.#deps.repository.touch(row.id);
    return true;
  }

  /** Handing a channel over: the overwrites have to follow the owner or the new one has no rights. */
  async transfer(
    ctx: ModuleContext<TempVcConfig>,
    row: TempVoiceChannelRow,
    toUserId: string,
    privacy: PrivacyMode,
  ): Promise<boolean> {
    await this.#deps.repository.setOwner(row.id, toUserId);

    return this.applyAccess(ctx, { ...row, ownerId: toUserId }, privacy);
  }

  async claim(
    ctx: ModuleContext<TempVcConfig>,
    row: TempVoiceChannelRow,
    byUserId: string,
    privacy: PrivacyMode,
  ): Promise<boolean> {
    const won = await this.#deps.repository.claim(row.id, byUserId);
    if (!won) return false;

    await this.applyAccess(ctx, { ...row, ownerId: byUserId }, privacy);
    return true;
  }

  async grantRole(
    ctx: ModuleContext<TempVcConfig>,
    hub: TempVcHub,
    tempChannelId: string,
    userId: string,
    isOwner: boolean,
  ): Promise<void> {
    const roleId = hub.temporaryRoleId;
    if (!roleId || hub.temporaryRoleMode === 'off') return;
    if (hub.temporaryRoleMode === 'owner' && !isOwner) return;

    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'add_role',
      actorId: MODULE_ID,
      targetId: userId,
      reason: 'joined a temporary voice channel',
      idempotencyKey: `${MODULE_ID}:${tempChannelId}:role:${userId}`,
      dryRun: false,
      record: false,
      payload: { userId, roleId },
    });

    // Recorded only on success, and only by us: a role the member already held is never written
    // here, which is what stops cleanup taking away something they earned elsewhere.
    if (result.status === 'executed') {
      await this.#deps.repository.grantedRole(tempChannelId, userId, roleId);
    }
  }

  async revokeRoles(
    ctx: ModuleContext<TempVcConfig>,
    tempChannelId: string,
    userId: string,
  ): Promise<void> {
    for (const roleId of await this.#deps.repository.takeRole(tempChannelId, userId)) {
      await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'remove_role',
        actorId: MODULE_ID,
        targetId: userId,
        reason: 'left a temporary voice channel',
        idempotencyKey: `${MODULE_ID}:${tempChannelId}:unrole:${userId}:${roleId}`,
        dryRun: false,
        record: false,
        payload: { userId, roleId },
      });
    }
  }

  /**
   * Empty channels are not deleted on the spot. Discord emits a burst of voice states when someone
   * switches channel, and an immediate delete races the rejoin — so a deadline is written and the
   * sweeper re-checks occupancy when it expires.
   */
  async scheduleDelete(
    ctx: ModuleContext<TempVcConfig>,
    hub: TempVcHub,
    row: TempVoiceChannelRow,
  ): Promise<Date | null> {
    if (!hub.autoDeleteEmpty) return null;

    const at = new Date(this.#now().getTime() + delayMsOf(hub));
    await this.#deps.repository.scheduleDelete(row.id, at);

    // Keyed on the row, so a rejoin-then-leave replaces the pending job rather than stacking one.
    await ctx.schedule?.(SWEEP_JOB_ID, at, row.id, { rowId: row.id });

    return at;
  }

  async cancelDelete(ctx: ModuleContext<TempVcConfig>, row: TempVoiceChannelRow): Promise<void> {
    await this.#deps.repository.cancelDelete(row.id);
    await ctx.cancel?.(SWEEP_JOB_ID, row.id);
  }

  /**
   * The one place a temporary channel is removed. Idempotent: the row is moved to `closing` with a
   * predicate-guarded update first, so two sweepers cannot both call Discord, and a 404 is treated
   * as success because the goal is that the channel is gone.
   */
  async destroy(
    ctx: ModuleContext<TempVcConfig>,
    row: TempVoiceChannelRow,
    why: string,
  ): Promise<boolean> {
    const repo = this.#deps.repository;

    if (row.status === 'live' && !(await repo.beginClose(row.id))) return false;

    for (const granted of await repo.rolesGranted(row.id)) {
      await this.revokeRoles(ctx, row.id, granted.userId);
    }

    if (row.channelId) {
      const result = await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'delete_channel',
        actorId: MODULE_ID,
        reason: why,
        idempotencyKey: `${MODULE_ID}:${row.id}:delete`,
        dryRun: false,
        record: false,
        payload: { channelId: row.channelId },
      });

      const gone =
        result.status === 'executed' ||
        result.status === 'skipped_duplicate' ||
        result.failure?.code === 'not_found';

      if (!gone) {
        ctx.logger.error(
          `an empty temporary voice channel could not be removed: ${
            result.failure?.humanReason ?? `the action ended as ${result.status}`
          }`,
          { guildId: ctx.guildId, moduleId: MODULE_ID, channelId: row.channelId },
        );

        // Back to live so the sweeper tries again rather than the row being stuck in `closing`
        // and its owner locked out of ever getting another channel.
        await repo.cancelDelete(row.id);
        await repo.setOwner(row.id, row.ownerId);
        return false;
      }
    }

    await repo.forget(row.id);
    return true;
  }

  hubOf(config: TempVcConfig, row: TempVoiceChannelRow): TempVcHub | undefined {
    return (
      hubFor(config, row.hubChannelId) ?? config.hubs.find((h) => h.channelId === row.hubChannelId)
    );
  }

  permits(hub: TempVcHub, control: OwnerControl): boolean {
    return allows(hub, control);
  }
}

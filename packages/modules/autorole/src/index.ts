import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { AUTOROLE_SCHEMA_VERSION, autoroleConfigSchema, autoroleDefaultConfig } from './config.ts';
import { type AutoroleDeps, createStickyListener } from './listeners.ts';
import { autorolePresetRules } from './rules.ts';

export {
  AUTOROLE_SCHEMA_VERSION,
  type AutoroleConfig,
  autoroleConfigSchema,
  autoroleDefaultConfig,
  MAX_STICKY_ROLES,
} from './config.ts';
export { DrizzleStickyRoleStore } from './drizzle-store.ts';
export {
  AUTOROLE_ACTOR,
  AUTOROLE_EVENT_TYPES,
  AUTOROLE_MODULE_ID,
  type AutoroleDeps,
  createStickyListener,
} from './listeners.ts';
export { planRestore, type RestorePlan } from './restore.ts';
export { autorolePresetRules, autoroleRuleId, autoroleRules } from './rules.ts';
export type { StickyRoleStore } from './store.ts';

/**
 * Autorole and sticky roles (PLAN.md §8, Phase 3).
 *
 * One module rather than two because they are the same question asked at two
 * moments — "what roles should this member have on arrival?" — and they have to
 * agree. Split apart, a guild could configure an autorole that sticky roles then
 * refused to restore, and neither module would be in a position to notice.
 *
 * The two halves are implemented differently on purpose, and the contrast is the
 * point of the module:
 *
 *  - **Autorole is preset rules.** Trigger, no conditions, one action — entirely
 *    within §4-P2's vocabulary, so expressing it any other way would hide it from
 *    the rules table and from the rule builder later. See `rules.ts`.
 *  - **Sticky roles is a listener.** Restoring reads per-member state, filters it
 *    against a hierarchy that may have moved, and reports what it refused. The
 *    action vocabulary cannot say that, and widening it to fit is what `antiraid`
 *    records declining to do. See `listeners.ts`.
 *
 * A factory rather than a constant because the snapshot needs somewhere to live
 * and §7's `ModuleContext` has no storage port — the same gap `logging` and
 * `backup` work around. Built with no deps it is still a complete, renderable
 * manifest, and it reports its own unwiring by name rather than going quiet.
 */
export function createAutoroleModule(
  deps: AutoroleDeps = {},
): ModuleManifest<typeof autoroleConfigSchema> {
  return {
    id: 'autorole',
    name: 'Autorole & sticky roles',
    category: 'utility',
    configSchema: autoroleConfigSchema,
    defaultConfig: autoroleDefaultConfig,
    schemaVersion: AUTOROLE_SCHEMA_VERSION,

    /**
     * GUILD_MEMBERS is privileged and both halves are nothing without it: without
     * it neither GUILD_MEMBER_ADD nor GUILD_MEMBER_UPDATE is dispatched, so no
     * member is ever granted a role and no snapshot is ever taken. Declaring it
     * means the registry disables the module with the intent named and the portal
     * toggle to flip (§7), rather than a guild discovering the silence when a
     * member complains their roles vanished.
     */
    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],

    /**
     * MANAGE_ROLES as a hard gate, unlike `cases`, which keeps ban rights out of
     * its requirements so a guild does not lose its moderation history for never
     * granting them. The asymmetry is deliberate: this module does exactly one
     * thing and MANAGE_ROLES is the permission it needs to do any of it. A guild
     * that has not granted it gets a module that is off with a reason, which
     * beats one that is on and silently does nothing.
     */
    requiredPermissions: [Permissions.ManageRoles],

    listeners: [createStickyListener(deps)],
    rules: autorolePresetRules,
    migrations: [],

    dashboard: {
      icon: 'user-plus',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        { id: 'autorole', title: 'Roles on join', fields: ['autoroleIds'] },
        { id: 'sticky', title: 'Sticky roles', fields: ['stickyEnabled', 'stickyRoleIds'] },
      ],
    },
  };
}

/** The module as the registry and dashboard see it, with no store bound. */
export const autoroleModule: ModuleManifest<typeof autoroleConfigSchema> = createAutoroleModule();

export default autoroleModule;

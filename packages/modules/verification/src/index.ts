import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { verificationCommands } from './commands.ts';
import {
  VERIFICATION_SCHEMA_VERSION,
  verificationConfigSchema,
  verificationDefaultConfig,
} from './config.ts';
import type { VerificationDeps } from './deps.ts';
import { createJoinGateListener } from './listeners.ts';

export {
  quarantineCommand,
  unquarantineCommand,
  verificationCommands,
  verifyCommand,
} from './commands.ts';
export {
  VERIFICATION_SCHEMA_VERSION,
  type VerificationConfig,
  verificationConfigSchema,
  verificationDefaultConfig,
} from './config.ts';
export {
  type BindResult,
  type BoundGateDeps,
  type BoundQuarantineDeps,
  bindGateDeps,
  bindQuarantineDeps,
  describeUnbound,
  type VerificationDeps,
} from './deps.ts';
export {
  handleJoin,
  type JoinFacts,
  type JoinGateOutcome,
  planVerification,
  readJoin,
  runVerify,
} from './gate.ts';
export { createJoinGateListener, VERIFICATION_EVENT_TYPES } from './listeners.ts';
export {
  MESSAGE_MAX,
  MODULE_ID,
  REASON_MAX,
  runSteps,
  type StepReport,
  succeeded,
  VERIFICATION_ACTOR,
} from './perform.ts';
export { runQuarantine, runRelease } from './quarantine.ts';
export {
  checkGrantable,
  planQuarantine,
  planRelease,
  type QuarantinePlan,
  type ReleasePlan,
  type RoleCheck,
  type RoleStep,
} from './roles.ts';
export {
  QUARANTINE_PREFIX,
  type QuarantineRecord,
  type QuarantineStore,
  quarantineKey,
  quarantineRecordSchema,
  RedisQuarantineStore,
} from './store.ts';

/**
 * Gated access and quarantine (PLAN.md §8, Phase 2).
 *
 * A factory rather than a constant because §7's `ModuleContext` carries a guild
 * id, a config, an executor and a logger and nothing else — no role snapshot, no
 * member lookup, nowhere to record what a quarantine took away. The ports are
 * declared in `deps.ts` and bound by whatever process runs modules, exactly as
 * `createLoggingModule({ store })` and `createAntinukeModule` do. When the
 * framework grows a port for these, this becomes a plain constant.
 *
 * Two design choices worth stating outright:
 *
 *  - **The gate prefers Discord's role-granting invites (§10.5).** An invite
 *    carrying `role_ids` applies the unverified role at the instant of joining,
 *    so there is no window between the join and the bot's REST call for a script
 *    to act in. The join listener detects that from the roles already on the
 *    GUILD_MEMBER_ADD dispatch and does nothing when it sees them; the
 *    bot-applies-after-join path is the fallback for joins no invite covered.
 *  - **Quarantine records before it strips.** The prior-role set is written to
 *    the store before the first `remove_role`, and every removal carries the same
 *    set in its payload so the case ledger holds a durable second copy. Lockdown
 *    records `previousAllow`/`previousDeny` for the same reason: a swap you
 *    cannot undo exactly is a swap that rewrites a server's access (R4).
 *
 * Remaining limitations, all in `packages/core` and all outside a module's
 * remit. The join gate itself is live: `apps/worker`'s `ModuleListenerRuntime`
 * drives `manifest.listeners`, and `apps/worker/src/index.ts` binds every port.
 *
 *  1. **`runPrechecks` has the wrong hierarchy rule for `add_role`/`remove_role`.**
 *     `TARGETS_MEMBER` marks both true, so I8 compares the *target member's*
 *     highest role against the bot's. Discord's actual rule for role assignment
 *     is about the role being moved — "a bot can grant roles to other users that
 *     are of a lower position than its own highest role" — and says nothing about
 *     the target's own roles. So core is simultaneously too strict (it refuses to
 *     give a low role to a senior member, which Discord permits) and too lax (it
 *     lets through a grant of a role above the bot, which Discord refuses with a
 *     bare 403 naming nothing). The fix is `PrecheckInput` carrying the granted
 *     role's position for those two kinds. Until then `checkGrantable` in
 *     `roles.ts` does it here, where at least the refusal can name the role, both
 *     positions and the remedy.
 *  2. **`ModuleContext` has no storage port.** The quarantine record therefore
 *     lives behind a module-declared `QuarantineStore`, bound at construction.
 *     The same gap forced `createLoggingModule({ store })`.
 *  3. **A quarantine record cannot be read back from the case ledger.** Every
 *     `remove_role` carries `priorRoleIds` in its payload and the recorder stores
 *     it verbatim, but no module can query cases, so that copy is readable by a
 *     human and not by `/unquarantine`. Closing blocker 2 with a case-query port
 *     would make the Redis store a cache rather than the system of record.
 */
export function createVerificationModule(
  deps: VerificationDeps = {},
): ModuleManifest<typeof verificationConfigSchema> {
  return {
    id: 'verification',
    name: 'Verification',
    category: 'security',
    configSchema: verificationConfigSchema,
    defaultConfig: verificationDefaultConfig,
    schemaVersion: VERIFICATION_SCHEMA_VERSION,

    /**
     * GUILD_MEMBERS is privileged and the gate is nothing without it: without the
     * intent GUILD_MEMBER_ADD is never dispatched, so no join is ever seen and
     * every member walks in ungated while the module reports itself healthy.
     * Declaring it means the registry disables the module with the intent named
     * and the portal toggle to flip (§7).
     */
    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],

    /**
     * MANAGE_ROLES and nothing else. Every operation this module performs is a
     * role moving on or off a member, and there is no path through it that needs
     * to ban, kick, time out or read a message. Requiring anything more would
     * disable verification in servers that correctly declined to grant it.
     */
    requiredPermissions: [Permissions.ManageRoles],

    commands: verificationCommands(deps),
    listeners: [createJoinGateListener(deps)],

    migrations: [],

    dashboard: {
      icon: 'shield-check',
      sections: [
        {
          id: 'gate',
          title: 'Verification gate',
          fields: ['enabled', 'unverifiedRoleId', 'verifiedRoleId', 'applyUnverifiedOnJoin'],
        },
        { id: 'quarantine', title: 'Quarantine', fields: ['quarantineRoleId'] },
      ],
    },
  };
}

/**
 * The module as the registry and dashboard see it, with no ports bound.
 *
 * Safe because `enabled` defaults to false and no role is configured: a guild
 * that has not set this up gets nothing at all. One that has enabled it gets an
 * error naming exactly which port is unwired rather than silence (§1, §7).
 */
export const verificationModule: ModuleManifest<typeof verificationConfigSchema> =
  createVerificationModule();

export default verificationModule;

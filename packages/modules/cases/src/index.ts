import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  CASES_SCHEMA_VERSION,
  casesConfigSchema,
  casesDefaultConfig,
  casesFormSchema,
} from './config.ts';
import { casesPresetRules } from './escalation.ts';

export {
  CASES_SCHEMA_VERSION,
  type CasesConfig,
  casesConfigSchema,
  casesDefaultConfig,
  casesFormSchema,
  ESCALATION_ACTIONS,
  type EscalationAction,
  type EscalationRung,
  escalationLadderSchema,
  escalationRungSchema,
} from './config.ts';
export { casesPresetRules, escalationRuleId, escalationRules } from './escalation.ts';

/**
 * Case management (PLAN.md §8, Phase 1).
 *
 * What this manifest carries today is the warn-escalation ladder, compiled to
 * ordinary preset rules. `/case`, `/history`, `/reason` and the WARN action are
 * **not** here, and their absence is a framework gap rather than an oversight —
 * see the blockers recorded below. Shipping a command whose handler cannot reach
 * the data it exists to show would be the "the bot did nothing" outcome §1 and
 * §7 exist to eliminate, so they are withheld until the gap is closed.
 *
 * Known blockers, all in `packages/core` and all outside a module's remit:
 *
 *  1. `ModuleContext` has no read port. §7 gives a manifest `migrations` so a
 *     module owns its own tables, but nothing in the context can query them, so
 *     no module can read back what it wrote. `/case`, `/history` and `/reason`
 *     all need it.
 *  2. There is no `warn` in `ACTION_KINDS`. A warn is a ledger-only state change
 *     — a case row and no REST call — and the executor's pipeline assumes every
 *     kind maps to a Discord endpoint. Recording a warn outside the executor
 *     would violate I1.
 *  3. Modules cannot publish. `moderation.warned` exists in `EVENT_TYPES` and
 *     these rules trigger on it, but no module holds an `EventBus`, so nothing
 *     can emit it and the ladder below can never fire.
 */
export const casesModule: ModuleManifest<typeof casesConfigSchema> = {
  id: 'cases',
  name: 'Cases',
  category: 'moderation',
  configSchema: casesConfigSchema,
  // The ladder is an array of objects, outside the v1 form vocabulary (§9). It
  // stays in config — per-guild data validated on every read/write (I5) and
  // diffed for the audit trail (I7) — and the dashboard gives it a bespoke
  // editor, as §9 says the rule builder will get.
  formSchema: casesFormSchema,
  defaultConfig: casesDefaultConfig,
  schemaVersion: CASES_SCHEMA_VERSION,
  // Non-privileged. Cases are recorded from Proton's own actions, not from
  // watching members, so neither Server Members nor Message Content is needed.
  requiredIntents: [GatewayIntentBits.Guilds],
  /**
   * Only what the module always needs: reading a channel and posting in it.
   *
   * Not ModerateMembers/KickMembers/BanMembers, even though a ladder rung can
   * ask for all three. `requiredPermissions` is a hard gate — the registry
   * disables the module outright when one is missing — and gating case
   * management on ban rights would take away a guild's moderation history
   * because it never grants bans. A rung the bot cannot perform fails at the
   * executor's precheck instead, which names the missing permission and where
   * (I8), which is the right layer for a per-rung requirement.
   */
  requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
  rules: casesPresetRules,
  migrations: [],
  dashboard: {
    icon: 'gavel',
    sections: [
      { id: 'general', title: 'General', fields: ['enabled', 'historyLimit'] },
      {
        id: 'escalation',
        title: 'Warn escalation',
        // `escalationLadder` is listed so the section owns it, but no generated
        // descriptor will ever appear for it (§9). The dashboard renders this
        // section with a bespoke ladder editor.
        fields: ['escalationWindow', 'escalationLadder'],
      },
    ],
  },
};

export default casesModule;

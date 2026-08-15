import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { rolemenuCommands } from './commands.ts';
import {
  ROLEMENU_SCHEMA_VERSION,
  rolemenuConfigSchema,
  rolemenuDefaultConfig,
  rolemenuFormSchema,
} from './config.ts';
import type { RolemenuDeps } from './deps.ts';
import { createComponentListener, createReactionListener } from './listeners.ts';

export { rolemenuCommand, rolemenuCommands } from './commands.ts';
export {
  BINDING_KEY_MAX,
  BINDING_LABEL_MAX,
  findMenu,
  MAX_BINDINGS_PER_MENU,
  MAX_MENUS,
  MENU_ID_MAX,
  ROLEMENU_KINDS,
  ROLEMENU_MODES,
  ROLEMENU_SCHEMA_VERSION,
  type RolemenuBinding,
  type RolemenuConfig,
  type RolemenuKind,
  type RolemenuMenu,
  type RolemenuMode,
  rolemenuBindingSchema,
  rolemenuConfigSchema,
  rolemenuDefaultConfig,
  rolemenuFormSchema,
  rolemenuMenuSchema,
  rolemenuMenusSchema,
} from './config.ts';
export {
  CUSTOM_ID_PREFIX,
  CUSTOM_ID_SEPARATOR,
  encodeCustomId,
  hasRolemenuPrefix,
  parseCustomId,
  type RolemenuCustomId,
  SELECT_BINDING_KEY,
} from './custom-id.ts';
export {
  type BindResult,
  type BoundComponentDeps,
  type BoundReactionDeps,
  bindComponentDeps,
  bindReactionDeps,
  describeUnbound,
  type RolemenuDeps,
} from './deps.ts';
export {
  type ComponentFacts,
  type ComponentOutcome,
  handleComponent,
  readComponent,
} from './interactions.ts';
export {
  COMPONENT_EVENT_TYPES,
  createComponentListener,
  createReactionListener,
  REACTION_EVENT_TYPES,
  ROLEMENU_EVENT_TYPES,
} from './listeners.ts';
export {
  buildButtonRows,
  buildComponents,
  buildSelectRow,
  type MessageComponent,
} from './message.ts';
export {
  describeReport,
  MESSAGE_MAX,
  MODULE_ID,
  REASON_MAX,
  type RoleChangeReport,
  runRoleChanges,
  succeeded,
} from './perform.ts';
export {
  handleReaction,
  type ReactionFacts,
  type ReactionOutcome,
  readReaction,
} from './reactions.ts';
export {
  type ResolveInput,
  ROLEMENU_INTENTS,
  type RoleChanges,
  type RolemenuIntent,
  resolveRoleChanges,
} from './resolve.ts';

/**
 * Reaction, button and dropdown roles (PLAN.md §8, Phase 3 — slice 3.E).
 *
 * A factory rather than a constant because §7's `ModuleContext` carries a guild
 * id, a config, an executor and a logger and nothing else — in particular, no
 * answer to "who am I", which both halves of this module need for different
 * reasons (`deps.ts` states them). The ports are bound by whatever process runs
 * modules, exactly as `createPhishingModule({ botUserId })` does. When the
 * framework grows an identity on `ModuleContext`, this becomes a plain constant.
 *
 * Three design choices worth stating outright:
 *
 *  - **Legacy components, no `IS_COMPONENTS_V2`.** Verified August 2026: action
 *    rows, buttons and string selects still work without the flag, and the flag
 *    disables `content` and `embeds` — so taking it would stop a guild putting a
 *    sentence above its own role menu, and buy nothing in return.
 *  - **A `custom_id` is namespaced, and the parser is strict.**
 *    `interaction.component` carries every component press in the guild, so this
 *    module is handed other modules' buttons and they are handed its.
 *    `parseCustomId` refuses everything it does not positively recognise, and the
 *    handler returns *before acknowledging* when it does — an interaction may be
 *    acknowledged once, and answering someone else's button would consume the
 *    acknowledgement their handler needed.
 *  - **Direction comes from the event for reactions and from state for
 *    components.** Discord says separately that a reaction was added or removed,
 *    so an un-react puts the role down; a button press carries no direction at
 *    all, so it flips against what the member holds. Collapsing the two into one
 *    "toggle" would make un-reacting hand the role back to anyone who had lost it
 *    elsewhere.
 *
 * Two limitations, both recorded rather than worked around:
 *
 *  1. **A role above Proton is caught by Discord, not by the prechecks.**
 *     `runPrechecks` compares the *target member's* highest role against the
 *     bot's, which is the right check for a ban and an incomplete one for a role
 *     grant: a member holding nothing but `@everyone` passes it, and the grant
 *     still fails because the *role being handed out* sits above Proton. Closing
 *     that means `PrecheckInput` carrying the granted role's position, which is
 *     core's job and is already recorded as a blocker on
 *     `createVerificationModule`. Until then the refusal arrives as Discord's 403
 *     — and every path in this module carries the executor's `humanReason`
 *     through verbatim, so the member is told rather than left guessing.
 *  2. **A menu's message id is copied in by hand.** `/rolemenu` posts the message
 *     but the executor returns a case id, not a Discord message id, so the module
 *     cannot record where it put it. Until an action result carries the created
 *     message, the command says so in its own reply rather than posting a second
 *     copy every time it is run.
 */
export function createRolemenuModule(
  deps: RolemenuDeps = {},
): ModuleManifest<typeof rolemenuConfigSchema> {
  return {
    id: 'rolemenu',
    name: 'Role menus',
    category: 'engagement',
    configSchema: rolemenuConfigSchema,
    // `menus` is an array of objects, outside the v1 form vocabulary (§9). It
    // stays in config — per-guild data validated on every read/write (I5) and
    // diffed for the audit trail (I7) — and the dashboard gives it a bespoke
    // editor, exactly as the escalation ladder has.
    formSchema: rolemenuFormSchema,
    defaultConfig: rolemenuDefaultConfig,
    schemaVersion: ROLEMENU_SCHEMA_VERSION,

    /**
     * GuildMessageReactions is not privileged, and reaction menus are nothing
     * without it: MESSAGE_REACTION_ADD is simply never dispatched, so every
     * reaction on every menu is silently discarded while the module reports
     * itself healthy. Declaring it means the registry disables the module with
     * the intent named and the portal toggle to flip (§7).
     *
     * Button and dropdown menus need no intent at all — INTERACTION_CREATE is
     * delivered to the app that owns the component regardless — but the intent is
     * declared unconditionally because it is a property of the module, not of one
     * guild's menus, and a per-guild intent is not a thing that exists.
     */
    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],

    /**
     * MANAGE_ROLES and nothing else. Every effect this module has is a role
     * moving on or off the member who asked for it.
     *
     * Not SEND_MESSAGES or ADD_REACTIONS, even though `/rolemenu` needs both.
     * `requiredPermissions` is a hard gate — the registry disables the module
     * outright when one is missing — and gating self-service roles on the ability
     * to post would take the feature away from a guild that runs its menus in a
     * channel Proton cannot write to, which is a perfectly reasonable setup once
     * the menu is posted. `/rolemenu` fails at the executor's precheck instead,
     * which names the missing permission and the channel (I8).
     */
    requiredPermissions: [Permissions.ManageRoles],

    commands: rolemenuCommands,
    listeners: [createReactionListener(deps), createComponentListener(deps)],

    migrations: [],

    dashboard: {
      icon: 'list-checks',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        {
          id: 'menus',
          title: 'Menus',
          // Listed so the section owns it, but no generated descriptor will ever
          // appear for it (§9). The dashboard renders this section with a
          // bespoke menu editor.
          fields: ['menus'],
        },
      ],
    },
  };
}

/**
 * The module as the registry and dashboard see it, with no ports bound.
 *
 * Safe because `enabled` defaults to false and no menu is configured: a guild
 * that has not set this up gets nothing at all. One that has enabled it gets an
 * error naming exactly which port is unwired — and, on the component path, an
 * ephemeral answer rather than a failed interaction (§1, §7).
 */
export const rolemenuModule: ModuleManifest<typeof rolemenuConfigSchema> = createRolemenuModule();

export default rolemenuModule;

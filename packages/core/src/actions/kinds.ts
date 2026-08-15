import { Permissions } from '../permissions/bits.ts';

/**
 * Every state change Proton can make (PLAN.md §4-P3, widened for Gate 1).
 *
 * The union is the source of truth. `REQUIRED_PERMISSIONS`, `TARGETS_MEMBER`
 * and the executor's payload switch are all `Record<ActionKind, …>` or
 * exhaustive switches, so adding a kind makes the compiler name every place
 * that must account for it. A kind cannot ship half-wired.
 */
export const ACTION_KINDS = [
  'send',
  'edit_message',
  'delete_message',
  'add_reaction',
  'interaction_reply',
  'interaction_followup',
  'warn',
  'ban',
  'unban',
  'kick',
  'timeout',
  'untimeout',
  'add_role',
  'remove_role',
  'purge',
  'slowmode',
  'lockdown',
  'unlock',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * Narrow a string read back from storage.
 *
 * `scheduled_actions.kind` is a text column written by a possibly older build,
 * so it is a claim about an action kind rather than one of ours.
 */
export function isActionKind(value: string): value is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(value);
}

/**
 * What the bot must be able to do for each kind.
 *
 * `interaction_reply` is deliberately zero: Discord always permits an app to
 * answer its own interaction, even in a channel it could not otherwise post in.
 * Requiring SendMessages there would refuse legitimate replies — including the
 * reply explaining why some *other* action was refused.
 */
export const REQUIRED_PERMISSIONS: Record<ActionKind, bigint> = {
  send: Permissions.ViewChannel | Permissions.SendMessages,

  /**
   * Editing a message Proton itself sent needs nothing beyond seeing the channel
   * — Discord only gates editing *another* app's message, and it gates that by
   * refusing outright rather than by a permission. Every Phase 3 edit is
   * starboard updating its own post.
   */
  edit_message: Permissions.ViewChannel,

  /**
   * Deliberately over-gated, and worth saying why rather than discovering it.
   *
   * Deleting your own message needs no permission at all, and every Phase 3
   * deletion is starboard removing its own post. Requiring MANAGE_MESSAGES
   * anyway keeps one rule for the kind instead of a payload flag that decides
   * how strict the precheck is — a flag a caller could set wrongly and thereby
   * delete someone else's message with no precheck at all. Any guild running a
   * starboard grants it, so the cost is a precheck failure that names a
   * permission the guild was going to need regardless.
   */
  delete_message: Permissions.ManageMessages,

  add_reaction: Permissions.ViewChannel | Permissions.ReadMessageHistory | Permissions.AddReactions,

  /**
   * Both interaction paths are zero: Discord always permits an app to answer its
   * own interaction, even in a channel it could not otherwise post in. Requiring
   * SendMessages there would refuse legitimate replies — including the reply
   * explaining why some *other* action was refused.
   */
  interaction_reply: 0n,
  interaction_followup: 0n,

  /**
   * A warn is a ledger row and nothing else — no REST call, so no permission.
   * The hierarchy and owner prechecks still apply (see `TARGETS_MEMBER`), which
   * is the part that actually matters: Proton should no more warn the owner than
   * ban them.
   */
  warn: 0n,

  ban: Permissions.BanMembers,
  unban: Permissions.BanMembers,
  kick: Permissions.KickMembers,
  timeout: Permissions.ModerateMembers,
  untimeout: Permissions.ModerateMembers,

  add_role: Permissions.ManageRoles,
  remove_role: Permissions.ManageRoles,

  // Bulk delete needs history access to see what it is deleting.
  purge: Permissions.ManageMessages | Permissions.ReadMessageHistory,
  slowmode: Permissions.ManageChannels,

  // Channel overwrites are governed by MANAGE_ROLES, not MANAGE_CHANNELS.
  lockdown: Permissions.ManageRoles,
  unlock: Permissions.ManageRoles,
};

/**
 * Whether the kind acts on a guild member, and so needs the hierarchy, owner
 * and self prechecks (I8).
 *
 * `unban` is false on purpose: a banned user is not a member, has no roles in
 * the guild, and there is no hierarchy to respect. Marking it true would make
 * every unban fail closed on an unresolvable member.
 */
export const TARGETS_MEMBER: Record<ActionKind, boolean> = {
  send: false,
  edit_message: false,
  delete_message: false,
  add_reaction: false,
  interaction_reply: false,
  interaction_followup: false,

  /**
   * True even though a warn issues no REST call.
   *
   * The hierarchy, owner and self prechecks are not about what Discord will
   * permit — they are about what Proton should be willing to do (I8, and §15's
   * "refuse to act on owner/self/above-role targets"). A moderator warning the
   * guild owner, or the bot warning itself off its own escalation ladder, are
   * both things to refuse with a named reason rather than record.
   */
  warn: true,

  ban: true,
  unban: false,
  kick: true,
  timeout: true,
  untimeout: true,
  add_role: true,
  remove_role: true,

  purge: false,
  slowmode: false,
  lockdown: false,
  unlock: false,
};

/**
 * Kinds that undo another kind.
 *
 * A kind absent here cannot carry an `expiresAt`: the executor refuses the
 * request rather than performing an action nothing will ever lift.
 * `planReversal` translates each pairing's payload.
 */
export const REVERSAL_OF: Partial<Record<ActionKind, ActionKind>> = {
  ban: 'unban',
  timeout: 'untimeout',
  add_role: 'remove_role',
  lockdown: 'unlock',
};

export function requiredPermissionsFor(kind: ActionKind): bigint {
  return REQUIRED_PERMISSIONS[kind];
}

export function targetsMember(kind: ActionKind): boolean {
  return TARGETS_MEMBER[kind];
}

export function reversalOf(kind: ActionKind): ActionKind | undefined {
  return REVERSAL_OF[kind];
}

/**
 * Kinds whose effect is destructive and so default to dry-run in dev (I12).
 *
 * `delete_message` is deliberately absent. I12 names bans, kicks and
 * channel/role deletion — irreversible acts against a guild or its members.
 * Every Phase 3 deletion is starboard retracting its own post when a message
 * falls back below the star threshold, and dry-running that would leave stale
 * board posts behind in every development guild while the tests reported
 * success. `purge` stays, because it deletes other people's messages.
 */
export const DESTRUCTIVE_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'ban',
  'kick',
  'purge',
  'lockdown',
]);

export function isDestructive(kind: ActionKind): boolean {
  return DESTRUCTIVE_KINDS.has(kind);
}

/**
 * Kinds the executor records without calling Discord at all.
 *
 * A warn is a state change in Proton's ledger and nowhere else: there is no
 * Discord endpoint for "this member has been warned". It still goes through the
 * executor because I1 admits no exceptions and because everything the executor
 * provides — the prechecks, the idempotency key, the `cases` row, the audit
 * attribution — is exactly what a warn needs. What it does not need is a REST
 * call, so `toRestCall` returns no call for it and the executor skips the
 * request rather than inventing an endpoint to POST nothing to.
 *
 * Kept as a set rather than a boolean on the payload so it cannot be set per
 * request: whether a kind touches Discord is a property of the kind.
 */
export const LEDGER_ONLY_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(['warn']);

export function isLedgerOnly(kind: ActionKind): boolean {
  return LEDGER_ONLY_KINDS.has(kind);
}

/**
 * I12 as one function: destructive kinds are planned and recorded but not
 * performed outside production.
 *
 * This lived in `moderation` alone through Phase 1, and I3 (modules never import
 * modules) meant every Phase 2 module that could ban or kick had to copy it —
 * six identical copies by the end of the phase. Duplication of the *list* was
 * never the risk, since all six read `isDestructive` from here; duplication of
 * the *policy* was, because the whole point of I12 is that it is uniform. Six
 * copies is six places to forget when the rule changes.
 *
 * `env` is a parameter rather than a read of `process.env` inside, so a test can
 * pin the environment explicitly instead of inheriting whatever the runner set.
 * Note what this does not cover: `add_role` and `remove_role` are not
 * destructive, so a role strip or a quarantine runs for real in development —
 * which is intended. Withholding them would leave the reversible half of
 * anti-nuke and verification untested everywhere it is safe to test.
 */
export function dryRunFor(
  kind: ActionKind,
  env: string | undefined = process.env.NODE_ENV,
): boolean {
  return isDestructive(kind) && env !== 'production';
}

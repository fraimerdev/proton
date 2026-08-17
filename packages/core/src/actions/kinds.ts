import { Permissions } from '../permissions/bits.ts';

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
  'create_channel',
  'create_role',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export function isActionKind(value: string): value is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(value);
}

export const REQUIRED_PERMISSIONS: Record<ActionKind, bigint> = {
  send: Permissions.ViewChannel | Permissions.SendMessages,

  edit_message: Permissions.ViewChannel,

  // Over-gated on purpose: deleting your own message needs nothing, but one rule beats a flag.
  delete_message: Permissions.ManageMessages,

  add_reaction: Permissions.ViewChannel | Permissions.ReadMessageHistory | Permissions.AddReactions,

  interaction_reply: 0n,
  interaction_followup: 0n,

  warn: 0n,

  ban: Permissions.BanMembers,
  unban: Permissions.BanMembers,
  kick: Permissions.KickMembers,
  timeout: Permissions.ModerateMembers,
  untimeout: Permissions.ModerateMembers,

  add_role: Permissions.ManageRoles,
  remove_role: Permissions.ManageRoles,

  purge: Permissions.ManageMessages | Permissions.ReadMessageHistory,
  slowmode: Permissions.ManageChannels,

  lockdown: Permissions.ManageRoles,
  unlock: Permissions.ManageRoles,

  create_channel: Permissions.ManageChannels,
  create_role: Permissions.ManageRoles,
};

export const TARGETS_MEMBER: Record<ActionKind, boolean> = {
  send: false,
  edit_message: false,
  delete_message: false,
  add_reaction: false,
  interaction_reply: false,
  interaction_followup: false,

  // True despite issuing no REST call: I8 is about what Proton will do, not what Discord permits.
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

  create_channel: false,
  create_role: false,
};

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

export const DESTRUCTIVE_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'ban',
  'kick',
  'purge',
  'lockdown',
]);

export function isDestructive(kind: ActionKind): boolean {
  return DESTRUCTIVE_KINDS.has(kind);
}

export const LEDGER_ONLY_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(['warn']);

export function isLedgerOnly(kind: ActionKind): boolean {
  return LEDGER_ONLY_KINDS.has(kind);
}

export function dryRunFor(
  kind: ActionKind,
  env: string | undefined = process.env.NODE_ENV,
  allowDestructive: string | undefined = process.env.PROTON_ALLOW_DESTRUCTIVE,
): boolean {
  if (!isDestructive(kind)) return false;
  if (env === 'production') return false;
  // The deliberate escape hatch: exercising a real ban against the test guild needs I12 off for
  // one run, and flipping NODE_ENV to do it changes far more than the dry-run rail.
  return allowDestructive !== 'true';
}

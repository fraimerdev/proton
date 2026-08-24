import { Permissions } from '../permissions/bits.ts';
import {
  createChannelPayloadSchema,
  createThreadPayloadSchema,
  editChannelPayloadSchema,
  sendPayloadSchema,
  THREAD_TYPE_PUBLIC,
} from './payloads.ts';

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
  'delete_channel',
  'edit_channel',
  'create_thread',
  'move_member',
  'end_poll',
  'pin_message',
  'automod_rule_create',
  'automod_rule_update',
  'automod_rule_delete',
  'giveaway_draw',
  'create_dm',
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
  delete_channel: Permissions.ManageChannels,
  edit_channel: Permissions.ManageChannels,

  create_thread: Permissions.ViewChannel,

  move_member: Permissions.MoveMembers | Permissions.Connect,

  end_poll: Permissions.ViewChannel,
  pin_message: Permissions.PinMessages,

  // Not ManageMessages: Discord gates the whole auto-moderation surface, reads included, on
  // Manage Server alone.
  automod_rule_create: Permissions.ManageGuild,
  automod_rule_update: Permissions.ManageGuild,
  automod_rule_delete: Permissions.ManageGuild,
  giveaway_draw: 0n,
  // A DM needs no guild permission — the recipient's privacy settings are the only gate.
  create_dm: 0n,
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
  delete_channel: false,
  edit_channel: false,
  create_thread: false,

  move_member: true,

  end_poll: false,
  pin_message: false,

  automod_rule_create: false,
  automod_rule_update: false,
  automod_rule_delete: false,
  giveaway_draw: false,
  // Not a member action: a DM has no role hierarchy, and flagging it would refuse to message a
  // winner who outranks the bot.
  create_dm: false,
};

export const CHANNEL_SCOPED: Record<ActionKind, boolean> = {
  send: true,
  edit_message: true,
  delete_message: true,
  add_reaction: true,

  // False despite landing in a channel: the interaction token authorises the response by itself.
  interaction_reply: false,
  interaction_followup: false,

  warn: false,

  ban: false,
  unban: false,
  kick: false,
  timeout: false,
  untimeout: false,
  add_role: false,
  remove_role: false,

  purge: true,
  slowmode: true,
  lockdown: true,
  unlock: true,

  create_channel: false,
  create_role: false,
  delete_channel: true,
  edit_channel: true,
  create_thread: true,

  // The destination, not the channel the command was typed in — Discord refuses the move unless
  // the bot could connect there itself, so that is the channel the precheck has to judge.
  move_member: true,

  end_poll: true,
  pin_message: true,

  automod_rule_create: false,
  automod_rule_update: false,
  automod_rule_delete: false,
  giveaway_draw: false,
  create_dm: false,
};

export function isChannelScoped(kind: ActionKind): boolean {
  return CHANNEL_SCOPED[kind];
}

export const REVERSAL_OF: Partial<Record<ActionKind, ActionKind>> = {
  ban: 'unban',
  timeout: 'untimeout',
  add_role: 'remove_role',
  lockdown: 'unlock',
};

// Discord refuses an overwrite that hands out a permission the bot does not itself hold, so the
// bits being granted are part of what the action requires — without this the precheck passes and
// the 403 that follows names nothing.
function grantedBits(overwrites: ReadonlyArray<{ allow?: string | undefined }>): bigint {
  let granted = 0n;
  for (const overwrite of overwrites) granted |= BigInt(overwrite.allow ?? '0');
  return granted;
}

export const PAYLOAD_PERMISSIONS: Partial<Record<ActionKind, (payload: unknown) => bigint>> = {
  send: (payload) => {
    const parsed = sendPayloadSchema.safeParse(payload);
    if (!parsed.success) return 0n;

    return (
      (parsed.data.poll !== undefined ? Permissions.SendPolls : 0n) |
      // Without this the precheck passes and Discord refuses the message instead, which is the
      // "the bot did nothing" failure §7 exists to kill.
      (parsed.data.embeds?.length ? Permissions.EmbedLinks : 0n) |
      (parsed.data.files?.length ? Permissions.AttachFiles : 0n)
    );
  },

  // Discord refuses to let a bot hand out permissions it may not manage, so a private ticket
  // channel needs ManageRoles as well as ManageChannels.
  create_channel: (payload) => {
    const parsed = createChannelPayloadSchema.safeParse(payload);
    if (!parsed.success || parsed.data.permissionOverwrites === undefined) return 0n;

    return Permissions.ManageRoles | grantedBits(parsed.data.permissionOverwrites);
  },

  edit_channel: (payload) => {
    const parsed = editChannelPayloadSchema.safeParse(payload);
    if (!parsed.success || parsed.data.permissionOverwrites === undefined) return 0n;

    return Permissions.ManageRoles | grantedBits(parsed.data.permissionOverwrites);
  },

  create_thread: (payload) => {
    const parsed = createThreadPayloadSchema.safeParse(payload);
    // Never or the two together: CreatePublicThreads and CreatePrivateThreads are disjoint bits.
    if (!parsed.success) return Permissions.CreatePrivateThreads;
    return parsed.data.type === THREAD_TYPE_PUBLIC
      ? Permissions.CreatePublicThreads
      : Permissions.CreatePrivateThreads;
  },
};

// SendMessages is documented as T/V/S and says outright that it does not cover threads.
export const THREAD_PERMISSION_SUBSTITUTIONS: ReadonlyArray<readonly [bigint, bigint]> = [
  [Permissions.SendMessages, Permissions.SendMessagesInThreads],
];

export function requiredPermissionsFor(
  kind: ActionKind,
  payload?: unknown,
  inThread = false,
): bigint {
  const required = REQUIRED_PERMISSIONS[kind] | (PAYLOAD_PERMISSIONS[kind]?.(payload) ?? 0n);
  if (!inThread) return required;

  let substituted = required;
  for (const [outsideThreads, insideThreads] of THREAD_PERMISSION_SUBSTITUTIONS) {
    if ((substituted & outsideThreads) === 0n) continue;
    substituted = (substituted & ~outsideThreads) | insideThreads;
  }

  return substituted;
}

export function targetsMember(kind: ActionKind): boolean {
  return TARGETS_MEMBER[kind];
}

/**
 * Whether Discord applies role hierarchy — and the owner exemption — to this kind. Almost every
 * member-targeting action is subject to both, so this lists only the exceptions.
 *
 * A voice move is not a moderation action. `Modify Guild Member` documents `channel_id` as needing
 * MOVE_MEMBERS and nothing else, and Discord moves the owner and members ranked above the bot
 * without complaint. Gating it like a ban meant the server owner — the one person guaranteed to
 * test a new module — could never be moved into the channel Proton had just built for them.
 */
const HIERARCHY_EXEMPT: ReadonlySet<ActionKind> = new Set<ActionKind>(['move_member']);

export function hierarchyApplies(kind: ActionKind): boolean {
  return TARGETS_MEMBER[kind] && !HIERARCHY_EXEMPT.has(kind);
}

export function reversalOf(kind: ActionKind): ActionKind | undefined {
  return REVERSAL_OF[kind];
}

export const LEDGER_ONLY_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'warn',
  // A draw changes who won, not anything on Discord: the announcement is a separate send. It
  // still belongs in the ledger, which is what makes a giveaway auditable alongside every other
  // state change (PLAN.md I1).
  'giveaway_draw',
]);

export function isLedgerOnly(kind: ActionKind): boolean {
  return LEDGER_ONLY_KINDS.has(kind);
}

export const NEVER_RECORDED_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'interaction_reply',
  'interaction_followup',
  // Opening a DM channel is a lookup, not a state change — the message sent into it is the
  // action, and that is recorded on its own.
  'create_dm',
]);

export function isNeverRecorded(kind: ActionKind): boolean {
  return NEVER_RECORDED_KINDS.has(kind);
}

import { hasWithAdmin, Permissions } from '@proton/core';
import type { ClaimMode } from './config.ts';
import type { Ticket } from './store.ts';

export const TICKET_ACTIONS = [
  'info',
  'transcript',
  'close',
  'request-close',
  'reopen',
  'archive',
  'delete',
  'claim',
  'unclaim',
  'assign',
  'transfer',
  'add-participant',
  'remove-participant',
  'rename',
  'move',
  'priority',
  'lock',
  'unlock',
  'response',
  'post-panel',
  'blacklist',
  'stats',
] as const;

export type TicketAction = (typeof TICKET_ACTIONS)[number];

export const TICKET_ROLES = [
  'admin',
  'moderator',
  'support',
  'claimant',
  'assignee',
  'owner',
  'opener',
] as const;

export type TicketRole = (typeof TICKET_ROLES)[number];

export interface TicketActor {
  userId: string;
  roleIds: readonly string[];
  permissions: bigint;
}

export interface TicketAuthInput {
  action: TicketAction;
  actor: TicketActor;

  ticket: Ticket | null;

  staffRoleIds: readonly string[];

  claimMode?: ClaimMode;
  claimRestrictsStaff?: boolean;
  reopenEnabled?: boolean;
}

export type TicketAuthDecision =
  | { allowed: true; via: TicketRole }
  | { allowed: false; code: string; humanReason: string };

const ADMIN_BITS = Permissions.ManageGuild;

const MODERATOR_BITS = Permissions.ManageChannels;

// Ordered strongest first: the decision reports the highest tier that granted it, which is what an
// audit line has to say, and a tier that appears here but not in ALLOWED can still never allow.
const ALLOWED: Record<TicketAction, readonly TicketRole[]> = {
  info: ['admin', 'moderator', 'support', 'claimant', 'assignee', 'owner', 'opener'],
  transcript: ['admin', 'moderator', 'support', 'claimant', 'assignee', 'owner', 'opener'],

  close: ['admin', 'moderator', 'support', 'claimant', 'assignee', 'owner'],
  'request-close': ['admin', 'moderator', 'support', 'claimant', 'assignee'],
  reopen: ['admin', 'moderator', 'support', 'claimant', 'assignee', 'owner'],
  archive: ['admin', 'moderator', 'support', 'claimant', 'assignee'],

  // Deliberately narrower than close (§30): closing is reversible and deleting takes the
  // conversation with it, so support staff who may close all day cannot destroy the record.
  delete: ['admin', 'moderator'],

  claim: ['admin', 'moderator', 'support'],
  unclaim: ['admin', 'moderator', 'claimant'],
  assign: ['admin', 'moderator', 'support', 'claimant'],
  transfer: ['admin', 'moderator', 'support', 'claimant', 'assignee'],

  'add-participant': ['admin', 'moderator', 'support', 'claimant', 'assignee', 'owner'],
  'remove-participant': ['admin', 'moderator', 'support', 'claimant', 'assignee'],

  rename: ['admin', 'moderator', 'support', 'claimant', 'assignee'],
  move: ['admin', 'moderator', 'support', 'claimant', 'assignee'],
  priority: ['admin', 'moderator', 'support', 'claimant', 'assignee'],
  lock: ['admin', 'moderator', 'support', 'claimant', 'assignee'],
  unlock: ['admin', 'moderator', 'support', 'claimant', 'assignee'],

  // Answering on the team's behalf, so it carries the same standing as claiming — but without
  // claim's precondition, or a guild owner would be refused a saved reply with a message about a
  // claiming setting that has nothing to do with it.
  response: ['admin', 'moderator', 'support', 'claimant', 'assignee'],

  'post-panel': ['admin', 'moderator'],
  blacklist: ['admin', 'moderator'],
  stats: ['admin', 'moderator', 'support'],
};

const GUILD_ACTIONS: ReadonlySet<TicketAction> = new Set<TicketAction>([
  'post-panel',
  'blacklist',
  'stats',
]);

// The actions a claim is allowed to fence off. Reading a ticket and answering "who has this?" are
// not among them, or a claimed ticket would go dark for the rest of the team.
const CLAIMABLE: ReadonlySet<TicketAction> = new Set<TicketAction>([
  'close',
  'request-close',
  'archive',
  'assign',
  'transfer',
  'add-participant',
  'remove-participant',
  'rename',
  'move',
  'priority',
  'lock',
  'unlock',
  'response',
]);

export function rolesOf(input: TicketAuthInput): TicketRole[] {
  const { actor, ticket } = input;
  const roles: TicketRole[] = [];

  if (hasWithAdmin(actor.permissions, ADMIN_BITS)) roles.push('admin');
  if (hasWithAdmin(actor.permissions, MODERATOR_BITS)) roles.push('moderator');

  const staff = new Set(input.staffRoleIds);
  if (actor.roleIds.some((roleId) => staff.has(roleId))) roles.push('support');

  if (ticket) {
    if (ticket.claimedById === actor.userId) roles.push('claimant');
    if (ticket.assignedToId === actor.userId) roles.push('assignee');
    if (ticket.ownerId === actor.userId) roles.push('owner');
    if (ticket.openerId === actor.userId) roles.push('opener');
  }

  return roles;
}

function refusal(code: string, humanReason: string): TicketAuthDecision {
  return { allowed: false, code, humanReason };
}

function whoMay(permitted: readonly TicketRole[]): string {
  if (permitted.includes('owner')) return 'Only its owner and staff can.';
  if (permitted.includes('support')) return 'Only staff can.';
  if (permitted.includes('claimant')) {
    return 'Only whoever claimed it, or anyone with Manage Channels or Manage Server, can.';
  }
  return 'It needs Manage Channels or Manage Server.';
}

export function authorizeTicket(input: TicketAuthInput): TicketAuthDecision {
  const { action, ticket } = input;

  if (!GUILD_ACTIONS.has(action) && ticket === null) {
    return refusal('no_ticket', 'There’s no ticket in this channel, so nothing was changed.');
  }

  if (ticket?.status === 'deleted') {
    return refusal(
      'ticket_deleted',
      `Ticket #${ticket.number} was deleted, so it can’t be changed any more.`,
    );
  }

  if (action === 'claim' && (input.claimMode ?? 'single') === 'off') {
    return refusal(
      'claiming_off',
      'Claiming is off for this ticket type. An admin can turn it on in the Proton dashboard ' +
        'under Tickets → Ticket types.',
    );
  }

  if (action === 'reopen' && input.reopenEnabled === false) {
    return refusal(
      'reopen_off',
      'Tickets of this type can’t be reopened once they’re closed. Open a new one instead.',
    );
  }

  const held = rolesOf(input);
  const permitted = ALLOWED[action];
  const via = permitted.find((role) => held.includes(role));

  if (!via) {
    return refusal(
      'not_permitted',
      ticket === null
        ? permitted.includes('support')
          ? 'You need Manage Server, Manage Channels or a staff role to do that.'
          : 'You need Manage Server or Manage Channels to do that.'
        : `You can’t do that to ticket #${ticket.number}. ${whoMay(permitted)}`,
    );
  }

  // A claim is a fence around the staff side of one conversation, never around the people who
  // outrank it: without the admin and moderator exits a claimant could lock out the whole server.
  if (
    ticket &&
    CLAIMABLE.has(action) &&
    input.claimRestrictsStaff === true &&
    ticket.claimedById !== null &&
    (via === 'support' || via === 'owner')
  ) {
    return refusal(
      'claimed_by_other',
      `Ticket #${ticket.number} is claimed by <@${ticket.claimedById}>, and on this ticket type ` +
        'only the claimer can use its controls. Ask them to hand it over, or ask someone with ' +
        'Manage Channels to unclaim it.',
    );
  }

  return { allowed: true, via };
}

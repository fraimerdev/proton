import type { ActionResult, ModuleContext, TicketPriority } from '@proton/core';
import {
  MODULE_ID,
  PRIORITY_LABELS,
  renderChannelName,
  sanitiseChannelName,
  staffRolesFor,
  type TicketsConfig,
  typeFor,
} from './config.ts';
import type { TicketsDeps } from './deps.ts';
import { describePriority } from './interface.ts';
import {
  OVERWRITE_MEMBER,
  TICKET_LOCKED_ALLOW,
  TICKET_LOCKED_DENY,
  TICKET_MEMBER_ALLOW,
  ticketOverwrites,
} from './overwrites.ts';
import { armTicketTimers } from './schedule.ts';
import type { Ticket, TicketStore } from './store.ts';

export interface ControlInput {
  ctx: ModuleContext<TicketsConfig>;
  store: TicketStore;
  deps: TicketsDeps;
  ticket: Ticket;
  actorId: string;
  idempotencyKey: string;
}

export type ControlOutcome =
  | { ok: true; message: string; ticket: Ticket }
  | { ok: false; humanReason: string };

function failureOf(result: ActionResult, fallback: string): string {
  return result.failure?.humanReason ?? `${fallback} (the action ended as ${result.status})`;
}

function refused(result: ActionResult): boolean {
  return result.status === 'failed_precheck' || result.status === 'failed_api';
}

async function note(
  input: ControlInput,
  type: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await input.store.recordEvent({
    ticketId: input.ticket.id,
    guildId: input.ctx.guildId,
    type,
    actorId: input.actorId,
    data,
  });
}

export async function claim(input: ControlInput): Promise<ControlOutcome> {
  const claimed = await input.store.claim(input.ctx.guildId, input.ticket.id, input.actorId);

  // Null means somebody else's update won the race, so this is the losing press being told who
  // holds it rather than a second claimant silently overwriting the first.
  if (!claimed) {
    const current = await input.store.get(input.ctx.guildId, input.ticket.id);

    return {
      ok: false,
      humanReason:
        current?.claimedById && current.claimedById !== input.actorId
          ? `<@${current.claimedById}> claimed this ticket first.`
          : `Ticket #${input.ticket.number} cannot be claimed — it is not open any more.`,
    };
  }

  await note(input, 'claimed');

  await input.ctx.publish?.('tickets.claimed', claimed.id, {
    guildId: input.ctx.guildId,
    ticketId: claimed.id,
    number: claimed.number,
    channelId: claimed.channelId,
    typeId: claimed.typeId,
    typeName: typeFor(input.ctx.config, claimed.typeId)?.name ?? claimed.typeId,
    claimedById: input.actorId,
  });

  return { ok: true, ticket: claimed, message: `You claimed ticket #${claimed.number}.` };
}

export async function unclaim(input: ControlInput): Promise<ControlOutcome> {
  const released = await input.store.unclaim(input.ctx.guildId, input.ticket.id);

  if (!released) {
    return {
      ok: false,
      humanReason: 'Nobody has claimed this ticket, so there was nothing to let go of.',
    };
  }

  await note(input, 'unclaimed', { previous: input.ticket.claimedById });

  return {
    ok: true,
    ticket: released,
    message: `Ticket #${released.number} is unclaimed and back in the queue.`,
  };
}

export async function assign(
  input: ControlInput,
  assigneeId: string | null,
): Promise<ControlOutcome> {
  const assigned = await input.store.assign(
    input.ctx.guildId,
    input.ticket.id,
    assigneeId,
    input.actorId,
  );

  if (!assigned) {
    return { ok: false, humanReason: `Ticket #${input.ticket.number} could not be reassigned.` };
  }

  await note(input, assigneeId === null ? 'unassigned' : 'assigned', { assigneeId });

  return {
    ok: true,
    ticket: assigned,
    message:
      assigneeId === null
        ? `Ticket #${assigned.number} is no longer assigned to anybody.`
        : `Ticket #${assigned.number} is assigned to <@${assigneeId}>.`,
  };
}

export async function transfer(input: ControlInput, ownerId: string): Promise<ControlOutcome> {
  if (ownerId === input.ticket.ownerId) {
    return { ok: false, humanReason: `<@${ownerId}> already owns ticket #${input.ticket.number}.` };
  }

  const granted = await grantAccess(input, ownerId);
  if (granted !== null) return { ok: false, humanReason: granted };

  const moved = await input.store.transferOwner(input.ctx.guildId, input.ticket.id, ownerId);

  if (!moved) {
    return { ok: false, humanReason: `Ticket #${input.ticket.number} could not be transferred.` };
  }

  await input.store.addParticipant(moved.id, ownerId, 'added', input.actorId);
  await note(input, 'transferred', { from: input.ticket.ownerId, to: ownerId });

  return {
    ok: true,
    ticket: moved,
    message: `<@${ownerId}> now owns ticket #${moved.number}.`,
  };
}

export async function setPriority(
  input: ControlInput,
  priority: TicketPriority,
): Promise<ControlOutcome> {
  if (priority === input.ticket.priority) {
    return {
      ok: false,
      humanReason: `Ticket #${input.ticket.number} is already ${PRIORITY_LABELS[priority]} priority.`,
    };
  }

  const updated = await input.store.setPriority(input.ctx.guildId, input.ticket.id, priority);

  if (!updated) {
    return { ok: false, humanReason: `Ticket #${input.ticket.number} could not be changed.` };
  }

  await note(input, 'priority-changed', { from: input.ticket.priority, to: priority });

  return {
    ok: true,
    ticket: updated,
    message: `Ticket #${updated.number} is now ${describePriority(priority)}.`,
  };
}

async function setMemberOverwrite(
  input: ControlInput,
  userId: string,
  locked: boolean,
  suffix: string,
): Promise<ActionResult> {
  return input.ctx.executor.execute({
    guildId: input.ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'set_channel_overwrite',
    actorId: input.actorId,
    reason: `ticket #${input.ticket.number} ${locked ? 'locked' : 'unlocked'}`,
    idempotencyKey: `${input.idempotencyKey}:${suffix}`,
    dryRun: false,
    record: false,
    payload: {
      channelId: input.ticket.channelId,
      overwriteId: userId,
      type: OVERWRITE_MEMBER,
      allow: (locked ? TICKET_LOCKED_ALLOW : TICKET_MEMBER_ALLOW).toString(),
      deny: (locked ? TICKET_LOCKED_DENY : 0n).toString(),
    },
  });
}

export async function setLock(input: ControlInput, locked: boolean): Promise<ControlOutcome> {
  const flipped = await input.store.setLocked(
    input.ctx.guildId,
    input.ticket.id,
    locked ? input.actorId : null,
  );

  if (!flipped) {
    return {
      ok: false,
      humanReason: locked
        ? `Ticket #${input.ticket.number} is already locked, or is not open.`
        : `Ticket #${input.ticket.number} is not locked.`,
    };
  }

  const participants = await input.store.listParticipants(flipped.id);

  // Every non-staff member, one overwrite at a time. Rebuilding the whole array instead would
  // revoke whoever was added between the read and the write.
  const targets = new Set<string>([flipped.ownerId, ...participants.map((p) => p.userId)]);
  targets.delete(input.deps.botUserId ?? '');

  const failures: string[] = [];

  for (const userId of targets) {
    const result = await setMemberOverwrite(input, userId, locked, `lock:${userId}`);
    if (refused(result)) failures.push(failureOf(result, 'Discord refused it'));
  }

  await note(input, locked ? 'locked' : 'unlocked');

  if (failures.length > 0) {
    input.ctx.logger.warn(
      `ticket #${flipped.number} was marked ${locked ? 'locked' : 'unlocked'} but ${failures.length} ` +
        `permission change(s) were refused: ${failures.join('; ')}`,
      { guildId: input.ctx.guildId, moduleId: MODULE_ID },
    );
  }

  return {
    ok: true,
    ticket: flipped,
    message: locked
      ? `Ticket #${flipped.number} is locked. Only staff can post in it now.`
      : `Ticket #${flipped.number} is unlocked.`,
  };
}

export async function rename(input: ControlInput, raw: string): Promise<ControlOutcome> {
  const name = sanitiseChannelName(raw);

  const result = await input.ctx.executor.execute({
    guildId: input.ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_channel',
    actorId: input.actorId,
    reason: `ticket #${input.ticket.number} renamed`,
    idempotencyKey: `${input.idempotencyKey}:rename`,
    dryRun: false,
    record: false,
    // No permissionOverwrites: omitting the field leaves the live array alone, and sending one
    // rebuilt from config would revoke everybody added since the channel was created.
    payload: { channelId: input.ticket.channelId, name },
  });

  if (refused(result)) {
    return {
      ok: false,
      humanReason: `I couldn't rename it: ${failureOf(result, 'Discord refused it')}`,
    };
  }

  await note(input, 'renamed', { name });

  return { ok: true, ticket: input.ticket, message: `Renamed to **#${name}**.` };
}

export async function move(input: ControlInput, categoryId: string): Promise<ControlOutcome> {
  const moved = await input.ctx.executor.execute({
    guildId: input.ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_channel',
    actorId: input.actorId,
    reason: `ticket #${input.ticket.number} moved`,
    idempotencyKey: `${input.idempotencyKey}:move`,
    dryRun: false,
    record: false,
    payload: { channelId: input.ticket.channelId, parentId: categoryId },
  });

  if (refused(moved)) {
    return {
      ok: false,
      humanReason: `I couldn't move it: ${failureOf(moved, 'Discord refused it')}`,
    };
  }

  const participants = await input.store.listParticipants(input.ticket.id);

  // A category carries its own overwrites, and Discord does not merge them into a channel that
  // moves in — the private grants have to be written again or the ticket changes who can read it.
  const required = ticketOverwrites({
    guildId: input.ctx.guildId,
    ownerId: input.ticket.ownerId,
    staffRoleIds: staffRolesFor(input.ctx.config, typeFor(input.ctx.config, input.ticket.typeId)),
    botUserId: input.deps.botUserId,
    participantIds: participants.map((participant) => participant.userId),
    locked: input.ticket.lockedAt !== null,
  });

  const revalidated = await input.ctx.executor.execute({
    guildId: input.ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_channel',
    actorId: input.actorId,
    reason: `ticket #${input.ticket.number} permissions revalidated after move`,
    idempotencyKey: `${input.idempotencyKey}:move-perms`,
    dryRun: false,
    record: false,
    payload: { channelId: input.ticket.channelId, permissionOverwrites: required },
  });

  if (refused(revalidated)) {
    input.ctx.logger.error(
      `ticket #${input.ticket.number} was moved but its permissions could not be reapplied, so it ` +
        `may now be readable by the wrong people: ${failureOf(revalidated, 'Discord refused it')}`,
      { guildId: input.ctx.guildId, moduleId: MODULE_ID, code: revalidated.failure?.code },
    );
  }

  await note(input, 'moved', { categoryId });

  return { ok: true, ticket: input.ticket, message: `Moved ticket #${input.ticket.number}.` };
}

async function grantAccess(input: ControlInput, userId: string): Promise<string | null> {
  const result = await input.ctx.executor.execute({
    guildId: input.ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'set_channel_overwrite',
    actorId: input.actorId,
    reason: `added to ticket #${input.ticket.number}`,
    idempotencyKey: `${input.idempotencyKey}:grant:${userId}`,
    dryRun: false,
    record: false,
    payload: {
      channelId: input.ticket.channelId,
      overwriteId: userId,
      type: OVERWRITE_MEMBER,
      allow: (input.ticket.lockedAt === null
        ? TICKET_MEMBER_ALLOW
        : TICKET_LOCKED_ALLOW
      ).toString(),
      deny: (input.ticket.lockedAt === null ? 0n : TICKET_LOCKED_DENY).toString(),
    },
  });

  return refused(result)
    ? `I couldn't give <@${userId}> access: ${failureOf(result, 'Discord refused it')}`
    : null;
}

export async function addParticipant(input: ControlInput, userId: string): Promise<ControlOutcome> {
  const problem = await grantAccess(input, userId);
  if (problem !== null) return { ok: false, humanReason: problem };

  await input.store.addParticipant(input.ticket.id, userId, 'added', input.actorId);
  await note(input, 'member-added', { userId });

  return {
    ok: true,
    ticket: input.ticket,
    message: `Added <@${userId}> to ticket #${input.ticket.number}.`,
  };
}

export async function removeParticipant(
  input: ControlInput,
  userId: string,
): Promise<ControlOutcome> {
  if (userId === input.ticket.ownerId) {
    return {
      ok: false,
      humanReason:
        'That member owns this ticket, so they cannot be removed from it. Close the ticket, or ' +
        'transfer it to somebody else first.',
    };
  }

  const removed = await input.store.removeParticipant(input.ticket.id, userId);

  if (!removed) {
    return {
      ok: false,
      humanReason:
        `<@${userId}> was not added to this ticket by anybody, so there is nothing to take away. ` +
        'Members who can see it through a support role are removed by changing that role.',
    };
  }

  const result = await input.ctx.executor.execute({
    guildId: input.ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_channel_overwrite',
    actorId: input.actorId,
    reason: `removed from ticket #${input.ticket.number}`,
    idempotencyKey: `${input.idempotencyKey}:revoke:${userId}`,
    dryRun: false,
    record: false,
    payload: { channelId: input.ticket.channelId, overwriteId: userId },
  });

  if (refused(result)) {
    // The row is already gone, so saying "nothing happened" would be a lie — the ticket now
    // disagrees with Discord and somebody has to know which way.
    input.ctx.logger.error(
      `<@${userId}> was removed from ticket #${input.ticket.number} in Proton but their channel ` +
        `access could not be revoked: ${failureOf(result, 'Discord refused it')}`,
      { guildId: input.ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );

    return {
      ok: false,
      humanReason:
        `I removed <@${userId}> from the ticket's records but could not take their channel access ` +
        `away: ${failureOf(result, 'Discord refused it')}`,
    };
  }

  await note(input, 'member-removed', { userId });

  return {
    ok: true,
    ticket: input.ticket,
    message: `Removed <@${userId}> from ticket #${input.ticket.number}.`,
  };
}

export async function requestClose(
  input: ControlInput,
  reason: string | null,
): Promise<ControlOutcome> {
  const requested = await input.store.requestClose(
    input.ctx.guildId,
    input.ticket.id,
    input.actorId,
  );

  if (!requested) {
    return {
      ok: false,
      humanReason: `Somebody has already asked to close ticket #${input.ticket.number}.`,
    };
  }

  await note(input, 'close-requested', reason === null ? undefined : { reason });

  await armTicketTimers(input.ctx, typeFor(input.ctx.config, requested.typeId), requested);

  return {
    ok: true,
    ticket: requested,
    message: `Asked <@${requested.ownerId}> to confirm closing ticket #${requested.number}.`,
  };
}

export function defaultName(ctx: ModuleContext<TicketsConfig>, ticket: Ticket): string {
  const type = typeFor(ctx.config, ticket.typeId);

  return renderChannelName(
    type?.namePattern ?? ctx.config.namePattern,
    ticket.number,
    ticket.ownerId,
    type?.name ?? '',
  );
}

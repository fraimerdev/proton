import {
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
  createCommandOptions,
  type DedupeStore,
  DefaultActionExecutor,
  type EntitlementTier,
  type GuildRole,
  type GuildState,
  type GuildStateStore,
  INTERACTION_CALLBACK_MODAL,
  type Logger,
  type ModuleContext,
  newId,
  OptionType,
  Permissions,
  type PrecheckInput,
  type ProtonEvent,
  type RawOption,
  type ResolveContextHints,
  type RestFile,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
  type ScheduleOptions,
  type ScheduleOutcome,
  type TicketPriority,
} from '@proton/core';
import { ComponentType, InteractionType } from 'discord-api-types/v10';
import { ticketsCommands } from '../src/commands.ts';
import {
  CATEGORY_CHANNEL_TYPE,
  TEXT_CHANNEL_TYPE,
  type TicketPanel,
  type TicketsConfig,
  type TicketType,
  ticketPanelSchema,
  ticketsDefaultConfig,
  ticketTypeSchema,
} from '../src/config.ts';
import type { TicketsDeps } from '../src/deps.ts';
import { createTicketsModule } from '../src/index.ts';
import { handleTicketInteraction, type PressOutcome } from '../src/interactions.ts';
import { TICKET_MEMBER_ALLOW } from '../src/overwrites.ts';
import type {
  BlacklistEntry,
  BlacklistInput,
  CaptureMessageInput,
  CloseTicketInput,
  ParticipantKind,
  RecordTicketEventInput,
  ReserveTicketInput,
  Ticket,
  TicketEvent,
  TicketFormAnswer,
  TicketMessage,
  TicketParticipant,
  TicketRating,
  TicketStats,
  TicketStatus,
  TicketStore,
} from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';

export const MEMBER = '100000000000000001';
export const HELPER = '100000000000000002';
export const OTHER_HELPER = '100000000000000003';

export const SUPPORT_ROLE = '410000000000000007';

export const PANEL_CHANNEL = '500000000000000001';
export const TICKET_CHANNEL = '500000000000000002';
export const CREATED = '500000000000000003';
export const TRANSCRIPTS = '500000000000000004';
export const LOG_CHANNEL = '500000000000000005';
export const DM_CHANNEL = '500000000000000006';
export const CATEGORY = '500000000000000009';
export const ARCHIVE_CATEGORY = '500000000000000010';

export const INTERACTION = '600000000000000001';
export const PANEL_MESSAGE = '700000000000000001';

const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000005';

// Derived from TICKET_MEMBER_ALLOW rather than listed again: Discord refuses an overwrite granting
// a permission the bot does not hold, so a bit added there and forgotten here would fail the
// create_channel precheck in every test at once.
export const BOT_PERMISSIONS =
  TICKET_MEMBER_ALLOW | Permissions.ManageChannels | Permissions.ManageRoles;

export const TYPE: TicketType = ticketTypeSchema.parse({
  id: 'support',
  name: 'Support',
  categoryId: CATEGORY,
  staffRoleIds: [SUPPORT_ROLE],
});

export const PANEL: TicketPanel = ticketPanelSchema.parse({
  id: 'support',
  name: 'Support',
  channelId: PANEL_CHANNEL,
  typeIds: [TYPE.id],
  panelText: 'Need a hand?',
});

const CHANNEL_TYPES: ReadonlyArray<[string, number]> = [
  [PANEL_CHANNEL, TEXT_CHANNEL_TYPE],
  [TICKET_CHANNEL, TEXT_CHANNEL_TYPE],
  [CREATED, TEXT_CHANNEL_TYPE],
  [TRANSCRIPTS, TEXT_CHANNEL_TYPE],
  [LOG_CHANNEL, TEXT_CHANNEL_TYPE],
  [DM_CHANNEL, TEXT_CHANNEL_TYPE],
  [CATEGORY, CATEGORY_CHANNEL_TYPE],
  [ARCHIVE_CATEGORY, CATEGORY_CHANNEL_TYPE],
];

const NAMES: Record<string, string> = {
  [MEMBER]: 'member',
  [HELPER]: 'helper',
  [OTHER_HELPER]: 'other-helper',
  [OWNER]: 'owner',
  [BOT]: 'proton',
};

function guildState(botPermissions: bigint): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: new Map<string, GuildRole>([
      [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
      [SUPPORT_ROLE, { id: SUPPORT_ROLE, permissions: 0n, position: 2 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: botPermissions, position: 5 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map(
      CHANNEL_TYPES.map(([id, type]) => [
        id,
        {
          id,
          type,
          parentId: id === TICKET_CHANNEL || id === CREATED ? CATEGORY : null,
          overwrites: [],
        },
      ]),
    ),
    updatedAt: Date.now(),
  };
}

export class MemoryTicketStore implements TicketStore {
  // Counts channel lookups so a test can assert that a guild configuring no automation pays no
  // query per message, which is the difference between a quiet module and a hot one.
  reads = 0;

  readonly rows = new Map<string, Ticket>();
  readonly participants: TicketParticipant[] = [];
  readonly events: TicketEvent[] = [];
  readonly answers = new Map<string, TicketFormAnswer[]>();
  readonly captured: Array<TicketMessage & { expiresAt: Date }> = [];
  readonly blocked = new Map<string, BlacklistEntry>();
  readonly ratings = new Map<string, TicketRating>();

  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  #of(guildId: string): Ticket[] {
    return [...this.rows.values()].filter((ticket) => ticket.guildId === guildId);
  }

  #row(guildId: string, ticketId: string): Ticket | null {
    const ticket = this.rows.get(ticketId);
    return ticket && ticket.guildId === guildId ? ticket : null;
  }

  #write(ticket: Ticket, patch: Partial<Ticket>): Ticket {
    const next: Ticket = { ...ticket, ...patch };
    this.rows.set(ticket.id, next);
    return next;
  }

  async reserve(input: ReserveTicketInput): Promise<Ticket> {
    const id = newId();
    const highest = this.#of(input.guildId).reduce((top, row) => Math.max(top, row.number), 0);
    const at = this.#now();

    const ticket: Ticket = {
      id,
      guildId: input.guildId,
      number: highest + 1,
      typeId: input.typeId,
      panelId: input.panelId,
      // Its own id until attach() lands, so the live-channel unique index still holds meanwhile.
      channelId: id,
      openerId: input.openerId,
      ownerId: input.openerId,
      status: 'open',
      priority: input.priority,
      subject: input.subject ?? null,
      claimedById: null,
      claimedAt: null,
      assignedToId: null,
      assignedById: null,
      assignedAt: null,
      lockedAt: null,
      lockedById: null,
      waitingOn: 'staff',
      openedAt: at,
      lastActivityAt: at,
      lastUserMessageAt: null,
      lastStaffMessageAt: null,
      firstResponseAt: null,
      closeRequestedById: null,
      closeRequestedAt: null,
      closedAt: null,
      closedBy: null,
      closeReason: null,
      archivedAt: null,
      deletedAt: null,
      messageCount: 0,
      transcriptUrl: null,
    };

    this.rows.set(id, ticket);
    return ticket;
  }

  async attach(guildId: string, ticketId: string, channelId: string): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    return ticket ? this.#write(ticket, { channelId }) : null;
  }

  async abandon(guildId: string, ticketId: string): Promise<void> {
    if (!this.#row(guildId, ticketId)) return;

    this.rows.delete(ticketId);
    this.answers.delete(ticketId);
    this.ratings.delete(ticketId);

    for (const list of [this.participants, this.events, this.captured]) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (list[index]?.ticketId === ticketId) list.splice(index, 1);
      }
    }
  }

  async get(guildId: string, ticketId: string): Promise<Ticket | null> {
    return this.#row(guildId, ticketId);
  }

  async byChannel(guildId: string, channelId: string): Promise<Ticket | null> {
    this.reads += 1;

    return (
      this.#of(guildId).find(
        (ticket) => ticket.channelId === channelId && ticket.status !== 'deleted',
      ) ?? null
    );
  }

  async byNumber(guildId: string, number: number): Promise<Ticket | null> {
    return this.#of(guildId).find((ticket) => ticket.number === number) ?? null;
  }

  async countOpenFor(guildId: string, ownerId: string): Promise<number> {
    return this.#of(guildId).filter(
      (ticket) => ticket.ownerId === ownerId && ticket.status === 'open',
    ).length;
  }

  async countOpenForType(guildId: string, ownerId: string, typeId: string): Promise<number> {
    return this.#of(guildId).filter(
      (ticket) =>
        ticket.ownerId === ownerId && ticket.typeId === typeId && ticket.status === 'open',
    ).length;
  }

  async countOpen(guildId: string): Promise<number> {
    return this.#of(guildId).filter((ticket) => ticket.status === 'open').length;
  }

  async lastOpenedAt(guildId: string, openerId: string): Promise<Date | null> {
    const opened = this.#of(guildId)
      .filter((ticket) => ticket.openerId === openerId)
      .map((ticket) => ticket.openedAt.getTime());

    return opened.length === 0 ? null : new Date(Math.max(...opened));
  }

  async openRankAt(
    guildId: string,
    ownerId: string,
    number: number,
    typeId?: string,
  ): Promise<number> {
    return this.#of(guildId).filter(
      (ticket) =>
        ticket.ownerId === ownerId &&
        ticket.status === 'open' &&
        ticket.number <= number &&
        (typeId === undefined || ticket.typeId === typeId),
    ).length;
  }

  async listOpen(guildId: string): Promise<Ticket[]> {
    return this.#of(guildId)
      .filter((ticket) => ticket.status === 'open')
      .sort((a, b) => a.number - b.number);
  }

  async close(input: CloseTicketInput): Promise<Ticket | null> {
    const ticket = this.#row(input.guildId, input.ticketId);
    if (ticket?.status !== 'open') return null;

    return this.#write(ticket, {
      status: 'closed',
      closedAt: this.#now(),
      closedBy: input.closedBy,
      closeReason: input.reason,
      closeRequestedById: null,
      closeRequestedAt: null,
      waitingOn: null,
    });
  }

  async reopen(guildId: string, ticketId: string, byId: string): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (!ticket || (ticket.status !== 'closed' && ticket.status !== 'archived')) return null;

    const reopened = this.#write(ticket, {
      status: 'open',
      closedAt: null,
      closedBy: null,
      closeReason: null,
      archivedAt: null,
      lastActivityAt: this.#now(),
      waitingOn: 'staff',
    });

    await this.recordEvent({ ticketId, guildId, type: 'reopened', actorId: byId });
    return reopened;
  }

  async archive(guildId: string, ticketId: string): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (ticket?.status !== 'closed') return null;

    return this.#write(ticket, { status: 'archived', archivedAt: this.#now() });
  }

  async markDeleted(
    guildId: string,
    ticketId: string,
    byId: string,
    reason: string | null,
    expected?: readonly TicketStatus[],
  ): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (!ticket || ticket.status === 'deleted') return null;
    if (expected !== undefined && !expected.includes(ticket.status)) return null;

    const removed = this.#write(ticket, {
      status: 'deleted',
      deletedAt: this.#now(),
      ...(reason === null ? {} : { closeReason: reason }),
    });

    await this.recordEvent({ ticketId, guildId, type: 'deleted', actorId: byId });
    return removed;
  }

  async claim(guildId: string, ticketId: string, userId: string): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (ticket?.status !== 'open' || ticket.claimedById !== null) return null;

    return this.#write(ticket, { claimedById: userId, claimedAt: this.#now() });
  }

  async unclaim(guildId: string, ticketId: string): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (!ticket || ticket.claimedById === null) return null;

    return this.#write(ticket, { claimedById: null, claimedAt: null });
  }

  async assign(
    guildId: string,
    ticketId: string,
    assigneeId: string | null,
    byId: string,
  ): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (!ticket || ticket.status === 'deleted') return null;

    return this.#write(ticket, {
      assignedToId: assigneeId,
      assignedById: assigneeId === null ? null : byId,
      assignedAt: assigneeId === null ? null : this.#now(),
    });
  }

  async transferOwner(guildId: string, ticketId: string, ownerId: string): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (!ticket || ticket.status === 'deleted' || ticket.ownerId === ownerId) return null;

    return this.#write(ticket, { ownerId });
  }

  async setPriority(
    guildId: string,
    ticketId: string,
    priority: TicketPriority,
  ): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (!ticket || ticket.status === 'deleted') return null;

    return this.#write(ticket, { priority });
  }

  async setSubject(
    guildId: string,
    ticketId: string,
    subject: string | null,
  ): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (!ticket || ticket.status === 'deleted') return null;

    return this.#write(ticket, { subject });
  }

  async setLocked(
    guildId: string,
    ticketId: string,
    lockedById: string | null,
  ): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (ticket?.status !== 'open') return null;

    const locking = lockedById !== null;
    if (locking === (ticket.lockedAt !== null)) return null;

    return this.#write(ticket, { lockedById, lockedAt: locking ? this.#now() : null });
  }

  async requestClose(guildId: string, ticketId: string, byId: string): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (ticket?.status !== 'open' || ticket.closeRequestedAt !== null) return null;

    return this.#write(ticket, { closeRequestedById: byId, closeRequestedAt: this.#now() });
  }

  async clearCloseRequest(guildId: string, ticketId: string): Promise<Ticket | null> {
    const ticket = this.#row(guildId, ticketId);
    if (!ticket || ticket.closeRequestedAt === null) return null;

    return this.#write(ticket, { closeRequestedById: null, closeRequestedAt: null });
  }

  async setTranscriptUrl(guildId: string, ticketId: string, url: string): Promise<void> {
    const ticket = this.#row(guildId, ticketId);
    if (ticket) this.#write(ticket, { transcriptUrl: url });
  }

  async touch(guildId: string, channelId: string, notBefore: Date): Promise<void> {
    const ticket = await this.byChannel(guildId, channelId);
    if (ticket?.status !== 'open' || ticket.lastActivityAt >= notBefore) return;

    this.#write(ticket, { lastActivityAt: this.#now() });
  }

  async recordActivity(
    guildId: string,
    channelId: string,
    input: { fromStaff: boolean; at: Date },
  ): Promise<Ticket | null> {
    const ticket = this.#of(guildId).find(
      (row) => row.channelId === channelId && row.status === 'open',
    );
    if (!ticket) return null;

    return this.#write(ticket, {
      lastActivityAt: input.at,
      waitingOn: input.fromStaff ? 'user' : 'staff',
      ...(input.fromStaff
        ? {
            lastStaffMessageAt: input.at,
            firstResponseAt: ticket.firstResponseAt ?? input.at,
          }
        : { lastUserMessageAt: input.at, messageCount: ticket.messageCount + 1 }),
    });
  }

  async due(guildId: string, limit: number): Promise<Ticket[]> {
    return this.#of(guildId)
      .filter((ticket) => ticket.status === 'open' || ticket.status === 'closed')
      .sort((a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime())
      .slice(0, limit);
  }

  async addParticipant(
    ticketId: string,
    userId: string,
    kind: ParticipantKind,
    addedById: string | null,
  ): Promise<void> {
    const already = this.participants.some(
      (entry) => entry.ticketId === ticketId && entry.userId === userId,
    );
    if (already) return;

    this.participants.push({ ticketId, userId, kind, addedById, addedAt: this.#now() });
  }

  async removeParticipant(ticketId: string, userId: string): Promise<boolean> {
    const index = this.participants.findIndex(
      (entry) => entry.ticketId === ticketId && entry.userId === userId && entry.kind !== 'opener',
    );
    if (index < 0) return false;

    this.participants.splice(index, 1);
    return true;
  }

  async listParticipants(ticketId: string): Promise<TicketParticipant[]> {
    return this.participants
      .filter((entry) => entry.ticketId === ticketId)
      .sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime());
  }

  async recordEvent(input: RecordTicketEventInput): Promise<void> {
    this.events.push({
      id: newId(),
      ticketId: input.ticketId,
      guildId: input.guildId,
      type: input.type,
      actorId: input.actorId,
      data: input.data ?? null,
      at: this.#now(),
    });
  }

  async listEvents(ticketId: string, limit: number): Promise<TicketEvent[]> {
    return this.events
      .filter((entry) => entry.ticketId === ticketId)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(0, limit);
  }

  async saveAnswers(ticketId: string, answers: readonly TicketFormAnswer[]): Promise<void> {
    if (answers.length === 0) return;

    const stored = this.answers.get(ticketId) ?? [];

    for (const answer of answers) {
      if (stored.some((entry) => entry.fieldId === answer.fieldId)) continue;
      stored.push({ ...answer });
    }

    this.answers.set(ticketId, stored);
  }

  async listAnswers(ticketId: string): Promise<TicketFormAnswer[]> {
    return [...(this.answers.get(ticketId) ?? [])].sort((a, b) => a.position - b.position);
  }

  async captureMessage(input: CaptureMessageInput): Promise<void> {
    const already = this.captured.some(
      (entry) => entry.ticketId === input.ticketId && entry.messageId === input.messageId,
    );
    if (already) return;

    this.captured.push({
      id: newId(),
      ticketId: input.ticketId,
      messageId: input.messageId,
      authorId: input.authorId,
      authorName: input.authorName,
      authorBot: input.authorBot,
      content: input.content,
      attachments: [...input.attachments],
      embeds: [...input.embeds],
      replyToId: input.replyToId,
      createdAt: input.createdAt,
      editedAt: null,
      deletedAt: null,
      expiresAt: input.expiresAt,
    });
  }

  async markMessageEdited(
    ticketId: string,
    messageId: string,
    content: string,
    at: Date,
  ): Promise<void> {
    const row = this.captured.find(
      (entry) => entry.ticketId === ticketId && entry.messageId === messageId,
    );
    if (!row) return;

    row.content = content;
    row.editedAt = at;
  }

  async markMessageDeleted(ticketId: string, messageId: string, at: Date): Promise<void> {
    const row = this.captured.find(
      (entry) => entry.ticketId === ticketId && entry.messageId === messageId,
    );
    if (row) row.deletedAt = at;
  }

  async listMessages(ticketId: string): Promise<TicketMessage[]> {
    return this.captured
      .filter((entry) => entry.ticketId === ticketId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(({ expiresAt: _expiresAt, ...message }) => message);
  }

  async purgeExpiredMessages(now: Date, limit: number): Promise<number> {
    const doomed = this.captured
      .filter((entry) => entry.expiresAt.getTime() <= now.getTime())
      .slice(0, limit);

    for (const row of doomed) {
      const index = this.captured.indexOf(row);
      if (index >= 0) this.captured.splice(index, 1);
    }

    return doomed.length;
  }

  async blacklist(input: BlacklistInput): Promise<BlacklistEntry> {
    const key = `${input.guildId}:${input.userId}`;
    const existing = this.blocked.get(key);

    const entry: BlacklistEntry = {
      id: existing?.id ?? newId(),
      guildId: input.guildId,
      userId: input.userId,
      reason: input.reason,
      createdBy: input.createdBy,
      createdAt: this.#now(),
      expiresAt: input.expiresAt,
    };

    this.blocked.set(key, entry);
    return entry;
  }

  async unblacklist(guildId: string, userId: string): Promise<boolean> {
    return this.blocked.delete(`${guildId}:${userId}`);
  }

  async blacklistEntry(guildId: string, userId: string, now: Date): Promise<BlacklistEntry | null> {
    const entry = this.blocked.get(`${guildId}:${userId}`);
    if (!entry) return null;

    return entry.expiresAt === null || entry.expiresAt.getTime() >= now.getTime() ? entry : null;
  }

  async listBlacklist(guildId: string): Promise<BlacklistEntry[]> {
    return [...this.blocked.values()]
      .filter((entry) => entry.guildId === guildId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async saveRating(input: Omit<TicketRating, 'createdAt'>): Promise<boolean> {
    if (this.ratings.has(input.ticketId)) return false;

    this.ratings.set(input.ticketId, { ...input, createdAt: this.#now() });
    return true;
  }

  async getRating(ticketId: string): Promise<TicketRating | null> {
    return this.ratings.get(ticketId) ?? null;
  }

  async stats(guildId: string, since: Date): Promise<TicketStats> {
    const scope = this.#of(guildId).filter(
      (ticket) => ticket.openedAt.getTime() >= since.getTime(),
    );

    const average = (values: number[]): number | null =>
      values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

    const tally = (key: (ticket: Ticket) => string): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const ticket of scope) counts[key(ticket)] = (counts[key(ticket)] ?? 0) + 1;
      return counts;
    };

    const byStaff = new Map<string, { userId: string; claimed: number; closed: number }>();

    for (const ticket of scope) {
      if (ticket.claimedById === null) continue;

      const entry = byStaff.get(ticket.claimedById) ?? {
        userId: ticket.claimedById,
        claimed: 0,
        closed: 0,
      };

      entry.claimed += 1;
      if (ticket.closedAt !== null) entry.closed += 1;
      byStaff.set(ticket.claimedById, entry);
    }

    const rated = [...this.ratings.values()].filter(
      (rating) => rating.guildId === guildId && rating.createdAt.getTime() >= since.getTime(),
    );

    return {
      opened: scope.length,
      closed: scope.filter((ticket) => ticket.closedAt !== null).length,
      reopened: this.events.filter(
        (entry) =>
          entry.guildId === guildId &&
          entry.type === 'reopened' &&
          entry.at.getTime() >= since.getTime(),
      ).length,
      open: scope.filter((ticket) => ticket.status === 'open').length,
      averageResolutionMs: average(
        scope
          .filter((ticket) => ticket.closedAt !== null)
          .map((ticket) => (ticket.closedAt?.getTime() ?? 0) - ticket.openedAt.getTime()),
      ),
      averageFirstResponseMs: average(
        scope
          .filter((ticket) => ticket.firstResponseAt !== null)
          .map((ticket) => (ticket.firstResponseAt?.getTime() ?? 0) - ticket.openedAt.getTime()),
      ),
      averageRating: average(rated.map((rating) => rating.rating)),
      ratings: rated.length,
      byPriority: tally((ticket) => ticket.priority),
      byType: tally((ticket) => ticket.typeId),
      byStaff: [...byStaff.values()].sort((a, b) => b.claimed - a.claimed).slice(0, 25),
    };
  }
}

class MemoryDedupe implements DedupeStore {
  readonly #claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.#claimed.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.#claimed.has(key);
  }
}

class MemoryRecorder implements CaseRecorder {
  readonly recorded: CaseInput[] = [];

  async record(input: CaseInput): Promise<{ caseId: string }> {
    this.recorded.push(input);
    return { caseId: newId() };
  }
}

export type RouteMatcher = string | ((call: { method: string; path: string }) => boolean);

export class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];

  response: RestResponse = { status: 200, body: { id: CREATED } };

  readonly #scripted: Array<{ match: RouteMatcher; response: RestResponse }> = [];

  fail(match: RouteMatcher, response: RestResponse): void {
    this.#scripted.push({ match, response });
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    const scripted = this.#scripted.find((entry) =>
      typeof entry.match === 'string' ? options.path.includes(entry.match) : entry.match(options),
    );

    return scripted?.response ?? this.response;
  }
}

export interface Scheduled {
  jobId: string;
  runAt: Date;
  naturalKey: string;
  data: unknown;
  options: ScheduleOptions | undefined;
}

export interface Published {
  type: string;
  naturalKey: string;
  payload: unknown;
}

export interface Overrides {
  config: Partial<TicketsConfig>;
  deps: TicketsDeps;
  tier: EntitlementTier;
  botPermissions: bigint;

  // false builds a context with no schedule/cancel, which is what a deployment with no durable
  // scheduler looks like to the module.
  scheduler: boolean;

  channelId: string;
  messageId: string;
  eventId: string;
  idempotencyKey: string;

  userId: string;
  roleIds: string[];
  permissions: bigint;

  componentType: number;
  values: Record<string, string[]>;
}

export const STAFF: Partial<Overrides> = { userId: HELPER, roleIds: [SUPPORT_ROLE] };

export const OTHER_STAFF: Partial<Overrides> = {
  userId: OTHER_HELPER,
  roleIds: [SUPPORT_ROLE],
};

export const MOD: Partial<Overrides> = {
  userId: HELPER,
  permissions: Permissions.ManageChannels,
};

export const ADMIN: Partial<Overrides> = {
  userId: HELPER,
  permissions: Permissions.ManageGuild,
};

export interface HarnessOptions {
  config?: Partial<TicketsConfig>;
  botPermissions?: bigint;
  tier?: EntitlementTier;
  now?: number;
}

export interface Harness {
  rest: FakeRest;
  store: MemoryTicketStore;
  recorder: MemoryRecorder;
  deps: TicketsDeps;

  logs: Array<{ level: string; message: string }>;
  published: Published[];
  scheduled: Scheduled[];
  cancelled: Array<{ jobId: string; naturalKey: string }>;

  now(): Date;
  advance(ms: number): void;

  ticket(): Ticket;

  calls(): RestRequestOptions[];
  discordCalls(): RestRequestOptions[];
  sentIn(channelId: string): Array<Record<string, unknown>>;
  sentFiles(): RestFile[];

  replies(): string[];
  replyContent(): string | null;
  followUps(): string[];
  followUpContent(): string | null;
  told(): string[];
  lastTold(): string | null;

  components(): Record<string, unknown>[];
  buttonIds(): string[];
  callbackTypes(): number[];
  modalOpened(): Record<string, unknown> | null;

  context(overrides?: Partial<Overrides>): ModuleContext<TicketsConfig>;

  press(event: ProtonEvent, overrides?: Partial<Overrides>): Promise<void>;
  submit(
    customId: string,
    fields: Record<string, string>,
    overrides?: Partial<Overrides>,
  ): Promise<void>;
  select(customId: string, values: string[], overrides?: Partial<Overrides>): Promise<void>;
  run(options: RawOption[], overrides?: Partial<Overrides>): Promise<void>;

  // Straight to the handler, skipping the listener's enabled gate, for tests that read the outcome
  // rather than what the member was told.
  handle(event: ProtonEvent, overrides?: Partial<Overrides>): Promise<PressOutcome>;
}

export function harness(options: HarnessOptions = {}): Harness {
  let clock = options.now ?? Date.UTC(2026, 7, 24, 12, 0, 0);

  const now = (): Date => new Date(clock);

  const rest = new FakeRest();
  const store = new MemoryTicketStore(now);
  const dedupe = new MemoryDedupe();
  const recorder = new MemoryRecorder();

  const logs: Array<{ level: string; message: string }> = [];
  const published: Published[] = [];
  const scheduled: Scheduled[] = [];
  const cancelled: Array<{ jobId: string; naturalKey: string }> = [];

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const stateFor = (botPermissions: bigint): GuildStateStore => ({
    get: async () => guildState(botPermissions),
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  });

  const deps: TicketsDeps = {
    store,
    applicationId: BOT,
    botUserId: BOT,
    guildState: stateFor(options.botPermissions ?? BOT_PERMISSIONS),
    displayName: async (userId) => NAMES[userId] ?? null,
    guildName: async () => 'Test Guild',
    now,
  };

  const executorFor = (botPermissions: bigint, channelId: string) =>
    new DefaultActionExecutor({
      dedupe,
      rest,
      recorder,
      resolveContext: async (
        request,
        hints,
      ): Promise<PrecheckInput | { failure: { code: string; humanReason: string } }> => {
        const resolved = await resolvePrecheckContext(
          { store: stateFor(botPermissions), botUserId: BOT, fetchMemberRoles: async () => [] },
          request,
          (hints ?? {}) as ResolveContextHints,
        );
        return 'context' in resolved ? resolved.context : resolved;
      },
    }).scoped({ channelId, appPermissions: botPermissions });

  const configOf = (overrides: Partial<Overrides>): TicketsConfig => ({
    ...ticketsDefaultConfig,
    enabled: true,
    types: [TYPE],
    panels: [PANEL],
    ...options.config,
    ...overrides.config,
  });

  const schedule = async (
    jobId: string,
    runAt: Date,
    naturalKey: string,
    data?: unknown,
    options?: ScheduleOptions,
  ): Promise<ScheduleOutcome> => {
    scheduled.push({ jobId, runAt, naturalKey, data, options });
    return { scheduled: true, replaced: false };
  };

  const cancel = async (jobId: string, naturalKey: string): Promise<void> => {
    cancelled.push({ jobId, naturalKey });
  };

  const publish = async (type: string, naturalKey: string, payload: unknown): Promise<void> => {
    published.push({ type, naturalKey, payload });
  };

  const context = (overrides: Partial<Overrides> = {}): ModuleContext<TicketsConfig> => ({
    guildId: GUILD,
    config: configOf(overrides),
    tier: overrides.tier ?? options.tier ?? 'free',
    executor: executorFor(
      overrides.botPermissions ?? options.botPermissions ?? BOT_PERMISSIONS,
      overrides.channelId ?? TICKET_CHANNEL,
    ),
    logger,
    publish,
    ...(overrides.scheduler === false ? {} : { schedule, cancel }),
  });

  const dataOf = (call: RestRequestOptions): Record<string, unknown> => {
    const body = (call.body ?? {}) as Record<string, unknown>;

    return call.path.startsWith('/interactions/')
      ? ((body.data as Record<string, unknown> | undefined) ?? {})
      : body;
  };

  const contentsOf = (calls: readonly RestRequestOptions[]): string[] =>
    calls
      .map((call) => dataOf(call).content)
      .filter((content): content is string => typeof content === 'string' && content.length > 0);

  const callbacks = (): RestRequestOptions[] =>
    rest.calls.filter((call) => call.path.startsWith('/interactions/'));

  const webhooks = (): RestRequestOptions[] =>
    rest.calls.filter((call) => call.path.startsWith('/webhooks/'));

  const facing = (): RestRequestOptions[] =>
    rest.calls.filter(
      (call) => call.path.startsWith('/interactions/') || call.path.startsWith('/webhooks/'),
    );

  const components = (): Record<string, unknown>[] => {
    const last = rest.calls
      .map(dataOf)
      .filter((data) => Array.isArray(data.components) && data.components.length > 0)
      .at(-1);

    return (last?.components as Record<string, unknown>[] | undefined) ?? [];
  };

  const memberOf = (overrides: Partial<Overrides>): Record<string, unknown> => ({
    user: { id: overrides.userId ?? MEMBER, username: 'presser', bot: false },
    roles: overrides.roleIds ?? [],
    permissions: String(overrides.permissions ?? 0n),
    joined_at: '2026-08-15T12:00:00.000000+00:00',
  });

  const interactionEvent = (
    type: 'interaction.component' | 'interaction.modal',
    overrides: Partial<Overrides>,
    data: Record<string, unknown>,
  ): ProtonEvent => {
    const component = type === 'interaction.component';

    return {
      id: overrides.eventId ?? newId(),
      type,
      guildId: GUILD,
      occurredAt: clock,
      payload: {
        id: INTERACTION,
        application_id: BOT,
        type: component ? InteractionType.MessageComponent : InteractionType.ModalSubmit,
        token: 'interaction-token',
        guild_id: GUILD,
        channel_id: overrides.channelId ?? TICKET_CHANNEL,
        channel: { id: overrides.channelId ?? TICKET_CHANNEL, type: TEXT_CHANNEL_TYPE },
        member: memberOf(overrides),
        app_permissions: String(overrides.botPermissions ?? BOT_PERMISSIONS),
        ...(component
          ? {
              message: {
                id: overrides.messageId ?? PANEL_MESSAGE,
                channel_id: overrides.channelId ?? TICKET_CHANNEL,
              },
            }
          : {}),
        data,
      },
    };
  };

  // Every listener that declares the event type, the way the worker routes it — not just the
  // interaction one, or a message event would silently reach nothing.
  const listen = async (event: ProtonEvent, overrides: Partial<Overrides>): Promise<void> => {
    const bound = overrides.deps ?? deps;
    const ctx = context(overrides);

    for (const listener of createTicketsModule(bound).listeners ?? []) {
      if (!listener.types.includes(event.type)) continue;
      await listener.handler(event, ctx);
    }
  };

  return {
    rest,
    store,
    recorder,
    deps,
    logs,
    published,
    scheduled,
    cancelled,

    now,
    advance: (ms) => {
      clock += ms;
    },

    ticket() {
      const rows = [...store.rows.values()];
      const only = rows[0];

      if (rows.length !== 1 || !only) {
        throw new Error(`the store holds ${rows.length} tickets, so 'the' ticket is ambiguous`);
      }

      return only;
    },

    calls: () => rest.calls,

    discordCalls: () =>
      rest.calls.filter(
        (call) => !call.path.startsWith('/interactions/') && !call.path.startsWith('/webhooks/'),
      ),

    sentIn: (channelId) =>
      rest.calls
        .filter((call) => call.method === 'POST' && call.path === `/channels/${channelId}/messages`)
        .map((call) => (call.body ?? {}) as Record<string, unknown>),

    sentFiles: () => rest.calls.flatMap((call) => call.files ?? []),

    replies: () => contentsOf(callbacks()),
    replyContent: () => contentsOf(callbacks()).at(-1) ?? null,

    followUps: () => contentsOf(webhooks()),
    followUpContent: () => contentsOf(webhooks()).at(-1) ?? null,

    told: () => contentsOf(facing()),
    lastTold: () => contentsOf(facing()).at(-1) ?? null,

    components,

    buttonIds: () => customIds(components()),

    callbackTypes: () =>
      callbacks()
        .map((call) => (call.body as { type?: number } | undefined)?.type)
        .filter((type): type is number => typeof type === 'number'),

    modalOpened: () => {
      const opened = callbacks()
        .map((call) => call.body as { type?: number; data?: Record<string, unknown> } | undefined)
        .findLast((body) => body?.type === INTERACTION_CALLBACK_MODAL);

      return opened?.data ?? null;
    },

    context,

    press: (event, overrides = {}) => listen(event, overrides),

    submit(customId, fields, overrides = {}) {
      const selected = overrides.values ?? {};

      const entries = [
        ...Object.entries(fields).map(([fieldId, value]) => ({
          type: ComponentType.TextInput,
          custom_id: fieldId,
          value,
        })),
        ...Object.entries(selected).map(([fieldId, values]) => ({
          type: ComponentType.StringSelect,
          custom_id: fieldId,
          values,
        })),
      ];

      return listen(
        interactionEvent('interaction.modal', overrides, {
          custom_id: customId,
          components: entries.map((component, index) => ({
            id: index + 1,
            type: ComponentType.Label,
            label: component.custom_id,
            component: { id: index + 100, ...component },
          })),
        }),
        overrides,
      );
    },

    select(customId, values, overrides = {}) {
      return listen(
        interactionEvent('interaction.component', overrides, {
          custom_id: customId,
          component_type: overrides.componentType ?? ComponentType.StringSelect,
          values,
        }),
        overrides,
      );
    },

    async run(options_, overrides = {}) {
      const definition = ticketsCommands(overrides.deps ?? deps)[0];
      if (!definition) throw new Error('no /ticket command');

      const channelId = overrides.channelId ?? TICKET_CHANNEL;

      const ctx: CommandContext<TicketsConfig> = {
        ...context(overrides),
        channelId,
        userId: overrides.userId ?? MEMBER,
        actorRoleIds: overrides.roleIds ?? [],
        actorPermissions: overrides.permissions ?? 0n,
        options: createCommandOptions(options_),
        interaction: { id: INTERACTION, token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? newId(),
      };

      await definition.handler(ctx);
    },

    handle: (event, overrides = {}) =>
      handleTicketInteraction(event, context(overrides), overrides.deps ?? deps),
  };
}

function customIds(nodes: readonly unknown[], found: string[] = []): string[] {
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;

    const entry = node as Record<string, unknown>;

    if (typeof entry.custom_id === 'string') found.push(entry.custom_id);
    if (Array.isArray(entry.components)) customIds(entry.components, found);
    if (entry.accessory) customIds([entry.accessory], found);
    if (entry.component) customIds([entry.component], found);
  }

  return found;
}

export function pressEvent(customId: string, overrides: Partial<Overrides> = {}): ProtonEvent {
  return {
    id: overrides.eventId ?? newId(),
    type: 'interaction.component',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      id: INTERACTION,
      application_id: BOT,
      type: InteractionType.MessageComponent,
      token: 'interaction-token',
      guild_id: GUILD,
      channel_id: overrides.channelId ?? TICKET_CHANNEL,
      channel: { id: overrides.channelId ?? TICKET_CHANNEL, type: TEXT_CHANNEL_TYPE },
      member: {
        user: { id: overrides.userId ?? MEMBER, username: 'presser', bot: false },
        roles: overrides.roleIds ?? [],
        // A decimal string, because that is what Discord sends and readMemberPermissions parses;
        // '0' is a member who may do nothing, so every staff control has to be opted into.
        permissions: String(overrides.permissions ?? 0n),
        joined_at: '2026-08-15T12:00:00.000000+00:00',
      },
      app_permissions: String(overrides.botPermissions ?? BOT_PERMISSIONS),
      message: {
        id: overrides.messageId ?? PANEL_MESSAGE,
        channel_id: overrides.channelId ?? TICKET_CHANNEL,
      },
      data: {
        custom_id: customId,
        component_type: overrides.componentType ?? ComponentType.Button,
      },
    },
  };
}

export interface MessageOverrides {
  type: 'message.created' | 'message.updated' | 'message.deleted';
  userId: string;
  roleIds: string[];
  isBot: boolean;
  content: string;
  messageId: string;
  attachments: Array<Record<string, unknown>>;
  embeds: Array<Record<string, unknown>>;
  replyToId: string;
}

export function messageEvent(
  channelId: string,
  overrides: Partial<MessageOverrides> = {},
): ProtonEvent {
  return {
    id: newId(),
    type: overrides.type ?? 'message.created',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      id: overrides.messageId ?? '700000000000000002',
      channel_id: channelId,
      guild_id: GUILD,
      author: {
        id: overrides.userId ?? MEMBER,
        username: NAMES[overrides.userId ?? MEMBER] ?? 'member',
        bot: overrides.isBot ?? false,
      },
      member: { roles: overrides.roleIds ?? [] },
      content: overrides.content ?? 'hello',
      attachments: overrides.attachments ?? [],
      embeds: overrides.embeds ?? [],
      ...(overrides.replyToId ? { message_reference: { message_id: overrides.replyToId } } : {}),
    },
  };
}

export function subcommand(name: string, options: RawOption[] = []): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options }];
}

export function group(name: string, sub: string, options: RawOption[] = []): RawOption[] {
  return [{ name, type: OptionType.SubcommandGroup, options: subcommand(sub, options) }];
}

export function integerOption(name: string, value: number): RawOption {
  return { name, type: OptionType.Integer, value };
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function userOption(name: string, value: string): RawOption {
  return { name, type: OptionType.User, value };
}

export function channelOption(name: string, value: string): RawOption {
  return { name, type: OptionType.Channel, value };
}

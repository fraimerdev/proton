import type { CaseInput, CaseRecorder } from '@proton/core';
import type {
  BufferedMessage,
  CaseLedger,
  CaseMatch,
  CaseMessage,
  CaseMessageStore,
  CaseStamp,
  DmChannelStore,
  LedgerCase,
  MessageHistoryBuffer,
  NewCaseMessage,
  NewTimeout,
  TimeoutClose,
  TimeoutRow,
  TimeoutStore,
} from '../src/punish/store.ts';

function copy<T extends object>(value: T): T {
  return { ...value };
}

export class MemoryTimeoutStore implements TimeoutStore {
  readonly rows = new Map<string, TimeoutRow>();

  async record(row: NewTimeout): Promise<boolean> {
    if (this.rows.has(row.caseId)) return false;

    this.rows.set(row.caseId, {
      caseId: row.caseId,
      guildId: row.guildId,
      userId: row.userId,
      startedAt: row.startedAt.getTime(),
      endsAt: row.endsAt.getTime(),
      appliedUntil: row.appliedUntil === null ? null : row.appliedUntil.getTime(),
      closedAt: null,
      closedBy: null,
      closeReason: null,
      expiryLoggedAt: null,
    });
    return true;
  }

  async open(guildId: string, userId: string): Promise<TimeoutRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.guildId === guildId && row.userId === userId && row.closedAt === null)
      .sort((a, b) => a.endsAt - b.endsAt)
      .map(copy);
  }

  async openUsers(guildId: string): Promise<string[]> {
    const users = new Set<string>();
    for (const row of this.rows.values()) {
      if (row.guildId === guildId && row.closedAt === null) users.add(row.userId);
    }
    return [...users];
  }

  #closeWhere(predicate: (row: TimeoutRow) => boolean, close: TimeoutClose): TimeoutRow[] {
    const closed: TimeoutRow[] = [];

    for (const row of this.rows.values()) {
      if (row.closedAt !== null || !predicate(row)) continue;

      row.closedAt = close.at.getTime();
      row.closedBy = close.by;
      row.closeReason = close.reason;
      closed.push(copy(row));
    }

    return closed;
  }

  async close(
    guildId: string,
    caseIds: readonly string[],
    close: TimeoutClose,
  ): Promise<TimeoutRow[]> {
    const ids = new Set(caseIds);
    return this.#closeWhere((row) => row.guildId === guildId && ids.has(row.caseId), close);
  }

  async closeOpen(
    guildId: string,
    userId: string,
    close: TimeoutClose,
    options: { except?: string } = {},
  ): Promise<TimeoutRow[]> {
    return this.#closeWhere(
      (row) => row.guildId === guildId && row.userId === userId && row.caseId !== options.except,
      close,
    );
  }

  async setAppliedUntil(guildId: string, userId: string, until: Date): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.guildId === guildId && row.userId === userId && row.closedAt === null) {
        row.appliedUntil = until.getTime();
      }
    }
  }

  async markExpiryLogged(guildId: string, caseId: string, at: Date): Promise<boolean> {
    const row = this.rows.get(caseId);
    if (!row || row.guildId !== guildId || row.expiryLoggedAt !== null) return false;

    row.expiryLoggedAt = at.getTime();
    return true;
  }

  async trackedCaseIds(guildId: string, userId: string): Promise<string[]> {
    return [...this.rows.values()]
      .filter((row) => row.guildId === guildId && row.userId === userId)
      .map((row) => row.caseId);
  }
}

interface StoredCase extends LedgerCase {
  guildId: string;
  dryRun: boolean;
}

export class MemoryCaseLedger implements CaseLedger {
  readonly cases: StoredCase[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  follow(recorder: CaseRecorder): void {
    const record = recorder.record.bind(recorder);

    recorder.record = async (input: CaseInput) => {
      const recorded = await record(input);
      this.add(input, recorded.caseId);
      return recorded;
    };
  }

  add(input: CaseInput, caseId: string): void {
    this.cases.push({
      caseId,
      guildId: input.guildId,
      kind: input.kind,
      targetId: input.targetId ?? null,
      actorId: input.actorId,
      reason: input.reason ?? null,
      idempotencyKey: input.idempotencyKey,
      createdAt: this.#now(),
      expiresAt: input.expiresAt ? input.expiresAt.getTime() : null,
      revertedAt: null,
      revertedBy: null,
      dryRun: input.dryRun,
    });
  }

  seed(entry: Partial<StoredCase> & Pick<StoredCase, 'caseId' | 'guildId' | 'kind'>): void {
    this.cases.push({
      targetId: null,
      actorId: null,
      reason: null,
      idempotencyKey: `seed:${entry.caseId}`,
      createdAt: this.#now(),
      expiresAt: null,
      revertedAt: null,
      revertedBy: null,
      dryRun: false,
      ...entry,
    });
  }

  #live(guildId: string): StoredCase[] {
    return this.cases.filter((entry) => entry.guildId === guildId && !entry.dryRun);
  }

  #view({ guildId: _guild, dryRun: _dry, ...entry }: StoredCase): LedgerCase {
    return entry;
  }

  async recent(
    guildId: string,
    targetId: string,
    kind: string,
    since: Date,
  ): Promise<LedgerCase | null> {
    const found = this.#live(guildId)
      .filter(
        (entry) =>
          entry.targetId === targetId &&
          entry.kind === kind &&
          entry.revertedAt === null &&
          entry.createdAt >= since.getTime(),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    return found ? this.#view(found) : null;
  }

  async closeOpen(guildId: string, match: CaseMatch, stamp: CaseStamp): Promise<LedgerCase[]> {
    const ids = match.caseIds === undefined ? null : new Set(match.caseIds);
    const except = new Set(match.exceptCaseIds ?? []);
    const after = match.createdAfter?.getTime() ?? null;
    const closed: LedgerCase[] = [];

    for (const entry of this.#live(guildId)) {
      if (entry.targetId !== match.targetId || entry.kind !== match.kind) continue;
      if (entry.revertedAt !== null || (ids !== null && !ids.has(entry.caseId))) continue;
      if (except.has(entry.caseId) || (after !== null && entry.createdAt < after)) continue;

      entry.revertedAt = stamp.at.getTime();
      entry.revertedBy = stamp.by;
      closed.push(this.#view(entry));
    }

    return closed;
  }

  async byIdempotencyKey(
    guildId: string,
    key: string,
  ): Promise<{ caseId: string; kind: string; revertedAt: number | null } | null> {
    const found = this.cases.find(
      (entry) => entry.guildId === guildId && entry.idempotencyKey === key,
    );
    return found ? { caseId: found.caseId, kind: found.kind, revertedAt: found.revertedAt } : null;
  }

  async find(guildId: string, caseId: string): Promise<LedgerCase | null> {
    const found = this.cases.find((entry) => entry.guildId === guildId && entry.caseId === caseId);
    return found ? this.#view(found) : null;
  }

  async countsForTarget(guildId: string, targetId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const entry of this.#live(guildId)) {
      if (entry.targetId === targetId) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    }
    return counts;
  }

  async lastCase(guildId: string, targetId: string): Promise<LedgerCase | null> {
    const found = this.#live(guildId)
      .filter((entry) => entry.targetId === targetId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    return found ? this.#view(found) : null;
  }
}

export class MemoryCaseMessageStore implements CaseMessageStore {
  readonly rows: CaseMessage[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async save(rows: readonly NewCaseMessage[]): Promise<number> {
    let saved = 0;

    for (const row of rows) {
      const exists = this.rows.some(
        (stored) => stored.caseId === row.caseId && stored.messageId === row.messageId,
      );
      if (exists) continue;

      this.rows.push({ ...row, capturedAt: this.#now() });
      saved += 1;
    }

    return saved;
  }

  async forCase(guildId: string, caseId: string): Promise<CaseMessage[]> {
    return this.rows
      .filter((row) => row.guildId === guildId && row.caseId === caseId)
      .sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId))
      .map(copy);
  }

  async purgeExpired(now: Date): Promise<number> {
    const before = this.rows.length;
    const kept = this.rows.filter((row) => row.expiresAt > now.getTime());
    this.rows.splice(0, this.rows.length, ...kept);
    return before - kept.length;
  }
}

export class MemoryHistoryBuffer implements MessageHistoryBuffer {
  readonly messages = new Map<string, BufferedMessage[]>();

  async record(guildId: string, message: BufferedMessage): Promise<void> {
    const list = this.messages.get(guildId) ?? [];
    list.push({ ...message });
    this.messages.set(guildId, list);
  }

  async markDeleted(
    guildId: string,
    channelId: string,
    messageId: string,
    at: number,
  ): Promise<void> {
    for (const message of this.messages.get(guildId) ?? []) {
      if (message.channelId === channelId && message.messageId === messageId) {
        message.deletedAt = at;
      }
    }
  }

  async recent(guildId: string, userId: string, _now: number): Promise<BufferedMessage[]> {
    return (this.messages.get(guildId) ?? [])
      .filter((message) => message.authorId === userId)
      .map(copy);
  }

  async purge(guildId: string): Promise<void> {
    this.messages.delete(guildId);
  }
}

export class MemoryDmChannelStore implements DmChannelStore {
  readonly channels = new Map<string, string>();

  async recall(guildId: string, userId: string): Promise<string | null> {
    return this.channels.get(`${guildId}:${userId}`) ?? null;
  }

  async remember(guildId: string, userId: string, channelId: string): Promise<void> {
    this.channels.set(`${guildId}:${userId}`, channelId);
  }
}

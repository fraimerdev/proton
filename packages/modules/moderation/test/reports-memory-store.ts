import { newCaseId } from '@proton/core';
import type { z } from 'zod';
import { type DraftStore, parseDraft } from '../src/drafts.ts';
import type { PromptStore, ReactionClaim, ReactionGate } from '../src/reports/redis-store.ts';
import {
  type BeginDecisionInput,
  type BeginDecisionResult,
  CARD_ATTEMPTS_MAX,
  type CardRefs,
  CLOSE_ATTEMPTS_MAX,
  type ClaimRunInput,
  cardBackoffMs,
  type NewReport,
  type QualifyingQuery,
  type QualifyingReport,
  type ReportEventInput,
  type ReportStore,
  type ResolveInput,
  SUBMIT_ID_ATTEMPTS,
  type SubmitLimits,
  type SubmitResult,
  type TargetStats,
} from '../src/reports/store.ts';
import {
  type AutomationRun,
  type AutomationRunStatus,
  type CardState,
  type CloseAction,
  EVIDENCE_OPEN_TTL_MS,
  type EvidenceCopy,
  isActiveStatus,
  type NotificationKind,
  type NotificationOutcome,
  type ReportEventRecord,
  type ReportEvidence,
  type ReportRecord,
  type RunOutcome,
} from '../src/reports/types.ts';

function copy<T>(value: T): T {
  return structuredClone(value);
}

function purgedEvidence(evidence: ReportEvidence): ReportEvidence {
  const message = evidence.message;

  return {
    purged: true,
    links: evidence.links.map((link) => ({ url: link.url, status: link.status })),
    attachments: [],
    ...(message
      ? {
          message:
            message.status === 'captured'
              ? {
                  status: 'unavailable' as const,
                  reason: 'purged' as const,
                  ids: { channelId: message.snapshot.channelId, messageId: message.snapshot.id },
                }
              : message,
        }
      : {}),
    ...(evidence.copy ? { copy: evidence.copy } : {}),
  };
}

export class MemoryReportStore implements ReportStore {
  readonly rows = new Map<string, ReportRecord>();
  readonly events = new Map<string, ReportEventRecord>();
  readonly runs = new Map<string, AutomationRun>();
  readonly editFailures = new Map<string, number>();

  // Taken between the limit checks and the insert, the gap two racing submissions would slip
  // through if the chain below did not serialise them the way the advisory lock does.
  gap: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0));

  mintId: () => string = newCaseId;

  readonly #now: () => number;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  #find(guildId: string, id: string): ReportRecord | null {
    const row = this.rows.get(id);
    return row && row.guildId === guildId ? row : null;
  }

  #update(
    guildId: string,
    id: string,
    when: (row: ReportRecord) => boolean,
    change: (row: ReportRecord) => void,
  ): ReportRecord | null {
    const row = this.#find(guildId, id);
    if (!row || !when(row)) return null;

    change(row);
    return copy(row);
  }

  #inGuild(guildId: string): ReportRecord[] {
    return [...this.rows.values()].filter((row) => row.guildId === guildId);
  }

  seed(record: ReportRecord): void {
    this.rows.set(record.id, copy(record));
  }

  async submit(input: NewReport, limits: SubmitLimits): Promise<SubmitResult> {
    return this.#serial(async () => {
      const replayed = [...this.rows.values()].find(
        (row) => row.idempotencyKey === input.idempotencyKey,
      );
      if (replayed) return { status: 'existing', report: copy(replayed) };

      const mine = this.#inGuild(input.guildId);

      if (!limits.bypassCooldown && limits.cooldownMs > 0) {
        const latest = mine
          .filter((row) => row.reporterId === input.reporterId)
          .reduce((max, row) => Math.max(max, row.createdAt), Number.NEGATIVE_INFINITY);
        const retryAt = latest + limits.cooldownMs;
        if (Number.isFinite(latest) && retryAt > input.now) {
          return { status: 'refused', code: 'cooldown', retryAt };
        }
      }

      const open = mine.filter((row) => isActiveStatus(row.status));

      if (limits.duplicateProtection) {
        const duplicate = open.find(
          (row) =>
            row.reporterId === input.reporterId &&
            row.targetId === input.targetId &&
            (row.sourceMessageId ?? '') === (input.source?.messageId ?? ''),
        );
        if (duplicate) return { status: 'refused', code: 'duplicate', reportId: duplicate.id };
      }

      if (open.filter((row) => row.targetId === input.targetId).length >= limits.maxOpenPerMember) {
        return { status: 'refused', code: 'member_cap' };
      }
      if (open.length >= limits.maxOpenPerServer) {
        return { status: 'refused', code: 'server_cap' };
      }

      await this.gap();

      const number = mine.reduce((max, row) => Math.max(max, row.number), 0) + 1;

      for (let attempt = 1; attempt <= SUBMIT_ID_ATTEMPTS; attempt += 1) {
        const id = this.mintId();
        if (this.rows.has(id)) continue;

        const record: ReportRecord = {
          id,
          guildId: input.guildId,
          number,
          reporterId: input.reporterId,
          targetId: input.targetId,
          method: input.method,
          status: 'open',
          reasonId: input.reasonId,
          reason: input.reason,
          customReason: input.customReason,
          comment: input.comment,
          sourceChannelId: input.source?.channelId ?? null,
          sourceMessageId: input.source?.messageId ?? null,
          sourceAuthorId: input.source?.authorId ?? null,
          evidence: copy(input.evidence),
          evidenceExpiresAt: input.now + EVIDENCE_OPEN_TTL_MS,
          evidencePurgedAt: null,
          assigneeId: null,
          assignedAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
          reporterNote: null,
          actionKind: null,
          caseIds: [],
          card: {
            channelId: null,
            messageId: null,
            evidenceMessageId: null,
            state: 'pending',
            error: null,
            attempts: 0,
            version: 0,
          },
          close: { action: null, dueAt: null, closedAt: null, attempts: 0, error: null },
          decision: { token: null, kind: null, startedAt: null },
          notifications: {},
          dmChannelId: null,
          dmAttempts: 0,
          version: 0,
          idempotencyKey: input.idempotencyKey,
          createdAt: input.now,
          updatedAt: input.now,
        };

        this.rows.set(id, record);
        await this.recordEvent({
          id: `${id}:submitted`,
          reportId: id,
          guildId: input.guildId,
          kind: 'submitted',
          actorId: input.reporterId,
          source: 'discord',
          data: { method: input.method },
          at: input.now,
        });

        return { status: 'filed', report: copy(record) };
      }

      throw new Error(
        `could not mint an unused report id in ${SUBMIT_ID_ATTEMPTS} attempts; nothing was filed`,
      );
    });
  }

  async get(guildId: string, id: string): Promise<ReportRecord | null> {
    const row = this.#find(guildId, id);
    return row ? copy(row) : null;
  }

  async byCardMessage(guildId: string, messageId: string): Promise<ReportRecord | null> {
    const row = this.#inGuild(guildId).find((candidate) => candidate.card.messageId === messageId);
    return row ? copy(row) : null;
  }

  async byIdempotency(guildId: string, key: string): Promise<ReportRecord | null> {
    const row = this.#inGuild(guildId).find((candidate) => candidate.idempotencyKey === key);
    return row ? copy(row) : null;
  }

  async claim(
    guildId: string,
    id: string,
    assigneeId: string,
    now: number,
  ): Promise<ReportRecord | null> {
    return this.#update(
      guildId,
      id,
      (row) =>
        row.status === 'open' || (row.status === 'in_review' && row.assigneeId === assigneeId),
      (row) => {
        const theirs = row.status === 'in_review' && row.assigneeId === assigneeId;
        row.status = 'in_review';
        row.assigneeId = assigneeId;
        if (!theirs) {
          row.assignedAt = now;
          row.version += 1;
        }
        row.updatedAt = now;
      },
    );
  }

  async assign(
    guildId: string,
    id: string,
    assigneeId: string | null,
    now: number,
  ): Promise<ReportRecord | null> {
    return this.#update(
      guildId,
      id,
      (row) => isActiveStatus(row.status),
      (row) => {
        row.status = assigneeId === null ? 'open' : 'in_review';
        row.assigneeId = assigneeId;
        row.assignedAt = assigneeId === null ? null : now;
        row.version += 1;
        row.updatedAt = now;
      },
    );
  }

  async unclaim(guildId: string, id: string, now: number): Promise<ReportRecord | null> {
    return this.#update(
      guildId,
      id,
      (row) => row.status === 'in_review',
      (row) => {
        row.status = 'open';
        row.assigneeId = null;
        row.assignedAt = null;
        row.version += 1;
        row.updatedAt = now;
      },
    );
  }

  async beginDecision(input: BeginDecisionInput): Promise<BeginDecisionResult> {
    return this.#serial(async () => {
      const row = this.#find(input.guildId, input.id);
      if (!row) return { state: 'missing', mine: false, takeover: null, report: null };

      const mine = row.decision.token === input.token;

      if (!isActiveStatus(row.status)) {
        return { state: 'resolved', mine, takeover: null, report: copy(row) };
      }

      if (mine) return { state: 'acquired', mine, takeover: null, report: copy(row) };

      const held = row.decision.token !== null;
      const startedAt = row.decision.startedAt;
      const fresh = startedAt !== null && startedAt + input.staleMs > input.now;

      if (held && fresh) {
        return { state: 'held_by_other', mine: false, takeover: null, report: copy(row) };
      }

      const takeover =
        row.decision.token !== null ? { token: row.decision.token, kind: row.decision.kind } : null;

      row.decision = { token: input.token, kind: input.kind, startedAt: input.now };
      row.updatedAt = input.now;

      return { state: 'acquired', mine: true, takeover, report: copy(row) };
    });
  }

  async releaseDecision(guildId: string, id: string, token: string): Promise<void> {
    this.#update(
      guildId,
      id,
      (row) => isActiveStatus(row.status) && row.decision.token === token,
      (row) => {
        row.decision = { token: null, kind: null, startedAt: null };
      },
    );
  }

  async resolve(input: ResolveInput): Promise<ReportRecord | null> {
    return this.#update(
      input.guildId,
      input.id,
      (row) => isActiveStatus(row.status) && row.decision.token === input.token,
      (row) => {
        row.status = input.status;
        row.resolvedBy = input.by;
        row.resolvedAt = input.at;
        row.resolutionNote = input.note;
        row.reporterNote = input.reporterNote;
        row.actionKind = input.actionKind;
        for (const caseId of input.caseIds) {
          if (!row.caseIds.includes(caseId)) row.caseIds.push(caseId);
        }
        row.close.action = input.close.action;
        row.close.dueAt = input.close.dueAt;
        row.evidenceExpiresAt = Math.min(
          row.evidenceExpiresAt ?? input.evidenceExpiresAt,
          input.evidenceExpiresAt,
        );
        if (input.reporterNote !== null) row.evidencePurgedAt = null;
        row.version += 1;
        row.updatedAt = input.at;
      },
    );
  }

  async linkCase(guildId: string, id: string, caseId: string): Promise<ReportRecord | null> {
    return this.#update(
      guildId,
      id,
      () => true,
      (row) => {
        if (row.caseIds.includes(caseId)) return;
        row.caseIds.push(caseId);
        row.version += 1;
        row.updatedAt = this.#now();
      },
    );
  }

  async noteCardAttempt(guildId: string, id: string): Promise<number> {
    const row = this.#update(
      guildId,
      id,
      () => true,
      (found) => {
        found.card.attempts += 1;
        found.updatedAt = this.#now();
      },
    );
    return row?.card.attempts ?? 0;
  }

  async rememberCard(
    guildId: string,
    id: string,
    card: { channelId: string; messageId: string },
  ): Promise<ReportRecord | null> {
    return this.#update(
      guildId,
      id,
      () => true,
      (row) => {
        row.card.channelId = card.channelId;
        row.card.messageId = card.messageId;
        row.card.state = 'posted';
        row.card.error = null;
        row.updatedAt = this.#now();
      },
    );
  }

  async rememberEvidenceCopy(
    guildId: string,
    id: string,
    evidenceCopy: EvidenceCopy,
  ): Promise<void> {
    this.#update(
      guildId,
      id,
      () => true,
      (row) => {
        row.evidence.copy = copy(evidenceCopy);
        if ('messageId' in evidenceCopy) row.card.evidenceMessageId = evidenceCopy.messageId;
        row.updatedAt = this.#now();
      },
    );
  }

  async markCard(
    guildId: string,
    id: string,
    state: CardState,
    options: { error?: string; messageId?: string } = {},
  ): Promise<ReportRecord | null> {
    if (state === 'missing' && options.messageId === undefined) return null;

    return this.#update(
      guildId,
      id,
      (row) =>
        state !== 'missing' ||
        (row.card.messageId === options.messageId &&
          row.card.state === 'posted' &&
          row.close.closedAt === null),
      (row) => {
        row.card.state = state;
        row.card.error = options.error ?? null;
        row.updatedAt = this.#now();
      },
    );
  }

  async bumpVersion(guildId: string, id: string): Promise<number | null> {
    const row = this.#update(
      guildId,
      id,
      () => true,
      (found) => {
        found.version += 1;
        found.updatedAt = this.#now();
      },
    );
    return row?.version ?? null;
  }

  async markCardVersion(guildId: string, id: string, version: number): Promise<void> {
    this.#update(
      guildId,
      id,
      () => true,
      (row) => {
        row.card.version = Math.max(row.card.version, version);
        this.editFailures.delete(row.id);
      },
    );
  }

  async noteCardEditFailure(guildId: string, id: string): Promise<void> {
    this.#update(
      guildId,
      id,
      () => true,
      (row) => {
        this.editFailures.set(row.id, (this.editFailures.get(row.id) ?? 0) + 1);
        row.updatedAt = this.#now();
      },
    );
  }

  async scheduleClose(
    guildId: string,
    id: string,
    action: CloseAction,
    dueAt: number,
  ): Promise<void> {
    this.#update(
      guildId,
      id,
      (row) => row.close.closedAt === null,
      (row) => {
        row.close.action = action;
        row.close.dueAt = dueAt;
        row.updatedAt = this.#now();
      },
    );
  }

  async noteCloseAttempt(guildId: string, id: string): Promise<number> {
    const row = this.#update(
      guildId,
      id,
      () => true,
      (found) => {
        found.close.attempts += 1;
        found.updatedAt = this.#now();
      },
    );
    return row?.close.attempts ?? 0;
  }

  async moveCard(
    guildId: string,
    id: string,
    refs: CardRefs,
    state: CardState,
  ): Promise<ReportRecord | null> {
    return this.#update(
      guildId,
      id,
      (row) => row.close.closedAt === null,
      (row) => {
        row.card.channelId = refs.channelId;
        row.card.messageId = refs.messageId;
        row.card.state = state;
        row.card.evidenceMessageId = refs.copy?.messageId ?? null;
        if (refs.copy) {
          row.evidence.copy = { channelId: refs.copy.channelId, messageId: refs.copy.messageId };
        }
        row.updatedAt = this.#now();
      },
    );
  }

  async markClosed(
    guildId: string,
    id: string,
    state: CardState,
    at: number,
  ): Promise<ReportRecord | null> {
    return this.#update(
      guildId,
      id,
      (row) => row.close.closedAt === null,
      (row) => {
        row.close.closedAt = at;
        row.close.error = null;
        row.card.state = state;
        row.updatedAt = at;
      },
    );
  }

  async markCloseFailed(guildId: string, id: string, error: string): Promise<void> {
    this.#update(
      guildId,
      id,
      () => true,
      (row) => {
        row.close.error = error;
        row.updatedAt = this.#now();
      },
    );
  }

  async recordNotification(
    guildId: string,
    id: string,
    kind: NotificationKind,
    outcome: NotificationOutcome,
    at: number,
  ): Promise<void> {
    this.#update(
      guildId,
      id,
      () => true,
      (row) => {
        row.notifications[kind] = { outcome, at };
      },
    );
  }

  async rememberDm(guildId: string, id: string, channelId: string): Promise<void> {
    this.#update(
      guildId,
      id,
      () => true,
      (row) => {
        row.dmChannelId = channelId;
      },
    );
  }

  async noteDmAttempt(guildId: string, id: string): Promise<number> {
    const row = this.#update(
      guildId,
      id,
      () => true,
      (found) => {
        found.dmAttempts += 1;
      },
    );
    return row?.dmAttempts ?? 0;
  }

  async recordEvent(event: ReportEventInput): Promise<void> {
    if (this.events.has(event.id)) return;

    this.events.set(event.id, {
      id: event.id,
      reportId: event.reportId,
      guildId: event.guildId,
      kind: event.kind,
      actorId: event.actorId,
      source: event.source,
      data: copy(event.data ?? {}),
      createdAt: event.at ?? this.#now(),
    });
  }

  async listEvents(guildId: string, id: string): Promise<ReportEventRecord[]> {
    return [...this.events.values()]
      .filter((event) => event.guildId === guildId && event.reportId === id)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(copy);
  }

  async targetStats(guildId: string, targetId: string, sinceMs: number): Promise<TargetStats> {
    const about = this.#inGuild(guildId).filter((row) => row.targetId === targetId);
    const recent = about.filter((row) => row.createdAt >= sinceMs);

    return {
      total: recent.length,
      distinctReporters: new Set(recent.map((row) => row.reporterId)).size,
      open: about.filter((row) => isActiveStatus(row.status)).length,
    };
  }

  async qualifying(
    guildId: string,
    targetId: string,
    query: QualifyingQuery,
  ): Promise<QualifyingReport[]> {
    const last = query.lastRun;
    const ruleId = query.uncoveredBy;
    const covered = new Set(
      ruleId === undefined
        ? []
        : [...this.runs.values()]
            .filter(
              (run) =>
                run.guildId === guildId && run.ruleId === ruleId && run.targetId === targetId,
            )
            .flatMap((run) => run.reportIds),
    );

    return this.#inGuild(guildId)
      .filter(
        (row) =>
          row.targetId === targetId &&
          row.createdAt >= query.since &&
          query.statuses.includes(row.status) &&
          !covered.has(row.id) &&
          (last === null ||
            (row.createdAt >= last.coveredUntil && !last.reportIds.includes(row.id))),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        reporterId: row.reporterId,
        status: row.status,
        assigneeId: row.assigneeId,
        createdAt: row.createdAt,
      }));
  }

  async targetsWithOpenUnclaimed(
    guildId: string,
    before: number,
    limit: number,
    afterTargetId: string | null,
  ): Promise<string[]> {
    const targets = this.#inGuild(guildId)
      .filter((row) => row.status === 'open' && row.assigneeId === null && row.createdAt < before)
      .map((row) => row.targetId)
      .filter((targetId) => afterTargetId === null || targetId > afterTargetId);

    return [...new Set(targets)].sort().slice(0, limit);
  }

  async deliveryBacklog(guildId: string, now: number, limit: number): Promise<ReportRecord[]> {
    return this.#inGuild(guildId)
      .filter(
        (row) =>
          (row.card.state === 'pending' || row.card.state === 'failed') &&
          row.card.attempts < CARD_ATTEMPTS_MAX &&
          row.close.closedAt === null &&
          row.updatedAt + cardBackoffMs(row.card.attempts) <= now,
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map(copy);
  }

  async unfinishedResolutions(guildId: string, limit: number): Promise<ReportRecord[]> {
    return this.#inGuild(guildId)
      .filter(
        (row) =>
          (row.status === 'accepted' || row.status === 'dismissed') &&
          ((row.card.state === 'posted' &&
            row.card.version < row.version &&
            (this.editFailures.get(row.id) ?? 0) < CARD_ATTEMPTS_MAX) ||
            row.notifications[row.status] === undefined),
      )
      .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(copy);
  }

  async dueCloses(guildId: string, now: number, limit: number): Promise<ReportRecord[]> {
    return this.#inGuild(guildId)
      .filter(
        (row) =>
          row.close.action !== null &&
          row.close.closedAt === null &&
          row.close.dueAt !== null &&
          row.close.dueAt <= now &&
          row.close.attempts < CLOSE_ATTEMPTS_MAX,
      )
      .sort((a, b) => (a.close.dueAt ?? 0) - (b.close.dueAt ?? 0))
      .slice(0, limit)
      .map(copy);
  }

  async purgeExpiredEvidence(now: number, limit: number): Promise<number> {
    const expired = [...this.rows.values()]
      .filter(
        (row) =>
          row.evidencePurgedAt === null &&
          row.evidenceExpiresAt !== null &&
          row.evidenceExpiresAt <= now,
      )
      .sort((a, b) => (a.evidenceExpiresAt ?? 0) - (b.evidenceExpiresAt ?? 0))
      .slice(0, limit);

    for (const row of expired) {
      row.evidence = purgedEvidence(row.evidence);
      row.comment = null;
      row.customReason = null;
      row.reporterNote = null;
      row.evidencePurgedAt = now;
      row.updatedAt = now;

      await this.recordEvent({
        id: `${row.id}:evidence_purged`,
        reportId: row.id,
        guildId: row.guildId,
        kind: 'evidence_purged',
        actorId: null,
        source: 'system',
        at: now,
      });
    }

    return expired.length;
  }

  async claimRun(input: ClaimRunInput): Promise<AutomationRun | null> {
    return this.#serial(async () => {
      const covered = input.reportIds
        .map((id) => this.#find(input.guildId, id))
        .filter((row): row is ReportRecord => row !== null);
      if (covered.length === 0) return null;

      const clash = [...this.runs.values()].some(
        (run) =>
          run.guildId === input.guildId &&
          run.ruleId === input.ruleId &&
          run.targetId === input.targetId &&
          run.episodeStart === input.episodeStart,
      );
      if (clash || this.runs.has(input.id)) return null;

      const run: AutomationRun = {
        id: input.id,
        guildId: input.guildId,
        ruleId: input.ruleId,
        ruleName: input.ruleName,
        targetId: input.targetId,
        episodeStart: input.episodeStart,
        coveredUntil: Math.max(...covered.map((row) => row.createdAt)),
        reportIds: [...input.reportIds],
        status: 'running',
        leaseUntil: input.now + input.leaseMs,
        outcomes: [],
        createdAt: input.now,
        finishedAt: null,
      };

      this.runs.set(run.id, run);
      return copy(run);
    });
  }

  #runOf(guildId: string, runId: string): AutomationRun | null {
    const run = this.runs.get(runId);
    return run && run.guildId === guildId ? run : null;
  }

  async lastRun(guildId: string, ruleId: string, targetId: string): Promise<AutomationRun | null> {
    const last = [...this.runs.values()]
      .filter(
        (run) => run.guildId === guildId && run.ruleId === ruleId && run.targetId === targetId,
      )
      .sort((a, b) => b.episodeStart - a.episodeStart || b.createdAt - a.createdAt)[0];

    return last ? copy(last) : null;
  }

  async recordRunOutcome(guildId: string, runId: string, outcome: RunOutcome): Promise<void> {
    const run = this.#runOf(guildId, runId);
    if (!run || run.outcomes.some((entry) => entry.index === outcome.index)) return;

    run.outcomes.push(copy(outcome));
  }

  async renewLease(guildId: string, runId: string, leaseUntil: number): Promise<boolean> {
    const run = this.#runOf(guildId, runId);
    if (run?.status !== 'running') return false;

    run.leaseUntil = leaseUntil;
    return true;
  }

  async finishRun(
    guildId: string,
    runId: string,
    status: Exclude<AutomationRunStatus, 'running'>,
    at: number,
  ): Promise<void> {
    const run = this.#runOf(guildId, runId);
    if (run?.status !== 'running') return;

    run.status = status;
    run.finishedAt = at;
  }

  async staleRuns(guildId: string, now: number, limit: number): Promise<AutomationRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.guildId === guildId && run.status === 'running' && run.leaseUntil < now)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map(copy);
  }

  async resumeRun(
    guildId: string,
    runId: string,
    now: number,
    leaseMs: number,
  ): Promise<AutomationRun | null> {
    return this.#serial(async () => {
      const run = this.#runOf(guildId, runId);
      if (run?.status !== 'running' || run.leaseUntil >= now) return null;

      run.leaseUntil = now + leaseMs;
      return copy(run);
    });
  }
}

interface Stored {
  value: string;
  expiresAt: number;
}

export class MemoryDraftStore implements DraftStore {
  readonly entries = new Map<string, Stored>();
  readonly locks = new Map<string, Stored>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #read(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.#now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  #write(key: string, value: unknown, ttlMs: number): void {
    this.entries.set(key, { value: JSON.stringify(value), expiresAt: this.#now() + ttlMs });
  }

  async put(guildId: string, id: string, value: unknown, ttlMs: number): Promise<void> {
    this.#write(`${guildId}:${id}`, value, ttlMs);
  }

  async get<T>(guildId: string, id: string, schema: z.ZodType<T>): Promise<T | null> {
    return parseDraft(this.#read(`${guildId}:${id}`), schema);
  }

  async take<T>(guildId: string, id: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = this.#read(`${guildId}:${id}`);
    this.entries.delete(`${guildId}:${id}`);
    return parseDraft(raw, schema);
  }

  async putOutcome(guildId: string, id: string, value: unknown, ttlMs = 900_000): Promise<void> {
    this.#write(`${guildId}:${id}:done`, value, ttlMs);
  }

  async getOutcome<T>(guildId: string, id: string, schema: z.ZodType<T>): Promise<T | null> {
    return parseDraft(this.#read(`${guildId}:${id}:done`), schema);
  }

  async lock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const held = this.locks.get(key);
    if (held && held.expiresAt > this.#now()) return false;

    this.locks.set(key, { value: token, expiresAt: this.#now() + ttlMs });
    return true;
  }

  async unlock(key: string, token: string): Promise<void> {
    if (this.locks.get(key)?.value === token) this.locks.delete(key);
  }
}

export class MemoryReactionGate implements ReactionGate {
  readonly held = new Map<string, { eventId: string; expiresAt: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async claim(
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
    eventId: string,
  ): Promise<ReactionClaim> {
    const key = `${guildId}:${channelId}:${messageId}:${userId}`;
    const current = this.held.get(key);

    if (current && current.expiresAt > this.#now()) {
      return current.eventId === eventId ? 'redelivery' : 'duplicate';
    }

    this.held.set(key, { eventId, expiresAt: this.#now() + 600_000 });
    return 'claimed';
  }

  async release(
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
  ): Promise<void> {
    this.held.delete(`${guildId}:${channelId}:${messageId}:${userId}`);
  }
}

export class MemoryPromptStore implements PromptStore {
  readonly prompts = new Map<string, Map<string, number>>();

  async record(
    guildId: string,
    channelId: string,
    messageId: string,
    dueAt: number,
  ): Promise<void> {
    const guild = this.prompts.get(guildId) ?? new Map<string, number>();
    guild.set(`${channelId}:${messageId}`, dueAt);
    this.prompts.set(guildId, guild);
  }

  async remove(guildId: string, channelId: string, messageId: string): Promise<void> {
    this.prompts.get(guildId)?.delete(`${channelId}:${messageId}`);
  }

  async overdue(
    guildId: string,
    now: number,
    limit: number,
  ): Promise<Array<{ channelId: string; messageId: string; dueAt: number }>> {
    return [...(this.prompts.get(guildId) ?? new Map<string, number>()).entries()]
      .filter(([, dueAt]) => dueAt <= now)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .flatMap(([member, dueAt]) => {
        const [channelId, messageId] = member.split(':');
        return channelId && messageId ? [{ channelId, messageId, dueAt }] : [];
      });
  }
}

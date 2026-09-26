import { newCaseId } from '@proton/core';
import type { DbHandle } from '@proton/db';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import {
  type ReportAutomationRunRow,
  type ReportEventRow,
  type ReportRow,
  reportAutomationRuns,
  reportEvents,
  reports,
} from '../tables.ts';
import {
  type BeginDecisionInput,
  type BeginDecisionResult,
  CARD_ATTEMPTS_MAX,
  type CardRefs,
  CLOSE_ATTEMPTS_MAX,
  type ClaimRunInput,
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
} from './store.ts';
import {
  ACTIVE_REPORT_STATUSES,
  type AutomationRun,
  type AutomationRunStatus,
  type CardState,
  type CloseAction,
  EVIDENCE_OPEN_TTL_MS,
  type EvidenceCopy,
  type NotificationKind,
  type NotificationOutcome,
  RESOLVED_REPORT_STATUSES,
  type ReportEventRecord,
  type ReportEventSource,
  type ReportMethod,
  type ReportRecord,
  type ReportStatus,
  type RunOutcome,
  readEvidence,
  readNotifications,
  readOutcomes,
} from './types.ts';

export const REPORT_LOCK_PREFIX = 'moderation:reports:';

function ms(value: Date | null): number | null {
  return value ? value.getTime() : null;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`;

  return sql`array[${sql.join(
    values.map((value) => sql`${value}::text`),
    sql`, `,
  )}]::text[]`;
}

export function toReportRecord(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    number: row.number,
    reporterId: row.reporterId,
    targetId: row.targetId,
    method: row.method as ReportMethod,
    status: row.status as ReportStatus,

    reasonId: row.reasonId,
    reason: row.reason,
    customReason: row.customReason,
    comment: row.comment,

    sourceChannelId: row.sourceChannelId,
    sourceMessageId: row.sourceMessageId,
    sourceAuthorId: row.sourceAuthorId,

    evidence: readEvidence(row.evidence),
    evidenceExpiresAt: ms(row.evidenceExpiresAt),
    evidencePurgedAt: ms(row.evidencePurgedAt),

    assigneeId: row.assigneeId,
    assignedAt: ms(row.assignedAt),
    resolvedBy: row.resolvedBy,
    resolvedAt: ms(row.resolvedAt),
    resolutionNote: row.resolutionNote,
    reporterNote: row.reporterNote,
    actionKind: row.actionKind,
    caseIds: row.caseIds,

    card: {
      channelId: row.cardChannelId,
      messageId: row.cardMessageId,
      evidenceMessageId: row.evidenceMessageId,
      state: row.cardState as CardState,
      error: row.cardError,
      attempts: row.cardAttempts,
      version: row.cardVersion,
    },

    close: {
      action: row.closeAction as CloseAction | null,
      dueAt: ms(row.closeDueAt),
      closedAt: ms(row.closedAt),
      attempts: row.closeAttempts,
      error: row.closeError,
    },

    decision: {
      token: row.decisionToken,
      kind: row.decisionKind,
      startedAt: ms(row.decisionStartedAt),
    },
    notifications: readNotifications(row.notifications),

    dmChannelId: row.dmChannelId,
    dmAttempts: row.dmAttempts,
    version: row.version,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toEvent(row: ReportEventRow): ReportEventRecord {
  const data = row.data;

  return {
    id: row.id,
    reportId: row.reportId,
    guildId: row.guildId,
    kind: row.kind,
    actorId: row.actorId,
    source: row.source as ReportEventSource,
    data:
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
    createdAt: row.createdAt.getTime(),
  };
}

function toRun(row: ReportAutomationRunRow): AutomationRun {
  return {
    id: row.id,
    guildId: row.guildId,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    targetId: row.targetId,
    episodeStart: row.episodeStart.getTime(),
    coveredUntil: row.coveredUntil.getTime(),
    reportIds: row.reportIds,
    status: row.status as AutomationRunStatus,
    leaseUntil: row.leaseUntil.getTime(),
    outcomes: readOutcomes(row.outcomes),
    createdAt: row.createdAt.getTime(),
    finishedAt: ms(row.finishedAt),
  };
}

const active = inArray(reports.status, [...ACTIVE_REPORT_STATUSES]);

function one(guildId: string, id: string): SQL | undefined {
  return and(eq(reports.guildId, guildId), eq(reports.id, id));
}

function oneRun(guildId: string, runId: string): SQL | undefined {
  return and(eq(reportAutomationRuns.guildId, guildId), eq(reportAutomationRuns.id, runId));
}

const PURGED_EVIDENCE = sql`jsonb_strip_nulls(jsonb_build_object(
  'purged', true,
  'links', coalesce((
    select jsonb_agg(jsonb_build_object('url', link ->> 'url', 'status', link ->> 'status'))
      from jsonb_array_elements(
        case when jsonb_typeof(${reports.evidence} -> 'links') = 'array'
             then ${reports.evidence} -> 'links' else '[]'::jsonb end
      ) as link
  ), '[]'::jsonb),
  'attachments', '[]'::jsonb,
  'message', case
    when ${reports.evidence} -> 'message' ->> 'status' = 'captured' then jsonb_build_object(
      'status', 'unavailable',
      'reason', 'purged',
      'ids', jsonb_build_object(
        'channelId', ${reports.evidence} -> 'message' -> 'snapshot' ->> 'channelId',
        'messageId', ${reports.evidence} -> 'message' -> 'snapshot' ->> 'id'
      )
    )
    else ${reports.evidence} -> 'message'
  end,
  'copy', ${reports.evidence} -> 'copy'
))`;

export class DrizzleReportStore implements ReportStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  get #db() {
    return this.#handle.db;
  }

  async submit(input: NewReport, limits: SubmitLimits): Promise<SubmitResult> {
    const at = new Date(input.now);

    return this.#db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${REPORT_LOCK_PREFIX}${input.guildId}`}, 0))`,
      );

      const [replayed] = await tx
        .select()
        .from(reports)
        .where(eq(reports.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (replayed) return { status: 'existing', report: toReportRecord(replayed) };

      if (!limits.bypassCooldown && limits.cooldownMs > 0) {
        const [latest] = await tx
          .select({ createdAt: reports.createdAt })
          .from(reports)
          .where(and(eq(reports.guildId, input.guildId), eq(reports.reporterId, input.reporterId)))
          .orderBy(desc(reports.createdAt))
          .limit(1);

        const retryAt = latest ? latest.createdAt.getTime() + limits.cooldownMs : null;
        if (retryAt !== null && retryAt > input.now) {
          return { status: 'refused', code: 'cooldown', retryAt };
        }
      }

      if (limits.duplicateProtection) {
        const [duplicate] = await tx
          .select({ id: reports.id })
          .from(reports)
          .where(
            and(
              eq(reports.guildId, input.guildId),
              eq(reports.reporterId, input.reporterId),
              eq(reports.targetId, input.targetId),
              active,
              sql`coalesce(${reports.sourceMessageId}, '') = ${input.source?.messageId ?? ''}`,
            ),
          )
          .limit(1);

        if (duplicate) return { status: 'refused', code: 'duplicate', reportId: duplicate.id };
      }

      const [open] = await tx
        .select({
          server: sql<number>`count(*)::int`.mapWith(Number),
          member:
            sql<number>`count(*) filter (where ${reports.targetId} = ${input.targetId})::int`.mapWith(
              Number,
            ),
        })
        .from(reports)
        .where(and(eq(reports.guildId, input.guildId), active));

      if ((open?.member ?? 0) >= limits.maxOpenPerMember) {
        return { status: 'refused', code: 'member_cap' };
      }
      if ((open?.server ?? 0) >= limits.maxOpenPerServer) {
        return { status: 'refused', code: 'server_cap' };
      }

      const [numbered] = await tx
        .select({
          next: sql<number>`(coalesce(max(${reports.number}), 0) + 1)::int`.mapWith(Number),
        })
        .from(reports)
        .where(eq(reports.guildId, input.guildId));

      for (let attempt = 1; attempt <= SUBMIT_ID_ATTEMPTS; attempt += 1) {
        const rows = await tx
          .insert(reports)
          .values({
            id: newCaseId(),
            guildId: input.guildId,
            number: numbered?.next ?? 1,
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
            evidence: input.evidence,
            evidenceExpiresAt: new Date(input.now + EVIDENCE_OPEN_TTL_MS),
            idempotencyKey: input.idempotencyKey,
            createdAt: at,
            updatedAt: at,
          })
          .onConflictDoNothing({ target: reports.id })
          .returning();

        const row = rows[0];
        if (!row) continue;

        await tx
          .insert(reportEvents)
          .values({
            id: `${row.id}:submitted`,
            reportId: row.id,
            guildId: row.guildId,
            kind: 'submitted',
            actorId: input.reporterId,
            source: 'discord',
            data: { method: input.method },
            createdAt: at,
          })
          .onConflictDoNothing();

        return { status: 'filed', report: toReportRecord(row) };
      }

      throw new Error(
        `could not mint an unused report id in ${SUBMIT_ID_ATTEMPTS} attempts; nothing was filed`,
      );
    });
  }

  async get(guildId: string, id: string): Promise<ReportRecord | null> {
    const [row] = await this.#db.select().from(reports).where(one(guildId, id)).limit(1);
    return row ? toReportRecord(row) : null;
  }

  async byCardMessage(guildId: string, messageId: string): Promise<ReportRecord | null> {
    const [row] = await this.#db
      .select()
      .from(reports)
      .where(and(eq(reports.guildId, guildId), eq(reports.cardMessageId, messageId)))
      .limit(1);
    return row ? toReportRecord(row) : null;
  }

  async byIdempotency(guildId: string, key: string): Promise<ReportRecord | null> {
    const [row] = await this.#db
      .select()
      .from(reports)
      .where(and(eq(reports.guildId, guildId), eq(reports.idempotencyKey, key)))
      .limit(1);
    return row ? toReportRecord(row) : null;
  }

  async claim(
    guildId: string,
    id: string,
    assigneeId: string,
    now: number,
  ): Promise<ReportRecord | null> {
    const theirs = sql`(${reports.status} = 'in_review' and ${reports.assigneeId} = ${assigneeId})`;

    const [row] = await this.#db
      .update(reports)
      .set({
        status: 'in_review',
        assigneeId,
        assignedAt: sql`case when ${theirs} then ${reports.assignedAt} else ${iso(now)}::timestamptz end`,
        version: sql`case when ${theirs} then ${reports.version} else ${reports.version} + 1 end`,
        updatedAt: new Date(now),
      })
      .where(
        and(
          one(guildId, id),
          or(
            eq(reports.status, 'open'),
            and(eq(reports.status, 'in_review'), eq(reports.assigneeId, assigneeId)),
          ),
        ),
      )
      .returning();

    return row ? toReportRecord(row) : null;
  }

  async assign(
    guildId: string,
    id: string,
    assigneeId: string | null,
    now: number,
  ): Promise<ReportRecord | null> {
    const [row] = await this.#db
      .update(reports)
      .set({
        status: assigneeId === null ? 'open' : 'in_review',
        assigneeId,
        assignedAt: assigneeId === null ? null : new Date(now),
        version: sql`${reports.version} + 1`,
        updatedAt: new Date(now),
      })
      .where(and(one(guildId, id), active))
      .returning();

    return row ? toReportRecord(row) : null;
  }

  async unclaim(guildId: string, id: string, now: number): Promise<ReportRecord | null> {
    const [row] = await this.#db
      .update(reports)
      .set({
        status: 'open',
        assigneeId: null,
        assignedAt: null,
        version: sql`${reports.version} + 1`,
        updatedAt: new Date(now),
      })
      .where(and(one(guildId, id), eq(reports.status, 'in_review')))
      .returning();

    return row ? toReportRecord(row) : null;
  }

  async beginDecision(input: BeginDecisionInput): Promise<BeginDecisionResult> {
    return this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(reports)
        .where(one(input.guildId, input.id))
        .limit(1)
        .for('update');

      if (!row) return { state: 'missing', mine: false, takeover: null, report: null };

      const mine = row.decisionToken === input.token;
      const status = row.status as ReportStatus;

      if (status === 'accepted' || status === 'dismissed') {
        return { state: 'resolved', mine, takeover: null, report: toReportRecord(row) };
      }

      if (mine) return { state: 'acquired', mine, takeover: null, report: toReportRecord(row) };

      const held = row.decisionToken !== null;
      const startedAt = row.decisionStartedAt?.getTime() ?? null;
      const fresh = startedAt !== null && startedAt + input.staleMs > input.now;

      if (held && fresh) {
        return { state: 'held_by_other', mine: false, takeover: null, report: toReportRecord(row) };
      }

      const [taken] = await tx
        .update(reports)
        .set({
          decisionToken: input.token,
          decisionKind: input.kind,
          decisionStartedAt: new Date(input.now),
          updatedAt: new Date(input.now),
        })
        .where(one(input.guildId, input.id))
        .returning();

      return {
        state: 'acquired',
        mine: true,
        takeover:
          row.decisionToken !== null ? { token: row.decisionToken, kind: row.decisionKind } : null,
        report: toReportRecord(taken ?? row),
      };
    });
  }

  async releaseDecision(guildId: string, id: string, token: string): Promise<void> {
    await this.#db
      .update(reports)
      .set({ decisionToken: null, decisionKind: null, decisionStartedAt: null })
      .where(and(one(guildId, id), active, eq(reports.decisionToken, token)));
  }

  async resolve(input: ResolveInput): Promise<ReportRecord | null> {
    const expiry = sql`${iso(input.evidenceExpiresAt)}::timestamptz`;
    const caseIds = [...new Set(input.caseIds)];

    const [row] = await this.#db
      .update(reports)
      .set({
        status: input.status,
        resolvedBy: input.by,
        resolvedAt: new Date(input.at),
        resolutionNote: input.note,
        reporterNote: input.reporterNote,
        actionKind: input.actionKind,
        caseIds: sql`${reports.caseIds} || array(
          select x from unnest(${textArray(caseIds)}) as x where not (x = any(${reports.caseIds}))
        )`,
        closeAction: input.close.action,
        closeDueAt: input.close.dueAt === null ? null : new Date(input.close.dueAt),
        evidenceExpiresAt: sql`least(coalesce(${reports.evidenceExpiresAt}, ${expiry}), ${expiry})`,
        ...(input.reporterNote === null ? {} : { evidencePurgedAt: null }),
        version: sql`${reports.version} + 1`,
        updatedAt: new Date(input.at),
      })
      .where(and(one(input.guildId, input.id), active, eq(reports.decisionToken, input.token)))
      .returning();

    return row ? toReportRecord(row) : null;
  }

  async linkCase(guildId: string, id: string, caseId: string): Promise<ReportRecord | null> {
    const linked = sql`(${caseId}::text = any(${reports.caseIds}))`;

    const [row] = await this.#db
      .update(reports)
      .set({
        caseIds: sql`case when ${linked} then ${reports.caseIds}
          else array_append(${reports.caseIds}, ${caseId}::text) end`,
        version: sql`case when ${linked} then ${reports.version} else ${reports.version} + 1 end`,
        updatedAt: sql`now()`,
      })
      .where(one(guildId, id))
      .returning();

    return row ? toReportRecord(row) : null;
  }

  async noteCardAttempt(guildId: string, id: string): Promise<number> {
    const [row] = await this.#db
      .update(reports)
      .set({ cardAttempts: sql`${reports.cardAttempts} + 1`, updatedAt: sql`now()` })
      .where(one(guildId, id))
      .returning({ attempts: reports.cardAttempts });

    return row?.attempts ?? 0;
  }

  async rememberCard(
    guildId: string,
    id: string,
    card: { channelId: string; messageId: string },
  ): Promise<ReportRecord | null> {
    const [row] = await this.#db
      .update(reports)
      .set({
        cardChannelId: card.channelId,
        cardMessageId: card.messageId,
        cardState: 'posted',
        cardError: null,
        updatedAt: sql`now()`,
      })
      .where(one(guildId, id))
      .returning();

    return row ? toReportRecord(row) : null;
  }

  async rememberEvidenceCopy(guildId: string, id: string, copy: EvidenceCopy): Promise<void> {
    await this.#db
      .update(reports)
      .set({
        evidence: sql`jsonb_set(${reports.evidence}, '{copy}', ${JSON.stringify(copy)}::jsonb, true)`,
        ...('messageId' in copy ? { evidenceMessageId: copy.messageId } : {}),
        updatedAt: sql`now()`,
      })
      .where(one(guildId, id));
  }

  async markCard(
    guildId: string,
    id: string,
    state: CardState,
    options: { error?: string; messageId?: string } = {},
  ): Promise<ReportRecord | null> {
    if (state === 'missing' && options.messageId === undefined) return null;

    const where =
      state === 'missing'
        ? and(
            one(guildId, id),
            eq(reports.cardMessageId, options.messageId ?? ''),
            eq(reports.cardState, 'posted'),
            isNull(reports.closedAt),
          )
        : one(guildId, id);

    const [row] = await this.#db
      .update(reports)
      .set({ cardState: state, cardError: options.error ?? null, updatedAt: sql`now()` })
      .where(where)
      .returning();

    return row ? toReportRecord(row) : null;
  }

  async bumpVersion(guildId: string, id: string): Promise<number | null> {
    const [row] = await this.#db
      .update(reports)
      .set({ version: sql`${reports.version} + 1`, updatedAt: sql`now()` })
      .where(one(guildId, id))
      .returning({ version: reports.version });

    return row?.version ?? null;
  }

  async markCardVersion(guildId: string, id: string, version: number): Promise<void> {
    await this.#db
      .update(reports)
      .set({
        cardVersion: sql`greatest(${reports.cardVersion}, ${version}::int)`,
        cardEditAttempts: 0,
      })
      .where(one(guildId, id));
  }

  async noteCardEditFailure(guildId: string, id: string): Promise<void> {
    await this.#db
      .update(reports)
      .set({ cardEditAttempts: sql`${reports.cardEditAttempts} + 1`, updatedAt: sql`now()` })
      .where(one(guildId, id));
  }

  async scheduleClose(
    guildId: string,
    id: string,
    action: CloseAction,
    dueAt: number,
  ): Promise<void> {
    await this.#db
      .update(reports)
      .set({ closeAction: action, closeDueAt: new Date(dueAt), updatedAt: sql`now()` })
      .where(and(one(guildId, id), isNull(reports.closedAt)));
  }

  async noteCloseAttempt(guildId: string, id: string): Promise<number> {
    const [row] = await this.#db
      .update(reports)
      .set({ closeAttempts: sql`${reports.closeAttempts} + 1`, updatedAt: sql`now()` })
      .where(one(guildId, id))
      .returning({ attempts: reports.closeAttempts });

    return row?.attempts ?? 0;
  }

  async moveCard(
    guildId: string,
    id: string,
    refs: CardRefs,
    state: CardState,
  ): Promise<ReportRecord | null> {
    const [row] = await this.#db
      .update(reports)
      .set({
        cardChannelId: refs.channelId,
        cardMessageId: refs.messageId,
        cardState: state,
        evidenceMessageId: refs.copy?.messageId ?? null,
        ...(refs.copy
          ? {
              evidence: sql`jsonb_set(${reports.evidence}, '{copy}', ${JSON.stringify({
                channelId: refs.copy.channelId,
                messageId: refs.copy.messageId,
              })}::jsonb, true)`,
            }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(and(one(guildId, id), isNull(reports.closedAt)))
      .returning();

    return row ? toReportRecord(row) : null;
  }

  async markClosed(
    guildId: string,
    id: string,
    state: CardState,
    at: number,
  ): Promise<ReportRecord | null> {
    const [row] = await this.#db
      .update(reports)
      .set({ closedAt: new Date(at), cardState: state, closeError: null, updatedAt: new Date(at) })
      .where(and(one(guildId, id), isNull(reports.closedAt)))
      .returning();

    return row ? toReportRecord(row) : null;
  }

  async markCloseFailed(guildId: string, id: string, error: string): Promise<void> {
    await this.#db
      .update(reports)
      .set({ closeError: error, updatedAt: sql`now()` })
      .where(one(guildId, id));
  }

  async recordNotification(
    guildId: string,
    id: string,
    kind: NotificationKind,
    outcome: NotificationOutcome,
    at: number,
  ): Promise<void> {
    const entry = JSON.stringify({ [kind]: { outcome, at } });

    await this.#db
      .update(reports)
      .set({ notifications: sql`${reports.notifications} || ${entry}::jsonb` })
      .where(one(guildId, id));
  }

  async rememberDm(guildId: string, id: string, channelId: string): Promise<void> {
    await this.#db.update(reports).set({ dmChannelId: channelId }).where(one(guildId, id));
  }

  async noteDmAttempt(guildId: string, id: string): Promise<number> {
    const [row] = await this.#db
      .update(reports)
      .set({ dmAttempts: sql`${reports.dmAttempts} + 1` })
      .where(one(guildId, id))
      .returning({ attempts: reports.dmAttempts });

    return row?.attempts ?? 0;
  }

  async recordEvent(event: ReportEventInput): Promise<void> {
    await this.#db
      .insert(reportEvents)
      .values({
        id: event.id,
        reportId: event.reportId,
        guildId: event.guildId,
        kind: event.kind,
        actorId: event.actorId,
        source: event.source,
        data: event.data ?? {},
        ...(event.at === undefined ? {} : { createdAt: new Date(event.at) }),
      })
      .onConflictDoNothing();
  }

  async listEvents(guildId: string, id: string): Promise<ReportEventRecord[]> {
    const rows = await this.#db
      .select()
      .from(reportEvents)
      .where(and(eq(reportEvents.guildId, guildId), eq(reportEvents.reportId, id)))
      .orderBy(asc(reportEvents.createdAt), asc(reportEvents.id));

    return rows.map(toEvent);
  }

  async targetStats(guildId: string, targetId: string, sinceMs: number): Promise<TargetStats> {
    const since = sql`${iso(sinceMs)}::timestamptz`;

    const [row] = await this.#db
      .select({
        total: sql<number>`(count(*) filter (where ${reports.createdAt} >= ${since}))::int`.mapWith(
          Number,
        ),
        distinctReporters:
          sql<number>`(count(distinct ${reports.reporterId}) filter (where ${reports.createdAt} >= ${since}))::int`.mapWith(
            Number,
          ),
        open: sql<number>`(count(*) filter (where ${reports.status} in ('open', 'in_review')))::int`.mapWith(
          Number,
        ),
      })
      .from(reports)
      .where(and(eq(reports.guildId, guildId), eq(reports.targetId, targetId)));

    return {
      total: row?.total ?? 0,
      distinctReporters: row?.distinctReporters ?? 0,
      open: row?.open ?? 0,
    };
  }

  async qualifying(
    guildId: string,
    targetId: string,
    query: QualifyingQuery,
  ): Promise<QualifyingReport[]> {
    if (query.statuses.length === 0) return [];

    const conditions = [
      eq(reports.guildId, guildId),
      eq(reports.targetId, targetId),
      gte(reports.createdAt, new Date(query.since)),
      inArray(reports.status, [...query.statuses]),
    ];

    if (query.lastRun) {
      conditions.push(gte(reports.createdAt, new Date(query.lastRun.coveredUntil)));
      conditions.push(notInArray(reports.id, [...query.lastRun.reportIds]));
    }

    if (query.uncoveredBy !== undefined) {
      conditions.push(sql`not exists (
        select 1 from ${reportAutomationRuns}
         where ${reportAutomationRuns.guildId} = ${guildId}
           and ${reportAutomationRuns.ruleId} = ${query.uncoveredBy}
           and ${reportAutomationRuns.targetId} = ${targetId}
           and ${reports.id} = any(${reportAutomationRuns.reportIds})
      )`);
    }

    const rows = await this.#db
      .select({
        id: reports.id,
        reporterId: reports.reporterId,
        status: reports.status,
        assigneeId: reports.assigneeId,
        createdAt: reports.createdAt,
      })
      .from(reports)
      .where(and(...conditions))
      .orderBy(asc(reports.createdAt), asc(reports.id));

    return rows.map((row) => ({
      id: row.id,
      reporterId: row.reporterId,
      status: row.status as ReportStatus,
      assigneeId: row.assigneeId,
      createdAt: row.createdAt.getTime(),
    }));
  }

  async targetsWithOpenUnclaimed(
    guildId: string,
    before: number,
    limit: number,
    afterTargetId: string | null,
  ): Promise<string[]> {
    const rows = await this.#db
      .selectDistinct({ targetId: reports.targetId })
      .from(reports)
      .where(
        and(
          eq(reports.guildId, guildId),
          eq(reports.status, 'open'),
          isNull(reports.assigneeId),
          lt(reports.createdAt, new Date(before)),
          ...(afterTargetId === null ? [] : [gt(reports.targetId, afterTargetId)]),
        ),
      )
      .orderBy(asc(reports.targetId))
      .limit(limit);

    return rows.map((row) => row.targetId);
  }

  async deliveryBacklog(guildId: string, now: number, limit: number): Promise<ReportRecord[]> {
    const rows = await this.#db
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.guildId, guildId),
          inArray(reports.cardState, ['pending', 'failed']),
          lt(reports.cardAttempts, CARD_ATTEMPTS_MAX),
          isNull(reports.closedAt),
          sql`${reports.updatedAt} + (interval '1 minute' * power(2, ${reports.cardAttempts})) <= ${iso(now)}::timestamptz`,
        ),
      )
      .orderBy(asc(reports.createdAt))
      .limit(limit);

    return rows.map(toReportRecord);
  }

  async unfinishedResolutions(guildId: string, limit: number): Promise<ReportRecord[]> {
    const rows = await this.#db
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.guildId, guildId),
          inArray(reports.status, [...RESOLVED_REPORT_STATUSES]),
          or(
            and(
              eq(reports.cardState, 'posted'),
              lt(reports.cardVersion, reports.version),
              lt(reports.cardEditAttempts, CARD_ATTEMPTS_MAX),
            ),
            sql`(${reports.notifications} -> ${reports.status}) is null`,
          ),
        ),
      )
      .orderBy(asc(reports.updatedAt), asc(reports.id))
      .limit(limit);

    return rows.map(toReportRecord);
  }

  async dueCloses(guildId: string, now: number, limit: number): Promise<ReportRecord[]> {
    const rows = await this.#db
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.guildId, guildId),
          isNotNull(reports.closeAction),
          isNull(reports.closedAt),
          lte(reports.closeDueAt, new Date(now)),
          lt(reports.closeAttempts, CLOSE_ATTEMPTS_MAX),
        ),
      )
      .orderBy(asc(reports.closeDueAt))
      .limit(limit);

    return rows.map(toReportRecord);
  }

  async purgeExpiredEvidence(now: number, limit: number): Promise<number> {
    const at = new Date(now);

    return this.#db.transaction(async (tx) => {
      const expired = tx
        .select({ id: reports.id })
        .from(reports)
        .where(and(isNull(reports.evidencePurgedAt), lte(reports.evidenceExpiresAt, at)))
        .orderBy(asc(reports.evidenceExpiresAt))
        .limit(limit)
        .for('update', { skipLocked: true });

      const purged = await tx
        .update(reports)
        .set({
          evidence: PURGED_EVIDENCE,
          comment: null,
          customReason: null,
          reporterNote: null,
          evidencePurgedAt: at,
          updatedAt: at,
        })
        .where(inArray(reports.id, expired))
        .returning({ id: reports.id, guildId: reports.guildId });

      if (purged.length > 0) {
        await tx
          .insert(reportEvents)
          .values(
            purged.map((row) => ({
              id: `${row.id}:evidence_purged`,
              reportId: row.id,
              guildId: row.guildId,
              kind: 'evidence_purged',
              actorId: null,
              source: 'system',
              data: {},
              createdAt: at,
            })),
          )
          .onConflictDoNothing();
      }

      return purged.length;
    });
  }

  async #run(guildId: string, runId: string): Promise<AutomationRun | null> {
    const [row] = await this.#db
      .select()
      .from(reportAutomationRuns)
      .where(oneRun(guildId, runId))
      .limit(1);

    return row ? toRun(row) : null;
  }

  async claimRun(input: ClaimRunInput): Promise<AutomationRun | null> {
    if (input.reportIds.length === 0) return null;

    const ids = textArray(input.reportIds);

    const inserted = await this.#db.execute<{ id: string }>(sql`
      insert into ${reportAutomationRuns}
        (id, guild_id, rule_id, rule_name, target_id, episode_start, covered_until, report_ids,
         status, lease_until, outcomes, created_at)
      select ${input.id}, ${input.guildId}, ${input.ruleId}, ${input.ruleName}, ${input.targetId},
             ${iso(input.episodeStart)}::timestamptz, max(source.created_at), ${ids}, 'running',
             ${iso(input.now + input.leaseMs)}::timestamptz, '[]'::jsonb,
             ${iso(input.now)}::timestamptz
        from ${reports} as source
       where source.guild_id = ${input.guildId}
         and source.id = any(${ids})
      having count(*) > 0
      on conflict (guild_id, rule_id, target_id, episode_start) do nothing
      returning id
    `);

    if (inserted.length === 0) return null;

    return this.#run(input.guildId, input.id);
  }

  async lastRun(guildId: string, ruleId: string, targetId: string): Promise<AutomationRun | null> {
    const [row] = await this.#db
      .select()
      .from(reportAutomationRuns)
      .where(
        and(
          eq(reportAutomationRuns.guildId, guildId),
          eq(reportAutomationRuns.ruleId, ruleId),
          eq(reportAutomationRuns.targetId, targetId),
        ),
      )
      .orderBy(desc(reportAutomationRuns.episodeStart), desc(reportAutomationRuns.createdAt))
      .limit(1);

    return row ? toRun(row) : null;
  }

  async recordRunOutcome(guildId: string, runId: string, outcome: RunOutcome): Promise<void> {
    const outcomes = reportAutomationRuns.outcomes;

    await this.#db
      .update(reportAutomationRuns)
      .set({
        outcomes: sql`case
          when exists (
            select 1 from jsonb_array_elements(${outcomes}) as entry
             where (entry ->> 'index')::int = ${outcome.index}::int
          ) then ${outcomes}
          else ${outcomes} || ${JSON.stringify([outcome])}::jsonb
        end`,
      })
      .where(oneRun(guildId, runId));
  }

  async renewLease(guildId: string, runId: string, leaseUntil: number): Promise<boolean> {
    const rows = await this.#db
      .update(reportAutomationRuns)
      .set({ leaseUntil: new Date(leaseUntil) })
      .where(and(oneRun(guildId, runId), eq(reportAutomationRuns.status, 'running')))
      .returning({ id: reportAutomationRuns.id });

    return rows.length > 0;
  }

  async finishRun(
    guildId: string,
    runId: string,
    status: Exclude<AutomationRunStatus, 'running'>,
    at: number,
  ): Promise<void> {
    await this.#db
      .update(reportAutomationRuns)
      .set({ status, finishedAt: new Date(at) })
      .where(and(oneRun(guildId, runId), eq(reportAutomationRuns.status, 'running')));
  }

  async staleRuns(guildId: string, now: number, limit: number): Promise<AutomationRun[]> {
    const rows = await this.#db
      .select()
      .from(reportAutomationRuns)
      .where(
        and(
          eq(reportAutomationRuns.guildId, guildId),
          eq(reportAutomationRuns.status, 'running'),
          lt(reportAutomationRuns.leaseUntil, new Date(now)),
        ),
      )
      .orderBy(asc(reportAutomationRuns.createdAt))
      .limit(limit);

    return rows.map(toRun);
  }

  async resumeRun(
    guildId: string,
    runId: string,
    now: number,
    leaseMs: number,
  ): Promise<AutomationRun | null> {
    const [row] = await this.#db
      .update(reportAutomationRuns)
      .set({ leaseUntil: new Date(now + leaseMs) })
      .where(
        and(
          oneRun(guildId, runId),
          eq(reportAutomationRuns.status, 'running'),
          lt(reportAutomationRuns.leaseUntil, new Date(now)),
        ),
      )
      .returning();

    return row ? toRun(row) : null;
  }
}

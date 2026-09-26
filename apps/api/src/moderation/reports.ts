import {
  type EventBus,
  type JsonValue,
  moderationReportActionRequestedSchema,
  type RedisMailbox,
  type ReportActionOutcome,
  snowflakeSchema,
} from '@proton/core';
import { cases, type DbHandle } from '@proton/db';
import { moderationConfigSchema } from '@proton/module-moderation/config';
import {
  type AutomationRunList,
  type AutomationRunView,
  automationRunQuerySchema,
  automationRunViewSchema,
  type CaseEvidenceView,
  type CaseMessageView,
  caseMessageViewSchema,
  REPORT_GROUP_PREVIEW,
  REPORT_RELATED_MAX,
  type ReportActionBody,
  type ReportActionResult,
  type ReportDetail,
  type ReportEventView,
  type ReportGroup,
  type ReportListResult,
  type ReportSummary,
  type ReportSummaryCounts,
  reportDetailSchema,
  reportQuerySchema,
} from '@proton/module-moderation/reports-view';
import {
  type ModerationCaseMessageRow,
  moderationCaseMessages,
  type ReportAutomationRunRow,
  type ReportEventRow,
  type ReportRow,
  reportAutomationRuns,
  reportEvents,
  reports,
} from '@proton/module-moderation/tables';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import { toCaseRecord } from '../cases/service.ts';
import type { AuditWrite } from '../leveling/xp-events.ts';
import type { ModuleConfigService } from '../modules/service.ts';

const MODULE_ID = 'moderation';

const DAY_MS = 86_400_000;

export const REPORT_ACTION_WAIT_MS = 20_000;

const DECISION_STALE_MS = 2 * 60_000;
const STATS_WINDOW_MS = 30 * DAY_MS;
const AUTOMATION_FAILURE_WINDOW_MS = 7 * DAY_MS;

const ACTIVE = ['open', 'in_review'];
const RESOLVED = ['accepted', 'dismissed'];
const PROBLEM_CARD_STATES = ['failed', 'missing'];
const FAILED_RUNS = ['failed', 'partial'];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const REPORT_NUMBER = /^#(\d{1,9})$/;
const DIGITS = /^\d{1,9}$/;

function blankless<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

export const reportSearchSchema = reportQuerySchema.extend({
  close: blankless(z.enum(['problem'])),
});

export type ReportSearch = z.infer<typeof reportSearchSchema>;

export const automationRunSearchSchema = automationRunQuerySchema.extend({
  status: z.union([z.literal('problem'), automationRunQuerySchema.shape.status]),
});

export type AutomationRunSearch = z.infer<typeof automationRunSearchSchema>;

export const viewerQuerySchema = z.object({ viewerId: blankless(snowflakeSchema) });

export type ReportsErrorCode =
  | 'not_found'
  | 'no_bus'
  | 'no_redis'
  | 'module_disabled'
  | 'worker_timeout'
  | 'invalid_request';

export class ReportsError extends Error {
  readonly code: ReportsErrorCode;

  constructor(code: ReportsErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ReportsError';
  }
}

export type ReportActionMailbox = Pick<RedisMailbox<ReportActionOutcome>, 'recall' | 'wait'>;

export interface ReportsServiceOptions {
  db: DbHandle;
  modules: Pick<ModuleConfigService, 'get'>;
  audit: AuditWrite;
  bus?: EventBus;
  mailbox?: ReportActionMailbox;
  waitMs?: number;
  logger?: Pick<Console, 'error'>;
  now?(): number;
}

const UNREACHABLE =
  'Proton can’t act on reports right now because part of its service is down, so nothing was ' +
  'done. Try again later.';

const NOT_PASSED_ON =
  'Proton couldn’t start that action, so nothing was done. Try again in a moment.';

const MODERATION_OFF = 'Moderation is off in this server, so nothing was done. Turn it on first.';

const TIMED_OUT =
  'Proton didn’t confirm the action within 20 seconds. It may still complete, so refresh the ' +
  'report in a moment to see where it stands before trying again.';

const SUMMARY = {
  id: reports.id,
  number: reports.number,
  status: reports.status,
  method: reports.method,
  reporterId: reports.reporterId,
  targetId: reports.targetId,
  reasonId: reports.reasonId,
  reason: reports.reason,
  customReason: reports.customReason,
  sourceChannelId: reports.sourceChannelId,
  sourceMessageId: reports.sourceMessageId,
  assigneeId: reports.assigneeId,
  assignedAt: reports.assignedAt,
  resolvedBy: reports.resolvedBy,
  resolvedAt: reports.resolvedAt,
  actionKind: reports.actionKind,
  caseIds: reports.caseIds,
  cardChannelId: reports.cardChannelId,
  cardMessageId: reports.cardMessageId,
  evidenceMessageId: reports.evidenceMessageId,
  cardState: reports.cardState,
  cardError: reports.cardError,
  cardAttempts: reports.cardAttempts,
  cardVersion: reports.cardVersion,
  closeAction: reports.closeAction,
  closeDueAt: reports.closeDueAt,
  closedAt: reports.closedAt,
  closeAttempts: reports.closeAttempts,
  closeError: reports.closeError,
  evidencePurgedAt: reports.evidencePurgedAt,
  createdAt: reports.createdAt,
  updatedAt: reports.updatedAt,
} as const;

type SummaryRow = Pick<ReportRow, keyof typeof SUMMARY>;

const evidenceSchema = reportDetailSchema.shape.evidence;
const notificationsSchema = reportDetailSchema.shape.notifications;
const outcomeSchema = automationRunViewSchema.shape.outcomes.element;
const attachmentsSchema = caseMessageViewSchema.shape.attachments;

function ms(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

function instant(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(String(value));
}

function tally(condition: SQL | undefined) {
  return sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function startOf(value: string): Date {
  return new Date(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
}

function endOf(value: string): Date {
  return new Date(DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value);
}

function statusFilter(status: ReportSearch['status']): SQL | undefined {
  if (status === 'all') return undefined;
  if (status === 'active') return inArray(reports.status, ACTIVE);
  if (status === 'resolved') return inArray(reports.status, RESOLVED);
  return eq(reports.status, status);
}

function idLike(q: string): SQL {
  return sql`${reports.id} ilike ${`%${escapeLike(q)}%`} escape '\\'`;
}

function searchFilter(q: string): SQL | undefined {
  if (SNOWFLAKE.test(q)) return or(eq(reports.targetId, q), eq(reports.reporterId, q));

  const numbered = REPORT_NUMBER.exec(q);
  if (numbered) return eq(reports.number, Number(numbered[1]));

  if (DIGITS.test(q)) return or(eq(reports.number, Number(q)), idLike(q));

  return idLike(q);
}

function closeProblem(): SQL | undefined {
  return and(isNotNull(reports.closeError), isNull(reports.closedAt));
}

function notAbout(viewerId: string | undefined): SQL | undefined {
  return viewerId === undefined ? undefined : ne(reports.targetId, viewerId);
}

function runsNotAbout(viewerId: string | undefined): SQL | undefined {
  return viewerId === undefined ? undefined : ne(reportAutomationRuns.targetId, viewerId);
}

function runStatusFilter(status: AutomationRunSearch['status']): SQL | undefined {
  if (status === undefined) return undefined;
  if (status === 'problem') return inArray(reportAutomationRuns.status, FAILED_RUNS);
  return eq(reportAutomationRuns.status, status);
}

function queryFilter(
  guildId: string,
  query: ReportSearch,
  viewerId: string | undefined,
): SQL | undefined {
  return and(
    eq(reports.guildId, guildId),
    statusFilter(query.status),
    query.targetId === undefined ? undefined : eq(reports.targetId, query.targetId),
    query.reporterId === undefined ? undefined : eq(reports.reporterId, query.reporterId),
    query.assigneeId === undefined
      ? undefined
      : query.assigneeId === 'none'
        ? isNull(reports.assigneeId)
        : eq(reports.assigneeId, query.assigneeId),
    query.from === undefined ? undefined : gte(reports.createdAt, startOf(query.from)),
    query.to === undefined ? undefined : lte(reports.createdAt, endOf(query.to)),
    query.q === undefined ? undefined : searchFilter(query.q),
    query.delivery === 'problem' ? inArray(reports.cardState, PROBLEM_CARD_STATES) : undefined,
    query.close === 'problem' ? closeProblem() : undefined,
    notAbout(viewerId),
  );
}

function toSummary(row: SummaryRow): ReportSummary {
  return {
    id: row.id,
    number: row.number,
    status: row.status as ReportSummary['status'],
    method: row.method as ReportSummary['method'],
    reporterId: row.reporterId,
    targetId: row.targetId,
    reasonId: row.reasonId,
    reason: row.reason,
    customReason: row.customReason,
    sourceChannelId: row.sourceChannelId,
    sourceMessageId: row.sourceMessageId,
    assigneeId: row.assigneeId,
    assignedAt: ms(row.assignedAt),
    resolvedBy: row.resolvedBy,
    resolvedAt: ms(row.resolvedAt),
    actionKind: row.actionKind,
    caseIds: row.caseIds,
    card: {
      channelId: row.cardChannelId,
      messageId: row.cardMessageId,
      evidenceMessageId: row.evidenceMessageId,
      state: row.cardState as ReportSummary['card']['state'],
      error: row.cardError,
      attempts: row.cardAttempts,
      version: row.cardVersion,
    },
    close: {
      action: row.closeAction as ReportSummary['close']['action'],
      dueAt: ms(row.closeDueAt),
      closedAt: ms(row.closedAt),
      attempts: row.closeAttempts,
      error: row.closeError,
    },
    evidencePurgedAt: ms(row.evidencePurgedAt),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toEvent(row: ReportEventRow): ReportEventView {
  const data = row.data;

  return {
    id: row.id,
    reportId: row.reportId,
    kind: row.kind,
    actorId: row.actorId,
    source: row.source as ReportEventView['source'],
    data:
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, JsonValue>)
        : {},
    createdAt: row.createdAt.getTime(),
  };
}

function toRun(row: Omit<ReportAutomationRunRow, 'guildId' | 'leaseUntil'>): AutomationRunView {
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    targetId: row.targetId,
    episodeStart: row.episodeStart.getTime(),
    coveredUntil: row.coveredUntil.getTime(),
    reportIds: row.reportIds,
    status: row.status as AutomationRunView['status'],
    outcomes: Array.isArray(row.outcomes)
      ? row.outcomes.flatMap((entry: unknown) => {
          const parsed = outcomeSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
    createdAt: row.createdAt.getTime(),
    finishedAt: ms(row.finishedAt),
  };
}

function toCaseMessage(row: ModerationCaseMessageRow): CaseMessageView {
  const attachments = attachmentsSchema.safeParse(row.attachments);

  return {
    caseId: row.caseId,
    messageId: row.messageId,
    channelId: row.channelId,
    authorId: row.authorId,
    content: row.content,
    attachments: attachments.success ? attachments.data : [],
    createdAt: row.createdAt.getTime(),
    deletedAt: ms(row.deletedAt),
    proof: row.proof,
    capturedAt: row.capturedAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

function textLengths(params: ReportActionBody['params']) {
  const { reason, note, reporterNote, ...rest } = params;

  return {
    ...rest,
    ...(reason === undefined ? {} : { reasonLength: reason.length }),
    ...(note === undefined ? {} : { noteLength: note.length }),
    ...(reporterNote === undefined ? {} : { reporterNoteLength: reporterNote.length }),
  };
}

function notFound(reportId: string): ReportsError {
  return new ReportsError(
    'not_found',
    `This server has no report \`${reportId}\`. It may have been filed in another server.`,
  );
}

export class ReportsService {
  readonly #db: DbHandle;
  readonly #modules: Pick<ModuleConfigService, 'get'>;
  readonly #audit: AuditWrite;
  readonly #bus: EventBus | undefined;
  readonly #mailbox: ReportActionMailbox | undefined;
  readonly #waitMs: number;
  readonly #logger: Pick<Console, 'error'>;
  readonly #now: () => number;

  constructor(options: ReportsServiceOptions) {
    this.#db = options.db;
    this.#modules = options.modules;
    this.#audit = options.audit;
    this.#bus = options.bus;
    this.#mailbox = options.mailbox;
    this.#waitMs = options.waitMs ?? REPORT_ACTION_WAIT_MS;
    this.#logger = options.logger ?? console;
    this.#now = options.now ?? Date.now;
  }

  async search(guildId: string, query: ReportSearch, viewerId?: string): Promise<ReportListResult> {
    const where = queryFilter(guildId, query, viewerId);

    return query.group === 'member' ? this.#grouped(where, query) : this.#flat(where, query);
  }

  async #flat(where: SQL | undefined, query: ReportSearch): Promise<ReportListResult> {
    const order = query.dir === 'asc' ? asc : desc;

    const ordering =
      query.sort === 'number'
        ? [order(reports.number)]
        : [order(reports.createdAt), order(reports.number)];

    const [rows, totals] = await Promise.all([
      this.#db.db
        .select(SUMMARY)
        .from(reports)
        .where(where)
        .orderBy(...ordering)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.#db.db.select({ value: count() }).from(reports).where(where),
    ]);

    return {
      grouped: false,
      reports: rows.map(toSummary),
      total: totals[0]?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async #grouped(where: SQL | undefined, query: ReportSearch): Promise<ReportListResult> {
    const order = query.dir === 'asc' ? asc : desc;

    const total = sql<number>`count(*)`.mapWith(Number);
    const latest = sql`max(${reports.createdAt})`;

    const ordering =
      query.sort === 'volume'
        ? [order(total), desc(latest)]
        : query.sort === 'number'
          ? [order(sql`max(${reports.number})`)]
          : [order(latest)];

    const [groups, totals] = await Promise.all([
      this.#db.db
        .select({
          targetId: reports.targetId,
          total,
          open: tally(inArray(reports.status, ACTIVE)),
          distinctReporters: sql<number>`count(distinct ${reports.reporterId})`.mapWith(Number),
          firstAt: sql`min(${reports.createdAt})`.mapWith(instant),
          lastAt: latest.mapWith(instant),
        })
        .from(reports)
        .where(where)
        .groupBy(reports.targetId)
        .orderBy(...ordering, asc(reports.targetId))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.#db.db
        .select({ value: sql<number>`count(distinct ${reports.targetId})`.mapWith(Number) })
        .from(reports)
        .where(where),
    ]);

    const previews = await this.#previews(
      where,
      groups.map((group) => group.targetId),
    );

    const result: ReportGroup[] = groups.map((group) => ({
      targetId: group.targetId,
      total: group.total,
      open: group.open,
      distinctReporters: group.distinctReporters,
      firstAt: group.firstAt?.getTime() ?? 0,
      lastAt: group.lastAt?.getTime() ?? 0,
      reports: previews.get(group.targetId) ?? [],
    }));

    return {
      grouped: true,
      groups: result,
      total: totals[0]?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async #previews(
    where: SQL | undefined,
    targetIds: string[],
  ): Promise<Map<string, ReportSummary[]>> {
    const byTarget = new Map<string, ReportSummary[]>();
    if (targetIds.length === 0) return byTarget;

    const ranked = this.#db.db
      .select({
        ...SUMMARY,
        rank: sql<number>`row_number() over (partition by ${reports.targetId} order by ${reports.createdAt} desc, ${reports.number} desc)`.as(
          'rank',
        ),
      })
      .from(reports)
      .where(and(where, inArray(reports.targetId, targetIds)))
      .as('ranked');

    const rows = await this.#db.db
      .select()
      .from(ranked)
      .where(lte(ranked.rank, REPORT_GROUP_PREVIEW))
      .orderBy(desc(ranked.createdAt), desc(ranked.number));

    for (const row of rows) {
      const list = byTarget.get(row.targetId) ?? [];
      list.push(toSummary(row));
      byTarget.set(row.targetId, list);
    }

    return byTarget;
  }

  async summary(guildId: string, viewerId?: string): Promise<ReportSummaryCounts> {
    const since = new Date(this.#now() - AUTOMATION_FAILURE_WINDOW_MS);

    const [[row], [runs]] = await Promise.all([
      this.#db.db
        .select({
          open: tally(eq(reports.status, 'open')),
          inReview: tally(eq(reports.status, 'in_review')),
          accepted: tally(eq(reports.status, 'accepted')),
          dismissed: tally(eq(reports.status, 'dismissed')),
          openUnclaimed: tally(and(eq(reports.status, 'open'), isNull(reports.assigneeId))),
          oldestOpenAt:
            sql`min(${reports.createdAt}) filter (where ${eq(reports.status, 'open')})`.mapWith(
              instant,
            ),
          deliveryProblems: tally(inArray(reports.cardState, PROBLEM_CARD_STATES)),
          closeProblems: tally(closeProblem()),
        })
        .from(reports)
        .where(and(eq(reports.guildId, guildId), notAbout(viewerId))),
      this.#db.db
        .select({ value: count() })
        .from(reportAutomationRuns)
        .where(
          and(
            eq(reportAutomationRuns.guildId, guildId),
            inArray(reportAutomationRuns.status, FAILED_RUNS),
            gte(reportAutomationRuns.createdAt, since),
            runsNotAbout(viewerId),
          ),
        ),
    ]);

    return {
      counts: {
        open: row?.open ?? 0,
        in_review: row?.inReview ?? 0,
        accepted: row?.accepted ?? 0,
        dismissed: row?.dismissed ?? 0,
      },
      openUnclaimed: row?.openUnclaimed ?? 0,
      oldestOpenAt: ms(row?.oldestOpenAt ?? null),
      deliveryProblems: row?.deliveryProblems ?? 0,
      closeProblems: row?.closeProblems ?? 0,
      automationFailures7d: runs?.value ?? 0,
    };
  }

  async detail(guildId: string, reportId: string, viewerId?: string): Promise<ReportDetail> {
    const row = await this.#row(guildId, reportId);
    if (!row || row.targetId === viewerId) throw notFound(reportId);

    const now = this.#now();
    const since = new Date(now - STATS_WINDOW_MS);
    const sameTarget = and(eq(reports.guildId, guildId), eq(reports.targetId, row.targetId));

    const [events, related, linked, [stats]] = await Promise.all([
      this.#db.db
        .select()
        .from(reportEvents)
        .where(and(eq(reportEvents.guildId, guildId), eq(reportEvents.reportId, row.id)))
        .orderBy(asc(reportEvents.createdAt), asc(reportEvents.id)),
      this.#db.db
        .select(SUMMARY)
        .from(reports)
        .where(and(sameTarget, ne(reports.id, row.id)))
        .orderBy(desc(reports.createdAt), desc(reports.number))
        .limit(REPORT_RELATED_MAX),
      row.caseIds.length === 0
        ? Promise.resolve([])
        : this.#db.db
            .select()
            .from(cases)
            .where(and(eq(cases.guildId, guildId), inArray(cases.id, row.caseIds)))
            .orderBy(asc(cases.caseNumber)),
      this.#db.db
        .select({
          total: tally(gte(reports.createdAt, since)),
          distinctReporters:
            sql<number>`count(distinct ${reports.reporterId}) filter (where ${gte(reports.createdAt, since)})`.mapWith(
              Number,
            ),
          open: tally(inArray(reports.status, ACTIVE)),
        })
        .from(reports)
        .where(sameTarget),
    ]);

    const evidence = evidenceSchema.safeParse(row.evidence ?? {});
    const notifications = notificationsSchema.safeParse(row.notifications ?? {});
    const decidedAt = row.decisionStartedAt?.getTime() ?? null;

    return {
      ...toSummary(row),
      guildId: row.guildId,
      comment: row.comment,
      sourceAuthorId: row.sourceAuthorId,
      evidence: evidence.success ? evidence.data : { links: [], attachments: [] },
      evidenceExpiresAt: ms(row.evidenceExpiresAt),
      resolutionNote: row.resolutionNote,
      reporterNote: row.reporterNote,
      notifications: notifications.success ? notifications.data : {},
      version: row.version,
      deciding:
        ACTIVE.includes(row.status) &&
        row.decisionToken !== null &&
        decidedAt !== null &&
        now - decidedAt < DECISION_STALE_MS,
      events: events.map(toEvent),
      related: related.map(toSummary),
      cases: linked.map(toCaseRecord),
      stats: {
        total: stats?.total ?? 0,
        distinctReporters: stats?.distinctReporters ?? 0,
        open: stats?.open ?? 0,
      },
    };
  }

  async automationRuns(
    guildId: string,
    query: AutomationRunSearch,
    viewerId?: string,
  ): Promise<AutomationRunList> {
    const where = and(
      eq(reportAutomationRuns.guildId, guildId),
      runStatusFilter(query.status),
      runsNotAbout(viewerId),
    );

    const [rows, totals] = await Promise.all([
      this.#db.db
        .select({
          id: reportAutomationRuns.id,
          ruleId: reportAutomationRuns.ruleId,
          ruleName: reportAutomationRuns.ruleName,
          targetId: reportAutomationRuns.targetId,
          episodeStart: reportAutomationRuns.episodeStart,
          coveredUntil: reportAutomationRuns.coveredUntil,
          reportIds: reportAutomationRuns.reportIds,
          status: reportAutomationRuns.status,
          outcomes: reportAutomationRuns.outcomes,
          createdAt: reportAutomationRuns.createdAt,
          finishedAt: reportAutomationRuns.finishedAt,
        })
        .from(reportAutomationRuns)
        .where(where)
        .orderBy(desc(reportAutomationRuns.createdAt), desc(reportAutomationRuns.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.#db.db.select({ value: count() }).from(reportAutomationRuns).where(where),
    ]);

    return {
      runs: rows.map(toRun),
      total: totals[0]?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async caseEvidence(guildId: string, caseId: string): Promise<CaseEvidenceView> {
    const rows = await this.#db.db
      .select()
      .from(moderationCaseMessages)
      .where(
        and(
          eq(moderationCaseMessages.guildId, guildId),
          eq(moderationCaseMessages.caseId, caseId),
          gt(moderationCaseMessages.expiresAt, new Date(this.#now())),
        ),
      )
      .orderBy(asc(moderationCaseMessages.createdAt), asc(moderationCaseMessages.messageId));

    const messages = rows.map(toCaseMessage);

    return {
      proof: messages.find((message) => message.proof) ?? null,
      history: messages.filter((message) => !message.proof),
    };
  }

  async act(
    guildId: string,
    reportId: string,
    body: ReportActionBody,
  ): Promise<ReportActionResult> {
    const mailbox = this.#mailbox;
    if (!mailbox) throw new ReportsError('no_redis', UNREACHABLE);

    const mailboxId = `${guildId}:${body.requestId}`;

    // Ahead of the module check: a retried press must get its first answer, not a fresh refusal.
    const kept = await mailbox.recall(mailboxId);
    if (kept !== null) return kept;

    const bus = this.#bus;
    if (!bus) throw new ReportsError('no_bus', UNREACHABLE);

    if (body.action === 'assign' && body.params.assigneeId === undefined) {
      throw new ReportsError(
        'invalid_request',
        'Choose who to assign the report to. Nothing was done.',
      );
    }

    const auditId = `report.${body.action}:${guildId}:${body.requestId}`;

    const requested = moderationReportActionRequestedSchema.safeParse({
      requestId: body.requestId,
      auditId,
      guildId,
      reportId,
      action: body.action,
      params: body.params,
      actorId: body.actorId,
      actorPermissions: body.actorPermissions,
    });

    if (!requested.success) {
      throw new ReportsError(
        'invalid_request',
        `${guildId} is not a Discord server id, so nothing was done.`,
      );
    }

    await this.#assertModerationOn(guildId);

    const row = await this.#row(guildId, reportId);
    if (!row || row.targetId === body.actorId) throw notFound(reportId);

    await this.#audit({
      id: auditId,
      guildId,
      actorId: body.actorId,
      source: body.source,
      action: `module.moderation.report.${body.action}`,
      before: {
        reportId: row.id,
        number: row.number,
        status: row.status,
        targetId: row.targetId,
        assigneeId: row.assigneeId,
        actionKind: row.actionKind,
        caseIds: row.caseIds,
        cardState: row.cardState,
      },
      after: { action: body.action, requestId: body.requestId, ...textLengths(body.params) },
      ipHash: body.ipHash ?? null,
    });

    try {
      await bus.publish({
        id: `moderation.report_action_requested:${guildId}:${body.requestId}`,
        type: 'moderation.report_action_requested',
        guildId,
        occurredAt: this.#now(),
        payload: requested.data,
      });
    } catch (error) {
      this.#logger.error(
        `the ${body.action} of report ${reportId} in guild ${guildId} was audited but could not ` +
          `be published, so the worker never saw it: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ReportsError('no_bus', NOT_PASSED_ON);
    }

    const outcome = await mailbox.wait(mailboxId, this.#waitMs);
    if (outcome === null) throw new ReportsError('worker_timeout', TIMED_OUT);

    return outcome;
  }

  async #assertModerationOn(guildId: string): Promise<void> {
    const view = await this.#modules.get(guildId, MODULE_ID);

    if (!view.enabled || !moderationConfigSchema.parse(view.config).enabled) {
      throw new ReportsError('module_disabled', MODERATION_OFF);
    }
  }

  async #row(guildId: string, reportId: string): Promise<ReportRow | null> {
    const [row] = await this.#db.db
      .select()
      .from(reports)
      .where(and(eq(reports.guildId, guildId), eq(reports.id, reportId)))
      .limit(1);

    return row ?? null;
  }
}

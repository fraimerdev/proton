import {
  type EventListener,
  messageUrl,
  Permissions,
  type ProtonEvent,
  parseCustomId,
  type ReportActionOutcome,
  readComponentInteraction,
  readModalInteraction,
} from '@proton/core';
import type { ModerationConfig } from '../src/config.ts';
import type { ModerationDeps } from '../src/deps.ts';
import { PUNISH_ACTIONS, type PunishAction } from '../src/punish/interactions.ts';
import { reportCustomId } from '../src/reports/card.ts';
import { createReportCloseHandler } from '../src/reports/closing.ts';
import { createReportSubmittedListener, REPORT_CLOSE_JOB } from '../src/reports/delivery.ts';
import { REPORT_INTERACTION_ACTIONS } from '../src/reports/interactions.ts';
import { createReportRequestListener } from '../src/reports/requests.ts';
import { acceptReport } from '../src/reports/review.ts';
import type { NewReport } from '../src/reports/store.ts';
import type { MessageSnapshot, ReportRecord } from '../src/reports/types.ts';
import { type ComponentOptions, moderationEvent, pressEvent, snowflake } from './drivers.ts';
import {
  CHANNEL,
  GUILD,
  MEMBER,
  MESSAGE,
  MODERATOR,
  REPORTER,
  type RunOverrides,
  type SentMessage,
} from './harness.ts';
import { MemoryCaseLedger, MemoryTimeoutStore } from './punish-stores.ts';
import {
  NOW,
  REPORT_CHANNEL,
  type ReportsRig,
  type RigOptions,
  reportsRig,
} from './reports-setup.ts';

export const REVIEWER_PERMISSIONS =
  Permissions.ManageGuild |
  Permissions.BanMembers |
  Permissions.KickMembers |
  Permissions.ModerateMembers;

export const SECOND_MODERATOR = '100000000000000002';
export const ARCHIVE_CHANNEL = '500000000000000011';

export function snapshotOf(overrides: Partial<MessageSnapshot> = {}): MessageSnapshot {
  return {
    id: MESSAGE,
    channelId: CHANNEL,
    authorId: MEMBER,
    authorName: 'member',
    authorBot: false,
    url: messageUrl(GUILD, CHANNEL, MESSAGE),
    createdAt: NOW - 60_000,
    editedAt: null,
    content: 'free nitro at scam.example',
    attachments: [],
    embeds: [],
    stickers: [],
    forwarded: false,
    forwardedContent: null,
    capturedFrom: 'interaction',
    ...overrides,
  };
}

export function reviewRouter(deps: ModerationDeps): EventListener<ModerationConfig> {
  return {
    types: ['interaction.component', 'interaction.modal'],
    async handler(event, ctx) {
      const read =
        event.type === 'interaction.modal'
          ? readModalInteraction(event)
          : readComponentInteraction(event);
      const parsed = parseCustomId(read?.customId);
      if (parsed?.moduleId !== 'moderation') return;

      const report = REPORT_INTERACTION_ACTIONS[parsed.action];
      if (report) return report(event, ctx, deps);

      if (Object.hasOwn(PUNISH_ACTIONS, parsed.action)) {
        await PUNISH_ACTIONS[parsed.action as PunishAction](event, ctx, deps);
      }
    },
  };
}

export interface SeedInput extends Partial<Omit<NewReport, 'evidence'>> {
  evidence?: NewReport['evidence'];
  memberReport?: boolean;
}

export interface ReviewRig extends ReportsRig {
  ledger: MemoryCaseLedger;
  timeouts: MemoryTimeoutStore;
  answers: Array<{ id: string; outcome: ReportActionOutcome }>;
  seed(input?: SeedInput): Promise<ReportRecord>;
  file(input?: SeedInput): Promise<ReportRecord>;
  deliver(report: ReportRecord): Promise<void>;
  press(action: string, report: ReportRecord | string, options?: ComponentOptions): Promise<void>;
  route(event: ProtonEvent, extra?: Partial<RunOverrides>): Promise<number>;
  request(
    action: string,
    reportId: string,
    params?: Record<string, unknown>,
    actor?: { id?: string; permissions?: bigint; requestId?: string },
  ): Promise<ReportActionOutcome | undefined>;
  closeJob(): Promise<boolean>;
  runClose(reportId: string): Promise<boolean>;
  current(id: string): ReportRecord;
  cardPosts(): SentMessage[];
}

let seeded = 0;

export function reviewRig(options: RigOptions = {}): ReviewRig {
  const rig = reportsRig(options);
  const ledger = new MemoryCaseLedger(() => rig.h.now());
  ledger.follow(rig.h.recorder);
  const timeouts = new MemoryTimeoutStore();
  const answers: ReviewRig['answers'] = [];

  rig.deps.ledger = ledger;
  rig.deps.timeouts = timeouts;
  rig.deps.mailbox = {
    answer: async (id, outcome) => {
      answers.push({ id, outcome });
    },
  };
  rig.deps.reportAccept = (ctx, request) => acceptReport(ctx, rig.deps, request);

  const router = reviewRouter(rig.deps);
  const submitted = createReportSubmittedListener(rig.deps);
  const requests = createReportRequestListener(rig.deps);

  const seed = async (input: SeedInput = {}): Promise<ReportRecord> => {
    seeded += 1;
    const { memberReport, evidence, ...rest } = input;
    const now = rig.h.now();

    const result = await rig.store.submit(
      {
        guildId: GUILD,
        reporterId: REPORTER,
        targetId: MEMBER,
        method: memberReport ? 'command' : 'message_menu',
        reasonId: 'spam',
        reason: 'Spam or flooding',
        customReason: null,
        comment: 'Keeps posting the same link.',
        source: memberReport ? null : { channelId: CHANNEL, messageId: MESSAGE, authorId: MEMBER },
        evidence:
          evidence ??
          (memberReport
            ? { links: [], attachments: [] }
            : {
                message: { status: 'captured', snapshot: snapshotOf() },
                links: [],
                attachments: [],
              }),
        idempotencyKey: `seed:${seeded}:${snowflake()}`,
        now,
        ...rest,
      },
      {
        cooldownMs: 0,
        bypassCooldown: true,
        duplicateProtection: false,
        maxOpenPerMember: 100,
        maxOpenPerServer: 1000,
      },
    );

    if (result.status === 'refused') throw new Error(`seeding was refused: ${result.code}`);
    return result.report;
  };

  const deliver = async (report: ReportRecord): Promise<void> => {
    await rig.h.listen(
      moderationEvent('moderation.report_submitted', {
        guildId: GUILD,
        reportId: report.id,
        number: report.number,
        reporterId: report.reporterId,
        targetId: report.targetId,
        method: report.method,
        reason: report.reason,
        channelId: report.sourceChannelId,
        messageId: report.sourceMessageId,
        createdAt: report.createdAt,
      }),
      [submitted],
      rig.overrides(),
    );
  };

  const current = (id: string): ReportRecord => {
    const found = rig.store.rows.get(id);
    if (!found) throw new Error(`no report ${id}`);
    return structuredClone(found);
  };

  const route = (event: ProtonEvent, extra?: Partial<RunOverrides>) =>
    rig.h.listen(event, [router], rig.overrides(extra));

  return {
    ...rig,
    ledger,
    timeouts,
    answers,
    seed,
    async file(input) {
      const report = await seed(input);
      await deliver(report);
      return current(report.id);
    },
    deliver,
    route,
    async press(action, report, options = {}) {
      const id = typeof report === 'string' ? report : report.id;
      const customId = reportCustomId(action, id);
      if (!customId) throw new Error('bad custom id');

      const messageId =
        typeof report === 'string' ? undefined : (current(report.id).card.messageId ?? undefined);

      await route(
        pressEvent(customId, {
          userId: MODERATOR,
          permissions: REVIEWER_PERMISSIONS,
          channelId: REPORT_CHANNEL,
          ...(messageId ? { messageId } : {}),
          ...options,
        }),
      );
    },
    async request(action, reportId, params = {}, actor = {}) {
      const requestId = actor.requestId ?? `req${snowflake()}`;
      const before = answers.length;

      await rig.h.listen(
        moderationEvent('moderation.report_action_requested', {
          requestId,
          auditId: `audit-${requestId}`,
          guildId: GUILD,
          reportId,
          action: action as never,
          params,
          actorId: actor.id ?? MODERATOR,
          actorPermissions: String(actor.permissions ?? REVIEWER_PERMISSIONS),
        }),
        [requests],
        rig.overrides(),
      );

      return answers.slice(before).find((entry) => entry.id === `${GUILD}:${requestId}`)?.outcome;
    },
    closeJob() {
      const pending = rig.h.pendingJobs().find((call) => call.jobId === REPORT_CLOSE_JOB);
      if (!pending) throw new Error('no closing job is booked');

      return rig.h.job(REPORT_CLOSE_JOB, pending.data, {
        ...rig.overrides(),
        handlers: { [REPORT_CLOSE_JOB]: createReportCloseHandler(rig.deps) },
        naturalKey: pending.naturalKey,
      });
    },
    runClose: (reportId) =>
      rig.h.job(
        REPORT_CLOSE_JOB,
        { reportId },
        {
          ...rig.overrides(),
          handlers: { [REPORT_CLOSE_JOB]: createReportCloseHandler(rig.deps) },
          naturalKey: reportId,
        },
      ),
    current,
    cardPosts: () => rig.h.sentIn(REPORT_CHANNEL).filter((message) => !message.message_reference),
  };
}

export function customIdsOf(message: { components?: Array<Record<string, unknown>> }): string[] {
  return (message.components ?? []).flatMap((row) =>
    ((row.components ?? []) as Array<{ custom_id?: string }>).map((c) => c.custom_id ?? ''),
  );
}

export function actionsOf(message: { components?: Array<Record<string, unknown>> }): string[] {
  return customIdsOf(message).map((id) => parseCustomId(id)?.action ?? id);
}

export function embedOf(message: SentMessage | undefined) {
  const embed = message?.embeds?.[0];
  if (!embed) throw new Error('no embed');
  return embed;
}

export function fieldValue(message: SentMessage | undefined, name: string): string | undefined {
  return embedOf(message).fields?.find((field) => field.name === name)?.value;
}

export { GUILD, MEMBER, MODERATOR, NOW, REPORT_CHANNEL, REPORTER };

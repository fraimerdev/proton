import {
  type ActionResult,
  type AllowedMentions,
  COMPONENT_TYPE_TEXT_DISPLAY,
  type DiscordMessageBody,
  type EventListener,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  type ModuleContext,
  messageUrl,
  moderationReportResolvedSchema,
  moderationReportSubmittedSchema,
  newId,
  type ProtonEvent,
  toDiscordMessage,
  tryParseDuration,
} from '@proton/core';
import {
  type BotFacts,
  clipGraphemes,
  type ServerFacts,
  serverFactsFrom,
  type UserFacts,
} from '@proton/core/placeholders';
import { describeError } from '@proton/db';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import { sendDm } from '../punish/dm.ts';
import { DUPLICATE_MESSAGE, punish } from '../punish/pipeline.ts';
import { DIRECTION_NOUN, type PunishActor } from '../punish/types.ts';
import {
  type AlertReportFacts,
  alertKeys,
  automationMessagePath,
  memberNoticeKeys,
  renderMemberNotice,
  renderReportAlert,
  reportDashboardUrl,
} from './automation-surfaces.ts';
import type { AutomationAction, AutomationRule } from './config.ts';
import { REPORTS_ACTOR } from './direct.ts';
import type { QualifyingReport, ReportStore } from './store.ts';
import { reportMethodName } from './surfaces.ts';
import type { AutomationRun, AutomationRunStatus, RunOutcome } from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const AUTOMATION_ACTOR: PunishActor = Object.freeze({
  id: REPORTS_ACTOR,
  roleIds: null,
  permissions: null,
  kind: 'automation',
  label: 'Proton',
});

export const RUN_LEASE_MS = 2 * 60_000;
export const RUN_RESUME_WINDOW_MS = 60 * 60_000;
export const STALE_RUNS_MAX = 20;

const MESSAGE_CONTENT_MAX = 2000;

export const STOP_CODES = [
  'reports_disabled',
  'rule_disabled',
  'rule_removed',
  'rule_changed',
  'conditions_no_longer_met',
  'interrupted',
] as const;

export type StopCode = (typeof STOP_CODES)[number];

export const STOP_MESSAGES: Readonly<Record<StopCode, string>> = {
  reports_disabled: 'User reports were turned off, so the rest of this rule was cancelled.',
  rule_disabled: 'The rule was turned off, so the rest of it was cancelled.',
  rule_removed: 'The rule was deleted, so the rest of it was cancelled.',
  rule_changed: 'The rule no longer has this action, so the rest of it was cancelled.',
  conditions_no_longer_met:
    'The reports that set off this rule no longer meet its conditions (one was claimed or ' +
    'resolved in the meantime), so the rest was cancelled.',
  interrupted: 'Interrupted by a restart and not retried.',
};

const SOFT_SKIPS: ReadonlySet<string> = new Set(['skipped_recent_case']);

export type RunResult = Exclude<AutomationRunStatus, 'running'> | 'lost';

export interface AutomationFiring {
  ruleId: string;
  runId: string;
  status: RunResult;
}

export function automationKey(runId: string, index: number): string {
  return `moderation:reports:auto:${runId}:${index}`;
}

function clock(deps: ModerationDeps): number {
  return deps.now?.() ?? Date.now();
}

function describe(error: unknown): string {
  return describeError(error);
}

export function ruleHasCondition(rule: AutomationRule): boolean {
  const { reports, reporters, unreviewedFor } = rule.conditions;
  return reports !== null || reporters !== null || unreviewedFor !== null;
}

export function conditionsMet(
  rule: AutomationRule,
  rows: readonly QualifyingReport[],
  now: number,
): boolean {
  if (rows.length === 0) return false;

  const { reports, reporters, unreviewedFor } = rule.conditions;
  const checks: boolean[] = [];

  if (reports !== null) checks.push(rows.length >= reports);
  if (reporters !== null) checks.push(new Set(rows.map((row) => row.reporterId)).size >= reporters);
  if (unreviewedFor !== null) {
    const waitMs = tryParseDuration(unreviewedFor);
    checks.push(
      waitMs !== null &&
        rows.some(
          (row) =>
            row.status === 'open' && row.assigneeId === null && now - row.createdAt >= waitMs,
        ),
    );
  }

  if (checks.length === 0) return false;
  return rule.match === 'all' ? checks.every(Boolean) : checks.some(Boolean);
}

function windowStart(rule: AutomationRule, now: number): number | null {
  const windowMs = tryParseDuration(rule.window);
  return windowMs === null ? null : now - windowMs;
}

function firstOpenIndex(recorded: ReadonlySet<number>): number {
  let index = 0;
  while (recorded.has(index)) index += 1;
  return index;
}

function finalStatus(outcomes: readonly RunOutcome[]): Exclude<AutomationRunStatus, 'running'> {
  const failures = outcomes.filter((outcome) => !outcome.ok);
  if (failures.length === 0) return 'done';
  if (failures.length < outcomes.length) return 'partial';
  return failures.every((outcome) => SOFT_SKIPS.has(outcome.code)) ? 'partial' : 'failed';
}

function haltOf(config: ModerationConfig, rule: AutomationRule): StopCode | null {
  if (!config.reports.enabled) return 'reports_disabled';
  if (!rule.enabled) return 'rule_disabled';
  return null;
}

interface Step<A extends AutomationAction = AutomationAction> {
  store: ReportStore;
  rule: AutomationRule;
  ruleIndex: number;
  run: AutomationRun;
  index: number;
  action: A;
  rows: QualifyingReport[];
  at: number;
}

function success(step: Step, code: string, message: string, caseId?: string | null): RunOutcome {
  return {
    index: step.index,
    kind: step.action.kind,
    ok: true,
    code,
    message,
    ...(caseId ? { caseId } : {}),
    at: step.at,
  };
}

function failure(step: Step, code: string, message: string): RunOutcome {
  return { index: step.index, kind: step.action.kind, ok: false, code, message, at: step.at };
}

function landed(result: ActionResult): boolean {
  return result.status === 'executed' || result.status === 'skipped_duplicate';
}

function codeOf(result: ActionResult): string {
  return result.failure?.code ?? result.status;
}

function reasonOf(result: ActionResult): string {
  return result.failure?.humanReason ?? 'Discord gave no reason.';
}

function uses(keys: ReadonlySet<string>, namespace: string, beyond: readonly string[] = []) {
  return [...keys].some((key) => key.startsWith(`${namespace}.`) && !beyond.includes(key));
}

async function userFacts(deps: ModerationDeps, userId: string, wanted: boolean) {
  const bare: UserFacts = { id: userId, username: null, globalName: null, avatarHash: null };
  if (!wanted || !deps.placeholders) return bare;

  try {
    return (await deps.placeholders.user(userId)) ?? bare;
  } catch {
    return bare;
  }
}

async function serverFacts(ctx: Ctx, deps: ModerationDeps, wanted: boolean): Promise<ServerFacts> {
  if (!wanted) return { id: ctx.guildId };

  try {
    if (deps.placeholders) return await deps.placeholders.server(ctx.guildId);
    return serverFactsFrom((await deps.guildState?.get(ctx.guildId)) ?? null, ctx.guildId);
  } catch {
    return { id: ctx.guildId };
  }
}

async function botFacts(deps: ModerationDeps, wanted: boolean): Promise<BotFacts | null> {
  if (!wanted || !deps.placeholders) return null;

  try {
    return await deps.placeholders.bot();
  } catch {
    return null;
  }
}

const IDENTITY = (namespace: string) => [`${namespace}.id`, `${namespace}.mention`];

async function latestReport(
  ctx: Ctx,
  deps: ModerationDeps,
  step: Step,
): Promise<AlertReportFacts | null> {
  const newest = step.rows.reduce<QualifyingReport | null>(
    (best, row) => (best === null || row.createdAt >= best.createdAt ? row : best),
    null,
  );
  if (newest === null) return null;

  const report = await step.store.get(ctx.guildId, newest.id);
  if (report === null) return null;

  return {
    id: report.id,
    number: report.number,
    status: report.status,
    method: report.method,
    methodName: reportMethodName(ctx, report.method),
    reason: report.reason,
    createdAt: report.createdAt,
    messageUrl:
      report.sourceChannelId && report.sourceMessageId
        ? messageUrl(ctx.guildId, report.sourceChannelId, report.sourceMessageId)
        : null,
    url: reportDashboardUrl(deps.dashboardUrl, ctx.guildId, report.id),
  };
}

function withRolePings(
  body: DiscordMessageBody,
  roleIds: readonly string[],
): Omit<DiscordMessageBody, 'allowedMentions'> & { allowedMentions: AllowedMentions } {
  const { allowedMentions: _ignored, ...rest } = body;
  if (roleIds.length === 0) return { ...rest, allowedMentions: { parse: [] } };

  const pings = roleIds.map((roleId) => `<@&${roleId}>`).join(' ');
  const allowedMentions: AllowedMentions = { parse: [], roles: [...roleIds] };

  if (((rest.flags ?? 0) & MESSAGE_FLAG_IS_COMPONENTS_V2) !== 0) {
    return {
      ...rest,
      components: [
        { type: COMPONENT_TYPE_TEXT_DISPLAY, content: pings },
        ...(rest.components ?? []),
      ],
      allowedMentions,
    };
  }

  const content = rest.content ? `${pings}\n${rest.content}` : pings;
  return { ...rest, content: clipGraphemes(content, MESSAGE_CONTENT_MAX), allowedMentions };
}

async function postAlert(
  ctx: Ctx,
  deps: ModerationDeps,
  step: Step<Extract<AutomationAction, { kind: 'alert' }>>,
): Promise<RunOutcome> {
  const { action, run } = step;
  const channelId = action.channelId ?? ctx.config.reports.channelId;

  if (channelId === undefined) {
    return failure(
      step,
      'no_channel',
      "There's no alert channel and no report channel, so the alert wasn't posted. Choose one " +
        'under Moderation → User reports.',
    );
  }

  const keys = alertKeys(action.message);
  const rendered = renderReportAlert(
    action.message,
    {
      ruleName: step.rule.name,
      report: await latestReport(ctx, deps, step),
      totalReports: step.rows.length,
      reporterCount: new Set(step.rows.map((row) => row.reporterId)).size,
      target: await userFacts(deps, run.targetId, uses(keys, 'target', IDENTITY('target'))),
      server: await serverFacts(ctx, deps, uses(keys, 'server')),
      bot: await botFacts(deps, uses(keys, 'bot')),
    },
    step.at,
    automationMessagePath(step.ruleIndex, step.index),
  );

  if (!rendered.ok) {
    return failure(
      step,
      'render_failed',
      `The alert couldn't be written, so it wasn't posted: ${rendered.humanReason}`,
    );
  }

  const roleIds = rendered.message.mentions.roles ? action.roleIds : [];
  const body = withRolePings(
    toDiscordMessage(rendered.message, { customIdFor: (key) => key, now: new Date(step.at) }),
    roleIds,
  );

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: REPORTS_ACTOR,
    targetId: run.targetId,
    idempotencyKey: automationKey(run.id, step.index),
    dryRun: false,
    record: false,
    payload: { channelId, ...body },
  });

  return landed(result)
    ? success(step, 'posted', `Posted the alert in <#${channelId}>.`)
    : failure(
        step,
        codeOf(result),
        `Couldn't post the alert in <#${channelId}>: ${reasonOf(result)}`,
      );
}

async function messageMember(
  ctx: Ctx,
  deps: ModerationDeps,
  step: Step<Extract<AutomationAction, { kind: 'dm' }>>,
): Promise<RunOutcome> {
  const { action, run } = step;
  const who = `<@${run.targetId}>`;
  const keys = memberNoticeKeys(action.message);

  const rendered = renderMemberNotice(
    action.message,
    {
      ruleName: step.rule.name,
      user: await userFacts(deps, run.targetId, uses(keys, 'user', IDENTITY('user'))),
      server: await serverFacts(ctx, deps, uses(keys, 'server')),
      bot: await botFacts(deps, uses(keys, 'bot')),
    },
    step.at,
    automationMessagePath(step.ruleIndex, step.index),
  );

  if (!rendered.ok) {
    return failure(
      step,
      'render_failed',
      `The DM couldn't be written, so ${who} wasn't sent one: ${rendered.humanReason}`,
    );
  }

  const { allowedMentions: _ignored, ...body } = toDiscordMessage(rendered.message, {
    customIdFor: (key) => key,
    now: new Date(step.at),
  });

  const sent = await sendDm(ctx, deps, {
    userId: run.targetId,
    root: automationKey(run.id, step.index),
    step: 'send',
    body,
    actorId: REPORTS_ACTOR,
  });

  switch (sent.outcome) {
    case 'sent':
      return success(step, 'sent', `Sent ${who} the rule's DM.`);
    case 'closed':
      return failure(step, 'closed', `${who} has DMs closed, so they weren't told.`);
    case 'no_mutual_server':
      return failure(
        step,
        'no_mutual_server',
        `${who} no longer shares a server with Proton, so they weren't told.`,
      );
    default:
      return failure(step, sent.outcome, `The DM to ${who} didn't go through.`);
  }
}

async function punishMember(
  ctx: Ctx,
  deps: ModerationDeps,
  step: Step<Extract<AutomationAction, { kind: 'punish' }>>,
): Promise<RunOutcome> {
  const { action, run, rule } = step;

  if (!rule.acknowledgedRisk) {
    return failure(
      step,
      'risk_not_acknowledged',
      'This rule punishes members before anyone reviews the reports, and nobody confirmed that ' +
        "risk, so it didn't punish anyone. Confirm it under Moderation → User reports → Automation.",
    );
  }

  const outcome = await punish(ctx, deps, {
    guildId: ctx.guildId,
    kind: action.punishment,
    targetId: run.targetId,
    actor: AUTOMATION_ACTOR,
    reason: action.reason,
    ...(action.duration === null ? {} : { duration: action.duration }),
    origin: { type: 'automation', ruleId: rule.id, runId: run.id },
    notify: action.notify,
    idempotencyRoot: automationKey(run.id, step.index),
  });

  switch (outcome.status) {
    case 'executed':
      return success(step, 'executed', outcome.summary, outcome.caseId);
    case 'needs_confirmation':
      return failure(
        step,
        'skipped_recent_case',
        `<@${run.targetId}> already has a recent ${DIRECTION_NOUN[action.punishment]} (case ` +
          `\`${outcome.recentCaseId}\`), so this rule didn't add another.`,
      );
    case 'duplicate':
      return failure(step, 'duplicate', outcome.message);
    default:
      return failure(step, outcome.code, outcome.message);
  }
}

async function changeRole(
  ctx: Ctx,
  deps: ModerationDeps,
  step: Step<Extract<AutomationAction, { kind: 'add_role' | 'remove_role' }>>,
): Promise<RunOutcome> {
  const { action, run } = step;
  const key = automationKey(run.id, step.index);
  const adding = action.kind === 'add_role';
  const done = adding
    ? `Gave <@${run.targetId}> <@&${action.roleId}>.`
    : `Took <@&${action.roleId}> from <@${run.targetId}>.`;

  const earlier = await deps.ledger?.byIdempotencyKey(ctx.guildId, key);
  if (earlier) return success(step, 'executed', done, earlier.caseId);

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: action.kind,
    actorId: REPORTS_ACTOR,
    targetId: run.targetId,
    reason: `User reports automation: ${step.rule.name}`,
    idempotencyKey: key,
    dryRun: false,
    payload: { userId: run.targetId, roleId: action.roleId },
  });

  if (result.status === 'executed') return success(step, 'executed', done, result.caseId);

  if (result.status === 'skipped_duplicate') {
    if (!deps.ledger) return success(step, 'executed', done);

    const found = await deps.ledger.byIdempotencyKey(ctx.guildId, key);
    return found
      ? success(step, 'executed', done, found.caseId)
      : failure(step, 'duplicate', DUPLICATE_MESSAGE);
  }

  return failure(
    step,
    codeOf(result),
    `Couldn't ${adding ? 'give' : 'take'} <@&${action.roleId}>: ${reasonOf(result)}`,
  );
}

function perform(ctx: Ctx, deps: ModerationDeps, step: Step): Promise<RunOutcome> {
  const { action } = step;

  switch (action.kind) {
    case 'alert':
      return postAlert(ctx, deps, { ...step, action });
    case 'dm':
      return messageMember(ctx, deps, { ...step, action });
    case 'punish':
      return punishMember(ctx, deps, { ...step, action });
    case 'add_role':
    case 'remove_role':
      return changeRole(ctx, deps, { ...step, action });
  }
}

async function stillQualifying(
  store: ReportStore,
  guildId: string,
  rule: AutomationRule,
  run: AutomationRun,
): Promise<QualifyingReport[]> {
  const covered = new Set(run.reportIds);
  const rows = await store.qualifying(guildId, run.targetId, {
    since: run.episodeStart,
    lastRun: null,
    statuses: rule.statuses,
  });

  return rows.filter((row) => covered.has(row.id));
}

async function stopRun(
  store: ReportStore,
  guildId: string,
  run: AutomationRun,
  input: {
    index: number;
    kind: string;
    code: StopCode;
    status: 'cancelled' | 'failed';
    at: number;
  },
): Promise<void> {
  await store.recordRunOutcome(guildId, run.id, {
    index: input.index,
    kind: input.kind,
    ok: false,
    code: input.code,
    message: STOP_MESSAGES[input.code],
    at: input.at,
  });
  await store.finishRun(guildId, run.id, input.status, input.at);
}

function ruleOf(
  config: ModerationConfig,
  ruleId: string,
): { rule: AutomationRule; ruleIndex: number } | null {
  const ruleIndex = config.reports.automation.findIndex((rule) => rule.id === ruleId);
  const rule = config.reports.automation[ruleIndex];
  return rule ? { rule, ruleIndex } : null;
}

async function executeRun(
  ctx: Ctx,
  deps: ModerationDeps,
  store: ReportStore,
  run: AutomationRun,
): Promise<RunResult> {
  const guildId = ctx.guildId;
  const outcomes = [...run.outcomes];
  const recorded = new Set(outcomes.map((outcome) => outcome.index));
  const found = ruleOf(ctx.config, run.ruleId);

  const stop = async (index: number, kind: string, code: StopCode): Promise<RunResult> => {
    await stopRun(store, guildId, run, { index, kind, code, status: 'cancelled', at: clock(deps) });
    return 'cancelled';
  };

  if (found === null) return stop(firstOpenIndex(recorded), 'run', 'rule_removed');

  const { rule, ruleIndex } = found;

  for (const [index, action] of rule.actions.entries()) {
    if (recorded.has(index)) continue;

    const halted = haltOf(ctx.config, rule);
    if (halted) return stop(index, action.kind, halted);

    const at = clock(deps);
    const rows = await stillQualifying(store, guildId, rule, run);
    if (!conditionsMet(rule, rows, at)) return stop(index, action.kind, 'conditions_no_longer_met');

    if (!(await store.renewLease(guildId, run.id, at + RUN_LEASE_MS))) return 'lost';

    const outcome = await perform(ctx, deps, {
      store,
      rule,
      ruleIndex,
      run,
      index,
      action,
      rows,
      at,
    });

    if (!outcome.ok) {
      ctx.logger.warn(
        `report automation rule ${rule.id} could not ${action.kind} (step ${index + 1}): ` +
          outcome.message,
        { guildId, moduleId: MODULE_ID, userId: run.targetId, code: outcome.code },
      );
    }

    await store.recordRunOutcome(guildId, run.id, outcome);
    outcomes.push(outcome);
  }

  if (outcomes.length === 0) return stop(0, 'run', 'rule_changed');

  const status = finalStatus(outcomes);
  await store.finishRun(guildId, run.id, status, clock(deps));
  return status;
}

async function noteFiring(ctx: Ctx, store: ReportStore, run: AutomationRun): Promise<void> {
  try {
    for (const reportId of run.reportIds) {
      await store.recordEvent({
        id: `${reportId}:automation_fired:${run.id}`,
        reportId,
        guildId: ctx.guildId,
        kind: 'automation_fired',
        actorId: REPORTS_ACTOR,
        source: 'automation',
        data: { ruleId: run.ruleId, runId: run.id },
        at: run.createdAt,
      });
    }
  } catch (error) {
    ctx.logger.warn(
      `report automation run ${run.id} could not add itself to the reports' timelines: ` +
        describe(error),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

export async function evaluateTarget(
  ctx: Ctx,
  deps: ModerationDeps,
  targetId: string,
  now: number,
): Promise<AutomationFiring[]> {
  if (!ctx.config.enabled || !ctx.config.reports.enabled) return [];

  const store = deps.reports;
  if (!store) {
    ctx.logger.error('report automation cannot run: the report store is not connected', {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return [];
  }

  const fired: AutomationFiring[] = [];

  for (const rule of ctx.config.reports.automation) {
    if (!rule.enabled || !ruleHasCondition(rule) || rule.actions.length === 0) continue;

    const since = windowStart(rule, now);
    if (since === null) continue;

    const last = await store.lastRun(ctx.guildId, rule.id, targetId);
    const rows = await store.qualifying(ctx.guildId, targetId, {
      since,
      lastRun: last ? { coveredUntil: last.coveredUntil, reportIds: last.reportIds } : null,
      statuses: rule.statuses,
      uncoveredBy: rule.id,
    });
    if (!conditionsMet(rule, rows, now)) continue;

    const run = await store.claimRun({
      id: newId(),
      guildId: ctx.guildId,
      ruleId: rule.id,
      ruleName: rule.name,
      targetId,
      // Past the last episode even when its reports share one millisecond, or the key repeats.
      episodeStart: last ? Math.max(last.coveredUntil, last.episodeStart + 1) : 0,
      reportIds: rows.map((row) => row.id),
      now,
      leaseMs: RUN_LEASE_MS,
    });
    if (!run) continue;

    await noteFiring(ctx, store, run);
    fired.push({ ruleId: rule.id, runId: run.id, status: await executeRun(ctx, deps, store, run) });
  }

  return fired;
}

export interface ResumeSummary {
  resumed: number;
  failed: number;
  cancelled: number;
}

export async function resumeStaleRuns(
  ctx: Ctx,
  deps: ModerationDeps,
  now: number,
): Promise<ResumeSummary> {
  const summary: ResumeSummary = { resumed: 0, failed: 0, cancelled: 0 };
  const store = deps.reports;
  if (!ctx.config.enabled || !store) return summary;

  for (const stale of await store.staleRuns(ctx.guildId, now, STALE_RUNS_MAX)) {
    const run = await store.resumeRun(ctx.guildId, stale.id, now, RUN_LEASE_MS);
    if (!run) continue;

    if (now - run.createdAt > RUN_RESUME_WINDOW_MS) {
      const index = firstOpenIndex(new Set(run.outcomes.map((outcome) => outcome.index)));
      const kind = ruleOf(ctx.config, run.ruleId)?.rule.actions[index]?.kind ?? 'run';

      await stopRun(store, ctx.guildId, run, {
        index,
        kind,
        code: 'interrupted',
        status: 'failed',
        at: now,
      });
      summary.failed += 1;
      continue;
    }

    const status = await executeRun(ctx, deps, store, run);
    if (status === 'cancelled') summary.cancelled += 1;
    else if (status !== 'lost') summary.resumed += 1;
  }

  return summary;
}

export function reportTargetOf(event: ProtonEvent, guildId: string): string | null {
  const parsed =
    event.type === 'moderation.report_submitted'
      ? moderationReportSubmittedSchema.safeParse(event.payload)
      : event.type === 'moderation.report_resolved'
        ? moderationReportResolvedSchema.safeParse(event.payload)
        : null;

  return parsed?.success && parsed.data.guildId === guildId ? parsed.data.targetId : null;
}

export function createAutomationListener(deps: ModerationDeps): EventListener<ModerationConfig> {
  return {
    types: ['moderation.report_submitted', 'moderation.report_resolved'],

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      const targetId = reportTargetOf(event, ctx.guildId);
      if (targetId === null) return;

      await evaluateTarget(ctx, deps, targetId, clock(deps));
    },
  };
}

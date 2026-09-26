import type {
  AppealLinkClaims,
  BlockedMemberList,
  BlockedMemberQuery,
  CaseQuery,
  CaseSearchResult,
  CommandCatalogueView,
  CommandEnabledBody,
  CommandIssue,
  CommandUpdateBody,
  CommandUpdateResult,
  CommandView,
  GuildOverview,
  GuildPresence,
  LeaderboardQuery,
  LeaderboardResult,
  LiftBlockResult,
  ModuleConfigView,
  ModuleIndex,
  ModuleUpdateResult,
  VerificationRequestResult,
} from '@proton/core';
import {
  blockedMemberListSchema,
  botInviteSchema,
  commandCatalogueViewSchema,
  commandIssueSchema,
  commandUpdateResultSchema,
  commandViewSchema,
  guildOverviewSchema,
  guildPresenceSchema,
  type JoinrolesRunKind,
  liftBlockResultSchema,
  moduleConfigViewSchema,
  moduleIndexSchema,
  moduleUpdateResultSchema,
  type PanelRequestResult,
  panelRequestResultSchema,
  type SimulationOutcome,
  type SimulationRun,
  simulationOutcomeSchema,
  verificationRequestResultSchema,
} from '@proton/core';
import {
  type AchievementsOverview,
  achievementsOverviewSchema,
  type JobQueued,
  type JobRequest,
  jobQueuedSchema,
  type MemberDetail,
  memberDetailSchema,
  type ResetRequest,
  type ResetResult,
  type RewardListQuery,
  type RewardListResult,
  type RewardRetryOutcome,
  type RewardRetryRequest,
  resetResultSchema,
  rewardListResultSchema,
  rewardRetryOutcomeSchema,
  type UnlockListQuery,
  type UnlockListResult,
  unlockListResultSchema,
} from '@proton/module-achievements/view';
import {
  type NameStyleStatus,
  nameStyleStatusSchema,
} from '@proton/module-branding/name-style-status';
import {
  type JoinRolesSyncStatus,
  type SyncStartResult,
  syncStartResultSchema,
  syncStatusSchema,
} from '@proton/module-joinroles/sync-view';
import {
  type AutomationRunList,
  automationRunListSchema,
  automationRunQuerySchema,
  type CaseEvidenceView,
  caseEvidenceViewSchema,
  type ReportActionBody,
  type ReportActionResult,
  type ReportDetail,
  type ReportListResult,
  type ReportSummaryCounts,
  reportActionResultSchema,
  reportDetailSchema,
  reportListResultSchema,
  reportQuerySchema,
  reportSummaryCountsSchema,
} from '@proton/module-moderation/reports-view';
import type { TagQuery, TagSearchResult } from '@proton/module-tags/query';
import type { TicketQuery, TicketSearchResult } from '@proton/module-tickets/query';
import type { z } from 'zod';
import { z as zod } from 'zod';
import type { AuditStamp } from '../server/audit.ts';
import { COMMAND_CHANGED } from './errors.ts';

const commandIssuesSchema = zod.array(commandIssueSchema).min(1);
const commandEnabledResultSchema = zod.object({ command: commandViewSchema });
const acknowledgedSchema = zod.object({ ok: zod.literal(true) });

const maintenanceViewSchema = zod.object({
  window: zod
    .object({
      guildId: zod.string(),
      enabledBy: zod.string(),
      reason: zod.string().nullable(),
      startedAt: zod.number(),
      expiresAt: zod.number(),
    })
    .nullable(),
  now: zod.number().optional(),
});

export type MaintenanceView = zod.infer<typeof maintenanceViewSchema>;

export const reportListQuerySchema = reportQuerySchema.extend({
  close: zod.enum(['problem']).optional(),
});

export type ReportListQuery = zod.infer<typeof reportListQuerySchema>;

export const automationRunListQuerySchema = automationRunQuerySchema.extend({
  status: zod.union([zod.literal('problem'), automationRunQuerySchema.shape.status]),
});

export type AutomationRunListQuery = zod.infer<typeof automationRunListQuerySchema>;

function queryString(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }

  return params.toString();
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly issues: CommandIssue[] | undefined;

  constructor(
    status: number,
    code: string | undefined,
    message: string,
    issues?: CommandIssue[] | undefined,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #secret: string;

  constructor(baseUrl: string, secret: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#secret = secret;
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-proton-secret': this.#secret,
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        message?: string;
        issues?: unknown;
      };
      const issues = commandIssuesSchema.safeParse(body.issues);

      // Neutral about reads and writes, because the callers supply that half ("Could not save: …").
      // A gateway error or an HTML error page used to reach the admin as "api returned 502".
      throw new ApiError(
        response.status,
        typeof body.error === 'string' ? body.error : undefined,
        body.message ??
          `Proton's API did not answer (HTTP ${response.status}). Nothing was changed. Try again ` +
            `in a moment.`,
        issues.success ? issues.data : undefined,
      );
    }

    return (await response.json()) as T;
  }

  // Parsed rather than cast, for the shapes both apps declare: the dashboard's own copy of
  // ModuleConfigView had already drifted two fields behind the api's before this existed, and a
  // cast turns that into a runtime undefined somewhere far from the endpoint that changed.
  async #parsed<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    init: RequestInit = {},
  ): Promise<z.output<TSchema>> {
    const parsed = schema.safeParse(await this.#request(path, init));

    if (!parsed.success) {
      throw new Error(
        `the api answered ${path} with a shape this dashboard does not understand: ` +
          `${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`,
      );
    }

    return parsed.data;
  }

  getGuild(guildId: string): Promise<GuildOverview> {
    return this.#parsed(`/guilds/${guildId}`, guildOverviewSchema);
  }

  async invitePermissions(): Promise<string> {
    const { permissions } = await this.#parsed('/invite', botInviteSchema);

    return permissions;
  }

  guildPresence(guildIds: readonly string[]): Promise<GuildPresence> {
    return this.#parsed('/guilds/presence', guildPresenceSchema, {
      method: 'POST',
      body: JSON.stringify({ ids: guildIds }),
    });
  }

  listModules(guildId: string): Promise<ModuleIndex> {
    return this.#parsed(`/guilds/${guildId}/modules`, moduleIndexSchema);
  }

  getModule(guildId: string, moduleId: string): Promise<ModuleConfigView> {
    return this.#parsed(`/guilds/${guildId}/modules/${moduleId}`, moduleConfigViewSchema);
  }

  recordVerificationPass(
    guildId: string,
    body: { userId: string; jti: string },
  ): Promise<VerificationRequestResult> {
    return this.#parsed(`/guilds/${guildId}/verification/passed`, verificationRequestResultSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  getMaintenance(guildId: string): Promise<MaintenanceView> {
    return this.#parsed(`/guilds/${guildId}/antinuke/maintenance`, maintenanceViewSchema);
  }

  endMaintenance(guildId: string, actorId: string): Promise<MaintenanceView> {
    return this.#parsed(`/guilds/${guildId}/antinuke/maintenance`, maintenanceViewSchema, {
      method: 'DELETE',
      headers: { 'x-proton-actor': actorId },
    });
  }

  searchCases(guildId: string, query: CaseQuery): Promise<CaseSearchResult> {
    return this.#request(`/guilds/${guildId}/cases?${queryString(query)}`);
  }

  getAppealForm(claims: AppealLinkClaims): Promise<{ guildId: string; view: unknown }> {
    return this.#request(`/guilds/${claims.guildId}/appeals/form`, {
      method: 'POST',
      body: JSON.stringify({ claims }),
    });
  }

  submitAppeal(
    claims: AppealLinkClaims,
    answers: Record<string, string>,
  ): Promise<{ number: number; requestId: string }> {
    return this.#request(`/guilds/${claims.guildId}/appeals/submit`, {
      method: 'POST',
      body: JSON.stringify({ claims, answers }),
    });
  }

  searchBlockedMembers(guildId: string, query: BlockedMemberQuery): Promise<BlockedMemberList> {
    return this.#parsed(
      `/guilds/${guildId}/blocked-members?${queryString(query)}`,
      blockedMemberListSchema,
    );
  }

  liftBlockedMember(
    guildId: string,
    userId: string,
    body: { actorId: string; source: string; liftReason: string; ipHash?: string | undefined },
  ): Promise<LiftBlockResult> {
    return this.#parsed(
      `/guilds/${guildId}/blocked-members/${userId}/lift`,
      liftBlockResultSchema,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  runSimulation(
    guildId: string,
    moduleId: string,
    body: SimulationRun & AuditStamp,
  ): Promise<SimulationOutcome> {
    return this.#parsed(
      `/guilds/${guildId}/modules/${moduleId}/simulations`,
      simulationOutcomeSchema,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  searchReports(
    guildId: string,
    query: ReportListQuery,
    viewerId: string,
  ): Promise<ReportListResult> {
    return this.#parsed(
      `/guilds/${guildId}/moderation/reports?${queryString({ ...query, viewerId })}`,
      reportListResultSchema,
    );
  }

  getReportSummary(guildId: string, viewerId: string): Promise<ReportSummaryCounts> {
    return this.#parsed(
      `/guilds/${guildId}/moderation/reports/summary?${queryString({ viewerId })}`,
      reportSummaryCountsSchema,
    );
  }

  getReport(guildId: string, reportId: string, viewerId: string): Promise<ReportDetail> {
    const path = `/guilds/${guildId}/moderation/reports/${encodeURIComponent(reportId)}`;
    return this.#parsed(`${path}?${queryString({ viewerId })}`, reportDetailSchema);
  }

  listReportAutomationRuns(
    guildId: string,
    query: AutomationRunListQuery,
    viewerId: string,
  ): Promise<AutomationRunList> {
    const path = `/guilds/${guildId}/moderation/reports/automation/runs`;
    return this.#parsed(`${path}?${queryString({ ...query, viewerId })}`, automationRunListSchema);
  }

  actOnReport(
    guildId: string,
    reportId: string,
    body: ReportActionBody,
  ): Promise<ReportActionResult> {
    return this.#parsed(
      `/guilds/${guildId}/moderation/reports/${encodeURIComponent(reportId)}/actions`,
      reportActionResultSchema,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  getCaseEvidence(guildId: string, caseId: string): Promise<CaseEvidenceView> {
    return this.#parsed(
      `/guilds/${guildId}/cases/${encodeURIComponent(caseId)}/evidence`,
      caseEvidenceViewSchema,
    );
  }

  searchTags(guildId: string, query: TagQuery): Promise<TagSearchResult> {
    return this.#request(`/guilds/${guildId}/tags?${queryString(query)}`);
  }

  searchTickets(guildId: string, query: TicketQuery): Promise<TicketSearchResult> {
    return this.#request(`/guilds/${guildId}/tickets?${queryString(query)}`);
  }

  searchLeaderboard(guildId: string, query: LeaderboardQuery): Promise<LeaderboardResult> {
    return this.#request(`/guilds/${guildId}/leaderboard?${queryString(query)}`);
  }

  // The Response itself, not bytes: the card is an image the browser streams into an <img>, and
  // buffering it here to hand back a data URI would cost a base64 round trip per keystroke.
  cardPreview(guildId: string, query: Record<string, unknown>): Promise<Response> {
    return fetch(`${this.#baseUrl}/guilds/${guildId}/cards/preview?${queryString(query)}`, {
      headers: { 'x-proton-secret': this.#secret },
    });
  }

  getNameStyleStatus(guildId: string): Promise<NameStyleStatus> {
    return this.#parsed(`/guilds/${guildId}/branding/name-style/status`, nameStyleStatusSchema);
  }

  getJoinRolesSync(guildId: string): Promise<JoinRolesSyncStatus> {
    return this.#parsed(`/guilds/${guildId}/joinroles/sync`, syncStatusSchema);
  }

  startJoinRolesSync(
    guildId: string,
    body: AuditStamp & { kind: JoinrolesRunKind },
  ): Promise<SyncStartResult> {
    return this.#parsed(`/guilds/${guildId}/joinroles/sync`, syncStartResultSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  getCommands(guildId: string): Promise<CommandCatalogueView> {
    return this.#parsed(`/guilds/${guildId}/commands`, commandCatalogueViewSchema);
  }

  // A result, not a throw: only an Error's message crosses a server function, never its issues.
  async updateCommand(
    guildId: string,
    key: string,
    body: CommandUpdateBody,
  ): Promise<CommandUpdateResult> {
    try {
      return await this.#parsed(
        `/guilds/${guildId}/commands/${encodeURIComponent(key)}`,
        commandUpdateResultSchema,
        { method: 'PUT', body: JSON.stringify(body) },
      );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'invalid_command' && error.issues !== undefined) {
        return { ok: false, issues: error.issues };
      }
      if (error.code === 'command_changed') {
        throw new ApiError(error.status, error.code, COMMAND_CHANGED);
      }
      throw error;
    }
  }

  async setCommandEnabled(
    guildId: string,
    key: string,
    body: CommandEnabledBody,
  ): Promise<CommandView> {
    const { command } = await this.#parsed(
      `/guilds/${guildId}/commands/${encodeURIComponent(key)}/enabled`,
      commandEnabledResultSchema,
      { method: 'POST', body: JSON.stringify(body) },
    );

    return command;
  }

  async ackLostCommandPermissions(guildId: string, body: AuditStamp): Promise<void> {
    await this.#parsed(`/guilds/${guildId}/commands/lost-permissions/ack`, acknowledgedSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  brandingAsset(guildId: string, kind: string): Promise<Response> {
    return fetch(`${this.#baseUrl}/guilds/${guildId}/branding/${kind}`, {
      headers: { 'x-proton-secret': this.#secret },
    });
  }

  uploadBrandingAsset(
    guildId: string,
    kind: string,
    bytes: ArrayBuffer,
    actorId: string,
  ): Promise<Response> {
    return fetch(`${this.#baseUrl}/guilds/${guildId}/branding/${kind}`, {
      method: 'PUT',
      headers: {
        'x-proton-secret': this.#secret,
        'x-proton-actor': actorId,
        'content-type': 'application/octet-stream',
      },
      body: bytes,
    });
  }

  clearBrandingAsset(guildId: string, kind: string, actorId: string): Promise<Response> {
    return fetch(`${this.#baseUrl}/guilds/${guildId}/branding/${kind}`, {
      method: 'DELETE',
      headers: { 'x-proton-secret': this.#secret, 'x-proton-actor': actorId },
    });
  }

  getAchievementsOverview(guildId: string): Promise<AchievementsOverview> {
    return this.#parsed(`/guilds/${guildId}/achievements/overview`, achievementsOverviewSchema);
  }

  getAchievementMember(guildId: string, userId: string): Promise<MemberDetail> {
    return this.#parsed(
      `/guilds/${guildId}/achievements/members/${encodeURIComponent(userId)}`,
      memberDetailSchema,
    );
  }

  listAchievementUnlocks(guildId: string, query: UnlockListQuery): Promise<UnlockListResult> {
    return this.#parsed(
      `/guilds/${guildId}/achievements/unlocks?${queryString(query)}`,
      unlockListResultSchema,
    );
  }

  listAchievementRewards(guildId: string, query: RewardListQuery): Promise<RewardListResult> {
    return this.#parsed(
      `/guilds/${guildId}/achievements/rewards?${queryString(query)}`,
      rewardListResultSchema,
    );
  }

  retryAchievementRewards(
    guildId: string,
    body: RewardRetryRequest & AuditStamp,
  ): Promise<RewardRetryOutcome> {
    return this.#parsed(`/guilds/${guildId}/achievements/rewards/retry`, rewardRetryOutcomeSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  resetAchievements(guildId: string, body: ResetRequest & AuditStamp): Promise<ResetResult> {
    return this.#parsed(`/guilds/${guildId}/achievements/resets`, resetResultSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  requestAchievementJob(guildId: string, body: JobRequest & AuditStamp): Promise<JobQueued> {
    return this.#parsed(`/guilds/${guildId}/achievements/jobs`, jobQueuedSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  achievementBadge(guildId: string, assetId: string): Promise<Response> {
    return fetch(
      `${this.#baseUrl}/guilds/${guildId}/achievements/badges/${encodeURIComponent(assetId)}`,
      { headers: { 'x-proton-secret': this.#secret } },
    );
  }

  uploadAchievementBadge(guildId: string, bytes: ArrayBuffer, actorId: string): Promise<Response> {
    return fetch(`${this.#baseUrl}/guilds/${guildId}/achievements/badges`, {
      method: 'PUT',
      headers: {
        'x-proton-secret': this.#secret,
        'x-proton-actor': actorId,
        'content-type': 'application/octet-stream',
      },
      body: bytes,
    });
  }

  updateModule(
    guildId: string,
    moduleId: string,
    body: AuditStamp & {
      enabled?: boolean | undefined;
      config?: Record<string, unknown> | undefined;
    },
  ): Promise<ModuleUpdateResult> {
    return this.#parsed(`/guilds/${guildId}/modules/${moduleId}`, moduleUpdateResultSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // "Asked", not "posted": the api has no Discord client, so it records the request and publishes
  // it for the worker. The name comes back so the page can say which panel it was.
  postPanel(
    guildId: string,
    moduleId: string,
    panelId: string,
    body: AuditStamp,
  ): Promise<PanelRequestResult> {
    return this.#parsed(
      `/guilds/${guildId}/modules/${moduleId}/panels/${encodeURIComponent(panelId)}/post`,
      panelRequestResultSchema,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }
}

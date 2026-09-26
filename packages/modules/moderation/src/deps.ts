import type {
  GuildStateStore,
  ModuleContext,
  ReportActionOutcome,
  ResolvedMessage,
  UserProfile,
} from '@proton/core';
import type { PlaceholderEnvironment } from '@proton/core/placeholders';
import type { ModerationConfig } from './config.ts';
import type { DraftStore } from './drafts.ts';
import type { GuildMemberLister } from './members.ts';
import type { PunishKind } from './punish/config.ts';
import type {
  CaseLedger,
  CaseMessageStore,
  DmChannelStore,
  MessageHistoryBuffer,
  TimeoutStore,
} from './punish/store.ts';
import type { CommandGateResult } from './punish/types.ts';
import type { ReviewActor } from './reports/authorize.ts';
import type { PromptStore, ReactionGate } from './reports/redis-store.ts';
import type { ReportStore } from './reports/store.ts';
import type { RoleRunStore } from './run-store.ts';
import type { WarningStore } from './store.ts';

export type MessageRead =
  | { ok: true; message: ResolvedMessage }
  | { ok: false; reason: 'not_found' | 'no_access' | 'failed' };

export type MemberLookup =
  | { state: 'member'; roleIds: string[]; timeoutUntil: number | null; joinedAt: number | null }
  | { state: 'absent' }
  | { state: 'unavailable'; status: number };

export interface ModerationDeps {
  // Unbound leaves the subcommand that needs it registered but refusing: the command list is
  // built without bindings for the dashboard and the landing page, and a command that vanishes
  // there is worse than one that says why it cannot run.
  warnings?: WarningStore;

  // Role positions and the managed flag, for the hierarchy checks the executor's prechecks do not
  // make — they judge the target member, never the role being handed out or the invoker's rank.
  guildState?: GuildStateStore;

  // The target member's own roles, for the same reason: ranking them against the invoker needs
  // their role list, and the executor fetches it too late and only ever compares it to Proton's.
  fetchMemberRoles?(guildId: string, userId: string): Promise<string[] | null>;

  members?: GuildMemberLister;
  roleRuns?: RoleRunStore;

  // Needed to follow up a deferred interaction: /role's mass path answers after it has posted a
  // message and booked a job, which is well past the three seconds Discord allows a first reply.
  applicationId?: string;

  lookupMember?(guildId: string, userId: string): Promise<MemberLookup>;
  drafts?: DraftStore;

  reports?: ReportStore;
  reactionGate?: ReactionGate;
  prompts?: PromptStore;
  readMessage?(guildId: string, channelId: string, messageId: string): Promise<MessageRead>;
  users?: { resolve(userId: string): Promise<UserProfile | null> };
  mailbox?: { answer(requestId: string, outcome: ReportActionOutcome): Promise<void> };

  commandGate?(
    guildId: string,
    commandName: string,
    roleIds: readonly string[],
  ): Promise<CommandGateResult>;
  timeouts?: TimeoutStore;
  ledger?: CaseLedger;
  caseMessages?: CaseMessageStore;
  history?: MessageHistoryBuffer;
  dmChannels?: DmChannelStore;
  reversals?: { cancel(idempotencyKey: string): Promise<unknown> };
  placeholders?: PlaceholderEnvironment;
  botUserId?: string;
  now?(): number;
  dashboardUrl?: string;

  reportAccept?(
    ctx: ModuleContext<ModerationConfig>,
    request: ReportAcceptRequest,
  ): Promise<ReportAcceptResult>;
}

export interface ReportAcceptRequest {
  reportId: string;
  actor: ReviewActor;
  punishment: 'none' | PunishKind;
  reason?: string;
  duration?: string | null;
  deleteMessage: boolean;
  note?: string;
  reporterNote?: string;
  confirmRecentCase?: boolean;
  token: string;
}

export type ReportAcceptResult =
  | { ok: true; message: string; caseId?: string }
  | { ok: false; code: string; message: string; needsConfirmation?: 'recent_case' };

import { Permissions, type ResolvedAttachment } from '@proton/core';
import type { PunishDirection, PunishKind, UnpunishKind } from './config.ts';

export interface PunishActor {
  id: string;
  roleIds: string[] | null;
  permissions: bigint | null;
  kind: 'member' | 'automation';
  label?: string;
}

export interface ProofMessage {
  channelId: string;
  messageId: string;
  authorId: string;
  content: string;
  createdAt: number | null;
  attachments: ResolvedAttachment[];
  url: string;
}

export type PunishOrigin =
  | { type: 'command' }
  | { type: 'message' }
  | { type: 'report'; reportId: string }
  | { type: 'automation'; ruleId: string; runId: string };

export type NotifyMode = 'inherit' | 'send' | 'skip';

export interface PunishRequest {
  guildId: string;
  kind: PunishKind;
  targetId: string;
  actor: PunishActor;
  reason?: string;
  duration?: string | null;
  deleteMessageDays?: number;
  proof?: ProofMessage;
  deleteProof?: boolean;
  origin: PunishOrigin;
  notify?: NotifyMode;
  confirmedRecentCase?: boolean;
  channelId?: string;
  idempotencyRoot: string;
  dmRoot?: string;
}

export interface UnpunishRequest {
  guildId: string;
  kind: UnpunishKind;
  targetId?: string;
  caseId?: string;
  actor: PunishActor;
  reason?: string;
  origin: PunishOrigin;
  notify?: NotifyMode;
  idempotencyRoot: string;
}

export const PUNISH_REFUSALS = [
  'wrong_guild',
  'unbound',
  'reason_required',
  'invalid_duration',
  'duration_too_long',
  'lookup_unavailable',
  'not_member',
  'guild_state_unavailable',
  'hierarchy',
  'immune_role',
  'missing_permission',
  'proof_permission',
  'command_gated',
  'case_not_found',
  'already_reverted',
] as const;

export type PunishRefusal = (typeof PUNISH_REFUSALS)[number];

export type DmOutcome =
  | 'sent'
  | 'closed'
  | 'no_mutual_server'
  | 'failed'
  | 'gave_up'
  | 'skipped'
  | 'not_sent';

export type ExtraStep = 'add_role' | 'remove_role' | 'disconnect' | 'delete_proof' | 'history';

export interface ExtraOutcome {
  step: ExtraStep;
  roleId?: string;
  status: 'done' | 'skipped' | 'failed';
  message: string;
}

export type PunishOutcome =
  | {
      status: 'executed';
      kind: PunishKind;
      caseId: string | null;
      reason: string;
      expiresAt: number | null;
      dm: DmOutcome;
      extras: ExtraOutcome[];
      proofDeleted: boolean | null;
      summary: string;
    }
  | { status: 'refused'; code: PunishRefusal; message: string }
  | { status: 'needs_confirmation'; code: 'recent_case'; message: string; recentCaseId: string }
  | { status: 'failed'; code: string; message: string }
  | { status: 'duplicate'; message: string };

export type UnpunishOutcome =
  | {
      status: 'executed';
      kind: UnpunishKind;
      caseId: string | null;
      reason: string;
      dm: DmOutcome;
      extras: ExtraOutcome[];
      revertedCaseIds: string[];
      summary: string;
    }
  | { status: 'refused'; code: PunishRefusal; message: string }
  | { status: 'failed'; code: string; message: string }
  | { status: 'duplicate'; message: string };

export type CommandGateResult = { allowed: true } | { allowed: false; message: string };

export const KIND_PERMISSION: Readonly<Record<PunishKind, bigint>> = {
  warn: Permissions.ModerateMembers,
  timeout: Permissions.ModerateMembers,
  kick: Permissions.KickMembers,
  ban: Permissions.BanMembers,
};

export const KIND_COMMAND: Readonly<Record<PunishKind, string>> = {
  warn: 'warn',
  timeout: 'timeout',
  kick: 'kick',
  ban: 'ban',
};

export const DIRECTION_VERB: Readonly<Record<PunishDirection, string>> = {
  ban: 'ban',
  unban: 'unban',
  kick: 'kick',
  timeout: 'time out',
  untimeout: 'end the timeout of',
  warn: 'warn',
  unwarn: 'withdraw a warning from',
};

export const DIRECTION_NOUN: Readonly<Record<PunishDirection, string>> = {
  ban: 'ban',
  unban: 'unban',
  kick: 'kick',
  timeout: 'timeout',
  untimeout: 'timeout removal',
  warn: 'warning',
  unwarn: 'warning withdrawal',
};

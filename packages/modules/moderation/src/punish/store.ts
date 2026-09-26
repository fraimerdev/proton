import { z } from 'zod';

export const TIMEOUT_CLOSE_REASONS = [
  'removed',
  'superseded',
  'expired',
  'removed_in_discord',
] as const;

export type TimeoutCloseReason = (typeof TIMEOUT_CLOSE_REASONS)[number];

export interface TimeoutRow {
  caseId: string;
  guildId: string;
  userId: string;
  startedAt: number;
  endsAt: number;
  appliedUntil: number | null;
  closedAt: number | null;
  closedBy: string | null;
  closeReason: TimeoutCloseReason | null;
  expiryLoggedAt: number | null;
}

export interface NewTimeout {
  caseId: string;
  guildId: string;
  userId: string;
  startedAt: Date;
  endsAt: Date;
  appliedUntil: Date | null;
}

export interface TimeoutClose {
  at: Date;
  by: string | null;
  reason: TimeoutCloseReason;
}

export interface TimeoutStore {
  record(row: NewTimeout): Promise<boolean>;
  open(guildId: string, userId: string): Promise<TimeoutRow[]>;
  openUsers(guildId: string): Promise<string[]>;
  close(guildId: string, caseIds: readonly string[], close: TimeoutClose): Promise<TimeoutRow[]>;
  closeOpen(
    guildId: string,
    userId: string,
    close: TimeoutClose,
    options?: { except?: string },
  ): Promise<TimeoutRow[]>;
  setAppliedUntil(guildId: string, userId: string, until: Date): Promise<void>;
  markExpiryLogged(guildId: string, caseId: string, at: Date): Promise<boolean>;
  trackedCaseIds(guildId: string, userId: string): Promise<string[]>;
}

export interface LedgerCase {
  caseId: string;
  kind: string;
  targetId: string | null;
  actorId: string | null;
  reason: string | null;
  idempotencyKey: string;
  createdAt: number;
  expiresAt: number | null;
  revertedAt: number | null;
  revertedBy: string | null;
}

export interface CaseMatch {
  targetId: string;
  kind: string;
  caseIds?: readonly string[];
  exceptCaseIds?: readonly string[];
  createdAfter?: Date;
}

export interface CaseStamp {
  at: Date;
  by: string;
}

export interface CaseLedger {
  recent(guildId: string, targetId: string, kind: string, since: Date): Promise<LedgerCase | null>;
  closeOpen(guildId: string, match: CaseMatch, stamp: CaseStamp): Promise<LedgerCase[]>;
  byIdempotencyKey(
    guildId: string,
    key: string,
  ): Promise<{ caseId: string; kind: string; revertedAt: number | null } | null>;
  find(guildId: string, caseId: string): Promise<LedgerCase | null>;
  countsForTarget(guildId: string, targetId: string): Promise<Record<string, number>>;
  lastCase(guildId: string, targetId: string): Promise<LedgerCase | null>;
}

export const caseAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string().nullable(),
  size: z.number().int().nonnegative(),
  url: z.string(),
  expiresAt: z.number().nullable(),
});

export type CaseAttachment = z.infer<typeof caseAttachmentSchema>;

export const caseAttachmentsSchema = z.array(caseAttachmentSchema);

export interface BufferedMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  content: string;
  attachments: CaseAttachment[];
  createdAt: number;
  deletedAt: number | null;
}

export interface CaseMessage extends BufferedMessage {
  caseId: string;
  guildId: string;
  proof: boolean;
  capturedAt: number;
  expiresAt: number;
}

export type NewCaseMessage = Omit<CaseMessage, 'capturedAt'>;

export interface CaseMessageStore {
  save(rows: readonly NewCaseMessage[]): Promise<number>;
  forCase(guildId: string, caseId: string): Promise<CaseMessage[]>;
  purgeExpired(now: Date): Promise<number>;
}

export interface MessageHistoryBuffer {
  record(guildId: string, message: BufferedMessage): Promise<void>;
  markDeleted(guildId: string, channelId: string, messageId: string, at: number): Promise<void>;
  recent(guildId: string, userId: string, now: number): Promise<BufferedMessage[]>;
  purge(guildId: string): Promise<void>;
}

export interface DmChannelStore {
  recall(guildId: string, userId: string): Promise<string | null>;
  remember(guildId: string, userId: string, channelId: string): Promise<void>;
}

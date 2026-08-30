import type { CheckedAnswer, FiledAppeal } from './web.ts';

export interface FileAppealInput {
  guildId: string;
  userId: string;
  panelId: string;

  origin: string;
  jti: string;

  answers: CheckedAnswer[];
}

export interface AppealRecord extends FiledAppeal {
  guildId: string;
  userId: string;
  panelId: string;

  origin: string;
  jti: string;

  decidedBy: string | null;
  decisionNote: string | null;
  outcomeApplied: boolean;

  cardChannelId: string | null;
  cardMessageId: string | null;

  dmChannelId: string | null;
  dmAttempts: number;

  answers: CheckedAnswer[];
}

export interface DecideInput {
  guildId: string;
  appealId: string;

  decision: 'approved' | 'denied';
  decidedBy: string;
  note?: string | undefined;
}

export interface AppealStore {
  // Idempotent on (guildId, origin, jti): re-opening the same link finds the appeal already filed
  // rather than filing a second one.
  file(input: FileAppealInput): Promise<{ appeal: AppealRecord; filed: boolean }>;

  find(guildId: string, appealId: string): Promise<AppealRecord | null>;

  findByLink(guildId: string, origin: string, jti: string): Promise<AppealRecord | null>;

  lastDecidedAt(guildId: string, userId: string): Promise<number | null>;

  // The conditional UPDATE is the lock. Two reviewers pressing at once are two different event
  // ids, so the executor's dedupe cannot arbitrate between them; the loser gets null.
  decide(input: DecideInput): Promise<AppealRecord | null>;

  markApplied(guildId: string, appealId: string): Promise<void>;

  rememberCard(
    guildId: string,
    appealId: string,
    channelId: string,
    messageId: string,
  ): Promise<void>;

  rememberDm(guildId: string, appealId: string, channelId: string): Promise<void>;

  noteDmAttempt(guildId: string, appealId: string): Promise<number>;
}

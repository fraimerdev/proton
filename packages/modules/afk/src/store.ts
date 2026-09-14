export interface AfkStatus {
  guildId: string;
  userId: string;
  sessionId: string;
  reason: string | null;
  since: Date;
  previousNick: string | null;
  appliedNick: string | null;
  endedAt: Date | null;
  endedBy: string | null;
}

export interface AfkPing {
  sessionId: string;
  guildId: string;
  userId: string;
  messageId: string;
  channelId: string;
  authorId: string;
  pingedAt: Date;
}

export interface StartAfkInput {
  guildId: string;
  userId: string;
  sessionId: string;
  reason: string | null;
  since: Date;
  previousNick: string | null;
}

export interface StartAfkResult {
  status: AfkStatus;
  created: boolean;
}

export type RecordPingInput = Omit<AfkPing, 'sessionId'>;

export interface AfkStore {
  start(input: StartAfkInput): Promise<StartAfkResult>;

  get(guildId: string, userId: string): Promise<AfkStatus | null>;
  active(guildId: string, userIds: readonly string[]): Promise<AfkStatus[]>;
  all(guildId: string): Promise<AfkStatus[]>;

  updateReason(guildId: string, userId: string, reason: string | null): Promise<AfkStatus | null>;
  setAppliedNick(sessionId: string, appliedNick: string | null): Promise<void>;
  recordTag(sessionId: string, nick: string): Promise<boolean>;

  recordPing(sessionId: string, input: RecordPingInput): Promise<boolean>;
  pings(sessionId: string): Promise<AfkPing[]>;

  markEnded(sessionId: string, endedBy: string): Promise<AfkStatus | null>;
  finishSession(sessionId: string): Promise<void>;

  remove(sessionId: string): Promise<void>;
  removeMember(guildId: string, userId: string): Promise<void>;
}

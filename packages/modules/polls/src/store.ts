export interface PollRecord {
  guildId: string;
  channelId: string;
  messageId: string;
  createdBy: string;
  question: string;
  endsAt: Date;
  endedAt: Date | null;
  announceChannelId: string | null;
  createdAt: Date;
}

export interface CreatePollInput {
  guildId: string;
  channelId: string;
  messageId: string;
  createdBy: string;
  question: string;
  endsAt: Date;
  announceChannelId: string | null;
}

export interface PollStore {
  create(input: CreatePollInput): Promise<void>;

  get(guildId: string, messageId: string): Promise<PollRecord | null>;

  listRunning(guildId: string): Promise<PollRecord[]>;

  // Discord expires a poll at its own deadline whether or not Proton's closing job ever ran, so a
  // row past ends_at holds nothing open and must not hold an entitlement slot either.
  countRunning(guildId: string, now: Date): Promise<number>;

  // Conditional on ended_at being null and reporting whether it changed anything: the announce
  // schedule is redelivered, so "has this already been announced?" has to be one atomic question.
  end(guildId: string, messageId: string, endedAt: Date): Promise<boolean>;
}

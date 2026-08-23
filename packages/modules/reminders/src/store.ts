export interface Reminder {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  content: string;
  remindAt: Date;
  createdAt: Date;
  deliveredAt: Date | null;
}

export interface CreateReminderInput {
  // The interaction's own event id. A redelivered command carries the same one, so the insert
  // collides instead of booking a second reminder that fires alongside the first.
  id: string;

  guildId: string;
  userId: string;
  channelId: string;
  content: string;
  remindAt: Date;
}

export interface PendingQuery {
  guildId: string;
  userId: string;
  limit: number;

  search?: string;
}

export interface ReminderStore {
  create(input: CreateReminderInput): Promise<Reminder | null>;

  get(guildId: string, id: string): Promise<Reminder | null>;

  pending(query: PendingQuery): Promise<Reminder[]>;
  countPending(guildId: string, userId: string): Promise<number>;

  remove(guildId: string, id: string, userId: string): Promise<boolean>;

  markDelivered(guildId: string, id: string, deliveredAt: Date): Promise<boolean>;
}

export interface StarboardPost {
  guildId: string;
  sourceMessageId: string;
  boardMessageId: string;

  starCount: number;
  createdAt: Date;
}

export interface StarboardStore {
  get(guildId: string, sourceMessageId: string): Promise<StarboardPost | null>;

  record(post: StarboardPost): Promise<boolean>;

  setCount(guildId: string, sourceMessageId: string, starCount: number): Promise<void>;

  remove(guildId: string, sourceMessageId: string): Promise<void>;
}

import type { BotFacts, ServerFacts, UserFacts } from './facts.ts';

export interface PlaceholderEnvironment {
  applicationId: string;
  bot(): Promise<BotFacts>;
  server(guildId: string): Promise<ServerFacts>;
  user(userId: string): Promise<UserFacts | null>;
  now(): number;
}

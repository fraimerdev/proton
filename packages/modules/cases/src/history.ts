export const CASE_TYPES = [
  'ban',
  'kick',
  'timeout',
  'warn',
  'quarantine',
  'unban',
  'untimeout',
] as const;

export type CaseType = (typeof CASE_TYPES)[number];

export interface CaseCountQuery {
  guildId: string;
  userIds: readonly string[];

  types: readonly string[];

  /** Only cases created at or after this instant. Omitted counts every case ever. */
  since?: Date;

  /** Only cases still in force — not reverted, and not expired by `now`. */
  activeAt?: Date;
}

export interface CaseHistoryStore {
  /** One statement for every member asked about — never one query per member. */
  countByTarget(query: CaseCountQuery): Promise<Map<string, number>>;
}

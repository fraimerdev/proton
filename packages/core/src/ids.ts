import { ulid } from 'ulid';

export function newId(): string {
  return ulid();
}

export const DISCORD_EPOCH_MS = 1_420_070_400_000;

export function snowflakeCreatedAt(id: string): number | null {
  if (!/^\d{17,20}$/.test(id)) return null;

  return Number((BigInt(id) >> 22n) + BigInt(DISCORD_EPOCH_MS));
}

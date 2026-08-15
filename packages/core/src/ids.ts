import { ulid } from 'ulid';

/**
 * Monotonic, lexicographically sortable ID.
 *
 * ULID rather than UUIDv4 because `ProtonEvent.id` doubles as the dedupe key and
 * as a `cases` primary key — sortable IDs keep those indexes from fragmenting.
 */
export function newId(): string {
  return ulid();
}

/** Discord's epoch — the zero point every snowflake timestamp counts from. */
export const DISCORD_EPOCH_MS = 1_420_070_400_000;

/**
 * When the entity behind a snowflake was created, in ms since the Unix epoch.
 *
 * A snowflake carries its own creation time in the top 42 bits, so an account's
 * age needs no API call — which is what makes the `account-age` rule condition
 * (§4-P2) free to evaluate on every join during a raid.
 *
 * bigint throughout: a snowflake exceeds `Number.MAX_SAFE_INTEGER`, so shifting
 * it as a Number silently returns the wrong millisecond.
 */
export function snowflakeCreatedAt(id: string): number | null {
  if (!/^\d{17,20}$/.test(id)) return null;
  // The result is a millisecond timestamp, comfortably inside Number's exact range.
  return Number((BigInt(id) >> 22n) + BigInt(DISCORD_EPOCH_MS));
}

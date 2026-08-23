import { ulid } from 'ulid';

export function newId(): string {
  return ulid();
}

export const CASE_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export const CASE_ID_LENGTH = 7;

// 256 is not a multiple of 62, so the first 8 byte values would land twice as often as the rest.
// Drawing again beyond the last whole cycle is what keeps every id equally likely.
const CASE_ID_BYTE_CEILING = 256 - (256 % CASE_ID_ALPHABET.length);

export function newCaseId(): string {
  let id = '';
  const buffer = new Uint8Array(CASE_ID_LENGTH);

  while (id.length < CASE_ID_LENGTH) {
    crypto.getRandomValues(buffer);

    for (const byte of buffer) {
      if (byte >= CASE_ID_BYTE_CEILING) continue;

      id += CASE_ID_ALPHABET[byte % CASE_ID_ALPHABET.length];
      if (id.length === CASE_ID_LENGTH) break;
    }
  }

  return id;
}

export const DISCORD_EPOCH_MS = 1_420_070_400_000;

export function snowflakeCreatedAt(id: string): number | null {
  if (!/^\d{17,20}$/.test(id)) return null;

  return Number((BigInt(id) >> 22n) + BigInt(DISCORD_EPOCH_MS));
}

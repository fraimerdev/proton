// No I, O, 0 or 1: a host reads this code off a message and types it into a command, and the
// confusable pairs are the ones that get mistyped. 32 divides 256, so byte % 32 is already
// uniform and needs no rejection loop.
export const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const SHORT_CODE_LENGTH = 4;
export const SHORT_CODE_PREFIX = 'G-';

export function newShortCode(): string {
  const bytes = new Uint8Array(SHORT_CODE_LENGTH);
  crypto.getRandomValues(bytes);

  let code = '';
  for (const byte of bytes) code += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length];

  return code;
}

export function formatShortCode(code: string | null): string | null {
  return code === null ? null : `${SHORT_CODE_PREFIX}${code}`;
}

/**
 * Accepts what a host will actually type: `G-7X29`, `g-7x29` or bare `7x29`. Returns null when the
 * input is not short-code shaped at all, which is how the caller knows to try it as a raw id.
 */
export function parseShortCode(reference: string): string | null {
  const trimmed = reference.trim().toUpperCase();
  const body = trimmed.startsWith(SHORT_CODE_PREFIX) ? trimmed.slice(2) : trimmed;

  if (body.length !== SHORT_CODE_LENGTH) return null;

  for (const character of body) {
    if (!SHORT_CODE_ALPHABET.includes(character)) return null;
  }

  return body;
}

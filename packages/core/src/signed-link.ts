import type { z } from 'zod';

export const SIGNED_LINK_SECRET_MIN = 32;

export type SignedLinkResult<T> = { claims: T } | { invalid: string };

export interface SignedLinkClaims {
  expiresAt: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

  const padded = value.replaceAll('-', '+').replaceAll('_', '/');

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  return bytes;
}

async function sign(secret: string, body: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
}

// Returning early on the first differing byte would leak the length of the matching prefix, which
// is enough to forge a signature one byte at a time.
function equals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);

  return difference === 0;
}

export async function signLink<S extends z.ZodType<SignedLinkClaims>>(
  schema: S,
  claims: z.infer<S>,
  secret: string,
): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(schema.parse(claims))));

  return `${body}.${toBase64Url(await sign(secret, body))}`;
}

export async function readLink<S extends z.ZodType<SignedLinkClaims>>(
  schema: S,
  token: string,
  secret: string,
  now: number,
  what: string,
): Promise<SignedLinkResult<z.infer<S>>> {
  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) {
    return { invalid: 'the token is not a body.signature pair' };
  }

  const body = token.slice(0, separator);
  const presented = fromBase64Url(token.slice(separator + 1));
  if (!presented) return { invalid: 'the signature is not base64url' };

  if (!equals(presented, await sign(secret, body))) {
    return { invalid: 'the signature does not match this deployment’s VERIFY_LINK_SECRET' };
  }

  const decoded = fromBase64Url(body);
  if (!decoded) return { invalid: 'the body is not base64url' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(decoded));
  } catch {
    return { invalid: 'the body is signed but is not JSON' };
  }

  const claims = schema.safeParse(parsed);
  if (!claims.success) return { invalid: `the body is signed but is not ${what}` };

  if (claims.data.expiresAt <= now) {
    return { invalid: `the link expired at ${new Date(claims.data.expiresAt).toISOString()}` };
  }

  return { claims: claims.data };
}

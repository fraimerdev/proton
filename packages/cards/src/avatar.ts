/**
 * Fetching avatar bitmaps, and the I2 question that comes with it.
 *
 * **The decision, written down because it looks like a violation and is not.**
 * I2 says every Discord REST call goes through `apps/rest-proxy`, and no other
 * process creates a REST client against discord.com. Avatars live on
 * `cdn.discordapp.com`, which is a static asset host, not `discord.com/api`: it
 * is unauthenticated, carries no bot token, is not rate-limited into the buckets
 * the proxy exists to share, and returns image bytes rather than API resources.
 * Routing it through the proxy would put megabytes of image traffic through the
 * one component whose whole job is serialising token-bearing, bucket-limited
 * calls — it would make the proxy worse at the thing I2 protects. So this fetch
 * is direct, and the containment is here instead:
 *
 *  - **A host allowlist**, so this can never be pointed at an arbitrary URL. The
 *    avatar URL is derived from user-controlled ids upstream; without this the
 *    renderer is an SSRF gadget.
 *  - **A byte cap**, checked against `content-length` *and* enforced while
 *    streaming, because a hostile or broken origin can lie about the former.
 *  - **A timeout**, so a slow CDN cannot hold a bus consumer open.
 *  - **A content-type allowlist**, which is also a satori constraint — see below.
 *  - **Failure returns `null`, never throws.** docs/PHASE-3.md G8: "A CDN blip
 *    must degrade the card, never fail the command." The layout draws a monogram
 *    instead and the member still gets their welcome.
 */

const ALLOWED_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/**
 * satori decodes embedded images itself and understands PNG, JPEG and GIF only.
 *
 * That matters upstream, not here: Discord's CDN serves WebP by default and only
 * returns PNG when the URL asks for it, so callers must build the URL with a
 * `.png` extension. `discordAvatarUrl` below is the supported way to do that.
 */
const ALLOWED_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif'];

/** 256px of PNG is ~40 KB; a megabyte is generous and still bounds the damage. */
export const AVATAR_MAX_BYTES = 1_048_576;

export const AVATAR_TIMEOUT_MS = 2_000;

/**
 * The port (I11).
 *
 * Injected so tests never touch the network — not merely for speed, but because
 * a renderer test that reaches `cdn.discordapp.com` is a test that fails in CI
 * for reasons unrelated to the code, and Gate 3 criterion 6 requires a card to
 * render with no network at all.
 */
export interface AvatarFetcher {
  /** Resolves to the raw image bytes, or `null` if the avatar could not be had. */
  fetch(url: string): Promise<Uint8Array | null>;
}

/**
 * Narrower than `typeof globalThis.fetch` on purpose.
 *
 * Bun's `fetch` carries a `preconnect` property, so the full type would oblige
 * every test fake to stub a method this class never calls. The port is the two
 * arguments actually used.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpAvatarFetcherOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Swappable only so tests can assert the guards without a live socket. */
  fetchImpl?: FetchLike;
  /** Called with the reason an avatar was skipped; the caller decides whether to log it. */
  onSkip?: (reason: string) => void;
}

function contentTypeAllowed(header: string | null): boolean {
  if (!header) return false;
  const type = header.split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_CONTENT_TYPES.includes(type);
}

/**
 * Read at most `maxBytes`, aborting the moment the budget is exceeded.
 *
 * `response.arrayBuffer()` would buffer the whole body first and only then let us
 * measure it, which makes the cap advisory rather than enforced.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body = response.body;
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class HttpAvatarFetcher implements AvatarFetcher {
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #onSkip: (reason: string) => void;

  constructor(options: HttpAvatarFetcherOptions = {}) {
    this.#maxBytes = options.maxBytes ?? AVATAR_MAX_BYTES;
    this.#timeoutMs = options.timeoutMs ?? AVATAR_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#onSkip = options.onSkip ?? (() => undefined);
  }

  async fetch(url: string): Promise<Uint8Array | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      this.#onSkip(`avatar URL is not a URL: ${url}`);
      return null;
    }

    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
      this.#onSkip(
        `refused to fetch an avatar from '${parsed.protocol}//${parsed.hostname}': cards only ` +
          `fetch over https from ${[...ALLOWED_HOSTS].join(' or ')}`,
      );
      return null;
    }

    try {
      const response = await this.#fetch(parsed.toString(), {
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: 'error',
      });

      if (!response.ok) {
        this.#onSkip(`avatar CDN answered ${response.status} for ${parsed.pathname}`);
        return null;
      }

      if (!contentTypeAllowed(response.headers.get('content-type'))) {
        this.#onSkip(
          `avatar at ${parsed.pathname} is '${response.headers.get('content-type') ?? 'untyped'}'; ` +
            `card rendering can only embed ${ALLOWED_CONTENT_TYPES.join(', ')} — request the ` +
            'avatar with a .png extension',
        );
        return null;
      }

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.#maxBytes) {
        this.#onSkip(`avatar at ${parsed.pathname} declares ${declared} bytes, over the cap`);
        return null;
      }

      const bytes = await readCapped(response, this.#maxBytes);
      if (!bytes) {
        this.#onSkip(`avatar at ${parsed.pathname} exceeded the ${this.#maxBytes}-byte cap`);
        return null;
      }
      return bytes;
    } catch (cause) {
      this.#onSkip(
        `avatar fetch for ${parsed.pathname} failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return null;
    }
  }
}

/** Never fetches anything. The default, so a caller must opt in to network. */
export const nullAvatarFetcher: AvatarFetcher = { fetch: async () => null };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38]);

function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

/**
 * Sniff the real format rather than trusting the header we already checked.
 *
 * Belt and braces on purpose: satori keys its decoder off the data URI's media
 * type, so a mislabelled body would be handed to the wrong decoder and throw
 * from inside satori — where the message says nothing about avatars. Returning
 * `null` here turns that into the monogram fallback instead.
 */
export function toDataUri(bytes: Uint8Array): string | null {
  const type = startsWith(bytes, PNG)
    ? 'image/png'
    : startsWith(bytes, JPEG)
      ? 'image/jpeg'
      : startsWith(bytes, GIF)
        ? 'image/gif'
        : null;
  if (!type) return null;

  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * Build the CDN URL for a member's avatar in a format satori can decode.
 *
 * `.png` is explicit because the CDN negotiates WebP otherwise, and `size` is
 * capped at 256 because that is already above the largest avatar any preset
 * draws — asking for 1024 would quadruple the bytes for pixels the layout throws
 * away. Verified against docs.discord.com's CDN reference (image formats and the
 * power-of-two `size` range) on 2026-08-15.
 */
export function discordAvatarUrl(userId: string, avatarHash: string, size = 256): string {
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=${size}`;
}

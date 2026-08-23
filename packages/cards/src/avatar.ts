const ALLOWED_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

const ALLOWED_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif'];

export const IMAGE_MAX_BYTES = 1_048_576;

export const IMAGE_TIMEOUT_MS = 2_000;

export interface ImageFetcher {
  fetch(url: string): Promise<Uint8Array | null>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpImageFetcherOptions {
  maxBytes?: number;
  timeoutMs?: number;

  fetchImpl?: FetchLike;

  onSkip?: (reason: string) => void;
}

function contentTypeAllowed(header: string | null): boolean {
  if (!header) return false;
  const type = header.split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_CONTENT_TYPES.includes(type);
}

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

export class HttpImageFetcher implements ImageFetcher {
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #onSkip: (reason: string) => void;

  constructor(options: HttpImageFetcherOptions = {}) {
    this.#maxBytes = options.maxBytes ?? IMAGE_MAX_BYTES;
    this.#timeoutMs = options.timeoutMs ?? IMAGE_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#onSkip = options.onSkip ?? (() => undefined);
  }

  async fetch(url: string): Promise<Uint8Array | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      this.#onSkip(`card image URL is not a URL: ${url}`);
      return null;
    }

    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
      this.#onSkip(
        `refused to fetch a card image from '${parsed.protocol}//${parsed.hostname}': cards only ` +
          `fetch over https from ${[...ALLOWED_HOSTS].join(' or ')}. Upload the image to Discord ` +
          'and use the link Discord gives it.',
      );
      return null;
    }

    try {
      const response = await this.#fetch(parsed.toString(), {
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: 'error',
      });

      if (!response.ok) {
        this.#onSkip(`the Discord CDN answered ${response.status} for ${parsed.pathname}`);
        return null;
      }

      if (!contentTypeAllowed(response.headers.get('content-type'))) {
        this.#onSkip(
          `the image at ${parsed.pathname} is '${response.headers.get('content-type') ?? 'untyped'}'; ` +
            `card rendering can only draw ${ALLOWED_CONTENT_TYPES.join(', ')} — request it ` +
            'with a .png extension',
        );
        return null;
      }

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.#maxBytes) {
        this.#onSkip(`the image at ${parsed.pathname} declares ${declared} bytes, over the cap`);
        return null;
      }

      const bytes = await readCapped(response, this.#maxBytes);
      if (!bytes) {
        this.#onSkip(`the image at ${parsed.pathname} exceeded the ${this.#maxBytes}-byte cap`);
        return null;
      }
      return bytes;
    } catch (cause) {
      this.#onSkip(
        `fetching the image at ${parsed.pathname} failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return null;
    }
  }
}

export const nullImageFetcher: ImageFetcher = { fetch: async () => null };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38]);

function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

export function isRenderableImage(bytes: Uint8Array): boolean {
  return startsWith(bytes, PNG) || startsWith(bytes, JPEG) || startsWith(bytes, GIF);
}

export function discordAvatarUrl(userId: string, avatarHash: string, size = 256): string {
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=${size}`;
}

export const CARD_IMAGE_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'] as const;

const ALLOWED_HOSTS = new Set<string>(CARD_IMAGE_HOSTS);

// The dashboard's live preview loads card images itself and would otherwise draw a background the
// renderer refuses — and with it the scrim and lifted ink that come with having one at all.
export function cardImageHostAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

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

export function imageMimeType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, GIF)) return 'image/gif';
  return null;
}

export function isRenderableImage(bytes: Uint8Array): boolean {
  return imageMimeType(bytes) !== null;
}

const IHDR = new Uint8Array([0x49, 0x48, 0x44, 0x52]);

export const IMAGE_MAX_SIDE = 4_096;

export interface ImageSize {
  width: number;
  height: number;
}

function uint16(bytes: Uint8Array, offset: number, littleEndian = false): number | null {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  if (first === undefined || second === undefined) return null;
  return littleEndian ? first | (second << 8) : (first << 8) | second;
}

function uint32(bytes: Uint8Array, offset: number): number | null {
  const high = uint16(bytes, offset);
  const low = uint16(bytes, offset + 2);
  return high === null || low === null ? null : high * 65_536 + low;
}

function pngSize(bytes: Uint8Array): ImageSize | null {
  if (!IHDR.every((byte, index) => bytes[12 + index] === byte)) return null;

  const width = uint32(bytes, 16);
  const height = uint32(bytes, 20);
  return width === null || height === null ? null : { width, height };
}

function gifSize(bytes: Uint8Array): ImageSize | null {
  const width = uint16(bytes, 6, true);
  const height = uint16(bytes, 8, true);
  return width === null || height === null ? null : { width, height };
}

const NOT_A_FRAME: ReadonlySet<number> = new Set([0xc4, 0xc8, 0xcc]);

function jpegSize(bytes: Uint8Array): ImageSize | null {
  let offset = 2;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;

    const marker = bytes[offset + 1];
    if (marker === undefined) return null;

    // Any number of 0xff bytes may pad a marker, so one is stepped over rather than two.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = uint16(bytes, offset + 2);
    if (length === null || length < 2) return null;

    if (marker >= 0xc0 && marker <= 0xcf && !NOT_A_FRAME.has(marker)) {
      const height = uint16(bytes, offset + 5);
      const width = uint16(bytes, offset + 7);
      return width === null || height === null ? null : { width, height };
    }

    if (marker === 0xda) return null;

    offset += 2 + length;
  }

  return null;
}

export function imageDimensions(bytes: Uint8Array): ImageSize | null {
  if (startsWith(bytes, PNG)) return pngSize(bytes);
  if (startsWith(bytes, JPEG)) return jpegSize(bytes);
  if (startsWith(bytes, GIF)) return gifSize(bytes);
  return null;
}

// A header too damaged to declare a size is let through: resvg reads the same field to size its
// buffer, so an image this cannot measure is one it cannot decode into a bomb either.
export function oversizedImage(bytes: Uint8Array, maxSide = IMAGE_MAX_SIDE): ImageSize | null {
  const size = imageDimensions(bytes);
  return size !== null && (size.width > maxSide || size.height > maxSide) ? size : null;
}

export function discordAvatarUrl(userId: string, avatarHash: string, size = 256): string {
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=${size}`;
}

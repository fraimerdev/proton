import { type AssetKind, kilobytes, maxBytesFor } from './kinds.ts';

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const GIF = [0x47, 0x49, 0x46, 0x38];
const IHDR = [0x49, 0x48, 0x44, 0x52];

export const IMAGE_MAX_SIDE = 4_096;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

function matches(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[offset + index] === byte);
}

export function imageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, GIF)) return 'image/gif';
  return null;
}

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
  if (!matches(bytes, 12, IHDR)) return null;

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

// Header fields only, never a decode: the point is to refuse a decompression bomb without
// allocating the bitmap it declares.
export function imageDimensions(bytes: Uint8Array): ImageSize | null {
  if (startsWith(bytes, PNG)) return pngSize(bytes);
  if (startsWith(bytes, JPEG)) return jpegSize(bytes);
  if (startsWith(bytes, GIF)) return gifSize(bytes);
  return null;
}

export interface AcceptedImage {
  contentType: string;
  base64: string;
  hash: string;
  byteSize: number;
}

export type ImageCheck = { accepted: AcceptedImage } | { refused: string };

// Sniffed, never taken from the upload's declared type or its file extension: Image Data carries
// the type inside the URI, so a PNG named .jpg reaches Discord as a 400 that names no field.
export function acceptImage(bytes: Uint8Array, kind: AssetKind): ImageCheck {
  if (bytes.byteLength === 0) return { refused: 'that file is empty.' };

  const article = kind === 'avatar' ? 'an avatar' : 'a banner';
  const cap = maxBytesFor(kind);
  if (bytes.byteLength > cap) {
    return {
      refused: `that image is ${kilobytes(bytes.byteLength)}, and ${article} can be at most ${kilobytes(cap)}.`,
    };
  }

  const contentType = imageMime(bytes);
  if (!contentType) {
    return { refused: 'that file isn’t a PNG, JPEG or GIF, the only formats Discord accepts.' };
  }

  // A header too damaged to read is left to Discord to refuse: branding relays these bytes and
  // never decodes them, so only a size it does declare is worth checking here.
  const size = imageDimensions(bytes);
  if (size && (size.width > IMAGE_MAX_SIDE || size.height > IMAGE_MAX_SIDE)) {
    return {
      refused:
        `that image is ${size.width}×${size.height} pixels, and ${article} can be at most ` +
        `${IMAGE_MAX_SIDE}×${IMAGE_MAX_SIDE}.`,
    };
  }

  return {
    accepted: {
      contentType,
      base64: Buffer.from(bytes).toString('base64'),
      hash: Bun.hash(bytes).toString(36),
      byteSize: bytes.byteLength,
    },
  };
}

export function dataUri(contentType: string, base64: string): string {
  return `data:${contentType};base64,${base64}`;
}

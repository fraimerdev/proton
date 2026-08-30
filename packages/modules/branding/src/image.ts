import { type AssetKind, kilobytes, maxBytesFor } from './kinds.ts';

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const GIF = [0x47, 0x49, 0x46, 0x38];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

export function imageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, GIF)) return 'image/gif';
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

  const cap = maxBytesFor(kind);
  if (bytes.byteLength > cap) {
    return {
      refused: `that image is ${kilobytes(bytes.byteLength)}, and a ${kind} may be at most ${kilobytes(cap)}.`,
    };
  }

  const contentType = imageMime(bytes);
  if (!contentType) {
    return { refused: 'that file is not a PNG, JPEG or GIF. Discord accepts no other format.' };
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

export const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngHeader {
  magic: number[];
  ihdr: string;
  width: number;
  height: number;
}

export function readPng(bytes: Uint8Array): PngHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return {
    magic: [...bytes.slice(0, 8)],
    ihdr: String.fromCharCode(...bytes.slice(12, 16)),
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
}

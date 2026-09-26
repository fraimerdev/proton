export const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngHeader {
  magic: number[];
  ihdr: string;
  width: number;
  height: number;
}

export function sizedPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([...PNG_MAGIC, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

  const header = new DataView(bytes.buffer);
  header.setUint32(16, width);
  header.setUint32(20, height);

  return bytes;
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

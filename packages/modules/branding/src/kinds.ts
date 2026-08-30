export const ASSET_KINDS = ['avatar', 'banner'] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

export const AVATAR_MAX_BYTES = 1_024 * 1_024;
export const BANNER_MAX_BYTES = 2 * 1_024 * 1_024;

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif'] as const;

export function maxBytesFor(kind: AssetKind): number {
  return kind === 'avatar' ? AVATAR_MAX_BYTES : BANNER_MAX_BYTES;
}

export function kilobytes(bytes: number): string {
  return bytes >= 1_024 * 1_024
    ? `${(bytes / (1_024 * 1_024)).toFixed(bytes % (1_024 * 1_024) === 0 ? 0 : 1)} MB`
    : `${Math.round(bytes / 1_024)} KB`;
}

import type { BrandingConfig } from './config.ts';
import { dataUri } from './image.ts';
import type { AssetKind } from './kinds.ts';
import type { BrandingAssetStore } from './store.ts';

export interface DesiredProfile {
  nickname: string | null;
  avatarHash: string | null;
  bannerHash: string | null;
  bio: string | null;
}

// Config is the whole desired face, so a field the admin cleared reads as null and is pushed as a
// clear. Undefined would leave whatever a human set by hand, and the dashboard's Clear would do
// nothing.
export function desiredProfile(config: BrandingConfig): DesiredProfile {
  return {
    nickname: config.nickname ?? null,
    avatarHash: config.avatarHash ?? null,
    bannerHash: config.bannerHash ?? null,
    bio: config.bio ?? null,
  };
}

export const CLEARED: DesiredProfile = {
  nickname: null,
  avatarHash: null,
  bannerHash: null,
  bio: null,
};

export function fingerprint(desired: DesiredProfile): string {
  return Bun.hash(JSON.stringify(desired)).toString(36);
}

export interface ObservedProfile {
  nickname: string | null;
  hasAvatar: boolean;
  hasBanner: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// GUILD_CREATE carries the bot's own member, which is the only place Proton learns what it already
// looks like in a guild. Reading it here is what makes a kick and re-invite self-heal: the member
// comes back blank, so the next reconcile no longer matches and pushes again.
export function observedProfile(payload: unknown, botUserId: string): ObservedProfile | null {
  const guild = record(payload);
  const members = Array.isArray(guild?.members) ? guild.members : [];

  for (const raw of members) {
    const member = record(raw);
    if (str(record(member?.user)?.id) !== botUserId) continue;

    return {
      nickname: str(member?.nick),
      hasAvatar: str(member?.avatar) !== null,
      hasBanner: str(member?.banner) !== null,
    };
  }

  return null;
}

export interface Divergence {
  nickname: boolean;
  profile: boolean;
}

// Images compare on presence, not on identity: what Discord returns is a hash of its own re-encode
// and there is no way back from it to the bytes Proton uploaded. Absence is the case that matters —
// it is what a re-invite, or an admin clearing the avatar by hand, actually looks like.
export function diverges(desired: DesiredProfile, observed: ObservedProfile): Divergence {
  return {
    nickname: desired.nickname !== observed.nickname,
    profile:
      (desired.avatarHash !== null) !== observed.hasAvatar ||
      (desired.bannerHash !== null) !== observed.hasBanner,
  };
}

export interface ImageResult {
  dataUri?: string;
  failure?: string;
}

export async function readImage(
  guildId: string,
  kind: AssetKind,
  assets: BrandingAssetStore,
): Promise<ImageResult> {
  const asset = await assets.get(guildId, kind);
  if (!asset) {
    return {
      failure: `this server's ${kind} is set in its settings but its image is not in Proton's store, so there is nothing to send. Upload it again.`,
    };
  }

  return { dataUri: dataUri(asset.contentType, asset.base64) };
}

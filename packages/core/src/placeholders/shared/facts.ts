export interface UserFacts {
  id: string;
  username: string | null;
  globalName: string | null;
  avatarHash: string | null;
  bot?: boolean | undefined;
}

export interface MemberFacts {
  nick: string | null | undefined;
  joinedAt?: string | null | undefined;
  premiumSince?: string | null | undefined;
  pending?: boolean | undefined;
  timeoutUntil?: string | null | undefined;
  roleIds?: readonly string[] | null | undefined;
}

export interface ServerFacts {
  id: string;
  name?: string | undefined;
  memberCount?: number | undefined;
  ownerId?: string | undefined;
  roleCount?: number | undefined;
  channelCount?: number | undefined;
  iconHash?: string | null | undefined;
  bannerHash?: string | null | undefined;
  description?: string | null | undefined;
  boostCount?: number | null | undefined;
  boostTier?: number | undefined;
}

export interface BotFacts {
  id: string;
  name?: string | null | undefined;
  avatarHash?: string | null | undefined;
  websiteUrl?: string | undefined;
  supportUrl: string;
}

export interface ChannelFacts {
  id: string;
  name?: string | undefined;
  type?: number | undefined;
  parentId?: string | null | undefined;
}

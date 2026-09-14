export const CHANNEL_NAME_MAX = 100;

export const NAME_PLACEHOLDERS = ['{user}', '{displayName}', '{username}', '{userId}'] as const;

export type NamePlaceholder = (typeof NAME_PLACEHOLDERS)[number];

import type { AutomodConfig } from '@proton/module-automod/config';

export function setField<K extends keyof AutomodConfig>(
  config: AutomodConfig,
  key: K,
  value: AutomodConfig[K],
): AutomodConfig {
  const next = { ...config };
  next[key] = value;
  return next;
}

// Cleared by deleting the key, not by writing '': the schema is `snowflakeSchema.optional()`, and
// an empty string fails its pattern and gets the whole save refused.
export function withAlertChannel(config: AutomodConfig, channelId: string | null): AutomodConfig {
  const next = { ...config };

  if (channelId === null) delete next.alertChannelId;
  else next.alertChannelId = channelId;

  return next;
}

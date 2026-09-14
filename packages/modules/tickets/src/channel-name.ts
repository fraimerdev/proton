export const CHANNEL_NAME_MAX = 100;

export function sanitiseChannelName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, CHANNEL_NAME_MAX);

  // Discord refuses an empty name, and a pattern of nothing but punctuation sanitises to one.
  return cleaned === '' ? 'ticket' : cleaned;
}

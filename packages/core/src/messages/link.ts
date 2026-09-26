export interface ParsedMessageLink {
  guildId: string;
  channelId: string;
  messageId: string;
}

const MESSAGE_LINK =
  /^<?(?:https?:\/\/)?(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})\/?(?:[?#]\S*)?>?$/;

export function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function parseMessageLink(text: string): ParsedMessageLink | null {
  const match = MESSAGE_LINK.exec(text.trim().toLowerCase());
  if (match === null) return null;

  const [, guildId, channelId, messageId] = match;
  if (guildId === undefined || channelId === undefined || messageId === undefined) return null;

  return { guildId, channelId, messageId };
}

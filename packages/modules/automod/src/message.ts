export interface MessageAttachment {
  filename: string;
  contentType: string | null;
}

export interface MessageFacts {
  messageId: string;
  channelId: string;
  authorId: string;
  isBot: boolean;
  type: number;
  content: string;
  // NFKC-folded and stripped of format characters, for matching only. Never stored or shown: the
  // fold is lossy, and a member's message must be quoted back as they wrote it.
  normalised: string;
  mentionUserIds: string[];
  mentionRoleIds: string[];
  mentionsEveryone: boolean;
  attachments: MessageAttachment[];
  roleIds: string[] | null;
}

// 0 is an ordinary message, 19 a reply. Everything else in the enum is a system notice — a join
// announcement, a boost, a pin — that no member wrote and none should be punished for.
const HUMAN_MESSAGE_TYPES = new Set([0, 19]);

export function isHumanMessage(type: number): boolean {
  return HUMAN_MESSAGE_TYPES.has(type);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry : str(nested(entry, 'id'))))
    .filter((id): id is string => id !== null);
}

const CONFUSABLES: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  ѕ: 's',
  і: 'i',
  һ: 'h',
  '․': '.',
  '。': '.',
};

export function normaliseForMatching(content: string): string {
  const folded = content
    .normalize('NFKC')
    // Zero-width joiners, RTL overrides and friends: invisible to a reader, but they break every
    // substring match, which is exactly why evasion uses them.
    .replace(/\p{Cf}/gu, '')
    .replace(/[аеорсхѕіһ․。]/gu, (c) => CONFUSABLES[c] ?? c);

  return folded.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function stripCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

export function readMessage(payload: unknown): MessageFacts | null {
  const messageId = str(nested(payload, 'id'));
  const channelId = str(nested(payload, 'channel_id'));
  const author = nested(payload, 'author');
  const authorId = str(nested(author, 'id'));

  if (!messageId || !channelId || !authorId) return null;

  const content = str(nested(payload, 'content')) ?? '';
  const rawAttachments = nested(payload, 'attachments');

  return {
    messageId,
    channelId,
    authorId,
    isBot: nested(author, 'bot') === true,
    type: typeof nested(payload, 'type') === 'number' ? (nested(payload, 'type') as number) : 0,
    content,
    normalised: normaliseForMatching(content),
    mentionUserIds: ids(nested(payload, 'mentions')),
    mentionRoleIds: ids(nested(payload, 'mention_roles')),
    mentionsEveryone: nested(payload, 'mention_everyone') === true,
    attachments: Array.isArray(rawAttachments)
      ? rawAttachments.flatMap((entry) => {
          const filename = str(nested(entry, 'filename'));
          return filename ? [{ filename, contentType: str(nested(entry, 'content_type')) }] : [];
        })
      : [],
    roleIds: ids(nested(nested(payload, 'member'), 'roles')).length
      ? ids(nested(nested(payload, 'member'), 'roles'))
      : null,
  };
}

export function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

export function hasDoubleExtension(filename: string): boolean {
  return /\.[a-z0-9]{2,4}\.[a-z0-9]{2,4}$/i.test(filename);
}

import {
  computeChannelPermissions,
  type GuildState,
  has,
  messageUrl,
  Permissions,
  parseMessageLink,
  type ResolvedAttachment,
  type ResolvedMessage,
} from '@proton/core';
import { ChannelType } from 'discord-api-types/v10';
import type { MessageRead } from '../deps.ts';
import {
  type AttachmentMeta,
  EMBED_TEXT_STORED_MAX,
  type LinkEvidence,
  type MessageEvidence,
  type MessageSnapshot,
  REPORT_LINKS_MAX,
  STORED_CONTENT_MAX,
} from './types.ts';

const FILENAME_MAX = 256;
const EMBEDS_KEPT = 10;
const STICKERS_KEPT = 3;
const ATTACHMENTS_KEPT = 10;
const LINK_TEXT_KEPT = 200;

export const READ_HISTORY = Permissions.ViewChannel | Permissions.ReadMessageHistory;

export function clipStored(text: string, max: number = STORED_CONTENT_MAX): string {
  if (text.length <= max) return text;

  const points = Array.from(text);
  let clipped = '';
  for (const point of points) {
    if (clipped.length + point.length > max) break;
    clipped += point;
  }
  return clipped;
}

function textOf(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 ? clipStored(value, max) : null;
}

export function attachmentMeta(attachment: ResolvedAttachment): AttachmentMeta {
  return {
    id: attachment.id,
    filename: clipStored(attachment.filename, FILENAME_MAX),
    contentType: attachment.contentType,
    size: attachment.size,
    url: attachment.url,
    expiresAt: attachment.expiresAt,
  };
}

export function snapshotFromResolved(
  message: ResolvedMessage,
  guildId: string,
  capturedFrom: MessageSnapshot['capturedFrom'] = 'interaction',
): MessageSnapshot {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author?.id ?? null,
    authorName: message.author?.username ?? null,
    authorBot: message.author?.bot === true || message.webhookId !== null,
    url: messageUrl(guildId, message.channelId, message.id),
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    content: clipStored(message.content),
    attachments: message.attachments.slice(0, ATTACHMENTS_KEPT).map(attachmentMeta),
    embeds: message.embeds.slice(0, EMBEDS_KEPT).map((embed) => ({
      title: textOf(embed.title, EMBED_TEXT_STORED_MAX),
      description: textOf(embed.description, STORED_CONTENT_MAX),
      url: textOf(embed.url, 512),
    })),
    stickers: message.stickerNames.slice(0, STICKERS_KEPT),
    forwarded: message.forwarded,
    forwardedContent: message.snapshotContent === null ? null : clipStored(message.snapshotContent),
    capturedFrom,
  };
}

export function capturedMessage(
  message: ResolvedMessage,
  guildId: string,
  capturedFrom: MessageSnapshot['capturedFrom'],
): MessageEvidence {
  return { status: 'captured', snapshot: snapshotFromResolved(message, guildId, capturedFrom) };
}

export function unavailableMessage(
  read: MessageRead | null,
  ids: { channelId: string; messageId: string },
): MessageEvidence {
  const reason =
    read === null
      ? 'not_captured'
      : read.ok
        ? 'failed'
        : read.reason === 'not_found'
          ? 'deleted'
          : read.reason;

  return { status: 'unavailable', reason, ids };
}

export function canReadHistory(
  state: GuildState,
  memberId: string,
  roleIds: readonly string[],
  channelId: string,
  options: { bot?: boolean } = {},
): boolean {
  const channel = state.channels.get(channelId);
  if (!channel) return false;

  const permissions = computeChannelPermissions(
    {
      guildOwnerId: state.ownerId,
      everyoneRoleId: state.everyoneRoleId,
      memberId,
      memberRoleIds: roleIds,
      roles: state.roles,
    },
    channel.overwrites,
    state.channels.get(channel.parentId ?? '')?.overwrites ?? [],
  );

  // GuildState can't see private-thread membership, so Manage Threads is the only proof of access.
  const privateThread = channel.type === ChannelType.PrivateThread && options.bot !== true;
  return has(permissions, privateThread ? READ_HISTORY | Permissions.ManageThreads : READ_HISTORY);
}

export interface LinkLines {
  lines: string[];
  problems: string[];
}

export function readLinkLines(raw: string | null | undefined): LinkLines {
  const lines = [
    ...new Set(
      (raw ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ];

  const problems: string[] = [];

  if (lines.length > REPORT_LINKS_MAX) {
    problems.push(`Add at most ${REPORT_LINKS_MAX} message links, one per line.`);
  }

  const invalid = lines.find((line) => parseMessageLink(line) === null);
  if (invalid !== undefined) {
    problems.push(
      `‘${clipStored(invalid, 80).replaceAll('`', "'")}’ isn’t a message link. In Discord, ` +
        'right-click the message and choose Copy Message Link.',
    );
  }

  return { lines: lines.slice(0, REPORT_LINKS_MAX), problems };
}

export interface LinkCaptureInput {
  guildId: string;
  reporterId: string;
  reporterRoleIds: readonly string[];
  lines: readonly string[];
  state: GuildState | null;
  readMessage?:
    | ((guildId: string, channelId: string, messageId: string) => Promise<MessageRead>)
    | undefined;
}

export async function captureLinks(input: LinkCaptureInput): Promise<LinkEvidence[]> {
  const captured: LinkEvidence[] = [];

  for (const line of input.lines.slice(0, REPORT_LINKS_MAX)) {
    const parsed = parseMessageLink(line);
    const url = parsed
      ? messageUrl(parsed.guildId, parsed.channelId, parsed.messageId)
      : clipStored(line, LINK_TEXT_KEPT);

    if (!parsed) {
      captured.push({ url, status: 'invalid' });
      continue;
    }

    if (parsed.guildId !== input.guildId) {
      captured.push({ url, status: 'other_server' });
      continue;
    }

    // Followed only where the reporter can read it, or a link would read a channel through Proton.
    if (
      input.state === null ||
      !canReadHistory(input.state, input.reporterId, input.reporterRoleIds, parsed.channelId)
    ) {
      captured.push({ url, status: 'no_access' });
      continue;
    }

    if (!input.readMessage) {
      captured.push({ url, status: 'failed' });
      continue;
    }

    const read = await input.readMessage(input.guildId, parsed.channelId, parsed.messageId);

    if (read.ok) {
      captured.push({
        url,
        status: 'captured',
        snapshot: snapshotFromResolved(read.message, input.guildId, 'rest'),
      });
    } else {
      captured.push({
        url,
        status:
          read.reason === 'not_found'
            ? 'not_found'
            : read.reason === 'no_access'
              ? 'no_access'
              : 'failed',
      });
    }
  }

  return captured;
}

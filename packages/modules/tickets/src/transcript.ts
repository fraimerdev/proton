import type { TicketPriority } from '@proton/core';
import { z } from 'zod';
import { PRIORITY_COLOUR, PRIORITY_LABELS } from './config.ts';
import type {
  Ticket,
  TicketAttachment,
  TicketEvent,
  TicketFormAnswer,
  TicketMessage,
  TicketParticipant,
  TicketRating,
} from './store.ts';

export interface TranscriptInput {
  ticket: Ticket;
  typeName: string;
  guildName: string;
  messages: readonly TicketMessage[];
  participants: readonly TicketParticipant[];
  answers: readonly TicketFormAnswer[];
  events: readonly TicketEvent[];
  rating: TicketRating | null;
  displayNames: ReadonlyMap<string, string>;
}

export function escapeHtml(value: string): string {
  // Ampersand first, or every entity written below is escaped a second time into visible text.
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

const IMAGE_HOSTS: readonly string[] = ['cdn.discordapp.com', 'media.discordapp.net'];

function safeUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  // The protocol is read off the parsed URL: a prefix test on the raw string is fooled by leading
  // whitespace, by 'java\tscript:' and by uppercase, all of which browsers still run.
  return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed : null;
}

function anchor(raw: string, label: string): string {
  const url = safeUrl(raw);
  if (url === null) return escapeHtml(label);

  const shown = safeUrl(label);

  // An embed picks its link text and its href separately, so the text can name a host the link
  // does not go to. Naming the real origin costs a few characters and is the whole defence.
  const target =
    shown !== null && shown.origin !== url.origin
      ? ` <span class="quiet">→ ${escapeHtml(url.origin)}</span>`
      : '';

  return (
    `<a class="link" href="${escapeHtml(url.href)}" rel="noreferrer">${escapeHtml(label)}</a>` +
    target
  );
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function isDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

function iso(at: Date): string {
  // A row whose timestamp is out of range would throw here and cost the whole transcript, which is
  // the one copy of the conversation that outlives the channel.
  return isDate(at) ? at.toISOString() : 'unknown';
}

function human(at: Date): string {
  if (!isDate(at)) return 'unknown';

  const date = `${pad(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? '???'} ${at.getUTCFullYear()}`;

  return `${date}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

function stamp(at: Date): string {
  return `<time datetime="${escapeHtml(iso(at))}">${escapeHtml(human(at))}</time>`;
}

function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const parts: string[] = [];

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (rest > 0 || parts.length === 0) parts.push(`${rest}s`);

  return parts.slice(0, 2).join(' ');
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return 'size unknown';
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function priorityKey(priority: TicketPriority): TicketPriority {
  // hasOwn, not `in`: the column is text and the row is cast, and `'constructor' in PRIORITY_LABELS`
  // is true, so `in` would let a stored 'constructor' through and print a native function.
  return Object.hasOwn(PRIORITY_LABELS, priority) ? priority : 'medium';
}

function accent(priority: TicketPriority): string {
  // Masked and padded, so the only thing that can reach the style attribute is six hex digits.
  return `#${(PRIORITY_COLOUR[priority] & 0xffffff).toString(16).padStart(6, '0')}`;
}

const MENTION = /<(@[!&]?|#)(\d{17,20})>/g;

const NAME_LIMIT = 80;

const DETAIL_LIMIT = 200;

function nameOf(id: string | null, names: ReadonlyMap<string, string>): string {
  if (id === null || id === '') return 'nobody';
  return oneLine(names.get(id) ?? id, NAME_LIMIT);
}

function authorOf(message: TicketMessage, names: ReadonlyMap<string, string>): string {
  return message.authorName === ''
    ? nameOf(message.authorId, names)
    : oneLine(message.authorName, NAME_LIMIT);
}

function mentionText(sigil: string, id: string, names: ReadonlyMap<string, string>): string | null {
  const name = names.get(id);
  if (name === undefined) return null;

  return `${sigil === '#' ? '#' : '@'}${name}`;
}

function renderContent(content: string, names: ReadonlyMap<string, string>): string {
  let out = '';
  let cursor = 0;

  for (const match of content.matchAll(MENTION)) {
    const raw = match[0] ?? '';
    const index = match.index ?? 0;
    const token = mentionText(match[1] ?? '', match[2] ?? '', names);

    out += escapeHtml(content.slice(cursor, index));
    out += token === null ? escapeHtml(raw) : `<span class="mention">${escapeHtml(token)}</span>`;
    cursor = index + raw.length;
  }

  return out + escapeHtml(content.slice(cursor));
}

function plainContent(content: string, names: ReadonlyMap<string, string>): string {
  return content.replace(MENTION, (raw: string, sigil: string, id: string) => {
    return mentionText(sigil, id, names) ?? raw;
  });
}

function oneLine(content: string, limit: number): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

// Not only \n: a lone \r starts a line in enough viewers to carry text past the prefix below.
const NEWLINE = /\r\n|[\n\r\u2028\u2029]/;

// Structural lines live at column 0, so member text that skips this prefix forges them: a message
// body of "HISTORY", or of "[2026-01-01T00:00:00.000Z] Head of Support (bot)", is byte-identical.
function block(content: string): string[] {
  return content.split(NEWLINE).map((line) => (line === '' ? '  |' : `  | ${line}`));
}

const embedText = z.string().catch('');

const embedFieldSchema = z
  .object({ name: embedText, value: embedText })
  .catch({ name: '', value: '' });

const embedSchema = z.object({
  title: embedText,
  description: embedText,
  url: embedText,
  author: z.object({ name: embedText }).catch({ name: '' }),
  footer: z.object({ text: embedText }).catch({ text: '' }),
  fields: z.array(embedFieldSchema).max(25).catch([]),
});

type TranscriptEmbed = z.infer<typeof embedSchema>;

function readEmbed(raw: Record<string, unknown>): TranscriptEmbed | null {
  const parsed = embedSchema.safeParse(raw);
  if (!parsed.success) return null;

  const embed = parsed.data;
  const empty =
    embed.title === '' &&
    embed.description === '' &&
    embed.author.name === '' &&
    embed.footer.text === '' &&
    embed.fields.length === 0;

  return empty ? null : embed;
}

function renderEmbed(embed: TranscriptEmbed, names: ReadonlyMap<string, string>): string {
  const parts: string[] = [];

  if (embed.author.name !== '') {
    parts.push(`<p class="embed-author">${escapeHtml(embed.author.name)}</p>`);
  }

  if (embed.title !== '') {
    const title = embed.url === '' ? escapeHtml(embed.title) : anchor(embed.url, embed.title);
    parts.push(`<p class="embed-title">${title}</p>`);
  }

  if (embed.description !== '') {
    parts.push(`<div class="body">${renderContent(embed.description, names)}</div>`);
  }

  for (const field of embed.fields) {
    if (field.name === '' && field.value === '') continue;
    parts.push(
      `<div class="embed-field"><p class="embed-field-name">${escapeHtml(field.name)}</p>` +
        `<div class="body">${renderContent(field.value, names)}</div></div>`,
    );
  }

  if (embed.footer.text !== '') {
    parts.push(`<p class="embed-footer">${escapeHtml(embed.footer.text)}</p>`);
  }

  return `<div class="embed">${parts.join('')}</div>`;
}

const fileText = (limit: number) => z.string().transform((value) => oneLine(value, limit));

// The column is jsonb and the row is cast, so a number where a filename belongs would throw out of
// escapeHtml and cost the whole transcript. Mirrors embedSchema above.
const attachmentSchema = z
  .object({
    url: fileText(2000).catch(''),
    filename: fileText(256).catch(''),
    contentType: fileText(128).nullable().catch(null),
    size: z.number().catch(Number.NaN),
  })
  .catch({ url: '', filename: '', contentType: null, size: Number.NaN });

type TranscriptAttachment = z.infer<typeof attachmentSchema>;

function readAttachment(raw: TicketAttachment): TranscriptAttachment {
  return attachmentSchema.parse(raw);
}

function fileName(file: TranscriptAttachment): string {
  return file.filename === '' ? 'attachment' : file.filename;
}

function isImage(file: TranscriptAttachment, url: URL): boolean {
  // Fetched the moment the transcript is opened, so an <img> anywhere but Discord's CDN reports
  // every reader of the archive to whoever put the attachment in the ticket.
  return (file.contentType?.startsWith('image/') ?? false) && IMAGE_HOSTS.includes(url.hostname);
}

function renderAttachment(file: TranscriptAttachment): string {
  const meta = `${escapeHtml(formatBytes(file.size))}${
    file.contentType === null ? '' : ` · ${escapeHtml(file.contentType)}`
  }`;

  const link = anchor(file.url, fileName(file));
  const url = safeUrl(file.url);

  if (url !== null && isImage(file, url)) {
    return (
      `<figure class="file"><img src="${escapeHtml(url.href)}" alt="${escapeHtml(fileName(file))}" ` +
      `loading="lazy"><figcaption>${link} <span class="quiet">· ${meta}</span></figcaption></figure>`
    );
  }

  return `<p class="file">${link} <span class="quiet">· ${meta}</span></p>`;
}

function row(label: string, markup: string): string {
  return `<div class="pair"><dt>${escapeHtml(label)}</dt><dd>${markup}</dd></div>`;
}

function textRow(label: string, value: string): string {
  return row(label, escapeHtml(value));
}

function stampRow(label: string, at: Date | null, absent: string): string {
  return row(label, at === null ? escapeHtml(absent) : stamp(at));
}

function contentRow(label: string, value: string, names: ReadonlyMap<string, string>): string {
  return row(label, renderContent(value, names));
}

function section(title: string, body: string): string {
  return body === '' ? '' : `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

const STYLES = `
:root {
  color-scheme: light dark;
  --ground: #f4f5f8;
  --surface: #ffffff;
  --raised: #eceef4;
  --hairline: #dcdfe8;
  --ink: #14161c;
  --muted: #454b5b;
  --quiet: #6d7486;
  --link: #2a55c8;
  --alarm: #b23a48;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0f1116;
    --surface: #161920;
    --raised: #1d212b;
    --hairline: #242833;
    --ink: #e9ebf1;
    --muted: #aab1c0;
    --quiet: #868e9f;
    --link: #6ba1ff;
    --alarm: #ff7a86;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px 16px 64px;
  background: var(--ground);
  color: var(--ink);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, sans-serif;
}
.sheet { max-width: 880px; margin: 0 auto; }
.head {
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-top: 3px solid var(--hairline);
  border-radius: 12px;
  padding: 20px 22px;
}
.eyebrow { margin: 0 0 4px; color: var(--quiet); font-size: 13px; }
h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; }
.subject { margin: 6px 0 0; color: var(--muted); font-size: 17px; }
h2 {
  margin: 32px 0 10px;
  font-size: 12px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--quiet);
}
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 2px 24px; margin: 18px 0 0; }
.pair { display: flex; gap: 10px; padding: 5px 0; border-top: 1px solid var(--hairline); }
dt { flex: 0 0 128px; color: var(--quiet); font-size: 13px; }
dd { margin: 0; color: var(--muted); min-width: 0; overflow-wrap: anywhere; }
.card {
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: 12px;
  padding: 6px 18px 14px;
}
.group { border-top: 1px solid var(--hairline); padding: 14px 0 4px; }
.group:first-child { border-top: 0; }
.who { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.name { font-weight: 600; }
.pill {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  background: var(--raised);
  color: var(--quiet);
  border-radius: 5px;
  padding: 1px 6px;
}
.id, .quiet { color: var(--quiet); font-size: 12px; }
.id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.msg { padding: 4px 0 8px; }
.msg + .msg { border-top: 1px dashed var(--hairline); }
.stamp { color: var(--quiet); font-size: 12px; }
.tag { color: var(--quiet); font-size: 12px; }
.gone .body { color: var(--quiet); text-decoration: line-through; }
.gone .tag { color: var(--alarm); }
.body { white-space: pre-wrap; overflow-wrap: anywhere; margin: 2px 0 0; }
.reply {
  margin: 2px 0 0;
  padding-left: 12px;
  border-left: 2px solid var(--hairline);
  color: var(--quiet);
  font-size: 13px;
}
.mention {
  background: var(--raised);
  border-radius: 4px;
  padding: 0 4px;
  color: var(--link);
  font-weight: 500;
}
.link { color: var(--link); }
.file { margin: 6px 0 0; }
.file img {
  display: block;
  max-width: 100%;
  max-height: 360px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  margin: 0 0 4px;
}
figure { margin: 8px 0 0; }
figcaption { font-size: 13px; }
.embed {
  margin: 8px 0 0;
  padding: 8px 12px;
  background: var(--raised);
  border-left: 3px solid var(--hairline);
  border-radius: 0 8px 8px 0;
}
.embed-author { margin: 0; font-size: 13px; color: var(--quiet); }
.embed-title { margin: 2px 0; font-weight: 600; }
.embed-field { margin: 8px 0 0; }
.embed-field-name { margin: 0; font-size: 13px; font-weight: 600; }
.embed-footer { margin: 8px 0 0; font-size: 12px; color: var(--quiet); }
.log { list-style: none; margin: 0; padding: 0; }
.log li { border-top: 1px solid var(--hairline); padding: 8px 0; }
.log li:first-child { border-top: 0; }
.stars { letter-spacing: 3px; }
footer { margin: 28px 0 0; color: var(--quiet); font-size: 12px; text-align: center; }
`;

const META = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="referrer" content="no-referrer">',
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    `img-src ${IMAGE_HOSTS.map((host) => `https://${host}`).join(' ')}; ` +
    "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">",
].join('');

function ticketLabel(ticket: Ticket): string {
  return `Ticket #${pad(ticket.number, 4)}`;
}

function durationOf(ticket: Ticket): string {
  if (ticket.closedAt === null) return 'still open';
  if (!isDate(ticket.closedAt) || !isDate(ticket.openedAt)) return 'unknown';

  return humanDuration(ticket.closedAt.getTime() - ticket.openedAt.getTime());
}

function headerBlock(input: TranscriptInput): string {
  const { ticket, displayNames: names } = input;
  const priority = priorityKey(ticket.priority);

  const rows = [
    textRow('Type', input.typeName),
    textRow('Server', input.guildName),
    textRow('Status', ticket.status),
    textRow('Priority', PRIORITY_LABELS[priority]),
    textRow('Opened by', nameOf(ticket.openerId, names)),
    textRow('Owner', nameOf(ticket.ownerId, names)),
    textRow(
      'Claimed by',
      ticket.claimedById === null ? 'unclaimed' : nameOf(ticket.claimedById, names),
    ),
    textRow(
      'Assigned to',
      ticket.assignedToId === null ? 'nobody' : nameOf(ticket.assignedToId, names),
    ),
    stampRow('Opened', ticket.openedAt, 'unknown'),
    stampRow('Closed', ticket.closedAt, 'still open'),
    textRow('Duration', durationOf(ticket)),
    textRow('Messages', String(ticket.messageCount)),
  ];

  if (ticket.closedBy !== null) rows.push(textRow('Closed by', nameOf(ticket.closedBy, names)));

  if (ticket.closeReason !== null && ticket.closeReason !== '') {
    rows.push(contentRow('Close reason', ticket.closeReason, names));
  }

  const subject =
    ticket.subject === null || ticket.subject === ''
      ? ''
      : `<p class="subject">${escapeHtml(ticket.subject)}</p>`;

  return (
    `<header class="head" style="border-top-color:${accent(priority)}">` +
    `<p class="eyebrow">${escapeHtml(input.typeName)} · ${escapeHtml(input.guildName)}</p>` +
    `<h1>${escapeHtml(ticketLabel(ticket))}</h1>${subject}` +
    `<dl class="meta">${rows.join('')}</dl></header>`
  );
}

function answersBlock(input: TranscriptInput): string {
  const answers = [...input.answers].sort((a, b) => a.position - b.position);
  if (answers.length === 0) return '';

  const rows = answers.map(
    (answer) =>
      `<div class="group"><p class="name">${escapeHtml(answer.label)}</p>` +
      `<div class="body">${renderContent(answer.value, input.displayNames)}</div></div>`,
  );

  return section('Form answers', `<div class="card">${rows.join('')}</div>`);
}

function participantsBlock(input: TranscriptInput): string {
  if (input.participants.length === 0) return '';

  const rows = input.participants.map((participant) => {
    const added =
      participant.addedById === null
        ? ''
        : ` <span class="quiet">· added by ${escapeHtml(nameOf(participant.addedById, input.displayNames))}</span>`;

    return (
      `<li><span class="name">${escapeHtml(nameOf(participant.userId, input.displayNames))}</span> ` +
      `<span class="pill">${escapeHtml(participant.kind)}</span>${added} ` +
      `<span class="quiet">· ${stamp(participant.addedAt)}</span></li>`
    );
  });

  return section('Participants', `<div class="card"><ul class="log">${rows.join('')}</ul></div>`);
}

function groupMessages(messages: readonly TicketMessage[]): TicketMessage[][] {
  const groups: TicketMessage[][] = [];

  for (const message of messages) {
    const last = groups.at(-1);

    if (last !== undefined && last[0]?.authorId === message.authorId) last.push(message);
    else groups.push([message]);
  }

  return groups;
}

function replyLine(
  message: TicketMessage,
  byId: ReadonlyMap<string, TicketMessage>,
  names: ReadonlyMap<string, string>,
): string {
  if (message.replyToId === null) return '';

  const target = byId.get(message.replyToId);

  if (target === undefined) {
    return `<p class="reply">${escapeHtml('in reply to a message that is not in this log')}</p>`;
  }

  const snippet = oneLine(plainContent(target.content, names), 90);

  return `<p class="reply">${escapeHtml(`in reply to ${authorOf(target, names)}: ${snippet}`)}</p>`;
}

function messageBlock(
  message: TicketMessage,
  byId: ReadonlyMap<string, TicketMessage>,
  names: ReadonlyMap<string, string>,
): string {
  const tags: string[] = [];

  if (message.editedAt !== null) {
    tags.push(`<span class="tag">· edited ${stamp(message.editedAt)}</span>`);
  }

  if (message.deletedAt !== null) {
    tags.push(`<span class="tag">· deleted ${stamp(message.deletedAt)}</span>`);
  }

  const attachments = message.attachments
    .map((file) => renderAttachment(readAttachment(file)))
    .join('');

  const embeds = message.embeds
    .map(readEmbed)
    .filter((embed): embed is TranscriptEmbed => embed !== null)
    .map((embed) => renderEmbed(embed, names))
    .join('');

  return (
    `<div class="msg${message.deletedAt === null ? '' : ' gone'}">` +
    `<p class="stamp">${stamp(message.createdAt)} ${tags.join(' ')}</p>` +
    replyLine(message, byId, names) +
    `<div class="body">${renderContent(message.content, names)}</div>` +
    `${attachments}${embeds}</div>`
  );
}

function messagesBlock(input: TranscriptInput): string {
  if (input.messages.length === 0) {
    return section(
      'Messages',
      `<div class="card"><p class="group quiet">${escapeHtml(
        'No messages were kept for this ticket. Message capture is off unless an admin turns it on.',
      )}</p></div>`,
    );
  }

  const byId = new Map(input.messages.map((message) => [message.messageId, message]));

  const groups = groupMessages(input.messages).map((group) => {
    const first = group[0];
    if (first === undefined) return '';

    const author = authorOf(first, input.displayNames);
    const bot = first.authorBot ? '<span class="pill">bot</span>' : '';

    const bodies = group.map((message) => messageBlock(message, byId, input.displayNames)).join('');

    return (
      `<article class="group"><p class="who"><span class="name">${escapeHtml(author)}</span>` +
      `${bot}<span class="id">${escapeHtml(first.authorId)}</span></p>${bodies}</article>`
    );
  });

  return section('Messages', `<div class="card">${groups.join('')}</div>`);
}

function eventDetails(data: Record<string, unknown> | null): string[] {
  if (data === null) return [];

  const out: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push(oneLine(`${key}: ${String(value)}`, DETAIL_LIMIT));
    }
  }

  return out;
}

function eventsBlock(input: TranscriptInput): string {
  if (input.events.length === 0) return '';

  const rows = input.events.map((event) => {
    const details = eventDetails(event.data);

    const detail =
      details.length === 0
        ? ''
        : `<span class="quiet"> · ${escapeHtml(details.join(' · '))}</span>`;

    return (
      `<li><span class="quiet">${stamp(event.at)}</span> ` +
      `<span class="name">${escapeHtml(event.type.replace(/[._-]+/g, ' '))}</span> ` +
      `<span class="quiet">by ${escapeHtml(nameOf(event.actorId, input.displayNames))}</span>${detail}</li>`
    );
  });

  return section('History', `<div class="card"><ul class="log">${rows.join('')}</ul></div>`);
}

// Clamped rather than trusted: the column is an integer but a transcript is the last copy of a
// ticket, and a bad row must not take the whole document down over a rating.
function scoreFor(rating: number): string {
  return `${Math.max(0, Math.min(5, Math.round(rating)))} out of 5`;
}

function ratingBlock(input: TranscriptInput): string {
  const rating = input.rating;
  if (rating === null) return '';

  const comment =
    rating.comment === null || rating.comment === ''
      ? ''
      : `<div class="body">${renderContent(rating.comment, input.displayNames)}</div>`;

  const body =
    `<div class="group"><p class="who"><span class="stars">${escapeHtml(scoreFor(rating.rating))}</span>` +
    `<span class="quiet">${escapeHtml(`${rating.rating}/5 from ${nameOf(rating.userId, input.displayNames)}`)} ` +
    `· ${stamp(rating.createdAt)}</span></p>${comment}</div>`;

  return section('Rating', `<div class="card">${body}</div>`);
}

export function renderTranscriptHtml(input: TranscriptInput): string {
  const title = `${ticketLabel(input.ticket)} · ${input.typeName} · ${input.guildName}`;

  return (
    '<!doctype html><html lang="en"><head>' +
    `${META}<title>${escapeHtml(title)}</title><style>${STYLES}</style></head><body>` +
    '<main class="sheet">' +
    headerBlock(input) +
    answersBlock(input) +
    participantsBlock(input) +
    messagesBlock(input) +
    eventsBlock(input) +
    ratingBlock(input) +
    `<footer>${escapeHtml(`${ticketLabel(input.ticket)} · transcript generated by Proton`)}</footer>` +
    '</main></body></html>'
  );
}

export function transcriptFilename(ticket: Ticket): string {
  return `ticket-${pad(ticket.number, 4)}.html`;
}

function textAttachment(file: TranscriptAttachment): string {
  const type = file.contentType === null ? '' : `, ${file.contentType}`;
  const url = file.url === '' ? '' : ` ${file.url}`;

  return `  [file] ${fileName(file)} (${formatBytes(file.size)}${type})${url}`;
}

function textEmbed(embed: TranscriptEmbed, names: ReadonlyMap<string, string>): string[] {
  const lines: string[] = [];

  if (embed.author.name !== '') lines.push(...block(`[embed] ${embed.author.name}`));

  if (embed.title !== '') {
    lines.push(...block(`[embed] ${embed.title}${embed.url === '' ? '' : ` ${embed.url}`}`));
  }

  if (embed.description !== '') {
    lines.push(...block(`[embed] ${plainContent(embed.description, names)}`));
  }

  for (const field of embed.fields) {
    if (field.name === '' && field.value === '') continue;
    lines.push(...block(`[embed] ${field.name}: ${plainContent(field.value, names)}`));
  }

  if (embed.footer.text !== '') lines.push(...block(`[embed] ${embed.footer.text}`));

  return lines;
}

export function renderTranscriptText(input: TranscriptInput): string {
  const { ticket, displayNames: names } = input;
  const priority = priorityKey(ticket.priority);

  const lines: string[] = [
    `${ticketLabel(ticket)} — ${oneLine(input.typeName, NAME_LIMIT)}`,
    `Server:      ${oneLine(input.guildName, NAME_LIMIT)}`,
    `Status:      ${ticket.status}`,
    `Priority:    ${PRIORITY_LABELS[priority]}`,
    `Subject:     ${ticket.subject === null ? 'none' : oneLine(ticket.subject, DETAIL_LIMIT)}`,
    `Opened by:   ${nameOf(ticket.openerId, names)}`,
    `Owner:       ${nameOf(ticket.ownerId, names)}`,
    `Claimed by:  ${ticket.claimedById === null ? 'unclaimed' : nameOf(ticket.claimedById, names)}`,
    `Assigned to: ${ticket.assignedToId === null ? 'nobody' : nameOf(ticket.assignedToId, names)}`,
    `Opened:      ${iso(ticket.openedAt)} (${human(ticket.openedAt)})`,
    `Closed:      ${ticket.closedAt === null ? 'still open' : `${iso(ticket.closedAt)} (${human(ticket.closedAt)})`}`,
    `Duration:    ${durationOf(ticket)}`,
    `Messages:    ${ticket.messageCount}`,
  ];

  if (ticket.closedBy !== null) lines.push(`Closed by:   ${nameOf(ticket.closedBy, names)}`);

  if (ticket.closeReason !== null && ticket.closeReason !== '') {
    lines.push('Reason:', ...block(plainContent(ticket.closeReason, names)));
  }

  const answers = [...input.answers].sort((a, b) => a.position - b.position);

  if (answers.length > 0) {
    lines.push('', 'FORM ANSWERS');

    for (const answer of answers) {
      lines.push(
        `- ${oneLine(answer.label, NAME_LIMIT)}`,
        ...block(plainContent(answer.value, names)),
      );
    }
  }

  if (input.participants.length > 0) {
    lines.push('', 'PARTICIPANTS');

    for (const participant of input.participants) {
      const added =
        participant.addedById === null ? '' : `, added by ${nameOf(participant.addedById, names)}`;

      lines.push(
        `- ${nameOf(participant.userId, names)} (${participant.kind}${added}) ${iso(participant.addedAt)}`,
      );
    }
  }

  lines.push('', 'MESSAGES');

  if (input.messages.length === 0) {
    lines.push('No messages were kept for this ticket.', '');
  }

  const byId = new Map(input.messages.map((message) => [message.messageId, message]));

  for (const message of input.messages) {
    const author = authorOf(message, names);

    const marks = [
      message.authorBot ? 'bot' : '',
      message.editedAt === null ? '' : `edited ${iso(message.editedAt)}`,
      message.deletedAt === null ? '' : `deleted ${iso(message.deletedAt)}`,
    ].filter((mark) => mark !== '');

    lines.push(
      `[${iso(message.createdAt)}] ${author}${marks.length === 0 ? '' : ` (${marks.join(', ')})`}`,
    );

    if (message.replyToId !== null) {
      const target = byId.get(message.replyToId);

      lines.push(
        target === undefined
          ? '  [reply] to a message that is not in this log'
          : `  [reply] to ${authorOf(target, names)}: ${oneLine(plainContent(target.content, names), 90)}`,
      );
    }

    if (message.content !== '') lines.push(...block(plainContent(message.content, names)));

    for (const file of message.attachments) lines.push(textAttachment(readAttachment(file)));

    for (const raw of message.embeds) {
      const embed = readEmbed(raw);
      if (embed !== null) lines.push(...textEmbed(embed, names));
    }

    lines.push('');
  }

  if (input.events.length > 0) {
    lines.push('HISTORY');

    for (const event of input.events) {
      const details = eventDetails(event.data);

      lines.push(
        `- ${iso(event.at)} ${event.type.replace(/[._-]+/g, ' ')} by ${nameOf(event.actorId, names)}` +
          `${details.length === 0 ? '' : ` (${details.join(', ')})`}`,
      );
    }

    lines.push('');
  }

  if (input.rating !== null) {
    lines.push('RATING');
    lines.push(
      `${input.rating.rating}/5 from ${nameOf(input.rating.userId, names)} at ${iso(input.rating.createdAt)}`,
    );

    if (input.rating.comment !== null && input.rating.comment !== '') {
      lines.push(...block(plainContent(input.rating.comment, names)));
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

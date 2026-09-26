import {
  deferUpdate,
  encodeCustomId,
  errorStatus,
  type GuildState,
  hasWithAdmin,
  type InteractionMessage,
  interactionRef,
  MAX_MODAL_TITLE_LENGTH,
  type Modal,
  type ModuleContext,
  messageUrl,
  openModal,
  Permissions,
  type ProtonCustomId,
  type ProtonEvent,
  parseCustomId,
  type RespondTo,
  readComponentInteraction,
  readMemberPermissions,
  readModalInteraction,
  successStatus,
} from '@proton/core';
import { ComponentType, TextInputStyle } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { deferTo, replyTo, respondTo, send, statusMessage } from '../interactions/respond.ts';
import { MODULE_ID } from '../perform.ts';
import { openPunishFlow } from '../punish/flow.ts';
import { type Channel, followChannel } from '../punish/pending.ts';
import { mayReview, type ReviewAction, type ReviewActor } from './authorize.ts';
import {
  clipText,
  escapeMarkdown,
  fenced,
  purgedText,
  REPORT_CARD_ACTIONS,
  relative,
  STATS_WINDOW_DAYS,
  snowflakeCreatedAt,
  statusLine,
} from './card.ts';
import { readState, refreshCard } from './delivery.ts';
import { canReadHistory } from './evidence.ts';
import {
  handleFinish,
  handleIntakeSubmit,
  handleRetry,
  REPORT_FINISH_ACTION,
  REPORT_RETRY_ACTION,
  REPORT_SUBMIT_ACTION,
  REPORT_SUBMIT_DIRECT_ACTION,
} from './intake.ts';
import {
  alreadyResolved,
  claimReport,
  dismissReport,
  notFound,
  proofOf,
  REVIEW_MODERATION_OFF,
  REVIEW_STORE_UNBOUND,
  unclaimReport,
} from './review.ts';
import {
  type AttachmentMeta,
  isActiveStatus,
  type LinkEvidence,
  type MessageSnapshot,
  type ReportRecord,
} from './types.ts';

export type ReportInteractionHandler = (
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
) => Promise<void>;

export const REPORT_INTAKE_ACTIONS: Readonly<Record<string, ReportInteractionHandler>> = {
  [REPORT_SUBMIT_ACTION]: handleIntakeSubmit,
  [REPORT_SUBMIT_DIRECT_ACTION]: handleIntakeSubmit,
  [REPORT_FINISH_ACTION]: handleFinish,
  [REPORT_RETRY_ACTION]: handleRetry,
};

const DIRECT_ACTIONS: ReadonlySet<string> = new Set([
  REPORT_FINISH_ACTION,
  REPORT_SUBMIT_DIRECT_ACTION,
]);

export function reportDirectInteractionGuild(customId: ProtonCustomId): string | null {
  if (!DIRECT_ACTIONS.has(customId.action)) return null;

  const guildId = customId.args[0];
  return guildId && /^\d{17,20}$/.test(guildId) ? guildId : null;
}

type Ctx = ModuleContext<ModerationConfig>;
type RawEmbed = Record<string, unknown> & {
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
};

export const REPORT_DISMISS_MODAL_ACTION = 'rdis';

export const DISMISS_FIELDS = { note: 'note', reporter: 'reporter' } as const;

export const STALE_REPORT_BUTTON =
  'I can’t find the report this button belongs to any more, so nothing was done.';

const REPORT_ID = /^[A-Za-z0-9]{1,16}$/;
const NOTE_MAX = 1000;
const LABEL_MAX = 45;
const EVIDENCE_TOTAL_MAX = 5800;
const MESSAGE_SHOWN_MAX = 3500;
const LINK_EXCERPT = 250;
const FIELD_MAX = 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

function reportIdOf(raw: string | undefined): string | null {
  return raw && REPORT_ID.test(raw) ? raw : null;
}

function reviewerOf(
  event: ProtonEvent,
  facts: { userId: string; roleIds: string[] | null },
  state: GuildState | null,
): ReviewActor {
  return {
    id: facts.userId,
    roleIds: facts.roleIds,
    permissions: readMemberPermissions(event),
    source: 'discord',
    ...(state?.ownerId === facts.userId ? { owner: true } : {}),
  };
}

function errorMessage(text: string): InteractionMessage {
  return statusMessage(errorStatus(text));
}

async function replyError(ctx: Ctx, to: RespondTo, text: string): Promise<void> {
  await send(ctx, replyTo(to, errorMessage(text)));
}

async function refreshStale(ctx: Ctx, deps: ModerationDeps, reportId: string): Promise<void> {
  try {
    const report = await deps.reports?.get(ctx.guildId, reportId);
    if (report) await refreshCard(ctx, deps, report, deps.now?.() ?? Date.now());
  } catch {
    return;
  }
}

async function handleClaimPress(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
  claiming: boolean,
): Promise<void> {
  const press = readComponentInteraction(event);
  const parsed = parseCustomId(press?.customId);
  if (!press || parsed?.moduleId !== MODULE_ID) return;

  const to = respondTo(ctx.guildId, press.userId, interactionRef(press));
  if (!ctx.config.enabled) return replyError(ctx, to, REVIEW_MODERATION_OFF);

  await send(ctx, deferUpdate(to));
  const channel = followChannel(ctx, to, press.applicationId ?? deps.applicationId);

  const reportId = reportIdOf(parsed.args[0]);
  if (!reportId) return channel.say(errorMessage(STALE_REPORT_BUTTON), 'result', true);

  const actor = reviewerOf(event, press, null);
  const result = claiming
    ? await claimReport(ctx, deps, reportId, actor)
    : await unclaimReport(ctx, deps, reportId, actor);
  if (result.ok) return;

  await refreshStale(ctx, deps, reportId);
  await channel.say(errorMessage(result.message), 'result', true);
}

interface Loaded {
  report: ReportRecord;
  actor: ReviewActor;
  state: GuildState | null;
}

async function loadForReview(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
  facts: { userId: string; roleIds: string[] | null },
  rawId: string | undefined,
  action: ReviewAction,
  refuse: (text: string) => Promise<void>,
): Promise<Loaded | null> {
  const reportId = reportIdOf(rawId);
  if (!reportId) {
    await refuse(STALE_REPORT_BUTTON);
    return null;
  }

  const store = deps.reports;
  if (!store) {
    await refuse(REVIEW_STORE_UNBOUND);
    return null;
  }

  const report = await store.get(ctx.guildId, reportId);
  if (!report) {
    await refuse(notFound(reportId).message);
    return null;
  }

  const state = await readState(deps, ctx.guildId);
  const actor = reviewerOf(event, facts, state);
  const allowed = mayReview(ctx.config, actor, report, action);
  if (!allowed.ok) {
    await refuse(allowed.message);
    return null;
  }

  return { report, actor, state };
}

async function handleAcceptPress(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<void> {
  const press = readComponentInteraction(event);
  const parsed = parseCustomId(press?.customId);
  if (!press || parsed?.moduleId !== MODULE_ID) return;

  const to = respondTo(ctx.guildId, press.userId, interactionRef(press));
  if (!ctx.config.enabled) return replyError(ctx, to, REVIEW_MODERATION_OFF);

  await send(ctx, deferTo(to, true));
  const channel = followChannel(ctx, to, press.applicationId ?? deps.applicationId);
  const refuse = (text: string) => channel.say(errorMessage(text), 'result', true);

  const loaded = await loadForReview(event, ctx, deps, press, parsed.args[0], 'accept', refuse);
  if (!loaded) return;
  const { report } = loaded;

  if (!isActiveStatus(report.status)) {
    await refreshStale(ctx, deps, report.id);
    return refuse(alreadyResolved(report).message);
  }

  const proof = proofOf(report);
  await openPunishFlow(event, ctx, deps, {
    targetId: report.targetId,
    ...(proof ? { proof } : {}),
    origin: { type: 'report', reportId: report.id },
    ...(report.reason ? { prefillReason: report.reason } : {}),
    reporterNoteField: ctx.config.reports.notifications.accepted.enabled,
  });
}

function labelled(
  label: string,
  description: string,
  component: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: ComponentType.Label,
    label: label.slice(0, LABEL_MAX),
    description: description.slice(0, 100),
    component,
  };
}

function noteInput(customId: string): Record<string, unknown> {
  return {
    type: ComponentType.TextInput,
    custom_id: customId,
    style: TextInputStyle.Paragraph,
    required: false,
    max_length: NOTE_MAX,
  };
}

export function dismissModal(config: ModerationConfig, reportId: string): Modal | null {
  const customId = encodeCustomId(MODULE_ID, REPORT_DISMISS_MODAL_ACTION, reportId);
  if (!customId.ok) return null;

  return {
    customId: customId.customId,
    title: clipText(`Dismiss report ${reportId}`, MAX_MODAL_TITLE_LENGTH).text,
    components: [
      labelled(
        'Internal note',
        'Staff only. Never shown to the reporter.',
        noteInput(DISMISS_FIELDS.note),
      ),
      ...(config.reports.notifications.dismissed.enabled
        ? [
            labelled(
              'Reporter note',
              'Sent to the member who filed the report, with the outcome.',
              noteInput(DISMISS_FIELDS.reporter),
            ),
          ]
        : []),
    ],
  };
}

async function handleDismissPress(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<void> {
  const press = readComponentInteraction(event);
  const parsed = parseCustomId(press?.customId);
  if (!press || parsed?.moduleId !== MODULE_ID) return;

  const to = respondTo(ctx.guildId, press.userId, interactionRef(press));
  const refuse = (text: string) => replyError(ctx, to, text);
  if (!ctx.config.enabled) return refuse(REVIEW_MODERATION_OFF);

  const reportId = reportIdOf(parsed.args[0]);
  if (!reportId) return refuse(STALE_REPORT_BUTTON);

  const store = deps.reports;
  if (!store) return refuse(REVIEW_STORE_UNBOUND);

  const report = await store.get(ctx.guildId, reportId);
  if (!report) return refuse(notFound(reportId).message);

  // The modal must open within 3 seconds, so the owner lookup runs only when the reporter presses.
  const state = press.userId === report.reporterId ? await readState(deps, ctx.guildId) : null;
  const allowed = mayReview(ctx.config, reviewerOf(event, press, state), report, 'dismiss');
  if (!allowed.ok) return refuse(allowed.message);
  if (!isActiveStatus(report.status)) return refuse(alreadyResolved(report).message);

  const modal = dismissModal(ctx.config, report.id);
  if (!modal) return refuse('I couldn’t build the dismiss form, so nothing was done.');

  await send(ctx, openModal(to, modal));
}

async function handleDismissSubmit(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<void> {
  const modal = readModalInteraction(event);
  const parsed = parseCustomId(modal?.customId);
  if (!modal || parsed?.moduleId !== MODULE_ID) return;

  const to = respondTo(ctx.guildId, modal.userId, interactionRef(modal));
  if (!ctx.config.enabled) return replyError(ctx, to, REVIEW_MODERATION_OFF);

  await send(ctx, deferTo(to, true));
  const channel = followChannel(ctx, to, modal.applicationId ?? deps.applicationId);

  const reportId = reportIdOf(parsed.args[0]);
  if (!reportId) return channel.say(errorMessage(STALE_REPORT_BUTTON), 'result', true);

  const told = ctx.config.reports.notifications.dismissed.enabled;
  const result = await dismissReport(ctx, deps, reportId, reviewerOf(event, modal, null), {
    note: modal.fields[DISMISS_FIELDS.note] ?? null,
    reporterNote: told ? (modal.fields[DISMISS_FIELDS.reporter] ?? null) : null,
    token: event.id,
  });

  if (!result.ok) await refreshStale(ctx, deps, reportId);

  await channel.say(
    statusMessage(result.ok ? successStatus(result.message) : errorStatus(result.message)),
    'result',
    true,
  );
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

const CASE_NOUNS: ReadonlyArray<[string, string]> = [
  ['warn', 'warning'],
  ['timeout', 'timeout'],
  ['kick', 'kick'],
  ['ban', 'ban'],
];

async function memberEmbed(
  ctx: Ctx,
  deps: ModerationDeps,
  report: ReportRecord,
  now: number,
): Promise<RawEmbed> {
  const targetId = report.targetId;
  const lines: string[] = [];

  const username = await deps.users
    ?.resolve(targetId)
    .then((profile) => profile?.username ?? null)
    .catch(() => null);
  lines.push(
    `<@${targetId}>${username ? ` · @${escapeMarkdown(username)}` : ''} · \`${targetId}\``,
  );

  const created = snowflakeCreatedAt(targetId);
  if (created !== null) lines.push(`Account created ${relative(created)}`);

  const found = await deps.lookupMember?.(ctx.guildId, targetId).catch(() => null);
  if (found?.state === 'member') {
    lines.push(found.joinedAt === null ? 'In the server' : `Joined ${relative(found.joinedAt)}`);
    if (found.timeoutUntil !== null && found.timeoutUntil > now) {
      lines.push(`Timed out until ${relative(found.timeoutUntil)}`);
    }
  } else if (found?.state === 'absent') {
    lines.push('Not in the server');
  } else if (found?.state === 'unavailable') {
    lines.push(`Proton couldn’t check their membership (Discord answered ${found.status}).`);
  }

  const fields: NonNullable<RawEmbed['fields']> = [];

  const counts = await deps.ledger?.countsForTarget(ctx.guildId, targetId).catch(() => null);
  if (counts) {
    const listed = CASE_NOUNS.flatMap(([kind, noun]) => {
      const count = counts[kind] ?? 0;
      return count > 0 ? [plural(count, noun)] : [];
    });
    fields.push({ name: 'Cases', value: listed.length > 0 ? listed.join(' · ') : 'No cases' });
  }

  const stats = await deps.reports
    ?.targetStats(ctx.guildId, targetId, now - STATS_WINDOW_DAYS * DAY_MS)
    .catch(() => null);
  if (stats) {
    fields.push({
      name: 'Reports',
      value:
        `${plural(stats.total, 'report')} by ${plural(stats.distinctReporters, 'member')} in ` +
        `${STATS_WINDOW_DAYS} days · ${stats.open} open`,
    });
  }

  fields.push({ name: 'This report', value: statusLine(report) });

  return { title: 'Reported member', description: lines.join('\n'), fields };
}

function safeName(text: string, max = 80): string {
  return clipText(text.replace(/[[\]()`*_~|<>@#\\]/g, '_'), max).text;
}

function attachmentLines(attachments: readonly AttachmentMeta[], now: number, max: number) {
  const lines: string[] = [];
  let length = 0;

  for (const [index, attachment] of attachments.entries()) {
    const name = safeName(attachment.filename);
    const expired = attachment.expiresAt !== null && attachment.expiresAt <= now;
    const line = expired
      ? `${name} · link expired`
      : `[${name}](${attachment.url})${
          attachment.expiresAt === null ? '' : ` · link expires ${relative(attachment.expiresAt)}`
        }`;

    const rest = `…and ${attachments.length - index} more`;
    if (length + line.length + 1 > max - rest.length - 1) {
      lines.push(rest);
      break;
    }

    lines.push(line);
    length += line.length + 1;
  }

  return lines.join('\n');
}

const UNAVAILABLE_TEXT: Readonly<Record<string, string>> = {
  deleted: 'The message was already deleted when it was reported.',
  no_access: 'Proton couldn’t read that channel when the report was filed.',
  failed: 'Proton couldn’t fetch the message when the report was filed.',
  not_captured: 'Proton didn’t capture the message when the report was filed.',
};

const LINK_TEXT: Readonly<Record<string, string>> = {
  not_found: 'Not found. It was deleted, or the link was wrong.',
  no_access: 'In a channel the reporter can’t view, so Proton didn’t read it.',
  other_server: 'In another server, so Proton didn’t read it.',
  invalid: 'Not a message link.',
  failed: 'Proton couldn’t read it when the report was filed.',
};

const HIDDEN = 'Message in a channel you can’t view.';

type Viewer = (channelId: string) => boolean;

function viewerFor(state: GuildState | null, actor: ReviewActor): Viewer {
  return (channelId) => {
    if (actor.owner === true || hasWithAdmin(actor.permissions, Permissions.Administrator)) {
      return true;
    }
    if (!state || actor.roleIds === null) return false;
    return canReadHistory(state, actor.id, actor.roleIds, channelId);
  };
}

function snapshotText(snapshot: MessageSnapshot): string {
  return snapshot.content || snapshot.forwardedContent || '';
}

function linkValue(link: LinkEvidence, canView: Viewer): string {
  const snapshot = link.snapshot;

  if (link.status === 'captured' && snapshot) {
    if (!canView(snapshot.channelId)) return HIDDEN;
    const author = snapshot.authorId ? ` · <@${snapshot.authorId}>` : '';
    const text = snapshotText(snapshot);
    return (
      `[Jump to message](${snapshot.url})${author} in <#${snapshot.channelId}>` +
      (text.trim() ? `\n${fenced(text, LINK_EXCERPT)}` : '')
    );
  }

  const said = LINK_TEXT[link.status] ?? LINK_TEXT.failed;
  return link.status === 'invalid' ? `${fenced(link.url, 120)}\n${said}` : `${link.url}\n${said}`;
}

function embedLength(embed: RawEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0)
  );
}

function moreEvidence(report: ReportRecord, canView: Viewer, now: number): RawEmbed | null {
  const { evidence } = report;
  const fields: NonNullable<RawEmbed['fields']> = [];

  evidence.links.forEach((link, index) => {
    fields.push({ name: `Linked message ${index + 1}`, value: linkValue(link, canView) });
  });

  if (evidence.attachments.length > 0) {
    fields.push({
      name: 'Files from the reporter',
      value: attachmentLines(evidence.attachments, now, FIELD_MAX),
    });
  }

  if (evidence.copy && 'messageId' in evidence.copy) {
    fields.push({
      name: 'Forwarded copy',
      value: `[Jump to the copy](${messageUrl(
        report.guildId,
        evidence.copy.channelId,
        evidence.copy.messageId,
      )})`,
    });
  } else if (evidence.copy && 'failed' in evidence.copy) {
    fields.push({ name: 'Forwarded copy', value: clipText(evidence.copy.failed, FIELD_MAX).text });
  }

  return fields.length > 0 ? { title: 'More evidence', fields } : null;
}

function messageEmbed(
  report: ReportRecord,
  canView: Viewer,
  now: number,
  budget: number,
): RawEmbed | null {
  const message = report.evidence.message;
  if (!message) return null;

  const title = 'Reported message';

  if (message.status === 'unavailable') {
    const { channelId, messageId } = message.ids;
    const said =
      message.reason === 'purged'
        ? purgedText(report)
        : (UNAVAILABLE_TEXT[message.reason] ?? UNAVAILABLE_TEXT.failed);
    return {
      title,
      description: `${said}\n[Jump to where it was](${messageUrl(report.guildId, channelId, messageId)})`,
    };
  }

  const snapshot = message.snapshot;
  if (!canView(snapshot.channelId)) return { title, description: HIDDEN };

  const text = snapshotText(snapshot);
  const fields: NonNullable<RawEmbed['fields']> = [];

  const sent = [
    `${snapshot.authorId ? `<@${snapshot.authorId}>` : 'Unknown author'} in <#${snapshot.channelId}>`,
    ...(snapshot.createdAt === null ? [] : [relative(snapshot.createdAt)]),
    ...(snapshot.editedAt === null ? [] : ['edited']),
    ...(snapshot.forwarded ? ['forwarded'] : []),
  ].join(' · ');
  fields.push({ name: 'Sent', value: `${sent}\n[Jump to message](${snapshot.url})` });

  if (snapshot.attachments.length > 0) {
    fields.push({
      name: 'Attachments',
      value: attachmentLines(snapshot.attachments, now, FIELD_MAX),
    });
  }

  const extras = [
    ...snapshot.embeds.map((embed) => `Embed: ${safeName(embed.title ?? embed.url ?? 'untitled')}`),
    ...snapshot.stickers.map((sticker) => `Sticker: ${safeName(sticker, 40)}`),
  ];
  if (extras.length > 0) {
    fields.push({ name: 'Also in the message', value: clipText(extras.join('\n'), 500).text });
  }

  const room = Math.max(200, Math.min(MESSAGE_SHOWN_MAX, budget - embedLength({ title, fields })));

  return {
    title,
    description: text.trim() ? fenced(text, room - 8) : 'No text.',
    fields,
  };
}

export function evidenceEmbeds(report: ReportRecord, canView: Viewer, now: number): RawEmbed[] {
  const heading = `Evidence for report \`${report.id}\``;

  if (report.evidence.purged === true || report.evidencePurgedAt !== null) {
    return [{ title: heading, description: purgedText(report) }];
  }

  const more = moreEvidence(report, canView, now);
  const main = messageEmbed(
    report,
    canView,
    now,
    EVIDENCE_TOTAL_MAX - (more ? embedLength(more) : 0),
  );

  const embeds = [main, more].filter((embed): embed is RawEmbed => embed !== null);
  return embeds.length > 0
    ? embeds
    : [{ title: heading, description: 'No message, links or files were attached to this report.' }];
}

async function handleViewPress(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
  what: 'member' | 'evidence',
): Promise<void> {
  const press = readComponentInteraction(event);
  const parsed = parseCustomId(press?.customId);
  if (!press || parsed?.moduleId !== MODULE_ID) return;

  const to = respondTo(ctx.guildId, press.userId, interactionRef(press));
  if (!ctx.config.enabled) return replyError(ctx, to, REVIEW_MODERATION_OFF);

  await send(ctx, deferTo(to, true));
  const channel: Channel = followChannel(ctx, to, press.applicationId ?? deps.applicationId);
  const refuse = (text: string) => channel.say(errorMessage(text), 'result', true);

  const loaded = await loadForReview(event, ctx, deps, press, parsed.args[0], 'view', refuse);
  if (!loaded) return;

  const now = deps.now?.() ?? Date.now();
  const embeds =
    what === 'member'
      ? [await memberEmbed(ctx, deps, loaded.report, now)]
      : evidenceEmbeds(loaded.report, viewerFor(loaded.state, loaded.actor), now);

  await channel.say({ embeds, components: [], allowedMentions: { parse: [] } }, 'result', true);
}

export const REPORT_REVIEW_ACTIONS: Readonly<Record<string, ReportInteractionHandler>> = {
  [REPORT_CARD_ACTIONS.claim]: (event, ctx, deps) => handleClaimPress(event, ctx, deps, true),
  [REPORT_CARD_ACTIONS.unclaim]: (event, ctx, deps) => handleClaimPress(event, ctx, deps, false),
  [REPORT_CARD_ACTIONS.accept]: handleAcceptPress,
  [REPORT_CARD_ACTIONS.dismiss]: handleDismissPress,
  [REPORT_DISMISS_MODAL_ACTION]: handleDismissSubmit,
  [REPORT_CARD_ACTIONS.member]: (event, ctx, deps) => handleViewPress(event, ctx, deps, 'member'),
  [REPORT_CARD_ACTIONS.evidence]: (event, ctx, deps) =>
    handleViewPress(event, ctx, deps, 'evidence'),
};

export const REPORT_INTERACTION_ACTIONS: Readonly<Record<string, ReportInteractionHandler>> = {
  ...REPORT_INTAKE_ACTIONS,
  ...REPORT_REVIEW_ACTIONS,
};

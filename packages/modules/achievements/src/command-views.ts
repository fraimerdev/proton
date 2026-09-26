import { TIER_COLOURS, TIER_LABELS } from '@proton/cards/design';
import {
  type AllowedMentions,
  type Attachment,
  type AutocompleteChoice,
  type EncodeCustomIdResult,
  encodeCustomId,
  type InteractionMessage,
  MAX_AUTOCOMPLETE_CHOICE_LENGTH,
  MAX_AUTOCOMPLETE_CHOICES,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  type StatusBody,
  TIER_IDS,
  type TierId,
} from '@proton/core';
import { escapeDiscordMarkdown } from '@proton/core/placeholders';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import {
  type Achievement,
  type AchievementKind,
  type AchievementsConfig,
  MODULE_ID,
  type Requirement,
  type Reward,
  type Tier,
} from './config.ts';
import { cancelButtonId, type ResetDraft, type ResetStep, resetButtonId } from './drafts.ts';
import { describeRequirement, progressBar, type StatusView, tierRank } from './evaluate.ts';
import { BADGE_FILENAME } from './placeholders.ts';
import { badgeColour } from './simulation.ts';
import type { UnlockRow } from './store.ts';
import { type TriggerId, triggerOf } from './triggers.ts';

export type Component = Record<string, unknown>;

export const LIST_COMMAND = 'achievements';
export const ACHIEVEMENT_COMMAND = 'achievement';
export const ACHIEVEMENT_OPTION = 'achievement';

export const PAGE_SIZE = 6;
export const PAGE_ACTION = 'pg';
export const BADGE_BUDGET_MS = 1500;

export const NO_MENTIONS: AllowedMentions = { parse: [] };

export function notYours(list: string): string {
  return `Only the person who ran ${list} can turn these pages.`;
}

export const ACHIEVEMENTS_OFF =
  'Achievements is off in this server. An admin can turn it on in the Proton dashboard.';

export const STORE_UNBOUND =
  'I can’t read this server’s achievements right now. That’s a problem on my side, not a ' +
  'setting in this server.';

export const NO_APPLICATION =
  'I can’t reply to this right now. That’s a problem on my side, not a setting in this server.';

export const UNKNOWN_CONTROL =
  'That button no longer works, so nothing was done. Run the command again.';

export const UNKNOWN_SUBCOMMAND = 'I don’t recognise that subcommand.';

export function needsManageServer(view: string): string {
  return `You need Manage Server to reset achievements. Anyone can still use ${view}.`;
}

export function resetExpired(reset: string): string {
  return `This confirmation expired, so nothing was reset. Run ${reset} again.`;
}

export const RESET_SETTLED = 'This reset was already confirmed or cancelled, so nothing changed.';

export const RESET_CANCELLED = 'Cancelled. Nothing was reset.';

export const RESET_UNSTARTED =
  'Couldn’t start this reset, so nothing was done. Run the command again.';

export const WORKING = 'Working on it…';

const EMPTY_LIST = 'No badges yet, and no achievements are active in this server right now.';

const MEDALS: Readonly<Record<TierId, string>> = {
  single: '🏅',
  bronze: '🥉',
  silver: '🥈',
  gold: '🥇',
  diamond: '💎',
};

const LOCKED = '🔒';

const COUNT = new Intl.NumberFormat('en-GB');

export function count(value: number): string {
  return COUNT.format(value);
}

function dateFormat(timeZone: string, withTime: boolean): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
  };

  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' });
  }
}

export function formatDate(at: number, timeZone: string): string {
  return dateFormat(timeZone, false).format(at);
}

export function formatDateTime(at: number, timeZone: string): string {
  return dateFormat(timeZone, true).format(at);
}

function relative(at: number): string {
  return `<t:${Math.floor(at / 1000)}:R>`;
}

function instant(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

function plain(name: string): string {
  return escapeDiscordMarkdown(name);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function statusMessage(body: StatusBody): InteractionMessage {
  return {
    content: body.content,
    embeds: body.embeds,
    components: [],
    allowedMentions: NO_MENTIONS,
  };
}

export function textMessage(content: string, components: Component[] = []): InteractionMessage {
  return { content, embeds: [], components, allowedMentions: NO_MENTIONS };
}

export function v2Message(components: Component[], files: Attachment[] = []): InteractionMessage {
  return {
    components,
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
    allowedMentions: NO_MENTIONS,
    ...(files.length > 0 ? { files } : {}),
  };
}

function text(content: string): Component {
  return { type: ComponentType.TextDisplay, content };
}

function separator(): Component {
  return { type: ComponentType.Separator, divider: true, spacing: 1 };
}

function container(accent: number, components: Component[]): Component {
  return { type: ComponentType.Container, accent_color: accent, components };
}

function section(texts: readonly string[], thumbnail: string): Component {
  return {
    type: ComponentType.Section,
    components: texts.map(text),
    accessory: { type: ComponentType.Thumbnail, media: { url: thumbnail } },
  };
}

function button(
  label: string,
  customId: string,
  disabled: boolean,
  style: ButtonStyle = ButtonStyle.Secondary,
): Component {
  return { type: ComponentType.Button, style, label, custom_id: customId, disabled };
}

function tiersByRank(tiers: readonly Tier[]): Tier[] {
  return [...tiers].sort((a, b) => tierRank(a.id) - tierRank(b.id));
}

export interface ProgressPart {
  trigger: TriggerId;
  current: number;
  target: number;
}

export function amountText(part: ProgressPart): string {
  if (part.trigger === 'leveling.level') {
    return `level ${count(part.current)} of ${count(part.target)}`;
  }
  if (part.trigger === 'achievements.unlocked') {
    return part.current >= part.target ? 'prerequisite earned' : 'prerequisite not earned yet';
  }

  const { unit } = triggerOf(part.trigger);
  return `${count(part.current)} / ${count(part.target)} ${part.target === 1 ? unit.one : unit.many}`;
}

export function percentOf(parts: readonly ProgressPart[]): number {
  if (parts.length === 0) return 0;

  return Math.min(
    ...parts.map((part) =>
      part.target > 0
        ? Math.floor((Math.min(Math.max(part.current, 0), part.target) * 100) / part.target)
        : 0,
    ),
  );
}

export function progressText(
  parts: readonly ProgressPart[],
  percent: number,
  forTier: TierId | null,
): string {
  const amounts = parts.map(amountText).join(', ');
  return `${amounts}${forTier === null ? '' : ` for ${TIER_LABELS[forTier]}`} (${percent}%)`;
}

export function barLine(percent: number): string {
  return `\`${progressBar(percent / 100)}\``;
}

export type EntryState = 'active' | 'expired' | 'paused' | 'archived' | 'retired';

export interface ListEntry {
  achievementId: string;
  name: string;
  kind: AchievementKind;
  state: EntryState;
  held: TierId | null;
  earnedAt: number | null;
  next: { tier: TierId; parts: ProgressPart[] } | null;
}

const STATE_NOTES: Readonly<Partial<Record<EntryState, string>>> = {
  expired: 'Ended',
  paused: 'Paused',
  archived: 'Archived',
  retired: 'Retired',
};

function standingOf(entry: ListEntry): string {
  if (entry.held === null) return 'Not earned yet';
  return entry.kind === 'tiered' ? TIER_LABELS[entry.held] : 'Earned';
}

export function entryText(entry: ListEntry, timeZone: string): string {
  const note = STATE_NOTES[entry.state];
  const medal = entry.held === null ? LOCKED : MEDALS[entry.held];
  const lines = [
    `${medal} **${plain(entry.name)}**: ${standingOf(entry)}${note ? ` · ${note}` : ''}`,
  ];

  if (entry.next) {
    const percent = percentOf(entry.next.parts);
    lines.push(
      progressText(entry.next.parts, percent, entry.kind === 'tiered' ? entry.next.tier : null),
      barLine(percent),
    );
  } else if (entry.earnedAt !== null) {
    lines.push(`Earned ${formatDate(entry.earnedAt, timeZone)}`);
  }

  return lines.join('\n');
}

export function pageCount(entries: number): number {
  return Math.max(1, Math.ceil(entries / PAGE_SIZE));
}

export function clampPage(page: number, pages: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.trunc(page)), Math.max(1, pages));
}

export function pageButtonId(
  subjectId: string,
  page: number,
  invokerId: string,
): EncodeCustomIdResult {
  return encodeCustomId(MODULE_ID, PAGE_ACTION, subjectId, String(page), invokerId);
}

function pagerRow(
  subjectId: string,
  invokerId: string,
  page: number,
  pages: number,
): Component | null {
  if (pages <= 1) return null;

  const previous = pageButtonId(subjectId, page - 1, invokerId);
  const here = pageButtonId(subjectId, page, invokerId);
  const next = pageButtonId(subjectId, page + 1, invokerId);
  if (!previous.ok || !here.ok || !next.ok) return null;

  return {
    type: ComponentType.ActionRow,
    components: [
      button('Previous', previous.customId, page <= 1),
      button(`${page} / ${pages}`, here.customId, true),
      button('Next', next.customId, page >= pages),
    ],
  };
}

export interface ListPageInput {
  subjectId: string;
  invokerId: string;
  entries: readonly ListEntry[];
  page: number;
  timeZone: string;
}

export interface ListPage {
  components: Component[];
  page: number;
  pages: number;
}

export function listPage(input: ListPageInput): ListPage {
  const pages = pageCount(input.entries.length);
  const page = clampPage(input.page, pages);
  const shown = input.entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const earned = input.entries.filter((entry) => entry.held !== null).length;

  const title = `**<@${input.subjectId}>’s achievements**`;
  const header =
    input.entries.length > 0
      ? `${title} · ${count(earned)} of ${count(input.entries.length)} earned`
      : title;

  const body =
    shown.length > 0
      ? shown.map((entry) => text(entryText(entry, input.timeZone)))
      : [text(EMPTY_LIST)];

  const components = [container(TIER_COLOURS.single, [text(header), separator(), ...body])];
  const row = pagerRow(input.subjectId, input.invokerId, page, pages);
  if (row) components.push(row);

  return { components, page, pages };
}

function rewardText(reward: Reward): string {
  switch (reward.kind) {
    case 'add_role':
      return `<@&${reward.roleId}>`;
    case 'remove_role':
      return `removes <@&${reward.roleId}>`;
    case 'xp':
      return `${count(reward.amount)} XP`;
  }
}

function rewardsText(rewards: readonly Reward[]): string {
  return rewards.map(rewardText).join(', ');
}

function scopeOf(requirement: Requirement): string | null {
  const channels = (ids: readonly string[]) => ids.map((id) => `<#${id}>`).join(', ');
  const parts = [
    ...(requirement.channelIds.length > 0 ? [`only in ${channels(requirement.channelIds)}`] : []),
    ...(requirement.excludedChannelIds.length > 0
      ? [`not in ${channels(requirement.excludedChannelIds)}`]
      : []),
  ];

  return parts.length > 0 ? parts.join(', ') : null;
}

type NameOf = (achievementId: string) => string | undefined;

function requirementLine(requirement: Requirement, target: number, nameOf?: NameOf): string {
  return describeRequirement(requirement, target, 'en-GB', nameOf);
}

function requirementsBlock(achievement: Achievement, nameOf?: NameOf): string {
  const tiers = tiersByRank(achievement.tiers);

  if (achievement.kind === 'tiered') {
    const lines = ['**Tiers**'];

    for (const tier of tiers) {
      const what = achievement.requirements
        .map((requirement) =>
          requirementLine(requirement, tier.targets[requirement.id] ?? 0, nameOf),
        )
        .join(' and ');
      const rewards = tier.rewards.length > 0 ? ` · ${rewardsText(tier.rewards)}` : '';
      lines.push(`${MEDALS[tier.id]} **${TIER_LABELS[tier.id]}**: ${what}${rewards}`);
    }

    const scopes = achievement.requirements
      .map(scopeOf)
      .filter((scope): scope is string => scope !== null);
    if (scopes.length > 0) lines.push(`-# Counts ${scopes.join('; ')}`);

    return lines.join('\n');
  }

  const tier = tiers[0];
  const lines = [
    achievement.requirements.length > 1
      ? '**Requirements** · Members need all of these.'
      : '**Requirement**',
  ];

  for (const requirement of achievement.requirements) {
    const scope = scopeOf(requirement);
    const target = tier?.targets[requirement.id] ?? 0;
    lines.push(`- ${requirementLine(requirement, target, nameOf)}${scope ? ` · ${scope}` : ''}`);
  }

  if (tier && tier.rewards.length > 0) lines.push(`**Rewards** · ${rewardsText(tier.rewards)}`);

  return lines.join('\n');
}

function statusLine(achievement: Achievement, status: StatusView, timeZone: string): string {
  const at = (label: string, when: number) =>
    `${label} ${formatDateTime(when, timeZone)} (${timeZone}) · ${relative(when)}`;
  const startsAt = instant(achievement.startsAt);
  const endsAt = instant(achievement.endsAt);

  switch (status.status) {
    case 'scheduled':
      return startsAt === null ? 'Starting soon' : at('Starts', startsAt);
    case 'active':
      return endsAt === null ? 'Active' : `Active · ${at('Ends', endsAt)}`;
    case 'expired':
      return endsAt === null ? 'Ended' : at('Ended', endsAt);
    case 'paused':
      return achievement.status === 'paused' || !status.reason
        ? 'Paused by an admin'
        : `Paused · ${status.reason}`;
    case 'archived':
      return 'Archived · no longer counting';
    case 'draft':
      return 'Draft';
  }
}

export function displayTier(achievement: Achievement, earned: Iterable<TierId>): TierId {
  const held = new Set(earned);
  const tiers = tiersByRank(achievement.tiers);
  return tiers.filter((tier) => held.has(tier.id)).at(-1)?.id ?? tiers[0]?.id ?? TIER_IDS[0];
}

export interface DetailInput {
  achievement: Achievement;
  subjectId: string;
  status: StatusView;
  values: Readonly<Record<string, number>>;
  earned: ReadonlyMap<TierId, number>;
  badge: boolean;
  timeZone: string;
  nameOf?: NameOf;
}

function progressBlock(input: DetailInput): string {
  const { achievement, values, earned, timeZone } = input;
  const tiers = tiersByRank(achievement.tiers);
  const next = tiers.find((tier) => !earned.has(tier.id));
  const lines = [`**<@${input.subjectId}>’s progress**`];

  for (const tier of tiers) {
    const tiered = achievement.kind === 'tiered';
    const label = tiered ? `${MEDALS[tier.id]} ${TIER_LABELS[tier.id]}: ` : '';
    const earnedAt = earned.get(tier.id);

    if (earnedAt !== undefined) {
      lines.push(
        tiered
          ? `${label}earned ${formatDate(earnedAt, timeZone)}`
          : `${MEDALS.single} Earned ${formatDate(earnedAt, timeZone)}`,
      );
      continue;
    }

    const parts = achievement.requirements.map((requirement) => ({
      trigger: requirement.trigger,
      current: values[requirement.id] ?? 0,
      target: tier.targets[requirement.id] ?? 0,
    }));
    const percent = percentOf(parts);

    lines.push(`${label}${progressText(parts, percent, null)}`);
    if (tier.id === next?.id) lines.push(barLine(percent));
  }

  return lines.join('\n');
}

export function detailComponents(input: DetailInput): Component[] {
  const { achievement } = input;
  const description = achievement.description.trim();
  const heading = [
    `## ${plain(achievement.name)}`,
    ...(description ? [description] : []),
    `-# ${statusLine(achievement, input.status, input.timeZone)}`,
  ];

  const intro = input.badge
    ? [section(heading, `attachment://${BADGE_FILENAME}`)]
    : heading.map(text);
  const accent = badgeColour(achievement.badge, displayTier(achievement, input.earned.keys()));

  return [
    container(accent, [
      ...intro,
      separator(),
      text(requirementsBlock(achievement, input.nameOf)),
      separator(),
      text(progressBlock(input)),
    ]),
  ];
}

export interface RetiredInput {
  name: string;
  kind: AchievementKind;
  subjectId: string;
  earned: ReadonlyMap<TierId, number>;
  timeZone: string;
}

export function retiredComponents(input: RetiredInput): Component[] {
  const held = TIER_IDS.filter((tierId) => input.earned.has(tierId));
  const lines = [`**<@${input.subjectId}>’s badges**`];

  for (const tierId of held) {
    const earnedAt = input.earned.get(tierId) ?? 0;
    lines.push(
      input.kind === 'tiered'
        ? `${MEDALS[tierId]} ${TIER_LABELS[tierId]}: earned ${formatDate(earnedAt, input.timeZone)}`
        : `${MEDALS.single} Earned ${formatDate(earnedAt, input.timeZone)}`,
    );
  }

  return [
    container(TIER_COLOURS[held.at(-1) ?? 'single'], [
      text(`## ${plain(input.name)}`),
      text('-# Retired · members keep what they earned'),
      separator(),
      text(lines.join('\n')),
    ]),
  ];
}

export function findAchievement(config: AchievementsConfig, raw: string): Achievement | null {
  const wanted = raw.trim();
  const lowered = wanted.toLowerCase();

  return (
    config.achievements.find((achievement) => achievement.id === wanted) ??
    config.achievements.find((achievement) => achievement.name.toLowerCase() === lowered) ??
    null
  );
}

export function notFound(raw: string): string {
  return (
    `There’s no achievement called “${plain(truncate(raw.trim(), 100))}” in this server. ` +
    'Pick one from the list as you type.'
  );
}

export function earnedTiers(
  rows: readonly UnlockRow[],
  achievement?: Achievement,
): Map<TierId, number> {
  const known = achievement ? new Set(achievement.tiers.map((tier) => tier.id)) : null;
  const earned = new Map<TierId, number>();

  for (const row of rows) {
    if (known && !known.has(row.tierId)) continue;
    const seen = earned.get(row.tierId);
    if (seen === undefined || row.unlockedAt < seen) earned.set(row.tierId, row.unlockedAt);
  }

  return earned;
}

export type ChoiceScope = 'view' | 'reset';

export function achievementChoices(
  config: AchievementsConfig,
  held: readonly UnlockRow[],
  query: string,
  scope: ChoiceScope,
): AutocompleteChoice[] {
  const wanted = query.trim().toLowerCase();
  const heldIds = new Set(held.map((row) => row.achievementId));
  const configured = new Set(config.achievements.map((achievement) => achievement.id));
  const sources: Array<{ id: string; name: string; note: string | null }> = [];

  for (const achievement of config.achievements) {
    if (achievement.status === 'draft') continue;
    if (achievement.status === 'archived' && scope === 'view' && !heldIds.has(achievement.id)) {
      continue;
    }

    sources.push({
      id: achievement.id,
      name: achievement.name,
      note: achievement.status === 'archived' ? 'archived' : null,
    });
  }

  if (scope === 'view') {
    const retired = new Set<string>();

    for (const row of held) {
      if (configured.has(row.achievementId) || retired.has(row.achievementId)) continue;
      retired.add(row.achievementId);
      sources.push({ id: row.achievementId, name: row.definition.name, note: 'retired' });
    }
  }

  return sources
    .filter(
      (source) =>
        wanted === '' || source.name.toLowerCase().includes(wanted) || source.id.includes(wanted),
    )
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((source) => ({
      name: truncate(
        source.note ? `${source.name} (${source.note})` : source.name,
        MAX_AUTOCOMPLETE_CHOICE_LENGTH,
      ),
      value: source.id,
    }));
}

function resetTarget(name: string | null): string {
  return name === null ? '**every achievement**' : `**${plain(name)}**`;
}

export function resetPrompt(
  draft: ResetDraft,
  step: ResetStep,
  name: string | null,
): InteractionMessage | null {
  const confirm = resetButtonId(draft, step);
  const cancel = cancelButtonId(draft, step);
  if (!confirm.ok || !cancel.ok) return null;

  const target = resetTarget(name);
  const member = `<@${draft.memberId}>`;

  const lines =
    step === 1
      ? [
          `Reset ${target} for ${member}?`,
          `Their progress starts again from now, and ${
            name === null ? 'every badge they hold is' : 'the badges they hold for it are'
          } removed.`,
          draft.rewardsAgain
            ? 'Next you’ll be asked separately whether they can earn the rewards again.'
            : 'Rewards they were already given stay given and won’t be given again.',
        ]
      : [
          `Also let ${member} earn the rewards again?`,
          `Roles and XP they were already given for ${target} will be given again when they ` +
            'earn those tiers again.',
        ];

  return textMessage(lines.join('\n'), [
    {
      type: ComponentType.ActionRow,
      components: [
        button(
          step === 1 ? 'Reset' : 'Let them earn rewards again',
          confirm.customId,
          false,
          ButtonStyle.Danger,
        ),
        button('Cancel', cancel.customId, false),
      ],
    },
  ]);
}

export function resetDone(draft: ResetDraft, name: string | null): string {
  return (
    `Reset ${resetTarget(name)} for <@${draft.memberId}>. Their progress starts again from now. ` +
    (draft.rewardsAgain
      ? 'They can earn the rewards again.'
      : 'Rewards they were already given won’t be given again.')
  );
}

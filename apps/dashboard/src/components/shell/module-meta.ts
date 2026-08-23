import type { IconName } from './icon-set.gen.ts';
export const CATEGORY_ORDER = [
  'moderation',
  'security',
  'engagement',
  'utility',
  'logging',
] as const;

export type Category = (typeof CATEGORY_ORDER)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  moderation: 'Moderation',
  security: 'Security',
  engagement: 'Engagement',
  utility: 'Utility',
  logging: 'Logging',
};

export const CATEGORY_ICONS: Record<Category, IconName> = {
  moderation: 'shield-check',
  security: 'lock-key',
  engagement: 'trend-up',
  utility: 'wrench',
  logging: 'list-magnifying-glass',
};

export function isCategory(value: string): value is Category {
  return (CATEGORY_ORDER as readonly string[]).includes(value);
}

// The module's own switch, which the sidebar owns. It is filtered out of the generated form so
// one control cannot disagree with another; ModuleConfigService.update keeps the two in step.
export const MODULE_SWITCH_PATH = 'enabled';

export function configurableDescriptors<T extends { path: string }>(
  descriptors: readonly T[],
): T[] {
  return descriptors.filter((descriptor) => descriptor.path !== MODULE_SWITCH_PATH);
}

export interface BrowseView {
  moduleId: string;
  viewId: string;
  title: string;
  icon: IconName;
}

// Duplicated from MODULE_VIEWS rather than derived from it: that registry pulls every view's Zod
// search schema in, and the shell renders on the overview where none of them is used.
// view-registry.test.tsx fails if the two ever disagree.
export const BROWSE_VIEWS: readonly BrowseView[] = [
  { moduleId: 'cases', viewId: 'cases', title: 'Cases', icon: 'scales' },
  { moduleId: 'leveling', viewId: 'leaderboard', title: 'Leaderboard', icon: 'ranking' },
  { moduleId: 'tags', viewId: 'tags', title: 'Tags', icon: 'tag' },
];

// The manifests name their icons in Lucide's vocabulary; the design system draws Phosphor. Mapped
// rather than passed through so an icon nobody translated shows the fallback instead of a blank box.
const MODULE_ICON_FALLBACK: IconName = 'puzzle-piece';

const PHOSPHOR: Record<string, IconName> = {
  activity: 'pulse',
  'alarm-clock': 'alarm',
  archive: 'archive',
  'bar-chart-3': 'chart-bar',
  fish: 'fish',
  gavel: 'gavel',
  gift: 'gift',
  'hand-wave': 'hand-waving',
  hash: 'hash',
  'layout-template': 'layout',
  'list-checks': 'list-checks',
  lightbulb: 'lightbulb',
  lock: 'lock',
  megaphone: 'megaphone',
  'message-square': 'chat-circle-text',
  'scroll-text': 'scroll',
  shield: 'shield',
  'shield-alert': 'shield-warning',
  'shield-check': 'shield-check',
  star: 'star',
  tag: 'tag',
  ticket: 'ticket',
  'trending-up': 'trend-up',
  'user-plus': 'user-plus',
  voice: 'speaker-high',
};

// The closed set moduleIcon can return. scripts/build-icons.ts reads it to decide which glyphs to
// generate, so an entry added to PHOSPHOR without re-running it fails the build rather than the eye.
export const MODULE_ICON_NAMES: readonly IconName[] = [
  ...new Set([...Object.values(PHOSPHOR), MODULE_ICON_FALLBACK]),
];

export function moduleIcon(name: string | null | undefined): IconName {
  if (!name) return MODULE_ICON_FALLBACK;

  return Object.hasOwn(PHOSPHOR, name)
    ? (PHOSPHOR[name] ?? MODULE_ICON_FALLBACK)
    : MODULE_ICON_FALLBACK;
}

const SHORT_REASONS: Record<string, string> = {
  missing_intent: 'A privileged intent is off',
  missing_permission: 'A permission is missing',
  missing_dependency: 'A module it needs is not loaded',
  insufficient_entitlement: 'Not on this plan',
};

export function shortReason(code: string | undefined): string {
  if (!code) return 'Not running';
  return Object.hasOwn(SHORT_REASONS, code)
    ? (SHORT_REASONS[code] ?? 'Not running')
    : 'Not running';
}

const WHERE_TO_FIX: Record<string, string> = {
  missing_intent: 'Discord Developer Portal → Proton → Bot → Privileged Gateway Intents',
  missing_permission: 'Server Settings → Roles → Proton',
  missing_dependency: 'Proton’s own deployment — no server setting changes this',
  insufficient_entitlement: 'Billing → this server’s plan',
};

export function whereToFix(code: string | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(WHERE_TO_FIX, code) ? (WHERE_TO_FIX[code] ?? null) : null;
}

export type Tone = 'accent' | 'ok' | 'warn' | 'danger' | 'muted';

export interface ActionLook {
  icon: IconName;
  tone: Tone;
  verb: string;
}

const ACTION_LOOK: Record<string, ActionLook> = {
  ban: { icon: 'prohibit', tone: 'danger', verb: 'Banned' },
  unban: { icon: 'seal-check', tone: 'ok', verb: 'Unbanned' },
  kick: { icon: 'sign-out', tone: 'warn', verb: 'Kicked' },
  timeout: { icon: 'clock-user', tone: 'warn', verb: 'Timed out' },
  untimeout: { icon: 'clock-counter-clockwise', tone: 'ok', verb: 'Timeout lifted' },
  warn: { icon: 'warning', tone: 'warn', verb: 'Warned' },
  purge: { icon: 'eraser', tone: 'accent', verb: 'Purged' },
  add_role: { icon: 'user-plus', tone: 'ok', verb: 'Role added' },
  remove_role: { icon: 'user-minus', tone: 'warn', verb: 'Role removed' },
  lockdown: { icon: 'lightning-slash', tone: 'danger', verb: 'Locked down' },
  unlock: { icon: 'lock-key-open', tone: 'ok', verb: 'Unlocked' },
  slowmode: { icon: 'hourglass-medium', tone: 'accent', verb: 'Slowmode' },
  delete_message: { icon: 'trash', tone: 'accent', verb: 'Message deleted' },
  edit_message: { icon: 'pencil-simple', tone: 'accent', verb: 'Message edited' },
  send: { icon: 'paper-plane-tilt', tone: 'accent', verb: 'Message sent' },
  add_reaction: { icon: 'smiley', tone: 'accent', verb: 'Reaction added' },
  move_member: { icon: 'arrows-left-right', tone: 'accent', verb: 'Moved' },
  create_channel: { icon: 'plus-square', tone: 'accent', verb: 'Channel created' },
  delete_channel: { icon: 'minus-square', tone: 'danger', verb: 'Channel deleted' },
  edit_channel: { icon: 'sliders-horizontal', tone: 'accent', verb: 'Channel edited' },
  create_thread: { icon: 'chat-teardrop-text', tone: 'accent', verb: 'Thread created' },
  create_role: { icon: 'shield-plus', tone: 'accent', verb: 'Role created' },
  pin_message: { icon: 'push-pin', tone: 'accent', verb: 'Pinned' },
  end_poll: { icon: 'chart-bar', tone: 'accent', verb: 'Poll ended' },
  automod_rule_create: { icon: 'shield-plus', tone: 'accent', verb: 'AutoMod rule created' },
  automod_rule_update: { icon: 'shield-check', tone: 'accent', verb: 'AutoMod rule updated' },
  automod_rule_delete: { icon: 'shield-slash', tone: 'warn', verb: 'AutoMod rule removed' },
  interaction_reply: { icon: 'chat-circle-text', tone: 'accent', verb: 'Replied' },
  interaction_followup: { icon: 'chat-circle-dots', tone: 'accent', verb: 'Followed up' },
};

const ACTION_ICON_FALLBACK: IconName = 'dot-outline';

export const ACTION_ICON_NAMES: readonly IconName[] = [
  ...new Set([...Object.values(ACTION_LOOK).map((look) => look.icon), ACTION_ICON_FALLBACK]),
];

export function actionLook(kind: string): ActionLook {
  const unknown: ActionLook = { icon: ACTION_ICON_FALLBACK, tone: 'muted', verb: kind };

  return Object.hasOwn(ACTION_LOOK, kind) ? (ACTION_LOOK[kind] ?? unknown) : unknown;
}

export function toneClass(tone: Tone): string {
  if (tone === 'danger') return 'tile-blocked';
  if (tone === 'warn') return 'tile-warn';
  if (tone === 'ok') return 'tile-ok';
  if (tone === 'muted') return '';
  return 'tile-accent';
}

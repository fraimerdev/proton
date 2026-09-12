import type { ModuleSummary } from '@proton/core';
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

export interface NavGroup {
  id: string;
  label: string;
  modules: readonly string[];
}

/**
 * How the sidebar files the modules: by the job an admin came to do. The manifest's own category is
 * the worker's taxonomy — it is what /commands and the public catalogue list by — and using it here
 * produced a group of eleven called Utility headed by Help and Ping.
 *
 * Order inside a group is authored, not the registry's: the rows an admin opens first come first.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  { id: 'joining', label: 'When someone joins', modules: ['verification', 'joinroles', 'welcome'] },
  {
    id: 'safety',
    label: 'Keeping it safe',
    modules: ['automod', 'antiraid', 'antinuke', 'phishing', 'honeypot'],
  },
  {
    id: 'people',
    label: 'Moderating people',
    modules: ['moderation', 'cases', 'appeals', 'permissions'],
  },
  {
    id: 'members',
    label: 'Things members use',
    modules: [
      'tickets',
      'rolemenu',
      'tags',
      'messages',
      'leveling',
      'giveaways',
      'polls',
      'suggestions',
      'starboard',
      'tempvc',
      'reminders',
      'counters',
    ],
  },
  { id: 'written', label: 'What gets written down', modules: ['serverlog', 'logging'] },
  { id: 'server', label: 'The server itself', modules: ['branding', 'backup', 'help', 'ping'] },
];

export interface NavGroupEntry<T> {
  id: string;
  label: string;
  modules: readonly T[];
}

export function navGrouped<T extends { id: string; category: string }>(
  modules: readonly T[],
): readonly NavGroupEntry<T>[] {
  const claimed = new Set(NAV_GROUPS.flatMap((group) => group.modules));

  const authored = NAV_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    modules: group.modules.flatMap((id) => modules.filter((module) => module.id === id)),
  }));

  // A module the table has never heard of falls back to its manifest category rather than
  // disappearing: the api ships modules this build may not know, and an unlisted one is unreachable.
  const left = modules.filter((module) => !claimed.has(module.id));
  const byCategory = CATEGORY_ORDER.map((category) => ({
    id: `category:${category}`,
    label: CATEGORY_LABELS[category],
    modules: left.filter((module) => module.category === category),
  }));
  const uncategorised = left.filter((module) => !isCategory(module.category));

  return [
    ...authored,
    ...byCategory,
    { id: 'other', label: 'Everything else', modules: uncategorised },
  ].filter((group) => group.modules.length > 0);
}

// Search synonyms, not claims about features: the category's users arrive with MEE6's, Dyno's and
// Carl-bot's vocabulary, and "reaction roles" found nothing at all.
const MODULE_ALIASES: Record<string, string> = {
  antinuke: 'nuke protection breaker mass delete',
  antiraid: 'raid protection join gate lockdown',
  appeals: 'ban appeal unban request',
  automod: 'anti-spam antispam auto moderation word filter caps links',
  backup: 'snapshot restore export server template',
  branding: 'nickname avatar banner bio name',
  cases: 'mod log history infractions warnings record',
  counters: 'member count stats',
  giveaways: 'raffle draw prize',
  help: 'commands list what proton does',
  honeypot: 'bait channel trap spam bots',
  joinroles: 'auto roles autorole join role sticky roles',
  leveling: 'levels xp rank leaderboard',
  logging: 'message logs edited deleted',
  messages: 'embeds embed builder announcement buttons',
  moderation: 'ban kick timeout mute purge warn',
  permissions: 'command permissions who can run',
  phishing: 'scam links blocklist',
  ping: 'latency uptime is it up',
  polls: 'vote poll',
  reminders: 'remind me timer',
  rolemenu: 'reaction roles self roles role picker button roles',
  serverlog: 'audit log mod log server events',
  starboard: 'highlights pins stars',
  suggestions: 'ideas feedback votes',
  tags: 'custom commands snippets autoresponder',
  tempvc: 'temporary voice join to create voice channels',
  tickets: 'support helpdesk modmail panels',
  verification: 'gate member screening rules agree',
  welcome: 'welcomer greeting goodbye leave message',
};

export function moduleAliases(moduleId: string): string {
  return Object.hasOwn(MODULE_ALIASES, moduleId) ? (MODULE_ALIASES[moduleId] ?? '') : '';
}

// What the first tab of a module with data views but no sub-pages is called. "Settings" named the
// software rather than the thing being set, on four pages out of thirty.
const SETTINGS_TAB_TITLES: Record<string, string> = {
  cases: 'Escalation',
  moderation: 'Policy',
  tags: 'Posting',
  tickets: 'How tickets work',
};

export function settingsTabTitle(moduleId: string, moduleName: string): string {
  return Object.hasOwn(SETTINGS_TAB_TITLES, moduleId)
    ? (SETTINGS_TAB_TITLES[moduleId] ?? moduleName)
    : moduleName;
}

// Presentation, not architecture: branding is an ordinary module underneath — it needs the config
// store, the audit trail and the reconciliation listener — but it configures Proton's own identity
// in this server rather than adding a feature to it, so listing it beside Tickets and Tags reads
// wrong. It sits above the categories on both surfaces instead.
const SERVER_LEVEL: ReadonlySet<string> = new Set(['branding']);

export function isServerLevel(moduleId: string): boolean {
  return SERVER_LEVEL.has(moduleId);
}

// Held here rather than on the manifest: a module tells the worker what it does by doing it, and
// adding a prose field to ModuleManifest would put dashboard copy in twenty-nine packages the
// worker loads. A module with no entry falls back to its category, which is never wrong.
const MODULE_BLURBS: Record<string, string> = {
  appeals:
    'The forms somebody fills in to argue against a ban, and where your moderators read and decide them.',
  antinuke: 'Trips a breaker when one member deletes channels, roles or webhooks too quickly.',
  antiraid: 'Watches the join rate and how new the accounts are, and gates a suspected raid.',
  automod: 'Checks every message for spam, banned words, links and shouting.',
  backup: 'Snapshots this server’s channels and roles, and previews a restore before it runs.',
  branding:
    'What Proton is called and what it looks like in this server — nickname, avatar, banner and bio. Only here; other servers are unaffected.',
  cases:
    'Every action Proton takes, numbered and searchable, with the ladder that escalates repeat warnings.',
  counters:
    'Channels whose names carry a count of this server’s members, roles or channels. Proton makes them, locks them, and rewrites them every ten minutes.',
  giveaways: 'Giveaways members enter with a button, drawn and announced by Proton.',
  help: 'The /help overview of what Proton does, and the link that sends a member back to this dashboard.',
  honeypot:
    'Channels nobody has a reason to post in. Anyone who posts in one is removed on the spot, which is how spam bots and compromised accounts give themselves away.',
  joinroles: 'Roles handed out when somebody joins, and the roles they get back if they return.',
  leveling:
    'XP for talking and for time in voice, with level-up announcements, role rewards and the /rank card.',
  logging:
    'Edited and deleted messages, archived for 30 days. It stores personal data, so it is off by default.',
  messages: 'Named messages you post with /message, and the button and dropdown rows they carry.',
  moderation:
    'The ban, kick, timeout and purge commands, and the policy Proton applies when staff run them.',
  permissions: 'Which roles may run each of Proton’s commands.',
  phishing: 'Matches links against a phishing blocklist Proton refreshes for itself.',
  ping: 'Answers /ping, so anyone can tell whether Proton is responding.',
  polls: 'Runs Discord’s own polls, and announces the result when one closes.',
  reminders: 'Members ask Proton to remind them later, in the channel they asked from.',
  rolemenu: 'Menus members click to give themselves roles.',
  serverlog:
    'Discord’s own audit events — channels, roles, members, bans — routed to the channels you pick.',
  starboard: 'Messages the server stars often enough get reposted to one channel.',
  suggestions:
    'Members suggest things, staff accept or deny them, and each suggestion keeps its own thread.',
  tags: 'Saved snippets anybody can post with /tag.',
  tempvc: 'Creator channels that give each member their own voice channel, with a panel to run it.',
  tickets:
    'Private support channels members open from a panel. Each kind of ticket carries its own staff, intake form, timers and transcript.',
  verification: 'A gate new members pass before the rest of the server opens up.',
  welcome:
    'What Proton posts when somebody joins or leaves, and the card it draws on the greeting.',
};

export function moduleBlurb(moduleId: string, category: string): string {
  if (Object.hasOwn(MODULE_BLURBS, moduleId)) {
    const held = MODULE_BLURBS[moduleId];
    if (held) return held;
  }

  return isCategory(category)
    ? `A ${CATEGORY_LABELS[category].toLowerCase()} module.`
    : 'A Proton module.';
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

  // Whether the sidebar's Records group lists it. A leaderboard and a tag library are browsable, but
  // they are not a record of anything — they reach the admin as tabs on their own module instead.
  record?: boolean;
}

// Duplicated from MODULE_VIEWS rather than derived from it: that registry pulls every view's Zod
// search schema in, and the shell renders on the overview where none of them is used.
// view-registry.test.tsx fails if the two ever disagree.
export const BROWSE_VIEWS: readonly BrowseView[] = [
  { moduleId: 'cases', viewId: 'cases', title: 'Case log', icon: 'scales', record: true },
  {
    moduleId: 'moderation',
    viewId: 'blocked',
    title: 'Blocked members',
    icon: 'shield-slash',
    record: true,
  },
  { moduleId: 'leveling', viewId: 'leaderboard', title: 'Leaderboard', icon: 'ranking' },
  { moduleId: 'tags', viewId: 'tags', title: 'Tag library', icon: 'tag' },
  { moduleId: 'tickets', viewId: 'tickets', title: 'Ticket queue', icon: 'ticket', record: true },
];

// The manifests name their icons in Lucide's vocabulary; the design system draws Phosphor. Mapped
// rather than passed through so an icon nobody translated shows the fallback instead of a blank box.
const MODULE_ICON_FALLBACK: IconName = 'puzzle-piece';

const PHOSPHOR: Record<string, IconName> = {
  activity: 'pulse',
  scales: 'scales',
  'alarm-clock': 'alarm',
  archive: 'archive',
  'bar-chart-3': 'chart-bar',
  fish: 'fish',
  gavel: 'gavel',
  gift: 'gift',
  'hand-wave': 'hand-waving',
  hash: 'hash',
  'help-circle': 'question',
  'id-card': 'identification-badge',
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

const MODULE_ART: Record<string, string> = {
  moderation: '/art/modules/moderation.png',
  automod: '/art/modules/automod.png',
  leveling: '/art/modules/leveling.png',
  serverlog: '/art/modules/serverlog.png',
  tickets: '/art/modules/tickets.png',
  giveaways: '/art/modules/giveaways.png',
};

export const FEATURED_MODULES: readonly string[] = Object.keys(MODULE_ART);

export function moduleArt(moduleId: string): string | undefined {
  return Object.hasOwn(MODULE_ART, moduleId) ? MODULE_ART[moduleId] : undefined;
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

export type ModuleState = 'off' | 'running' | 'blocked' | 'degraded';

export function moduleState(module: ModuleSummary): ModuleState {
  if (!module.enabled) return 'off';
  if (!module.status || module.status.enabled) return 'running';

  return module.status.disabledReason?.code === 'insufficient_entitlement' ? 'degraded' : 'blocked';
}

const WHERE_TO_FIX: Record<string, string> = {
  missing_intent: 'Discord Developer Portal → Proton → Bot → Privileged Gateway Intents',
  missing_permission: 'Server Settings → Roles → Proton',
  missing_dependency: 'Proton’s operator — no server setting changes this',
  // Not "Billing →": there is no billing surface in the product, and PRODUCT.md forbids
  // inventing one. The plan is shown on the server home, which is somewhere that exists.
  insufficient_entitlement: 'Modules → This server → Plan, for the tier this server is on',
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
  unwarn: { icon: 'eraser', tone: 'ok', verb: 'Warning withdrawn' },
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
  giveaway_draw: { icon: 'gift', tone: 'accent', verb: 'Giveaway drawn' },
  create_dm: { icon: 'chat-circle-text', tone: 'accent', verb: 'DM opened' },
  edit_role: { icon: 'sliders-horizontal', tone: 'accent', verb: 'Role edited' },
  set_channel_overwrite: { icon: 'lock', tone: 'accent', verb: 'Channel override set' },
  delete_channel_overwrite: {
    icon: 'lock-key-open',
    tone: 'accent',
    verb: 'Channel override removed',
  },
  add_bot_role: { icon: 'user-plus', tone: 'ok', verb: 'Role added to Proton' },
  remove_bot_role: { icon: 'user-minus', tone: 'warn', verb: 'Role removed from Proton' },
  set_bot_nickname: { icon: 'identification-badge', tone: 'accent', verb: 'Nickname changed' },
  set_bot_profile: { icon: 'identification-badge', tone: 'accent', verb: 'Profile changed' },
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

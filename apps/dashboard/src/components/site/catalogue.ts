import type { IconName } from '../shell/icon-set.gen.ts';
import { CATEGORY_ORDER, type Category, moduleBlurb } from '../shell/module-meta.ts';

export interface CatalogueEntry {
  id: string;
  name: string;
  category: Category;
  icon: IconName;
  commands: readonly string[];
}

// The manifests live in twenty-nine worker packages whose barrels drag discord.js, so the public
// pages cannot read them. catalogue.test.ts fails when this list and those manifests disagree.
export const CATALOGUE: readonly CatalogueEntry[] = [
  { id: 'appeals', name: 'Appeals', category: 'moderation', icon: 'scales', commands: [] },
  { id: 'cases', name: 'Cases', category: 'moderation', icon: 'gavel', commands: [] },
  {
    id: 'moderation',
    name: 'Moderation',
    category: 'moderation',
    icon: 'shield',
    commands: ['/ban', '/kick', '/timeout', '/warn', '/role', '/slowmode', '/lockdown'],
  },

  {
    id: 'antinuke',
    name: 'Anti-nuke',
    category: 'security',
    icon: 'shield-warning',
    commands: ['/antinuke'],
  },
  {
    id: 'antiraid',
    name: 'Anti-raid',
    category: 'security',
    icon: 'shield-warning',
    commands: [],
  },
  { id: 'automod', name: 'Automod', category: 'security', icon: 'shield-warning', commands: [] },
  { id: 'backup', name: 'Backup', category: 'security', icon: 'archive', commands: ['/backup'] },
  { id: 'honeypot', name: 'Honeypot', category: 'security', icon: 'fish', commands: [] },
  {
    id: 'phishing',
    name: 'Phishing links',
    category: 'security',
    icon: 'fish',
    commands: ['/phishing'],
  },
  {
    id: 'verification',
    name: 'Verification',
    category: 'security',
    icon: 'shield-check',
    commands: ['/verify', '/quarantine'],
  },

  {
    id: 'giveaways',
    name: 'Giveaways',
    category: 'engagement',
    icon: 'gift',
    commands: ['/giveaway'],
  },
  {
    id: 'leveling',
    name: 'Leveling',
    category: 'engagement',
    icon: 'trend-up',
    commands: ['/rank', '/leaderboard', '/xp'],
  },
  {
    id: 'rolemenu',
    name: 'Role menus',
    category: 'engagement',
    icon: 'list-checks',
    commands: ['/rolemenu'],
  },
  { id: 'starboard', name: 'Starboard', category: 'engagement', icon: 'star', commands: [] },
  {
    id: 'suggestions',
    name: 'Suggestions',
    category: 'engagement',
    icon: 'lightbulb',
    commands: ['/suggest', '/suggestion'],
  },
  {
    id: 'welcome',
    name: 'Welcome & goodbye',
    category: 'engagement',
    icon: 'hand-waving',
    commands: [],
  },

  {
    id: 'branding',
    name: 'Branding',
    category: 'utility',
    icon: 'identification-badge',
    commands: ['/branding'],
  },
  {
    id: 'counters',
    name: 'Counter channels',
    category: 'utility',
    icon: 'hash',
    commands: ['/counters'],
  },
  { id: 'help', name: 'Help', category: 'utility', icon: 'question', commands: ['/help'] },
  { id: 'joinroles', name: 'Join roles', category: 'utility', icon: 'user-plus', commands: [] },
  {
    id: 'messages',
    name: 'Messages',
    category: 'utility',
    icon: 'chat-circle-text',
    commands: ['/message'],
  },
  { id: 'permissions', name: 'Permissions', category: 'utility', icon: 'lock', commands: [] },
  { id: 'ping', name: 'Ping', category: 'utility', icon: 'pulse', commands: ['/ping'] },
  { id: 'polls', name: 'Polls', category: 'utility', icon: 'chart-bar', commands: ['/poll'] },
  {
    id: 'reminders',
    name: 'Reminders',
    category: 'utility',
    icon: 'alarm',
    commands: ['/remind', '/reminders'],
  },
  { id: 'tags', name: 'Tags', category: 'utility', icon: 'tag', commands: ['/tag', '/tags'] },
  {
    id: 'tempvc',
    name: 'Temporary voice channels',
    category: 'utility',
    icon: 'speaker-high',
    commands: ['/voice'],
  },
  { id: 'tickets', name: 'Tickets', category: 'utility', icon: 'ticket', commands: ['/ticket'] },

  { id: 'logging', name: 'Message logs', category: 'logging', icon: 'scroll', commands: [] },
  { id: 'serverlog', name: 'Server logs', category: 'logging', icon: 'scroll', commands: [] },
];

export interface CatalogueGroup {
  category: Category;
  entries: readonly CatalogueEntry[];
}

export function catalogueByCategory(): CatalogueGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    entries: CATALOGUE.filter((entry) => entry.category === category),
  })).filter((group) => group.entries.length > 0);
}

export function blurbFor(entry: CatalogueEntry): string {
  return moduleBlurb(entry.id, entry.category);
}

export const TOP_LEVEL_COMMANDS: readonly string[] = CATALOGUE.flatMap((entry) => entry.commands);

export function moduleNames(ids: readonly string[]): string[] {
  return ids.flatMap((id) => {
    const entry = CATALOGUE.find((candidate) => candidate.id === id);

    return entry ? [entry.name] : [];
  });
}

export interface ReplacedBot {
  job: string;
  note: string;
  modules: readonly string[];
}

// Every module is filed under exactly one row, because the table claims to account for all of
// them. catalogue.test.ts fails when one is missing, listed twice, or no longer exists.
export const REPLACES: readonly ReplacedBot[] = [
  {
    job: 'A moderation bot',
    note: 'Bans, kicks, timeouts and warnings, a numbered case for each, and appeals against them.',
    modules: ['moderation', 'cases', 'appeals', 'permissions'],
  },
  {
    job: 'An anti-raid bot',
    note: 'Join-rate gating, a breaker on mass admin actions, verification, and traps for the accounts that go looking.',
    modules: ['antiraid', 'antinuke', 'automod', 'phishing', 'verification', 'honeypot'],
  },
  {
    job: 'A ticket bot',
    note: 'Panels members press, a private channel each, staff roles and claiming per ticket type.',
    modules: ['tickets'],
  },
  {
    job: 'A levelling bot',
    note: 'XP for talking and for voice, role rewards, and the rest of what a server runs for fun.',
    modules: ['leveling', 'starboard', 'giveaways', 'polls', 'suggestions', 'rolemenu'],
  },
  {
    job: 'A logging bot',
    note: 'Discord’s audit log printed as it happens, routed per category, with message edits and deletions if you opt in.',
    modules: ['serverlog', 'logging'],
  },
  {
    job: 'Three or four utilities',
    note: 'Welcome messages, join roles, tags, reminders, temporary voice channels, counters, saved messages, snapshots.',
    modules: [
      'welcome',
      'joinroles',
      'tags',
      'reminders',
      'tempvc',
      'counters',
      'messages',
      'branding',
      'backup',
      'help',
      'ping',
    ],
  },
];

export interface LogCategoryRow {
  key: string;
  label: string;
  on: boolean;
}

// Copied from the Server logs settings page, not read off the module: importing
// @proton/module-serverlog/catalogue for thirteen labels drags all 88 event renderers into a
// marketing page. catalogue.test.ts fails when this list and that page disagree.
export const LOG_CATEGORY_ROUTING: readonly LogCategoryRow[] = [
  { key: 'server', label: 'Server', on: true },
  { key: 'channels', label: 'Channels', on: true },
  { key: 'roles', label: 'Roles', on: true },
  { key: 'members', label: 'Members', on: true },
  { key: 'messages', label: 'Messages', on: false },
  { key: 'voice', label: 'Voice', on: false },
  { key: 'moderation', label: 'Moderation', on: true },
  { key: 'invites', label: 'Invites', on: true },
  { key: 'integrations', label: 'Integrations', on: true },
  { key: 'expressions', label: 'Emoji & stickers', on: true },
  { key: 'events', label: 'Events & stages', on: true },
  { key: 'automod', label: 'AutoMod', on: true },
  { key: 'proton', label: 'Proton', on: true },
];

export const OAUTH_SCOPES = ['identify', 'guilds', 'guilds.members.read'] as const;

export const MODULE_COUNT = CATALOGUE.length;

// Copied rather than derived. Reading the log counts off @proton/module-serverlog/catalogue puts
// all 88 event specs in the bundle, and COMMAND_COUNT off command-set.gen.ts puts all 121 commands
// there — on pages that print an integer. catalogue.test.ts fails when any of them drift.
export const LOG_EVENT_COUNT = 88;
export const LOG_CATEGORY_COUNT = 13;
export const COMMAND_COUNT = 121;

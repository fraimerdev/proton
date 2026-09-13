import type { IconName } from '../../components/ui/icon-set.gen.ts';

export interface AreaMeta {
  id: string;
  label: string;
  /** Underline tabs for major workspace modes; segmented for closely related config surfaces. */
  style?: 'tabs' | 'segmented';
}

export interface ModuleMeta {
  id: string;
  label: string;
  icon: IconName;
  group: NavGroupId;
  /** Shown under the title only where it carries information the title does not. */
  subtitle?: string;
  /** What an admin might type instead of the label. Searched alongside it and the field labels. */
  aliases: readonly string[];
  areas?: readonly AreaMeta[];
  areaStyle?: 'tabs' | 'segmented';
}

export type NavGroupId =
  | 'joining'
  | 'safety'
  | 'people'
  | 'members'
  | 'written'
  | 'server'
  | 'records';

export const NAV_GROUPS: readonly { id: NavGroupId; label: string }[] = [
  { id: 'joining', label: 'Joining' },
  { id: 'safety', label: 'Security' },
  { id: 'people', label: 'Moderation' },
  { id: 'members', label: 'Member tools' },
  { id: 'written', label: 'Logs' },
  { id: 'server', label: 'Server' },
  { id: 'records', label: 'Records' },
];

const T = 'tabs' as const;
const S = 'segmented' as const;

export const MODULES: readonly ModuleMeta[] = [
  // ------------------------------------------------------------- joining
  {
    id: 'verification',
    label: 'Verification',
    icon: 'shield-check',
    group: 'joining',
    aliases: ['verify', 'captcha', 'gate', 'member screening', 'entry'],
    areaStyle: T,
    areas: [
      { id: 'gate', label: 'Settings' },
      { id: 'panel', label: 'Panel' },
    ],
  },
  {
    id: 'joinroles',
    label: 'Join Roles',
    icon: 'user-plus',
    group: 'joining',
    aliases: [
      'autorole',
      'auto role',
      'auto roles',
      'join role',
      'sticky roles',
      'on join',
      'people',
    ],
    areaStyle: S,
    areas: [
      { id: 'people', label: 'Members' },
      { id: 'bots', label: 'Bots' },
      { id: 'sticky', label: 'Sticky roles' },
      { id: 'options', label: 'Settings' },
    ],
  },
  {
    id: 'welcome',
    label: 'Welcome & Goodbye',
    icon: 'hand-waving',
    group: 'joining',
    aliases: [
      'welcomer',
      'greeting',
      'greet',
      'goodbye',
      'farewell',
      'leave message',
      'welcome card',
    ],
    areaStyle: S,
    areas: [
      { id: 'welcome', label: 'Welcome' },
      { id: 'goodbye', label: 'Goodbye' },
      { id: 'card', label: 'Card' },
    ],
  },

  // -------------------------------------------------------------- safety
  {
    id: 'automod',
    label: 'Automod',
    icon: 'shield-warning',
    group: 'safety',
    aliases: ['auto mod', 'automoderation', 'filter', 'word filter', 'spam', 'caps', 'invites'],
    areaStyle: T,
    areas: [
      { id: 'checks', label: 'Checks' },
      { id: 'response', label: 'Response' },
      { id: 'native', label: 'Discord AutoMod' },
      { id: 'exemptions', label: 'Exemptions' },
    ],
  },
  {
    id: 'antiraid',
    label: 'Anti-Raid',
    icon: 'users-three',
    group: 'safety',
    aliases: ['anti raid', 'raid', 'raid protection', 'join spike'],
  },
  {
    id: 'antinuke',
    label: 'Anti-Nuke',
    icon: 'siren',
    group: 'safety',
    aliases: ['anti nuke', 'nuke', 'nuke protection', 'mass delete', 'maintenance'],
  },
  {
    id: 'phishing',
    label: 'Phishing',
    icon: 'link-break',
    group: 'safety',
    aliases: ['scam links', 'malicious links', 'bad domains', 'blocklist', 'allowlist'],
  },
  {
    id: 'honeypot',
    label: 'Honeypot',
    icon: 'bug',
    group: 'safety',
    aliases: ['bait', 'trap', 'spam trap', 'bait channel', 'decoy', 'what happens'],
    areaStyle: T,
    areas: [
      { id: 'channels', label: 'Bait channels' },
      { id: 'camouflage', label: 'Camouflage' },
      { id: 'consequences', label: 'Response' },
      { id: 'exemptions', label: 'Exemptions' },
      { id: 'warning', label: 'Warning message' },
      { id: 'dm', label: 'Direct message' },
      { id: 'escalation', label: 'Follow-up' },
    ],
  },

  // -------------------------------------------------------------- people
  {
    id: 'moderation',
    label: 'Moderation',
    icon: 'gavel',
    group: 'people',
    aliases: [
      'ban',
      'kick',
      'timeout',
      'mute',
      'warn',
      'purge',
      'role',
      'slowmode',
      'lockdown',
      'escalation',
      'ladder',
      'warn escalation',
    ],
    // Not tabs: the page reaches these through its own rows, and a link can still land on either.
    areas: [
      { id: 'policy', label: 'Policy' },
      { id: 'escalation', label: 'Warn escalation' },
      { id: 'blocked', label: 'Blocked members' },
    ],
  },
  {
    id: 'cases',
    label: 'Cases',
    icon: 'clipboard-text',
    group: 'people',
    aliases: ['case log', 'infractions', 'history', 'warnings'],
    areas: [{ id: 'log', label: 'Case log' }],
  },
  {
    id: 'appeals',
    label: 'Appeals',
    icon: 'scales',
    group: 'people',
    aliases: ['appeal', 'unban request', 'appeal form', 'review settings'],
    areaStyle: T,
    areas: [
      { id: 'forms', label: 'Appeal forms' },
      { id: 'review', label: 'Review' },
    ],
  },
  {
    id: 'permissions',
    label: 'Permissions',
    icon: 'lock',
    group: 'people',
    subtitle: 'Choose which roles can use Proton commands.',
    aliases: ['command permissions', 'who can use', 'allowed roles', 'command access'],
  },

  // ------------------------------------------------------------- members
  {
    id: 'tickets',
    label: 'Tickets',
    icon: 'ticket',
    group: 'members',
    aliases: ['support', 'ticket panel', 'helpdesk', 'transcripts', 'claim'],
    areaStyle: T,
    areas: [
      { id: 'queue', label: 'Queue' },
      { id: 'types', label: 'Ticket types' },
      { id: 'panels', label: 'Panels' },
      { id: 'responses', label: 'Quick responses' },
      { id: 'settings', label: 'Settings' },
    ],
  },
  {
    id: 'rolemenu',
    label: 'Role Menus',
    icon: 'list-checks',
    group: 'members',
    aliases: ['reaction roles', 'reaction role', 'self roles', 'button roles', 'role picker'],
  },
  {
    id: 'tags',
    label: 'Tags',
    icon: 'tag',
    group: 'members',
    aliases: ['custom commands', 'custom command', 'snippets', 'canned responses', 'autoresponder'],
    areaStyle: T,
    areas: [
      { id: 'library', label: 'Tag library' },
      { id: 'settings', label: 'Settings' },
    ],
  },
  {
    id: 'messages',
    label: 'Messages',
    icon: 'chat-centered-text',
    group: 'members',
    aliases: ['embed', 'embeds', 'templates', 'announcements', 'say', 'components', 'buttons'],
    areaStyle: T,
    areas: [
      { id: 'templates', label: 'Templates' },
      { id: 'components', label: 'Saved rows' },
    ],
  },
  {
    id: 'leveling',
    label: 'Leveling',
    icon: 'trend-up',
    group: 'members',
    aliases: ['levels', 'xp', 'rank', 'rank card', 'leaderboard', 'role rewards'],
    areaStyle: T,
    areas: [
      { id: 'xp', label: 'Earning XP' },
      { id: 'levelup', label: 'Level-up' },
      { id: 'rewards', label: 'Role rewards' },
      { id: 'card', label: 'Rank card' },
      { id: 'leaderboard', label: 'Leaderboard' },
    ],
  },
  {
    id: 'giveaways',
    label: 'Giveaways',
    icon: 'gift',
    group: 'members',
    aliases: ['giveaway', 'raffle', 'draw', 'winners', 'requirements', 'defaults'],
    areaStyle: T,
    areas: [
      { id: 'list', label: 'Giveaways' },
      { id: 'defaults', label: 'Settings' },
      { id: 'access', label: 'Access' },
    ],
  },
  {
    id: 'polls',
    label: 'Polls',
    icon: 'chart-bar',
    group: 'members',
    aliases: ['poll', 'vote', 'voting'],
  },
  {
    id: 'suggestions',
    label: 'Suggestions',
    icon: 'lightbulb',
    group: 'members',
    aliases: ['suggest', 'feedback', 'ideas', 'upvote'],
  },
  {
    id: 'starboard',
    label: 'Starboard',
    icon: 'star',
    group: 'members',
    aliases: ['star board', 'highlights', 'best of', 'pins'],
  },
  {
    id: 'tempvc',
    label: 'Temporary Voice Channels',
    icon: 'speaker-high',
    group: 'members',
    aliases: [
      'temp vc',
      'temporary voice',
      'join to create',
      'voice hub',
      'auto voice',
      'global settings',
    ],
    areaStyle: T,
    areas: [
      { id: 'hubs', label: 'Creator channels' },
      { id: 'settings', label: 'Settings' },
    ],
  },
  {
    id: 'reminders',
    label: 'Reminders',
    icon: 'alarm',
    group: 'members',
    aliases: ['remind', 'remindme', 'reminder'],
  },
  {
    id: 'counters',
    label: 'Counters',
    icon: 'hash',
    group: 'members',
    aliases: ['counter channels', 'member count', 'stats channels', 'count channel'],
  },

  // ------------------------------------------------------------- written
  {
    id: 'serverlog',
    label: 'Server Logs',
    icon: 'scroll',
    group: 'written',
    aliases: ['audit log', 'event log', 'logs', 'log channel', 'mod log', 'individual events'],
    areaStyle: T,
    areas: [
      { id: 'categories', label: 'Categories' },
      { id: 'events', label: 'Events' },
      { id: 'filters', label: 'Filters' },
    ],
  },
  {
    id: 'logging',
    label: 'Logging',
    icon: 'database',
    group: 'written',
    aliases: ['message log', 'retention', 'privacy', 'store messages', 'data'],
  },

  // -------------------------------------------------------------- server
  {
    id: 'branding',
    label: 'Branding',
    icon: 'identification-card',
    group: 'server',
    aliases: ['avatar', 'nickname', 'banner', 'bio', 'identity', 'appearance', 'profile'],
  },
  {
    id: 'backup',
    label: 'Backup',
    icon: 'archive',
    group: 'server',
    aliases: ['restore', 'snapshot', 'backups'],
    areaStyle: T,
    areas: [
      { id: 'backups', label: 'Backups' },
      { id: 'settings', label: 'Settings' },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    icon: 'question',
    group: 'server',
    aliases: ['commands', 'docs', 'documentation'],
  },
  {
    id: 'ping',
    label: 'Ping',
    icon: 'pulse',
    group: 'server',
    aliases: ['latency', 'uptime', 'pong', 'alive'],
  },
];

export const MODULE_BY_ID: ReadonlyMap<string, ModuleMeta> = new Map(
  MODULES.map((module) => [module.id, module]),
);

/**
 * Operational destinations, not modules: each is a view onto records that a module owns, so it
 * links into that module's own route rather than getting a second page that could disagree with it.
 */
export interface RecordLink {
  id: string;
  label: string;
  icon: IconName;
  moduleId: string;
  area: string;
  aliases: readonly string[];
}

export const RECORD_LINKS: readonly RecordLink[] = [
  {
    id: 'case-log',
    label: 'Case log',
    icon: 'clipboard-text',
    moduleId: 'cases',
    area: 'log',
    aliases: ['cases', 'infractions', 'history', 'warnings', 'punishments'],
  },
  {
    id: 'blocked-members',
    label: 'Blocked members',
    icon: 'prohibit',
    moduleId: 'moderation',
    area: 'blocked',
    aliases: ['blocklist', 'blocked', 'proton block', 'security block'],
  },
  {
    id: 'ticket-queue',
    label: 'Ticket queue',
    icon: 'list',
    moduleId: 'tickets',
    area: 'queue',
    aliases: ['open tickets', 'support queue', 'unclaimed'],
  },
];

export const MODULE_ICON_NAMES: readonly IconName[] = MODULES.map((module) => module.icon);
export const RECORD_ICON_NAMES: readonly IconName[] = RECORD_LINKS.map((link) => link.icon);

export function moduleMeta(moduleId: string): ModuleMeta | undefined {
  return MODULE_BY_ID.get(moduleId);
}

export function areaMeta(module: ModuleMeta, areaId: string | undefined): AreaMeta | undefined {
  if (!module.areas) return undefined;
  return module.areas.find((area) => area.id === areaId) ?? module.areas[0];
}

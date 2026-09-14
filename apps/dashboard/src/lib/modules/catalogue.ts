import type { IconName } from '../../components/ui/icon-set.gen.ts';

export interface AreaMeta {
  id: string;
  label: string;
}

export interface ModuleMeta {
  id: string;
  label: string;
  description: string;
  icon: IconName;
  group: NavGroupId;
  subtitle?: string;
  aliases: readonly string[];
  areas?: readonly AreaMeta[];
  areaStyle?: 'tabs' | 'segmented';
  switchOnly?: true;
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
  {
    id: 'verification',
    label: 'Verification',
    description: 'Gate new members behind a button, captcha or website sign-in.',
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
    description: 'Give roles to new members and bots, and restore roles on rejoin.',
    icon: 'user-plus',
    group: 'joining',
    aliases: ['autorole', 'auto role', 'auto roles', 'join role', 'sticky roles', 'on join'],
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
    label: 'Welcomer',
    description:
      'Send a message when someone joins, leaves or boosts, with an optional image card.',
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
      'boost',
      'booster',
      'server boost',
      'nitro boost',
    ],
    areaStyle: S,
    areas: [
      { id: 'welcome', label: 'Welcome' },
      { id: 'goodbye', label: 'Goodbye' },
      { id: 'boost', label: 'Boosts' },
      { id: 'card', label: 'Card' },
    ],
  },

  {
    id: 'automod',
    label: 'Automod',
    description: 'Filter spam and unwanted content, and manage Discord AutoMod rules.',
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
    description: 'Score new members and give suspicious ones a role or kick them.',
    icon: 'users-three',
    group: 'safety',
    aliases: ['anti raid', 'raid', 'raid protection', 'join spike'],
  },
  {
    id: 'antinuke',
    label: 'Anti-Nuke',
    description: 'Strip roles from members making destructive changes too quickly.',
    icon: 'siren',
    group: 'safety',
    aliases: ['anti nuke', 'nuke', 'nuke protection', 'mass delete', 'maintenance'],
  },
  {
    id: 'phishing',
    label: 'Phishing',
    description: 'Detect known scam links and act on the member who posted them.',
    icon: 'link-break',
    group: 'safety',
    aliases: ['scam links', 'malicious links', 'bad domains', 'blocklist', 'allowlist'],
  },
  {
    id: 'honeypot',
    label: 'Honeypot',
    description: 'Catch spam bots and hacked accounts that post in bait channels.',
    icon: 'bug',
    group: 'safety',
    aliases: ['bait', 'trap', 'spam trap', 'bait channel', 'decoy'],
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

  {
    id: 'moderation',
    label: 'Moderation',
    description: 'Warn, time out, kick or ban members and escalate repeat warnings.',
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
    description: 'Search every action Proton has recorded, by member or moderator.',
    icon: 'clipboard-text',
    group: 'people',
    aliases: ['case log', 'infractions', 'history', 'warnings'],
    areas: [{ id: 'log', label: 'Case log' }],
  },
  {
    id: 'appeals',
    label: 'Appeals',
    description: 'Create ban appeal forms and review submissions in a channel.',
    icon: 'scales',
    group: 'people',
    aliases: ['appeal', 'unban request', 'appeal form'],
    areaStyle: T,
    areas: [
      { id: 'forms', label: 'Appeal forms' },
      { id: 'review', label: 'Review' },
    ],
  },
  {
    id: 'permissions',
    label: 'Permissions',
    description: 'Restrict each Proton command to specific roles.',
    icon: 'lock',
    group: 'people',
    subtitle: 'Choose which roles can use Proton commands.',
    aliases: ['command permissions', 'who can use', 'allowed roles', 'command access'],
  },

  {
    id: 'tickets',
    label: 'Tickets',
    description: 'Let members open private support channels with staff.',
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
    description: 'Let members pick roles with reactions, buttons or dropdowns.',
    icon: 'list-checks',
    group: 'members',
    aliases: ['reaction roles', 'reaction role', 'self roles', 'button roles', 'role picker'],
  },
  {
    id: 'tags',
    label: 'Tags',
    description: 'Save text snippets members can post with /tag.',
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
    description: 'Create embeds and buttons to post with /message or on a schedule.',
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
    description: 'Give members XP for messages and voice time, with role rewards.',
    icon: 'trend-up',
    group: 'members',
    aliases: [
      'levels',
      'xp',
      'rank',
      'rank card',
      'leaderboard',
      'role rewards',
      'multiplier',
      'xp multiplier',
      'double xp',
      'xp event',
    ],
    areaStyle: T,
    areas: [
      { id: 'xp', label: 'Earning XP' },
      { id: 'events', label: 'XP events' },
      { id: 'levelup', label: 'Level-up' },
      { id: 'rewards', label: 'Role rewards' },
      { id: 'card', label: 'Rank card' },
      { id: 'leaderboard', label: 'Leaderboard' },
    ],
  },
  {
    id: 'giveaways',
    label: 'Giveaways',
    description: 'Run giveaways with requirements and bonus entries.',
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
    description: 'Run Discord’s native polls and announce when they close.',
    icon: 'chart-bar',
    group: 'members',
    aliases: ['poll', 'vote', 'voting'],
    switchOnly: true,
  },
  {
    id: 'suggestions',
    label: 'Suggestions',
    description: 'Let members suggest and vote on ideas that staff accept or deny.',
    icon: 'lightbulb',
    group: 'members',
    aliases: ['suggest', 'feedback', 'ideas', 'upvote'],
  },
  {
    id: 'starboard',
    label: 'Starboard',
    description: 'Repost messages to a board channel once they get enough stars.',
    icon: 'star',
    group: 'members',
    aliases: ['star board', 'highlights', 'best of', 'pins'],
  },
  {
    id: 'tempvc',
    label: 'Temporary Voice Channels',
    description: 'Give members their own voice channel when they join a creator channel.',
    icon: 'speaker-high',
    group: 'members',
    aliases: ['temp vc', 'temporary voice', 'join to create', 'voice hub', 'auto voice'],
    areaStyle: T,
    areas: [
      { id: 'hubs', label: 'Creator channels' },
      { id: 'settings', label: 'Settings' },
    ],
  },
  {
    id: 'reminders',
    label: 'Reminders',
    description: 'Let members schedule a message that pings them later.',
    icon: 'alarm',
    group: 'members',
    aliases: ['remind', 'remindme', 'reminder'],
    switchOnly: true,
  },
  {
    id: 'afk',
    label: 'AFK',
    description:
      'Tell people who ping an away member why they’re away, and recap what they missed.',
    icon: 'moon',
    group: 'members',
    aliases: ['away', 'away from keyboard', 'brb', 'afk status', 'away message'],
  },
  {
    id: 'counters',
    label: 'Counters',
    description: 'Show member, role or channel counts in channel names.',
    icon: 'hash',
    group: 'members',
    aliases: ['counter channels', 'member count', 'stats channels', 'count channel'],
  },

  {
    id: 'serverlog',
    label: 'Server Logs',
    description: 'Post member, role, channel and moderation events to log channels.',
    icon: 'scroll',
    group: 'written',
    aliases: ['audit log', 'event log', 'logs', 'log channel', 'mod log'],
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
    description: 'Archive message edits and deletions for 30 days.',
    icon: 'database',
    group: 'written',
    aliases: ['message log', 'retention', 'privacy', 'store messages', 'data'],
  },

  {
    id: 'branding',
    label: 'Branding',
    description: 'Set Proton’s nickname, avatar, banner and bio in this server.',
    icon: 'identification-card',
    group: 'server',
    aliases: ['avatar', 'nickname', 'banner', 'bio', 'identity', 'appearance', 'profile'],
  },
  {
    id: 'backup',
    label: 'Backup',
    description: 'Snapshot channels and roles, and recreate missing ones.',
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
    description: 'Reply to /help with what Proton does and where to set it up.',
    icon: 'question',
    group: 'server',
    aliases: ['commands', 'docs', 'documentation'],
    switchOnly: true,
  },
  {
    id: 'ping',
    label: 'Ping',
    description: 'Let members run /ping to check Proton is responding.',
    icon: 'pulse',
    group: 'server',
    aliases: ['latency', 'uptime', 'pong', 'alive'],
    switchOnly: true,
  },
];

export const MODULE_BY_ID: ReadonlyMap<string, ModuleMeta> = new Map(
  MODULES.map((module) => [module.id, module]),
);

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

export function areaMeta(module: ModuleMeta, areaId: string | undefined): AreaMeta | undefined {
  if (!module.areas) return undefined;
  return module.areas.find((area) => area.id === areaId) ?? module.areas[0];
}

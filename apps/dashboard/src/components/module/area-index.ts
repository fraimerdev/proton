import type { AreaEntry } from './areas.ts';
import { tally } from './areas.ts';

/**
 * The five modules whose settings are split into sub-pages, and the config field roots each
 * sub-page draws. Data only, no components: the command palette imports the whole table to send a
 * field jump to the page that actually renders it, and a route file imports its own row.
 *
 * `fields` is the join the module manifest's `dashboard.sections` used to make. It has to stay in
 * step with what the route file renders — `area-index.test.ts` is what keeps it honest.
 */
export interface IndexedArea extends AreaEntry {
  fields: readonly string[];
}

function checksOn(config: Record<string, unknown>): string | null {
  const severities = Object.entries(config).filter(([key]) => /severity$/i.test(key));
  if (severities.length === 0) return null;

  const on = severities.filter(([, value]) => typeof value === 'string' && value !== 'off').length;

  return `${on} of ${severities.length} on`;
}

export const AUTOMOD_AREAS: readonly IndexedArea[] = [
  {
    id: 'checks',
    title: 'Message checks',
    blurb: 'Everything Proton itself looks for in a message, and how serious each one is.',
    icon: 'list-checks',
    count: checksOn,
    fields: [
      'floodSeverity',
      'floodCount',
      'floodWindow',
      'duplicateSeverity',
      'duplicateCount',
      'duplicateWindow',
      'mentionsSeverity',
      'mentionsLimit',
      'invitesSeverity',
      'linksSeverity',
      'linkBlockDomains',
      'linkAllowDomains',
      'attachmentsSeverity',
      'attachmentExtensions',
      'patternsSeverity',
      'capsSeverity',
      'capsRatio',
      'emojiSeverity',
      'emojiLimit',
      'wallsSeverity',
      'wallMaxLines',
      'zalgoSeverity',
    ],
  },
  {
    id: 'response',
    title: 'Response',
    blurb: 'What happens when a check fires, and where Proton reports it.',
    icon: 'gavel',
    fields: [
      'alertChannelId',
      'deleteFrom',
      'lowResponse',
      'mediumResponse',
      'highResponse',
      'mediumTimeout',
      'highTimeout',
    ],
  },
  {
    id: 'discord',
    title: 'Enforced by Discord',
    blurb:
      'Word lists and patterns Proton hands to Discord’s own AutoMod, blocked before Proton sees them.',
    icon: 'lock',
    count: (config) => tally(config, 'blockedWords', 'blocked word'),
    fields: [
      'blockedWords',
      'allowedWords',
      'presets',
      'mentionLimit',
      'nativeSpam',
      'regexPatterns',
    ],
  },
  {
    id: 'exemptions',
    title: 'Exemptions',
    blurb: 'Roles, channels and bots no check applies to.',
    icon: 'user-minus',
    count: (config) => tally(config, 'exemptRoleIds', 'exempt role'),
    fields: ['exemptRoleIds', 'exemptChannelIds', 'exemptBots'],
  },
];

export const SERVERLOG_AREAS: readonly IndexedArea[] = [
  {
    id: 'routing',
    title: 'Categories and channels',
    blurb: 'Which categories of event are logged, and the channel each one is written to.',
    icon: 'hash',
    fields: ['defaultChannelId', 'categories', 'categoryChannels'],
  },
  {
    id: 'events',
    title: 'Individual logs',
    blurb: 'Every event Discord reports, switched on one at a time and routed on its own.',
    icon: 'list-checks',
    fields: ['events'],
  },
  {
    id: 'filters',
    title: 'Filters',
    blurb: 'Channels, roles and members whose activity is never logged.',
    icon: 'funnel',
    count: (config) => tally(config, 'ignoredChannelIds', 'ignored channel'),
    fields: ['ignoredChannelIds', 'ignoredRoleIds', 'ignoredUserIds', 'ignoreBots'],
  },
];

export const MESSAGES_AREAS: readonly IndexedArea[] = [
  {
    id: 'templates',
    title: 'Templates',
    blurb: 'Named messages you post with /message, and everything they carry.',
    icon: 'chat-circle-text',
    count: (config) => tally(config, 'templates', 'template'),
    fields: ['templates'],
  },
  {
    id: 'components',
    title: 'Components',
    blurb: 'Rows of buttons and dropdowns to drop into any template.',
    icon: 'layout',
    count: (config) => tally(config, 'components', 'component'),
    fields: ['components'],
  },
];

export const LEVELING_AREAS: readonly IndexedArea[] = [
  {
    id: 'earning',
    title: 'Earning XP',
    blurb: 'How much XP a message or a minute in voice is worth, and who is excluded.',
    icon: 'chart-bar',
    fields: [
      'xpPerMessageMin',
      'xpPerMessageMax',
      'messageCooldown',
      'voiceXpPerMinute',
      'afkChannelId',
      'excludedChannelIds',
      'excludedRoleIds',
    ],
  },
  {
    id: 'levelup',
    title: 'Level-up announcement',
    blurb: 'Where Proton says somebody levelled up, and what it says.',
    icon: 'megaphone',
    fields: ['levelUpChannelId', 'levelUpMessage'],
  },
  {
    id: 'rewards',
    title: 'Role rewards',
    blurb: 'Roles handed out at a level, and whether earlier ones are kept.',
    icon: 'user-plus',
    count: (config) => tally(config, 'roleRewards', 'reward'),
    fields: ['rewardMode', 'roleRewards'],
  },
  {
    id: 'card',
    title: 'Rank card',
    blurb: 'The image /rank draws.',
    icon: 'layout',
    fields: [
      'rankCard',
      'cardPreset',
      'cardAccent',
      'cardBackgroundUrl',
      'cardShowRank',
      'cardShowPercent',
      'cardShowTotalXp',
    ],
  },
];

export const WELCOME_AREAS: readonly IndexedArea[] = [
  {
    id: 'welcome',
    title: 'Welcome message',
    blurb: 'Posted when somebody joins, with the channel it lands in.',
    icon: 'hand-waving',
    fields: ['welcomeChannelId', 'welcomeMessage'],
  },
  {
    id: 'goodbye',
    title: 'Goodbye message',
    blurb: 'Posted when somebody leaves, with the channel it lands in.',
    icon: 'sign-out',
    fields: ['goodbyeChannelId', 'goodbyeMessage'],
  },
  {
    id: 'card',
    title: 'Welcome card',
    blurb: 'The image drawn onto the greeting.',
    icon: 'layout',
    fields: ['card', 'preset', 'cardAccent', 'cardBackgroundUrl', 'cardShowMemberCount'],
  },
];

export const HONEYPOT_AREAS: readonly IndexedArea[] = [
  {
    id: 'bait',
    title: 'Bait channels',
    blurb: 'The channels nobody has a reason to write in, and whether the trap is armed.',
    icon: 'fish',
    count: (config) => tally(config, 'channels', 'bait channel'),
    fields: ['includeThreads', 'channels'],
  },
  {
    id: 'camouflage',
    title: 'Camouflage',
    blurb:
      'Two daily jobs that stop a bait channel reading as one. Both are off until you turn them on.',
    icon: 'eye-slash',
    fields: ['keepChannelActive', 'renameChannelDaily'],
  },
  {
    id: 'action',
    title: 'What happens',
    blurb: 'What happens to the account that posted, and to its message.',
    icon: 'gavel',
    fields: [
      'action',
      'timeoutFirst',
      'timeoutFirstDuration',
      'timeoutDuration',
      'deleteMessageSeconds',
      'appealPanelId',
      'waitBeforeActingSeconds',
      'auditLogReason',
      'deleteTriggerMessage',
    ],
  },
  {
    id: 'exemptions',
    title: 'Who is exempt',
    blurb: 'Catches from these are logged and counted, but nothing is done to the account.',
    icon: 'user-minus',
    count: (config) => tally(config, 'exemptRoleIds', 'exempt role'),
    fields: ['exemptAdministrators', 'exemptAdminRoleId', 'exemptRoleIds'],
  },
  {
    id: 'notice',
    title: 'The warning message',
    blurb:
      'The notice posted in every bait channel, so a member who wanders in knows to leave it alone.',
    icon: 'warning',
    fields: ['postNotice', 'noticeCounterButton', 'hideWhatIsAHoneypot', 'noticeLayout'],
  },
  {
    id: 'dm',
    title: 'The direct message',
    blurb: 'What the caught account is told, sent just before the action lands.',
    icon: 'paper-plane-tilt',
    fields: ['sendDirectMessage', 'offerWayBackIn', 'inviteUrl', 'dmLayout'],
  },
  {
    id: 'escalation',
    title: 'Escalation and logging',
    blurb: 'What else happens to a caught account, and where it is logged.',
    icon: 'shield-slash',
    fields: ['addToBlacklist', 'quoteMessage', 'logChannelId'],
  },
];

export const MODULE_AREAS: Readonly<Record<string, readonly IndexedArea[]>> = {
  automod: AUTOMOD_AREAS,
  serverlog: SERVERLOG_AREAS,
  messages: MESSAGES_AREAS,
  leveling: LEVELING_AREAS,
  welcome: WELCOME_AREAS,
  honeypot: HONEYPOT_AREAS,
};

// The closed set an area icon may come from. scripts/build-icons.ts reads it, so a name added here
// without re-running it stops being an IconName rather than turning into a blank square.
export const AREA_ICON_NAMES = [
  ...new Set(Object.values(MODULE_AREAS).flatMap((areas) => areas.map((area) => area.icon))),
];

// Object.hasOwn, not a lookup-and-test: MODULE_AREAS['constructor'] would otherwise be truthy.
export function areasFor(moduleId: string): readonly IndexedArea[] {
  return Object.hasOwn(MODULE_AREAS, moduleId) ? (MODULE_AREAS[moduleId] ?? []) : [];
}

/**
 * Which sub-page a field ends up on. The command palette jumps straight to a field by path, and on
 * a module with areas the settings root is the hub — so without this the jump lands somewhere the
 * field is not rendered and the hash matches nothing.
 */
export function areaForField(moduleId: string, path: string): IndexedArea | undefined {
  // The path's first segment, not the whole path: an area declares `rankCard` and the config holds
  // `rankCard.background`, so an exact compare would miss every nested field.
  const root = path.split('.')[0] ?? '';

  return areasFor(moduleId).find((area) => area.fields.includes(root));
}

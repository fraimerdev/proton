/** Exactly what the Discord consent screen will ask for, spelled the way Discord spells it. */
export const OAUTH_SCOPES = ['identify', 'guilds', 'guilds.members.read'] as const;

export const MODULE_GROUPS: readonly {
  title: string;
  blurb: string;
  modules: readonly string[];
}[] = [
  {
    title: 'Let the right people in',
    blurb:
      'Verification, join roles and a welcome that survives a raid. Membership screening is honoured rather than worked around.',
    modules: ['verification', 'joinroles', 'welcome'],
  },
  {
    title: 'Keep it safe',
    blurb:
      'Eleven automod checks, raid and nuke protection, a phishing blocklist, and honeypot channels that catch bots before a member reports them.',
    modules: ['automod', 'antiraid', 'antinuke', 'phishing', 'honeypot'],
  },
  {
    title: 'Moderate with a record',
    blurb:
      'Every action becomes a case. Moderation escalates repeat warnings on a ladder you set, and appeals arrive as a form rather than a DM.',
    modules: ['moderation', 'cases', 'appeals', 'permissions'],
  },
  {
    title: 'Give members something to use',
    blurb:
      'Tickets, role menus, tags, levelling, giveaways, polls, suggestions, starboard and temporary voice channels.',
    modules: ['tickets', 'rolemenu', 'tags', 'leveling', 'giveaways', 'tempvc'],
  },
  {
    title: 'Write it all down',
    blurb:
      'Server logs routed per event or per category, with message-content retention off until you switch it on.',
    modules: ['serverlog', 'logging', 'backup'],
  },
];

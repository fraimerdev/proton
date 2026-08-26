import { ButtonStyle, ComponentType } from 'discord-api-types/v10';

// DESIGN.md's Committed Blue: the blue Proton uses wherever it becomes a filled surface.
export const HELP_COLOUR = 0x3369e8;

export const OPEN_DASHBOARD = 'Open the dashboard';

const HEADING = '## Proton';

const INTRO =
  'Moderation, security and engagement for this server, in one bot. Every action that changes ' +
  'something here is recorded as a numbered case — who did it, to whom, why, and when. Bans, ' +
  'timeouts, role changes and lockdowns can be reversed from that record.';

const CATEGORIES = [
  '**Moderation** — bans, kicks, timeouts, purges and slowmode, and the ladder that escalates ' +
    'repeat warnings.',
  '**Security** — a verification gate for new members, raid and nuke breakers, phishing-link ' +
    'matching, honeypot channels, AutoMod rules and server backups.',
  '**Engagement** — leveling with role rewards, giveaways, a starboard, suggestions, role menus ' +
    'and welcome messages.',
  '**Utility** — tickets, tags, reminders, polls, temporary voice channels, counter channels, ' +
    'join roles, and which roles may run each command.',
  '**Logging** — Discord’s own audit events routed to the channels you pick, and opt-in message ' +
    'logs kept for 30 days.',
].join('\n');

const WHERE =
  '### Configured in the dashboard\n' +
  'Which modules run in this server, what each one does and who may use them are all set there, ' +
  'not from chat. A change is live here within seconds of being saved.';

const NO_LINK =
  " I can't link you straight there: this Proton deployment hasn't been given its dashboard " +
  'address. A server admin will know where it lives.';

const COMMANDS =
  'Type `/` in the message box to see what Proton offers you here. A command you cannot see is ' +
  'either switched off in this server or restricted to another role.';

function text(content: string): Record<string, unknown> {
  return { type: ComponentType.TextDisplay, content };
}

function separator(): Record<string, unknown> {
  return { type: ComponentType.Separator, divider: true, spacing: 1 };
}

function callToAction(link: string | null): Record<string, unknown> {
  if (!link) return text(`${WHERE}${NO_LINK}`);

  return {
    type: ComponentType.Section,
    components: [text(WHERE)],
    accessory: {
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      label: OPEN_DASHBOARD,
      url: link,
    },
  };
}

export function buildHelpComponents(link: string | null): Record<string, unknown>[] {
  return [
    {
      type: ComponentType.Container,
      accent_color: HELP_COLOUR,
      components: [
        text(HEADING),
        text(INTRO),
        text(CATEGORIES),
        separator(),
        callToAction(link),
        text(COMMANDS),
      ],
    },
  ];
}

import { ButtonStyle, ComponentType } from 'discord-api-types/v10';

// DESIGN.md's Committed Blue: the blue Proton uses wherever it becomes a filled surface.
export const HELP_COLOUR = 0x3369e8;

export const OPEN_DASHBOARD = 'Open the dashboard';

const HEADING = '## Proton';

const INTRO =
  'Moderation, security and engagement for this server, in one bot. Moderation actions are ' +
  'recorded as cases: who did it, to whom, why and when. Temporary bans, timeouts and lockdowns ' +
  'lift on their own.';

const CATEGORIES = [
  '**Moderation**: bans, kicks, timeouts, warnings, slowmode and lockdowns, with automatic ' +
    'escalation for repeat warnings.',
  '**Security**: a verification gate for new members, raid and nuke protection, phishing-link ' +
    'checks, honeypot channels, AutoMod rules and server backups.',
  '**Engagement**: leveling with role rewards and XP multipliers, achievements with badges and ' +
    'rewards, giveaways, a starboard, suggestions, role menus, and welcome, goodbye and boost ' +
    'messages.',
  '**Utility**: tickets, tags, reminders, AFK statuses, polls, temporary voice channels, ' +
    'counter channels, join roles, how Proton looks in this server, and which roles can use each ' +
    'command.',
  '**Logging**: Discord’s own audit events sent to the channels you pick, and opt-in message ' +
    'logs kept for 30 days.',
].join('\n');

const WHERE =
  '### Set up in the dashboard\n' +
  'Choose which modules run here, how they behave and who can use them. Changes apply within ' +
  'seconds of saving.';

const NO_LINK =
  ' The dashboard link isn’t available right now. A server admin will know where it lives.';

const COMMANDS =
  'Type `/` in the message box to see what Proton offers you here. A command you can’t see is ' +
  'either off in this server or limited to members with certain roles or permissions.';

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

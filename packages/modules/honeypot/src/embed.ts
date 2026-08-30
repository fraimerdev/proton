import { HONEYPOT_COLOUR } from './notice.ts';

export const HONEYPOT_OK = 0x4fcf95;
export const HONEYPOT_ALARM = 0xf0b752;

// DESIGN.md's Quiet Slate. Never the amber: an exempt catch never reached the executor, so
// reporting it as "could not be carried out" would be reporting a failure that never happened.
export const HONEYPOT_QUIET = 0x868e9f;

export interface Incident {
  userId: string;
  channelId: string;
  messageId: string;
  guildId: string;

  action: string;
  window: string | null;
  outcome: 'done' | 'refused' | 'ban_stuck' | 'exempt' | 'gone';
  detail?: string | undefined;

  quote?: string | undefined;
  dm?: string | undefined;
}

export const QUOTE_MAX = 900;

// Fenced and stripped of backticks, so a message ending in one cannot break out of the block and
// turn the rest of the embed into whatever markdown it wanted. Mentions are neutralised by the
// send's own allowedMentions, not here.
export function quoteForLog(body: string): string | undefined {
  const trimmed = body.trim();
  if (trimmed === '') return undefined;

  const cut = trimmed.length > QUOTE_MAX ? `${trimmed.slice(0, QUOTE_MAX)}…` : trimmed;

  return ['```', cut.replaceAll('`', "'"), '```'].join('\n');
}

const OUTCOMES: Record<Incident['outcome'], { text: string; colour: number }> = {
  done: { text: 'Done', colour: HONEYPOT_OK },
  refused: { text: 'Could not be carried out', colour: HONEYPOT_ALARM },

  exempt: { text: 'Left alone — exempt', colour: HONEYPOT_QUIET },
  gone: { text: 'They had already left', colour: HONEYPOT_QUIET },

  // Never green and never merely amber: the member is still banned and a human has to lift it.
  ban_stuck: { text: 'FAILED — the member is still banned', colour: HONEYPOT_COLOUR },
};

export function buildIncidentEmbed(incident: Incident, now: number): Record<string, unknown> {
  const outcome = OUTCOMES[incident.outcome];

  const fields: Record<string, unknown>[] = [
    { name: 'Member', value: `<@${incident.userId}>\n\`${incident.userId}\``, inline: true },
    { name: 'Channel', value: `<#${incident.channelId}>`, inline: true },
    { name: 'Action', value: incident.action, inline: true },
  ];

  if (incident.window) {
    fields.push({ name: 'Messages deleted', value: incident.window, inline: true });
  }

  fields.push({ name: 'Result', value: outcome.text, inline: true });

  if (incident.detail) {
    fields.push({ name: 'Detail', value: incident.detail.slice(0, 1024), inline: false });
  }

  if (incident.dm) {
    fields.push({ name: 'Told', value: incident.dm, inline: false });
  }

  if (incident.quote) {
    fields.push({ name: 'What they posted', value: incident.quote.slice(0, 1024), inline: false });
  }

  return {
    title: '🍯  Honeypot triggered',
    color: outcome.colour,
    description:
      `[Jump to the message](https://discord.com/channels/${incident.guildId}/` +
      `${incident.channelId}/${incident.messageId})`,
    fields,
    timestamp: new Date(now).toISOString(),
  };
}

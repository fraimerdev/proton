import { describeWindow, type HoneypotChannel } from './config.ts';

// DESIGN.md's Blocked Coral: "something cannot run, or the user is about to destroy something".
// The one colour in Proton's palette that means stop.
export const HONEYPOT_COLOUR = 0xff7a86;

export const HONEYPOT_OK = 0x4fcf95;
export const HONEYPOT_ALARM = 0xf0b752;

function describeAction(channel: HoneypotChannel): string {
  switch (channel.action) {
    case 'softban':
      return (
        'you will be removed from the server and your recent messages deleted. ' +
        'You can rejoin straight away.'
      );
    case 'ban':
      return 'you will be banned from the server.';
    case 'kick':
      return 'you will be removed from the server.';
    case 'timeout':
      return 'you will be timed out and unable to speak.';
    case 'warn':
      return 'it will be recorded against your account.';
    case 'none':
      return 'it will be reported to the moderators.';
  }
}

export function buildNoticeEmbed(channel: HoneypotChannel): Record<string, unknown> {
  const purge =
    channel.action === 'softban' || channel.action === 'ban'
      ? describeWindow(channel.deleteMessageSeconds)
      : null;

  return {
    title: '🍯  Do not send messages in this channel',
    color: HONEYPOT_COLOUR,
    description:
      'This channel is a trap. It exists to catch spam bots and compromised accounts, which post ' +
      'in every channel they can see.\n\n' +
      `**There is never a reason to post here.** If you do, ${describeAction(channel)}`,

    ...(purge
      ? {
          fields: [
            {
              name: 'Messages deleted',
              value: purge === 'no messages' ? 'None' : `Everything you posted in ${purge}`,
              inline: true,
            },
          ],
        }
      : {}),

    footer: { text: 'Protected by Proton' },
  };
}

export interface Incident {
  userId: string;
  channelId: string;
  messageId: string;
  guildId: string;

  action: string;
  window: string | null;
  outcome: 'done' | 'refused' | 'ban_stuck';
  detail?: string | undefined;
}

const OUTCOMES: Record<Incident['outcome'], { text: string; colour: number }> = {
  done: { text: 'Done', colour: HONEYPOT_OK },
  refused: { text: 'Could not be carried out', colour: HONEYPOT_ALARM },

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

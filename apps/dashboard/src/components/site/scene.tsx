import type { ProtonMessage } from '@proton/core';
import type { ReactElement } from 'react';
import type { DiscordChannel, DiscordRole } from '../form/fields.tsx';
import { MessagePreview } from '../message/preview.tsx';

// Every scene here is a message Proton really posts, drawn by the same preview the dashboard's
// message builder draws with. Ids and names are fixtures; the colours, field order, wording and
// buttons are the ones the modules compose.

const LOUNGE = '500000000000000001';
const STARS = '500000000000000003';
const MEMBER = '400000000000000001';

const CHANNELS: readonly DiscordChannel[] = [
  { id: LOUNGE, name: 'lounge', type: 0 },
  { id: STARS, name: 'starboard', type: 0 },
];

const ROLES: readonly DiscordRole[] = [{ id: '600000000000000001', name: 'Regular', position: 3 }];

// Drawn by scripts/build-author-avatar.ts, the same monogram the rank card falls back to — so
// the member starred in one scene is the member ranked in the other.
const AVATAR = '/art/author-avatar.png';

// A mention resolves to a display name; the code span the log prints beside it is the username.
const USERS = [{ id: MEMBER, name: 'Rin' }];

// Fixed so the server render and the client render agree — a live clock hydrates as a mismatch,
// and every stamp in these scenes is illustrative anyway.
const AT = new Date('2026-03-14T20:04:00Z');

function Scene({
  message,
  command,
  attachment,
}: {
  message: ProtonMessage;
  command?: { user: string; name: string; avatar?: string };
  attachment?: ReactElement;
}): ReactElement {
  return (
    <MessagePreview
      message={message}
      channels={CHANNELS}
      roles={ROLES}
      users={USERS}
      now={AT}
      head={null}
      {...(command ? { command } : {})}
      {...(attachment ? { attachment } : {})}
    />
  );
}

const QUIET = { everyone: false, roles: false, users: false } as const;

// A slash command answered with an attachment and nothing else: the card is the whole reply.
const EMPTY: ProtonMessage = {
  content: undefined,
  embeds: [],
  components: [],
  mentions: QUIET,
  v2: [],
};

// The reply /ban composes, with the case id stamped under it in subtext — the handle the ledger
// is searchable by.
const BAN: ProtonMessage = {
  content: `Banned <@${MEMBER}> for 7d — it lifts automatically.\n-# Case \`K3M9PQ2\``,
  embeds: [],
  components: [],
  mentions: QUIET,
  v2: [],
};

export function ModerationScene(): ReactElement {
  return <Scene command={{ user: 'Rin', name: 'ban', avatar: AVATAR }} message={BAN} />;
}

// Not a preview: /rank answers with a PNG the bot draws, and this one was drawn by that renderer.
// scripts/build-rank-card.ts regenerates it.
export function RankCardScene(): ReactElement {
  return (
    <Scene
      command={{ user: 'Rin', name: 'rank', avatar: AVATAR }}
      message={EMPTY}
      attachment={
        <img
          src="/art/rank-card.png"
          alt="A rank card: Rin, level 42, rank 3, 69 percent of the way to the next level"
          width={1100}
          height={370}
          loading="lazy"
          decoding="async"
        />
      }
    />
  );
}

// STAR_COLOUR, and the `emoji **count** <#channel>` line buildBoardMessage posts above the embed.
const STARBOARD: ProtonMessage = {
  content: `⭐ **38** <#${LOUNGE}>`,
  embeds: [
    {
      color: 0xff_ac_33,
      author: { name: 'Rin', iconUrl: AVATAR },
      title: 'Jump to message',
      url: 'https://discord.com/channels/1/1/1',
      description: 'i have never once read the pinned messages and i am not going to start now',
      timestamp: '2026-03-14T19:41:00.000Z',
    },
  ],
  components: [],
  mentions: QUIET,
  v2: [],
};

export function StarboardScene(): ReactElement {
  return <Scene message={STARBOARD} />;
}

// A ticket panel is Components V2: buildPanelComponents lays the title and body out as text
// displays, then a separator, then one button per ticket type.
const TICKET_PANEL: ProtonMessage = {
  content: undefined,
  embeds: [],
  components: [],
  mentions: QUIET,
  v2: [
    {
      kind: 'container',
      accentColor: 0x33_69_e8,
      children: [
        { kind: 'text', content: '## Get help from the staff team' },
        {
          kind: 'text',
          content:
            'Open a ticket and only you and the support team can read it. Say what you need in ' +
            'the first message and somebody will pick it up.',
        },
        { kind: 'separator', divider: true, spacing: 'small' },
        {
          kind: 'row',
          row: {
            kind: 'buttons',
            buttons: [
              {
                key: 'support',
                style: 'primary',
                label: 'Support',
                action: { kind: 'reply', content: 'opening', ephemeral: true },
              },
              {
                key: 'report',
                style: 'secondary',
                label: 'Report a member',
                action: { kind: 'reply', content: 'opening', ephemeral: true },
              },
            ],
          },
        },
      ],
    },
  ],
};

export function TicketPanelScene(): ReactElement {
  return <Scene message={TICKET_PANEL} />;
}

// ServerLogColors.Add, and the label/value lines logLine() builds.
const MEMBER_JOINED: ProtonMessage = {
  content: undefined,
  embeds: [
    {
      title: 'Member joined',
      color: 0x57_f2_87,
      description: [
        `**Member:** <@${MEMBER}> \`@rin\``,
        `**Id:** \`${MEMBER}\``,
        '**Account created:** <t:1740700000:R>',
      ].join('\n'),
      footer: { text: 'Proton' },
      timestamp: '2026-03-14T20:04:00.000Z',
    },
  ],
  components: [],
  mentions: QUIET,
  v2: [],
};

export function ServerLogScene(): ReactElement {
  return <Scene message={MEMBER_JOINED} />;
}

// What the precheck answers with rather than doing nothing: the permission under the name
// Discord's own settings use, and the channel it is missing in.
const REFUSAL: ProtonMessage = {
  content: `I'm missing the Add Reactions permission in <#${STARS}>.`,
  embeds: [],
  components: [],
  mentions: QUIET,
  v2: [],
};

export function RefusalScene(): ReactElement {
  return <Scene message={REFUSAL} />;
}

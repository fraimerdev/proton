import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ProsePage } from '../components/site/prose.tsx';
import { documentTitle } from '../lib/document-title.ts';

export const Route = createFileRoute('/privacy')({
  head: () => ({ meta: [{ title: documentTitle('Privacy') }] }),
  component: Privacy,
});

function Privacy(): ReactElement {
  return (
    <ProsePage
      title="Privacy"
      lede="What Proton stores, why it stores it, and how long it keeps it."
      updated="12 September 2026"
      sections={[
        {
          heading: 'What signing in shares',
          paragraphs: [
            'Signing in to the dashboard uses Discord OAuth. Proton asks for three scopes and no others: identify, guilds and guilds.members.read. That tells Proton your Discord user id, your display name and avatar, and which servers you are in along with your permissions in them.',
            'Proton uses that to list the servers you may configure — the ones you own or hold Manage Server in. It does not read your messages, your direct messages, or your email address through this sign-in.',
          ],
        },
        {
          heading: 'What Proton stores about a server',
          bullets: [
            'The settings you save for each module, against the server id.',
            'An audit record of every change made through the dashboard: who made it, when, and the before and after values. This is what lets a server owner see who changed what.',
            'A truncated, salted hash of the IP address a dashboard change came from. The address itself is never stored.',
            'Moderation cases: the action taken, who took it, who it was about, the reason, and when.',
            'Where you have switched the feature on, ticket transcripts and appeal submissions.',
          ],
        },
        {
          heading: 'Message content',
          paragraphs: [
            'Proton runs with the Message Content intent because automod, the phishing filter and the honeypot have to read a message to decide whether to act on it. Reading is not storing.',
            'Message content is only written down when an administrator switches on message logging or ticket transcripts for that server. Both are off by default, and stored message content is deleted after 30 days.',
          ],
        },
        {
          heading: 'What Proton never does',
          bullets: [
            'It does not sell or share your data with advertisers or data brokers.',
            'It does not read direct messages between members.',
            'It does not use the Presence intent, so it does not see your status or activity.',
          ],
        },
        {
          heading: 'Removing your data',
          paragraphs: [
            'Removing Proton from a server stops all collection for it. To have the stored settings, cases and audit records for a server deleted, contact the server owner or Proton’s operator with the server id.',
          ],
        },
      ]}
    />
  );
}

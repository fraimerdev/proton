import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ProsePage } from '../components/site/prose.tsx';
import { documentTitle } from '../lib/document-title.ts';

export const Route = createFileRoute('/terms')({
  head: () => ({ meta: [{ title: documentTitle('Terms') }] }),
  component: Terms,
});

function Terms(): ReactElement {
  return (
    <ProsePage
      title="Terms"
      lede="The terms you accept by adding Proton to a server or using its dashboard."
      updated="12 September 2026"
      sections={[
        {
          heading: 'Who may use Proton',
          paragraphs: [
            'You must meet Discord’s own minimum age for your country and follow the Discord Terms of Service and Community Guidelines. Adding Proton to a server requires the Manage Server permission in it.',
          ],
        },
        {
          heading: 'What you are responsible for',
          bullets: [
            'The configuration you save. Proton performs the actions you configure — bans, kicks, timeouts, channel and role changes — for real, in every environment.',
            'Telling your members what you have switched on, in particular message logging and ticket transcripts.',
            'Holding the permissions Proton needs. Where a permission is missing, Proton says so rather than acting partially.',
          ],
        },
        {
          heading: 'What Proton does not promise',
          paragraphs: [
            'Proton is provided as is, without warranty. It depends on Discord’s API and on network conditions outside its control, so it cannot guarantee uninterrupted service or that any individual action reaches Discord.',
            'Automated moderation is a filter, not a judgement. Review the cases it opens.',
          ],
        },
        {
          heading: 'Acceptable use',
          bullets: [
            'Do not use Proton to harass, to evade Discord’s rules, or to collect data about members beyond running your server.',
            'Do not attempt to disrupt the service, its rate limits, or other servers using it.',
          ],
        },
        {
          heading: 'Ending it',
          paragraphs: [
            'You can remove Proton from a server at any time, which stops all processing for it. Access may be withdrawn from a server that breaks these terms or Discord’s.',
          ],
        },
        {
          heading: 'Changes',
          paragraphs: [
            'These terms may change as Proton changes. The date above says when they last did.',
          ],
        },
      ]}
    />
  );
}

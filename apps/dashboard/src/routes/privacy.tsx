import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { PrivacyPolicy } from '../components/legal/privacy-policy.tsx';
import { SitePage } from '../components/site/chrome.tsx';
import { documentTitle } from '../lib/document-title.ts';

export const Route = createFileRoute('/privacy')({
  head: () => ({ meta: [{ title: documentTitle('What Proton stores') }] }),
  component: PrivacyPage,
});

function PrivacyPage(): ReactElement {
  return (
    <SitePage>
      <div className="doc-page">
        <PrivacyPolicy />
      </div>
    </SitePage>
  );
}

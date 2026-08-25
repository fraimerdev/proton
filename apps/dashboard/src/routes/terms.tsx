import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Terms } from '../components/legal/terms.tsx';
import { SitePage } from '../components/site/chrome.tsx';
import { documentTitle } from '../lib/document-title.ts';

export const Route = createFileRoute('/terms')({
  head: () => ({ meta: [{ title: documentTitle('Terms of Service') }] }),
  component: TermsPage,
});

function TermsPage(): ReactElement {
  return (
    <SitePage>
      <div className="doc-page">
        <Terms />
      </div>
    </SitePage>
  );
}

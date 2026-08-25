import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { PrivacyPolicy } from '../components/legal/privacy-policy.tsx';
import { Icon } from '../components/shell/icon.tsx';
import { documentTitle } from '../lib/document-title.ts';

export const Route = createFileRoute('/privacy')({
  head: () => ({ meta: [{ title: documentTitle('What Proton stores') }] }),
  component: PrivacyPage,
});

function PrivacyPage(): ReactElement {
  return (
    <div className="plain-page">
      <div className="page">
        <Link to="/" className="back-link">
          <Icon name="arrow-left" />
          Proton
        </Link>
        <PrivacyPolicy />
      </div>
    </div>
  );
}

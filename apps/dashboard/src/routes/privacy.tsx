import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { PrivacyPolicy } from '../components/legal/privacy-policy.tsx';
import { Icon } from '../components/shell/icon.tsx';

export const Route = createFileRoute('/privacy')({
  head: () => ({ meta: [{ title: 'Proton — Privacy' }] }),
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

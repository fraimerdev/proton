import { createFileRoute } from '@tanstack/react-router';
import { PrivacyPolicy } from '../components/legal/privacy-policy.tsx';

export const Route = createFileRoute('/privacy')({
  head: () => ({ meta: [{ title: 'Proton — Privacy' }] }),
  component: PrivacyPolicy,
});

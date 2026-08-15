import { createFileRoute } from '@tanstack/react-router';
import { PrivacyPolicy } from '../components/legal/privacy-policy.tsx';

/**
 * The policy itself lives in a component so it can be rendered — and asserted
 * on — without a router. What it has to say is a product requirement (PLAN.md
 * §6), not decoration, so it is worth a test.
 */
export const Route = createFileRoute('/privacy')({
  head: () => ({ meta: [{ title: 'Proton — Privacy' }] }),
  component: PrivacyPolicy,
});

import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { createContext, use } from 'react';
import { ProtonMark } from '../shell/topbar.tsx';
import { Icon } from '../ui/icon.tsx';

// Handed down from the root route rather than read here. This module is imported by every public
// page, and reaching into lib/queries.ts from it pulls the whole server-function graph into the
// first chunk the browser parses.
const SignedIn = createContext<boolean | null>(null);

export function SignedInProvider({
  value,
  children,
}: {
  value: boolean | null;
  children: ReactNode;
}): ReactElement {
  return <SignedIn value={value}>{children}</SignedIn>;
}

export function useSignedIn(): boolean | null {
  return use(SignedIn);
}

export function SiteHeader(): ReactElement {
  const signedIn = useSignedIn();

  return (
    <header className="site-header">
      <Link to="/" className="topbar-brand">
        <ProtonMark />
        Proton
      </Link>

      <nav className="site-nav">
        <Link to="/commands">Commands</Link>
        <Link to="/faq">FAQ</Link>
      </nav>

      <span className="topbar-spacer" />

      {signedIn === true ? (
        <Link to="/dashboard" className="button button-primary button-sm">
          Open dashboard
        </Link>
      ) : (
        <Link to="/signin" className="button button-primary button-sm">
          <Icon name="discord-logo" size={15} weight="fill" />
          Log in with Discord
        </Link>
      )}
    </header>
  );
}

export function SiteFooter(): ReactElement {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <span>Proton</span>
        <span className="topbar-spacer" />
        <Link to="/commands">Commands</Link>
        <Link to="/faq">FAQ</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
      </div>
    </footer>
  );
}

export function SitePage({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="site">
      <SiteHeader />
      <main className="site-main">{children}</main>
      <SiteFooter />
    </div>
  );
}

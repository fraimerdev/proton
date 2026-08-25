import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { SUPPORT_INVITE } from '../../lib/site-meta.ts';
import { Icon } from '../shell/icon.tsx';
import { ProtonMark } from '../shell/mark.tsx';

export function SiteHeader(): ReactElement {
  return (
    <header className="site-header">
      <nav className="site-nav" aria-label="Proton">
        <Link to="/" className="site-brand">
          <ProtonMark size={22} />
          <span>Proton</span>
        </Link>

        <ul className="site-nav-links">
          <li>
            <a href="/#features">Features</a>
          </li>
          <li>
            <Link to="/commands">Commands</Link>
          </li>
          <li>
            <Link to="/faq">Questions</Link>
          </li>
          <li>
            <Link to="/privacy">Privacy</Link>
          </li>
        </ul>

        <Link to="/dashboard" className="button button-quiet site-nav-cta">
          Dashboard
        </Link>
      </nav>
    </header>
  );
}

function FooterWave(): ReactElement {
  return (
    <svg
      className="site-wave"
      viewBox="0 0 1440 120"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M0 74C168 110 372 118 636 92 900 66 1152 6 1440 26V120H0Z" />
    </svg>
  );
}

export function SiteFooter(): ReactElement {
  return (
    <footer className="site-footer">
      <FooterWave />

      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <ProtonMark size={44} />
          <span>Proton</span>
        </div>

        <nav className="site-footer-group" aria-label="Navigation">
          <span className="site-footer-heading">Navigation</span>
          <ul>
            <li>
              <Link to="/">Home</Link>
            </li>
            <li>
              <a href="/#features">Features</a>
            </li>
            <li>
              <Link to="/commands">Commands</Link>
            </li>
            <li>
              <Link to="/faq">Questions</Link>
            </li>
          </ul>
        </nav>

        <nav className="site-footer-group" aria-label="Other">
          <span className="site-footer-heading">Other</span>
          <ul>
            <li>
              <a href="/invite">Add to Discord</a>
            </li>
            <li>
              <a href={SUPPORT_INVITE} rel="noreferrer noopener" target="_blank">
                Support server
              </a>
            </li>
            <li>
              <Link to="/dashboard">Dashboard</Link>
            </li>
          </ul>
        </nav>

        <nav className="site-footer-group" aria-label="Legal">
          <span className="site-footer-heading">Legal</span>
          <ul>
            <li>
              <Link to="/terms">Terms of Service</Link>
            </li>
            <li>
              <Link to="/privacy">Privacy policy</Link>
            </li>
            <li>
              <Link to="/faq" hash="data">
                What Proton stores
              </Link>
            </li>
            <li>
              <Link to="/faq" hash="delete">
                Deleting your data
              </Link>
            </li>
          </ul>
        </nav>

        <div className="site-footer-call">
          <a className="button button-discord" href="/invite">
            <Icon name="discord-logo" weight="fill" />
            Add to Discord
          </a>
        </div>
      </div>

      <div className="site-footer-base">
        © Proton · Not affiliated with or endorsed by Discord Inc.
      </div>
    </footer>
  );
}

export function SitePage({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="site">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="site-main">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

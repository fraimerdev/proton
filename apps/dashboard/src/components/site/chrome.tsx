import { Link } from '@tanstack/react-router';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import { SUPPORT_INVITE } from '../../lib/site-meta.ts';
import { Icon } from '../shell/icon.tsx';
import { ProtonMark } from '../shell/mark.tsx';
import { MODULE_COUNT } from './catalogue.ts';
import { capitalised, inWords } from './words.ts';

const SignedInContext = createContext<boolean | null>(null);

export const SignedInProvider = SignedInContext.Provider;

// The landing page's sections, in the order they are read. Sections the nav cannot point at are
// still observed, so reaching one clears the item the reader has left.
const SECTIONS: readonly string[] = [
  'features',
  'dashboard',
  'commands',
  'compare',
  'questions',
] as const;

/** The first of `ids` in view, or null on a page that has none of them. */
function useSectionInView(ids: readonly string[]): string | null {
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    const targets = ids
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);

    if (targets.length === 0) return;

    const inView = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inView.add(entry.target.id);
          else inView.delete(entry.target.id);
        }

        setCurrent(ids.find((id) => inView.has(id)) ?? null);
      },
      // The band is the strip under the sticky header, so one section is current at a time rather
      // than every section the viewport overlaps.
      { rootMargin: '-88px 0px -60% 0px' },
    );

    for (const target of targets) observer.observe(target);

    return () => observer.disconnect();
  }, [ids]);

  return current;
}

export function SiteHeader(): ReactElement {
  // null is an unknown answer, and /dashboard suits both: it sends a stranger to sign in itself.
  const signedOut = useContext(SignedInContext) === false;
  const inView = useSectionInView(SECTIONS);

  // includeHash, so the section links are current only while the address bar points at them and
  // two items never read as current at once.
  const byHash = { exact: true, includeHash: true } as const;

  return (
    <header className="site-header">
      <nav className="site-nav" aria-label="Proton">
        <Link to="/" className="site-brand">
          <ProtonMark size={26} />
          <span>Proton</span>
        </Link>

        <ul className="site-nav-links" data-spy={inView ? 'true' : undefined}>
          <li>
            <Link
              to="/"
              hash="features"
              activeOptions={byHash}
              data-current={inView === 'features' ? 'true' : undefined}
              aria-current={inView === 'features' ? 'true' : undefined}
            >
              Features
            </Link>
          </li>
          <li>
            <Link to="/commands">Commands</Link>
          </li>
          <li>
            <Link
              to="/"
              hash="compare"
              activeOptions={byHash}
              data-current={inView === 'compare' ? 'true' : undefined}
              aria-current={inView === 'compare' ? 'true' : undefined}
            >
              Compare
            </Link>
          </li>
          <li>
            <Link to="/faq">Questions</Link>
          </li>
        </ul>

        <div className="site-nav-actions">
          {signedOut ? (
            <a
              href="/api/auth/signin/discord"
              className="button button-quiet site-nav-cta site-nav-login"
            >
              <Icon name="discord-logo" weight="fill" />
              Login with Discord
            </a>
          ) : (
            <Link to="/dashboard" className="button button-quiet site-nav-cta">
              Dashboard
            </Link>
          )}
          <a className="button button-discord site-nav-cta site-nav-add" href="/invite">
            Add to Discord
          </a>
        </div>
      </nav>
    </header>
  );
}

export function SiteFooter(): ReactElement {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <Link to="/" className="site-footer-home">
            <ProtonMark size={24} />
            <span>Proton</span>
          </Link>
          <p>
            {capitalised(inWords(MODULE_COUNT))} modules for your Discord server, each behind its
            own switch, and a written record of everything they do.
          </p>
        </div>

        <nav className="site-footer-group" aria-label="Product">
          <span className="site-footer-heading">Product</span>
          <ul>
            <li>
              <Link to="/" hash="features">
                Features
              </Link>
            </li>
            <li>
              <Link to="/dashboard">Dashboard</Link>
            </li>
            <li>
              <Link to="/commands">Commands</Link>
            </li>
          </ul>
        </nav>

        <nav className="site-footer-group" aria-label="Resources">
          <span className="site-footer-heading">Resources</span>
          <ul>
            <li>
              <Link to="/faq">Questions</Link>
            </li>
            <li>
              <a href={SUPPORT_INVITE} rel="noreferrer noopener" target="_blank">
                Support server
              </a>
            </li>
            <li>
              <a href="/invite">Add to Discord</a>
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
        <span>© Proton · Not affiliated with or endorsed by Discord Inc.</span>
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

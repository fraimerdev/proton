import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { SitePage } from './chrome.tsx';

export interface ProseSection {
  id: string;
  heading: string;
  body: ReactNode;
}

const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function useReading(ids: string): string | null {
  const [reading, setReading] = useState<string | null>(null);

  useEffect(() => {
    const order = ids.split(' ');
    const shown = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) shown.add(entry.target.id);
          else shown.delete(entry.target.id);
        }
        const first = order.find((id) => shown.has(id));
        if (first) setReading(first);
      },
      { rootMargin: '-72px 0px -55% 0px' },
    );

    for (const id of order) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, [ids]);

  return reading;
}

export function ProsePage({
  title,
  updated,
  related,
  sections,
}: {
  title: string;
  updated: string;
  related: { to: '/privacy' | '/terms'; label: string };
  sections: readonly ProseSection[];
}): ReactElement {
  const reading = useReading(sections.map((section) => section.id).join(' '));

  return (
    <SitePage>
      <div className="legal">
        <header className="legal-head">
          <h1 className="legal-title">{title}</h1>
          <p className="legal-meta">
            <span>
              Last updated <time dateTime={updated}>{DATE.format(new Date(updated))}</time>
            </span>
            <Link to={related.to}>{related.label}</Link>
          </p>
        </header>

        <div className="legal-body">
          <nav className="legal-toc scroll-y" aria-labelledby="legal-toc">
            <p className="legal-toc-label" id="legal-toc">
              On this page
            </p>
            <ol>
              {sections.map((section, index) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="legal-toc-link"
                    aria-current={reading === section.id ? 'location' : undefined}
                  >
                    <span className="legal-num">{index + 1}</span>
                    {section.heading}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="legal-prose">
            {sections.map((section, index) => (
              <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`}>
                <h2 id={`${section.id}-heading`}>
                  <span className="legal-num">{index + 1}</span>
                  {section.heading}
                </h2>
                {section.body}
              </section>
            ))}
          </div>
        </div>
      </div>
    </SitePage>
  );
}

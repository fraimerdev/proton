import type { ReactElement } from 'react';
import { SitePage } from './chrome.tsx';

export interface ProseSection {
  heading: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
}

export function ProsePage({
  title,
  lede,
  updated,
  sections,
}: {
  title: string;
  lede: string;
  updated: string;
  sections: readonly ProseSection[];
}): ReactElement {
  return (
    <SitePage>
      <div className="site-section" style={{ paddingTop: 56, paddingBottom: 72 }}>
        <h1 className="site-heading">{title}</h1>
        <p className="site-lede">{lede}</p>
        <p className="text-xs text-muted" style={{ marginTop: 10 }}>
          Last updated {updated}
        </p>

        <div className="prose" style={{ marginTop: 28 }}>
          {sections.map((section) => (
            <section key={section.heading}>
              <h2>{section.heading}</h2>
              {section.paragraphs?.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {section.bullets ? (
                <ul>
                  {section.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </SitePage>
  );
}

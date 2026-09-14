import type { NameStyleEffect, NameStyleFont } from '@proton/module-branding/name-style';
import type { CSSProperties, ReactElement } from 'react';
import { Fragment, useSyncExternalStore } from 'react';
import { faceFor, fontStack } from './faces.ts';
import { type GlyphRun, graphemes, runsOf, specimenVars } from './shape.ts';

const NONE: ReadonlySet<number> = new Set();

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => true,
  );
}

export function GlyphRuns({
  text,
  missing = NONE,
}: {
  text: string;
  missing?: ReadonlySet<number> | undefined;
}): ReactElement {
  const runs: GlyphRun[] =
    missing.size === 0 ? [{ text, missing: false, start: 0 }] : runsOf(graphemes(text), missing);

  return (
    <>
      {runs.map((run) =>
        run.missing ? (
          <span key={run.start} className="name-specimen-missing">
            {run.text}
          </span>
        ) : (
          <Fragment key={run.start}>{run.text}</Fragment>
        ),
      )}
    </>
  );
}

export function NameSpecimen({
  font,
  effect,
  colours,
  text,
  missing = NONE,
}: {
  font: NameStyleFont;
  effect: NameStyleEffect;
  colours: readonly number[];
  text: string;
  missing?: ReadonlySet<number> | undefined;
}): ReactElement {
  const style: CSSProperties & Record<`--ns-${number}`, string> = {
    fontFamily: fontStack(font),
    fontWeight: faceFor(font).weight,
    ...specimenVars(colours),
  };

  return (
    <span className="name-specimen" data-effect={effect} data-font={font} style={style}>
      <GlyphRuns text={text} missing={missing} />
    </span>
  );
}

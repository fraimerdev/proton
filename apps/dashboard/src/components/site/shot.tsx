import type { ReactElement } from 'react';
import { Icon } from '../shell/icon.tsx';

export interface Shot {
  file: string;
  alt: string;
  width: number;
  height: number;

  // Flip to true the moment public/shots/<file> exists. Until then the frame draws a labelled
  // placeholder, because a missing <img> renders as a broken icon on a page nobody has to look at.
  ready: boolean;
}

export const SHOTS = {
  modules: {
    file: 'modules.png',
    alt: 'Proton’s dashboard listing a server’s modules, each with its own switch',
    width: 1440,
    height: 900,
    ready: false,
  },
  cases: {
    file: 'cases.png',
    alt: 'The case ledger, showing numbered moderation cases with actor, reason and time',
    width: 1440,
    height: 900,
    ready: false,
  },
  settings: {
    file: 'settings.png',
    alt: 'A module’s settings page, with its master switch above the generated form',
    width: 1440,
    height: 900,
    ready: false,
  },
  notRunning: {
    file: 'not-running.png',
    alt: 'A module reporting the exact Discord permission it is missing',
    width: 1440,
    height: 900,
    ready: false,
  },
} satisfies Record<string, Shot>;

export function ShotFrame({ shot }: { shot: Shot }): ReactElement {
  if (!shot.ready) {
    return (
      <div className="shot shot-pending">
        <Icon name="layout" />
        <span className="shot-file mono">public/shots/{shot.file}</span>
        <span className="shot-note">{shot.alt}</span>
      </div>
    );
  }

  return (
    <img
      className="shot"
      src={`/shots/${shot.file}`}
      alt={shot.alt}
      width={shot.width}
      height={shot.height}
      loading="lazy"
      decoding="async"
    />
  );
}
